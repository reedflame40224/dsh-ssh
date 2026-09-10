import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { release } from 'node:os';

export function createWslTransport({ platform = process.platform, env = process.env,
  kernel = release(), exists = existsSync, read = path => readFileSync(path, 'utf8'),
  windowsPath = path => execFileSync('/usr/bin/wslpath', ['-w', path], { encoding: 'utf8', timeout: 3000 }).trim(),
} = {}) {
  const mode = env.DSH_SSH_WSL_INTEROP ?? 'auto';
  if (!['auto', 'off'].includes(mode)) throw new Error('DSH_SSH_WSL_INTEROP must be auto or off');
  const wsl = mode !== 'off' && platform === 'linux' && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft/i.test(kernel));
  const usesWindows = file => wsl && /^\/mnt\/[a-z]\/.*\.exe$/i.test(file);
  return {
    hostPath(file, executable) {
      if (!usesWindows(executable)) return file;
      return windowsPath(file).replaceAll('\\', '/');
    },
    argv(argv) {
      if (!usesWindows(argv[0])) return argv;
      let registered = false;
      try { registered = /^enabled\b/m.test(read('/proc/sys/fs/binfmt_misc/WSLInterop')); } catch {}
      if (registered) return argv;
      if (!exists('/init')) throw new Error('WSL Windows SSH interop is unavailable: /init is missing');
      // /init consumes the executable path followed by the Windows argv[0].
      return ['/init', argv[0], ...argv];
    },
  };
}
