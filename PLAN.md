# dsh-ssh 设计方案（探讨稿 v1）

> 目标：让 DSH 拥有"远端工作区"能力，对标 ZCode「远程连接」。插件形态与 dsh-terminal 相同（web profile bundle：host 半 + client 半，tsdown 打包，cordis.patch.yml 挂载，link 进 ~/.dsh/profiles/web）。
> 输入：7 张 ZCode 截图 UX 精读（子代理1）、zcode.zip 远端运行时机解剖（子代理2，deepseek-v4-flash）、harness 源码与运行时槽位勘察。

## 0. 需求 → 方案映射

| 需求 | 方案要点 | 里程碑 |
|---|---|---|
| 1. 基本实现 ZCode 远程连接全部功能 | 四步向导 + 连接日志双载体 + 远端运行时下发 + 目录选择 + 工作区落位 | M1–M4 |
| 2. 与 dsh-terminal 联动（终端 shell=工作区环境） | dsh-terminal spawn 帧扩展 `target`；host 桥消费可选服务 `dshSsh.spawnSshTerminal()`，本地 PTY 包 `ssh -t`，整条 WS 桥管道复用 | M1 |
| 3. 运行环境是 WSL，考虑 SSH 隧道网络 | 系统 OpenSSH + ControlMaster 多路复用；VMnet8 等不可直达网段走 Windows `ssh.exe` interop（每连接档案可配 `sshBinary`）；隧道一律 `-L` 本地转发骑 mux | M1/M4 |
| 4. 保留 WSL 选项但本机是 WSL 时禁用 | 环境探测（`WSL_DISTRO_NAME` / osrelease=microsoft）→ 向导第1步卡片禁用态 | M1 |
| 5. 新增 "WIN" 连接方式 | WSL→本机 Windows：**interop 优先**（文件=/mnt/<盘符>，终端=powershell.exe 进 PTY，零配置零SSH服务）；可选 SSH 到 Windows OpenSSH Server。DSH 跑在 Windows 上时该卡禁用 | M1/M3 |
| 6. 远端运行所需默认下载到家目录 | `~/.dsh-remote/`：manifest + 单文件 server + 可选 node/rg/pty.node；stdio JSON-RPC（无入站端口、免认证，骑 SSH） | M2 |
| 7. 每次打开 dsh 检测远端工作区存活 | 插件加载即并发探测（`ssh -O check` / 轻 exec / 运行时 ping，5s 超时），状态 store → 侧栏行徽标；60s 抖动复探 + 离线退避 | M1 |
| 8. Rust vs TS 后端论证 | 结论 TS，见 §7 | — |
| 前端1. "添加工作区"处加"远程连接" | ui-workspace 小补丁：添加按钮变双项菜单 + 新增 `sidebar.workspaces.remoteFlow` 孔 + `sidebar.workspaces.sections` 列表孔 | M1 |
| 前端2. UI 仿 ZCode 但有 DSH 特色 | 四步向导挂 `shell.overlay`，全令牌化（--dsw-alias-*、--dsh-round-side），兼容 ui-custom/rounded-panels | M1 |

## 1. 勘察结论（已验证事实）

