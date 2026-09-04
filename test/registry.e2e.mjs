/**
 * dsh-ssh 离线 e2e：ConnectionRegistry（CRUD + 原子写 + 缺文件首启 + 密码不入库）。
 *
 * 纯 node 运行：`node test/registry.e2e.mjs`；退出码 0/非 0 表成败。
 */

import { mkdtempSync, readFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectionRegistry } from '../src/registry.ts'

const fail = (reason) => {
  console.error('[registry] FAIL:', reason)
  process.exit(1)
}

const guard = (condition, label) => {
  if (!condition) fail(label)
  console.log(`[registry] ok: ${label}`)
}

const base = mkdtempSync(join(tmpdir(), 'dsh-ssh-reg-'))
let step = 0
const mkdirGuard = (label) => {
  const dir = join(base, `case-${++step}`)
  mkdirSync(dir, { recursive: true })
  guard(true, `${label}（含 ${dir}）`)
  return dir
}

try {
  // ── S0 缺文件首启 ──────────────────────────────────────────────
  {
    const dir = mkdirGuard('缺文件首启：目录已建')
    const reg = new ConnectionRegistry({ baseDir: dir })
    reg.load()
    guard(reg.list().length === 0, '缺 connections.json → list() 为空')
    guard(existsSync(join(dir, 'mux')), 'mux 目录已创建')
    guard(existsSync(join(dir, 'askpass')), 'askpass 目录已创建')
    const stat = statSync(dir)
    guard((stat.mode & 0o777) === 0o700, `数据目录权限 0700（实际 ${(stat.mode & 0o777).toString(8)}）`)
  }

  // ── S1 create + 内存缓存 + 缺省端口 ────────────────────────────
  let createdId
  {
    const dir = mkdirGuard('create + 内存缓存')
    const reg = new ConnectionRegistry({ baseDir: dir })
    reg.load()
    const conn = reg.create(
      { kind: 'ssh', title: 'pwn', ssh: { host: '192.168.184.131', user: 'kali', auth: { type: 'key', identityFile: '/x/id' } } },
      'pwn',
      '/home/kali/pwn',
    )
    createdId = conn.id
    guard(conn.id.startsWith('conn_'), `id 前缀 conn_（${conn.id}）`)
    guard(conn.ssh.port === 22, '缺省端口 22')
    guard(conn.runtime.installed === false, 'runtime.installed 初始 false')
    guard(reg.get(conn.id) === conn, '内存缓存 get 命中同一对象')
    guard(reg.list().length === 1, 'list 长度 1')
    guard(reg.list()[0].createdAt === conn.createdAt, 'createdAt ISO')
    guard(existsSync(join(dir, 'connections.json')), 'connections.json 已落盘')
  }

  // ── S2 原子写 + 无残留 tmp ─────────────────────────────────────
  {
    const dir = mkdirGuard('原子写：无残留 tmp')
    const reg = new ConnectionRegistry({ baseDir: dir })
    reg.load()
    for (let i = 0; i < 5; i++) {
      reg.create({ kind: 'ssh', title: `t${i}`, ssh: { host: 'h', port: 22, user: 'u', auth: { type: 'key', identityFile: '/x' } } }, `t${i}`, '/')
      reg.remove(reg.list()[0].id)
    }
    const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp-'))
    guard(leftovers.length === 0, `无残留 tmp 文件（实际 ${JSON.stringify(leftovers)}）`)
    const parsed = JSON.parse(readFileSync(join(dir, 'connections.json'), 'utf8'))
    guard(Array.isArray(parsed.connections), 'connections.json 为 {connections:[...]} 结构')
    const stat = statSync(join(dir, 'connections.json'))
    guard((stat.mode & 0o777) === 0o600, `文件权限 0600（实际 ${(stat.mode & 0o777).toString(8)}）`)
  }

  // ── S3 密码绝不入库 ────────────────────────────────────────────
  {
    const dir = mkdirGuard('密码不入库')
    const reg = new ConnectionRegistry({ baseDir: dir })
    reg.load()
    reg.create(
      { kind: 'ssh', title: 'secret-host', ssh: { host: 'h', port: 22, user: 'u', auth: { type: 'password', password: 's3cret-pw!' } } },
      'secret-host',
      '/',
    )
    const raw = readFileSync(join(dir, 'connections.json'), 'utf8')
    guard(!raw.includes('s3cret-pw!'), '明文密码未写入磁盘')
    const parsed = JSON.parse(raw)
    guard(parsed.connections[0].ssh.auth.type === 'password', '密码认证保留 type')
    guard(!('password' in parsed.connections[0].ssh.auth), '密码字段被剥离')
  }

  // ── S4 create/update/remove 变更回调 ───────────────────────────
  {
    const dir = mkdirGuard('变更回调')
    const events = []
    const reg = new ConnectionRegistry({ baseDir: dir, onChanged: (action, id) => events.push(`${action}:${id}`) })
    reg.load()
    const conn = reg.create(
      { kind: 'ssh', title: 'x', ssh: { host: 'h', port: 22, user: 'u', auth: { type: 'key', identityFile: '/x' } } },
      'x',
      '/',
    )
    guard(events.length === 1 && events[0] === `create:${conn.id}`, `create 回调（${events[0]}）`)
    reg.update(conn.id, { title: 'y' })
    guard(events[1] === `update:${conn.id}`, 'update 回调')
    reg.remove(conn.id)
    guard(events[2] === `remove:${conn.id}`, 'remove 回调')
    guard(reg.list().length === 0, 'remove 后为空')
  }

  // ── S5 磁盘重载（list/update 一致性）──────────────────────────
  {
    const dir = mkdirGuard('磁盘重载')
    let reg = new ConnectionRegistry({ baseDir: dir })
    reg.load()
    const conn = reg.create(
      { kind: 'ssh', title: 'reload', ssh: { host: 'h', port: 2222, user: 'u', auth: { type: 'key', identityFile: '/x' } } },
      'reload',
      '/home/u',
    )
    // 新实例重读
    reg = new ConnectionRegistry({ baseDir: dir })
    reg.load()
    const loaded = reg.get(conn.id)
    guard(loaded !== undefined, '重载后按 id 命中')
    guard(loaded.title === 'reload' && loaded.remotePath === '/home/u', '重载后字段一致')
    guard(loaded.ssh.port === 2222, '重载后 ssh.port 一致')
    // 损坏文件 → 备份 + 空启动
    writeFileSync(join(dir, 'connections.json'), '{ not json')
    reg = new ConnectionRegistry({ baseDir: dir })
    reg.load()
    guard(reg.list().length === 0, '损坏 JSON → 空启动')
    const backup = readdirSync(dir).find((n) => n.startsWith('connections.json.corrupt-'))
    guard(Boolean(backup), `损坏备份存在（${backup}）`)
  }

  console.log('\n[registry] ✅ 全部通过')
} finally {
  rmSync(base, { recursive: true, force: true })
}