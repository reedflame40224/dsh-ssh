# dsh-ssh — M1 实施规范（编码子代理必读）

目标：DSH Web GUI 远端工作区插件 M1。四步连接向导（SSH/WIN）、连接档案注册表、系统 OpenSSH+ControlMaster 连接器、存活检测、远程工作区侧栏 section、dsh-terminal 远程终端联动。M2（远端运行时下发）另见 SPEC-M2（后续发布，本规范预留 hook）。

配套补丁（同一波次，另两个子代理实施）：
- **H1**：harness 仓 `packages/client/ui-workspace` 增量补丁（添加工作区双项菜单 + 两个新槽孔）。
- **H2**：`Plugin/dsh-terminal` target 扩展（spawn 帧 + 服务消费 + 客户端下拉分组）。

总方案背景见同目录 PLAN.md（§0 需求映射、§1 勘察结论）。本规范是**唯一契约来源**：跨代理协作的协议/槽位/服务/帧格式以本文件为准，不得擅自偏离。

## 验收标准（主 agent 执行）

1. `pnpm install && pnpm bundle` 零报错（dsh-ssh 与 dsh-terminal 各自）。
2. 离线 e2e 全绿：`node test/registry.e2e.mjs && node test/connector.e2e.mjs && node test/routes.e2e.mjs`；dsh-terminal 原有 e2e 回归 + 新增 target 用例全绿。
3. harness 仓：`pnpm vitest run packages/client/ui-workspace` 全绿（含新增用例）+ `tsc -b tsconfig.client.json` 过 + oxlint 0 警告。
4. 在线（主 agent 挂载后）：`curl 127.0.0.1:3080/__dsh-ssh/api/health` 与 `/environment`、`/aliases` 均 200 JSON；浏览器"添加工作区"出现双项菜单；向导连 kali 真机走完四步；远程 section 行状态正确；dsh-terminal「+」下拉出现远程目标且新标签落 `~/pwn` 出 kali p10k 提示符；重启 dsh web 后存活状态重检正确。

## 已验证事实（不要重新发明、不要怀疑，直接按此实现）

