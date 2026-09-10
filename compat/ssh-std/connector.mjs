import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { SshConnector, targetFromDraft } from './vendor/ssh.ts';
import { createWslTransport } from './wsl-transport.mjs';

export class ScopedConnector extends SshConnector {
  constructor(options) {
    const children = new Map();
    const state = { closed: false };
    // Unix-domain ControlPath includes a 40-character SSH hash and is limited to 108 bytes.
    const shortMux = options.muxDir.length > 55 ? mkdtempSync('/tmp/dsh-std-mux-') : undefined;
    super({ ...options, muxDir: shortMux ?? options.muxDir, spawnFn(file, args, opts) {
      const controlExit = args.some((arg, index) => arg === '-O' && args[index + 1] === 'exit');
      if (state.closed || (state.stopping && !controlExit)) throw new Error('SSH component is closed');
      const child = spawn(file, args, opts);
      const exited = new Promise(resolve => { child.once('close', resolve); child.once('error', resolve); });
      children.set(child, exited);
      exited.then(() => children.delete(child));
      return child;
    } });
    this.state = state;
    this.children = children;
    this.targets = new Map();
    this.knownHosts = options.knownHosts;
    this.shortMux = shortMux;
    this.transport = options.transport ?? createWslTransport();
  }
  buildSshArgv(target, options) {
    if (!target || typeof target.host !== 'string' || typeof target.user !== 'string'
      || !target.host.trim() || !target.user.trim() || /[\s\0]/.test(target.host + target.user)
      || target.user.startsWith('-') || target.host.startsWith('-')
      || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error('Invalid SSH endpoint');
    const argv = super.buildSshArgv(target, options);
    const knownHosts = this.transport.hostPath(this.knownHosts, argv[0]);
    argv.splice(1, 0, '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${knownHosts}`, '-o', 'NumberOfPasswordPrompts=1');
    return this.transport.argv(argv);
  }
  async testConnect(draft, log) {
    if (this.state.closed || this.state.stopping) throw new Error('SSH component is closed');
    const target = targetFromDraft(draft);
    // Remember even failed/unsaved wizard connections so their mux is reclaimed.
    this.targets.set(`${target.user}@${target.host}:${target.port}`, { ...target, auth: target.auth.type === 'password' ? { type: 'password' } : target.auth });
    return super.testConnect(draft, log);
  }
  async disposeAll() {
    if (this.closing) return this.closing;
    this.state.stopping = true;
    this.closing = (async () => {
      for (const target of this.targets.values()) await super.close(undefined, target);
      await super.disposeAll();
      this.state.closed = true;
      const pending = [...this.children];
      for (const [child] of pending) child.kill('SIGTERM');
      const timer = setTimeout(() => { for (const [child] of pending) if (this.children.has(child)) child.kill('SIGKILL'); }, 500);
      await Promise.allSettled(pending.map(([, done]) => done));
      clearTimeout(timer);
      await super.disposeAll();
      this.targets.clear();
      if (this.shortMux) rmSync(this.shortMux, { recursive: true, force: true });
    })();
    return this.closing;
  }
}
