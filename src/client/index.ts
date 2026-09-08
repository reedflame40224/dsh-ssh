/**
 * dsh-ssh 浏览器侧入口：cordis apply 薄壳（M1 起，SPEC C/I/J 节消费侧；M6 集成）。
 *
 * apply 注册三处：
 *  - `ctx.provide('workspaceRowExt', …)`（M6）：原生工作区行远程扩展服务
 *    （云/窗图标、状态点、⋯ 菜单追加项、日志浮层开关）。dsh-ssh 在 profile
 *    bundles 里位于 ui-workspace 之后，消费侧必须**惰性 getter** 每次 render
 *    取；这里 apply 顶部直接 provide（比 setPluginCtx 转发更稳）。
 *  - `sidebar.workspaces.remoteFlow`（single，order 10）：无头 RemoteFlowDriver，
 *    经 register 的 inject 向渲染器提供 hooks.remoteFlow 占用信号（H1 用它决定
 *    「远程连接」菜单项显隐）；driver 同步 owner.open ↔ wizardStore。
 *  - `shell.overlay`（list）：order 60 WizardRoot 向导 modal（visible-store 模式，
 *    hooks.visible 绑定 wizardVisible）；order 62 LogPopoverOverlay 行菜单日志
 *    浮层（hooks.visible 绑定 logPopoverVisible）。
 *
 * 生命周期：WS 常驻客户端（状态+日志桥到 store）随 apply 启停，ctx.effect 回收；
 * 注册表初始拉取（connectionsStore.refresh）随 apply 启动，失败降级为空列表
 * （行装饰自然不命中，绝不让侧栏白屏）。
 *
 * 规范约束：react 等走 shell 冻结模块表（tsdown external）；不 import 任何
 * @deepseek-ai/* 运行时值；样式全令牌化（--dsw-alias-*）。
 */

import { WizardRoot } from './wizard/WizardRoot.ts'
import { RemoteFlowDriver } from './wizard/RemoteFlowDriver.ts'
import { LogPopoverOverlay } from './section/LogPopoverOverlay.ts'
import { createRowExt } from './rowext.ts'
import {
  connectionsStore, initWsBridge, logPopoverStore, logPopoverVisible,
  setPluginCtx, wizardOccupied, wizardStore, wizardVisible,
} from './stores.ts'

export const name = 'dsh-ssh'

/** slots 服务的最小本地面（与 ui-renderer registry 签名对齐，照抄 dsh-terminal）。 */
interface SlotsLike {
  inject(key: string, callback: () => (() => void) | Iterable<() => void>): () => void
  register(options: Record<string, unknown>, component: unknown): () => void
}

interface ClientContextLike {
  slots: SlotsLike
  get(name: string): unknown
  provide(name: string, value?: unknown): () => void
  effect(fn: () => unknown, name?: string): unknown
}

/** 硬依赖 slots 服务（web shell 核心能力，必在）。 */
export const inject = ['slots']

export function apply(ctx: ClientContextLike): void {
  // 捕获 client ctx（rowext.onSelect 惰性取 uiWorkspace 删工作区用）。
  setPluginCtx(ctx)
  // M6：工作区行远程扩展服务（冻结契约实现见 rowext.ts）。
  ctx.provide('workspaceRowExt', createRowExt())
  // 注册表初始拉取（行装饰/状态点的数据源；失败降级空列表不白屏）。
  void connectionsStore.refresh()

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

  // 行菜单「查看日志」浮层：overlay 列表条目（order 62，visible-store 模式；
  // 频道/锚点从 logPopoverStore 读，关闭经 onClose 回 store.close()）。
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'dsh-ssh-log',
    order: 62,
    inject: () => ({
      hooks: { visible: logPopoverVisible },
      onClose: () => logPopoverStore.close(),
    }),
  }, LogPopoverOverlay))

  // WS 常驻：状态频道 → connectionsStore、日志频道 → logsStore；随 apply 回收。
  ctx.effect(() => initWsBridge(), 'dsh-ssh:ws-bridge')
}