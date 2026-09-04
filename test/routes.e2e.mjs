/**
 * dsh-ssh 离线 e2e：HTTP/WS API（起本地 http server 挂 createApi 的全部路由）。
 *
 * 场景：health / environment / aliases / connect（假连接器 + flowId 日志流）/
 * brows（flowId 与 connectionId 两路）/ check / disconnect / delete / targets / WS
 * （status 快照+增量、log 快照+增量、HTTP 中断不杀 pipeline）。
 *
 * 纯 node 运行：`node test/routes.e2e.mjs`；退出码 0/非 0 表成败。
 */

import http from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { ConnectionRegistry } from '../src/registry.ts'
import { SshConnector } from '../src/ssh.ts'
import { LivenessProbe } from '../src/liveness.ts'
import { LogHub } from '../src/loghub.ts'
import { createApi } from '../src/routes.ts'
import { createDshSshService } from '../src/service.ts'

const fail = (reason) => {
  console.error('[routes] FAIL:', reason)
  process.exit(1)
}
const guard = (condition, label) => {
  if (!condition) fail(label)
  console.log(`[routes] ok: ${label}`)
}

const base = mkdtempSync(join(tmpdir(), 'dsh-ssh-routes-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── 假 ssh 脚本：按远程命令输出；让真实 SshConnector 走通整条链路 ─────
const fakeScriptPath = join(base, 'fake-ssh.sh')
// 该脚本在测试进程中直接生成（由 routes e2e 自己编写，而非 spawnFn）
const fakeBody = [
  '#!/bin/sh',
  'case "$*" in',
  '  *10.0.0.1*) sleep 1.5 ;;',
  'esac',
  'CMD=""',
  'PREV=""',
  'OP=""',
  'for a in "$@"; do',
  '  if [ "$PREV" = "-O" ]; then OP="$a"; fi',
  '  PREV="$a"; CMD="$a"',
  'done',
  'if [ "$OP" = "check" ]; then echo "Master running (pid=1)"; exit 0; fi',
  'if [ "$OP" = "exit" ]; then exit 0; fi',
  'case "$CMD" in',
  '  *__DSH_SSH_OK__*) echo "__DSH_SSH_OK__"; echo "Linux x86_64"; exit 0 ;;',
  '  *command\\ -v*) echo "/usr/bin/zsh"; echo "/usr/bin/bash"; echo "/bin/sh"; echo "NODE:v22.16.0"; echo "LOGIN:/usr/bin/zsh"; exit 0 ;;',
  '  *true*) exit 0 ;;',
  '  *ls\\ -1Ap*) printf "etc/\\nopt/\\nroot.txt\\nbin@\\nrun*\\n.custom/\\n"; exit 0 ;;',
  '  *mkdir\\ -p*) exit 0 ;;',
  '  *) echo "unhandled:$CMD" >&2; exit 9 ;;',
  'esac',
].join('\n')
const { writeFileSync, chmodSync } = await import('node:fs')
writeFileSync(fakeScriptPath, fakeBody + '\n')
chmodSync(fakeScriptPath, 0o755)

const registry = new ConnectionRegistry({ baseDir: join(base, 'data') })
registry.load()
const connector = new SshConnector({
  muxDir: join(base, 'mux'),
  askpassDir: join(base, 'askpass'),
  defaultSshBinary: fakeScriptPath,
})
const loghub = new LogHub({ bufferSize: 500, pingIntervalMs: 5_000, getStatuses: () => probe.getStatuses() })
const probe = new LivenessProbe({ registry, connector, onStatus: (id, st) => loghub.pushStatus(id, st) })
const api = createApi({ registry, connector, liveness: probe, loghub, version: 'test-1.2.3' })
const dshSsh = createDshSshService({ registry, connector, liveness: probe })

const server = http.createServer((req, res) => {
  const pathname = (req.url ?? '').split('?')[0]
  for (const route of api.httpRoutes) {
    const match = route.kind === 'exact' ? pathname === route.path : pathname.startsWith(route.path + '/')
    if (match) {
      try {
        const result = route.handler(req, res)
        if (result && typeof result.catch === 'function') {
          void result.catch((error) => {
            if (!res.headersSent) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
            }
          })
        }
      } catch (error) {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
        }
      }
      return
    }
  }
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: false, error: 'not found' }))
})
server.on('upgrade', (req, socket, head) => {
  const pathname = (req.url ?? '').split('?')[0]
  if (pathname === api.wsRoute.path) {
    void api.wsRoute.handler(req, socket, head)
  } else {
    socket.destroy()
  }
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}/__dsh-ssh`

const jsonRequest = async (method, path, body) => {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data = {}
  try { data = await res.json() } catch { /* 非 JSON */ }
  return { status: res.status, data }
}

/** 收集一条 WS 消息直到满足 predicate（或超时）。 */
const collectWs = (ws, predicate, timeoutMs = 4000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    ws.off('message', onMessage)
    reject(new Error('WS 消息超时'))
  }, timeoutMs)
  const onMessage = (raw) => {
    const msg = JSON.parse(raw.toString())
    if (predicate(msg)) {
      clearTimeout(timer)
      ws.off('message', onMessage)
      resolve(msg)
    }
  }
  ws.on('message', onMessage)
})
const wsConnect = () => new Promise((resolve, reject) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/__dsh-ssh/ws`)
  ws.on('open', () => resolve(ws))
  ws.on('error', reject)
})

