/**
 * dsh-remote 远端运行时 —— stdio JSON-RPC server（换行分隔 JSON）。
 *
 * 协议（SPEC-M2 R1 + M5 契约 B）：
 * - 启动即向 stdout 打印一行 hello（非请求响应）：
 *   {"type":"dsh-remote-hello","version":"0.2.0","platform":"linux","arch":"x64","node":"v22.22.2"}
 * - 请求 {"id":<number|string>,"method":"...","params":{...}}
 * - 响应 {"id":<同>,"result":...} 或 {"id":<同>,"error":{"code":"...","message":"..."}}
 * - 健壮性：单行 JSON 解析失败 → BAD_JSON（id:null）继续循环（进程不死）；
 *   未知 method → UNKNOWN_METHOD；单方法抛错 → INTERNAL 带 message。
 * - 方法可返回 Promise：结果/错误仍走同一条换行 JSON 帧（exec 异步、fs.* 同步）。
 * - stderr 只写日志（host 侧把 stderr 行当日志），stdout 只走协议。
 * - 零 npm 依赖，只用 node: 内置模块；--version 打印版本退出。
 * - 方法（M2 冻结）：ping / hello / fs.list / fs.mkdir。
 * - 方法（M5 新增）：fs.stat / fs.readText / fs.readBytes / fs.writeText /
 *   fs.listDir / fs.editText / exec（语义对齐 fs-local，差异见各实现注释）。
 * - 错误词汇表：M2 冻结 BAD_JSON/UNKNOWN_METHOD/INTERNAL/NOT_FOUND/NOT_DIR/
 *   EACCES/BAD_REQUEST；M5 增补 NO_MATCH/AMBIGUOUS（fs.editText，对齐
 *   fs-local 的 FS_EDIT_NOT_FOUND/FS_AMBIGUOUS_EDIT）与 NOT_TEXT（二进制/非法
 *   UTF-8，对齐 fs-local 的 FS_NOT_TEXT）。
 */

import { createInterface } from 'node:readline'
import { spawn } from 'node:child_process'
import {
  readdirSync, mkdirSync, statSync, openSync, fstatSync, readSync, closeSync, writeFileSync,
  type Dirent,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'

// 版本常量：构建期由 scripts/build-runtime.mjs 用 esbuild define 注入
// （--define:__DSH_REMOTE_VERSION__='"…"'）；直跑源码未注入时回退到与
// package.json 保持一致的默认值（typeof 探活避免未定义标识符抛 ReferenceError）。
const VERSION: string = (typeof __DSH_REMOTE_VERSION__ === 'string' && __DSH_REMOTE_VERSION__) || '0.2.0'

/** JSON-RPC 业务错误：code 来自协议词汇表（见文件头；M5 增 NO_MATCH/AMBIGUOUS/NOT_TEXT）。 */
class RpcError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

/** process.platform 归一为协议词汇 linux|darwin|win32（unix 系统一归 linux）。 */
function normalizePlatform(raw: string): string {
  if (raw === 'darwin') return 'darwin'
  if (raw.startsWith('win')) return 'win32'
  // linux/freebsd/sunos/aix 等一律归 linux（M2 只交付 linux-x64 变体）
  return 'linux'
}

/** 向 stdout 写一行协议数据（唯一出口，绝不含日志）。 */
function writeLine(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

/** 与 M1 browse 同形状的目录列表结果。 */
interface ListEntry {
  name: string
  type: 'dir' | 'file' | 'link'
}

function parentOf(dir: string): string | undefined {
  let trimmed = dir
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1)
  const index = trimmed.lastIndexOf('/')
  if (index <= 0) return undefined
  return trimmed.slice(0, index) || undefined
}

/** 把底层 fs 错误映射为协议错误：ENOENT→NOT_FOUND / ENOTDIR|EISDIR→NOT_DIR / EACCES|EPERM→EACCES。 */
function fsError(action: string, dir: string, error: unknown): RpcError {
  const code = (error as { code?: string }).code
  if (code === 'ENOENT') return new RpcError('NOT_FOUND', `${action}失败：${dir} 不存在`)
  if (code === 'ENOTDIR' || code === 'EISDIR') return new RpcError('NOT_DIR', `${action}失败：${dir} 不是目录/是目录`)
  if (code === 'EACCES' || code === 'EPERM') return new RpcError('EACCES', `${action}失败：${dir} 无权限`)
  return new RpcError('INTERNAL', `${action}失败：${error instanceof Error ? error.message : String(error)}`)
}

/** 收集目录条目：目录优先排序（dir 组内与 file/link 组内均按名称字节序），与 M1 browse 同形状。 */
function collectEntries(dir: string): ListEntry[] {
  let isDir: boolean
  try {
    isDir = statSync(dir).isDirectory()
  } catch (error) {
    throw fsError('读取目录', dir, error)
  }
  if (!isDir) throw new RpcError('NOT_DIR', `${dir} 不是目录`)
  let names: Dirent[]
  try {
    names = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    throw fsError('读取目录', dir, error)
  }
  const dirs: ListEntry[] = []
  const others: ListEntry[] = []
  for (const ent of names) {
    const type: ListEntry['type'] = ent.isDirectory() ? 'dir' : ent.isSymbolicLink() ? 'link' : 'file'
    ;(type === 'dir' ? dirs : others).push({ name: ent.name, type })
  }
  const cmp = (a: ListEntry, b: ListEntry): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  dirs.sort(cmp)
  others.sort(cmp)
  return [...dirs, ...others]
}

/** fs.list：与 M1 browse 同形状（dir/parent?/entries）。 */
function fsList(dir: string) {
  const entries = collectEntries(dir)
  const parent = parentOf(dir)
  return { dir, ...(parent ? { parent } : {}), entries }
}

/** fs.mkdir：recursive（父级自动建）；已存在目录幂等成功（recursive 不抛 EEXIST）。 */
function fsMkdir(dir: string): { dir: string } {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    throw fsError('创建目录', dir, error)
  }
  return { dir }
}

