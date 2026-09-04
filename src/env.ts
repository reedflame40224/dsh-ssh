/**
 * 本地环境探测 + 连接别名解析（与 cordis 无关的纯 Node 模块）。
 *
 * - detectLocalEnvironment()：WSL / Windows / Linux / macOS 判定与卡片可用性。
 * - loadAliases()：合并 `~/.dsh/remote-hosts.json`（dsh 源，优先）与
 *   `~/.ssh/config`（ssh-config 源，追加不重名项）。
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type LocalKind = 'wsl' | 'windows' | 'linux' | 'macos'

export interface LocalEnvironment {
  kind: LocalKind
  detail?: string
  canWsl: boolean
  canWin: boolean
  canDocker: boolean
}

export type AliasSource = 'dsh' | 'ssh-config'

export interface AliasItem {
  name: string
  host: string
  port?: number
  user?: string
  identityFile?: string
  sshBinary?: string
  source: AliasSource
  description?: string
}

/** 读取 osrelease（不存在/不可读 → 空串）。 */
function readOsRelease(): string {
  try {
    return readFileSync('/proc/sys/kernel/osrelease', 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * 本地环境判定（SPEC G）：
 *   linux 且（WSL_DISTRO_NAME 非空 或 osrelease 含 microsoft 不分大小写）→ wsl；
 *   win32 → windows。
 * 卡片可用性：canWin = kind==='wsl'（WIN 走 interop 仅当 DSH 在 WSL 中）；
 *   canWsl M1 恒 false 占位（Windows→WSL 直连未实现，禁用逻辑在 client）；
 *   canDocker 恒 false。
 */
export function detectLocalEnvironment(): LocalEnvironment {
  const platform = process.platform
  if (platform === 'win32') {
    return { kind: 'windows', detail: 'windows', canWsl: false, canWin: false, canDocker: false }
  }
  if (platform === 'linux') {
    const distro = process.env.WSL_DISTRO_NAME
    const osrelease = readOsRelease()
    const isWsl = Boolean(distro) || /microsoft/i.test(osrelease)
    if (isWsl) {
      return {
        kind: 'wsl',
        detail: distro || osrelease || undefined,
        canWsl: false,
        canWin: true,
        canDocker: false,
      }
    }
    return { kind: 'linux', detail: osrelease || undefined, canWsl: false, canWin: false, canDocker: false }
  }
  if (platform === 'darwin') {
    return { kind: 'macos', detail: 'macos', canWsl: false, canWin: false, canDocker: false }
  }
  return { kind: 'linux', detail: platform, canWsl: false, canWin: false, canDocker: false }
}

/** 读 dsh 源别名文件（`~/.dsh/remote-hosts.json`）。文件缺失/损坏 → 空数组。 */
export function readDshAliases(filePath?: string): AliasItem[] {
  const resolved = filePath ?? join(homedir(), '.dsh', 'remote-hosts.json')
  let raw: string
  try {
    raw = readFileSync(resolved, 'utf8')
  } catch {
    return []
  }
  try {
    const data = JSON.parse(raw) as { hosts?: Array<Record<string, unknown>> }
    const hosts = Array.isArray(data.hosts) ? data.hosts : []
    return hosts.map((h) => {
      const item: AliasItem = {
        name: String(h.alias ?? ''),
        host: String(h.host ?? ''),
        source: 'dsh',
      }
      if (typeof h.port === 'number' && Number.isFinite(h.port)) item.port = h.port
      if (typeof h.user === 'string' && h.user) item.user = h.user
      if (typeof h.identityFile === 'string' && h.identityFile) item.identityFile = h.identityFile
      if (typeof h.sshBinary === 'string' && h.sshBinary) item.sshBinary = h.sshBinary
      if (typeof h.description === 'string' && h.description) item.description = h.description
      return item
    }).filter((it) => it.name && it.host)
  } catch {
    return []
  }
}

/**
 * 宽容解析 `~/.ssh/config` Host 块（容错：任何异常返回空数组）。
 * 规则：跳过含 `*`/`?` 的通配块；块内取 HostName/User/Port/IdentityFile。
 * 一个 `Host a b` 块对每个非通配 pattern 各产出一条。
 */
export function parseSshConfig(text: string): AliasItem[] {
  interface Block {
    patterns: string[]
    hostName?: string
    user?: string
    port?: number
    identityFile?: string
  }
  const items: AliasItem[] = []
  let current: Block | undefined
  const flush = (): void => {
    if (!current) return
    const block = current
    const hasWildcard = block.patterns.some((p) => p.includes('*') || p.includes('?'))
    if (!hasWildcard) {
      for (const pattern of block.patterns) {
        if (!pattern) continue
        const item: AliasItem = {
          name: pattern,
          host: block.hostName || pattern,
          source: 'ssh-config',
        }
        if (block.port !== undefined) item.port = block.port
        if (block.user) item.user = block.user
        if (block.identityFile) item.identityFile = block.identityFile
        items.push(item)
      }
    }
    current = undefined
  }
  try {
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#') || line.startsWith(';')) continue
      const tokens = line.split(/\s+/)
      const keyword = tokens[0].toLowerCase()
      switch (keyword) {
        case 'host':
          flush()
          current = { patterns: tokens.slice(1) }
          break
        case 'hostname':
          if (current && tokens[1]) current.hostName = tokens.slice(1).join(' ')
          break
        case 'user':
          if (current && tokens[1]) current.user = tokens[1]
          break
        case 'port': {
          if (current && tokens[1]) {
            const n = Number(tokens[1])
            if (Number.isFinite(n) && n > 0) current.port = n
          }
          break
        }
        case 'identityfile':
          if (current && tokens[1]) current.identityFile = tokens.slice(1).join(' ')
          break
        default:
          break
      }
    }
    flush()
  } catch {
    /* 容错：解析失败返回空数组 */
  }
  return items
}

/** 读 ssh-config 源（`~/.ssh/config`），文件不存在 → 空数组。 */
export function readSshConfigAliases(filePath?: string): AliasItem[] {
  const resolved = filePath ?? join(homedir(), '.ssh', 'config')
  let text: string
  try {
    text = readFileSync(resolved, 'utf8')
  } catch {
    return []
  }
  return parseSshConfig(text)
}

/**
 * 合并别名（dsh 优先同名覆盖）：先按 dsh 源建表，ssh-config 只追加不重名项。
 * 返回顺序：dsh 项在前，随后是 ssh-config 新增项。
 */
export function loadAliases(): AliasItem[] {
  const merged = new Map<string, AliasItem>()
  for (const item of readDshAliases()) merged.set(item.name, item)
  for (const item of readSshConfigAliases()) {
    if (!merged.has(item.name)) merged.set(item.name, item)
  }
  return [...merged.values()]
}