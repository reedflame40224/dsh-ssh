/**
 * dsh-ssh host 半 M2 离线 e2e：运行时下发全链路（SPEC-M2 R2 六个场景）。
 *
 * 假 ssh 注入：sshBinary 指向本地 stub 脚本（connector.e2e.mjs 同款尾参提取），
 * 对尾参命令用 `env HOME=<fakehome> sh -c '<cmd>'` **本地真执行**（~ 由脚本 sed 替换为
 * fakehome），因此 RuntimeManager 的安装流（mkdir/cat 上传/sha256sum/tar/ln/启动
 * start.sh 系统 node）在本地目录全真演练。
 *
 * 场景：
 *   1. 全新安装：fakehome 无 .dsh-remote → ensure 后目录结构齐全、握手 ping 通、
 *      日志含上传/校验/激活/握手行，reused=system-node；
 *   2. 幂等：二次 ensure → `已是最新`、无重复上传（假脚本记录次数）；testConnect +
 *      runtimeStep 注入链路返回 runtime 结果；
 *   3. 升级：伪造旧版 manifest → 重新安装、current 指向新版、旧 cache 保留；
 *   4. 校验失败：假脚本篡改 sha256sum 输出 → ERROR 校验失败、current 不变；
 *   5. degraded：runtime.installed=true 的连接，通道拒答（假 start.sh 退出）→
 *      degraded（运行时无响应），恢复 → online；
 *   6. openChannel 基础：写行进 tail、onLine 逐行、close 后 exited。
 *
 * 纯 node 运行：`node test/runtime-host.e2e.mjs`；退出码 0/非 0 表成败。
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConnectionRegistry } from '../src/registry.ts'
import { SshConnector } from '../src/ssh.ts'
import { RuntimePool } from '../src/remote-client.ts'
import { RuntimeManager } from '../src/runtime.ts'
import { LivenessProbe } from '../src/liveness.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

const fail = (reason) => {
  console.error('[runtime-host] FAIL:', reason)
  process.exit(1)
}
const guard = (condition, label) => {
  if (!condition) fail(label)
  console.log(`[runtime-host] ok: ${label}`)
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const base = mkdtempSync(join(tmpdir(), 'dsh-ssh-rhost-'))
const fakeLogPath = join(base, 'fake.log')

/** 组装假 ssh 脚本：尾参命令 → env HOME=<fakehome> sh -c 本地真执行。 */
function writeFakeSsh() {
  const script = join(base, 'fake-ssh.sh')
  const body = [
    '#!/bin/sh',
    '# 假 ssh：尾参命令用 env HOME=$FAKE_HOME sh -c 本地真执行（stdin/stdout 透传）。',
    '# ~ 由 sed 替换为 fakehome 路径（不依赖 shell 的 tilde 语义取 HOME）。',
    'echo "FAKEARGS:$*" >> "$FAKE_LOG"',
    'CMD=""',
    'PREV=""',
    'OP=""',
    'for a in "$@"; do',
    '  if [ "$PREV" = "-O" ]; then OP="$a"; fi',
    '  PREV="$a"',
    '  CMD="$a"',
    'done',
    'if [ "$OP" = "check" ]; then',
    '  if [ -n "$FAKE_MUXDOWN" ]; then echo "Control socket connect failed" >&2; exit 255; fi',
    '  echo "Master running (pid=1)"',
    '  exit 0',
    'fi',
    'if [ "$OP" = "exit" ]; then exit 0; fi',
    'if [ -n "$FAKE_RUNTIME_DOWN" ] && printf "%s" "$CMD" | grep -q "start.sh --stdio"; then',
    '  echo "runtime down (fake)" >&2',
    '  exit 1',
    'fi',
    'if [ -n "$FAKE_SHA_BAD" ] && printf "%s" "$CMD" | grep -q "sha256sum"; then',
    '  echo "0000000000000000000000000000000000000000000000000000000000000000 ~/.dsh-remote/staging/0.1.0.tar.gz"',
    '  exit 0',
    'fi',
    'if [ -n "$FAKE_HOME" ]; then',
    '  CMD=$(printf "%s" "$CMD" | sed "s|~|${FAKE_HOME}|g")',
    '  exec env HOME="$FAKE_HOME" sh -c "$CMD"',
    'fi',
    'exec sh -c "$CMD"',
  ].join('\n')
  writeFileSync(script, body + '\n')
  chmodSync(script, 0o755)
  return script
}

