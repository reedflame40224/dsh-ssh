/**
 * terminals 后端（type 'ssh'，SPEC-M5 契约 C）：本地 PTY 包裹 dshSsh.buildRemoteSpawn 的
 * 远端交互 shell（ssh -tt，M1 真机验证过的通道）。
 *
 * spawn 语义：
 *  - spec.cwd 经 dshRemotePaths.match 找连接；未命中 throw（该 cwd 非已注册远程根）；
 *  - 命中 → ctx.subprocess.spawnTerminal(argv = buildRemoteSpawn({connectionId, cwd}))
 *    （本地 node-pty 起 ssh -tt 远端登录 shell；远端 cwd 不存于本地，本地进程 cwd 用
 *    process.cwd()）；
 *  - 返回包装成 TerminalBackendSession 形状的会话（output/write/resize/done/terminate/signal）。
 *
 * 简化设计（与 terminal-bash 的完整 xterm 模拟器不同）：
 *  - 无 @xterm/headless 依赖（dsh-ssh 不依赖 @deepseek-ai/* 运行时值），输出做
 *    ANSI 剥离 + 行缓冲，交互语义（startSend 等待提示符/静默/超时）按
 *    TerminalWaitReason 四值实现；
 *  - signal 转发给 foreground 进程组；close 收敛进程树后 settle session_exit。
 *
 * 规范约束：不 import 任何 @deepseek-ai/* 运行时值；形状用本地最小结构面。
 */

import type { DshRemotePaths } from './remote-paths.ts'

// ── 本地最小结构面（packages/terminal/terminal/src/types.ts 的逐字形状）────

export type TerminalWaitReason = 'stdin_read' | 'inferred_idle' | 'timeout' | 'session_exit'
export type TerminalSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGTSTP' | 'SIGHUP'
export type TerminalSessionStatusLike =
  | { kind: 'running' }
  | { kind: 'exited'; exitCode: number | null; signal: NodeJS.Signals | null }

export interface TerminalSendRequestLike {
  text: string
  submit: boolean
  signal?: AbortSignal
}

export interface TerminalSendReadLike {
  delta: string
  truncated: boolean
}

export interface TerminalSendResultLike {
  viewport: string
  waitReason: TerminalWaitReason
  sessionStatus: TerminalSessionStatusLike
  truncated: boolean
}

export interface TerminalSendOperationLike {
  done: Promise<TerminalSendResultLike>
  readOutput(): TerminalSendReadLike
  cancel(): boolean
}

export interface TerminalReadRequestLike {
  offset?: number
  count?: number
}

export interface TerminalReadResultLike {
  text: string
  totalLines: number
  lineBegin: number
  lineEnd: number
  truncated: boolean
}

export interface TerminalBackendSpawnSpecLike {
  sessionId: string
  owner: unknown
  type: string
  name?: string
  cwd?: string
  signal?: AbortSignal
}

export interface TerminalBackendSessionLike {
  readonly motd: string
  readonly pid?: number
  startSend(request: TerminalSendRequestLike): TerminalSendOperationLike
  read(request: TerminalReadRequestLike): TerminalReadResultLike
  signal(signal: TerminalSignal): Promise<{ delivered: true; targetPgid: number }>
  status(): TerminalSessionStatusLike
  close(reason: string): Promise<void>
}

export interface TerminalBackendLike {
  type: string
  spawn(spec: TerminalBackendSpawnSpecLike): Promise<TerminalBackendSessionLike>
}

/** subprocess.spawnTerminal 的本地最小面（packages/subprocess/subprocess/src/types.ts）。 */
export interface RemoteTerminalHandleLike {
  pid: number
  output: NodeJS.ReadableStream
  done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  write(data: string): Promise<void>
  resize?(cols: number, rows: number): void | Promise<void>
  signalForeground(signal: TerminalSignal): Promise<number>
  terminate(): Promise<void>
}

