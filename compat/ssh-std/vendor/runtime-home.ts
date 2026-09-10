// Lab-specific remote namespace; never replace an existing production runtime.
export const REMOTE_HOME = process.env.DSH_SSH_STD_REMOTE_HOME || '.dsh-remote-std-lab'
if (!/^\.dsh-remote-std-lab(?:-[a-z0-9-]+)?$/.test(REMOTE_HOME)) throw new Error('Invalid isolated remote runtime directory')
