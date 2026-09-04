/**
 * RuntimeManager —— dsh-remote 远端运行时下发管理（SPEC-M2 R2，与 cordis 无关的纯 Node 模块）。
 *
 * 常量：REMOTE_HOME='.dsh-remote'（远端登录用户家目录下）；
 *   LOCAL_TAR = assets/runtime/dsh-remote-<version>-linux-x64.tar.gz（M2 只交付 linux-x64 变体）。
 *
 * ensure(target, {method:'upload'|'remote', remoteUrl?}, log) 流程：
 *   0) 自探测远端平台 + node 版本（非 linux-x64 → WARN 跳过，返回 undefined）；
 *   1) INFO `检查远端运行时…` → cat current/manifest.json + .ready；
 *      version 与本地一致且 .ready → INFO `运行时已是最新（v…）`（reused=undefined）；
 *   2) 上传（openChannel `cat > staging/<v>.tar.gz` 流式写本地 tar 字节）或远端下载（curl/wget）；
 *   3) sha256 校验（本地算 tar sha ↔ 远端 sha256sum；不等 → ERROR `校验失败`，current 不变）；
 *   4) 单条 exec 解压激活（rm -rf cache/<v> && mkdir && tar -xzf && chmod && ln -sfn current
 *      && touch .ready && rm -f staging 包）→ INFO `运行时校验通过，激活 v…`；
 *   5) RuntimePool.get → hello/ping 握手 → INFO `远端运行时握手成功（node …）`；
 *      失败 → WARN 但仍算 installed（ssh 可用，运行时降级由存活检测表达）。
 *   node 复用判定：current 含 node/bin/node → bundled-node（start.sh 优先自带）；
 *   否则远端 node major≥18 → system-node；都没有 → WARN 无可用 node。
 *
 * 约定：install 过程中「已记日志」的预期失败（校验失败 / 上传失败 / 激活失败等）
 * 抛出的 Error 带 `logged=true` 标记，上层 hook 不再重复打日志。
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SshChannel, SshExecResult, SshLogFn, SshTarget } from './ssh.ts'
import { normalizeArchName, normalizeOsName, shellQuote } from './ssh.ts'
import type { DownloadMethod } from './registry.ts'
import type { RuntimePool } from './remote-client.ts'

/** 远端运行时家目录（登录用户家目录下）。 */
const REMOTE_HOME = '.dsh-remote'

export interface RuntimeEnsureOptions {
  method?: DownloadMethod
  /** method='remote' 时的下载源地址（draft.runtimeUrl；缺省报明错）。 */
  remoteUrl?: string
}

export interface RuntimeEnsureResult {
  installed: true
  version: string
  reused?: 'system-node' | 'bundled-node'
}

export interface RuntimeManagerDeps {
  connector: import('./ssh.ts').SshConnector
  pool: RuntimePool
  /** dsh-remote 运行时版本（package.json version，与 tar 文件名一致）。 */
  version: string
  /** 本地运行时产物目录（默认 <包根>/assets/runtime，src/ 与 lib/ 下两层路径一致）。 */
  assetsDir?: string
}

export class RuntimeManager {
  private deps: RuntimeManagerDeps

  constructor(deps: RuntimeManagerDeps) {
    this.deps = deps
  }

  /** 本地 linux-x64 变体 tar 产物路径（src/ 与 lib/ 下相对包根均为 ../assets/runtime）。
   *  slim=不含 node（远端复用系统 node）；with-node=内置 node 变体。 */
  private localTarPath(variant: 'slim' | 'with-node'): string {
    const assetsDir = this.deps.assetsDir ?? fileURLToPath(new URL('../assets/runtime/', import.meta.url))
    const suffix = variant === 'with-node' ? '.with-node.tar.gz' : '.tar.gz'
    return join(assetsDir, `dsh-remote-${this.deps.version}-linux-x64${suffix}`)
  }

