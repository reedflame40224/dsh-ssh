/**
 * RemoteSection —— `sidebar.workspaces.sections` 孔条目：远程工作区 section
 *（SPEC-M1 J 节）。分区标题「远程」；行=图标（ssh=云朵轮廓 / win=窗口）+标题+
 * 副行小字（user@host / 盘符路径）+右侧状态件（checking spinner / online 绿点 /
 * offline 灰点）+⋯菜单（打开终端 / 重新连接 / 查看日志 / 删除连接）。
 * 行点击（online）dispatch `dsh-ssh:open-terminal`（detail 携带
 * connectionId/kind/title/remotePath，dsh-terminal 消费联动）。
 *
 * 向导连接中在分区顶部渲染临时行（spinner「正在连接…」+ 日志浮层与向导共用
 * 同一 WS 频道，最小化不杀 pipeline；点击可恢复向导）。
 *
 * 降级：插件 API 首次拉取失败且无数据（404/未挂载）→ 整节不渲染（null），
 * 绝不让侧栏白屏。
 */

import { createElement, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api } from '../api.ts'
import type { ConnectionEntry, StatusState } from '../api.ts'
import { connectionsStore, getPluginCtx, wizardStore } from '../stores.ts'
import { statusColors } from '../styles.tokens.ts'
import { LogPopover } from './LogPopover.ts'
import css from './Section.module.css'

export interface RemoteSectionProps {
  wide: boolean
}

function statusColor(state: StatusState): string {
  switch (state) {
    case 'online':
      return statusColors.online
    case 'checking':
      return statusColors.checking
    case 'degraded':
      return statusColors.checking
    default:
      return statusColors.offline
  }
}

