/**
 * HTTP/WS API 路由（与 cordis 无关；由 index.ts 挂到 webServer）。
 *
 * SPEC G 契约逐字：统一前缀 `/__dsh-ssh/`，全部 JSON；
 * 错误响应 `{ok:false, error:string}` + 合适状态码。
 *
 * 硬语义：
 *  - POST /api/connect 是"长请求"：pipeline 归服务端 flowId map，HTTP 中断不杀
 *    pipeline，日志经 LogHub 按 flowId 频道持续流出；
 *  - flowId → 暂存活动连接（内存 map，pipeline 成功后保留 10min）；
 *  - WS /ws：subscribe/unsubscribe + 快照/增量，环形缓冲由 LogHub 持有。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { ConnectionRegistry, ConnectDraft } from './registry.ts'
import type { SshConnector, SshTarget } from './ssh.ts'
import { targetFromDraft, targetFromRecord, maskSecret } from './ssh.ts'
import type { LivenessProbe } from './liveness.ts'
import type { LogHub } from './loghub.ts'
import { detectLocalEnvironment, loadAliases, type AliasItem, type LocalEnvironment } from './env.ts'

export interface WebRoute {
  kind: 'prefix' | 'exact'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

export interface WebUpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

export interface RoutesDeps {
  registry: ConnectionRegistry
  connector: SshConnector
  liveness: LivenessProbe
  loghub: LogHub
  version: string
  /** 可注入（测试覆盖），缺省用 env.ts 的检测。 */
  aliasesLoader?: () => AliasItem[]
  environmentLoader?: () => LocalEnvironment
  /** M2：运行时池（可选；注入后 /api/browse 的连接路径优先走运行时 fs.list）。 */
  pool?: import('./remote-client.ts').RuntimePool
  /** M2：运行时管理器（可选；POST /api/runtime/ensure 依赖）。 */
  runtimeManager?: import('./runtime.ts').RuntimeManager
  /**
   * M5：注册远程工作区处理（connectionId → workspaceRegistry.create(remotePath)）。
   * index.ts 组装时闭包注入（workspaceRegistry 为可选服务，缺省 501）。
   * 返回 {ok, workspaceId?, already?, error?}。
   */
  registerRemoteWorkspace?: (connectionId: string) => Promise<{
    ok: boolean
    workspaceId?: string
    already?: boolean
    error?: string
  }>
}

export interface ApiSurface {
  httpRoutes: WebRoute[]
  wsRoute: WebUpgradeRoute
  dispose: () => void
}

/** flowId 暂存：活动目标 + 探测出的 env + M2 运行时结果 + 过期时间（10min）。 */
interface FlowEntry {
  target: SshTarget
  env?: import('./registry.ts').RemoteEnv
  /** M2：testConnect 内 runtimeStep 的安装结果（createConnection 时落库）。 */
  runtime?: { installed: boolean; version?: string }
  expiresAt: number
}

const FLOW_TTL_MS = 10 * 60_000
const BODY_LIMIT = 1_000_000

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  try {
    if (res.headersSent || res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  } catch {
    /* 客户端已断开：HTTP 中断不杀 pipeline，静默忽略 */
  }
}

