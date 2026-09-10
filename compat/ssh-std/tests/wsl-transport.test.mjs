import test from 'node:test';
import assert from 'node:assert/strict';
import { createWslTransport } from '../wsl-transport.mjs';
const exe = '/mnt/c/Windows/System32/OpenSSH/ssh.exe';
const options = { platform: 'linux', env: { WSL_DISTRO_NAME: 'Example' }, kernel: 'microsoft', exists: () => true,
  read: () => { throw new Error('missing'); }, windowsPath: () => '\\\\wsl.localhost\\Example\\home\\user\\known_hosts' };
test('missing WSL handler preserves Windows argv[0] and every argument', () => {
  const transport = createWslTransport(options);
  const argv = [exe, '-i', 'C:\\Keys\\my key', 'user@host', 'printf "hello world"'];
  assert.deepEqual(transport.argv(argv), ['/init', exe, ...argv]);
  assert.equal(transport.hostPath('/home/user/known_hosts', exe), '//wsl.localhost/Example/home/user/known_hosts');
});
test('native Windows, Linux, macOS and Linux SSH retain their transport', () => {
  for (const override of [{ platform: 'win32' }, { platform: 'darwin' }, { env: {}, kernel: 'generic' }, { env: { DSH_SSH_WSL_INTEROP: 'off' } }]) {
    const transport = createWslTransport({ ...options, ...override });
    const argv = [exe, '-V'];
    assert.equal(transport.argv(argv), argv);
    assert.equal(transport.hostPath('/home/user/known_hosts', exe), '/home/user/known_hosts');
  }
  const argv = ['/usr/bin/ssh', '-V'];
  assert.equal(createWslTransport(options).argv(argv), argv);
});
test('enabled PE handler is used directly, disabled handler uses init', () => {
  const argv = [exe, '-V'];
  assert.equal(createWslTransport({ ...options, read: () => 'enabled\n' }).argv(argv), argv);
  assert.equal(createWslTransport({ ...options, read: () => 'disabled\n' }).argv(argv)[0], '/init');
  assert.throws(() => createWslTransport({ ...options, exists: () => false }).argv(argv), /unavailable/);
});
