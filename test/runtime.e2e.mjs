/**
 * dsh-remote 运行时离线 e2e（SPEC-M2 R1 三个测试面）：
 *
 * 1) 构建：build-runtime.mjs 无内置 node 产物存在、manifest 组件 sha256 与解压内容
 *    一致、tar 可解；另以假 node 资产验证 --with-node 的三组件（optional）路径。
 * 2) 协议：spawn <解压>/dsh-remote-server.cjs --stdio —— hello 首行 →
 *    ping → hello 方法 → fs.list（dir/file/link 分类、目录优先、parent）→
 *    fs.mkdir 递归幂等 → fs.list 不存在 NOT_FOUND → 未知方法 UNKNOWN_METHOD →
 *    坏 JSON BAD_JSON 进程不死 → 后续 ping 恢复 → --version → kill。
 * 3) start.sh：伪造目录结构（无 node/bin/node）走系统 node 出 hello；
 *    无 node 可解析（PATH 指向不存在目录，等效 SPEC 的 env -i 语义）→ exit 127。
 *
 * 纯 node 运行：`node test/runtime.e2e.mjs`；退出码 0/非 0 表成败。
 */

import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACT_DIR = join(ROOT, 'assets', 'runtime')
const BUILD_SCRIPT = join(ROOT, 'scripts', 'build-runtime.mjs')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

const fail = (reason) => {
  console.error('[runtime] FAIL:', reason)
  process.exit(1)
}
const guard = (condition, label) => {
  if (!condition) fail(label)
  console.log(`[runtime] ok: ${label}`)
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 运行构建脚本，返回 spawnSync 结果（失败时打印输出）。 */
function runBuild(args = []) {
  const res = spawnSync(process.execPath, [BUILD_SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  if (res.status !== 0) {
    console.error(res.stdout)
    console.error(res.stderr)
    fail(`build-runtime ${args.join(' ') || '(默认)'} 退出码 ${res.status}`)
  }
  return res
}

/** 按行读取子进程 stdout（缓冲 + 等待队列，避免粘包）。 */
function makeLines(child) {
  let buffer = ''
  const queue = []
  const waiters = []
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      if (waiters.length > 0) waiters.shift()(line)
      else queue.push(line)
    }
  })
  return {
    next(timeoutMs = 8000) {
      if (queue.length > 0) return Promise.resolve(queue.shift())
      return new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('等待响应超时')), timeoutMs)
        waiters.push((line) => {
          clearTimeout(timer)
          _resolve(line)
        })
      })
    },
  }
}

let nextId = 1

/** 发一行请求并等对应响应行。 */
async function call(child, lines, method, params) {
  const id = nextId++
  child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
  const line = await lines.next()
  return JSON.parse(line)
}

function onceClose(child, timeoutMs = 8000) {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('子进程未在预期内退出')), timeoutMs)
    child.once('close', () => {
      clearTimeout(timer)
      _resolve()
    })
  })
}

async function killChild(child) {
  try {
    child.kill('SIGKILL')
  } catch {
    // 已退出
  }
  await onceClose(child)
}

// ---------------------------------------------------------------------------
// 测试面 1：构建产物与 manifest
// ---------------------------------------------------------------------------

function verifyManifest(extractDir, expectedPaths, label) {
  const manifest = JSON.parse(readFileSync(join(extractDir, 'manifest.json'), 'utf8'))
  guard(manifest.name === 'dsh-remote' && manifest.version === VERSION && manifest.platform === 'linux-x64', `${label}: manifest 元信息`)
  guard(manifest.requiresNode === '>=18', `${label}: requiresNode`)
  const paths = manifest.components.map((c) => c.path)
  for (const p of expectedPaths) {
    guard(paths.includes(p), `${label}: 组件路径包含 ${p}`)
  }
  for (const comp of manifest.components) {
    const file = join(extractDir, comp.path)
    guard(existsSync(file), `${label}: 组件文件存在 ${comp.path}`)
    const bytes = readFileSync(file)
    const sha = createHash('sha256').update(bytes).digest('hex')
    guard(sha === comp.sha256, `${label}: 组件 sha256 一致 ${comp.path}`)
    guard(bytes.byteLength === comp.bytes, `${label}: 组件 bytes 一致 ${comp.path}`)
  }
  return manifest
}

