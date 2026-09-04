/**
 * dsh-ssh 宿主侧（Node）入口：cordis apply 薄壳。
 *
 * 只做组装：
 *   1. ConnectionRegistry（~/.dsh/dsh-ssh，tmp+rename 原子写）；
 *   2. SshConnector（系统 OpenSSH + ControlMaster，mux/askpass 目录由 registry 建好；
 *      注入 M2 runtimeStep hook）；
 *   3. RuntimePool + RuntimeManager（M2：远端运行时 stdio 通道池与下发管理）；
 *   4. LivenessProbe（加载即全量探测 + 60s±15% 复探 + offline 指数退避 + runtime degraded）；
 *   5. LogHub（日志/状态 WS 通道，快照+增量）；
 *   6. M5：dshRemotePaths + 路由三件（fs/shell/subprocess 的 W1 可选钩子消费方）、
 *      terminals 'ssh' 后端、systemPrompt 提示段、register-remote-workspace 路由；
 *   7. createApi 挂全部 HTTP/WS 路由；
 *   8. `ctx.provide('dshSsh', …)`（dsh-terminal 消费）+ 四个 M5 新名；
 *   9. ctx.effect 全量回收（路由 dispose、探测定时器、WS server、运行时池、mux、
 *      M5 后端与提示段 disposers）。
 *
 * 规范约束：不 import 任何 @deepseek-ai/* 运行时值（链接挂载解析不到），
 * 服务面用本地最小结构接口声明。
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { ConnectionRegistry, type ConnectionRecord } from './registry.ts'
import { SshConnector, type SshLogFn, type SshTarget } from './ssh.ts'
import { LivenessProbe } from './liveness.ts'
import { LogHub } from './loghub.ts'
import { createApi } from './routes.ts'
import { RuntimePool } from './remote-client.ts'
import { RuntimeManager } from './runtime.ts'
import { createDshSshService, type DshSshService, type RemoteSpawnSpec, type RemoteSpawnResult } from './service.ts'
import { createDshRemotePaths } from './remote-paths.ts'
import { createRouters, type Routers } from './routers.ts'
import { registerSshTerminalBackend } from './terminal-backend.ts'

export const name = 'dsh-ssh'

interface WebRoute {
  kind: 'prefix' | 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

interface WebUpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

interface WebServerLike {
  register(route: WebRoute): () => void
  registerUpgrade(route: WebUpgradeRoute): () => void
}

/** cordis Context 的最小面。 */
interface HostContextLike {
  get(name: string): unknown
  inject(keys: string[], fn: (ctx: HostContextLike) => void): unknown
  effect(fn: () => unknown, name?: string): unknown
  provide(name: string, value: unknown): unknown
}

/** terminals 服务最小面（M5 ssh 后端注册用）。 */
interface TerminalsLike {
  registerBackend(backend: import('./terminal-backend.ts').TerminalBackendLike): () => void
}

/** subprocess 服务最小面（M5 只消费 spawnTerminal）。 */
interface SubprocessLike {
  spawnTerminal(spec: import('./terminal-backend.ts').RemoteTerminalSpawnSpecLike): Promise<import('./terminal-backend.ts').RemoteTerminalHandleLike>
}

/** systemPrompt 服务最小面（M5 只消费 section + variable）。 */
interface SystemPromptLike {
  section(input: { name: string; order: number; text: string }): () => void
  variable(name: string, provider: (context: { agent?: { session?: { header?: { cwd?: string } } } }) => string | undefined): () => void
}

/** 读取插件 package.json 版本（构建后 lib/index.js → ../package.json）。 */
function pluginVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }
    return pkg.version ?? '0.1.0'
  } catch {
    return '0.1.0'
  }
}

