// Runs in the existing DSH module realm; all stores and React come from that realm.
export function installCompat(ctx, { react, connectionsStore, wizardStore, api, logPopoverStore }) {
  const listeners = new Set();
  let visible = false;
  const setVisible = value => { visible = value; for (const listener of listeners) listener(); };
  const visibility = { getSnapshot: () => visible, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
  const h = react.createElement;
  const button = { border: '1px solid var(--dsw-alias-border-default, #555)', borderRadius: 4, background: 'transparent', color: 'inherit', padding: '5px 9px', cursor: 'pointer' };
  function ConnectRemote({ onClose, disabled }) {
    return h('button', { type: 'button', disabled,
      style: { ...button, alignSelf: 'flex-start', font: 'inherit', fontSize: 13, margin: '4px 0', minHeight: 32 },
      onClick: () => { onClose(); wizardStore.open(); } }, '连接远程工作区');
  }
  for (const parent of ['sidebar.workspaces.directoryFlow', 'conversation.hero.workspace.directoryFlow']) {
    const name = `${parent}.actions`;
    ctx.slots.inject(name, () => ctx.slots.register({ name, id: 'dsh-ssh-connect' }, ConnectRemote));
  }
  function Manager() {
    const shown = react.useSyncExternalStore(visibility.subscribe, visibility.getSnapshot);
    react.useSyncExternalStore(connectionsStore.subscribe, connectionsStore.getVersion);
    const [error, setError] = react.useState('');
    const [busy, setBusy] = react.useState(false);
    react.useEffect(() => { const close = event => { if (event.key === 'Escape') setVisible(false); }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, []);
    const run = async work => { setBusy(true); setError(''); try { await work(); await connectionsStore.refresh(); } catch (cause) { setError(cause.message); } finally { setBusy(false); } };
    if (!shown) return null;
    return h('div', { style: { position: 'fixed', inset: 0, background: '#0008', display: 'grid', placeItems: 'center', zIndex: 100 } },
      h('section', { role: 'dialog', 'aria-modal': true, 'aria-label': 'SSH connections', style: { background: 'var(--dsw-alias-bg-base, #202020)', color: 'var(--dsw-alias-text-primary, #eee)', width: 680, maxWidth: '94vw', maxHeight: '85vh', overflow: 'auto', border: '1px solid #555', borderRadius: 6, padding: 20 } },
        h('header', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 } },
          h('h2', { style: { fontSize: 18, margin: 0, flex: 1 } }, 'SSH connections'),
          h('button', { style: button, onClick: () => { setVisible(false); wizardStore.open(); } }, 'New connection'),
          h('button', { style: button, onClick: () => setVisible(false) }, 'Close')),
        error ? h('div', { role: 'alert', style: { color: '#ff8e8e', overflowWrap: 'anywhere' } }, error) : null,
        connectionsStore.getEntries().length === 0 ? h('p', null, 'No connections') : null,
        ...connectionsStore.getEntries().map(({ connection, status }) => h('div', { key: connection.id, style: { borderTop: '1px solid #555', padding: '12px 0', display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' } },
          h('div', { style: { flex: '1 1 200px', minWidth: 0, overflowWrap: 'anywhere' } },
            h('strong', null, connection.title), h('div', { style: { fontSize: 12, marginTop: 4 } }, status.state, ' · ', connection.remotePath)),
          h('button', { style: button, disabled: busy || status.state !== 'online', onClick: () => {
            setVisible(false);
            window.dispatchEvent(new CustomEvent('dsh-ssh:open-terminal', { detail: { connectionId: connection.id, kind: connection.kind, title: connection.title, remotePath: connection.remotePath } }));
          } }, 'Terminal'),
          h('button', { style: button, disabled: busy, onClick: () => run(() => api.check(connection.id)) }, 'Check'),
          h('button', { style: button, disabled: busy, onClick: () => run(() => api.registerRemoteWorkspace(connection.id)) }, 'Workspace'),
          h('button', { style: button, disabled: busy, onClick: event => { setVisible(false); logPopoverStore.open(connection.id, { left: event.clientX, top: event.clientY, width: 0, height: 0 }); } }, 'Logs'),
          h('button', { style: button, disabled: busy, onClick: () => run(() => api.disconnect(connection.id)) }, 'Disconnect'),
          h('button', { style: button, disabled: busy, onClick: () => run(async () => {
            if (connection.workspaceId) await ctx.get('uiWorkspace')?.deleteWorkspace(connection.workspaceId);
            await api.removeConnection(connection.id);
          }) }, 'Remove')))));
  }
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'dsh-ssh-manager', order: 59,
    inject: () => ({ hooks: { visible: visibility }, onClose: () => setVisible(false) }) }, Manager));
  ctx.effect(() => () => { setVisible(false); listeners.clear(); });
}
