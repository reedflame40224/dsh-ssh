import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectionRegistry } from './vendor/registry.ts';
import { ScopedConnector } from './connector.mjs';
import { RuntimePool } from './vendor/remote-client.ts';
import { RuntimeManager } from './vendor/runtime.ts';
import { LivenessProbe } from './vendor/liveness.ts';
import { LogHub } from './vendor/loghub.ts';
import { createApi } from './vendor/routes.ts';
import { createDshSshService } from './vendor/service.ts';
import { createDshRemotePaths } from './vendor/remote-paths.ts';
import { createRouters } from './vendor/routers.ts';

export function createApplication({ baseDir, webServer, registerRemoteWorkspace, connectionRegistry }) {
  if (!baseDir) throw new Error('SSH component requires an explicit data directory');
  const registry = connectionRegistry ?? new ConnectionRegistry({ baseDir });
  registry.load();
  const connector = new ScopedConnector({ muxDir: registry.muxDir, askpassDir: registry.askpassDir, knownHosts: join(baseDir, 'known_hosts'),
    async runtimeStep(target, draft, log) {
      if (!target.downloadMethod) return;
      return manager.ensure(target, { method: target.downloadMethod, remoteUrl: draft.ssh.runtimeUrl }, log);
    },
  });
  const pool = new RuntimePool({ connector });
  const manager = new RuntimeManager({ connector, pool, version: '0.2.0', assetsDir: fileURLToPath(new URL('../../assets/runtime/', import.meta.url)) });
  const probe = new LivenessProbe({ registry, connector, pool, onStatus: (id, status) => loghub.pushStatus(id, status) });
  const loghub = new LogHub({ getStatuses: () => probe.getStatuses() });
  const service = createDshSshService({ registry, connector, liveness: probe });
  const paths = createDshRemotePaths(registry);
  const routers = createRouters({ registry, connector, pool, paths, getStatus: id => probe.getStatus(id), log: line => loghub.pushLog('router', line.level, line.msg) });
  const api = createApi({ registry, connector, liveness: probe, loghub, pool, runtimeManager: manager, version: '0.2.0-lab.1',
    registerRemoteWorkspace: id => registerRemoteWorkspace(registry.get(id)) });
  let closed = false, closing;
  const disposers = [], requests = new Set();
  function wrap(handler) {
    return (req, res) => {
      if (closed) { res.writeHead(503); res.end(); return; }
      const request = Promise.resolve().then(() => handler(req, res));
      requests.add(request);
      request.then(() => requests.delete(request), () => requests.delete(request));
      return request;
    };
  }
  function dispose() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      for (const remove of disposers.splice(0).reverse()) remove();
      probe.stop();
      api.dispose();
      loghub.dispose();
      pool.disposeAll();
      await connector.disposeAll();
      await Promise.allSettled([...requests]);
      api.dispose();
    })();
    return closing;
  }
  try {
    for (const route of api.httpRoutes) disposers.push(webServer.register({ ...route, handler: wrap(route.handler) }));
    disposers.push(webServer.registerUpgrade(api.wsRoute));
    probe.start();
  } catch (error) { void dispose(); throw error; }
  return { registry, connector, pool, manager, probe, service, paths, routers, dispose };
}
