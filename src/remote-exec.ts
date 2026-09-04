/**
 * RemoteFsLike / RemoteExecLike 实现（SPEC-M5 契约 A/B，与 cordis 无关的纯 Node 模块）。
 *
 * 两个路由服务的远端执行器落在同一模块：
 * - RemoteFsLike：方法面与 FileSystem（fs-local 公开方法）等价，操作对象是远端
 *   绝对路径（远程工作区注册后，本地工具层看到的路径就是远端路径）；
 * - RemoteExecLike：run/start/resolve 对齐 bash-local（ShellRunResult/ShellProcess），
 *   spawn 对齐 subprocess-local（SubprocessHandle，glob/grep 的 rg spawn 命中，
 *   argv[0] 是本地 rg 绝对路径 → 翻译为远端运行时内 `~/.dsh-remote/current/tools/rg`）。
 *
 * 通道选择（契约 B）：优先走 RuntimePool（快、常驻）；运行时缺失 / degraded /
 * 通道报错 → 回落 connector.exec（ssh 一次性命令，慢但对）。密码连接 exec 每次
 * 走 askpass、interop 连接无 mux，一次性命令比 mux 慢——已知，注释即可。
 *
 * 规范约束：不 import 任何 @deepseek-ai/* 运行时值；方法参数用本地最小结构面，
 * 类型层面与 harness 各 seam 的公开形状逐字段对齐（Node 24 类型擦除兼容）。
 */

import { isAbsolute, join, relative, resolve, basename, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ConnectionRegistry, ConnectionStatus } from './registry.ts'
import type { SshConnector, SshTarget } from './ssh.ts'
import { shellQuote, targetFromRecord } from './ssh.ts'
import type { RuntimePool } from './remote-client.ts'
import type { RemotePathMatch } from './remote-paths.ts'

// ── 常量 ────────────────────────────────────────────────────────────────────

/** 本地 rg 二进制 basename（@vscode/ripgrep 包内 bin/rg；翻译判定用）。 */
const RG_BASENAMES = new Set(['rg', 'rg.exe'])
/** 远端运行时内 rg 路径（build-runtime.mjs 组件清单 tools/rg）。
 *  用 $HOME 而非 ~：~ 只在词首展开（命令经 `cd … && exec …` 包裹后 rg 不在词首
 *  会按字面相对路径命中——真机踩过，agent 被迫建字面 ~ 目录变通）。 */
const REMOTE_RG_PATH = '$HOME/.dsh-remote/current/tools/rg'
/** 远端 exec 兜底超时（无调用方 timeout 时使用；本地 spawn 无上限，靠调用方 signal 取消）。 */
const DEFAULT_EXEC_TIMEOUT_MS = 120_000
/** fs 读远端文件的内存上限（运行时 readText 的 maxBytes；防无界取回）。 */
const FS_READ_CAP_BYTES = 64 * 1024 * 1024
/** 本地 shell 默认 timeout（bash-local resolve 未给值时）。 */
const DEFAULT_SHELL_TIMEOUT_MS = 120_000
const MAX_SHELL_TIMEOUT_MS = 600_000

// ── 通用小工具 ──────────────────────────────────────────────────────────────

/** 归一化 stdout/stderr 段（CollectedOutput 形状：text/truncated/spillPath?）。 */
function collectedText(text: string): { text: string; truncated: boolean } {
  return { text, truncated: false }
}

/** 解析正在执行的远端目标（kind!=='ssh' 或无记录 → undefined）。 */
function targetOf(registry: ConnectionRegistry, connectionId: string): SshTarget | undefined {
  const record = registry.get(connectionId)
  if (!record) return undefined
  return targetFromRecord(record)
}

// ── RemoteFsLike 类型面（与 FileSystem 公开方法签名等价）──────────────────

export interface RemoteFsTarget {
  targetKey: string
  displayPath: string
}

export interface RemoteFsInfo {
  version: string
  type: 'file' | 'directory' | 'other'
  size?: number
}

export interface RemoteFsPathInfo {
  version: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size?: number
}

export interface RemoteFsDirEntry {
  name: string
  type: 'file' | 'directory' | 'other'
  target: RemoteFsTarget
  version?: string
  size?: number
}

export type RemoteFsWriteIntent =
  | { kind: 'createIfAbsent' }
  | { kind: 'replaceIfVersion'; version: string }

export interface RemoteFsWriteOutcome {
  operation: 'create' | 'update'
  version: string
  before: string | null
  after: string
}

export interface RemoteFsEditRequest {
  oldString: string
  newString: string
  replaceAll: boolean
}

export interface RemoteFsEditOutcome {
  version: string
  before: string
  after: string
}

