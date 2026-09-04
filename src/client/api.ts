/**
 * dsh-ssh client 半的 HTTP/WS 客户端（契约 = SPEC-M1.md G 节逐字冻结）。
 *
 * REST：统一前缀 /__dsh-ssh/，全 JSON；`{ok:true,...}` 解包返回业务字段，
 * `{ok:false,error}` 与 HTTP 非 2xx 一律抛 ApiError（status=0 表示网络级失败）。
 *
 * WS：/__dsh-ssh/ws，C→S subscribe（channel: status|log，log 带 key）；
 * S→C 订阅即回快照（status:items / log-snapshot），随后增量（status:connectionId
 * / log:key）。常驻单例：指数退避重连（1s→2s→…→15s 封顶），断线后自动
 * 重发全部活跃订阅；同一 key 的日志订阅做引用计数去重。断开仅退订不杀
 * 服务端 pipeline（SPEC G：pipeline 归 flowId map 所有）。
 */

export type EnvKind = 'wsl' | 'windows' | 'linux' | 'macos'

export interface EnvironmentInfo {
  ok: true
  kind: EnvKind
  detail?: string
  canWsl: boolean
  canWin: boolean
  canDocker: false
}

export interface AliasItem {
  name: string
  host: string
  port: number
  user: string
  identityFile?: string
  sshBinary?: string
  source: 'dsh' | 'ssh-config'
  description?: string
}

export interface RemoteEnv {
  os: 'linux' | 'windows' | 'macos'
  arch: 'x64' | 'arm64'
  uname?: string
  shells: Array<{ name: string; path: string }>
  node?: string
}

export type StatusState = 'unknown' | 'checking' | 'online' | 'offline' | 'degraded'

export interface Status {
  state: StatusState
  lastChecked?: string
  error?: string
  env?: RemoteEnv
}

export interface ConnectionRecord {
  id: string
  kind: 'ssh' | 'win'
  title: string
  ssh: {
    host: string
    port: number
    user: string
    auth: { type: 'password' } | { type: 'key'; identityFile: string }
    sshBinary?: string
    downloadMethod?: 'upload' | 'remote'
  }
  remotePath?: string
  runtime: { installed: boolean }
  /** M5：注册成的原生工作区 id（注册后行点击=打开会话而非终端）。 */
  workspaceId?: string
  createdAt: string
  updatedAt: string
}

export interface ConnectionEntry {
  connection: ConnectionRecord
  status: Status
}

export interface BrowseEntry {
  name: string
  type: 'dir' | 'file' | 'link'
}

export interface BrowseResult {
  dir: string
  parent?: string
  entries: BrowseEntry[]
}

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

export interface LogLine {
  ts: string
  level: LogLevel
  msg: string
}

export interface TargetItem {
  connectionId: string
  title: string
  kind: 'ssh' | 'win'
  online: boolean
  remotePath?: string
}

/**
 * POST /api/connect 的 draft（G 节）。`auth.type==='password'` 时携带
 * password 字段走一次性 askpass（服务端连接成功/失败后即焚，永不入库）。
 */
export interface ConnectDraft {
  kind: 'ssh' | 'win'
  title?: string
  ssh: {
    host: string
    port: number
    user: string
    auth: { type: 'password'; password?: string } | { type: 'key'; identityFile: string }
    sshBinary?: string
    downloadMethod?: 'upload' | 'remote'
    /** downloadMethod==='remote' 时的下载源地址（远端可访问的 tar URL）。 */
    runtimeUrl?: string
  }
}

