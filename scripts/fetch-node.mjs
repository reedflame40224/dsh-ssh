#!/usr/bin/env node
/**
 * 拉取官方 node v22 LTS linux-x64 tarball，只取 bin/node 落到
 * assets/node/linux-x64/bin/node（0755）。
 * 已存在且大小 >100MB 视为完整，跳过下载（>100MB 是残缺判定）。网络失败清晰报错退出非 0
 * （验收环境可能无外网，是否真下载由主代理判断）。
 * 同时幂等确保 assets/node/ 加入 .gitignore。
 *
 * 用法: node scripts/fetch-node.mjs [--dry-run] [--version v22.16.0] [--help]
 * 说明: 解压 xz 依赖系统 tar -xJf（node:zlib 不含 xz）。
 */

import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLATFORM = 'linux-x64' // M2 只支持 linux-x64 变体
const DEFAULT_VERSION = 'v22.16.0'
const SKIP_BYTES = 100 * 1024 * 1024

/** 幂等：assets/node/ 加入 .gitignore（缺行则追加）。 */
function ensureGitignore() {
  const gitignorePath = join(ROOT, '.gitignore')
  const line = 'assets/node/'
  let content = ''
  try {
    content = readFileSync(gitignorePath, 'utf8')
  } catch {
    // 不存在时按空内容新建
  }
  const lines = content.split('\n').map((l) => l.trim())
  if (!lines.includes(line)) {
    writeFileSync(gitignorePath, `${content.replace(/\s+$/, '')}\n${line}\n`)
    console.log(`[fetch-node] 已把 ${line} 加入 .gitignore`)
  }
}

function usage() {
  return '用法: node scripts/fetch-node.mjs [--dry-run] [--version v22.16.0] [--help]'
}

function parseArgs(argv) {
  const args = { dryRun: false, version: DEFAULT_VERSION }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help') {
      console.log(usage())
      console.log('  --dry-run               只打印将执行的动作，不发起网络请求')
      console.log('  --version <v>           如 v22.16.0（官方 dist 目录版本号）')
      process.exit(0)
    } else if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg.startsWith('--version=')) {
      args.version = arg.slice('--version='.length)
    } else if (arg === '--version') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error('--version 需要值，如 v22.16.0')
      args.version = value
      i += 1
    } else {
      throw new Error(`未知参数：${arg}（${usage()}）`)
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const version = args.version.startsWith('v') ? args.version : `v${args.version}`
  const url = `https://nodejs.org/dist/${version}/node-${version}-${PLATFORM}.tar.xz`
  const destDir = join(ROOT, 'assets', 'node', PLATFORM, 'bin')
  const dest = join(destDir, 'node')

  // 跳过判定：已存在且 >100MB（完整 node 二进制远大于此），倾斜处理为残缺重下
  if (existsSync(dest)) {
    const bytes = statSync(dest).size
    if (bytes > SKIP_BYTES) {
      console.log(`[fetch-node] assets/node/${PLATFORM}/bin/node 已存在（${bytes} bytes > 100MB），跳过下载`)
      return
    }
    console.log(`[fetch-node] 已存在但大小 ${bytes} bytes ≤ 100MB，视为残缺，重新下载`)
  }

  ensureGitignore()

  if (args.dryRun) {
    console.log(`[fetch-node] [dry-run] 将下载: ${url}`)
    console.log(`[fetch-node] [dry-run] 目标: ${dest}（0755）`)
    console.log(`[fetch-node] [dry-run] 解压成员: node-${version}-${PLATFORM}/bin/node`)
    console.log('[fetch-node] [dry-run] 已跳过全部网络操作')
    return
  }

  const tmp = mkdtempSync(join(tmpdir(), 'dsh-node-fetch-'))
  try {
    const tarPath = join(tmp, `node-${version}-${PLATFORM}.tar.xz`)
    console.log(`[fetch-node] 下载 ${url} ...`)
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const buf = Buffer.from(await res.arrayBuffer())
    writeFileSync(tarPath, buf)
    console.log(`[fetch-node] 下载完成（${buf.byteLength} bytes），解压 bin/node ...`)

    const member = `node-${version}-${PLATFORM}/bin/node`
    const stage = join(tmp, 'stage')
    mkdirSync(stage, { recursive: true })
    execFileSync('tar', ['-xJf', tarPath, '-C', stage, member], { stdio: 'ignore' })

    mkdirSync(destDir, { recursive: true })
    copyFileSync(join(stage, member), dest)
    chmodSync(dest, 0o755)
    const bytes = statSync(dest).size
    console.log(`[fetch-node] 完成：${dest}（${bytes} bytes，0755）`)
  } catch (error) {
    // 下载/解压任何一步失败：清晰报错退出非 0（无外网时主代理据此改用 upload 下发）
    console.error(`[fetch-node] 失败：${error instanceof Error ? error.message : String(error)}`)
    console.error('[fetch-node] 当前环境可能无外网；请改在主代理网络可达处执行，或对该远端走 upload 方式下发')
    process.exitCode = 1
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

await main()