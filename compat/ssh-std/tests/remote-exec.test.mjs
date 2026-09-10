import test from 'node:test';
import assert from 'node:assert/strict';

const { REMOTE_HOME } = await import('../vendor/runtime-home.ts');
const {
  createRemoteExecFactory,
  createRemoteFsFactory,
} = await import('../vendor/remote-exec.ts');

const match = { connectionId: 'conn-1', remoteRoot: '/remote/workspace' };

function makeDeps({ runtime = false, rpc = async () => ({ code: 0, stdout: '', stderr: '' }), exec = async () => ({ code: 0, stdout: '', stderr: '' }) } = {}) {
  const connectorCalls = [];
  const rpcCalls = [];
  const record = {
    id: 'conn-1',
    kind: 'ssh',
    ssh: { host: 'fixture.invalid', port: 22, user: 'test', auth: { type: 'password' } },
    runtime: { installed: runtime },
  };
  const registry = { get: id => id === record.id ? record : undefined };
  const connector = {
    exec: async (target, command, options) => {
      connectorCalls.push({ target, command, options });
      return exec(command, options);
    },
  };
  const pool = runtime ? {
    get: async () => ({
      call: async (method, params, timeoutMs) => {
        rpcCalls.push({ method, params, timeoutMs });
        return rpc(method, params, timeoutMs);
      },
    }),
  } : undefined;
  return { deps: { registry, connector, pool }, connectorCalls, rpcCalls };
}

function statOutput({ type = 'regular file', size = 7, mtime = 1 } = {}) {
  return `type=${type}|size=${size}|mtime=${mtime}`;
}

