/**
 * dsh-ssh client 半的三个 HostObservable store（模式照抄 dsh-terminal client/sessions.ts）：
 *
 * - connectionsStore：注册表 + 内存状态（WS status 频道喂增量，行内状态件用）。
 * - wizardStore：连接向导状态机（visible/step/表单/连接中/目录浏览/持久化）。
 * - logsStore：按 key（flowId|connectionId）的日志环形缓冲（向导面板与 section
 *   浮层共用同一 WS log 频道，最小化向导不杀 pipeline，重订阅拿快照+增量）。
 *
 * 另有 wizardVisible（shell.overlay 的 hooks.visible 绑定）与 wizardOccupied
 * （remoteFlow 孔的 hooks.remoteFlow 绑定，SPEC C 节）两个 HostObservable<boolean>。
 */

import { api, wsClient, ApiError } from './api.ts'
import type {
  AliasItem, BrowseEntry, ConnectionEntry, ConnectionRecord, ConnectDraft, EnvironmentInfo,
  LogLine, RemoteEnv, Status, WsInFrame,
} from './api.ts'

/** 插件 client ctx（apply 时捕获；用于惰性取 client 服务如 uiWorkspace）。 */
let pluginCtx: { get(name: string): unknown } | null = null
export function setPluginCtx(ctx: { get(name: string): unknown }): void {
  pluginCtx = ctx
}
export function getPluginCtx(): { get(name: string): unknown } | null {
  return pluginCtx
}

export type WizardKind = 'ssh' | 'win'
export type WizardStep = 1 | 2 | 3 | 4
export type AuthMode = 'password' | 'key'
export type DownloadMethod = 'upload' | 'remote'
export type WinShell = 'powershell' | 'cmd'

/** 日志缓冲区上限（服务端每 key 环形 500 行，客户端同量保底）。 */
const LOG_RING_SIZE = 500

// ── 通用 HostObservable 面 ────────────────────────────────────────────────

export interface HostObservable<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
}

// ── logsStore ──────────────────────────────────────────────────────────────

interface LogsState {
  linesByKey: Record<string, LogLine[]>
}

const logsState: LogsState = { linesByKey: {} }
let logsVersion = 0
const logsListeners = new Set<() => void>()

function logsNotify(): void {
  logsVersion += 1
  for (const listener of [...logsListeners]) listener()
}

export const logsStore = {
  subscribe: (listener: () => void): (() => void) => {
    logsListeners.add(listener)
    return () => { logsListeners.delete(listener) }
  },
  getVersion: (): number => logsVersion,
  /** 读视图：某 key 的日志行（空则空数组，绝不返回 undefined）。 */
  getLogs: (key: string): LogLine[] => logsState.linesByKey[key] ?? [],
  /** 订阅即回快照（WS log-snapshot 帧）。 */
  snapshot: (key: string, lines: LogLine[]): void => {
    logsState.linesByKey[key] = lines.slice(-LOG_RING_SIZE)
    logsNotify()
  },
  /** 增量一行（WS log 帧）。 */
  append: (key: string, line: LogLine): void => {
    const arr = logsState.linesByKey[key] ?? []
    arr.push(line)
    if (arr.length > LOG_RING_SIZE) arr.splice(0, arr.length - LOG_RING_SIZE)
    logsState.linesByKey[key] = arr
    logsNotify()
  },
  /** 新 flowId 起笔：清空该 key 历史（重试场景从零开始）。 */
  clear: (key: string): void => {
    if (logsState.linesByKey[key] === undefined) return
    logsState.linesByKey[key] = []
    logsNotify()
  },
}

// ── connectionsStore ───────────────────────────────────────────────────────

let connEntries: ConnectionEntry[] = []
let connLoaded = false
let connFailed = false
let connVersion = 0
const connListeners = new Set<() => void>()
/** WIN 注册为本地工作区后的行内副标题提示（connId → 文案，4s 后自动消失）。 */
let connHints: Record<string, string> = {}
const connHintTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearHintTimer(connectionId: string): void {
  const timer = connHintTimers.get(connectionId)
  if (timer !== undefined) {
    clearTimeout(timer)
    connHintTimers.delete(connectionId)
  }
}

