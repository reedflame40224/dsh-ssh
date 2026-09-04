/**
 * Stepper —— 向导左侧步骤条（SPEC J）。
 *
 * 标题「远程连接」；步骤：当前=实心圆+行高亮、完成=绿勾、未到=灰圆。
 * WIN 分支三步（spec J：选择方式/填写配置/选择目录）。
 */

import { createElement } from 'react'
import css from './WizardRoot.module.css'

export interface StepperProps {
  steps: string[]
  current: number
}

/** 完成态的绿勾（内联 SVG，stroke 取 success 语义令牌）。 */
function CheckIcon(): ReturnType<typeof createElement> {
  return createElement(
    'svg',
    { className: css.checkIcon, viewBox: '0 0 12 12', width: 12, height: 12, fill: 'none', 'aria-hidden': true },
    createElement('path', {
      d: 'M2.5 6.2 5 8.7l4.5-5.4',
      stroke: 'currentColor',
      strokeWidth: 1.8,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
  )
}

export function Stepper({ steps, current }: StepperProps) {
  return createElement(
    'div',
    { className: css.stepper },
    createElement('div', { className: css.stepperTitle }, '远程连接'),
    createElement(
      'ol',
      { className: css.steps },
      steps.map((label, index) => {
        const ordinal = index + 1
        const done = ordinal < current
        const active = ordinal === current
        return createElement(
          'li',
          {
            key: label,
            className: `${css.step} ${active ? css.stepActive : ''}`,
            'aria-current': active ? 'step' : undefined,
          },
          createElement(
            'span',
            { className: `${css.stepDot} ${done ? css.stepDotDone : ''} ${active ? css.stepDotActive : ''}` },
            done ? createElement(CheckIcon) : String(ordinal),
          ),
          createElement('span', { className: css.stepLabel }, label),
        )
      }),
    ),
  )
}