# dsh-ssh

面向 DSH Web 的远程工作区插件，支持 SSH 连接管理、远程目录浏览、运行时下发，以及与 [dsh-terminal](https://github.com/reedflame40224/dsh-terminal) 联动打开远程终端。

本仓库保留原插件源码和提交历史，默认入口已切换到基于 [dsh-std](https://github.com/Yan-Zero/dsh-std) 的兼容实现，包含 WSL Windows OpenSSH 适配和连接状态检测修复。

## 兼容要求

| 项目 | 要求 |
| --- | --- |
| DSH 宿主 | 已验证 `0.1.2-rc.1`，此前也在 `0.1.2-alpha.2` 完成验收 |
| 社区适配器 | `@dsh-std/adapter-dsh@0.1.1-rc.2`，需在 Web profile 中启用 |
| 本地 Node.js | 24 或更高版本 |
| 安装方式 | 在 `node_modules` 外保留源码仓库，通过本地目录链接安装 |
| 远程运行时 | 当前构建脚本面向 Linux x64；普通压缩包要求远端已有 Node.js |

兼容实现加载仓库中的 TypeScript 文件，依赖 Node.js 内置类型擦除功能。该功能在 `node_modules` 内受到限制，因此请使用源码目录链接。

本实现使用内部组件清单和 DSH 专用远程工作区接口，尚不是 Community 0.15 跨宿主标准包。其他宿主版本需要重新验证接口与补丁。

## 构建与测试

```bash
git clone https://github.com/reedflame40224/dsh-ssh.git
cd dsh-ssh
pnpm install --frozen-lockfile
pnpm bundle
pnpm test
pnpm build:runtime
```

- `pnpm bundle`：构建原浏览器源码，再应用兼容转换。
- `pnpm test`：运行独立兼容测试，无需原开发者的 lab 目录或服务器凭据。
- `pnpm build:runtime`：生成 `assets/runtime/` 下的远程运行时压缩包；产物不提交到 Git。

仓库已跟踪经过验证的浏览器入口。需要内置 Node.js 或 ripgrep 时，可分别运行 `scripts/fetch-node.mjs` 和 `scripts/fetch-rg.mjs` 准备资源，再执行 `pnpm build:runtime --with-node`。内置 Node.js 必须是真实可执行文件。

## 接入 DSH

在 Web profile 的 `package.json` 中，将 `dsh-ssh` 依赖指向本地仓库，例如 `link:/path/to/dsh-ssh`，并在 `dsh.profile.bundles` 中启用 `@dsh-std/adapter-dsh` 和 `dsh-ssh`。请合并现有配置，保留其他插件条目。

当前已验证版本还需要宿主补丁，才能完整接入原生工作区。先停止 DSH，指定实际 Web profile 路径：

```bash
node scripts/apply-host-hooks.mjs --host /path/to/.dsh/profiles/web --check
node scripts/apply-host-hooks.mjs --host /path/to/.dsh/profiles/web
```

脚本支持 profile 本地依赖、`.dsh/profiles/node_modules` 共享依赖、直接指定 `node_modules`，以及旧的 `runtime/node_modules` 布局。`--check` 只预检，不修改文件；不带该参数才写入。默认要求 `0.1.2-rc.1`，原文件及哈希保存在所指定目录的 `patches/ssh-host-hooks-0.1.2-rc.1/`。旧基准需设置 `DSH_PATCH_BASELINE=0.1.2-alpha.2`。更新宿主后必须重新预检。

目录弹窗参数通过 TypeScript AST 定位，允许保留新增的 `pickNativeDirectory`、`validateDirectory` 等参数。其余源码锚点仍严格校验；遇到未知结构会停止，不能据此认为支持任意同版本构建。

完成 profile 依赖安装与宿主补丁后，重启 `dsh web`。连接入口位于添加工作区的目录选择弹窗中；浏览器终端面板由独立的 `dsh-terminal` 插件提供，需另行安装。

## Windows 原生安装实验

使用 Node.js 24，在 `node_modules` 外克隆并安装两个仓库的依赖。先确保现有 Web profile 能正常启动，且能解析 `@dsh-std/adapter-dsh@0.1.1-rc.2`。在 dsh-ssh 仓库目录执行 PowerShell：

```powershell
$profileDir = "$env:USERPROFILE\.dsh\profiles\web"
node scripts/install-profile.mjs --profile "$profileDir" --terminal "C:/plugins/dsh-terminal"
node scripts/install-profile.mjs --profile "$profileDir" --terminal "C:/plugins/dsh-terminal" --apply
node scripts/apply-host-hooks.mjs --host "$profileDir" --check
node scripts/apply-host-hooks.mjs --host "$profileDir"
```

将示例路径替换为实际路径；自定义 `DSH_HOME` 时也需调整 profile。安装脚本默认仅显示计划，`--apply` 会备份并合并 `package.json`，创建 Windows junction（Linux 为目录软链接）。它不会安装宿主或适配器，也不会替换指向其他位置的现有插件依赖。`node_modules` 本身若为共享链接，脚本会拒绝写入。

启用插件后统一使用网页目录弹窗，替代自动选择的系统目录选择器，使远程入口在 Windows 上可见。Windows OpenSSH 不启用 Unix ControlMaster；主机密钥记录路径支持空格。原生 Windows 的密码认证暂未实现，请使用密钥认证；WSL 保留原来的认证实现。

本次隔离实验基于 Windows 原生 Node.js 24 和 DSH `0.1.2-rc.1`，通过 34 项兼容测试，已验证安装、补丁预检和网页远程入口。联合安装的终端已实测 PowerShell 命令执行、ConPTY 尺寸回读和退出。现有 SSH 测试目标直连也超时，尚未完成本次 Windows 远程运行时和远程终端实机验收。

## WSL 连接适配

当连接明确配置为 `/mnt/<盘符>/...exe` 下的 Windows SSH 时，兼容层会：

- 使用 `wslpath` 转换插件的主机密钥记录路径。
- 在 WSLInterop 未注册或未启用时，通过 `/init` 启动 Windows SSH，并保留正确的参数序列。
- 根据 SSH 退出码判断存活状态，避免失败的连接被误报为在线。

该逻辑不修改全局网络、路由、防火墙或 WSL 设置，不自动切换 SSH 实现，也不重试任意远程命令。原生 Linux SSH 和非 WSL 环境保留原传输方式。自定义盘符挂载根目录暂不自动识别。

| 环境变量 | 用途 |
| --- | --- |
| `DSH_SSH_WSL_INTEROP=off` | 关闭 WSL Windows SSH 适配，默认值为 `auto` |
| `DSH_SSH_STD_REMOTE_HOME` | 指定远程运行时目录；默认保留 `.dsh-remote-std-lab` 以兼容已有部署 |

连接记录不持久化密码。不要将真实连接记录、私钥、密码或 DSH 用户配置提交到仓库。

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `compat/ssh-std/` | SSH、运行时、文件系统和生命周期实现 |
| `compat/ssh-dsh-bridge/` | DSH 服务桥接、路由与浏览器兼容入口 |
| `src/` | 保留的原始 TypeScript 插件源码 |
| `remote/` | 远程运行时源码 |
| `scripts/` | 构建、宿主补丁和测试脚本 |

默认服务端入口是 `compat/ssh-dsh-bridge/index.mjs`；`lib/index.js` 属于原实现的构建产物。

## 验证范围

兼容测试覆盖生命周期、宿主接口、四种安装布局、目录弹窗参数扩展和 Windows SSH 参数。指定 `DSH_PATCH_ROOT` 后还会验证宿主接口。此前实机验收覆盖 WSL 调用 Windows OpenSSH 的密钥认证、运行时握手、工作区文件查询与目录浏览，以及远程终端命令执行、尺寸调整和退出。测试结果不代表所有平台和宿主构建均已验收。
