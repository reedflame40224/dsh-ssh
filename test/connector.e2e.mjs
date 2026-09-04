/**
 * dsh-ssh 离线 e2e：SshConnector（假 ssh 脚本注入，验证 mux 参数/OK 标记/env 解析
 * /askpass 脚本生灭/密码 redact/browse ls 解析/check/close/超时）。
 *
 * 双注入：sshBinary 指向临时假 ssh 脚本（按参数输出）；spawnFn 包装记录
 * argv/env/detached/askpass 文件状态，全部可断言。
 *
 * 纯 node 运行：`node test/connector.e2e.mjs`；退出码 0/非 0 表成败。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, rmSync, mkdirSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SshConnector, maskSecret } from '../src/ssh.ts'

const fail = (reason) => {
  console.error('[connector] FAIL:', reason)
  process.exit(1)
}
const guard = (condition, label) => {
  if (!condition) fail(label)
  console.log(`[connector] ok: ${label}`)
}

const base = mkdtempSync(join(tmpdir(), 'dsh-ssh-conn-'))
let fakeCount = 0

/** 生成假 ssh 脚本：按最后一个参数（远程命令）分派输出；记录信息到 $FAKE_LOG。 */
function writeFakeSsh() {
  fakeCount += 1
  const logPath = join(base, `fake-${fakeCount}.log`)
  const script = join(base, `fake-ssh-${fakeCount}.sh`)
  const body = [
    '#!/bin/sh',
    'echo "FAKEARGS:$@" >> "$FAKE_LOG"',
    'echo "FAKEENV:SSH_ASKPASS=${SSH_ASKPASS:-<none>};DISPLAY=${DISPLAY:-<none>};REQUIRE=${SSH_ASKPASS_REQUIRE:-<none>}" >> "$FAKE_LOG"',
    'if [ -n "$SSH_ASKPASS" ] && [ -f "$SSH_ASKPASS" ]; then',
    '  echo "ASKPASS_CONTENT:[$(cat "$SSH_ASKPASS" 2>/dev/null)]" >> "$FAKE_LOG"',
    '  echo "ASKPASS_MODE:$(stat -c %a "$SSH_ASKPASS" 2>/dev/null || echo na)" >> "$FAKE_LOG"',
    'fi',
    'if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi',
    'if [ -n "$FAKE_FAIL" ]; then',
    '  case "$FAKE_FAIL" in',
    '    permission) echo "Permission denied (publickey,password)." >&2 ;;',
    '    refused) echo "ssh: connect to host h port 22: Connection refused" >&2 ;;',
    '    other) echo "auth failed for user: ${FAKE_SECRET:-x}" >&2 ;;',
    '  esac',
    '  exit 255',
    'fi',
    'CMD=""',
    'PREV=""',
    'OP=""',
    'for a in "$@"; do',
    '  if [ "$PREV" = "-O" ]; then OP="$a"; fi',
    '  PREV="$a"; CMD="$a"',
    'done',
    'if [ "$OP" = "check" ]; then',
    '  if [ -n "$FAKE_MUXDOWN" ]; then echo "Control socket connect failed" >&2; exit 255; fi',
    '  echo "Master running (pid=1234)"',
    '  exit 0',
    'fi',
    'if [ "$OP" = "exit" ]; then exit 0; fi',
    'case "$CMD" in',
    '  *__DSH_SSH_OK__*) echo "__DSH_SSH_OK__"; echo "Linux x86_64"; exit 0 ;;',
    '  *command\\ -v*) echo "/usr/bin/zsh"; echo "/usr/bin/bash"; echo "/bin/sh"; echo "NODE:v22.16.0"; echo "LOGIN:/usr/bin/zsh"; exit 0 ;;',
    '  *echo\\ hi*) echo "hi"; exit 0 ;;',
    '  *true*) exit 0 ;;',
    '  *ls\\ -1Ap*) printf "Desktop/\\nDocuments/\\nreadme.md\\nnotes@\\nprog*\\n.hidden/\\n"; exit 0 ;;',
    '  *mkdir\\ -p*) exit 0 ;;',
    '  *) echo "unhandled:$CMD" >&2; exit 9 ;;',
    'esac',
  ].join('\n')
  writeFileSync(script, body + '\n')
  chmodSync(script, 0o755)
  return { script, logPath }
}