function connNotify(): void {
  connVersion += 1
  for (const listener of [...connListeners]) listener()
}

export const connectionsStore = {
  subscribe: (listener: () => void): (() => void) => {
    connListeners.add(listener)
    return () => { connListeners.delete(listener) }
  },
  getVersion: (): number => connVersion,
  getEntries: (): ConnectionEntry[] => connEntries,
  isLoaded: (): boolean => connLoaded,
  isFailed: (): boolean => connFailed,
  /** 初始拉取（/api/connections）；失败标记 failed，保留旧列表（插件降级不白屏）。 */
  refresh: async (): Promise<void> => {
    try {
      const { items } = await api.connections()
      connEntries = items
      connLoaded = true
      connFailed = false
    } catch {
      connLoaded = true
      connFailed = true
    }
    connNotify()
  },
  /** WS status 快照（Record<id,Status>），只覆盖已知连接。 */
  applyStatusSnapshot: (items: Record<string, Status>): void => {
    if (connEntries.length === 0) return
    const next = connEntries.map((entry) => {
      const status = items[entry.connection.id]
      return status !== undefined && status !== entry.status
        ? { connection: entry.connection, status }
        : entry
    })
    if (next.some((entry, index) => entry.status !== connEntries[index]?.status)) {
      connEntries = next
      connNotify()
    }
  },
  /** WS status 单条增量。 */
  applyStatus: (connectionId: string, status: Status): void => {
    let changed = false
    connEntries = connEntries.map((entry) => {
      if (entry.connection.id !== connectionId) return entry
      if (entry.status === status) return entry
      changed = true
      return { connection: entry.connection, status }
    })
    if (changed) connNotify()
  },
  /** 持久化完成后本地即时可见（不等下次 refresh）。 */
  upsert: (connection: ConnectionRecord): void => {
    const index = connEntries.findIndex((entry) => entry.connection.id === connection.id)
    if (index >= 0) {
      connEntries = connEntries.map((entry, i) =>
        i === index ? { connection, status: entry.status } : entry)
    } else {
      connEntries = [...connEntries, { connection, status: { state: 'unknown' } }]
    }
    connNotify()
  },
  /** 删除连接后本地移除。 */
  removeLocal: (connectionId: string): void => {
    connEntries = connEntries.filter((entry) => entry.connection.id !== connectionId)
    clearHintTimer(connectionId)
    const nextHints = { ...connHints }
    delete nextHints[connectionId]
    connHints = nextHints
    connNotify()
  },
  /** 行内副标题提示文案（无提示则为 null；M3 WIN 注册结果用）。 */
  getHint: (connectionId: string): string | null => connHints[connectionId] ?? null,
  /** 行内副标题短暂变文案（toast 式，4s 后自动消失，不引新组件）。 */
  setHint: (connectionId: string, text: string): void => {
    clearHintTimer(connectionId)
    connHints = { ...connHints, [connectionId]: text }
    connNotify()
    connHintTimers.set(connectionId, setTimeout(() => {
      connHintTimers.delete(connectionId)
      if (connHints[connectionId] === undefined) return
      const nextHints = { ...connHints }
      delete nextHints[connectionId]
      connHints = nextHints
      connNotify()
    }, 4000))
  },
}

// ── wizardStore ────────────────────────────────────────────────────────────

export interface WizardDraftState {
  /** 选中的别名名（null=不使用别名）。 */
  alias: string | null
  host: string
  port: string
  user: string
  authMode: AuthMode
  password: string
  identityFile: string
  sshBinary: string
  downloadMethod: DownloadMethod
  /** downloadMethod==='remote' 时的下载源地址（远端能访问的 tar URL）。 */
  runtimeUrl: string
}

