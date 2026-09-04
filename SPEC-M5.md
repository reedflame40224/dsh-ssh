# dsh-ssh — M5 实施规范：会话级远程执行路由（方案 B，编码子代理必读）

目标体验（用户拍板）：远程工作区注册为**原生工作区**混排在本地侧栏；在其上开会话与本地会话**操作零差别**——不新增任何界面元素、不改现有 UI、不要新标签。agent 的 bash/read/write/edit/glob/grep/terminal 工具透明在远端执行。

前置：M1+M2 完成态已回退干净（M3/M4 iframe 方案已撤，快照在 Plugin/dsh-ssh-m4-backup/，勿回引）。SPEC-M1/M2 全部有效。本规范是 M5 唯一契约来源。

## 已验证事实（勘察，勿重复发明）

### 执行缝（harness 真实结构）
- **一次性 bash**：`ctx.shell`（`ShellExecutor` 抽象服务，实现=packages/shell/bash-local；`ctx.shell.run(ctx.shell.resolve({command, cwd, timeoutMs, ...}))`；tool-bash 从 `exec.agent?.session.header.cwd` 取 cwd）。
- **持久终端**：`ctx.terminals` 服务有**开放的 `registerBackend(backend): () => void`**（packages/terminal/terminal/src/index.ts L125，重复 type 才抛）。bash 工具 `terminal_open` 的 `type` 参数选后端（模型面向参数，描述 "usually shell"）；`spawn(owner,{type,name?,cwd?})` → `backends.get(type).spawn(...)`。后端 spawn 收到 `{sessionId, owner, type, name?, cwd?}`。
- **fs**：`ctx.fs`（FileSystem 抽象，实现=packages/fs/fs-local）；read/write/edit/read_image/listDir 全部经 `ctx.fs.*`，per-call 带 `{cwd}`（sessionResolveOptions：session cwd 或 sandboxPolicy.workspaceRoot）。FileSystem 方法面（packages/fs/fs/src/index.ts）：resolve/processPath/fileUrl/contains/stat/lstat/readText/streamText/readBytes/listDir/writeText/editText（签名以该文件为准，逐字读）。
- **glob/grep**：tool-fs-search spawn 本地 rg（@vscode/ripgrep 包内二进制绝对路径）经 `ctx.subprocess.spawn({argv, cwd, stdio, graceMs})`。
- **subprocess**：`ctx.subprocess`（SubprocessRuntime 抽象，实现=packages/subprocess/subprocess-local；spawn + spawnTerminal）。
- **cordis 服务语义（实证 vendor/cordis/src/reflect.ts）**：`provide` 同名抛错；`set` 只能改自己 provide 的。**所以路由不替换存量服务，而是"可选钩子"模式：stock 实现里查 `ctx.get('<routerName>')`，缺席=纯本地零变化**（先例：subprocess resize 补丁、ui-workspace 孔补丁）。
- **systemPrompt**：`ctx.systemPrompt.section({name, order, text})` 静态段 + `ctx.systemPrompt.variable(name, provider)` 每会话变量（provider(context) 里能拿到会话/agent 上下文——读 packages/core/system-prompt/src/index.ts 的 AssembleContext 形状）。
- **workspace 注册**：`ctx.get('workspaceRegistry').create(path)`（api/workspace-controller 实证）；create 走 realpathNormalize+stat 校验存在性，indexHeader 对会话 header.cwd 做同样校验（不符的会话被滤出工作区视图）——**这两处是 harness 补丁点**。

### 运行时与连接（已有）
- dsh-remote（M2）：`~/.dsh-remote/current/` stdio JSON-RPC（hello/ping/fs.list/fs.mkdir），RuntimePool 常驻通道（connId keyed），SshConnector.openChannel 承载。
- 终端远程：`dshSsh.buildRemoteSpawn`（ssh -tt argv，本地 PTY 包裹）已真机验证。
- rg 二进制来源：harness 仓 `node_modules/@vscode/ripgrep/bin/rg`（linux-x64，可直接拷入资产）。

## M5 分工（三代理并行；契约全在本节冻结）