  /** 变体选择：远端有 node≥18 优先 slim（小上传）；否则必须 with-node；都没有则硬失败给指引。 */
  private selectVariant(env: { nodeMajor?: number }): { variant: 'slim' | 'with-node'; tarLocal: string } {
    const slim = this.localTarPath('slim')
    const withNode = this.localTarPath('with-node')
    const remoteHasNode = env.nodeMajor !== undefined && env.nodeMajor >= 18
    if (remoteHasNode && existsSync(slim)) return { variant: 'slim', tarLocal: slim }
    if (existsSync(withNode)) return { variant: 'with-node', tarLocal: withNode }
    if (!remoteHasNode && existsSync(slim)) {
      throw new Error('远端无 node>=18 且本地无内置 node 变体：请先 pnpm fetch:node（或放置 node 资产）后 pnpm build:runtime -- --with-node')
    }
    throw new Error(`本地运行时产物缺失：${slim}（先跑 pnpm build:runtime）`)
  }

  /** 经 mux 执行远端命令（timeout 抛错由上层兜底）。 */
  private exec(target: SshTarget, command: string, timeoutMs = 15_000): Promise<SshExecResult> {
    return this.deps.connector.exec(target, command, { timeoutMs })
  }

  /** 已记日志的失败：抛错并标记 logged（上层 hook 不重复打日志）。 */
  private loggedErr(log: SshLogFn, logMsg: string, errMsg: string): Error {
    log({ level: 'ERROR', msg: logMsg })
    const err = new Error(errMsg)
    ;(err as { logged?: boolean }).logged = true
    return err
  }

