/**
 * 连接注册表：CRUD + tmp+rename 原子写 + 内存缓存 + 变更回调。
 *
 * 存储：`~/.dsh/dsh-ssh/connections.json`（默认），目录 0700；
 * mux/ 与 askpass/ 子目录同样由本模块负责创建（0700）。
 *
 * 安全约束（SPEC D）：密码绝不入库 —— 密码认证 draft 落盘时只保留
 * `{type:'password'}` 壳，明文只在内存与一次性 askpass 脚本中存活。
 */

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, readdirSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export type ConnKind = 'ssh' | 'win'
export type DownloadMethod = 'upload' | 'remote'

export interface SshAuthPw {
  type: 'password'
}

export interface SshAuthKey {
  type: 'key'
  identityFile: string
}

export type SshAuth = SshAuthPw | SshAuthKey

export interface SshConfig {
  host: string
  port: number
  user: string
  auth: SshAuth
  /** 可选：用 Windows ssh.exe 等自定义二进制 */
  sshBinary?: string
  downloadMethod?: DownloadMethod
  /** M2：远端服务器下载源地址（method='remote' 时使用；缺省报明错）。 */
  runtimeUrl?: string
}

export interface WinConfig {
  shell: 'powershell' | 'cmd'
}

/** 持久化的连接档案（SPEC D）。kind==='win' 时无 ssh 字段，win 字段存终端 shell。 */
export interface ConnectionRecord {
  id: string
  kind: ConnKind
  title: string
  ssh?: SshConfig
  win?: WinConfig
  remotePath?: string
  /** M2 填充：installed 是否已安装；version 已激活版本；updatedAt 最近一次写入时间 */
  runtime: { installed: boolean; version?: string; updatedAt?: string }
  /** M5：注册成原生工作区后的 workspaceId（远程 section 行点击直接开会话用）。 */
  workspaceId?: string
  createdAt: string
  updatedAt: string
}

/** 远程环境（SPEC D Status.env）。defaultShell 为 M1 探测出的远端登录 shell。 */
export interface RemoteEnv {
  os: string
  arch: string
  uname: string
  shells: Array<{ name: string; path: string }>
  node?: string
  defaultShell?: string
}

export type ConnState = 'unknown' | 'checking' | 'online' | 'offline' | 'degraded'

/** 连接状态（不持久化，内存 + WS 推送）。 */
export interface ConnectionStatus {
  state: ConnState
  lastChecked?: string
  error?: string
  env?: RemoteEnv
}

/** 向导 connect 用的口令认证（明文仅瞬态）。 */
export interface DraftSshAuthPw {
  type: 'password'
  password: string
}

export type DraftSshAuth = SshAuthKey | DraftSshAuthPw

export interface DraftSshConfig {
  host: string
  port?: number
  user: string
  auth: DraftSshAuth
  sshBinary?: string
  downloadMethod?: DownloadMethod
  /** M2：远端服务器下载源地址（method='remote' 时使用）。 */
  runtimeUrl?: string
}

export interface SshDraft {
  kind: 'ssh'
  title?: string
  ssh: DraftSshConfig
}

export interface WinDraft {
  kind: 'win'
  title?: string
  win?: { shell?: 'powershell' | 'cmd' }
}

export type ConnectDraft = SshDraft | WinDraft

export interface RegistryDeps {
  /** 数据目录，默认 ~/.dsh/dsh-ssh */
  baseDir?: string
  /** 覆盖文件路径（测试注入） */
  filePath?: string
  /** 记录变更回调（create/update/remove 后触发） */
  onChanged?: (action: 'create' | 'update' | 'remove', id: string) => void
}

/** 清洗 draft → 持久化 ssh 配置：剥离密码明文。 */
export function sanitizeSshConfig(draft: DraftSshConfig): SshConfig {
  const auth: SshAuth = draft.auth.type === 'key'
    ? { type: 'key', identityFile: draft.auth.identityFile }
    : { type: 'password' }
  const ssh: SshConfig = {
    host: draft.host,
    port: draft.port ?? 22,
    user: draft.user,
    auth,
  }
  if (draft.sshBinary) ssh.sshBinary = draft.sshBinary
  if (draft.downloadMethod) ssh.downloadMethod = draft.downloadMethod
  if (draft.runtimeUrl) ssh.runtimeUrl = draft.runtimeUrl
  return ssh
}

const FILE_MODE = 0o600
const DIR_MODE = 0o700

export class ConnectionRegistry {
  readonly baseDir: string
  readonly filePath: string
  readonly muxDir: string
  readonly askpassDir: string

  private records: ConnectionRecord[] = []
  private deps: RegistryDeps