export interface RemoteTerminalSpawnSpecLike {
  argv: readonly string[]
  cwd: string
  env?: Record<string, string>
  rows: number
  cols: number
  graceMs: number
  signal?: AbortSignal
}

export interface SshTerminalBackendDeps {
  /** dshSsh 服务（buildRemoteSpawn 产 ssh -tt argv）。 */
  dshSsh: {
    buildRemoteSpawn(spec: { connectionId: string; cwd?: string; shell?: string }): {
      argv: string[]
      name: string
      env?: Record<string, string>
    }
  }
  paths: DshRemotePaths
  /** ctx.subprocess.spawnTerminal（返回本地 PTY 会话）。 */
  spawnTerminal(spec: RemoteTerminalSpawnSpecLike): Promise<RemoteTerminalHandleLike>
  /** terminals 注册表（index.ts 注入后传入）。 */
  terminals: { registerBackend(backend: TerminalBackendLike): () => void }
  rows?: number
  cols?: number
  graceMs?: number
  /** 单次 send 等待上限（默认 30s）。 */
  timeoutMs?: number
  /** 输出静默判 idle（默认 800ms）。 */
  idleMs?: number
  maxReadBytes?: number
  scrollbackMaxBytes?: number
  scrollbackLines?: number
}

// ── 小工具 ─────────────────────────────────────────────────────────────────

/** 剥离 CSI/OSC/charset 选择的 ANSI 转义（无模拟器下的可读文本近似）。 */
const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\)|\([A-Za-z0-9]|\)[A-Za-z0-9])/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE, '')
}

function requireSafeInteger(name: string, value: number, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`)
  }
  return value
}

function requirePositiveFinite(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive finite number`)
  return value
}

/** 字节上限内保留 UTF-8 尾段（与 terminal-bash 的 utf8Tail 同语义）。 */
function utf8Tail(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
  const chars = Array.from(text)
  let bytes = 0
  let start = chars.length
  while (start > 0) {
    const next = Buffer.byteLength(chars[start - 1] as string, 'utf8')
    if (bytes + next > maxBytes) break
    bytes += next
    start -= 1
  }
  return { text: chars.slice(start).join(''), truncated: true }
}

class BoundedTextBuffer {
  private value = ''
  private dropped = false
  private readonly maxBytes: number
  private readonly maxLines?: number

  constructor(maxBytes: number, maxLines?: number) {
    this.maxBytes = maxBytes
    this.maxLines = maxLines
  }

  append(text: string): void {
    if (text.length === 0) return
    this.value += text
    if (this.maxLines !== undefined) {
      const lines = this.value.split('\n')
      if (lines.length > this.maxLines) {
        this.value = lines.slice(lines.length - this.maxLines).join('\n')
        this.dropped = true
      }
    }
    const tail = utf8Tail(this.value, this.maxBytes)
    this.value = tail.text
    this.dropped ||= tail.truncated
  }

  snapshot(): { text: string; truncated: boolean } {
    return { text: this.value, truncated: this.dropped }
  }

  consume(): TerminalSendReadLike {
    const snapshot = this.snapshot()
    this.value = ''
    this.dropped = false
    return { delta: snapshot.text, truncated: snapshot.truncated }
  }
}

