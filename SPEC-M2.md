# dsh-ssh — M2 实施规范：dsh-remote 远端运行时（编码子代理必读）

> **主代理修订（验收期）**：
> 1. 运行时变体从单包改为**双变体并存**：`dsh-remote-<v>-<platform>.tar.gz`（slim，复用远端 node≥18）与 `…​.with-node.tar.gz`（内置 node）。RuntimeManager.selectVariant：远端有 node→slim 优先，否则必须 with-node，都无→硬失败给指引。build-runtime.mjs 的 --with-node 产物用 `.with-node.tar.gz` 后缀。
> 2. test/runtime.e2e.mjs 的假 node 资产改为备份/恢复语义（防覆盖真 node 资产）；e2e 会重建 assets/runtime 产物，**e2e 之后必须重跑两次 build-runtime（slim + --with-node）恢复正式产物**。
> 3. 数据根遵循 harness 约定 `$DSH_HOME`（缺省 ~/.dsh）——隔离测试实例（DSH_HOME 指他处）不碰用户真注册表。
> 4. node 资产来源：fetch-node.mjs 官方源在本环境无外网超时，实测用本机 nvm 官方二进制（~/.nvm/versions/node/v24.19.0/bin/node，126MB 单文件 ELF）拷入 assets/node/linux-x64/bin/node。

目标（对应 PLAN.md §4）：连接向导成功后，把最小运行时下发到 SSH 远端**登录用户家目录** `~/.dsh-remote/`，支持 stdio JSON-RPC（hello/ping/fs.list/fs.mkdir），sha256+`.ready` 版本治理，两种下载方式（本地下载后上传 / 远端服务器下载）。M2 交付后，存活检测升级为运行时 ping（ssh 通但运行时挂 → degraded），已注册连接的 browse 优先走运行时。

前置：M1 已完成并真机验收（ecs 直连 / kali interop 全通）。M1 事实（SPEC-M1.md）仍然有效，不再复述。本规范是 M2 唯一契约来源。

## 分工（串行两波：R1 先，主代理验收后 R2 再动）

| 代理 | 拥有路径 | 任务 |
|---|---|---|
| R1 运行时 | `Plugin/dsh-ssh/remote/**`、`Plugin/dsh-ssh/scripts/**`、`Plugin/dsh-ssh/test/runtime.e2e.mjs` | 远端 server 源码 + start.sh + 构建/拉取脚本 + 运行时离线 e2e |
| R2 host 集成 | `Plugin/dsh-ssh/src/**`（不含 client/）、`Plugin/dsh-ssh/test/runtime-host.e2e.mjs` | stdio 通道 + RuntimeManager + testConnect hook 替换 + browse 优先运行时 + liveness degraded + API |

**禁止**：改 package.json/tsdown.config.ts（主代理已加好 esbuild devDep 与 scripts）；改 client/（M2 无前端工作）；git commit。

## R1：远端运行时本体

### 目录与产物
```
remote/
  src/server.ts        # stdio JSON-RPC server 源码（TS，只用 node: 内置模块）
  start.sh             # 启动器（见下）
scripts/
  build-runtime.mjs    # 打包脚本（见下）
  fetch-node.mjs       # node 二进制拉取（见下）
assets/runtime/        # 构建产物（gitignored）：dsh-remote-<version>-<platform>.tar.gz
test/runtime.e2e.mjs   # 离线 e2e
```

