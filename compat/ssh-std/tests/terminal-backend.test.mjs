import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { mountTerminalBackend } from '../../ssh-dsh-bridge/terminal-contribution.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const {
  RemoteSshPtySession,
  registerSshTerminalBackend,
} = await import(pathToFileURL(join(root, 'vendor', 'terminal-backend.ts')).href);

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

class FakeTerminal extends EventEmitter {
  constructor({ resize = true } = {}) {
    super();
    this.output = this;
    this.pid = 7123;
    this.writes = [];
    this.signals = [];
    this.resizeCalls = [];
    this.terminated = 0;
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    if (resize) this.resize = (cols, rows) => { this.resizeCalls.push([cols, rows]); };
  }

  write(data) {
    this.writes.push(data);
    return Promise.resolve();
  }

  signalForeground(signal) {
    this.signals.push(signal);
    return Promise.resolve(9001);
  }

  terminate() {
    this.terminated += 1;
    this.resolveDone({ exitCode: null, signal: 'SIGTERM' });
    this.emit('end');
    return Promise.resolve();
  }

  outputText(text) {
    this.emit('data', Buffer.from(text));
  }

  exit(outcome = { exitCode: 0, signal: null }) {
    this.resolveDone(outcome);
    this.emit('end');
  }
}

function makeRegistration(options = {}) {
  const terminal = new FakeTerminal(options);
  let backend;
  let spawnedSpec;
  const disposer = (options.lifecycle ? mountTerminalBackend : registerSshTerminalBackend)({
    dshSsh: {
      buildRemoteSpawn(spec) {
        return {
          argv: ['ssh', '-tt', spec.connectionId],
          name: 'remote-shell',
          env: { LC_ALL: 'C.UTF-8' },
        };
      },
    },
    paths: { match: path => path.startsWith('/remote') ? { connectionId: 'conn-1', remoteRoot: '/remote' } : undefined, has: path => path.startsWith('/remote') },
    spawnTerminal: async spec => { spawnedSpec = spec; return terminal; },
    terminals: { registerBackend(value) { backend = value; return () => { backend = undefined; }; } },
    idleMs: 1,
    timeoutMs: 80,
    maxReadBytes: 1024,
    scrollbackMaxBytes: 4096,
    scrollbackLines: 20,
    rows: 24,
    cols: 80,
    graceMs: 10,
  });
  return { terminal, get backend() { return backend; }, get spawnedSpec() { return spawnedSpec; }, disposer };
}

async function spawnReady(registration, { cwd = '/remote/project' } = {}) {
  const pending = registration.backend.spawn({
    sessionId: 'pty-1',
    owner: {},
    type: 'ssh',
    cwd,
  });
  await wait(0);
  registration.terminal.outputText('welcome\r\nremote$ ');
  const session = await pending;
  return session;
}

test('facet unload closes active terminals and rejects further spawns', async () => {
  const registration = makeRegistration({ lifecycle: true });
  const backend = registration.backend;
  await spawnReady(registration);
  await registration.disposer();
  assert.equal(registration.terminal.terminated, 1);
  assert.equal(registration.backend, undefined);
  await assert.rejects(backend.spawn({ cwd: '/remote/project' }), /unloading/);
  await registration.disposer();
  assert.equal(registration.terminal.terminated, 1);
});

test('facet unload aborts initialization and awaits pending terminal cleanup', async () => {
  const registration = makeRegistration({ lifecycle: true });
  const pending = registration.backend.spawn({ cwd: '/remote/project' });
  const rejected = assert.rejects(pending);
  await wait(0);
  await registration.disposer();
  await rejected;
  assert.equal(registration.terminal.terminated, 1);
});

test('spawns only registered remote cwd and matches alpha.2 subprocess spec', async () => {
  const registration = makeRegistration({ resize: false });
  try {
    const session = await spawnReady(registration);
    assert.equal(registration.spawnedSpec.cwd, process.cwd());
    assert.deepEqual(registration.spawnedSpec.argv, ['ssh', '-tt', 'conn-1']);
    assert.deepEqual(registration.spawnedSpec.env, { TERM: 'xterm-256color', LC_ALL: 'C.UTF-8' });
    assert.equal(registration.spawnedSpec.rows, 24);
    assert.equal(registration.spawnedSpec.cols, 80);
    assert.equal(session.pid, 7123);
    await session.resize(100, 30);
    await assert.rejects(() => registration.backend.spawn({ sessionId: 'pty-2', owner: {}, type: 'ssh', cwd: '/local' }), /cwd 不在已注册/);
    await session.close('test');
  } finally {
    registration.disposer();
  }
});

