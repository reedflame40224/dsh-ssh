/**
 * StepMethod —— 向导第 1 步「选择连接方式」（SPEC J 文案逐字）。
 *
 * 2×2 卡片：SSH/远程主机、WIN/本机 Windows、WSL/Windows Linux 子系统、Docker/本地容器。
 * 选中=整卡提亮+图标瓦片反白；禁用卡灰化 + tooltip 原因。
 * 禁用依据 environment API：WSL（canWsl=false 或 kind==='wsl' → 当前已在 WSL 中运行）、
 * WIN（canWin=false → 仅当 DSH 运行在 WSL 时可用）、Docker（恒禁用 → 即将推出）。
 */

import { createElement } from 'react'
import { wizardStore } from '../stores.ts'
import type { WizardKind } from '../stores.ts'
import css from './WizardRoot.module.css'

type MethodKey = WizardKind | 'wsl' | 'docker'

interface MethodCard {
  key: MethodKey
  title: string
  subtitle: string
  disabled: boolean
  tooltip?: string
}

export function StepMethod() {
  const state = wizardStore.getSnapshot()
  const env = state.env

  // 环境未加载完成时除 SSH 外全部禁用（保守，避免误导）。
  const canWsl = env !== null && env.canWsl && env.kind !== 'wsl'
  const canWin = env !== null && env.canWin

  const cards: MethodCard[] = [
    { key: 'ssh', title: 'SSH', subtitle: '远程主机', disabled: false },
    {
      key: 'win',
      title: 'WIN',
      subtitle: '本机 Windows',
      disabled: !canWin,
      tooltip: '仅当 DSH 运行在 WSL 时可用',
    },
    {
      key: 'wsl',
      title: 'WSL',
      subtitle: 'Windows Linux 子系统',
      disabled: !canWsl,
      tooltip: '当前已在 WSL 中运行',
    },
    { key: 'docker', title: 'Docker', subtitle: '本地容器', disabled: true, tooltip: '即将推出' },
  ]

  const select = (key: MethodKey): void => {
    if (key === 'ssh' || key === 'win') wizardStore.setKind(key)
  }

  return createElement(
    'div',
    { className: css.stepBody },
    createElement('p', { className: css.stepSubtitle }, '选择进入当前工作区的连接方式，然后继续填写对应的连接配置。'),
    createElement(
      'div',
      { className: css.methodGrid },
      cards.map((card) => {
        const selected = state.kind === card.key
        return createElement(
          'button',
          {
            type: 'button',
            key: card.key,
            className: `${css.methodCard} ${selected ? css.methodCardSelected : ''} ${card.disabled ? css.methodCardDisabled : ''}`,
            disabled: card.disabled,
            title: card.disabled ? card.tooltip : undefined,
            'aria-pressed': selected,
            onClick: () => select(card.key),
          },
          createElement(
            'span',
            { className: `${css.methodTile} ${selected ? css.methodTileSelected : ''}` },
            createElement(MethodIcon, { kind: card.key }),
          ),
          createElement('span', { className: css.methodTitle }, card.title),
          createElement('span', { className: css.methodSubtitle }, card.subtitle),
        )
      }),
    ),
    createElement(
      'div',
      { className: css.stepFooter },
      createElement('button', {
        type: 'button',
        className: css.buttonGhost,
        onClick: () => wizardStore.requestClose(),
      }, '取消'),
      createElement('button', {
        type: 'button',
        className: css.buttonPrimary,
        onClick: () => wizardStore.next(),
      }, '下一步 ›'),
    ),
  )
}

function MethodIcon({ kind }: { kind: MethodKey }) {
  const common = { width: 22, height: 22, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true }
  const paths = (() => {
    switch (kind) {
      case 'ssh':
        // 云朵轮廓（与侧栏线性图标一致的语言）。
        return [
          createElement('path', {
            key: 'cloud',
            d: 'M4.2 12.5a3.2 3.2 0 1 1 .6-6.36 4.4 4.4 0 1 1 8.14 1.86A3.5 3.5 0 0 1 12 12.5Z',
            stroke: 'currentColor',
            strokeWidth: 1.4,
            strokeLinejoin: 'round',
          }),
        ]
      case 'win':
        // 窗口：外框 + 标题栏线。
        return [
          createElement('path', { key: 'w', d: 'M2.5 3.5h11v9h-11Z', stroke: 'currentColor', strokeWidth: 1.4 }),
          createElement('path', { key: 't', d: 'M2.5 6h11', stroke: 'currentColor', strokeWidth: 1.4 }),
        ]
      case 'wsl':
        // 终端提示符：>_。
        return [
          createElement('path', { key: 'p', d: 'M2.5 5 6 8l-3.5 3', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
          createElement('path', { key: 'c', d: 'M7.5 11h6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        ]
      case 'docker':
        // 集装箱：外框 + 中部横条。
        return [
          createElement('path', { key: 'd', d: 'M3 4.5h10v7H3Z', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
          createElement('path', { key: 'm', d: 'M3 8h10', stroke: 'currentColor', strokeWidth: 1.4 }),
        ]
    }
  })()
  return createElement('svg', { className: css.methodIcon, ...common } as Record<string, unknown>, ...paths)
}