/**
 * SshConnector —— 系统 OpenSSH + ControlMaster 连接器（与 cordis 无关的纯 Node 模块）。
 *
 * 离线 e2e 注入假 ssh 脚本（sshBinary 指向 stub 脚本或注入 spawnFn）验证全部行为；
 * 构造注入 `{ muxDir, askpassDir, spawnFn? }`。
 *
 * 关键语义：
 * - ControlMaster 多路复用：-o ControlMaster=auto -o ControlPath=<muxdir>/%C
 *   -o ControlPersist=10m -o ServerAliveInterval=15 -o ServerAliveCountMax=2；
 * - 密码认证走一次性 SSH_ASKPASS 脚本（0700，DISPLAY=dsh:0，SSH_ASKPASS_REQUIRE=force，
 *   detached:true + stdin ignore），pipeline 结束（成败均）即删；
 * - 日志 redact：凡是 draft 明文密码出现处替换 `***`（含错误消息）；
 * - sshBinary 缺省 `ssh`；Windows ssh.exe interop 时 identityFile 为 Windows 路径，
 *   原样传给 ssh.exe，禁止 wslpath 转换。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ConnectDraft, ConnKind, DownloadMethod, RemoteEnv, SshAuth } from './registry.ts'

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'

/** ssh 二进制是否为 Windows interop 路径（/mnt/<盘>/…）：interop 二进制禁用 mux、tty 用 -tt。 */
export function isInteropBinary(bin: string): boolean {
  return /^\/mnt\/[a-z]\//i.test(bin)
}

export interface SshLogLine {
  level: LogLevel
  msg: string
}

export type SshLogFn = (line: SshLogLine) => void

/** 连接目标（由 registry 记录或 wizard draft 归一化而来）。 */
export interface SshTarget {
  connId?: string
  kind: ConnKind
  host: string
  port: number
  user: string
  auth: SshAuth
  sshBinary?: string
  downloadMethod?: DownloadMethod
}

export interface SshSpawnOpts {
  env?: Record<string, string>
  timeoutMs?: number
  detached?: boolean
}

/** 持久通道：stdio pipe 的 ssh exec（运行时 RPC 与 tar 二进制上传共用）。 */
export interface SshChannel {
  /** 写一行（追加 \n，协议文本行）。 */
  write(line: string): void
  /** 写原始字节（二进制上传）；返回 false 表背压（应等 onceDrain 再续写）。 */
  writeRaw(chunk: Uint8Array): boolean
  /** stdout 行回调（行分隔，不含换行符）。 */
  onLine(cb: (line: string) => void): void
  /** stderr 行回调（日志）。 */
  onStderrLine(cb: (line: string) => void): void
  /** 退出回调（code=退出码或 null；只触发一次）。 */
  onExit(cb: (code: number | null) => void): void
  /** stdin 排空回调（背压续写）。 */
  onceDrain(cb: () => void): void
  /** 优雅关闭：stdin EOF（远端命令读 EOF 自行收尾），逾 3s 强杀兜底。 */
  close(): void
  /** 是否已退出。 */
  exited: boolean
}

/** M2 运行时下发 hook（缺省 = M1 行为；由 index.ts 组装注入）。返回 undefined 表示无运行时信息。 */
export type RuntimeStepHook = (
  target: SshTarget,
  draft: Extract<ConnectDraft, { kind: 'ssh' }>,
  log: SshLogFn,
) => Promise<{ installed: boolean; version?: string; reused?: string } | undefined>

export interface SshRunResult {
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  timedOut: boolean
}