test('writes submitted input, returns bounded output, and forwards signals', async () => {
  const registration = makeRegistration();
  try {
    const session = await spawnReady(registration);
    const operation = session.startSend({ text: 'printf hi', submit: true });
    assert.deepEqual(registration.terminal.writes, ['printf hi\r']);
    registration.terminal.outputText('printf hi\r\nhi\r\nremote$ ');
    const result = await operation.done;
    assert.ok(['stdin_read', 'inferred_idle'].includes(result.waitReason));
    assert.match(result.viewport, /hi/);
    assert.deepEqual(operation.readOutput(), { delta: result.viewport, truncated: false });
    assert.deepEqual(await session.signal('SIGTERM'), { delivered: true, targetPgid: 9001 });
    assert.deepEqual(registration.terminal.signals, ['SIGTERM']);
    await session.close('test');
  } finally {
    registration.disposer();
  }
});

test('cancellation interrupts the foreground process and leaves the session usable', async () => {
  const registration = makeRegistration();
  try {
    const session = await spawnReady(registration);
    const operation = session.startSend({ text: 'sleep 30', submit: true });
    assert.equal(operation.cancel(), true);
    await wait(0);
    assert.deepEqual(registration.terminal.signals, ['SIGINT']);
    registration.terminal.outputText('^C\r\nremote$ ');
    const result = await operation.done;
    assert.ok(['stdin_read', 'inferred_idle'].includes(result.waitReason));
    assert.equal(operation.cancel(), false);
    await session.close('test');
  } finally {
    registration.disposer();
  }
});

test('abort signal cancels a send and forwards SIGINT', async () => {
  const registration = makeRegistration();
  try {
    const session = await spawnReady(registration);
    const controller = new AbortController();
    const operation = session.startSend({ text: 'sleep 30', submit: true, signal: controller.signal });
    controller.abort(new Error('cancelled by test'));
    await wait(0);
    assert.deepEqual(registration.terminal.signals, ['SIGINT']);
    registration.terminal.outputText('^C\r\nremote$ ');
    assert.ok(['stdin_read', 'inferred_idle'].includes((await operation.done).waitReason));
    await session.close('test');
  } finally {
    registration.disposer();
  }
});

test('read validates pagination and preserves bounded newest-relative pages', async () => {
  const registration = makeRegistration();
  try {
    const session = await spawnReady(registration);
    registration.terminal.outputText('one\ntwo\nthree\nfour');
    assert.deepEqual(session.read({ offset: 1, count: 2 }), {
      text: 'two\nthree', totalLines: 5, lineBegin: 1, lineEnd: 3, truncated: false,
    });
    assert.throws(() => session.read({ offset: -1 }), /safe integer >= 0/);
    assert.throws(() => session.read({ count: 0 }), /safe integer >= 1/);
    await session.close('test');
  } finally {
    registration.disposer();
  }
});

test('close is idempotent, shared, and detaches output listeners', async () => {
  const registration = makeRegistration();
  try {
    const session = await spawnReady(registration);
    const first = session.close('first');
    const second = session.close('second');
    assert.strictEqual(first, second);
    await Promise.all([first, second]);
    assert.equal(registration.terminal.terminated, 1);
    assert.equal(registration.terminal.listenerCount('data'), 0);
    assert.equal(registration.terminal.listenerCount('end'), 0);
    assert.equal(registration.terminal.listenerCount('error'), 0);
  } finally {
    registration.disposer();
  }
});

test('startup failure cleans up the unpublished terminal', async () => {
  const registration = makeRegistration();
  try {
    await assert.rejects(() => registration.backend.spawn({ sessionId: 'pty-1', owner: {}, type: 'ssh', cwd: '/remote/project' }), /启动超时/);
    assert.equal(registration.terminal.terminated, 1);
  } finally {
    registration.disposer();
  }
});

test('transport failure rejects the active send and terminates the handle', async () => {
  const registration = makeRegistration();
  try {
    const session = await spawnReady(registration);
    const operation = session.startSend({ text: 'broken', submit: true });
    const failure = new Error('output failed');
    registration.terminal.emit('error', failure);
    await assert.rejects(operation.done, /output failed/);
    assert.equal(registration.terminal.terminated, 1);
    await assert.rejects(() => session.close('test'), /output failed/);
  } finally {
    registration.disposer();
  }
});