/** 统一错误类型：message 里是服务端 {ok:false,error} 的原文或网络说明。 */
export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const BASE = '/__dsh-ssh'

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${BASE}${path}`, {
      headers: { 'content-type': 'application/json' },
      ...init,
    })
  } catch {
    // 宿主未挂载/断网：网络级失败（插件整体降级判断用 status 0）。
    throw new ApiError('无法连接 DSH 服务（插件可能未挂载）', 0)
  }
  let data: { ok?: boolean; error?: string } & Record<string, unknown>
  try {
    data = await res.json()
  } catch {
    throw new ApiError(`响应不是 JSON（HTTP ${res.status}）`, res.status)
  }
  if (!res.ok || data.ok === false) {
    throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status)
  }
  return data as T
}

export const api = {
  /** GET /api/environment —— 本地环境（卡片禁用依据）。 */
  environment: (): Promise<EnvironmentInfo> => request<EnvironmentInfo>('/api/environment'),

  /** GET /api/aliases —— 别名下拉数据源（dsh + ssh-config 合并）。 */
  aliases: (): Promise<{ ok: true; items: AliasItem[] }> => request<{ ok: true; items: AliasItem[] }>('/api/aliases'),

  /** GET /api/connections —— 注册表 + 当前状态。 */
  connections: (): Promise<{ ok: true; items: ConnectionEntry[] }> =>
    request<{ ok: true; items: ConnectionEntry[] }>('/api/connections'),

  /** POST /api/connect —— 长请求；进度走 WS log 频道（key=flowId），不持久化。 */
  connect: (draft: ConnectDraft, flowId: string): Promise<{ ok: true; env: RemoteEnv }> =>
    request<{ ok: true; env: RemoteEnv }>('/api/connect', {
      method: 'POST',
      body: JSON.stringify({ draft, flowId }),
    }),

  /** POST /api/connections —— 向导第 4 步「完成」持久化。flowId 关联 connect 暂存（env/运行时安装结果回填落库）。 */
  persistConnection: (draft: ConnectDraft, title: string, remotePath: string, flowId?: string | null): Promise<{ ok: true; connection: ConnectionRecord }> =>
    request<{ ok: true; connection: ConnectionRecord }>('/api/connections', {
      method: 'POST',
      body: JSON.stringify({ draft, title, remotePath, ...(flowId ? { flowId } : {}) }),
    }),

  /** POST /api/browse —— 远端列目录（flowId 向导期 / connectionId 注册表）。 */
  browse: (input: { flowId?: string; connectionId?: string; dir: string; mkdir?: string }): Promise<{ ok: true } & BrowseResult> =>
    request<{ ok: true } & BrowseResult>('/api/browse', { method: 'POST', body: JSON.stringify(input) }),

  /** POST /api/check —— 手动重测存活（同步等结果）。 */
  check: (connectionId: string): Promise<{ ok: true; status: Status }> =>
    request<{ ok: true; status: Status }>('/api/check', { method: 'POST', body: JSON.stringify({ connectionId }) }),

  /** POST /api/disconnect —— 关 mux、置 unknown。 */
  disconnect: (connectionId: string): Promise<{ ok: true }> =>
    request<{ ok: true }>('/api/disconnect', { method: 'POST', body: JSON.stringify({ connectionId }) }),

  /** DELETE /api/connections —— 删除连接（先 disconnect）。 */
  removeConnection: (connectionId: string): Promise<{ ok: true }> =>
    request<{ ok: true }>('/api/connections', { method: 'DELETE', body: JSON.stringify({ connectionId }) }),

  /** GET /api/targets —— dsh-terminal client 直取；本插件仅降级自检时兜底。 */
  targets: (): Promise<{ ok: true; items: TargetItem[] }> => request<{ ok: true; items: TargetItem[] }>('/api/targets'),

  /** POST /api/register-remote-workspace —— M5：把连接注册为原生工作区（失败不掉向导）。 */
  registerRemoteWorkspace: (connectionId: string): Promise<{ ok: true; workspaceId?: string; already?: boolean }> =>
    request<{ ok: true; workspaceId?: string; already?: boolean }>('/api/register-remote-workspace', {
      method: 'POST',
      body: JSON.stringify({ connectionId }),
    }),
}

// ── WS 常驻客户端 ──────────────────────────────────────────────────────────

type WsInFrame =
  | { t: 'status'; items: Record<string, Status> }
  | { t: 'status'; connectionId: string; status: Status }
  | { t: 'log-snapshot'; key: string; lines: LogLine[] }
  | { t: 'log'; key: string; line: LogLine }

export type { WsInFrame }

type WsOutFrame =
  | { t: 'subscribe'; channel: 'status' }
  | { t: 'subscribe'; channel: 'log'; key: string }
  | { t: 'unsubscribe'; channel: 'status' | 'log'; key?: string }

interface ActiveSub {
  channel: 'status' | 'log'
  key?: string
  refs: number
}

/** 帧分发回调（stores.ts 注册：status → connectionsStore、log → logsStore）。 */
export type WsFrameHandler = (frame: WsInFrame) => void

const WS_RETRY_BASE_MS = 1000
const WS_RETRY_MAX_MS = 15000

class WsClient {
  private ws: WebSocket | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = WS_RETRY_BASE_MS
  private disposed = false
  private started = false
  /** 活跃订阅表（引用计数去重：同 key 只向服务端订阅一次）。 */
  private readonly subs = new Map<string, ActiveSub>()
  private handler: WsFrameHandler | null = null

  /** 注册帧分发回调（模块级单例，只允许一个消费者；null 解绑）。 */
  setHandler(handler: WsFrameHandler | null): void {
    this.handler = handler
  }

  /** 常驻启动：建立连接并订阅状态频道（生命周期归 ctx.effect）。 */
  start(): void {
    if (this.started) return
    this.started = true
    this.disposed = false
    this.subscribeStatus()
    this.connect()
  }

  /** 彻底停止（插件卸载）：断连、清定时器、清订阅。 */
  dispose(): void {
    this.disposed = true
    this.started = false
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.ws !== null) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }
    this.subs.clear()
    this.retryDelay = WS_RETRY_BASE_MS
  }

  /** 订阅状态频道（引用计数）；返回退订函数。 */
  subscribeStatus(): () => void {
    return this.acquire('status', undefined)
  }

  /** 订阅日志频道（key=flowId|connectionId）；返回退订函数。 */
  subscribeLog(key: string): () => void {
    return this.acquire('log', key)
  }

  private acquire(channel: 'status' | 'log', key: string | undefined): () => void {
    const id = `${channel}:${key ?? ''}`
    const existing = this.subs.get(id)
    if (existing !== undefined) {
      existing.refs += 1
    } else {
      this.subs.set(id, { channel, key, refs: 1 })
      // 连接就绪时立即补发订阅（拿快照）。
      if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) this.sendSub(channel, key)
    }
    let released = false
    return () => {
      if (released) return
      released = true
      const sub = this.subs.get(id)
      if (sub === undefined) return
      sub.refs -= 1
      if (sub.refs <= 0) {
        this.subs.delete(id)
        if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
          this.send({ t: 'unsubscribe', channel, key })
        }
      }
    }
  }

  private connect(): void {
    if (this.disposed || this.ws !== null) return
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    let socket: WebSocket
    try {
      socket = new WebSocket(`${protocol}://${window.location.host}${BASE}/ws`)
    } catch {
      this.scheduleReconnect()
      return
    }
    this.ws = socket
    socket.addEventListener('open', () => {
      this.retryDelay = WS_RETRY_BASE_MS
      // 重连后重发全部活跃订阅（订阅即回快照）。
      for (const sub of this.subs.values()) this.sendSub(sub.channel, sub.key)
    })
    socket.addEventListener('message', (event) => {
      if (this.disposed) return
      if (typeof event.data !== 'string') return
      let frame: WsInFrame
      try {
        frame = JSON.parse(event.data) as WsInFrame
      } catch {
        return
      }
      this.handler?.(frame)
    })
    socket.addEventListener('close', () => {
      if (this.ws === socket) this.ws = null
      if (!this.disposed) this.scheduleReconnect()
    })
    socket.addEventListener('error', () => {
      // close 事件随后触发，重连逻辑统一走 close。
      socket.close()
    })
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.retryTimer !== null) return
    const delay = this.retryDelay
    this.retryDelay = Math.min(this.retryDelay * 2, WS_RETRY_MAX_MS)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, delay)
  }

  private sendSub(channel: 'status' | 'log', key: string | undefined): void {
    this.send(
      channel === 'status'
        ? { t: 'subscribe', channel: 'status' }
        : { t: 'subscribe', channel: 'log', key: key ?? '' },
    )
  }

  private send(frame: WsOutFrame): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify(frame))
  }
}

/** 模块级单例（浏览器页内唯一，生命周期归 client apply 的 ctx.effect）。 */
export const wsClient = new WsClient()