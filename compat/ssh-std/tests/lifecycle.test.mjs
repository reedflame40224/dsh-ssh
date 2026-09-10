import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { default: facet, surface } = await import('../host.mjs');
const { ScopedConnector } = await import('../connector.mjs');
const { bindContributionHost } = await import('@dsh-std/ui');

test('SSH requires negotiated capability', () => {
  assert.throws(() => facet.activate({ protocols: { client: () => undefined } }), /not negotiated/);
});

test('SSH contribution releases all routes and allows remount', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'ssh-lifecycle-'));
  const routes = new Map();
  const register = row => { assert.ok(!routes.has(row.path)); routes.set(row.path, row); return () => routes.delete(row.path); };
  const owner = { component: 'local.ssh-std', version: '0.2.0-lab.1', facet: 'host', instanceId: 'test', participantId: 'consumer' };
  const provider = { participantId: 'provider', support: { surfaces: [{ ...surface, modes: ['local-module'] }] },
    register(_owner, row) { return row.localModule.createApplication({ baseDir, webServer: { register, registerUpgrade: register }, registerRemoteWorkspace() {} }).dispose; } };
  try {
    for (let i = 0; i < 2; i++) {
      const binding = bindContributionHost({ surfaces: [{ ...surface, consumer: 'consumer', provider: 'provider', mode: 'local-module' }] }, owner, provider);
      facet.activate({ protocols: { client: () => binding.client } });
      assert.ok(routes.size > 5);
      await binding.close();
      assert.equal(routes.size, 0);
    }
  } finally { rmSync(baseDir, { recursive: true, force: true }); }
});

test('SSH short mux paths, endpoint validation and shutdown rejection', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'ssh-connector-'));
  const connector = new ScopedConnector({ muxDir: `${baseDir}/${'long'.repeat(30)}`, askpassDir: `${baseDir}/askpass`, knownHosts: `${baseDir}/known_hosts` });
  const target = { kind: 'ssh', host: 'fixture.invalid', port: 22, user: 'test', auth: { type: 'password' } };
  try {
    if (process.platform === 'win32') assert.equal(connector.shortMux, undefined);
    else assert.ok(connector.shortMux.startsWith(tmpdir()));
    assert.ok(connector.buildSshArgv(target).includes('StrictHostKeyChecking=accept-new'));
    for (const patch of [{ host: '-bad' }, { user: 'a b' }, { port: 0 }]) assert.throws(() => connector.buildSshArgv({ ...target, ...patch }), /Invalid SSH endpoint/);
    await connector.disposeAll();
    if (connector.shortMux) assert.equal(existsSync(connector.shortMux), false);
    await assert.rejects(connector.testConnect({}), /closed/);
    await connector.disposeAll();
  } finally { await connector.disposeAll(); rmSync(baseDir, { recursive: true, force: true }); }
});
