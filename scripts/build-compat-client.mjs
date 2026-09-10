import { readFile, writeFile } from 'node:fs/promises';
import { installCompat } from '../compat/ssh-dsh-bridge/client-compat.mjs';
const root = new URL('../compat/ssh-dsh-bridge/lib/', import.meta.url);
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const marker = 'function apply(ctx) {';
if (source.split(marker).length !== 2) throw new Error('Original browser entry changed; review compatibility insertion');
let output = source.replace(marker, `${installCompat.toString()}\n\t\t${marker}\n\t\t\tinstallCompat(ctx, { react, connectionsStore, wizardStore, api, logPopoverStore });`);
const logAnchor = 'logPopoverStore.open(conn.id, at);';
if (output.split(logAnchor).length !== 2) throw new Error('SSH row log anchor changed');
output = output.replace(logAnchor, 'logPopoverStore.open(conn.id, { left: at.x, top: at.y, width: 0, height: 0 });');
for (const [before, after] of [
  ['const uiWorkspace = getPluginCtx()?.get("uiWorkspace");', 'const uiWorkspace = getPluginCtx()?.get("workspaces");'],
  ['await uiWorkspace?.deleteWorkspace(workspaceId);', 'await uiWorkspace?.delete(workspaceId);'],
  ['api.registerRemoteWorkspace(connection.id).catch((e) => {', 'api.registerRemoteWorkspace(connection.id).then(() => connectionsStore.refresh()).catch((e) => {'],
]) {
  if (output.split(before).length !== 2) throw new Error(`SSH compatibility anchor changed: ${before}`);
  output = output.replace(before, after);
}
await writeFile(new URL('client.js', root), output);
console.log('Built SSH browser compatibility entry');
