/**
 * workspaceRowExt —— 原生工作区行的远程扩展服务（SPEC-M6 冻结契约逐字实现）。
 *
 * 由 dsh-ssh client 经 `ctx.provide('workspaceRowExt', createRowExt())` 注册
 * （index.ts apply 顶部）；ui-workspace 的 Rows 用**惰性 getter** 每次 render
 * `ctx.get('workspaceRowExt')` 消费——dsh-ssh 在 profile bundles 里位于
 * ui-workspace 之后，apply 期捕获必然拿不到，必须是惰性取值。
 *
 * - decorate：工作区行 path 命中连接的 remotePath（前缀匹配 + 目录边界）→
 *   云/窗图标 + 状态点色 + hover 标题；未命中 undefined（= 默认文件夹图标）。
 * - menuItems：⋯ 菜单追加「打开终端/重新连接/查看日志/删除连接」。
 * - onSelect：打开终端 dispatch `dsh-ssh:open-terminal`（dsh-terminal 联动）；
 *   重新连接 = api.check + applyStatus；查看日志 = 开 logPopoverStore（锚定点击
 *   处视口坐标）；删除连接 = api.removeConnection + 顺带 uiWorkspace.deleteWorkspace
 *   （删注册记录，有 workspaceId 时——安全）。
 * - subscribe/getVersion 桥接 connectionsStore（HostObservable 形状，驱动
 *   Rows 的 useSyncExternalStore 重渲染：状态点/装饰变化即行内刷新）。
 *
 * 云/窗口图标 SVG path 原存于 RemoteSection.ts（M6 删除该文件），此处移出保留，
 * 供 ui-workspace 补丁在图标库无 IconCloud/IconWindow 时内联 SVG 照抄。
 */

import { api } from './api.ts'
import type { ConnectionEntry, ConnectionRecord, StatusState } from './api.ts'
import { connectionsStore, getPluginCtx, logPopoverStore } from './stores.ts'
import { statusColors } from './styles.tokens.ts'

/** 菜单追加项（渲染在 rename/delete 之后；形状冻结于 SPEC-M6）。 */
export interface WorkspaceRowExtItem {
  id: string
  label: string
  danger?: boolean
}

/** workspaceRowExt 服务（SPEC-M6 冻结契约逐字照抄）。 */
export interface WorkspaceRowExt {
  /** 行装饰：path 命中远程根 → {icon, statusColor?, title?}；未命中 undefined（= 默认文件夹图标）。 */
  decorate(path: string, workspaceId: string): {
    icon: 'cloud' | 'window' // 云=ssh 远程 / 窗口=WIN
    statusColor?: string // 状态点色值（在线绿/离线灰/checking 蓝）；缺席=无点
    title?: string // 行 hover title 附加（如 'kali@192.168.184.131（在线）'）
  } | undefined
  /** 追加到 ⋯ 菜单的远程管理项。 */
  menuItems(workspaceId: string, path: string): WorkspaceRowExtItem[]
  /** 菜单项选中；at=点击处视口坐标（供日志浮层定位）。 */
  onSelect(workspaceId: string, path: string, itemId: string, at: { x: number; y: number }): void
  /** HostObservable 形状：驱动 Rows 重渲染（状态点/装饰变化）。 */
  subscribe(listener: () => void): () => void
  getVersion(): number
}

/** 云图标（ssh 远程）SVG path：ui-workspace 图标库无 IconCloud 时 harness 补丁内联兜底照抄。 */
export const CLOUD_ICON_PATH = 'M4.2 12.5a3.2 3.2 0 1 1 .6-6.36 4.4 4.4 0 1 1 8.14 1.86A3.5 3.5 0 0 1 12 12.5Z'
/** 窗口图标（WIN）SVG path：同上用途（外框 + 顶栏横线）。 */
export const WINDOW_ICON_PATH = 'M2.5 3.5h11v9h-11Z M2.5 6h11'

/** 连接行 ⋯ 菜单追加项（SPEC-M6 文案逐字）。 */
const REMOTE_MENU_ITEMS: WorkspaceRowExtItem[] = [
  { id: 'open-terminal', label: '打开终端' },
  { id: 'reconnect', label: '重新连接' },
  { id: 'view-log', label: '查看日志' },
  { id: 'delete-connection', label: '删除连接', danger: true },
]

/** 远端根规范化：根 '/' 原样保留（前缀匹配对根恒真）；其余去掉尾部斜杠（兼容 / 与 \）。 */
function normalizeRoot(root: string): string {
  if (root === '' || root === '/' || root === '\\') return root
  return root.replace(/[\\/]+$/, '')
}

/** path 是否落在远端根之内（前缀匹配 + 目录边界，防 /root 误配 /root2）。 */
function isWithin(root: string, path: string): boolean {
  const r = normalizeRoot(root)
  if (r === '' || r === '/' || r === '\\') return true
  return path === r || path.startsWith(`${r}/`) || path.startsWith(`${r}\\`)
}

