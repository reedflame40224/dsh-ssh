/**
 * LivenessProbe —— 存活检测（与 cordis 无关的纯 Node 模块）。
 *
 * 语义（SPEC F）：
 *  - sweep()：插件加载即全量探测（并发 4，单连接 6s 超时）；
 *  - start()：60s±15% 抖动周期；offline 指数退避 30s→×2→5min 封顶；
 *    online 复探周期 60s（同为抖动）；
 *  - 状态机 unknown→checking→online|offline|degraded；degraded 预留给 M2
 *    （ssh 通但 runtime 异常），M1 不产生；
 *  - 状态变更 → onStatus 回调（由 routes 接到 WS 广播）；
 *  - checkNow(connId) 手动重测（/api/check 用，同步等结果）。
 */

import type { ConnectionRegistry, ConnectionRecord, ConnectionStatus, RemoteEnv } from './registry.ts'
import type { SshConnector, SshTarget } from './ssh.ts'
import { targetFromRecord } from './ssh.ts'

export interface LivenessDeps {
  registry: ConnectionRegistry
  connector: SshConnector
  onStatus: (connId: string, status: ConnectionStatus) => void
  /** M2：运行时池（可选；注入后 ssh online 且 runtime.installed 的连接追加 runtime ping）。 */
  pool?: import('./remote-client.ts').RuntimePool
  /** 探测并发（默认 4）。 */
  concurrency?: number
  /** 单连接探测超时（默认 6s）。 */
  checkTimeoutMs?: number
  /** M2：runtime ping 超时（默认 3s）。 */
  runtimePingTimeoutMs?: number
  /** online 复探周期（默认 60s）。 */
  baseIntervalMs?: number
  /** 退避基数（默认 30s）。 */
  backoffBaseMs?: number
  /** 退避封顶（默认 5min）。 */
  backoffMaxMs?: number
  /** 周期抖动 ±15%。 */
  jitter?: number
}

export class LivenessProbe {
  private statuses = new Map<string, ConnectionStatus>()
  private timers = new Map<string, NodeJS.Timeout>()
  private backoff = new Map<string, number>()
  /** 在途探测（connId → Promise）：并发去重，调用方共享最终结果。 */
  private probing = new Map<string, Promise<ConnectionStatus>>()
  private stopped = false
  private deps: LivenessDeps

  constructor(deps: LivenessDeps) {
    this.deps = deps
  }

  getStatus(connId: string): ConnectionStatus {
    return this.statuses.get(connId) ?? { state: 'unknown' }
  }

  getStatuses(): Record<string, ConnectionStatus> {
    return Object.fromEntries(this.statuses)
  }

  /** 手动写入状态（disconnect 置 unknown / connect 成功写入 env）。 */
  setStatus(connId: string, status: ConnectionStatus): void {
    if (status.state === 'unknown') this.cancelTimer(connId)
    this.statuses.set(connId, status)
    this.deps.onStatus(connId, status)
  }

  /** 把探测出的远端 env 写入状态（连接成功后的 env 保留）。 */
  setEnv(connId: string, env: RemoteEnv): void {
    const prev = this.getStatus(connId)
    this.setStatus(connId, { ...prev, env })
  }