export interface SshExecResult {
  code: number
  stdout: string
  stderr: string
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

export type SpawnFn = (file: string, args: string[], opts: Record<string, unknown>) => ChildProcess

export interface SshConnectorDeps {
  muxDir: string
  askpassDir: string
  spawnFn?: SpawnFn
  defaultTimeoutMs?: number
  /** 缺省 ssh 二进制（target 未显式指定 sshBinary 时使用；e2e 注入假脚本）。 */
  defaultSshBinary?: string
  /** M2：运行时下发 hook（可选，缺省 = M1 行为）。 */
  runtimeStep?: RuntimeStepHook
}

const DEFAULT_TIMEOUT_MS = 15_000
const CONTROL_TIMEOUT_MS = 3_000

/** 密码 redact：文本中出现 secret 的位置替换为 ***（无 secret 时原样返回）。 */
export function maskSecret(text: string, secret?: string): string {
  if (!secret || secret.length === 0) return text
  return text.split(secret).join('***')
}

/** 单引号包裹 + 内部单引号 `'\''` 转义（远端命令/路径安全）。 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** 归一化：registry 记录 → 连接目标（win 连接无 ssh，返回 undefined）。 */
export function targetFromRecord(record: {
  id: string
  kind: ConnKind
  ssh?: { host: string; port: number; user: string; auth: SshAuth; sshBinary?: string; downloadMethod?: DownloadMethod }
}): SshTarget | undefined {
  if (record.kind !== 'ssh' || !record.ssh) return undefined
  return {
    connId: record.id,
    kind: 'ssh',
    host: record.ssh.host,
    port: record.ssh.port,
    user: record.ssh.user,
    auth: record.ssh.auth,
    sshBinary: record.ssh.sshBinary,
    downloadMethod: record.ssh.downloadMethod,
  }
}

/** 归一化：wizard draft → 连接目标（仅 ssh 分支）。 */
export function targetFromDraft(draft: Extract<ConnectDraft, { kind: 'ssh' }>): SshTarget {
  return {
    kind: 'ssh',
    host: draft.ssh.host,
    port: draft.ssh.port ?? 22,
    user: draft.ssh.user,
    auth: { ...draft.ssh.auth } as SshAuth,
    sshBinary: draft.ssh.sshBinary,
    downloadMethod: draft.ssh.downloadMethod,
  }
}

/** uname -s / -m → SPEC 的 os/arch 归一。 */
export function normalizeOsName(raw: string): string {
  const lower = (raw || '').toLowerCase()
  if (lower.includes('darwin')) return 'macos'
  if (lower.includes('mingw') || lower.includes('msys') || lower.includes('microsoft')) return 'windows'
  if (lower.includes('linux')) return 'linux'
  return lower || 'unknown'
}

export function normalizeArchName(raw: string): string {
  const lower = (raw || '').toLowerCase().trim()
  if (lower === 'x86_64' || lower === 'amd64') return 'x64'
  if (lower === 'aarch64' || lower === 'arm64') return 'arm64'
  return lower || 'unknown'
}

export class SshConnector {
  private muxDir: string
  private askpassDir: string
  private spawnFn: SpawnFn
  private defaultTimeoutMs: number
  private defaultSshBinary: string
  /** M2：运行时下发 hook（可选，缺省 = M1 行为）。 */
  private runtimeStep?: RuntimeStepHook
  /** 已建立 mux 的目标键（`sshBinary|user@host:port`），用于零开销 -O check。 */
  private muxAlive = new Set<string>()
  /** connId → target，供 close(connId) 反查。 */
  private activeTargets = new Map<string, SshTarget>()

  constructor(deps: SshConnectorDeps) {
    this.muxDir = deps.muxDir
    this.askpassDir = deps.askpassDir
    this.spawnFn = deps.spawnFn ?? ((file, args, opts) => spawn(file, args, opts))
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
    this.defaultSshBinary = deps.defaultSshBinary ?? 'ssh'
    this.runtimeStep = deps.runtimeStep
    mkdirSync(this.muxDir, { recursive: true, mode: 0o700 })
    mkdirSync(this.askpassDir, { recursive: true, mode: 0o700 })
  }

  getMuxDir(): string {
    return this.muxDir
  }

  getAskpassDir(): string {
    return this.askpassDir
  }

