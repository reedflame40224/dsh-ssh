import test from 'node:test';
import assert from 'node:assert/strict';
import { hostResolver } from '../../../scripts/host-layout.mjs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const resolveHost = hostResolver(process.env.DSH_PATCH_ROOT);
const load = name => import(pathToFileURL(join(resolveHost(`@deepseek-ai/${name}`).directory, 'lib/index.js')));
const { default: Fs } = await load('dsh-fs-local');
const { default: Workspace } = await load('dsh-workspace');
const { default: Bash } = await load('dsh-bash-local');
const { default: Subprocess } = await load('dsh-subprocess-local');

test('host filesystem delegates every public operation to the remote provider', async () => {
  const invoked = [];
  const backend = new Proxy({}, { get: (_, name) => (...args) => { invoked.push({ name, args }); return name; } });
  const subject = { ctx: { get: name => { assert.equal(name, 'fsRemoteRouter'); return { route: () => backend }; } } };
  const target = { displayPath: '/remote/test', targetKey: '/remote/test' };
  for (const [name, args] of [
    ['resolve', ['/remote/test']], ['processPath', [target]], ['processPathFromHostPath', ['/remote/test']],
    ['fileUrl', [target]], ['contains', [target, target]], ['stat', [target]], ['lstat', ['/remote/test']],
    ['readText', [target]], ['streamText', [target]], ['readBytes', [target, undefined, 10]],
    ['listDir', [target]], ['writeText', [target, 'content']], ['editText', [target, {}]],
  ]) assert.equal(await Fs.prototype[name].apply(subject, args), name);
  assert.equal(invoked.length, 13);
});

test('remote workspace creation, lookup and session index skip local IO', async () => {
  const path = '/nonexistent-dsh-remote-workspace';
  const subject = { ctx: { get: name => { assert.equal(name, 'dshRemotePaths'); return { has: input => input === path }; } },
    enqueueOperation: fn => fn(), createCanonical: (input, title) => ({ path: input, title }),
    headers: new Map(), sessionPaths: new Map(), invalidSessionPaths: new Map() };
  assert.deepEqual(await Workspace.prototype.create.call(subject, path, 'Remote'), { path, title: 'Remote' });
  await Workspace.prototype.indexHeader.call(subject, { id: 'session', cwd: path });
  assert.equal(subject.sessionPaths.get('session'), path);
  await assert.rejects(Workspace.prototype.create.call(subject, '/nonexistent-dsh-local-workspace'), { code: 'ENOENT' });
});

test('bash and subprocess route explicit remote cwd before local execution', async () => {
  const cwd = '/nonexistent-dsh-remote-workspace';
  const backend = { resolve: input => input, run: () => 'run', start: () => 'start', spawn: () => 'spawn' };
  const subject = { ctx: { get: () => ({ routeByCwd: input => { assert.equal(input, cwd); return backend; } }) } };
  const spec = { workdir: cwd };
  assert.equal(Bash.prototype.resolve.call(subject, spec), spec);
  assert.equal(await Bash.prototype.run.call(subject, spec), 'run');
  assert.equal(Bash.prototype.start.call(subject, spec), 'start');
  assert.equal(Subprocess.prototype.spawn.call(subject, { cwd }), 'spawn');
});