export function apply(ctx: HostContextLike): void {
  // 遵循 harness 约定：数据根 = $DSH_HOME（缺省 ~/.dsh）。隔离测试实例（DSH_HOME 指他处）不碰用户真注册表。
  const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const baseDir = join(dshHome, 'dsh-ssh')
  const registry = new ConnectionRegistry({ baseDir })
  registry.load()

  // M2 runtimeStep hook：testConnect / POST /api/connect 全链路注入（缺省返回 undefined = M1 行为）。
  // 闭包引用 pool/runtimeManager——它们在其后初始化，但 hook 只在运行期（ensure 时）被调用，
  // 此时均已就绪（JS const TDZ 语义保证）。安装硬失败（ensure 已记 ERROR 的带 logged 标记）
  // 不阻断 ssh 连接；运行时降级由存活检测表达。
  const runtimeStep = async (
    target: SshTarget,
    draft: Extract<import('./registry.ts').ConnectDraft, { kind: 'ssh' }>,
    log: SshLogFn,
  ): Promise<{ installed: boolean; version?: string; reused?: string } | undefined> => {
    if (!target.downloadMethod) return undefined
    try {
      const result = await runtimeManager.ensure(target, {
        method: target.downloadMethod,
        remoteUrl: (draft.ssh as { runtimeUrl?: string } | undefined)?.runtimeUrl,
      }, log)
      return result ?? undefined
    } catch (error) {
      if (!(error as { logged?: boolean }).logged) {
        log({ level: 'ERROR', msg: `运行时安装失败：${error instanceof Error ? error.message : String(error)}` })
      }
      return undefined
    }
  }

  const connector = new SshConnector({ muxDir: registry.muxDir, askpassDir: registry.askpassDir, runtimeStep })
  const pool = new RuntimePool({ connector })
  const runtimeManager = new RuntimeManager({ connector, pool, version: pluginVersion() })

  const probe = new LivenessProbe({
    registry,
    connector,
    pool,
    onStatus: (connId, status) => {
      loghub.pushStatus(connId, status)
    },
  })
  const loghub = new LogHub({ getStatuses: () => probe.getStatuses() })

  // M5 契约 A：dshRemotePaths + 路由三件（W1 可选钩子消费；新名字不冲突存量）。
  const remotePaths = createDshRemotePaths(registry)
  const routers: Routers = createRouters({
    registry,
    connector,
    pool,
    paths: remotePaths,
    getStatus: (connId) => probe.getStatus(connId),
    log: (line) => loghub.pushLog('router', line.level, line.msg),
  })
  ctx.provide('dshRemotePaths', remotePaths)
  ctx.provide('fsRemoteRouter', routers.fsRemoteRouter)
  ctx.provide('shellRemoteRouter', routers.shellRemoteRouter)
  ctx.provide('subprocessRemoteRouter', routers.subprocessRemoteRouter)

  // M5 契约 D：注册远程工作区（原生工作区列表可见）。workspaceRegistry 为可选服务；
  // create() 走 W1 的 tolerate 补丁（远程路径跳过 realpath/stat 校验）。already 记录
  // 本进程内已注册路径（重复 create 幂等复用实体）。
  const registeredRemoteRoots = new Set<string>()
  const registerRemoteWorkspace = async (connectionId: string): Promise<{
    ok: boolean
    workspaceId?: string
    already?: boolean
    error?: string
  }> => {
    const record = registry.get(connectionId)
    if (!record) return { ok: false, error: `连接不存在：${connectionId}` }
    if (!record.remotePath || record.remotePath.length === 0) {
      return { ok: false, error: `连接 ${connectionId} 未设置远程目录（remotePath）` }
    }
    const workspaceRegistry = ctx.get('workspaceRegistry') as
      | { create(path: string, title?: string): Promise<{ id: unknown }> }
      | undefined
    if (!workspaceRegistry) return { ok: false, error: '工作区注册服务（workspaceRegistry）不可用' }
    try {
      const workspace = await workspaceRegistry.create(record.remotePath)
      const already = registeredRemoteRoots.has(record.remotePath)
      registeredRemoteRoots.add(record.remotePath)
      const workspaceId = workspace?.id !== undefined ? String(workspace.id) : ''
      // 记录 workspaceId：远程 section 行点击据此直接打开原生会话（M5 联动）。
      if (workspaceId.length > 0) registry.updateWorkspaceId(connectionId, workspaceId)
      return { ok: true, ...(workspaceId.length > 0 ? { workspaceId } : {}), ...(already ? { already: true } : {}) }
    } catch (error) {
      return { ok: false, error: `注册工作区失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  const api = createApi({
    registry,
    connector,
    liveness: probe,
    loghub,
    pool,
    runtimeManager,
    version: pluginVersion(),
    registerRemoteWorkspace,
  })

  // dshSsh 服务：dsh-terminal 等后端消费（H 节契约）
  ctx.provide('dshSsh', createDshSshService({ registry, connector, liveness: probe }))

  // M5 契约 C：terminals 后端（type 'ssh'）+ systemPrompt 提示段/变量。
  // 三个服务均需等待 inject；注册全部走 ctx.effect 可回收。
  ctx.inject(['terminals', 'subprocess', 'systemPrompt'], (injected) => {
    const disposers: Array<() => void> = []
    const terminals = injected.get('terminals') as TerminalsLike | undefined
    const subprocess = injected.get('subprocess') as SubprocessLike | undefined
    if (terminals !== undefined && subprocess !== undefined) {
      try {
        // dshSsh 是本插件 apply 顶部 provide 的，这里同 ctx 可用
        const dshSsh = ctx.get('dshSsh') as DshSshService | undefined
        if (dshSsh !== undefined) {
          disposers.push(registerSshTerminalBackend({
            dshSsh,
            paths: remotePaths,
            terminals,
            spawnTerminal: (spec) => subprocess.spawnTerminal(spec),
          }))
        }
      } catch (error) {
        // 后端注册失败不阻断插件本体（终端功能降级，连接/引导/路由不受影响）
        console.warn('[dsh-ssh] ssh 终端后端注册失败：', error)
      }
    }
    const systemPrompt = injected.get('systemPrompt') as SystemPromptLike | undefined
    if (systemPrompt !== undefined) {
      try {
        disposers.push(systemPrompt.section({
          name: 'dsh-ssh-remote',
          // TOOL_PTY(1700) 之后、TOOL_WEB_SEARCH(2000) 之前的稀疏位
          order: 1800,
          text: '{{dsh_ssh_remote_hint}}',
        }))
        disposers.push(systemPrompt.variable('dsh_ssh_remote_hint', (context) => {
          const cwd = context.agent?.session?.header?.cwd
          if (cwd === undefined || cwd.length === 0) return ''
          const match = remotePaths.match(cwd)
          if (match === undefined) return ''
          const record = registry.get(match.connectionId)
          if (record === undefined) return ''
          // 本地会话返回空串（renderPrompt 对空段直接丢弃；undefined 会让
          // 引用它的 section 抛错，故用空串表达"无提示"）
          return `本会话的工作区在远端主机 ${record.title}（连接 ${match.connectionId}）。所有文件与命令操作已在远端执行；terminal_open 的 type 用 'ssh'。`
        }))
      } catch (error) {
        console.warn('[dsh-ssh] systemPrompt 注册失败：', error)
      }
    }
    ctx.effect(() => {
      const owned = disposers.slice().reverse()
      return () => {
        for (const dispose of owned) {
          try { dispose() } catch { /* 已回收 */ }
        }
      }
    }, 'dsh-ssh: M5 terminals backend + systemPrompt cleanup')
  })

  // 加载即探测（插件加载即全量探测；随后 start 里的周期调度在 sweep 后执行）
  probe.start()

  // M5 迁移自愈：存量连接（升级前注册的，缺 workspaceId）在 workspaceRegistry
  // 就绪后补齐工作区注册——行点击随即获得"打开会话"主动作。失败仅 warn。
  ctx.inject(['workspaceRegistry'], () => {
    for (const record of registry.list()) {
      if (record.remotePath !== undefined && record.remotePath.length > 0
        && (record.workspaceId === undefined || record.workspaceId.length === 0)) {
        void registerRemoteWorkspace(record.id).then((result) => {
          if (!result.ok) console.warn('[dsh-ssh] 存量工作区注册跳过：', record.title, result.error)
        })
      }
    }
  })

  // webServer 是异步注册的，必须走 inject 等待。
  ctx.inject(['webServer'], (injected) => {
    const webServer = injected.get('webServer') as WebServerLike
    const disposeRoutes = api.httpRoutes.map((route) => webServer.register(route))
    const disposeUpgrade = webServer.registerUpgrade(api.wsRoute)

    ctx.effect(() => () => {
      for (const dispose of disposeRoutes) {
        try { dispose() } catch { /* 已回收 */ }
      }
      try { disposeUpgrade() } catch { /* 已回收 */ }
      api.dispose()
      probe.stop()
      loghub.dispose()
      pool.disposeAll()
      void connector.disposeAll()
    }, 'dsh-ssh: routes + probe + ws + runtime pool + mux cleanup')
  })
}

// 类型再导出（供其它模块 type-only 引用，无运行时副作用）
export type { ConnectionRecord, SshTarget, DshSshService, RemoteSpawnSpec, RemoteSpawnResult }