  private binaryOf(target: SshTarget): string {
    return target.sshBinary ?? this.defaultSshBinary
  }

  /**
   * mux 是否可用：Windows ssh.exe interop（/mnt/<盘>/… 路径）不支持
   * ControlMaster/ControlPath（WSL 侧 socket 路径对 Windows 进程无意义），
   * interop 连接退化为每次独立 TCP+认证（密钥场景开销可接受），
   * muxAlive/-O check 同步禁用。
   */
  private muxSupported(target: SshTarget): boolean {
    return process.platform !== 'win32' && !isInteropBinary(this.binaryOf(target))
  }

  private muxKey(target: SshTarget): string {
    return `${this.binaryOf(target)}|${target.user}@${target.host}:${target.port}`
  }

  private registerTarget(target: SshTarget): void {
    if (target.connId) this.activeTargets.set(target.connId, target)
  }

  /** 公共 argv：头（ControlMaster 等）+ 认证选项 + 目标 [+ 命令]。 */
  buildSshArgv(
    target: SshTarget,
    opts: { tty?: boolean; command?: string; ctrl?: 'check' | 'exit'; batch?: boolean } = {},
  ): string[] {
    const bin = this.binaryOf(target)
    const argv: string[] = [bin]
    const mux = this.muxSupported(target)
    if (opts.ctrl && !mux) {
      // interop 无 mux socket 可控：调用方应已用 muxSupported 预判，防御性报错。
      throw new Error(`目标 ${target.user}@${target.host} 的 sshBinary 为 Windows interop，不支持 -O ${opts.ctrl}`)
    }
    if (opts.ctrl) argv.push('-O', opts.ctrl)
    if (mux) {
      argv.push('-o', 'ControlMaster=auto')
      argv.push('-o', `ControlPath=${join(this.muxDir, '%C')}`)
    }
    if (!opts.ctrl) {
      if (mux) argv.push('-o', 'ControlPersist=10m')
      argv.push('-o', 'ServerAliveInterval=15')
      argv.push('-o', 'ServerAliveCountMax=2')
      argv.push('-o', 'ConnectTimeout=10')
    }
    if (target.auth.type === 'key') {
      argv.push('-i', target.auth.identityFile)
      argv.push('-o', 'BatchMode=yes')
      argv.push('-o', 'IdentitiesOnly=yes')
    } else if (opts.batch) {
      argv.push('-o', 'BatchMode=yes')
    }
    if (opts.tty) {
      // interop 下 ssh.exe 的 stdin 是 Windows 管道（非控制台），单个 -t 会拒绝
      // 分配伪终端（"Pseudo-terminal will not be allocated"），-tt 强制分配。
      argv.push(mux ? '-t' : '-tt')
    }
    argv.push('-p', String(target.port))
    argv.push(`${target.user}@${target.host}`)
    if (opts.command) argv.push(opts.command)
    return argv
  }