### A. 插件形态与构建（照抄 dsh-terminal，已就绪勿改）
- 工作根目录 `/home/lyy/workspace/DSH/Plugin/dsh-ssh/`；package.json / cordis.patch.yml / pnpm-workspace.yaml / tsdown.config.ts / 骨架 src/index.ts、src/client/index.ts **已由主 agent 备好**。依赖已 pnpm install。构建 `pnpm bundle` → lib/index.js（ESM node）+ lib/client.js（CJS browser 带 `__ModuleLoader__.load({id:'dsh-ssh'})` 包装）。
- **不 import 任何 @deepseek-ai/\* 运行时值**（链接挂载解析不到）；服务/槽位/InjectFace 类型全部本地最小结构声明；type-only import 可用。host 半可用全部 node:\* 内置模块（真实 Node 进程）。
- client 半 external 仅：react、react/jsx-runtime、react-dom、react-dom/client、@deepseek-ai/cordis、@deepseek-ai/dsh-client-ui-slots、@deepseek-ai/dsh-client-ui-renderer、@deepseek-ai/dsh-client-ui-primitives、@deepseek-ai/dsh-client-ui-attachment、@deepseek-ai/dsh-client-ui-theme、@deepseek-ai/dsh-client-runtime/client（tsdown 已配）。
- 源码兼容 Node 24 类型擦除（e2e 直跑 src/*.ts）：禁 enum/namespace/构造器参数属性等不可擦除语法。风格：无分号、单引号、中文注释（对齐 dsh-terminal）。
- 参照实现：`/home/lyy/workspace/DSH/Plugin/dsh-terminal/src/`（host 薄壳模式、client 槽位注入、HostObservable store、CSS Modules 令牌化）——动手前先通读其 index.ts、bridge.ts、client/index.ts、client/sessions.ts。

### B. 运行时服务（host 半 cordis ctx）
- `ctx.get('webServer')` → `{ register({kind:'prefix'|'exact', path, handler(req,res)}): () => void; registerUpgrade({path, handler(req,socket,head)}): () => void }`。**异步注册**：apply 时同步 get 可能 undefined，必须 `ctx.inject(['webServer'], cb)` 等待（骨架 src/index.ts 已示范）。
- `ctx.provide('dshSsh', serviceObj)` 提供 cordis 服务（harness 测试里实证：web-app.spec.ts `ctx.provide('webServer', server)`）。dsh-terminal 侧 `ctx.get('dshSsh')` 判 undefined 容错消费。
- `ctx.effect(fn)` 注册清理（stop/unmount 时全量回收：路由 dispose、定时器、WS server、子进程）。
- WS 桥用 npm 包 `ws`（已是 dependencies）：`new WebSocketServer({noServer:true})` + `server.handleUpgrade(req,socket,head,cb)`，参考 deepseek-harness/packages/api/gateway/src/stream-server.ts 与 dsh-terminal/src/bridge.ts。

### C. 新增槽位契约（H1 补丁落地后存在；P2 按此编码）
```ts
// ui-workspace slots.ts 追加（H1 负责实现，P2 只做类型声明消费）：
interface RemoteFlowOwnerProps { open: boolean; onClose: () => void }
SlotMap:
  'sidebar.workspaces.remoteFlow': { kind:'single'; scope:'root'; owner: RemoteFlowOwnerProps }
  'sidebar.workspaces.sections':  { kind:'list';  scope:'root'; owner: { wide: boolean } }
// 占用可观测：与 directoryFlow 同模式，注入 hooks 位 { remoteFlow: HostObservable<boolean> }，
// 渲染器把孔占用绑定进 useRemoteFlow selector；孔空时"远程连接"菜单项消失、open 被撤回。
```
- P2 注册写法（参照 dsh-terminal client/index.ts 的 slots.inject 模式）：
  - `ctx.slots.inject('sidebar.workspaces.remoteFlow', () => ctx.slots.register({ name:'sidebar.workspaces.remoteFlow', id:'dsh-ssh', order:10, inject: () => ({ hooks: { remoteFlow: wizardOccupiedStore } }) }, RemoteFlowDriver))` —— RemoteFlowDriver 是**无头组件**（return null），职责：useEffect 同步 owner.open ↔ wizardStore.visible。
  - 向导本体注册进 `shell.overlay`（list，order 60，dsh-terminal 面板同款 visible-store 模式，根元素 `pointer-events:auto`）。
  - `ctx.slots.inject('sidebar.workspaces.sections', () => ctx.slots.register({ name:'sidebar.workspaces.sections', id:'dsh-ssh', order:10, label:'远程' }, RemoteSection))`；owner props `{ wide:boolean }`。
- HostObservable store 模式照抄 dsh-terminal client/sessions.ts（getSnapshot/subscribe/notify + useSyncExternalStore）。

### D. 数据模型与存储（P1）
- 目录 `~/.dsh/dsh-ssh/`（插件自建，0700）：`connections.json`（注册表，tmp+rename 原子写）、`mux/`（ControlMaster socket 目录，0700）、`askpass/`（临时脚本目录，0700，用完即删）。
- ConnectionRecord：
```jsonc
{ "id": "conn_<crypto.randomUUID>", "kind": "ssh|win", "title": "pwn",
  "ssh": { "host":"192.168.184.131", "port":22, "user":"kali",
           "auth": {"type":"password"} | {"type":"key","identityFile":"…"},
           "sshBinary": "/mnt/c/WINDOWS/System32/OpenSSH/ssh.exe",   // 可选
           "downloadMethod": "upload" | "remote" },
  "remotePath": "/home/kali/pwn",            // 向导第4步选定
  "runtime": { "installed": false },          // M2 填充
  "createdAt": "…ISO", "updatedAt": "…ISO" }
```
- **密码绝不入库**：draft 里的密码只活在内存与一次性 askpass 脚本，连接成功/失败后即焚。
- 状态（不持久化，内存+WS 推送）：`{ state:'unknown'|'checking'|'online'|'offline'|'degraded', lastChecked?, error?, env? }`；env = `{ os:'linux|windows|macos', arch:'x64|arm64', uname:'…', shells:[{name,path}], node?:'v22.16.0' }`。

### E. SSH 连接器（P1，核心）`src/ssh.ts`
- 纯 Node 类 `SshConnector`，cordis 无关（离线 e2e 注入假 sshBinary 脚本验证）。
- 每个连接的公共 argv 头：`[sshBinary, '-o','ControlMaster=auto','-o','ControlPath=<muxdir>/%C','-o','ControlPersist=10m','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2','-p',port]`；密钥认证加 `['-i',identityFile,'-o','BatchMode=yes','-o','IdentitiesOnly=yes']`；密码认证走 askpass（见下）不加 BatchMode。目标 `[user@host]`。
- `sshBinary` 缺省 `ssh`；kali 类 WSL2→VMnet8 场景用 `/mnt/c/WINDOWS/System32/OpenSSH/ssh.exe`（此时 identityFile 是 **Windows 路径**，原样传给 ssh.exe，禁止 wslpath 转换）。
- 密码认证 askpass：connect 前写 `askpass/<rand>.sh`（内容 `#!/bin/sh\nprintf '%s' '<密码单引号转义>'`，0700），env 追加 `SSH_ASKPASS=<path>`、`SSH_ASKPASS_REQUIRE=force`、`DISPLAY=dsh:0`，spawn 时 `detached:true` + stdin ignore（确保 askpass 被调用而非 tty 提示）；pipeline 结束（成败均）删脚本。**密码永不进日志/WS**（日志 redact 过滤器：凡是 draft.password 出现处替换 `***`）。
- 方法：
  - `testConnect(draft, log(line)): Promise<{env}>` —— 连接向导 pipeline：① INFO `正在通过窗口 Host 连接 ssh <title>`（对齐 ZCode 文案）；② 建 mux + 探活：`exec 'echo __DSH_SSH_OK__ && uname -sm'` 解析标记；③ INFO `detecting remote env...`：`command -v zsh bash sh fish pwsh` 收集 shells、`node --version 2>/dev/null` 容错；④ INFO `远程环境检测完成：<os>/<arch>`。失败分类提示（timeout=网络不可达 / Permission denied=认证失败 / Connection refused=SSH 服务未开），ERROR 行进日志。
  - `exec(conn, remoteCommand, {timeoutMs}): Promise<{code,stdout,stderr}>`（骑 mux；stderr 非空不视为失败，看 code）。
  - `check(conn): Promise<boolean>` —— `ssh -O check`（mux 在时零开销），否则 5s 超时的 `exec('true')`。
  - `browse(conn, dir): Promise<{dir, parent?, entries:[{name,type:'dir'|'file'|'link'}]}>` —— `cd '<dir>' && ls -1Ap --group-directories-first`（尾 `/`=dir、`@`=link、`*`=file；点开头隐藏条目保留但 client 默认折叠）；dir 不可读时报错。路径一律单引号包裹+内部单引号 `'\''` 转义。
  - `close(connId)`（`ssh -O exit`）、`disposeAll()`（ctx.effect 清理）。
- env 探测解析出的 shells 用于 dsh-terminal 远程标签的 shell 选择；缺省远端登录 shell 由 `getent passwd <user>` 第7字段或 `$SHELL` 兜底。

### F. 存活检测（P1）`src/liveness.ts`
- `LivenessProbe`：构造注入 `{ registry, connector, onStatus(connId,status) }`。
- `sweep()`：插件加载即全量探测（并发 4，单连接 6s 超时）；`start()`：60s±15% 抖动周期；offline 指数退避 30s→×2→5min 封顶；online 复探周期 60s。
- 状态机 `unknown→checking→online|offline|degraded`；degraded 预留给 M2（ssh 通但 runtime 异常），M1 不产生。状态变更 → onStatus → WS 广播。
- `checkNow(connId)` 手动重测（API 调用）。

### G. HTTP/WS API 契约（P1 实现、P2 消费，逐字冻结）
统一前缀 `/__dsh-ssh/`，全部 JSON；错误响应 `{ok:false, error:string}` + 合适状态码。
- `GET  /api/health` → `{ok:true, plugin:'dsh-ssh', version}`（骨架已有，保留）。
- `GET  /api/environment` → `{ok:true, kind:'wsl'|'windows'|'linux'|'macos', detail?, canWsl:boolean, canWin:boolean, canDocker:false}`。
  探测：`process.platform==='linux'` 且（`env.WSL_DISTRO_NAME` 非空 或 `/proc/sys/kernel/osrelease` 含 `microsoft` 不分大小写）→ `wsl`；`win32`→`windows`。`canWin = kind==='wsl'`；`canWsl = kind==='windows'`（M1 恒 false 占位，WSL 卡禁用逻辑在 client）；`canDocker=false`。
- `GET  /api/aliases` → `{ok:true, items:[{name,host,port,user,identityFile?,sshBinary?,source:'dsh'|'ssh-config',description?}]}`。
  数据源按序合并（dsh 优先同名覆盖）：`/home/lyy/.dsh/remote-hosts.json`（`{hosts:[{alias,host,user,port,identityFile,sshBinary,description}]}`，字段名照抄）+ `~/.ssh/config` Host 块（跳过含 `*`/`?` 的通配块；HostName/User/Port/IdentityFile）。
- `GET  /api/connections` → `{ok:true, items:[{connection:ConnectionRecord, status:Status}]}`。
- `POST /api/connect` 请求 `{draft:{kind,title?,ssh:{host,port,user,auth,sshBinary?,downloadMethod}}, flowId:string}`；**长请求**：pipeline 期间连接保持，进度走 WS log 频道（key=flowId）；响应 `{ok:true, env}` 或 `{ok:false,error}`。**不持久化**。
- `POST /api/connections` `{draft, title, remotePath}` → 持久化 → `{ok:true, connection}`（向导第4步"完成"调用；随后内部触发 checkNow）。
- `POST /api/browse` `{flowId?:string, connectionId?:string, dir:string}` → `{ok:true, dir, parent?, entries:[…]}`。flowId 走向导期暂存的活动连接（内存 map，pipeline 成功后保留 10min），connectionId 走注册表。
- `POST /api/check` `{connectionId}` → `{ok:true, status}`（同步等结果，6s 超时）。
- `POST /api/disconnect` `{connectionId}` → 关 mux、置 unknown → `{ok:true}`。
- `DELETE /api/connections` `{connectionId}` → `{ok:true}`（先 disconnect）。
- `GET  /api/targets` → `{ok:true, items:[{connectionId,title,kind,online,remotePath?}]}`（dsh-terminal client 直取；online 由内存状态推导）。
- WS `/ws`：C→S `{t:'subscribe', channel:'status'}` / `{t:'subscribe', channel:'log', key:flowId|connectionId}` / `{t:'unsubscribe', …}`；S→C 订阅即回快照 `{t:'status', items:Record<id,Status>}` 或 `{t:'log-snapshot', key, lines:[LogLine]}`，随后增量 `{t:'status', connectionId, status}` / `{t:'log', key, line}`。LogLine=`{ts:'HH:mm:ss', level:'INFO'|'WARN'|'ERROR', msg:string}`。每 key 环形缓冲 500 行；30s ping 心跳；连接断开仅退订不杀 pipeline（pipeline 归 HTTP 请求生命周期？不——**pipeline 归服务端 flowId map 所有**，HTTP 中断不杀，向导最小化后重订阅同 flowId 拿快照+增量，这是"双载体共用日志流"的实现基础）。

### H. dshSsh 服务契约（P1 provide，H2 消费）
```ts
interface DshSshService {
  listTargets(): Array<{ connectionId:string; title:string; kind:'ssh'|'win'; online:boolean; remotePath?:string }>
  /** 返回本地 PTY 应 spawn 的 argv；连接未知/离线 throw Error（中文消息）。 */
  buildRemoteSpawn(spec:{ connectionId:string; cwd?:string; shell?:string }): { argv:string[]; name:string; env?:Record<string,string> }
}
// ssh: argv = [...公共argv头, '-t', 'user@host', `cd '<cwd||remotePath>' && exec <shell||远端默认shell> -l`]
//      name = conn.title；注意 -t 必须，远端命令经 sh -c 语义（直接作为单个 argv 尾参即可，ssh 自动拼接）。
// win: argv = [shell==='cmd' ? 'cmd.exe' : 'powershell.exe','-NoLogo']，cwd 语义由 dsh-terminal spawn 的 cwd
//      承担（WSL 侧 /mnt/<盘> 路径，interop 下 powershell 起在对应 Windows 目录由后续 M3 优化，M1 先落盘符根）。
```

### I. dsh-terminal 扩展契约（H2）
- spawn 帧追加可选 `target`（缺省=`{kind:'local'}`=逐字节现状）：
  `{kind:'local'} | {kind:'ssh', connectionId:string, cwd?:string} | {kind:'win', shell:'powershell'|'cmd', cwd?:string}`
- bridge.ts：构造 deps 追加可选 `resolveTarget?: (target) => {argv,cwd?,env?,name}`；收到非 local target 且无 resolver → error 帧不落 PTY（allowlist 同款语义）；有 resolver → throw 转 error 帧，否则用返回值替换 spawn spec 的 argv/cwd/env，ready 帧 shell 字段用返回的 name。
- index.ts：`ctx.get('dshSsh')` 存在则构造 resolver（ssh/win 均调 buildRemoteSpawn）；不存在则 resolver=undefined。
- client：「+」下拉分组——本地 shells（现状）+ 远程目标（`GET /__dsh-ssh/api/targets` 容错拉取，失败/404 则不显示分组，单插件可独立工作）；远程标签 chip 显示 `ssh·<title>`，cwd 缺省 remotePath。
- client 监听 window 自定义事件 `dsh-ssh:open-terminal`（detail=`{connectionId}`）：收到即开面板+新建对应 target 标签（dsh-ssh section 行点击触发联动）。
- e2e：fake resolveTarget 断言 argv 替换与 error 帧语义；原有用例不得改动地通过。

### J. 前端规格（P2）——文案逐字冻结（仿 ZCode，DSH 特色化）
- 向导（modal，居中 ~1100px，圆角 `var(--dsh-round-side,14px)`，背景 `var(--dsw-alias-bg-layer-1)`，边框 `var(--dsw-alias-border-l1)`）：左侧步骤条（标题"远程连接"；步骤 `选择方式/填写配置/连接中/选择目录`；当前=实心圆+行高亮、完成=绿勾、未到=灰）+ 右侧内容区（右上 × 关闭，连接中步加 — 最小化）。
- Step1「选择连接方式」副标`选择进入当前工作区的连接方式，然后继续填写对应的连接配置。` 2×2 卡片：SSH/远程主机、WIN/本机 Windows、WSL/Windows Linux 子系统、Docker/本地容器。选中=整卡提亮+图标瓦片反白。禁用：WSL 卡（canWsl=false 或 kind==='wsl'，tooltip"当前已在 WSL 中运行"）、WIN 卡（canWin=false，tooltip"仅当 DSH 运行在 WSL 时可用"）、Docker 卡（恒禁用，tooltip"即将推出"）。按钮：取消 / 下一步 ›。
- Step2「填写连接配置」副标`填写建立 SSH 连接所需的信息，我们会据此准备远程会话。` 字段：`SSH 配置别名（可选）`下拉（默认`不使用别名`，说明`选择别名后会自动填充主机、端口、用户名和私钥路径。`）；双列`主机`(placeholder`输入主机地址或 IP，例如 192.168.1.100`)+`端口`(默认22)；双列`用户名`(placeholder`输入用户名，例如 root`)+`认证方式` segmented 密码|私钥；密码框(placeholder`输入 SSH 密码`)或私钥路径框(placeholder`例如 ~/.ssh/id_ed25519`)；`资源下载方式` segmented 本地下载后上传|远端服务器下载（说明`远端服务器下载可减少上传等待，但服务器需要能访问下载源，并具备下载、解压和校验工具。`）。按钮：‹ 上一步 / 开始连接（主机+用户名+凭证齐备才可用）。**WIN 分支**：Step2 替换为 `Windows 目录`输入（placeholder`例如 E:\PWN 或 /mnt/e/PWN`）+ `终端 shell` segmented PowerShell|cmd；无连接中步骤（步骤条变三步：选择方式/填写配置/选择目录）。
- Step3「正在建立连接」副标`正在建立 SSH 连接，你可以在这里查看实时的连接进度。` 日志面板：标题栏`连接日志`+右侧 spinner`正在连接…`；日志区等宽（`var(--dsw-font-markdown-code*)`）行格式 `HH:mm:ss [LEVEL] msg`（时间戳暗、级别灰、ERROR 红）。上一步禁用、主按钮`正在连接…`禁用；失败→主按钮变`重试`；成功自动进 Step4。
- Step4「选择目录」副标`选择远端主机上作为工作区打开的目录。` 面包屑+目录列表（仅 dir 可进入，双击/单击进入，file 灰显）、`新建文件夹`按钮（弹输入名→browse 侧 mkdir——API：`POST /api/browse` 加 `{mkdir:string}` 可选字段，P1 实现）、标题输入（默认=目录 basename）。按钮：‹ 上一步 / 完成。
- 远程 section（侧栏，插入工作区分组下方）：分区标题`远程`；行=图标（ssh=云朵轮廓/win=窗口）+标题+副行小字（`user@host` 或盘符路径）+右侧状态件（checking=spinner、online=绿点、offline=灰点）+⋯菜单（`打开终端 / 重新连接 / 查看日志 / 删除连接`）。行点击（online）：dispatch window 事件 `dsh-ssh:open-terminal` `{connectionId}`。连接中/查看日志：锚定行右侧浮出日志卡片（标题`连接日志`，同向导订阅流）。
- 颜色硬约束：背景/边框/文字一律 `var(--dsw-alias-*)`；状态色先 grep `packages/client/ui-theme` 的 design-platform.css 找 success/danger 语义令牌，没有则集中定义于 `styles/tokens.ts` 导出常量并注释来源（绿 `#4caf50`、灰 `var(--dsw-alias-label-secondary)`）；圆角 `var(--dsh-round-side,14px)`；兼容 ui-custom 玻璃拟态（不在 overlay 根设不透明纯色，用 bg-layer 令牌）。

