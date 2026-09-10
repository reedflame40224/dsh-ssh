export function patchWorkspaceClient(source, replace) {
  source = replace(source, 'function apply(ctx) {', 'function apply(ctx) {\n\t\t\tgetWorkspaceRowExt = () => ctx.get("workspaceRowExt");');
  source = replace(source, 'function ProjectRowItem({', 'let getWorkspaceRowExt = () => undefined;\n\t\tfunction ProjectRowItem({');
  const start = source.indexOf('function ProjectRowItem({');
  const end = source.indexOf('\n\t\t/* v8 ignore next 3', start);
  if (end < 0) throw new Error('Workspace row boundary changed');
  let row = source.slice(start, end);
  row = replace(row, 'const workspaceMenuItems = [{', `const ext = getWorkspaceRowExt();
      (0, react.useSyncExternalStore)(listener => ext?.subscribe(listener) ?? (() => {}), () => ext?.getVersion() ?? 0);
      const deco = row.workspaceId ? ext?.decorate(row.cwd ?? '', row.workspaceId) : undefined;
      const pointer = (0, react.useRef)({ x: 0, y: 0 });
      (0, react.useEffect)(() => {
        if (!menuOpen) return;
        const track = event => { pointer.current = { x: event.clientX, y: event.clientY }; };
        document.addEventListener('pointerdown', track, true);
        return () => document.removeEventListener('pointerdown', track, true);
      }, [menuOpen]);
      const workspaceMenuItems = [{`);
  row = replace(row, 'const ownRow =', `if (row.workspaceId) workspaceMenuItems.push(...(ext?.menuItems(row.workspaceId, row.cwd ?? '') ?? []));
      const ownRow =`);
  row = replace(row, '"aria-expanded": row.expanded,', '"aria-expanded": row.expanded,\n title: deco?.title,');
  row = replace(row, 'children: row.expanded ?', `"data-remote-icon": deco?.icon,
      children: deco ? (0, react.createElement)('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
        (0, react.createElement)('path', { d: deco.icon === 'cloud' ? 'M4.2 12.5a3.2 3.2 0 1 1 .6-6.36 4.4 4.4 0 1 1 8.14 1.86A3.5 3.5 0 0 1 12 12.5Z' : 'M2.5 3.5h11v9h-11Z M2.5 6h11' })) : row.expanded ?`);
  row = replace(row, 'children: label', `children: (0, react.createElement)(react.Fragment, null, label, deco?.statusColor && (0, react.createElement)('span', { 'data-remote-dot': true, 'aria-hidden': true, style: { display: 'inline-block', width: 6, height: 6, borderRadius: '50%', marginLeft: 8, verticalAlign: 'middle', background: deco.statusColor } }))`);
  row = replace(row, 'if (id !== "rename" && id !== "delete") return;', `if (id !== "rename" && id !== "delete") { ext?.onSelect(row.workspaceId, row.cwd ?? '', id, pointer.current); return; }`);
  return source.slice(0, start) + row + source.slice(end);
}