### 1.1 harness 架构事实（决定方案边界）
- **Workspace 实体 = 本地规范路径**：`path` 是 create 时 `fs.realpath` 的本地目录；会话归属要求会话 header 的 canonical cwd **等于** workspace.path（packages/workspace/workspace/src/types.ts）。远端目录无法直接成为 host workspace —— 除非它在本地有挂载点。
- **`ctx.subprocess` 是进程级单例能力缝**（"Subclass, implement spawn, load as plugin — registers as ctx.subprocess (one implementation)"），有 local 与 e2b 两实现。即 harness 的"执行环境"是组合级选择，不支持按工作区切换。
- **web client 连接层同源**：`dsh web` 注入 `window.__DSH_BOOT__`，一个浏览器标签 = 一个 Host。
- **槽位现状（运行时 Inspect 实查）**：`sidebar.workspaces`（single，WorkspaceBrowser 占用）下只有 `sidebar.workspaces.directoryFlow`（single，ui-directory-picker-browse 占用，"添加工作区"入口仅在此孔被占用时存在）。**没有**可挂"远程连接"菜单项或行装饰的现成孔。`shell.overlay`（list）是向导对话框的落点（dsh-terminal 面板同款模式）。
- **向导"选择目录"后 adopt 的语义**：`createWorkspace({path})` 只收本地路径。
- **已有联动资产**：dsh-terminal 的 `WsTerminalBridge` 是 cordis 无关纯 Node 类（一 WS=一会话，JSON 控制帧 spawn/resize/kill + 二进制帧），spawn 帧已有 `cwd?`/`shell?`；M2 记忆曾预留"远程 TerminalTarget：本地 PTY 里 spawn ssh -t 即可复用整条管道"。
- **harness 补丁有先例**：subprocess resize 补丁（4f3b25ee9f）已提交并验收，ui-workspace 小补丁沿用同一节奏。
- 运行时环境实测：WSL2，**无 sshfs**；Windows OpenSSH Server 未开（localhost:22 refused）；Windows ssh.exe 9.5p2 可 interop；remote-hosts.json 已有 ecs（密钥直连）与 kali（ssh.exe interop 绕 VMnet8）两个现成连接档案。

### 1.2 zcode.zip 解剖（119MB → 381MB，远端家目录 `~/.zcode/`）
- 布局三分：`server/`（node 22.16.0 运行时 121.5MB + zcode-server.cjs 11.9MB 单文件 esbuild bundle + pty.node + bfs/ugrep/rg + agents/glm agent CLI）、`cli/`（会话 sqlite WAL、每工具调用 stdout 落盘、bash-startup shim 把 find/grep/rg 映射到自带快工具、shell 快照、插件市场）、`v2/`（telemetry deviceMid、tasks-index、**私有 CA**）。
- 装配：`.asset-components/*.json` 期望清单（id/version/sha256/platformArch）→ `asset-cache/components/<platform>/<组件>/<sha256>/` 内容寻址缓存 + staging 暂存 + `.ready` 标记；升级保留旧版目录可回滚（3.10.1/3.10.2 双目录实证）。
- 通道架构：**云中继**（桌面与远端各自出站连 `/remote/v4` + `/ws`，`attach-service-port` 类型化端口隧道帧，X-Device-Mid 鉴权）——远端**不开入站端口**。私有 CA 是给中继/TLS 拦截用的信任锚。
- workspaceKey 建模：`remote:ssh:<ip>:<port>:<user>:<path>`。
- **DSH 该抄**：单文件 bundle 零 node_modules、sha256 缓存+.ready、bash shim、调用审计落盘、无入站端口心跳。**该砍**：私有 CA、云中继（我们 SSH 直连）、三搜索工具留一（rg）、双份 node、7 个官方插件。
- **DSH 最小运行时估算**：复用远端 node 时 zip ≈ 2.5–5.5MB；内置 node 时 ≈ 43–45MB（zcode 的 114MB 的 40%）。

### 1.3 ZCode UX 要点（精读报告浓缩）
- 远程项目行用**云朵图标**区别于文件夹；行菜单两项：打开文件夹 / 远程连接。
- 向导四步：选择方式（卡片选择器，选中=整卡提亮+图标瓦片反白）→ 填写配置（SSH 别名下拉自动填充、主机/端口22/用户名、认证方式 segmented 密码|私钥、资源下载方式 segmented 本地下载后上传|远端服务器下载）→ 连接中（日志面板 `HH:mm:ss [LEVEL] msg`，可最小化，主按钮文案迁移为"正在连接…"禁用）→ 选择目录。
- **连接状态双载体**：向导可最小化，项目行内 spinner + 可唤起锚定行右侧的日志浮层，与向导共用同一日志流。
- 成功后自动开终端：标签=目录名、shell chip=zsh、提示符 kali@kali ~/pwn（cwd 与所选目录联动）。
- DSH 挂载点现状：工作区分区行右三个图标按钮（搜索/过滤/添加工作区），tooltip"添加工作区"已验证。

## 2. 总体架构

