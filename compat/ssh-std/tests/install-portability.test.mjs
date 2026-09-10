import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostResolver } from '../../../scripts/host-layout.mjs';
import { addDirectoryActions } from '../../../scripts/directory-browser-patch.mjs';
import { ScopedConnector } from '../connector.mjs';

test('resolve runtime, profile, shared profile and direct node_modules layouts', async () => {
  for (const layout of ['runtime/node_modules', 'profiles/web/node_modules', 'profiles/node_modules', 'node_modules']) {
    const root = await mkdtemp(join(tmpdir(), 'dsh-layout-'));
    const packageDir = join(root, layout, '@deepseek-ai/dsh-workspace');
    try {
      await mkdir(packageDir, { recursive: true });
      await writeFile(join(packageDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-workspace', version: '0.1.2-rc.1' }));
      assert.equal(hostResolver(root)('@deepseek-ai/dsh-workspace').directory, packageDir);
      assert.equal(hostResolver(join(root, layout))('@deepseek-ai/dsh-workspace').directory, packageDir);
      assert.throws(() => hostResolver(root)('@deepseek-ai/missing'), /Cannot resolve/);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('directory action patch preserves extra parameters, aliases and defaults', () => {
  for (const extra of ['', 'pickNativeDirectory, validateDirectory,', 'pickNativeDirectory: pick = null,']) {
    const source = `function DirectoryBrowser({ open, listDirectory, createDirectory, ${extra} onOpen, onClose, busy, t }) { return open; }`;
    const patched = addDirectoryActions(source);
    assert.ok(patched.includes('t, renderActions'));
    assert.ok(patched.includes(extra));
    assert.throws(() => addDirectoryActions(patched), /already extended/);
  }
  assert.throws(() => addDirectoryActions('function DirectoryBrowser({open}) {}'), /missing required/);
  assert.throws(() => addDirectoryActions('function Other() {}'), /Expected one/);
});

test('native Windows never allocates a Unix mux socket or passes ControlMaster', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-native-'));
  const connector = new ScopedConnector({ muxDir: join(root, 'mux'), askpassDir: join(root, 'askpass'), knownHosts: join(root, 'known hosts') });
  try {
    const argv = connector.buildSshArgv({ host: 'example.invalid', port: 22, user: 'user', kind: 'ssh', auth: { type: 'key', identityFile: 'C:/keys/id' } }, { tty: true });
    assert.equal(connector.shortMux, undefined);
    assert.ok(!argv.some(arg => /ControlMaster|ControlPath|ControlPersist/.test(arg)));
    assert.ok(argv.includes('-tt'));
  } finally { await connector.disposeAll(); await rm(root, { recursive: true, force: true }); }
});
