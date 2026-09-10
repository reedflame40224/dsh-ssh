import { createApplication } from './application.mjs';
export const surface = Object.freeze({ apiVersion: 'local.dsh-ssh/v1alpha1', kind: 'RemoteWorkspaces' });
export default {
  activate(context) {
    const ui = context.protocols.client({ apiVersion: 'ui.dsh/v1alpha1', kind: 'ContributionHost' });
    if (!ui) throw new Error('RemoteWorkspaces surface was not negotiated');
    ui.register({ descriptor: { id: 'ssh', surface, content: { title: 'Remote workspaces', abi: 1 } }, localModule: { createApplication } });
  },
};
