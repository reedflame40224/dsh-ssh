/**
 * dsh-ssh 浏览器侧入口：cordis apply 薄壳（M1，SPEC C/I/J 节消费侧）。
 *
 * 注册三处槽位（写法照抄 dsh-terminal client/index.ts 的 slots.inject 模式）：
 *  - `sidebar.workspaces.remoteFlow`（single，order 10）：无头 RemoteFlowDriver，
 *    经 register 的 inject 向渲染器提供 hooks.remoteFlow 占用信号（H1 用它决定
 *    「远程连接」菜单项显隐）；driver 同步 owner.open ↔ wizardStore。
 *  - `shell.overlay`（list，order 60）：WizardRoot 向导 modal，visible-store
 *    模式（hooks.visible 绑定 wizardVisible），根元素 pointer-events:auto。
 *  - `sidebar.workspaces.sections`（list，order 10，label「远程」）：RemoteSection
 *    远程工作区行。
 *
 * 生命周期：WS 常驻客户端（状态+日志桥到 store）随 apply 启停，ctx.effect 回收；
 * 插件 API 不可用/404 时 section 降级为空（见 RemoteSection），绝不让侧栏白屏。
 *
 * 规范约束：react 等走 shell 冻结模块表（tsdown external）；不 import 任何
 * @deepseek-ai/* 运行时值；样式全令牌化（--dsw-alias-*）。
 */

import { WizardRoot } from './wizard/WizardRoot.ts'
import { RemoteFlowDriver } from './wizard/RemoteFlowDriver.ts'
import { RemoteSection } from './section/RemoteSection.ts'
import { initWsBridge, setPluginCtx, wizardOccupied, wizardStore, wizardVisible } from './stores.ts'

export const name = 'dsh-ssh'

/** slots 服务的最小本地面（与 ui-renderer registry 签名对齐，照抄 dsh-terminal）。 */
interface SlotsLike {
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

interface ClientContextLike {
  slots: SlotsLike
  get(name: string): unknown
  effect(fn: () => unknown, name?: string): unknown
}

/** 硬依赖 slots 服务（web shell 核心能力，必在）。 */
export const inject = ['slots']

export function apply(ctx: ClientContextLike): void {
  // 捕获 client ctx（RemoteSection 行点击惰性取 uiWorkspace 开会话用）。
  setPluginCtx(ctx)
  // 「添加工作区 → 远程连接」孔（H1 渲染器绑定 hooks.remoteFlow 决定菜单项显隐）。
  ctx.slots.inject('sidebar.workspaces.remoteFlow', () => ctx.slots.register({
    name: 'sidebar.workspaces.remoteFlow',
    id: 'dsh-ssh',
    order: 10,
    inject: () => ({ hooks: { remoteFlow: wizardOccupied } }),
  }, RemoteFlowDriver))

  // 向导本体：overlay 列表条目（order 60，visible-store 模式）。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-ssh-wizard',
    order: 60,
    inject: () => ({
      hooks: { visible: wizardVisible },
      onClose: () => wizardStore.requestClose(),
    }),
  }, WizardRoot))

  // 远程工作区 section（工作区分组下方；owner props = { wide: boolean }）。
  ctx.slots.inject('sidebar.workspaces.sections', () => ctx.slots.register({
    name: 'sidebar.workspaces.sections',
    id: 'dsh-ssh',
    order: 10,
    label: '远程',
  }, RemoteSection))

  // WS 常驻：状态频道 → connectionsStore、日志频道 → logsStore；随 apply 回收。
  ctx.effect(() => initWsBridge(), 'dsh-ssh:ws-bridge')
}