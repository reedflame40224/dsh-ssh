import test from 'node:test';
import assert from 'node:assert/strict';
import { SshConnector } from '../vendor/ssh.ts';
test('non-multiplexed liveness requires remote command exit code zero', async () => {
  const target = { kind: 'ssh', auth: { type: 'key' } };
  for (const code of [0, 1, 255]) {
    const connector = { muxKey: () => 'test', muxSupported: () => false, exec: async () => ({ code }) };
    assert.equal(await SshConnector.prototype.check.call(connector, target), code === 0);
  }
});