try {
  // ── S1 health ────────────────────────────────────────────────────
  {
    const { status, data } = await jsonRequest('GET', '/api/health')
    guard(status === 200 && data.ok === true, `health 200 ok（${status}）`)
    guard(data.plugin === 'dsh-ssh', `plugin 名（${data.plugin}）`)
    guard(data.version === 'test-1.2.3', `version（${data.version}）`)
  }

  // ── S2 environment ───────────────────────────────────────────────
  {
    const { status, data } = await jsonRequest('GET', '/api/environment')
    guard(status === 200 && data.ok === true, `environment 200 ok（${status}）`)
    guard(['wsl', 'windows', 'linux', 'macos'].includes(data.kind), `kind 合法（${data.kind}）`)
    guard(typeof data.canWsl === 'boolean', 'canWsl 布尔')
    guard(data.canWin === (data.kind === 'wsl'), `canWin = kind==='wsl'（${data.canWin}）`)
    guard(data.canDocker === false, 'canDocker=false')
  }

  // ── S3 aliases ───────────────────────────────────────────────────
  {
    const { status, data } = await jsonRequest('GET', '/api/aliases')
    guard(status === 200 && data.ok === true, `aliases 200 ok（${status}）`)
    guard(Array.isArray(data.items), 'items 数组')
    // 本机 ~/.dsh/remote-hosts.json 存在 ecs/kali 档（开发期验证）
    const names = data.items.map((i) => i.name)
    guard(names.includes('ecs'), `包含 dsh 源 ecs（${names.join(',')}）`)
    guard(names.includes('kali'), '包含 dsh 源 kali')
    const kali = data.items.find((i) => i.name === 'kali')
    guard(kali && kali.sshBinary, 'kali 档含 sshBinary')
    guard(kali && kali.source === 'dsh', 'kali 源标记 dsh')
    const allValid = data.items.every((i) => i.name && i.host && ['dsh', 'ssh-config'].includes(i.source))
    guard(allValid, 'items 字段形状合法')
    // 同名去重（dsh 优先）
    const unique = new Set(data.items.map((i) => i.name)).size === data.items.length
    guard(unique, '同名不重复')
  }

  // ── S4 connect：长请求 pipeline + flowId 日志流 ──────────────────
  {
    // 先开 WS 订阅 log 频道（flow-4），再发 connect，验证增量
    const ws = await wsConnect()
    ws.send(JSON.stringify({ t: 'subscribe', channel: 'log', key: 'flow-4' }))
    const snapshot = await collectWs(ws, (m) => m.t === 'log-snapshot' && m.key === 'flow-4')
    guard(Array.isArray(snapshot.lines) && snapshot.lines.length === 0, '订阅即回 log-snapshot 空快照')

    const draft = {
      kind: 'ssh',
      title: 'kali-pwn',
      ssh: { host: '192.168.184.131', port: 22, user: 'kali', auth: { type: 'key', identityFile: '/tmp/id' } },
    }
    // fetch 并发（长请求），不 await —— 模拟 HTTP 中断不杀 pipeline
    const pending = fetch(`${baseUrl}/api/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft, flowId: 'flow-4' }),
    })
    const incr1 = await collectWs(ws, (m) => m.t === 'log' && m.key === 'flow-4' && m.line.msg.includes('正在通过窗口 Host 连接 ssh kali-pwn'))
    guard(incr1.line.level === 'INFO', `log 增量 1（${incr1.line.msg}）`)
    const incr2 = await collectWs(ws, (m) => m.t === 'log' && m.key === 'flow-4' && m.line.msg.includes('远程环境检测完成'))
    guard(incr2.line.msg.includes('linux/x64'), `log 增量 2（${incr2.line.msg}）`)
    const res = await pending
    const data = await res.json()
    guard(res.status === 200 && data.ok === true, `connect 200 ok（${res.status}）`)
    guard(data.env && data.env.os === 'linux', `connect 返回 env（${JSON.stringify(data.env).slice(0, 60)}）`)
    ws.send(JSON.stringify({ t: 'unsubscribe', channel: 'log', key: 'flow-4' }))
    ws.close()
  }

  // ── S4b HTTP 中断不杀 pipeline：不同 flowId 重订阅可达快照 ───────
  {
    const draft2 = {
      kind: 'ssh',
      title: 'interrupt-test',
      ssh: { host: '10.0.0.1', port: 22, user: 'u', auth: { type: 'key', identityFile: '/tmp/id' } },
    }
    // 发出请求，等服务端收到并开始 pipeline 后中断（假脚本对 10.0.0.1 睡 1.5s，保证在途）
    const controller = new AbortController()
    void fetch(`${baseUrl}/api/connect`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: draft2, flowId: 'flow-4b' }),
    }).catch(() => { /* 中断预期 */ })
    await sleep(300) // 服务端已收 body 并启动 pipeline
    controller.abort()
    await sleep(3400) // 等 pipeline 服务端落地（假 ssh 两次 spawn 各 1.5s + 余量）
    const ws = await wsConnect()
    ws.send(JSON.stringify({ t: 'subscribe', channel: 'log', key: 'flow-4b' }))
    const snapshot = await collectWs(ws, (m) => m.t === 'log-snapshot' && m.key === 'flow-4b')
    const msgs = snapshot.lines.map((l) => l.msg)
    guard(msgs.some((m) => m.includes('正在通过窗口 Host 连接 ssh interrupt-test')), 'HTTP 中断后 pipeline 日志完整（头）')
    guard(msgs.some((m) => m.includes('远程环境检测完成')), 'HTTP 中断后 pipeline 日志完整（尾）')
    guard(msgs.filter((m) => m === '***').length === 0, '无 redact 伪影')
    // flowId map 保留 → browse 可用
    const browse = await jsonRequest('POST', '/api/browse', { flowId: 'flow-4b', dir: '/home/u' })
    guard(browse.status === 200 && browse.data.ok === true, `中断后 flowId browse 仍可用（${browse.status}）`)
    ws.close()
  }

  // ── S5 connections CRUD + check + targets + disconnect + delete ──
  let connId
  {
    // 创建（向导第 4 步完成）
    const draft = {
      kind: 'ssh',
      title: 'ecs-prod',
      ssh: { host: '8.138.56.116', port: 22, user: 'root', auth: { type: 'key', identityFile: '/home/lyy/.ssh/id_ed25519' }, downloadMethod: 'upload' },
    }
    const { status, data } = await jsonRequest('POST', '/api/connections', { draft, title: 'ecs-prod', remotePath: '/root', flowId: 'flow-4b' })
    guard(status === 200 && data.ok === true, `create 200 ok（${status}）`)
    connId = data.connection.id
    guard(connId.startsWith('conn_'), `id 前缀 conn_（${connId}）`)
    guard(data.connection.ssh.auth.type === 'key', '持久化 key 认证')
    // 列表含 status
    await sleep(150)
    const list = await jsonRequest('GET', '/api/connections')
    const item = list.data.items.find((i) => i.connection.id === connId)
    guard(Boolean(item), 'connections 列表含新连接')
    guard(item.status.state === 'online', `checkNow 后 state online（${item.status.state}）`)
    // targets
    const targets = await jsonRequest('GET', '/api/targets')
    const t = targets.data.items.find((i) => i.connectionId === connId)
    guard(t && t.online === true && t.kind === 'ssh' && t.remotePath === '/root', `targets 结构（${JSON.stringify(t)}）`)
    // check 手动重测
    const check = await jsonRequest('POST', '/api/check', { connectionId: connId })
    guard(check.data.ok === true && check.data.status.state === 'online', `check 同步返回 online（${check.data.status.state}）`)
    // dshSsh 服务（H 契约）
    const spawn = dshSsh.buildRemoteSpawn({ connectionId: connId })
    guard(spawn.name === 'ecs-prod', `buildRemoteSpawn name（${spawn.name}）`)
    guard(spawn.argv[0] === fakeScriptPath, `buildRemoteSpawn argv 头为假脚本（${spawn.argv[0]}）`)
    guard(spawn.argv.includes('-t'), 'buildRemoteSpawn 含 -t')
    const finalArg = spawn.argv[spawn.argv.length - 1]
    guard(finalArg.includes("cd '/root'") && finalArg.includes('exec'), `远端命令尾参（${finalArg}）`)
    const targets2 = dshSsh.listTargets()
    guard(targets2.some((x) => x.connectionId === connId && x.online), 'listTargets 联动')
  }

  // ── S6 browse：connectionId 与 flowId 两路 + mkdir ───────────────
  {
    const viaConn = await jsonRequest('POST', '/api/browse', { connectionId: connId, dir: '/root' })
    guard(viaConn.status === 200 && viaConn.data.ok === true, `connectionId browse 200（${viaConn.status}）`)
    guard(viaConn.data.dir === '/root' && viaConn.data.parent === undefined, 'dir/parent 正确')
    const names = viaConn.data.entries.map((e) => e.name)
    guard(names.includes('etc') && names.includes('root.txt'), `entries 解析（${names.join(',')}）`)
    guard(viaConn.data.entries.some((e) => e.name === '.custom' && e.type === 'dir'), '隐藏项普适解析')
    const viaFlow = await jsonRequest('POST', '/api/browse', { flowId: 'flow-4', dir: '/home/kali' })
    guard(viaFlow.data.ok === true && viaFlow.data.parent === '/home', `flowId browse 200（${viaFlow.status}）`)
    const mkdir = await jsonRequest('POST', '/api/browse', { connectionId: connId, dir: '/root', mkdir: 'newdir' })
    guard(mkdir.data.ok === true, 'browse mkdir 字段生效')

    // WIN 连接（kind:'win'）：browse 走本地 WSL 侧，验证真实目录
    const winDraft = { kind: 'win', win: { shell: 'powershell' } }
    const winCreate = await jsonRequest('POST', '/api/connections', { draft: winDraft, title: 'win-box', remotePath: '/tmp' })
    guard(winCreate.data.ok === true, 'win 连接创建 ok')
    const winConnId = winCreate.data.connection.id
    const winBrowse = await jsonRequest('POST', '/api/browse', { connectionId: winConnId, dir: '/tmp' })
    guard(winBrowse.status === 200 && winBrowse.data.ok === true, `win browse 200（${winBrowse.status}）`)
    guard(winBrowse.data.dir === '/tmp', 'win browse dir 回显')
    const winTarget = await jsonRequest('GET', '/api/targets')
    const winT = winTarget.data.items.find((i) => i.connectionId === winConnId)
    guard(winT && winT.kind === 'win' && winT.online === true, `win target kind/online（${JSON.stringify(winT)}）`)
    const winSpawn = dshSsh.buildRemoteSpawn({ connectionId: winConnId, shell: 'powershell' })
    guard(JSON.stringify(winSpawn.argv) === JSON.stringify(['powershell.exe', '-NoLogo']), `win buildRemoteSpawn（${winSpawn.argv.join(' ')}）`)
    await jsonRequest('DELETE', '/api/connections', { connectionId: winConnId })
  }

  // ── S7 WS status 快照 + 增量 ─────────────────────────────────────
  {
    const ws = await wsConnect()
    ws.send(JSON.stringify({ t: 'subscribe', channel: 'status' }))
    const snapshot = await collectWs(ws, (m) => m.t === 'status' && m.items !== undefined)
    guard(typeof snapshot.items === 'object' && snapshot.items !== null, 'status 快照 items 对象')
    guard(Object.keys(snapshot.items).length >= 1, `status 快照含连接（${Object.keys(snapshot.items).length}）`)
    // 触发一次探测 → 增量
    void jsonRequest('POST', '/api/check', { connectionId: connId })
    const incr = await collectWs(ws, (m) => m.t === 'status' && m.connectionId === connId)
    guard(incr.status && typeof incr.status.state === 'string', `status 增量（${incr.status.state}）`)
    ws.close()
  }

  // ── S8 disconnect → unknown；DELETE → 移除 ──────────────────────
  {
    const disc = await jsonRequest('POST', '/api/disconnect', { connectionId: connId })
    guard(disc.data.ok === true, 'disconnect ok')
    await sleep(50)
    const list = await jsonRequest('GET', '/api/connections')
    const item = list.data.items.find((i) => i.connection.id === connId)
    guard(item.status.state === 'unknown', `disconnect 后 state unknown（${item.status.state}）`)
    const del = await jsonRequest('DELETE', '/api/connections', { connectionId: connId })
    guard(del.data.ok === true, 'DELETE ok')
    const list2 = await jsonRequest('GET', '/api/connections')
    guard(!list2.data.items.some((i) => i.connection.id === connId), 'DELETE 后列表移除')
  }

  // ── S9 错误路径 ─────────────────────────────────────────────────
  {
    const badConnect = await jsonRequest('POST', '/api/connect', { draft: { kind: 'ssh', ssh: {} }, flowId: 'x' })
    guard(badConnect.status === 400 && badConnect.data.ok === false, `缺字段 connect 400（${badConnect.status}）`)
    const noFlowBrowse = await jsonRequest('POST', '/api/browse', { dir: '/x' })
    guard(noFlowBrowse.status === 410, `无 id browse 410（${noFlowBrowse.status}）`)
    const badConn = await jsonRequest('POST', '/api/check', { connectionId: 'conn_missing' })
    guard(badConn.status === 404 && badConn.data.ok === false, `不存在 check 404（${badConn.status}）`)
    const badDel = await jsonRequest('DELETE', '/api/connections', { connectionId: 'conn_missing' })
    guard(badDel.status === 404, `不存在 DELETE 404（${badDel.status}）`)
    const wrongMethod = await jsonRequest('POST', '/api/health', {})
    guard(wrongMethod.status === 405, `health POST 405（${wrongMethod.status}）`)
  }

  console.log('\n[routes] ✅ 全部通过')
} catch (error) {
  console.error('[routes] FAIL: 未捕获异常')
  console.error(error)
  process.exit(1)
} finally {
  loghub.dispose()
  probe.stop()
  await connector.disposeAll()
  await new Promise((resolve) => server.close(resolve))
  rmSync(base, { recursive: true, force: true })
}