export function RemoteSection(_props: RemoteSectionProps) {
  useSyncExternalStore(connectionsStore.subscribe, connectionsStore.getVersion)
  useSyncExternalStore(wizardStore.subscribe, wizardStore.getVersion)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [menuAnchor, setMenuAnchor] = useState<DOMRect | null>(null)
  const [logKey, setLogKey] = useState<string | null>(null)
  const [logAnchor, setLogAnchor] = useState<DOMRect | null>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())

  // 初始拉取注册表（失败保留旧数据；无数据且 API 不可用则本节渲染 null）。
  useEffect(() => {
    void connectionsStore.refresh()
  }, [])

  // 打开菜单：记录行视口矩形，菜单 fixed 定位。
  const openMenu = (connectionId: string): void => {
    const rect = rowRefs.current.get(connectionId)?.getBoundingClientRect()
    if (rect === undefined) return
    setMenuAnchor(rect)
    setMenuFor(connectionId)
  }
  const closeMenu = (): void => {
    setMenuFor(null)
    setMenuAnchor(null)
  }

  // 打开日志浮层（锚定行右侧）。
  const openLog = (key: string, targetRef?: HTMLDivElement | null): void => {
    const rect = targetRef?.getBoundingClientRect() ?? rowRefs.current.get(key)?.getBoundingClientRect()
    if (rect === undefined) return
    setLogAnchor(rect)
    setLogKey(key)
  }

  // 行点击（仅 online）→ 打开远程终端联动（detail 携带标题/路径供标签命名与 cwd）。
  const openTerminalFor = (entry: ConnectionEntry): void => {
    const { connection: conn } = entry
    window.dispatchEvent(new CustomEvent('dsh-ssh:open-terminal', {
      detail: { connectionId: conn.id, kind: conn.kind, title: conn.title, remotePath: conn.remotePath },
    }))
  }

  // 行主动作（仅 online）：已注册原生工作区 → uiWorkspace.startSession 开会话
  //（与本地工作区零差别）；未注册 → 回落开终端（dsh-terminal 联动）。
  const openPrimaryFor = (entry: ConnectionEntry): void => {
    const { connection: conn } = entry
    const workspaceId = conn.workspaceId
    const uiWorkspace = workspaceId !== undefined && workspaceId.length > 0
      ? getPluginCtx()?.get('uiWorkspace') as { startSession(workspaceId?: string): void } | undefined
      : undefined
    if (uiWorkspace !== undefined && workspaceId !== undefined) {
      uiWorkspace.startSession(workspaceId)
      return
    }
    openTerminalFor(entry)
  }

  const entries = connectionsStore.getEntries()
  const connLoaded = connectionsStore.isLoaded()
  const connFailed = connectionsStore.isFailed()
  const wizard = wizardStore.getSnapshot()

  // 降级：API 首次拉取失败且无任何数据 → 整节消失（绝不让侧栏白屏）。
  if (connLoaded && connFailed && entries.length === 0) return null

  // 连接中的目标行：向导 flowId 临时行（连接完成即消失，除非暂停等确认步骤）。
  const connectingRow = wizard.connecting
    ? createElement(
      'div',
      {
        key: 'connecting',
        className: css.row,
        ref: (el: HTMLDivElement | null) => {
          if (el !== null) rowRefs.current.set('connecting', el)
        },
        onClick: () => wizardStore.restore(),
        title: '点击恢复向导',
      },
      createElement('span', { className: css.rowIcon }, createElement(CloudIcon)),
      createElement(
        'span',
        { className: css.rowText },
        createElement('span', { className: css.rowTitle }, '正在连接…'),
        createElement('span', { className: css.rowSubtitle }, '远程主机'),
      ),
      createElement('span', { className: css.rowStatus }, createElement('span', { className: css.spinnerSmall })),
      createElement(
        'button',
        {
          type: 'button',
          className: css.rowMenu,
          'aria-label': '连接日志',
          title: '连接日志',
          onClick: (event: { stopPropagation: () => void }) => {
            event.stopPropagation()
            openLog(String(wizard.flowId ?? ''))
          },
        },
        '⋯',
      ),
    )
    : null

  const rows = entries.map((entry: ConnectionEntry) => {
    const { connection: conn, status } = entry
    const subtitle = conn.kind === 'ssh'
      ? `${conn.ssh.user}@${conn.ssh.host}`
      : (conn.remotePath ?? (conn.ssh.host.length > 0 ? conn.ssh.host : '本机 Windows'))
    const online = status.state === 'online'

    return createElement(
      'div',
      {
        key: conn.id,
        className: `${css.row} ${css.rowWithSubtitle} ${online ? css.rowOnline : ''}`,
        ref: (el: HTMLDivElement | null) => {
          if (el !== null) rowRefs.current.set(conn.id, el)
        },
        title: online
          ? (conn.workspaceId !== undefined && conn.workspaceId.length > 0
            ? `${conn.title}（在线，点击打开会话）`
            : `${conn.title}（在线，点击打开终端）`)
          : conn.title,
        onClick: () => {
          if (online) openPrimaryFor(entry)
        },
      },
      createElement('span', { className: css.rowIcon },
        conn.kind === 'win' ? createElement(WindowIcon) : createElement(CloudIcon)),
      createElement(
        'span',
        { className: css.rowText },
        createElement('span', { className: css.rowTitle }, conn.title),
        createElement('span', { className: css.rowSubtitle }, subtitle),
      ),
      createElement(
        'span',
        { className: css.rowStatus, title: status.state },
        status.state === 'checking'
          ? createElement('span', { className: css.spinnerSmall })
          : createElement('span', {
            className: css.statusDot,
            style: { background: statusColor(status.state) },
          }),
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: css.rowMenu,
          'aria-label': `${conn.title} 菜单`,
          'aria-expanded': menuFor === conn.id,
          onClick: (event: { stopPropagation: () => void }) => {
            event.stopPropagation()
            if (menuFor === conn.id) closeMenu()
            else openMenu(conn.id)
          },
        },
        '⋯',
      ),
    )
  })

  // ⋯ 菜单：打开终端 / 重新连接 / 查看日志 / 删除连接
  const menuConnection = menuFor !== null && menuAnchor !== null
    ? entries.find((entry) => entry.connection.id === menuFor) ?? null
    : null
  const menu = menuConnection !== null && menuAnchor !== null
    ? (() => {
      const online = menuConnection.status.state === 'online'
      return createElement(
        'div',
        {
          className: css.menu,
          style: {
            left: `${Math.min(menuAnchor.left + menuAnchor.width - 150, window.innerWidth - 160)}px`,
            top: `${Math.min(menuAnchor.top + menuAnchor.height + 4, window.innerHeight - 170)}px`,
          },
        },
        createElement('button', {
          type: 'button',
          className: css.menuItem,
          disabled: !online,
          onClick: () => {
            closeMenu()
            openTerminalFor(menuConnection)
          },
        }, '打开终端'),
        createElement('button', {
          type: 'button',
          className: css.menuItem,
          onClick: () => {
            closeMenu()
            void recheck(menuConnection)
          },
        }, '重新连接'),
        createElement('button', {
          type: 'button',
          className: css.menuItem,
          onClick: () => {
            closeMenu()
            openLog(menuConnection.connection.id, rowRefs.current.get(menuConnection.connection.id))
          },
        }, '查看日志'),
        createElement('button', {
          type: 'button',
          className: `${css.menuItem} ${css.menuItemDanger}`,
          onClick: () => {
            closeMenu()
            void removeConnection(menuConnection)
          },
        }, '删除连接'),
      )
    })()
    : null

  // 日志浮层：连接中临时行（live）或菜单「查看日志」（connectionId）。
  const logPopover = logKey !== null && logAnchor !== null
    ? createElement(LogPopover, {
      channelKey: logKey,
      live: logKey === String(wizard.flowId) && wizard.connecting,
      anchor: logAnchor,
      onClose: () => setLogKey(null),
    })
    : null

  return createElement(
    'div',
    { className: css.section },
    createElement('div', { className: css.sectionHeader }, '远程'),
    connectingRow,
    rows,
    menu,
    logPopover,
  )

  async function recheck(entry: ConnectionEntry): Promise<void> {
    try {
      const { status } = await api.check(entry.connection.id)
      connectionsStore.applyStatus(entry.connection.id, status)
    } catch {
      // 失败保持现状（WS 状态频道会继续纠偏）。
    }
  }

  async function removeConnection(entry: ConnectionEntry): Promise<void> {
    const ok = window.confirm(`删除连接「${entry.connection.title}」？远端不会受影响，此操作不可撤销。`)
    if (!ok) return
    try {
      await api.removeConnection(entry.connection.id)
      connectionsStore.removeLocal(entry.connection.id)
    } catch {
      window.alert('删除失败，请稍后重试。')
    }
  }
}

/* —— 内联线性图标（云朵=ssh 远程，窗口=WIN）—— */
function CloudIcon() {
  return createElement(
    'svg',
    { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', 'aria-hidden': true },
    createElement('path', {
      d: 'M4.2 12.5a3.2 3.2 0 1 1 .6-6.36 4.4 4.4 0 1 1 8.14 1.86A3.5 3.5 0 0 1 12 12.5Z',
      stroke: 'currentColor',
      strokeWidth: 1.4,
      strokeLinejoin: 'round',
    }),
  )
}

function WindowIcon() {
  return createElement(
    'svg',
    { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', 'aria-hidden': true },
    createElement('path', { d: 'M2.5 3.5h11v9h-11Z', stroke: 'currentColor', strokeWidth: 1.4 }),
    createElement('path', { d: 'M2.5 6h11', stroke: 'currentColor', strokeWidth: 1.4 }),
  )
}