### server.ts（stdio JSON-RPC，换行分隔 JSON）
- 启动即向 stdout 打印一行 hello（非请求响应）：`{"type":"dsh-remote-hello","version":"0.1.0","platform":"linux","arch":"x64","node":"v22.22.2"}`（version 来自同包 manifest，构建期注入常量亦可；platform/arch 用 process.platform/process.arch，os 归一 linux|darwin|win32）。
- 循环读 stdin 行，JSON 解析；请求 `{"id":<number|string>,"method":"...","params":{...}}`；响应 `{"id":<同>,"result":...}` 或 `{"id":<同>,"error":{"code":"...","message":"..."}}`。
- **健壮性**：单行 JSON 解析失败 → 回 `{"id":null,"error":{"code":"BAD_JSON","message":...}}` 继续循环（进程不死）；未知 method → `UNKNOWN_METHOD`；单个方法抛错 → `INTERNAL` 带 message。stderr 只写日志（host 侧把 stderr 行当日志）。
- 方法（M2 冻结）：
  - `ping {}` → `{version, uptimeMs, pid}`
  - `hello {}` → `{version, platform, arch, node, home}`（home=os.homedir()）
  - `fs.list {dir}` → `{dir, parent?, entries:[{name,type:'dir'|'file'|'link'}]}`（dir 不存在→`NOT_FOUND`；非目录→`NOT_DIR`；无权限→`EACCES`；entries 目录优先排序，与 M1 browse 同形状）
  - `fs.mkdir {dir}` → `{dir}`（recursive；已存在幂等成功）
- `--version` CLI 参数打印 version 退出。
- **体积约束**：零 npm 依赖，只用 node: 内置模块，esbuild --bundle --platform=node --format=cjs 后应 < 50KB。

### start.sh（POSIX sh，zcode-agent 同型）
```sh
#!/bin/sh
# dsh-remote 启动器：优先自带 node，其次系统 node（>=18），都没有则报错退出 127。
# 用法: start.sh [--stdio]   （M2 只有 stdio 模式）
```
- 定位自身目录 `SELF_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)`。
- node 解析顺序：`$SELF_DIR/node/bin/node` 可执行 → `command -v node` 且 `node -e` 打印 major≥18 → 都没有：stderr 写 `dsh-remote: 未找到可用 node（>=18），请安装或改用内置 node 变体包`，exit 127。
- `exec "$NODE" "$SELF_DIR/dsh-remote-server.cjs" "$@"`。

### scripts/build-runtime.mjs
- 用法：`node scripts/build-runtime.mjs [--platform linux-x64] [--with-node]`
- 步骤：esbuild bundle `remote/src/server.ts` → 临时目录 `dsh-remote-server.cjs`；拷贝 `remote/start.sh`；生成 `manifest.json`：
  ```json
  {"name":"dsh-remote","version":"0.1.0","platform":"linux-x64","requiresNode":">=18",
   "components":[{"path":"dsh-remote-server.cjs","sha256":"…","bytes":…},{"path":"start.sh","sha256":"…","bytes":…},{"path":"node/bin/node","sha256":"…","optional":true}]}
  ```
  （--with-node 且 `assets/node/<platform>/bin/node` 存在时纳入 node 组件，否则省略该组件项）
- 打 `tar -czf assets/runtime/dsh-remote-0.1.0-linux-x64.tar.gz -C <临时目录> .`（用系统 tar）；打印产物路径+大小+manifest sha256 摘要。
- version 读 package.json version。

### scripts/fetch-node.mjs
- 拉取官方 node v22 LTS linux-x64 tarball（`https://nodejs.org/dist/v22.16.0/node-v22.16.0-linux-x64.tar.xz`），只取 `bin/node` 落到 `assets/node/linux-x64/bin/node`（0755）。已存在且大小>100MB 则跳过。网络失败清晰报错退出非 0（验收环境可能无外网，主代理判断）。
- `assets/node/` 加进 .gitignore（脚本自己确保，幂等）。

### test/runtime.e2e.mjs（纯 node，全绿才算完）
1. 跑 build-runtime.mjs（不带 node）→ 产物存在、manifest 三组件 sha256 与临时解压内容一致、tar 可解。
2. 本地 spawn `node <解压>/dsh-remote-server.cjs --stdio`：hello 行先到（含 version/platform/arch/node）→ ping → hello 方法 → fs.list 临时目录（dir/file/link 分类正确、目录优先）→ fs.mkdir 递归新建幂等 → fs.list 不存在目录 NOT_FOUND → 未知方法 UNKNOWN_METHOD → 发一行坏 JSON 进程不死且回 BAD_JSON → 后续 ping 仍正常 → kill。
3. start.sh 逻辑：伪造目录结构（无 node/bin/node）下系统 node 可跑通（exec 出 hello）；PATH 置空场景 exit 127（用 env -i + 无 node/bin 模拟）。

