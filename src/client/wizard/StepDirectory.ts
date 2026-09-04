/**
 * StepDirectory —— 向导第 4 步「选择目录」（SPEC J 文案逐字）。
 *
 * 面包屑 + 目录列表（仅 dir 可进入，file/link 灰显，点开头隐藏条目灰显
 * 折叠）；「新建文件夹」弹输入名 → browse 侧 mkdir（POST /api/browse{mkdir}）；
 * 标题输入默认 = 当前目录 basename（用户编辑后不自动跟随）。
 * SSH 为第 4 步、WIN 为第 3 步（spec J：WIN 无连接中步骤）。
 */

import { createElement } from 'react'
import type { ChangeEvent } from 'react'
import { wizardStore } from '../stores.ts'
import type { BrowseEntry } from '../api.ts'
import css from './WizardRoot.module.css'

function joinPath(parent: string, name: string): string {
  if (parent === '/' || parent.length === 0) return `/${name}`
  return `${parent}/${name}`
}

/** 面包屑：锚定根，逐段可点击。 */
function crumbs(path: string): Array<{ label: string; path: string }> {
  if (path.length === 0) return []
  const parts = path.split('/').filter((part) => part.length > 0)
  const items: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }]
  let acc = ''
  for (const part of parts) {
    acc += `/${part}`
    items.push({ label: part, path: acc })
  }
  return items
}

function EntryIcon({ type, hidden }: { type: BrowseEntry['type']; hidden: boolean }) {
  const common = { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true }
  const paths = (() => {
    switch (type) {
      case 'dir':
        return [
          createElement('path', {
            key: 'd',
            d: 'M2 4.5h4.2l1.3 1.5H14v7H2Z',
            stroke: hidden ? 'var(--dsw-alias-label-tertiary)' : 'currentColor',
            strokeWidth: 1.3,
            strokeLinejoin: 'round',
          }),
        ]
      case 'file':
        return [
          createElement('path', {
            key: 'f',
            d: 'M4 2.5h5l3 3v8H4Z',
            stroke: 'currentColor',
            strokeWidth: 1.3,
            strokeLinejoin: 'round',
          }),
        ]
      case 'link':
        return [
          createElement('path', {
            key: 'l',
            d: 'M6.2 9.8a3 3 0 0 1 0-4.2l1.6-1.6a3 3 0 0 1 4.2 4.2l-1 1',
            stroke: 'currentColor',
            strokeWidth: 1.3,
            strokeLinecap: 'round',
          }),
          createElement('path', {
            key: 'l2',
            d: 'M9.8 6.2a3 3 0 0 1 0 4.2L8.2 12a3 3 0 0 1-4.2-4.2l1-1',
            stroke: 'currentColor',
            strokeWidth: 1.3,
            strokeLinecap: 'round',
          }),
        ]
    }
  })()
  return createElement('svg', { ...common } as Record<string, unknown>, ...paths)
}

export function StepDirectory() {
  const state = wizardStore.getSnapshot()

  const onEnter = (name: string): void => {
    wizardStore.browse(joinPath(state.directory, name))
  }

  return createElement(
    'div',
    { className: css.stepBody },
    createElement('p', { className: css.stepSubtitle }, '选择远端主机上作为工作区打开的目录。'),

    createElement(
      'div',
      { className: css.directoryPanel },
      createElement(
        'div',
        { className: css.directoryToolbar },
        createElement(
          'nav',
          { className: css.crumbs, 'aria-label': '当前目录' },
          crumbs(state.directory).map((crumb, index) =>
            createElement(
              'button',
              {
                type: 'button',
                key: `${crumb.path}-${index}`,
                className: css.crumb,
                onClick: () => wizardStore.browse(crumb.path),
              },
              crumb.label,
            )),
        ),
        createElement('button', {
          type: 'button',
          className: css.buttonGhost,
          disabled: state.mkdirOpen || state.directory.length === 0,
          onClick: () => wizardStore.openMkdir(),
        }, '新建文件夹'),
      ),

      // 新建文件夹 inline 输入行
      state.mkdirOpen
        ? createElement(
          'div',
          { className: css.mkdirRow },
          createElement('input', {
            className: css.input,
            type: 'text',
            value: state.mkdirName,
            placeholder: '文件夹名称',
            autoFocus: true,
            onChange: (event: ChangeEvent<HTMLInputElement>) => wizardStore.setMkdirName(event.target.value),
          }),
          createElement('button', {
            type: 'button',
            className: css.buttonPrimary,
            disabled: state.mkdirName.trim().length === 0 || state.mkdirBusy,
            onClick: () => void wizardStore.confirmMkdir(),
          }, '创建'),
          createElement('button', {
            type: 'button',
            className: css.buttonGhost,
            disabled: state.mkdirBusy,
            onClick: () => wizardStore.closeMkdir(),
          }, '取消'),
        )
        : null,
      state.mkdirError !== null
        ? createElement('div', { className: css.logError }, state.mkdirError)
        : null,

      state.browseFailed
        ? createElement('div', { className: css.logEmpty }, '目录不可读，请通过面包屑尝试其它目录。')
        : state.entries.length === 0 && state.directory.length > 0
          ? createElement('div', { className: css.logEmpty }, '目录为空')
          : createElement(
            'div',
            { className: css.entryList },
            state.entries.map((entry) => {
              const hidden = entry.name.startsWith('.')
              const clickable = entry.type === 'dir' && !hidden
              return createElement(
                'button',
                {
                  type: 'button',
                  key: entry.name,
                  className: `${css.entryRow} ${clickable ? css.entryRowDir : css.entryRowMuted} ${hidden ? css.entryRowHidden : ''}`,
                  disabled: !clickable,
                  title: clickable ? `进入 ${entry.name}` : undefined,
                  onClick: () => onEnter(entry.name),
                },
                createElement(EntryIcon, { type: entry.type, hidden }),
                createElement('span', { className: css.entryName }, entry.name),
              )
            }),
          ),
    ),

    createElement(
      'label',
      { className: css.field },
      createElement('span', { className: css.fieldLabel }, '标题'),
      createElement('input', {
        className: css.input,
        type: 'text',
        value: state.title,
        placeholder: '默认使用目录名',
        spellCheck: false,
        onChange: (event: ChangeEvent<HTMLInputElement>) => wizardStore.setTitle(event.target.value),
      }),
    ),

    state.persistError !== null
      ? createElement('div', { className: css.logError }, state.persistError)
      : null,

    createElement(
      'div',
      { className: css.stepFooter },
      createElement('button', {
        type: 'button',
        className: css.buttonGhost,
        disabled: state.persisting,
        onClick: () => wizardStore.back(),
      }, '‹ 上一步'),
      createElement('button', {
        type: 'button',
        className: css.buttonPrimary,
        disabled: state.persisting || state.directory.length === 0,
        onClick: () => void wizardStore.complete(),
      }, state.persisting ? '保存中…' : '完成'),
    ),
  )
}