/** fsRemoteRouter.route 返回的远端文件实现（方法面对齐 FileSystem 真实公开方法）。 */
export interface RemoteFsLike {
  resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<RemoteFsTarget>
  processPath(target: RemoteFsTarget): string
  processPathFromHostPath(hostPath: string): string | undefined
  fileUrl(target: RemoteFsTarget): string
  contains(parent: RemoteFsTarget, child: RemoteFsTarget): boolean
  stat(target: RemoteFsTarget, signal?: AbortSignal): Promise<RemoteFsInfo | undefined>
  lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<RemoteFsPathInfo | undefined>
  readText(target: RemoteFsTarget, signal?: AbortSignal): Promise<string>
  streamText(target: RemoteFsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
  readBytes(target: RemoteFsTarget, signal: AbortSignal | undefined, maxBytes?: number): Promise<Uint8Array>
  listDir(target: RemoteFsTarget, signal?: AbortSignal): Promise<RemoteFsDirEntry[]>
  writeText(
    target: RemoteFsTarget,
    content: string,
    expected?: RemoteFsWriteIntent,
    signal?: AbortSignal,
  ): Promise<RemoteFsWriteOutcome>
  editText(
    target: RemoteFsTarget,
    edit: RemoteFsEditRequest,
    expected?: { version: string },
    signal?: AbortSignal,
  ): Promise<RemoteFsEditOutcome>
}

// ── RemoteExecLike 类型面（bash-local + subprocess-local 公开方法并集）────

export interface RemoteShellExecSpec {
  command: string
  workdir: string
  timeoutMs: number
  stdoutMaxBytes: number
  signal?: AbortSignal
  stdin?: string
  env?: Record<string, string>
  dshEnv?: Record<string, string>
  sandboxPolicy?: unknown
}

/** bash-local resolve 的请求面。 */
export interface RemoteShellExecRequest {
  command: string
  workdir?: string
  timeoutMs?: number
  stdoutMaxBytes?: number
  signal?: AbortSignal
  stdin?: string
  env?: Record<string, string>
  dshEnv?: Record<string, string>
  sandboxPolicy?: unknown
}

export interface RemoteCollectedOutput {
  text: string
  truncated: boolean
  spillPath?: string
}

export interface RemoteShellRunResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
  aborted: boolean
  timeoutMs: number
  stdout: RemoteCollectedOutput
  stderr: RemoteCollectedOutput
}

export interface RemoteShellProcessRead {
  delta: string
  lossy: boolean
  stdoutSpillPath?: string
  stderrSpillPath?: string
}

export type RemoteShellProcessStatus = 'running' | 'completed' | 'killed'

export interface RemoteShellProcess {
  status: RemoteShellProcessStatus
  exitCode: number | null
  signal: NodeJS.Signals | null
  done: Promise<void>
  readOutput(): RemoteShellProcessRead
  kill(): boolean
}

/** subprocess spawn 的 spec 面（stdio 只读 maxBytes，远端不提供 raw pipe）。 */
export interface RemoteSubprocessSpawnSpec {
  argv: readonly string[]
  cwd: string
  stdio?: {
    stdin?: unknown
    stdout?: unknown
    stderr?: unknown
  }
  graceMs?: number
  signal?: AbortSignal
  env?: Record<string, string>
}

export interface RemoteSubprocessOutcome {
  exitCode: number | null
  signal: NodeJS.Signals | null
}

/** 与 SubprocessOutputReader.readFrom 等价的增量读结果。 */
export interface RemoteOutputRead {
  text: string
  nextOffset: number
  lossy: boolean
  spillPath?: string
}

/** 远端进程句柄（形状对齐 SubprocessHandle；pid 为合成 id）。 */
export interface RemoteSubprocessHandle {
  readonly pid: number
  readonly stdin: undefined
  readonly stdout: undefined
  readonly stderr: undefined
  readonly collected: { stdout?: RemoteOutputReader; stderr?: RemoteOutputReader }
  readonly done: Promise<RemoteSubprocessOutcome>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

/** shellRemoteRouter / subprocessRemoteRouter 共用的远端执行器面。 */
export interface RemoteExecLike {
  resolve(request: RemoteShellExecRequest): RemoteShellExecSpec
  run(spec: RemoteShellExecSpec): Promise<RemoteShellRunResult>
  start(spec: RemoteShellExecSpec): RemoteShellProcess
  spawn(spec: RemoteSubprocessSpawnSpec): RemoteSubprocessHandle
}

// ── 遥控依赖面（local minimal，避免 @deepseek-ai/* 运行时值）──────────────

export interface RemoteOpsDeps {
  registry: ConnectionRegistry
  connector: SshConnector
  /** 可选：运行时池（缺失 = 恒定走 connector.exec 回落）。 */
  pool?: RuntimePool
  /** 可选：存活状态（离线/degraded 时跳过运行时尝试直接回落）。 */
  getStatus?: (connectionId: string) => ConnectionStatus
  /** 可选：回落告警日志。 */
  log?: (line: { level: 'INFO' | 'WARN' | 'ERROR'; msg: string }) => void
}

/** 远端输出收集器：与 subprocess-local OutputCollector.readFrom 同语义的 tail-window 读。 */
export class RemoteOutputReader {
  private buffer: Buffer
  private maxBytes: number | undefined

