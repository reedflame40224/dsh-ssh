/**
 * StepConfig —— 向导第 2 步「填写连接配置」（SPEC J 文案逐字冻结）。
 *
 * SSH 分支：别名下拉（自动填充）+ 主机/端口 + 用户名/认证方式 segmented
 * （密码|私钥）+ 密码/私钥路径 + 资源下载方式 segmented + 说明文案；
 * 「开始连接」在主机+用户名+凭证齐备时可用。
 * WIN 分支：Windows 目录输入 + 终端 shell segmented（PowerShell|cmd），
 * 提交即 connect（无连接中步骤，成功直接进选择目录）。
 */

import { createElement } from 'react'
import type { ChangeEvent } from 'react'
import { wizardStore } from '../stores.ts'
import type { AuthMode, DownloadMethod, WinShell } from '../stores.ts'
import css from './WizardRoot.module.css'

function Segmented<T extends string>({ value, options, onChange }: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return createElement(
    'div',
    { className: css.segmented, role: 'radiogroup' },
    options.map((option) =>
      createElement('button', {
        type: 'button',
        key: option.value,
        className: `${css.segment} ${value === option.value ? css.segmentActive : ''}`,
        role: 'radio',
        'aria-checked': value === option.value,
        onClick: () => onChange(option.value),
      }, option.label)),
  )
}

const DOWNLOAD_OPTIONS: Array<{ value: DownloadMethod; label: string }> = [
  { value: 'upload', label: '本地下载后上传' },
  { value: 'remote', label: '远端服务器下载' },
]

const SHELL_OPTIONS: Array<{ value: WinShell; label: string }> = [
  { value: 'powershell', label: 'PowerShell' },
  { value: 'cmd', label: 'cmd' },
]