/** 末行是否形如 shell 提示符（bash 'user@host:~$ ' / '# ' / pwsh '❯' 等）。 */
function promptLike(text: string): boolean {
  const lines = text.split('\n')
  const last = lines[lines.length - 1] ?? ''
  if (/[\$#>❯]\s*$/.test(last)) return true
  return /^[\w.-]+@[\w.:-]+:[\w./~-]*[\$#%] ?$/.test(last.trim())
}

// ── 会话 ────────────────────────────────────────────────────────────────────

/** 远端 PTY 会话（TerminalBackendSession 实现；交互语义为提示符/静默/超时三态）。 */
export class RemoteSshPtySession implements TerminalBackendSessionLike {
  motd = ''
  readonly pid: number
  private decoder = new TextDecoder()
  private scrollback: BoundedTextBuffer
  private statusValue: TerminalSessionStatusLike = { kind: 'running' }
  private active: SshSendOperation | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private lastOutputAt = 0
  private closing = false
  private closePromise: Promise<void> | undefined
  private transportFailure: Error | undefined
  private activeAbort: (() => void) | undefined
  private activeWrite: Promise<void> | undefined
  private interrupting: SshSendOperation | undefined
  private outputEnded: PromiseWithResolvers<void>
  private completion: Promise<void>
  private readonly idleMs: number
  private readonly timeoutMs: number
  private readonly maxReadBytes: number
  private readonly terminal: RemoteTerminalHandleLike

  constructor(terminal: RemoteTerminalHandleLike, opts: Required<Pick<SshTerminalBackendDeps, 'timeoutMs' | 'idleMs' | 'maxReadBytes' | 'scrollbackMaxBytes' | 'scrollbackLines'>>) {
    this.terminal = terminal
    this.pid = terminal.pid
    this.idleMs = opts.idleMs
    this.timeoutMs = opts.timeoutMs
    this.maxReadBytes = opts.maxReadBytes
    this.scrollback = new BoundedTextBuffer(opts.scrollbackMaxBytes, opts.scrollbackLines)
    this.outputEnded = Promise.withResolvers<void>()
    this.completion = terminal.done.then(
      (outcome) => this.onExit(outcome),
      (error: unknown) => { this.onTransportFailure(error) },
    )
    const output = terminal.output as NodeJS.ReadableStream & {
      on(event: string, cb: (chunk: unknown) => void): void
      once(event: string, cb: () => void): void
      off?(event: string, cb: (...args: any[]) => void): void
      removeListener?(event: string, cb: (...args: any[]) => void): void
    }
    const onData = (chunk: unknown) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk as Buffer
      this.onData(this.decoder.decode(bytes, { stream: true }))
    }
    const onEnd = () => {
      this.onData(this.decoder.decode())
      this.outputEnded.resolve()
    }
    const onError = (error: unknown) => {
      this.onTransportFailure(error as Error)
      this.outputEnded.resolve()
    }
    output.on('data', onData)
    output.once('end', onEnd)
    output.once('error', onError)
    this.detachOutput = () => {
      if (typeof output.off === 'function') {
        output.off('data', onData)
        output.off('end', onEnd)
        output.off('error', onError)
      } else if (typeof output.removeListener === 'function') {
        output.removeListener('data', onData)
        output.removeListener('end', onEnd)
        output.removeListener('error', onError)
      }
    }
  }

  private detachOutput: () => void = () => {}

  private onData(text: string): void {
    if (text.length === 0) return
    const cleaned = stripAnsi(text).replaceAll('\r\n', '\n')
    if (cleaned.length === 0) return
    this.lastOutputAt = Date.now()
    this.scrollback.append(cleaned)
    this.active?.append(cleaned)
  }

  private async onExit(outcome: { exitCode: number | null; signal: NodeJS.Signals | null }): Promise<void> {
    await this.outputEnded.promise
    if (this.transportFailure !== undefined) return
    this.statusValue = { kind: 'exited', exitCode: outcome.exitCode, signal: outcome.signal }
    this.settleActive('session_exit')
  }

  private onTransportFailure(error: unknown): void {
    const failure = error instanceof Error ? error : new Error(String(error))
    this.transportFailure ??= failure
    this.statusValue = { kind: 'exited', exitCode: null, signal: null }
    this.stopPolling()
    this.activeAbort?.()
    this.activeAbort = undefined
    const operation = this.active
    this.active = undefined
    operation?.fail(failure)
    void this.terminal.terminate().catch(() => {})
  }

  /** 启动：等首屏输出静默，作为 motd（terminal_open 的初始输出）。 */
  async initialize(signal?: AbortSignal): Promise<void> {
    const operation = this.startSend({ text: '', submit: false, ...(signal !== undefined ? { signal } : {}) })
    let removeAbort: (() => void) | undefined
    try {
      let result: TerminalSendResultLike
      if (signal === undefined) {
        result = await operation.done
      } else {
        let rejectAbort!: (reason?: unknown) => void
        const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
        const onAbort = () => {
          operation.cancel()
          rejectAbort(signal.reason)
        }
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
        removeAbort = () => signal.removeEventListener('abort', onAbort)
        result = await Promise.race([operation.done, aborted])
      }
      signal?.throwIfAborted()
      if (result.waitReason === 'session_exit') throw new Error('远端 shell 在启动期间退出')
      if (result.waitReason === 'timeout') throw new Error('远端 shell 启动超时（无输出）')
      this.motd = result.viewport
    } catch (error) {
      signal?.throwIfAborted()
      throw error
    } finally {
      removeAbort?.()
    }
  }

  startSend(request: TerminalSendRequestLike): SshSendOperation {
    if (this.closing) throw new Error('PTY session is closing')
    if (this.statusValue.kind === 'exited') throw new Error('PTY session has exited')
    if (this.active !== undefined) throw new Error('PTY session already has an active send')
    if (request.signal?.aborted === true) throw new Error('PTY send aborted before write')

    const operation = new SshSendOperation(this.maxReadBytes, () => this.cancelOperation(operation))
    this.active = operation
    this.lastOutputAt = Date.now()
    const startedAt = Date.now()
    operation.markStarted(startedAt)

    if (request.signal !== undefined) {
      const onAbort = () => operation.cancel()
      request.signal.addEventListener('abort', onAbort, { once: true })
      this.activeAbort = () => request.signal?.removeEventListener('abort', onAbort)
    }
    if (this.pollTimer === undefined) {
      this.pollTimer = setInterval(() => this.poll(), 100)
    }

    const input = `${request.text}${request.submit ? '\r' : ''}`
    if (input.length > 0) {
      try {
        const write = this.terminal.write(input)
        this.activeWrite = write
        void write.then(() => {
          if (this.activeWrite === write) this.activeWrite = undefined
        }, (error: unknown) => {
          if (this.activeWrite === write) this.activeWrite = undefined
          if (this.active === operation && !this.closing) this.onTransportFailure(error)
        })
      } catch (error) {
        this.onTransportFailure(error)
      }
    }
    return operation
  }

  private cancelOperation(operation: SshSendOperation): void {
    if (this.active !== operation) return
    if (this.interrupting === operation) return
    this.interrupting = operation
    this.stopPolling()
    void (async () => {
      try {
        if (this.activeWrite !== undefined) {
          try { await this.activeWrite } catch { return }
        }
        if (this.active === operation && !this.closing) await this.terminal.signalForeground('SIGINT')
      } catch (error) {
        if (this.active === operation && !this.closing) this.onTransportFailure(error)
      } finally {
        if (this.interrupting === operation) this.interrupting = undefined
      }
      if (this.active === operation && !this.closing && this.statusValue.kind === 'running') {
        this.lastOutputAt = Date.now()
        this.pollTimer = setInterval(() => this.poll(), 100)
      }
    })()
  }

  private poll(): void {
    if (this.closing) {
      this.stopPolling()
      return
    }
    const operation = this.active
    if (operation === undefined) {
      this.stopPolling()
      return
    }
    if (this.interrupting === operation) return
    if (this.statusValue.kind === 'exited') {
      this.settleActive('session_exit')
      return
    }
    if (operation.cancelled) {
      this.settleActive('inferred_idle')
      return
    }
    const viewport = operation.buffer.snapshot().text
    const quietFor = Date.now() - this.lastOutputAt
    const hasOutput = viewport.length > 0
    if (hasOutput && quietFor >= this.idleMs) {
      this.settleActive(promptLike(viewport) ? 'stdin_read' : 'inferred_idle')
      return
    }
    if (Date.now() - operation.startedAt >= this.timeoutMs) {
      this.settleActive('timeout')
    }
  }

  private settleActive(waitReason: TerminalWaitReason): void {
    const operation = this.active
    if (operation === undefined) return
    this.active = undefined
    this.stopPolling()
    this.activeAbort?.()
    this.activeAbort = undefined
    const snapshot = operation.buffer.snapshot()
    operation.settle(waitReason, this.statusValue, snapshot.truncated)
  }

  private stopPolling(): void {
    if (this.pollTimer !== undefined) {
      clearInterval(this.pollTimer)
      this.pollTimer = undefined
    }
  }

  read(request: TerminalReadRequestLike): TerminalReadResultLike {
    const text = this.scrollback.snapshot().text
    const lines = text.split('\n')
    const totalLines = text.length === 0 ? 0 : lines.length
    const offset = requireSafeInteger('PTY read offset', request.offset ?? 0, 0)
    const count = requireSafeInteger('PTY read count', request.count ?? 500, 1)
    if (offset >= totalLines) {
      return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: this.scrollback.snapshot().truncated }
    }
    const end = totalLines - offset
    const start = Math.max(0, end - count)
    const requested = lines.slice(start, end).join('\n')
    const bounded = utf8Tail(requested, this.maxReadBytes)
    const returnedLines = bounded.text.length === 0 ? 0 : bounded.text.split('\n').length
    return {
      text: bounded.text,
      totalLines,
      lineBegin: offset,
      lineEnd: offset + returnedLines,
      truncated: this.scrollback.snapshot().truncated || bounded.truncated,
    }
  }

  async signal(signal: TerminalSignal): Promise<{ delivered: true; targetPgid: number }> {
    if (this.closing) throw new Error('PTY session is closing')
    const targetPgid = await this.terminal.signalForeground(signal)
    return { delivered: true, targetPgid }
  }

  /** 便捷方法（TerminalBackendSession 之外）：转发窗口尺寸。 */
  async resize(cols: number, rows: number): Promise<void> {
    requireSafeInteger('terminal columns', cols, 1)
    requireSafeInteger('terminal rows', rows, 1)
    if (cols > 500 || rows > 500) throw new Error('terminal dimensions must be <= 500')
    if (typeof this.terminal.resize === 'function') await this.terminal.resize(cols, rows)
  }

  status(): TerminalSessionStatusLike {
    return this.statusValue
  }

  close(reason: string): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    this.stopPolling()
    const closing = this.closeOnce(reason).catch((error: unknown) => {
      this.closePromise = undefined
      this.activeAbort?.()
      this.activeAbort = undefined
      const operation = this.active
      this.active = undefined
      operation?.fail(error)
      throw error
    })
    this.closePromise = closing
    return closing
  }

  private async closeOnce(reason: string): Promise<void> {
    try {
      await this.terminal.terminate()
    } catch (error: unknown) {
      throw new Error(`ssh 终端清理失败（${reason}）：${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    this.settleActive('session_exit')
    await this.completion
    this.detachOutput()
    if (this.transportFailure !== undefined) throw this.transportFailure
  }
}

class SshSendOperation implements TerminalSendOperationLike {
  readonly buffer: BoundedTextBuffer
  private resolvers: PromiseWithResolvers<TerminalSendResultLike>
  private finished = false
  startedAt = 0
  cancelled = false
  private readonly onCancel: () => void

  constructor(maxReadBytes: number, onCancel: () => void) {
    this.onCancel = onCancel
    this.buffer = new BoundedTextBuffer(maxReadBytes)
    this.resolvers = Promise.withResolvers<TerminalSendResultLike>()
  }

  get done(): Promise<TerminalSendResultLike> {
    return this.resolvers!.promise
  }

  markStarted(timestamp: number): void {
    this.startedAt = timestamp
  }

  append(text: string): void {
    if (!this.finished) this.buffer.append(text)
  }

  settle(waitReason: TerminalWaitReason, sessionStatus: TerminalSessionStatusLike, inheritedTruncation: boolean): void {
    if (this.finished) return
    this.finished = true
    const snapshot = this.buffer.snapshot()
    this.resolvers!.resolve({
      viewport: snapshot.text,
      waitReason,
      sessionStatus,
      truncated: snapshot.truncated || inheritedTruncation,
    })
  }

  fail(error: unknown): void {
    if (this.finished) return
    this.finished = true
    this.resolvers.reject(error)
  }

  readOutput(): TerminalSendReadLike {
    return this.buffer.consume()
  }

  cancel(): boolean {
    if (this.finished) return false
    this.cancelled = true
    this.onCancel()
    return true
  }
}

// ── 后端注册 ────────────────────────────────────────────────────────────────

/** 注册 terminals 后端（type 'ssh'）；返回 ctx.effect 可回收的 disposer。 */
export function registerSshTerminalBackend(deps: SshTerminalBackendDeps): () => void {
  const idleMs = requirePositiveFinite('idleMs', deps.idleMs ?? 800)
  const timeoutMs = requirePositiveFinite('timeoutMs', deps.timeoutMs ?? 30_000)
  const maxReadBytes = requireSafeInteger('maxReadBytes', deps.maxReadBytes ?? 64 * 1024, 1)
  const scrollbackMaxBytes = requireSafeInteger('scrollbackMaxBytes', deps.scrollbackMaxBytes ?? 512 * 1024, 1)
  const scrollbackLines = requireSafeInteger('scrollbackLines', deps.scrollbackLines ?? 2000, 1)
  const rows = requireSafeInteger('rows', deps.rows ?? 30, 1)
  const cols = requireSafeInteger('cols', deps.cols ?? 120, 1)
  const graceMs = requirePositiveFinite('graceMs', deps.graceMs ?? 3_000)

  const backend: TerminalBackendLike = {
    type: 'ssh',
    spawn: async (spec) => {
      spec.signal?.throwIfAborted()
      const cwd = spec.cwd ?? ''
      const match = deps.paths.match(cwd)
      if (match === undefined) {
        throw new Error(`cwd 不在已注册远程工作区内（${cwd.length > 0 ? cwd : '(空)'}），无法打开远端终端`)
      }
      // ssh -tt 登录 shell（M1 真机验证）。spec.name 只是 terminal_open 显示名，
      // 绝不能当 shell 参数传入；dshSsh 会选缓存登录 shell 或远端 $SHELL。
      const built = deps.dshSsh.buildRemoteSpawn({ connectionId: match.connectionId, cwd })
      const terminal = await deps.spawnTerminal({
        argv: built.argv,
        // 远端 cwd 不存于本地：本地 ssh 客户端进程的工作目录用进程 cwd
        cwd: process.cwd(),
        env: { TERM: 'xterm-256color', ...(built.env ?? {}) },
        rows,
        cols,
        graceMs,
        signal: spec.signal,
      })
      const session = new RemoteSshPtySession(terminal, {
        idleMs,
        timeoutMs,
        maxReadBytes,
        scrollbackMaxBytes,
        scrollbackLines,
      })
      try {
        await session.initialize(spec.signal)
        return session
      } catch (error) {
        try {
          await session.close('ssh 终端启动失败')
        } catch (closeError: unknown) {
          // 启动失败 + 清理失败：抛后者同时带上前者原因（对齐 TerminalBackendCleanupError 语义的本地近似）
          throw new AggregateError([error, closeError], 'ssh 终端启动与清理均失败')
        }
        throw error
      }
    },
  }

  return deps.terminals.registerBackend(backend)
}