test('stat fallback removes GNU stat field labels', async () => {
  const fixture = makeDeps({
    exec: async command => command.includes('stat -c')
      ? { code: 0, stdout: statOutput({ size: 7, mtime: 1700000000 }), stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
  });
  const fs = createRemoteFsFactory(fixture.deps).forMatch(match);

  await assert.doesNotReject(async () => {
    assert.deepEqual(await fs.stat({ targetKey: '/remote/workspace/a.txt', displayPath: '/remote/workspace/a.txt' }), {
      version: 'remote:1700000000000:7',
      type: 'file',
      size: 7,
    });
  });
});

test('runtime read truncation falls back and returns complete text', async () => {
  const fixture = makeDeps({
    runtime: true,
    rpc: async method => {
      if (method === 'fs.readText') return { text: 'partial', truncated: true };
      throw new Error(`unexpected RPC ${method}`);
    },
    exec: async command => command.includes('stat -c')
      ? { code: 0, stdout: statOutput({ size: 8 }), stderr: '' }
      : { code: 0, stdout: 'complete', stderr: '' },
  });
  const fs = createRemoteFsFactory(fixture.deps).forMatch(match);

  const text = await fs.readText({ targetKey: '/remote/workspace/a.txt', displayPath: '/remote/workspace/a.txt' });
  assert.equal(text, 'complete');
  assert.equal(fixture.connectorCalls.filter(call => call.command.includes('stat -c')).length, 1);
  assert.ok(fixture.connectorCalls.some(call => call.command.startsWith('cat --')));
});

test('failed filesystem fallback rejects instead of returning empty output', async () => {
  const fixture = makeDeps({
    exec: async () => ({ code: 2, stdout: '', stderr: 'permission denied' }),
  });
  const fs = createRemoteFsFactory(fixture.deps).forMatch(match);

  await assert.rejects(
    fs.readText({ targetKey: '/remote/workspace/secret.txt', displayPath: '/remote/workspace/secret.txt' }),
    /fs\.stat 失败：permission denied/,
  );
});

test('fallback byte reads enforce the requested size limit', async () => {
  const fixture = makeDeps({
    exec: async command => command.includes('stat -c')
      ? { code: 0, stdout: statOutput({ size: 5 }), stderr: '' }
      : { code: 0, stdout: 'ignored', stderr: '' },
  });
  const fs = createRemoteFsFactory(fixture.deps).forMatch(match);

  await assert.rejects(
    fs.readBytes({ targetKey: '/remote/workspace/a.bin', displayPath: '/remote/workspace/a.bin' }, undefined, 4),
    /exceeds the 4-byte limit/,
  );
  assert.equal(fixture.connectorCalls.filter(call => call.command.startsWith('base64')).length, 0);
});

test('stale write intent is rejected before the write command', async () => {
  const fixture = makeDeps({
    exec: async command => command.includes('stat -c')
      ? { code: 0, stdout: statOutput({ size: 3, mtime: 2 }), stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
  });
  const fs = createRemoteFsFactory(fixture.deps).forMatch(match);

  await assert.rejects(
    fs.writeText(
      { targetKey: '/remote/workspace/a.txt', displayPath: '/remote/workspace/a.txt' },
      'new',
      { kind: 'replaceIfVersion', version: 'remote:1000:3' },
    ),
    /file changed since it was read/,
  );
  assert.equal(fixture.connectorCalls.length, 1);
});

test('failed write fallback rejects instead of reporting a successful write', async () => {
  const fixture = makeDeps({
    exec: async command => {
      if (command.includes('stat -c')) return { code: 0, stdout: statOutput({ size: 3 }), stderr: '' };
      if (command.startsWith('cat --')) return { code: 0, stdout: 'old', stderr: '' };
      if (command.startsWith("printf '%s'")) return { code: 1, stdout: '', stderr: 'read-only filesystem' };
      return { code: 0, stdout: '', stderr: '' };
    },
  });
  const fs = createRemoteFsFactory(fixture.deps).forMatch(match);

  await assert.rejects(
    fs.writeText({ targetKey: '/remote/workspace/a.txt', displayPath: '/remote/workspace/a.txt' }, 'new'),
    /fs\.writeText 失败：read-only filesystem/,
  );
  assert.equal(fixture.connectorCalls.filter(call => call.command.startsWith("printf '%s'")).length, 1);
});

test('ambiguous write RPC failure is surfaced without SSH replay', async () => {
  const fixture = makeDeps({
    runtime: true,
    rpc: async method => {
      if (method === 'fs.stat') return { exists: true, isDir: false, isFile: true, size: 3, mtimeMs: 1000 };
      if (method === 'fs.readText') return { text: 'old', truncated: false };
      if (method === 'fs.writeText') throw new Error('response timeout');
      throw new Error(`unexpected RPC ${method}`);
    },
  });
  const fs = createRemoteFsFactory(fixture.deps).forMatch(match);
  const target = { targetKey: '/remote/workspace/a.txt', displayPath: '/remote/workspace/a.txt' };

  await assert.rejects(fs.writeText(target, 'new', { kind: 'replaceIfVersion', version: 'remote:1000:3' }), /RPC 调用失败/);
  assert.equal(fixture.connectorCalls.length, 0);
});

test('ambiguous edit RPC failure is surfaced without SSH replay', async () => {
  const fixture = makeDeps({
    runtime: true,
    rpc: async method => {
      if (method === 'fs.stat') return { exists: true, isDir: false, isFile: true, size: 3, mtimeMs: 1000 };
      if (method === 'fs.readText') return { text: 'old', truncated: false };
      if (method === 'fs.writeText') throw new Error('response timeout');
      throw new Error(`unexpected RPC ${method}`);
    },
  });
  const fs = createRemoteFsFactory(fixture.deps).forMatch(match);
  const target = { targetKey: '/remote/workspace/a.txt', displayPath: '/remote/workspace/a.txt' };

  await assert.rejects(fs.editText(target, { oldString: 'old', newString: 'new', replaceAll: false }, { version: 'remote:1000:3' }), /RPC 调用失败/);
  assert.equal(fixture.connectorCalls.length, 0);
});

test('exec RPC failure does not execute the command a second time', async () => {
  const fixture = makeDeps({
    runtime: true,
    rpc: async method => {
      if (method === 'exec') throw new Error('channel closed');
      throw new Error(`unexpected RPC ${method}`);
    },
  });
  const exec = createRemoteExecFactory(fixture.deps).forMatch(match);

  const result = await exec.run(exec.resolve({ command: 'touch should-run-once', workdir: '/remote/workspace' }));
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr.text, /exec 调用失败/);
  assert.equal(fixture.connectorCalls.length, 0);
  assert.equal(fixture.rpcCalls.filter(call => call.method === 'exec').length, 1);
});

test('rg spawn uses the lab runtime home', async () => {
  const fixture = makeDeps({
    runtime: true,
    rpc: async method => method === 'exec'
      ? { code: 0, stdout: 'match', stderr: '' }
      : { code: 0, stdout: '', stderr: '' },
  });
  const exec = createRemoteExecFactory(fixture.deps).forMatch(match);

  const handle = exec.spawn({ argv: ['/local/node_modules/rg', 'needle', '.'], cwd: '/remote/workspace' });
  await handle.done;
  const command = fixture.rpcCalls.find(call => call.method === 'exec')?.params.command;
  assert.match(command, new RegExp(`\\$HOME/${REMOTE_HOME}/current/tools/rg`));
  assert.doesNotMatch(command, /\\$HOME\/\.dsh-remote\/current\/tools\/rg/);
  assert.equal(handle.collected.stdout.readFrom(0).text, 'match');
});