export interface WizardState {
  visible: boolean
  step: WizardStep
  kind: WizardKind
  env: EnvironmentInfo | null
  envFailed: boolean
  aliases: AliasItem[]
  aliasesFailed: boolean
  /** 当前/最近一次 connect 的 flowId（WS log 频道 key）。 */
  flowId: string | null
  connecting: boolean
  connected: boolean
  failed: boolean
  error: string | null
  draft: WizardDraftState
  winDir: string
  winShell: WinShell
  /** 第 4 步：当前浏览目录（空 = 尚未浏览成功）。 */
  directory: string
  browseParent: string | null
  entries: BrowseEntry[]
  browseFailed: boolean
  title: string
  titleTouched: boolean
  mkdirOpen: boolean
  mkdirName: string
  mkdirBusy: boolean
  mkdirError: string | null
  persisting: boolean
  persistError: string | null
}

function initialDraft(): WizardDraftState {
  return {
    alias: null,
    host: '',
    port: '22',
    user: '',
    authMode: 'password',
    password: '',
    identityFile: '',
    sshBinary: '',
    downloadMethod: 'upload',
    runtimeUrl: '',
  }
}

let wizardState: WizardState = createInitialState()
let wizardVersion = 0
const wizardListeners = new Set<() => void>()
/** 渲染器 owner 的关闭回调（remoteFlow 孔注入；向导 × 时通知撤回 open）。 */
let ownerClose: (() => void) | null = null
/** 连接中日志订阅的退订函数（最小化不杀；向导关闭时释放）。 */
let activeLogUnsub: (() => void) | null = null

function createInitialState(): WizardState {
  return {
    visible: false,
    step: 1,
    kind: 'ssh',
    env: null,
    envFailed: false,
    aliases: [],
    aliasesFailed: false,
    flowId: null,
    connecting: false,
    connected: false,
    failed: false,
    error: null,
    draft: initialDraft(),
    winDir: '',
    winShell: 'powershell',
    directory: '',
    browseParent: null,
    entries: [],
    browseFailed: false,
    title: '',
    titleTouched: false,
    mkdirOpen: false,
    mkdirName: '',
    mkdirBusy: false,
    mkdirError: null,
    persisting: false,
    persistError: null,
  }
}

function wizardNotify(): void {
  wizardVersion += 1
  for (const listener of [...wizardListeners]) listener()
}

function patch(p: Partial<WizardState>): void {
  wizardState = { ...wizardState, ...p }
  wizardNotify()
}

function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}

