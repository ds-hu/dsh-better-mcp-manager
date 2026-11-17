window.__ModuleLoader__.load({
	id: "@ds-hu/dsh-better-mcp-manager",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");
		const { useState, useEffect, useRef, useCallback, useMemo } = react;
		const h = react.createElement;

		const NS = "mcpManager";
		const API_BASE = "/better-mcp-manager/api";
		const PANEL_ID = "mcp-manager";
		const POLL_MS = 2500;
		const CSS_TAG = "@ds-hu/dsh-better-mcp-manager/client.css";
		const MAX_HEADERS = 20;
		const MAX_HEADER_VALUE = 4096;
		const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
		const COLORS = ["blue", "violet", "teal", "green", "amber", "rose", "slate"];
		const ICON_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
		const ICON_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
		const MAX_ICON_BYTES = 512 * 1024;
		const DEFAULT_TIMEOUT = 60000;

		/* ================================================================ */
		/* runtime state shared with the disposer                            */
		/* ================================================================ */

		/** The locale translator; tests may swap it through setTestRuntime. */
		let tt = (key) => key;
		/** Current browser plugin context, used by helpers that read the locale. */
		let appCtx = null;
		/** Every interval this module owns, so disposal can never leak one. */
		const timers = new Set();
		/** Every fetch controller this module owns, so disposal aborts them. */
		const liveRequests = new Set();

		function t(key, params) {
			const raw = tt(key, params);
			if (raw === key && params) {
				let out = key;
				for (const name of Object.keys(params)) out = out.split("{" + name + "}").join(String(params[name]));
				return out;
			}
			return raw;
		}

		function currentLang() {
			try {
				const locale = appCtx && appCtx.locale;
				const snapshot = locale && typeof locale.getLocale === "function" ? locale.getLocale() : undefined;
				const active = snapshot && typeof snapshot.active === "string" ? snapshot.active : undefined;
				if (active !== undefined && active.toLowerCase().startsWith("en")) return "en";
			} catch {
				/* fall through to the plugin default */
			}
			return "zh";
		}

		/**
		 * Swap the module-level runtime for tests.
		 * @param {any} ctx - fake context with a `locale` service.
		 * @param {(key: string, params?: object) => string} translate - translate function.
		 * @returns {() => void} restores the previous runtime.
		 */
		function setTestRuntime(ctx, translate) {
			const previous = { ctx: appCtx, translate: tt };
			appCtx = ctx;
			tt = translate;
			return () => {
				appCtx = previous.ctx;
				tt = previous.translate;
			};
		}

		/* ================================================================ */
		/* small utilities                                                   */
		/* ================================================================ */

		function cx() {
			let out = "";
			for (let index = 0; index < arguments.length; index += 1) {
				const part = arguments[index];
				if (part) out += (out === "" ? "" : " ") + part;
			}
			return out;
		}

		function isAbortError(failure) {
			return Boolean(failure && (failure.name === "AbortError" || failure.code === 20));
		}

		/**
		 * One JSON call to the Host API.
		 * @param {string} path - path below API_BASE.
		 * @param {{ method?: string, body?: any, signal?: AbortSignal }} [options] - request options.
		 * @returns {Promise<any>} the parsed answer.
		 */
		async function apiFetch(path, options) {
			const opts = options || {};
			const request = {
				method: opts.method || "GET",
				headers: { Accept: "application/json" },
				signal: opts.signal,
			};
			if (opts.body !== undefined) {
				request.headers["Content-Type"] = "application/json";
				request.body = JSON.stringify(opts.body);
			}
			const response = await fetch(API_BASE + path, request);
			let payload = null;
			try {
				payload = await response.json();
			} catch {
				/* a non-JSON body is reported through the status code */
			}
			if (!response.ok || (payload && payload.ok === false)) {
				const message = (payload && (payload.error || payload.code)) || "HTTP " + response.status;
				const failure = new Error(message);
				failure.status = response.status;
				failure.code = payload && payload.code;
				throw failure;
			}
			return payload || {};
		}

		/**
		 * A mutation request whose controller is tracked until it settles.
		 * @param {string} method - HTTP method.
		 * @param {string} path - path below API_BASE.
		 * @param {any} [body] - JSON body.
		 * @returns {Promise<any>} the parsed answer.
		 */
		function apiMutate(method, path, body) {
			const controller = typeof AbortController === "function" ? new AbortController() : null;
			if (controller) liveRequests.add(controller);
			const promise = apiFetch(path, { method, body, signal: controller ? controller.signal : undefined });
			promise.then(
				() => { if (controller) liveRequests.delete(controller); },
				() => { if (controller) liveRequests.delete(controller); },
			);
			return promise;
		}

		/** Abort every request and clear every timer this module owns. */
		function disposeRuntime() {
			for (const timer of Array.from(timers)) clearInterval(timer);
			timers.clear();
			for (const controller of Array.from(liveRequests)) {
				try {
					controller.abort();
				} catch {
					/* already settled */
				}
			}
			liveRequests.clear();
		}

		function formatTime(iso) {
			if (typeof iso !== "string" || iso === "") return "";
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return iso;
			if (currentLang() === "en") {
				return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
			}
			return date.toLocaleString("zh-CN", {
				year: "numeric", month: "2-digit", day: "2-digit",
				hour: "2-digit", minute: "2-digit", second: "2-digit",
			});
		}

		/* ================================================================ */
		/* data helpers                                                      */
		/* ================================================================ */

		const STATUS_META = {
			connected: { word: "status.connected", tone: "ok" },
			connecting: { word: "status.connecting", tone: "warn" },
			retrying: { word: "status.retrying", tone: "warn" },
			error: { word: "status.error", tone: "error" },
			disabled: { word: "status.disabled", tone: "idle" },
		};

		/**
		 * The display status of one server.
		 * @param {any} server - server record with a derived status.
		 * @returns {{ state: string, wordKey: string, tone: string, status: any }} display facts.
		 */
		function statusFor(server) {
			const status = (server && server.status) || {};
			if (!server || server.enabled !== true) {
				return { state: "disabled", wordKey: "status.disabled", tone: "idle", status };
			}
			const state = typeof status.state === "string" && STATUS_META[status.state] ? status.state : "connecting";
			// The Host reuses "error" for a scheduled retry; the page shows that as its own state.
			if (state === "error" && status.nextRetryAt) {
				const retrying = STATUS_META.retrying;
				return { state: "retrying", wordKey: retrying.word, tone: retrying.tone, status };
			}
			const meta = STATUS_META[state];
			return { state, wordKey: meta.word, tone: meta.tone, status };
		}

		function transportKey(transport) {
			if (transport === "sse") return "transport.sse";
			if (transport === "stdio") return "transport.stdio";
			return "transport.http";
		}

		function transportLabel(transport) {
			return t(transportKey(transport));
		}

		/** The first grapheme of a name, uppercased; "?" when there is none. */
		function letterOf(name) {
			const text = typeof name === "string" ? name.trim() : "";
			if (text === "") return "?";
			return Array.from(text)[0].toUpperCase();
		}

		/** The fallback letter shown when a server has no loadable icon. */
		function iconLetter(server) {
			return letterOf(server && server.name);
		}

		/** The Host-provided icon URL for a server, or "" when it has none. */
		function iconUrlOf(server) {
			return server && typeof server.iconUrl === "string" && server.iconUrl !== "" ? server.iconUrl : "";
		}

		const PRESET_FALLBACKS = {
			standard: { zh: "标准模式", en: "Standard mode" },
			ptc: { zh: "ptc", en: "ptc" },
			minimal: { zh: "minimal", en: "minimal" },
			cordis: { zh: "cordis", en: "cordis" },
			"task-center": { zh: "任务管理", en: "Task management" },
			search: { zh: "搜索模式", en: "Search mode" },
		};

		function presetDisplayName(preset) {
			if (!preset) return "";
			if (typeof preset.name === "string" && preset.name !== "" && preset.name !== preset.id) return preset.name;
			const builtIn = PRESET_FALLBACKS[preset.id];
			if (builtIn) return currentLang() === "en" ? builtIn.en : builtIn.zh;
			return typeof preset.id === "string" ? preset.id : "";
		}

		/**
		 * Group servers for the list view, ungrouped last.
		 * @param {any[]} servers - list order records.
		 * @returns {{ key: string, name: string, servers: any[] }[]} sections.
		 */
		function groupServers(servers) {
			const sections = [];
			const byName = new Map();
			for (const server of servers || []) {
				const name = typeof server.group === "string" ? server.group.trim() : "";
				const key = name === "" ? "\u0000ungrouped" : name;
				let section = byName.get(key);
				if (!section) {
					section = { key, name, servers: [] };
					byName.set(key, section);
					sections.push(section);
				}
				section.servers.push(server);
			}
			const named = sections.filter((section) => section.name !== "");
			const ungrouped = sections.filter((section) => section.name === "");
			return named.concat(ungrouped);
		}

		/** The list header subtitle: total and connected counts. */
		function countConnected(servers) {
			let count = 0;
			for (const server of servers || []) {
				if (server.enabled === true && statusFor(server).state === "connected") count += 1;
			}
			return count;
		}

		/** Enabled/total discovered tool counts from a live status, with fallbacks. */
		function toolCounts(status) {
			const total = status && Number.isInteger(status.toolCount) ? status.toolCount : 0;
			const enabled = status && Number.isInteger(status.enabledToolCount) ? status.enabledToolCount : total;
			return { enabled, total };
		}

		/** Normalize the GET /servers/:id/tools payload into sorted, safe rows. */
		function normalizeToolList(rawTools) {
			const list = Array.isArray(rawTools) ? rawTools : [];
			const tools = [];
			for (const raw of list) {
				if (!raw || typeof raw.name !== "string" || raw.name === "") continue;
				const params = [];
				for (const param of Array.isArray(raw.params) ? raw.params : []) {
					if (param && typeof param.name === "string" && param.name !== "") {
						params.push({ name: param.name, required: param.required === true });
					}
				}
				tools.push({
					name: raw.name,
					publicName: typeof raw.publicName === "string" ? raw.publicName : raw.name,
					description: typeof raw.description === "string" ? raw.description : "",
					params,
					enabled: raw.enabled !== false,
					approval: raw.approval === true,
				});
			}
			tools.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
			return tools;
		}

		/** The PUT /servers/:id/tools body: always the full visible list, sorted. */
		function toolSettingsOf(tools) {
			const rows = [];
			for (const tool of Array.isArray(tools) ? tools : []) {
				rows.push({ name: tool.name, enabled: tool.enabled !== false, approval: tool.approval === true });
			}
			rows.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
			return rows;
		}

		/** Stable fingerprint of the settings, used to gate the save button. */
		function toolSettingsKey(tools) {
			return JSON.stringify(toolSettingsOf(tools));
		}

		function byName(left, right) {
			return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
		}

		/** Normalize GET/POST/PUT /external payloads into safe, sorted rows. */
		function normalizeExternalPayload(payload) {
			const presets = [];
			for (const raw of Array.isArray(payload && payload.presets) ? payload.presets : []) {
				if (!raw || typeof raw.id !== "string" || raw.id === "") continue;
				const servers = [];
				for (const rawServer of Array.isArray(raw.servers) ? raw.servers : []) {
					if (!rawServer || typeof rawServer.name !== "string" || rawServer.name === "") continue;
					const tools = [];
					for (const rawTool of Array.isArray(rawServer.tools) ? rawServer.tools : []) {
						if (!rawTool || typeof rawTool.name !== "string" || rawTool.name === "") continue;
						const params = [];
						for (const rawParam of Array.isArray(rawTool.params) ? rawTool.params : []) {
							if (rawParam && typeof rawParam.name === "string" && rawParam.name !== "") {
								params.push({ name: rawParam.name, required: rawParam.required === true });
							}
						}
						tools.push({
							name: rawTool.name,
							description: typeof rawTool.description === "string" ? rawTool.description : "",
							params,
							enabled: rawTool.enabled !== false,
							approval: rawTool.approval === true,
						});
					}
					tools.sort(byName);
					servers.push({
						name: rawServer.name,
						discoveredAt: typeof rawServer.discoveredAt === "string" ? rawServer.discoveredAt : null,
						tools,
					});
				}
				servers.sort(byName);
				presets.push({
					id: raw.id,
					name: typeof raw.name === "string" && raw.name !== "" ? raw.name : raw.id,
					hasPresetMcp: raw.hasPresetMcp === true,
					servers,
				});
			}
			return {
				scannedAt: typeof payload === "object" && payload !== null && typeof payload.scannedAt === "string" ? payload.scannedAt : null,
				presets,
			};
		}

		/** The PUT /external/tools body: every visible tool of one preset, sorted. */
		function externalToolSettings(preset) {
			const rows = [];
			for (const server of preset.servers) {
				for (const tool of server.tools) {
					rows.push({ name: tool.name, enabled: tool.enabled !== false, approval: tool.approval === true });
				}
			}
			rows.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
			return rows;
		}

		/** Stable per-preset fingerprint of the external settings. */
		function externalToolSettingsKey(preset) {
			return JSON.stringify(externalToolSettings(preset));
		}

		/** Baseline fingerprints for every preset in a payload. */
		function externalBaselines(presets) {
			const baselines = {};
			for (const preset of presets) baselines[preset.id] = externalToolSettingsKey(preset);
			return baselines;
		}

		/* ================================================================ */
		/* draft helpers                                                     */
		/* ================================================================ */

		function blankDraft(group) {
			return {
				id: "",
				key: "",
				name: "",
				enabled: true,
				transport: "http",
				url: "",
				command: "",
				argsText: "",
				cwd: "",
				envRows: [],
				headers: [],
				oauth: { mode: "none" },
				color: "blue",
				group: typeof group === "string" ? group : "",
				presets: "all",
				timeoutMs: DEFAULT_TIMEOUT,
			};
		}

		function draftFromServer(server) {
			const env = server && server.env && typeof server.env === "object" ? server.env : {};
			const envRows = Object.keys(env).map((name) => ({ name, value: String(env[name] === undefined ? "" : env[name]) }));
			const headers = Array.isArray(server && server.headers)
				? server.headers.map((row) => ({ name: String(row.name || ""), value: String(row.value || "") }))
				: [];
			const presets = server && Array.isArray(server.presets) ? server.presets.slice() : "all";
			return {
				id: server && server.id ? server.id : "",
				key: server && server.key ? server.key : "",
				name: server && server.name ? String(server.name) : "",
				enabled: server ? server.enabled === true : true,
				transport: server && (server.transport === "sse" || server.transport === "stdio") ? server.transport : "http",
				url: server && server.url ? String(server.url) : "",
				command: server && server.command ? String(server.command) : "",
				argsText: server && Array.isArray(server.args) ? server.args.join("\n") : "",
				cwd: server && server.cwd ? String(server.cwd) : "",
				envRows,
				headers,
				oauth: server && server.oauth && typeof server.oauth === "object" ? { ...server.oauth } : { mode: "none" },
				color: server && COLORS.indexOf(server.color) >= 0 ? server.color : "blue",
				group: server && server.group ? String(server.group) : "",
				presets,
				timeoutMs: server && Number.isInteger(server.timeoutMs) ? server.timeoutMs : DEFAULT_TIMEOUT,
			};
		}

		function normalizeOAuth(oauth) {
			const source = oauth && typeof oauth === "object" ? oauth : {};
			const mode = source.mode;
			if (mode === "bearer") {
				return { mode: "bearer", token: String(source.token === undefined ? "" : source.token) };
			}
			if (mode === "client_credentials") {
				return {
					mode: "client_credentials",
					tokenUrl: String(source.tokenUrl === undefined ? "" : source.tokenUrl).trim(),
					clientId: String(source.clientId === undefined ? "" : source.clientId).trim(),
					clientSecret: String(source.clientSecret === undefined ? "" : source.clientSecret),
					scope: String(source.scope === undefined ? "" : source.scope).trim(),
				};
			}
			return { mode: "none" };
		}

		function bodyFromDraft(draft) {
			const body = {
				name: String(draft.name || "").trim(),
				enabled: draft.enabled === true,
				transport: draft.transport === "sse" || draft.transport === "stdio" ? draft.transport : "http",
				color: COLORS.indexOf(draft.color) >= 0 ? draft.color : "blue",
				group: String(draft.group || "").trim(),
				presets: draft.presets === "all" ? "all" : (Array.isArray(draft.presets) ? draft.presets.slice() : []),
				timeoutMs: Number(draft.timeoutMs) || DEFAULT_TIMEOUT,
			};
			if (body.transport === "stdio") {
				body.command = String(draft.command || "").trim();
				body.args = String(draft.argsText || "")
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line !== "");
				body.cwd = String(draft.cwd || "").trim();
				const env = {};
				for (const row of draft.envRows || []) {
					const name = String(row.name || "").trim();
					if (name !== "") env[name] = String(row.value === undefined ? "" : row.value);
				}
				body.env = env;
			} else {
				body.url = String(draft.url || "").trim();
				body.headers = (draft.headers || [])
					.filter((row) => String(row.name || "").trim() !== "" || String(row.value || "").trim() !== "")
					.map((row) => ({ name: String(row.name || "").trim(), value: String(row.value || "").trim() }));
				body.oauth = normalizeOAuth(draft.oauth);
			}
			return body;
		}

		/**
		 * Validate a draft the way the Host does, so mistakes surface inline first.
		 * @param {any} draft - editable draft.
		 * @param {any[]} presets - live preset roster.
		 * @returns {any} an errors object; empty when valid.
		 */
		function validateDraft(draft, presets) {
			const errors = {};
			const name = String(draft.name || "").trim();
			if (name === "") errors.name = "field.nameErrorRequired";
			else if (Array.from(name).length > 80) errors.name = "field.nameErrorLong";
			if (draft.transport === "stdio") {
				if (String(draft.command || "").trim() === "") errors.command = "field.commandErrorRequired";
			} else {
				const url = String(draft.url || "").trim();
				if (url === "") errors.url = "field.urlErrorRequired";
				else if (!/^https?:\/\/[^\s]+$/iu.test(url)) errors.url = "field.urlErrorInvalid";
			}
			const timeout = Number(draft.timeoutMs);
			if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 600000) errors.timeout = "field.timeoutError";
			const rowErrors = {};
			const seen = new Map();
			let headerCount = 0;
			(draft.headers || []).forEach((row, index) => {
				const headerName = String(row.name || "").trim();
				const value = String(row.value || "");
				if (headerName === "" && value.trim() === "") return;
				headerCount += 1;
				if (headerName === "") {
					rowErrors[index] = "headers.errorRequired";
					return;
				}
				if (!HEADER_NAME_RE.test(headerName)) {
					rowErrors[index] = "headers.errorInvalid";
					return;
				}
				const lower = headerName.toLowerCase();
				if (seen.has(lower)) {
					rowErrors[index] = "headers.errorDuplicate";
					return;
				}
				if (value.length > MAX_HEADER_VALUE) {
					rowErrors[index] = "headers.errorValueLong";
					return;
				}
				seen.set(lower, index);
			});
			if (headerCount > MAX_HEADERS) errors.headersLimit = "headers.errorLimit";
			if (Object.keys(rowErrors).length > 0) errors.headerRows = rowErrors;
			if (draft.presets !== "all" && Array.isArray(draft.presets)) {
				if (draft.presets.length > 40) errors.presets = "presets.errorMax";
				else if (presets && presets.length > 0) {
					const known = new Set(presets.map((preset) => preset.id));
					const unknown = draft.presets.find((id) => !known.has(id));
					if (unknown !== undefined) errors.presets = "presets.unknown";
				}
			}
			return errors;
		}

		function hasFieldErrors(errors) {
			return Boolean(errors && (
				errors.name || errors.url || errors.command || errors.timeout ||
				errors.headerRows || errors.headersLimit || errors.presets
			));
		}

		/* ================================================================ */
		/* dictionaries                                                      */
		/* ================================================================ */

		const zh = {
			"panel": "MCP 管理",
			"title": "MCP 管理",
			"page.title": "MCP 管理",
			"page.subtitle": "共 {total} 个服务器 · {connected} 个已连接",
			"page.add": "添加 MCP",
			"page.version": "v{version}",
			"page.settings": "设置",

			"list.loading": "正在读取服务器…",
			"list.emptyTitle": "还没有 MCP 服务器",
			"list.emptyHint": "添加一个 MCP 服务器，它提供的工具就会出现在选中预设的会话里。",
			"list.emptyAction": "添加 MCP",
			"list.error": "无法读取服务器列表：{message}",
			"list.retry": "重试",
			"list.stale": "显示的是上次成功读取的数据。",

			"group.ungrouped": "其他（未分组）",
			"group.count": "{count} 个",

			"status.connected": "已连接",
			"status.connecting": "连接中",
			"status.retrying": "重连中",
			"status.error": "连接失败",
			"status.disabled": "已停用",

			"card.tools": "工具 {count}/{total}",
			"card.details": "详情",
			"card.menu": "更多操作",
			"card.menu.edit": "编辑",
			"card.menu.test": "测试连接",
			"card.menu.reconnect": "重新连接",
			"card.menu.enable": "启用",
			"card.menu.disable": "停用",
			"card.menu.delete": "删除",
			"card.nextRetry": "下次重试 {time}",

			"transport.http": "HTTP",
			"transport.sse": "SSE",
			"transport.stdio": "内置",

			"color.blue": "蓝色",
			"color.violet": "紫色",
			"color.teal": "青色",
			"color.green": "绿色",
			"color.amber": "琥珀",
			"color.rose": "玫红",
			"color.slate": "灰蓝",

			"action.failed": "操作失败：{message}",
			"action.saved": "已保存",
			"action.deleted": "已删除",
			"action.enabled": "已启用",
			"action.disabled": "已停用",
			"action.reconnected": "已发出重新连接请求",

			"error.title": "连接错误",
			"error.code": "错误码",
			"error.message": "错误信息",
			"error.detail": "详细信息",
			"error.at": "发生时间",
			"error.attempts": "连续失败",
			"error.attemptsValue": "{count} 次",
			"error.nextRetry": "下次重试",
			"error.none": "（无）",
			"error.close": "关闭",
			"error.verbatim": "以下内容由宿主原样返回。",

			"form.newTitle": "添加 MCP 服务器",
			"form.editTitle": "编辑 MCP 服务器",
			"form.back": "返回列表",
			"form.save": "保存",
			"form.saving": "保存中…",
			"form.cancel": "取消",
			"form.test": "测试连接",
			"form.testing": "测试中…",
			"form.delete": "删除",
			"form.deleteTitle": "删除这个 MCP 服务器？",
			"form.deleteBody": "删除后无法恢复，它的工具会立即从所有会话中移除。",
			"form.deleteAction": "删除",
			"form.deleteFailed": "删除失败：{message}",
			"form.saveFailed": "保存失败：{message}",
			"form.testFailed": "测试失败：{message}",
			"form.testTimeout": "测试最多等待 15 秒。",
			"form.unsavedHint": "修改只在点「保存」后生效。",
			"form.validationFailed": "还有字段需要修正，请看下面的提示。",
			"form.keyHint": "命名空间保存后固定为 {key}，工具名会以它开头。",
			"form.keyPending": "命名空间会在保存后生成",

			"section.basic": "基本",
			"section.basicHint": "名称、图标与分组决定它在列表里怎么显示。",
			"section.connection": "连接",
			"section.connectionHint": "服务器地址，或在本机启动的命令。",
			"section.oauth": "OAuth 设置",
			"section.oauthHint": "先在服务商处登记，再把访问令牌或客户端凭证填在这里。",
			"section.headers": "自定义请求头",
			"section.headersHint": "按顺序发送；请求头名称不能重复。",
			"section.presets": "预设暴露",
			"section.presetsHint": "选择哪些 Agent 预设可以拿到这个服务器的工具。",

			"form.tabBasic": "基础设置",
			"form.tabTools": "工具",
			"form.tabsLabel": "设置分区",
			"tools.title": "工具列表",
			"tools.hint": "单独控制每个工具是否暴露给 Agent，以及调用前是否需要你的批准。",
			"tools.loading": "正在读取工具列表…",
			"tools.retry": "重试",
			"tools.empty": "这个服务器没有提供工具",
			"tools.offline": "服务器未连接，连接后才能读取实时工具列表",
			"tools.cached": "服务器当前未连接，显示上次连接时的工具列表",
			"tools.cachedAt": "更新于 {time}",
			"tools.save": "保存工具设置",
			"tools.saved": "工具设置已保存",
			"tools.saveFailed": "保存工具设置失败：{message}",
			"tools.loadFailed": "读取工具列表失败：{message}",
			"tools.enableAll": "全部开启",
			"tools.disableAll": "全部关闭",
			"tools.approval": "需要审批",
			"tools.approvalHint": "非完全权限时会要求你批准",
			"tools.params": "参数",
			"tools.required": "必填",
			"tools.optional": "可选",
			"tools.noParams": "无参数",
			"tools.disabledNote": "工具已停用，不会暴露给任何 Agent。",
			"tools.count": "已启用 {enabled}/{total}",
			"tools.saveFirst": "先保存并连接服务器，再管理工具",
			"tools.footHint": "工具设置的改动会在保存后立即生效。",
			"page.tabOwned": "本插件 MCP",
			"page.tabExternal": "其他 MCP",
			"page.tabsLabel": "MCP 分组",
			"external.title": "其他 MCP",
			"external.intro": "这些 MCP 由其他预设或插件挂载；这里只能管理工具是否暴露给 Agent、以及调用前是否需要审批，不能修改连接或凭据。",
			"external.scan": "重新扫描",
			"external.scanning": "正在扫描…",
			"external.scannedAt": "上次扫描：{time}",
			"external.neverScanned": "尚未扫描",
			"external.loading": "正在读取其他 MCP…",
			"external.empty": "没有发现预设自带的 MCP",
			"external.pending": "该预设自带 MCP，但工具列表还未同步",
			"external.pendingHint": "打开一次使用该预设的会话后自动同步，也可以点「重新扫描」。",
			"external.save": "保存工具设置",
			"external.saved": "工具设置已保存",
			"external.saveFailed": "保存失败：{message}",
			"external.loadFailed": "读取失败：{message}",
			"external.retry": "重试",
			"external.toolCount": "{count} 个工具",
			"external.serverMeta": "{enabled}/{total} 个工具已启用",
			"external.discoveredAt": "发现于 {time}",
			"external.back": "返回",
			"external.detailHint": "单独控制这个服务器里每个工具是否暴露给 Agent，以及调用前是否需要审批。",
			"external.ownedBadge": "预设自带",
			"external.disabledNote": "已停用，不会暴露给 Agent",
			"external.footHint": "停用后该工具会从 Agent 的工具列表中消失；需要审批只在非完全权限下生效。",
			"external.noParams": "无参数",
			"external.toolsEmpty": "该服务器暂未上报工具",
			"field.enabled": "是否启用",
			"field.enabledHint": "关闭后不再连接，工具立即从所有会话移除。",
			"field.icon": "服务器图标",
			"icon.upload": "上传图标",
			"icon.auto": "恢复自动",
			"icon.hint": "默认使用 MCP 服务端声明的图标，没有则显示名称首字母。",
			"icon.invalidType": "请选择 PNG、JPEG、WebP 或 GIF 图片",
			"icon.tooLarge": "图片不能超过 512 KiB",
			"icon.uploadFailed": "已保存，但图标上传失败：{message}",
			"icon.removed": "已恢复自动图标",
			"icon.autoLabel": "自动（来自 MCP 服务端）",
			"field.color": "图标颜色",
			"field.group": "分组",
			"field.groupPlaceholder": "选择或输入分组名称",
			"field.groupNone": "不分组",
			"field.name": "名称",
			"field.namePlaceholder": "My MCP",
			"field.nameErrorRequired": "请填写名称",
			"field.nameErrorLong": "名称最多 80 个字符",
			"field.transport": "传输类型",
			"field.transportHttpHint": "连接一个 HTTP 或 HTTPS 地址（Streamable HTTP）。",
			"field.transportSseHint": "连接一个提供 Server-Sent Events 的地址。",
			"field.transportStdioHint": "在本机启动一个进程，通过标准输入输出通信。",
			"field.url": "服务器地址",
			"field.urlPlaceholder": "http://localhost:3000",
			"field.urlErrorRequired": "请填写服务器地址",
			"field.urlErrorInvalid": "需要以 http:// 或 https:// 开头的绝对地址",
			"field.command": "命令",
			"field.commandPlaceholder": "npx",
			"field.commandErrorRequired": "请填写启动命令",
			"field.args": "参数",
			"field.argsPlaceholder": "-y\n@modelcontextprotocol/server-filesystem\n/tmp",
			"field.argsHint": "每行一个参数。",
			"field.cwd": "工作目录",
			"field.cwdPlaceholder": "可选，留空则继承当前目录",
			"field.env": "环境变量",
			"field.envEmpty": "还没有环境变量。",
			"field.envName": "变量名",
			"field.envValue": "值",
			"field.envAdd": "添加环境变量",
			"field.envRemove": "删除环境变量",
			"field.timeout": "请求超时",
			"field.timeoutUnit": "毫秒",
			"field.timeoutHint": "单次工具调用的最长等待时间，1000–600000。",
			"field.timeoutError": "超时需要是 1000 到 600000 之间的整数",

			"headers.empty": "还没有自定义请求头",
			"headers.name": "名称",
			"headers.value": "值",
			"headers.namePlaceholder": "Authorization",
			"headers.valuePlaceholder": "Bearer xxxxxx",
			"headers.add": "添加请求头",
			"headers.remove": "删除请求头",
			"headers.errorRequired": "填写值之前先填名称",
			"headers.errorInvalid": "请求头名称包含非法字符",
			"headers.errorDuplicate": "请求头名称重复",
			"headers.errorValueLong": "请求头的值最多 4096 个字符",
			"headers.errorLimit": "最多 20 个请求头",

			"oauth.title": "OAuth 设置",
			"oauth.mode": "模式",
			"oauth.none": "不启用",
			"oauth.bearer": "Bearer",
			"oauth.clientCredentials": "客户端凭证",
			"oauth.token": "访问令牌",
			"oauth.tokenPlaceholder": "粘贴访问令牌",
			"oauth.tokenUrl": "Token 地址",
			"oauth.tokenUrlPlaceholder": "https://idp.example.com/token",
			"oauth.clientId": "Client ID",
			"oauth.clientSecret": "Client Secret",
			"oauth.scope": "Scope",
			"oauth.scopePlaceholder": "mcp.read",
			"oauth.configure": "配置",
			"oauth.summaryNone": "未启用",
			"oauth.summaryBearer": "Bearer Token",
			"oauth.summaryClientCredentials": "客户端凭证",
			"oauth.hint": "自定义 Authorization 请求头优先于这里配置的令牌。",
			"oauth.done": "完成",
			"oauth.cancel": "取消",

			"presets.all": "全部预设",
			"presets.allHint": "所有会话都能拿到这些工具，包括没有预设的 Agent。",
			"presets.specific": "指定预设",
			"presets.specificHint": "只有选中的预设能拿到这些工具。",
			"presets.empty": "这个 profile 没有提供可用的 Agent 预设。",
			"presets.emptyHint": "预设由 Harness 的 agentPresets 服务提供；没有它时只能选择「全部预设」。",
			"presets.noneSelected": "没有选择任何预设：这些工具不会暴露给任何会话。",
			"presets.selectedCount": "已选 {count} 个",
			"presets.unknown": "有预设已经不存在，请重新选择",
			"presets.errorMax": "最多选择 40 个预设",
			"presets.noDescription": "没有描述",

			"test.title": "测试结果",
			"test.success": "连接成功",
			"test.failure": "连接失败",
			"test.tools": "发现 {count} 个工具",
			"test.transport": "传输方式",
			"test.noStatus": "宿主没有返回连接状态",
			"test.close": "关闭",
			"test.rerun": "再测一次",

			"toast.dismiss": "关闭提示",
			"common.close": "关闭",
			"common.required": "必填",
			"common.loading": "加载中…",
		};

		const en = {
			"panel": "MCP Manager",
			"title": "MCP Manager",
			"page.title": "MCP Manager",
			"page.subtitle": "{total} server(s) · {connected} connected",
			"page.add": "Add MCP",
			"page.version": "v{version}",
			"page.settings": "Settings",

			"list.loading": "Reading servers…",
			"list.emptyTitle": "No MCP servers yet",
			"list.emptyHint": "Add an MCP server and its tools will appear in sessions that use the selected presets.",
			"list.emptyAction": "Add MCP",
			"list.error": "Cannot read the server list: {message}",
			"list.retry": "Retry",
			"list.stale": "Showing the last successful read.",

			"group.ungrouped": "Other (ungrouped)",
			"group.count": "{count} server(s)",

			"status.connected": "Connected",
			"status.connecting": "Connecting",
			"status.retrying": "Retrying",
			"status.error": "Connection failed",
			"status.disabled": "Disabled",

			"card.tools": "Tools {count}/{total}",
			"card.details": "Details",
			"card.menu": "More actions",
			"card.menu.edit": "Edit",
			"card.menu.test": "Test connection",
			"card.menu.reconnect": "Reconnect",
			"card.menu.enable": "Enable",
			"card.menu.disable": "Disable",
			"card.menu.delete": "Delete",
			"card.nextRetry": "Next retry {time}",

			"transport.http": "HTTP",
			"transport.sse": "SSE",
			"transport.stdio": "Built-in",

			"color.blue": "Blue",
			"color.violet": "Violet",
			"color.teal": "Teal",
			"color.green": "Green",
			"color.amber": "Amber",
			"color.rose": "Rose",
			"color.slate": "Slate",

			"action.failed": "Action failed: {message}",
			"action.saved": "Saved",
			"action.deleted": "Deleted",
			"action.enabled": "Enabled",
			"action.disabled": "Disabled",
			"action.reconnected": "Reconnect requested",

			"error.title": "Connection error",
			"error.code": "Code",
			"error.message": "Message",
			"error.detail": "Detail",
			"error.at": "At",
			"error.attempts": "Failed attempts",
			"error.attemptsValue": "{count}",
			"error.nextRetry": "Next retry",
			"error.none": "(none)",
			"error.close": "Close",
			"error.verbatim": "The Host returned the text below verbatim.",

			"form.newTitle": "Add MCP server",
			"form.editTitle": "Edit MCP server",
			"form.back": "Back to list",
			"form.save": "Save",
			"form.saving": "Saving…",
			"form.cancel": "Cancel",
			"form.test": "Test connection",
			"form.testing": "Testing…",
			"form.delete": "Delete",
			"form.deleteTitle": "Delete this MCP server?",
			"form.deleteBody": "This cannot be undone; its tools are removed from every session immediately.",
			"form.deleteAction": "Delete",
			"form.deleteFailed": "Cannot delete: {message}",
			"form.saveFailed": "Cannot save: {message}",
			"form.testFailed": "Cannot test: {message}",
			"form.testTimeout": "The test waits at most 15 seconds.",
			"form.unsavedHint": "Changes apply after you press Save.",
			"form.validationFailed": "Some fields need attention; see the messages below.",
			"form.keyHint": "The namespace is fixed at {key}; every tool name starts with it.",
			"form.keyPending": "The namespace is assigned when you save",

			"section.basic": "Basics",
			"section.basicHint": "Name, icon and group decide how the server appears in the list.",
			"section.connection": "Connection",
			"section.connectionHint": "A server URL, or a command started on this machine.",
			"section.oauth": "OAuth settings",
			"section.oauthHint": "Register with the provider first, then paste an access token or client credentials here.",
			"section.headers": "Custom headers",
			"section.headersHint": "Sent in order; header names must be unique.",
			"section.presets": "Preset exposure",
			"section.presetsHint": "Choose which Agent presets receive this server's tools.",

			"form.tabBasic": "Basic",
			"form.tabTools": "Tools",
			"form.tabsLabel": "Sections",
			"tools.title": "Tools",
			"tools.hint": "Control which tools are exposed to agents, and whether each call needs your approval.",
			"tools.loading": "Loading tools…",
			"tools.retry": "Retry",
			"tools.empty": "This server exposes no tools",
			"tools.offline": "The server is not connected; connect it to read the live tool list",
			"tools.cached": "The server is not connected; showing the last discovered tool list",
			"tools.cachedAt": "Updated {time}",
			"tools.save": "Save tool settings",
			"tools.saved": "Tool settings saved",
			"tools.saveFailed": "Failed to save tool settings: {message}",
			"tools.loadFailed": "Failed to load the tool list: {message}",
			"tools.enableAll": "Enable all",
			"tools.disableAll": "Disable all",
			"tools.approval": "Requires approval",
			"tools.approvalHint": "Asks when the session is not in full access",
			"tools.params": "Parameters",
			"tools.required": "Required",
			"tools.optional": "Optional",
			"tools.noParams": "No parameters",
			"tools.disabledNote": "This tool is disabled and is not exposed to any agent.",
			"tools.count": "{enabled}/{total} enabled",
			"tools.saveFirst": "Save and connect the server first, then manage its tools",
			"tools.footHint": "Tool settings take effect as soon as you save.",
			"page.tabOwned": "Plugin MCP",
			"page.tabExternal": "Other MCP",
			"page.tabsLabel": "MCP groups",
			"external.title": "Other MCP",
			"external.intro": "These MCP servers are mounted by other presets or plugins. You can only control whether their tools are exposed to agents and whether calls need approval; connections and credentials cannot be changed here.",
			"external.scan": "Rescan",
			"external.scanning": "Scanning…",
			"external.scannedAt": "Last scan: {time}",
			"external.neverScanned": "Not scanned yet",
			"external.loading": "Loading other MCP servers…",
			"external.empty": "No preset-owned MCP servers found",
			"external.pending": "This preset owns an MCP server, but its tools are not synced yet",
			"external.pendingHint": "Open one session using this preset to sync automatically, or press Rescan.",
			"external.save": "Save tool settings",
			"external.saved": "Tool settings saved",
			"external.saveFailed": "Failed to save: {message}",
			"external.loadFailed": "Failed to load: {message}",
			"external.retry": "Retry",
			"external.toolCount": "{count} tools",
			"external.serverMeta": "{enabled}/{total} tools enabled",
			"external.discoveredAt": "discovered {time}",
			"external.back": "Back",
			"external.detailHint": "Control whether each tool on this server is exposed to Agents and whether calls need approval.",
			"external.ownedBadge": "Preset-owned",
			"external.disabledNote": "Disabled; not exposed to agents",
			"external.footHint": "Disabling hides the tool from agents' tool lists; approval applies only outside full access.",
			"external.noParams": "No parameters",
			"external.toolsEmpty": "This server has not reported tools yet",
			"field.enabled": "Enabled",
			"field.enabledHint": "Disabling stops the connection and removes the tools from every session immediately.",
			"field.icon": "Server icon",
			"icon.upload": "Upload icon",
			"icon.auto": "Use automatic",
			"icon.hint": "Uses the icon the MCP server declares; otherwise the first letter of the name.",
			"icon.invalidType": "Choose a PNG, JPEG, WebP or GIF image",
			"icon.tooLarge": "Image must be 512 KiB or less",
			"icon.uploadFailed": "Saved, but the icon upload failed: {message}",
			"icon.removed": "Automatic icon restored",
			"icon.autoLabel": "Automatic (from the MCP server)",
			"field.color": "Icon color",
			"field.group": "Group",
			"field.groupPlaceholder": "Pick or type a group name",
			"field.groupNone": "No group",
			"field.name": "Name",
			"field.namePlaceholder": "My MCP",
			"field.nameErrorRequired": "Enter a name",
			"field.nameErrorLong": "The name is at most 80 characters",
			"field.transport": "Transport",
			"field.transportHttpHint": "Connect to an HTTP or HTTPS URL (Streamable HTTP).",
			"field.transportSseHint": "Connect to a URL that serves Server-Sent Events.",
			"field.transportStdioHint": "Start a process on this machine and talk over stdin/stdout.",
			"field.url": "Server URL",
			"field.urlPlaceholder": "http://localhost:3000",
			"field.urlErrorRequired": "Enter the server URL",
			"field.urlErrorInvalid": "Use an absolute URL starting with http:// or https://",
			"field.command": "Command",
			"field.commandPlaceholder": "npx",
			"field.commandErrorRequired": "Enter the command to start",
			"field.args": "Arguments",
			"field.argsPlaceholder": "-y\n@modelcontextprotocol/server-filesystem\n/tmp",
			"field.argsHint": "One argument per line.",
			"field.cwd": "Working directory",
			"field.cwdPlaceholder": "Optional; empty inherits the current directory",
			"field.env": "Environment",
			"field.envEmpty": "No environment variables yet.",
			"field.envName": "Name",
			"field.envValue": "Value",
			"field.envAdd": "Add variable",
			"field.envRemove": "Remove variable",
			"field.timeout": "Request timeout",
			"field.timeoutUnit": "ms",
			"field.timeoutHint": "Longest wait for one tool call, 1000–600000.",
			"field.timeoutError": "The timeout must be an integer from 1000 to 600000",

			"headers.empty": "No custom headers yet",
			"headers.name": "Name",
			"headers.value": "Value",
			"headers.namePlaceholder": "Authorization",
			"headers.valuePlaceholder": "Bearer xxxxxx",
			"headers.add": "Add header",
			"headers.remove": "Remove header",
			"headers.errorRequired": "Name the header before giving it a value",
			"headers.errorInvalid": "The header name contains invalid characters",
			"headers.errorDuplicate": "Duplicate header name",
			"headers.errorValueLong": "A header value is at most 4096 characters",
			"headers.errorLimit": "At most 20 headers",

			"oauth.title": "OAuth settings",
			"oauth.mode": "Mode",
			"oauth.none": "Disabled",
			"oauth.bearer": "Bearer",
			"oauth.clientCredentials": "Client credentials",
			"oauth.token": "Access token",
			"oauth.tokenPlaceholder": "Paste an access token",
			"oauth.tokenUrl": "Token URL",
			"oauth.tokenUrlPlaceholder": "https://idp.example.com/token",
			"oauth.clientId": "Client ID",
			"oauth.clientSecret": "Client secret",
			"oauth.scope": "Scope",
			"oauth.scopePlaceholder": "mcp.read",
			"oauth.configure": "Configure",
			"oauth.summaryNone": "Not enabled",
			"oauth.summaryBearer": "Bearer token",
			"oauth.summaryClientCredentials": "Client credentials",
			"oauth.hint": "A custom Authorization header takes precedence over the token configured here.",
			"oauth.done": "Done",
			"oauth.cancel": "Cancel",

			"presets.all": "All presets",
			"presets.allHint": "Every session gets these tools, including agents without a preset.",
			"presets.specific": "Selected presets",
			"presets.specificHint": "Only the checked presets get these tools.",
			"presets.empty": "This profile provides no Agent presets.",
			"presets.emptyHint": "Presets come from the Harness agentPresets service; without it only “All presets” is available.",
			"presets.noneSelected": "No preset selected: these tools are not exposed to any session.",
			"presets.selectedCount": "{count} selected",
			"presets.unknown": "A selected preset no longer exists; choose again",
			"presets.errorMax": "Select at most 40 presets",
			"presets.noDescription": "No description",

			"test.title": "Test result",
			"test.success": "Connected",
			"test.failure": "Connection failed",
			"test.tools": "{count} tool(s) discovered",
			"test.transport": "Transport",
			"test.noStatus": "The Host returned no connection status",
			"test.close": "Close",
			"test.rerun": "Test again",

			"toast.dismiss": "Dismiss",
			"common.close": "Close",
			"common.required": "Required",
			"common.loading": "Loading…",
		};

		/* ================================================================ */
		/* styles                                                            */
		/* ================================================================ */

		const CSS = `
.mm-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:13px;line-height:1.5;overflow:hidden;}
.mm-root *{box-sizing:border-box;}
.mm-root button,.mm-root input,.mm-root select,.mm-root textarea{font-family:inherit;}
.mm-root :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px;}
.mm-scroll{flex:1;min-height:0;overflow:auto;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent;scrollbar-gutter:stable;}
.mm-page{display:flex;flex-direction:column;gap:22px;width:100%;max-width:960px;min-height:100%;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px;}
.mm-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:16px;padding-top:28px;}
.mm-headMain{min-width:0;}
.mm-title{margin:0;font-size:20px;font-weight:600;line-height:28px;}
.mm-subtitle{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;}
.mm-version{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:0 8px;color:var(--dsw-alias-label-caption);font-size:11px;line-height:17px;}
.mm-headActions{display:flex;flex:none;align-items:center;gap:8px;}
.mm-banner{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border:1px solid transparent;border-radius:var(--dsw-radius-md);font-size:12.5px;line-height:18px;}
.mm-banner[data-kind="error"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 22%,transparent);color:var(--dsw-alias-state-error-primary);}
.mm-banner[data-kind="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 24%,transparent);color:var(--dsw-alias-state-success-primary);}
.mm-bannerText{flex:1;min-width:0;overflow-wrap:anywhere;}
.mm-bannerDismiss{flex:none;border:0;background:none;color:inherit;cursor:pointer;padding:0;font:inherit;font-size:15px;line-height:18px;opacity:.8;}
.mm-bannerDismiss:hover{opacity:1;}

.mm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:8px 14px;background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:18px;white-space:nowrap;cursor:pointer;transition:background .12s ease,border-color .12s ease,color .12s ease;}
.mm-btn:hover{background:var(--dsw-alias-interactive-bg-hover);}
.mm-btn:disabled{opacity:.5;cursor:not-allowed;}
.mm-btnPrimary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);}
.mm-btnPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}
.mm-btnDanger{border-color:var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-state-error-primary);}
.mm-btnDanger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);}
.mm-btnGhost{border-color:transparent;}
.mm-btnSm{padding:5px 10px;font-size:12px;line-height:16px;}
.mm-iconBtn{display:inline-flex;flex:none;align-items:center;justify-content:center;width:32px;height:32px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:18px;line-height:1;cursor:pointer;}
.mm-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.mm-link{border:0;background:none;padding:0;color:var(--dsw-alias-link);font:inherit;font-size:12.5px;line-height:18px;white-space:nowrap;cursor:pointer;}
.mm-link:hover{text-decoration:underline;}
.mm-pill{display:inline-flex;align-items:center;gap:6px;border:1px dashed var(--dsw-alias-border-l3);border-radius:999px;padding:6px 14px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:18px;cursor:pointer;}
.mm-pill:hover{border-style:solid;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}

.mm-group{display:flex;flex-direction:column;gap:10px;}
.mm-groupHead{display:flex;align-items:center;gap:8px;padding:0 4px;}
.mm-groupTitle{margin:0;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-secondary);}
.mm-groupCount{border-radius:999px;padding:1px 8px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;}
.mm-cards{display:flex;flex-direction:column;gap:12px;margin:0;padding:0;list-style:none;}
.mm-card{position:relative;padding:18px 20px;border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);box-shadow:var(--dsw-elevation-soft);}
.mm-cardRow{display:flex;align-items:flex-start;gap:16px;}
.mm-tileWrap{position:relative;flex:none;}
.mm-tile{display:flex;align-items:center;justify-content:center;width:64px;height:64px;border:1px solid color-mix(in srgb,var(--mm-tint) 30%,transparent);border-radius:var(--dsw-radius-lg);background:color-mix(in srgb,var(--mm-tint) 16%,var(--dsw-alias-bg-module-platform));color:var(--mm-tint);cursor:default;user-select:none;--mm-tint:var(--dsw-alias-label-tertiary);}
.mm-tileImage{width:42px;height:42px;object-fit:contain;border-radius:var(--dsw-radius-sm);display:block;}
.mm-tileLetter{font-size:24px;font-weight:600;line-height:1;}
.mm-dot{position:absolute;left:-3px;bottom:-3px;width:15px;height:15px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);box-shadow:0 0 0 3px var(--dsw-alias-settings-card-fill);}
.mm-dot[data-tone="ok"]{background:var(--dsw-alias-state-success-primary);}
.mm-dot[data-tone="error"]{background:var(--dsw-alias-state-error-primary);}
.mm-dot[data-tone="warn"]{background:var(--dsw-alias-state-warn-primary);}
.mm-cardMain{flex:1;min-width:0;padding-top:1px;}
.mm-cardTitle{margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:18px;font-weight:600;line-height:24px;}
.mm-statusLine{display:flex;flex-wrap:wrap;align-items:center;gap:2px 6px;margin:6px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:18px;}
.mm-statusWord{font-weight:500;}
.mm-statusWord[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);}
.mm-statusWord[data-tone="error"]{color:var(--dsw-alias-state-error-primary);}
.mm-statusWord[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);}
.mm-statusWord[data-tone="idle"]{color:var(--dsw-alias-label-caption);}
.mm-statusSep{color:var(--dsw-alias-label-caption);}
.mm-cardActions{position:relative;display:flex;flex:none;align-items:center;gap:4px;}
.mm-menu{position:absolute;top:36px;right:0;z-index:20;display:flex;flex-direction:column;gap:2px;min-width:184px;padding:6px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent);}
.mm-menuItem{display:flex;align-items:center;gap:8px;width:100%;padding:7px 10px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;text-align:left;cursor:pointer;}
.mm-menuItem:hover{background:var(--dsw-alias-interactive-bg-hover);}
.mm-menuItemDanger{color:var(--dsw-alias-state-error-primary);}
.mm-menuItemDanger:hover{background:var(--dsw-alias-interactive-bg-hover-danger);}
.mm-menuSep{height:1px;margin:4px 2px;background:var(--dsw-alias-border-l2);}
.mm-errorRow{display:flex;align-items:flex-start;gap:8px;margin-top:14px;padding:10px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 22%,transparent);border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);}
.mm-errorIcon{display:inline-flex;flex:none;margin-top:1px;color:var(--dsw-alias-state-error-primary);}
.mm-errorText{display:-webkit-box;flex:1;min-width:0;overflow:hidden;color:var(--dsw-alias-state-error-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:17px;overflow-wrap:anywhere;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
.mm-errorLink{flex:none;align-self:flex-start;margin-top:1px;}

.mm-empty{display:flex;flex-direction:column;align-items:center;gap:10px;padding:48px 24px;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);text-align:center;}
.mm-emptyGlyph{display:flex;align-items:center;justify-content:center;width:72px;height:72px;margin-bottom:4px;border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary);}
.mm-emptyTitle{margin:0;font-size:17px;font-weight:600;line-height:24px;}
.mm-emptyHint{max-width:440px;margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;}
.mm-empty .mm-btn{margin-top:6px;}
.mm-skeletonCard{display:flex;gap:16px;padding:18px 20px;border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);}
.mm-skelTile{flex:none;width:64px;height:64px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-skeleton);}
.mm-skelCol{display:flex;flex:1;flex-direction:column;justify-content:center;gap:8px;min-width:0;}
.mm-skel{height:12px;border-radius:999px;background:var(--dsw-alias-bg-skeleton);}

.mm-formHead{display:flex;align-items:center;gap:10px;padding-top:22px;}
.mm-formHeadMain{min-width:0;}
.mm-formTitle{margin:0;font-size:20px;font-weight:600;line-height:28px;}
.mm-formSubtitle{margin:3px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:18px;overflow-wrap:anywhere;}
.mm-section{padding:6px 20px;border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);box-shadow:var(--dsw-elevation-soft);}
.mm-sectionHead{padding:16px 0 2px;}
.mm-sectionTitle{margin:0;font-size:15px;font-weight:600;line-height:22px;}
.mm-sectionHint{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}
.mm-row{display:flex;align-items:center;gap:16px;padding:14px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);}
.mm-row:last-child{border-bottom:0;}
.mm-rowTop{align-items:flex-start;padding-top:16px;}
.mm-rowStack{display:block;}
.mm-rowLabel{flex:none;width:132px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;}
.mm-rowControl{display:flex;flex:1;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;min-width:0;}
.mm-rowStack .mm-rowControl{display:block;margin-top:8px;}
.mm-controlCol{display:flex;flex-direction:column;gap:4px;width:100%;max-width:440px;min-width:0;}
.mm-rowStack .mm-controlCol{max-width:none;}
.mm-input,.mm-textarea,.mm-select{width:100%;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:8px 11px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:18px;transition:border-color .12s ease;}
.mm-input:hover,.mm-textarea:hover,.mm-select:hover{border-color:var(--dsw-alias-border-l4);}
.mm-input:focus,.mm-textarea:focus,.mm-select:focus{border-color:var(--dsw-alias-state-business-primary);}
.mm-input[aria-invalid="true"],.mm-textarea[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary);}
.mm-textarea{min-height:84px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12.5px;line-height:1.6;}
.mm-select{appearance:auto;cursor:pointer;}
.mm-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;}
.mm-fieldError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:11.5px;line-height:16px;}
.mm-switch{display:inline-flex;align-items:center;gap:10px;border:0;background:none;padding:0;color:inherit;font:inherit;font-size:13px;line-height:20px;cursor:pointer;}
.mm-switchTrack{position:relative;flex:none;width:46px;height:28px;border:1px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-module-platform);transition:background .15s ease,border-color .15s ease;}
.mm-switch[aria-checked="true"] .mm-switchTrack{border-color:transparent;background:var(--dsw-alias-state-success-primary);}
.mm-switchThumb{position:absolute;top:2px;left:2px;width:22px;height:22px;border-radius:50%;background:var(--dsw-alias-switch-thumb);box-shadow:var(--dsw-elevation-soft);transition:transform .15s ease;}
.mm-switch[aria-checked="true"] .mm-switchThumb{transform:translateX(18px);}
.mm-switch:disabled{opacity:.45;cursor:not-allowed;}
.mm-segmented{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);}
.mm-segment{border:0;border-radius:calc(var(--dsw-radius-md) - 3px);padding:6px 18px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;font-weight:500;line-height:18px;cursor:pointer;transition:background .12s ease,color .12s ease;}
.mm-segment:hover{color:var(--dsw-alias-label-primary);}
.mm-segment[aria-pressed="true"]{background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-soft);}
.mm-iconRow{display:flex;align-items:center;gap:12px;width:100%;}
.mm-iconPreview{display:flex;flex:none;align-items:center;justify-content:center;width:52px;height:52px;border:1px solid color-mix(in srgb,var(--mm-tint) 30%,transparent);border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--mm-tint) 16%,var(--dsw-alias-bg-module-platform));color:var(--mm-tint);font-size:25px;line-height:1;--mm-tint:var(--dsw-alias-label-tertiary);}
.mm-iconPreviewImage{width:36px;height:36px;object-fit:contain;border-radius:var(--dsw-radius-xs);display:block;}
.mm-iconMeta{display:flex;flex:1;flex-direction:column;gap:8px;min-width:0;}
.mm-swatches{display:flex;flex-wrap:wrap;gap:8px;}
.mm-swatch{width:24px;height:24px;padding:0;border:2px solid transparent;border-radius:50%;background:var(--mm-tint);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l3);cursor:pointer;--mm-tint:var(--dsw-alias-label-tertiary);}
.mm-swatch[aria-pressed="true"]{border-color:var(--dsw-alias-label-primary);}
.mm-iconActions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;}
.mm-iconPreviewLetter{font-size:21px;font-weight:600;line-height:1;}
.mm-iconAuto{margin:0;font-size:12px;line-height:16px;color:var(--dsw-alias-label-caption);}
.mm-box{display:flex;flex-direction:column;gap:8px;width:100%;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);}
.mm-boxEmpty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}
.mm-boxRow{display:flex;align-items:flex-start;gap:8px;}
.mm-boxRow .mm-input{flex:1;min-width:0;}
.mm-boxRow .mm-inputName{flex:0 1 38%;}
.mm-boxRow .mm-iconBtn{width:30px;height:30px;color:var(--dsw-alias-label-tertiary);}
.mm-boxError{margin:-4px 0 0;color:var(--dsw-alias-state-error-primary);font-size:11.5px;line-height:16px;}
.mm-inlineControls{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;width:100%;}
.mm-oauthSummary{display:inline-flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px;}
.mm-badge{border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:1px 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;}
.mm-badgeOn{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent);color:var(--dsw-alias-state-success-primary);}
.mm-choices{display:flex;flex-direction:column;gap:8px;width:100%;max-width:560px;}
.mm-choice{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);cursor:pointer;}
.mm-choice:hover{border-color:var(--dsw-alias-border-l3);}
.mm-choice[data-checked="true"]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-button-primary-dimmed);}
.mm-choice input{flex:none;width:16px;height:16px;margin:2px 0 0;accent-color:var(--dsw-alias-state-business-primary);}
.mm-choiceMain{display:flex;flex-direction:column;gap:2px;min-width:0;}
.mm-choiceTitle{font-size:13px;font-weight:500;line-height:18px;overflow-wrap:anywhere;}
.mm-choiceDesc{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;overflow-wrap:anywhere;}
.mm-choiceCount{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:18px;white-space:nowrap;}
.mm-presetHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;}
.mm-presetWarn{margin:0;color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));font-size:11.5px;line-height:16px;}
.mm-tabs{display:flex;align-items:center;padding-top:2px;}
.mm-pageTabs{justify-content:flex-start;}
.mm-pageBody{display:flex;flex-direction:column;gap:22px;}

.mm-externalIntro{display:flex;flex-direction:column;gap:4px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-fill-l1);}
.mm-externalTitle{margin:0;font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);}
.mm-externalIntroText{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:19px;overflow-wrap:anywhere;}
.mm-externalBar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}
.mm-externalScanned{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;}
.mm-externalPreset{display:flex;flex-direction:column;gap:12px;padding:14px 18px;border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);box-shadow:var(--dsw-elevation-soft);}
.mm-externalPresetHead{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap;}
.mm-externalPresetTitle{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}
.mm-externalPresetName{margin:0;font-size:15px;font-weight:600;line-height:22px;}
.mm-externalPresetId{font-family:"SFMono-Regular",ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);}
.mm-externalServers{gap:10px;}
.mm-externalServerCard{display:block;width:100%;color:inherit;font:inherit;text-align:left;cursor:pointer;}
.mm-externalServerCard:hover{border-color:var(--dsw-alias-border-l3);}
.mm-externalServerCard:focus-visible{outline:2px solid var(--dsw-alias-state-success-primary);outline-offset:2px;}
.mm-externalServerCard .mm-statusWord{color:var(--dsw-alias-label-tertiary);font-weight:400;}
.mm-externalTile{width:56px;height:56px;cursor:inherit;}
.mm-externalChevron{display:flex;flex:none;align-self:center;color:var(--dsw-alias-label-caption);font-size:22px;line-height:1;}
.mm-externalPendingTitle{margin:0;font-size:12.5px;line-height:18px;font-weight:500;color:var(--dsw-alias-label-secondary);}
.mm-externalPendingHint{margin:4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}
.mm-externalFoot{display:flex;flex-direction:column;gap:10px;padding-top:6px;}
.mm-tabs .mm-segmented{flex:1;}
.mm-tabs .mm-segment{flex:1;}
.mm-tabPanel{display:flex;flex-direction:column;gap:22px;}

.mm-toolList{display:flex;flex-direction:column;gap:10px;padding:2px 0 4px;}
.mm-toolCard{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);}
.mm-toolCard[data-enabled="false"]{opacity:.68;}
.mm-toolHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}
.mm-toolName{font-family:"SFMono-Regular",ui-monospace,Menlo,Consolas,monospace;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;}
.mm-toolDesc{margin:0;font-size:13px;line-height:19px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;overflow-wrap:anywhere;max-height:96px;overflow:auto;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent;}
.mm-toolParams{display:flex;flex-wrap:wrap;align-items:center;gap:6px;}
.mm-toolParamsLabel{margin-right:2px;color:var(--dsw-alias-label-caption);font-size:11.5px;line-height:16px;}
.mm-paramChip{display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary);font-family:"SFMono-Regular",ui-monospace,Menlo,Consolas,monospace;font-size:11px;line-height:16px;}
.mm-paramChip[data-required="true"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary);font-weight:600;}
.mm-paramFlag{font-family:inherit;font-weight:400;font-size:10px;line-height:14px;opacity:.8;}
.mm-toolNoParams{margin:0;color:var(--dsw-alias-label-caption);font-size:12px;line-height:16px;}
.mm-toolFoot{display:flex;flex-direction:column;gap:6px;padding-top:2px;border-top:1px solid var(--dsw-alias-border-l4);}
.mm-toolApproval{display:flex;align-items:center;gap:8px;padding-top:10px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px;}
.mm-toolApprovalLabel{font-weight:500;color:var(--dsw-alias-label-primary);}
.mm-toolDisabledNote{margin:0;font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-caption);}
.mm-toolsBar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:8px 0 2px;}
.mm-toolsCount{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:18px;}
.mm-toolsNote{margin:0;padding:8px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;}
.mm-toolsLoading{margin:0;padding:18px 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:19px;}
.mm-toolsEmpty{margin:0;padding:18px 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:19px;}
.mm-toolsActions{display:flex;gap:10px;padding-top:10px;}
.mm-toolsNotice{margin:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-state-error-primary);}
.mm-toolsNoticeOk{color:var(--dsw-alias-state-success-primary);}
.mm-toolsFoot{display:flex;flex-direction:column;gap:10px;padding:12px 0 48px;}

.mm-formFoot{display:flex;flex-direction:column;gap:10px;padding:2px 0 48px;}
.mm-save{width:100%;padding:12px 16px;border-radius:var(--dsw-radius-lg);font-size:15px;font-weight:600;line-height:20px;}
.mm-formFootRow{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px;}
.mm-formFootHint{color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:16px;}

.mm-overlay{position:fixed;inset:0;z-index:80;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1);}
.mm-dialog{display:flex;flex-direction:column;gap:14px;width:100%;max-width:560px;max-height:min(82vh,720px);overflow:auto;padding:20px 22px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-prominent);outline:none;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent;}
.mm-dialogWide{max-width:640px;}
.mm-dialogHead{display:flex;align-items:flex-start;gap:12px;}
.mm-dialogTitle{flex:1;min-width:0;margin:0;font-size:17px;font-weight:600;line-height:24px;}
.mm-dialogBody{display:flex;flex-direction:column;gap:12px;min-width:0;}
.mm-dialogText{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;}
.mm-dialogField{display:flex;flex-direction:column;gap:6px;min-width:0;}
.mm-dialogLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;}
.mm-dialogBody .mm-input{max-width:none;}
.mm-dialogBody .mm-hint{max-width:none;}
.mm-dialogFoot{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:10px;}
.mm-facts{display:grid;grid-template-columns:96px 1fr;gap:8px 12px;margin:0;font-size:12.5px;line-height:18px;}
.mm-factLabel{margin:0;color:var(--dsw-alias-label-tertiary);}
.mm-factValue{margin:0;min-width:0;overflow-wrap:anywhere;}
.mm-pre{margin:0;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;}
.mm-testStatus{display:flex;align-items:center;gap:10px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);font-size:14px;font-weight:600;line-height:20px;}
.mm-testStatus[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,transparent);}
.mm-testStatus[data-tone="error"]{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 30%,transparent);}
.mm-testStatus[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 30%,transparent);}

.mm-tile[data-color="blue"],.mm-swatch[data-color="blue"]{--mm-tint:var(--dsw-alias-state-business-primary);}
.mm-tile[data-color="violet"],.mm-swatch[data-color="violet"]{--mm-tint:color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,var(--dsw-alias-state-error-secondary));}
.mm-tile[data-color="teal"],.mm-swatch[data-color="teal"]{--mm-tint:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,var(--dsw-alias-state-success-primary));}
.mm-tile[data-color="green"],.mm-swatch[data-color="green"]{--mm-tint:var(--dsw-alias-state-success-primary);}
.mm-tile[data-color="amber"],.mm-swatch[data-color="amber"]{--mm-tint:var(--dsw-alias-state-warn-primary);}
.mm-tile[data-color="rose"],.mm-swatch[data-color="rose"]{--mm-tint:var(--dsw-alias-state-error-secondary);}
.mm-tile[data-color="slate"],.mm-swatch[data-color="slate"]{--mm-tint:var(--dsw-alias-label-tertiary);}

@media (max-width:640px){
.mm-card{padding:16px;}
.mm-cardRow{gap:12px;}
.mm-tile{width:54px;height:54px;}
.mm-tileImage{width:36px;height:36px;}
.mm-cardTitle{font-size:16px;line-height:22px;}
.mm-row{flex-direction:column;align-items:stretch;gap:6px;}
.mm-rowLabel{width:auto;}
.mm-rowControl{justify-content:flex-start;}
.mm-controlCol{max-width:none;}
.mm-choices{max-width:none;}
.mm-facts{grid-template-columns:1fr;}
.mm-formFootRow{flex-direction:column;align-items:stretch;}
.mm-formFootRow .mm-btn{width:100%;}
}
`;

		/**
		 * Install the one stylesheet tag this plugin owns and remove it on dispose.
		 * @returns {() => void} the release function.
		 */
		function mountCss() {
			if (typeof document === "undefined") return () => {};
			let tag = document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]');
			if (!tag) {
				tag = document.createElement("style");
				tag.dataset.pluginCss = CSS_TAG;
				tag.dataset.plugin = "@ds-hu/dsh-better-mcp-manager";
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
			return () => {
				if (tag && tag.parentNode) tag.parentNode.removeChild(tag);
			};
		}

		/* ================================================================ */
		/* glyphs                                                            */
		/* ================================================================ */

		function svg(props) {
			const size = props.size || 16;
			const children = Array.prototype.slice.call(arguments, 1);
			return h("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: props.strokeWidth || 1.7,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				focusable: "false",
			}, ...(children.length > 0 ? children : (props.children === undefined ? [] : [props.children])));
		}

		function PlugGlyph(props) {
			return svg({ size: props && props.size, strokeWidth: 1.6 },
				h("path", { d: "M4.5 8.5h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z" }),
				h("path", { d: "M14.5 11.5h2.2M14.5 15.5h2.2" }),
				h("path", { d: "M6.5 8.5V6.2M10.5 8.5V6.2" }),
				h("path", { d: "M17.5 4v4M20.5 4v7M21 13.5v6.5" }),
				h("circle", { cx: 17.5, cy: 6.2, r: 1.1 }),
				h("circle", { cx: 20.9, cy: 11.1, r: 1.1 }));
		}

		function PlusGlyph(props) {
			return svg({ size: props && props.size },
				h("path", { d: "M12 5v14M5 12h14" }));
		}

		function AlertGlyph(props) {
			const size = props && props.size ? props.size : 16;
			return svg({ size, strokeWidth: 1.7 },
				h("path", { d: "M12 4.5 21 20H3L12 4.5Z" }),
				h("path", { d: "M12 10v4.2" }),
				h("circle", { cx: 12, cy: 17.2, r: 0.9, fill: "currentColor", stroke: "none" }));
		}

		function TrashGlyph(props) {
			return svg({ size: props && props.size },
				h("path", { d: "M4 7h16M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" }),
				h("path", { d: "M6.5 7l.8 11.4A1.6 1.6 0 0 0 8.9 20h6.2a1.6 1.6 0 0 0 1.6-1.6L17.5 7" }),
				h("path", { d: "M10.5 11v5M13.5 11v5" }));
		}

		function BackGlyph(props) {
			return svg({ size: props && props.size },
				h("path", { d: "M14.5 5 7.5 12l7 7" }));
		}

		function CheckGlyph(props) {
			return svg({ size: props && props.size, strokeWidth: 2 },
				h("path", { d: "m5 12.5 4.5 4.5L19 7" }));
		}

		function CloseGlyph(props) {
			return svg({ size: props && props.size },
				h("path", { d: "M6 6l12 12M18 6 6 18" }));
		}

		function RefreshGlyph(props) {
			return svg({ size: props && props.size },
				h("path", { d: "M20 12a8 8 0 1 1-2.6-5.9" }),
				h("path", { d: "M20 4v5h-5" }));
		}

		function LockGlyph(props) {
			return svg({ size: props && props.size },
				h("rect", { x: "5", y: "10.5", width: "14", height: "9.5", rx: "2.5" }),
				h("path", { d: "M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" }),
				h("circle", { cx: "12", cy: "15.2", r: "1.1", fill: "currentColor", stroke: "none" }));
		}

		function MoreGlyph(props) {
			const size = props && props.size ? props.size : 18;
			return svg({ size, strokeWidth: 0 },
				h("circle", { cx: 5.5, cy: 12, r: 1.5, fill: "currentColor" }),
				h("circle", { cx: 12, cy: 12, r: 1.5, fill: "currentColor" }),
				h("circle", { cx: 18.5, cy: 12, r: 1.5, fill: "currentColor" }));
		}

		/** The sidebar row icon: decorative; the sidebar owns the accessible label. */
		function MCPPanelIcon(props) {
			return h(PlugGlyph, { size: props && props.size ? props.size : 16 });
		}

		/* ================================================================ */
		/* primitive controls                                                */
		/* ================================================================ */

		function FieldError(props) {
			if (!props.message) return null;
			return h("p", { className: "mm-fieldError", id: props.id, role: "alert" }, props.message);
		}

		function Hint(props) {
			if (!props.text) return null;
			return h("p", { className: "mm-hint" }, props.text);
		}

		/**
		 * A text field with an optional error message.
		 * @param {any} props - value, onChange, label (aria), placeholder, error, inputRef, type.
		 * @returns {any} the field element.
		 */
		function TextField(props) {
			const id = props.id;
			const errorId = errorIdFor(id);
			const input = h("input", {
				ref: props.inputRef,
				className: "mm-input",
				"data-testid": props.testId,
				type: props.type || "text",
				value: props.value === undefined || props.value === null ? "" : props.value,
				placeholder: props.placeholder,
				"aria-label": props.ariaLabel || props.placeholder || undefined,
				"aria-invalid": props.error ? "true" : undefined,
				"aria-describedby": props.error ? errorId : undefined,
				maxLength: props.maxLength,
				spellCheck: props.spellCheck === undefined ? false : props.spellCheck,
				autoComplete: props.autoComplete || "off",
				disabled: props.disabled,
				onChange: (event) => props.onChange(event.target.value),
				onKeyDown: props.onKeyDown,
			});
			return h("div", { className: "mm-controlCol" },
				props.prefix ? h("div", { className: "mm-inlineControls" }, props.prefix, input) : input,
				h(FieldError, { id: errorId, message: props.error }),
				props.hint ? h(Hint, { text: props.hint }) : null);
		}

		function errorIdFor(id) {
			return id ? id + "-error" : undefined;
		}

		function TextAreaField(props) {
			const id = props.id;
			const errorId = errorIdFor(id);
			return h("div", { className: "mm-controlCol" },
				h("textarea", {
					className: "mm-textarea",
					"data-testid": props.testId,
					value: props.value === undefined || props.value === null ? "" : props.value,
					placeholder: props.placeholder,
					"aria-label": props.ariaLabel || props.placeholder || undefined,
					"aria-invalid": props.error ? "true" : undefined,
					"aria-describedby": props.error ? errorId : undefined,
					rows: props.rows || 4,
					spellCheck: false,
					onChange: (event) => props.onChange(event.target.value),
				}),
				h(FieldError, { id: errorId, message: props.error }),
				props.hint ? h(Hint, { text: props.hint }) : null);
		}

		function Switch(props) {
			return h("button", {
				type: "button",
				role: "switch",
				className: "mm-switch",
				"data-testid": props.testId,
				"aria-checked": props.checked === true ? "true" : "false",
				"aria-label": props.label,
				disabled: props.disabled,
				onClick: () => props.onChange(!props.checked),
			},
			h("span", { className: "mm-switchTrack", "aria-hidden": "true" },
				h("span", { className: "mm-switchThumb" })),
			props.text ? h("span", null, props.text) : null);
		}

		function Segmented(props) {
			return h("div", { className: "mm-segmented", role: "group", "aria-label": props.label },
				props.options.map((option) => h("button", {
					key: option.value,
					type: "button",
					className: "mm-segment",
					"data-testid": option.testId,
					"aria-pressed": props.value === option.value ? "true" : "false",
					onClick: () => props.onChange(option.value),
				}, option.label)));
		}

		function RadioRow(props) {
			return h("label", { className: "mm-choice", "data-checked": props.checked ? "true" : "false" },
				h("input", {
					type: "radio",
					name: props.name,
					"data-testid": props.testId,
					checked: props.checked === true,
					onChange: () => props.onChange(),
				}),
				h("span", { className: "mm-choiceMain" },
					h("span", { className: "mm-choiceTitle" }, props.title),
					props.description ? h("span", { className: "mm-choiceDesc" }, props.description) : null));
		}

		function CheckRow(props) {
			return h("label", { className: "mm-choice", "data-checked": props.checked ? "true" : "false" },
				h("input", {
					type: "checkbox",
					"data-testid": props.testId,
					checked: props.checked === true,
					onChange: (event) => props.onChange(event.target.checked),
				}),
				h("span", { className: "mm-choiceMain" },
					h("span", { className: "mm-choiceTitle" }, props.title),
					props.description ? h("span", { className: "mm-choiceDesc" }, props.description) : null));
		}

		let dialogSeq = 0;

		/**
		 * A modal dialog: role=dialog, Escape closes, focus enters and returns to the trigger.
		 * Rendered inline (not through a portal) so it unmounts with the page.
		 */
		function Modal(props) {
			const panelRef = useRef(null);
			const previousFocus = useRef(null);
			const closeRef = useRef(props.onClose);
			closeRef.current = props.onClose;
			const labelRef = useRef(null);
			if (labelRef.current === null) {
				dialogSeq += 1;
				labelRef.current = "mm-dialog-title-" + dialogSeq;
			}
			useEffect(() => {
				previousFocus.current = typeof document !== "undefined" ? document.activeElement : null;
				const node = panelRef.current;
				if (node && typeof node.focus === "function") node.focus();
				const onKeyDown = (event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						closeRef.current();
						return;
					}
					if (event.key !== "Tab" || !node) return;
					const focusables = node.querySelectorAll('button:not(:disabled),[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])');
					const list = Array.prototype.filter.call(focusables, (element) => element.offsetParent !== null);
					if (list.length === 0) {
						event.preventDefault();
						node.focus();
						return;
					}
					const first = list[0];
					const last = list[list.length - 1];
					if (event.shiftKey && document.activeElement === first) {
						event.preventDefault();
						last.focus();
					} else if (!event.shiftKey && document.activeElement === last) {
						event.preventDefault();
						first.focus();
					}
				};
				document.addEventListener("keydown", onKeyDown, true);
				return () => {
					document.removeEventListener("keydown", onKeyDown, true);
					const previous = previousFocus.current;
					if (previous && typeof previous.focus === "function" && previous.isConnected !== false) previous.focus();
				};
			}, []);
			return h("div", {
				className: "mm-overlay",
				onMouseDown: (event) => {
					if (event.target === event.currentTarget) props.onClose();
				},
			},
			h("div", {
				ref: panelRef,
				className: cx("mm-dialog", props.wide ? "mm-dialogWide" : ""),
				role: "dialog",
				"aria-modal": "true",
				"aria-labelledby": labelRef.current,
				"data-testid": props.testId,
				tabIndex: -1,
			},
			h("div", { className: "mm-dialogHead" },
				h("h2", { className: "mm-dialogTitle", id: labelRef.current }, props.title),
				h("button", {
					type: "button",
					className: "mm-iconBtn",
					"data-testid": props.closeTestId,
					"aria-label": t("common.close"),
					onClick: props.onClose,
				}, h(CloseGlyph, { size: 16 }))),
			props.children,
			props.footer ? h("div", { className: "mm-dialogFoot" }, props.footer) : null));
		}
		/* ================================================================ */
		/* server card                                                       */
		/* ================================================================ */

		function ServerTile(props) {
			const server = props.server;
			const url = iconUrlOf(server);
			const [failedUrl, setFailedUrl] = useState("");
			const showImage = url !== "" && failedUrl !== url;
			return h("div", { className: "mm-tileWrap" },
				h("div", {
					className: "mm-tile",
					"data-color": server.color || "blue",
					"aria-hidden": "true",
				},
				showImage
					? h("img", {
						className: "mm-tileImage",
						src: url,
						alt: "",
						loading: "lazy",
						"data-testid": "server-icon",
						onError: () => setFailedUrl(url),
					})
					: h("span", { className: "mm-tileLetter" }, iconLetter(server))),
				h("span", {
					className: "mm-dot",
					"data-tone": props.tone,
					"data-state": props.state,
					"data-testid": "status-dot",
					"aria-hidden": "true",
				}));
		}

		function StatusLine(props) {
			const info = props.info;
			const status = info.status || {};
			const counts = toolCounts(status);
			const parts = [
				h("span", { key: "word", className: "mm-statusWord", "data-tone": info.tone }, t(info.wordKey)),
				h("span", { key: "sep1", className: "mm-statusSep", "aria-hidden": "true" }, "·"),
				h("span", { key: "transport" }, transportLabel(props.server.transport)),
			];
			if (props.server.enabled === true) {
				parts.push(h("span", { key: "sep2", className: "mm-statusSep", "aria-hidden": "true" }, "·"));
				parts.push(h("span", { key: "tools" }, t("card.tools", { count: counts.enabled, total: counts.total })));
			}
			return h("p", { className: "mm-statusLine" }, parts);
		}

		function CardMenu(props) {
			const [open, setOpen] = useState(false);
			const rootRef = useRef(null);
			const buttonRef = useRef(null);
			const firstItemRef = useRef(null);
			useEffect(() => {
				if (!open) return undefined;
				const onPointerDown = (event) => {
					if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key !== "Escape") return;
					setOpen(false);
					if (buttonRef.current) buttonRef.current.focus();
				};
				document.addEventListener("mousedown", onPointerDown);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("mousedown", onPointerDown);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);
			useEffect(() => {
				if (open && firstItemRef.current) firstItemRef.current.focus();
			}, [open]);
			const server = props.server;
			const choose = (action) => {
				setOpen(false);
				props.onAction(action, server);
			};
			const entries = [
				{ key: "edit", label: t("card.menu.edit"), action: "edit", testId: "menu-edit" },
				{ key: "test", label: t("card.menu.test"), action: "test", testId: "menu-test" },
				{ key: "reconnect", label: t("card.menu.reconnect"), action: "reconnect", testId: "menu-reconnect" },
				{ key: "sep1", separator: true },
				{ key: "toggle", label: server.enabled === true ? t("card.menu.disable") : t("card.menu.enable"), action: "toggle", testId: "menu-toggle" },
				{ key: "sep2", separator: true },
				{ key: "delete", label: t("card.menu.delete"), action: "delete", testId: "menu-delete", danger: true },
			];
			return h("div", { className: "mm-cardActions", ref: rootRef },
				h("button", {
					type: "button",
					ref: buttonRef,
					className: "mm-iconBtn",
					"data-testid": "server-menu",
					"aria-label": t("card.menu"),
					"aria-haspopup": "menu",
					"aria-expanded": open ? "true" : "false",
					onClick: () => setOpen(!open),
				}, h(MoreGlyph, { size: 18 })),
				open
					? h("div", { className: "mm-menu", role: "menu", "aria-label": t("card.menu") },
						entries.map((entry, index) => entry.separator
							? h("div", { key: entry.key, className: "mm-menuSep", role: "separator" })
							: h("button", {
								key: entry.key,
								ref: index === 0 ? firstItemRef : undefined,
								type: "button",
								role: "menuitem",
								className: cx("mm-menuItem", entry.danger ? "mm-menuItemDanger" : ""),
								"data-testid": entry.testId,
								onClick: () => choose(entry.action),
							}, entry.label)))
					: null);
		}

		function ServerCard(props) {
			const server = props.server;
			const info = statusFor(server);
			const error = (info.state === "error" || info.state === "retrying") && info.status.error ? info.status.error : null;
			return h("li", {
				className: "mm-card",
				"data-server-id": server.id,
				"data-testid": "server-card",
				"data-server-name": server.name || server.key || "",
			},
				h("div", { className: "mm-cardRow" },
					h(ServerTile, { server, tone: info.tone, state: info.state }),
					h("div", { className: "mm-cardMain" },
						h("h3", { className: "mm-cardTitle", title: server.name || server.key }, server.name || server.key || server.id),
						h(StatusLine, { server, info })),
					h(CardMenu, { server, onAction: props.onAction })),
				error
					? h("div", { className: "mm-errorRow" },
						h("span", { className: "mm-errorIcon" }, h(AlertGlyph, { size: 15 })),
						h("span", { className: "mm-errorText" }, error.message || error.code || ""),
						h("button", {
							type: "button",
							className: "mm-link mm-errorLink",
							"data-testid": "detail-error",
							onClick: () => props.onShowError(server),
						}, t("card.details")))
					: null);
		}

		/* ================================================================ */
		/* banners, empty state, skeleton                                    */
		/* ================================================================ */

		function Banner(props) {
			return h("div", {
				className: "mm-banner",
				"data-kind": props.banner.kind,
				role: props.banner.kind === "error" ? "alert" : "status",
			},
			h("span", { className: "mm-bannerText" }, props.banner.message),
			h("button", {
				type: "button",
				className: "mm-bannerDismiss",
				"aria-label": t("toast.dismiss"),
				onClick: props.onDismiss,
			}, h(CloseGlyph, { size: 14 })));
		}

		function ListSkeleton() {
			return h("div", { className: "mm-cards", "aria-hidden": "true" },
				[0, 1, 2].map((index) => h("div", { key: index, className: "mm-skeletonCard" },
					h("div", { className: "mm-skelTile" }),
					h("div", { className: "mm-skelCol" },
						h("div", { className: "mm-skel", style: { width: "34%" } }),
						h("div", { className: "mm-skel", style: { width: "58%" } })))));
		}

		function EmptyState(props) {
			return h("div", { className: "mm-empty" },
				h("div", { className: "mm-emptyGlyph" }, h(PlugGlyph, { size: 34 })),
				h("h2", { className: "mm-emptyTitle" }, t("list.emptyTitle")),
				h("p", { className: "mm-emptyHint" }, t("list.emptyHint")),
				h("button", {
					type: "button",
					className: "mm-btn mm-btnPrimary",
					"data-testid": "add-mcp-empty",
					onClick: props.onAdd,
				}, h(PlusGlyph, { size: 15 }), t("list.emptyAction")));
		}

		/* ================================================================ */
		/* catalog polling                                                   */
		/* ================================================================ */

		function useCatalog() {
			const [snapshot, setSnapshot] = useState({
				status: "loading",
				servers: [],
				presets: [],
				groups: [],
				version: "",
				dataDir: "",
				error: null,
			});
			const mountedRef = useRef(true);
			const requestRef = useRef(null);
			const load = useCallback((options) => {
				const quiet = Boolean(options && options.quiet);
				if (!mountedRef.current) return Promise.resolve();
				if (requestRef.current) requestRef.current.abort();
				const controller = typeof AbortController === "function" ? new AbortController() : null;
				requestRef.current = controller;
				if (controller) liveRequests.add(controller);
				if (!quiet) {
					setSnapshot((previous) => ({ ...previous, status: previous.servers.length > 0 ? "refreshing" : "loading", error: null }));
				}
				return apiFetch("/servers", { signal: controller ? controller.signal : undefined })
					.then((payload) => {
						if (!mountedRef.current || (controller && controller.signal.aborted)) return;
						setSnapshot({
							status: "ready",
							servers: Array.isArray(payload.servers) ? payload.servers : [],
							presets: Array.isArray(payload.presets) ? payload.presets : [],
							groups: Array.isArray(payload.groups) ? payload.groups : [],
							version: typeof payload.version === "string" ? payload.version : "",
							dataDir: typeof payload.dataDir === "string" ? payload.dataDir : "",
							error: null,
						});
					})
					.catch((failure) => {
						if (!mountedRef.current || isAbortError(failure)) return;
						setSnapshot((previous) => ({
							...previous,
							status: previous.servers.length > 0 ? "ready" : "error",
							error: failure.message || "request failed",
						}));
					})
					.finally(() => {
						if (controller) liveRequests.delete(controller);
						if (requestRef.current === controller) requestRef.current = null;
					});
			}, []);
			useEffect(() => {
				mountedRef.current = true;
				void load();
				const timer = setInterval(() => { void load({ quiet: true }); }, POLL_MS);
				timers.add(timer);
				return () => {
					mountedRef.current = false;
					clearInterval(timer);
					timers.delete(timer);
					if (requestRef.current) requestRef.current.abort();
				};
			}, [load]);
			return { ...snapshot, reload: load };
		}

		/* ================================================================ */
		/* list view                                                         */
		/* ================================================================ */

		function ListView(props) {
			const catalog = props.catalog;
			const headingRef = useRef(null);
			useEffect(() => {
				if (headingRef.current) headingRef.current.focus();
			}, []);
			const servers = Array.isArray(catalog.servers) ? catalog.servers : [];
			const sections = useMemo(() => groupServers(servers), [servers]);
			const total = servers.length;
			const connected = countConnected(servers);
			const loading = catalog.status === "loading" && total === 0;
			return h("div", { className: "mm-scroll", "data-testid": "mcp-list" },
				h("div", { className: "mm-page" },
					h("div", { className: "mm-head" },
						h("div", { className: "mm-headMain" },
							h("h1", { className: "mm-title", ref: headingRef, tabIndex: -1 }, t("page.title")),
							h("p", { className: "mm-subtitle" },
								t("page.subtitle", { total, connected }),
								catalog.version ? h("span", { className: "mm-version" }, t("page.version", { version: catalog.version })) : null)),
						h("div", { className: "mm-headActions" },
							props.pageTab === "external"
								? null
								: h("button", {
									type: "button",
									className: "mm-btn mm-btnPrimary",
									"data-testid": "add-mcp",
									onClick: props.onAdd,
								}, h(PlusGlyph, { size: 15 }), t("page.add")))),
					h("div", { className: "mm-tabs mm-pageTabs" },
						h(Segmented, {
							value: props.pageTab === "external" ? "external" : "owned",
							label: t("page.tabsLabel"),
							options: [
								{ value: "owned", label: t("page.tabOwned"), testId: "page-tab-owned" },
								{ value: "external", label: t("page.tabExternal"), testId: "page-tab-external" },
							],
							onChange: (value) => { if (props.onPageTab) props.onPageTab(value); },
						})),
					props.pageTab === "external"
						? h(ExternalTab)
						: h("div", { className: "mm-pageBody" },
							props.banner ? h(Banner, { banner: props.banner, onDismiss: props.onDismissBanner }) : null,
							catalog.error
								? h("div", { className: "mm-banner", "data-kind": "error", role: "alert" },
									h("span", { className: "mm-bannerText" },
										t("list.error", { message: catalog.error }),
										total > 0 ? " " + t("list.stale") : ""),
									h("button", {
										type: "button",
										className: "mm-btn mm-btnSm",
										onClick: () => { void catalog.reload(); },
									}, t("list.retry")))
								: null,
							loading ? h(ListSkeleton) : null,
							!loading && catalog.status !== "error" && total === 0
								? h(EmptyState, { onAdd: props.onAdd })
								: null,
							!loading && catalog.status === "error" && total === 0
								? h("div", { className: "mm-empty" },
									h("div", { className: "mm-emptyGlyph" }, h(PlugGlyph, { size: 34 })),
									h("p", { className: "mm-emptyHint" }, t("list.loading")))
								: null,
							!loading && total > 0
								? sections.map((section) => h("section", { key: section.key, className: "mm-group" },
									h("div", { className: "mm-groupHead" },
										h("h2", { className: "mm-groupTitle" }, section.name === "" ? t("group.ungrouped") : section.name),
										h("span", { className: "mm-groupCount" }, t("group.count", { count: section.servers.length }))),
									h("ul", { className: "mm-cards" },
										section.servers.map((server) => h(ServerCard, {
											key: server.id,
											server,
											onAction: props.onAction,
											onShowError: props.onShowError,
										})))))
								: null)));
		}

		/* ================================================================ */
		/* dialogs                                                           */
		/* ================================================================ */

		function Facts(props) {
			const children = [];
			for (const row of props.rows || []) {
				if (!row || row.value === undefined || row.value === null || row.value === "") continue;
				children.push(h("dt", { key: row.label + "-label", className: "mm-factLabel" }, row.label));
				children.push(h("dd", { key: row.label + "-value", className: "mm-factValue" }, row.value));
			}
			return h("dl", { className: "mm-facts" }, children);
		}

		function ConfirmDialog(props) {
			return h(Modal, {
				title: props.title,
				testId: "confirm-dialog",
				onClose: props.onCancel,
				footer: [
					h("button", { key: "cancel", type: "button", className: "mm-btn", onClick: props.onCancel }, props.cancelLabel),
					h("button", {
						key: "confirm",
						type: "button",
						className: "mm-btn mm-btnDanger",
						"data-testid": "confirm-delete",
						disabled: props.busy === true,
						onClick: props.onConfirm,
					}, props.busy === true ? t("common.loading") : props.confirmLabel),
				],
			},
			h("div", { className: "mm-dialogBody" },
				h("p", { className: "mm-dialogText" }, props.body)));
		}

		function ErrorDetailDialog(props) {
			const server = props.server;
			const status = (server && server.status) || {};
			const error = status.error || {};
			const rows = [
				{ label: t("error.code"), value: error.code || t("error.none") },
				{ label: t("error.at"), value: formatTime(error.at) || t("error.none") },
				{ label: t("error.attempts"), value: t("error.attemptsValue", { count: Number.isInteger(status.attempts) ? status.attempts : 0 }) },
				{ label: t("error.nextRetry"), value: status.nextRetryAt ? formatTime(status.nextRetryAt) : "" },
			];
			return h(Modal, {
				title: t("error.title"),
				wide: true,
				testId: "error-dialog",
				closeTestId: "error-dialog-close",
				onClose: props.onClose,
				footer: h("button", { type: "button", className: "mm-btn mm-btnPrimary", onClick: props.onClose }, t("error.close")),
			},
			h("div", { className: "mm-dialogBody" },
				h("p", { className: "mm-dialogText" }, t("error.verbatim")),
				h(Facts, { rows }),
				h("span", { className: "mm-dialogLabel" }, t("error.message")),
				h("pre", { className: "mm-pre" }, error.message || t("error.none")),
				error.detail ? h("span", { className: "mm-dialogLabel" }, t("error.detail")) : null,
				error.detail ? h("pre", { className: "mm-pre" }, error.detail) : null));
		}

		function testTone(status) {
			if (!status) return "warn";
			if (status.state === "connected") return "ok";
			if (status.state === "error") return "error";
			return "warn";
		}

		function testWordKey(status) {
			if (!status) return "test.noStatus";
			if (status.state === "connected") return "test.success";
			if (status.state === "error") return "test.failure";
			if (STATUS_META[status.state]) return STATUS_META[status.state].word;
			return "test.noStatus";
		}

		function TestResultDialog(props) {
			const status = props.result && props.result.status ? props.result.status : null;
			const tone = testTone(status);
			const rows = [];
			if (status) {
				const counts = toolCounts(status);
				rows.push({ label: t("test.transport"), value: transportLabel(props.transport) });
				rows.push({ label: t("card.tools"), value: t("card.tools", { count: counts.enabled, total: counts.total }) });
			}
			const error = status && status.error ? status.error : null;
			return h(Modal, {
				title: t("test.title"),
				testId: "test-dialog",
				onClose: props.onClose,
				footer: [
					h("button", {
						key: "again",
						type: "button",
						className: "mm-btn",
						disabled: props.busy === true,
						onClick: props.onRerun,
					}, props.busy === true ? t("form.testing") : t("test.rerun")),
					h("button", { key: "close", type: "button", className: "mm-btn mm-btnPrimary", onClick: props.onClose }, t("test.close")),
				],
			},
			h("div", { className: "mm-dialogBody" },
				h("div", { className: "mm-testStatus", "data-tone": tone, role: "status" },
					status && status.state === "connected"
						? h(CheckGlyph, { size: 16 })
						: h(AlertGlyph, { size: 16 }),
					t(testWordKey(status))),
				h(Facts, { rows }),
				error
					? h("div", { className: "mm-dialogBody" },
						h("span", { className: "mm-dialogLabel" }, t("error.message")),
						h("pre", { className: "mm-pre" }, error.message || error.code || ""),
						error.detail ? h("span", { className: "mm-dialogLabel" }, t("error.detail")) : null,
						error.detail ? h("pre", { className: "mm-pre" }, error.detail) : null)
					: null));
		}

		/* ================================================================ */
		/* OAuth dialog                                                      */
		/* ================================================================ */

		const OAUTH_MODES = [
			{ value: "none", labelKey: "oauth.none" },
			{ value: "bearer", labelKey: "oauth.bearer" },
			{ value: "client_credentials", labelKey: "oauth.clientCredentials" },
		];

		function oauthSummaryKey(oauth) {
			const mode = oauth && oauth.mode;
			if (mode === "bearer") return "oauth.summaryBearer";
			if (mode === "client_credentials") return "oauth.summaryClientCredentials";
			return "oauth.summaryNone";
		}

		function DialogField(props) {
			return h("div", { className: "mm-dialogField" },
				h("span", { className: "mm-dialogLabel" }, props.label),
				props.children);
		}

		function OAuthDialog(props) {
			const [value, setValue] = useState(() => normalizeOAuth(props.value));
			const update = (patch) => setValue((previous) => ({ ...previous, ...patch }));
			const fields = [];
			if (value.mode === "bearer") {
				fields.push(h(DialogField, { key: "token", label: t("oauth.token") },
					h("input", {
						className: "mm-input",
						type: "password",
						"data-testid": "oauth-token",
						value: value.token || "",
						placeholder: t("oauth.tokenPlaceholder"),
						"aria-label": t("oauth.token"),
						autoComplete: "off",
						onChange: (event) => update({ token: event.target.value }),
					})));
			} else if (value.mode === "client_credentials") {
				fields.push(h(DialogField, { key: "tokenUrl", label: t("oauth.tokenUrl") },
					h("input", {
						className: "mm-input",
						type: "url",
						"data-testid": "oauth-token-url",
						value: value.tokenUrl || "",
						placeholder: t("oauth.tokenUrlPlaceholder"),
						"aria-label": t("oauth.tokenUrl"),
						autoComplete: "off",
						onChange: (event) => update({ tokenUrl: event.target.value }),
					})));
				fields.push(h(DialogField, { key: "clientId", label: t("oauth.clientId") },
					h("input", {
						className: "mm-input",
						"data-testid": "oauth-client-id",
						value: value.clientId || "",
						"aria-label": t("oauth.clientId"),
						autoComplete: "off",
						onChange: (event) => update({ clientId: event.target.value }),
					})));
				fields.push(h(DialogField, { key: "clientSecret", label: t("oauth.clientSecret") },
					h("input", {
						className: "mm-input",
						type: "password",
						"data-testid": "oauth-client-secret",
						value: value.clientSecret || "",
						"aria-label": t("oauth.clientSecret"),
						autoComplete: "off",
						onChange: (event) => update({ clientSecret: event.target.value }),
					})));
				fields.push(h(DialogField, { key: "scope", label: t("oauth.scope") },
					h("input", {
						className: "mm-input",
						"data-testid": "oauth-scope",
						value: value.scope || "",
						placeholder: t("oauth.scopePlaceholder"),
						"aria-label": t("oauth.scope"),
						autoComplete: "off",
						onChange: (event) => update({ scope: event.target.value }),
					})));
			}
			return h(Modal, {
				title: t("oauth.title"),
				testId: "oauth-dialog",
				onClose: props.onClose,
				footer: [
					h("button", { key: "cancel", type: "button", className: "mm-btn", onClick: props.onClose }, t("oauth.cancel")),
					h("button", {
						key: "done",
						type: "button",
						className: "mm-btn mm-btnPrimary",
						"data-testid": "oauth-save",
						onClick: () => {
							props.onChange(value);
							props.onClose();
						},
					}, t("oauth.done")),
				],
			},
			h("div", { className: "mm-dialogBody" },
				h(DialogField, { key: "mode", label: t("oauth.mode") },
					h(Segmented, {
						label: t("oauth.mode"),
						value: value.mode,
						options: OAUTH_MODES.map((mode) => ({ value: mode.value, label: t(mode.labelKey), testId: "oauth-mode-" + mode.value })),
						onChange: (mode) => update({ mode }),
					})),
				fields,
				h("p", { className: "mm-hint" }, t("oauth.hint"))));
		}

		/* ================================================================ */
		/* edit form                                                         */
		/* ================================================================ */

		function EnvSection(props) {
			const rows = props.rows;
			const children = [];
			rows.forEach((row, index) => {
				children.push(h("div", { key: "env-" + index, className: "mm-boxRow" },
					h("input", {
						className: "mm-input mm-inputName",
						"data-testid": "form-env-name",
						value: row.name,
						placeholder: t("field.envName"),
						"aria-label": t("field.envName"),
						spellCheck: false,
						onChange: (event) => props.onChange(index, { name: event.target.value }),
					}),
					h("input", {
						className: "mm-input",
						"data-testid": "form-env-value",
						value: row.value,
						placeholder: t("field.envValue"),
						"aria-label": t("field.envValue"),
						spellCheck: false,
						onChange: (event) => props.onChange(index, { value: event.target.value }),
					}),
					h("button", {
						type: "button",
						className: "mm-iconBtn",
						"data-testid": "form-env-remove",
						"aria-label": t("field.envRemove"),
						onClick: () => props.onRemove(index),
					}, h(TrashGlyph, { size: 15 }))));
			});
			if (rows.length === 0) children.push(h("p", { key: "empty", className: "mm-boxEmpty" }, t("field.envEmpty")));
			children.push(h("div", { key: "add" },
				h("button", { type: "button", className: "mm-pill", "data-testid": "form-env-add", onClick: props.onAdd }, h(PlusGlyph, { size: 13 }), t("field.envAdd"))));
			return h("div", { className: "mm-box", "data-testid": props.testId }, children);
		}

		function HeaderSection(props) {
			const rows = props.rows;
			const rowErrors = props.rowErrors || {};
			const children = [];
			rows.forEach((row, index) => {
				const message = rowErrors[index] ? t(rowErrors[index]) : "";
				children.push(h("div", { key: "header-" + index, className: "mm-boxRow" },
					h("input", {
						className: "mm-input mm-inputName",
						"data-testid": "form-header-name",
						value: row.name,
						placeholder: t("headers.namePlaceholder"),
						"aria-label": t("headers.name"),
						"aria-invalid": message ? "true" : undefined,
						spellCheck: false,
						maxLength: 120,
						onChange: (event) => props.onChange(index, { name: event.target.value }),
					}),
					h("input", {
						className: "mm-input",
						"data-testid": "form-header-value",
						value: row.value,
						placeholder: t("headers.valuePlaceholder"),
						"aria-label": t("headers.value"),
						"aria-invalid": message ? "true" : undefined,
						spellCheck: false,
						onChange: (event) => props.onChange(index, { value: event.target.value }),
					}),
					h("button", {
						type: "button",
						className: "mm-iconBtn",
						"data-testid": "form-header-remove",
						"aria-label": t("headers.remove"),
						onClick: () => props.onRemove(index),
					}, h(TrashGlyph, { size: 15 }))));
				if (message) children.push(h("p", { key: "header-error-" + index, className: "mm-boxError", role: "alert" }, message));
			});
			if (rows.length === 0) children.push(h("p", { key: "empty", className: "mm-boxEmpty" }, t("headers.empty")));
			children.push(h("div", { key: "add" },
				h("button", { type: "button", className: "mm-pill", "data-testid": "form-header-add", onClick: props.onAdd }, h(PlusGlyph, { size: 13 }), t("headers.add"))));
			return h("div", { className: "mm-box", "data-testid": props.testId }, children);
		}

		function PresetSection(props) {
			const draft = props.draft;
			const presets = Array.isArray(props.presets) ? props.presets : [];
			const specific = draft.presets !== "all";
			const selected = Array.isArray(draft.presets) ? draft.presets : [];
			const error = props.error ? t(props.error) : "";

			const radioRows = h("div", { className: "mm-choices", role: "radiogroup", "aria-label": t("section.presets") },
				h(RadioRow, {
					name: "mm-preset-mode",
					checked: !specific,
					testId: "preset-mode-all",
					onChange: () => props.onChange("all"),
					title: t("presets.all"),
					description: t("presets.allHint"),
				}),
				h(RadioRow, {
					name: "mm-preset-mode",
					checked: specific,
					testId: "preset-mode-specific",
					onChange: () => props.onChange(selected),
					title: t("presets.specific"),
					description: t("presets.specificHint"),
				}));

			let body = null;
			if (presets.length === 0) {
				body = selected.length > 0 ? h("p", { className: "mm-hint" }, selected.join(", ")) : null;
			} else if (specific) {
				body = h("div", { className: "mm-choices" },
					presets.map((preset) => h(CheckRow, {
						key: preset.id,
						checked: selected.indexOf(preset.id) >= 0,
						testId: "preset-checkbox-" + preset.id,
						onChange: (checked) => props.onToggle(preset.id, checked),
						title: presetDisplayName(preset),
						description: preset.description || preset.id || t("presets.noDescription"),
					})),
					selected.length === 0 ? h("p", { className: "mm-presetWarn" }, t("presets.noneSelected")) : null);
			}

			return h("section", { className: "mm-section" },
				h("div", { className: "mm-sectionHead" },
					h("h2", { className: "mm-sectionTitle" }, t("section.presets")),
					h("p", { className: "mm-sectionHint" }, t("section.presetsHint"))),
				h("div", { className: "mm-row mm-rowTop" },
					h("span", { className: "mm-rowLabel" }, t("presets.all")),
					h("div", { className: "mm-rowControl" }, h("div", { className: "mm-controlCol" }, radioRows))),
				specific
					? h("div", { className: "mm-row mm-rowTop" },
						h("span", { className: "mm-rowLabel" }, t("presets.selectedCount", { count: selected.length })),
						h("div", { className: "mm-rowControl" }, h("div", { className: "mm-controlCol" },
							presets.length === 0 && selected.length > 0
								? h("p", { className: "mm-hint" }, t("presets.empty"))
								: null,
							body,
							error ? h("p", { className: "mm-presetWarn", role: "alert" }, error) : null)))
					: null,
				presets.length === 0
					? h("div", { className: "mm-row" },
						h("span", { className: "mm-rowLabel" }),
						h("div", { className: "mm-rowControl" },
								h("div", { className: "mm-controlCol" },
									h("p", { className: "mm-hint" }, t("presets.empty")),
									h("p", { className: "mm-hint" }, t("presets.emptyHint")))))
					: null);
		}

		function ToolCard(props) {
			const tool = props.tool;
			const params = tool.params || [];
			return h("article", {
				className: "mm-toolCard",
				"data-testid": "tool-card",
				"data-enabled": tool.enabled ? "true" : "false",
			},
			h("div", { className: "mm-toolHead" },
				h("code", { className: "mm-toolName", "data-testid": "tool-name" }, tool.name),
				h(Switch, {
					checked: tool.enabled,
					label: tool.name,
					testId: "tool-enabled",
					onChange: (enabled) => props.onToggleEnabled(tool.name, enabled),
				})),
			tool.description ? h("p", { className: "mm-toolDesc", "data-testid": "tool-desc" }, tool.description) : null,
			params.length === 0
				? h("p", { className: "mm-toolNoParams" }, t("tools.noParams"))
				: h("div", { className: "mm-toolParams" },
					h("span", { className: "mm-toolParamsLabel" }, t("tools.params")),
					params.map((param) => h("span", {
						key: param.name,
						className: "mm-paramChip",
						"data-testid": "tool-param",
						"data-required": param.required ? "true" : "false",
						title: t(param.required ? "tools.required" : "tools.optional"),
					}, param.name,
					h("span", { className: "mm-paramFlag" }, t(param.required ? "tools.required" : "tools.optional"))))),
			h("div", { className: "mm-toolFoot" },
				h("div", { className: "mm-toolApproval" },
					h(LockGlyph, { size: 14 }),
					h("span", { className: "mm-toolApprovalLabel" }, t("tools.approval")),
					h(Switch, {
						checked: tool.approval,
						disabled: !tool.enabled,
						label: t("tools.approval"),
						testId: "tool-approval",
						onChange: (approval) => props.onToggleApproval(tool.name, approval),
					})),
				h("p", { className: "mm-hint" }, t("tools.approvalHint")),
				!tool.enabled ? h("p", { className: "mm-toolDisabledNote" }, t("tools.disabledNote")) : null));
		}

		function ToolsPanel(props) {
			const meta = props.meta || {};
			const items = props.items || [];
			const head = h("div", { className: "mm-sectionHead" },
				h("h2", { className: "mm-sectionTitle" }, t("tools.title")),
				h("p", { className: "mm-sectionHint" }, t("tools.hint")));
			if (props.canManage !== true) {
				return h("section", { className: "mm-section", "data-testid": "tools-panel" },
					head,
					h("p", { className: "mm-toolsNote", "data-testid": "tools-save-first" }, t("tools.saveFirst")));
			}
			if (meta.status === "loading" || meta.status === "idle") {
				return h("section", { className: "mm-section", "data-testid": "tools-panel" },
					head,
					h("p", { className: "mm-toolsLoading", "data-testid": "tools-loading", role: "status" }, t("tools.loading")));
			}
			if (meta.status === "error") {
				return h("section", { className: "mm-section", "data-testid": "tools-panel" },
					head,
					h("div", { className: "mm-banner", "data-kind": "error", "data-testid": "tools-error", role: "alert" },
						h("span", { className: "mm-bannerText" }, t("tools.loadFailed", { message: meta.error }))),
					h("div", { className: "mm-toolsActions" },
						h("button", {
							type: "button",
							className: "mm-btn",
							"data-testid": "tools-retry",
							onClick: props.onRetry,
						}, h(RefreshGlyph, { size: 14 }), t("tools.retry"))));
			}
			const enabledCount = items.filter((tool) => tool.enabled === true).length;
			const notice = props.notice || null;
			return h("section", { className: "mm-section", "data-testid": "tools-panel" },
				head,
				meta.connected === true
					? null
					: h("p", { className: "mm-toolsNote", "data-testid": "tools-cached", role: "status" },
						t(meta.cachedAt ? "tools.cached" : "tools.offline")),
				meta.cachedAt
					? h("p", { className: "mm-toolsNote" }, t("tools.cachedAt", { time: formatTime(meta.cachedAt) }))
					: null,
				h("div", { className: "mm-toolsBar" },
					h("p", { className: "mm-toolsCount", "data-testid": "tools-count" }, t("tools.count", { enabled: enabledCount, total: items.length })),
					h("div", { className: "mm-iconActions" },
						h("button", {
							type: "button",
							className: "mm-pill",
							"data-testid": "tools-enable-all",
							disabled: props.saving === true || items.length === 0,
							onClick: props.onEnableAll,
						}, t("tools.enableAll")),
						h("button", {
							type: "button",
							className: "mm-pill",
							"data-testid": "tools-disable-all",
							disabled: props.saving === true || items.length === 0,
							onClick: props.onDisableAll,
						}, t("tools.disableAll")))),
				items.length === 0
					? h("p", { className: "mm-toolsEmpty", "data-testid": "tools-empty" }, t("tools.empty"))
					: h("div", { className: "mm-toolList" }, items.map((tool) => h(ToolCard, {
						key: tool.name,
						tool,
						onToggleEnabled: props.onToggleEnabled,
						onToggleApproval: props.onToggleApproval,
					}))),
				notice
					? h("p", {
						className: cx("mm-toolsNotice", notice.kind === "ok" ? "mm-toolsNoticeOk" : ""),
						role: notice.kind === "ok" ? "status" : "alert",
					}, notice.message)
					: null,
				h("div", { className: "mm-toolsFoot" },
					h("p", { className: "mm-formFootHint" }, t("tools.footHint")),
					h("button", {
						type: "button",
						className: "mm-btn mm-btnPrimary mm-save",
						"data-testid": "tools-save",
						disabled: props.saving === true || props.dirty !== true,
						onClick: props.onSave,
					}, props.saving === true ? t("form.saving") : t("tools.save"))));
		}

		function ExternalToolCard(props) {
			const tool = props.tool;
			const params = tool.params || [];
			return h("article", {
				className: "mm-toolCard",
				"data-testid": "external-tool-card",
				"data-enabled": tool.enabled ? "true" : "false",
			},
			h("div", { className: "mm-toolHead" },
				h("code", { className: "mm-toolName", "data-testid": "external-tool-name" }, tool.name),
				h(Switch, {
					checked: tool.enabled,
					label: tool.name,
					testId: "external-tool-enabled",
					onChange: (enabled) => props.onToggleEnabled(tool.name, enabled),
				})),
			tool.description ? h("p", { className: "mm-toolDesc", "data-testid": "external-tool-desc" }, tool.description) : null,
			params.length === 0
				? h("p", { className: "mm-toolNoParams" }, t("external.noParams"))
				: h("div", { className: "mm-toolParams" },
					h("span", { className: "mm-toolParamsLabel" }, t("tools.params")),
					params.map((param) => h("span", {
						key: param.name,
						className: "mm-paramChip",
						"data-testid": "external-tool-param",
						"data-required": param.required ? "true" : "false",
						title: t(param.required ? "tools.required" : "tools.optional"),
					}, param.name,
					h("span", { className: "mm-paramFlag" }, t(param.required ? "tools.required" : "tools.optional"))))),
			h("div", { className: "mm-toolFoot" },
				h("div", { className: "mm-toolApproval" },
					h(LockGlyph, { size: 14 }),
					h("span", { className: "mm-toolApprovalLabel" }, t("tools.approval")),
					h(Switch, {
						checked: tool.approval,
						disabled: !tool.enabled,
						label: t("tools.approval"),
						testId: "external-tool-approval",
						onChange: (approval) => props.onToggleApproval(tool.name, approval),
					})),
				h("p", { className: "mm-hint" }, t("tools.approvalHint")),
				!tool.enabled ? h("p", { className: "mm-toolDisabledNote" }, t("external.disabledNote")) : null));
		}

		function ExternalTab() {
			const [status, setStatus] = useState("loading");
			const [data, setData] = useState(null);
			const [error, setError] = useState("");
			const [scanning, setScanning] = useState(false);
			const [savingId, setSavingId] = useState("");
			const [baselines, setBaselines] = useState({});
			const [notice, setNotice] = useState(null);
			const [selected, setSelected] = useState(null);

			const applyPayload = (payload) => {
				const normalized = normalizeExternalPayload(payload);
				setData(normalized);
				setBaselines(externalBaselines(normalized.presets));
				setSelected((current) => {
					if (!current) return current;
					const preset = normalized.presets.find((item) => item.id === current.presetId);
					return preset && preset.servers.some((server) => server.name === current.serverName) ? current : null;
				});
				setStatus("ready");
				setError("");
			};

			const load = async () => {
				setStatus("loading");
				setError("");
				try {
					applyPayload(await apiMutate("GET", "/external"));
				} catch (failure) {
					if (!isAbortError(failure)) {
						setStatus("error");
						setError(failure.message || "");
					}
				}
			};

			useEffect(() => {
				void load();
			}, []);

			const scan = async () => {
				if (scanning) return;
				setScanning(true);
				setNotice(null);
				try {
					applyPayload(await apiMutate("POST", "/external/scan"));
				} catch (failure) {
					if (!isAbortError(failure)) {
						setStatus("error");
						setError(failure.message || "");
					}
				} finally {
					setScanning(false);
				}
			};

			const updateServerTools = (presetId, serverName, updater) => {
				setData((previous) => {
					if (!previous) return previous;
					return { ...previous, presets: previous.presets.map((preset) => preset.id !== presetId ? preset : {
						...preset,
						servers: preset.servers.map((server) => server.name !== serverName ? server : {
							...server,
							tools: updater(server.tools),
						}),
					}) };
				});
			};

			const updateTool = (presetId, serverName, toolName, patch) => {
				updateServerTools(presetId, serverName, (tools) => tools.map((tool) => tool.name === toolName ? { ...tool, ...patch } : tool));
			};

			const savePreset = async (preset) => {
				if (savingId !== "") return;
				if (externalToolSettingsKey(preset) === baselines[preset.id]) return;
				setSavingId(preset.id);
				setNotice(null);
				try {
					const payload = await apiMutate("PUT", "/external/tools", {
						presetId: preset.id,
						tools: externalToolSettings(preset),
					});
					applyPayload(payload);
					setNotice({ presetId: preset.id, kind: "ok", message: t("external.saved") });
				} catch (failure) {
					if (!isAbortError(failure)) {
						setNotice({ presetId: preset.id, kind: "error", message: t("external.saveFailed", { message: failure.message }) });
					}
				} finally {
					setSavingId("");
				}
			};

			return h(ExternalView, {
				status,
				data,
				error,
				scanning,
				savingId,
				baselines,
				notice,
				selected,
				onScan: scan,
				onRetry: load,
				onSave: savePreset,
				onToggle: updateTool,
				onToggleAll: (presetId, serverName, enabled) => updateServerTools(presetId, serverName, (tools) => tools.map((tool) => ({ ...tool, enabled }))),
				onOpenServer: (presetId, serverName) => setSelected({ presetId, serverName }),
				onBack: () => setSelected(null),
			});
		}

		function ExternalView(props) {
			const { status, data, error, scanning, savingId, baselines, notice } = props;
			const intro = h("section", { className: "mm-externalIntro" },
				h("h2", { className: "mm-externalTitle" }, t("external.title")),
				h("p", { className: "mm-externalIntroText" }, t("external.intro")));

			if (status === "loading") {
				return h("div", { className: "mm-pageBody", "data-testid": "external-panel" },
					intro,
					h("p", { className: "mm-toolsLoading", "data-testid": "external-loading", role: "status" }, t("external.loading")));
			}
			if (status === "error") {
				return h("div", { className: "mm-pageBody", "data-testid": "external-panel" },
					intro,
					h("div", { className: "mm-banner", "data-kind": "error", "data-testid": "external-error", role: "alert" },
						h("span", { className: "mm-bannerText" }, t("external.loadFailed", { message: error }))),
					h("div", { className: "mm-toolsActions" },
						h("button", {
							type: "button",
							className: "mm-btn",
							"data-testid": "external-retry",
							onClick: props.onRetry,
						}, h(RefreshGlyph, { size: 14 }), t("external.retry"))));
			}

			const presets = data ? data.presets : [];
			const selected = props.selected;
			if (selected) {
				const selectedPreset = presets.find((preset) => preset.id === selected.presetId);
				const selectedServer = selectedPreset && selectedPreset.servers.find((server) => server.name === selected.serverName);
				if (selectedPreset && selectedServer) {
					return h(ExternalServerView, {
						preset: selectedPreset,
						server: selectedServer,
						baselines: props.baselines,
						savingId: props.savingId,
						notice: notice,
						onBack: props.onBack,
						onSave: () => props.onSave(selectedPreset),
						onToggle: props.onToggle,
						onToggleAll: props.onToggleAll,
					});
				}
			}
			return h("div", { className: "mm-pageBody", "data-testid": "external-panel" },
				intro,
				h("div", { className: "mm-externalBar" },
					h("p", { className: "mm-externalScanned" }, data && data.scannedAt ? t("external.scannedAt", { time: formatTime(data.scannedAt) }) : t("external.neverScanned")),
					h("button", {
						type: "button",
						className: "mm-btn",
						"data-testid": "external-scan",
						disabled: scanning,
						onClick: props.onScan,
					}, h(RefreshGlyph, { size: 14 }), scanning ? t("external.scanning") : t("external.scan"))),
				presets.length === 0
					? h("div", { className: "mm-empty", "data-testid": "external-empty" },
						h("div", { className: "mm-emptyGlyph" }, h(PlugGlyph, { size: 34 })),
						h("p", { className: "mm-emptyHint" }, t("external.empty")))
					: presets.map((preset) => {
						const totalTools = preset.servers.reduce((count, server) => count + server.tools.length, 0);
						const dirty = externalToolSettingsKey(preset) !== baselines[preset.id];
						return h("section", { key: preset.id, className: "mm-externalPreset", "data-testid": "external-preset", "data-preset-id": preset.id },
							h("div", { className: "mm-externalPresetHead" },
								h("div", { className: "mm-externalPresetTitle" },
									h("h2", { className: "mm-externalPresetName" }, preset.name),
									h("code", { className: "mm-externalPresetId" }, preset.id),
									preset.hasPresetMcp
										? h("span", { className: "mm-badge mm-badgeOn", "data-testid": "external-owned-badge" }, t("external.ownedBadge"))
										: null),
								h("span", { className: "mm-groupCount" }, t("external.toolCount", { count: totalTools }))),
							preset.hasPresetMcp && preset.servers.length === 0
								? h("div", { className: "mm-toolsNote", "data-testid": "external-pending" },
									h("p", { className: "mm-externalPendingTitle" }, t("external.pending")),
									h("p", { className: "mm-externalPendingHint" }, t("external.pendingHint")))
								: h("div", { className: "mm-cards mm-externalServers" },
									preset.servers.map((server) => h(ExternalServerCard, {
										key: server.name,
										presetId: preset.id,
										server,
										onOpen: () => props.onOpenServer(preset.id, server.name),
									}))),
							h("div", { className: "mm-externalFoot" },
								h("p", { className: "mm-formFootHint" }, t("external.footHint")),
								h("button", {
									type: "button",
									className: "mm-btn mm-btnPrimary",
									"data-testid": "external-save",
									disabled: savingId === preset.id || !dirty,
									onClick: () => props.onSave(preset),
								}, savingId === preset.id ? t("form.saving") : t("external.save"))),
							notice && notice.presetId === preset.id
								? h("p", {
									className: cx("mm-toolsNotice", notice.kind === "ok" ? "mm-toolsNoticeOk" : ""),
									role: notice.kind === "ok" ? "status" : "alert",
								}, notice.message)
								: null);
					}));
		}

		function ExternalServerCard(props) {
			const server = props.server;
			const tools = server.tools || [];
			const enabled = tools.filter((tool) => tool.enabled === true).length;
			const initial = (String(server.name || "").trim().slice(0, 1) || "M").toUpperCase();
			return h("button", {
				type: "button",
				className: "mm-card mm-externalServerCard",
				"data-testid": "external-server-card",
				"data-preset-id": props.presetId,
				"data-server-name": server.name,
				onClick: props.onOpen,
			},
			h("div", { className: "mm-cardRow" },
				h("div", { className: "mm-tile mm-externalTile", "aria-hidden": "true" },
					h("span", { className: "mm-tileLetter" }, initial)),
				h("div", { className: "mm-cardMain" },
					h("h3", { className: "mm-cardTitle", title: server.name }, server.name),
					h("p", { className: "mm-statusLine" },
						h("span", { className: "mm-statusWord" }, t("external.serverMeta", { enabled, total: tools.length })),
						server.discoveredAt
							? h("span", { className: "mm-statusSep" }, "·")
							: null,
						server.discoveredAt
							? h("span", null, t("external.discoveredAt", { time: formatTime(server.discoveredAt) }))
							: null)),
				h("span", { className: "mm-externalChevron", "aria-hidden": "true" }, "\u203a")));
		}

		function ExternalServerView(props) {
			const preset = props.preset;
			const server = props.server;
			const tools = server.tools || [];
			const enabled = tools.filter((tool) => tool.enabled === true).length;
			const dirty = externalToolSettingsKey(preset) !== props.baselines[preset.id];
			const notice = props.notice && props.notice.presetId === preset.id ? props.notice : null;
			return h("div", { className: "mm-pageBody", "data-testid": "external-server-view" },
				h("div", { className: "mm-formHead" },
					h("button", {
						type: "button",
						className: "mm-iconBtn",
						"data-testid": "external-back",
						"aria-label": t("external.back"),
						onClick: props.onBack,
					}, h(BackGlyph, { size: 18 })),
					h("div", { className: "mm-formHeadMain" },
						h("h1", { className: "mm-formTitle" }, server.name),
						h("p", { className: "mm-formSubtitle" }, preset.name + " · " + preset.id + " · " + t("external.ownedBadge")))),
				h("section", { className: "mm-section", "data-testid": "external-tools-panel" },
					h("div", { className: "mm-sectionHead" },
						h("h2", { className: "mm-sectionTitle" }, t("tools.title")),
						h("p", { className: "mm-sectionHint" }, t("external.detailHint"))),
					h("div", { className: "mm-toolsBar" },
						h("p", { className: "mm-toolsCount", "data-testid": "external-count" }, t("tools.count", { enabled, total: tools.length })),
						h("div", { className: "mm-iconActions" },
							h("button", {
								type: "button",
								className: "mm-pill",
								"data-testid": "external-enable-all",
								disabled: tools.length === 0 || enabled === tools.length,
								onClick: () => props.onToggleAll(preset.id, server.name, true),
							}, t("tools.enableAll")),
							h("button", {
								type: "button",
								className: "mm-pill",
								"data-testid": "external-disable-all",
								disabled: tools.length === 0 || enabled === 0,
								onClick: () => props.onToggleAll(preset.id, server.name, false),
							}, t("tools.disableAll")))),
					tools.length === 0
						? h("p", { className: "mm-hint" }, t("external.toolsEmpty"))
						: h("div", { className: "mm-toolList" }, tools.map((tool) => h(ExternalToolCard, {
							key: tool.name,
							tool,
							onToggleEnabled: (name, next) => props.onToggle(preset.id, server.name, name, { enabled: next }),
							onToggleApproval: (name, next) => props.onToggle(preset.id, server.name, name, { approval: next }),
						}))),
					h("div", { className: "mm-toolsFoot" },
						h("p", { className: "mm-formFootHint" }, t("external.footHint")),
						h("button", {
							type: "button",
							className: "mm-btn mm-btnPrimary mm-save",
							"data-testid": "external-save",
							disabled: props.savingId === preset.id || !dirty,
							onClick: props.onSave,
						}, props.savingId === preset.id ? t("form.saving") : t("external.save"))),
					notice
						? h("p", {
							className: cx("mm-toolsNotice", notice.kind === "ok" ? "mm-toolsNoticeOk" : ""),
							role: notice.kind === "ok" ? "status" : "alert",
						}, notice.message)
						: null));
		}

		function EditFormView(props) {
			const editing = props.mode === "edit" && props.server !== null && props.server !== undefined;
			const [draft, setDraft] = useState(() => editing ? draftFromServer(props.server) : blankDraft(""));
			const [errors, setErrors] = useState({});
			const [saving, setSaving] = useState(false);
			const [testing, setTesting] = useState(false);
			const [banner, setBanner] = useState(null);
			const [deleteOpen, setDeleteOpen] = useState(false);
			const [deleting, setDeleting] = useState(false);
			const [testResult, setTestResult] = useState(null);
			const [oauthOpen, setOauthOpen] = useState(false);
			const [tab, setTab] = useState("basic");
			const [toolItems, setToolItems] = useState([]);
			const [toolMeta, setToolMeta] = useState({ status: "idle", connected: false, cachedAt: null, error: "" });
			const [toolBaseline, setToolBaseline] = useState("[]");
			const [toolNotice, setToolNotice] = useState(null);
			const [toolsSaving, setToolsSaving] = useState(false);
			const [pendingIcon, setPendingIcon] = useState(null);
			const [iconError, setIconError] = useState("");
			const [iconBusy, setIconBusy] = useState(false);
			const [previewFailedUrl, setPreviewFailedUrl] = useState("");
			const [iconState, setIconState] = useState(() => ({
				kind: editing && props.server && props.server.icon && props.server.icon.kind === "upload" ? "upload" : "auto",
				url: iconUrlOf(editing ? props.server : null),
			}));
			const fileInputRef = useRef(null);
			const headingRef = useRef(null);

			useEffect(() => {
				if (headingRef.current) headingRef.current.focus();
			}, []);

			const update = useCallback((patch) => {
				setDraft((previous) => ({ ...previous, ...patch }));
			}, []);

			const loadTools = async () => {
				if (!editing) return;
				setToolNotice(null);
				setToolMeta((previous) => ({ ...previous, status: "loading", error: "" }));
				try {
					const result = await apiMutate("GET", "/servers/" + encodeURIComponent(draft.id) + "/tools");
					const items = normalizeToolList(result.tools);
					setToolItems(items);
					setToolBaseline(toolSettingsKey(items));
					setToolMeta({
						status: "ready",
						connected: result.connected === true,
						cachedAt: typeof result.cachedAt === "string" && result.cachedAt !== "" ? result.cachedAt : null,
						error: "",
					});
				} catch (failure) {
					if (!isAbortError(failure)) {
						setToolMeta((previous) => ({ ...previous, status: "error", error: failure.message || "" }));
					}
				}
			};

			useEffect(() => {
				if (tab !== "tools" || !editing || toolMeta.status !== "idle") return;
				void loadTools();
			}, [tab, editing, toolMeta.status]);

			const setHeader = (index, patch) => {
				setDraft((previous) => {
					const headers = previous.headers.map((row, position) => position === index ? { ...row, ...patch } : row);
					return { ...previous, headers };
				});
			};
			const addHeader = () => {
				setDraft((previous) => ({ ...previous, headers: previous.headers.concat([{ name: "", value: "" }]) }));
			};
			const removeHeader = (index) => {
				setDraft((previous) => ({ ...previous, headers: previous.headers.filter((row, position) => position !== index) }));
			};
			const setEnv = (index, patch) => {
				setDraft((previous) => {
					const envRows = previous.envRows.map((row, position) => position === index ? { ...row, ...patch } : row);
					return { ...previous, envRows };
				});
			};
			const addEnv = () => {
				setDraft((previous) => ({ ...previous, envRows: previous.envRows.concat([{ name: "", value: "" }]) }));
			};
			const removeEnv = (index) => {
				setDraft((previous) => ({ ...previous, envRows: previous.envRows.filter((row, position) => position !== index) }));
			};
			const togglePreset = (id, checked) => {
				setDraft((previous) => {
					const current = Array.isArray(previous.presets) ? previous.presets.slice() : [];
					const known = (props.presets || []).map((preset) => preset.id);
					const wanted = new Set(current);
					if (checked) wanted.add(id);
					else wanted.delete(id);
					const ordered = known.filter((presetId) => wanted.has(presetId));
					for (const existing of current) {
						if (!known.includes(existing) && wanted.has(existing) && ordered.indexOf(existing) < 0) ordered.push(existing);
					}
					return { ...previous, presets: ordered };
				});
			};

			const save = async () => {
				if (saving || testing) return;
				const nextErrors = validateDraft(draft, props.presets);
				setErrors(nextErrors);
				if (hasFieldErrors(nextErrors)) {
					setBanner({ kind: "error", message: t("form.validationFailed") });
					return;
				}
				setSaving(true);
				setBanner(null);
				try {
					const body = bodyFromDraft(draft);
					const result = editing
						? await apiMutate("PUT", "/servers/" + encodeURIComponent(draft.id), body)
						: await apiMutate("POST", "/servers", body);
					const saved = result.server || result;
					if (pendingIcon) {
						try {
							const iconResult = await apiMutate("POST", "/servers/" + encodeURIComponent(saved.id) + "/icon", { dataUrl: pendingIcon });
							if (props.onSaved) props.onSaved(iconResult.server || saved, editing ? "edited" : "created", null);
						} catch (failure) {
							if (props.onSaved) props.onSaved(saved, editing ? "edited" : "created", { iconError: failure.message });
						}
						return;
					}
					if (props.onSaved) props.onSaved(saved, editing ? "edited" : "created", null);
				} catch (failure) {
					if (!isAbortError(failure)) setBanner({ kind: "error", message: t("form.saveFailed", { message: failure.message }) });
				} finally {
					setSaving(false);
				}
			};

			const runTest = async () => {
				if (saving || testing) return;
				const nextErrors = validateDraft(draft, props.presets);
				setErrors(nextErrors);
				if (hasFieldErrors(nextErrors)) {
					setBanner({ kind: "error", message: t("form.validationFailed") });
					return;
				}
				setTesting(true);
				setBanner(null);
				try {
					const result = await apiMutate("POST", "/servers/test", bodyFromDraft(draft));
					setTestResult({ transport: draft.transport, status: result.status || null });
				} catch (failure) {
					if (!isAbortError(failure)) setBanner({ kind: "error", message: t("form.testFailed", { message: failure.message }) });
				} finally {
					setTesting(false);
				}
			};

			const remove = async () => {
				if (!editing || deleting) return;
				setDeleting(true);
				try {
					await apiMutate("DELETE", "/servers/" + encodeURIComponent(draft.id));
					setDeleteOpen(false);
					if (props.onDeleted) props.onDeleted(draft.id);
				} catch (failure) {
					if (!isAbortError(failure)) setBanner({ kind: "error", message: t("form.deleteFailed", { message: failure.message }) });
				} finally {
					setDeleting(false);
				}
			};

			const pickIcon = () => {
				if (fileInputRef.current) fileInputRef.current.click();
			};

			const onIconFile = (event) => {
				const input = event.target;
				const file = input.files && input.files[0] ? input.files[0] : null;
				input.value = "";
				if (!file) return;
				setIconError("");
				if (ICON_TYPES.indexOf(file.type) < 0) {
					setIconError("icon.invalidType");
					return;
				}
				if (file.size > MAX_ICON_BYTES) {
					setIconError("icon.tooLarge");
					return;
				}
				if (typeof FileReader !== "function") {
					setIconError("icon.invalidType");
					return;
				}
				const reader = new FileReader();
				reader.onload = () => {
					if (typeof reader.result === "string" && reader.result.indexOf("data:image/") === 0) setPendingIcon(reader.result);
					else setIconError("icon.invalidType");
				};
				reader.onerror = () => setIconError("icon.invalidType");
				reader.readAsDataURL(file);
			};

			const restoreAutoIcon = async () => {
				if (iconBusy || saving) return;
				setIconError("");
				const resetStored = editing && iconState.kind === "upload";
				setPendingIcon(null);
				if (!resetStored) return;
				setIconBusy(true);
				try {
					const result = await apiMutate("DELETE", "/servers/" + encodeURIComponent(draft.id) + "/icon");
					const server = result.server || null;
					setIconState({ kind: "auto", url: iconUrlOf(server) });
					setBanner({ kind: "ok", message: t("icon.removed") });
				} catch (failure) {
					if (!isAbortError(failure)) setBanner({ kind: "error", message: t("form.saveFailed", { message: failure.message }) });
				} finally {
					setIconBusy(false);
				}
			};

			const saveTools = async () => {
				if (!editing || toolsSaving) return;
				const body = { tools: toolSettingsOf(toolItems) };
				if (toolSettingsKey(toolItems) === toolBaseline) return;
				setToolsSaving(true);
				setToolNotice(null);
				try {
					await apiMutate("PUT", "/servers/" + encodeURIComponent(draft.id) + "/tools", body);
					setToolBaseline(toolSettingsKey(toolItems));
					setToolNotice({ kind: "ok", message: t("tools.saved") });
					if (props.onRefresh) props.onRefresh();
				} catch (failure) {
					if (!isAbortError(failure)) {
						setToolNotice({ kind: "error", message: t("tools.saveFailed", { message: failure.message }) });
					}
				} finally {
					setToolsSaving(false);
				}
			};

			const groups = Array.isArray(props.groups) ? props.groups : [];
			const headerRowErrors = errors.headerRows || {};
			const previewSrc = pendingIcon || iconState.url;
			const showPreviewImage = previewSrc !== "" && previewFailedUrl !== previewSrc;
			const previewLetter = letterOf(draft.name);

			const basicSection = h("section", { className: "mm-section" },
				h("div", { className: "mm-sectionHead" },
					h("h2", { className: "mm-sectionTitle" }, t("section.basic")),
					h("p", { className: "mm-sectionHint" }, t("section.basicHint"))),
				h("div", { className: "mm-row" },
					h("span", { className: "mm-rowLabel" }, t("field.enabled")),
					h("div", { className: "mm-rowControl" },
						h(Switch, {
							checked: draft.enabled,
							label: t("field.enabled"),
							testId: "form-enabled",
							onChange: (enabled) => update({ enabled }),
						}))),
				h("div", { className: "mm-row" },
					h("span", { className: "mm-rowLabel" }),
					h("div", { className: "mm-rowControl" }, h("p", { className: "mm-hint" }, t("field.enabledHint")))),
				h("div", { className: "mm-row mm-rowTop", "data-testid": "form-icon" },
					h("span", { className: "mm-rowLabel" }, t("field.icon")),
					h("div", { className: "mm-rowControl" },
						h("div", { className: "mm-controlCol" },
							h("div", { className: "mm-iconRow" },
								h("div", { className: "mm-iconPreview", "data-color": draft.color, "data-testid": "icon-preview", role: "img", "aria-label": showPreviewImage ? t("field.icon") : previewLetter },
									showPreviewImage
										? h("img", { className: "mm-iconPreviewImage", src: previewSrc, alt: "", onError: () => setPreviewFailedUrl(previewSrc) })
										: h("span", { className: "mm-iconPreviewLetter", "aria-hidden": "true" }, previewLetter)),
								h("div", { className: "mm-iconMeta" },
									h("div", { className: "mm-iconActions" },
										h("button", { type: "button", className: "mm-pill", "data-testid": "icon-upload", disabled: iconBusy || saving || testing, onClick: pickIcon }, h(PlusGlyph, { size: 13 }), t("icon.upload")),
										h("button", { type: "button", className: "mm-pill", "data-testid": "icon-remove", disabled: iconBusy || saving || testing || (!pendingIcon && !(editing && iconState.kind === "upload")), onClick: restoreAutoIcon }, h(RefreshGlyph, { size: 13 }), t("icon.auto")),
										h("input", { ref: fileInputRef, type: "file", hidden: true, accept: ICON_ACCEPT, "data-testid": "icon-file", onChange: onIconFile })),
									h("div", { className: "mm-swatches", role: "group", "aria-label": t("field.color") },
										COLORS.map((color) => h("button", {
											key: color,
											type: "button",
											className: "mm-swatch",
											"data-color": color,
											"aria-pressed": draft.color === color ? "true" : "false",
											"aria-label": t("color." + color),
											title: t("color." + color),
											onClick: () => update({ color }),
										}))),
									!pendingIcon && iconState.kind === "auto"
										? h("p", { className: "mm-iconAuto" }, t("icon.autoLabel"))
										: null,
									iconError ? h("p", { className: "mm-fieldError", role: "alert" }, t(iconError)) : null,
									h("p", { className: "mm-hint" }, t("icon.hint"))))))),
				h("div", { className: "mm-row" },
					h("span", { className: "mm-rowLabel" }, t("field.group")),
					h("div", { className: "mm-rowControl" },
						h("div", { className: "mm-controlCol" },
							h("input", {
								className: "mm-input",
								"data-testid": "form-group",
								list: "mm-group-options",
								value: draft.group,
								placeholder: t("field.groupPlaceholder"),
								"aria-label": t("field.group"),
								onChange: (event) => update({ group: event.target.value }),
							}),
							h("datalist", { id: "mm-group-options" },
								groups.map((group) => h("option", { key: group, value: group })))))),
				h("div", { className: "mm-row" },
					h("span", { className: "mm-rowLabel" }, t("field.name")),
					h("div", { className: "mm-rowControl" },
						h(TextField, {
							id: "mm-name",
							testId: "form-name",
							value: draft.name,
							onChange: (name) => update({ name }),
							placeholder: t("field.namePlaceholder"),
							ariaLabel: t("field.name"),
							maxLength: 80,
							error: errors.name ? t(errors.name) : "",
							hint: editing ? t("form.keyHint", { key: draft.key }) : t("form.keyPending"),
						}))));

			const timeoutRow = h("div", { key: "timeout", className: "mm-row" },
				h("span", { className: "mm-rowLabel" }, t("field.timeout")),
				h("div", { className: "mm-rowControl" },
					h("div", { className: "mm-controlCol" },
						h("div", { className: "mm-inlineControls" },
							h("input", {
								className: "mm-input",
								type: "number",
								"data-testid": "form-timeout",
								min: 1000,
								max: 600000,
								step: 1000,
								value: draft.timeoutMs,
								"aria-label": t("field.timeout"),
								"aria-invalid": errors.timeout ? "true" : undefined,
								onChange: (event) => update({ timeoutMs: event.target.value }),
							}),
							h("span", { className: "mm-hint" }, t("field.timeoutUnit"))),
						errors.timeout ? h("p", { className: "mm-fieldError", role: "alert" }, t(errors.timeout)) : null,
						h("p", { className: "mm-hint" }, t("field.timeoutHint")))));

			const connectionRows = [];
			connectionRows.push(h("div", { key: "transport", className: "mm-row mm-rowTop" },
				h("span", { className: "mm-rowLabel" }, t("field.transport")),
				h("div", { className: "mm-rowControl" },
					h("div", { className: "mm-controlCol" },
						h(Segmented, {
							label: t("field.transport"),
							value: draft.transport,
							options: [
								{ value: "http", label: t("transport.http"), testId: "form-transport-http" },
								{ value: "sse", label: t("transport.sse"), testId: "form-transport-sse" },
								{ value: "stdio", label: t("transport.stdio"), testId: "form-transport-stdio" },
							],
							onChange: (transport) => update({ transport }),
						}),
						h("p", { className: "mm-hint" }, t(draft.transport === "stdio" ? "field.transportStdioHint" : draft.transport === "sse" ? "field.transportSseHint" : "field.transportHttpHint"))))));
			if (draft.transport === "stdio") {
				connectionRows.push(h("div", { key: "command", className: "mm-row" },
					h("span", { className: "mm-rowLabel" }, t("field.command")),
					h("div", { className: "mm-rowControl" },
						h(TextField, {
							id: "mm-command",
							testId: "form-command",
							value: draft.command,
							onChange: (command) => update({ command }),
							placeholder: t("field.commandPlaceholder"),
							ariaLabel: t("field.command"),
							error: errors.command ? t(errors.command) : "",
						}))));
				connectionRows.push(h("div", { key: "args", className: "mm-row mm-rowTop" },
					h("span", { className: "mm-rowLabel" }, t("field.args")),
					h("div", { className: "mm-rowControl" },
						h(TextAreaField, {
							id: "mm-args",
							testId: "form-args",
							value: draft.argsText,
							onChange: (argsText) => update({ argsText }),
							placeholder: t("field.argsPlaceholder"),
							ariaLabel: t("field.args"),
							hint: t("field.argsHint"),
						}))));
				connectionRows.push(h("div", { key: "cwd", className: "mm-row" },
					h("span", { className: "mm-rowLabel" }, t("field.cwd")),
					h("div", { className: "mm-rowControl" },
						h(TextField, {
							id: "mm-cwd",
							testId: "form-cwd",
							value: draft.cwd,
							onChange: (cwd) => update({ cwd }),
							placeholder: t("field.cwdPlaceholder"),
							ariaLabel: t("field.cwd"),
						}))));
				connectionRows.push(h("div", { key: "env", className: "mm-row mm-rowStack" },
					h("span", { className: "mm-rowLabel" }, t("field.env")),
					h("div", { className: "mm-rowControl" },
						h(EnvSection, {
							testId: "form-env",
							rows: draft.envRows,
							onChange: setEnv,
							onAdd: addEnv,
							onRemove: removeEnv,
						}))));
			} else {
				connectionRows.push(h("div", { key: "url", className: "mm-row" },
					h("span", { className: "mm-rowLabel" }, t("field.url")),
					h("div", { className: "mm-rowControl" },
						h(TextField, {
							id: "mm-url",
							testId: "form-url",
							value: draft.url,
							onChange: (url) => update({ url }),
							placeholder: t("field.urlPlaceholder"),
							ariaLabel: t("field.url"),
							type: "url",
							spellCheck: false,
							error: errors.url ? t(errors.url) : "",
						}))));
			}
			connectionRows.push(timeoutRow);

			const oauthRow = draft.transport === "stdio"
				? null
				: h("div", { key: "oauth", className: "mm-row" },
					h("span", { className: "mm-rowLabel" }, t("section.oauth")),
					h("div", { className: "mm-rowControl" },
						h("span", { className: "mm-oauthSummary" },
							h("span", { className: cx("mm-badge", draft.oauth && draft.oauth.mode !== "none" ? "mm-badgeOn" : "") }, t(oauthSummaryKey(draft.oauth)))),
						h("button", { type: "button", className: "mm-pill", "data-testid": "form-oauth-open", onClick: () => setOauthOpen(true) }, t("oauth.configure"))));

			const headersRow = draft.transport === "stdio"
				? null
				: h("div", { key: "headers", className: "mm-row mm-rowStack" },
					h("span", { className: "mm-rowLabel" }, t("section.headers")),
					h("div", { className: "mm-rowControl" },
						h("div", { className: "mm-controlCol" },
							h(HeaderSection, {
								testId: "form-headers",
								rows: draft.headers,
								rowErrors: headerRowErrors,
								onChange: setHeader,
								onAdd: addHeader,
								onRemove: removeHeader,
							}),
							errors.headersLimit ? h("p", { className: "mm-fieldError", role: "alert" }, t(errors.headersLimit)) : null,
							h("p", { className: "mm-hint" }, t("section.headersHint")))));

			const connectionSection = h("section", { className: "mm-section" },
				h("div", { className: "mm-sectionHead" },
					h("h2", { className: "mm-sectionTitle" }, t("section.connection")),
					h("p", { className: "mm-sectionHint" }, t("section.connectionHint"))),
				connectionRows,
				oauthRow,
				headersRow);

			const basicPanel = h("div", { className: "mm-tabPanel" },
				basicSection,
				connectionSection,
				h(PresetSection, {
					draft,
					presets: props.presets,
					error: errors.presets,
					onChange: (presets) => update({ presets }),
					onToggle: togglePreset,
				}),
				h("div", { className: "mm-formFoot" },
					editing
						? h("div", { className: "mm-formFootRow" },
							h("button", {
								type: "button",
								className: "mm-btn",
								"data-testid": "form-test",
								disabled: testing || saving,
								onClick: runTest,
							}, h(RefreshGlyph, { size: 15 }), testing ? t("form.testing") : t("form.test")),
							h("button", {
								type: "button",
								className: "mm-btn mm-btnDanger",
								"data-testid": "form-delete",
								disabled: saving,
								onClick: () => setDeleteOpen(true),
							}, h(TrashGlyph, { size: 15 }), t("form.delete")))
						: null,
					h("button", {
						type: "button",
						className: "mm-btn mm-btnPrimary mm-save",
						"data-testid": "form-save",
						disabled: saving || testing,
						onClick: save,
					}, saving ? t("form.saving") : t("form.save")),
					h("p", { className: "mm-formFootHint" }, t("form.testTimeout"))));

			const toolsPanel = h(ToolsPanel, {
				canManage: editing,
				meta: toolMeta,
				items: toolItems,
				notice: toolNotice,
				dirty: toolSettingsKey(toolItems) !== toolBaseline,
				saving: toolsSaving,
				onRetry: loadTools,
				onSave: saveTools,
				onToggleEnabled: (name, enabled) => setToolItems((previous) => previous.map((tool) => tool.name === name ? { ...tool, enabled } : tool)),
				onToggleApproval: (name, approval) => setToolItems((previous) => previous.map((tool) => tool.name === name ? { ...tool, approval } : tool)),
				onEnableAll: () => setToolItems((previous) => previous.map((tool) => ({ ...tool, enabled: true }))),
				onDisableAll: () => setToolItems((previous) => previous.map((tool) => ({ ...tool, enabled: false }))),
			});

			return h("div", { className: "mm-scroll" },
				h("div", { className: "mm-page" },
					h("div", { className: "mm-formHead" },
						h("button", {
							type: "button",
							className: "mm-iconBtn",
							"data-testid": "form-cancel",
							"aria-label": t("form.back"),
							onClick: props.onBack,
						}, h(BackGlyph, { size: 18 })),
						h("div", { className: "mm-formHeadMain" },
							h("h1", { className: "mm-formTitle", ref: headingRef, tabIndex: -1 }, editing ? t("form.editTitle") : t("form.newTitle")),
							h("p", { className: "mm-formSubtitle" }, t("form.unsavedHint")))),
					h("div", { className: "mm-tabs" },
						h(Segmented, {
							value: tab,
							label: t("form.tabsLabel"),
							options: [
								{ value: "basic", label: t("form.tabBasic"), testId: "form-tab-basic" },
								{ value: "tools", label: t("form.tabTools"), testId: "form-tab-tools" },
							],
							onChange: (value) => { setTab(value); setBanner(null); },
						})),
					banner ? h(Banner, { banner, onDismiss: () => setBanner(null) }) : null,
					tab === "basic" ? basicPanel : toolsPanel),

				oauthOpen
					? h(OAuthDialog, {
						value: draft.oauth,
						onChange: (oauth) => update({ oauth }),
						onClose: () => setOauthOpen(false),
					})
					: null,
				deleteOpen
					? h(ConfirmDialog, {
						title: t("form.deleteTitle"),
						body: t("form.deleteBody"),
						confirmLabel: t("form.deleteAction"),
						cancelLabel: t("form.cancel"),
						busy: deleting,
						onCancel: () => setDeleteOpen(false),
						onConfirm: remove,
					})
					: null,
				testResult
					? h(TestResultDialog, {
						result: testResult,
						transport: draft.transport,
						busy: testing,
						onClose: () => setTestResult(null),
						onRerun: runTest,
					})
					: null);
		}

		/* ================================================================ */
		/* page                                                              */
		/* ================================================================ */

		function MCPManagerPage() {
			const catalog = useCatalog();
			const [view, setView] = useState({ kind: "list", server: null });
			const [pageTab, setPageTab] = useState("owned");
			const [banner, setBanner] = useState(null);
			const [busyId, setBusyId] = useState("");
			const [errorServer, setErrorServer] = useState(null);
			const [deleteTarget, setDeleteTarget] = useState(null);
			const [deleteBusy, setDeleteBusy] = useState(false);
			const [testState, setTestState] = useState(null);
			const [testBusy, setTestBusy] = useState(false);

			const announce = (kind, message) => setBanner({ kind, message });
			const refreshSoon = () => { void catalog.reload({ quiet: true }); };

			const runAction = async (action, server) => {
				if (action === "edit") {
					setView({ kind: "form", server, id: server.id });
					return;
				}
				if (action === "test") {
					if (testBusy) return;
					setTestBusy(true);
					setTestState({ server, transport: server.transport, status: null });
					try {
						const result = await apiMutate("POST", "/servers/test", bodyFromDraft(draftFromServer(server)));
						setTestState({ server, transport: server.transport, status: result.status || null });
					} catch (failure) {
						if (!isAbortError(failure)) {
							setTestState(null);
							announce("error", t("form.testFailed", { message: failure.message }));
						}
					} finally {
						setTestBusy(false);
					}
					return;
				}
				if (action === "delete") {
					setDeleteTarget(server);
					return;
				}
				if (busyId !== "") return;
				setBusyId(server.id);
				try {
					if (action === "toggle") {
						const enabled = server.enabled !== true;
						await apiMutate("POST", "/servers/" + encodeURIComponent(server.id) + "/enabled", { enabled });
						announce("ok", enabled ? t("action.enabled") : t("action.disabled"));
					} else if (action === "reconnect") {
						await apiMutate("POST", "/servers/" + encodeURIComponent(server.id) + "/reconnect", {});
						announce("ok", t("action.reconnected"));
					}
					refreshSoon();
				} catch (failure) {
					if (!isAbortError(failure)) announce("error", t("action.failed", { message: failure.message }));
				} finally {
					setBusyId("");
				}
			};

			const confirmDelete = async () => {
				if (!deleteTarget || deleteBusy) return;
				setDeleteBusy(true);
				try {
					await apiMutate("DELETE", "/servers/" + encodeURIComponent(deleteTarget.id));
					setDeleteTarget(null);
					announce("ok", t("action.deleted"));
					refreshSoon();
				} catch (failure) {
					if (!isAbortError(failure)) announce("error", t("action.failed", { message: failure.message }));
				} finally {
					setDeleteBusy(false);
				}
			};

			const handleSaved = (...savedArgs) => {
				const outcome = savedArgs[2];
				setView({ kind: "list", server: null });
				if (outcome && outcome.iconError) announce("error", t("icon.uploadFailed", { message: outcome.iconError }));
				else announce("ok", t("action.saved"));
				refreshSoon();
			};

			const handleDeleted = () => {
				setView({ kind: "list", server: null });
				announce("ok", t("action.deleted"));
				refreshSoon();
			};

			const list = h(ListView, {
				catalog,
				banner,
				pageTab,
				onPageTab: setPageTab,
				onAdd: () => setView({ kind: "form", server: null }),
				onAction: runAction,
				onShowError: (server) => setErrorServer(server),
				onDismissBanner: () => setBanner(null),
			});

			const form = h(EditFormView, {
				key: view.kind === "form" && view.server ? view.server.id : "new",
				mode: view.kind === "form" && view.server ? "edit" : "create",
				server: view.kind === "form" ? view.server : null,
				presets: catalog.presets,
				groups: catalog.groups,
				onBack: () => setView({ kind: "list", server: null }),
				onSaved: handleSaved,
				onDeleted: handleDeleted,
				onRefresh: refreshSoon,
			});

			return h("div", { className: "mm-root", "data-testid": "mcp-page" },
				view.kind === "form" ? form : list,
				errorServer
					? h(ErrorDetailDialog, { server: errorServer, onClose: () => setErrorServer(null) })
					: null,
				deleteTarget
					? h(ConfirmDialog, {
						title: t("form.deleteTitle"),
						body: t("form.deleteBody"),
						confirmLabel: t("form.deleteAction"),
						cancelLabel: t("form.cancel"),
						busy: deleteBusy,
						onCancel: () => setDeleteTarget(null),
						onConfirm: confirmDelete,
					})
					: null,
				testState
					? h(TestResultDialog, {
						result: testState,
						transport: testState.transport,
						busy: testBusy,
						onClose: () => setTestState(null),
						onRerun: () => {
							if (testState.server) void runAction("test", testState.server);
						},
					})
					: null);
		}

		/* ================================================================ */
		/* plugin                                                            */
		/* ================================================================ */

		function apply(ctx) {
			appCtx = ctx;
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "mcp-manager: dictionaries");
			tt = ctx.locale.bind(NS);
			ctx.effect(() => mountCss(), "mcp-manager: stylesheet");
			ctx.effect(() => disposeRuntime, "mcp-manager: timers and requests");

			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
			}, MCPManagerPage));

			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 20,
				locale: NS,
				label: () => t("panel"),
			}, MCPPanelIcon));
		}

		exports.name = "mcp-manager-client";
		exports.inject = ["slots", "locale"];
		exports.apply = apply;
		exports.__mcpTest = {
			MCPManagerPage,
			ListView,
			EditFormView,
			ServerCard,
			ToolCard,
			ToolsPanel,
			Modal,
			mountCss,
			setTestRuntime,
			disposeRuntime,
			CSS,
			zh,
			en,
			API_BASE,
			NS,
			PANEL_ID,
			POLL_MS,
			groupServers,
			blankDraft,
			draftFromServer,
			bodyFromDraft,
			validateDraft,
			statusFor,
			transportLabel,
			letterOf,
			iconLetter,
			iconUrlOf,
			ICON_TYPES,
			MAX_ICON_BYTES,
			toolCounts,
			normalizeToolList,
			toolSettingsOf,
			toolSettingsKey,
			normalizeExternalPayload,
			externalToolSettings,
			externalToolSettingsKey,
			externalBaselines,
			ExternalTab,
			ExternalView,
			ExternalToolCard,
			ExternalServerCard,
			ExternalServerView,
		};
		return module.exports;
	}
});