/** 状态点色值（在线绿/离线灰/checking 蓝；degraded 视作 checking，沿用 RemoteSection 映射）。 */
function statusColorOf(state: StatusState): string {
  switch (state) {
    case 'online':
      return statusColors.online
    case 'checking':
    case 'degraded':
      return statusColors.checking
    default:
      return statusColors.offline
  }
}

/** 状态中文文案（hover 标题「user@host（状态）」）。 */
function statusLabel(state: StatusState): string {
  switch (state) {
    case 'online':
      return '在线'
    case 'checking':
      return '检查中'
    case 'degraded':
      return '降级'
    case 'offline':
      return '离线'
    default:
      return '未知'
  }
}

/** user@host 摘要（ssh）/ 盘符路径或主机（win），与旧 RemoteSection 副行一致。 */
function userHostLabel(conn: ConnectionRecord): string {
  if (conn.kind === 'ssh') return `${conn.ssh.user}@${conn.ssh.host}`
  return conn.remotePath ?? (conn.ssh.host.length > 0 ? conn.ssh.host : '本机 Windows')
}

/** 由工作区行定位连接：workspaceId 精确优先，回落 remotePath 前缀匹配
 *（M5 起 host 侧已把注册后的 workspaceId 回写进连接记录，refresh 后精确命中）。 */
function entryFor(workspaceId: string, path: string): ConnectionEntry | undefined {
  const entries = connectionsStore.getEntries()
  if (workspaceId.length > 0) {
    const byWorkspace = entries.find((entry) => entry.connection.workspaceId === workspaceId)
    if (byWorkspace !== undefined) return byWorkspace
  }
  return entries.find((entry) =>
    entry.connection.remotePath !== undefined && isWithin(entry.connection.remotePath, path))
}

/** 重新连接：api.check 回填状态（失败保持现状，WS 状态频道继续纠偏）。 */
async function recheck(connectionId: string): Promise<void> {
  try {
    const { status } = await api.check(connectionId)
    connectionsStore.applyStatus(connectionId, status)
  } catch {
    // 忽略：离线/网络失败等下次状态推送纠偏。
  }
}

/** 删除连接：API 删除 → 顺带删注册工作区记录（有 workspaceId 时）→ 本地移除。 */
async function removeConnectionFlow(entry: ConnectionEntry): Promise<void> {
  const conn = entry.connection
  const ok = window.confirm(`删除连接「${conn.title}」？远端不会受影响，此操作不可撤销。`)
  if (!ok) return
  try {
    await api.removeConnection(conn.id)
    const workspaceId = conn.workspaceId
    if (workspaceId !== undefined && workspaceId.length > 0) {
      const uiWorkspace = getPluginCtx()?.get('uiWorkspace') as
        { deleteWorkspace(workspaceId: string): Promise<void> } | undefined
      try {
        await uiWorkspace?.deleteWorkspace(workspaceId)
      } catch (e) {
        // 连接已删成功，注册记录删除失败仅 WARN，不阻断。
        console.warn('[dsh-ssh] 删除工作区记录失败：', e instanceof Error ? e.message : String(e))
      }
    }
    connectionsStore.removeLocal(conn.id)
  } catch {
    window.alert('删除失败，请稍后重试。')
  }
}

/** 菜单项选中分发（itemId 与 REMOTE_MENU_ITEMS 一一对应；未知 id 静默忽略）。 */
function handleSelect(workspaceId: string, path: string, itemId: string, at: { x: number; y: number }): void {
  const entry = entryFor(workspaceId, path)
  if (entry === undefined) return
  const conn = entry.connection
  switch (itemId) {
    case 'open-terminal':
      // dsh-terminal 联动：detail 携带 connectionId/kind/title/remotePath（H2 消费）。
      window.dispatchEvent(new CustomEvent('dsh-ssh:open-terminal', {
        detail: { connectionId: conn.id, kind: conn.kind, title: conn.title, remotePath: conn.remotePath },
      }))
      break
    case 'reconnect':
      void recheck(conn.id)
      break
    case 'view-log':
      logPopoverStore.open(conn.id, at)
      break
    case 'delete-connection':
      void removeConnectionFlow(entry)
      break
    default:
      break
  }
}

/** 工厂：index.ts apply 里 `ctx.provide('workspaceRowExt', createRowExt())`。 */
export function createRowExt(): WorkspaceRowExt {
  return {
    decorate: (path, workspaceId) => {
      const entry = entryFor(workspaceId, path)
      if (entry === undefined) return undefined
      const conn = entry.connection
      return {
        icon: conn.kind === 'win' ? 'window' : 'cloud',
        statusColor: statusColorOf(entry.status.state),
        title: `${userHostLabel(conn)}（${statusLabel(entry.status.state)}）`,
      }
    },
    // 本地行（非远程根）返回 []：菜单零追加，逐字节原行为。
    menuItems: (workspaceId, path) => entryFor(workspaceId, path) === undefined ? [] : REMOTE_MENU_ITEMS,
    onSelect: handleSelect,
    subscribe: (listener) => connectionsStore.subscribe(listener),
    getVersion: () => connectionsStore.getVersion(),
  }
}