  constructor(text: string, maxBytes?: number) {
    this.buffer = Buffer.from(text, 'utf8')
    this.maxBytes = maxBytes
  }

  get totalBytes(): number {
    return this.buffer.length
  }

  readFrom(fromByte: number): RemoteOutputRead {
    const total = this.buffer.length
    const limit = this.maxBytes ?? total
    const windowStart = Math.max(0, total - limit)
    const lossy = fromByte < windowStart
    const start = lossy ? 0 : Math.min(Math.max(fromByte - windowStart, 0), total - windowStart)
    const slice = this.buffer.subarray(windowStart + start)
    return {
      text: slice.toString('utf8'),
      nextOffset: total,
      lossy,
      spillPath: undefined,
    }
  }
}

/** 远端执行通道：运行时 RPC 优先 + connector.exec 回落。 */
class RemoteChannel {
  protected readonly deps: RemoteOpsDeps
  readonly match: RemotePathMatch

  constructor(deps: RemoteOpsDeps, match: RemotePathMatch) {
    this.deps = deps
    this.match = match
  }

  /** 回落告警（RemoteFs 组合使用，公开面）。 */
  warn(scope: string, error: unknown): void {
    this.deps.log?.({ level: 'WARN', msg: `远端<${scope}>运行时不可用，回落 ssh exec：${error instanceof Error ? error.message : String(error)}` })
  }

  /** 运行时可用性预检：离线/degraded/未装过运行时 → 直接回落（RemoteFs 组合使用）。 */
  runtimeUsable(record?: { runtime?: { installed?: boolean } }): boolean {
    const status = this.deps.getStatus?.(this.match.connectionId)
    if (status !== undefined && (status.state === 'offline' || status.state === 'degraded')) return false
    if (record !== undefined && record.runtime !== undefined && record.runtime.installed !== true) return false
    return this.deps.pool !== undefined
  }

  /** RuntimePool RPC（连接不存在 / 通道失败统一抛错由调用方回落；RemoteFs 组合使用）。 */
  async rpc(method: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const target = targetOf(this.deps.registry, this.match.connectionId)
    if (!target) throw new Error(`连接不存在：${this.match.connectionId}`)
    const client = await this.deps.pool!.get(this.match.connectionId, target)
    return client.call(method, params, timeoutMs)
  }

