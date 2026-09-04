/**
 * RemoteFlowDriver —— `sidebar.workspaces.remoteFlow` 孔的**无头**占用组件
 * （SPEC C 节）：返回 null，职责是双向同步渲染器 owner 与向导状态机——
 * open=true → 打开向导；open 被撤回（孔空/插件卸载）→ 最小化向导（连接中
 * 不杀 pipeline）。× 关闭时通知 owner 撤回 open（向导模块经 register 的
 * inject 向渲染器提供 hooks.remoteFlow 占用信号，菜单项由此显隐）。
 */

import { useEffect } from 'react'
import { wizardStore } from '../stores.ts'

export interface RemoteFlowDriverProps {
  /** 渲染器 owner share（H1 ui-workspace 孔契约 RemoteFlowOwnerProps）。 */
  open: boolean
  /** 渲染器提供的撤销回调（向导关闭后调用以撤回 open）。 */
  onClose: () => void
}

export function RemoteFlowDriver({ open, onClose }: RemoteFlowDriverProps) {
  // owner.open ↔ 向导可见性：open 拉高 → 打开（重置流程）；撤回 → 最小化。
  useEffect(() => {
    if (open) wizardStore.open()
    else wizardStore.minimize()
  }, [open])

  // 向导 × 关闭时回调渲染器，让 owner 撤回 open（孔空时菜单项随之消失）。
  useEffect(() => {
    wizardStore.setOwnerClose(onClose)
    return () => {
      if (wizardStore.getOwnerClose() === onClose) wizardStore.setOwnerClose(null)
    }
  }, [onClose])

  return null
}