/** 参数校验：dir 必须是非空字符串（参数缺失属于 BAD_REQUEST，非解析错误）。 */
function requireDir(params: Record<string, unknown>): string {
  const dir = params.dir
  if (typeof dir !== 'string' || dir.trim() === '') {
    throw new RpcError('BAD_REQUEST', '参数 dir 必须是非空字符串')
  }
  return dir
}

/** 参数校验：path 必须是非空字符串（M5 各 fs 方法与 exec 共用）。 */
function requirePath(params: Record<string, unknown>): string {
  const path = params.path
  if (typeof path !== 'string' || path.trim() === '') {
    throw new RpcError('BAD_REQUEST', '参数 path 必须是非空字符串')
  }
  return path
}

/** 参数校验：指定键必须是字符串（text/oldText/newText 等；空串按业务语义各自判定）。 */
function requireStringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key]
  if (typeof value !== 'string') {
    throw new RpcError('BAD_REQUEST', `参数 ${key} 必须是字符串`)
  }
  return value
}

/** 参数校验：maxBytes 可选，缺失返回 undefined，否则必须是非负数（向下取整）。 */
function requireMaxBytes(params: Record<string, unknown>): number | undefined {
  const value = params.maxBytes
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RpcError('BAD_REQUEST', '参数 maxBytes 必须是非负整数')
  }
  return Math.floor(value)
}

/** 参数校验：timeoutMs 可选，缺失返回 0（= 不设超时），否则必须是非负数（毫秒）。 */
function requireTimeoutMs(params: Record<string, unknown>): number {
  const value = params.timeoutMs
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RpcError('BAD_REQUEST', '参数 timeoutMs 必须是非负整数（毫秒）')
  }
  return Math.floor(value)
}

/** 二进制采样窗口：与 fs-local readWholeText 的 BINARY_SAMPLE_BYTES 一致。 */
const BINARY_SAMPLE_BYTES = 8192

