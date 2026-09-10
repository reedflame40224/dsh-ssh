import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const directory = new URL('../compat/ssh-std/tests/', import.meta.url);
const files = (await readdir(directory)).filter(name => name.endsWith('.test.mjs') && (name !== 'host-hooks.test.mjs' || process.env.DSH_PATCH_ROOT)).map(name => fileURLToPath(new URL(name, directory)));
const child = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
