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

当前已验证版本还需要宿主补丁，才能完整接入原生工作区。先停止 DSH，再将 `DSH_PATCH_ROOT` 设置为包含 `runtime/node_modules` 的宿主目录：

```bash
DSH_PATCH_ROOT=/path/to/host node scripts/apply-host-hooks.mjs
DSH_PATCH_ROOT=/path/to/host pnpm test
```

补丁脚本默认要求 `0.1.2-rc.1`，检查包版本和源码锚点，并将原文件及哈希保存在宿主的 `patches/ssh-host-hooks/` 下。旧基准需额外设置 `DSH_PATCH_BASELINE=0.1.2-alpha.2`。宿主目录结构不符合要求时，需要先调整部署方式。

完成 profile 依赖安装与宿主补丁后，重启 `dsh web`。连接入口位于添加工作区的目录选择弹窗中；浏览器终端面板由独立的 `dsh-terminal` 插件提供，需另行安装。

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

已通过 28 项独立兼容测试；指定已打补丁的宿主目录后，共运行 31 项测试。此前实机验收覆盖 WSL 调用 Windows OpenSSH 的密钥认证、运行时握手、工作区文件查询与目录浏览，以及远程终端命令执行、尺寸调整和退出。其他操作系统有隔离测试覆盖，不代表已完成相应平台的实机验收。
