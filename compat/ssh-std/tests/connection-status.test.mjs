import test from 'node:test';
import assert from 'node:assert/strict';
import { SshConnector } from '../vendor/ssh.ts';

test('password connection checks the live mux after a remote command fails', async () => {
  const target = { auth: { type: 'password' } };
  const connector = Object.create(SshConnector.prototype);
  connector.muxAlive = new Set(['server']);
  connector.muxSupported = () => true;
  connector.muxKey = () => 'server';
  connector.runRemote = async () => ({ code: 1, stdout: '', stderr: 'missing file' });
  assert.equal((await connector.exec(target, 'test -f missing')).code, 1);
  let checks = 0;
  connector.control = async (_, action) => { assert.equal(action, 'check'); checks++; return { code: 0 }; };
  assert.equal(await connector.check(target), true);
  assert.equal(checks, 1);
  connector.control = async () => ({ code: 255 });
  assert.equal(await connector.check(target), false);
});
