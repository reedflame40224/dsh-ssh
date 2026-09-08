/**
 * LogPopoverOverlay —— shell.overlay 条目：行菜单「查看日志」的日志浮层
 * （SPEC-M6：LogPopover 以 overlay 重挂，废弃 RemoteSection 的局部挂载）。
 *
 * visible-store 模式：hooks.visible 绑定 logPopoverVisible（logPopoverStore.open
 * 拉高 → 渲染；×/Esc/点击外部 → onClose → close 拉低）。锚点/频道从
 * logPopoverStore 读：anchorRect 是 onSelect 传入的点击处视口坐标（点锚）。
 * 追加 logsStore 版本订阅：行日志实时增量（原 RemoteSection 载体已删，overlay
 * 是唯一浮层载体，必须自己驱动重绘）。
 */

import { createElement, useSyncExternalStore } from 'react'
import { logsStore, logPopoverStore } from '../stores.ts'
import { LogPopover } from './LogPopover.ts'

export interface LogPopoverOverlayProps {
  /** 渲染器注入的可见性选择钩子（register 的 hooks.visible 绑定 logPopoverVisible）。 */
  useVisible: <R>(selector: (value: boolean) => R) => R
  onClose: () => void
}

export function LogPopoverOverlay({ useVisible, onClose }: LogPopoverOverlayProps) {
  const visible = useVisible((value) => value)
  // 频道/锚点变更（打开/关闭）驱动重渲染；日志行实时增量同源订阅。
  useSyncExternalStore(logPopoverStore.subscribe, logPopoverStore.getVersion)
  useSyncExternalStore(logsStore.subscribe, logsStore.getVersion)

  if (!visible) return null
  const state = logPopoverStore.getSnapshot()
  if (!state.open || state.channelKey === null || state.anchorRect === null) return null
  return createElement(LogPopover, {
    channelKey: state.channelKey,
    anchor: state.anchorRect,
    onClose,
  })
}