```
浏览器标签(本地 DSH web GUI)
 ├─ dsh-ssh client 半
 │   ├─ 向导对话框（shell.overlay，四步）
 │   ├─ 远程工作区 section（sidebar.workspaces.sections 孔，云图标/spinner/日志浮层）
 │   └─ 与 dsh-terminal client 的 target 选择联动
 │        │  fetch /__dsh-ssh/api/*（JSON）+ WS /__dsh-ssh/ws（日志/状态流）
 ▼        ▼
dsh-ssh host 半（dsh web 进程内 cordis 插件）
 ├─ ConnectionRegistry（~/.dsh/storages/dsh-ssh.connections.json）
 ├─ SshConnector：系统 ssh + ControlMaster mux（每连接一条主连接，exec/sftp/隧道全骑它）
 │   ├─ WSL 直连（ecs）  ├─ Windows ssh.exe interop（kali/VMnet8）  ├─ WIN interop（/mnt/*）
 ├─ LivenessProbe（启动探测 + 周期复探）
 ├─ RemoteRuntimeManager（下发/校验/升级 ~/.dsh-remote）
 └─ 服务面：cordis service `dshSsh`（供 dsh-terminal 等消费）+ HTTP/WS 路由（供 client 半）
         │ ssh mux（一条 TCP 多路复用：exec / sftp / stdio JSON-RPC / -L 隧道）
 ▼
远端家目录 ~/.dsh-remote/（M2+）
 └─ dsh-remote-server.cjs（stdio JSON-RPC：hello/env、fs.list、ping、M3+ pty/search/tunnel）
```

连接档案数据模型（对齐 ZCode 的 workspaceKey 思路）：
```jsonc
{
  "id": "conn_<uuid>",
  "kind": "ssh" | "win",            // wsl/docker 卡片禁用占位
  "title": "pwn",
  "ssh": { "host": "192.168.184.131", "port": 22, "user": "kali",
           "auth": { "type": "key", "identityFile": "C:\\Users\\lyy\\.ssh\\id_ed25519_kali" },
           "sshBinary": "/mnt/c/WINDOWS/System32/OpenSSH/ssh.exe" /* 可选，interop 绕行 */ },
  "workspace": { "remotePath": "/home/kali/pwn", "mountPath": null /* M3 sshfs 本地挂载点 */ },
  "runtime": { "installed": false, "version": null, "home": "~/.dsh-remote" },
  "createdAt": "…", "updatedAt": "…"
}
```

## 3. 连接层设计（host 半核心）

### 3.1 为什么用系统 OpenSSH + ControlMaster，而不是 ssh2 npm 库 / russh
- 免费获得 `~/.ssh/config`、ssh-agent、known_hosts、ProxyJump 全套用户既有配置。
- Windows ssh.exe interop 是绕 WSL2→VMnet8 不可达的**已验证唯一通道**（remote-hosts.json kali 档）；任何纯 JS/Rust SSH 栈都得自己解决这个网络问题。
- ControlMaster 多路复用：一条 TCP 承载向导探测、sftp 上传、stdio JSON-RPC、终端 ssh -t、-L 隧道 —— 认证只做一次，存活检测零开销（`ssh -O check`）。
- 关键参数：`-o ControlMaster=auto -o ControlPath=~/.dsh/dsh-ssh/mux/%C -o ControlPersist=10m -o ServerAliveInterval=15 -o ServerAliveCountMax=2`。

### 3.2 凭证与安全
- 优先密钥；别名下拉自动填充（数据源：`~/.dsh/remote-hosts.json` + 解析 `~/.ssh/config` 的 Host 段，含 sshBinary/identityFile 扩展字段）。
- 密码认证：向导收集后写入**一次性 SSH_ASKPASS 脚本**（0600，`DISPLAY=:0 SSH_ASKPASS_REQUIRE=force` 触发），连接建立即删；**永不入库、永不进日志**；日志流对密码行 redact。known_hosts 策略 `accept-new`，首次连接在日志里提示指纹。
- WIN interop 无需凭证（WSL 同源信任边界）。

### 3.3 环境探测与卡片禁用（需求 4/5）
`detectLocalEnvironment()`：`process.platform==='linux' && (env.WSL_DISTRO_NAME || /microsoft/i.test(osrelease))` → `wsl`；`win32` → `windows`；否则 `linux/macos`。
- local=wsl：WSL 卡禁用（"当前已在 WSL 中运行"），SSH/WIN 可选。
- local=windows：WIN 卡禁用，WSL 可选（wsl.exe interop 进 WSL 工作区）。
- Docker 卡 M1 禁用占位（"即将推出"），保留卡片矩阵与 ZCode 一致。