/** 按需读取文件字节：maxBytes 给出上限（缺失=整读）；越过上限置 truncated。 */
function readCapped(path: string, maxBytes: number | undefined): { buffer: Buffer; truncated: boolean } {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (error) {
    throw fsError('读取文件', path, error)
  }
  try {
    const size = fstatSync(fd).size
    const cap = maxBytes === undefined || maxBytes >= size ? size : maxBytes
    const buffer = Buffer.alloc(cap)
    let offset = 0
    while (offset < cap) {
      const n = readSync(fd, buffer, offset, cap - offset, offset)
      if (n <= 0) break
      offset += n
    }
    return { buffer: buffer.subarray(0, offset), truncated: cap < size }
  } catch (error) {
    throw fsError('读取文件', path, error)
  } finally {
    try {
      closeSync(fd)
    } catch {
      // 关闭失败可忽略（读已完成或已抛错）
    }
  }
}

/** 严格 UTF-8 解码；truncated 时允许回退至多 3 字节（切断的多字节字符尾部）。 */
function decodeUtf8(buffer: Buffer, truncated: boolean, path: string): string {
  const decode = (bytes: Buffer): string => new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  try {
    return decode(buffer)
  } catch {
    // 整读仍解码失败 = 非法 UTF-8（对齐 fs-local 的 FS_NOT_TEXT）
    if (!truncated) throw new RpcError('NOT_TEXT', `读取失败：${path} 不是有效的 UTF-8 文本`)
    for (let back = 1; back <= 3 && back < buffer.length; back += 1) {
      try {
        return decode(buffer.subarray(0, buffer.length - back))
      } catch {
        // 继续回退
      }
    }
  }
  throw new RpcError('NOT_TEXT', `读取失败：${path} 不是有效的 UTF-8 文本`)
}

/** fs.stat：不存在 exists:false 不报错（契约 B）；其余错误走 fsError。 */
function fsStat(params: Record<string, unknown>): { exists: boolean; isDir: boolean; isFile: boolean; size: number; mtimeMs: number } {
  const path = requirePath(params)
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(path)
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { exists: false, isDir: false, isFile: false, size: 0, mtimeMs: 0 }
    }
    throw fsError('stat', path, error)
  }
  return { exists: true, isDir: st.isDirectory(), isFile: st.isFile(), size: st.size, mtimeMs: st.mtimeMs }
}

/** fs.readText：UTF-8 文本；maxBytes 截断置 truncated；二进制/非法 UTF-8 → NOT_TEXT。 */
function fsReadText(params: Record<string, unknown>): { text: string; truncated: boolean } {
  const path = requirePath(params)
  const maxBytes = requireMaxBytes(params)
  const { buffer, truncated } = readCapped(path, maxBytes)
  if (buffer.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
    throw new RpcError('NOT_TEXT', `读取失败：${path} 是二进制文件`)
  }
  return { text: decodeUtf8(buffer, truncated, path), truncated }
}

/** fs.readBytes：原样字节 base64；maxBytes 截断置 truncated（不校验文本/二进制）。 */
function fsReadBytes(params: Record<string, unknown>): { base64: string; truncated: boolean } {
  const path = requirePath(params)
  const maxBytes = requireMaxBytes(params)
  const { buffer, truncated } = readCapped(path, maxBytes)
  return { base64: buffer.toString('base64'), truncated }
}

/** fs.writeText：UTF-8 直写；createParents 时先建父目录；返回写入字节数。 */
function fsWriteText(params: Record<string, unknown>): { bytes: number } {
  const path = requirePath(params)
  const text = requireStringParam(params, 'text')
  const createParents = params.createParents === true
  if (createParents) {
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch (error) {
      throw fsError('创建父目录', path, error)
    }
  }
  try {
    writeFileSync(path, text, 'utf8')
  } catch (error) {
    throw fsError('写入文件', path, error)
  }
  return { bytes: Buffer.byteLength(text, 'utf8') }
}

/** fs.listDir：与 fs.list 同形状的 entries（{name,type}）；path 参数而非 dir。 */
function fsListDir(params: Record<string, unknown>): { entries: ListEntry[] } {
  return { entries: collectEntries(requirePath(params)) }
}

/** CRLF→LF 归一（对齐 fs-local 的编辑匹配基准）。 */
function normalizeCrlf(content: string): string {
  return content.replaceAll('\r\n', '\n')
}

