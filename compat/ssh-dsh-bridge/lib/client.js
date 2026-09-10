window.__ModuleLoader__.load({
	id: "dsh-ssh",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/client/api.ts
		/** 统一错误类型：message 里是服务端 {ok:false,error} 的原文或网络说明。 */
		var ApiError = class extends Error {
			status;
			constructor(message, status) {
				super(message);
				this.name = "ApiError";
				this.status = status;
			}
		};
		const BASE = "/__dsh-ssh";
		async function request(path, init) {
			let res;
			try {
				res = await fetch(`${BASE}${path}`, {
					headers: { "content-type": "application/json" },
					...init
				});
			} catch {
				throw new ApiError("无法连接 DSH 服务（插件可能未挂载）", 0);
			}
			let data;
			try {
				data = await res.json();
			} catch {
				throw new ApiError(`响应不是 JSON（HTTP ${res.status}）`, res.status);
			}
			if (!res.ok || data.ok === false) throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
			return data;
		}
		const api = {
			/** GET /api/environment —— 本地环境（卡片禁用依据）。 */
			environment: () => request("/api/environment"),
			/** GET /api/aliases —— 别名下拉数据源（dsh + ssh-config 合并）。 */
			aliases: () => request("/api/aliases"),
			/** GET /api/connections —— 注册表 + 当前状态。 */
			connections: () => request("/api/connections"),
			/** POST /api/connect —— 长请求；进度走 WS log 频道（key=flowId），不持久化。 */
			connect: (draft, flowId) => request("/api/connect", {
				method: "POST",
				body: JSON.stringify({
					draft,
					flowId
				})
			}),
			/** POST /api/connections —— 向导第 4 步「完成」持久化。flowId 关联 connect 暂存（env/运行时安装结果回填落库）。 */
			persistConnection: (draft, title, remotePath, flowId) => request("/api/connections", {
				method: "POST",
				body: JSON.stringify({
					draft,
					title,
					remotePath,
					...flowId ? { flowId } : {}
				})
			}),
			/** POST /api/browse —— 远端列目录（flowId 向导期 / connectionId 注册表）。 */
			browse: (input) => request("/api/browse", {
				method: "POST",
				body: JSON.stringify(input)
			}),
			/** POST /api/check —— 手动重测存活（同步等结果）。 */
			check: (connectionId) => request("/api/check", {
				method: "POST",
				body: JSON.stringify({ connectionId })
			}),
			/** POST /api/disconnect —— 关 mux、置 unknown。 */
			disconnect: (connectionId) => request("/api/disconnect", {
				method: "POST",
				body: JSON.stringify({ connectionId })
			}),
			/** DELETE /api/connections —— 删除连接（先 disconnect）。 */
			removeConnection: (connectionId) => request("/api/connections", {
				method: "DELETE",
				body: JSON.stringify({ connectionId })
			}),
			/** GET /api/targets —— dsh-terminal client 直取；本插件仅降级自检时兜底。 */
			targets: () => request("/api/targets"),
			/** POST /api/register-remote-workspace —— M5：把连接注册为原生工作区（失败不掉向导）。 */
			registerRemoteWorkspace: (connectionId) => request("/api/register-remote-workspace", {
				method: "POST",
				body: JSON.stringify({ connectionId })
			})
		};
		const WS_RETRY_BASE_MS = 1e3;
		const WS_RETRY_MAX_MS = 15e3;
		var WsClient = class {
			ws = null;
			retryTimer = null;
			retryDelay = WS_RETRY_BASE_MS;
			disposed = false;
			started = false;
			/** 活跃订阅表（引用计数去重：同 key 只向服务端订阅一次）。 */
			subs = /* @__PURE__ */ new Map();
			handler = null;
			/** 注册帧分发回调（模块级单例，只允许一个消费者；null 解绑）。 */
			setHandler(handler) {
				this.handler = handler;
			}
			/** 常驻启动：建立连接并订阅状态频道（生命周期归 ctx.effect）。 */
			start() {
				if (this.started) return;
				this.started = true;
				this.disposed = false;
				this.subscribeStatus();
				this.connect();
			}
			/** 彻底停止（插件卸载）：断连、清定时器、清订阅。 */
			dispose() {
				this.disposed = true;
				this.started = false;
				if (this.retryTimer !== null) {
					clearTimeout(this.retryTimer);
					this.retryTimer = null;
				}
				if (this.ws !== null) {
					this.ws.onclose = null;
					this.ws.close();
					this.ws = null;
				}
				this.subs.clear();
				this.retryDelay = WS_RETRY_BASE_MS;
			}
			/** 订阅状态频道（引用计数）；返回退订函数。 */
			subscribeStatus() {
				return this.acquire("status", void 0);
			}
			/** 订阅日志频道（key=flowId|connectionId）；返回退订函数。 */
			subscribeLog(key) {
				return this.acquire("log", key);
			}
			acquire(channel, key) {
				const id = `${channel}:${key ?? ""}`;
				const existing = this.subs.get(id);
				if (existing !== void 0) existing.refs += 1;
				else {
					this.subs.set(id, {
						channel,
						key,
						refs: 1
					});
					if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) this.sendSub(channel, key);
				}
				let released = false;
				return () => {
					if (released) return;
					released = true;
					const sub = this.subs.get(id);
					if (sub === void 0) return;
					sub.refs -= 1;
					if (sub.refs <= 0) {
						this.subs.delete(id);
						if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) this.send({
							t: "unsubscribe",
							channel,
							key
						});
					}
				};
			}
			connect() {
				if (this.disposed || this.ws !== null) return;
				const protocol = window.location.protocol === "https:" ? "wss" : "ws";
				let socket;
				try {
					socket = new WebSocket(`${protocol}://${window.location.host}${BASE}/ws`);
				} catch {
					this.scheduleReconnect();
					return;
				}
				this.ws = socket;
				socket.addEventListener("open", () => {
					this.retryDelay = WS_RETRY_BASE_MS;
					for (const sub of this.subs.values()) this.sendSub(sub.channel, sub.key);
				});
				socket.addEventListener("message", (event) => {
					if (this.disposed) return;
					if (typeof event.data !== "string") return;
					let frame;
					try {
						frame = JSON.parse(event.data);
					} catch {
						return;
					}
					this.handler?.(frame);
				});
				socket.addEventListener("close", () => {
					if (this.ws === socket) this.ws = null;
					if (!this.disposed) this.scheduleReconnect();
				});
				socket.addEventListener("error", () => {
					socket.close();
				});
			}
			scheduleReconnect() {
				if (this.disposed || this.retryTimer !== null) return;
				const delay = this.retryDelay;
				this.retryDelay = Math.min(this.retryDelay * 2, WS_RETRY_MAX_MS);
				this.retryTimer = setTimeout(() => {
					this.retryTimer = null;
					this.connect();
				}, delay);
			}
			sendSub(channel, key) {
				this.send(channel === "status" ? {
					t: "subscribe",
					channel: "status"
				} : {
					t: "subscribe",
					channel: "log",
					key: key ?? ""
				});
			}
			send(frame) {
				if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return;
				this.ws.send(JSON.stringify(frame));
			}
		};
		/** 模块级单例（浏览器页内唯一，生命周期归 client apply 的 ctx.effect）。 */
		const wsClient = new WsClient();
		//#endregion
		//#region src/client/stores.ts
		/**
		* dsh-ssh client 半的三个 HostObservable store（模式照抄 dsh-terminal client/sessions.ts）：
		*
		* - connectionsStore：注册表 + 内存状态（WS status 频道喂增量，行内状态件用）。
		* - wizardStore：连接向导状态机（visible/step/表单/连接中/目录浏览/持久化）。
		* - logsStore：按 key（flowId|connectionId）的日志环形缓冲（向导面板与行菜单
		*   日志浮层共用同一 WS log 频道，最小化向导不杀 pipeline，重订阅拿快照+增量）。
		* - logPopoverStore：行菜单「查看日志」浮层（M6 shell.overlay order 62 挂载）——
		*   {open, anchorRect, channelKey}，open 供 hooks.visible 绑定。
		*
		* 另有 wizardVisible（shell.overlay 的 hooks.visible 绑定）与 wizardOccupied
		* （remoteFlow 孔的 hooks.remoteFlow 绑定，SPEC C 节）两个 HostObservable<boolean>。
		*/
		/** 插件 client ctx（apply 时捕获；用于惰性取 client 服务如 uiWorkspace）。 */
		let pluginCtx = null;
		function setPluginCtx(ctx) {
			pluginCtx = ctx;
		}
		function getPluginCtx() {
			return pluginCtx;
		}
		/** 日志缓冲区上限（服务端每 key 环形 500 行，客户端同量保底）。 */
		const LOG_RING_SIZE = 500;
		const logsState = { linesByKey: {} };
		let logsVersion = 0;
		const logsListeners = /* @__PURE__ */ new Set();
		function logsNotify() {
			logsVersion += 1;
			for (const listener of [...logsListeners]) listener();
		}
		const logsStore = {
			subscribe: (listener) => {
				logsListeners.add(listener);
				return () => {
					logsListeners.delete(listener);
				};
			},
			getVersion: () => logsVersion,
			/** 读视图：某 key 的日志行（空则空数组，绝不返回 undefined）。 */
			getLogs: (key) => logsState.linesByKey[key] ?? [],
			/** 订阅即回快照（WS log-snapshot 帧）。 */
			snapshot: (key, lines) => {
				logsState.linesByKey[key] = lines.slice(-500);
				logsNotify();
			},
			/** 增量一行（WS log 帧）。 */
			append: (key, line) => {
				const arr = logsState.linesByKey[key] ?? [];
				arr.push(line);
				if (arr.length > LOG_RING_SIZE) arr.splice(0, arr.length - LOG_RING_SIZE);
				logsState.linesByKey[key] = arr;
				logsNotify();
			},
			/** 新 flowId 起笔：清空该 key 历史（重试场景从零开始）。 */
			clear: (key) => {
				if (logsState.linesByKey[key] === void 0) return;
				logsState.linesByKey[key] = [];
				logsNotify();
			}
		};
		let connEntries = [];
		let connLoaded = false;
		let connFailed = false;
		let connVersion = 0;
		const connListeners = /* @__PURE__ */ new Set();
		/** WIN 注册为本地工作区后的行内副标题提示（connId → 文案，4s 后自动消失）。 */
		let connHints = {};
		const connHintTimers = /* @__PURE__ */ new Map();
		function clearHintTimer(connectionId) {
			const timer = connHintTimers.get(connectionId);
			if (timer !== void 0) {
				clearTimeout(timer);
				connHintTimers.delete(connectionId);
			}
		}
		function connNotify() {
			connVersion += 1;
			for (const listener of [...connListeners]) listener();
		}
		const connectionsStore = {
			subscribe: (listener) => {
				connListeners.add(listener);
				return () => {
					connListeners.delete(listener);
				};
			},
			getVersion: () => connVersion,
			getEntries: () => connEntries,
			isLoaded: () => connLoaded,
			isFailed: () => connFailed,
			/** 初始拉取（/api/connections）；失败标记 failed，保留旧列表（插件降级不白屏）。 */
			refresh: async () => {
				try {
					const { items } = await api.connections();
					connEntries = items;
					connLoaded = true;
					connFailed = false;
				} catch {
					connLoaded = true;
					connFailed = true;
				}
				connNotify();
			},
			/** WS status 快照（Record<id,Status>），只覆盖已知连接。 */
			applyStatusSnapshot: (items) => {
				if (connEntries.length === 0) return;
				const next = connEntries.map((entry) => {
					const status = items[entry.connection.id];
					return status !== void 0 && status !== entry.status ? {
						connection: entry.connection,
						status
					} : entry;
				});
				if (next.some((entry, index) => entry.status !== connEntries[index]?.status)) {
					connEntries = next;
					connNotify();
				}
			},
			/** WS status 单条增量。 */
			applyStatus: (connectionId, status) => {
				let changed = false;
				connEntries = connEntries.map((entry) => {
					if (entry.connection.id !== connectionId) return entry;
					if (entry.status === status) return entry;
					changed = true;
					return {
						connection: entry.connection,
						status
					};
				});
				if (changed) connNotify();
			},
			/** 持久化完成后本地即时可见（不等下次 refresh）。 */
			upsert: (connection) => {
				const index = connEntries.findIndex((entry) => entry.connection.id === connection.id);
				if (index >= 0) connEntries = connEntries.map((entry, i) => i === index ? {
					connection,
					status: entry.status
				} : entry);
				else connEntries = [...connEntries, {
					connection,
					status: { state: "unknown" }
				}];
				connNotify();
			},
			/** 删除连接后本地移除。 */
			removeLocal: (connectionId) => {
				connEntries = connEntries.filter((entry) => entry.connection.id !== connectionId);
				clearHintTimer(connectionId);
				const nextHints = { ...connHints };
				delete nextHints[connectionId];
				connHints = nextHints;
				connNotify();
			},
			/** 行内副标题提示文案（无提示则为 null；M3 WIN 注册结果用）。 */
			getHint: (connectionId) => connHints[connectionId] ?? null,
			/** 行内副标题短暂变文案（toast 式，4s 后自动消失，不引新组件）。 */
			setHint: (connectionId, text) => {
				clearHintTimer(connectionId);
				connHints = {
					...connHints,
					[connectionId]: text
				};
				connNotify();
				connHintTimers.set(connectionId, setTimeout(() => {
					connHintTimers.delete(connectionId);
					if (connHints[connectionId] === void 0) return;
					const nextHints = { ...connHints };
					delete nextHints[connectionId];
					connHints = nextHints;
					connNotify();
				}, 4e3));
			}
		};
		function initialDraft() {
			return {
				alias: null,
				host: "",
				port: "22",
				user: "",
				authMode: "password",
				password: "",
				identityFile: "",
				sshBinary: "",
				downloadMethod: "upload",
				runtimeUrl: ""
			};
		}
		let wizardState = createInitialState();
		let wizardVersion = 0;
		const wizardListeners = /* @__PURE__ */ new Set();
		/** 渲染器 owner 的关闭回调（remoteFlow 孔注入；向导 × 时通知撤回 open）。 */
		let ownerClose = null;
		/** 连接中日志订阅的退订函数（最小化不杀；向导关闭时释放）。 */
		let activeLogUnsub = null;
		function createInitialState() {
			return {
				visible: false,
				step: 1,
				kind: "ssh",
				env: null,
				envFailed: false,
				aliases: [],
				aliasesFailed: false,
				flowId: null,
				connecting: false,
				connected: false,
				failed: false,
				error: null,
				draft: initialDraft(),
				winDir: "",
				winShell: "powershell",
				directory: "",
				browseParent: null,
				entries: [],
				browseFailed: false,
				title: "",
				titleTouched: false,
				mkdirOpen: false,
				mkdirName: "",
				mkdirBusy: false,
				mkdirError: null,
				persisting: false,
				persistError: null
			};
		}
		function wizardNotify() {
			wizardVersion += 1;
			for (const listener of [...wizardListeners]) listener();
		}
		function patch(p) {
			wizardState = {
				...wizardState,
				...p
			};
			wizardNotify();
		}
		function errorMessage(e) {
			if (e instanceof ApiError) return e.message;
			if (e instanceof Error) return e.message;
			return String(e);
		}
		function newFlowId() {
			const c = globalThis.crypto;
			if (c !== void 0 && typeof c.randomUUID === "function") return `flow_${c.randomUUID()}`;
			return `flow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
		}
		/** 目录 basename（兼容 / 与 \ 分隔，Windows 风格路径）。 */
		function basenameOf(path, fallback) {
			const cleaned = path.replace(/[\\/]+$/, "");
			if (cleaned.length === 0) return fallback;
			const parts = cleaned.split(/[\\/]/);
			return parts[parts.length - 1] ?? fallback;
		}
		/** SSH 家目录猜测（P1 未在 connect 响应给 home；常见布局兜底，失败回退根目录）。 */
		function guessHomeDir(os, user) {
			if (user === "root") return "/root";
			if (os === "macos") return `/Users/${user || "unknown"}`;
			return `/home/${user || "unknown"}`;
		}
		function clampPort(raw) {
			const port = Number.parseInt(raw, 10);
			if (Number.isNaN(port) || port < 1 || port > 65535) return 22;
			return port;
		}
		/** 提交给服务端的 draft（G 节契约形状；密码仅内存传递，服务端即焚）。 */
		function buildConnectDraft() {
			if (wizardState.kind === "win") return {
				kind: "win",
				ssh: {
					host: "",
					port: 0,
					user: "",
					auth: { type: "password" }
				}
			};
			const d = wizardState.draft;
			return {
				kind: "ssh",
				ssh: {
					host: d.host.trim(),
					port: clampPort(d.port),
					user: d.user.trim(),
					auth: d.authMode === "password" ? {
						type: "password",
						password: d.password
					} : {
						type: "key",
						identityFile: d.identityFile.trim()
					},
					sshBinary: d.sshBinary.trim().length > 0 ? d.sshBinary.trim() : void 0,
					downloadMethod: d.downloadMethod,
					runtimeUrl: d.downloadMethod === "remote" && d.runtimeUrl.trim().length > 0 ? d.runtimeUrl.trim() : void 0
				}
			};
		}
		/** 向导重置（保留环境/别名缓存）：菜单再次打开或 × 关闭时。 */
		function resetFlow() {
			const env = wizardState.env;
			const envFailed = wizardState.envFailed;
			const aliases = wizardState.aliases;
			const aliasesFailed = wizardState.aliasesFailed;
			if (activeLogUnsub !== null) {
				activeLogUnsub();
				activeLogUnsub = null;
			}
			wizardState = {
				...createInitialState(),
				env,
				envFailed,
				aliases,
				aliasesFailed
			};
			wizardNotify();
		}
		async function loadEnvironment() {
			if (wizardState.env !== null || wizardState.envFailed) return;
			try {
				patch({
					env: await api.environment(),
					envFailed: false
				});
			} catch {
				patch({ envFailed: true });
			}
		}
		async function loadAliases() {
			if (wizardState.aliases.length > 0 || wizardState.aliasesFailed) return;
			try {
				const { items } = await api.aliases();
				patch({
					aliases: items,
					aliasesFailed: false
				});
			} catch {
				patch({ aliasesFailed: true });
			}
		}
		/** 目录浏览（向导期用 flowId；注册表期用 connectionId，仅供后续扩展）。 */
		async function browseInto(dir, flowId, connectionId) {
			patch({
				directory: dir,
				browseFailed: false,
				browseParent: null,
				entries: []
			});
			try {
				const input = connectionId !== void 0 ? {
					connectionId,
					dir
				} : {
					flowId: flowId ?? "",
					dir
				};
				const result = await api.browse(input);
				const next = {
					directory: result.dir,
					browseParent: result.parent ?? null,
					entries: result.entries,
					browseFailed: false
				};
				if (!wizardState.titleTouched) next.title = basenameOf(result.dir, "");
				patch(next);
			} catch (e) {
				patch({
					browseFailed: true,
					entries: []
				});
			}
		}
		/** 连接主流程（SSH 与 WIN 共用；长请求进度走 WS log channel=flowId）。 */
		async function runConnect() {
			const kind = wizardState.kind;
			const flowId = newFlowId();
			if (activeLogUnsub !== null) activeLogUnsub();
			activeLogUnsub = wsClient.subscribeLog(flowId);
			logsStore.clear(flowId);
			patch({
				flowId,
				connecting: true,
				failed: false,
				connected: false,
				error: null,
				persistError: null
			});
			try {
				const draft = buildConnectDraft();
				const { env } = await api.connect(draft, flowId);
				patch({
					connecting: false,
					connected: true
				});
				await browseInto(kind === "win" ? wizardState.winDir.trim() || "/mnt/c" : guessHomeDir(env.os, wizardState.draft.user.trim() || "unknown"), flowId);
				if (wizardState.browseFailed) await browseInto("/", flowId);
				patch({ step: kind === "ssh" ? 4 : 3 });
				if (!wizardState.visible) patch({ visible: true });
			} catch (e) {
				patch({
					connecting: false,
					failed: true,
					error: errorMessage(e)
				});
			}
		}
		const wizardStore = {
			subscribe: (listener) => {
				wizardListeners.add(listener);
				return () => {
					wizardListeners.delete(listener);
				};
			},
			getVersion: () => wizardVersion,
			getSnapshot: () => wizardState,
			getOwnerClose: () => ownerClose,
			/** RemoteFlowDriver 注册渲染器 owner 的撤销回调。 */
			setOwnerClose: (fn) => {
				ownerClose = fn;
			},
			/** 菜单「远程连接」触发：重置流程并显示向导（懒加载环境/别名）。 */
			open: () => {
				if (!wizardState.visible) resetFlow();
				patch({
					visible: true,
					step: 1
				});
				loadEnvironment();
				loadAliases();
			},
			/** 最小化（连接中步骤的 — 按钮 / owner 撤回 open）：隐藏但保留连接与订阅。 */
			minimize: () => {
				if (!wizardState.visible) return;
				patch({ visible: false });
			},
			/** 恢复向导（section 连接中临时行点击）。 */
			restore: () => {
				patch({ visible: true });
			},
			/** × 关闭：撤 owner open、释放日志订阅、重置流程。 */
			requestClose: () => {
				if (activeLogUnsub !== null) {
					activeLogUnsub();
					activeLogUnsub = null;
				}
				ownerClose?.();
				patch({ visible: false });
				resetFlow();
			},
			setKind: (kind) => {
				if (wizardState.kind === kind) return;
				patch({
					kind,
					step: 1
				});
			},
			next: () => {
				const s = wizardState.step;
				if (s === 1) patch({ step: 2 });
				else if (s === 2 && wizardState.kind === "win") runConnect();
				else if (s === 3 && wizardState.connected) patch({ step: 4 });
			},
			back: () => {
				const s = wizardState.step;
				if (s === 2) patch({ step: 1 });
				else if (s === 3) patch({ step: 2 });
				else if (s === 4) patch({ step: wizardState.kind === "ssh" ? 3 : 2 });
			},
			setDraft: (p) => {
				patch({ draft: {
					...wizardState.draft,
					...p
				} });
			},
			setWinDir: (winDir) => {
				patch({ winDir });
			},
			setWinShell: (winShell) => {
				patch({ winShell });
			},
			/** 别名选中：自动填充主机/端口/用户名/私钥路径/sshBinary。 */
			selectAlias: (name) => {
				const alias = wizardState.aliases.find((item) => item.name === name);
				const draft = {
					alias: alias?.name ?? null,
					host: alias?.host ?? "",
					port: alias !== void 0 ? String(alias.port) : "22",
					user: alias?.user ?? "",
					identityFile: alias?.identityFile ?? "",
					sshBinary: alias?.sshBinary ?? "",
					authMode: alias?.identityFile !== void 0 ? "key" : wizardState.draft.authMode
				};
				patch({ draft: {
					...wizardState.draft,
					...draft
				} });
			},
			/** SSH 表单提交：开始连接。 */
			startConnect: () => {
				runConnect();
			},
			/** Step3 失败态主按钮「重试」。 */
			retry: () => {
				runConnect();
			},
			browse: (dir) => {
				browseInto(dir, wizardState.flowId ?? void 0);
			},
			setTitle: (title) => {
				patch({
					title,
					titleTouched: title.length > 0
				});
			},
			openMkdir: () => {
				patch({
					mkdirOpen: true,
					mkdirName: "",
					mkdirError: null
				});
			},
			closeMkdir: () => {
				patch({
					mkdirOpen: false,
					mkdirError: null
				});
			},
			setMkdirName: (mkdirName) => {
				patch({ mkdirName });
			},
			/** 新建文件夹：browse 侧 mkdir（POST /api/browse {mkdir}），成功后刷新列表。 */
			confirmMkdir: async () => {
				const name = wizardState.mkdirName.trim();
				if (name.length === 0 || wizardState.flowId === null || wizardState.directory.length === 0) return;
				patch({
					mkdirBusy: true,
					mkdirError: null
				});
				try {
					await api.browse({
						flowId: wizardState.flowId,
						dir: wizardState.directory,
						mkdir: name
					});
					patch({
						mkdirOpen: false,
						mkdirName: ""
					});
					await browseInto(wizardState.directory, wizardState.flowId);
				} catch (e) {
					patch({ mkdirError: errorMessage(e) });
				} finally {
					patch({ mkdirBusy: false });
				}
			},
			/** 完成：持久化 → 注册远端工作区（失败仅 WARN）→ 本地 upsert → 关闭向导。 */
			complete: async () => {
				if (wizardState.persisting || wizardState.directory.length === 0) return;
				const fallbackTitle = basenameOf(wizardState.directory, wizardState.draft.user || "remote");
				const title = wizardState.title.trim() || fallbackTitle;
				patch({
					persisting: true,
					persistError: null
				});
				try {
					const { connection } = await api.persistConnection(buildConnectDraft(), title, wizardState.directory, wizardState.flowId);
					connectionsStore.upsert(connection);
					api.registerRemoteWorkspace(connection.id).then(() => connectionsStore.refresh()).catch((e) => {
						console.warn("[dsh-ssh] 注册远端工作区失败：", errorMessage(e));
					});
					wizardStore.requestClose();
				} catch (e) {
					patch({
						persisting: false,
						persistError: errorMessage(e)
					});
				}
			}
		};
		/** shell.overlay 条目绑定的可见性 HostObservable（hooks.visible）。 */
		const wizardVisible = {
			getSnapshot: () => wizardState.visible,
			subscribe: (listener) => {
				wizardListeners.add(listener);
				return () => {
					wizardListeners.delete(listener);
				};
			}
		};
		/** remoteFlow 孔绑定的占用 HostObservable（hooks.remoteFlow，SPEC C 节）。
		*  向导模块活着即为 true（菜单项可见）；插件卸载时注册消失、孔空 → H1 撤 open。 */
		const wizardOccupied = {
			getSnapshot: () => true,
			subscribe: () => () => {}
		};
		let logPopoverState = {
			open: false,
			anchorRect: null,
			channelKey: null
		};
		let logPopoverVersion = 0;
		const logPopoverListeners = /* @__PURE__ */ new Set();
		function logPopoverNotify() {
			logPopoverVersion += 1;
			for (const listener of [...logPopoverListeners]) listener();
		}
		const logPopoverStore = {
			subscribe: (listener) => {
				logPopoverListeners.add(listener);
				return () => {
					logPopoverListeners.delete(listener);
				};
			},
			getVersion: () => logPopoverVersion,
			getSnapshot: () => logPopoverState,
			/** 行菜单「查看日志」：at=点击处视口坐标（宽高为 0 的点锚）。 */
			open: (channelKey, at) => {
				logPopoverState = {
					open: true,
					channelKey,
					anchorRect: {
						left: at.x,
						top: at.y,
						width: 0,
						height: 0,
						right: at.x,
						bottom: at.y
					}
				};
				logPopoverNotify();
			},
			close: () => {
				if (!logPopoverState.open) return;
				logPopoverState = {
					open: false,
					anchorRect: null,
					channelKey: null
				};
				logPopoverNotify();
			}
		};
		/** shell.overlay 条目绑定的可见性 HostObservable（hooks.visible）。 */
		const logPopoverVisible = {
			getSnapshot: () => logPopoverState.open,
			subscribe: (listener) => {
				logPopoverListeners.add(listener);
				return () => {
					logPopoverListeners.delete(listener);
				};
			}
		};
		/** WS 帧 → store 桥（index.ts apply 内调用；生命周期归 ctx.effect）。 */
		function initWsBridge() {
			wsClient.setHandler((frame) => {
				if (frame.t === "status") {
					if ("items" in frame && frame.items !== void 0) connectionsStore.applyStatusSnapshot(frame.items);
					if ("connectionId" in frame && frame.connectionId !== void 0) connectionsStore.applyStatus(frame.connectionId, frame.status);
				} else if (frame.t === "log-snapshot") logsStore.snapshot(frame.key, frame.lines);
				else if (frame.t === "log") logsStore.append(frame.key, frame.line);
			});
			const unsubStatus = wsClient.subscribeStatus();
			wsClient.start();
			return () => {
				wsClient.setHandler(null);
				unsubStatus();
				wsClient.dispose();
			};
		}
		//#endregion
		//#region \0dsh-css-module:/home/lyy/workspace/DSH/Plugin/dsh-ssh/src/client/wizard/WizardRoot.module.css.mjs
		const css$1 = ".nZAU7q_backdrop{z-index:60;background:var(--dsw-alias-bg-mask-1);pointer-events:auto;place-items:center;padding:24px;display:grid;position:fixed;inset:0}.nZAU7q_wizard{box-sizing:border-box;border-radius:var(--dsh-round-side,14px);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);width:min(1100px,100vw - 48px);max-height:calc(100vh - 48px);box-shadow:var(--dsw-shadow-lv3,0 24px 64px #0000003d);display:flex;overflow:hidden}.nZAU7q_sidebar{box-sizing:border-box;border-right:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb, var(--dsw-alias-bg-layer-2) 40%, transparent);flex:none;width:208px;padding:22px 14px}.nZAU7q_stepperTitle{color:var(--dsw-alias-label-primary);margin:0 0 16px 10px;font-size:16px;font-weight:600;line-height:24px}.nZAU7q_steps{flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;display:flex}.nZAU7q_step{color:var(--dsw-alias-label-secondary);user-select:none;border-radius:8px;align-items:center;gap:10px;padding:8px 10px;display:flex}.nZAU7q_stepActive{background:var(--dsw-alias-interactive-bg-active,#7f7f7f24);color:var(--dsw-alias-label-primary)}.nZAU7q_stepDot{border:1px solid var(--dsw-alias-border-l2);width:22px;height:22px;color:var(--dsw-alias-label-tertiary);border-radius:50%;flex:none;place-items:center;font-size:11px;line-height:1;display:grid}.nZAU7q_stepDotActive{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted,#fff)}.nZAU7q_stepDotDone{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}.nZAU7q_checkIcon{display:block}.nZAU7q_stepLabel{font-size:13px;line-height:18px}.nZAU7q_content{flex-direction:column;flex:1;min-width:0;display:flex;position:relative}.nZAU7q_topbar{z-index:1;align-items:center;gap:4px;display:flex;position:absolute;top:10px;right:12px}.nZAU7q_topAction{width:28px;height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:7px;place-items:center;padding:0;font-size:15px;line-height:1;display:grid}.nZAU7q_topAction:hover{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f14);color:var(--dsw-alias-label-primary)}.nZAU7q_stepBody{box-sizing:border-box;flex-direction:column;flex:1;gap:16px;min-height:0;padding:52px 40px 20px;display:flex;overflow-y:auto}.nZAU7q_stepSubtitle{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;line-height:20px}.nZAU7q_methodGrid{grid-template-columns:1fr 1fr;gap:12px;display:grid}.nZAU7q_methodCard{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;border-radius:12px;flex-direction:column;align-items:flex-start;gap:3px;padding:16px;display:flex}.nZAU7q_methodCardSelected{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-2))}.nZAU7q_methodCardDisabled{opacity:.45;cursor:not-allowed}.nZAU7q_methodTile{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f14);width:40px;height:40px;color:var(--dsw-alias-label-secondary);border-radius:10px;place-items:center;margin-bottom:8px;display:grid}.nZAU7q_methodTileSelected{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted,#fff)}.nZAU7q_methodIcon{width:22px;height:22px}.nZAU7q_methodTitle{font-size:15px;font-weight:600;line-height:22px}.nZAU7q_methodSubtitle{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.nZAU7q_field{flex-direction:column;gap:6px;display:flex}.nZAU7q_fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}.nZAU7q_fieldRow{gap:12px;display:flex}.nZAU7q_fieldRow .nZAU7q_field{flex:1}.nZAU7q_fieldNarrow{flex:none;width:200px}.nZAU7q_input,.nZAU7q_field select.nZAU7q_input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);width:100%;height:34px;color:var(--dsw-alias-label-primary);border-radius:8px;outline:none;padding:0 10px;font-size:13px;line-height:20px}.nZAU7q_input:focus{border-color:var(--dsw-alias-brand-primary)}.nZAU7q_field select.nZAU7q_input{appearance:none;background-image:linear-gradient(45deg, transparent 50%, var(--dsw-alias-label-tertiary) 50%), linear-gradient(135deg, var(--dsw-alias-label-tertiary) 50%, transparent 50%);background-position:calc(100% - 16px) 14px,calc(100% - 11px) 14px;background-repeat:no-repeat;background-size:5px 5px;padding-right:26px}.nZAU7q_fieldHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}.nZAU7q_segmented{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:8px;gap:2px;height:34px;padding:2px;display:inline-flex}.nZAU7q_segment{color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:none;border-radius:6px;padding:0 12px;font-size:12px;line-height:28px}.nZAU7q_segmentActive,.nZAU7q_segment:hover{background:var(--dsw-alias-interactive-bg-active,#7f7f7f24);color:var(--dsw-alias-label-primary)}.nZAU7q_inlineError{color:var(--dsw-alias-state-error-primary);font-size:12px}.nZAU7q_stepFooter{justify-content:flex-end;align-items:center;gap:10px;margin-top:auto;padding-top:8px;display:flex}.nZAU7q_buttonPrimary,.nZAU7q_buttonGhost{cursor:pointer;white-space:nowrap;border-radius:8px;height:32px;padding:0 18px;font-size:13px;line-height:30px}.nZAU7q_buttonPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted,#fff);border:none}.nZAU7q_buttonPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill))}.nZAU7q_buttonPrimary:disabled,.nZAU7q_buttonGhost:disabled{opacity:.5;cursor:not-allowed}.nZAU7q_buttonGhost{border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}.nZAU7q_buttonGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#7f7f7f14);color:var(--dsw-alias-label-primary)}.nZAU7q_logPanel{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:12px;flex-direction:column;min-height:0;display:flex;overflow:hidden}.nZAU7q_logHeader{border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;justify-content:space-between;align-items:center;padding:8px 12px;display:flex}.nZAU7q_logTitle{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600}.nZAU7q_logSpinner{color:var(--dsw-alias-label-secondary);align-items:center;gap:6px;font-size:12px;display:flex}.nZAU7q_spinner{box-sizing:border-box;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;width:13px;height:13px;animation:.8s linear infinite nZAU7q_dshSshSpin}@keyframes nZAU7q_dshSshSpin{to{transform:rotate(360deg)}}.nZAU7q_logBody{box-sizing:border-box;min-height:240px;max-height:360px;font:var(--dsw-font-markdown-code,12px/1.6 monospace);padding:8px 12px;overflow-y:auto}.nZAU7q_logLine{white-space:pre-wrap;word-break:break-all;gap:8px;font-size:12px;line-height:20px;display:flex}.nZAU7q_logTs{color:var(--dsw-alias-label-tertiary);flex:none}.nZAU7q_logLevel{color:var(--dsw-alias-label-secondary);flex:none}.nZAU7q_logLevelError{color:var(--dsw-alias-state-error-primary)}.nZAU7q_logMsg{min-width:0;color:var(--dsw-alias-label-primary)}.nZAU7q_logEmpty{color:var(--dsw-alias-label-tertiary);padding:20px 12px;font-size:12px}.nZAU7q_logError{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger,#ec13130f);border-radius:8px;padding:8px 12px;font-size:12px;line-height:18px}.nZAU7q_directoryPanel{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:12px;flex-direction:column;min-height:260px;display:flex;overflow:hidden}.nZAU7q_directoryToolbar{border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;justify-content:space-between;align-items:center;gap:8px;padding:6px 8px;display:flex}.nZAU7q_crumbs{align-items:center;gap:2px;min-width:0;font-size:12px;display:flex;overflow-x:auto}.nZAU7q_crumb{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:5px;flex:none;padding:3px 6px;font-size:12px}.nZAU7q_crumb:hover{background:var(--dsw-alias-interactive-bg-hover,#7f7f7f14);color:var(--dsw-alias-label-primary)}.nZAU7q_crumb+.nZAU7q_crumb:before{content:\"/\";color:var(--dsw-alias-label-tertiary);margin-right:2px}.nZAU7q_mkdirRow{border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;align-items:center;gap:8px;padding:8px;display:flex}.nZAU7q_mkdirRow .nZAU7q_input{flex:1}.nZAU7q_entryList{flex:1;min-height:0;padding:4px;overflow-y:auto}.nZAU7q_entryRow{box-sizing:border-box;width:100%;color:var(--dsw-alias-label-primary);text-align:left;cursor:pointer;background:0 0;border:none;border-radius:6px;align-items:center;gap:8px;padding:5px 8px;font-size:13px;line-height:20px;display:flex}.nZAU7q_entryRowDir:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,#7f7f7f14)}.nZAU7q_entryRowMuted{color:var(--dsw-alias-label-tertiary);cursor:default}.nZAU7q_entryRowHidden{opacity:.55;cursor:default}.nZAU7q_entryName{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}";
		const tagId$1 = "dsh-ssh/WizardRoot.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$1) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-ssh";
			tag.dataset.pluginCss = tagId$1;
			tag.textContent = css$1;
			document.head.appendChild(tag);
		}
		var WizardRoot_module_css_default = {
			"logLine": "nZAU7q_logLine",
			"entryName": "nZAU7q_entryName",
			"methodTileSelected": "nZAU7q_methodTileSelected",
			"entryList": "nZAU7q_entryList",
			"stepDotActive": "nZAU7q_stepDotActive",
			"methodTitle": "nZAU7q_methodTitle",
			"stepFooter": "nZAU7q_stepFooter",
			"stepperTitle": "nZAU7q_stepperTitle",
			"stepActive": "nZAU7q_stepActive",
			"methodCard": "nZAU7q_methodCard",
			"buttonGhost": "nZAU7q_buttonGhost",
			"segmented": "nZAU7q_segmented",
			"logHeader": "nZAU7q_logHeader",
			"logBody": "nZAU7q_logBody",
			"fieldLabel": "nZAU7q_fieldLabel",
			"entryRow": "nZAU7q_entryRow",
			"buttonPrimary": "nZAU7q_buttonPrimary",
			"checkIcon": "nZAU7q_checkIcon",
			"methodCardDisabled": "nZAU7q_methodCardDisabled",
			"directoryToolbar": "nZAU7q_directoryToolbar",
			"mkdirRow": "nZAU7q_mkdirRow",
			"topAction": "nZAU7q_topAction",
			"field": "nZAU7q_field",
			"backdrop": "nZAU7q_backdrop",
			"directoryPanel": "nZAU7q_directoryPanel",
			"methodCardSelected": "nZAU7q_methodCardSelected",
			"fieldNarrow": "nZAU7q_fieldNarrow",
			"logEmpty": "nZAU7q_logEmpty",
			"logMsg": "nZAU7q_logMsg",
			"logSpinner": "nZAU7q_logSpinner",
			"stepDotDone": "nZAU7q_stepDotDone",
			"step": "nZAU7q_step",
			"steps": "nZAU7q_steps",
			"logLevelError": "nZAU7q_logLevelError",
			"logLevel": "nZAU7q_logLevel",
			"content": "nZAU7q_content",
			"methodTile": "nZAU7q_methodTile",
			"logTs": "nZAU7q_logTs",
			"fieldRow": "nZAU7q_fieldRow",
			"stepLabel": "nZAU7q_stepLabel",
			"dshSshSpin": "nZAU7q_dshSshSpin",
			"topbar": "nZAU7q_topbar",
			"input": "nZAU7q_input",
			"entryRowHidden": "nZAU7q_entryRowHidden",
			"sidebar": "nZAU7q_sidebar",
			"logError": "nZAU7q_logError",
			"crumbs": "nZAU7q_crumbs",
			"stepDot": "nZAU7q_stepDot",
			"stepBody": "nZAU7q_stepBody",
			"methodIcon": "nZAU7q_methodIcon",
			"fieldHint": "nZAU7q_fieldHint",
			"segmentActive": "nZAU7q_segmentActive",
			"crumb": "nZAU7q_crumb",
			"spinner": "nZAU7q_spinner",
			"wizard": "nZAU7q_wizard",
			"segment": "nZAU7q_segment",
			"stepSubtitle": "nZAU7q_stepSubtitle",
			"logPanel": "nZAU7q_logPanel",
			"logTitle": "nZAU7q_logTitle",
			"entryRowDir": "nZAU7q_entryRowDir",
			"entryRowMuted": "nZAU7q_entryRowMuted",
			"methodGrid": "nZAU7q_methodGrid",
			"methodSubtitle": "nZAU7q_methodSubtitle",
			"inlineError": "nZAU7q_inlineError"
		};
		//#endregion
		//#region src/client/wizard/Stepper.ts
		/**
		* Stepper —— 向导左侧步骤条（SPEC J）。
		*
		* 标题「远程连接」；步骤：当前=实心圆+行高亮、完成=绿勾、未到=灰圆。
		* WIN 分支三步（spec J：选择方式/填写配置/选择目录）。
		*/
		/** 完成态的绿勾（内联 SVG，stroke 取 success 语义令牌）。 */
		function CheckIcon() {
			return (0, react.createElement)("svg", {
				className: WizardRoot_module_css_default.checkIcon,
				viewBox: "0 0 12 12",
				width: 12,
				height: 12,
				fill: "none",
				"aria-hidden": true
			}, (0, react.createElement)("path", {
				d: "M2.5 6.2 5 8.7l4.5-5.4",
				stroke: "currentColor",
				strokeWidth: 1.8,
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}));
		}
		function Stepper({ steps, current }) {
			return (0, react.createElement)("div", { className: WizardRoot_module_css_default.stepper }, (0, react.createElement)("div", { className: WizardRoot_module_css_default.stepperTitle }, "远程连接"), (0, react.createElement)("ol", { className: WizardRoot_module_css_default.steps }, steps.map((label, index) => {
				const ordinal = index + 1;
				const done = ordinal < current;
				const active = ordinal === current;
				return (0, react.createElement)("li", {
					key: label,
					className: `${WizardRoot_module_css_default.step} ${active ? WizardRoot_module_css_default.stepActive : ""}`,
					"aria-current": active ? "step" : void 0
				}, (0, react.createElement)("span", { className: `${WizardRoot_module_css_default.stepDot} ${done ? WizardRoot_module_css_default.stepDotDone : ""} ${active ? WizardRoot_module_css_default.stepDotActive : ""}` }, done ? (0, react.createElement)(CheckIcon) : String(ordinal)), (0, react.createElement)("span", { className: WizardRoot_module_css_default.stepLabel }, label));
			})));
		}
		//#endregion
		//#region src/client/wizard/StepMethod.ts
		/**
		* StepMethod —— 向导第 1 步「选择连接方式」（SPEC J 文案逐字）。
		*
		* 2×2 卡片：SSH/远程主机、WIN/本机 Windows、WSL/Windows Linux 子系统、Docker/本地容器。
		* 选中=整卡提亮+图标瓦片反白；禁用卡灰化 + tooltip 原因。
		* 禁用依据 environment API：WSL（canWsl=false 或 kind==='wsl' → 当前已在 WSL 中运行）、
		* WIN（canWin=false → 仅当 DSH 运行在 WSL 时可用）、Docker（恒禁用 → 即将推出）。
		*/
		function StepMethod() {
			const state = wizardStore.getSnapshot();
			const env = state.env;
			const canWsl = env !== null && env.canWsl && env.kind !== "wsl";
			const cards = [
				{
					key: "ssh",
					title: "SSH",
					subtitle: "远程主机",
					disabled: false
				},
				{
					key: "win",
					title: "WIN",
					subtitle: "本机 Windows",
					disabled: !(env !== null && env.canWin),
					tooltip: "仅当 DSH 运行在 WSL 时可用"
				},
				{
					key: "wsl",
					title: "WSL",
					subtitle: "Windows Linux 子系统",
					disabled: !canWsl,
					tooltip: "当前已在 WSL 中运行"
				},
				{
					key: "docker",
					title: "Docker",
					subtitle: "本地容器",
					disabled: true,
					tooltip: "即将推出"
				}
			];
			const select = (key) => {
				if (key === "ssh" || key === "win") wizardStore.setKind(key);
			};
			return (0, react.createElement)("div", { className: WizardRoot_module_css_default.stepBody }, (0, react.createElement)("p", { className: WizardRoot_module_css_default.stepSubtitle }, "选择进入当前工作区的连接方式，然后继续填写对应的连接配置。"), (0, react.createElement)("div", { className: WizardRoot_module_css_default.methodGrid }, cards.map((card) => {
				const selected = state.kind === card.key;
				return (0, react.createElement)("button", {
					type: "button",
					key: card.key,
					className: `${WizardRoot_module_css_default.methodCard} ${selected ? WizardRoot_module_css_default.methodCardSelected : ""} ${card.disabled ? WizardRoot_module_css_default.methodCardDisabled : ""}`,
					disabled: card.disabled,
					title: card.disabled ? card.tooltip : void 0,
					"aria-pressed": selected,
					onClick: () => select(card.key)
				}, (0, react.createElement)("span", { className: `${WizardRoot_module_css_default.methodTile} ${selected ? WizardRoot_module_css_default.methodTileSelected : ""}` }, (0, react.createElement)(MethodIcon, { kind: card.key })), (0, react.createElement)("span", { className: WizardRoot_module_css_default.methodTitle }, card.title), (0, react.createElement)("span", { className: WizardRoot_module_css_default.methodSubtitle }, card.subtitle));
			})), (0, react.createElement)("div", { className: WizardRoot_module_css_default.stepFooter }, (0, react.createElement)("button", {
				type: "button",
				className: WizardRoot_module_css_default.buttonGhost,
				onClick: () => wizardStore.requestClose()
			}, "取消"), (0, react.createElement)("button", {
				type: "button",
				className: WizardRoot_module_css_default.buttonPrimary,
				onClick: () => wizardStore.next()
			}, "下一步 ›")));
		}
		function MethodIcon({ kind }) {
			const common = {
				width: 22,
				height: 22,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": true
			};
			const paths = (() => {
				switch (kind) {
					case "ssh": return [(0, react.createElement)("path", {
						key: "cloud",
						d: "M4.2 12.5a3.2 3.2 0 1 1 .6-6.36 4.4 4.4 0 1 1 8.14 1.86A3.5 3.5 0 0 1 12 12.5Z",
						stroke: "currentColor",
						strokeWidth: 1.4,
						strokeLinejoin: "round"
					})];
					case "win": return [(0, react.createElement)("path", {
						key: "w",
						d: "M2.5 3.5h11v9h-11Z",
						stroke: "currentColor",
						strokeWidth: 1.4
					}), (0, react.createElement)("path", {
						key: "t",
						d: "M2.5 6h11",
						stroke: "currentColor",
						strokeWidth: 1.4
					})];
					case "wsl": return [(0, react.createElement)("path", {
						key: "p",
						d: "M2.5 5 6 8l-3.5 3",
						stroke: "currentColor",
						strokeWidth: 1.4,
						strokeLinecap: "round",
						strokeLinejoin: "round"
					}), (0, react.createElement)("path", {
						key: "c",
						d: "M7.5 11h6",
						stroke: "currentColor",
						strokeWidth: 1.4,
						strokeLinecap: "round"
					})];
					case "docker": return [(0, react.createElement)("path", {
						key: "d",
						d: "M3 4.5h10v7H3Z",
						stroke: "currentColor",
						strokeWidth: 1.4,
						strokeLinejoin: "round"
					}), (0, react.createElement)("path", {
						key: "m",
						d: "M3 8h10",
						stroke: "currentColor",
						strokeWidth: 1.4
					})];
				}
			})();
			return (0, react.createElement)("svg", {
				className: WizardRoot_module_css_default.methodIcon,
				...common
			}, ...paths);
		}
		//#endregion
		//#region src/client/wizard/StepConfig.ts
		/**
		* StepConfig —— 向导第 2 步「填写连接配置」（SPEC J 文案逐字冻结）。
		*
		* SSH 分支：别名下拉（自动填充）+ 主机/端口 + 用户名/认证方式 segmented
		* （密码|私钥）+ 密码/私钥路径 + 资源下载方式 segmented + 说明文案；
		* 「开始连接」在主机+用户名+凭证齐备时可用。
		* WIN 分支：Windows 目录输入 + 终端 shell segmented（PowerShell|cmd），
		* 提交即 connect（无连接中步骤，成功直接进选择目录）。
		*/
		function Segmented({ value, options, onChange }) {
			return (0, react.createElement)("div", {
				className: WizardRoot_module_css_default.segmented,
				role: "radiogroup"
			}, options.map((option) => (0, react.createElement)("button", {
				type: "button",
				key: option.value,
				className: `${WizardRoot_module_css_default.segment} ${value === option.value ? WizardRoot_module_css_default.segmentActive : ""}`,
				role: "radio",
				"aria-checked": value === option.value,
				onClick: () => onChange(option.value)
			}, option.label)));
		}
		const DOWNLOAD_OPTIONS = [{
			value: "upload",
			label: "本地下载后上传"
		}, {
			value: "remote",
			label: "远端服务器下载"
		}];
		const SHELL_OPTIONS = [{
			value: "powershell",
			label: "PowerShell"
		}, {
			value: "cmd",
			label: "cmd"
		}];
		function StepConfig() {
			const state = wizardStore.getSnapshot();
			const { kind, draft, winDir, winShell } = state;
			if (kind === "win") return renderWin();
			const credsReady = draft.authMode === "password" ? draft.password.length > 0 : draft.identityFile.trim().length > 0;
			const canStart = draft.host.trim().length > 0 && draft.user.trim().length > 0 && credsReady && (draft.downloadMethod !== "remote" || draft.runtimeUrl.trim().length > 0);
			const connected = state.connected;
			return (0, react.createElement)("div", { className: WizardRoot_module_css_default.stepBody }, (0, react.createElement)("p", { className: WizardRoot_module_css_default.stepSubtitle }, "填写建立 SSH 连接所需的信息，我们会据此准备远程会话。"), (0, react.createElement)("label", { className: WizardRoot_module_css_default.field }, (0, react.createElement)("span", { className: WizardRoot_module_css_default.fieldLabel }, "SSH 配置别名（可选）"), (0, react.createElement)("select", {
				className: WizardRoot_module_css_default.input,
				value: draft.alias ?? "",
				onChange: (event) => wizardStore.selectAlias(event.target.value)
			}, (0, react.createElement)("option", {
				key: "",
				value: ""
			}, "不使用别名"), ...state.aliases.map((alias) => (0, react.createElement)("option", {
				key: alias.name,
				value: alias.name
			}, alias.name))), (0, react.createElement)("span", { className: WizardRoot_module_css_default.fieldHint }, "选择别名后会自动填充主机、端口、用户名和私钥路径。")), (0, react.createElement)("div", { className: WizardRoot_module_css_default.fieldRow }, (0, react.createElement)("label", { className: WizardRoot_module_css_default.field }, (0, react.createElement)("span", { className: WizardRoot_module_css_default.fieldLabel }, "主机"), (0, react.createElement)("input", {
				className: WizardRoot_module_css_default.input,
				type: "text",
				value: draft.host,
				placeholder: "输入主机地址或 IP，例如 192.168.1.100",
				spellCheck: false,
				onChange: (event) => wizardStore.setDraft({ host: event.target.value })
			})), (0, react.createElement)("label", { className: `${WizardRoot_module_css_default.field} ${WizardRoot_module_css_default.fieldNarrow}` }, (0, react.createElement)("span", { className: WizardRoot_module_css_default.fieldLabel }, "端口"), (0, react.createElement)("input", {
				className: WizardRoot_module_css_default.input,
				type: "text",
				inputMode: "numeric",
				value: draft.port,
				placeholder: "22",
				onChange: (event) => wizardStore.setDraft({ port: event.target.value })
			}))), (0, react.createElement)("div", { className: WizardRoot_module_css_default.fieldRow }, (0, react.createElement)("label", { className: WizardRoot_module_css_default.field }, (0, react.createElement)("span", { className: WizardRoot_module_css_default.fieldLabel }, "用户名"), (0, react.createElement)("input", {
				className: WizardRoot_module_css_default.input,
				type: "text",
				value: draft.user,
				placeholder: "输入用户名，例如 root",
				spellCheck: false,
				onChange: (event) => wizardStore.setDraft({ user: event.target.value })
			})), (0, react.createElement)("label", { className: `${WizardRoot_module_css_default.field} ${WizardRoot_module_css_default.fieldNarrow}` }, (0, react.createElement)("span", { className: WizardRoot_module_css_default.fieldLabel }, "认证方式"), (0, react.createElement)(Segmented, {
				value: draft.authMode,
				options: [{
					value: "password",
					label: "密码"
				}, {
					value: "key",
					label: "私钥"
				}],
				onChange: (authMode) => wizardStore.setDraft({ authMode })
			}))), draft.authMode === "password" ? renderField("密码", (0, react.createElement)("input", {
				className: WizardRoot_module_css_default.input,
				type: "password",
				value: draft.password,
				placeholder: "输入 SSH 密码",
				autoComplete: "off",
				onChange: (event) => wizardStore.setDraft({ password: event.target.value })
			})) : renderField("私钥路径", (0, react.createElement)("input", {
				className: WizardRoot_module_css_default.input,
				type: "text",
				value: draft.identityFile,
				placeholder: "例如 ~/.ssh/id_ed25519",
				spellCheck: false,
				onChange: (event) => wizardStore.setDraft({ identityFile: event.target.value })
			})), (0, react.createElement)("label", { className: WizardRoot_module_css_default.field }, (0, react.createElement)("span", { className: WizardRoot_module_css_default.fieldLabel }, "资源下载方式"), (0, react.createElement)(Segmented, {
				value: draft.downloadMethod,
				options: DOWNLOAD_OPTIONS,
				onChange: (downloadMethod) => wizardStore.setDraft({ downloadMethod })
			}), (0, react.createElement)("span", { className: WizardRoot_module_css_default.fieldHint }, "远端服务器下载可减少上传等待，但服务器需要能访问下载源，并具备下载、解压和校验工具。")), draft.downloadMethod === "remote" ? renderField("下载源地址", (0, react.createElement)("input", {
				className: WizardRoot_module_css_default.input,
				type: "text",
				value: draft.runtimeUrl,
				placeholder: "https://…/dsh-remote-<版本>-linux-x64.with-node.tar.gz",
				spellCheck: false,
				onChange: (event) => wizardStore.setDraft({ runtimeUrl: event.target.value })
			}), "远端主机将用 curl/wget 从此地址拉取运行时包；请确保远端网络可达且具备 tar 与 sha256sum。") : null, (0, react.createElement)("div", { className: WizardRoot_module_css_default.stepFooter }, (0, react.createElement)("button", {
				type: "button",
				className: WizardRoot_module_css_default.buttonGhost,
				onClick: () => wizardStore.back()
			}, "‹ 上一步"), (0, react.createElement)("button", {
				type: "button",
				className: WizardRoot_module_css_default.buttonPrimary,
				disabled: !canStart || connected,
				title: connected ? "连接已完成" : void 0,
				onClick: () => wizardStore.startConnect()
			}, "开始连接")));
			function renderWin() {
				const canNext = winDir.trim().length > 0 && !state.connecting;
				return (0, react.createElement)("div", { className: WizardRoot_module_css_default.stepBody }, (0, react.createElement)("p", { className: WizardRoot_module_css_default.stepSubtitle }, "填写建立 SSH 连接所需的信息，我们会据此准备远程会话。"), renderField("Windows 目录", (0, react.createElement)("input", {
					className: WizardRoot_module_css_default.input,
					type: "text",
					value: winDir,
					placeholder: "例如 E:\\PWN 或 /mnt/e/PWN",
					spellCheck: false,
					onChange: (event) => wizardStore.setWinDir(event.target.value)
				})), renderField("终端 shell", (0, react.createElement)(Segmented, {
					value: winShell,
					options: SHELL_OPTIONS,
					onChange: (winShell) => wizardStore.setWinShell(winShell)
				})), state.connecting ? (0, react.createElement)("div", { className: WizardRoot_module_css_default.inlineError }, "正在连接…") : null, (0, react.createElement)("div", { className: WizardRoot_module_css_default.stepFooter }, (0, react.createElement)("button", {
					type: "button",
					className: WizardRoot_module_css_default.buttonGhost,
					onClick: () => wizardStore.back()
				}, "‹ 上一步"), (0, react.createElement)("button", {
					type: "button",
					className: WizardRoot_module_css_default.buttonPrimary,
					disabled: !canNext,
					onClick: () => wizardStore.next()
				}, "下一步 ›")));
			}
			function renderField(label, control, hint) {
				return (0, react.createElement)("label", { className: WizardRoot_module_css_default.field }, (0, react.createElement)("span", { className: WizardRoot_module_css_default.fieldLabel }, label), control, hint !== void 0 ? (0, react.createElement)("span", { className: WizardRoot_module_css_default.fieldHint }, hint) : null);
			}
		}
		//#endregion
		//#region src/client/wizard/StepConnecting.ts
		/**
		* StepConnecting —— 向导第 3 步「正在建立连接」（SPEC J 文案逐字，仅 SSH 分支）。
		*
		* 日志面板：标题栏「连接日志」+ 右侧 spinner「正在连接…」；日志行格式
		* `HH:mm:ss [LEVEL] msg`，等宽字体（--dsw-font-markdown-code），时间戳暗、
		* 级别灰、ERROR 红。上一步禁用；连接中主按钮禁用「正在连接…」；失败变
		* 「重试」；成功自动进 Step4（留在本步时主按钮变「下一步 ›」）。
		* 日志订阅与 section 浮层同 key（flowId），最小化不杀 pipeline。
		*/
		function StepConnecting() {
			const state = wizardStore.getSnapshot();
			const flowId = state.flowId;
			const lines = flowId !== null ? logsStore.getLogs(flowId) : [];
			const listRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const el = listRef.current;
				if (el !== null) el.scrollTop = el.scrollHeight;
			}, [lines.length]);
			const renderButtons = () => {
				const primary = state.connecting ? (0, react.createElement)("button", {
					type: "button",
					className: WizardRoot_module_css_default.buttonPrimary,
					disabled: true
				}, "正在连接…") : state.failed ? (0, react.createElement)("button", {
					type: "button",
					className: WizardRoot_module_css_default.buttonPrimary,
					onClick: () => wizardStore.retry()
				}, "重试") : (0, react.createElement)("button", {
					type: "button",
					className: WizardRoot_module_css_default.buttonPrimary,
					onClick: () => wizardStore.next()
				}, "下一步 ›");
				return (0, react.createElement)("div", { className: WizardRoot_module_css_default.stepFooter }, (0, react.createElement)("button", {
					type: "button",
					className: WizardRoot_module_css_default.buttonGhost,
					disabled: true
				}, "‹ 上一步"), primary);
			};
			return (0, react.createElement)("div", { className: WizardRoot_module_css_default.stepBody }, (0, react.createElement)("p", { className: WizardRoot_module_css_default.stepSubtitle }, "正在建立 SSH 连接，你可以在这里查看实时的连接进度。"), (0, react.createElement)("div", { className: WizardRoot_module_css_default.logPanel }, (0, react.createElement)("div", { className: WizardRoot_module_css_default.logHeader }, (0, react.createElement)("span", { className: WizardRoot_module_css_default.logTitle }, "连接日志"), state.connecting ? (0, react.createElement)("span", { className: WizardRoot_module_css_default.logSpinner }, (0, react.createElement)("span", { className: WizardRoot_module_css_default.spinner }), "正在连接…") : null), (0, react.createElement)("div", {
				className: WizardRoot_module_css_default.logBody,
				ref: listRef
			}, lines.length === 0 ? (0, react.createElement)("div", { className: WizardRoot_module_css_default.logEmpty }, "等待连接日志…") : lines.map((line, index) => (0, react.createElement)("div", {
				key: `${line.ts}-${index}`,
				className: WizardRoot_module_css_default.logLine
			}, (0, react.createElement)("span", { className: WizardRoot_module_css_default.logTs }, line.ts), (0, react.createElement)("span", { className: `${WizardRoot_module_css_default.logLevel} ${line.level === "ERROR" ? WizardRoot_module_css_default.logLevelError : ""}` }, `[${line.level}]`), (0, react.createElement)("span", { className: WizardRoot_module_css_default.logMsg }, line.msg))))), state.failed && state.error !== null ? (0, react.createElement)("div", { className: WizardRoot_module_css_default.logError }, state.error) : null, renderButtons());
		}
		//#endregion
		//#region src/client/wizard/StepDirectory.ts
		/**
		* StepDirectory —— 向导第 4 步「选择目录」（SPEC J 文案逐字）。
		*
		* 面包屑 + 目录列表（仅 dir 可进入，file/link 灰显，点开头隐藏条目灰显
		* 折叠）；「新建文件夹」弹输入名 → browse 侧 mkdir（POST /api/browse{mkdir}）；
		* 标题输入默认 = 当前目录 basename（用户编辑后不自动跟随）。
		* SSH 为第 4 步、WIN 为第 3 步（spec J：WIN 无连接中步骤）。
		*/
		function joinPath(parent, name) {
			if (parent === "/" || parent.length === 0) return `/${name}`;
			return `${parent}/${name}`;
		}
		/** 面包屑：锚定根，逐段可点击。 */
		function crumbs(path) {
			if (path.length === 0) return [];
			const parts = path.split("/").filter((part) => part.length > 0);
			const items = [{
				label: "/",
				path: "/"
			}];
			let acc = "";
			for (const part of parts) {
				acc += `/${part}`;
				items.push({
					label: part,
					path: acc
				});
			}
			return items;
		}
		function EntryIcon({ type, hidden }) {
			const common = {
				width: 14,
				height: 14,
				viewBox: "0 0 16 16",
				fill: "none",
				"aria-hidden": true
			};
			const paths = (() => {
				switch (type) {
					case "dir": return [(0, react.createElement)("path", {
						key: "d",
						d: "M2 4.5h4.2l1.3 1.5H14v7H2Z",
						stroke: hidden ? "var(--dsw-alias-label-tertiary)" : "currentColor",
						strokeWidth: 1.3,
						strokeLinejoin: "round"
					})];
					case "file": return [(0, react.createElement)("path", {
						key: "f",
						d: "M4 2.5h5l3 3v8H4Z",
						stroke: "currentColor",
						strokeWidth: 1.3,
						strokeLinejoin: "round"
					})];
					case "link": return [(0, react.createElement)("path", {
						key: "l",
						d: "M6.2 9.8a3 3 0 0 1 0-4.2l1.6-1.6a3 3 0 0 1 4.2 4.2l-1 1",
						stroke: "currentColor",
						strokeWidth: 1.3,
						strokeLinecap: "round"
					}), (0, react.createElement)("path", {
						key: "l2",
						d: "M9.8 6.2a3 3 0 0 1 0 4.2L8.2 12a3 3 0 0 1-4.2-4.2l1-1",
						stroke: "currentColor",
						strokeWidth: 1.3,
						strokeLinecap: "round"
					})];
				}
			})();
			return (0, react.createElement)("svg", { ...common }, ...paths);
		}
		function StepDirectory() {
			const state = wizardStore.getSnapshot();
			const onEnter = (name) => {
				wizardStore.browse(joinPath(state.directory, name));
			};
			return (0, react.createElement)("div", { className: WizardRoot_module_css_default.stepBody }, (0, react.createElement)("p", { className: WizardRoot_module_css_default.stepSubtitle }, "选择远端主机上作为工作区打开的目录。"), (0, react.createElement)("div", { className: WizardRoot_module_css_default.directoryPanel }, (0, react.createElement)("div", { className: WizardRoot_module_css_default.directoryToolbar }, (0, react.createElement)("nav", {
				className: WizardRoot_module_css_default.crumbs,
				"aria-label": "当前目录"
			}, crumbs(state.directory).map((crumb, index) => (0, react.createElement)("button", {
				type: "button",
				key: `${crumb.path}-${index}`,
				className: WizardRoot_module_css_default.crumb,
				onClick: () => wizardStore.browse(crumb.path)
			}, crumb.label))), (0, react.createElement)("button", {
				type: "button",
				className: WizardRoot_module_css_default.buttonGhost,
				disabled: state.mkdirOpen || state.directory.length === 0,
				onClick: () => wizardStore.openMkdir()
			}, "新建文件夹")), state.mkdirOpen ? (0, react.createElement)("div", { className: WizardRoot_module_css_default.mkdirRow }, (0, react.createElement)("input", {
				className: WizardRoot_module_css_default.input,
				type: "text",
				value: state.mkdirName,
				placeholder: "文件夹名称",
				autoFocus: true,
				onChange: (event) => wizardStore.setMkdirName(event.target.value)
			}), (0, react.createElement)("button", {
				type: "button",
				className: WizardRoot_module_css_default.buttonPrimary,
				disabled: state.mkdirName.trim().length === 0 || state.mkdirBusy,
				onClick: () => void wizardStore.confirmMkdir()
			}, "创建"), (0, react.createElement)("button", {
				type: "button",
				className: WizardRoot_module_css_default.buttonGhost,
				disabled: state.mkdirBusy,
				onClick: () => wizardStore.closeMkdir()
			}, "取消")) : null, state.mkdirError !== null ? (0, react.createElement)("div", { className: WizardRoot_module_css_default.logError }, state.mkdirError) : null, state.browseFailed ? (0, react.createElement)("div", { className: WizardRoot_module_css_default.logEmpty }, "目录不可读，请通过面包屑尝试其它目录。") : state.entries.length === 0 && state.directory.length > 0 ? (0, react.createElement)("div", { className: WizardRoot_module_css_default.logEmpty }, "目录为空") : (0, react.createElement)("div", { className: WizardRoot_module_css_default.entryList }, state.entries.map((entry) => {
				const hidden = entry.name.startsWith(".");
				const clickable = entry.type === "dir" && !hidden;
				return (0, react.createElement)("button", {
					type: "button",
					key: entry.name,
					className: `${WizardRoot_module_css_default.entryRow} ${clickable ? WizardRoot_module_css_default.entryRowDir : WizardRoot_module_css_default.entryRowMuted} ${hidden ? WizardRoot_module_css_default.entryRowHidden : ""}`,
					disabled: !clickable,
					title: clickable ? `进入 ${entry.name}` : void 0,
					onClick: () => onEnter(entry.name)
				}, (0, react.createElement)(EntryIcon, {
					type: entry.type,
					hidden
				}), (0, react.createElement)("span", { className: WizardRoot_module_css_default.entryName }, entry.name));
			}))), (0, react.createElement)("label", { className: WizardRoot_module_css_default.field }, (0, react.createElement)("span", { className: WizardRoot_module_css_default.fieldLabel }, "标题"), (0, react.createElement)("input", {
				className: WizardRoot_module_css_default.input,
				type: "text",
				value: state.title,
				placeholder: "默认使用目录名",
				spellCheck: false,
				onChange: (event) => wizardStore.setTitle(event.target.value)
			})), state.persistError !== null ? (0, react.createElement)("div", { className: WizardRoot_module_css_default.logError }, state.persistError) : null, (0, react.createElement)("div", { className: WizardRoot_module_css_default.stepFooter }, (0, react.createElement)("button", {
				type: "button",
				className: WizardRoot_module_css_default.buttonGhost,
				disabled: state.persisting,
				onClick: () => wizardStore.back()
			}, "‹ 上一步"), (0, react.createElement)("button", {
				type: "button",
				className: WizardRoot_module_css_default.buttonPrimary,
				disabled: state.persisting || state.directory.length === 0,
				onClick: () => void wizardStore.complete()
			}, state.persisting ? "保存中…" : "完成")));
		}
		//#endregion
		//#region src/client/wizard/WizardRoot.ts
		/**
		* WizardRoot —— shell.overlay 条目：远程连接向导 modal（SPEC J）。
		*
		* 居中 ~1100px、圆角 var(--dsh-round-side)、背景/边框全 --dsw-alias-* 令牌；
		* 左步骤条（标题「远程连接」）+ 右内容区（右上 ×；连接中步骤加 — 最小化）。
		* 可见性走 visible-store 模式（hooks.visible 绑定 wizardVisible，隐藏渲染 null）。
		* 最小化只隐藏 modal：连接 pipeline 与 WS 日志订阅保留，成功自动弹回选目录。
		* Esc 关闭（连接中时等价最小化）。
		*/
		/** SSH 四步 / WIN 三步（spec J）。 */
		const STEPS_SSH = [
			"选择方式",
			"填写配置",
			"连接中",
			"选择目录"
		];
		const STEPS_WIN = [
			"选择方式",
			"填写配置",
			"选择目录"
		];
		function WizardRoot({ useVisible, onClose }) {
			const visible = useVisible((value) => value);
			(0, react.useSyncExternalStore)(wizardStore.subscribe, wizardStore.getVersion);
			(0, react.useEffect)(() => {
				if (!visible) return;
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					event.preventDefault();
					if (wizardStore.getSnapshot().connecting) wizardStore.minimize();
					else wizardStore.requestClose();
				};
				window.addEventListener("keydown", onKeyDown);
				return () => window.removeEventListener("keydown", onKeyDown);
			}, [visible]);
			if (!visible) return null;
			const state = wizardStore.getSnapshot();
			const steps = state.kind === "win" ? STEPS_WIN : STEPS_SSH;
			const stepOrdinal = state.kind === "win" ? state.step >= 3 ? 3 : state.step : state.step;
			const stepContent = (() => {
				switch (state.step) {
					case 1: return (0, react.createElement)(StepMethod, { key: "step1" });
					case 2: return (0, react.createElement)(StepConfig, { key: "step2" });
					case 3: return state.kind === "win" ? (0, react.createElement)(StepDirectory, { key: "step-dir-win" }) : (0, react.createElement)(StepConnecting, { key: "step3" });
					case 4: return (0, react.createElement)(StepDirectory, { key: "step4" });
				}
			})();
			return (0, react.createElement)("div", {
				className: WizardRoot_module_css_default.backdrop,
				role: "presentation"
			}, (0, react.createElement)("div", {
				className: WizardRoot_module_css_default.wizard,
				role: "dialog",
				"aria-label": "远程连接",
				"aria-modal": true
			}, (0, react.createElement)("div", { className: WizardRoot_module_css_default.sidebar }, (0, react.createElement)(Stepper, {
				steps,
				current: stepOrdinal
			})), (0, react.createElement)("div", { className: WizardRoot_module_css_default.content }, (0, react.createElement)("div", { className: WizardRoot_module_css_default.topbar }, state.connecting || state.step === 3 ? (0, react.createElement)("button", {
				type: "button",
				className: WizardRoot_module_css_default.topAction,
				title: "最小化（连接不中断）",
				"aria-label": "最小化",
				onClick: () => wizardStore.minimize()
			}, "—") : null, (0, react.createElement)("button", {
				type: "button",
				className: WizardRoot_module_css_default.topAction,
				title: "关闭",
				"aria-label": "关闭",
				onClick: onClose
			}, "×")), stepContent)));
		}
		//#endregion
		//#region src/client/wizard/RemoteFlowDriver.ts
		/**
		* RemoteFlowDriver —— `sidebar.workspaces.remoteFlow` 孔的**无头**占用组件
		* （SPEC C 节）：返回 null，职责是双向同步渲染器 owner 与向导状态机——
		* open=true → 打开向导；open 被撤回（孔空/插件卸载）→ 最小化向导（连接中
		* 不杀 pipeline）。× 关闭时通知 owner 撤回 open（向导模块经 register 的
		* inject 向渲染器提供 hooks.remoteFlow 占用信号，菜单项由此显隐）。
		*/
		function RemoteFlowDriver({ open, onClose }) {
			(0, react.useEffect)(() => {
				if (open) wizardStore.open();
				else wizardStore.minimize();
			}, [open]);
			(0, react.useEffect)(() => {
				wizardStore.setOwnerClose(onClose);
				return () => {
					if (wizardStore.getOwnerClose() === onClose) wizardStore.setOwnerClose(null);
				};
			}, [onClose]);
			return null;
		}
		//#endregion
		//#region \0dsh-css-module:/home/lyy/workspace/DSH/Plugin/dsh-ssh/src/client/section/LogPopover.module.css.mjs
		const css = ".p2X1vW_spinnerSmall{box-sizing:border-box;border:2px solid var(--dsw-alias-border-l2);border-top-color:var(--dsw-alias-label-secondary);border-radius:50%;width:10px;height:10px;animation:.8s linear infinite p2X1vW_dshSshLogSpin}@keyframes p2X1vW_dshSshLogSpin{to{transform:rotate(360deg)}}.p2X1vW_logPopover{z-index:90;border:1px solid var(--dsw-alias-border-l2,var(--dsw-alias-border-l1));background:var(--dsw-alias-bg-overlay,var(--dsw-alias-bg-layer-3));border-radius:10px;flex-direction:column;width:320px;max-width:calc(100vw - 24px);max-height:280px;display:flex;position:fixed;overflow:hidden;box-shadow:0 8px 24px #0000002e}.p2X1vW_logPopoverHeader{border-bottom:1px solid var(--dsw-alias-border-l1);flex:none;justify-content:space-between;align-items:center;gap:8px;padding:7px 10px;display:flex}.p2X1vW_logPopoverTitle{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600}.p2X1vW_logPopoverLive{color:var(--dsw-alias-label-secondary);align-items:center;gap:5px;font-size:11px;display:flex}.p2X1vW_logPopoverBody{box-sizing:border-box;min-height:60px;max-height:230px;padding:6px 10px;overflow-y:auto}.p2X1vW_logPopoverEmpty{color:var(--dsw-alias-label-tertiary);padding:10px 0;font-size:11px}.p2X1vW_logPopoverLine{font:var(--dsw-font-markdown-code,11px/1.6 monospace);white-space:pre-wrap;word-break:break-all;gap:6px;display:flex}.p2X1vW_logPopoverTs{color:var(--dsw-alias-label-tertiary);flex:none}.p2X1vW_logPopoverLevel{color:var(--dsw-alias-label-secondary);flex:none}.p2X1vW_logPopoverLevelError{color:var(--dsw-alias-state-error-primary)}.p2X1vW_logPopoverMsg{min-width:0;color:var(--dsw-alias-label-primary)}";
		const tagId = "dsh-ssh/LogPopover.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-ssh";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var LogPopover_module_css_default = {
			"logPopoverBody": "p2X1vW_logPopoverBody",
			"logPopoverEmpty": "p2X1vW_logPopoverEmpty",
			"logPopoverHeader": "p2X1vW_logPopoverHeader",
			"logPopoverLevel": "p2X1vW_logPopoverLevel",
			"logPopoverLevelError": "p2X1vW_logPopoverLevelError",
			"dshSshLogSpin": "p2X1vW_dshSshLogSpin",
			"logPopoverTitle": "p2X1vW_logPopoverTitle",
			"logPopoverTs": "p2X1vW_logPopoverTs",
			"logPopover": "p2X1vW_logPopover",
			"logPopoverMsg": "p2X1vW_logPopoverMsg",
			"logPopoverLive": "p2X1vW_logPopoverLive",
			"logPopoverLine": "p2X1vW_logPopoverLine",
			"spinnerSmall": "p2X1vW_spinnerSmall"
		};
		//#endregion
		//#region src/client/section/LogPopover.ts
		/**
		* LogPopover —— 锚定行右侧浮出的连接日志卡片（SPEC J）。
		*
		* 与向导 StepConnecting 订阅**同一 WS key**（flowId|connectionId）：
		* 挂载即订阅（引用计数去重）、卸载即退订；重订阅拿快照+增量。标题栏
		* 「连接日志」，`live` 时右侧显示 spinner「正在连接…」。fixed 定位锚定
		* 点击处/行的视口矩形，滚动/窗口变化由调用方（LogPopoverOverlay）负责关闭。
		*/
		function LogPopover({ channelKey, live, anchor, onClose }) {
			const lines = logsStore.getLogs(channelKey);
			const listRef = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				return wsClient.subscribeLog(channelKey);
			}, [channelKey]);
			(0, react.useEffect)(() => {
				const onPointerDown = (event) => {
					const target = event.target;
					if (target === null) return;
					if (listRef.current?.contains(target) === true) return;
					onClose();
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") onClose();
				};
				window.addEventListener("mousedown", onPointerDown);
				window.addEventListener("keydown", onKeyDown);
				return () => {
					window.removeEventListener("mousedown", onPointerDown);
					window.removeEventListener("keydown", onKeyDown);
				};
			}, [onClose]);
			(0, react.useEffect)(() => {
				const el = listRef.current;
				if (el !== null) el.scrollTop = el.scrollHeight;
			}, [lines.length]);
			const left = Math.min(anchor.left + anchor.width + 8, window.innerWidth - 336);
			const top = Math.min(Math.max(anchor.top, 8), Math.max(8, window.innerHeight - 300));
			return (0, react.createElement)("div", {
				className: LogPopover_module_css_default.logPopover,
				ref: listRef,
				style: {
					left: `${left}px`,
					top: `${top}px`
				}
			}, (0, react.createElement)("div", { className: LogPopover_module_css_default.logPopoverHeader }, (0, react.createElement)("span", { className: LogPopover_module_css_default.logPopoverTitle }, "连接日志"), live === true ? (0, react.createElement)("span", { className: LogPopover_module_css_default.logPopoverLive }, (0, react.createElement)("span", { className: LogPopover_module_css_default.spinnerSmall }), "正在连接…") : null), (0, react.createElement)("div", { className: LogPopover_module_css_default.logPopoverBody }, lines.length === 0 ? (0, react.createElement)("div", { className: LogPopover_module_css_default.logPopoverEmpty }, "暂无日志") : lines.map((line, index) => (0, react.createElement)("div", {
				key: `${line.ts}-${index}`,
				className: LogPopover_module_css_default.logPopoverLine
			}, (0, react.createElement)("span", { className: LogPopover_module_css_default.logPopoverTs }, line.ts), (0, react.createElement)("span", { className: `${LogPopover_module_css_default.logPopoverLevel} ${line.level === "ERROR" ? LogPopover_module_css_default.logPopoverLevelError : ""}` }, `[${line.level}]`), (0, react.createElement)("span", { className: LogPopover_module_css_default.logPopoverMsg }, line.msg)))));
		}
		//#endregion
		//#region src/client/section/LogPopoverOverlay.ts
		/**
		* LogPopoverOverlay —— shell.overlay 条目：行菜单「查看日志」的日志浮层
		* （SPEC-M6：LogPopover 以 overlay 重挂，废弃 RemoteSection 的局部挂载）。
		*
		* visible-store 模式：hooks.visible 绑定 logPopoverVisible（logPopoverStore.open
		* 拉高 → 渲染；×/Esc/点击外部 → onClose → close 拉低）。锚点/频道从
		* logPopoverStore 读：anchorRect 是 onSelect 传入的点击处视口坐标（点锚）。
		* 追加 logsStore 版本订阅：行日志实时增量（原 RemoteSection 载体已删，overlay
		* 是唯一浮层载体，必须自己驱动重绘）。
		*/
		function LogPopoverOverlay({ useVisible, onClose }) {
			const visible = useVisible((value) => value);
			(0, react.useSyncExternalStore)(logPopoverStore.subscribe, logPopoverStore.getVersion);
			(0, react.useSyncExternalStore)(logsStore.subscribe, logsStore.getVersion);
			if (!visible) return null;
			const state = logPopoverStore.getSnapshot();
			if (!state.open || state.channelKey === null || state.anchorRect === null) return null;
			return (0, react.createElement)(LogPopover, {
				channelKey: state.channelKey,
				anchor: state.anchorRect,
				onClose
			});
		}
		//#endregion
		//#region src/client/styles.tokens.ts
		/**
		* 状态色集中常量（SPEC J 节颜色硬约束）。
		*
		* 已核查 ui-theme design-platform.css：success/danger 语义令牌存在
		* （--dsw-alias-state-success-primary / --dsw-alias-state-error-primary /
		* --dsw-alias-state-warn-primary），一律复用，不新造色值；offline 灰点
		* 用 label 次级令牌（SPEC 指定）。异常时才回落 tokens 文件内注释的来源值。
		*/
		const statusColors = {
			/** 在线绿点：design-platform.css 的 success 语义令牌（--dsw-static-green-500）。 */
			online: "var(--dsw-alias-state-success-primary)",
			/** 探测中（checking/连接中）：warn 语义令牌。 */
			checking: "var(--dsw-alias-state-warn-primary)",
			/** 离线/未知灰点：label 次级（SPEC 指定 var(--dsw-alias-label-secondary)）。 */
			offline: "var(--dsw-alias-label-secondary)",
			/** ERROR 日志/错误提示：danger 语义令牌。 */
			error: "var(--dsw-alias-state-error-primary)",
			/** 品牌强调（选中卡提亮、主按钮等）。 */
			brand: "var(--dsw-alias-brand-primary)"
		};
		//#endregion
		//#region src/client/rowext.ts
		/**
		* workspaceRowExt —— 原生工作区行的远程扩展服务（SPEC-M6 冻结契约逐字实现）。
		*
		* 由 dsh-ssh client 经 `ctx.provide('workspaceRowExt', createRowExt())` 注册
		* （index.ts apply 顶部）；ui-workspace 的 Rows 用**惰性 getter** 每次 render
		* `ctx.get('workspaceRowExt')` 消费——dsh-ssh 在 profile bundles 里位于
		* ui-workspace 之后，apply 期捕获必然拿不到，必须是惰性取值。
		*
		* - decorate：工作区行 path 命中连接的 remotePath（前缀匹配 + 目录边界）→
		*   云/窗图标 + 状态点色 + hover 标题；未命中 undefined（= 默认文件夹图标）。
		* - menuItems：⋯ 菜单追加「打开终端/重新连接/查看日志/删除连接」。
		* - onSelect：打开终端 dispatch `dsh-ssh:open-terminal`（dsh-terminal 联动）；
		*   重新连接 = api.check + applyStatus；查看日志 = 开 logPopoverStore（锚定点击
		*   处视口坐标）；删除连接 = api.removeConnection + 顺带 uiWorkspace.deleteWorkspace
		*   （删注册记录，有 workspaceId 时——安全）。
		* - subscribe/getVersion 桥接 connectionsStore（HostObservable 形状，驱动
		*   Rows 的 useSyncExternalStore 重渲染：状态点/装饰变化即行内刷新）。
		*
		* 云/窗口图标 SVG path 原存于 RemoteSection.ts（M6 删除该文件），此处移出保留，
		* 供 ui-workspace 补丁在图标库无 IconCloud/IconWindow 时内联 SVG 照抄。
		*/
		/** 连接行 ⋯ 菜单追加项（SPEC-M6 文案逐字）。 */
		const REMOTE_MENU_ITEMS = [
			{
				id: "open-terminal",
				label: "打开终端"
			},
			{
				id: "reconnect",
				label: "重新连接"
			},
			{
				id: "view-log",
				label: "查看日志"
			},
			{
				id: "delete-connection",
				label: "删除连接",
				danger: true
			}
		];
		/** 远端根规范化：根 '/' 原样保留（前缀匹配对根恒真）；其余去掉尾部斜杠（兼容 / 与 \）。 */
		function normalizeRoot(root) {
			if (root === "" || root === "/" || root === "\\") return root;
			return root.replace(/[\\/]+$/, "");
		}
		/** path 是否落在远端根之内（前缀匹配 + 目录边界，防 /root 误配 /root2）。 */
		function isWithin(root, path) {
			const r = normalizeRoot(root);
			if (r === "" || r === "/" || r === "\\") return true;
			return path === r || path.startsWith(`${r}/`) || path.startsWith(`${r}\\`);
		}
		/** 状态点色值（在线绿/离线灰/checking 蓝；degraded 视作 checking，沿用 RemoteSection 映射）。 */
		function statusColorOf(state) {
			switch (state) {
				case "online": return statusColors.online;
				case "checking":
				case "degraded": return statusColors.checking;
				default: return statusColors.offline;
			}
		}
		/** 状态中文文案（hover 标题「user@host（状态）」）。 */
		function statusLabel(state) {
			switch (state) {
				case "online": return "在线";
				case "checking": return "检查中";
				case "degraded": return "降级";
				case "offline": return "离线";
				default: return "未知";
			}
		}
		/** user@host 摘要（ssh）/ 盘符路径或主机（win），与旧 RemoteSection 副行一致。 */
		function userHostLabel(conn) {
			if (conn.kind === "ssh") return `${conn.ssh.user}@${conn.ssh.host}`;
			return conn.remotePath ?? (conn.ssh.host.length > 0 ? conn.ssh.host : "本机 Windows");
		}
		/** 由工作区行定位连接：workspaceId 精确优先，回落 remotePath 前缀匹配
		*（M5 起 host 侧已把注册后的 workspaceId 回写进连接记录，refresh 后精确命中）。 */
		function entryFor(workspaceId, path) {
			const entries = connectionsStore.getEntries();
			if (workspaceId.length > 0) {
				const byWorkspace = entries.find((entry) => entry.connection.workspaceId === workspaceId);
				if (byWorkspace !== void 0) return byWorkspace;
			}
			return entries.find((entry) => entry.connection.remotePath !== void 0 && isWithin(entry.connection.remotePath, path));
		}
		/** 重新连接：api.check 回填状态（失败保持现状，WS 状态频道继续纠偏）。 */
		async function recheck(connectionId) {
			try {
				const { status } = await api.check(connectionId);
				connectionsStore.applyStatus(connectionId, status);
			} catch {}
		}
		/** 删除连接：API 删除 → 顺带删注册工作区记录（有 workspaceId 时）→ 本地移除。 */
		async function removeConnectionFlow(entry) {
			const conn = entry.connection;
			if (!window.confirm(`删除连接「${conn.title}」？远端不会受影响，此操作不可撤销。`)) return;
			try {
				await api.removeConnection(conn.id);
				const workspaceId = conn.workspaceId;
				if (workspaceId !== void 0 && workspaceId.length > 0) {
					const uiWorkspace = getPluginCtx()?.get("workspaces");
					try {
						await uiWorkspace?.delete(workspaceId);
					} catch (e) {
						console.warn("[dsh-ssh] 删除工作区记录失败：", e instanceof Error ? e.message : String(e));
					}
				}
				connectionsStore.removeLocal(conn.id);
			} catch {
				window.alert("删除失败，请稍后重试。");
			}
		}
		/** 菜单项选中分发（itemId 与 REMOTE_MENU_ITEMS 一一对应；未知 id 静默忽略）。 */
		function handleSelect(workspaceId, path, itemId, at) {
			const entry = entryFor(workspaceId, path);
			if (entry === void 0) return;
			const conn = entry.connection;
			switch (itemId) {
				case "open-terminal":
					window.dispatchEvent(new CustomEvent("dsh-ssh:open-terminal", { detail: {
						connectionId: conn.id,
						kind: conn.kind,
						title: conn.title,
						remotePath: conn.remotePath
					} }));
					break;
				case "reconnect":
					recheck(conn.id);
					break;
				case "view-log":
					logPopoverStore.open(conn.id, { left: at.x, top: at.y, width: 0, height: 0 });
					break;
				case "delete-connection": removeConnectionFlow(entry);
			}
		}
		/** 工厂：index.ts apply 里 `ctx.provide('workspaceRowExt', createRowExt())`。 */
		function createRowExt() {
			return {
				decorate: (path, workspaceId) => {
					const entry = entryFor(workspaceId, path);
					if (entry === void 0) return void 0;
					const conn = entry.connection;
					return {
						icon: conn.kind === "win" ? "window" : "cloud",
						statusColor: statusColorOf(entry.status.state),
						title: `${userHostLabel(conn)}（${statusLabel(entry.status.state)}）`
					};
				},
				menuItems: (workspaceId, path) => entryFor(workspaceId, path) === void 0 ? [] : REMOTE_MENU_ITEMS,
				onSelect: handleSelect,
				subscribe: (listener) => connectionsStore.subscribe(listener),
				getVersion: () => connectionsStore.getVersion()
			};
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* dsh-ssh 浏览器侧入口：cordis apply 薄壳（M1 起，SPEC C/I/J 节消费侧；M6 集成）。
		*
		* apply 注册三处：
		*  - `ctx.provide('workspaceRowExt', …)`（M6）：原生工作区行远程扩展服务
		*    （云/窗图标、状态点、⋯ 菜单追加项、日志浮层开关）。dsh-ssh 在 profile
		*    bundles 里位于 ui-workspace 之后，消费侧必须**惰性 getter** 每次 render
		*    取；这里 apply 顶部直接 provide（比 setPluginCtx 转发更稳）。
		*  - `sidebar.workspaces.remoteFlow`（single，order 10）：无头 RemoteFlowDriver，
		*    经 register 的 inject 向渲染器提供 hooks.remoteFlow 占用信号（H1 用它决定
		*    「远程连接」菜单项显隐）；driver 同步 owner.open ↔ wizardStore。
		*  - `shell.overlay`（list）：order 60 WizardRoot 向导 modal（visible-store 模式，
		*    hooks.visible 绑定 wizardVisible）；order 62 LogPopoverOverlay 行菜单日志
		*    浮层（hooks.visible 绑定 logPopoverVisible）。
		*
		* 生命周期：WS 常驻客户端（状态+日志桥到 store）随 apply 启停，ctx.effect 回收；
		* 注册表初始拉取（connectionsStore.refresh）随 apply 启动，失败降级为空列表
		* （行装饰自然不命中，绝不让侧栏白屏）。
		*
		* 规范约束：react 等走 shell 冻结模块表（tsdown external）；不 import 任何
		* @deepseek-ai/* 运行时值；样式全令牌化（--dsw-alias-*）。
		*/
		const name = "dsh-ssh";
		/** 硬依赖 slots 服务（web shell 核心能力，必在）。 */
		const inject = ["slots"];
		function installCompat(ctx, { react, connectionsStore, wizardStore, api, logPopoverStore }) {
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
		function apply(ctx) {
			installCompat(ctx, { react, connectionsStore, wizardStore, api, logPopoverStore });
			setPluginCtx(ctx);
			ctx.provide("workspaceRowExt", createRowExt());
			connectionsStore.refresh();
			ctx.slots.inject("sidebar.workspaces.remoteFlow", () => ctx.slots.register({
				name: "sidebar.workspaces.remoteFlow",
				id: "dsh-ssh",
				order: 10,
				inject: () => ({ hooks: { remoteFlow: wizardOccupied } })
			}, RemoteFlowDriver));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-ssh-wizard",
				order: 60,
				inject: () => ({
					hooks: { visible: wizardVisible },
					onClose: () => wizardStore.requestClose()
				})
			}, WizardRoot));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "dsh-ssh-log",
				order: 62,
				inject: () => ({
					hooks: { visible: logPopoverVisible },
					onClose: () => logPopoverStore.close()
				})
			}, LogPopoverOverlay));
			ctx.effect(() => initWsBridge(), "dsh-ssh:ws-bridge");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map