### 3.4 WIN 连接（需求 5，M1 终端 + M3 工作区）
- 文件：`/mnt/<盘符小写>/...` ↔ `C:\...` 双向翻译（`wslpath -u/-w` 可调用）。
- 终端：dsh-terminal spawn argv = `['powershell.exe']` 或 `['cmd.exe']`，本地 PTY 即可（interop 管道由 WSL 内核桥接）；cwd 用 `cd /mnt/e/...`（在 WSL 侧落盘）或直接 `powershell.exe -NoLogo -WorkingDirectory` 语义（注意 interop 下 UNC/路径转换坑，M3 验证）。
- "远端运行所需"：interop 语义下**无需向 Windows 下发任何运行时**（M3 如需 Windows 侧代理再议）。

### 3.5 SSH 隧道（需求 3 的落点）
- M1：隧道只是 mux 的副产品（终端/sftp/stdio 全走加密 SSH）。
- M4：类型化端口转发 `attachPort({remotePort|remoteSocket, localPort})` → mux 上 `ssh -L 127.0.0.1:<local>:127.0.0.1:<remote>`，生命周期归 registry；给"远程窗口"（浏览器新标签开 `http://127.0.0.1:<local>`）与远端 dsh API 用。协议骨架参考 zcode 的 attach-service-port/detach/broadcast 帧，但我们骑 SSH 不需要中继与私有 CA。

## 4. 远端运行时 dsh-remote（需求 6，M2）

```
~/.dsh-remote/
├── manifest.json            # {version, platformArch, components:[{id,sha256}]}
├── dsh-remote-server.cjs    # 单文件 esbuild bundle（插件仓同源码构建，TS→cjs）
├── start.sh                 # exec 语义启动器（zcode-agent 同型），支持 --stdio
├── tools/rg                 # 可选（M3 搜索桥）
├── native/pty.node          # 可选（M3 远端 PTY 直连，不经 ssh -t 包裹时）
├── cache/<sha256>/…+.ready  # 版本化缓存，升级保留旧版可回滚（抄 zcode）
└── state/                   # 运行后生成：logs/*.jsonl、exec/ 输出、心跳标记
```

- **通道**：M2 只用 **stdio JSON-RPC**——`ssh <conn> ~/.dsh-remote/start.sh --stdio`，帧=换行分隔 JSON。无端口、无额外认证（SSH 即认证）、NAT/防火墙全免疫。WS 模式留给 M4 远程窗口。
- **M2 方法集**：`hello`（os/arch/shell 列表/node 版本/glibc）、`ping`（版本+存活）、`fs.list(dir)`（向导第4步选择目录，分页+过滤）。M3 加 `pty.spawn/write/resize/kill`、`search.grep/glob`；M4 加 `port.attach/detach`。
- **node 策略**：hello 探测远端 node≥18 则复用（zip≈3–5MB）；否则走"内置 node"变体包（≈45MB）。向导"资源下载方式"两选项保留：**本地下载后上传**（插件 assets 内置 tar，sftp 走 mux 上传，staging→sha256 校验→.ready）/ **远端服务器下载**（远端 curl 可配置 URL，需远端有 curl+tar+sha256sum，日志逐条回报）。
- **版本治理**：manifest sha256 比对 → 状态 store 标记 `runtimeOutdated`，侧栏行提示升级；升级=新 hash 目录落地+切换激活+旧版惰性保留。

## 5. dsh-terminal 联动（需求 2，M1 核心交付）

