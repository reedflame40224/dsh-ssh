import { registerSshTerminalBackend } from '../ssh-std/vendor/terminal-backend.ts';

export function mountTerminalBackend({ terminals, ...deps }) {
  const sessions = new Set(), pending = new Set(), controllers = new Set();
  let stopping = false, closing;
  const unregister = registerSshTerminalBackend({ ...deps, terminals: {
    registerBackend(backend) {
      return terminals.registerBackend({ ...backend, async spawn(spec) {
        if (stopping) throw new Error('SSH backend is unloading');
        const controller = new AbortController();
        controllers.add(controller);
        const abort = () => controller.abort(spec.signal.reason);
        spec.signal?.addEventListener('abort', abort, { once: true });
        if (spec.signal?.aborted) abort();
        const task = backend.spawn({ ...spec, signal: controller.signal });
        pending.add(task);
        try {
          const session = await task;
          if (stopping) { await session.close('SSH backend unloaded during spawn'); throw new Error('SSH backend is unloading'); }
          sessions.add(session);
          const close = session.close.bind(session);
          session.close = async reason => { await close(reason); sessions.delete(session); };
          return session;
        } finally {
          pending.delete(task);
          controllers.delete(controller);
          spec.signal?.removeEventListener('abort', abort);
        }
      } });
    },
  } });
  return () => {
    if (closing) return closing;
    stopping = true;
    unregister();
    for (const controller of controllers) controller.abort(new Error('SSH backend unloaded'));
    closing = (async () => {
      await Promise.allSettled([...pending]);
      const results = await Promise.allSettled([...sessions].map(session => session.close('SSH backend unloaded')));
      const errors = results.filter(row => row.status === 'rejected').map(row => row.reason);
      if (errors.length) throw new AggregateError(errors, 'SSH terminal cleanup failed');
    })();
    return closing;
  };
}
