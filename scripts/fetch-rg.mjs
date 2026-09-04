#!/usr/bin/env node
/**
 * 从 harness 仓 node_modules 拷贝 @vscode/ripgrep 的 linux-x64 rg 二进制，
 * 落到 assets/rg/linux-x64/rg（0755），供 build-runtime.mjs 以 tools/rg 组件入包。
 *
 * 来源路径（pnpm 布局各异，按序探测）：
 *   1) <harness>/node_modules/@vscode/ripgrep/bin/rg（SPEC 默认路径）
 *   2) <harness>/node_modules/@vscode/ripgrep-linux-x64/bin/rg（某些安装直接躺平）
 *   3) <harness>/node_modules/.pnpm/ 下的 @vscode+ripgrep(-…)* 虚拟 Store 内
 *      node_modules/@vscode/ripgrep-…-x64 包里的 bin/rg（本机 pnpm 实际布局）
 * 已存在且大小 ≥ 1MB 视为完整，跳过拷贝（幂等；<1MB 视为残缺重拷）。
 *
 * 用法: node scripts/fetch-rg.mjs [--harness <dir>] [--help]
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLATFORM = 'linux-x64' // M2 只支持 linux-x64 变体
const SKIP_BYTES = 1 * 1024 * 1024
const DEFAULT_HARNESS = '/home/lyy/workspace/DSH/deepseek-harness'

function usage() {
  return '用法: node scripts/fetch-rg.mjs [--harness <dir>] [--help]'
}

function parseArgs(argv) {
  const args = { harness: process.env.DSH_HARNESS || DEFAULT_HARNESS }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help') {
      console.log(usage())
      console.log('  --harness <dir>   harness 仓库根目录（默认取 DSH_HARNESS 环境变量或固定路径）')
      process.exit(0)
    } else if (arg === '--harness') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error('--harness 需要值')
      args.harness = value
      i += 1
    } else {
      throw new Error(`未知参数：${arg}（${usage()}）`)
    }
  }
  return args
}

/** 在 .pnpm 虚拟 Store 树上找出所有可能的 rg 候选（@vscode+ripgrep* 包内 bin/rg）。 */
function pnpmCandidates(harness) {
  const pnpmDir = join(harness, 'node_modules', '.pnpm')
  const results = []
  if (!existsSync(pnpmDir)) return results
  let entries
  try {
    entries = readdirSync(pnpmDir)
  } catch {
    return results
  }
  for (const entry of entries) {
    if (!entry.startsWith('@vscode+ripgrep')) continue
    const base = join(pnpmDir, entry, 'node_modules', '@vscode')
    if (!existsSync(base)) continue
    let dirs
    try {
      dirs = readdirSync(base)
    } catch {
      continue
    }
    for (const name of dirs) {
      if (name.startsWith('ripgrep')) {
        const candidate = join(base, name, 'bin', 'rg')
        if (existsSync(candidate)) results.push(candidate)
      }
    }
  }
  return results
}

/** 按序找出第一个存在的 rg 二进制；全部缺失则报错并列出已探测路径。 */
function findRg(harness) {
  const candidates = [
    join(harness, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
    join(harness, 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg'),
    ...pnpmCandidates(harness),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  console.error(`[fetch-rg] 未找到 rg 二进制，已探测: ${candidates.join('\n  ')}`)
  console.error('[fetch-rg] 可传 --harness 指定其他 harness 根目录')
  throw new Error('缺少 @vscode/ripgrep 的 linux-x64 rg 二进制')
}

/** 幂等：assets/rg/ 加入 .gitignore（缺行则追加；与 fetch-node 对 assets/node/ 一致）。 */
function ensureGitignore() {
  const gitignorePath = join(ROOT, '.gitignore')
  const line = 'assets/rg/'
  let content = ''
  try {
    content = readFileSync(gitignorePath, 'utf8')
  } catch {
    // 不存在时按空内容新建
  }
  const lines = content.split('\n').map((l) => l.trim())
  if (!lines.includes(line)) {
    writeFileSync(gitignorePath, `${content.replace(/\s+$/, '')}\n${line}\n`)
    console.log(`[fetch-rg] 已把 ${line} 加入 .gitignore`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dest = join(ROOT, 'assets', 'rg', PLATFORM, 'rg')

  // 幂等：已存在且视为完整则跳过（不再触碰源文件）
  if (existsSync(dest)) {
    const bytes = statSync(dest).size
    if (bytes >= SKIP_BYTES) {
      console.log(`[fetch-rg] assets/rg/${PLATFORM}/rg 已存在（${bytes} bytes ≥ 1MB），跳过拷贝`)
      return
    }
    console.log(`[fetch-rg] 已存在但大小 ${bytes} bytes < 1MB，视为残缺，重新拷贝`)
  }

  const src = findRg(args.harness)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  chmodSync(dest, 0o755)
  ensureGitignore()
  const bytes = statSync(dest).size
  console.log(`[fetch-rg] 完成：${dest}（${bytes} bytes，0755，来自 ${src}）`)
}

await main()