- **dsh-terminal 改动（小）**：spawn 帧加可选 `target`：`{kind:'local'} | {kind:'ssh', connectionId, cwd} | {kind:'win', shell:'powershell'|'cmd', cwd}`；host 桥构造注入可选 `resolveTarget(spec)→{argv,cwd,env}`；apply 薄壳里 `ctx.get('dshSsh')` 存在即接线，不存在=纯本地（松耦合，单测/e2e 用假 dshSsh）。
- **dsh-ssh 提供**：cordis service `dshSsh.spawnSshTerminal(connectionId, {cwd, cols, rows, shell?})` → 返回与 `SubprocessTerminalHandle` 同形的句柄，实现=本地 PTY 跑 `ssh -t <conn> "cd <cwd> && exec <shell> -l"`（mux 复用免重复认证；`-t` 强制伪终端；远端 shell 探测用 hello/etectShells over exec）。
- **客户端**：dsh-terminal 标签条的"+"下拉分组：本地 shells / 远程连接（在线的）/ WIN shells；远程标签 chip 显示 `ssh·pwn`，标签名=远端目录 basename（图6 复刻）。断线重连：WS 重连后按 target 重新 spawn。
- 离线 e2e 扩展：假 dshSsh 断言 target 帧路由；真机验收：kali 标签落 `~/pwn` 出 p10k 提示符。

## 6. 前端设计（需求 前端1/2）

### 6.1 harness 补丁（ui-workspace，与 resize 补丁同节奏，一个 commit）
1. **添加工作区按钮 → 双项菜单**：点击弹出「本地目录… / 远程连接…」（对齐图1 两项菜单）。新孔 `sidebar.workspaces.remoteFlow`（single，owner props 仿 DirectoryFlowOwnerProps：`open/busy/onConnected/onCancel/onError`）；孔被 dsh-ssh 占用时菜单才出现"远程连接"项——无插件则行为与今天完全一致。
2. **远程工作区 section**：新孔 `sidebar.workspaces.sections`（list）渲染在工作区分组之后，dsh-ssh 注册自己的 section（连接行：云朵/Windows 图标 + 标题 + 状态点/spinner + ⋯菜单 + 锚定行右侧的连接日志浮层）。行全部归插件自绘，host workspace 注册表零侵入。
3. （M3）sshfs 挂载点用既有 `createWorkspace({path: mountPath})` 注册为真实工作区，原生出现在列表里；section 行与真实行去重联动。

### 6.2 向导（shell.overlay，全令牌化）
- 四步复刻图2–图5：左侧步骤条（当前=实心圆+行高亮、完成=绿勾、未到=灰）；卡片选择器（SSH/WSL/WIN/Docker 2×2，禁用卡灰化+原因 tooltip）；表单（别名下拉/主机/端口22/用户名/认证 segmented/私钥路径或密码/资源下载 segmented+说明文案）；连接中（日志大面板+右上 spinner"正在连接…"+主按钮文案迁移+可最小化到行内状态）；选择目录（远端目录树浏览，数据来自 ssh exec `ls`（M1）或 dsh-remote fs.list（M2），面包屑+新建文件夹）。
- **DSH 特色**：背景/边框/文字全部 `var(--dsw-alias-*)`，圆角 `var(--dsh-round-side,14px)`，兼容 ui-custom 玻璃拟态与 rounded-panels；图标用与侧栏一致的线性 SVG；日志等宽字体走 `var(--dsw-font-markdown-code*)`；动效遵循 ui-custom motion 令牌。
- **日志流单源**：host 半把连接过程事件（时间戳/级别/消息）推到 `WS /__dsh-ssh/ws`（按 connectionId 分频道）；向导大面板与行内浮层订阅同一频道——最小化向导连接不中断（图4/图5 双载体）。
- API 面：`GET /__dsh-ssh/api/connections`、`POST /__dsh-ssh/api/connect`（向导提交）、`GET /api/connections/:id/logs`、`POST /api/browse`（远端列目录）、`POST /api/check`（手动重测存活）、`GET /api/environment`（本地环境=卡片禁用依据）。全部挂在现有 webServer 服务上（dsh-terminal 同款 register/registerUpgrade）。

## 7. 存活检测（需求 7，M1）

- 触发：插件 apply 完成即全量探测（并发上限 4）；之后 60s±15% 抖动周期；离线指数退避（30s→5min 封顶）；侧栏展开/手动刷新即时重测。
- 探针分级：mux 在 → `ssh -O check`（零认证开销）；mux 不在 → 5s 超时 `ssh conn true`；runtime.installed → 升级探针为 stdio `ping`（顺带版本比对）。
- 状态机：`unknown → checking → online | offline | degraded(ssh通/runtime挂)`；状态变更经 WS 推 client，行徽标（绿点/灰点/spinner/黄叹号）实时刷新。DSH 重启后所有 mux 自然消亡，首探即重建——符合"每次打开 dsh 再检测"。