  constructor(deps: RegistryDeps = {}) {
    this.deps = deps
    // 数据根遵循 harness 约定：$DSH_HOME（缺省 ~/.dsh）。
    const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
    this.baseDir = deps.baseDir ?? join(dshHome, 'dsh-ssh')
    this.filePath = deps.filePath ?? join(this.baseDir, 'connections.json')
    this.muxDir = join(this.baseDir, 'mux')
    this.askpassDir = join(this.baseDir, 'askpass')
    // 插件自建目录（0700）：数据根 + mux + askpass
    // 注意：对已存在目录也强制 chmod，防 mkdirSync 保留 umask 放宽的权限
    for (const dir of [this.baseDir, this.muxDir, this.askpassDir]) {
      mkdirSync(dir, { recursive: true })
      chmodSync(dir, DIR_MODE)
    }
  }

  /** 读取磁盘数据；缺文件 → 空；损坏 → 备份后重置为空。 */
  load(): void {
    if (!existsSync(this.filePath)) {
      this.records = []
      return
    }
    try {
      const text = readFileSync(this.filePath, 'utf8')
      const data = JSON.parse(text) as { connections?: ConnectionRecord[] }
      this.records = Array.isArray(data.connections) ? data.connections : []
    } catch {
      // 损坏备份：connections.json → connections.json.corrupt-<ts>
      const backup = `${this.filePath}.corrupt-${Date.now()}`
      try {
        renameSync(this.filePath, backup)
      } catch {
        /* 备份失败不致命，仍以空启动 */
      }
      this.records = []
    }
  }

  list(): ConnectionRecord[] {
    return this.records
  }

  get(id: string): ConnectionRecord | undefined {
    return this.records.find((r) => r.id === id)
  }

  /** 持久化一条连接（向导第 4 步"完成"）。密码类 draft 落盘清洗。 */
  create(draft: ConnectDraft, title: string, remotePath: string): ConnectionRecord {
    const now = new Date().toISOString()
    const record: ConnectionRecord = {
      id: `conn_${randomUUID()}`,
      kind: draft.kind,
      title: title || (draft.kind === 'ssh' ? 'ssh' : 'Windows'),
      remotePath,
      runtime: { installed: false },
      createdAt: now,
      updatedAt: now,
    }
    if (draft.kind === 'ssh') {
      record.ssh = sanitizeSshConfig(draft.ssh)
    } else if (draft.win) {
      record.win = { shell: draft.win.shell ?? 'powershell' }
    }
    this.records.push(record)
    this.persist()
    this.deps.onChanged?.('create', record.id)
    return record
  }

  update(id: string, patch: Partial<Omit<ConnectionRecord, 'id' | 'createdAt'>>): ConnectionRecord | undefined {
    const record = this.get(id)
    if (!record) return undefined
    Object.assign(record, patch, { updatedAt: new Date().toISOString() })
    this.persist()
    this.deps.onChanged?.('update', id)
    return record
  }

  /** M2：原子写入运行时安装状态（installed/version + updatedAt）。 */
  updateRuntime(id: string, info: { installed: boolean; version?: string }): ConnectionRecord | undefined {
    const record = this.get(id)
    if (!record) return undefined
    record.runtime = {
      installed: info.installed,
      ...(info.version ? { version: info.version } : {}),
      updatedAt: new Date().toISOString(),
    }
    this.persist()
    this.deps.onChanged?.('update', id)
    return record
  }

  /** M5：原子写入注册成的原生工作区 id（workspaceId + updatedAt）。 */
  updateWorkspaceId(id: string, workspaceId: string): ConnectionRecord | undefined {
    const record = this.get(id)
    if (!record) return undefined
    record.workspaceId = workspaceId
    record.updatedAt = new Date().toISOString()
    this.persist()
    this.deps.onChanged?.('update', id)
    return record
  }

  remove(id: string): boolean {
    const index = this.records.findIndex((r) => r.id === id)
    if (index < 0) return false
    this.records.splice(index, 1)
    this.persist()
    this.deps.onChanged?.('remove', id)
    return true
  }

  /** tmp+rename 原子写：同目录临时文件落盘后 rename 覆盖，清理残留 tmp。 */
  persist(): void {
    const tmp = `${this.filePath}.tmp-${randomUUID()}`
    const payload = JSON.stringify({ connections: this.records }, null, 2)
    writeFileSync(tmp, payload, { encoding: 'utf8', mode: FILE_MODE })
    renameSync(tmp, this.filePath)
    // 清理历史残留临时文件（防崩溃遗留堆积）
    try {
      const prefix = `${this.filePath}.tmp-`
      for (const name of readdirSync(this.baseDir)) {
        if (name.startsWith(prefix)) {
          try { unlinkSync(join(this.baseDir, name)) } catch { /* 忽略 */ }
        }
      }
    } catch {
      /* 目录不可读时忽略 */
    }
  }
}