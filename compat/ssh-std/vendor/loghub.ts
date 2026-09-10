/**
 * LogHub —— 日志/状态通道中心（与 cordis 无关的纯 Node 模块）。
 *
 * 语义（SPEC G）：
 *  - C→S `{t:'subscribe', channel:'status'}` / `{t:'subscribe', channel:'log', key}`
 *    / `{t:'unsubscribe', …}`；
 *  - S→C 订阅即回快照 `{t:'status', items}` 或 `{t:'log-snapshot', key, lines}`，
 *    随后增量 `{t:'status', connectionId, status}` / `{t:'log', key, line}`；
 *  - 每 key 环形缓冲 500 行；30s ping 心跳；连接断开仅退订不杀 pipeline
 *    （pipeline 归服务端 flowId map 所有，HTTP 中断不杀）。
 */

import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { ConnectionStatus } from './registry.ts'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

export interface LogLine {
  ts: string
  level: LogLevel
  msg: string
}

export interface LogHubDeps {
  /** 订阅 status 频道时的全量快照提供者（来自 LivenessProbe）。 */
  getStatuses?: () => Record<string, ConnectionStatus>
  /** 每 key 环形缓冲上限（默认 500）。 */
  bufferSize?: number
  /** ping 心跳周期（默认 30s）。 */
  pingIntervalMs?: number
}

interface WsSubState {
  status: boolean
  logs: Set<string>
}

function timestamp(): string {
  const now = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

export class LogHub {
  private wss = new WebSocketServer({ noServer: true })
  private channels = new Map<string, LogLine[]>()
  private sockets = new Set<WebSocket>()
  private subStates = new WeakMap<WebSocket, WsSubState>()
  private alive = new WeakMap<WebSocket, boolean>()
  private deps: LogHubDeps
  private bufferSize: number
  private pingIntervalMs: number
  private pingTimer: NodeJS.Timeout | undefined

  constructor(deps: LogHubDeps = {}) {
    this.deps = deps
    this.bufferSize = deps.bufferSize ?? 500
    this.pingIntervalMs = deps.pingIntervalMs ?? 30_000
    this.pingTimer = setInterval(() => this.sweepPing(), this.pingIntervalMs)
    this.pingTimer.unref?.()
  }

  /** webServer.registerUpgrade 的 handler。 */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws))
  }

  private attach(ws: WebSocket): void {
    const state: WsSubState = { status: false, logs: new Set() }
    this.sockets.add(ws)
    this.subStates.set(ws, state)
    this.alive.set(ws, true)
    ws.on('pong', () => this.alive.set(ws, true))
    ws.on('message', (raw: Buffer) => {
      try {
        this.onFrame(ws, JSON.parse(raw.toString('utf8')))
      } catch {
        /* 非法 JSON 忽略 */
      }
    })
    ws.on('close', () => this.detach(ws))
    ws.on('error', () => this.detach(ws))
  }

  private detach(ws: WebSocket): void {
    // 仅退订，不杀 pipeline
    this.sockets.delete(ws)
    this.subStates.delete(ws)
    this.alive.delete(ws)
    try { ws.terminate() } catch { /* 已关 */ }
  }

  private onFrame(ws: WebSocket, frame: Record<string, unknown>): void {
    const state = this.subStates.get(ws)
    if (!state) return
    if (frame.t === 'subscribe') {
      const channel = frame.channel
      if (channel === 'status') {
        state.status = true
        this.sendJson(ws, { t: 'status', items: this.deps.getStatuses?.() ?? {} })
      } else if (channel === 'log' && typeof frame.key === 'string' && frame.key) {
        const key = frame.key
        state.logs.add(key)
        this.sendJson(ws, { t: 'log-snapshot', key, lines: this.snapshot(key) })
      }
    } else if (frame.t === 'unsubscribe') {
      const channel = frame.channel
      if (channel === 'status') {
        state.status = false
      } else if (channel === 'log') {
        if (typeof frame.key === 'string') state.logs.delete(frame.key)
        else state.logs.clear()
      }
    }
  }

  private sweepPing(): void {
    for (const ws of this.sockets) {
      const alive = this.alive.get(ws)
      if (alive === false) {
        this.detach(ws)
        continue
      }
      this.alive.set(ws, false)
      try { ws.ping() } catch { /* 未完成握手等 */ }
    }
  }

  private snapshot(key: string): LogLine[] {
    return this.channels.get(key) ?? []
  }

  /** 写入一条日志（环形缓冲 + 广播增量）。 */
  pushLog(key: string, level: LogLevel, msg: string): void {
    const line: LogLine = { ts: timestamp(), level, msg }
    const buf = this.channels.get(key) ?? []
    buf.push(line)
    if (buf.length > this.bufferSize) buf.splice(0, buf.length - this.bufferSize)
    this.channels.set(key, buf)
    this.broadcastTo((state) => state.logs.has(key), (ws) => {
      this.sendJson(ws, { t: 'log', key, line })
    })
  }

  /** 广播一条状态增量（status 订阅者收 {t:'status', connectionId, status}）。 */
  pushStatus(connectionId: string, status: ConnectionStatus): void {
    this.broadcastTo((state) => state.status, (ws) => {
      this.sendJson(ws, { t: 'status', connectionId, status })
    })
  }

  private broadcastTo(match: (state: WsSubState) => boolean, deliver: (ws: WebSocket) => void): void {
    for (const ws of this.sockets) {
      const state = this.subStates.get(ws)
      if (state && match(state)) deliver(ws)
    }
  }

  private sendJson(ws: WebSocket, obj: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
  }

  /** ctx.effect 清理：停心跳、关所有连接、close server。 */
  dispose(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = undefined
    }
    for (const ws of [...this.sockets]) {
      try { ws.terminate() } catch { /* 已关 */ }
    }
    this.wss.close()
  }
}