  /** 远端执行一条命令（运行时优先；回落 ssh 一次性 exec）。 */
  async execCommand(command: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const record = this.deps.registry.get(this.match.connectionId)
    if (this.runtimeUsable(record)) {
      try {
        const raw = await this.rpc('exec', { command, cwd: undefined, timeoutMs }, timeoutMs + 5_000)
        if (raw !== null && typeof raw === 'object') {
          const result = raw as { code?: unknown; stdout?: unknown; stderr?: unknown }
          const code = typeof result.code === 'number' ? result.code : null
          return { code, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') }
        }
      } catch (error) {
        // 运行时缺失/degraded/通道失败 → 回落（慢但对）
        this.warn('exec', error)
      }
    }
    const target = targetOf(this.deps.registry, this.match.connectionId)
    if (!target) throw new Error(`连接不存在：${this.match.connectionId}`)
    try {
      const result = await this.deps.connector.exec(target, command, { timeoutMs })
      return { code: result.code, stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      // 回落路径也失败：不抛给工具，以失败结果表达（exit 1 + 明因 stderr）
      return { code: 1, stdout: '', stderr: `远端执行失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }
}

// ── RemoteFsLike 实现 ───────────────────────────────────────────────────────

const FS_RPC_TIMEOUT_MS = 15_000

/** 服务端 fs.stat 结果 → FsInfo（版本令牌 = remote:<mtime>:<size>）。 */
function infoFromStat(raw: { exists?: unknown; isDir?: unknown; isFile?: unknown; size?: unknown; mtimeMs?: unknown }): RemoteFsInfo | undefined {
  if (raw.exists !== true) return undefined
  const isDir = raw.isDir === true
  const isFile = raw.isFile === true
  const size = typeof raw.size === 'number' ? raw.size : undefined
  const mtimeMs = typeof raw.mtimeMs === 'number' ? raw.mtimeMs : 0
  const type = isDir ? 'directory' : isFile ? 'file' : 'other'
  return { version: `remote:${mtimeMs}:${size ?? 0}`, type, ...(size !== undefined ? { size } : {}) }
}

/** 远端 fs 实现（按命中连接，stat/read/write 逐方法委托）。 */
export class RemoteFs implements RemoteFsLike {
  private channel: RemoteChannel
  private readonly deps: RemoteOpsDeps
  readonly match: RemotePathMatch

  constructor(deps: RemoteOpsDeps, match: RemotePathMatch) {
    this.deps = deps
    this.match = match
    this.channel = new RemoteChannel(deps, match)
  }

  /** target → 远端绝对路径（targetKey 即远端路径；displayPath 兜底）。 */
  private pathOf(target: RemoteFsTarget): string {
    return String(target.targetKey || target.displayPath || '')
  }

  async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<RemoteFsTarget> {
    if (opts?.signal?.aborted) throw new Error('fs resolve aborted')
    const abs = isAbsolute(path) ? path : resolve(opts?.cwd ?? this.match.remoteRoot, path)
    return { targetKey: abs, displayPath: abs }
  }

  processPath(target: RemoteFsTarget): string {
    return this.pathOf(target)
  }

  processPathFromHostPath(hostPath: string): string | undefined {
    // 远端路径无本地 realpath；绝对路径原样透传（与 fs-local 的 resolve 语义对齐）
    return isAbsolute(hostPath) ? hostPath : undefined
  }

  fileUrl(target: RemoteFsTarget): string {
    return pathToFileURL(this.pathOf(target)).href
  }

  contains(parent: RemoteFsTarget, child: RemoteFsTarget): boolean {
    const p = this.pathOf(parent)
    const c = this.pathOf(child)
    const rel = relative(p, c)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }

  async stat(target: RemoteFsTarget, signal?: AbortSignal): Promise<RemoteFsInfo | undefined> {
    if (signal?.aborted) throw new Error('fs stat aborted')
    const path = this.pathOf(target)
    try {
      const raw = await this.rpcStat(path) as { exists?: unknown; isDir?: unknown; isFile?: unknown; size?: unknown; mtimeMs?: unknown }
      return infoFromStat(raw)
    } catch (error) {
      this.channel.warn('fs.stat', error)
      return this.fallbackStat(path)
    }
  }

  async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<RemoteFsPathInfo | undefined> {
    if (signal?.aborted) throw new Error('fs lstat aborted')
    const abs = isAbsolute(path) ? path : resolve(opts?.cwd ?? this.match.remoteRoot, path)
    try {
      const raw = await this.rpcStat(abs) as { exists?: unknown; isDir?: unknown; isFile?: unknown; size?: unknown; mtimeMs?: unknown }
      const info = infoFromStat(raw)
      if (info === undefined) return undefined
      return { ...info, type: info.type === 'other' ? 'other' : info.type }
    } catch (error) {
      this.channel.warn('fs.lstat', error)
      return this.fallbackStat(abs)
    }
  }

  private async rpcStat(path: string): Promise<unknown> {
    const record = this.deps.registry.get(this.match.connectionId)
    if (!this.channel.runtimeUsable(record)) throw new Error('运行时不可用')
    return this.channel.rpc('fs.stat', { path }, FS_RPC_TIMEOUT_MS)
  }

  /** ssh exec 回落 stat：`test -e` + GNU stat 三字段。 */
  private async fallbackStat(path: string): Promise<RemoteFsInfo | undefined> {
    const command = `if [ -e ${shellQuote(path)} ]; then stat -c 'type=%F|size=%s|mtime=%Y' -- ${shellQuote(path)} 2>/dev/null; else echo MISSING; fi`
    const result = await this.channel.execCommand(command, FS_RPC_TIMEOUT_MS)
    const line = result.stdout.trim()
    if (line === 'MISSING' || line.length === 0) return undefined
    const [typeRaw, sizeRaw, mtimeRaw] = line.split('|')
    const size = Number.parseInt(sizeRaw ?? '', 10)
    const mtimeMs = (Number.parseFloat(mtimeRaw ?? '') || 0) * 1000
    const type = typeRaw === 'directory' ? 'directory' : typeRaw === 'regular file' ? 'file' : 'other'
    return { version: `remote:${mtimeMs}:${Number.isFinite(size) ? size : 0}`, type, ...(Number.isFinite(size) ? { size } : {}) }
  }

  async readText(target: RemoteFsTarget, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new Error('fs readText aborted')
    const path = this.pathOf(target)
    try {
      const raw = await this.rpcReadText(path) as { text?: unknown; truncated?: unknown }
      return String(raw.text ?? '')
    } catch (error) {
      this.channel.warn('fs.readText', error)
      // 回落：head -c 上限（GNU coreutils；切尾可能截断 UTF-8，可接受）
      const result = await this.channel.execCommand(`head -c ${FS_READ_CAP_BYTES} ${shellQuote(path)}`, FS_RPC_TIMEOUT_MS)
      return result.stdout
    }
  }

  private async rpcReadText(path: string): Promise<unknown> {
    const record = this.deps.registry.get(this.match.connectionId)
    if (!this.channel.runtimeUsable(record)) throw new Error('运行时不可用')
    return this.channel.rpc('fs.readText', { path, maxBytes: FS_READ_CAP_BYTES }, FS_RPC_TIMEOUT_MS)
  }

  async streamText(target: RemoteFsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    if (signal?.aborted) throw new Error('fs streamText aborted')
    const text = await this.readText(target, signal)
    return {
      async *[Symbol.asyncIterator]() {
        const chunkSize = 64 * 1024
        let offset = 0
        while (offset < text.length) {
          yield text.slice(offset, offset + chunkSize)
          offset += chunkSize
        }
      },
    }
  }

  async readBytes(target: RemoteFsTarget, signal: AbortSignal | undefined, maxBytes?: number): Promise<Uint8Array> {
    if (signal?.aborted) throw new Error('fs readBytes aborted')
    const path = this.pathOf(target)
    const cap = Math.min(maxBytes ?? FS_READ_CAP_BYTES, FS_READ_CAP_BYTES)
    try {
      const raw = await this.rpcReadBytes(path, cap) as { base64?: unknown; truncated?: unknown }
      const base64 = String(raw.base64 ?? '')
      return Uint8Array.from(Buffer.from(base64, 'base64'))
    } catch (error) {
      this.channel.warn('fs.readBytes', error)
      const result = await this.channel.execCommand(`base64 -w0 ${shellQuote(path)} 2>/dev/null | head -c $(( ${cap} * 4 / 3 + 4 ))`, FS_RPC_TIMEOUT_MS)
      return Uint8Array.from(Buffer.from(result.stdout.trim(), 'base64'))
    }
  }

  private async rpcReadBytes(path: string, cap: number): Promise<unknown> {
    const record = this.deps.registry.get(this.match.connectionId)
    if (!this.channel.runtimeUsable(record)) throw new Error('运行时不可用')
    return this.channel.rpc('fs.readBytes', { path, maxBytes: cap }, FS_RPC_TIMEOUT_MS)
  }

  async listDir(target: RemoteFsTarget, signal?: AbortSignal): Promise<RemoteFsDirEntry[]> {
    if (signal?.aborted) throw new Error('fs listDir aborted')
    const path = this.pathOf(target)
    try {
      const raw = await this.rpcListDir(path) as { entries?: unknown }
      if (!Array.isArray(raw.entries)) return []
      const entries: RemoteFsDirEntry[] = []
      for (const entry of raw.entries) {
        if (entry === null || typeof entry !== 'object') continue
        const item = entry as { name?: unknown; type?: unknown }
        if (typeof item.name !== 'string' || item.name.length === 0) continue
        const type = item.type === 'dir' ? 'directory' : item.type === 'file' ? 'file' : 'other'
        const child = join(path, item.name)
        entries.push({ name: item.name, type, target: { targetKey: child, displayPath: child } })
      }
      return entries
    } catch (error) {
      this.channel.warn('fs.listDir', error)
      return this.fallbackListDir(path)
    }
  }

  private async rpcListDir(path: string): Promise<unknown> {
    const record = this.deps.registry.get(this.match.connectionId)
    if (!this.channel.runtimeUsable(record)) throw new Error('运行时不可用')
    return this.channel.rpc('fs.listDir', { path }, FS_RPC_TIMEOUT_MS)
  }

  /** ssh exec 回落列目录：`ls -1Ap --group-directories-first`（同 M1 browse 语义）。 */
  private async fallbackListDir(path: string): Promise<RemoteFsDirEntry[]> {
    const command = `ls -1Ap --group-directories-first ${shellQuote(path)}`
    const result = await this.channel.execCommand(command, FS_RPC_TIMEOUT_MS)
    const entries: RemoteFsDirEntry[] = []
    for (const line of result.stdout.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === '.' || trimmed === '..') continue
      const suffix = trimmed[trimmed.length - 1]
      let name = trimmed
      let type: 'file' | 'directory' | 'other' = 'file'
      if (suffix === '/') { name = trimmed.slice(0, -1); type = 'directory' }
      else if (suffix === '@') { name = trimmed.slice(0, -1); type = 'other' }
      else if (suffix === '*') { name = trimmed.slice(0, -1) }
      const child = join(path, name)
      entries.push({ name, type, target: { targetKey: child, displayPath: child } })
    }
    return entries
  }

  async writeText(
    target: RemoteFsTarget,
    content: string,
    expected?: RemoteFsWriteIntent,
    signal?: AbortSignal,
  ): Promise<RemoteFsWriteOutcome> {
    if (signal?.aborted) throw new Error('fs writeText aborted')
    const path = this.pathOf(target)
    // 前置校验（fs-local 语义）：createIfAbsent 撞已存在 / replaceIfVersion 版本不符
    if (expected !== undefined) {
      const existing = await this.stat(target, signal)
      if (expected.kind === 'createIfAbsent' && existing !== undefined) {
        throw new Error(`cannot overwrite existing "${path}" without reading it first`)
      }
      if (expected.kind === 'replaceIfVersion') {
        if (existing === undefined || existing.version !== expected.version) {
          throw new Error(`cannot write "${path}": file changed since it was read`)
        }
      }
    }
    const before = await this.readIfExists(target, signal)
    try {
      const raw = await this.rpcWriteText(path, content) as { bytes?: unknown }
      void raw
    } catch (error) {
      this.channel.warn('fs.writeText', error)
      // 回落：printf '%s' 单引号内容直写（非原子，运行时通道优先）
      await this.channel.execCommand(`printf '%s' ${shellQuote(content)} > ${shellQuote(path)}`, FS_RPC_TIMEOUT_MS)
    }
    const after = await this.stat(target, signal)
    return {
      operation: before !== null ? 'update' : 'create',
      version: after?.version ?? `remote:0:${Buffer.byteLength(content, 'utf8')}`,
      before,
      after: content.replaceAll('\r\n', '\n'),
    }
  }

  private async rpcWriteText(path: string, text: string): Promise<unknown> {
    const record = this.deps.registry.get(this.match.connectionId)
    if (!this.channel.runtimeUsable(record)) throw new Error('运行时不可用')
    return this.channel.rpc('fs.writeText', { path, text, createParents: false }, FS_RPC_TIMEOUT_MS)
  }

  /** 读已有文件内容（不存在 → null；用于 write/edit 的 before 语义）。 */
  private async readIfExists(target: RemoteFsTarget, signal?: AbortSignal): Promise<string | null> {
    try {
      const existing = await this.stat(target)
      if (existing === undefined) return null
      return await this.readText(target, signal)
    } catch {
      return null
    }
  }

  async editText(
    target: RemoteFsTarget,
    edit: RemoteFsEditRequest,
    expected?: { version: string },
    signal?: AbortSignal,
  ): Promise<RemoteFsEditOutcome> {
    if (signal?.aborted) throw new Error('fs editText aborted')
    const path = this.pathOf(target)
    const current = await this.stat(target, signal)
    if (current === undefined) {
      throw new Error(`cannot edit "${path}": file changed since it was read`)
    }
    if (current.type !== 'file') {
      throw new Error(`cannot edit "${path}": not a regular file`)
    }
    if (expected !== undefined && current.version !== expected.version) {
      throw new Error(`cannot edit "${path}": file changed since it was read`)
    }
    const original = await this.readText(target, signal)
    // 语义对齐 fs-local.applyLiteralEdit：LF 归一匹配；未命中 / 多处未 replaceAll 报错
    const oldNorm = edit.oldString.replaceAll('\r\n', '\n')
    if (oldNorm.length === 0) throw new Error('old_string must be a non-empty string')
    const newNorm = edit.newString.replaceAll('\r\n', '\n')
    const contentNorm = original.replaceAll('\r\n', '\n')
    const count = contentNorm.split(oldNorm).length - 1
    if (count === 0) throw new Error(`old_string was not found in "${path}"`)
    if (!edit.replaceAll && count > 1) {
      throw new Error(`old_string matched ${count} times in "${path}"; provide a more specific old_string or set replace_all to true`)
    }
    const after = contentNorm.split(oldNorm).join(newNorm)
    try {
      const raw = await this.rpcWriteText(path, after) as { bytes?: unknown }
      void raw
    } catch (error) {
      this.channel.warn('fs.editText', error)
      await this.channel.execCommand(`printf '%s' ${shellQuote(after)} > ${shellQuote(path)}`, FS_RPC_TIMEOUT_MS)
    }
    const post = await this.stat(target, signal)
    return { version: post?.version ?? current.version, before: contentNorm, after }
  }
}

// ── RemoteExecLike 实现 ────────────────────────────────────────────────────

/** 本地 rg 绝对路径判定（basename ∈ {rg, rg.exe} 即视为 rg，翻译为远端运行时内 rg）。 */
export function isRgBinary(argv0: string): boolean {
  return RG_BASENAMES.has(basename(argv0))
}

/** 拼远端命令：cd 到 cwd（防回落路径语义漂移，运行时 exec 的 cwd 参数不再依赖）。 */
function buildCdCommand(cwd: string, body: string): string {
  return `cd ${shellQuote(cwd)} && ${body}`
}

/** 带超时/取消的竞速：返回 {value?, timedOut, aborted}；不抛（远端错误由调用方转结果）。 */
async function raceWithControls<T>(
  promise: Promise<T>,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<{ value?: T; timedOut: boolean; aborted: boolean }> {
  return new Promise((resolveResult) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (): void => {
      if (timer !== undefined) { clearTimeout(timer); timer = undefined }
      opts.signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveResult({ timedOut: false, aborted: true })
    }
    // 已中止的 signal：addEventListener 不会回放，必须入口先查一次
    if (opts.signal?.aborted === true) {
      resolveResult({ timedOut: false, aborted: true })
      return
    }
    if (opts.timeoutMs > 0) {
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        resolveResult({ timedOut: true, aborted: false })
      }, opts.timeoutMs)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        resolveResult({ value, timedOut: false, aborted: false })
      },
      () => {
        // 传输层错误：不抛给工具（以失败结果表达）
        if (settled) return
        settled = true
        cleanup()
        resolveResult({ timedOut: false, aborted: false })
      },
    )
  })
}

/** 远端进程句柄（对齐 SubprocessHandle；无本地 pid，用单调合成 id）。 */
let syntheticPid = 100_000

export class RemoteSubprocessHandleImpl implements RemoteSubprocessHandle {
  readonly pid: number
  readonly stdin = undefined
  readonly stdout = undefined
  readonly stderr = undefined
  readonly collected: { stdout?: RemoteOutputReader; stderr?: RemoteOutputReader } = {}
  readonly done: Promise<RemoteSubprocessOutcome>
  private finished = false
  private terminateFlag = false
  private finish: ((outcome: RemoteSubprocessOutcome) => void) | undefined

  constructor(
    exec: () => Promise<{ code: number | null; stdout: string; stderr: string }>,
    opts: {
      stdoutMaxBytes?: number
      stderrMaxBytes?: number
      timeoutMs: number
      signal?: AbortSignal
    },
  ) {
    this.pid = ++syntheticPid
    this.done = new Promise<RemoteSubprocessOutcome>((resolveDone) => {
      this.finish = resolveDone
    })
    const settle = (outcome: RemoteSubprocessOutcome): void => {
      if (this.finished) return
      this.finished = true
      this.finish?.(outcome)
    }
    if (opts.signal !== undefined) {
      opts.signal.addEventListener('abort', () => settle({ exitCode: null, signal: 'SIGTERM' }), { once: true })
    }
    void exec().then(
      (result) => {
        // 输出一次性灌入读侧（readFrom 自带 tail-window 截断语义，
        // 超 maxBytes 时 readFrom(0) 报 lossy → 调用方按溢出处理）
        if (opts.stdoutMaxBytes !== undefined) this.collected.stdout = new RemoteOutputReader(result.stdout, opts.stdoutMaxBytes)
        else this.collected.stdout = new RemoteOutputReader(result.stdout)
        if (opts.stderrMaxBytes !== undefined) this.collected.stderr = new RemoteOutputReader(result.stderr, opts.stderrMaxBytes)
        else this.collected.stderr = new RemoteOutputReader(result.stderr)
        settle({ exitCode: result.code, signal: this.terminateFlag ? 'SIGTERM' : null })
      },
      () => settle({ exitCode: null, signal: this.terminateFlag ? 'SIGTERM' : null }),
    )
  }

  terminate(): void {
    this.terminateFlag = true
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.finished) return true
    if (signal?.aborted) return false
    if (signal === undefined) {
      await this.done
      return true
    }
    return new Promise<boolean>((resolveWait) => {
      const onAbort = (): void => resolveWait(false)
      signal.addEventListener('abort', onAbort, { once: true })
      void this.done.then(() => {
        signal.removeEventListener('abort', onAbort)
        resolveWait(true)
      })
    })
  }
}

/** 远端执行器（按命中连接；run/start/resolve 供 shellRemoteRouter，spawn 供 subprocessRemoteRouter）。 */
export class RemoteExec extends RemoteChannel implements RemoteExecLike {
  constructor(deps: RemoteOpsDeps, match: RemotePathMatch) {
    super(deps, match)
  }

  resolve(request: RemoteShellExecRequest): RemoteShellExecSpec {
    const timeoutMs = clampTimeout(request.timeoutMs, DEFAULT_SHELL_TIMEOUT_MS, MAX_SHELL_TIMEOUT_MS)
    return {
      command: request.command,
      workdir: request.workdir ?? this.match.remoteRoot,
      timeoutMs,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      ...(request.signal !== undefined ? { signal: request.signal } : {}),
      ...(request.stdin !== undefined ? { stdin: request.stdin } : {}),
      ...(request.env !== undefined ? { env: request.env } : {}),
      ...(request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
      sandboxPolicy: undefined,
    }
  }

  async run(spec: RemoteShellExecSpec): Promise<RemoteShellRunResult> {
    const timeoutMs = clampTimeout(spec.timeoutMs, DEFAULT_SHELL_TIMEOUT_MS, MAX_SHELL_TIMEOUT_MS)
    const cwd = spec.workdir || this.match.remoteRoot
    // 与本地 bash -c 语义一致：远端亦用 bash 执行（远端缺 bash 时报 127，行为同本地）
    let body = `exec bash -c ${shellQuote(spec.command)}`
    if (spec.stdin !== undefined) body = `printf '%s' ${shellQuote(spec.stdin)} | ${body}`
    const command = buildCdCommand(cwd, body)
    const raced = await raceWithControls(this.execCommand(command, timeoutMs), { timeoutMs, signal: spec.signal })
    if (raced.timedOut) {
      return { exitCode: null, signal: null, timedOut: true, aborted: false, timeoutMs, stdout: collectedText(''), stderr: collectedText('') }
    }
    if (raced.aborted) {
      return { exitCode: null, signal: null, timedOut: false, aborted: true, timeoutMs, stdout: collectedText(''), stderr: collectedText('') }
    }
    const result = raced.value ?? { code: 1, stdout: '', stderr: '远端执行失败（连接中断）' }
    return {
      exitCode: result.code,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs,
      stdout: collectedText(result.stdout),
      stderr: collectedText(result.stderr),
    }
  }

  start(spec: RemoteShellExecSpec): RemoteShellProcess {
    // 后台命令本地忽略 timeoutMs；远端给保守上限防悬挂（无法真正杀远端进程，注释明示）
    const timeoutMs = Math.max(spec.timeoutMs, 600_000)
    const cwd = spec.workdir || this.match.remoteRoot
    const command = buildCdCommand(cwd, `exec bash -c ${shellQuote(spec.command)}`)
    let killed = false
    let consumed = false
    const outputs = { stdout: '', stderr: '' }
    const proc: RemoteShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: Promise.resolve(),
      readOutput: () => ({ delta: '', lossy: false }),
      kill: () => false,
    }
    proc.kill = (): boolean => {
      if (proc.status !== 'running') return false
      killed = true
      proc.status = 'killed'
      return true
    }
    proc.readOutput = (): RemoteShellProcessRead => {
      // 远端一次性 exec：完成前无可读增量，完成后全量一次性吐出（stderr 带 [stderr] 段）
      if (consumed) return { delta: '', lossy: false }
      consumed = true
      const sepLine = outputs.stderr.length > 0 ? `\n[stderr]\n${outputs.stderr}` : ''
      return { delta: `${outputs.stdout}${sepLine}`, lossy: false }
    }
    const done = (async (): Promise<void> => {
      try {
        const result = await this.execCommand(command, timeoutMs)
        outputs.stdout = result.stdout
        outputs.stderr = result.stderr
        proc.exitCode = result.code
        proc.status = killed ? 'killed' : 'completed'
      } catch (error) {
        outputs.stderr = `远端执行失败：${error instanceof Error ? error.message : String(error)}`
        proc.status = 'killed'
      }
    })()
    proc.done = done
    return proc
  }

  spawn(spec: RemoteSubprocessSpawnSpec): RemoteSubprocessHandle {
    if (spec.signal?.aborted) {
      throw new Error(`aborted before spawn: ${String(spec.signal.reason ?? 'aborted')}`)
    }
    if (spec.argv.length === 0 || spec.argv[0] === undefined || spec.argv[0].length === 0) {
      throw new Error('invalid argv: expected a non-empty program name at argv[0]')
    }
    // 翻译：本地 rg 绝对路径 → 远端运行时内 rg（契约 E，只看 argv[0] basename）
    const argv = [...spec.argv]
    if (isRgBinary(argv[0] as string)) argv[0] = REMOTE_RG_PATH
    const cwd = spec.cwd || this.match.remoteRoot
    // REMOTE_RG_PATH 段不加单引号：$HOME 需由远端 shell 展开（单引号会锁死成字面量——
    // 真机踩过：`'~'` 与 `'$HOME'` 被引号锁死都让 rg 变 127）；该路径无空格/元字符，裸放安全。
    let body = argv.map((arg) => {
      const s = String(arg)
      return s === REMOTE_RG_PATH ? s : shellQuote(s)
    }).join(' ')
    if (spec.stdio !== undefined && spec.stdio.stdin !== undefined
      && typeof spec.stdio.stdin === 'object' && (spec.stdio.stdin as { data?: unknown }).data !== undefined) {
      body = `printf '%s' ${shellQuote(String((spec.stdio.stdin as { data: unknown }).data))} | ${body}`
    }
    const command = buildCdCommand(cwd, body)
    const stdoutMax = collectMaxBytes(spec.stdio?.stdout)
    const stderrMax = collectMaxBytes(spec.stdio?.stderr)
    const timeoutMs = DEFAULT_EXEC_TIMEOUT_MS
    return new RemoteSubprocessHandleImpl(
      async () => {
        // stdout 全量交给 reader（readFrom 自带 tail-window：超 maxBytes 时报 lossy，
        // 对齐 subprocess-local OutputCollector 的溢出语义）
        const result = await this.execCommand(command, timeoutMs)
        return { code: result.code, stdout: result.stdout, stderr: result.stderr }
      },
      { stdoutMaxBytes: stdoutMax, stderrMaxBytes: stderrMax, timeoutMs, signal: spec.signal },
    )
  }
}

/** 从 stdio 处置对象里取 maxBytes（rg 的 collect 形状 {maxBytes, spill?}）。 */
function collectMaxBytes(mode: unknown): number | undefined {
  if (mode !== null && typeof mode === 'object' && !Array.isArray(mode)) {
    const maybe = (mode as { maxBytes?: unknown }).maxBytes
    if (typeof maybe === 'number' && Number.isFinite(maybe) && maybe > 0) return maybe
  }
  return undefined
}

function clampTimeout(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(value, max)
}

// ── 工厂 ────────────────────────────────────────────────────────────────────

export interface RemoteFsFactory {
  forMatch(match: RemotePathMatch): RemoteFsLike
}

export interface RemoteExecFactory {
  forMatch(match: RemotePathMatch): RemoteExecLike
}

export function createRemoteFsFactory(deps: RemoteOpsDeps): RemoteFsFactory {
  return { forMatch: (match) => new RemoteFs(deps, match) }
}

export function createRemoteExecFactory(deps: RemoteOpsDeps): RemoteExecFactory {
  return { forMatch: (match) => new RemoteExec(deps, match) }
}

