/**
 * StepConnecting —— 向导第 3 步「正在建立连接」（SPEC J 文案逐字，仅 SSH 分支）。
 *
 * 日志面板：标题栏「连接日志」+ 右侧 spinner「正在连接…」；日志行格式
 * `HH:mm:ss [LEVEL] msg`，等宽字体（--dsw-font-markdown-code），时间戳暗、
 * 级别灰、ERROR 红。上一步禁用；连接中主按钮禁用「正在连接…」；失败变
 * 「重试」；成功自动进 Step4（留在本步时主按钮变「下一步 ›」）。
 * 日志订阅与 section 浮层同 key（flowId），最小化不杀 pipeline。
 */

import { createElement, useEffect, useRef } from 'react'
import { logsStore, wizardStore } from '../stores.ts'
import css from './WizardRoot.module.css'

export function StepConnecting() {
  const state = wizardStore.getSnapshot()
  const flowId = state.flowId
  const lines = flowId !== null ? logsStore.getLogs(flowId) : []
  const listRef = useRef<HTMLDivElement | null>(null)

  // 新日志到达自动滚到底（用户查看中可手动回滚，下次新增仍跟随）。
  useEffect(() => {
    const el = listRef.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [lines.length])

  const renderButtons = () => {
    const primary = state.connecting
      ? createElement('button', { type: 'button', className: css.buttonPrimary, disabled: true }, '正在连接…')
      : state.failed
        ? createElement('button', { type: 'button', className: css.buttonPrimary, onClick: () => wizardStore.retry() }, '重试')
        : createElement('button', { type: 'button', className: css.buttonPrimary, onClick: () => wizardStore.next() }, '下一步 ›')
    return createElement(
      'div',
      { className: css.stepFooter },
      createElement('button', { type: 'button', className: css.buttonGhost, disabled: true }, '‹ 上一步'),
      primary,
    )
  }

  return createElement(
    'div',
    { className: css.stepBody },
    createElement('p', { className: css.stepSubtitle }, '正在建立 SSH 连接，你可以在这里查看实时的连接进度。'),

    createElement(
      'div',
      { className: css.logPanel },
      createElement(
        'div',
        { className: css.logHeader },
        createElement('span', { className: css.logTitle }, '连接日志'),
        state.connecting
          ? createElement(
            'span',
            { className: css.logSpinner },
            createElement('span', { className: css.spinner }), '正在连接…',
          )
          : null,
      ),
      createElement(
        'div',
        { className: css.logBody, ref: listRef },
        lines.length === 0
          ? createElement('div', { className: css.logEmpty }, '等待连接日志…')
          : lines.map((line, index) =>
            createElement(
              'div',
              { key: `${line.ts}-${index}`, className: css.logLine },
              createElement('span', { className: css.logTs }, line.ts),
              createElement('span', { className: `${css.logLevel} ${line.level === 'ERROR' ? css.logLevelError : ''}` }, `[${line.level}]`),
              createElement('span', { className: css.logMsg }, line.msg),
            )),
      ),
    ),

    state.failed && state.error !== null
      ? createElement('div', { className: css.logError }, state.error)
      : null,
    renderButtons(),
  )
}