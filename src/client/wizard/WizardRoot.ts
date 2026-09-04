/**
 * WizardRoot —— shell.overlay 条目：远程连接向导 modal（SPEC J）。
 *
 * 居中 ~1100px、圆角 var(--dsh-round-side)、背景/边框全 --dsw-alias-* 令牌；
 * 左步骤条（标题「远程连接」）+ 右内容区（右上 ×；连接中步骤加 — 最小化）。
 * 可见性走 visible-store 模式（hooks.visible 绑定 wizardVisible，隐藏渲染 null）。
 * 最小化只隐藏 modal：连接 pipeline 与 WS 日志订阅保留，成功自动弹回选目录。
 * Esc 关闭（连接中时等价最小化）。
 */

import { createElement, useEffect, useSyncExternalStore } from 'react'
import { wizardStore } from '../stores.ts'
import { Stepper } from './Stepper.ts'
import { StepMethod } from './StepMethod.ts'
import { StepConfig } from './StepConfig.ts'
import { StepConnecting } from './StepConnecting.ts'
import { StepDirectory } from './StepDirectory.ts'
import css from './WizardRoot.module.css'

export interface WizardRootProps {
  useVisible: <R>(selector: (value: boolean) => R) => R
  onClose: () => void
}

/** SSH 四步 / WIN 三步（spec J）。 */
const STEPS_SSH = ['选择方式', '填写配置', '连接中', '选择目录']
const STEPS_WIN = ['选择方式', '填写配置', '选择目录']

export function WizardRoot({ useVisible, onClose }: WizardRootProps) {
  const visible = useVisible((value) => value)
  // 状态机版本订阅：任何 store 变更触发本组件（及子树）重渲染。
  useSyncExternalStore(wizardStore.subscribe, wizardStore.getVersion)

  // Esc：连接中 → 最小化（不杀 pipeline）；否则 → 关闭。
  useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      const state = wizardStore.getSnapshot()
      if (state.connecting) wizardStore.minimize()
      else wizardStore.requestClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [visible])

  if (!visible) return null

  const state = wizardStore.getSnapshot()
  const steps = state.kind === 'win' ? STEPS_WIN : STEPS_SSH
  const stepOrdinal = state.kind === 'win' ? (state.step >= 3 ? 3 : state.step) : state.step

  const stepContent = (() => {
    switch (state.step) {
      case 1:
        return createElement(StepMethod, { key: 'step1' })
      case 2:
        return createElement(StepConfig, { key: 'step2' })
      case 3:
        // WIN 的 step3 即选择目录；SSH 的 step3 是连接中。
        return state.kind === 'win'
          ? createElement(StepDirectory, { key: 'step-dir-win' })
          : createElement(StepConnecting, { key: 'step3' })
      case 4:
        return createElement(StepDirectory, { key: 'step4' })
    }
  })()

  return createElement(
    'div',
    { className: css.backdrop, role: 'presentation' },
    createElement(
      'div',
      { className: css.wizard, role: 'dialog', 'aria-label': '远程连接', 'aria-modal': true },
      createElement('div', { className: css.sidebar }, createElement(Stepper, { steps, current: stepOrdinal })),
      createElement(
        'div',
        { className: css.content },
        createElement(
          'div',
          { className: css.topbar },
          state.connecting || state.step === 3
            ? createElement(
              'button',
              {
                type: 'button',
                className: css.topAction,
                title: '最小化（连接不中断）',
                'aria-label': '最小化',
                onClick: () => wizardStore.minimize(),
              },
              '—',
            )
            : null,
          createElement(
            'button',
            {
              type: 'button',
              className: css.topAction,
              title: '关闭',
              'aria-label': '关闭',
              onClick: onClose,
            },
            '×',
          ),
        ),
        stepContent,
      ),
    ),
  )
}