export function StepConfig() {
  const state = wizardStore.getSnapshot()
  const { kind, draft, winDir, winShell } = state

  if (kind === 'win') return renderWin()

  const credsReady = draft.authMode === 'password'
    ? draft.password.length > 0
    : draft.identityFile.trim().length > 0
  const canStart = draft.host.trim().length > 0 && draft.user.trim().length > 0 && credsReady
    && (draft.downloadMethod !== 'remote' || draft.runtimeUrl.trim().length > 0)
  const connected = state.connected

  return createElement(
    'div',
    { className: css.stepBody },
    createElement('p', { className: css.stepSubtitle }, '填写建立 SSH 连接所需的信息，我们会据此准备远程会话。'),

    // 别名下拉
    createElement(
      'label',
      { className: css.field },
      createElement('span', { className: css.fieldLabel }, 'SSH 配置别名（可选）'),
      createElement(
        'select',
        {
          className: css.input,
          value: draft.alias ?? '',
          onChange: (event: ChangeEvent<HTMLSelectElement>) => wizardStore.selectAlias(event.target.value),
        },
        createElement('option', { key: '', value: '' }, '不使用别名'),
        ...state.aliases.map((alias) =>
          createElement('option', { key: alias.name, value: alias.name }, alias.name)),
      ),
      createElement('span', { className: css.fieldHint }, '选择别名后会自动填充主机、端口、用户名和私钥路径。'),
    ),

    // 主机 + 端口
    createElement(
      'div',
      { className: css.fieldRow },
      createElement(
        'label',
        { className: css.field },
        createElement('span', { className: css.fieldLabel }, '主机'),
        createElement('input', {
          className: css.input,
          type: 'text',
          value: draft.host,
          placeholder: '输入主机地址或 IP，例如 192.168.1.100',
          spellCheck: false,
          onChange: (event: ChangeEvent<HTMLInputElement>) => wizardStore.setDraft({ host: event.target.value }),
        }),
      ),
      createElement(
        'label',
        { className: `${css.field} ${css.fieldNarrow}` },
        createElement('span', { className: css.fieldLabel }, '端口'),
        createElement('input', {
          className: css.input,
          type: 'text',
          inputMode: 'numeric',
          value: draft.port,
          placeholder: '22',
          onChange: (event: ChangeEvent<HTMLInputElement>) => wizardStore.setDraft({ port: event.target.value }),
        }),
      ),
    ),

    // 用户名 + 认证方式
    createElement(
      'div',
      { className: css.fieldRow },
      createElement(
        'label',
        { className: css.field },
        createElement('span', { className: css.fieldLabel }, '用户名'),
        createElement('input', {
          className: css.input,
          type: 'text',
          value: draft.user,
          placeholder: '输入用户名，例如 root',
          spellCheck: false,
          onChange: (event: ChangeEvent<HTMLInputElement>) => wizardStore.setDraft({ user: event.target.value }),
        }),
      ),
      createElement(
        'label',
        { className: `${css.field} ${css.fieldNarrow}` },
        createElement('span', { className: css.fieldLabel }, '认证方式'),
        createElement(Segmented<AuthMode>, {
          value: draft.authMode,
          options: [
            { value: 'password', label: '密码' },
            { value: 'key', label: '私钥' },
          ],
          onChange: (authMode: AuthMode) => wizardStore.setDraft({ authMode }),
        }),
      ),
    ),

    // 凭证输入
    draft.authMode === 'password'
      ? renderField(
        '密码',
        createElement('input', {
          className: css.input,
          type: 'password',
          value: draft.password,
          placeholder: '输入 SSH 密码',
          autoComplete: 'off',
          onChange: (event: ChangeEvent<HTMLInputElement>) => wizardStore.setDraft({ password: event.target.value }),
        }),
      )
      : renderField(
        '私钥路径',
        createElement('input', {
          className: css.input,
          type: 'text',
          value: draft.identityFile,
          placeholder: '例如 ~/.ssh/id_ed25519',
          spellCheck: false,
          onChange: (event: ChangeEvent<HTMLInputElement>) => wizardStore.setDraft({ identityFile: event.target.value }),
        }),
      ),

    // 资源下载方式
    createElement(
      'label',
      { className: css.field },
      createElement('span', { className: css.fieldLabel }, '资源下载方式'),
      createElement(Segmented<DownloadMethod>, {
        value: draft.downloadMethod,
        options: DOWNLOAD_OPTIONS,
        onChange: (downloadMethod: DownloadMethod) => wizardStore.setDraft({ downloadMethod }),
      }),
      createElement('span', { className: css.fieldHint }, '远端服务器下载可减少上传等待，但服务器需要能访问下载源，并具备下载、解压和校验工具。'),
    ),

    // 远端服务器下载：下载源地址（选择 remote 时才需要）
    draft.downloadMethod === 'remote'
      ? renderField(
        '下载源地址',
        createElement('input', {
          className: css.input,
          type: 'text',
          value: draft.runtimeUrl,
          placeholder: 'https://…/dsh-remote-<版本>-linux-x64.with-node.tar.gz',
          spellCheck: false,
          onChange: (event: ChangeEvent<HTMLInputElement>) => wizardStore.setDraft({ runtimeUrl: event.target.value }),
        }),
        '远端主机将用 curl/wget 从此地址拉取运行时包；请确保远端网络可达且具备 tar 与 sha256sum。',
      )
      : null,

    createElement(
      'div',
      { className: css.stepFooter },
      createElement('button', {
        type: 'button',
        className: css.buttonGhost,
        onClick: () => wizardStore.back(),
      }, '‹ 上一步'),
      createElement('button', {
        type: 'button',
        className: css.buttonPrimary,
        disabled: !canStart || connected,
        title: connected ? '连接已完成' : undefined,
        onClick: () => wizardStore.startConnect(),
      }, '开始连接'),
    ),
  )

  function renderWin() {
    const canNext = winDir.trim().length > 0 && !state.connecting
    return createElement(
      'div',
      { className: css.stepBody },
      createElement('p', { className: css.stepSubtitle }, '填写建立 SSH 连接所需的信息，我们会据此准备远程会话。'),
      renderField(
        'Windows 目录',
        createElement('input', {
          className: css.input,
          type: 'text',
          value: winDir,
          placeholder: '例如 E:\\PWN 或 /mnt/e/PWN',
          spellCheck: false,
          onChange: (event: ChangeEvent<HTMLInputElement>) => wizardStore.setWinDir(event.target.value),
        }),
      ),
      renderField(
        '终端 shell',
        createElement(Segmented<WinShell>, {
          value: winShell,
          options: SHELL_OPTIONS,
          onChange: (winShell: WinShell) => wizardStore.setWinShell(winShell),
        }),
      ),
      state.connecting
        ? createElement('div', { className: css.inlineError }, '正在连接…')
        : null,
      createElement(
        'div',
        { className: css.stepFooter },
        createElement('button', {
          type: 'button',
          className: css.buttonGhost,
          onClick: () => wizardStore.back(),
        }, '‹ 上一步'),
        createElement('button', {
          type: 'button',
          className: css.buttonPrimary,
          disabled: !canNext,
          onClick: () => wizardStore.next(),
        }, '下一步 ›'),
      ),
    )
  }

  function renderField(label: string, control: ReturnType<typeof createElement>, hint?: string) {
    return createElement(
      'label',
      { className: css.field },
      createElement('span', { className: css.fieldLabel }, label),
      control,
      hint !== undefined ? createElement('span', { className: css.fieldHint }, hint) : null,
    )
  }
}