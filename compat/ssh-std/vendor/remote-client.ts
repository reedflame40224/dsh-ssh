/**
 * 远端运行时 stdio RPC 客户端 + 连接池（SPEC-M2 R2，与 cordis 无关的纯 Node 模块）。
 *
 * RemoteRuntimeClient：行分隔 JSON codec
 *  - 首行 hello（非请求响应）→ 构造时等待（5s 超时 reject）；
 *  - 请求 {"id":n,"method":...,"params":{...}} → 响应 {"id":n,"result":...} 或
 *    {"id":n,"error":{"code":"...","message":"..."}}；id 自增；pending map（10s 超时 reject）；
 *  - channel exit → 全部 pending reject + 状态 closed；close() = stdin EOF 优雅收尾。
 *
 * RuntimePool：connId → RemoteRuntimeClient 缓存，惰性建（openChannel spawn
 *  `~/.dsh-remote/current/start.sh --stdio`）、断线自动剔除、drop/disposeAll。
 */

import type { SshChannel, SshConnector, SshTarget } from './ssh.ts'
import { REMOTE_HOME } from './runtime-home.ts'

export interface HelloInfo {
  version: string
  platform: string
  arch: string
  node: string
}

export interface RuntimeClientDeps {
  channel: SshChannel
  /** hello 首行等待超时（默认 5s）。 */
  helloTimeoutMs?: number
  /** call 默认超时（默认 10s）。 */
  callTimeoutMs?: number
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer?: NodeJS.Timeout
}

/** hello 帧结构判定（type 字段且非请求响应）。 */
function isHello(obj: unknown): obj is HelloInfo {
  if (typeof obj !== 'object' || obj === null) return false
  const raw = obj as { type?: unknown; version?: unknown; platform?: unknown; arch?: unknown; node?: unknown }
  return raw.type === 'dsh-remote-hello'
}

export class RemoteRuntimeClient {
  /** hello 首行握手结果（构造时等待，5s 超时 reject）。 */
  readonly helloInfo: Promise<HelloInfo>
  private channel: SshChannel
  private nextId = 1
  private pending = new Map<number, PendingCall>()
  private closed = false
  private defaultCallTimeoutMs: number

  constructor(deps: RuntimeClientDeps) {
    this.channel = deps.channel
    this.defaultCallTimeoutMs = deps.callTimeoutMs ?? 10_000

    // hello 握手：首行等待；channel 提早退出也视为失败
    this.helloInfo = new Promise<HelloInfo>((resolve, reject) => {
      const helloTimeoutMs = deps.helloTimeoutMs ?? 5_000
      let timer: NodeJS.Timeout | undefined
      const fail = (reason: Error): void => {
        if (timer) { clearTimeout(timer); timer = undefined }
        reject(reason)
      }
      timer = setTimeout(() => fail(new Error(`运行时 hello 握手超时（${helloTimeoutMs / 1000}s）`)), helloTimeoutMs)
      timer.unref?.()
      this.channel.onLine((line) => {
        let obj: unknown
        try { obj = JSON.parse(line) } catch { return }
        if (!isHello(obj)) return
        if (timer) { clearTimeout(timer); timer = undefined }
        resolve({
          version: String((obj as HelloInfo).version ?? ''),
          platform: String((obj as HelloInfo).platform ?? ''),
          arch: String((obj as HelloInfo).arch ?? ''),
          node: String((obj as HelloInfo).node ?? ''),
        })
      })
      this.channel.onExit((code) => fail(new Error(`运行时通道提前退出（exit ${code}）`)))
    })

    // 响应分派 + 断线兜底
    this.channel.onLine((line) => this.handleLine(line))
    this.channel.onExit((code) => {
      this.closed = true
      const reason = new Error(`运行时通道已关闭（exit ${code}）`)
      for (const [, entry] of this.pending) {
        if (entry.timer) clearTimeout(entry.timer)
        entry.reject(reason)
      }
      this.pending.clear()
    })
  }

  get exited(): boolean {
    return this.channel.exited
  }

  /** 发起一个 RPC 调用（id 自增；pending 超时 reject；通道已关立即 reject）。 */
  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    if (this.closed || this.channel.exited) {
      return Promise.reject(new Error('运行时通道已关闭'))
    }
    const id = this.nextId++
    this.channel.write(JSON.stringify({ id, method, params }))
    const budget = timeoutMs ?? this.defaultCallTimeoutMs
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`RPC 调用超时：${method}（${budget / 1000}s）`))
      }, budget)
      timer.unref?.()
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      })
    })
  }

  /** 优雅关闭：stdin EOF（远端进程读 EOF 自行退出）。 */
  close(): void {
    this.closed = true
    try { this.channel.close() } catch { /* 已关 */ }
  }

  private handleLine(line: string): void {
    let obj: unknown
    try { obj = JSON.parse(line) } catch { return }
    if (!obj || typeof obj !== 'object' || isHello(obj)) return
    const frame = obj as { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } }
    if (typeof frame.id !== 'number' && typeof frame.id !== 'string') return
    // 本客户端 id 恒为自增数字，服务端原样回显；字符串 id 兜底按相等取用
    const key = frame.id
    const entry = typeof key === 'number' ? this.pending.get(key) : this.pending.get(Number(key))
    if (!entry) return
    this.pending.delete(key)
    if (entry.timer) clearTimeout(entry.timer)
    if (frame.error !== undefined && frame.error !== null) {
      const code = String(frame.error.code ?? 'RPC_ERROR')
      const message = String(frame.error.message ?? '')
      entry.reject(new Error(`远端运行时错误：${code} ${message}`.trim()))
    } else {
      entry.resolve(frame.result)
    }
  }
}

export interface RuntimePoolDeps {
  connector: SshConnector
}

/** connId → RemoteRuntimeClient 缓存池：惰性建 / 断线剔除 / disposeAll。 */
export class RuntimePool {
  private connector: SshConnector
  private clients = new Map<string, RemoteRuntimeClient>()

  constructor(deps: RuntimePoolDeps) {
    this.connector = deps.connector
  }

  /**
   * 惰性建/复用：openChannel spawn `~/.dsh-remote/current/start.sh --stdio`（远端登录
   * 用户家目录，经远程 shell 展开 `~`）。等待 hello 首行成功才入缓存；失败关通道并抛错。
   */
  async get(key: string, target: SshTarget): Promise<RemoteRuntimeClient> {
    const cached = this.clients.get(key)
    if (cached && !cached.exited) return cached
    if (cached) this.clients.delete(key)
    const channel = await this.connector.openChannel(target, `~/${REMOTE_HOME}/current/start.sh --stdio`)
    const client = new RemoteRuntimeClient({ channel })
    try {
      await client.helloInfo
    } catch (error) {
      try { channel.close() } catch { /* 已关 */ }
      this.clients.delete(key)
      throw new Error(`远端运行时启动失败：${error instanceof Error ? error.message : String(error)}`)
    }
    // 断线自动剔除缓存（下次 get 重建）
    channel.onExit(() => {
      if (this.clients.get(key) === client) this.clients.delete(key)
    })
    this.clients.set(key, client)
    return client
  }

  /** 关闭并移除指定连接通道。 */
  drop(key: string): void {
    const client = this.clients.get(key)
    if (!client) return
    this.clients.delete(key)
    try { client.close() } catch { /* 已关 */ }
  }

  /** ctx.effect 清理：关闭全部通道。 */
  disposeAll(): void {
    for (const client of this.clients.values()) {
      try { client.close() } catch { /* 已关 */ }
    }
    this.clients.clear()
  }
}