## R2：host 集成

### ssh.ts 扩展（在 M1 基础上增量）
- 新增 `openChannel(target, remoteCommand, opts?): Promise<SshChannel>`：persistent ssh exec，stdio=['pipe','pipe','pipe']，骑 mux（interop 无 mux 则独立连接）；SshChannel=`{write(line:string):void, onLine(cb), onStderrLine(cb), onExit(cb), close():void, exited:boolean}`。复用 run() 的 spawnFn 注入面（e2e 可注假）。askpass env 支持（密码连接的 channel 也要能建——复用 testConnect 的 askpass 生命周期抽取为小helper）。
- 删除 testConnect 末尾的 M2 占位 INFO，改为调用注入的 `runtimeStep`（构造新可选依赖 `runtimeStep?: (target, draft, log) => Promise<{installed:boolean, version?:string, reused?:string} | undefined>`）：缺省/返回 undefined 时行为=M1。该 hook 由 index.ts 组装时注入（routes 的 connect 也走 testConnect，一处改动全链路生效）。

### src/remote-client.ts（新）
- `class RemoteRuntimeClient`：构造 `{channel}`；行分隔 JSON codec；id 自增；pending map（10s 超时 reject）；hello 行单独事件（构造时等首行 hello，5s 超时 reject）；`call(method, params)`；`close()`；channel exit → 所有 pending reject + 状态 closed。
- `class RuntimePool`：connId → RemoteRuntimeClient 缓存；`get(conn)` 惰性建（spawn `~/.dsh-remote/current/start.sh --stdio` 经 openChannel）；`drop(connId)`；`disposeAll()`。channel 断开自动剔除缓存（下次重建）。

### src/runtime.ts（新）RuntimeManager
- 常量：`REMOTE_HOME='.dsh-remote'`（远端登录家目录下）；`LOCAL_TAR = assets/runtime/dsh-remote-<version>-linux-x64.tar.gz`（按 env.os/arch 选 platform，M2 只出 linux-x64 变体；远端非 linux-x64 → log WARN 跳过）。
- `ensure(target, {method:'upload'|'remote', remoteUrl?}, log): Promise<{installed:true, version, reused:'system-node'|'bundled-node'|undefined}>`：
  1. INFO `检查远端运行时…`：exec `cat ~/.dsh-remote/current/manifest.json 2>/dev/null` + `.ready` 存在性；version 与本地 manifest 一致且 .ready → INFO `运行时已是最新（v…）`，返回 installed（reused=undefined）。
  2. 需安装：method=upload → INFO `本地下载后上传：上传运行时包（X.X MB）…`，`openChannel(target, 'cat > ~/.dsh-remote/staging/<v>.tar.gz && …')` stdin 流式写本地 tar 文件（先 `mkdir -p ~/.dsh-remote/staging`）；method=remote → 需 remoteUrl（draft.runtimeUrl 或 undefined；无 → throw `未配置远端下载源地址`），exec `curl -fsSL '<url>' -o … || wget -qO … …`（INFO `远端服务器下载：…`）。
  3. 校验：本地算 tar 的 sha256 → 远端 `sha256sum` 比对，不等 → ERROR `校验失败`。
  4. 解压激活：exec `rm -rf cache/<v> && mkdir -p cache/<v> && tar -xzf staging/<v>.tar.gz -C cache/<v> && chmod +x cache/<v>/start.sh && ln -sfn cache/<v> current && touch cache/<v>/.ready && rm -f staging/<v>.tar.gz`（在 ~/.dsh-remote 下；单条 exec，分段失败即整体失败）。
  5. INFO `运行时校验通过，激活 v…`；握手：RuntimePool.get → hello/ping 成功 → INFO `远端运行时握手成功（node …）`；失败 → 记 WARN 但仍算 installed（ssh 可用，运行时降级由存活检测表达）。
