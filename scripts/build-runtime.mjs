#!/usr/bin/env node
/**
 * dsh-remote 运行时打包脚本（SPEC-M2 R1）：
 *   node scripts/build-runtime.mjs [--platform linux-x64] [--with-node]
 *
 * 步骤：esbuild bundle remote/src/server.ts → 临时目录 dsh-remote-server.cjs；
 *   拷贝 remote/start.sh；生成 manifest.json（各组件 sha256/bytes；
 *   --with-node 且 assets/node/<platform>/bin/node 存在时纳入 node 组件，否则省略）；
 *   系统 tar 打 assets/runtime/dsh-remote-<version>-<platform>.tar.gz；打印产物
 *   路径 + 大小 + manifest sha256 摘要。version 读 package.json。
 *
 * 只读依赖：esbuild（devDep 已备）、node: 内置、系统 tar。不改任何既有配置文件。
 */

import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_DIR = join(ROOT, 'assets', 'runtime')
const ENTRY = join(ROOT, 'remote', 'src', 'server.ts')

function usage() {
  return '用法: node scripts/build-runtime.mjs [--platform linux-x64] [--with-node]'
}

/** 组件 sha256 + bytes。 */
function digestOf(filePath) {
  const data = readFileSync(filePath)
  return { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.byteLength }
}

function parseArgs(argv) {
  const args = { platform: 'linux-x64', withNode: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help') {
      console.log(usage())
      console.log('  --platform <linux-x64>  平台标签（决定 tar 文件名与 node 资产目录）')
      console.log('  --with-node             内置 node 变体（需要 assets/node/<platform>/bin/node）')
      process.exit(0)
    } else if (arg === '--with-node') {
      args.withNode = true
    } else if (arg.startsWith('--platform=')) {
      args.platform = arg.slice('--platform='.length)
    } else if (arg === '--platform') {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) throw new Error('--platform 需要值，如 linux-x64')
      args.platform = value
      i += 1
    } else {
      throw new Error(`未知参数：${arg}（${usage()}）`)
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const tmp = mkdtempSync(join(tmpdir(), 'dsh-remote-build-'))
  try {
    // 1) esbuild bundle（node 平台 CJS，node: 内置模块外部化，体积应远小于 50KB）
    const serverOut = join(tmp, 'dsh-remote-server.cjs')
    await build({
      entryPoints: [ENTRY],
      outfile: serverOut,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node18',
      define: { __DSH_REMOTE_VERSION__: JSON.stringify(version) },
      logLevel: 'warning',
    })

    // 2) start.sh（可执行位保留，tar 内权限随之保留）
    const startSh = join(tmp, 'start.sh')
    copyFileSync(join(ROOT, 'remote', 'start.sh'), startSh)
    chmodSync(startSh, 0o755)

    // 3) manifest 组件（服务端 / 启动器 / rg 工具 / 可选的 node 二进制）
    const components = [
      { path: 'dsh-remote-server.cjs', ...digestOf(serverOut) },
      { path: 'start.sh', ...digestOf(startSh) },
    ]
    // M5 契约 B：双变体都纳入 tools/rg（远端 grep/glob 复用；从 fetch-rg 落的资产拷入，
    // 保持可执行位）。资产缺失时警告跳过（与 node 组件同策略，构建不因此失败）。
    const rgSrc = join(ROOT, 'assets', 'rg', args.platform, 'rg')
    if (existsSync(rgSrc)) {
      const rgDest = join(tmp, 'tools', 'rg')
      mkdirSync(dirname(rgDest), { recursive: true })
      copyFileSync(rgSrc, rgDest)
      chmodSync(rgDest, 0o755)
      components.push({ path: 'tools/rg', ...digestOf(rgDest) })
    } else {
      console.warn(`[build-runtime] 警告：assets/rg/${args.platform}/rg 不存在（先跑 node scripts/fetch-rg.mjs），tar 中不含 tools/rg`)
    }
    if (args.withNode) {
      const nodeSrc = join(ROOT, 'assets', 'node', args.platform, 'bin', 'node')
      if (existsSync(nodeSrc)) {
        const nodeDest = join(tmp, 'node', 'bin', 'node')
        mkdirSync(dirname(nodeDest), { recursive: true })
        copyFileSync(nodeSrc, nodeDest)
        chmodSync(nodeDest, 0o755)
        components.push({ path: 'node/bin/node', ...digestOf(nodeDest), optional: true })
      } else {
        console.warn(`[build-runtime] 警告：--with-node 但 assets/node/${args.platform}/bin/node 不存在，跳过内置 node 组件`)
      }
    }

    // 4) manifest.json
    const manifest = { name: 'dsh-remote', version, platform: args.platform, requiresNode: '>=18', components }
    writeFileSync(join(tmp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

    // 5) 系统 tar 打包（with-node 变体用 .with-node.tar.gz 后缀，与 slim 产物并存不互相覆盖）
    mkdirSync(OUT_DIR, { recursive: true })
    const tarName = args.withNode && components.some((c) => c.path === 'node/bin/node')
      ? `dsh-remote-${version}-${args.platform}.with-node.tar.gz`
      : `dsh-remote-${version}-${args.platform}.tar.gz`
    const tarPath = join(OUT_DIR, tarName)
    execFileSync('tar', ['-czf', tarPath, '-C', tmp, '.'], { stdio: 'ignore' })

    // 6) 打印：产物路径 + 大小 + manifest sha256 摘要
    const size = statSync(tarPath).size
    const serverBytes = statSync(serverOut).size
    console.log(`[build-runtime] 产物: ${tarPath} (${(size / 1024).toFixed(1)} KB)`)
    console.log(`[build-runtime] manifest: ${JSON.stringify(manifest)}`)
    console.log(`[build-runtime] manifest sha256: ${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`)
    console.log(`[build-runtime] dsh-remote-server.cjs 体积: ${serverBytes} bytes ${serverBytes < 50_000 ? '(<50KB ✓)' : '(!! 超过 50KB)'}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[build-runtime] 失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})