## 文件分工（四子代理并行，互不越界）

| 代理 | 模型 | 拥有路径 | 任务 |
|---|---|---|---|
| P1 host | ocgo/dsv4f | `Plugin/dsh-ssh/src/{index,registry,ssh,liveness,loghub,routes,service,env}.ts`、`Plugin/dsh-ssh/test/**` | D/E/F/G/H 全部 host 实现 + 离线 e2e（registry 原子读写、connector 注假 ssh 脚本、routes 假 ctx 冒烟） |
| P2 client | ocgo/dsv4f | `Plugin/dsh-ssh/src/client/**` | C/I消费侧/J 全部 client 实现（wizard/section/stores/api/CSS Modules） |
| H1 harness | ocgo/dsv4f | `deepseek-harness/packages/client/ui-workspace/**`（src+tests，禁动其它包） | C 的槽位实现 + 双项菜单 + locales + 测试；查清 client 包改动后的最小重建命令并执行 |
| H2 terminal | ocgo/dsv4f | `Plugin/dsh-terminal/src/**`、`Plugin/dsh-terminal/test/**` | I 全部（bridge/index/client/e2e） |

## 边界
- 各代理只写自己的拥有路径；不 git commit（主 agent 审 diff 后统一提交）；不改动已备好的 package.json/tsdown.config.ts/cordis.patch.yml（P1/P2）；不动 `~/.dsh/profiles/web/`（挂载归主 agent）。
- P1 不实现 M2 远端运行时（runtimeStep 留 hook：`testConnect` 成功后若 `downloadMethod` 存在则 INFO `运行时检查将在 M2 提供，当前跳过`）。
- H1 纯增量：现有 directoryFlow 语义、WorkspacePicker（conversation 侧）零变化；遵守仓 oxlint/格式。
- 所有代理完成后自检：P1/P2 跑 `pnpm exec tsdown --env.DSH_BUILD_FACE=host|client` 零报错 + 各自 e2e；H1 跑 ui-workspace vitest+tsc；H2 跑 `pnpm run test:e2e`。

## 完成定义
四代理各自交付：文件清单 + 构建/测试输出 + 已知风险。主 agent 汇总审 diff、跨仓联调、挂载、真机验收（ecs 密钥直连 + kali ssh.exe interop）。
