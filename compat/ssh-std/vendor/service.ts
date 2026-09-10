/**
 * dshSsh 服务（cordis service 提供体，供 dsh-terminal 等后端消费）。
 *
 * SPEC H 契约逐字：
 *   listTargets()：Array<{connectionId,title,kind,online,remotePath?}>
 *   buildRemoteSpawn(spec)：{argv,name,env?}
 *     ssh: argv = [...公共argv头, '-t', 'user@host', `cd '<cwd||remotePath>' && exec <shell|默认> -l`]
 *     win: argv = [shell==='cmd' ? 'cmd.exe' : 'powershell.exe','-NoLogo']
 */

import type { ConnectionRegistry, RemoteEnv } from './registry.ts'
import type { SshConnector } from './ssh.ts'
import { shellQuote } from './ssh.ts'
import type { LivenessProbe } from './liveness.ts'

export interface DshSshTargetItem {
  connectionId: string
  title: string
  kind: 'ssh' | 'win'
  online: boolean
  remotePath?: string
}

export interface RemoteSpawnSpec {
  connectionId: string
  cwd?: string
  shell?: string
}

export interface RemoteSpawnResult {
  argv: string[]
  name: string
  env?: Record<string, string>
}

export interface DshSshService {
  listTargets(): DshSshTargetItem[]
  buildRemoteSpawn(spec: RemoteSpawnSpec): RemoteSpawnResult
}

export interface ServiceDeps {
  registry: ConnectionRegistry
  connector: SshConnector
  liveness: LivenessProbe
}

export function createDshSshService(deps: ServiceDeps): DshSshService {
  const registry = deps.registry
  const connector = deps.connector

  const listTargets = (): DshSshTargetItem[] => {
    return registry.list().map((connection) => {
      const status = deps.liveness.getStatus(connection.id)
      const item: DshSshTargetItem = {
        connectionId: connection.id,
        title: connection.title,
        kind: connection.kind,
        online: status.state === 'online',
      }
      if (connection.remotePath) item.remotePath = connection.remotePath
      return item
    })
  }

  const buildRemoteSpawn = (spec: RemoteSpawnSpec): RemoteSpawnResult => {
    const connection = registry.get(spec.connectionId)
    if (!connection) throw new Error(`连接不存在：${spec.connectionId}`)
    const status = deps.liveness.getStatus(connection.id)
    if (status.state !== 'online') throw new Error(`连接离线：${connection.title}，请先在远程工作区重新连接`)

    if (connection.kind === 'win') {
      // WIN 走 interop：本地 PTY spawn powershell/cmd，cwd 语义由 dsh-terminal spawn 承担
      const shell = spec.shell ?? connection.win?.shell ?? 'powershell'
      const argv = shell === 'cmd' ? ['cmd.exe', '-NoLogo'] : ['powershell.exe', '-NoLogo']
      return { argv, name: connection.title }
    }

    // ssh：骑 mux（同一公共 argv 头），-t 强制伪终端
    const env = status.env
    const cwd = spec.cwd || connection.remotePath || ''
    // 显式 shell/探测到的登录 shell 优先；缓存尚未恢复时让远端 shell
    // 自己展开 $SHELL（Kali=/usr/bin/zsh），不能把变量单引号锁死。
    const selectedShell = spec.shell || env?.defaultShell
    const shellCommand = selectedShell
      ? `exec ${shellQuote(selectedShell)} -l`
      : 'exec "${SHELL:-/bin/sh}" -l'
    const remoteCommand = cwd
      ? `cd ${shellQuote(cwd)} && ${shellCommand}`
      : shellCommand
    const target = {
      kind: 'ssh' as const,
      host: connection.ssh!.host,
      port: connection.ssh!.port,
      user: connection.ssh!.user,
      auth: connection.ssh!.auth,
      sshBinary: connection.ssh!.sshBinary,
    }
    const argv = connector.buildSshArgv(target, { tty: true, command: remoteCommand })
    return { argv, name: connection.title }
  }

  return { listTargets, buildRemoteSpawn }
}

export type { RemoteEnv }