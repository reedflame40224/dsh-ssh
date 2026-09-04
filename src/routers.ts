/**
 * M5 路由服务三件（SPEC-M5 契约 A）：fsRemoteRouter / shellRemoteRouter /
 * subprocessRemoteRouter 的 cordis 提供体（与 cordis 无关的纯 Node 模块）。
 *
 * 三者都是"可选钩子"提供方：W1 在 stock 实现里 `ctx.get('<name>')` 判 undefined，
 * 缺席 = 纯本地零变化。命中判定统一走 dshRemotePaths.match（已注册远程根）。
 *
 * - fsRemoteRouter.route(path, cwd?)：命中返回 RemoteFsLike（FileSystem 方法面
 *   等价对象）；相对路径先按 cwd 解析为绝对再匹配；
 * - shellRemoteRouter / subprocessRemoteRouter.routeByCwd(cwd?)：命中返回
 *   RemoteExecLike（bash run/start/resolve 与 subprocess spawn 共用同一面；
 *   spawn 内把本地 rg argv[0] 翻译为远端运行时 rg）。
 */

import { resolve } from 'node:path'
import { isAbsolute } from 'node:path'
import type { DshRemotePaths, RemotePathMatch } from './remote-paths.ts'
import type { RemoteFsLike, RemoteExecLike, RemoteOpsDeps } from './remote-exec.ts'
import { createRemoteFsFactory, createRemoteExecFactory, type RemoteFsFactory, type RemoteExecFactory } from './remote-exec.ts'

/** fsRemoteRouter 服务面（W1 fs-local 补丁消费）。 */
export interface FsRemoteRouter {
  /** 命中返回一个与 FileSystem 该方法签名等价的远端实现对象；未命中 undefined。 */
  route(path: string, cwd?: string): RemoteFsLike | undefined
}

/** shellRemoteRouter / subprocessRemoteRouter 服务面（同形不同名）。 */
export interface ExecRemoteRouter {
  /** cwd 命中远程根 → 返回远端执行器；未命中 undefined。 */
  routeByCwd(cwd: string | undefined): RemoteExecLike | undefined
}

export interface Routers {
  fsRemoteRouter: FsRemoteRouter
  shellRemoteRouter: ExecRemoteRouter
  subprocessRemoteRouter: ExecRemoteRouter
}

export interface RoutersDeps extends RemoteOpsDeps {
  paths: DshRemotePaths
}

/** 相对路径先按 cwd 解析为绝对（无 cwd 时保持原样——匹配必然缺席，语义安全）。 */
function absoluteFor(path: string, cwd?: string): string {
  if (path.length === 0) return path
  if (isAbsolute(path)) return path
  return cwd !== undefined && cwd.length > 0 ? resolve(cwd, path) : path
}

export function createRouters(deps: RoutersDeps): Routers {
  const fsFactory: RemoteFsFactory = createRemoteFsFactory(deps)
  const execFactory: RemoteExecFactory = createRemoteExecFactory(deps)

  const routeFs = (path: string, cwd?: string): RemoteFsLike | undefined => {
    const match = deps.paths.match(absoluteFor(path, cwd))
    return match === undefined ? undefined : fsFactory.forMatch(match)
  }

  const routeExec = (cwd: string | undefined): RemoteExecLike | undefined => {
    if (cwd === undefined || cwd.length === 0) return undefined
    const match: RemotePathMatch | undefined = deps.paths.match(cwd)
    return match === undefined ? undefined : execFactory.forMatch(match)
  }

  return {
    fsRemoteRouter: { route: routeFs },
    shellRemoteRouter: { routeByCwd: routeExec },
    subprocessRemoteRouter: { routeByCwd: routeExec },
  }
}