/** 检测原始换行风格（对齐 fs-local detectLineEndings：取前 4096 字符比较计数）。 */
function detectLineEndings(raw: string): 'LF' | 'CRLF' {
  const sample = raw.slice(0, 4096)
  const crlfCount = sample.split('\r\n').length - 1
  const lfCount = sample.split('\n').length - 1 - crlfCount
  return crlfCount > lfCount ? 'CRLF' : 'LF'
}

/** 统计 needle 在 content 中的出现次数（非重叠）。 */
function countOccurrences(content: string, needle: string): number {
  let count = 0
  let index = 0
  for (;;) {
    const found = content.indexOf(needle, index)
    if (found === -1) return count
    count += 1
    index = found + needle.length
  }
}

/**
 * fs.editText：读-替换-写回（语义对齐 fs-local.editText/applyLiteralEdit）：
 * - LF 归一匹配（oldText/newText/内容）；
 * - oldText 为空 → NO_MATCH；未命中 → NO_MATCH；多处命中且未 replaceAll → AMBIGUOUS；
 * - 命中后按原始换行风格写回（CRLF 文件保持 CRLF）。
 */
function fsEditText(params: Record<string, unknown>): { replacements: number } {
  const path = requirePath(params)
  const oldText = requireStringParam(params, 'oldText')
  const newText = requireStringParam(params, 'newText')
  const replaceAll = params.replaceAll === true
  const { buffer } = readCapped(path, undefined)
  // 编辑路径对齐 fs-local readForEdit：全量字节扫描 NUL（非仅采样）
  if (buffer.includes(0)) {
    throw new RpcError('NOT_TEXT', `编辑失败：${path} 是二进制文件`)
  }
  const raw = decodeUtf8(buffer, false, path)
  const content = normalizeCrlf(raw)
  const lineEndings = detectLineEndings(raw)
  const oldNorm = normalizeCrlf(oldText)
  if (oldNorm.length === 0) throw new RpcError('NO_MATCH', `编辑失败：oldText 必须是非空字符串（${path}）`)
  const newNorm = normalizeCrlf(newText)
  const replacements = countOccurrences(content, oldNorm)
  if (replacements === 0) throw new RpcError('NO_MATCH', `编辑失败：oldText 未命中（${path}）`)
  if (!replaceAll && replacements > 1) {
    throw new RpcError('AMBIGUOUS', `编辑失败：oldText 命中 ${replacements} 次（${path}），请提供更精确的 oldText 或设置 replaceAll=true`)
  }
  const edited = content.split(oldNorm).join(newNorm)
  const output = lineEndings === 'CRLF' ? normalizeCrlf(edited).split('\n').join('\r\n') : edited
  try {
    writeFileSync(path, output, 'utf8')
  } catch (error) {
    throw fsError('写入文件', path, error)
  }
  return { replacements }
}

/**
 * exec：远端 `sh -c` 一次性命令（契约 B；供 bash 一次性命令与 rg 翻译后的搜索）。
 * - cwd 可选（缺省=运行时当前目录）；timeoutMs 可选（0=不设超时）；
 * - 超时杀整个进程组（detached 使子进程成为组长，kill(-pid) 连后代一起终止）。
 */