/** 记录上传次数：fake.log 中 `cat > ~/.dsh-remote/staging/` 出现次数。 */
function uploadCount() {
  if (!existsSync(fakeLogPath)) return 0
  return readFileSync(fakeLogPath, 'utf8').split('\n').filter((l) => l.includes('cat > ~/.dsh-remote/staging/')).length
}

const mkTarget = (connId) => ({
  connId,
  kind: 'ssh',
  host: 'h',
  port: 22,
  user: 'u',
  auth: { type: 'key', identityFile: '/tmp/id' },
})

const mkDraft = () => ({
  kind: 'ssh',
  title: 'wired',
  ssh: { host: 'h', port: 22, user: 'u', auth: { type: 'key', identityFile: '/tmp/id' }, downloadMethod: 'upload' },
})

try {
  const fakeSshPath = writeFakeSsh()
  process.env.FAKE_LOG = fakeLogPath
  const connector = new SshConnector({ muxDir: join(base, 'mux'), askpassDir: join(base, 'askpass'), defaultSshBinary: fakeSshPath })
  const pool = new RuntimePool({ connector })
  const manager = new RuntimeManager({ connector, pool, version: VERSION })

  // ── 1) 全新安装 ─────────────────────────────────────────────────
  const homeA = join(base, 'home-a')
  mkdirSync(homeA, { recursive: true })
  process.env.FAKE_HOME = homeA
  {
    const target = mkTarget('conn_install')
    const logs = []
    const result = await manager.ensure(target, { method: 'upload' }, (line) => logs.push(line))
    guard(result && result.installed === true && result.version === VERSION, `ensure installed v${VERSION}`)
    guard(result.reused === 'system-node', `node 复用 system-node（远端系统 node>=18，包无内置 node）`)

    const remoteHome = join(homeA, '.dsh-remote')
    guard(existsSync(remoteHome), '.dsh-remote 目录已建')
    guard(existsSync(join(remoteHome, 'current')), 'current 存在')
    const curReal = realpathSync(join(remoteHome, 'current'))
    guard(curReal === join(remoteHome, 'cache', VERSION), `current → cache/${VERSION}（${curReal}）`)
    guard(existsSync(join(remoteHome, 'cache', VERSION, '.ready')), '.ready 已 touch')
    guard(existsSync(join(remoteHome, 'current', 'manifest.json')), 'manifest.json 就位')
    const stagingLeft = readdirSync(join(remoteHome, 'staging')).filter((n) => n.endsWith('.tar.gz'))
    guard(stagingLeft.length === 0, `staging 已清空（${JSON.stringify(stagingLeft)}）`)

    const msgs = logs.map((l) => l.msg)
    guard(msgs.some((m) => m.includes('检查远端运行时…')), '日志含 检查远端运行时')
    guard(msgs.some((m) => m.includes('本地下载后上传：上传运行时包（')), '日志含 上传运行时包')
    guard(msgs.some((m) => m.includes(`运行时校验通过，激活 v${VERSION}`)), '日志含 校验通过激活')
    guard(msgs.some((m) => m.startsWith('远端运行时握手成功（node v')), '日志含 握手成功')
    guard(msgs.some((m) => m.includes('node 复用：system-node')), '日志含 node 复用行')

    // 池内握手通道真实可 ping（start.sh 用系统 node 真跑）
    const client = await pool.get('conn_install', target)
    const ping = await client.call('ping', {}, 3_000)
    guard(ping && ping.version === VERSION && ping.pid > 0, `池 ping 通（真 start.sh：version ${ping.version} pid ${ping.pid}）`)
    pool.drop('conn_install')
  }

  // ── 2) 幂等：二次 ensure 不重装；testConnect + runtimeStep 全链路 ──
  {
    const before = uploadCount()
    const logs = []
    const result = await manager.ensure(mkTarget('conn_install'), { method: 'upload' }, (line) => logs.push(line))
    guard(result && result.installed === true && result.version === VERSION, '幂等 ensure 返回 installed')
    guard(result.reused === undefined, `幂等路径 reused=undefined（实际 ${result.reused}）`)
    guard(logs.some((l) => l.msg.includes(`运行时已是最新（v${VERSION}）`)), '日志含 已是最新')
    guard(uploadCount() === before, `无重复上传（上传次数 ${before} → ${uploadCount()}）`)

    // testConnect + runtimeStep 注入（index.ts 同款组装）：运行时结果穿透返回值
    const runtimeStep = async (target, draft, log) => {
      if (!target.downloadMethod) return undefined
      try {
        return (await manager.ensure(target, { method: target.downloadMethod, remoteUrl: draft.ssh?.runtimeUrl }, log)) ?? undefined
      } catch (error) {
        if (!error.logged) log({ level: 'ERROR', msg: `运行时安装失败：${error.message}` })
        return undefined
      }
    }
    const connectorWired = new SshConnector({
      muxDir: join(base, 'mux2'),
      askpassDir: join(base, 'askpass2'),
      defaultSshBinary: fakeSshPath,
      runtimeStep,
    })
    const tLogs = []
    const res = await connectorWired.testConnect(mkDraft(), (line) => tLogs.push(line))
    guard(res.env.os === 'linux' && res.env.arch === 'x64', 'testConnect env 正常')
    guard(res.runtime && res.runtime.installed === true && res.runtime.version === VERSION, 'testConnect 返回 runtime 结果')
    await connectorWired.disposeAll()
  }

  // ── 3) 升级：伪造旧版 → 重装，current 指向新版，旧 cache 保留 ────
  const homeB = join(base, 'home-b')
  mkdirSync(homeB, { recursive: true })
  process.env.FAKE_HOME = homeB
  {
    const oldVersion = '0.0.9'
    const remoteHome = join(homeB, '.dsh-remote')
    const oldCache = join(remoteHome, 'cache', oldVersion)
    mkdirSync(oldCache, { recursive: true })
    writeFileSync(join(oldCache, 'manifest.json'), JSON.stringify({ name: 'dsh-remote', version: oldVersion, platform: 'linux-x64' }))
    writeFileSync(join(oldCache, '.ready'), '')
    writeFileSync(join(oldCache, 'dsh-remote-server.cjs'), '// 旧版占位')
    writeFileSync(join(oldCache, 'start.sh'), '#!/bin/sh\nexit 0\n')
    symlinkSync(join(oldCache), join(remoteHome, 'current'))

    const logs = []
    const result = await manager.ensure(mkTarget('conn_upgrade'), { method: 'upload' }, (line) => logs.push(line))
    guard(result && result.version === VERSION, `升级到 v${VERSION}`)
    const curReal = realpathSync(join(remoteHome, 'current'))
    guard(curReal === join(remoteHome, 'cache', VERSION), `升级后 current → cache/${VERSION}（${curReal}）`)
    guard(existsSync(join(oldCache, '.ready')), '旧 cache 保留')
    guard(result.reused === 'system-node', `升级后 node 复用 system-node（${result.reused}）`)
  }

  // ── 4) 校验失败：sha256sum 被篡改 → ERROR 校验失败、current 不变 ──
  const homeC = join(base, 'home-c')
  mkdirSync(homeC, { recursive: true })
  process.env.FAKE_HOME = homeC
  process.env.FAKE_SHA_BAD = '1'
  {
    const logs = []
    let thrown = ''
    try {
      await manager.ensure(mkTarget('conn_badsha'), { method: 'upload' }, (line) => logs.push(line))
      fail('校验失败场景应当抛错')
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error)
    }
    delete process.env.FAKE_SHA_BAD
    guard(thrown.includes('校验失败'), `抛错含 校验失败（${thrown}）`)
    guard(logs.some((l) => l.level === 'ERROR' && l.msg.includes('校验失败')), '日志含 ERROR 校验失败')
    guard(!existsSync(join(homeC, '.dsh-remote', 'current')), '校验失败后 current 未建立')
  }

  // ── 5) degraded：runtime.installed=true，通道拒答 → degraded；恢复 → online ──
  process.env.FAKE_HOME = homeA
  {
    const reg = new ConnectionRegistry({ baseDir: join(base, 'reg-data') })
    reg.load()
    const rec = reg.create(
      { kind: 'ssh', title: 'degraded', ssh: { host: 'h', port: 22, user: 'u', auth: { type: 'key', identityFile: '/tmp/id' }, downloadMethod: 'upload' } },
      'degraded',
      '/root',
    )
    reg.updateRuntime(rec.id, { installed: true, version: VERSION })
    const statuses = new Map()
    const probe = new LivenessProbe({
      registry: reg,
      connector,
      pool,
      onStatus: (id, st) => statuses.set(id, st),
      checkTimeoutMs: 3_000,
      runtimePingTimeoutMs: 2_000,
      baseIntervalMs: 60_000,
    })

    // 通道拒答：假 start.sh 立即退出 → hello 握手失败 → degraded
    process.env.FAKE_RUNTIME_DOWN = '1'
    const st1 = await probe.checkNow(rec.id)
    guard(st1.state === 'degraded', `运行时拒答 → degraded（${st1.state}）`)
    guard(st1.error && st1.error.includes('运行时无响应'), `error 含 运行时无响应（${st1.error}）`)
    delete process.env.FAKE_RUNTIME_DOWN

    // 恢复：真 start.sh 可握手 → online
    const st2 = await probe.checkNow(rec.id)
    guard(st2.state === 'online', `恢复 → online（${st2.state}）`)
    probe.stop()
  }

  // ── 6) openChannel 基础：写行进 tail、onLine 逐行、close 后 exited ──
  {
    process.env.FAKE_HOME = join(base, 'home-d')
    mkdirSync(join(base, 'home-d'), { recursive: true })
    const channel = await connector.openChannel(mkTarget('conn_ch6'), 'cat')
    const lines = []
    const errLines = []
    let exitCode = null
    channel.onLine((l) => lines.push(l))
    channel.onStderrLine((l) => errLines.push(l))
    channel.onExit((code) => { exitCode = code })
    channel.write('hello-line-1')
    channel.write('hello-line-2')
    await sleep(500)
    guard(lines.length === 2 && lines[0] === 'hello-line-1' && lines[1] === 'hello-line-2', `写行进 tail、onLine 逐行（${JSON.stringify(lines)}）`)
    channel.close()
    let waited = 0
    while (!channel.exited && waited < 3_000) {
      await sleep(50)
      waited += 50
    }
    guard(channel.exited === true, 'close 后 exited')
    guard(exitCode === 0, `close 后 exit code 0（实际 ${exitCode}，stderr ${JSON.stringify(errLines)}）`)
  }

  await pool.disposeAll()
  await connector.disposeAll()
  console.log('\n[runtime-host] ✅ 全部通过')
} catch (error) {
  console.error('[runtime-host] FAIL: 未捕获异常')
  console.error(error)
  process.exit(1)
} finally {
  for (const key of ['FAKE_LOG', 'FAKE_HOME', 'FAKE_RUNTIME_DOWN', 'FAKE_SHA_BAD', 'FAKE_MUXDOWN']) delete process.env[key]
  rmSync(base, { recursive: true, force: true })
}