  /** 全量探测（并发 4）。插件加载时调用；不调度后续周期。 */
  async sweep(): Promise<void> {
    const conns = this.deps.registry.list()
    const concurrency = this.deps.concurrency ?? 4
    let index = 0
    const worker = async (): Promise<void> => {
      while (index < conns.length) {
        const conn = conns[index++]
        if (this.stopped) return
        await this.probe(conn)
      }
    }
    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, conns.length)) }, () => worker())
    await Promise.all(workers)
  }

  /** 启动周期探测：立即 sweep，随后按状态各自调度。 */
  start(): void {
    if (this.stopped) this.stopped = false
    void this.sweep().then(() => {
      if (this.stopped) return
      for (const conn of this.deps.registry.list()) this.scheduleNext(conn.id)
    })
  }

  /** 全量清理：停调度、清状态。 */
  stop(): void {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.backoff.clear()
    this.probing.clear()
  }

  /** 手动重测（/api/check 同步等结果，上限 checkTimeoutMs）。 */
  async checkNow(connId: string): Promise<ConnectionStatus | undefined> {
    this.cancelTimer(connId)
    const conn = this.deps.registry.get(connId)
    if (!conn) return undefined
    const status = await this.probe(conn)
    this.scheduleNext(connId)
    return status
  }

  private cancelTimer(connId: string): void {
    const timer = this.timers.get(connId)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(connId)
    }
  }

  /** 单连接探测：unknown→checking→online|offline。degraded M1 不产生。
   *  并发去重：在途探测共享同一 Promise（checkNow 与周期探测撞车时，
   *  调用方拿到的是最终结果而不是"checking"中间态）。 */
  private probe(conn: ConnectionRecord): Promise<ConnectionStatus> {
    const inflight = this.probing.get(conn.id)
    if (inflight) return inflight
    const task = this.probeOnce(conn).finally(() => {
      this.probing.delete(conn.id)
    })
    this.probing.set(conn.id, task)
    return task
  }

  private async probeOnce(conn: ConnectionRecord): Promise<ConnectionStatus> {
    // 先记住已有 env（探测期 checking 状态不携带 env，结束再回填）
    const priorEnv = this.statuses.get(conn.id)?.env
    this.setStatus(conn.id, { state: 'checking' })
    let result: ConnectionStatus
    try {
      const target = targetFromRecord(conn)
      // win 连接无 ssh，恒 online（interop 无需探测）
      let online = target ? await this.checked(conn, target) : true
      // 冷启动抖动吸收：ssh 首探失败（dsh web 启动期 CPU 高峰/网络冷启动）时
      // 3s 后复核一次再判 offline，避免侧栏状态"闪灰"。checkNow 同享此语义。
      if (!online && target) {
        await new Promise((resolve) => setTimeout(resolve, 3_000))
        online = await this.checked(conn, target)
      }
      if (online) {
        // M2：ssh online 且 runtime.installed → 追加 runtime ping；
        // ping 失败 → degraded（ssh 通但运行时挂）；此前 degraded 时 ping 成功自然回 online。
        if (target && conn.runtime?.installed === true && this.deps.pool) {
          const pingOk = await this.runtimePing(conn.id, target)
          result = pingOk
            ? { state: 'online', lastChecked: new Date().toISOString() }
            : { state: 'degraded', lastChecked: new Date().toISOString(), error: '运行时无响应：远端运行时通道不可用' }
        } else {
          result = { state: 'online', lastChecked: new Date().toISOString() }
        }
      } else {
        result = { state: 'offline', lastChecked: new Date().toISOString(), error: '无法建立 SSH 连接' }
      }
      // 保留已探测到的 env（连接成功信息不因周期探测丢失）
      if (priorEnv) result.env = priorEnv
    } catch (error) {
      result = {
        state: 'offline',
        lastChecked: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      }
    }
    this.setStatus(conn.id, result)
    return result
  }

  /** M2 runtime ping：RuntimePool.get（hello）+ call('ping')，整体 3s 超时；失败剔除池缓存。 */
  private async runtimePing(connId: string, target: SshTarget): Promise<boolean> {
    const pool = this.deps.pool
    if (!pool) return false
    const timeoutMs = this.deps.runtimePingTimeoutMs ?? 3_000
    let ok = false
    let timer: NodeJS.Timeout | undefined
    try {
      ok = await Promise.race([
        (async (): Promise<boolean> => {
          const client = await pool.get(connId, target)
          await client.call('ping', {}, timeoutMs)
          return true
        })(),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
    } catch {
      ok = false
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (!ok) pool.drop(connId)
    return ok
  }

  private async checked(conn: ConnectionRecord, target: SshTarget): Promise<boolean> {
    const timeoutMs = this.deps.checkTimeoutMs ?? 6_000
    let timer: NodeJS.Timeout | undefined
    let timedOut = false
    const race = Promise.race([
      this.deps.connector.check(target),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true
          resolve(false)
        }, timeoutMs)
      }),
    ])
    const online = await race
    if (timer) clearTimeout(timer)
    if (timedOut) {
      const prev = this.getStatus(conn.id)
      this.setStatus(conn.id, { ...prev, error: `探测超时（${timeoutMs / 1000}s）` })
    }
    return online
  }

  /** 按状态调度下一次探测：online/degraded → baseInterval±15%；offline → 指数退避。 */
  private scheduleNext(connId: string): void {
    if (this.stopped) return
    this.cancelTimer(connId)
    const status = this.getStatus(connId)
    const jitter = () => 1 + (this.deps.jitter ?? 0.15) * (Math.random() * 2 - 1)
    let delayMs: number
    // online 与 degraded 都按基础周期复探（degraded 是 ssh 在线但运行时异常，需尽快恢复探测）
    if (status.state === 'online' || status.state === 'degraded') {
      this.backoff.delete(connId)
      delayMs = (this.deps.baseIntervalMs ?? 60_000) * jitter()
    } else if (status.state === 'offline') {
      const n = this.backoff.get(connId) ?? 0
      this.backoff.set(connId, n + 1)
      delayMs = Math.min(
        (this.deps.backoffBaseMs ?? 30_000) * 2 ** Math.max(0, n - 1),
        this.deps.backoffMaxMs ?? 300_000,
      )
      if (n === 0) delayMs = this.deps.backoffBaseMs ?? 30_000
      delayMs *= jitter()
    } else {
      // checking / unknown 状态暂不调度（checkNow 会重调度）
      return
    }
    const timer = setTimeout(() => {
      this.timers.delete(connId)
      const conn = this.deps.registry.get(connId)
      if (!conn || this.stopped) return
      void this.probe(conn).then(() => this.scheduleNext(connId))
    }, delayMs)
    timer.unref?.()
    this.timers.set(connId, timer)
  }

  /** registry 变更（connect 成功 / disconnect / 删除）时重新调度。 */
  reschedule(connId: string): void {
    if (this.stopped) return
    this.cancelTimer(connId)
    const conn = this.deps.registry.get(connId)
    if (!conn) return
    // probe 自带在途去重：撞车时共享在途 Promise，完成后再排下一周期。
    void this.probe(conn).then(() => this.scheduleNext(connId))
  }
}