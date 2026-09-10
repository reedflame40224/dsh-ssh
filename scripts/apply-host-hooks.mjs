import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { patchWorkspaceClient } from './patch-workspace-client.mjs';
import { hostResolver } from './host-layout.mjs';
import { addDirectoryActions } from './directory-browser-patch.mjs';

const root = process.argv.includes('--host') ? process.argv[process.argv.indexOf('--host') + 1] : process.env.DSH_PATCH_ROOT;
if (!root) throw new Error('Use --host <active-profile-or-node_modules> or set DSH_PATCH_ROOT');
const resolveHost = hostResolver(root);
const baseline = process.env.DSH_PATCH_BASELINE ?? '0.1.2-rc.1';
const backup = process.env.DSH_PATCH_BACKUP ?? join(root, 'patches', `ssh-host-hooks-${baseline}`);
const hash = text => createHash('sha256').update(text).digest('hex');
function replace(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Host hook anchor changed: ${before.slice(0, 100)}`);
  return source.replace(before, after);
}
function prepend(source, signature, body) {
  return replace(source, `\t${signature} {\n`, `\t${signature} {\n${body}\n`);
}
const patches = {
  'dsh-client-ui-workspace': source => patchWorkspaceClient(source, replace),
  'dsh-client-ui-directory-picker-browse': source => {
    source = addDirectoryActions(source);
    const anchor = 'children: t("browser.title")\n\t\t\t\t\t\t\t}),';
    source = replace(source, anchor, anchor + ' renderActions?.({ onClose, disabled: parentInert }),');
    source = replace(source, 'onClose: props.onCancel\n', 'onClose: props.onCancel,\n\t\t\t\trenderActions: owner => props.renderSlot(props.actionSlot, owner)\n');
    for (const prefix of ['conversation.hero.workspace', 'sidebar.workspaces']) {
      const slot = `${prefix}.directoryFlow`;
      source = replace(source, `name: "${slot}",\n\t\t\t\t\tinject: injected`,
        `name: "${slot}",\n\t\t\t\t\tchildren: { "${slot}.actions": { kind: "single", scope: "root" } },\n\t\t\t\t\tinject: () => ({ ...injected(), actionSlot: "${slot}.actions" })`);
    }
    return source;
  },
  'dsh-fs-local': source => {
    const methods = [
      ['async resolve(path, opts)', 'path, opts?.cwd', 'resolve(path, opts)'],
      ['processPath(target)', 'target.displayPath', 'processPath(target)'],
      ['processPathFromHostPath(hostPath)', 'hostPath', 'processPathFromHostPath(hostPath)'],
      ['fileUrl(target)', 'target.displayPath', 'fileUrl(target)'],
      ['contains(parent, child)', 'parent.displayPath', 'contains(parent, child)'],
      ['async stat(target, signal)', 'target.displayPath', 'stat(target, signal)'],
      ['async lstat(path, opts, signal)', 'path, opts?.cwd', 'lstat(path, opts, signal)'],
      ['async readText(target, signal)', 'target.displayPath', 'readText(target, signal)'],
      ['streamText(target, signal)', 'target.displayPath', 'streamText(target, signal)'],
      ['async readBytes(target, signal, maxBytes)', 'target.displayPath', 'readBytes(target, signal, maxBytes)'],
      ['async listDir(target, signal)', 'target.displayPath', 'listDir(target, signal)'],
      ['async writeText(target, content, expected, signal)', 'target.displayPath', 'writeText(target, content, expected, signal)'],
      ['async editText(target, edit, expected, signal)', 'target.displayPath', 'editText(target, edit, expected, signal)'],
    ];
    for (const [signature, route, call] of methods) source = prepend(source, signature,
      `\t\tconst remote = this.ctx.get("fsRemoteRouter")?.route(${route});\n\t\tif (remote !== void 0) return remote.${call};`);
    return source;
  },
  'dsh-bash-local': source => {
    for (const [signature, cwd, call] of [
      ['resolve(request)', 'request.workdir', 'resolve(request)'],
      ['async run(spec)', 'spec.workdir', 'run(spec)'],
      ['start(spec)', 'spec.workdir', 'start(spec)'],
    ]) source = prepend(source, signature, `\t\tconst remote = this.ctx.get("shellRemoteRouter")?.routeByCwd(${cwd});\n\t\tif (remote !== void 0) return remote.${call};`);
    return source;
  },
  'dsh-subprocess-local': source => prepend(source, 'spawn(spec)',
    '\t\tconst remote = this.ctx.get("subprocessRemoteRouter")?.routeByCwd(spec.cwd);\n\t\tif (remote !== void 0) return remote.spawn(spec);'),
  'dsh-workspace': source => {
    source = replace(source, 'static inject = ["storageDomain", "sessionPersistence"];', 'static inject = ["storageDomain", "sessionPersistence", "dshRemotePaths"];');
    source = replace(source, '\thost = {\n', '\thost = {\n\t\tisRemotePath: (path) => this.ctx.get("dshRemotePaths")?.has(path) === true,\n');
    source = prepend(source, 'async create(path, title)', '\t\tif (this.ctx.get("dshRemotePaths")?.has(path) === true) return this.enqueueOperation(() => this.createCanonical(path, title));');
    source = replace(source, 'cwd = await realpathNormalize(header.cwd);', 'cwd = this.host.isRemotePath(header.cwd) ? header.cwd : await realpathNormalize(header.cwd);');
    source = replace(source, 'if (!(await stat(cwd)).isDirectory())', 'if (!this.host.isRemotePath(cwd) && !(await stat(cwd)).isDirectory())');
    source = prepend(source, 'async status()', '\t\tif (this.host.isRemotePath(this.record.path)) return "ok";');
    source = replace(source, '\t\ttry {\n\t\t\tconst path = await realpathNormalize(header.cwd);',
      '\t\tif (this.ctx.get("dshRemotePaths")?.has(header.cwd) === true) {\n\t\t\tthis.sessionPaths.set(header.id, header.cwd);\n\t\t\tthis.invalidSessionPaths.delete(header.id);\n\t\t\treturn;\n\t\t}\n\t\ttry {\n\t\t\tconst path = await realpathNormalize(header.cwd);');
    // Lookup uses the same identity rule as creation.
    source = replace(source, '\t\tconst canonical = await realpathNormalize(path);\n\t\tfor (const entity', '\t\tconst canonical = this.ctx.get("dshRemotePaths")?.has(path) === true ? path : await realpathNormalize(path);\n\t\tfor (const entity');
    return source;
  },
  'dsh-api-session-controller': source => replace(source, 'await mkdir(cwd, { recursive: true });', 'if (this.ctx.get("dshRemotePaths")?.has(cwd) !== true) await mkdir(cwd, { recursive: true });'),
};

let previous = {};
try { previous = JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const pending = [];
for (const [name, patch] of Object.entries(patches)) {
  const { directory, manifest: pkg } = resolveHost(`@deepseek-ai/${name}`);
  if (pkg.version !== baseline) throw new Error(`Unexpected baseline: ${name}@${pkg.version}`);
  const file = join(directory, name.startsWith('dsh-client-ui-') ? 'lib/client.js' : 'lib/index.js');
  const current = await readFile(file, 'utf8');
  const saved = previous.files?.find(row => row.name === name);
  if (saved && ![saved.originalSha256, saved.patchedSha256].includes(hash(current))) throw new Error(`Host package changed outside patcher: ${name}`);
  const original = saved ? await readFile(join(backup, `${name}.original.js`), 'utf8') : current;
  if (saved && hash(original) !== saved.originalSha256) throw new Error(`Invalid backup: ${name}`);
  const patched = patch(original.replaceAll('\r\n', '\n'));
  pending.push({ name, file, original, patched, originalSha256: hash(original), patchedSha256: hash(patched) });
}
if (process.argv.includes('--check')) {
  console.log(JSON.stringify({ ok: true, dryRun: true, baseline, files: pending.map(({ name, file }) => ({ name, file })) }, null, 2));
} else {
await mkdir(backup, { recursive: true });
for (const row of pending) {
  await writeFile(join(backup, `${row.name}.original.js`), row.original);
  await writeFile(row.file, row.patched);
}
const manifest = { baseline, patch: 'ssh-host-hooks-v1', files: pending.map(({ name, file, originalSha256, patchedSha256 }) => ({ name, file, originalSha256, patchedSha256 })) };
await writeFile(join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ ok: true, baseline: manifest.baseline, patchedPackages: pending.map(row => row.name) }));
}
