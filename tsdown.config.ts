/**
 * dsh-ssh bundle build (tsdown), modeled on
 * DSH_BP/packages/ui-custom/tsdown.config.ts (self-contained variant).
 *
 *  - node half: `src/index.ts` → `lib/index.js` (ESM, node platform; `ws`
 *    stays external — the plugin resolves it from its own node_modules at
 *    runtime, same way the harness gateway does);
 *  - browser half: `src/client/index.ts` → `lib/client.js` (CJS, browser
 *    platform; externals are exactly the module-table rows the shell answers
 *    at runtime — react & friends. xterm and its addons are INLINED);
 *  - the browser bundle registers through the shell's
 *    `window.__ModuleLoader__.load({ id, factory })` handoff with the
 *    registration id `dsh-ssh` (must equal the cordis.patch.yml loader
 *    entry name, otherwise browser module boot rejects it);
 *  - CSS Modules (`*.module.css`) are compiled by lightningcss and inject a
 *    `<style data-plugin>` tag at factory execution; plain `.css` imports
 *    (xterm.css, the @font-face sheet) go through the same injector minus
 *    the class map.
 *
 * Run: `pnpm bundle` (both faces) or
 * `pnpm exec tsdown --env.DSH_BUILD_FACE=client` (browser half only).
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transform } from 'lightningcss'

const PACKAGE_ROOT = fileURLToPath(new URL('.', import.meta.url))
/** Standalone plugin: the package root IS the repository root. */
const REPOSITORY_ROOT = PACKAGE_ROOT
const ID = 'dsh-ssh'

const require_ = createRequire(pathToFileURL(PACKAGE_ROOT))

/** Browser platform modules seeded into the shell's frozen module table. */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-ui-theme',
]

/** Module-table rows this client's source imports (type-only imports are erased and never reach the bundle). */
const CLIENT_EXTERNALS: readonly string[] = [
  ...PLATFORM_MODULES,
  '@deepseek-ai/dsh-client-runtime/client',
]

/** Node-half externals: the host resolves these at runtime; everything else inlines. */
const NODE_EXTERNALS: readonly string[] = ['ws']

/** CSS virtual-id wrappers (kept clear of tsdown's own css pipeline). */
const CSS_MODULE_PREFIX = '\0dsh-css-module:'
const CSS_RAW_PREFIX = '\0dsh-css-raw:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Rebase a physical lib-relative source onto a browser URL mirroring the package directory. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const packagePath = relativeSafe(REPOSITORY_ROOT, physicalSource)
  return packagePath.startsWith('src/') ? `../${packagePath}` : source
}

function relativeSafe(from: string, to: string): string {
  const path = to.split(sep)
  const base = from.split(sep)
  while (path.length > 0 && base.length > 0 && path[0] === base[0]) {
    path.shift()
    base.shift()
  }
  const up = base.map(() => '..')
  return [...up, ...path].join('/')
}

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const marker = `${sep}lib${sep}types${sep}`
  const boundary = emitted.indexOf(marker)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + marker.length))
}

/** One plugin-owned `<style data-plugin>` injector, shared by both css flavors. */
function styleInjector(css: string, tagId: string): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    `if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {`,
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ].join('\n')
}

/** Emit the CSS Modules class map plus the style injector. */
async function cssModuleLoader(this: { addWatchFile(file: string): void }, virtualId: string) {
  if (!virtualId.startsWith(CSS_MODULE_PREFIX)) return null
  const fileId = virtualId.slice(CSS_MODULE_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
  // Keeps the physical stylesheet in rolldown's watch graph.
  this.addWatchFile(fileId)
  const source = await readFile(fileId)
  const { code, exports: cssExports } = transform({
    filename: fileId,
    code: source,
    cssModules: { pattern: '[hash]_[local]' },
    minify: true,
  })
  const classMap: Record<string, string> = {}
  for (const [local, exp] of Object.entries(cssExports ?? {})) classMap[local] = exp.name
  const tagId = `${ID}/${basename(fileId)}`
  return [
    styleInjector(code.toString(), tagId),
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

/** Plain `.css` (xterm.css, the @font-face sheet): injector only, no class map. */
async function cssRawLoader(this: { addWatchFile(file: string): void }, virtualId: string) {
  if (!virtualId.startsWith(CSS_RAW_PREFIX)) return null
  const fileId = virtualId.slice(CSS_RAW_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
  this.addWatchFile(fileId)
  const source = await readFile(fileId)
  const { code } = transform({ filename: fileId, code: source, minify: true })
  const tagId = `${ID}/${basename(fileId)}`
  return [
    styleInjector(code.toString(), tagId),
    'export default {};',
  ].join('\n')
}

const clientConfig = {
  name: `${ID}/client`,
  entry: { client: resolvePath(PACKAGE_ROOT, 'src/client/index.ts') },
  outDir: resolvePath(PACKAGE_ROOT, 'lib'),
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  plugins: [{
    name: 'dsh-css-inline',
    resolveId(source: string, importer: string | undefined) {
      if (source.endsWith('.module.css')) {
        const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
        return CSS_MODULE_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      }
      if (!source.endsWith('.css')) return null
      // Bare ids (e.g. '@xterm/xterm/css/xterm.css') resolve against the
      // plugin's own node_modules; relative ids resolve against the importer.
      const abs = source.startsWith('.')
        ? (importer !== undefined ? sourceAssetPath(source, importer) : source)
        : require_.resolve(source)
      return CSS_RAW_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    load(this: { addWatchFile(file: string): void }, virtualId: string) {
      if (virtualId.startsWith(CSS_MODULE_PREFIX)) return cssModuleLoader.call(this, virtualId)
      if (virtualId.startsWith(CSS_RAW_PREFIX)) return cssRawLoader.call(this, virtualId)
      return null
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapPathTransform: browserSourcePath,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

const nodeConfig = {
  name: ID,
  entry: { index: resolvePath(PACKAGE_ROOT, 'src/index.ts') },
  outDir: resolvePath(PACKAGE_ROOT, 'lib'),
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...NODE_EXTERNALS],
  noExternal: (id: string) => (NODE_EXTERNALS.includes(id) ? undefined : true),
  outputOptions: {
    // ESM 落在 .js（package.json "type": "module" 下 .js 即 ESM，与 main 对齐）。
    entryFileNames: 'index.js',
  },
}

export default ({ env }: { env: Record<string, string | undefined> }) => {
  const face = env?.DSH_BUILD_FACE
  if (face === 'host') return [nodeConfig]
  if (face === 'client') return [clientConfig]
  return [nodeConfig, clientConfig]
}