/** 组装 connector：spawnFn 记录 argv/env/detached/askpass 文件状态后走真 spawn。 */
function makeConnector({ sshBinary, muxDir, askpassDir, fakeLog, defaultTimeoutMs }) {
  process.env.FAKE_LOG = fakeLog
  const records = []
  const realSpawn = spawn
  const spawnFn = (file, args, opts) => {
    const askpassPath = opts.env?.SSH_ASKPASS
    let askpassBefore = undefined
    if (askpassPath && existsSync(askpassPath)) {
      askpassBefore = {
        content: readFileSync(askpassPath, 'utf8'),
        mode: (statSync(askpassPath).mode & 0o777).toString(8),
      }
    }
    records.push({ file, args, env: opts.env ?? {}, detached: Boolean(opts.detached), askpassBefore })
    return realSpawn(file, args, opts)
  }
  const connector = new SshConnector({ muxDir, askpassDir, spawnFn, defaultSshBinary: sshBinary, ...(defaultTimeoutMs ? { defaultTimeoutMs } : {}) })
  return { connector, records }
}

/** 释放暂存的假 ssh 环境变量。 */
function clearFakeEnv() {
  for (const key of ['FAKE_LOG', 'FAKE_SLEEP', 'FAKE_FAIL', 'FAKE_MUXDOWN', 'FAKE_SECRET']) delete process.env[key]
}

const targetKeyDraft = {
  kind: 'ssh',
  title: 'kali-pwn',
  ssh: { host: '192.168.184.131', port: 22, user: 'kali', auth: { type: 'key', identityFile: '/tmp/id_kali' } },
}

const targetPwDraft = {
  kind: 'ssh',
  title: 'pw-host',
  ssh: { host: '192.168.1.5', port: 22, user: 'root', auth: { type: 'password', password: 's3cr3t-pw!' } },
}