function execCommand(params: Record<string, unknown>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const command = requireStringParam(params, 'command')
  if (command.trim() === '') throw new RpcError('BAD_REQUEST', '参数 command 必须是非空字符串')
  const cwd = params.cwd === undefined ? process.cwd() : requireStringParam(params, 'cwd')
  const timeoutMs = requireTimeoutMs(params)
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('/bin/sh', ['-c', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(fsError('执行命令', cwd, error))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        // 超时：杀进程组（负 pid = 组信号；子进程 detached 后即组长）
        if (settled) return
        try {
          process.kill(-(child.pid as number), 'SIGKILL')
        } catch {
          // 进程组已消失（命令恰好退出），close 事件随即到达
        }
      }, timeoutMs)
      : undefined
    child.on('error', (error: Error) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      reject(fsError('执行命令', cwd, error))
    })
    child.on('close', (code: number | null) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

const methods: Record<string, (params: Record<string, unknown>) => unknown> = {
  ping: () => ({ version: VERSION, uptimeMs: Math.round(process.uptime() * 1000), pid: process.pid }),
  hello: () => ({
    version: VERSION,
    platform: normalizePlatform(process.platform),
    arch: process.arch,
    node: process.version,
    home: homedir(),
  }),
  // 与 M1 browse 同形状（dir/parent?/entries），供 host 侧 browse 优先走运行时
  'fs.list': (params) => fsList(requireDir(params)),
  'fs.mkdir': (params) => fsMkdir(requireDir(params)),
  // M5 契约 B：远端文件操作与一次性命令
  'fs.stat': (params) => fsStat(params),
  'fs.readText': (params) => fsReadText(params),
  'fs.readBytes': (params) => fsReadBytes(params),
  'fs.writeText': (params) => fsWriteText(params),
  'fs.listDir': (params) => fsListDir(params),
  'fs.editText': (params) => fsEditText(params),
  // 异步方法：handleLine 对 Promise 结果/错误走同一帧
  exec: (params) => execCommand(params),
}

/** 处理一行请求：一切错误都在这里转成协议响应，绝不外抛（进程不死）。 */
function handleLine(line: string): void {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch (error) {
    // 单行 JSON 解析失败：回 BAD_JSON（id:null）继续循环
    writeLine({ id: null, error: { code: 'BAD_JSON', message: `JSON 解析失败：${error instanceof Error ? error.message : String(error)}` } })
    return
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || typeof (raw as { method?: unknown }).method !== 'string') {
    // 结构上不是合法请求对象（缺 method 等）也按坏请求处理
    writeLine({ id: null, error: { code: 'BAD_JSON', message: '请求必须是含 method 字段的 JSON 对象' } })
    return
  }
  const req = raw as { id?: unknown; method: string; params?: unknown }
  const id = typeof req.id === 'number' || typeof req.id === 'string' ? req.id : null
  const params: Record<string, unknown> =
    typeof req.params === 'object' && req.params !== null && !Array.isArray(req.params) ? (req.params as Record<string, unknown>) : {}
  const handler = methods[req.method]
  if (!handler) {
    writeLine({ id, error: { code: 'UNKNOWN_METHOD', message: `未知方法：${req.method}` } })
    return
  }
  /** 把任意 throw/reject 归一为协议错误体（RpcError 保 code，其余 INTERNAL）。 */
  const errorOf = (error: unknown): { code: string; message: string } => {
    if (error instanceof RpcError) return { code: error.code, message: error.message }
    return { code: 'INTERNAL', message: error instanceof Error ? error.message : String(error) }
  }
  try {
    const outcome = handler(params)
    // 异步方法（exec）：成功/失败都落到同一条换行 JSON 帧；进程从不因单个方法死亡
    if (outcome instanceof Promise) {
      outcome.then(
        (result) => writeLine({ id, result }),
        (error) => writeLine({ id, error: errorOf(error) }),
      )
    } else {
      writeLine({ id, result: outcome })
    }
  } catch (error) {
    writeLine({ id, error: errorOf(error) })
  }
}

function main(): void {
  if (process.argv.includes('--version')) {
    process.stdout.write(`${VERSION}\n`)
    process.exit(0)
  }
  // 启动握手：非请求响应的 hello 首行（host 侧 codec 以它为会话就绪标记）
  writeLine({
    type: 'dsh-remote-hello',
    version: VERSION,
    platform: normalizePlatform(process.platform),
    arch: process.arch,
    node: process.version,
  })
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  rl.on('line', (line: string) => {
    const trimmed = line.trim()
    if (!trimmed) return // 空行跳过，不产生错误响应
    try {
      handleLine(trimmed)
    } catch (error) {
      // handleLine 内部已全部捕获；此处仅兜底写 stderr 日志（不进 stdout 协议）
      console.error(`[dsh-remote] 处理异常：${error instanceof Error ? error.message : String(error)}`)
    }
  })
  rl.on('error', (error: Error) => {
    console.error(`[dsh-remote] stdin 错误：${error.message}`)
  })
}

main()