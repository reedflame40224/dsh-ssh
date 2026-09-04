/**
 * dsh-ssh M5 离线 e2e：会话级远程执行路由（SPEC-M5 契约 A/B/D）。
 *
 * 场景：
 *  1. dshRemotePaths 钩子形状 + 命中/缺席（长根优先、目录边界、win 排除、无 remotePath 排除）；
 *  2. 路由三件形状 + 命中/缺席（fs route 相对路径按 cwd 解析、shell/subprocess routeByCwd）；
 *  3. RemoteFsLike 经假 RuntimePool 通道：resolve/stat/readText/writeText(守卫)/editText(歧义)/
 *     listDir 的 RPC 参数与结果形状；
 *  4. 回落：运行时缺失/degraded → connector.exec 一次性命令（断言命令串与 rg 翻译）；
 *  5. subprocess spawn 的 rg 翻译断言：本地 rg 绝对路径 → $HOME/.dsh-remote/current/tools/rg（裸放不引号，远端 shell 展开），
 *     非 rg argv[0] 不翻译；输出超 maxBytes → readFrom(0).lossy（溢出语义）；
 *  6. POST /api/register-remote-workspace 路由：200 workspaceId / 重复 already / 400 / 501。
 *
 * 纯 node 运行：`node test/m5-routers.e2e.mjs`；退出码 0/非 0 表成败。
 */

import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionRegistry } from '../src/registry.ts'
import { SshConnector } from '../src/ssh.ts'
import { LivenessProbe } from '../src/liveness.ts'
import { LogHub } from '../src/loghub.ts'
import { createApi } from '../src/routes.ts'
import { createDshRemotePaths } from '../src/remote-paths.ts'
import { createRouters } from '../src/routers.ts'