function newFlowId(): string {
  const c = globalThis.crypto
  if (c !== undefined && typeof c.randomUUID === 'function') return `flow_${c.randomUUID()}`
  return `flow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

/** 目录 basename（兼容 / 与 \ 分隔，Windows 风格路径）。 */
function basenameOf(path: string, fallback: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  if (cleaned.length === 0) return fallback
  const parts = cleaned.split(/[\\/]/)
  return parts[parts.length - 1] ?? fallback
}

/** SSH 家目录猜测（P1 未在 connect 响应给 home；常见布局兜底，失败回退根目录）。 */
function guessHomeDir(os: RemoteEnv['os'], user: string): string {
  if (user === 'root') return '/root'
  if (os === 'macos') return `/Users/${user || 'unknown'}`
  return `/home/${user || 'unknown'}`
}

function clampPort(raw: string): number {
  const port = Number.parseInt(raw, 10)
  if (Number.isNaN(port) || port < 1 || port > 65535) return 22
  return port
}

/** 提交给服务端的 draft（G 节契约形状；密码仅内存传递，服务端即焚）。 */
function buildConnectDraft(): ConnectDraft {
  if (wizardState.kind === 'win') {
    // WIN interop 无需 SSH 凭证（SPEC §3.4）；占位字段待 P1 宽松校验。
    return { kind: 'win', ssh: { host: '', port: 0, user: '', auth: { type: 'password' } } }
  }
  const d = wizardState.draft
  return {
    kind: 'ssh',
    ssh: {
      host: d.host.trim(),
      port: clampPort(d.port),
      user: d.user.trim(),
      auth: d.authMode === 'password'
        ? { type: 'password', password: d.password }
        : { type: 'key', identityFile: d.identityFile.trim() },
      sshBinary: d.sshBinary.trim().length > 0 ? d.sshBinary.trim() : undefined,
      downloadMethod: d.downloadMethod,
      // 远端服务器下载：携带下载源地址（host 侧 runtimeStep 读取 ssh.runtimeUrl）
      runtimeUrl: d.downloadMethod === 'remote' && d.runtimeUrl.trim().length > 0 ? d.runtimeUrl.trim() : undefined,
    },
  }
}

/** 向导重置（保留环境/别名缓存）：菜单再次打开或 × 关闭时。 */
function resetFlow(): void {
  const env = wizardState.env
  const envFailed = wizardState.envFailed
  const aliases = wizardState.aliases
  const aliasesFailed = wizardState.aliasesFailed
  if (activeLogUnsub !== null) {
    activeLogUnsub()
    activeLogUnsub = null
  }
  wizardState = {
    ...createInitialState(),
    env,
    envFailed,
    aliases,
    aliasesFailed,
  }
  wizardNotify()
}

async function loadEnvironment(): Promise<void> {
  if (wizardState.env !== null || wizardState.envFailed) return
  try {
    const env = await api.environment()
    patch({ env, envFailed: false })
  } catch {
    patch({ envFailed: true })
  }
}

async function loadAliases(): Promise<void> {
  if (wizardState.aliases.length > 0 || wizardState.aliasesFailed) return
  try {
    const { items } = await api.aliases()
    patch({ aliases: items, aliasesFailed: false })
  } catch {
    patch({ aliasesFailed: true })
  }
}

/** 目录浏览（向导期用 flowId；注册表期用 connectionId，仅供后续扩展）。 */
async function browseInto(dir: string, flowId?: string, connectionId?: string): Promise<void> {
  patch({ directory: dir, browseFailed: false, browseParent: null, entries: [] })
  try {
    const input = connectionId !== undefined
      ? { connectionId, dir }
      : { flowId: flowId ?? '', dir }
    const result = await api.browse(input)
    const next: Partial<WizardState> = {
      directory: result.dir,
      browseParent: result.parent ?? null,
      entries: result.entries,
      browseFailed: false,
    }
    // 标题默认 = 目录 basename；仅未手动编辑时自动跟随。
    if (!wizardState.titleTouched) next.title = basenameOf(result.dir, '')
    patch(next)
  } catch (e) {
    patch({ browseFailed: true, entries: [] })
    // 目录不可读视为失败（不落 error 主流程，避免误导重试）。
    void e
  }
}

/** 连接主流程（SSH 与 WIN 共用；长请求进度走 WS log channel=flowId）。 */
async function runConnect(): Promise<void> {
  const kind = wizardState.kind
  const flowId = newFlowId()
  if (activeLogUnsub !== null) activeLogUnsub()
  activeLogUnsub = wsClient.subscribeLog(flowId)
  logsStore.clear(flowId)
  patch({
    flowId,
    connecting: true,
    failed: false,
    connected: false,
    error: null,
    persistError: null,
  })
  try {
    const draft = buildConnectDraft()
    const { env } = await api.connect(draft, flowId)
    patch({ connecting: false, connected: true })
    // 目录起点：WIN = 第 2 步输入的 Windows 目录；SSH = 家目录猜测（失败回退根）。
    const start = kind === 'win'
      ? (wizardState.winDir.trim() || '/mnt/c')
      : guessHomeDir(env.os, wizardState.draft.user.trim() || 'unknown')
    await browseInto(start, flowId)
    if (wizardState.browseFailed) await browseInto('/', flowId)
    patch({ step: kind === 'ssh' ? 4 : 3 })
    // 最小化期间成功 → 弹回向导让用户选目录（pipeline 不杀）。
    if (!wizardState.visible) patch({ visible: true })
  } catch (e) {
    patch({ connecting: false, failed: true, error: errorMessage(e) })
    // SSH 停在 Step3（失败态可重试）；WIN 停在 Step2。
  }
}

export const wizardStore = {
  subscribe: (listener: () => void): (() => void) => {
    wizardListeners.add(listener)
    return () => { wizardListeners.delete(listener) }
  },
  getVersion: (): number => wizardVersion,
  getSnapshot: (): WizardState => wizardState,
  getOwnerClose: (): (() => void) | null => ownerClose,
  /** RemoteFlowDriver 注册渲染器 owner 的撤销回调。 */
  setOwnerClose: (fn: (() => void) | null): void => {
    ownerClose = fn
  },

  // ── 可见性（菜单 open ↔ 向导）──
  /** 菜单「远程连接」触发：重置流程并显示向导（懒加载环境/别名）。 */
  open: (): void => {
    if (!wizardState.visible) resetFlow()
    patch({ visible: true, step: 1 })
    void loadEnvironment()
    void loadAliases()
  },
  /** 最小化（连接中步骤的 — 按钮 / owner 撤回 open）：隐藏但保留连接与订阅。 */
  minimize: (): void => {
    if (!wizardState.visible) return
    patch({ visible: false })
  },
  /** 恢复向导（section 连接中临时行点击）。 */
  restore: (): void => {
    patch({ visible: true })
  },
  /** × 关闭：撤 owner open、释放日志订阅、重置流程。 */
  requestClose: (): void => {
    if (activeLogUnsub !== null) {
      activeLogUnsub()
      activeLogUnsub = null
    }
    ownerClose?.()
    patch({ visible: false })
    resetFlow()
  },

  // ── 步骤与表单 ──
  setKind: (kind: WizardKind): void => {
    if (wizardState.kind === kind) return
    patch({ kind, step: 1 })
  },
  next: (): void => {
    // Step1 → Step2；Step2（WIN 提交）→ runConnect；Step3（connected 后）→ Step4。
    const s = wizardState.step
    if (s === 1) patch({ step: 2 })
    else if (s === 2 && wizardState.kind === 'win') void runConnect()
    else if (s === 3 && wizardState.connected) patch({ step: 4 })
  },
  back: (): void => {
    const s = wizardState.step
    if (s === 2) patch({ step: 1 })
    else if (s === 3) patch({ step: 2 })
    else if (s === 4) patch({ step: wizardState.kind === 'ssh' ? 3 : 2 })
  },
  setDraft: (p: Partial<WizardDraftState>): void => {
    patch({ draft: { ...wizardState.draft, ...p } })
  },
  setWinDir: (winDir: string): void => {
    patch({ winDir })
  },
  setWinShell: (winShell: WinShell): void => {
    patch({ winShell })
  },
  /** 别名选中：自动填充主机/端口/用户名/私钥路径/sshBinary。 */
  selectAlias: (name: string): void => {
    const alias = wizardState.aliases.find((item) => item.name === name)
    const draft: Partial<WizardDraftState> = {
      alias: alias?.name ?? null,
      host: alias?.host ?? '',
      port: alias !== undefined ? String(alias.port) : '22',
      user: alias?.user ?? '',
      identityFile: alias?.identityFile ?? '',
      sshBinary: alias?.sshBinary ?? '',
      authMode: alias?.identityFile !== undefined ? 'key' : wizardState.draft.authMode,
    }
    patch({ draft: { ...wizardState.draft, ...draft } })
  },
  /** SSH 表单提交：开始连接。 */
  startConnect: (): void => {
    void runConnect()
  },
  /** Step3 失败态主按钮「重试」。 */
  retry: (): void => {
    void runConnect()
  },

  // ── Step4 目录 ──
  browse: (dir: string): void => {
    void browseInto(dir, wizardState.flowId ?? undefined)
  },
  setTitle: (title: string): void => {
    patch({ title, titleTouched: title.length > 0 })
  },
  openMkdir: (): void => {
    patch({ mkdirOpen: true, mkdirName: '', mkdirError: null })
  },
  closeMkdir: (): void => {
    patch({ mkdirOpen: false, mkdirError: null })
  },
  setMkdirName: (mkdirName: string): void => {
    patch({ mkdirName })
  },
  /** 新建文件夹：browse 侧 mkdir（POST /api/browse {mkdir}），成功后刷新列表。 */
  confirmMkdir: async (): Promise<void> => {
    const name = wizardState.mkdirName.trim()
    if (name.length === 0 || wizardState.flowId === null || wizardState.directory.length === 0) return
    patch({ mkdirBusy: true, mkdirError: null })
    try {
      await api.browse({ flowId: wizardState.flowId, dir: wizardState.directory, mkdir: name })
      patch({ mkdirOpen: false, mkdirName: '' })
      await browseInto(wizardState.directory, wizardState.flowId)
    } catch (e) {
      patch({ mkdirError: errorMessage(e) })
    } finally {
      patch({ mkdirBusy: false })
    }
  },
  /** 完成：持久化 → 注册远端工作区（失败仅 WARN）→ 本地 upsert → 关闭向导。 */
  complete: async (): Promise<void> => {
    if (wizardState.persisting || wizardState.directory.length === 0) return
    const fallbackTitle = basenameOf(wizardState.directory, wizardState.draft.user || 'remote')
    const title = wizardState.title.trim() || fallbackTitle
    patch({ persisting: true, persistError: null })
    try {
      const { connection } = await api.persistConnection(buildConnectDraft(), title, wizardState.directory, wizardState.flowId)
      connectionsStore.upsert(connection)
      // M5：kind 为 ssh|win 都注册为原生工作区（失败只 WARN，不阻断向导完成）
      void api.registerRemoteWorkspace(connection.id).catch((e) => {
        console.warn('[dsh-ssh] 注册远端工作区失败：', errorMessage(e))
      })
      wizardStore.requestClose()
    } catch (e) {
      patch({ persisting: false, persistError: errorMessage(e) })
    }
  },
}

/** shell.overlay 条目绑定的可见性 HostObservable（hooks.visible）。 */
export const wizardVisible: HostObservable<boolean> = {
  getSnapshot: (): boolean => wizardState.visible,
  subscribe: (listener: () => void): (() => void) => {
    wizardListeners.add(listener)
    return () => { wizardListeners.delete(listener) }
  },
}

/** remoteFlow 孔绑定的占用 HostObservable（hooks.remoteFlow，SPEC C 节）。
 *  向导模块活着即为 true（菜单项可见）；插件卸载时注册消失、孔空 → H1 撤 open。 */
export const wizardOccupied: HostObservable<boolean> = {
  getSnapshot: (): boolean => true,
  subscribe: (): (() => void) => () => {},
}

/** WS 帧 → store 桥（index.ts apply 内调用；生命周期归 ctx.effect）。 */
export function initWsBridge(): () => void {
  wsClient.setHandler((frame: WsInFrame) => {
    if (frame.t === 'status') {
      if ('items' in frame && frame.items !== undefined) connectionsStore.applyStatusSnapshot(frame.items)
      if ('connectionId' in frame && frame.connectionId !== undefined) connectionsStore.applyStatus(frame.connectionId, frame.status)
    } else if (frame.t === 'log-snapshot') {
      logsStore.snapshot(frame.key, frame.lines)
    } else if (frame.t === 'log') {
      logsStore.append(frame.key, frame.line)
    }
  })
  const unsubStatus = wsClient.subscribeStatus()
  wsClient.start()
  return () => {
    wsClient.setHandler(null)
    unsubStatus()
    wsClient.dispose()
  }
}