  /**
   * 远端平台 + node 版本探测（ensure 自给自足，不依赖 liveness 的 env 缓存）。
   * 失败抛错（ssh 本就不可用时由上层 hook 降级处理）。
   */
  private async probeRemoteEnv(target: SshTarget): Promise<{ os: string; arch: string; node?: string; nodeMajor?: number }> {
    const result = await this.exec(target, 'uname -sm; echo "NODE:$(node --version 2>/dev/null)"', 10_000)
    let uname = ''
    let node: string | undefined
    for (const raw of result.stdout.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line) continue
      if (line.startsWith('NODE:')) {
        const v = line.slice(5).trim()
        if (v) node = v
      } else if (!uname) {
        uname = line
      }
    }
    const [osRaw, archRaw] = uname.split(/\s+/)
    const os = normalizeOsName(osRaw ?? '')
    const arch = normalizeArchName(archRaw ?? '')
    const nodeMajor = node ? Number(node.replace(/^v/, '').split('.')[0]) : undefined
    return {
      os,
      arch,
      ...(node ? { node } : {}),
      ...(nodeMajor !== undefined && Number.isFinite(nodeMajor) ? { nodeMajor } : {}),
    }
  }

  /** 幂等检查：current/.ready 存在且 manifest.version 与本地一致。 */
  private async checkExisting(target: SshTarget): Promise<{ version: string } | undefined> {
    const command = `[ -f ~/${REMOTE_HOME}/current/.ready ] && cat ~/${REMOTE_HOME}/current/manifest.json 2>/dev/null || echo __NO_RUNTIME__`
    const result = await this.exec(target, command, 10_000)
    if (result.code !== 0) return undefined
    if (result.stdout.trim().includes('__NO_RUNTIME__')) return undefined
    try {
      const manifest = JSON.parse(result.stdout) as { version?: unknown }
      if (typeof manifest.version !== 'string' || !manifest.version) return undefined
      return { version: manifest.version }
    } catch {
      // 半成品 manifest → 视为未安装，重装
      return undefined
    }
  }

  /** 经 openChannel 流式上传本地 tar 字节（`cat > staging/<v>.tar.gz`），EOF 后等退出码。 */
  private uploadChannel(target: SshTarget, data: Buffer, version: string): Promise<number> {
    return new Promise((resolve) => {
      void this.deps.connector
        .openChannel(target, `cat > ~/${REMOTE_HOME}/staging/${version}.tar.gz`)
        .then((channel: SshChannel) => {
          channel.onExit((code) => resolve(code ?? 1))
          // 分块写原始字节（64KB），背压时等 drain 续写
          let offset = 0
          const pump = (): void => {
            while (offset < data.length) {
              const chunk = data.subarray(offset, offset + 65536)
              offset += chunk.length
              const buffered = channel.writeRaw(chunk)
              if (!buffered) {
                channel.onceDrain(pump)
                return
              }
            }
            // 全部写毕 → stdin EOF → 远端 cat 收尾退出
            channel.close()
          }
          pump()
        })
        .catch(() => resolve(1))
    })
  }

  /** 安装：上传/远端下载 → sha256 校验 → 解压激活。任何一步失败即整体失败（current 不变）。
   *  tarLocal：ensure 已按远端 node 探测选好的本地变体包（upload 路径必读；remote 路径仅作可选的校验参照）。 */
  private async install(target: SshTarget, opts: RuntimeEnsureOptions, log: SshLogFn, tarLocal: string): Promise<void> {
    const version = this.deps.version
    const method = opts.method ?? target.downloadMethod ?? 'upload'
    const staging = `~/${REMOTE_HOME}/staging`
    const tarRemote = `${staging}/${version}.tar.gz`

    // 2) 获取安装包
    if (method === 'remote') {
      const url = opts.remoteUrl
      if (!url) throw this.loggedErr(log, '未配置远端下载源地址（remoteUrl）', '未配置远端下载源地址')
      log({ level: 'INFO', msg: `远端服务器下载：${url}` })
      const res = await this.exec(
        target,
        `mkdir -p ${staging} && (curl -fsSL ${shellQuote(url)} -o ${tarRemote} || wget -qO ${tarRemote} ${shellQuote(url)})`,
        120_000,
      )
      if (res.code !== 0) {
        const detail = res.stderr.trim() || res.stdout.trim() || '未知错误'
        throw this.loggedErr(log, `远端服务器下载失败：${detail.slice(0, 200)}`, '远端服务器下载失败')
      }
    } else {
      if (!existsSync(tarLocal)) {
        throw this.loggedErr(log, `本地运行时产物缺失：${tarLocal}`, '本地运行时产物缺失')
      }
      const bytes = statSync(tarLocal).size
      log({ level: 'INFO', msg: `本地下载后上传：上传运行时包（${(bytes / 1048576).toFixed(1)} MB）…` })
      await this.exec(target, `mkdir -p ${staging}`, 10_000)
      const code = await this.uploadChannel(target, readFileSync(tarLocal), version)
      if (code !== 0) throw this.loggedErr(log, `上传运行时包失败（exit ${code}）`, '上传运行时包失败')
    }

    // 3) sha256 校验：本地算 tar sha ↔ 远端 sha256sum。
    //    upload 必有本地参照；remote 路径若本地恰有同版产物（确定性构建）也比对，否则只做格式健全性。
    let expectedSha: string | undefined
    if (existsSync(tarLocal)) {
      expectedSha = createHash('sha256').update(readFileSync(tarLocal)).digest('hex')
    }
    const sumRes = await this.exec(target, `sha256sum ${tarRemote}`, 15_000)
    const remoteSha = (sumRes.stdout.trim().split(/\s+/)[0] ?? '').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(remoteSha)) {
      const detail = sumRes.stderr.trim() || 'sha256sum 不可用或无输出'
      throw this.loggedErr(log, `校验失败：${detail.slice(0, 120)}`, '校验失败')
    }
    if (expectedSha && remoteSha !== expectedSha) {
      throw this.loggedErr(log, `校验失败：远端 sha256 与本地不一致（${remoteSha.slice(0, 12)}… vs ${expectedSha.slice(0, 12)}…）`, '校验失败')
    }

    // 4) 解压激活（单条 exec，分段失败即整体失败；失败时 current 保持原样）
    const actCmd = [
      `rm -rf ~/${REMOTE_HOME}/cache/${version}`,
      `mkdir -p ~/${REMOTE_HOME}/cache/${version}`,
      `tar -xzf ${tarRemote} -C ~/${REMOTE_HOME}/cache/${version}`,
      `chmod +x ~/${REMOTE_HOME}/cache/${version}/start.sh`,
      `ln -sfn ~/${REMOTE_HOME}/cache/${version} ~/${REMOTE_HOME}/current`,
      `touch ~/${REMOTE_HOME}/cache/${version}/.ready`,
      `rm -f ${tarRemote}`,
    ].join(' && ')
    const actRes = await this.exec(target, actCmd, 30_000)
    if (actRes.code !== 0) {
      const detail = actRes.stderr.trim() || actRes.stdout.trim() || '未知错误'
      throw this.loggedErr(log, `运行时激活失败：${detail.slice(0, 200)}`, '运行时激活失败')
    }
    log({ level: 'INFO', msg: `运行时校验通过，激活 v${version}` })
  }

  /** current 是否含内置 node（start.sh 将优先自带）。 */
  private async hasBundledNode(target: SshTarget): Promise<boolean> {
    try {
      const res = await this.exec(target, `test -x ~/${REMOTE_HOME}/current/node/bin/node && echo YES || echo NO`, 10_000)
      return res.code === 0 && res.stdout.trim().includes('YES')
    } catch {
      return false
    }
  }

  /** 激活后握手：RuntimePool.get（hello）→ ping；失败记 WARN 但仍算 installed。 */
  private async handshake(target: SshTarget, log: SshLogFn): Promise<void> {
    // 无 connId（向导期）用一次性 key，用完即弃；有 connId 则缓存复用
    const key = target.connId ?? `wizard-${randomUUID()}`
    try {
      const client = await this.deps.pool.get(key, target)
      const hello = await client.helloInfo
      await client.call('ping', {}, 3_000)
      log({ level: 'INFO', msg: `远端运行时握手成功（node ${hello.node}）` })
      if (!target.connId) this.deps.pool.drop(key)
    } catch (error) {
      log({ level: 'WARN', msg: `远端运行时握手失败：${error instanceof Error ? error.message : String(error)}` })
      if (!target.connId) this.deps.pool.drop(key)
    }
  }

  /**
   * 确保远端已安装并激活当前版本运行时。
   * 返回 undefined 表示跳过（平台不支持 / 探测失败）；抛错表示安装硬失败（已记 ERROR 日志的带 logged 标记）。
   */
  async ensure(target: SshTarget, opts: RuntimeEnsureOptions = {}, log: SshLogFn): Promise<RuntimeEnsureResult | undefined> {
    // 0) 远端平台 + node 探测（M2 只交付 linux-x64 变体）
    let env: { os: string; arch: string; node?: string; nodeMajor?: number }
    try {
      env = await this.probeRemoteEnv(target)
    } catch (error) {
      log({ level: 'WARN', msg: `远端环境探测失败，跳过运行时安装：${error instanceof Error ? error.message : String(error)}` })
      return undefined
    }
    if (env.os !== 'linux' || env.arch !== 'x64') {
      log({ level: 'WARN', msg: `目标平台 ${env.os}/${env.arch} 暂无运行时变体（M2 仅交付 linux-x64），跳过` })
      return undefined
    }

    // 1) 幂等检查
    log({ level: 'INFO', msg: '检查远端运行时…' })
    const existing = await this.checkExisting(target)
    if (existing && existing.version === this.deps.version) {
      log({ level: 'INFO', msg: `运行时已是最新（v${existing.version}）` })
      return { installed: true, version: existing.version, reused: undefined }
    }

    // 变体选择（远端有 node≥18 优先 slim；否则必须 with-node；都没有硬失败给指引）
    let selection: { variant: 'slim' | 'with-node'; tarLocal: string }
    try {
      selection = this.selectVariant(env)
    } catch (error) {
      throw this.loggedErr(log, error instanceof Error ? error.message : String(error), '运行时产物缺失')
    }
    if (opts.method !== 'remote') {
      log({ level: 'INFO', msg: `选择运行时变体：${selection.variant === 'with-node' ? '内置 node 包' : 'slim（复用远端 node）'}` })
    }

    // 2-4) 安装（上传/远端下载 → 校验 → 激活）
    await this.install(target, opts, log, selection.tarLocal)

    // node 复用判定（日志如实打印 reused）
    let reused: 'system-node' | 'bundled-node' | undefined
    if (await this.hasBundledNode(target)) {
      reused = 'bundled-node'
      log({ level: 'INFO', msg: 'node 复用：bundled-node（包内自带 node）' })
    } else if (env.nodeMajor !== undefined && env.nodeMajor >= 18) {
      reused = 'system-node'
      log({ level: 'INFO', msg: `node 复用：system-node（远端 node ${env.node}）` })
    } else {
      log({ level: 'WARN', msg: '远端无可用 node（>=18）且包内无内置 node，运行时将无法启动' })
    }

    // 5) 握手
    await this.handshake(target, log)

    return { installed: true, version: this.deps.version, reused }
  }
}