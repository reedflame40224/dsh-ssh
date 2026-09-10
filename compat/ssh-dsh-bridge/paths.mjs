import { join } from 'node:path';
import { ConnectionRegistry } from '../ssh-std/vendor/registry.ts';
import { createDshRemotePaths } from '../ssh-std/vendor/remote-paths.ts';

export const name = 'dsh-ssh-paths';
export function apply(ctx) {
  const registry = new ConnectionRegistry({ baseDir: join(process.env.DSH_HOME, 'dsh-ssh') });
  registry.load();
  const paths = createDshRemotePaths(registry);
  const remembered = new Map();
  function match(path) {
    for (const record of registry.list()) if (record.kind === 'ssh' && record.remotePath) remembered.set(record.remotePath, record.id);
    const found = paths.match(path);
    if (found) return found;
    for (const [root, connectionId] of remembered) if (path === root || path?.startsWith(root.endsWith('/') ? root : root + '/')) return { remoteRoot: root, connectionId };
  }
  ctx.provide('dshRemotePaths', { has: path => !!match(path), match, registry });
}
