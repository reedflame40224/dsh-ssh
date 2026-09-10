import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import facet, { surface } from '../ssh-std/host.mjs';
import { mountTerminalBackend } from './terminal-contribution.mjs';

export const name = 'dsh-ssh-std-bridge';
export const inject = ['dshStd', 'webServer', 'connection', 'terminals', 'subprocess', 'systemPrompt', 'dshRemotePaths'];

export async function apply(ctx) {
  let active;
  const baseDir = join(process.env.DSH_HOME, 'dsh-ssh');
  const paths = ctx.dshRemotePaths;
  const { registry, match } = paths;
  const current = () => { if (!active) throw new Error('SSH component is inactive'); return active; };
  for (const name of ['fsRemoteRouter', 'shellRemoteRouter', 'subprocessRemoteRouter']) {
    const route = name === 'fsRemoteRouter' ? 'route' : 'routeByCwd';
    ctx.provide(name, { [route](path, cwd) {
      const absolute = name === 'fsRemoteRouter' && cwd && !path.startsWith('/') ? join(cwd, path) : path;
      if (!match(absolute)) return;
      const value = current().routers[name][route](path, cwd);
      if (!value) throw new Error('Remote connection was removed; refusing local fallback');
      return value;
    } });
  }
  const sshService = {
    listTargets: () => active?.service.listTargets() ?? [],
    buildRemoteSpawn: spec => current().service.buildRemoteSpawn(spec),
  };
  ctx.provide('dshSsh', sshService);
  const webServer = {
    register(route) {
      return ctx.webServer.register({ ...route, handler(req, res) {
        const rejected = ctx.connection.requestRejection(req);
        if (rejected !== undefined) { res.writeHead(rejected); res.end(); return; }
        return route.handler(req, res);
      } });
    },
    registerUpgrade(route) {
      return ctx.webServer.registerUpgrade({ ...route, handler(req, socket, head) {
        const rejected = ctx.connection.requestRejection(req);
        if (rejected !== undefined) { socket.end(`HTTP/1.1 ${rejected} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); return; }
        return route.handler(req, socket, head);
      } });
    },
  };
  function mountExtras() {
    const terminalDispose = mountTerminalBackend({ dshSsh: sshService, paths,
      terminals: ctx.terminals, spawnTerminal: spec => ctx.subprocess.spawnTerminal(spec) });
    const prompt = ctx.systemPrompt;
    const sectionDispose = prompt.section({ name: 'dsh-ssh-remote', order: 1800, text: '{{dsh_ssh_remote_hint}}' });
    const variableDispose = prompt.variable('dsh_ssh_remote_hint', context => {
      const cwd = context.agent?.session?.header?.cwd;
      const target = cwd && match(cwd);
      return target ? `This workspace is on SSH connection ${target.connectionId}. File and command operations under ${target.remoteRoot} run remotely. Use terminal_open with type "ssh" for an interactive terminal. Remote shell execution uses the SSH account permissions and requires full-access mode. Keep operations inside this workspace unless explicitly requested otherwise.` : '';
    });
    return async () => { variableDispose(); sectionDispose(); await terminalDispose(); };
  }
  const unregister = ctx.dshStd.registerUiContributionProvider({
    participantId: 'local.dsh-ssh.workspace-provider', support: { surfaces: [{ ...surface, modes: ['local-module'] }] },
    register(owner, contribution) {
      if (active || owner.component !== 'local.ssh-std' || contribution.descriptor.content.abi !== 1) throw new Error('Invalid or duplicate SSH surface');
      active = contribution.localModule.createApplication({
        baseDir, webServer, connectionRegistry: registry,
        async registerRemoteWorkspace(record) {
          if (!record?.remotePath) return { ok: false, error: 'Connection has no remote directory' };
          const workspaces = ctx.get('workspaceRegistry');
          if (!workspaces) return { ok: false, error: 'Workspace registry is not ready' };
          const workspace = await workspaces.create(record.remotePath, record.title);
          registry.updateWorkspaceId(record.id, String(workspace.id));
          return { ok: true, workspaceId: String(workspace.id) };
        },
      });
      let extras;
      try { extras = mountExtras(); }
      catch (error) { const app = active; active = undefined; void app.dispose(); throw error; }
      return async () => { const app = active; active = undefined; try { await extras(); } finally { await app.dispose(); } };
    },
  });
  let unmount;
  try {
    const manifest = JSON.parse(await readFile(new URL('../ssh-std/component.manifest.json', import.meta.url), 'utf8'));
    unmount = await ctx.dshStd.mount({ manifest, facet: 'host', activate: context => facet.activate(context) });
  } catch (error) { await unregister(); throw error; }
  ctx.effect(() => async () => { try { await unmount(); } finally { await unregister(); } });
}