## 8. Rust 编写后端的优劣论证（需求 8）

先界定"后端"两层：**插件 host 半**（跑在 dsh web 的 Node 进程里）与 **dsh-remote 远端运行时**（跑在 SSH 对端）。

**TS（正常写法）优势**：
1. host 半**必须**是 JS——cordis ctx、webServer、服务/事件全在 JS 世界；Rust 只能以 napi addon 或 sidecar 进程形态接入，平白多一层 IPC/序列化与生命周期对齐。
2. 构建链复用（tsdown 双半打包、pnpm allowBuilds 已有坑位经验）、离线 e2e 模式成熟（Node 24 类型擦除直跑 src/*.ts）。
3. SSH 走系统 OpenSSH CLI（§3.1），根本不需要内嵌 SSH 协议栈——Rust 的 russh 优势场景被架空，且 russh 还解决不了 ssh.exe interop 这个真实网络约束。
4. dsh-terminal/vcp-memo/ui-custom 全员 TS，团队维护单一语言栈。

**Rust 的潜在优势**：单静态二进制分发（对**远端运行时**有吸引力：免 node 依赖，zip 从 45MB 降到 ~5MB）；端口转发数据面性能；内存安全。
**Rust 的代价**：napi 跨平台构建矩阵（linux-x64/arm64/darwin/win32 各一份 .node）、与 cordis 生命周期割裂、调试双语言、远端侧 PTY/WS/JSON-RPC 生态（portable-pty/russh/axum）全要重选型；而 node 单文件 bundle + 复用远端 node 已把 TS 远端包压到 3–5MB，体积优势被抹平。

**结论**：两层都用 **TS**。唯一值得留观察名单的：M4 隧道数据面若实测吞吐成为瓶颈，可把一个纯转发小工具用 Rust/Go 单独下沉——但那是可替换组件，不是插件后端。

## 9. 里程碑与验收

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M1 连接内核+向导+终端联动 | registry/SshConnector(mux)/存活检测/host API+WS/向导四步/远程 section/ui-workspace 补丁/dsh-terminal target 扩展/WSL+WIN 卡片逻辑 | e2e：假 ssh 假 ctx 全链路；真机：ecs(密钥直连) 与 kali(ssh.exe interop) 连接→日志流→选目录→终端标签落 ~/pwn 出 kali 提示符；重启 dsh web 后侧栏状态正确；向导最小化→行内 spinner+浮层日志与向导一致 |
| M2 远端运行时 | dsh-remote 最小包/manifest/两种下载方式/stdio JSON-RPC hello·ping·fs.list/版本漂移提示 | kali 无 node 场景上传内置 node 包可跑；ecs 复用系统 node；断网重传续装幂等（.ready） |
| ~~M3 远程工作区会话（方案A 远程窗口 + 方案C WIN）~~ **已于 2026-09-03 按用户决定回退** | 曾交付：dsh-app 部署包 + 隧道 + iframe 内嵌视图 + WIN 注册；用户验收后判定 iframe"机械拼接"不符合"同一 UI 管理"目标 → 整功能回退到 M1+M2 完成态，回退前快照在 `Plugin/dsh-ssh-m4-backup/` | 回退后 5 个 e2e 全绿、双面构建通过、真机残留进程已清理 |
| M5 远程会话原生执行（方案B） | harness 四包可选钩子补丁（workspace 远端路径容忍 create+indexHeader / fs-local 方法级 fsRemoteRouter 委托 / bash-local+subprocess-local 按 cwd 委托）+ dsh-ssh 路由四服务 + terminals 'ssh' 后端 + systemPrompt 按会话变量引导 + register-remote-workspace 路由 + dsh-remote 0.2.0（fs.\*/exec + tools/rg 入包） | ✅ 7 套件 e2e 全绿；headless 真机铁证（cwd=远端根的会话）：bash hostname 回 ecs 实例名、read 读仅远端存在文件、write 远端落盘核验、grep 走远端 rg；运行时 0.1.0→0.2.0 漂移自动升级；待：kali 复验 + 浏览器原生会话肉眼验收 |