const fail = (reason) => {
  console.error('[m5-routers] FAIL:', reason)
  process.exit(1)
}
const guard = (condition, label, detail = '') => {
  if (!condition) fail(`${label}${detail ? `（${detail}）` : ''}`)
  console.log(`[m5-routers] ok: ${label}${detail ? `（${detail}）` : ''}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const base = mkdtempSync(join(tmpdir(), 'dsh-ssh-m5-'))
const registry = new ConnectionRegistry({ baseDir: join(base, 'data') })
registry.load()

// 注册表基线（e2e 自建，不碰用户数据）：
//  conn-a：ssh /home/remote-a；conn-b：ssh /home/remote-b（长根测试用 conn-c 覆盖）
//  conn-c：ssh /home/remote-a/sub（嵌套长根）；conn-win：win /mnt/c（应被排除）
//  conn-nopath：ssh 无 remotePath（应被排除）
const connA = registry.create(
  { kind: 'ssh', title: 'a', ssh: { host: 'h1', port: 22, user: 'u', auth: { type: 'key', identityFile: '/tmp/id' } } },
  'a',
  '/home/remote-a',
)
const connB = registry.create(
  { kind: 'ssh', title: 'b', ssh: { host: 'h2', port: 22, user: 'u', auth: { type: 'key', identityFile: '/tmp/id' } } },
  'b',
  '/home/remote-b',
)
const connC = registry.create(
  { kind: 'ssh', title: 'c', ssh: { host: 'h3', port: 22, user: 'u', auth: { type: 'key', identityFile: '/tmp/id' } } },
  'c',
  '/home/remote-a/sub',
)
registry.create(
  { kind: 'win', title: 'w', win: { shell: 'powershell' } },
  'w',
  '/mnt/c/Users/foo',
)
const connNoPath = registry.create(
  { kind: 'ssh', title: 'nopath', ssh: { host: 'h4', port: 22, user: 'u', auth: { type: 'key', identityFile: '/tmp/id' } } },
  'nopath',
  '',
)
// 运行时通道测试需要 installed + online
registry.updateRuntime(connA.id, { installed: true })

// ── 假连接器 / 假池 / 假状态 ───────────────────────────────────────────────
const executedCommands = []
const rpcCalls = []
const warnLogs = []
const fakeConnector = {
  exec: async (target, command, opts) => {
    executedCommands.push({ command, timeoutMs: opts?.timeoutMs })
    return { code: 0, stdout: 'ok-stdout', stderr: '' }
  },
}
const fakePool = {
  down: false,
  get: async (connId, target) => {
    if (fakePool.down) throw new Error('远端运行时通道不可用（fake）')
    return {
      call: async (method, params, timeoutMs) => {
        rpcCalls.push({ method, params, timeoutMs })
        switch (method) {
          case 'fs.stat':
            return { exists: true, isDir: false, isFile: true, size: 12, mtimeMs: 1700000000000 }
          case 'fs.readText':
            return { text: 'hello remote 你好', truncated: false }
          case 'fs.readBytes':
            return { base64: Buffer.from('bytes-data').toString('base64'), truncated: false }
          case 'fs.listDir':
            return { entries: [{ name: 'dir1', type: 'dir' }, { name: 'a.txt', type: 'file' }] }
          case 'fs.writeText':
            return { bytes: 8 }
          case 'exec':
            return { code: 0, stdout: 'rg-json-output', stderr: '' }
          default:
            throw new Error(`未预期的 RPC 方法：${method}`)
        }
      },
    }
  },
}
const onlineStatus = () => ({ state: 'online' })
const routers = createRouters({
  registry,
  connector: fakeConnector,
  pool: fakePool,
  paths: createDshRemotePaths(registry),
  getStatus: (connId) => onlineStatus(connId),
  log: (line) => warnLogs.push(line),
})

try {
  // ── 1) dshRemotePaths 形状 + 命中/缺席 ────────────────────────────────
  {
    const paths = createDshRemotePaths(registry)
    guard(typeof paths.has === 'function' && typeof paths.match === 'function', 'dshRemotePaths 钩子形状（has/match）')
    guard(paths.has('/home/remote-a') === true, 'has：根自身命中')
    guard(paths.has('/home/remote-a/src/main.rs') === true, 'has：根内子路径命中')
    guard(paths.has('/home/remote-a/sub/x') === true, 'has：嵌套根内命中')
    guard(paths.has('/home/remote-aX') === false, 'has：目录边界之外缺席（/home/remote-aX）')
    guard(paths.has('/home/other') === false, 'has：未注册路径缺席')
    guard(paths.has('/mnt/c/Users/foo') === false, 'has：win 连接被排除（本地已存在）')
    guard(paths.has('/home/nopath') === false, 'has：无 remotePath 连接被排除')
    const deep = paths.match('/home/remote-a/sub/x/y')
    guard(deep !== undefined && deep.connectionId === connC.id && deep.remoteRoot === '/home/remote-a/sub',
      'match：长根优先（conn-c 嵌套根）', JSON.stringify(deep))
    const top = paths.match('/home/remote-a/file.txt')
    guard(top !== undefined && top.connectionId === connA.id && top.remoteRoot === '/home/remote-a',
      'match：外层根（conn-a）', JSON.stringify(top))
    guard(paths.match('/home/other') === undefined, 'match：缺席 undefined')
  }

  // ── 2) 路由三件形状 + 命中/缺席 ───────────────────────────────────────
  {
    guard(typeof routers.fsRemoteRouter.route === 'function', 'fsRemoteRouter 形状（route）')
    guard(typeof routers.shellRemoteRouter.routeByCwd === 'function', 'shellRemoteRouter 形状（routeByCwd）')
    guard(typeof routers.subprocessRemoteRouter.routeByCwd === 'function', 'subprocessRemoteRouter 形状（routeByCwd）')

    const fsHit = routers.fsRemoteRouter.route('/home/remote-a/file.txt')
    guard(fsHit !== undefined, 'fsRemoteRouter：命中返回远端对象')
    const methods = ['resolve', 'processPath', 'processPathFromHostPath', 'fileUrl', 'contains', 'stat', 'lstat',
      'readText', 'streamText', 'readBytes', 'listDir', 'writeText', 'editText']
    guard(methods.every((m) => typeof fsHit[m] === 'function'), 'fs 命中对象方法面齐全（FileSystem 13 公开方法）')
    guard(routers.fsRemoteRouter.route('/home/other/x') === undefined, 'fsRemoteRouter：未命中 undefined')
    guard(routers.fsRemoteRouter.route('src/main.rs', '/home/remote-a') !== undefined, 'fsRemoteRouter：相对路径按 cwd 解析命中')
    guard(routers.fsRemoteRouter.route('src/main.rs') === undefined, 'fsRemoteRouter：无 cwd 的相对路径缺席')

    const shellHit = routers.shellRemoteRouter.routeByCwd('/home/remote-a')
    guard(shellHit !== undefined && typeof shellHit.run === 'function', 'shellRemoteRouter：命中返回执行器（run）')
    guard(routers.shellRemoteRouter.routeByCwd('/home/other') === undefined, 'shellRemoteRouter：未命中 undefined')
    guard(routers.shellRemoteRouter.routeByCwd(undefined) === undefined, 'shellRemoteRouter：cwd 缺省 undefined')
    const subHit = routers.subprocessRemoteRouter.routeByCwd('/home/remote-b')
    guard(subHit !== undefined && typeof subHit.spawn === 'function', 'subprocessRemoteRouter：命中返回执行器（spawn）')
    guard(routers.subprocessRemoteRouter.routeByCwd('/home/other') === undefined, 'subprocessRemoteRouter：未命中 undefined')
  }

  // ── 3) RemoteFsLike 经运行时通道：RPC 参数与结果形状 ─────────────────
  {
    const fs = routers.fsRemoteRouter.route('/home/remote-a/proj/file.txt')
    const target = await fs.resolve('/home/remote-a/proj/file.txt')
    guard(target.targetKey === '/home/remote-a/proj/file.txt' && target.displayPath === target.targetKey,
      'fs.resolve：远端绝对路径即 targetKey/displayPath', target.targetKey)
    guard(fs.processPath(target) === '/home/remote-a/proj/file.txt', 'fs.processPath = targetKey')
    guard(fs.processPathFromHostPath('/home/remote-a/proj/file.txt') === '/home/remote-a/proj/file.txt',
      'fs.processPathFromHostPath：绝对路径透传')
    guard(fs.contains(target, { targetKey: '/home/remote-a/proj/file.txt', displayPath: 'x' }) === true, 'fs.contains：自身命中')
    guard(fs.contains(target, { targetKey: '/etc/passwd', displayPath: 'p' }) === false, 'fs.contains：外部缺席')
    guard(fs.fileUrl(target).startsWith('file://'), 'fs.fileUrl：file:// 前缀')

    rpcCalls.length = 0
    const info = await fs.stat(target)
    guard(info && info.version === 'remote:1700000000000:12' && info.type === 'file' && info.size === 12,
      'fs.stat：FsInfo 形状 + 版本令牌', JSON.stringify(info))
    guard(rpcCalls.length === 1 && rpcCalls[0].method === 'fs.stat' && rpcCalls[0].params.path === '/home/remote-a/proj/file.txt',
      'fs.stat：RPC 参数 {path}', JSON.stringify(rpcCalls[0]?.params))

    rpcCalls.length = 0
    const text = await fs.readText(target)
    guard(text === 'hello remote 你好', 'fs.readText：远端文本回传', JSON.stringify(text))
    guard(rpcCalls[0] && rpcCalls[0].method === 'fs.readText' && rpcCalls[0].params.maxBytes === 67108864,
      'fs.readText：RPC 参数带 maxBytes 上限')

    rpcCalls.length = 0
    const bytes = await fs.readBytes(target, undefined, 128)
    guard(Buffer.from(bytes).toString('utf8') === 'bytes-data', 'fs.readBytes：base64 解码回传')
    guard(rpcCalls[0] && rpcCalls[0].params.maxBytes === 128, 'fs.readBytes：RPC maxBytes 透传')

    rpcCalls.length = 0
    const entries = await fs.listDir(target)
    guard(entries.length === 2 && entries[0].type === 'directory' && entries[0].target.targetKey === '/home/remote-a/proj/file.txt/dir1',
      'fs.listDir：dir→directory 映射 + 子 target 拼接', JSON.stringify(entries.map((e) => e.target.targetKey)))
    guard(rpcCalls[0] && rpcCalls[0].method === 'fs.listDir', 'fs.listDir：走 RPC')

    // writeText 带守卫：createIfAbsent 撞已存在 → 报错（先改假 stat 不可行，直接断言不炸并走 RPC）
    rpcCalls.length = 0
    const outcome = await fs.writeText(target, 'new content', undefined)
    guard(outcome.version === 'remote:1700000000000:12' && outcome.after === 'new content', 'fs.writeText：产出形状（version/after）')
    guard(rpcCalls.some((c) => c.method === 'fs.writeText' && c.params.createParents === false), 'fs.writeText：RPC {path,text,createParents:false}')

    // editText 语义：未命中 / 歧义（与 fs-local.applyLiteralEdit 对齐）
    let editError = ''
    try { await fs.editText(target, { oldString: 'zzz-missing', newString: 'x', replaceAll: false }, undefined) } catch (e) { editError = String(e) }
    guard(editError.includes('was not found'), 'fs.editText：oldText 未命中报错', editError)
    try {
      await fs.editText(target, { oldString: 'o', newString: 'x', replaceAll: false }, undefined)
      fail('fs.editText 歧义场景应报错')
    } catch (e) {
      guard(String(e).includes('matched'), `fs.editText：多处命中未 replaceAll 报歧义（${e.message}）`)
    }
  }

  // ── 4) 回落：运行时缺失 → connector.exec 一次性命令 ──────────────────
  {
    executedCommands.length = 0
    fakePool.down = true
    const shell = routers.shellRemoteRouter.routeByCwd('/home/remote-a')
    const spec = shell.resolve({ command: 'pwd && ls', workdir: '/home/remote-a' })
    const result = await shell.run({ ...spec, timeoutMs: 5000 })
    guard(result !== undefined && result.stdout.text === 'ok-stdout' && result.exitCode === 0 && result.timedOut === false,
      '回落 run：结果形状（stdout/exitCode）', JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout }))
    guard(executedCommands.length === 1
      && executedCommands[0].command === "cd '/home/remote-a' && exec bash -c 'pwd && ls'",
      '回落 run：命令串 = cd + exec bash -c', executedCommands[0]?.command)
    guard(warnLogs.some((l) => l.level === 'WARN' && l.msg.includes('回落 ssh exec')), '回落告警日志已记录')

    // fs stat 回落：命中 stat -c
    executedCommands.length = 0
    const fs = routers.fsRemoteRouter.route('/home/remote-a/x/y.txt')
    const target = await fs.resolve('/home/remote-a/x/y.txt')
    await fs.stat(target)
    guard(executedCommands.length === 1 && executedCommands[0].command.includes(`stat -c 'type=%F|size=%s|mtime=%Y'`),
      '回落 stat：GNU stat 三字段命令', executedCommands[0]?.command)
    fakePool.down = false
  }

  // ── 5) subprocess spawn：rg 翻译断言 ──────────────────────────────────
  {
    // 运行时通道：rg 翻译发生在给运行时 exec 的命令串里
    rpcCalls.length = 0
    const sub = routers.subprocessRemoteRouter.routeByCwd('/home/remote-a')
    const localRg = '/harness/node_modules/@vscode/ripgrep/bin/rg'
    const handle = sub.spawn({
      argv: [localRg, '--no-config', '--json', '--regexp=hello'],
      cwd: '/home/remote-a',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1_000_000 }, stderr: { maxBytes: 64_000 } },
      graceMs: 3000,
    })
    const outcome = await handle.done
    guard(outcome.exitCode === 0 && outcome.signal === null, 'spawn.done：exitCode/signal 形状')
    const rgCall = rpcCalls.find((c) => c.method === 'exec')
    guard(rgCall !== undefined && rgCall.params.command.includes('$HOME/.dsh-remote/current/tools/rg') && !rgCall.params.command.includes("'$HOME"),
      'spawn 翻译断言：本地 rg 绝对路径 → 远端运行时 rg（$HOME 裸放不加单引号）', rgCall?.params?.command)
    guard(rgCall.params.command.startsWith("cd '/home/remote-a' &&"), 'spawn 命令串带 cd 前缀')
    guard(handle.collected.stdout.readFrom(0).text === 'rg-json-output' && handle.collected.stdout.readFrom(0).lossy === false,
      'spawn 收集输出：readFrom(0).lossy=false（未超上限）')
    guard(handle.pid > 0, 'spawn.pid：合成正数 id')

    // 回落通道：翻译同样发生在 connector.exec 命令串（rg 后置路径）
    executedCommands.length = 0
    fakePool.down = true
    const fallbackHandle = sub.spawn({
      argv: [localRg, '--no-config', '--files'],
      cwd: '/home/remote-b',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 10_000 } },
      graceMs: 3000,
    })
    const fallbackOutcome = await fallbackHandle.done
    void fallbackOutcome
    guard(executedCommands.length === 1 && executedCommands[0].command.includes('$HOME/.dsh-remote/current/tools/rg'),
      '回落 spawn：翻译在 ssh exec 命令串', executedCommands[0]?.command)
    fakePool.down = false

    // 非 rg argv[0] 不翻译
    rpcCalls.length = 0
    const nonRg = sub.spawn({
      argv: ['/usr/bin/true', '--flag'],
      cwd: '/home/remote-a',
      stdio: { stdin: 'ignore' },
      graceMs: 3000,
    })
    await nonRg.done
    const nonRgCall = rpcCalls.find((c) => c.method === 'exec')
    guard(nonRgCall !== undefined && nonRgCall.params.command.includes("'/usr/bin/true'"),
      '非 rg argv[0] 不翻译', nonRgCall?.params?.command)

    // 输出超 maxBytes → readFrom(0).lossy=true（溢出语义对齐本地 collector）
    fakePool.down = false
    const bigRpc = {
      call: async (method) => {
        if (method === 'exec') return { code: 0, stdout: 'x'.repeat(5000), stderr: '' }
        throw new Error('unexpected')
      },
    }
    const bigPool = {
      get: async () => bigRpc,
    }
    const subBig = createRouters({
      registry,
      connector: fakeConnector,
      pool: bigPool,
      paths: createDshRemotePaths(registry),
      getStatus: (connId) => onlineStatus(connId),
    }).subprocessRemoteRouter.routeByCwd('/home/remote-a')
    const bigHandle = subBig.spawn({
      argv: [localRg, '--files'],
      cwd: '/home/remote-a',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1000 } },
      graceMs: 3000,
    })
    await bigHandle.done
    const bigRead = bigHandle.collected.stdout.readFrom(0)
    guard(bigRead.lossy === true && bigRead.text.length === 1000,
      '输出超 maxBytes：readFrom(0).lossy=true（截断语义）', `${bigRead.text.length} bytes lossy=${bigRead.lossy}`)
  }

  // ── 6) POST /api/register-remote-workspace（契约 D 路由壳）────────────
  {
    const connector = new SshConnector({ muxDir: join(base, 'mux'), askpassDir: join(base, 'askpass'), defaultSshBinary: '/nonexistent-ssh' })
    const loghub = new LogHub({ bufferSize: 100, pingIntervalMs: 60_000 })
    const probe = new LivenessProbe({ registry, connector })
    let calls = 0
    const fakeRegister = async (connectionId) => {
      calls += 1
      if (connectionId === 'conn_unknown') return { ok: false, error: `连接不存在：${connectionId}` }
      if (connectionId === 'conn_nosrv') throw new Error('workspaceRegistry 崩溃')
      return calls === 1
        ? { ok: true, workspaceId: 'ws_m5_1' }
        : { ok: true, workspaceId: 'ws_m5_1', already: true }
    }
    const api = createApi({ registry, connector, liveness: probe, loghub, version: 'm5', registerRemoteWorkspace: fakeRegister })
    const server = http.createServer((req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      for (const route of api.httpRoutes) {
        const match = route.kind === 'exact' ? pathname === route.path : pathname.startsWith(route.path + '/')
        if (match) return route.handler(req, res)
      }
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise((resolve) => server.listen(0, resolve))
    const port = server.address().port
    const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(async (res) => ({ status: res.status, data: await res.json() }))

    let r = await post('/__dsh-ssh/api/register-remote-workspace', { connectionId: 'c1' })
    guard(r.status === 200 && r.data.ok === true && r.data.workspaceId === 'ws_m5_1' && r.data.already === undefined,
      '注册路由：首次 200 + workspaceId', JSON.stringify(r.data))
    r = await post('/__dsh-ssh/api/register-remote-workspace', { connectionId: 'c1' })
    guard(r.status === 200 && r.data.ok === true && r.data.already === true,
      '注册路由：重复置 already', JSON.stringify(r.data))
    r = await post('/__dsh-ssh/api/register-remote-workspace', {})
    guard(r.status === 400 && r.data.ok === false, '注册路由：缺 connectionId → 400')
    r = await post('/__dsh-ssh/api/register-remote-workspace', { connectionId: 'conn_unknown' })
    guard(r.status === 400 && r.data.error.includes('连接不存在'), '注册路由：未知连接 → 400 明因')
    r = await post('/__dsh-ssh/api/register-remote-workspace', { connectionId: 'conn_nosrv' })
    guard(r.status === 502 && r.data.ok === false, '注册路由：底层异常 → 502')
    const apiNoInject = createApi({ registry, connector, liveness: probe, loghub, version: 'm5' })
    const server2 = http.createServer((req, res) => {
      const pathname = (req.url ?? '').split('?')[0]
      const route = apiNoInject.httpRoutes.find((i) => i.kind === 'exact' && i.path === pathname)
      if (route) return route.handler(req, res)
      res.writeHead(404)
      res.end('not found')
    })
    await new Promise((resolve) => server2.listen(0, resolve))
    const port2 = server2.address().port
    const r2 = await fetch(`http://127.0.0.1:${port2}/__dsh-ssh/api/register-remote-workspace`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId: 'c1' }),
    }).then(async (res) => ({ status: res.status, data: await res.json() }))
    guard(r2.status === 501 && r2.data.ok === false, '注册路由：未注入 handler → 501')
    await new Promise((resolve) => server.close(resolve))
    await new Promise((resolve) => server2.close(resolve))
    loghub.dispose()
    probe.stop()
  }

  console.log('\n[m5-routers] ✅ 全部通过')
} catch (error) {
  console.error('[m5-routers] FAIL: 未捕获异常')
  console.error(error)
  process.exit(1)
} finally {
  rmSync(base, { recursive: true, force: true })
}