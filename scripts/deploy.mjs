import { spawnSync } from 'node:child_process';
import { readFile, writeFile, lstat, realpath, unlink } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { hostResolver } from './host-layout.mjs';

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  profile: { type: 'string' }, terminal: { type: 'string' },
  apply: { type: 'boolean' }, check: { type: 'boolean' }, help: { type: 'boolean' },
} });
if (values.help) {
  console.log('node scripts/deploy.mjs [--profile <web-profile>] [--terminal <checkout>] [--check | --apply]\nDefault: check only. Stop DSH before --apply. Requires installed host, adapter and checkout dependencies.');
} else {
  await deploy().catch(error => { console.error(`Deployment failed: ${error.message}`); process.exitCode = 1; });
}

function run(script, args = [], cwd = checkout, env = process.env) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script}: ${result.stderr || result.stdout || `exit ${result.status}`}`);
  return result.stdout;
}

async function deploy() {
  if (values.apply && values.check) throw new Error('Choose --check or --apply, not both');
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or newer is required; current: ' + process.version);
  const profile = resolve(values.profile ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'web'));
  const plugins = [{ name: 'dsh-ssh', directory: checkout }];
  if (values.terminal) plugins.push({ name: 'dsh-terminal', directory: resolve(values.terminal) });
  const host = hostResolver(profile);
  const version = host('@deepseek-ai/dsh').manifest.version;
  const baseline = process.env.DSH_PATCH_BASELINE ?? '0.1.2-rc.1';
  if (version !== baseline) throw new Error(`DSH ${version} does not match baseline ${baseline}`);
  console.log(`Checking ${process.platform}, Node ${process.version}, DSH ${version}\nProfile: ${profile}`);

  const ssh = spawnSync('ssh', ['-V'], { encoding: 'utf8', timeout: 10000 });
  if (ssh.error || ssh.status !== 0) throw new Error('OpenSSH is unavailable on PATH; install the OpenSSH client first');
  console.log('OpenSSH executable: OK');
  for (const plugin of plugins) {
    const directory = await realpath(plugin.directory);
    if (directory.split(sep).some(part => part.toLowerCase() === 'node_modules')) throw new Error(`${plugin.name}: keep the checkout outside node_modules for TypeScript loading`);
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (pkg.name !== plugin.name) throw new Error(`Unexpected checkout: ${directory}`);
    // Importing the entry checks dependency resolution and native TS loading without activating the plugin.
    run('--input-type=module', ['-e', 'await import(process.argv[1])', pathToFileURL(join(directory, pkg.main)).href], directory);
  }
  const installArgs = ['--profile', profile, ...(values.terminal ? ['--terminal', resolve(values.terminal)] : [])];
  run('scripts/install-profile.mjs', installArgs);
  const plan = JSON.parse(run('scripts/apply-host-hooks.mjs', ['--host', profile, '--check']));
  console.log(`Profile dependencies and ${plan.files.length} host source hooks: OK`);
  for (const plugin of plugins) {
    const output = run('scripts/test-compat.mjs', [], plugin.directory, { ...process.env, DSH_PATCH_ROOT: '' });
    console.log(`${plugin.name} compatibility tests: OK`);
    if (!output.trim()) throw new Error(`${plugin.name}: test runner returned no results`);
  }
  if (process.platform === 'win32') console.log('Windows SSH password authentication is not supported; use a key. Remote connectivity is not tested by deployment.');
  if (!values.apply) { console.log('All checks passed. Stop DSH, then rerun with --apply to deploy.'); return; }

  const snapshot = new Map();
  for (const file of [join(profile, 'package.json'), ...plan.files.map(row => row.file)]) snapshot.set(file, await readFile(file));
  const newLinks = [];
  for (const plugin of plugins) {
    const file = join(profile, 'node_modules', plugin.name);
    try { await lstat(file); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      newLinks.push({ file, directory: await realpath(plugin.directory) });
    }
  }
  try {
    run('scripts/apply-host-hooks.mjs', ['--host', profile]);
    run('scripts/install-profile.mjs', [...installArgs, '--apply']);
    run('scripts/apply-host-hooks.mjs', ['--host', profile, '--check']);
    run('scripts/test-compat.mjs', [], checkout, { ...process.env, DSH_PATCH_ROOT: profile });
  } catch (error) {
    const failures = [];
    for (const [file, bytes] of snapshot) {
      try { await writeFile(file, bytes); } catch (restoreError) { failures.push(`${file}: ${restoreError.message}`); }
    }
    for (const link of newLinks) {
      try {
        if ((await lstat(link.file)).isSymbolicLink() && await realpath(link.file) === link.directory) await unlink(link.file);
      } catch (restoreError) { if (restoreError.code !== 'ENOENT') failures.push(`${link.file}: ${restoreError.message}`); }
    }
    throw new Error(`${error.message}\n${failures.length ? `Rollback incomplete: ${failures.join('; ')}` : 'Profile and host files restored; patch backups retained.'}`);
  }
  console.log(`Deployment complete. Start DSH with the same DSH_HOME and Web profile.\nHost backups: ${process.env.DSH_PATCH_BACKUP ?? join(profile, 'patches', `ssh-host-hooks-${baseline}`)}`);
}
