import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, copyFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh deploy '));
  await mkdir(join(root, 'scripts'));
  const profile = join(root, 'profile');
  const host = join(profile, 'node_modules/@deepseek-ai/dsh');
  await mkdir(host, { recursive: true });
  await writeFile(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.2-rc.1' }));
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'dsh-ssh', main: 'entry.mjs' }));
  await writeFile(join(root, 'entry.mjs'), 'export const name = "fixture";');
  await writeFile(join(profile, 'package.json'), '{}');
  await writeFile(join(profile, 'host.js'), 'original');
  for (const name of ['deploy.mjs', 'host-layout.mjs']) await copyFile(new URL(`../../../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
  await writeFile(join(root, 'scripts/test-compat.mjs'), 'console.log("tests passed");');
  await writeFile(join(root, 'scripts/apply-host-hooks.mjs'), `
    import {writeFileSync} from 'node:fs';
    import {join} from 'node:path';
    const profile = process.argv[process.argv.indexOf('--host') + 1];
    if (process.env.DEPLOY_TEST_MODE === 'precheck-fail') throw new Error('unknown host hook');
    const file = join(profile, 'host.js');
    if (!process.argv.includes('--check')) writeFileSync(file, 'patched');
    console.log(JSON.stringify({files: [{file}]}));
  `);
  await writeFile(join(root, 'scripts/install-profile.mjs'), `
    import {writeFileSync, symlinkSync} from 'node:fs';
    import {join} from 'node:path';
    const profile = process.argv[process.argv.indexOf('--profile') + 1];
    if (process.argv.includes('--apply')) {
      writeFileSync(join(profile, 'package.json'), '{"changed":true}');
      symlinkSync(process.cwd(), join(profile, 'node_modules/dsh-ssh'), process.platform === 'win32' ? 'junction' : 'dir');
      if (process.env.DEPLOY_TEST_MODE === 'install-fail') throw new Error('installation failed');
    }
  `);
  return { root, profile };
}

for (const mode of ['check', 'precheck-fail', 'install-fail', 'success']) {
  test(`deployment orchestration: ${mode}`, async () => {
    const { root, profile } = await fixture();
    try {
      const result = spawnSync(process.execPath, ['scripts/deploy.mjs', '--profile', profile, mode === 'check' ? '--check' : '--apply'], {
        cwd: root, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, DSH_PATCH_BASELINE: '0.1.2-rc.1', DEPLOY_TEST_MODE: mode },
      });
      assert.ifError(result.error);
      assert.equal(result.status, mode.endsWith('fail') ? 1 : 0, result.stderr);
      const changed = mode === 'success';
      assert.equal(await readFile(join(profile, 'host.js'), 'utf8'), changed ? 'patched' : 'original');
      assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), changed ? '{"changed":true}' : '{}');
      if (!changed) await assert.rejects(access(join(profile, 'node_modules/dsh-ssh')));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