try {
  clearFakeEnv()

  // ── S0 redact 过滤器（纯函数）────────────────────────────────────
  {
    const masked = maskSecret('connecting with pw s3cr3t-pw! done', 's3cr3t-pw!')
    guard(masked.includes('***') && !masked.includes('s3cr3t-pw!'), `maskSecret 替换为 ***（${masked}）`)
    guard(maskSecret('no secret here', undefined) === 'no secret here', '无 secret 原样返回')
  }

  // ── S1 密钥认证：mux 参数 + OK 标记 + env 解析 ───────────────────
  {
    const { script, logPath } = writeFakeSsh()
    const muxDir = join(base, 'mux-1')
    mkdirSync(muxDir, { recursive: true })
    const { connector: c, records } = makeConnector({ sshBinary: script, muxDir, askpassDir: join(base, 'askpass-1'), fakeLog: logPath })
    const logs = []
    const { env } = await c.testConnect(targetKeyDraft, (line) => logs.push(line))
    guard(env.os === 'linux' && env.arch === 'x64', `os/arch 归一（${env.os}/${env.arch}）`)
    guard(env.uname === 'Linux x86_64', `uname 保留（${env.uname}）`)
    guard(env.shells.length === 3, `shells 3 个（${env.shells.map((s) => s.name).join(',')}）`)
    guard(env.shells[0].path === '/usr/bin/zsh' && env.shells[0].name === 'zsh', 'shells[0]=zsh')
    guard(env.node === 'v22.16.0', `node 版本（${env.node}）`)
    guard(env.defaultShell === '/usr/bin/zsh', `默认登录 shell（${env.defaultShell}）`)
    guard(logs.some((l) => l.level === 'INFO' && l.msg.includes('正在通过窗口 Host 连接 ssh kali-pwn')), 'INFO 连接头文案')
    guard(logs.some((l) => l.msg.includes('detecting remote env...')), 'detecting remote env...')
    guard(logs.some((l) => l.msg.includes('远程环境检测完成：linux/x64')), '远程环境检测完成')
    // mux 参数断言
    const first = records[0]
    guard(first && first.args.includes('-o'), '首次 spawn 为 ssh 主程序')
    const argsStr = JSON.stringify(first.args)
    guard(argsStr.includes('ControlMaster=auto'), 'ControlMaster=auto')
    guard(argsStr.includes(`ControlPath=${muxDir}/%C`), `ControlPath 指向 muxDir=%C（${muxDir}/%C）`)
    guard(argsStr.includes('ControlPersist=10m'), 'ControlPersist=10m')
    guard(argsStr.includes('ServerAliveInterval=15'), 'ServerAliveInterval=15')
    guard(argsStr.includes('ServerAliveCountMax=2'), 'ServerAliveCountMax=2')
    guard(first.args.includes('-p') && first.args[first.args.indexOf('-p') + 1] === '22', '-p 22')
    guard(argsStr.includes('-i') && argsStr.includes('/tmp/id_kali'), '密钥注入 -i')
    guard(argsStr.includes('BatchMode=yes') && argsStr.includes('IdentitiesOnly=yes'), '密钥 BatchMode+IdentitiesOnly')
    guard(!first.env.SSH_ASKPASS, '密钥认证无 askpass env')
    guard(first.args[first.args.length - 1].includes('echo __DSH_SSH_OK__'), '探活命令尾参')
    guard(first.args.includes('kali@192.168.184.131'), '目标 user@host')
    guard(logs.every((l) => l.level !== 'ERROR'), '密钥成功路径无 ERROR')
    await c.disposeAll()
  }

  // ── S1b Windows interop：mux 选项必须整体禁用（argv 级断言，不实执行）────
  {
    const { script, logPath } = writeFakeSsh()
    const muxDir = join(base, 'mux-1b')
    mkdirSync(muxDir, { recursive: true })
    const { connector: c } = makeConnector({ sshBinary: script, muxDir, askpassDir: join(base, 'askpass-1b'), fakeLog: logPath })
    const interopTarget = {
      kind: 'ssh', host: '192.168.184.131', port: 22, user: 'kali',
      auth: { type: 'key', identityFile: 'C:\\Users\\lyy\\.ssh\\id_ed25519_kali' },
      sshBinary: '/mnt/c/WINDOWS/System32/OpenSSH/ssh.exe',
    }
    const argv = c.buildSshArgv(interopTarget, { command: 'true' })
    const s = JSON.stringify(argv)
    guard(!s.includes('ControlMaster'), 'interop: 无 ControlMaster')
    guard(!s.includes('ControlPath'), 'interop: 无 ControlPath（WSL 路径对 Windows 进程无意义）')
    guard(!s.includes('ControlPersist'), 'interop: 无 ControlPersist')
    guard(s.includes('ServerAliveInterval=15'), 'interop: 保活选项保留')
    guard(argv[0] === '/mnt/c/WINDOWS/System32/OpenSSH/ssh.exe', 'interop: sshBinary 原样')
    guard(argv.includes('C:\\Users\\lyy\\.ssh\\id_ed25519_kali'), 'interop: identityFile Windows 路径原样（禁 wslpath 转换）')
    // 对照组：原生 ssh 仍有 mux
    const nativeArgv = c.buildSshArgv({ ...interopTarget, sshBinary: undefined }, { command: 'true' })
    guard(JSON.stringify(nativeArgv).includes('ControlMaster=auto'), '原生 ssh: ControlMaster=auto 保留')
    // interop 下 -O check 必须拒绝（无 mux socket 可控）
    let threw = ''
    try { c.buildSshArgv(interopTarget, { ctrl: 'check' }) } catch (e) { threw = e.message }
    guard(threw.includes('interop'), `interop: -O check 显式拒绝（${threw}）`)
    // tty：interop 必须 -tt（stdin 是 Windows 管道，-t 拒分配），原生保持 -t
    const ttyInterop = c.buildSshArgv(interopTarget, { tty: true, command: 'exec zsh -l' })
    guard(ttyInterop.includes('-tt'), 'interop: tty → -tt 强制分配伪终端')
    const ttyNative = c.buildSshArgv({ ...interopTarget, sshBinary: undefined }, { tty: true, command: 'exec zsh -l' })
    guard(ttyNative.includes('-t') && !ttyNative.includes('-tt'), '原生 ssh: tty → -t')
    await c.disposeAll()
  }

  // ── S2 密码认证：askpass 脚本生灭 + env + detached + DISPLAY ────
  {
    const { script, logPath } = writeFakeSsh()
    const askpassDir = join(base, 'askpass-2')
    const muxDir = join(base, 'mux-2')
    mkdirSync(askpassDir, { recursive: true })
    mkdirSync(muxDir, { recursive: true })
    const { connector: c, records } = makeConnector({ sshBinary: script, muxDir, askpassDir, fakeLog: logPath })
    const logs = []
    const { env } = await c.testConnect(targetPwDraft, (line) => logs.push(line))
    guard(env.os === 'linux', '密码认证也完成 env 探测')
    const withAskpass = records.filter((r) => r.env && r.env.SSH_ASKPASS)
    guard(withAskpass.length >= 2, `探活+env 探测均带 askpass env（实际 ${withAskpass.length} 次）`)
    const askpassPath = withAskpass[0].env.SSH_ASKPASS
    guard(askpassPath.startsWith(askpassDir), `askpass 落在 askpassDir（${askpassPath}）`)
    guard(withAskpass[0].env.SSH_ASKPASS_REQUIRE === 'force', 'SSH_ASKPASS_REQUIRE=force')
    guard(withAskpass[0].env.DISPLAY === 'dsh:0', 'DISPLAY=dsh:0')
    guard(withAskpass[0].detached === true, 'spawn detached:true')
    guard(withAskpass[0].askpassBefore !== undefined, 'spawn 时 askpass 脚本存在')
    guard(withAskpass[0].askpassBefore.mode === '700', `askpass 脚本 0700（${withAskpass[0].askpassBefore.mode}）`)
    guard(
      withAskpass[0].askpassBefore.content.includes(`printf '%s' 's3cr3t-pw!'`),
      `askpass 内容为 printf '%s' '...'（${JSON.stringify(withAskpass[0].askpassBefore.content.trim())}）`,
    )
    // 密码 redact：日志不得含明文
    guard(logs.every((l) => !l.msg.includes('s3cr3t-pw!')), '日志不含明文密码')
    // pipeline 结束后脚本被删
    guard(!existsSync(askpassPath), 'askpass 脚本 pipeline 后已删除')
    const askpassRemaining = readdirSync(askpassDir).filter((n) => n.startsWith('askpass-'))
    guard(askpassRemaining.length === 0, `askpass 目录无残留（${JSON.stringify(askpassRemaining)}）`)
    await c.disposeAll()
  }

  // ── S3 失败分类：认证失败 + 其它失败（含 redact 断言）────────────
  {
    // 3a. 认证失败
    const { script: s1, logPath: l1 } = writeFakeSsh()
    const mux1 = join(base, 'mux-3a')
    mkdirSync(mux1, { recursive: true })
    const { connector: c1 } = makeConnector({ sshBinary: s1, muxDir: mux1, askpassDir: join(base, 'askpass-3a'), fakeLog: l1 })
    process.env.FAKE_FAIL = 'permission'
    let thrown1 = ''
    const logs1 = []
    try {
      await c1.testConnect(targetPwDraft, (line) => logs1.push(line))
      fail('认证失败场景应当抛错')
    } catch (error) {
      thrown1 = error.message
    }
    clearFakeEnv()
    guard(thrown1.includes('认证失败'), `认证失败分类提示（${thrown1}）`)
    guard(logs1.some((l) => l.level === 'ERROR' && l.msg.includes('认证失败')), 'ERROR 行含认证失败分类')
    guard(logs1.every((l) => !l.msg.includes('s3cr3t-pw!')), '认证失败日志不含明文密码')
    await c1.disposeAll()

    // 3b. 失败且 stderr 含明文密码 → 分类消息被 redact
    const { script: s2, logPath: l2 } = writeFakeSsh()
    const mux2 = join(base, 'mux-3b')
    mkdirSync(mux2, { recursive: true })
    const { connector: c2 } = makeConnector({ sshBinary: s2, muxDir: mux2, askpassDir: join(base, 'askpass-3b'), fakeLog: l2 })
    process.env.FAKE_FAIL = 'other'
    process.env.FAKE_SECRET = 's3cr3t-pw!'
    let thrown2 = ''
    const logs2 = []
    try {
      await c2.testConnect(targetPwDraft, (line) => logs2.push(line))
      fail('其它失败场景应当抛错')
    } catch (error) {
      thrown2 = error.message
    }
    clearFakeEnv()
    guard(thrown2.includes('连接失败'), `其它失败分类提示（${thrown2}）`)
    guard(!thrown2.includes('s3cr3t-pw!'), `错误消息 redact（${thrown2}）`)
    guard(logs2.every((l) => !l.msg.includes('s3cr3t-pw!')), '失败日志不含明文密码')
    guard(logs2.some((l) => l.msg.includes('***')), '失败日志出现 *** 掩码')
    await c2.disposeAll()
  }

  // ── S4 超时 → 网络不可达 ─────────────────────────────────────────
  {
    const { script, logPath } = writeFakeSsh()
    const muxDir = join(base, 'mux-4')
    mkdirSync(muxDir, { recursive: true })
    // 注入较短的 defaultTimeoutMs（900ms）以便快速验证超时路径
    const { connector: c } = makeConnector({ sshBinary: script, muxDir, askpassDir: join(base, 'askpass-4'), fakeLog: logPath, defaultTimeoutMs: 900 })
    process.env.FAKE_SLEEP = '2' // sleep 2s > 900ms 探活超时
    let thrown = ''
    try {
      await c.testConnect(targetKeyDraft, () => {})
      fail('超时场景应当抛错')
    } catch (error) {
      thrown = error.message
    }
    clearFakeEnv()
    guard(thrown.includes('网络不可达'), `网络不可达分类提示（${thrown}）`)
    await c.disposeAll()
  }

  // ── S5 exec 骑 mux + check（-O check / 回退 exec true）+ 超时 + close ──
  {
    const { script, logPath } = writeFakeSsh()
    const muxDir = join(base, 'mux-5')
    mkdirSync(muxDir, { recursive: true })
    const { connector: c, records } = makeConnector({ sshBinary: script, muxDir, askpassDir: join(base, 'askpass-5'), fakeLog: logPath })
    await c.testConnect(targetKeyDraft, () => {}) // 建 mux
    const target = {
      connId: 'conn_test5',
      kind: 'ssh',
      host: '192.168.184.131',
      port: 22,
      user: 'kali',
      auth: { type: 'key', identityFile: '/tmp/id_kali' },
    }
    const execResult = await c.exec(target, 'echo hi && exit 0', { timeoutMs: 3000 })
    guard(execResult.code === 0, `exec 返回 code 0（${execResult.code}）`)
    guard(typeof execResult.stdout === 'string', 'exec stdout 字符串')
    const online = await c.check(target)
    guard(online === true, 'check → true（-O check 命中 mux）')
    // mux 挂 → 回退 exec true 仍 true
    process.env.FAKE_MUXDOWN = '1'
    const onlineFallback = await c.check(target)
    clearFakeEnv()
    guard(onlineFallback === true, 'mux 挂 → 回退 exec true 仍 true')
    // 超时：exec 抛超时
    process.env.FAKE_SLEEP = '2'
    let timeoutErr = ''
    try {
      await c.exec(target, 'sleep 1', { timeoutMs: 300 })
      fail('exec 超时应抛错')
    } catch (error) {
      timeoutErr = error.message
    }
    clearFakeEnv()
    guard(timeoutErr.includes('执行超时'), `exec 超时抛错（${timeoutErr}）`)
    // close：ssh -O exit
    await c.close('conn_test5', target)
    guard(records.some((r) => r.args.includes('-O') && r.args.includes('exit')), 'close → ssh -O exit')
    // check 再次探活（mux 已在 close 清除，回退 exec）
    const afterClose = await c.check(target)
    guard(afterClose === true, 'close 后 check 仍通过（回退 exec）')
    await c.disposeAll()
  }

  // ── S6 browse：ls 解析 + parent + mkdir ──────────────────────────
  {
    const { script, logPath } = writeFakeSsh()
    const muxDir = join(base, 'mux-6')
    mkdirSync(muxDir, { recursive: true })
    const { connector: c } = makeConnector({ sshBinary: script, muxDir, askpassDir: join(base, 'askpass-6'), fakeLog: logPath })
    const target = {
      connId: 'conn_test6',
      kind: 'ssh',
      host: 'h',
      port: 22,
      user: 'u',
      auth: { type: 'key', identityFile: '/tmp/id' },
    }
    const result = await c.browse(target, '/home/kali/pwn')
    guard(result.dir === '/home/kali/pwn', `dir 回显（${result.dir}）`)
    guard(result.parent === '/home/kali', `parent 推导（${result.parent}）`)
    const byName = Object.fromEntries(result.entries.map((e) => [e.name, e.type]))
    guard(byName.Desktop === 'dir', 'Desktop → dir')
    guard(byName.Documents === 'dir', 'Documents → dir')
    guard(byName['readme.md'] === 'file', 'readme.md → file')
    guard(byName.notes === 'link', 'notes → link（@）')
    guard(byName.prog === 'file', 'prog → file（* 剥离）')
    guard(byName['.hidden'] === 'dir', '.hidden → dir（隐藏保留）')
    // mkdir 字段
    await c.mkdir(target, '/home/kali/pwn', 'newdir')
    guard(true, 'mkdir -p 执行成功')
    await c.disposeAll()
  }

  console.log('\n[connector] ✅ 全部通过')
} catch (error) {
  console.error('[connector] FAIL: 未捕获异常')
  console.error(error)
  process.exit(1)
} finally {
  rmSync(base, { recursive: true, force: true })
}