/**
 * dshRemotePaths 服务（SPEC-M5 契约 A，与 cordis 无关的纯 Node 模块）。
 *
 * 语义：把"已注册远程工作区根"建模为连接注册表里 kind==='ssh' 且带 remotePath
 * 的连接（向导第 4 步落库即视为注册；win 连接的 /mnt 路径在 WSL 本地真实存在，
 * 无需远端路由，因此不进入本集合——否则 fs/shell 会把本地已可用的 win 路径错误
 * 委托给不存在的远端通道）。
 *
 * - has(path)：path 是否落在某个远程根（或其内部）——W1 的 workspace 补丁用它
 *   跳过 realpath/stat 校验；
 * - match(path)：命中返回 {connectionId, remoteRoot}（多根重叠时取最长根）；
 *   未命中 undefined——fs/shell/subprocess 补丁用它决定是否委托。
 *
 * 根目录归一：去尾部 `/`（根 `/` 保留）。每次调用实时扫注册表，新注册连接立即生效。
 */

import type { ConnectionRegistry } from './registry.ts'

/** 一次命中的连接与远端根。 */
export interface RemotePathMatch {
  connectionId: string
  remoteRoot: string
}

/** 'dshRemotePaths' cordis 可选服务面（W1 补丁消费；缺席 = 纯本地零变化）。 */
export interface DshRemotePaths {
  /** path 是否是已注册远程工作区根（或其内部）。 */
  has(path: string): boolean
  /** 命中时返回连接与远端根；未命中 undefined。 */
  match(path: string): RemotePathMatch | undefined
}

/** 远端根归一：去尾部 `/`（根 `/` 保留原样）。 */
function normalizeRoot(root: string): string {
  let value = root
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1)
  return value
}

/** path 是否等于 root 或位于 root 内部（root 已归一）。 */
function containsPath(root: string, path: string): boolean {
  if (path === root) return true
  if (path.startsWith(root)) {
    // 只认目录边界：root=/home/a 时 /home/ab 不算命中
    return root.endsWith('/') || path[root.length] === '/'
  }
  return false
}

/** 创建 dshRemotePaths 服务（实时扫连接注册表）。 */
export function createDshRemotePaths(registry: ConnectionRegistry): DshRemotePaths {
  const roots = (): RemotePathMatch[] => {
    const items: RemotePathMatch[] = []
    for (const record of registry.list()) {
      if (record.kind === 'ssh' && record.ssh && record.remotePath && record.remotePath.length > 0) {
        items.push({ connectionId: record.id, remoteRoot: normalizeRoot(record.remotePath) })
      }
    }
    return items
  }

  const match = (path: string): RemotePathMatch | undefined => {
    const value = path ?? ''
    let best: RemotePathMatch | undefined
    for (const item of roots()) {
      if (containsPath(item.remoteRoot, value) && (best === undefined || item.remoteRoot.length > best.remoteRoot.length)) {
        best = item
      }
    }
    return best
  }

  return {
    has: (path) => match(path) !== undefined,
    match,
  }
}