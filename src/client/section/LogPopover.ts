/**
 * LogPopover —— 锚定行右侧浮出的连接日志卡片（SPEC J）。
 *
 * 与向导 StepConnecting 订阅**同一 WS key**（flowId|connectionId）：
 * 挂载即订阅（引用计数去重）、卸载即退订；重订阅拿快照+增量。标题栏
 * 「连接日志」，`live` 时右侧显示 spinner「正在连接…」。fixed 定位锚定
 * 点击处/行的视口矩形，滚动/窗口变化由调用方（LogPopoverOverlay）负责关闭。
 */

import { createElement, useEffect, useRef } from 'react'
import { logsStore } from '../stores.ts'
import { wsClient } from '../api.ts'
import css from './LogPopover.module.css'

export interface LogPopoverProps {
  /** 日志频道 key（flowId=连接中 / connectionId=注册表行）。 */
  channelKey: string
  /** 连接中实时态：标题栏右侧 spinner「正在连接…」。 */
  live?: boolean
  /** 锚定行的视口矩形（fixed 定位参考）。 */
  anchor: DOMRect
  onClose: () => void
}

export function LogPopover({ channelKey, live, anchor, onClose }: LogPopoverProps) {
  const lines = logsStore.getLogs(channelKey)
  const listRef = useRef<HTMLDivElement | null>(null)

  // 订阅该频道（同 key 与向导浮层共享服务端流，引用计数去重）。
  useEffect(() => {
    const unsub = wsClient.subscribeLog(channelKey)
    return unsub
  }, [channelKey])

  // 点击外部 / Esc 关闭。
  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (listRef.current?.contains(target) === true) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose])

  // 新日志自动滚到底。
  useEffect(() => {
    const el = listRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [lines.length])

  const left = Math.min(anchor.left + anchor.width + 8, window.innerWidth - 336)
  const top = Math.min(Math.max(anchor.top, 8), Math.max(8, window.innerHeight - 300))

  return createElement(
    'div',
    {
      className: css.logPopover,
      ref: listRef,
      style: { left: `${left}px`, top: `${top}px` },
    },
    createElement(
      'div',
      { className: css.logPopoverHeader },
      createElement('span', { className: css.logPopoverTitle }, '连接日志'),
      live === true
        ? createElement(
          'span',
          { className: css.logPopoverLive },
          createElement('span', { className: css.spinnerSmall }), '正在连接…',
        )
        : null,
    ),
    createElement(
      'div',
      { className: css.logPopoverBody },
      lines.length === 0
        ? createElement('div', { className: css.logPopoverEmpty }, '暂无日志')
        : lines.map((line, index) =>
          createElement(
            'div',
            { key: `${line.ts}-${index}`, className: css.logPopoverLine },
            createElement('span', { className: css.logPopoverTs }, line.ts),
            createElement(
              'span',
              { className: `${css.logPopoverLevel} ${line.level === 'ERROR' ? css.logPopoverLevelError : ''}` },
              `[${line.level}]`,
            ),
            createElement('span', { className: css.logPopoverMsg }, line.msg),
          )),
    ),
  )
}