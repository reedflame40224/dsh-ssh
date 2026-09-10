import { createRequire } from 'node:module';
import { existsSync, realpathSync, readFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

export function hostResolver(input) {
  const root = resolve(input);
  // Prefer the selected profile, then its shared dependencies. Never use global resolution.
  const locations = [root, join(root, 'profiles/web'), join(root, 'profiles'), join(root, 'runtime')];
  return name => {
    for (const location of locations) {
      const candidates = [join(location, 'node_modules', name, 'package.json'), join(location, name, 'package.json')];
      for (const file of candidates) if (existsSync(file)) return validate(file, name);
      try {
        const file = createRequire(join(location, 'package.json')).resolve(`${name}/package.json`);
        return validate(file, name);
      } catch (error) {
        if (!['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error;
      }
    }
    throw new Error(`Cannot resolve ${name} from ${root}; select the active DSH profile or its node_modules directory`);
  };
}
function validate(file, name) {
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  if (manifest.name !== name) throw new Error(`Unexpected package at ${file}`);
  return { directory: realpathSync(dirname(file)), manifest };
}