风险登记：sshfs 未安装且性能有坑（大目录 git status 慢）→ M3 前做实测评估，必要时 M3 降级为"远端工作区只读浏览+终端"，把真工作区语义押到 M4 远程窗口；Windows OpenSSH Server 未装 → WIN 默认走 interop 不依赖它；密码认证在无 tty 场景的 SSH_ASKPASS 兼容性需在 kali/ecs 各验证一次。

**M1/M2 验收期实测新增（2026-09-02）**：
- ✅ 已修：interop（ssh.exe）必须 `-tt`（stdin 是 Windows 管道，-t 拒分配伪终端）；interop 禁用 ControlMaster/ControlPath（WSL 路径对 Windows 进程无意义）；checkNow 在途竞态（共享 Promise）；DSH_HOME 数据根约定；运行时双变体（slim/with-node）选择。
- ⚠️ 已知：dsh web 冷启动 CPU 高峰叠加 tsx 编译时，首次存活探测可能瞬判 offline，下个周期（≤60s）或手动刷新自愈。后续可在 probeOnce 加一次 3s 后重试消除首闪。
- ⚠️ ssh 自身 stderr 的 "Connection timed out" 未归类为"网络不可达"（走了通用"连接失败"前缀），分类提示可再细化。
- ⚠️ WIN interop 终端：powershell.exe 在 Linux PTY 里依赖终端应答 DSR 光标查询（xterm.js 原生支持 ✓）且 Enter 需 \r（xterm.js 默认就是 \r ✓）；逐键输入正常，**整行粘贴需真机肉眼确认**（理论上有 bracketed paste）。
- ℹ️ Windows interop 下密码认证不可用（SSH_ASKPASS 是 Linux 脚本，Windows ssh.exe 无法执行）——interop 连接仅支持密钥；向导可在选 interop sshBinary 时禁用密码段（后续打磨）。

**M3 验收期实测新增（2026-09-03）**：
- ✅ 已修：npm 发布版 dsh web（0.1.1-rc.2）回环监听免 token（URL 行无 ?token=）→ 启动检测与 token 提取双形态兼容；隧道绝不可骑 ControlMaster（master 会接管 -L 监听，"子进程存活=隧道存活"模型被击穿）→ 隧道一律独立连接；**interop 端口分配绝不做 WSL 侧 listen 探测**——WSL2 localhostForwarding 会把探测过的端口在 Windows 侧残留占用（EADDRINUSE），只走 Windows curl.exe 探测（退出码 7/28=空闲，0/52=占用）；绑定失败快速换端口重试 ≤5 次；interop killChild 追加 PowerShell taskkill 清剿 Windows 侧 ssh.exe（WSL kill 只到 /init 包装层）。
- ✅ 凭据同步：syncConfig 读 `$DSH_HOME`（隔离实例天然不泄漏真凭据——意外验证）；ZCode 文档确认"模型/账号留桌面端"是它的中继设计，我们方案 A 是完整远端 dsh，凭据随包同步（仅信任主机，UI 明示）。
- ℹ️ `dsh plugin add link:` 会触发 profile 管理器重建 node_modules——手工软链会被清，正确姿势是官方 CLI。
- ⚠️ 已知残留：早期调试在 Windows 侧残留 3120-3122 端口占用（WSL 探测遗留，需重启或等超时释放）；iframe 面板 × 关闭=拆隧道+停远端（重开幂等）。

## 10. 开放决策点（~~等用户拍板~~ 已决，2026-09-02）

1. **MVP 范围**：✅ 用户拍板 **M1+M2 一批**（连接内核+向导+终端联动+存活检测+远端运行时下发）。M3（sshfs/WIN 工作区落地）待 sshfs 实测后评估，M4（隧道+远程窗口）单独立项。
2. 向导"选择目录"后，M1 阶段不注册占位本地工作区，远程 section 独立（默认建议，用户未异议）。
3. dsh-remote 默认"复用远端系统 node"，探测失败自动转内置 node 变体包（默认建议，用户未异议）。