function fail(res: ServerResponse, status: number, error: string): void {
  sendJson(res, status, { ok: false, error })
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) as Record<string, unknown> : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createApi(deps: RoutesDeps): ApiSurface {
  const registry = deps.registry
  const connector = deps.connector
  const liveness = deps.liveness
  const loghub = deps.loghub
  const flowEntries = new Map<string, FlowEntry>()

  // M2：connectionId 路径的运行时优先浏览（fs.list；形状与 M1 browse 一致）。
  // 任何异常由调用方捕获回落 ls。
  const runtimeBrowse = async (connId: string, target: SshTarget, dir: string): Promise<import('./ssh.ts').BrowseResult> => {
    const pool = deps.pool
    if (!pool) throw new Error('运行时池未注入')
    const client = await pool.get(connId, target)
    const raw = (await client.call('fs.list', { dir })) as {
      dir?: unknown
      parent?: unknown
      entries?: Array<{ name?: unknown; type?: unknown }>
    }
    const entries = Array.isArray(raw?.entries)
      ? raw.entries
          .filter((e) => e && typeof e.name === 'string' && (e.type === 'dir' || e.type === 'file' || e.type === 'link'))
          .map((e) => ({ name: e.name as string, type: e.type as 'dir' | 'file' | 'link' }))
      : []
    return {
      dir: typeof raw?.dir === 'string' ? raw.dir : dir,
      ...(typeof raw?.parent === 'string' ? { parent: raw.parent } : {}),
      entries,
    }
  }

  // flowId 暂存清理（10min TTL）
  const ttlTimer = setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of flowEntries) {
      if (entry.expiresAt < now) flowEntries.delete(key)
    }
  }, 60_000)
  ttlTimer.unref?.()

  const resolveTarget = (flowId?: string, connectionId?: string): { target?: SshTarget; error?: string } => {
    if (flowId) {
      const entry = flowEntries.get(flowId)
      if (!entry) return { error: '连接已过期，请重新建立连接（flowId 无对应 pipeline）' }
      return { target: entry.target }
    }
    if (connectionId) {
      const record = registry.get(connectionId)
      if (!record) return { error: `连接不存在：${connectionId}` }
      if (record.kind === 'win') {
        // WIN interop：无 ssh，浏览走本地 WSL 侧（/mnt 路径）
        return { target: { kind: 'win', host: '', port: 0, user: '', auth: { type: 'password' } } }
      }
      const target = targetFromRecord(record)
      if (!target) return { error: '该连接不是 SSH 类型，不支持浏览' }
      return { target }
    }
    return { error: '需要 flowId 或 connectionId' }
  }

  // ─── GET /api/health ────────────────────────────────────────────────
  const health = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') { fail(res, 405, 'method not allowed'); return }
    sendJson(res, 200, { ok: true, plugin: 'dsh-ssh', version: deps.version })
  }

  // ─── GET /api/environment ───────────────────────────────────────────
  const environment = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') { fail(res, 405, 'method not allowed'); return }
    const env = (deps.environmentLoader ?? detectLocalEnvironment)()
    sendJson(res, 200, { ok: true, ...env })
  }

  // ─── GET /api/aliases ───────────────────────────────────────────────
  const aliases = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') { fail(res, 405, 'method not allowed'); return }
    const items = (deps.aliasesLoader ?? loadAliases)()
    sendJson(res, 200, { ok: true, items })
  }

  // ─── GET /api/connections ───────────────────────────────────────────
  const connections = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') { fail(res, 405, 'method not allowed'); return }
    const items = registry.list().map((connection) => ({
      connection,
      status: liveness.getStatus(connection.id),
    }))
    sendJson(res, 200, { ok: true, items })
  }

  // ─── POST /api/connect（长请求，pipeline 归 flowId map）────────────
  const connect = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') { fail(res, 405, 'method not allowed'); return }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      fail(res, 400, errorMessage(error))
      return
    }
    const draft = body.draft as ConnectDraft | undefined
    const flowId = body.flowId
    if (typeof flowId !== 'string' || !flowId) { fail(res, 400, '缺少 flowId'); return }
    if (!draft || draft.kind !== 'ssh' || !draft.ssh) { fail(res, 400, 'draft 必须是 ssh 类型且包含 ssh 配置'); return }
    // 字段校验：host/user 非空字符串，port 数字，认证方式合法
    const sshDraft = draft.ssh
    if (typeof sshDraft.host !== 'string' || sshDraft.host.length === 0) { fail(res, 400, 'ssh.host 必填'); return }
    if (typeof sshDraft.user !== 'string' || sshDraft.user.length === 0) { fail(res, 400, 'ssh.user 必填'); return }
    if (sshDraft.port !== undefined && (typeof sshDraft.port !== 'number' || !Number.isFinite(sshDraft.port) || sshDraft.port <= 0)) { fail(res, 400, 'ssh.port 非法'); return }
    if (!sshDraft.auth || (sshDraft.auth.type !== 'key' && sshDraft.auth.type !== 'password')) { fail(res, 400, 'ssh.auth 认证方式非法'); return }
    const secret = draft.ssh.auth.type === 'password' ? draft.ssh.auth.password : undefined

    // pipeline 日志进 flowId 频道（日志在连接器内已 redact，此处对错误消息再兜底）
    const log = (line: { level: 'INFO' | 'WARN' | 'ERROR'; msg: string }): void => {
      loghub.pushLog(flowId, line.level, maskSecret(line.msg, secret))
    }

    try {
      const result = await connector.testConnect(draft, log)
      const target = targetFromDraft(draft)
      flowEntries.set(flowId, {
        target: { ...target, connId: flowId },
        env: result.env,
        // M2：testConnect 内 runtimeStep 有结果则留档，createConnection 时写回注册表
        ...(result.runtime
          ? { runtime: { installed: result.runtime.installed, ...(result.runtime.version ? { version: result.runtime.version } : {}) } }
          : {}),
        expiresAt: Date.now() + FLOW_TTL_MS,
      })
      sendJson(res, 200, { ok: true, env: result.env })
    } catch (error) {
      const message = maskSecret(errorMessage(error), secret)
      loghub.pushLog(flowId, 'ERROR', message)
      sendJson(res, 502, { ok: false, error: message })
    }
  }

  // ─── POST /api/connections（向导第 4 步"完成"）─────────────────────
  const createConnection = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') { fail(res, 405, 'method not allowed'); return }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      fail(res, 400, errorMessage(error))
      return
    }
    const draft = body.draft as ConnectDraft | undefined
    const title = body.title
    const remotePath = body.remotePath
    if (!draft || (draft.kind !== 'ssh' && draft.kind !== 'win')) { fail(res, 400, 'draft.kind 必须为 ssh 或 win'); return }
    if (typeof title !== 'string' || !title) { fail(res, 400, '缺少 title'); return }
    if (typeof remotePath !== 'string' || !remotePath) { fail(res, 400, '缺少 remotePath'); return }
    try {
      const connection = registry.create(draft, title, remotePath)
      // 若同一 flowId 暂存过探测 env，则回填状态（dshSsh 远端默认 shell 依赖它）
      const flowId = body.flowId
      if (typeof flowId === 'string') {
        const entry = flowEntries.get(flowId)
        if (entry?.env) liveness.setEnv(connection.id, entry.env)
        // M2：向导 connect 阶段已安装运行时 → 落库（record 此时刚创建）
        if (entry?.runtime) registry.updateRuntime(connection.id, entry.runtime)
      }
      // 随后内部触发 checkNow（不阻塞响应）
      void liveness.checkNow(connection.id)
      sendJson(res, 200, { ok: true, connection })
    } catch (error) {
      fail(res, 400, errorMessage(error))
    }
  }

  // ─── POST /api/browse（flowId 走暂存活动连接，connectionId 走注册表）──
  const browse = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') { fail(res, 405, 'method not allowed'); return }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      fail(res, 400, errorMessage(error))
      return
    }
    const dir = body.dir
    if (typeof dir !== 'string' || !dir) { fail(res, 400, '缺少 dir'); return }
    const resolved = resolveTarget(
      typeof body.flowId === 'string' ? body.flowId : undefined,
      typeof body.connectionId === 'string' ? body.connectionId : undefined,
    )
    if (!resolved.target) { fail(res, resolved.error?.includes('不存在') ? 404 : 410, resolved.error ?? '目标缺失'); return }
    const target = resolved.target
    try {
      // Step4「新建文件夹」：POST /api/browse 加可选 mkdir 字段
      if (typeof body.mkdir === 'string' && body.mkdir) {
        await connector.mkdir(target, dir, body.mkdir)
      }
      let result: import('./ssh.ts').BrowseResult
      // M2 运行时优先：connectionId 路径下 runtime.installed 且在线 → 先走运行时 fs.list，
      // 任何异常回落 M1 的 ls（log WARN 一次）。flowId 路径保持 ls（向导期不依赖运行时）。
      const connId = typeof body.connectionId === 'string' ? body.connectionId : undefined
      const record = connId ? registry.get(connId) : undefined
      const status = connId ? liveness.getStatus(connId) : undefined
      if (record && record.kind === 'ssh' && record.runtime?.installed === true && status?.state === 'online' && deps.pool) {
        try {
          result = await runtimeBrowse(record.id, target, dir)
        } catch (error) {
          loghub.pushLog(record.id, 'WARN', `运行时浏览失败，回落 ls：${errorMessage(error)}`)
          result = await connector.browse(target, dir)
        }
      } else {
        result = await connector.browse(target, dir)
      }
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      const message = errorMessage(error)
      if (message.startsWith('目录不可读') || message.startsWith('列目录失败')) {
        fail(res, 422, message)
      } else {
        fail(res, 502, message)
      }
    }
  }

  // ─── POST /api/check（同步等结果）──────────────────────────────────
  const check = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') { fail(res, 405, 'method not allowed'); return }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      fail(res, 400, errorMessage(error))
      return
    }
    const connectionId = body.connectionId
    if (typeof connectionId !== 'string' || !connectionId) { fail(res, 400, '缺少 connectionId'); return }
    const status = await liveness.checkNow(connectionId)
    if (!status) { fail(res, 404, `连接不存在：${connectionId}`); return }
    sendJson(res, 200, { ok: true, status })
  }

  // ─── POST /api/disconnect（关 mux、置 unknown）─────────────────────
  const disconnect = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') { fail(res, 405, 'method not allowed'); return }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      fail(res, 400, errorMessage(error))
      return
    }
    const connectionId = body.connectionId
    if (typeof connectionId !== 'string' || !connectionId) { fail(res, 400, '缺少 connectionId'); return }
    const record = registry.get(connectionId)
    if (!record) { fail(res, 404, `连接不存在：${connectionId}`); return }
    const target = targetFromRecord(record)
    try {
      deps.pool?.drop(connectionId)
      await connector.close(connectionId, target)
    } catch {
      /* mux 已死，忽略 */
    }
    liveness.setStatus(connectionId, { state: 'unknown' })
    sendJson(res, 200, { ok: true })
  }

  // ─── DELETE /api/connections ───────────────────────────────────────
  const deleteConnection = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'DELETE') { fail(res, 405, 'method not allowed'); return }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      fail(res, 400, errorMessage(error))
      return
    }
    const connectionId = body.connectionId
    if (typeof connectionId !== 'string' || !connectionId) { fail(res, 400, '缺少 connectionId'); return }
    const record = registry.get(connectionId)
    if (!record) { fail(res, 404, `连接不存在：${connectionId}`); return }
    const target = targetFromRecord(record)
    try {
      deps.pool?.drop(connectionId)
      await connector.close(connectionId, target)
    } catch {
      /* 忽略 */
    }
    registry.remove(connectionId)
    liveness.setStatus(connectionId, { state: 'unknown' })
    sendJson(res, 200, { ok: true })
  }

  // ─── GET /api/targets（dsh-terminal client 直取）──────────────────
  const targets = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET') { fail(res, 405, 'method not allowed'); return }
    const items = registry.list().map((connection) => ({
      connectionId: connection.id,
      title: connection.title,
      kind: connection.kind,
      online: liveness.getStatus(connection.id).state === 'online',
      ...(connection.remotePath ? { remotePath: connection.remotePath } : {}),
      // M2：前瞻性 runtime 字段（dsh-terminal 暂不消费）
      ...(connection.runtime?.installed
        ? { runtime: { installed: true, ...(connection.runtime.version ? { version: connection.runtime.version } : {}) } }
        : {}),
    }))
    sendJson(res, 200, { ok: true, items })
  }

  // ─── POST /api/runtime/ensure（section 行菜单"重新连接/修复运行时"未来用；M2 只实现路由）──
  const runtimeEnsure = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') { fail(res, 405, 'method not allowed'); return }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      fail(res, 400, errorMessage(error))
      return
    }
    const connectionId = body.connectionId
    if (typeof connectionId !== 'string' || !connectionId) { fail(res, 400, '缺少 connectionId'); return }
    const record = registry.get(connectionId)
    if (!record) { fail(res, 404, `连接不存在：${connectionId}`); return }
    if (record.kind !== 'ssh' || !record.ssh) { fail(res, 400, '该连接不是 SSH 类型，不支持运行时安装'); return }
    if (!deps.runtimeManager) { fail(res, 501, '运行时管理器未注入'); return }
    const target = targetFromRecord(record)
    if (!target) { fail(res, 400, '该连接不是 SSH 类型，不支持运行时安装'); return }
    // 日志进 connectionId 频道（section 行的"查看日志"可订阅）
    const log = (line: { level: 'INFO' | 'WARN' | 'ERROR'; msg: string }): void => {
      loghub.pushLog(connectionId, line.level, line.msg)
    }
    try {
      const result = await deps.runtimeManager.ensure(target, {
        method: record.ssh.downloadMethod ?? 'upload',
        remoteUrl: record.ssh.runtimeUrl,
      }, log)
      if (!result) {
        // 平台跳过 / 探测失败：不算安装成功，也不污损原有记录
        sendJson(res, 200, { ok: true, installed: false })
        return
      }
      registry.updateRuntime(connectionId, { installed: result.installed, version: result.version })
      sendJson(res, 200, { ok: true, installed: result.installed, ...(result.version ? { version: result.version } : {}) })
    } catch (error) {
      sendJson(res, 502, { ok: false, error: errorMessage(error) })
    }
  }


  // ─── POST /api/register-remote-workspace（M5 契约 D）─────────────────
  const registerRemoteWorkspace = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') { fail(res, 405, 'method not allowed'); return }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody(req)
    } catch (error) {
      fail(res, 400, errorMessage(error))
      return
    }
    const connectionId = body.connectionId
    if (typeof connectionId !== 'string' || !connectionId) { fail(res, 400, '缺少 connectionId'); return }
    if (!deps.registerRemoteWorkspace) { fail(res, 501, '工作区注册服务未注入'); return }
    try {
      const result = await deps.registerRemoteWorkspace(connectionId)
      if (result.ok !== true) { fail(res, 400, result.error ?? '注册失败'); return }
      sendJson(res, 200, {
        ok: true,
        ...(result.workspaceId !== undefined && result.workspaceId.length > 0 ? { workspaceId: result.workspaceId } : {}),
        ...(result.already === true ? { already: true } : {}),
      })
    } catch (error) {
      fail(res, 502, errorMessage(error))
    }
  }

  const httpRoutes: WebRoute[] = [
    { kind: 'exact', path: '/__dsh-ssh/api/health', handler: health },
    { kind: 'exact', path: '/__dsh-ssh/api/environment', handler: environment },
    { kind: 'exact', path: '/__dsh-ssh/api/aliases', handler: aliases },
    { kind: 'exact', path: '/__dsh-ssh/api/connections', handler: (req, res) => {
      if (req.method === 'GET') return connections(req, res)
      if (req.method === 'POST') return createConnection(req, res)
      if (req.method === 'DELETE') return deleteConnection(req, res)
      fail(res, 405, 'method not allowed')
    } },
    { kind: 'exact', path: '/__dsh-ssh/api/connect', handler: connect },
    { kind: 'exact', path: '/__dsh-ssh/api/browse', handler: browse },
    { kind: 'exact', path: '/__dsh-ssh/api/check', handler: check },
    { kind: 'exact', path: '/__dsh-ssh/api/disconnect', handler: disconnect },
    { kind: 'exact', path: '/__dsh-ssh/api/targets', handler: targets },
    { kind: 'exact', path: '/__dsh-ssh/api/runtime/ensure', handler: runtimeEnsure },
    { kind: 'exact', path: '/__dsh-ssh/api/register-remote-workspace', handler: registerRemoteWorkspace },
  ]

  const wsRoute: WebUpgradeRoute = {
    path: '/__dsh-ssh/ws',
    handler: (req, socket, head) => loghub.handleUpgrade(req, socket, head),
  }

  return {
    httpRoutes,
    wsRoute,
    dispose: () => {
      clearInterval(ttlTimer)
      flowEntries.clear()
    },
  }
}