  /** 低层执行：spawn + 超时 + 结果归一。超时以 timedOut 标记返回（不抛）。 */
  private run(args: string[], opts: SshSpawnOpts = {}): Promise<SshRunResult> {
    const env = { ...process.env, ...opts.env }
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs
    return new Promise<SshRunResult>((resolve) => {
      let child: ChildProcess
      try {
        child = this.spawnFn(args[0], args.slice(1), {
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: opts.detached ?? false,
        })
      } catch (error) {
        resolve({ code: null, signal: null, stdout: '', stderr: `spawn 失败: ${error instanceof Error ? error.message : String(error)}`, timedOut: false })
        return
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      let timer: NodeJS.Timeout | undefined
      const cleanup = (): void => {
        if (timer) { clearTimeout(timer); timer = undefined }
      }
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return
          settled = true
          cleanup()
          try { child.kill('SIGKILL') } catch { /* 进程已退出 */ }
          resolve({ code: null, signal: 'SIGKILL', stdout, stderr, timedOut: true })
        }, timeoutMs)
      }
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
      child.once('error', () => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ code: null, signal: null, stdout, stderr, timedOut: false })
      })
      child.once('close', (code, signal) => {
        if (settled) return
        settled = true
        cleanup()
        resolve({ code, signal, stdout, stderr, timedOut: false })
      })
    })
  }

  /** 远端执行（可带 askpass env 与 detached），含 mux 标记维护。 */
  private runRemote(target: SshTarget, command: string, opts: SshSpawnOpts & { batch?: boolean } = {}): Promise<SshRunResult> {
    this.registerTarget(target)
    const argv = this.buildSshArgv(target, { command, batch: opts.batch })
    // 去掉 batch 键（非 run 的选项）
    const { batch: _drop, ...spawnOpts } = opts
    return this.run(argv, spawnOpts)
  }

  /** 控制操作：ssh -O check / -O exit（走 mux socket，无需认证）。 */
  private control(target: SshTarget, op: 'check' | 'exit'): Promise<SshRunResult> {
    this.registerTarget(target)
    const argv = this.buildSshArgv(target, { ctrl: op })
    return this.run(argv, { timeoutMs: CONTROL_TIMEOUT_MS })
  }

  /**
   * 连接向导 pipeline（SPEC E）：
   *   ① INFO `正在通过窗口 Host 连接 ssh <title>`
   *   ② 建 mux + 探活：`echo __DSH_SSH_OK__ && uname -sm` 解析标记与 os/arch
   *   ③ INFO `detecting remote env...`：探测 shells / node / 登录 shell
   *   ④ INFO `远程环境检测完成：<os>/<arch>`
   * 失败分类：timeout→网络不可达 / Permission denied→认证失败 /
   *   Connection refused→SSH 服务未开，ERROR 行进日志。
   */
  async testConnect(draft: Extract<ConnectDraft, { kind: 'ssh' }>, log?: SshLogFn): Promise<{ env: RemoteEnv; runtime?: { installed: boolean; version?: string; reused?: string } }> {
    const target = targetFromDraft(draft)
    const secret = draft.ssh.auth.type === 'password' ? draft.ssh.auth.password : undefined
    const emit = (line: SshLogLine): void => {
      log?.({ level: line.level, msg: maskSecret(line.msg, secret) })
    }
    const title = draft.title || `${target.user}@${target.host}`
    // Password 认证需要给完整 pipeline 都带 askpass env（testConnect 与 openChannel 共用 helper）：
    // askpass 脚本 0700 → env → pipeline 结束即删
    const { env: askpassEnv, cleanup: askpassCleanup } = this.askpassFor(target)

    try {
      emit({ level: 'INFO', msg: `正在通过窗口 Host 连接 ssh ${title}` })

      // ② 探活（建 mux）+ uname（密码认证：走 askpass，不设 BatchMode）
      const probe = await this.runRemote(target, 'echo __DSH_SSH_OK__ && uname -sm', {
        env: askpassEnv,
        timeoutMs: this.defaultTimeoutMs,
        detached: Boolean(askpassEnv.SSH_ASKPASS),
      })
      if (probe.timedOut || probe.code !== 0 || !probe.stdout.includes('__DSH_SSH_OK__')) {
        const classified = this.classifyFailure(probe, target)
        emit({ level: 'ERROR', msg: classified })
        // 失败分类明文（redact 兜底：错误消息同样不得泄漏密码）
        throw new Error(maskSecret(classified, secret))
      }

      const lines = probe.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0)
      const markerIndex = lines.findIndex((l) => l.trim() === '__DSH_SSH_OK__')
      const unameLine = markerIndex >= 0 && markerIndex + 1 < lines.length ? lines[markerIndex + 1].trim() : ''
      const [osRaw, archRaw] = unameLine.split(/\s+/)
      const os = normalizeOsName(osRaw)
      const arch = normalizeArchName(archRaw ?? '')

      // ③ env 探测（容错：任一条失败不影响整体）
      emit({ level: 'INFO', msg: 'detecting remote env...' })
      let env: RemoteEnv = { os, arch, uname: unameLine, shells: [] }
      const envCommand = [
        'command -v zsh bash sh fish pwsh 2>/dev/null',
        `echo "NODE:$(node --version 2>/dev/null)"`,
        `echo "LOGIN:$(getent passwd ${shellQuote(target.user)} 2>/dev/null | cut -d: -f7)"`,
        'echo "SHELL:${SHELL}"',
      ].join('; ')
      const envRun = await this.runRemote(target, envCommand, {
        env: askpassEnv,
        timeoutMs: this.defaultTimeoutMs,
        detached: Boolean(askpassEnv.SSH_ASKPASS),
      })
      if (envRun.code === 0) {
        const shells: Array<{ name: string; path: string }> = []
        let node: string | undefined
        let login = ''
        let she = ''
        for (const line of envRun.stdout.split(/\r?\n/)) {
          const trimmed = line.trim()
          if (!trimmed) continue
          if (trimmed.startsWith('NODE:')) {
            const v = trimmed.slice(5).trim()
            if (v) node = v
          } else if (trimmed.startsWith('LOGIN:')) {
            login = trimmed.slice(6).trim()
          } else if (trimmed.startsWith('SHELL:')) {
            she = trimmed.slice(6).trim()
          } else if (trimmed.startsWith('/')) {
            const name = basename(trimmed)
            if (name && !shells.some((s) => s.path === trimmed)) shells.push({ name, path: trimmed })
          }
        }
        env = { os, arch, uname: unameLine, shells, ...(node ? { node } : {}) }
        const defaultShell = login || she || undefined
        if (defaultShell) env.defaultShell = defaultShell
      }

      // ④ 完成
      emit({ level: 'INFO', msg: `远程环境检测完成：${os}/${arch}` })

      // M2 运行时下发 hook：可选注入（缺省 / 返回 undefined = M1 行为；
      // hook 由 index.ts 组装时注入，routes 的 connect 同样走这里，一处改动全链路生效）。
      // hook 抛错不阻断连接：记 ERROR 后按 M1 继续（运行时降级由存活检测表达）。
      let runtime: { installed: boolean; version?: string; reused?: string } | undefined
      if (this.runtimeStep) {
        try {
          runtime = (await this.runtimeStep(target, draft, emit)) ?? undefined
        } catch (error) {
          emit({ level: 'ERROR', msg: maskSecret(`运行时安装失败：${error instanceof Error ? error.message : String(error)}`, secret) })
        }
      }
      if (probe.code === 0 && this.muxSupported(target)) this.muxAlive.add(this.muxKey(target))
      return { env, ...(runtime ? { runtime } : {}) }
    } finally {
      // askpass 脚本生灭：成败均删
      askpassCleanup()
    }
  }

  /**
   * 密码认证的一次性 askpass 环境（testConnect 与 openChannel 共用）：
   * 脚本写入 askpassDir（0700），env 追加 SSH_ASKPASS/SSH_ASKPASS_REQUIRE=force/DISPLAY=dsh:0；
   * 返回的 cleanup 在 pipeline 结束（成败均）删除脚本。无明文密码（持久化记录）时返回空 env + 空 cleanup。
   */
  private askpassFor(target: SshTarget): { env: Record<string, string>; cleanup: () => void } {
    const env: Record<string, string> = {}
    const secret = (target.auth as { password?: string }).password
    if (target.auth.type === 'password' && secret) {
      if (process.platform === 'win32') throw new Error('Native Windows password authentication is not supported yet; use an SSH identity file')
      const askpassPath = join(this.askpassDir, `askpass-${randomUUID()}.sh`)
      const escaped = secret.replace(/'/g, `'\\''`)
      writeFileSync(askpassPath, `#!/bin/sh\nprintf '%s' '${escaped}'\n`, { mode: 0o700 })
      env.SSH_ASKPASS = askpassPath
      env.SSH_ASKPASS_REQUIRE = 'force'
      env.DISPLAY = 'dsh:0'
      return {
        env,
        cleanup: () => {
          try { unlinkSync(askpassPath) } catch { /* 已删 */ }
        },
      }
    }
    return { env, cleanup: () => { /* 无脚本无需清理 */ } }
  }

  /** 失败分类（SPEC E）：timeout=网络不可达 / Permission denied=认证失败 / Connection refused=SSH 服务未开。 */
  private classifyFailure(result: SshRunResult, target: SshTarget): string {
    const text = `${result.stderr}\n${result.stdout}`
    // 本层超时（timedOut）与 ssh 自报的 "Connection timed out"（网络层超时，stderr 文案）同归网络不可达。
    if (result.timedOut || /connection timed out/i.test(text)) return `网络不可达：连接 ${target.user}@${target.host} 超时`
    if (/permission denied/i.test(text)) return `认证失败：用户名或密码/密钥不正确（Permission denied）`
    if (/connection refused/i.test(text)) return `SSH 服务未开启：${target.host}:${target.port} 拒绝连接`
    if (/no route to host/i.test(text)) return `网络不可达：${target.host} 无路由（No route to host）`
    const detail = result.stderr.trim() || result.stdout.trim() || '未知错误'
    return `连接失败：${detail.slice(0, 200)}`
  }

  /** 经 mux 执行远端命令；stderr 非空不视为失败，看 code。超时抛错。 */
  async exec(
    target: SshTarget,
    remoteCommand: string,
    opts: { timeoutMs?: number; batch?: boolean } = {},
  ): Promise<SshExecResult> {
    const result = await this.runRemote(target, remoteCommand, { timeoutMs: opts.timeoutMs, batch: opts.batch })
    if (result.timedOut) {
      const error = new Error(`命令执行超时：${remoteCommand}`)
      ;(error as { timedOut?: boolean }).timedOut = true
      throw error
    }
    if (result.code === 0 && this.muxSupported(target)) this.muxAlive.add(this.muxKey(target))
    else this.muxAlive.delete(this.muxKey(target))
    return { code: result.code ?? 1, stdout: result.stdout, stderr: result.stderr }
  }

  /**
   * 存活探测（SPEC E）：mux 在时 `ssh -O check`（零开销）；否则
   * 密码类连接无法免密重建 → false；密钥类走 5s 超时的 exec('true')。
   */
  async check(target: SshTarget): Promise<boolean> {
    if (target.kind === 'win') return true
    const key = this.muxKey(target)
    if (this.muxSupported(target)) {
      const result = await this.control(target, 'check')
      if (result.code === 0) { this.muxAlive.add(key); return true }
      this.muxAlive.delete(key)
    }
    if (target.auth.type === 'password') return false
    try {
      const result = await this.exec(target, 'true', { timeoutMs: 5_000, batch: true })
      return result.code === 0
    } catch {
      return false
    }
  }

  /**
   * 持久通道（SPEC R2）：stdio pipe 的 ssh exec（运行时 stdio RPC / tar 二进制上传）。
   *  - 骑 mux（公共 argv 头）；interop 无 mux 则独立连接；
   *  - 复用 run() 的 spawnFn 注入面（e2e 可注假）；
   *  - 密码认证通道同样可建：复用 testConnect 的 askpass helper（一次性脚本，关通道即删）；
   *  - spawn 同步抛错 / 异步 error → 通道即刻以 onExit(null) 表达（不抛）；
   *  - close() = stdin EOF（远端命令收到 EOF 自行收尾），逾 3s 强杀兜底。
   */
  openChannel(target: SshTarget, remoteCommand: string, opts: SshSpawnOpts = {}): Promise<SshChannel> {
    return new Promise<SshChannel>((resolve) => {
      this.registerTarget(target)
      const argv = this.buildSshArgv(target, { command: remoteCommand })
      // askpass env（密码认证在通道进程内同样需要；无明文密码时为空 env）
      const { env: askpassEnv, cleanup: askpassCleanup } = this.askpassFor(target)
      const runEnv = { ...process.env, ...opts.env, ...askpassEnv }

      const lineListeners: Array<(line: string) => void> = []
      const stderrListeners: Array<(line: string) => void> = []
      const exitListeners: Array<(code: number | null) => void> = []
      const drainListeners: Array<() => void> = []
      let exited = false
      let closed = false
      let lastExitCode: number | null = null
      let child: ChildProcess

      const emitExit = (code: number | null): void => {
        if (exited) return
        exited = true
        lastExitCode = code
        // askpass 脚本生灭：channel 结束（成败均）即删
        askpassCleanup()
        for (const cb of exitListeners) {
          try { cb(code) } catch { /* 回调异常不影响通道 */ }
        }
      }

      const channel: SshChannel = {
        write: (line) => {
          if (exited || closed) return
          try { child.stdin?.write(`${line}\n`) } catch { /* 已关 */ }
        },
        writeRaw: (chunk) => {
          if (exited || closed || !child.stdin?.writable) return false
          return child.stdin.write(chunk)
        },
        onLine: (cb) => { lineListeners.push(cb) },
        onStderrLine: (cb) => { stderrListeners.push(cb) },
        onExit: (cb) => {
          if (exited) {
            try { cb(lastExitCode) } catch { /* 忽略 */ }
          } else {
            exitListeners.push(cb)
          }
        },
        onceDrain: (cb) => { drainListeners.push(cb) },
        close: () => {
          if (closed) return
          closed = true
          // stdin EOF：远端命令收尾（cat 写完退出 / 运行时 readline 收到 EOF 退出）
          try { child.stdin?.end() } catch { /* 已关 */ }
          const timer = setTimeout(() => {
            try { child.kill('SIGKILL') } catch { /* 已退出 */ }
          }, 3_000)
          timer.unref?.()
        },
        get exited() { return exited },
      }

      let buffer = ''
      try {
        child = this.spawnFn(argv[0], argv.slice(1), {
          env: runEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: Boolean(askpassEnv.SSH_ASKPASS),
        })
      } catch {
        // spawn 同步抛错：通道立即进入退出态（code null）
        queueMicrotask(() => emitExit(null))
        resolve(channel)
        return
      }
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        let index: number
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, '')
          buffer = buffer.slice(index + 1)
          for (const cb of lineListeners) {
            try { cb(line) } catch { /* 忽略 */ }
          }
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString('utf8').split(/\r?\n/)) {
          if (!line) continue
          for (const cb of stderrListeners) {
            try { cb(line) } catch { /* 忽略 */ }
          }
        }
      })
      child.stdin?.on('drain', () => {
        const pending = drainListeners.splice(0)
        for (const cb of pending) {
          try { cb() } catch { /* 忽略 */ }
        }
      })
      child.once('error', () => emitExit(null))
      child.once('close', (code) => emitExit(code))
      resolve(channel)
    })
  }

  /** 远端列目录（SPEC E）：`cd '<dir>' && ls -1Ap --group-directories-first`。 */
  async browse(target: SshTarget, dir: string): Promise<BrowseResult> {
    // WIN interop：本地 WSL 侧直接 ls（/mnt/<盘符> 路径已是本地可读）
    if (target.kind === 'win') return this.browseLocal(dir)
    const command = `cd ${shellQuote(dir)} && ls -1Ap --group-directories-first`
    try {
      const result = await this.exec(target, command, { timeoutMs: 10_000 })
      if (result.code !== 0) {
        const detail = result.stderr.trim() || '未知错误'
        throw new Error(`目录不可读：${detail.slice(0, 200)}`)
      }
      return this.parseLs(dir, result.stdout)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('目录不可读')) throw error
      throw new Error(`列目录失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** WIN interop 本地列目录：本地 `ls -1Ap --group-directories-first <dir>`。 */
  private async browseLocal(dir: string): Promise<BrowseResult> {
    const result = await this.run(['ls', '-1Ap', '--group-directories-first', dir], { timeoutMs: 10_000 })
    if (result.timedOut || result.code !== 0) {
      const detail = result.stderr.trim() || '未知错误'
      throw new Error(`目录不可读：${detail.slice(0, 200)}`)
    }
    return this.parseLs(dir, result.stdout)
  }

  /** 解析 `ls -1Ap` 输出（尾 `/`=dir、`@`=link、`*`=file）。 */
  private parseLs(dir: string, stdout: string): BrowseResult {
    const entries: BrowseEntry[] = []
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed === '.' || trimmed === '..') continue
      const suffix = trimmed[trimmed.length - 1]
      if (suffix === '/') entries.push({ name: trimmed.slice(0, -1), type: 'dir' })
      else if (suffix === '@') entries.push({ name: trimmed.slice(0, -1), type: 'link' })
      else if (suffix === '*') entries.push({ name: trimmed.slice(0, -1), type: 'file' })
      else entries.push({ name: trimmed, type: 'file' })
    }
    const parent = this.parentOf(dir)
    return { dir, ...(parent ? { parent } : {}), entries }
  }

  /** 新建文件夹（POST /api/browse 的 mkdir 字段）。 */
  async mkdir(target: SshTarget, dir: string, name: string): Promise<void> {
    // WIN interop：本地 mkdir
    if (target.kind === 'win') {
      const result = await this.run(['mkdir', '-p', `${dir}/${name}`], { timeoutMs: 10_000 })
      if (result.timedOut || result.code !== 0) {
        const detail = result.stderr.trim() || '未知错误'
        throw new Error(`新建文件夹失败：${detail.slice(0, 200)}`)
      }
      return
    }
    const command = `mkdir -p ${shellQuote(`${dir}/${name}`)}`
    try {
      const result = await this.exec(target, command, { timeoutMs: 10_000 })
      if (result.code !== 0) {
        const detail = result.stderr.trim() || '未知错误'
        throw new Error(`新建文件夹失败：${detail.slice(0, 200)}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('新建文件夹失败')) throw error
      throw new Error(`新建文件夹失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private parentOf(dir: string): string | undefined {
    let trimmed = dir
    while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1)
    const index = trimmed.lastIndexOf('/')
    if (index <= 0) return undefined
    return trimmed.slice(0, index) || undefined
  }

  /** 关 mux（`ssh -O exit`）。close(connId) 反查不到时可用 target 兜底。 */
  async close(connId?: string, target?: SshTarget): Promise<void> {
    const resolved = target ?? (connId ? this.activeTargets.get(connId) : undefined)
    if (!resolved || resolved.kind !== 'ssh') return
    try {
      await this.control(resolved, 'exit')
    } catch {
      /* mux 已死，忽略 */
    }
    this.muxAlive.delete(this.muxKey(resolved))
    if (connId) this.activeTargets.delete(connId)
  }

  /** ctx.effect 清理：全部关 mux + 清空状态 + 清理残留 askpass 脚本。 */
  async disposeAll(): Promise<void> {
    const targets = new Set(this.activeTargets.values())
    for (const target of targets) {
      try { await this.control(target, 'exit') } catch { /* 忽略 */ }
    }
    this.activeTargets.clear()
    this.muxAlive.clear()
    try {
      for (const name of readdirSync(this.askpassDir)) {
        if (name.startsWith('askpass-')) {
          try { unlinkSync(join(this.askpassDir, name)) } catch { /* 忽略 */ }
        }
      }
    } catch {
      /* 忽略 */
    }
  }
}

export type { ChildProcess }