function extractTar(tarPath, label) {
  guard(existsSync(tarPath) && statSync(tarPath).size > 0, `${label}: tar 产物存在且非空`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-extract-'))
  const res = spawnSync('tar', ['-xzf', tarPath, '-C', dir])
  guard(res.status === 0, `${label}: tar 可解压`)
  return dir
}

const fakeNodePath = join(ROOT, 'assets', 'node', 'linux-x64', 'bin', 'node')
mkdirSync(dirname(fakeNodePath), { recursive: true })
// 真 node 资产可能已就位（fetch-node / 手工拷贝）：备份后写假 node，清理时恢复，避免破坏资产。
const nodeBackupPath = `${fakeNodePath}.bak-e2e`
const hadRealNode = existsSync(fakeNodePath)
if (hadRealNode) renameSync(fakeNodePath, nodeBackupPath)
writeFileSync(fakeNodePath, '#!/bin/sh\nexit 0\n') // 假 node：只验证组件打包路径，不被执行

// 1a) --with-node + 假 node 资产 → 三组件（含 optional node）
// 注意契约修订（主代理）：with-node 变体输出 `dsh-remote-<v>-<platform>.with-node.tar.gz`，与 slim 并存。
runBuild(['--with-node'])
const tarWith = join(ARTIFACT_DIR, `dsh-remote-${VERSION}-linux-x64.with-node.tar.gz`)
const extractWith = extractTar(tarWith, '1a')
const manifestWith = verifyManifest(extractWith, ['dsh-remote-server.cjs', 'start.sh', 'node/bin/node'], '1a: with-node 三组件')
const nodeComp = manifestWith.components.find((c) => c.path === 'node/bin/node')
guard(nodeComp && nodeComp.optional === true, '1a: node 组件 optional 标记')

// 清理假 node 资产（保持仓库干净，后续无 node 构建不受影响）；恢复真 node 备份。
rmSync(fakeNodePath, { force: true })
if (hadRealNode) renameSync(nodeBackupPath, fakeNodePath)

// 1b) 无 node 构建 → 最终产物（两组件）且组件 sha256 与解压内容一致
runBuild([])
const tarPath = join(ARTIFACT_DIR, `dsh-remote-${VERSION}-linux-x64.tar.gz`)
const extractDir = extractTar(tarPath, '1b')
const manifest = verifyManifest(extractDir, ['dsh-remote-server.cjs', 'start.sh'], '1b: 两组件')
guard(manifest.components.every((c) => c.optional === undefined), '1b: 无 node 变体不含 optional 组件')
const serverCjsBytes = statSync(join(extractDir, 'dsh-remote-server.cjs')).size
guard(serverCjsBytes < 50_000, `1b: dsh-remote-server.cjs < 50KB（实际 ${serverCjsBytes} bytes）`)
guard((statSync(join(extractDir, 'start.sh')).mode & 0o111) !== 0, '1b: start.sh 可执行位保留')

// ---------------------------------------------------------------------------
// 测试面 2：stdio JSON-RPC 协议
// ---------------------------------------------------------------------------

async function protocolTest() {
  const serverPath = join(extractDir, 'dsh-remote-server.cjs')
  const child = spawn(process.execPath, [serverPath, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = makeLines(child)

  // hello 首行（非请求响应）
  const hello = JSON.parse(await lines.next())
  guard(hello.type === 'dsh-remote-hello', '2: hello 首行类型')
  guard(hello.version === VERSION, '2: hello version')
  guard(['linux', 'darwin', 'win32'].includes(hello.platform), '2: hello platform 归一')
  guard(typeof hello.arch === 'string' && hello.arch.length > 0, '2: hello arch')
  guard(typeof hello.node === 'string' && hello.node.startsWith('v'), '2: hello node')

  // ping
  const ping = await call(child, lines, 'ping', {})
  guard(ping.id !== undefined && ping.result && ping.result.version === VERSION, '2: ping result 结构与 version')
  guard(typeof ping.result.uptimeMs === 'number' && ping.result.uptimeMs >= 0, '2: ping uptimeMs')
  guard(typeof ping.result.pid === 'number' && ping.result.pid > 0, '2: ping pid')

  // hello 方法
  const hello2 = await call(child, lines, 'hello', {})
  guard(hello2.result.home === homedir(), '2: hello 方法 home')
  guard(hello2.result.node === process.version && hello2.result.version === VERSION, '2: hello 方法 version/node')
  guard(hello2.result.platform === hello.platform && hello2.result.arch === hello.arch, '2: hello 方法 platform/arch')

  // fs.list：dir/file/link 分类正确、目录优先、parent
  const listDir = mkdtempSync(join(tmpdir(), 'dsh-remote-list-'))
  mkdirSync(join(listDir, 'zdir'))
  mkdirSync(join(listDir, 'bdir'))
  writeFileSync(join(listDir, 'afile.txt'), 'x')
  symlinkSync(join(listDir, 'afile.txt'), join(listDir, 'clink'))
  const list = await call(child, lines, 'fs.list', { dir: listDir })
  guard(list.result.dir === listDir, '2: fs.list dir 回显')
  const types = Object.fromEntries(list.result.entries.map((e) => [e.name, e.type]))
  guard(types['zdir'] === 'dir' && types['bdir'] === 'dir' && types['afile.txt'] === 'file' && types['clink'] === 'link', '2: fs.list 分类')
  guard(list.result.entries[0]?.type === 'dir', '2: fs.list 目录优先排序')
  const dirNames = list.result.entries.filter((e) => e.type === 'dir').map((e) => e.name)
  guard(dirNames[0] === 'bdir' && dirNames[1] === 'zdir', '2: fs.list 目录组内按名排序')
  const fileNames = list.result.entries.filter((e) => e.type !== 'dir').map((e) => e.name)
  guard(fileNames[0] === 'afile.txt' && fileNames[1] === 'clink', '2: fs.list 文件组排序')
  guard(list.result.parent === dirname(listDir), '2: fs.list parent')

  // fs.mkdir：递归创建 + 幂等
  const mkDir = join(listDir, 'a', 'b', 'c')
  const mk1 = await call(child, lines, 'fs.mkdir', { dir: mkDir })
  guard(mk1.result?.dir === mkDir && existsSync(mkDir), '2: fs.mkdir 递归创建')
  const mk2 = await call(child, lines, 'fs.mkdir', { dir: mkDir })
  guard(mk2.result?.dir === mkDir && mk2.error === undefined, '2: fs.mkdir 已存在幂等成功')

  // fs.list 不存在目录 → NOT_FOUND
  const nf = await call(child, lines, 'fs.list', { dir: join(listDir, 'no-such') })
  guard(nf.error?.code === 'NOT_FOUND', '2: fs.list NOT_FOUND')
  // fs.list 参数缺失 → 非空校验错误（BAD_REQUEST）
  const badParams = await call(child, lines, 'fs.list', {})
  guard(badParams.error?.code === 'BAD_REQUEST', '2: fs.list 缺 dir 参数 BAD_REQUEST')

  // 未知方法 → UNKNOWN_METHOD
  const unknown = await call(child, lines, 'no.such.method', {})
  guard(unknown.error?.code === 'UNKNOWN_METHOD', '2: UNKNOWN_METHOD')

  // 坏 JSON：进程不死 + 回 BAD_JSON（id:null）
  child.stdin.write('{not-json\n')
  const bad = JSON.parse(await lines.next())
  guard(bad.id === null && bad.error?.code === 'BAD_JSON', '2: 坏 JSON → BAD_JSON id=null')

  // 坏 JSON 之后 ping 仍正常（进程未死）
  const ping2 = await call(child, lines, 'ping', {})
  guard(ping2.result?.pid === ping.result.pid, '2: BAD_JSON 后 ping 恢复')

  await killChild(child)
}

// ---------------------------------------------------------------------------
// 测试面 2b：--version CLI
// ---------------------------------------------------------------------------

function versionCliTest() {
  const serverPath = join(extractDir, 'dsh-remote-server.cjs')
  const res = spawnSync(process.execPath, [serverPath, '--version'], { encoding: 'utf8' })
  guard(res.status === 0 && res.stdout.trim() === VERSION, '2b: --version 打印版本退出')
}

// ---------------------------------------------------------------------------
// 测试面 3：start.sh
// ---------------------------------------------------------------------------

async function startShTest() {
  // 伪造目录结构：仅 start.sh + server.cjs，无 node/bin/node
  const shDir = mkdtempSync(join(tmpdir(), 'dsh-remote-sh-'))
  copyFileSync(join(extractDir, 'start.sh'), join(shDir, 'start.sh'))
  copyFileSync(join(extractDir, 'dsh-remote-server.cjs'), join(shDir, 'dsh-remote-server.cjs'))
  chmodSync(join(shDir, 'start.sh'), 0o755)

  // 3a) 系统 node：构造 PATH 里的 node（软链到真实 node），无内置 node 可跑通出 hello
  const fakeBinDir = mkdtempSync(join(tmpdir(), 'dsh-remote-bin-'))
  symlinkSync(process.execPath, join(fakeBinDir, 'node'))
  const pathEnv = [fakeBinDir, process.env.PATH || ''].join(':')
  const child = spawn('/bin/sh', [join(shDir, 'start.sh'), '--stdio'], {
    env: { ...process.env, PATH: pathEnv },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = makeLines(child)
  const hello3 = JSON.parse(await lines.next())
  guard(hello3.type === 'dsh-remote-hello', '3a: start.sh 系统 node 出 hello')
  guard(hello3.version === VERSION, '3a: start.sh hello version')
  await killChild(child)

  // 3b) 无 node 场景 → exit 127 + 明确报错。
  // 注意：dash 把「PATH 为空字符串」当作未设置，回落到默认搜索路径（/usr/bin 等），
  // 仍可能找到系统 node（本机即有 v26 系统 node）；因此把 PATH 指向不存在的目录，
  // 让命令查找（含默认路径回落）彻底失败，等价于 SPEC 的 env -i 无 node 语义。
  const res127 = spawnSync('/bin/sh', [join(shDir, 'start.sh'), '--stdio'], { env: { PATH: '/__dsh_no_node__' }, encoding: 'utf8' })
  guard(res127.status === 127, '3b: 无 node 场景 exit 127')
  guard(res127.stderr.includes('未找到可用 node'), '3b: stderr 含未找到可用 node 提示')
  console.log('  [runtime] (3b stderr 预览):', res127.stderr.trim().split('\n').slice(-2).join(' | '))
}

// ---------------------------------------------------------------------------

async function main() {
  await protocolTest()
  versionCliTest()
  await startShTest()
  console.log('[runtime] ✅ 全部通过')
}

main().catch((error) => {
  console.error('[runtime] FAIL:', error)
  process.exit(1)
})