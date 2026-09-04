/**
 * dsh-remote 运行时 M5 契约 B 离线 e2e：新增 fs.* 方法与 exec 的 stdio JSON-RPC 全真演练。
 *
 * 场景（临时目录真文件）：
 *   1. 构建 + 解压：dsh-remote-server.cjs 产物就绪；manifest 含 tools/rg（rg 资产缺失时仅告警跳过）。
 *   2. fs.stat 三态：文件（exists/isFile/size/mtimeMs）、目录（isDir）、不存在（exists:false 不报错）。
 *   3. fs.writeText：普通写（bytes=字节数）；createParents=true 逐级建父目录；
 *      父目录缺失且未 createParents → NOT_FOUND。
 *   4. fs.readText：整读回环；maxBytes 截断（text + truncated）；中文多字节切尾回退；
 *      不存在的文件 → NOT_FOUND。
 *   5. fs.readBytes：二进制内容的 base64 往返；maxBytes 截断（truncated）。
 *   6. fs.listDir：dir/file/link 分类、目录优先排序；缺失目录 → NOT_FOUND。
 *   7. fs.editText：单次命中替换；未命中 → NO_MATCH（文件不变）；多处未 replaceAll → AMBIGUOUS
 *      （文件不变）；replaceAll=true 全部替换；空 oldText → NO_MATCH。
 *   8. exec：echo 输出与退出码；stderr 分离；cwd 生效；退出码透传；超时杀进程组
 *      （sleep 后台子进程一并消失，进程不死 ping 恢复）；参数缺失 → BAD_REQUEST。
 *   9. 收尾：BAD_JSON 健壮性（进程不死）+ 清理临时目录。
 *
 * 纯 node 运行：`node test/runtime-m5.e2e.mjs`；退出码 0/非 0 表成败。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ARTIFACT_DIR = join(ROOT, 'assets', 'runtime')
const BUILD_SCRIPT = join(ROOT, 'scripts', 'build-runtime.mjs')
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version

const fail = (reason) => {
  console.error('[runtime-m5] FAIL:', reason)
  process.exit(1)
}
const guard = (condition, label) => {
  if (!condition) fail(label)
  console.log(`[runtime-m5] ok: ${label}`)
}

// ---------------------------------------------------------------------------
// 小工具（与 runtime.e2e.mjs 同款：按行缓冲 + 等待队列，规避粘包）
// ---------------------------------------------------------------------------

function runBuild(args = []) {
  const res = spawnSync(process.execPath, [BUILD_SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  if (res.status !== 0) {
    console.error(res.stdout)
    console.error(res.stderr)
    fail(`build-runtime ${args.join(' ') || '(默认)'} 退出码 ${res.status}`)
  }
  return res
}

function extractTar(tarPath, label) {
  guard(existsSync(tarPath) && statSync(tarPath).size > 0, `${label}: tar 产物存在且非空`)
  const dir = mkdtempSync(join(tmpdir(), 'dsh-remote-m5-extract-'))
  const res = spawnSync('tar', ['-xzf', tarPath, '-C', dir])
  guard(res.status === 0, `${label}: tar 可解压`)
  return dir
}

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
// 主测试流程
// ---------------------------------------------------------------------------

async function main() {
  // 0) 构建 slim 变体并解压（与 fetch-rg 无关也能跑：rg 资产缺失时构建仅告警跳过）
  runBuild([])
  const tarPath = join(ARTIFACT_DIR, `dsh-remote-${VERSION}-linux-x64.tar.gz`)
  const serverDir = extractTar(tarPath, '0')

  // manifest 含 tools/rg（rg 资产就位时；缺失时构建已告警，此处跳过断言）
  const manifest = JSON.parse(readFileSync(join(serverDir, 'manifest.json'), 'utf8'))
  const manifestPaths = manifest.components.map((c) => c.path)
  if (manifestPaths.includes('tools/rg')) {
    guard(existsSync(join(serverDir, 'tools', 'rg')), '0: tools/rg 组件（含 rg 资产）入包且文件存在')
    guard((statSync(join(serverDir, 'tools', 'rg')).mode & 0o111) !== 0, '0: tools/rg 可执行位保留')
  } else {
    console.log('[runtime-m5] warn: rg 资产缺失，跳过 tools/rg manifest 断言（先跑 scripts/fetch-rg.mjs）')
  }

  // 1) 起 server --stdio，握手
  const serverPath = join(serverDir, 'dsh-remote-server.cjs')
  const child = spawn(process.execPath, [serverPath, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] })
  const lines = makeLines(child)
  const hello = JSON.parse(await lines.next())
  guard(hello.type === 'dsh-remote-hello' && hello.version === VERSION, '1: hello 首行与版本')

  // 工作目录
  const work = mkdtempSync(join(tmpdir(), 'dsh-remote-m5-'))

  // 2) fs.stat 三态
  const statMissing = await call(child, lines, 'fs.stat', { path: join(work, 'nope') })
  guard(statMissing.error === undefined && statMissing.result.exists === false, '2: fs.stat 不存在 → exists:false 不报错')
  const statFile = join(work, 'a.txt')
  writeFileSync(statFile, 'hello')
  const stF = await call(child, lines, 'fs.stat', { path: statFile })
  guard(stF.result.exists === true && stF.result.isFile === true && stF.result.isDir === false, '2: fs.stat 文件 exists/isFile/isDir')
  guard(stF.result.size === 5 && typeof stF.result.mtimeMs === 'number' && stF.result.mtimeMs > 0, '2: fs.stat 文件 size/mtimeMs')
  const statDir = join(work, 'ad')
  mkdirSync(statDir)
  const stD = await call(child, lines, 'fs.stat', { path: statDir })
  guard(stD.result.exists === true && stD.result.isDir === true && stD.result.isFile === false, '2: fs.stat 目录 isDir')

  // 3) fs.writeText：普通写 + createParents + 缺父目录
  const wt1 = await call(child, lines, 'fs.writeText', { path: join(work, 'w.txt'), text: '你好, world\n' })
  guard(wt1.result.bytes === Buffer.byteLength('你好, world\n', 'utf8'), '3: fs.writeText 普通写 bytes')
  guard(readFileSync(join(work, 'w.txt'), 'utf8') === '你好, world\n', '3: fs.writeText 内容落盘')
  const nested = join(work, 'p1', 'p2', 'w2.txt')
  const wt2 = await call(child, lines, 'fs.writeText', { path: nested, text: 'x', createParents: true })
  guard(wt2.result.bytes === 1 && existsSync(nested), '3: fs.writeText createParents=true 建父目录')
  const wtMissing = await call(child, lines, 'fs.writeText', { path: join(work, 'no', 'dir', 'w3.txt'), text: 'y' })
  guard(wtMissing.error?.code === 'NOT_FOUND', '3: fs.writeText 父目录缺失且未 createParents → NOT_FOUND')

  // 4) fs.readText：整读、截断、中文切尾回退、缺失
  const rtFull = await call(child, lines, 'fs.readText', { path: join(work, 'w.txt') })
  guard(rtFull.result.text === '你好, world\n' && rtFull.result.truncated === false, '4: fs.readText 整读回环')
  const longFile = join(work, 'long.txt')
  writeFileSync(longFile, 'abcdefghij')
  const rtCut = await call(child, lines, 'fs.readText', { path: longFile, maxBytes: 4 })
  guard(rtCut.result.text === 'abcd' && rtCut.result.truncated === true, '4: fs.readText maxBytes 截断（truncated）')
  const cnFile = join(work, 'cn.txt')
  writeFileSync(cnFile, '你好x')
  const rtCn = await call(child, lines, 'fs.readText', { path: cnFile, maxBytes: 4 })
  // 4 字节切断"好"的首字节（3+1）；回退到完整字符 "你"
  guard(rtCn.result.text === '你' && rtCn.result.truncated === true, '4: fs.readText 中文多字节切尾回退')
  const rtMissing = await call(child, lines, 'fs.readText', { path: join(work, 'missing.txt') })
  guard(rtMissing.error?.code === 'NOT_FOUND', '4: fs.readText 缺失 → NOT_FOUND')

  // 5) fs.readBytes：二进制 base64 往返 + 截断
  const bin = Buffer.from([0, 1, 2, 254, 255, 65, 66, 0])
  const binFile = join(work, 'bin.dat')
  writeFileSync(binFile, bin)
  const rbFull = await call(child, lines, 'fs.readBytes', { path: binFile })
  guard(Buffer.from(rbFull.result.base64, 'base64').equals(bin) && rbFull.result.truncated === false, '5: fs.readBytes base64 往返')
  const rbCut = await call(child, lines, 'fs.readBytes', { path: binFile, maxBytes: 3 })
  guard(Buffer.from(rbCut.result.base64, 'base64').equals(bin.subarray(0, 3)) && rbCut.result.truncated === true, '5: fs.readBytes maxBytes 截断')

  // 6) fs.listDir：分类 + 目录优先排序 + 缺失
  const ldDir = join(work, 'ldir')
  mkdirSync(ldDir)
  mkdirSync(join(ldDir, 'zdir'))
  writeFileSync(join(ldDir, 'afile'), 'x')
  symlinkSync(join(ldDir, 'afile'), join(ldDir, 'clink'))
  const ld = await call(child, lines, 'fs.listDir', { path: ldDir })
  const types = Object.fromEntries(ld.result.entries.map((e) => [e.name, e.type]))
  guard(types['zdir'] === 'dir' && types['afile'] === 'file' && types['clink'] === 'link', '6: fs.listDir 分类')
  guard(ld.result.entries[0]?.name === 'zdir', '6: fs.listDir 目录优先排序')
  const ldMissing = await call(child, lines, 'fs.listDir', { path: join(work, 'ldir-missing') })
  guard(ldMissing.error?.code === 'NOT_FOUND', '6: fs.listDir 缺失 → NOT_FOUND')

  // 7) fs.editText：命中 / NO_MATCH / AMBIGUOUS / replaceAll / 空 oldText
  const editFile = join(work, 'edit.txt')
  writeFileSync(editFile, 'aXbc') // 单处 X
  const ed1 = await call(child, lines, 'fs.editText', { path: editFile, oldText: 'X', newText: 'Y' })
  guard(ed1.result.replacements === 1 && readFileSync(editFile, 'utf8') === 'aYbc', '7: fs.editText 单次命中替换')
  const edNoMatch = await call(child, lines, 'fs.editText', { path: editFile, oldText: 'ZZ', newText: 'Q' })
  guard(edNoMatch.error?.code === 'NO_MATCH' && readFileSync(editFile, 'utf8') === 'aYbc', '7: fs.editText 未命中 → NO_MATCH 且文件不变')
  writeFileSync(editFile, 'aXbXc')
  const edAmb2 = await call(child, lines, 'fs.editText', { path: editFile, oldText: 'X', newText: 'Z' })
  guard(edAmb2.error?.code === 'AMBIGUOUS' && readFileSync(editFile, 'utf8') === 'aXbXc', '7: fs.editText 多处未 replaceAll → AMBIGUOUS 且文件不变')
  const edAll = await call(child, lines, 'fs.editText', { path: editFile, oldText: 'X', newText: 'Z', replaceAll: true })
  guard(edAll.result.replacements === 2 && readFileSync(editFile, 'utf8') === 'aZbZc', '7: fs.editText replaceAll=true 全部替换')
  const edEmpty = await call(child, lines, 'fs.editText', { path: editFile, oldText: '', newText: 'K' })
  guard(edEmpty.error?.code === 'NO_MATCH', '7: fs.editText 空 oldText → NO_MATCH')
  // CRLF 文件编辑后保持 CRLF（fs-local 语义：LF 归一匹配、写回还原）
  const crlfFile = join(work, 'crlf.txt')
  writeFileSync(crlfFile, 'a\r\nb\r\nc')
  const edCrlf = await call(child, lines, 'fs.editText', { path: crlfFile, oldText: 'a\nb', newText: 'A\nB' })
  guard(edCrlf.result.replacements === 1 && readFileSync(crlfFile, 'utf8') === 'A\r\nB\r\nc', '7: fs.editText CRLF 保持')

  // 8) exec：echo / 退出码 / stderr / cwd / 超时杀
  const ex1 = await call(child, lines, 'exec', { command: 'echo hi-m5' })
  guard(ex1.result.code === 0 && ex1.result.stdout.trim() === 'hi-m5' && ex1.result.stderr === '', '8: exec echo 与退出码 0')
  const ex2 = await call(child, lines, 'exec', { command: 'echo out; echo err >&2; exit 3' })
  guard(ex2.result.code === 3 && ex2.result.stdout.trim() === 'out' && ex2.result.stderr.trim() === 'err', '8: exec stderr 分离与退出码透传')
  const exCwd = join(work, 'excwd')
  mkdirSync(exCwd)
  const ex3 = await call(child, lines, 'exec', { command: 'pwd', cwd: exCwd })
  guard(ex3.result.code === 0 && ex3.result.stdout.trim() === exCwd, '8: exec cwd 生效')
  const exBad = await call(child, lines, 'exec', { command: '' })
  guard(exBad.error?.code === 'BAD_REQUEST', '8: exec 空 command → BAD_REQUEST')

  // 超时杀进程组：sleep 后台子进程（组内）一并终止；进程不死，可继续 ping
  const t0 = Date.now()
  const exTimeout = await call(child, lines, 'exec', { command: 'sleep 30 & wait', timeoutMs: 600 })
  const elapsed = Date.now() - t0
  const sleepingGone = !spawnSync('sh', ['-c', `ps -eo args | grep '[s]leep 30' | grep -v grep`], { encoding: 'utf8' }).stdout.trim()
  guard(exTimeout.result.code === null && elapsed < 3000, `8: exec 超时杀（elapsed=${elapsed}ms，code=${exTimeout.result.code}）`)
  guard(sleepingGone, '8: exec 超时杀死整个进程组（sleep 30 后台子进程已消失）')
  const pingAfter = await call(child, lines, 'ping', {})
  guard(pingAfter.result?.pid > 0, '8: 超时后进程不死（ping 恢复）')

  // 9) BAD_JSON 健壮性依旧
  child.stdin.write('{nope\n')
  const bad = JSON.parse(await lines.next())
  guard(bad.id === null && bad.error?.code === 'BAD_JSON', '9: 坏 JSON → BAD_JSON 且进程不死')
  const pingAfterBad = await call(child, lines, 'ping', {})
  guard(pingAfterBad.result?.pid === pingAfter.result.pid, '9: BAD_JSON 后 ping 恢复')

  await killChild(child)
  rmSync(work, { recursive: true, force: true })
  rmSync(serverDir, { recursive: true, force: true })
  console.log('[runtime-m5] ✅ 全部通过')
}

main().catch((error) => {
  console.error('[runtime-m5] FAIL:', error)
  process.exit(1)
})