| 代理 | 拥有路径 | 任务 |
|---|---|---|
| W1 harness 补丁 | `deepseek-harness/packages/{workspace/workspace,fs/fs-local,shell/bash-local,subprocess/subprocess-local}/**` | 四个可选钩子补丁 + 各自测试 |
| W2 dsh-ssh 插件 | `Plugin/dsh-ssh/src/**`（不含 client/ 的 wizard/ 既有件外全部）、`Plugin/dsh-ssh/src/client/**` 仅 wizard 完成接线 | 路由服务三件 + terminals 后端 + systemPrompt + 注册路由 |
| W3 运行时扩展 | `Plugin/dsh-ssh/remote/**`、`scripts/build-runtime.mjs`、`test/runtime-m5.e2e.mjs` | server.ts 加 fs.*/exec 方法 + rg 入包 |

### 冻结契约 A：钩子服务形状（W1 查、W2 供）
```ts
// cordis 可选服务（全部 ctx.get 判 undefined，缺席=纯本地）：
// 'dshRemotePaths'（W2 提供）
interface DshRemotePaths {
  /** path 是否是已注册远程工作区根（或其内部）。 */
  has(path: string): boolean
  /** 命中时返回连接与远端根；未命中 undefined。 */
  match(path: string): { connectionId: string; remoteRoot: string } | undefined
}
// 'fsRemoteRouter'（W2 提供）——fs-local 方法级委托：
interface FsRemoteRouter {
  /** 命中返回一个与 FileSystem 该方法签名等价的远端实现对象；未命中 undefined。 */
  route(path: string, cwd?: string): RemoteFsLike | undefined
}
// 'shellRemoteRouter' / 'subprocessRemoteRouter'（W2 提供，同形不同名）：
interface ExecRemoteRouter {
  /** cwd 命中远程根 → 返回远端执行器；未命中 undefined。 */
  routeByCwd(cwd: string | undefined): RemoteExecLike | undefined
}
```
RemoteFsLike/RemoteExecLike 的方法面由 W1 从 fs-local/bash-local/subprocess-local 的真实公开方法逐字抄入补丁（路由返回对象按那批签名实现）。W1 的 patch 形态（伪码）：
```ts
const router = this.ctx.get?.('fsRemoteRouter')
const remote = router?.route(...args 里的 path/cwd...)
if (remote !== undefined) return remote.<同名方法>(...args)
// 否则走原实现逐字路径
```
钩子缺席时**逐字节**保持原行为；补丁全部附 vitest 新用例（钩子缺席回归 + 命中委托）。

### 冻结契约 B：远端执行后端（W2 实现，W3 供协议）
- dsh-remote stdio JSON-RPC 增方法（W3）：
  - `fs.stat {path}` → `{exists, isDir, isFile, size, mtimeMs}`（不存在 exists:false 不报错）
  - `fs.readText {path, maxBytes?}` → `{text, truncated}`；`fs.readBytes {path, maxBytes?}` → `{base64, truncated}`
  - `fs.writeText {path, text, createParents?}` → `{bytes}`；`fs.listDir {path}` → `{entries:[{name,type}]}`（同 fs.list 形状）
  - `fs.editText {path, oldText, newText, replaceAll?}` → `{replacements}`（服务端读-替换-写回；oldText 不命中=错误 `NO_MATCH`，多处命中未 replaceAll=`AMBIGUOUS`——语义对齐 fs-local.editText，读它的实现抄）
  - `exec {command, cwd?, timeoutMs?}` → `{code, stdout, stderr}`（远端 sh -c；用于 bash 一次性命令与 rg 翻译后的搜索）
  - 全部走既有换行 JSON 帧；server.ts 健壮性条款沿用 M2（BAD_JSON 不死）。
- 运行时包补 rg：`assets/node/` 同级新增 `assets/rg/linux-x64/rg`（从 harness node_modules/@vscode/ripgrep/bin/rg 拷贝，脚本 `scripts/fetch-rg.mjs`）；build-runtime.mjs 双变体都把 `tools/rg` 纳入（组件清单加 `tools/rg`）；start.sh 不动。版本 bump 到 0.2.0（触发已部署远端升级——M2 版本治理已支持）。
- W2 的 RemoteExecLike/RemoteFsLike 实现优先走 RuntimePool 通道（快、常驻）；运行时缺失/degraded → 回落 `connector.exec`（ssh 一次性命令，慢但对）；PTY 永远走 `dshSsh.buildRemoteSpawn`（ssh -tt）。

