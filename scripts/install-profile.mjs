import { readFile, writeFile, mkdir, lstat, symlink, realpath, copyFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostResolver } from './host-layout.mjs';
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
if (!option('--profile')) throw new Error('Usage: node scripts/install-profile.mjs --profile <web-profile> [--terminal <checkout>] [--apply]');
const profile = resolve(option('--profile'));
const packages = [{ name: 'dsh-ssh', directory: resolve(dirname(fileURLToPath(import.meta.url)), '..') }];
if (option('--terminal')) packages.push({ name: 'dsh-terminal', directory: resolve(option('--terminal')) });
const host = hostResolver(profile);
host('@deepseek-ai/dsh');
const adapter = host('@dsh-std/adapter-dsh');
if (adapter.manifest.version !== '0.1.1-rc.2') throw new Error('This installer requires adapter-dsh 0.1.1-rc.2');
const file = join(profile, 'package.json');
const config = JSON.parse(await readFile(file, 'utf8'));
const nm = join(profile, 'node_modules');
try { if ((await lstat(nm)).isSymbolicLink()) throw new Error('Profile node_modules is a shared link; use a dedicated profile dependency directory'); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const pending = [];
for (const item of packages) {
  const pkg = JSON.parse(await readFile(join(item.directory, 'package.json'), 'utf8'));
  if (pkg.name !== item.name) throw new Error(`Unexpected checkout: ${item.directory}`);
  const dest = join(nm, item.name);
  try {
    if (await realpath(dest) !== await realpath(item.directory)) throw new Error(`Existing dependency differs: ${dest}; move it aside before installation`);
  } catch (e) { if (e.code !== 'ENOENT') throw e; pending.push({ ...item, dest }); }
}
config.dependencies = { ...config.dependencies, '@dsh-std/adapter-dsh': adapter.manifest.version,
  ...Object.fromEntries(packages.map(item => [item.name, `link:${item.directory.replaceAll('\\', '/')}`])) };
config.dsh ??= {}; config.dsh.profile ??= {};
config.dsh.profile.bundles = [...new Set([...(config.dsh.profile.bundles ?? []), '@dsh-std/adapter-dsh', ...packages.map(item => item.name)])];
if (args.includes('--apply')) {
  await copyFile(file, `${file}.before-dsh-ssh-${Date.now()}`);
  await mkdir(nm, { recursive: true });
  for (const item of pending) await symlink(item.directory, item.dest, process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(file, JSON.stringify(config, null, 2) + '\n');
}
console.log(JSON.stringify({ applied: args.includes('--apply'), profile, packages, next: 'Run apply-host-hooks.mjs --host <profile> --check, then apply without --check and restart DSH.' }, null, 2));
