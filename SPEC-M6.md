# dsh-ssh — M6 实施规范：远程工作区全集成进原生列表（编码子代理必读）

目标（用户拍板）：**删除侧栏「远程」分区**，远程工作区全集成进原生工作区列表——云图标替换文件夹图标、行内状态点、⋯菜单追加远程管理项。ZCode 图2 的混排形态。

前置：M1+M2+M5 全部完成（SPEC-M1/M2/M5 有效）。本规范是 M6 唯一契约来源。

## 已验证事实
- ui-workspace 行渲染：packages/client/ui-workspace/src/client/rows/Rows.tsx——工作区行图标 `IconFolderClose16`/`IconFolderOpen16`（~L149），⋯菜单 `workspaceMenuItems`（rename/delete，~L128）+ `Menu` 组件；`StateDot` 已 import。Rows 的数据从 WorkspaceBrowser 经 props 下来。
- 客户端 cordis 同样支持 `ctx.provide`/`ctx.get`（ui-workspace 的 UiWorkspaceService 就是 client 侧 Service：`super(ctx,'uiWorkspace')`）。
- **加载顺序**：dsh-ssh 在 profile bundles 里位于 ui-workspace 之后——ui-workspace apply 时我们的服务还没 provide。所以缝必须是**惰性 getter**（每次 render 时 `getRowExt()` 取当前值），不能是 apply 期捕获。
- uiWorkspace 服务（client cordis 服务，packages/client/ui-workspace/src/client/navigation.ts）：`startSession(workspaceId?)`、`deleteWorkspace(id)`、`renameWorkspace` 等（M5 行点击已在用 startSession）。
- dsh-ssh client 已有：connectionsStore（HostObservable 模式 subscribe/getVersion）、api.*、LogPopover（原挂在 RemoteSection 里）、CloudIcon/WindowIcon 内联 SVG。

## 冻结契约：workspaceRowExt 服务（client 侧 cordis，dsh-ssh 提供，ui-workspace 可选消费）

```ts
// 菜单追加项（渲染在 rename/delete 之后）
interface WorkspaceRowExtItem { id: string; label: string; danger?: boolean }
interface WorkspaceRowExt {
  /** 行装饰：path 命中远程根 → {icon, statusColor?, title?}；未命中 undefined（= 默认文件夹图标） */
  decorate(path: string, workspaceId: string): {
    icon: 'cloud' | 'window'          // 云=ssh 远程 / 窗口=WIN
    statusColor?: string              // 状态点色值（在线绿/离线灰/checking 蓝）；缺席=无点
    title?: string                    // 行 hover title 附加（如 'kali@192.168.184.131（在线）'）
  } | undefined
  /** 追加到 ⋯ 菜单的远程管理项 */
  menuItems(workspaceId: string, path: string): WorkspaceRowExtItem[]
  /** 菜单项选中；at=点击处视口坐标（供日志浮层定位） */
  onSelect(workspaceId: string, path: string, itemId: string, at: { x: number; y: number }): void
  /** HostObservable 形状：驱动 Rows 重渲染（状态点/装饰变化） */
  subscribe(listener: () => void): () => void
  getVersion(): number
}
```

## W6-harness（ui-workspace 补丁）

拥有路径：packages/client/ui-workspace/**（src+tests）。
1. 新类型 + cordis 扩增：slots.ts 或新文件声明 `WorkspaceRowExt` + `declare module '@deepseek-ai/cordis' { interface Context { workspaceRowExt?: WorkspaceRowExt } }`（若 client 运行时类型不是这个包名，以现实为准并注释）。
2. client/index.ts：组装 WorkspaceBrowser 的注入面时加惰性 `getRowExt: () => ctx.get('workspaceRowExt')`（**函数不是值**）；类型沿 PropsHooks/Injected 链透传。
3. Rows.tsx：工作区行渲染处——`const ext = getRowExt?.()`（每 render 取）；ext 存在且有 subscribe → `useSyncExternalStore(ext.subscribe, ext.getVersion)`；`const deco = ext?.decorate(row.path, row.workspaceId)`：icon==='cloud' → 渲染云图标（ui 图标库里有云就用，没有就内联 SVG——先 grep IconCloud），'window' → 窗口图标，均替换文件夹图标位；deco.statusColor → 行尾标题区渲染 StateDot（该色）；deco.title → 追加进行 title。菜单：items = [...现有, ...(ext?.menuItems(row.workspaceId, row.path) ?? []).map(→ Menu item 形状)]；Menu onSelect 里：rename/delete 走原逻辑，其余 id 调 `ext.onSelect(row.workspaceId, row.path, id, {x: 点击 clientX, y: clientY})`。
4. 回归：无 ext 时逐字节原行为（现有测试全绿）；新增用例：提供假 ext → 云图标出现/状态点颜色/菜单追加/onSelect 收到坐标。
5. 自检：pnpm vitest run packages/client/ui-workspace 全绿；tsc -b tsconfig.client.json 过；oxlint 0 警；`pnpm --filter @deepseek-ai/dsh-client-ui-workspace bundle` 重建 lib。

## W6-client（dsh-ssh）

拥有路径：Plugin/dsh-ssh/src/client/**。
1. 删除：`sidebar.workspaces.sections` 注册（index.ts）+ `section/RemoteSection.ts` + `section/Section.module.css` 删除；LogPopover.ts 保留移用。
2. 新 `rowext.ts`：实现 workspaceRowExt 并 `ctx.provide('workspaceRowExt', …)`（apply 顶部；ctx 从 setPluginCtx 捕获的拿——把 provide 移到 index.ts apply 里直接做更稳）。decorate：path 命中连接的 remotePath（前缀匹配、目录边界）→ ssh=cloud/win=window，statusColor 读 connectionsStore 状态色（statusColors 令牌），title=`user@host（状态）`；subscribe/getVersion 桥接 connectionsStore。menuItems：`[{打开终端},{重新连接},{查看日志},{删除连接 danger}]`；onSelect：打开终端=dispatch dsh-ssh:open-terminal；重新连接=api.check+applyStatus；查看日志=开 LogPopover（见下）；删除连接=api.removeConnection + 顺带 uiWorkspace.deleteWorkspace(workspaceId)（有 workspaceId 时，删除的是注册记录——安全）。
3. LogPopover 重挂：注册一个 shell.overlay 条目（order 62），visible-store 模式读一个新 logPopoverStore（{open, anchorRect, channelKey}）；行菜单「查看日志」→ 开它。
4. index.ts apply 里删 sections 注册，保留 remoteFlow（向导）+ wizard overlay + ws-bridge + setPluginCtx。
5. 自检：pnpm exec tsdown --env.DSH_BUILD_FACE=client 零报错；产物 grep 含 workspaceRowExt 与「打开终端/重新连接/查看日志/删除连接」；Node 24 类型擦除冒烟。

## 验收（主代理）
1. ui-workspace vitest 全绿 + tsc client 过；dsh-ssh 7 e2e 不回归 + bundle 绿。
2. verify 实例：pwn/MyEcs 行=云图标+状态点、无「远程」分区、点行开会话、⋯菜单四项可用、本地行零变化。
3. 提交：harness 补丁一个 commit + dsh-ssh 一个 commit。

## 边界
- 不动其它包/插件；不 git commit（主代理统一提交）；无 ext 时逐字节原行为是硬要求。
- icon 优先用 ui-workspace 现有图标库（grep IconCloud）；没有才内联 SVG（照抄 dsh-ssh 的 CloudIcon path）。