### 冻结契约 C：terminals 后端 + systemPrompt
- W2 在 index.ts：`ctx.inject(['terminals'], ...)` 里 `ctx.get('terminals').registerBackend({ type:'ssh', spawn })`；spawn 实现：按 `spec.cwd` 经 dshRemotePaths.match 找连接 → 不存在则 throw（该 cwd 非远端）；存在则 `spawnTerminal`（从 ctx.get('subprocess')）argv=buildRemoteSpawn({connectionId, cwd: 相对/绝对远端路径, shell})，包装成 TerminalBackendSession 形状（读 packages/terminal/terminal/src/types.ts 的 TerminalBackend/TerminalBackendSession 接口逐字实现：output 流/write/resize/done/terminate/signal 等）。
- systemPrompt：`section({name:'dsh-ssh-remote', order: 合理值, text:'...{{dsh_ssh_remote_hint}}...'})` + `variable('dsh_ssh_remote_hint', ctx => 按 ctx 里的会话 cwd match 远程根 → 中文引导："本会话的工作区在远端主机 <title>（连接 <connId>）。所有文件与命令操作已在远端执行；terminal_open 的 type 用 'ssh'。"，本地会话返回 undefined 即空）`。读 AssembleContext 实际字段写对。

### 冻结契约 D：工作区注册与向导接线
- 新路由 `POST /api/register-remote-workspace {connectionId}` → registry 取连接 → `workspaceRegistry.create(remotePath)`（ssh=远端路径经 W1 补丁 tolerated；win=/mnt 路径本地存在性直接成立）→ `{ok, workspaceId?, already?}`。响应形状与 M3 的 register-win-workspace 相同（回退删掉的那个路由的通用化复活）。
- 向导 complete()：成功后若 kind=ssh|win 都调 register-remote-workspace（失败只 WARN 不阻断向导完成）。远程工作区出现在原生列表后，远程 section 的行保留（连接管理面：状态/重连/日志/删除），两处不冲突。
- 打开会话入口：用户在原生工作区行上正常开会话（零新 UI）。

### 冻结契约 E：patch 文件边界（W1）
- `packages/workspace/workspace/src/index.ts`：`create()` 与 `indexHeader()` 里 realpath/stat 校验前查 `this.ctx.get('dshRemotePaths')?.has(path)`，命中则跳过存在性校验（create 直接用原 path 作为 canonical；indexHeader 直接 sessionPaths.set(id, path)）。无钩子=原行为。
- `packages/fs/fs-local/src/index.ts`：每个公开方法方法首查 router 委托（见契约 A）。
- `packages/shell/bash-local/src/index.ts`：`run`/`resolve` 读到的 cwd 查 shellRemoteRouter.routeByCwd；命中则改用远端执行器产出结果（结果形状逐字对齐原返回类型）。
- `packages/subprocess/subprocess-local/src/index.ts`：`spawn` 的 spec.cwd 查 subprocessRemoteRouter；命中则委托（glob/grep 的 rg spawn 会命中——argv[0] 是本地 rg 绝对路径，**远端执行器负责把 argv[0] 翻译成远端 rg**（`~/.dsh-remote/current/tools/rg`），W2 实现里处理）。spawnTerminal 不拦（终端走 terminals 后端）。
- 所有补丁遵守仓 oxlint + 中文注释 + 各自包 vitest 全绿 + `tsc -b tsconfig.host.json` 过。tsx 直跑 src 生效，lib/ 有构建的顺带重建（该包有 bundle 脚本则跑）。

## 验收标准（主代理）
1. harness：四包 vitest 全绿 + tsc host 过 + oxlint 零警。
2. dsh-ssh：5 个既有 e2e + 新 m5 e2e（路由三分支命中/缺席、terminals 后端注册、register-remote-workspace、systemPrompt 变量）全绿；pnpm bundle 双面零报错。
3. dsh-remote：runtime e2e 含新方法；`pnpm build:runtime` 双变体含 tools/rg。
4. 真机（verify 实例）：kali 注册远端工作区 → 原生列表出现 → 开会话 → agent 依次跑：bash `pwd && hostname`、`read` 远端文件、`write`+`read` 回环、`grep` 远端关键字——全部远端生效；终端面板开 ssh 标签；本地会话不受影响（回归）。

## 边界
- W1 只许加"可选钩子"，禁止改变无钩子时任何行为；不 git commit harness 仓。
- W2 不改 package.json/tsdown.config.ts；不提供与存量同名的 cordis 服务（provide 同名会炸）。
- W3 不动 start.sh 的 node 解析逻辑；版本 bump 0.2.0。
- 密码连接的 exec 走 askpass 每调用一次（慢但可用）；interop 连接无 mux，一次性命令比 mux 慢——已知，注释即可。