- node 复用判定：target env（testConnect 已探测 node 版本）major≥18 且 tar 无内置 node → reused='system-node'；tar 含 node/bin/node → start.sh 优先自带（reused='bundled-node'）。日志如实打印 reused。

### routes.ts / liveness.ts / registry.ts 集成
- registry：ConnectionRecord.runtime 已有 `{installed:boolean}`，扩 `{installed, version?, updatedAt?}`；`registry.updateRuntime(connId, {installed,version})` 新方法（原子写）。
- connect pipeline 成功后（testConnect 返回且 runtimeStep 有结果）→ routes 调 `registry.updateRuntime`。
- liveness probe：ssh online 且 `record.runtime.installed` → 追加 runtime ping（RuntimePool.get+call('ping')，3s 超时）；ping 失败 → state='degraded'、error=`运行时无响应：…`；ping 成功且此前 degraded → 回 online。M1 的 unknown→checking→online|offline 不变。
- `POST /api/browse`：connectionId 路径下，`record.runtime.installed && status.state==='online'` → 先 RuntimePool fs.list，任何异常回落 M1 的 ls 实现（log WARN 一次）。flowId 路径保持 ls（向导期不依赖运行时）。
- 新 API：`POST /api/runtime/ensure {connectionId}` → `{ok, installed, version, error?}`（section 行菜单"重新连接/修复运行时"未来用；M2 只实现路由）。
- targets API items 扩 `runtime?: {installed:boolean, version?:string}`（dsh-terminal 暂不消费，前瞻性字段）。

### test/runtime-host.e2e.mjs（全绿才算完）
假 ssh 注入（connector.e2e.mjs 同款 spawnFn/脚本模式），脚本对尾参命令用 `env HOME=<fakehome> sh -c '<cmd>'` 本地真执行——这样 RuntimeManager 的安装流在本地目录全真演练：
1. 全新安装：fakehome 无 .dsh-remote → ensure 后目录结构（staging 已清/cache/<v>/.ready/current symlink/manifest）齐全、握手 ping 通（start.sh 用系统 node 真跑）、日志含上传/校验/激活/握手行。
2. 幂等：二次 ensure → `已是最新`、无重复上传（假脚本记录次数）。
3. 升级：伪造旧版 manifest（version 不同）→ 重新安装、current 指向新版、旧 cache 保留。
4. 校验失败：假脚本篡改 sha256sum 输出 → ERROR 校验失败、current 不变。
5. degraded：liveness 对 runtime.installed=true 的连接，channel 拒答（假 start.sh 退出）→ degraded；恢复 → online。
6. openChannel 基础：写行进 tail、onLine 逐行、close 后 exited。

## 验收标准（主 agent）
1. `pnpm build:runtime` 产物存在；`pnpm run test:e2e` 五个测试全绿；`pnpm bundle` 零报错。
2. 真机（重启后）：kali（有 node v22→system-node 复用）与 ecs（无 node→bundled 变体，需 fetch-node 成功；无外网则 ecs 仅验证 upload 路径的远端 tar 解压，node 用 bunded）各走一遍向导级 /api/connect（含运行时安装日志流），browse 走运行时 fs.list（日志/版本佐证），断网（kali 关机模拟可选）→ degraded。
3. 远端检查：`ssh kali 'ls ~/.dsh-remote / cat ~/.dsh-remote/current/manifest.json'`。

## 边界与风格
同 M1：无分号单引号中文注释；Node 24 类型擦除兼容；不 import @deepseek-ai/* 运行时值；密码不入日志（runtime 日志行过 maskSecret）；R2 的 ssh.ts 改动不得破坏 connector.e2e.mjs 既有断言。
