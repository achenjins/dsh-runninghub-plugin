/**
 * dsh-runninghub-plugin —— 浏览器半边
 * （DSH「插件」页面 → 本插件页 → 配置区 `plugins.bundle.config`）
 *
 * 手写、无构建：本文件不是 ES 模块，也不是 CommonJS 模块，而是 DSH 的
 * ModuleLoader 工厂（`window.__ModuleLoader__.load({ id, factory })`）。
 * 只能 `require("react")` / `require("react/jsx-runtime")`，没有 JSX 编译器，
 * 所以全部用自带的 `h()`（= React.createElement）手写。
 *
 * 挂载点：`plugins.bundle.config`（keyed 槽，**key = 包名 `dsh-runninghub-plugin`**），
 * 由「插件」页面声明，渲染在 bundle 页面「描述」与「行列表」之间。
 * 组件按宿主给的 `view` 两态渲染：
 *   - `summary` → 一行摘要（`国内 N/M 可用 · 海外 N/M 可用 · X 个工作流 · Y 个任务`）
 *   - `page`    → 完整配置面板（宿主页面已有插件名 + 描述，所以我们**不画大标题**）
 * 旧挂载点 `settings.plugins.tab` 已按用户要求移除。
 *
 * 结构：
 *   1. 纯逻辑（导出，供 tests/client 断言）——手风琴 reducer、分组、摘要
 *   2. 传输适配层 `createApi(ctx)`——host 方法名一变只改这一处。
 *      通道优先级：**`remote.runninghub`**（真机主通道，只能经 `ctx.inject` 读）
 *      → HTTP 路由（`POST /plugins/dsh-runninghub-plugin/api`，有 webServer 的组合兜底）
 *      → `ctx.get("runninghub")`。业务错误 `{ok:false,error}` 直接冒泡，只有通道级故障才降级。
 *   3. 样式 `insertStyles()`——`styles.insert(css)` 若可用则优先，静态包走自有
 *      `<style data-dsh-runninghub>`（选择器全部带前缀，明暗两套兜底色）
 *   4. 组件（ErrorBoundary + 状态栏 / Key 管理 / 工作流手风琴 / 文档库 / 任务流水）
 *   5. 插件面 `name` / `inject` / `apply(ctx)`
 *
 * 硬行为（用户要求）：工作流列表默认全部折叠；点某一行才展开它的节点；
 * 同时只展开一个（展开 B 自动收起 A）。见 `toggleExpanded()`。
 *
 * 崩溃隔离：`apply()` 每一步独立 try/catch；面板本身套 ErrorBoundary，
 * 任何渲染异常都降级成一行可读错误，绝不白屏「插件」页面。
 */

window.__ModuleLoader__.load({
	id: "dsh-runninghub-plugin",
	factory: (require) => {
		"use strict";

		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");

		/** 渲染辅助：等价 React.createElement（无 JSX）。 */
		const h = (type, props, ...children) => React.createElement(type, props, ...children);
		/** React.Fragment，缺失时退化为普通 div。 */
		const Fragment = React.Fragment || "div";
		/**
		 * 类组件的基类。**必须在这里（所有 ErrorBoundary 之前）声明** ——
		 * `class X extends BaseComponent` 在**定义时**就求值，声明晚了会踩 TDZ
		 * （`Cannot access 'BaseComponent' before initialization`）。
		 */
		const BaseComponent = typeof React.Component === "function" ? React.Component : class { constructor(props) { this.props = props; } };
		/** 安全取 hooks（极老/桩 React 可能缺）。 */
		const useState = typeof React.useState === "function" ? React.useState : (initial) => [typeof initial === "function" ? initial() : initial, () => {}];
		const useEffect = typeof React.useEffect === "function" ? React.useEffect : () => {};
		const useCallback = typeof React.useCallback === "function" ? React.useCallback : (fn) => fn;
		const useMemo = typeof React.useMemo === "function" ? React.useMemo : (fn) => fn();
		const useRef = typeof React.useRef === "function" ? React.useRef : (initial) => ({ current: initial });

		/** 包名 / 插件 id（与 package.json、ModuleLoader id、bundle id 一致）。 */
		const PKG = "dsh-runninghub-plugin";
		/** Remote 命名空间：host 侧 TYPERT 清单也用这个名字。 */
		const NS = "runninghub";

		/**
		 * `remote.runninghub` 命名空间服务的**唯一合法持有处**。
		 *
		 * Cordis 只允许在 `ctx.inject(['remote.runninghub'], scope => …)` 的作用域里读它；
		 * 在普通 ctx 上取属性会抛 `cannot get property "remote.runninghub" without inject`。
		 * 所以由 `apply()` 在注入回调里赋值，传输层只读这个变量。
		 */
		let injectedRemote = null;

		/**
		 * 客户端运行期错误收集器（**有界**：最近 10 条）。
		 *
		 * 为什么需要它：`api-gateway` 的 `$mount` 实现是
		 *   `const owned = callerCtx.effect(async () => { await enqueue(() => mountContribution(...)) ... }); await owned;`
		 * —— `owned` 是 effect 返回的**函数**，`await` 一个函数立刻 resolve，
		 * 于是 `mountContribution` 里抛的错**被完全吞掉**，`$mount` 照样"成功"。
		 * 浏览器 console 用户看不到、也传不出来，所以只能靠这两个全局钩子把真因留下来，
		 * 再显示到面板上 —— 下次用户截图就带着真因。
		 */
		const CLIENT_ERROR_LIMIT = 10;
		let clientErrors = [];

		/** 记一条客户端错误（截断到 400 字符，只留最近 10 条）。 */
		function recordClientError(kind, raw) {
			try {
				let message;
				if (raw === null || raw === undefined) message = "(空)";
				else if (typeof raw === "string") message = raw;
				else if (typeof raw === "object") message = raw.stack || raw.message || String(raw);
				else message = String(raw);
				clientErrors.push({ kind: String(kind), msg: String(message).slice(0, 400), at: Date.now() });
				if (clientErrors.length > CLIENT_ERROR_LIMIT) clientErrors = clientErrors.slice(-CLIENT_ERROR_LIMIT);
			} catch (error) {
				/* 收集器自己绝不能把面板搞崩 */
			}
		}

		/** 当前收集到的错误（副本）。 */
		function listClientErrors() {
			try {
				return clientErrors.slice();
			} catch (error) {
				return [];
			}
		}

		/** 最近一条错误的单行摘要（给 channelReport 用）。 */
		function latestClientErrorText() {
			const list = listClientErrors();
			if (list.length === 0) return "";
			const last = list[list.length - 1];
			const firstLine = last.msg.split("\n")[0];
			return `${last.kind}：${firstLine.slice(0, 160)}`;
		}

		/**
		 * 装上全局错误钩子；返回卸载函数。
		 * 全程 try/catch —— 收集器是"锦上添花"，任何失败都不能影响插件加载。
		 */
		function installErrorCollector() {
			try {
				if (typeof window === "undefined" || window === null || typeof window.addEventListener !== "function") {
					return () => {};
				}
				const onRejection = (event) => {
					recordClientError("unhandledrejection", event !== null && event !== undefined ? event.reason : undefined);
				};
				const onError = (event) => {
					if (event !== null && event !== undefined && event.error !== undefined && event.error !== null) {
						recordClientError("error", event.error);
					} else {
						recordClientError("error", event !== null && event !== undefined ? event.message : undefined);
					}
				};
				window.addEventListener("unhandledrejection", onRejection);
				window.addEventListener("error", onError);
				return () => {
					try {
						if (typeof window.removeEventListener === "function") {
							window.removeEventListener("unhandledrejection", onRejection);
							window.removeEventListener("error", onError);
						}
					} catch (error) {
						/* 忽略 */
					}
				};
			} catch (error) {
				return () => {};
			}
		}

		/**
		 * `ctx.get("remote.runninghub")` —— **官方存在性探测**（可选读，不抛）。
		 * 证据：api-gateway 的 `validateContribution` 自己就用
		 * `this.ownerCtx.get(remoteServiceKey(namespace)) !== void 0` 判"命名空间是否已存在"。
		 * 注意与"在普通 ctx 上取属性 `remote.runninghub`"不同：那个会抛 without inject。
		 */
		function probeNamespace(ctx) {
			try {
				if (ctx === null || ctx === undefined || typeof ctx.get !== "function") return undefined;
				return ctx.get(`remote.${NS}`);
			} catch (error) {
				return undefined;
			}
		}

		/** 面板可用的日志出口（宿主 console 永远存在，仍兜一层）。 */
		const log = {
			warn: (...args) => {
				try {
					console.warn("[dsh-runninghub-plugin]", ...args);
				} catch (error) {
					/* 静默：日志失败不能影响 UI */
				}
			},
		};

		// ------------------------------------------------------------------
		// 1. 纯逻辑（可测）
		// ------------------------------------------------------------------

		/**
		 * 手风琴 reducer：**同一时刻只允许一个工作流展开**（用户硬要求）。
		 * 点已展开的那一行 → 全部收起；点另一行 → 切换过去（原来那行自动收起）。
		 *
		 * @param state 当前状态：裸 id 字符串 / null，或 `{ expandedId }` 形态的对象
		 * @param id 被点击的工作流 id
		 * @returns 与入参同形态的新状态（对象入参返回浅拷贝，便于 React setState）
		 */
		function toggleExpanded(state, id) {
			const current = state !== null && typeof state === "object" ? state.expandedId : state;
			const target = id === undefined || id === null ? null : id;
			const next = current !== null && current !== undefined && current === target ? null : target;
			if (state !== null && typeof state === "object") {
				const copy = {};
				for (const key of Object.keys(state)) copy[key] = state[key];
				copy.expandedId = next;
				return copy;
			}
			return next;
		}

		/** 当前展开的 id（兼容两种状态形态）。 */
		function expandedIdOf(state) {
			if (state !== null && typeof state === "object") return state.expandedId ?? null;
			return state ?? null;
		}

		/** `outputKind` → 中文徽章文案。 */
		function outputKindLabel(kind) {
			switch (kind) {
				case "image": return "图";
				case "video": return "视频";
				case "audio": return "音频";
				case "3d": return "3D";
				case "text": return "文本";
				case "mixed": return "混合";
				default: return "未知";
			}
		}

		/** `outputKind` → 徽章色调（ok / warn / muted）。 */
		function outputKindTone(kind) {
			switch (kind) {
				case "image": return "ok";
				case "video": return "info";
				case "audio": return "warn";
				case "3d": return "brand";
				default: return "muted";
			}
		}

		/** 地域 → 中文。 */
		function regionLabel(region) {
			switch (region) {
				case "cn": return "国内";
				case "overseas": return "海外";
				case "auto": return "未探测";
				default: return region ? String(region) : "未探测";
			}
		}

		/** 节点角色 → 中文。 */
		const NODE_ROLES = ["prompt", "negative_prompt", "image", "video", "audio", "number", "select", "boolean", "seed", "other"];
		function roleLabel(role) {
			switch (role) {
				case "prompt": return "正向提示词";
				case "negative_prompt": return "负向提示词";
				case "image": return "参考图";
				case "video": return "参考视频";
				case "audio": return "参考音频";
				case "number": return "数值";
				case "select": return "枚举";
				case "boolean": return "开关";
				case "seed": return "随机种子";
				case "other": return "其它";
				default: return role ? String(role) : "其它";
			}
		}

		/** 节点角色 → 折叠分组名（§4 的 UI 分组）。 */
		function roleGroup(role) {
			switch (role) {
				case "prompt":
				case "negative_prompt": return "提示词";
				case "image":
				case "video":
				case "audio": return "参考素材";
				case "number":
				case "select":
				case "boolean":
				case "seed": return "参数";
				default: return "其它";
			}
		}

		/** 分组展示顺序。 */
		const GROUP_ORDER = ["提示词", "参考素材", "参数", "其它"];

		/**
		 * 工作流节点 → 折叠分组（保持组内原顺序，组按 GROUP_ORDER 排序）。
		 * @returns `[{ group, nodes }]`
		 */
		function groupNodes(nodes) {
			const list = Array.isArray(nodes) ? nodes : [];
			const buckets = new Map();
			for (const node of list) {
				if (node === null || typeof node !== "object") continue;
				const raw = typeof node.group === "string" && node.group.trim() !== "" ? node.group.trim() : roleGroup(node.role);
				if (!buckets.has(raw)) buckets.set(raw, []);
				buckets.get(raw).push(node);
			}
			const names = [...buckets.keys()].sort((a, b) => {
				const ia = GROUP_ORDER.indexOf(a);
				const ib = GROUP_ORDER.indexOf(b);
				if (ia === -1 && ib === -1) return a.localeCompare(b, "zh-Hans-CN");
				if (ia === -1) return 1;
				if (ib === -1) return -1;
				return ia - ib;
			});
			return names.map((group) => ({ group: group, nodes: buckets.get(group) }));
		}

		/** 一行摘要需要的字段（列表默认只渲染这一行）。 */
		function summarizeWorkflow(workflow) {
			const wf = workflow !== null && typeof workflow === "object" ? workflow : {};
			const nodes = Array.isArray(wf.nodes) ? wf.nodes : [];
			const optimizer = wf.promptOptimizer !== null && typeof wf.promptOptimizer === "object" ? wf.promptOptimizer : {};
			let promptCount = 0;
			let mediaCount = 0;
			for (const node of nodes) {
				if (node === null || typeof node !== "object") continue;
				if (node.role === "prompt" || node.role === "negative_prompt") promptCount += 1;
				else if (node.role === "image" || node.role === "video" || node.role === "audio") mediaCount += 1;
			}
			return {
				id: String(wf.id || wf.name || ""),
				name: String(wf.name ?? wf.displayNameEn ?? "(未命名)"),
				slug: String(wf.displayNameEn ?? wf.name ?? ""),
				description: typeof wf.description === "string" ? wf.description : "",
				nodeCount: typeof wf.nodeCount === "number" ? wf.nodeCount : nodes.length,
				promptCount: promptCount,
				mediaCount: mediaCount,
				outputKind: typeof wf.outputKind === "string" ? wf.outputKind : "unknown",
				outputLabel: outputKindLabel(wf.outputKind),
				outputTone: outputKindTone(wf.outputKind),
				region: typeof wf.region === "string" ? wf.region : "cn",
				regionLabel: regionLabel(wf.region),
				rhWorkflowId: wf.rhWorkflowId === undefined || wf.rhWorkflowId === null ? "" : String(wf.rhWorkflowId),
				tags: Array.isArray(wf.tags) ? wf.tags.filter((tag) => typeof tag === "string") : [],
				optimizerEnabled: optimizer.enabled === true,
				optimizerDocId: optimizer.docId === undefined ? null : optimizer.docId,
				optimizerAsSubagent: optimizer.asSubagentSystemPrompt === true,
			};
		}

		/** 提示词优化开关状态文案。 */
		function optimizerText(summary) {
			if (!summary || summary.optimizerEnabled !== true) return "提示词优化 关";
			if (summary.optimizerAsSubagent === true) return "提示词优化 开 · 子代理";
			if (summary.optimizerDocId !== null && summary.optimizerDocId !== undefined) return "提示词优化 开 · 挂文档";
			return "提示词优化 开";
		}

		/** 状态栏一行文字：`国内 2/3 可用 · 海外 0/1 可用`。 */
		function poolText(pool) {
			const safe = pool !== null && typeof pool === "object" ? pool : {};
			const cn = safe.cn !== null && typeof safe.cn === "object" ? safe.cn : {};
			const overseas = safe.overseas !== null && typeof safe.overseas === "object" ? safe.overseas : {};
			const part = (label, entry) => `${label} ${Number(entry.available) || 0}/${Number(entry.total) || 0} 可用`;
			return `${part("国内", cn)} · ${part("海外", overseas)}`;
		}

		/** 冷却时间戳 → 文案。 */
		function cooldownText(cooldownUntil, now) {
			if (cooldownUntil === null || cooldownUntil === undefined || cooldownUntil === 0) return "正常";
			const stamp = Number(cooldownUntil);
			if (!Number.isFinite(stamp) || stamp <= 0) return "正常";
			const current = Number.isFinite(now) ? now : Date.now();
			const left = stamp - current;
			if (left <= 0) return "正常";
			const minutes = Math.ceil(left / 60000);
			if (minutes < 60) return `冷却 ${minutes} 分钟`;
			const hours = Math.ceil(minutes / 60);
			return `冷却 ${hours} 小时`;
		}

		/** Key 行状态：失效 / 冷却 / 停用 / 可用。 */
		function keyStateLabel(key, now) {
			const entry = key !== null && typeof key === "object" ? key : {};
			if (entry.invalid === true) return { text: "失效", tone: "error" };
			if (entry.enabled === false) return { text: "已停用", tone: "muted" };
			const cooldown = cooldownText(entry.cooldownUntil, now);
			if (cooldown !== "正常") return { text: cooldown, tone: "warn" };
			return { text: "可用", tone: "ok" };
		}

		/** 多行文本 → 枚举数组（一行一个，去空行）。 */
		function parseOptionsText(text) {
			if (typeof text !== "string") return [];
			return text
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line !== "");
		}

		/**
		 * 编辑态文本 → **规范化**选项列表：trim 每行 + 丢空行 + 去重 + 保持顺序。
		 *
		 * ⚠️ 只在**失焦 / 提交**时调用，绝不在 `onChange` 里调用 ——
		 * 在 onChange 里规范化会把光标末尾那个空行吃掉，用户按回车"没反应"
		 * （真机报的就是这个；"打字后能换行"是因为那行有内容、不被丢）。
		 */
		function normalizeOptions(text) {
			const out = [];
			for (const line of parseOptionsText(text)) {
				if (!out.includes(line)) out.push(line);
			}
			return out;
		}

		/** 枚举数组 → 多行文本。 */
		function optionsToText(options) {
			return Array.isArray(options) ? options.filter((option) => typeof option === "string").join("\n") : "";
		}

		/** 数值输入：空串 → undefined（不写回该字段）。 */
		function numberOrUndefined(text) {
			if (text === "" || text === null || text === undefined) return undefined;
			const value = Number(text);
			return Number.isFinite(value) ? value : undefined;
		}

		/** 把一个节点的补丁合并进节点数组（返回新数组，不改原对象）。 */
		function patchNode(nodes, nodeId, patch, nodeIndex) {
			const list = Array.isArray(nodes) ? nodes : [];
			return list.map((node, index) => {
				if (node === null || typeof node !== "object") return node;
				if (String(node.nodeId) !== String(nodeId)) return node;
				if (nodeIndex !== undefined && index !== nodeIndex) return node;
				const merged = {};
				for (const key of Object.keys(node)) merged[key] = node[key];
				for (const key of Object.keys(patch || {})) {
					if (patch[key] === undefined) delete merged[key];
					else merged[key] = patch[key];
				}
				return merged;
			});
		}

		/** 节点的"范围或枚举"列文案。 */
		function rangeText(node) {
			const entry = node !== null && typeof node === "object" ? node : {};
			if (Array.isArray(entry.options) && entry.options.length > 0) return entry.options.join(" / ");
			const parts = [];
			if (entry.min !== undefined && entry.min !== null) parts.push(`min ${entry.min}`);
			if (entry.max !== undefined && entry.max !== null) parts.push(`max ${entry.max}`);
			if (entry.step !== undefined && entry.step !== null) parts.push(`step ${entry.step}`);
			return parts.length > 0 ? parts.join(" · ") : "—";
		}

		/** 节点的默认值：宿主用 `defaultValue`（避开 JS 保留字），兼容旧的 `default`。 */
		function nodeDefaultValue(node) {
			const entry = node !== null && typeof node === "object" ? node : {};
			return entry.defaultValue !== undefined ? entry.defaultValue : entry.default;
		}

		/** 默认值列文案（对象/数组 JSON 化，超长截断）。 */
		function defaultValueText(value) {
			if (value === undefined || value === null || value === "") return "—";
			let text;
			if (typeof value === "object") {
				try {
					text = JSON.stringify(value);
				} catch (error) {
					text = String(value);
				}
			} else {
				text = String(value);
			}
			return text.length > 60 ? `${text.slice(0, 57)}…` : text;
		}

		/** `probeWorkflow` 回执 → 一行摘要（节点数 / 输出类型 / 地域 / 提示条数）。 */
		function probeSummaryText(result) {
			const entry = result !== null && typeof result === "object" ? result : {};
			const proposal = entry.proposal !== null && typeof entry.proposal === "object" ? entry.proposal : entry;
			const nodes = Array.isArray(proposal.nodes) ? proposal.nodes : [];
			const hints = proposal.hints && Array.isArray(proposal.hints.warnings) ? proposal.hints.warnings : [];
			const parts = [`推断出 ${nodes.length} 个节点`, `输出类型 ${outputKindLabel(proposal.outputKind)}`];
			if (entry.region) parts.push(`地域 ${regionLabel(entry.region)}`);
			if (entry.rhWorkflowId) parts.push(`RH 工作流 ${entry.rhWorkflowId}`);
			if (hints.length > 0) parts.push(`提示 ${hints.length} 条`);
			return parts.join(" · ");
		}

		/** 余额回执 → 一行可读文案（`keysBalance`）。 */
		function balanceText(balance) {
			const entry = balance !== null && typeof balance === "object" ? balance : {};
			const parts = [];
			if (entry.remainCoins !== undefined && entry.remainCoins !== null) parts.push(`余额 ${entry.remainCoins}${entry.currency ? ` ${entry.currency}` : " 点"}`);
			if (entry.remainMoney !== undefined && entry.remainMoney !== null) parts.push(`金额 ${entry.remainMoney}`);
			if (entry.currentTaskCounts !== undefined && entry.currentTaskCounts !== null) parts.push(`当前任务 ${entry.currentTaskCounts}`);
			if (entry.apiType) parts.push(String(entry.apiType));
			if (parts.length > 0) return parts.join(" · ");
			return safeJson(balance);
		}

		/** 时间戳 → 本地短时间。 */
		function timeText(stamp) {
			const value = Number(stamp);
			if (!Number.isFinite(value) || value <= 0) return "—";
			try {
				return new Date(value).toLocaleString();
			} catch (error) {
				return String(value);
			}
		}

		/** 字节数 → 可读体积。 */
		function bytesText(bytes) {
			const value = Number(bytes);
			if (!Number.isFinite(value) || value < 0) return "—";
			if (value < 1024) return `${value} B`;
			if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
			return `${(value / (1024 * 1024)).toFixed(2)} MB`;
		}

		/** 任务状态 → 中文 + 色调。 */
		function taskState(status) {
			switch (status) {
				case "SUCCESS":
				case "success":
				case "SUCCEEDED": return { text: "生成完成", tone: "ok" };
				case "FAILED":
				case "failed": return { text: "失败", tone: "error" };
				case "CANCEL":
				case "CANCELLED":
				case "cancelled":
				case "CANCELED": return { text: "已取消", tone: "muted" };
				case "RUNNING":
				case "running": return { text: "运行中", tone: "info" };
				case "QUEUED":
				case "queued":
				case "PENDING":
				case "pending": return { text: "排队中", tone: "warn" };
				case "ERROR": return { text: "等待恢复", tone: "error" };
				case "UNCERTAIN":
				case "TRANSPORT_UNCERTAIN": return { text: "待核对", tone: "error" };
				default: return { text: status ? String(status) : "未知", tone: "muted" };
			}
		}

		/** 错误对象 → 可读中文（绝不吞异常：调用方仍会展示它）。 */
		function describeError(error) {
			if (error === null || error === undefined) return "未知错误";
			if (typeof error === "string") return error;
			const code = typeof error.code === "string" && error.code !== "" ? error.code : "";
			const message = typeof error.message === "string" && error.message !== "" ? error.message : "";
			const hint = typeof error.hint === "string" && error.hint !== "" ? error.hint : "";
			const head = code !== "" && message !== "" ? `${code}: ${message}` : code || message || String(error);
			return hint !== "" ? `${head}（${hint}）` : head;
		}

		// ------------------------------------------------------------------
		// 2. 传输适配层
		// ------------------------------------------------------------------

		/**
		 * host 侧逻辑方法表：`逻辑名 → { host, params }`。
		 *
		 * 命名契约：host 服务名 `runninghub`，
		 * 方法为下列 camelCase（`keys.add` → `keysAdd`）。**名字一变只改这张表。**
		 */
		const API_METHODS = {
			status: { host: "status", params: [] },
			listWorkflows: { host: "listWorkflows", params: [] },
			saveWorkflow: { host: "saveWorkflow", params: ["config"] },
			deleteWorkflow: { host: "deleteWorkflow", params: ["name"] },
			probeWorkflow: { host: "probeWorkflow", params: ["request"] },
			keysAdd: { host: "keysAdd", params: ["entry"] },
			keysUpdate: { host: "keysUpdate", params: ["id", "patch"] },
			keysRemove: { host: "keysRemove", params: ["id"] },
			keysDetect: { host: "keysDetect", params: ["id"] },
			keysBalance: { host: "keysBalance", params: ["id"] },
			docsList: { host: "docsList", params: [] },
			docsGet: { host: "docsGet", params: ["docId"] },
			docsSave: { host: "docsSave", params: ["doc"] },
			docsRemove: { host: "docsRemove", params: ["docId"] },
			tasksList: { host: "tasksList", params: ["limit", "status"] },
			tasksGet: { host: "tasksGet", params: ["taskId"] },
			tasksRefresh: { host: "tasksRefresh", params: ["taskId"] },
			tasksRetry: { host: "tasksRetry", params: ["taskId"] },
			tasksCancel: { host: "tasksCancel", params: ["taskId"] },
			// 任务流水保留条数：不传 limit 是只读（`{}`），传了才写。
			// ⚠️ `0` 是合法值（= 不限制），buildParams 用 `!== undefined` 判断，不会被吞。
			tasksLimit: { host: "tasksLimit", params: ["limit"] },
			diagnostics: { host: "diagnostics", params: [] },
		};

		/** 通用桥方法名：host 可只声明这一个 Remote 方法（参数是 JSON 字符串）。 */
		const GENERIC_METHOD = "call";
		/**
		 * Remote 描述符的 wire 字段名。
		 *
		 * 必须与 host/remote-manifest.mjs 的 PARAMS_WIRE 一致：
		 * 宿主每个方法都只声明一个 `params` 字段，调用约定是
		 * `ctx.remote.runninghub.<method>(paramsObject)` —— 位置参数只有 1 个。
		 */
		const PARAMS_WIRE = "params";
		/**
		 * host 侧 HTTP 路由（Lead 决策：**首选通道**，零依赖，见 `host/rpc.mjs`）。
		 * 同源相对路径，host 刻意没开 CORS。
		 */
		const HTTP_PATH = "/plugins/dsh-runninghub-plugin/api";
		/**
		 * host 侧图片路由（`POST {attachment}` → 二进制）。
		 * 由 Lead 在 `host/` 侧实现（同源校验 + 64 KiB body 上限）。
		 * 与参考实现 `shanliuling/dsh-image-gen` 的 `IMAGE_ROUTE` 同构。
		 */
		const IMAGE_ROUTE = "/plugins/dsh-runninghub-plugin/image";

		/**
		 * 手写 descriptor 的宽松 codec：客户端**不**执行 schema
		 * （api-remotes 只校验 `codec.mode === "strict"`，实参校验在 Host 侧）。
		 */
		function looseCodec(typeSymbol) {
			return Object.freeze({
				mode: "strict",
				typeSymbol: typeSymbol,
				create: () => undefined,
			});
		}

		/**
		 * 造一个一元 Remote invocation descriptor（与 host/rpc-remote.mjs 同形）。
		 * 每个方法**只有一个 `params` wire 字段**（`acceptsUndefined: true`，零参可省）。
		 */
		function makeDescriptor(namespace, method) {
			return Object.freeze({
				id: `${PKG}#${namespace}/${method}`,
				service: namespace,
				namespace: namespace,
				method: method,
				invocation: Object.freeze({ kind: "direct" }),
				parameters: Object.freeze([
					Object.freeze({
						name: PARAMS_WIRE,
						wire: PARAMS_WIRE,
						source: "json",
						acceptsUndefined: true,
						codec: looseCodec(`${PKG}/types#${method}Params`),
					}),
				]),
				result: looseCodec(`${PKG}/types#${method}Result`),
				sourceLocation: Object.freeze({ file: "client/client.js", line: 1, column: 1 }),
			});
		}

		/** 面板注册的全部 descriptors（host 侧 TYPERT 清单需镜像同一组）。 */
		function buildDescriptors() {
			const list = [makeDescriptor(NS, GENERIC_METHOD)];
			for (const logical of Object.keys(API_METHODS)) {
				list.push(makeDescriptor(NS, API_METHODS[logical].host));
			}
			return Object.freeze(list);
		}

		const DESCRIPTORS = buildDescriptors();

		/** 从任意 ctx 形态安全取一个服务。 */
		function safeGet(ctx, key) {
			if (ctx === null || ctx === undefined) return undefined;
			try {
				if (typeof ctx.get === "function") {
					const value = ctx.get(key);
					if (value !== undefined && value !== null) return value;
				}
			} catch (error) {
				/* 服务 getter 抛错不该拖垮面板 */
			}
			try {
				const direct = ctx[key];
				if (direct !== undefined && direct !== null) return direct;
			} catch (error) {
				/* 同上 */
			}
			return undefined;
		}

		/** 去掉 RemoteResult / `{ok,value|data}` / `{error}` 外壳。 */
		function unwrapResult(value) {
			if (value !== null && typeof value === "object" && !Array.isArray(value)) {
				if (value.ok === false) throw toApiError(value.error);
				if (value.ok === true) {
					if (Object.prototype.hasOwnProperty.call(value, "value")) return unwrapResult(value.value);
					if (Object.prototype.hasOwnProperty.call(value, "data")) return unwrapResult(value.data);
					return value;
				}
			}
			return value;
		}

		/** 任意错误形态 → Error（带 code/hint）。 */
		function toApiError(raw) {
			if (raw instanceof Error) return raw;
			const error = new Error(describeError(raw));
			if (raw !== null && typeof raw === "object") {
				if (typeof raw.code === "string") error.code = raw.code;
				if (typeof raw.hint === "string") error.hint = raw.hint;
			}
			return error;
		}

		/**
		 * 业务错误（宿主明确回答 `ok:false`）：带 `business` 标记，
		 * 通道层看到它**直接冒泡**，不会换通道重试（避免把失败当成功、或重复付费调用）。
		 */
		function businessError(raw) {
			const error = toApiError(raw);
			error.business = true;
			return error;
		}

		/** 是否业务错误。 */
		function isBusinessError(error) {
			return error !== null && typeof error === "object" && error.business === true;
		}

		/** 请求凭据只用于发送；网关或代理回显时，在记录错误前移除。 */
		function requestErrorRedactor(params) {
			const secrets = new Set();
			const seen = new Set();
			const collect = (value) => {
				if (value === null || typeof value !== "object" || seen.has(value)) return;
				seen.add(value);
				for (const [name, item] of Object.entries(value)) {
					if (/^(?:api[-_]?key(?:value)?|key|secret|token|password|authorization)$/i.test(name) && typeof item === "string" && item !== "") {
						secrets.add(item.replace(/^Bearer\s+/i, ""));
					} else if (item !== null && typeof item === "object") collect(item);
				}
			};
			collect(params);
			return (value) => {
				let text = String(value);
				for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
					if (secret) text = text.split(secret).join("****");
				}
				return text;
			};
		}

		/** JSON 字符串 → 对象（解析失败时原样返回）。 */
		function parseMaybeJson(value) {
			if (typeof value !== "string") return value;
			const text = value.trim();
			if (text === "" || (text[0] !== "{" && text[0] !== "[")) return value;
			try {
				return JSON.parse(text);
			} catch (error) {
				return value;
			}
		}

		/** Remote 就绪门的等待上限（真机首屏竞态：注入是异步的，不能"没就绪就放弃"）。 */
		const REMOTE_READY_TIMEOUT_MS = 2000;

		/**
		 * `$mount` 被吞掉的错误里，哪些其实意味着"**命名空间已经在了**"（= 成功态）。
		 *
		 * 证据（两条都会被 `$mount` 吞掉、`$mount` 照样 resolve）：
		 *   - `@deepseek-ai/dsh-typert-registry` RemoteStore.register：
		 *     `typert: Remote package "<pkg>" is already registered`
		 *   - `dsh-api-gateway` validateContribution：
		 *     `client api: namespace "<ns>" conflicts with an existing Remote namespace`
		 * 这两条在"第二次 mount / HMR / 别的入口已经挂过"时必然出现，
		 * 而命名空间其实已经建好了 —— 判成失败会把好好的通道判死。
		 */
		function isAlreadyMountedError(text) {
			return /already registered|conflicts with an existing Remote namespace|is already mounted|is no longer mounted|repeats (direct|scoped) method/i.test(
				String(text),
			);
		}

		/** 只给纯函数用的别名（导出名更贴近"这是在判断错误类别"）。 */
		function describeChannelError(text) {
			return isAlreadyMountedError(text) ? "already-mounted" : "failure";
		}

		/** 全模块**只尝试一次** `$mount`（按 ctx 缓存不够：不同 ctx 会各挂一次 → 撞"已注册"）。 */
		let globalMountPromise = null;
		/** `$mount` 的真实失败原因（原文；旧实现只 console.warn 就丢了）。 */
		let globalMountError = null;
		/** "已注册/已存在"类提示（成功态，但值得显示出来）。 */
		let globalMountNote = null;

		/**
		 * 挂 Remote 贡献 —— **全模块一次**。
		 *
		 * ⚠️ `$mount` 的 resolve **不可信**：api-gateway 的实现是
		 *   `const owned = callerCtx.effect(async () => { await enqueue(() => mountContribution(...)) ... }); await owned;`
		 * `owned` 是函数，`await` 函数立刻 resolve → `mountContribution` 抛的错被完全吞掉。
		 * 所以真实结局只能靠**副作用**判定：`ctx.get("remote.runninghub")` 存不存在。
		 */
		function mountNamespace(ctx) {
			if (globalMountPromise !== null) return globalMountPromise;
			globalMountPromise = (async () => {
				// ① 命名空间已经在了（HMR / 二次 apply / 别人挂过）→ 直接算成功，**不再 mount**
				if (probeNamespace(ctx) !== undefined) return true;
				const remote = safeGet(ctx, "remote");
				if (remote === null || typeof remote !== "object" || typeof remote.$mount !== "function") {
					globalMountError = "宿主没有 remote 服务";
					return false;
				}
				try {
					// ⚠️ 不要在这里读 `remote[NS]`：命名空间服务在普通 ctx 上取属性会抛
					// `cannot get property … without inject`（真机白屏过一次）。
					await remote.$mount({ package: PKG, descriptors: DESCRIPTORS });
				} catch (error) {
					const text = describeError(error);
					if (isAlreadyMountedError(text) || probeNamespace(ctx) !== undefined) {
						// "已注册/已存在" = 成功态，但把原文留下来给诊断
						globalMountNote = text;
						log.warn("Remote 命名空间已存在（视为成功）：", text);
						return true;
					}
					globalMountError = text;
					globalMountPromise = null; // 允许下一次 apply 重试
					log.warn("Remote 贡献挂载失败：", text);
					return false;
				}
				return true; // 真实结局由注入 / 探测判定
			})();
			return globalMountPromise;
		}

		/** 有 setTimeout 就用它，否则退化成"只让一个微任务"。 */
		function sleep(ms) {
			return new Promise((resolve) => {
				if (typeof setTimeout === "function") {
					setTimeout(resolve, ms);
					return;
				}
				Promise.resolve().then(resolve);
			});
		}

		/**
		 * Remote 就绪门（有界等待）。
		 *
		 * 真机竞态：`apply()` 里 `$mount()` resolve 之后才注册 `ctx.inject(...)`，
		 * 而 cordis 的注入回调要等命名空间真正出现才触发 —— 面板首屏的
		 * `api.status()` 几乎必然跑在这之前。旧实现此时 `remoteService()` 返回 null
		 * 就直接掉到 HTTP 兜底，而 desktop 组合没有 `webServer` → HTTP 405 →
		 * 用户看到 `NO_TRANSPORT: … HTTP 405`。
		 *
		 * 现在改成"等就绪"：mount 成功后有界轮询（≤2s）。
		 * **只在 mount 成功时才等** —— 宿主没有 remote 服务 / `$mount` 失败时不白等。
		 */
		function createRemoteGate(ctx) {
			let state = "idle"; // idle | mounting | waiting | ready | timeout | unavailable | mount-failed | namespace-missing | no-inject
			let readyPromise = null;

			/** 等就绪：探测 → （必要时）全模块唯一一次 mount → 注入 → 再探测。 */
			const ensure = () => {
				if (readyPromise !== null) return readyPromise;
				readyPromise = (async () => {
					// ① 已经有值（别的入口/上一代装好了）
					if (injectedRemote !== null) {
						state = "ready";
						return injectedRemote;
					}
					// ② **官方存在性探测**：命名空间已经在 → 直接用，别再 mount。
					//    这条同时兜住：HMR / 二次 apply / 上一代已注册（typert 会报 "already registered"）。
					const existing = probeNamespace(ctx);
					if (existing !== undefined) {
						injectedRemote = existing;
						state = "ready";
						return injectedRemote;
					}
					// ③ 全模块只挂一次
					state = "mounting";
					const mounted = await mountNamespace(ctx);
					if (mounted !== true) {
						state = "mount-failed";
						return null;
					}
					if (injectedRemote !== null) {
						state = "ready";
						return injectedRemote;
					}
					// ④ 注入是唯一"正规"读法；**等注入回调本身**（不傻轮询），
					//    命名空间一到就立刻返回，首屏不吃轮询间隔的延迟。
					if (typeof ctx.inject !== "function") {
						state = "no-inject";
						log.warn("ctx.inject 不可用，无法接住 remote 命名空间");
						return null;
					}
					let armError = null;
					const injected = new Promise((resolve) => {
						try {
							ctx.inject([`remote.${NS}`], (scope) => {
								try {
									injectedRemote = scope.remote[NS];
								} catch (error) {
									log.warn("注入 remote.runninghub 后仍取不到：", describeError(error));
									injectedRemote = null;
								}
								resolve();
							});
						} catch (error) {
							armError = describeError(error);
							resolve();
						}
					});
					state = "waiting";
					const outcome = await Promise.race([
						injected.then(() => "injected"),
						sleep(REMOTE_READY_TIMEOUT_MS).then(() => "timeout"),
					]);
					if (injectedRemote !== null) {
						state = "ready";
						return injectedRemote;
					}
					if (outcome === "injected" && armError !== null) {
						state = "no-inject";
						log.warn(`ctx.inject(remote.${NS}) 失败：`, armError);
						return null;
					}
					// ⑤ 超时（或注入到了但服务为空）：**再探测一次**。
					//    `$mount` 会吞错，所以真实结局只能看副作用：命名空间到底建出来没有。
					const late = probeNamespace(ctx);
					if (late !== undefined) {
						injectedRemote = late;
						state = "ready";
						return late;
					}
					state = globalMountError === null ? "namespace-missing" : "mount-failed";
					log.warn(
						`Remote 命名空间未出现（${globalMountError === null ? "mount 未报错但命名空间没建出来" : globalMountError}）` +
							(latestClientErrorText() === "" ? "" : `；最近客户端错误：${latestClientErrorText()}`),
					);
					return null;
				})();
				return readyPromise;
			};

			return {
				ensure: ensure,
				/** 真正的 mount 动作（全模块一次）。 */
				mount: () => mountNamespace(ctx),
				get state() {
					return state;
				},
				get error() {
					return globalMountError;
				},
				/** Remote 不可用时的**原因短语**（不带外层包装，便于拼进别的句子）。 */
				reason() {
					switch (state) {
						case "ready":
							return "已就绪";
						case "idle":
						case "mounting":
						case "waiting":
							return "正在连接…";
						case "timeout":
							return `尚未就绪：$mount 成功，但命名空间注入等待 ${REMOTE_READY_TIMEOUT_MS / 1000}s 超时`;
						case "mount-failed":
							return `未尝试：$mount 失败：${globalMountError === null ? "未知原因" : globalMountError}`;
						case "namespace-missing":
							return `$mount 已返回，但命名空间 remote.${NS} 没建出来（$mount 会吞掉内部异常；最近客户端错误：${
								latestClientErrorText() === "" ? "无" : latestClientErrorText()
							}）`;
						case "no-inject":
							return "未尝试：ctx.inject 不可用，接不住命名空间";
						default:
							return "未尝试：宿主没有 remote 服务";
					}
				},
				/** 状态栏 / 回执用的一句话解释。 */
				explain() {
					return `remote（${this.reason()}）`;
				},
			};
		}

		/**
		 * 建立 host 通道。**通道优先级（真机实测后修订，2026-09-30）**：
		 *
		 *   1. **`remote.runninghub`** —— 真机（desktop 组合）里**唯一可用**的通道：
		 *      宿主自检显示这个组合没有 `webServer` 服务，HTTP 路由直接 405，
		 *      `clientBridge` 实际是 `{kind:'remote', namespace:'runninghub'}`。
		 *      ⚠️ 只能通过 `ctx.inject(['remote.runninghub'], …)` 拿到的 scope 读它，
		 *      在普通 ctx 上取属性会抛 `cannot get property … without inject`
		 *      （见 `injectedRemote`）。
		 *      ⚠️ 注入是**异步**的 —— 首屏必须 await 就绪门（`ensureRemote`），
		 *      不能"没就绪就掉 HTTP"（真机 405 竞态，见 `createRemoteGate`）。
		 *   2. **HTTP 路由** `POST /plugins/dsh-runninghub-plugin/api` —— 给有
		 *      `webServer` 的组合兜底。body `{ method, params }`；回执
		 *      `{ok:true,...}` / `{ok:false,error:{...}}`（判据看 body.ok，不是状态码）。
		 *   3. `ctx.get("runninghub")` —— 宿主服务直连（同进程 / 测试场景）。
		 *
		 * 语义：**业务错误（ok:false）直接抛，不换通道重试**；
		 * 只有通道级故障（传输失败 / 非 200 / body 不是 JSON）才降级。
		 */
		function createTransport(ctx) {
			let activeKind = null; // 成功过的通道：remote / http / service
			let httpDown = false; // HTTP 探测失败后不再每次重试
			let httpLastError = null; // 最近一次 HTTP 通道级故障（诊断用）
			let genericOk = null; // Remote 通用桥是否可用（null = 未定）
			const gate = createRemoteGate(ctx);

			/** 挂载 Remote 贡献（幂等；失败不抛给调用方）。 */
			const mount = () => gate.mount();

			/** Remote 命名空间服务（`$mount` + `ctx.inject` 之后才有）。
			 *
			 * **只读 `injectedRemote`** —— 绝不在普通 ctx 上直接取 `remote.runninghub`：
			 * 那是命名空间服务，Cordis 只允许在 `ctx.inject(['remote.runninghub'], …)`
			 * 的作用域里访问，否则抛 `cannot get property "remote.runninghub" without inject`。
			 */
			const remoteService = () => {
				const svc = injectedRemote;
				return svc !== null && svc !== undefined && typeof svc === "object" ? svc : null;
			};

			/** 有界等待 Remote 就绪（结果缓存；已在则立即返回）。 */
			const ensureRemote = () => gate.ensure();

			/** 宿主服务直连。 */
			const directService = () => {
				const svc = safeGet(ctx, NS) || safeGet(ctx, "runninghubPanel");
				return svc !== null && svc !== undefined && typeof svc === "object" ? svc : null;
			};

			/** HTTP 通道是否可用。 */
			const httpAvailable = () => httpDown === false && typeof fetch === "function";

			/**
			 * 走 HTTP 路由：`POST {method, params}`。
			 * 通道级故障抛普通 Error（调用方会降级）；业务失败抛 businessError（直接冒泡）。
			 */
			const invokeHttp = async (hostMethod, params, redact) => {
				const response = await fetch(HTTP_PATH, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ method: hostMethod, params: params }),
				});
				const text = typeof response.text === "function" ? await response.text() : "";
				if (response.ok !== true) throw new Error(`HTTP ${response.status}${text === "" ? "" : `：${redact(text).slice(0, 200)}`}`);
				const body = parseMaybeJson(text);
				if (body === null || typeof body !== "object") {
					throw new Error(`响应不是 JSON：${redact(text).slice(0, 160)}`);
				}
				// 列表类方法直接回 JSON 数组（host 的 dispatch 原样透传），不能当成对象判 ok。
				if (!Array.isArray(body) && body.ok === false) throw businessError(body.error);
				return unwrapResult(body);
			};

			/** 先拆网关外壳，再判宿主业务结果；两种错误决定是否允许换通道。 */
			const remoteValue = (raw) => {
				// RemoteResult 判别联合：网关/装配类错误码 = 通道问题（可降级）；
				// 其它 = 宿主业务失败（直接冒泡）。
				if (raw !== null && typeof raw === "object" && raw.ok === false) {
					const code = raw.error !== null && typeof raw.error === "object" && typeof raw.error.code === "string" ? raw.error.code : "";
					// ⚠️ 只认 **`gateway/` 前缀**。早先还匹配 `internal` / `client api` / `typert`：
					//   · `client api` / `typert` 只出现在 message 里，**从来不是** RemoteResult 的 code（死分支）；
					//   · 而 `INTERNAL` 是**宿主自己的业务码**（`host/rpc.mjs` 的包装器、`host/shared.mjs`、
					//     工具分发捕获到异常时都返回它）。把它当通道故障 → 客户端换 HTTP **重跑一遍**，
					//     于是 `keysAdd` / `docsSave` / `tasksCancel` 这类**写操作被执行两次**，
					//     而且真正的失败被 HTTP 那次的结果盖掉（用户看到成功）。
					// 宁可少降级也不能重复执行写操作 —— 拿不准就按业务失败冒泡。
					if (code === "" || /^gateway\//i.test(code)) throw toApiError(raw.error);
					throw businessError(raw.error);
				}
				const body = parseMaybeJson(raw !== null && typeof raw === "object" && raw.ok === true && Object.prototype.hasOwnProperty.call(raw, "value") ? raw.value : raw);
				if (body !== null && typeof body === "object" && body.ok === false) throw businessError(body.error);
				return unwrapResult(body);
			};
			const invokeRemoteGeneric = async (svc, hostMethod, params) => {
				const callJson = JSON.stringify({ method: hostMethod, params: params });
				return remoteValue(await svc[GENERIC_METHOD]({ callJson: callJson }));
			};

			/** 位置参数 → 具名 params 对象（HTTP body 的形状，undefined 字段不传）。 */
			const buildParams = (spec, positional) => {
				const params = {};
				spec.params.forEach((paramName, index) => {
					if (positional[index] !== undefined) params[paramName] = positional[index];
				});
				return params;
			};

			return {
				/** 当前通道名（简单 token，逻辑/测试用）。 */
				get kind() {
					if (activeKind !== null) return activeKind;
					if (remoteService() !== null) return "remote";
					// 还没就绪 / 还在连：把就绪门踢起来（不阻塞），如实报"正在连接"
					if (gate.state === "idle" || gate.state === "mounting" || gate.state === "waiting") {
						void gate.ensure();
						return "remote";
					}
					if (httpAvailable()) return "http";
					if (directService() !== null) return "service";
					return "无可用通道";
				},
				/**
				 * 通道诊断（状态栏展示用）：结论 + 原因。
				 * 用户截图里那行 `通道 —` 就是它 —— 让面板自己说清"为什么不可用"，
				 * 免得只能靠"回执里少了哪一段"隔空猜。
				 */
				describe() {
					const remoteReason = gate.reason();
					if (activeKind === "remote") return "remote";
					if (activeKind === "http") {
						// 为什么不是 remote？这一句正是排查时最需要的
						const parts = [`http（Remote 不可用：${remoteReason}）`];
						if (httpLastError !== null) parts.push(`（HTTP 曾失败：${httpLastError}）`);
						return parts.join("");
					}
					if (activeKind === "service") return `service（Remote 不可用：${remoteReason}）`;
					const parts = [`remote（${remoteReason}）`];
					if (httpDown) parts.push(`http（已判定不可用：${httpLastError === null ? "未知原因" : httpLastError}）`);
					else if (typeof fetch !== "function") parts.push("http（不可用：环境没有 fetch）");
					else parts.push("http（未尝试）");
					if (directService() === null) parts.push("宿主服务（未提供）");
					return parts.join(" · ");
				},
				/** 确保 Remote 贡献已尝试挂载（由 apply() 调用；失败不抛）。 */
				mount: mount,
				/** 踢起就绪门（$mount → 注入等待），返回 Promise；由 apply() fire-and-forget 调用。 */
				ensureReady: () => gate.ensure(),
				/**
				 * 调一个逻辑方法。
				 * @param logical API_METHODS 的键
				 * @param args 位置参数（按 params 顺序）
				 */
				call: async (logical, args) => {
					const spec = API_METHODS[logical];
					if (spec === undefined) throw new Error(`未知的宿主方法：${logical}`);
					const positional = (args || []).slice(0, spec.params.length);
					const params = buildParams(spec, positional);
					const redact = requestErrorRedactor(params);
					const safeError = (raw) => {
						const error = new Error(redact(describeError(raw)));
						if (raw && typeof raw.code === "string") error.code = redact(raw.code);
						if (raw && typeof raw.hint === "string") error.hint = redact(raw.hint);
						if (isBusinessError(raw)) error.business = true;
						return error;
					};
					const failures = [];

					// ① Remote 贡献（真机上的主通道）：先通用桥，再直连方法。
					//    **先 await 就绪门**：注入是异步的，首屏不能"没就绪就掉 HTTP"（真机 405 竞态）。
					if (activeKind === null || activeKind === "remote") {
						let svc = remoteService();
						// **先 await 就绪门**：注入是异步的，首屏不能"没就绪就掉 HTTP"（真机 405 竞态）
						if (svc === null) svc = await ensureRemote();
						if (svc !== null) {
							if (genericOk !== false && typeof svc[GENERIC_METHOD] === "function") {
								try {
									const value = await invokeRemoteGeneric(svc, spec.host, params);
									genericOk = true;
									activeKind = "remote";
									return value;
								} catch (error) {
									error = safeError(error);
									if (isBusinessError(error)) throw error;
									genericOk = false;
									failures.push(`Remote(call)：尝试失败：${describeError(error)}`);
								}
							}
							if (typeof svc[spec.host] === "function") {
								try {
									// 宿主约定：一个位置参数 = params 对象
									const value = remoteValue(await svc[spec.host](params));
									activeKind = "remote";
									return value;
								} catch (error) {
									error = safeError(error);
									if (isBusinessError(error)) throw error;
									failures.push(`Remote(${spec.host})：尝试失败：${describeError(error)}`);
								}
							}
							if (failures.length === 0) failures.push("Remote：已就绪但既没有通用桥也没有该方法");
						} else if (gate.state !== "ready") {
							// **区分"没尝试"与"尝试了失败"** —— 上一次就是这里含糊，害得隔着屏幕猜
							failures.push(`Remote：${gate.explain()}`);
						}
					}

					// ② HTTP 路由（兜底：只有宿主注册了 webServer 的组合才有）
					if (activeKind === null || activeKind === "http") {
						if (httpAvailable()) {
							try {
								const value = await invokeHttp(spec.host, params, redact);
								activeKind = "http";
								return value;
							} catch (error) {
								error = safeError(error);
								if (isBusinessError(error)) throw error;
								activeKind = null;
								httpDown = true;
								httpLastError = describeError(error);
								failures.push(`HTTP：尝试失败：${httpLastError}`);
								log.warn("HTTP 通道不可用（宿主可能没有 webServer 服务），降级试宿主服务：", httpLastError);
							}
						} else {
							failures.push(`HTTP：未尝试（${httpDown ? `已判定不可用：${httpLastError}` : "环境没有 fetch"}）`);
						}
					}

					// ③ 宿主服务直连
					if (activeKind === null || activeKind === "service") {
						const svc = directService();
						if (svc !== null && typeof svc[spec.host] === "function") {
							try {
								// 宿主服务的方法签名同样是 `(params)`（与 host/rpc.mjs 的方法表一致）
								const raw = await svc[spec.host](params);
								if (raw !== null && typeof raw === "object" && raw.ok === false) throw businessError(raw.error);
								const value = unwrapResult(raw);
								activeKind = "service";
								return value;
							} catch (error) {
								error = safeError(error);
								if (isBusinessError(error)) throw error;
								failures.push(`宿主服务(${spec.host})：尝试失败：${describeError(error)}`);
							}
						} else {
							failures.push("宿主服务：未尝试（ctx 上没有 runninghub 服务）");
						}
					}

					// 聚合回执：**每个通道一行**，让人从截图就能定位
					const error = new Error(["与宿主通信失败（NO_TRANSPORT）：", ...failures.map((line) => `  · ${line}`)].join("\n"));
					error.code = "NO_TRANSPORT";
					error.channels = failures.slice();
					throw error;
				},
			};
		}

		/**
		 * 面板的 `api` 适配层：组件只认这些方法，不认通道。
		 * 每个方法失败时抛带中文说明的 Error（调用方负责显示）。
		 */
		/**
		 * 一个 ctx 只有一个 api（也就只有一个就绪门 / 一个通道）。
		 * 面板的 summary 与 page 两态共用 apply() 建的那一个 api —— 不会再各建一个，
		 * 也就不会出现"第二次 $mount 撞已注册"的隐患。
		 */
		const API_CACHE = new WeakMap();

		function createApi(ctx) {
			if (ctx !== null && typeof ctx === "object") {
				const cached = API_CACHE.get(ctx);
				if (cached !== undefined) return cached;
			}
			const transport = createTransport(ctx);
			const api = {
				/** 简单通道 token（逻辑 / 测试用）。 */
				get transportKind() {
					return transport.kind;
				},
				/** 通道诊断一句话（状态栏用）：结论 + 原因。 */
				get channelReport() {
					try {
						return transport.describe();
					} catch (error) {
						return `通道诊断失败：${describeError(error)}`;
					}
				},
				/** 把 Remote 就绪门踢起来（不阻塞、不抛）：$mount → 注入等待。 */
				ensureRemoteReady: () => {
					try {
						void transport.ensureReady();
					} catch (error) {
						log.warn("Remote 就绪门启动失败：", describeError(error));
					}
				},
				status: () => transport.call("status", []),
				listWorkflows: () => transport.call("listWorkflows", []),
				saveWorkflow: (config) => transport.call("saveWorkflow", [config]),
				deleteWorkflow: (name) => transport.call("deleteWorkflow", [name]),
				probeWorkflow: (request) => transport.call("probeWorkflow", [request]),
				keys: {
					add: (entry) => transport.call("keysAdd", [entry]),
					update: (id, patch) => transport.call("keysUpdate", [id, patch]),
					remove: (id) => transport.call("keysRemove", [id]),
					detect: (id) => transport.call("keysDetect", [id]),
					balance: (id) => transport.call("keysBalance", [id]),
				},
				docs: {
					list: () => transport.call("docsList", []),
					get: (docId) => transport.call("docsGet", [docId]),
					save: (doc) => transport.call("docsSave", [doc]),
					remove: (docId) => transport.call("docsRemove", [docId]),
				},
				tasks: {
					list: (limit, status) => transport.call("tasksList", [limit, status]),
					get: (taskId) => transport.call("tasksGet", [taskId]),
					refresh: (taskId) => transport.call("tasksRefresh", [taskId]),
					retry: (taskId) => transport.call("tasksRetry", [taskId]),
					cancel: (taskId) => transport.call("tasksCancel", [taskId]),
				},
				/** 任务流水保留条数：不传参 = 只读；传了（含 0）= 写入并立刻清理一次。 */
				tasksLimit: (limit) => transport.call("tasksLimit", [limit]),
				diagnostics: () => transport.call("diagnostics", []),
				/** 客户端运行期错误（有界快照）——面板要显示给用户看。 */
				listClientErrors: () => listClientErrors(),
			};
			if (ctx !== null && typeof ctx === "object") API_CACHE.set(ctx, api);
			return api;
		}

		// ------------------------------------------------------------------
		// 3. 样式（styles.insert 优先；退化为自有 <style>，仍然可清理）
		// ------------------------------------------------------------------

		/** 面板根标记：所有选择器都挂在它下面（含 data 属性以便测试定位）。 */
		const ROOT_ATTR = "data-dsh-runninghub";

		/** 自有 <style> 的引用计数（多个挂载点共用一个元素）。 */
		let styleInstalls = 0;
		let styleElement = null;

		/** 退化路径：直接建一个 <style data-dsh-runninghub>。 */
		function insertStyleElement(css) {
			let disposed = false;
			styleInstalls += 1;
			if (styleElement === null || styleElement.isConnected === false) {
				if (typeof document !== "undefined" && document !== null && typeof document.createElement === "function") {
					styleElement = document.createElement("style");
					styleElement.setAttribute(ROOT_ATTR, "");
					styleElement.textContent = css;
					const head = document.head || document.documentElement;
					if (head && typeof head.appendChild === "function") head.appendChild(styleElement);
				}
			}
			return () => {
				if (disposed) return;
				disposed = true;
				styleInstalls -= 1;
				if (styleInstalls <= 0) {
					styleInstalls = 0;
					try {
						if (styleElement && typeof styleElement.remove === "function") styleElement.remove();
					} catch (error) {
						/* 忽略 */
					}
					styleElement = null;
				}
			};
		}

		/**
		 * 注册面板样式表，返回清理函数。
		 * 优先 `styles.insert(css)`（动态 client half 的内置符号，随 Package 卸载自动清理）；
		 * 其次 `ctx.get("styles").insert(css)`；最后退化为自有 <style> 元素。
		 */
		function insertStyles(css, ctx) {
			const builtin = typeof styles !== "undefined" && styles !== null && typeof styles.insert === "function" ? styles : null;
			if (builtin !== null) {
				const dispose = builtin.insert(css);
				return typeof dispose === "function" ? dispose : () => {};
			}
			const service = safeGet(ctx, "styles");
			if (service !== null && service !== undefined && typeof service.insert === "function") {
				const dispose = service.insert(css);
				return typeof dispose === "function" ? dispose : () => {};
			}
			return insertStyleElement(css);
		}

		/**
		 * 面板样式。全部走 `--dsw-alias-*` 主题 token；同时用 `--rh-*` 本地变量
		 * 给出明/暗两套兜底色（token 缺失时也保证深色下可读）。
		 */
		const PANEL_CSS = `
[data-dsh-runninghub] {
  --rh-fg: var(--dsw-alias-label-primary, #1f2328);
  --rh-fg-2: var(--dsw-alias-label-secondary, #59636e);
  --rh-fg-3: var(--dsw-alias-label-tertiary, #818b98);
  --rh-bg: var(--dsw-alias-bg-layer-1, #ffffff);
  --rh-bg-2: var(--dsw-alias-bg-layer-2, #f6f8fa);
  --rh-border: var(--dsw-alias-border-l3, rgba(31, 35, 40, 0.18));
  --rh-border-2: var(--dsw-alias-border-l2, rgba(31, 35, 40, 0.1));
  --rh-brand: var(--dsw-alias-brand-primary, #2f6feb);
  --rh-ok: var(--dsw-alias-state-success-primary, #1a7f37);
  --rh-warn: var(--dsw-alias-state-warn-primary, #9a6700);
  --rh-error: var(--dsw-alias-state-error-primary, #cf222e);
  --rh-mono: var(--dsw-alias-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  color: var(--rh-fg);
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  font-size: 0.92em;
  line-height: 1.5;
}
@media (prefers-color-scheme: dark) {
  [data-dsh-runninghub] {
    --rh-fg: var(--dsw-alias-label-primary, #e6edf3);
    --rh-fg-2: var(--dsw-alias-label-secondary, #9aa4b2);
    --rh-fg-3: var(--dsw-alias-label-tertiary, #6e7781);
    --rh-bg: var(--dsw-alias-bg-layer-1, #161b22);
    --rh-bg-2: var(--dsw-alias-bg-layer-2, #21262d);
    --rh-border: var(--dsw-alias-border-l3, rgba(240, 246, 252, 0.2));
    --rh-border-2: var(--dsw-alias-border-l2, rgba(240, 246, 252, 0.12));
    --rh-brand: var(--dsw-alias-brand-primary, #6ea8fe);
    --rh-ok: var(--dsw-alias-state-success-primary, #3fb950);
    --rh-warn: var(--dsw-alias-state-warn-primary, #d29922);
    --rh-error: var(--dsw-alias-state-error-primary, #f85149);
  }
}
[data-dsh-runninghub] * { box-sizing: border-box; }
[data-dsh-runninghub] p { margin: 0; }
[data-dsh-runninghub] h3, [data-dsh-runninghub] h4 { margin: 0; font-size: 1em; }
[data-dsh-runninghub] code, [data-dsh-runninghub] pre { font-family: var(--rh-mono); }
[data-dsh-runninghub] .rh-head { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
[data-dsh-runninghub] .rh-title { font-size: 1.06em; font-weight: 600; }
[data-dsh-runninghub] .rh-muted { color: var(--rh-fg-2); }
[data-dsh-runninghub] .rh-dim { color: var(--rh-fg-3); }
[data-dsh-runninghub] .rh-error-text { color: var(--rh-error); overflow-wrap: anywhere; }
[data-dsh-runninghub] .rh-warn-text { color: var(--rh-warn); overflow-wrap: anywhere; }
[data-dsh-runninghub] .rh-btn {
  font: inherit;
  cursor: pointer;
  color: var(--rh-fg);
  background: var(--rh-bg);
  border: 1px solid var(--rh-border);
  border-radius: 4px;
  padding: 3px 10px;
}
[data-dsh-runninghub] .rh-btn:hover:not(:disabled) { border-color: var(--rh-brand); }
[data-dsh-runninghub] .rh-btn:focus-visible { outline: 2px solid var(--rh-brand); outline-offset: -2px; }
[data-dsh-runninghub] .rh-btn:disabled { opacity: 0.55; cursor: default; }
[data-dsh-runninghub] .rh-btn-danger { color: var(--rh-error); border-color: currentColor; }
[data-dsh-runninghub] .rh-btn-small { padding: 1px 7px; font-size: 0.9em; }
[data-dsh-runninghub] .rh-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
[data-dsh-runninghub] .rh-status {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  align-items: center;
  border: 1px solid var(--rh-border-2);
  border-radius: 6px;
  background: var(--rh-bg-2);
  padding: 8px 10px;
}
[data-dsh-runninghub] .rh-status-cell { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
[data-dsh-runninghub] .rh-status-label { color: var(--rh-fg-3); }
[data-dsh-runninghub] .rh-status-value { overflow-wrap: anywhere; white-space: pre-wrap; }
[data-dsh-runninghub] .rh-status-spacer { flex: 1 1 auto; }
[data-dsh-runninghub] .rh-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 0.82em;
  line-height: 1.7;
  white-space: nowrap;
  border: 1px solid currentColor;
  color: var(--rh-fg-2);
}
[data-dsh-runninghub] .rh-badge[data-tone="ok"] { color: var(--rh-ok); }
[data-dsh-runninghub] .rh-badge[data-tone="warn"] { color: var(--rh-warn); }
[data-dsh-runninghub] .rh-badge[data-tone="error"] { color: var(--rh-error); }
[data-dsh-runninghub] .rh-badge[data-tone="info"] { color: var(--rh-brand); }
[data-dsh-runninghub] .rh-badge[data-tone="brand"] { color: var(--rh-brand); }
[data-dsh-runninghub] .rh-badge[data-tone="muted"] { color: var(--rh-fg-3); }
[data-dsh-runninghub] .rh-section {
  border: 1px solid var(--rh-border-2);
  border-radius: 6px;
  background: var(--rh-bg);
  overflow: hidden;
}
[data-dsh-runninghub] .rh-section-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  font: inherit;
  text-align: left;
  color: var(--rh-fg);
  background: var(--rh-bg-2);
  border: 0;
  border-bottom: 1px solid transparent;
  padding: 8px 10px;
  cursor: pointer;
}
[data-dsh-runninghub] .rh-section-head[aria-expanded="true"] { border-bottom-color: var(--rh-border-2); }
[data-dsh-runninghub] .rh-section-head:focus-visible { outline: 2px solid var(--rh-brand); outline-offset: -2px; }
[data-dsh-runninghub] .rh-section-title { font-weight: 600; }
[data-dsh-runninghub] .rh-section-count { color: var(--rh-fg-3); }
[data-dsh-runninghub] .rh-caret { color: var(--rh-fg-3); width: 1em; display: inline-block; }
[data-dsh-runninghub] .rh-section-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px;
  min-width: 0;
}
[data-dsh-runninghub] .rh-section-body[hidden] { display: none; }
[data-dsh-runninghub] .rh-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
[data-dsh-runninghub] .rh-wf {
  border: 1px solid var(--rh-border-2);
  border-radius: 6px;
  background: var(--rh-bg);
  overflow: hidden;
}
[data-dsh-runninghub] .rh-wf-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  font: inherit;
  text-align: left;
  color: var(--rh-fg);
  background: none;
  border: 0;
  padding: 8px 10px;
  cursor: pointer;
  min-width: 0;
}
[data-dsh-runninghub] .rh-wf-row:hover { background: var(--rh-bg-2); }
[data-dsh-runninghub] .rh-wf-row:focus-visible { outline: 2px solid var(--rh-brand); outline-offset: -2px; }
[data-dsh-runninghub] .rh-wf-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
[data-dsh-runninghub] .rh-wf-slug { color: var(--rh-fg-3); font-family: var(--rh-mono); font-size: 0.86em; }
[data-dsh-runninghub] .rh-wf-trailing { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
[data-dsh-runninghub] .rh-wf-meta { color: var(--rh-fg-2); white-space: nowrap; }
[data-dsh-runninghub] .rh-wf-detail {
  border-top: 1px solid var(--rh-border-2);
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
[data-dsh-runninghub] .rh-group { border: 1px solid var(--rh-border-2); border-radius: 5px; overflow: hidden; }
[data-dsh-runninghub] .rh-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  font: inherit;
  text-align: left;
  color: var(--rh-fg);
  background: var(--rh-bg-2);
  border: 0;
  padding: 5px 9px;
  cursor: pointer;
}
[data-dsh-runninghub] .rh-group-head:focus-visible { outline: 2px solid var(--rh-brand); outline-offset: -2px; }
[data-dsh-runninghub] .rh-group-body { padding: 8px 9px; display: flex; flex-direction: column; gap: 8px; }
[data-dsh-runninghub] .rh-table-wrap { overflow-x: auto; min-width: 0; }
[data-dsh-runninghub] table.rh-table { border-collapse: collapse; width: 100%; font-size: 0.92em; }
[data-dsh-runninghub] table.rh-table th,
[data-dsh-runninghub] table.rh-table td {
  border-bottom: 1px solid var(--rh-border-2);
  padding: 4px 8px;
  text-align: left;
  vertical-align: top;
}
[data-dsh-runninghub] table.rh-table th { color: var(--rh-fg-3); font-weight: 500; white-space: nowrap; }
[data-dsh-runninghub] table.rh-table td.rh-cell-mono { font-family: var(--rh-mono); font-size: 0.9em; overflow-wrap: anywhere; }
[data-dsh-runninghub] .rh-node-editor {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 8px;
  border: 1px dashed var(--rh-border);
  border-radius: 5px;
  padding: 8px;
  background: var(--rh-bg-2);
}
[data-dsh-runninghub] .rh-field { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
[data-dsh-runninghub] .rh-field > span { color: var(--rh-fg-3); font-size: 0.88em; }
[data-dsh-runninghub] .rh-field input,
[data-dsh-runninghub] .rh-field select,
[data-dsh-runninghub] .rh-field textarea {
  font: inherit;
  color: var(--rh-fg);
  background: var(--rh-bg);
  border: 1px solid var(--rh-border);
  border-radius: 4px;
  padding: 3px 7px;
  min-width: 0;
  width: 100%;
}
[data-dsh-runninghub] .rh-field textarea { resize: vertical; min-height: 60px; }
[data-dsh-runninghub] .rh-check { display: flex; align-items: center; gap: 6px; color: var(--rh-fg-2); }
[data-dsh-runninghub] .rh-check input { width: auto; }
[data-dsh-runninghub] .rh-grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
[data-dsh-runninghub] .rh-card { border: 1px solid var(--rh-border-2); border-radius: 5px; padding: 8px; display: flex; flex-direction: column; gap: 8px; }
[data-dsh-runninghub] .rh-json {
  margin: 0;
  padding: 8px;
  border: 1px solid var(--rh-border-2);
  border-radius: 4px;
  background: var(--rh-bg-2);
  max-height: 260px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 0.86em;
}
[data-dsh-runninghub] .rh-notice {
  border: 1px solid currentColor;
  border-radius: 5px;
  padding: 6px 9px;
  color: var(--rh-ok);
  overflow-wrap: anywhere;
}
[data-dsh-runninghub] .rh-alert {
  border: 1px solid currentColor;
  border-radius: 5px;
  padding: 6px 9px;
  color: var(--rh-error);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
[data-dsh-runninghub] .rh-client-errors {
  border: 1px solid var(--rh-border-2);
  border-radius: 5px;
  padding: 6px 9px;
  color: var(--rh-fg-2);
  background: var(--rh-bg-2);
  overflow-wrap: anywhere;
}
[data-dsh-runninghub] .rh-client-errors > summary { cursor: pointer; }
[data-dsh-runninghub] .rh-client-errors .rh-health-list { color: var(--rh-error); font-family: var(--rh-mono); font-size: 0.85em; }
[data-dsh-runninghub] .rh-empty { color: var(--rh-fg-3); }
/* ── 聊天里的工具卡片（tool.call.toolview）── */
[data-dsh-runninghub] .rh-tool {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  font-size: 0.92em;
  line-height: 1.5;
  color: var(--rh-fg);
}
[data-dsh-runninghub] .rh-tool-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
[data-dsh-runninghub] .rh-tool-name { font-weight: 600; }
[data-dsh-runninghub] .rh-tool-action { color: var(--rh-fg-2); font-family: var(--rh-mono); font-size: 0.88em; }
[data-dsh-runninghub] .rh-tool-images { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; }
[data-dsh-runninghub] .rh-tool-image {
  max-height: 360px;
  max-width: 100%;
  border-radius: 6px;
  border: 1px solid var(--rh-border-2);
  display: block;
}
[data-dsh-runninghub] .rh-tool-links { display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline; overflow-wrap: anywhere; }
[data-dsh-runninghub] .rh-tool-links a { color: var(--rh-brand); }
[data-dsh-runninghub] .rh-tool-files { display: flex; gap: 6px; flex-wrap: wrap; align-items: baseline; min-width: 0; }
[data-dsh-runninghub] .rh-tool-file {
  font: inherit;
  cursor: pointer;
  color: var(--rh-brand);
  background: var(--rh-bg-2);
  border: 1px solid var(--rh-border);
  border-radius: 4px;
  padding: 1px 8px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-runninghub] .rh-tool-file:hover { border-color: var(--rh-brand); }
[data-dsh-runninghub] .rh-tool-file:focus-visible { outline: 2px solid var(--rh-brand); outline-offset: -2px; }
[data-dsh-runninghub] .rh-tool-file-static { font-family: var(--rh-mono); font-size: 0.9em; overflow-wrap: anywhere; }
[data-dsh-runninghub] .rh-field-hint { color: var(--rh-fg-3); font-size: 0.85em; }
/* 任务流水的「保留最近 N 条」控制条 */
[data-dsh-runninghub] .rh-limit { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
[data-dsh-runninghub] .rh-limit-input {
  font: inherit;
  width: 5.5em;
  color: var(--rh-fg);
  background: var(--rh-bg);
  border: 1px solid var(--rh-border);
  border-radius: 4px;
  padding: 3px 7px;
}
[data-dsh-runninghub] .rh-limit-input:focus-visible { outline: 2px solid var(--rh-brand); outline-offset: -2px; }
[data-dsh-runninghub] .rh-tool-details { min-width: 0; }
[data-dsh-runninghub] .rh-tool-details > summary { cursor: pointer; color: var(--rh-fg-2); }
[data-dsh-runninghub] .rh-tool-text {
  margin: 4px 0 0;
  padding: 8px;
  border: 1px solid var(--rh-border-2);
  border-radius: 4px;
  background: var(--rh-bg-2);
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--rh-mono);
  font-size: 0.88em;
}
[data-dsh-runninghub] .rh-tool-fallback { border: 1px solid var(--rh-border-2); border-radius: 6px; padding: 8px; }
/* summary 态：面板根标记加在一个行内 span 上，所以要抵消根布局（它默认是 flex 列）。 */
[data-dsh-runninghub].rh-summary {
  display: inline;
  flex-direction: row;
  gap: 0;
  font-size: inherit;
  line-height: inherit;
  color: var(--rh-fg-2);
  overflow-wrap: anywhere;
}
[data-dsh-runninghub].rh-summary[data-tone="muted"] { color: var(--rh-fg-3); }
[data-dsh-runninghub].rh-summary[data-tone="error"] { color: var(--rh-error); }
[data-dsh-runninghub] .rh-health-list {
  list-style: disc;
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-wrap: anywhere;
}
[data-dsh-runninghub] .rh-thumb { max-width: 72px; max-height: 72px; border-radius: 4px; border: 1px solid var(--rh-border-2); display: block; }
[data-dsh-runninghub] .rh-crash { border: 1px solid var(--rh-error); border-radius: 6px; padding: 10px; display: flex; flex-direction: column; gap: 6px; }
[data-dsh-runninghub] .rh-progress { height: 6px; border-radius: 3px; background: var(--rh-bg-2); border: 1px solid var(--rh-border-2); overflow: hidden; min-width: 90px; }
[data-dsh-runninghub] .rh-progress > i { display: block; height: 100%; background: var(--rh-brand); }
[data-dsh-runninghub] .rh-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
[data-dsh-runninghub] .rh-wrap-anywhere { overflow-wrap: anywhere; }
`;


		// ------------------------------------------------------------------
		// 4. 组件（手写 createElement，无 JSX）
		// ------------------------------------------------------------------

		/** 小徽章。 */
		function Badge(props) {
			return h("span", { className: "rh-badge", "data-tone": props.tone || "muted" }, props.children);
		}

		/** 一行可选中的折叠小节标题。 */
		function SectionHead(props) {
			return h(
				"button",
				{
					type: "button",
					className: "rh-section-head",
					"aria-expanded": props.open ? "true" : "false",
					"data-rh-section": props.id,
					onClick: props.onToggle,
				},
				h("span", { className: "rh-caret" }, props.open ? "▾" : "▸"),
				h("span", { className: "rh-section-title" }, props.title),
				props.count !== undefined && props.count !== null ? h("span", { className: "rh-section-count" }, props.count) : null,
				props.trailing || null,
			);
		}

		/** 可折叠小节。 */
		function Section(props) {
			return h(
				"section",
				{ className: "rh-section", "data-rh-section-box": props.id },
				h(SectionHead, props),
				props.open || props.keepMounted ? h("div", { className: "rh-section-body", hidden: !props.open }, props.children) : null,
			);
		}

		/** 错误 / 提示条 + 客户端运行期错误（有界，折叠展示）。 */
		function Alerts(props) {
			const clientErrors = Array.isArray(props.clientErrors) ? props.clientErrors : [];
			if (!props.error && !props.notice && clientErrors.length === 0) return null;
			return h(
				Fragment,
				null,
				props.error ? h("p", { className: "rh-alert", role: "alert" }, props.error) : null,
				props.notice ? h("p", { className: "rh-notice" }, props.notice) : null,
				clientErrors.length > 0
					? h(
							"details",
							{ className: "rh-client-errors", "data-rh-client-errors": "" },
							h("summary", null, `客户端运行期错误（最近 ${clientErrors.length} 条，$mount 内部的异常只有这里看得到）`),
							h(
								"ul",
								{ className: "rh-health-list" },
								clientErrors
									.slice()
									.reverse()
									.map((entry, index) => h("li", { key: `${entry.at}-${index}`, className: "rh-wrap-anywhere" }, `[${entry.kind}] ${entry.msg}`)),
							),
						)
					: null,
			);
		}

		/** 表格单元格（mono 可选）。 */
		function cell(props, children) {
			return h("td", { className: props.mono ? "rh-cell-mono" : undefined, key: props.key }, children);
		}

		// ---- 顶部状态栏 ----

		/** 顶部状态栏：数据目录 / 地域 / key 池 / 版本 / 通道 + 自检。 */
		function StatusBar(props) {
			const status = props.status !== null && typeof props.status === "object" ? props.status : {};
			const warnings = Array.isArray(status.warnings) ? status.warnings : [];
			// 宿主半边的健康事实（coreReady / loadError / bridge）——真实装机时最先要看的东西。
			const problems = [];
			if (status.coreReady === false) problems.push("宿主核心未就绪（coreReady=false）");
			if (status.loadError) problems.push(`宿主加载错误：${String(status.loadError)}`);
			const cells = [
				["数据目录", status.dataDir ? String(status.dataDir) : "—"],
				["当前地域", regionLabel(status.region)],
				["Key 池", poolText(status.pool)],
				["版本", status.version ? String(status.version) : "—"],
				["通道", [props.channelReport || props.transportKind || "—", status.bridge ? String(status.bridge) : ""].filter((part) => part !== "").join(" / ")],
			];
			return h(
				"div",
				{ className: "rh-status", "data-rh-status": "" },
				cells.map((pair) =>
					h(
						"span",
						{ className: "rh-status-cell", key: pair[0] },
						h("span", { className: "rh-status-label" }, pair[0]),
						h("span", { className: "rh-status-value", title: pair[1] }, pair[1]),
					),
				),
				warnings.length > 0
					? h("span", { className: "rh-status-cell" }, h(Badge, { tone: "warn" }, `警告 ${warnings.length}`))
					: null,
				h("span", { className: "rh-status-spacer" }),
				h(
					"button",
					{ type: "button", className: "rh-btn rh-btn-small", onClick: props.onDiagnostics, disabled: props.busy === true },
					props.busy === true ? "自检中…" : "自检",
				),
				h(
					"button",
					{ type: "button", className: "rh-btn rh-btn-small", onClick: props.onRefresh, disabled: props.busy === true },
					"刷新",
				),
				problems.length > 0 ? h("p", { className: "rh-alert", role: "alert", "data-rh-host-problem": "" }, problems.join("；")) : null,
				warnings.length > 0
					? h(
							"ul",
							{ className: "rh-health-list rh-warn-text", "data-rh-warnings": "" },
							warnings.map((warning, index) => h("li", { key: `w-${index}` }, typeof warning === "string" ? warning : safeJson(warning))),
						)
					: null,
			);
		}

		// ---- 工作流（手风琴主体） ----

		/** 节点表格中的一行（含内联编辑器）。 */
		function NodeRow(props) {
			const node = props.node;
			const nodeId = String(node.nodeId);
			const editing = props.editing === true;
			const patch = (delta) => props.onPatch(nodeId, delta, props.nodeIndex);
			return h(
				Fragment,
				null,
				h(
					"tr",
					{ key: `n-${nodeId}`, "data-rh-node": nodeId },
					cell({ mono: true, key: "id" }, nodeId),
					cell({ mono: true, key: "cls" }, String(node.classType || "—")),
					cell({ key: "role" }, roleLabel(node.role)),
					cell({ mono: true, key: "field" }, String(node.fieldName || "—")),
					cell({ key: "def" }, defaultValueText(nodeDefaultValue(node))),
					cell({ key: "range" }, rangeText(node)),
					cell({ key: "req" }, node.required === true ? "必填" : "可选"),
					h(
						"td",
						{ key: "ops" },
						h(
							"button",
							{
								type: "button",
								className: "rh-btn rh-btn-small",
								"data-rh-node-edit": nodeId,
								onClick: () => props.onToggleEdit(editing ? null : props.nodeIndex),
							},
							editing ? "收起" : "编辑",
						),
					),
				),
				editing
					? h(
							"tr",
							{ key: `e-${nodeId}` },
							h(
								"td",
								{ colSpan: 8 },
								h(
									"div",
									{ className: "rh-node-editor", "data-rh-node-editor": nodeId },
									h("label", { className: "rh-field" }, h("span", null, "角色"), h(
										"select",
										{ value: String(node.role || "other"), onChange: (event) => patch({ role: event.target.value }) },
										NODE_ROLES.map((role) => h("option", { key: role, value: role }, `${roleLabel(role)}（${role}）`)),
									)),
									h("label", { className: "rh-field" }, h("span", null, "显示名 label"), h("input", {
										type: "text",
										value: node.label === undefined || node.label === null ? "" : String(node.label),
										onChange: (event) => patch({ label: event.target.value }),
									})),
									h("label", { className: "rh-field" }, h("span", null, "字段名 fieldName"), h("input", {
										type: "text",
										value: node.fieldName === undefined || node.fieldName === null ? "" : String(node.fieldName),
										onChange: (event) => patch({ fieldName: event.target.value }),
									})),
									h("label", { className: "rh-field" }, h("span", null, "分组 group"), h("input", {
										type: "text",
										value: node.group === undefined || node.group === null ? "" : String(node.group),
										onChange: (event) => patch({ group: event.target.value === "" ? undefined : event.target.value }),
									})),
									h("label", { className: "rh-field" }, h("span", null, "值类型 valueType"), h(
										"select",
										{ value: String(node.valueType || "string"), onChange: (event) => patch({ valueType: event.target.value }) },
										["string", "number", "boolean", "enum"].map((type) => h("option", { key: type, value: type }, type)),
									)),
									// 默认值可改：enum 给真下拉；非 enum 且有建议值 → 可选可自由输入
									h(
										"label",
										{ className: "rh-field" },
										h("span", null, "默认值"),
										h(NodeFieldInput, {
											node: node,
											label: "默认值",
											value: nodeDefaultValue(node) === undefined || nodeDefaultValue(node) === null ? "" : String(nodeDefaultValue(node)),
											onChange: (next) => patch({ defaultValue: next }),
										}),
									),
									h("label", { className: "rh-field" }, h("span", null, "min"), h("input", {
										type: "number",
										value: node.min === undefined || node.min === null ? "" : String(node.min),
										onChange: (event) => patch({ min: numberOrUndefined(event.target.value), boundsSource: "user" }),
									})),
									h("label", { className: "rh-field" }, h("span", null, "max"), h("input", {
										type: "number",
										value: node.max === undefined || node.max === null ? "" : String(node.max),
										onChange: (event) => patch({ max: numberOrUndefined(event.target.value), boundsSource: "user" }),
									})),
									h("label", { className: "rh-field" }, h("span", null, "step"), h("input", {
										type: "number",
										value: node.step === undefined || node.step === null ? "" : String(node.step),
										onChange: (event) => patch({ step: numberOrUndefined(event.target.value) }),
									})),
									h(
										"label",
										{ className: "rh-field" },
										h("span", null, "枚举 options（一行一个）"),
										// ⚠️ 这里**不能**直接受控 + onChange 里规范化：会把末尾空行吃掉，
										//    用户按回车"没反应"。交给 OptionsEditor 保留原文、失焦才规范化。
										h(OptionsEditor, { node: node, onCommit: (options) => patch({ options: options, optionsSource: "user" }) }),
									),
									h(
										"label",
										{ className: "rh-field" },
										h("span", null, "备注 note"),
										h("input", {
											type: "text",
											value: node.note === undefined || node.note === null ? "" : String(node.note),
											onChange: (event) => patch({ note: event.target.value }),
										}),
									),
									h(
										"label",
										{ className: "rh-check" },
										h("input", { type: "checkbox", checked: node.required === true, onChange: (event) => patch({ required: event.target.checked }) }),
										"必填",
									),
								),
							),
						)
					: null,
			);
		}

		/** 节点表格的表头（8 列）。 */
		const NODE_COLUMNS = ["节点", "类型", "角色", "字段", "默认值", "范围 / 枚举", "必填", "操作"];

		/** 按分组折叠的节点表格。 */
		function NodeGroups(props) {
			const groups = groupNodes(props.nodes);
			const indexes = new Map(props.nodes.map((node, index) => [node, index]));
			if (groups.length === 0) return h("p", { className: "rh-empty" }, "该工作流还没有配置任何节点。");
			/** 一个分组：可折叠的标题 + 节点表格。 */
			const renderGroup = (entry) => {
				const collapsed = props.openGroups[entry.group] === false;
				const head = h(
					"button",
					{
						type: "button",
						className: "rh-group-head",
						"aria-expanded": collapsed ? "false" : "true",
						onClick: () => props.onToggleGroup(entry.group),
					},
					h("span", { className: "rh-caret" }, collapsed ? "▸" : "▾"),
					h("span", null, entry.group),
					h("span", { className: "rh-section-count" }, `${entry.nodes.length} 个节点`),
				);
				const table = h(
					"table",
					{ className: "rh-table" },
					h("thead", null, h("tr", null, NODE_COLUMNS.map((title) => h("th", { key: title }, title)))),
					h(
						"tbody",
						null,
						entry.nodes.map((node) =>
							h(NodeRow, {
									key: indexes.get(node),
								node: node,
									nodeIndex: indexes.get(node),
									editing: props.editingNode === indexes.get(node),
								onToggleEdit: props.onToggleEdit,
								onPatch: props.onNodePatch,
							}),
						),
					),
				);
				const body = collapsed ? null : h("div", { className: "rh-group-body" }, h("div", { className: "rh-table-wrap" }, table));
				return h("div", { className: "rh-group", key: entry.group, "data-rh-node-group": entry.group }, head, body);
			};
			return h(Fragment, null, groups.map(renderGroup));
		}

		/** 展开后的工作流详情：节点表格 + 提示词优化 + 保存/删除。 */
		function WorkflowDetail(props) {
			const workflow = props.workflow !== null && typeof props.workflow === "object" ? props.workflow : {};
			const draft = props.draft;
			const setDraft = (next) => props.onDraftChange(typeof next === "function" ? next(draft) : next);
			const [confirmed, setConfirmed] = useState(false);
			const [editingNode, setEditingNode] = useState(null);
			const [openGroups, setOpenGroups] = useState({});
			const [showJson, setShowJson] = useState(false);
			const optimizer = draft.promptOptimizer !== null && typeof draft.promptOptimizer === "object" ? draft.promptOptimizer : {};
			const nodes = Array.isArray(draft.nodes) ? draft.nodes : [];
			const docs = Array.isArray(props.docs) ? props.docs : [];
			const patchOptimizer = (delta) => setDraft((current) => {
				const base = current.promptOptimizer !== null && typeof current.promptOptimizer === "object" ? current.promptOptimizer : {};
				const next = {};
				for (const key of Object.keys(base)) next[key] = base[key];
				for (const key of Object.keys(delta)) {
					if (delta[key] === undefined) delete next[key];
					else next[key] = delta[key];
				}
				const copy = {};
				for (const key of Object.keys(current)) copy[key] = current[key];
				copy.promptOptimizer = next;
				return copy;
			});
			const promptNodes = nodes.filter((node) => node && (node.role === "prompt" || node.role === "negative_prompt"));
			return h(
				"div",
				{ className: "rh-wf-detail", "data-rh-wf-detail": String(workflow.name || "") },
				h("div", { className: "rh-grid2" },
					h("label", { className: "rh-field" }, h("span", null, "名称"), h("input", {
						value: draft.name || "", "data-rh-wf-name": "", onChange: (event) => setDraft((current) => Object.assign({}, current, { name: event.target.value })),
					})),
					h("label", { className: "rh-field" }, h("span", null, "英文名称（可选）"), h("input", {
						value: draft.displayNameEn || "", onChange: (event) => setDraft((current) => Object.assign({}, current, { displayNameEn: event.target.value })),
					})),
				),
				h(
					"div",
					{ className: "rh-row" },
					h("span", { className: "rh-muted" }, "RunningHub 工作流 ID："),
					h("code", null, draft.rhWorkflowId ? String(draft.rhWorkflowId) : "—"),
					h("span", { className: "rh-muted" }, "地域："),
					h(
						"select",
						{
							value: String(draft.region || "cn"),
							onChange: (event) => setDraft((current) => Object.assign({}, current, { region: event.target.value })),
						},
						h("option", { value: "cn" }, "国内"),
						h("option", { value: "overseas" }, "海外"),
					),
					h("span", { className: "rh-muted" }, "输出类型："),
					h("select", {
						value: draft.outputKind || "image", "data-rh-wf-output": "",
						onChange: (event) => setDraft((current) => Object.assign({}, current, { outputKind: event.target.value })),
					}, ["image", "video", "audio", "3d", "text", "mixed"].map((kind) => h("option", { key: kind, value: kind }, outputKindLabel(kind)))),
					h(
						"button",
						{ type: "button", className: "rh-btn rh-btn-small", onClick: () => setShowJson((value) => !value) },
						showJson ? "隐藏 JSON" : "查看 JSON",
					),
				),
				h(
					"label",
					{ className: "rh-field" },
					h("span", null, "描述（给模型看）"),
					h("input", {
						type: "text",
						value: draft.description === undefined || draft.description === null ? "" : String(draft.description),
						onChange: (event) => setDraft((current) => Object.assign({}, current, { description: event.target.value })),
					}),
				),
				showJson ? h("pre", { className: "rh-json" }, safeJson(draft)) : null,
				h("h4", { className: "rh-muted" }, `节点（${nodes.length}）`),
				h(NodeGroups, {
					nodes: nodes,
					editingNode: editingNode,
					openGroups: openGroups,
					onToggleEdit: setEditingNode,
					onToggleGroup: (group) => setOpenGroups((current) => Object.assign({}, current, { [group]: current[group] === false ? true : false })),
					onNodePatch: (nodeId, delta, nodeIndex) => setDraft((current) => Object.assign({}, current, { nodes: patchNode(current.nodes, nodeId, delta, nodeIndex) })),
				}),
				h(
					"fieldset",
					{ className: "rh-card", "data-rh-optimizer": "" },
					h("legend", { className: "rh-muted" }, "提示词优化"),
					h(
						"label",
						{ className: "rh-check" },
						h("input", {
							type: "checkbox",
							checked: optimizer.enabled === true,
							"data-rh-opt-enabled": "",
							onChange: (event) => patchOptimizer({ enabled: event.target.checked }),
						}),
						"启用提示词优化",
					),
					h(
						"div",
						{ className: "rh-grid2" },
						h(
							"label",
							{ className: "rh-field" },
							h("span", null, "优化文档"),
							h(
								"select",
								{
									value: optimizer.docId === undefined || optimizer.docId === null ? "" : String(optimizer.docId),
									onChange: (event) => patchOptimizer({ docId: event.target.value === "" ? null : event.target.value }),
								},
								h("option", { value: "" }, "（不使用文档）"),
								docs.map((doc) =>
									h(
										"option",
										{ key: String(doc.docId ?? doc.id ?? doc.name), value: String(doc.docId ?? doc.id ?? doc.name) },
										String(doc.name ?? doc.docId ?? doc.id),
									),
								),
							),
						),
						h(
							"label",
							{ className: "rh-field" },
							h("span", null, "写入的目标节点"),
							h(
								"select",
								{
									value: optimizer.targetNodeId === undefined || optimizer.targetNodeId === null ? "" : String(optimizer.targetNodeId),
									onChange: (event) => patchOptimizer({ targetNodeId: event.target.value === "" ? null : event.target.value }),
								},
								h("option", { value: "" }, "（自动选正向提示词节点）"),
								promptNodes.map((node) => h("option", { key: String(node.nodeId), value: String(node.nodeId) }, `${node.nodeId} · ${roleLabel(node.role)}`)),
							),
						),
					),
					h(
						"label",
						{ className: "rh-check" },
						h("input", {
							type: "checkbox",
							checked: optimizer.asSubagentSystemPrompt === true,
							onChange: (event) => patchOptimizer({ asSubagentSystemPrompt: event.target.checked }),
						}),
						"把该文档作为「无工具极简子代理」的系统提示词",
					),
					h(
						"label",
						{ className: "rh-field" },
						h("span", null, "附加指令"),
						h("textarea", {
							rows: 3,
							value: optimizer.extraInstruction === undefined || optimizer.extraInstruction === null ? "" : String(optimizer.extraInstruction),
							onChange: (event) => patchOptimizer({ extraInstruction: event.target.value }),
						}),
					),
				),
				h(
					"div",
					{ className: "rh-toolbar" },
					h(
						"button",
						{
							type: "button",
							className: "rh-btn",
							"data-rh-wf-save": String(workflow.name || ""),
							disabled: props.busy === true || !String(draft.name || "").trim() || props.needsConfirmation && !confirmed,
							onClick: () => props.onSave(draft),
						},
						props.busy === true ? "保存中…" : "保存该工作流",
					),
					props.needsConfirmation ? h("label", { className: "rh-check" }, h("input", {
						type: "checkbox", checked: confirmed, "data-rh-wf-confirm": "", onChange: (event) => setConfirmed(event.target.checked),
					}), "我已确认节点角色、默认值和输出类型") : null,
					props.onDiscard ? h("button", {
						type: "button", className: "rh-btn", "data-rh-wf-discard": String(workflow.name || ""),
						disabled: props.busy === true, onClick: props.onDiscard,
					}, props.needsConfirmation ? "放弃配置" : "放弃修改") : null,
					props.onDelete ? h(
						"button",
						{
							type: "button",
							className: "rh-btn rh-btn-danger",
							"data-rh-wf-delete": String(workflow.name || ""),
							disabled: props.busy === true,
							onClick: () => props.onDelete(String(workflow.name || "")),
						},
						"删除",
					) : null,
					h("span", { className: "rh-dim" }, "保存后生效，未保存的修改会保留到面板关闭。"),
				),
			);
		}

		/**
		 * 工作流小节：**主体手风琴**。
		 * 默认全部折叠；点一行才展开它的节点；同一时刻只展开一个（再点已展开的收起）。
		 */
		function WorkflowSection(props) {
			const workflows = Array.isArray(props.workflows) ? props.workflows : [];
			const [expandedId, setExpandedId] = useState(null);
			const [drafts, setDrafts] = useState({});
			const [probeId, setProbeId] = useState("");
			const [probeRegion, setProbeRegion] = useState("cn");
			const [probeResult, setProbeResult] = useState(null);
			const [probeDraft, setProbeDraft] = useState(null);
			const onToggle = (id) => setExpandedId((current) => toggleExpanded(current, id));
			const discardDraft = (id) => setDrafts((current) => {
				const next = Object.assign({}, current);
				delete next[id];
				return next;
			});
			const saveDraft = async (id, config) => {
				const result = await props.onSave(config);
				if (result && result.ok === true) setDrafts((current) => {
					if (current[id] !== config) return current;
					const next = Object.assign({}, current);
					delete next[id];
					return next;
				});
			};
			const runProbe = async () => {
				const result = await props.onProbe({ workflowId: probeId.trim(), region: probeRegion });
				if (result && result.ok === true) {
					setProbeResult(result);
					setProbeDraft(deepCopy(result.config));
				}
			};
			const saveProbe = async (config) => {
				const result = await props.onSave(config);
				if (result && result.ok === true) setProbeDraft((current) => current === config ? null : current);
			};
			return h(
				"div",
				{ "data-rh-workflows": "", "data-rh-expanded-id": expandedId === null ? "" : String(expandedId) },
				h(
					"p",
					{ className: "rh-muted" },
					`共 ${workflows.length} 个工作流。点击展开编辑，折叠或切换时保留未保存的修改。`,
				),
				workflows.length === 0
					? h("p", { className: "rh-empty" }, "还没有配置工作流，在下面粘贴 ID 或链接即可添加。")
					: h(
							"ul",
							{ className: "rh-list" },
							workflows.map((workflow) => {
								const summary = summarizeWorkflow(workflow);
								const expanded = expandedId !== null && String(expandedId) === summary.id;
								const draft = drafts[summary.id] || workflow;
								const dirty = drafts[summary.id] !== undefined && safeJson(draft) !== safeJson(workflow);
								return h(
									"li",
									{ className: "rh-wf", key: summary.id, "data-rh-wf": summary.id },
									h(
										"button",
										{
											type: "button",
											className: "rh-wf-row",
											"data-rh-wf-row": summary.id,
											"data-rh-expanded": expanded ? "true" : "false",
											"aria-expanded": expanded ? "true" : "false",
											onClick: () => onToggle(summary.id),
										},
										h("span", { className: "rh-caret" }, expanded ? "▾" : "▸"),
										h("span", { className: "rh-wf-name" }, summary.name),
										dirty ? h(Badge, { tone: "warn" }, "未保存") : null,
										summary.slug !== "" ? h("span", { className: "rh-wf-slug" }, summary.slug) : null,
										h("span", { className: "rh-wf-trailing" }, h(Badge, { tone: summary.outputTone }, summary.outputLabel), h("span", { className: "rh-wf-meta" }, `${summary.nodeCount} 节点`), h(
											"span",
											{ className: summary.optimizerEnabled ? "rh-wf-meta" : "rh-dim" },
											optimizerText(summary),
										)),
									),
									expanded
										? h(WorkflowDetail, {
												key: `detail-${summary.id}`,
												workflow: workflow,
												draft: draft,
												onDraftChange: (config) => setDrafts((current) => Object.assign({}, current, { [summary.id]: config })),
												docs: props.docs,
												busy: Boolean(props.busy),
												onSave: (config) => saveDraft(summary.id, config),
												onDiscard: dirty ? () => discardDraft(summary.id) : undefined,
												onDelete: (name) => props.onDelete(name),
											})
										: null,
								);
							}),
						),
				h(
					"fieldset",
					{ className: "rh-card", "data-rh-probe": "" },
					h("legend", { className: "rh-muted" }, "添加工作流"),
					h("p", { className: "rh-muted" }, "读取工作流后，检查节点角色与默认值，再编辑名称并保存。"),
					h(
						"div",
						{ className: "rh-row" },
						h("input", {
							type: "text",
							placeholder: "RunningHub 工作流 ID 或链接",
							value: probeId,
							"data-rh-probe-input": "",
							onChange: (event) => setProbeId(event.target.value),
						}),
						h(
							"select",
							{ value: probeRegion, onChange: (event) => setProbeRegion(event.target.value) },
							h("option", { value: "cn" }, "国内"),
							h("option", { value: "overseas" }, "海外"),
						),
						h(
							"button",
							{
								type: "button",
								className: "rh-btn",
								"data-rh-probe-run": "",
								disabled: Boolean(props.busy) || probeId.trim() === "" || probeDraft !== null,
								onClick: runProbe,
							},
							"读取工作流",
						),
					),
					probeResult === null
						? null
						: h(
								Fragment,
								null,
								h("p", { className: "rh-muted", "data-rh-probe-summary": "" }, probeSummaryText(probeResult)),
								probeResult.proposal.hints.warnings.length ? h("ul", { className: "rh-muted" }, probeResult.proposal.hints.warnings.map((warning, index) => h("li", { key: index }, warning))) : null,
								probeDraft ? h(WorkflowDetail, {
									key: `probe-${probeResult.rhWorkflowId}`,
									workflow: probeResult.config, draft: probeDraft, docs: props.docs, busy: Boolean(props.busy), needsConfirmation: true,
									onDraftChange: setProbeDraft, onSave: saveProbe, onDiscard: () => { setProbeDraft(null); setProbeResult(null); },
								}) : h("p", { className: "rh-notice" }, "工作流已保存。"),
							),
				),
			);
		}

		// ---- Key 管理 ----

		/** Key 管理小节：列表 + 新增 + 探测/余额/删除。 */
		function KeySection(props) {
			const keys = Array.isArray(props.keys) ? props.keys : [];
			const [draft, setDraft] = useState({ key: "", label: "", region: "auto", priority: 100 });
			const [reveal, setReveal] = useState({});
			const now = Date.now();
			return h(
				"div",
				{ "data-rh-keys": "" },
				keys.length === 0
					? h("p", { className: "rh-empty" }, "还没有配置任何 API Key。")
					: h(
							"div",
							{ className: "rh-table-wrap" },
							h(
								"table",
								{ className: "rh-table" },
								h(
									"thead",
									null,
									h(
										"tr",
										null,
										["掩码 Key", "标签", "地域", "优先级", "启用", "状态", "操作"].map((title) => h("th", { key: title }, title)),
									),
								),
								h(
									"tbody",
									null,
									keys.map((key) => {
										const id = String(key.id ?? key.maskedKey ?? "");
										const state = keyStateLabel(key, now);
										const balance = props.balances[id];
										return h(
											"tr",
											{ key: id, "data-rh-key": id },
											h("td", { className: "rh-cell-mono" }, String(key.maskedKey ?? "（无掩码）")),
											h(
												"td",
												null,
												h("input", {
													type: "text",
													value: key.label === undefined || key.label === null ? "" : String(key.label),
													onChange: (event) => props.onPatch(id, { label: event.target.value }),
												}),
											),
											h(
												"td",
												null,
												h(
													"select",
													{ value: String(key.region || "auto"), onChange: (event) => props.onPatch(id, { region: event.target.value }) },
													h("option", { value: "auto" }, "未探测 / 自动"),
													h("option", { value: "cn" }, "国内"),
													h("option", { value: "overseas" }, "海外"),
												),
											),
											h(
												"td",
												null,
												h("input", {
													type: "number",
													value: key.priority === undefined || key.priority === null ? "" : String(key.priority),
													onChange: (event) => props.onPatch(id, { priority: numberOrUndefined(event.target.value) }),
												}),
											),
											h(
												"td",
												null,
												h("input", {
													type: "checkbox",
													checked: key.enabled !== false,
													onChange: (event) => props.onPatch(id, { enabled: event.target.checked }),
												}),
											),
											h("td", null, h(Badge, { tone: state.tone }, state.text)),
											h(
												"td",
												null,
												h(
													"div",
													{ className: "rh-row" },
													h("button", { type: "button", className: "rh-btn rh-btn-small", "data-rh-key-detect": id, onClick: () => props.onDetect(id) }, key.invalid ? "重新验证" : "探测地域"),
													h("button", { type: "button", className: "rh-btn rh-btn-small", "data-rh-key-balance": id, onClick: () => props.onBalance(id) }, "查余额"),
													h("button", { type: "button", className: "rh-btn rh-btn-small", onClick: () => setReveal((current) => Object.assign({}, current, { [id]: !current[id] })) }, "编辑"),
													reveal[id] === true
														? h("button", { type: "button", className: "rh-btn rh-btn-small rh-btn-danger", "data-rh-key-remove": id, onClick: () => props.onRemove(id) }, "确认删除")
														: null,
													balance !== undefined && balance !== null
														? h("span", { className: "rh-dim rh-wrap-anywhere" }, balanceText(balance))
														: null,
												),
											),
										);
									}),
								),
							),
						),
				h(
					"fieldset",
					{ className: "rh-card", "data-rh-key-add": "" },
					h("legend", { className: "rh-muted" }, "新增 Key"),
					h(
						"div",
						{ className: "rh-grid2" },
						h(
							"label",
							{ className: "rh-field" },
							h("span", null, "API Key（只会上送到宿主，面板不保留明文）"),
							h("input", {
								type: "password",
								autoComplete: "off",
								value: draft.key,
								"data-rh-key-input": "",
								onChange: (event) => setDraft(Object.assign({}, draft, { key: event.target.value })),
							}),
						),
						h(
							"label",
							{ className: "rh-field" },
							h("span", null, "标签"),
							h("input", {
								type: "text",
								value: draft.label,
								onChange: (event) => setDraft(Object.assign({}, draft, { label: event.target.value })),
							}),
						),
						h(
							"label",
							{ className: "rh-field" },
							h("span", null, "地域"),
							h(
								"select",
								{ value: draft.region, onChange: (event) => setDraft(Object.assign({}, draft, { region: event.target.value })) },
								h("option", { value: "auto" }, "自动探测"),
								h("option", { value: "cn" }, "国内"),
								h("option", { value: "overseas" }, "海外"),
							),
						),
						h(
							"label",
							{ className: "rh-field" },
							h("span", null, "优先级（小的先用）"),
							h("input", {
								type: "number",
								value: String(draft.priority),
								onChange: (event) => setDraft(Object.assign({}, draft, { priority: numberOrUndefined(event.target.value) })),
							}),
						),
					),
					h(
						"div",
						{ className: "rh-toolbar" },
						h(
							"button",
							{
								type: "button",
								className: "rh-btn",
								"data-rh-key-add-run": "",
								disabled: draft.key.trim() === "",
								onClick: () => {
									const entry = { key: draft.key.trim(), label: draft.label, region: draft.region, priority: draft.priority };
									setDraft({ key: "", label: "", region: "auto", priority: 100 });
									props.onAdd(entry);
								},
							},
							"添加",
						),
						h("span", { className: "rh-dim" }, "面板只显示掩码；明文只在提交这一瞬间经过内存。"),
					),
				),
			);
		}

		// ---- 提示词文档库 ----

		/** 文档库小节：列表 + 编辑 + 上传 + 删除。 */
		function DocSection(props) {
			const docs = Array.isArray(props.docs) ? props.docs : [];
			const [selected, setSelected] = useState(null);
			const [name, setName] = useState("");
			const [content, setContent] = useState("");
			const [loading, setLoading] = useState(false);
			const open = async (docId) => {
				setLoading(true);
				try {
					const detail = await props.onOpen(docId);
					if (detail !== null && detail !== undefined) {
						setSelected(docId);
						setName(String(detail.name ?? docId));
						setContent(String(detail.content ?? ""));
					}
				} finally {
					setLoading(false);
				}
			};
			const pickFile = async (event) => {
				const file = event.target.files && event.target.files[0];
				if (!file) return;
				const text = await file.text();
				setSelected(null);
				setName(String(file.name || "未命名文档").replace(/\.[^.]+$/, ""));
				setContent(text);
			};
			return h(
				"div",
				{ "data-rh-docs": "" },
				docs.length === 0
					? h("p", { className: "rh-empty" }, "还没有提示词优化文档。可以点下面的「选择 txt/md 文件」上传。")
					: h(
							"ul",
							{ className: "rh-list" },
							docs.map((doc) => {
								const docId = String(doc.docId ?? doc.id ?? doc.name ?? "");
								return h(
									"li",
									{ className: "rh-card", key: docId, "data-rh-doc": docId },
									h(
										"div",
										{ className: "rh-row" },
										h("strong", null, String(doc.name ?? docId)),
										h("span", { className: "rh-dim" }, bytesText(doc.bytes)),
										h("span", { className: "rh-dim" }, timeText(doc.updatedAt)),
										h("span", { className: "rh-status-spacer" }),
										h("button", { type: "button", className: "rh-btn rh-btn-small", "data-rh-doc-open": docId, onClick: () => open(docId) }, loading ? "读取中…" : "编辑"),
										h("button", { type: "button", className: "rh-btn rh-btn-small rh-btn-danger", "data-rh-doc-remove": docId, onClick: () => props.onRemove(docId) }, "删除"),
									),
								);
							}),
						),
				h(
					"fieldset",
					{ className: "rh-card", "data-rh-doc-editor": "" },
					h("legend", { className: "rh-muted" }, selected === null ? "新建 / 上传文档" : `编辑：${selected}`),
					h(
						"label",
						{ className: "rh-field" },
						h("span", null, "文档名"),
						h("input", { type: "text", value: name, "data-rh-doc-name": "", onChange: (event) => setName(event.target.value) }),
					),
					h(
						"label",
						{ className: "rh-field" },
						h("span", null, "内容（txt / md 原文）"),
						h("textarea", { rows: 8, value: content, "data-rh-doc-content": "", onChange: (event) => setContent(event.target.value) }),
					),
					h(
						"div",
						{ className: "rh-toolbar" },
						h(
							"button",
							{
								type: "button",
								className: "rh-btn",
								"data-rh-doc-save": "",
								disabled: name.trim() === "",
								onClick: () => props.onSave({ docId: selected, name: name.trim(), content: content }),
							},
							selected === null ? "新建保存" : "保存",
						),
						h(
							"button",
							{
								type: "button",
								className: "rh-btn",
								disabled: name.trim() === "",
								onClick: () => props.onSave({ docId: null, name: `${name.trim()}-副本`, content: content }),
							},
							"另存为",
						),
						h("input", { type: "file", accept: ".txt,.md,text/plain,text/markdown", "data-rh-doc-file": "", onChange: pickFile }),
						h(
							"button",
							{
								type: "button",
								className: "rh-btn rh-btn-small",
								onClick: () => {
									setSelected(null);
									setName("");
									setContent("");
								},
							},
							"清空",
						),
					),
					h("p", { className: "rh-dim" }, "上传的文档原样存在插件数据目录，运行时可被提示词优化引用。"),
				),
			);
		}

		// ---- 任务流水 ----

		/**
		 * 「保留最近 N 条」的输入校验：**只接受非负整数**。
		 *
		 * `0` 是合法值（= 不限制）—— 调用方必须用 `=== null` 判断，
		 * 绝不能用 `if (!limit)` 这种真值判断（宿主侧刚在 `Number(null)===0` 上踩过）。
		 *
		 * @returns 合法则返回数字，非法返回 null。
		 */
		function parseLimitInput(text) {
			const trimmed = typeof text === "string" ? text.trim() : String(text === undefined || text === null ? "" : text).trim();
			if (trimmed === "") return null;
			if (!/^\d+$/.test(trimmed)) return null; // 负数 / 小数 / 科学计数法 / 字母 一律拒
			const value = Number(trimmed);
			return Number.isSafeInteger(value) ? value : null;
		}

		/** 从 `tasksLimit` 回执里取 `{limit, count}`；取不到返回 null。 */
		function tasksLimitInfo(value) {
			const entry = value !== null && typeof value === "object" ? value : null;
			if (entry === null) return null;
			const limit = typeof entry.limit === "number" || typeof entry.limit === "string" ? parseLimitInput(entry.limit) : null;
			if (limit === null) return null;
			const count = entry.count;
			return { limit: limit, count: Number.isSafeInteger(count) && count >= 0 ? count : null };
		}

		/** 小节级 ErrorBoundary：一段崩了只跳过这一段，其余小节照常渲染。 */
		class SectionBoundary extends BaseComponent {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error: error };
			}
			componentDidCatch(error, info) {
				recordClientError("section", error);
				log.warn("小节渲染失败，已跳过：", describeError(error), info);
			}
			render() {
				if (this.state.error !== null && this.state.error !== undefined) {
					return h(
						"p",
						{ className: "rh-error-text", "data-rh-section-error": "", role: "alert" },
						`该小节渲染失败，已跳过：${describeError(this.state.error)}`,
					);
				}
				return h(Fragment, null, this.props.children);
			}
		}

		/**
		 * 任务流水的「保留最近 N 条」控制条。
		 *
		 * 语义（UI 上必须说清）：默认 10；**0 = 不限制**；超出的**真删除**；
		 * 按完成时间清理；运行、待恢复、待核对和取结果中的任务继续保留。
		 *
		 * 提交时机：**失焦或回车**（不逐键发请求）。非法输入不发请求、回滚输入框、给可读提示。
		 * `tasksLimit` 不在（老宿主）或首次读取失败 → 只 warn 并隐藏本控制条，绝不影响其余小节。
		 */
		function TasksLimitBar(props) {
			const api = props !== null && props !== undefined ? props.api : null;
			const onChanged = props !== null && props !== undefined && typeof props.onChanged === "function" ? props.onChanged : () => {};
			const [state, setState] = useState({ phase: "loading", limit: 10, count: null, text: "", error: "", notice: "" });
			const [busy, setBusy] = useState(false);

			// 进面板读一次 {limit, count}
			useEffect(() => {
				let alive = true;
				if (api === null || typeof api.tasksLimit !== "function") {
					log.warn("宿主没有 tasksLimit：隐藏「保留条数」控制条");
					setState((current) => Object.assign({}, current, { phase: "unavailable" }));
					return () => {
						alive = false;
					};
				}
				Promise.resolve()
					.then(() => api.tasksLimit())
					.then(
						(value) => {
							if (!alive) return;
							const info = tasksLimitInfo(value);
							if (info === null) {
								log.warn("tasksLimit 只读回执形状不认识，隐藏控制条");
								setState((current) => Object.assign({}, current, { phase: "unavailable" }));
								return;
							}
							setState({ phase: "ready", limit: info.limit, count: info.count, text: String(info.limit), error: "", notice: "" });
						},
						(error) => {
							if (!alive) return;
							log.warn("tasksLimit 只读失败，隐藏控制条：", describeError(error));
							setState((current) => Object.assign({}, current, { phase: "unavailable" }));
						},
					);
				return () => {
					alive = false;
				};
			}, [api]);

			if (state.phase !== "ready") return null;

			/** 提交新上限（回车 / 失焦触发）。 */
			const commit = () => {
				if (busy) return;
				const parsed = parseLimitInput(state.text);
				if (parsed === null) {
					// 非法输入：**不发请求**，回滚输入框 + 可读提示
					setState((current) => Object.assign({}, current, { text: String(current.limit), error: "请输入 0 或正整数（0 = 不限制）", notice: "" }));
					return;
				}
				if (parsed === state.limit) {
					setState((current) => Object.assign({}, current, { text: String(parsed), error: "", notice: "" }));
					return;
				}
				setBusy(true);
				Promise.resolve()
					.then(() => api.tasksLimit(parsed))
					.then(
						(value) => {
							const removed = value !== null && typeof value === "object" && Array.isArray(value.removed) ? value.removed : [];
							// 成功后把 {limit, count} 刷新一遍
							return Promise.resolve()
								.then(() => api.tasksLimit())
								.then(
									(fresh) => ({ removed: removed, fresh: fresh }),
									() => ({ removed: removed, fresh: null }),
								);
						},
					)
					.then(
						(result) => {
							const info = tasksLimitInfo(result.fresh);
							setState((current) => {
								const limit = info === null ? parsed : info.limit;
								return {
									phase: "ready",
									limit: limit,
									count: info === null ? current.count : info.count,
									text: String(limit),
									error: "",
									notice: result.removed.length > 0 ? `已删除 ${result.removed.length} 条较早结束的记录` : "已保存",
								};
							});
							setBusy(false);
							onChanged();
						},
						async (error) => {
							const text = describeError(error);
							let fresh = null;
							if (error.code === "TASK_PRUNE_FAILED") {
								try { fresh = tasksLimitInfo(await api.tasksLimit()); } catch { /* 错误正文仍会说明设置已保存 */ }
								onChanged();
							}
							setState((current) =>
								Object.assign({}, current, {
									limit: fresh === null ? current.limit : fresh.limit,
									count: fresh === null ? current.count : fresh.count,
									text: String(fresh === null ? current.limit : fresh.limit),
									error: /SAVE_FAILED/.test(text) ? `${text}（保留条数未修改）` : text,
									notice: "",
								}),
							);
							setBusy(false);
						},
					);
			};

			return h(
				"div",
				{ className: "rh-limit", "data-rh-task-limit": "" },
				h("span", { className: "rh-muted" }, "保留最近"),
				h("input", {
					type: "number",
					min: "0",
					step: "1",
					className: "rh-limit-input",
					value: state.text,
					disabled: busy,
					"data-rh-task-limit-input": "",
					"aria-label": "任务流水保留条数",
					onChange: (event) => setState((current) => Object.assign({}, current, { text: String(event.target.value), error: "", notice: "" })),
					onKeyDown: (event) => {
						if (event !== null && event !== undefined && event.key === "Enter") {
							if (typeof event.preventDefault === "function") event.preventDefault();
							commit();
						}
					},
					onBlur: commit,
				}),
				h("span", { className: "rh-muted" }, "条"),
				h("span", { className: "rh-dim" }, "0 = 不限制"),
				state.count === null ? null : h("span", { className: "rh-dim", "data-rh-task-limit-count": "" }, `当前 ${state.count} 条`),
				state.error === "" ? null : h("span", { className: "rh-error-text", "data-rh-task-limit-error": "", role: "alert" }, state.error),
				state.notice === "" ? null : h("span", { className: "rh-muted", "data-rh-task-limit-notice": "" }, state.notice),
				h("span", { className: "rh-dim" }, "（按完成时间清理；运行中的永不删，待恢复/待核对另有独立上限）"),
			);
		}

		const TASK_FILTERS = [
			["", "全部状态"], ["RUNNING", "运行中"], ["QUEUED", "排队中"],
			["SUCCESS", "生成完成"], ["FAILED", "失败"], ["CANCEL", "已取消"],
			["ERROR", "等待恢复"], ["UNCERTAIN", "待核对"],
		];
		const taskIsActive = (task) => ["CREATE", "QUEUED", "PENDING", "RUNNING"].includes(String(task.status).toUpperCase());

		/** 任务区展开时才挂载；活动任务每 3 秒读取一次，后台标签页暂停。 */
		function TaskSection(props) {
			const tasks = Array.isArray(props.tasks) ? props.tasks : [];
			const hasActive = tasks.some(taskIsActive);
			const [copyNotice, setCopyNotice] = useState("");
			useEffect(() => {
				if (!hasActive || !props.onReload) return;
				let timer;
				let stopped = false;
				let loading = false;
				const schedule = () => {
					clearTimeout(timer);
					if (!stopped && !loading && !document.hidden) timer = setTimeout(poll, 3000);
				};
				const poll = async () => {
					loading = true;
					try {
						await props.onReload();
					} finally {
						loading = false;
						schedule();
					}
				};
				document.addEventListener("visibilitychange", schedule);
				schedule();
				return () => {
					stopped = true;
					clearTimeout(timer);
					document.removeEventListener("visibilitychange", schedule);
				};
			}, [hasActive, props.onReload]);

			const copyPath = async (path) => {
				try {
					await window.navigator.clipboard.writeText(path);
					setCopyNotice("路径已复制。");
				} catch (error) {
					setCopyNotice(`复制失败：${describeError(error)}；可直接选中路径复制。`);
				}
			};
			return h("div", { "data-rh-tasks": "" },
				h(SectionBoundary, null, h(TasksLimitBar, { api: props.api, onChanged: props.onLimitChanged })),
				h("div", { className: "rh-row" },
					h("label", { className: "rh-field" }, h("span", null, "状态"), h("select", {
						"data-rh-task-filter": "", value: props.status || "",
						onChange: (event) => props.onFilter(event.target.value),
					}, TASK_FILTERS.map(([value, label]) => h("option", { key: value, value }, label)))),
					h("button", { type: "button", className: "rh-btn rh-btn-small", "data-rh-tasks-refresh": "", onClick: () => void props.onReload() }, "刷新任务"),
					hasActive ? h("span", { className: "rh-dim" }, "运行时每 3 秒自动刷新") : null,
				),
				props.error ? h("p", { className: "rh-error-text", role: "alert" }, props.error) : null,
				copyNotice ? h("p", { className: "rh-muted", role: "status" }, copyNotice) : null,
				tasks.length === 0 ? h("p", { className: "rh-empty" }, props.status ? "没有符合该状态的任务。" : "还没有任务记录。") : h("ul", { className: "rh-list" },
					tasks.map((task) => {
						const taskId = String(task.taskId ?? task.id ?? "");
						const state = taskState(task.status);
						const progress = task.progress === "" || task.progress == null ? NaN : Number(task.progress);
						const outputs = Array.isArray(task.outputs) ? task.outputs : Array.isArray(task.results) ? task.results : [];
						const needsRetry = task.status === "SUCCESS" && outputs.some((output) => output.error || output.attachmentError);
						return h("li", { className: "rh-card", key: taskId, "data-rh-task": taskId },
							h("div", { className: "rh-row" },
								h("code", null, taskId),
								h(Badge, { tone: state.tone }, state.text),
								task.workflowName ? h("span", { className: "rh-muted" }, String(task.workflowName)) : null,
								h("span", { className: "rh-dim" }, timeText(task.createdAt)),
								Number.isFinite(progress) ? h("span", { className: "rh-progress" }, h("i", { style: { width: `${Math.max(0, Math.min(100, progress))}%` } })) : null,
								h("span", { className: "rh-status-spacer" }),
								h("button", { type: "button", className: "rh-btn rh-btn-small", disabled: props.busy, "data-rh-task-refresh": taskId, onClick: () => props.onRefresh(taskId) }, "查最新状态"),
								needsRetry ? h("button", { type: "button", className: "rh-btn rh-btn-small", disabled: props.busy, "data-rh-task-retry": taskId, onClick: () => props.onRetry(taskId) }, "补下载 / 补附件") : null,
								taskIsActive(task) ? h("button", { type: "button", className: "rh-btn rh-btn-small", disabled: props.busy, "data-rh-task-cancel": taskId, onClick: () => props.onCancel(taskId) }, "取消") : null,
							),
							task.error ? h("p", { className: "rh-error-text" }, describeError(task.error)) : null,
							task.persisted === false ? h("p", { className: "rh-error-text" }, "本地记录尚未保存。插件正在补存，请勿重新提交；关闭进程会丢失这条记录。") : null,
							task.hint ? h("p", { className: "rh-muted" }, task.hint) : null,
							task.status === "SUCCESS" && outputs.length === 0 ? h("p", { className: "rh-muted" }, "生成已完成，没有可下载的输出。") : null,
							outputs.length > 0 ? h("ul", { className: "rh-list" }, outputs.map((output, index) => {
								const link = typeof output === "string" ? output : String(output.url || "");
								const url = /^https?:\/\//i.test(link) ? link : "";
								const localPath = typeof output === "string" ? (url ? "" : output) : String(output.localPath || output.filePath || "");
								const attachmentId = output.attachmentId || output.attachment?.attachmentId;
								const isImage = /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(url);
								return h("li", { key: `${taskId}-${index}`, "data-rh-task-result": index },
									h("div", { className: "rh-row" },
										h("span", { className: "rh-muted" }, output.filename || `结果 ${index + 1}`),
										localPath ? h(Badge, { tone: "ok" }, "已保存") : null,
										attachmentId ? h(Badge, { tone: "ok" }, "附件已就绪") : null),
									output.text ? h("pre", { className: "rh-wrap-anywhere" }, output.text) : null,
									url ? h("a", { href: url, target: "_blank", rel: "noreferrer", className: "rh-wrap-anywhere" }, isImage ? h("img", { className: "rh-thumb", src: url, alt: "结果图" }) : url) : null,
									localPath ? h("div", { className: "rh-row" }, h("code", { className: "rh-wrap-anywhere" }, localPath), h("button", { type: "button", className: "rh-btn rh-btn-small", "data-rh-task-copy-path": localPath, onClick: () => void copyPath(localPath) }, "复制路径")) : null,
									output.error ? h("p", { className: "rh-error-text" }, `下载失败：${describeError(output.error)}`) : null,
									output.attachmentError ? h("p", { className: "rh-error-text" }, `附件未就绪：${describeError(output.attachmentError)}`) : null,
									output.note ? h("p", { className: "rh-dim" }, output.note) : null,
								);
							})) : null,
						);
					})),
				props.hasMore ? h("button", { type: "button", className: "rh-btn", "data-rh-tasks-more": "", onClick: props.onMore }, "加载更多") : null,
			);
		}

		/** JSON 美化（失败时原样返回）。 */
		function deepCopy(value) {
			try {
				return JSON.parse(JSON.stringify(value === undefined ? null : value));
			} catch (error) {
				return value;
			}
		}

		/** JSON.stringify 的兜底（循环引用 / 大对象）。 */
		function safeJson(value) {
			try {
				return JSON.stringify(value, null, 2);
			} catch (error) {
				return describeError(error);
			}
		}

		// ---- 根组件 ----

		/**
		 * 面板根组件。
		 * 标准 slot 属性（useResource/useSessions…）一律不用，只依赖注册时注入的 `api`，
		 * 这样组件既能在 DSH 里跑，也能在测试里用桩 api 直接渲染。
		 */
		function RunningHubPanel(props) {
			const api = props !== null && props !== undefined && props.api !== undefined ? props.api : null;
			/** 嵌入宿主页面（plugins.bundle.config 的 page 态）——不画自己的大标题。 */
			const embedded = props !== null && props !== undefined && props.embedded === true;
			const [view, setView] = useState({ phase: "loading", error: null, notice: null, status: null, workflows: [], docs: [], tasks: [], taskError: null, transportKind: "", channelReport: "", clientErrors: [] });
			const [busy, setBusy] = useState(null);
			const [open, setOpen] = useState({ keys: false, workflows: true, docs: false, tasks: false });
			const [balances, setBalances] = useState({});
			const [taskQuery, setTaskQuery] = useState({ limit: 20, status: "" });
			const taskQueryRef = useRef(taskQuery);
			const taskRequest = useRef(0);
			const mounted = useRef(true);
			useEffect(() => {
				mounted.current = true;
				return () => { mounted.current = false; };
			}, []);

			const refreshTasks = useCallback(async (query = taskQueryRef.current) => {
				const request = ++taskRequest.current;
				try {
					const tasks = await api.tasks.list(query.limit, query.status);
					if (mounted.current && request === taskRequest.current) setView((current) => Object.assign({}, current, { tasks, taskError: null }));
				} catch (error) {
					if (mounted.current && request === taskRequest.current) setView((current) => Object.assign({}, current, { taskError: describeError(error) }));
				}
			}, [api]);

			const changeTaskQuery = (query) => {
				taskQueryRef.current = query;
				setTaskQuery(query);
				void refreshTasks(query);
			};

			/** 拉一次快照；每一路独立 settle，坏一路不影响其它。 */
			const refresh = useCallback(async () => {
				if (api === null) {
					setView((current) => Object.assign({}, current, { phase: "error", error: "面板没有拿到宿主接口（api 未注入）。" }));
					return;
				}
				const settle = async (promise) => {
					try {
						return { ok: true, value: await promise };
					} catch (error) {
						return { ok: false, error: describeError(error) };
					}
				};
				const request = ++taskRequest.current;
				const query = taskQueryRef.current;
				const [status, workflows, docs, tasks] = await Promise.all([
					settle(api.status()),
					settle(api.listWorkflows()),
					settle(api.docs.list()),
					settle(api.tasks.list(query.limit, query.status)),
				]);
				if (mounted.current === false) return;
				const failures = [status, workflows, docs, tasks].filter((entry) => entry.ok === false);
				const allFailed = failures.length === 4;
				let transportKind = "";
				let channelReport = "";
				let clientErrors = [];
				try {
					transportKind = api.transportKind === undefined || api.transportKind === null ? "" : String(api.transportKind);
					// 通道诊断（结论 + 原因）：出问题时用户截图就能定位，不用隔空猜
					channelReport = api.channelReport === undefined || api.channelReport === null ? "" : String(api.channelReport);
					// `$mount` 内部被吞掉的异常只有这两个全局钩子能捞到 —— 显示给用户看
					clientErrors = typeof api.listClientErrors === "function" ? api.listClientErrors() : [];
					if (!Array.isArray(clientErrors)) clientErrors = [];
				} catch (error) {
					transportKind = "";
					channelReport = describeError(error);
					clientErrors = [];
				}
				setView((current) =>
					Object.assign({}, current, {
						phase: allFailed ? "error" : "ready",
						transportKind: transportKind,
						channelReport: channelReport,
						clientErrors: clientErrors,
						error: allFailed ? `读取宿主快照失败：${failures[0].error}` : failures.length > 0 ? `部分数据读取失败：${failures.map((entry) => entry.error).join("；")}` : null,
						status: status.ok ? status.value : current.status,
						workflows: workflows.ok ? (Array.isArray(workflows.value) ? workflows.value : []) : current.workflows,
						docs: docs.ok ? (Array.isArray(docs.value) ? docs.value : []) : current.docs,
						tasks: tasks.ok && request === taskRequest.current ? (Array.isArray(tasks.value) ? tasks.value : []) : current.tasks,
						taskError: request === taskRequest.current ? (tasks.ok ? null : tasks.error) : current.taskError,
					}),
				);
			}, [api]);

			useEffect(() => {
				void refresh();
			}, [refresh]);

			/** 统一的写操作包装：置忙 → 执行 → 提示 → 刷新；失败给可读错误。 */
			const run = useCallback(async (label, thunk, onRefresh = refresh) => {
				setBusy(label);
				try {
					const value = await thunk();
					if (mounted.current === false) return null;
					setView((current) => Object.assign({}, current, { notice: `${label}：完成`, error: null }));
					await onRefresh();
					return value === undefined ? null : value;
				} catch (error) {
					if (mounted.current === false) return null;
					setView((current) => Object.assign({}, current, { notice: null, error: `${label}：${describeError(error)}` }));
					return null;
				} finally {
					if (mounted.current !== false) setBusy(null);
				}
			}, [refresh]);

			const status = view.status;
			return h(
				"div",
				{ className: "rh-panel", "data-rh-panel": "", "data-rh-phase": view.phase, "data-rh-embedded": embedded ? "true" : "false" },
				// 嵌入「插件」页面时不画自己的大标题：宿主页面已经有插件名 + 描述，
				// 再顶一个 "RunningHub 工作流" 就是重复标题（Lead 明确要求）。
				embedded
					? null
					: h(
							"div",
							{ className: "rh-head" },
							h("h3", { className: "rh-title" }, "RunningHub 工作流"),
							h("span", { className: "rh-muted" }, "生图 / 生视频 / 生音频 · 多 Key 智能调度"),
							busy !== null ? h(Badge, { tone: "info" }, `${busy} 进行中…`) : null,
						),
				h(Alerts, { error: view.error, notice: view.notice, clientErrors: view.clientErrors }),
				h(StatusBar, {
					status: status,
					transportKind: view.transportKind,
					channelReport: view.channelReport,
					onRefresh: () => void refresh(),
					onDiagnostics: () => void run("自检", async () => {
						const result = await api.diagnostics();
						setView((current) => Object.assign({}, current, { notice: `自检：${typeof result === "string" ? result : safeJson(result)}` }));
						return result;
					}),
					busy: busy !== null,
				}),
				api === null
					? h("p", { className: "rh-error-text" }, "面板没有拿到宿主接口：请在 DSH 设置 → 插件里确认本插件已启用。")
					: h(
							Fragment,
							null,
							h(
								Section,
								{
									id: "keys",
									title: "Key 管理",
									count: `（${Array.isArray(status && status.keys) ? status.keys.length : 0} 个）`,
									open: open.keys === true,
									onToggle: () => setOpen((current) => Object.assign({}, current, { keys: !current.keys })),
								},
								h(KeySection, {
									keys: status && Array.isArray(status.keys) ? status.keys : [],
									balances: balances,
									onAdd: (entry) => void run("添加 Key", () => api.keys.add(entry)),
									onPatch: (id, patch) => void run("更新 Key", () => api.keys.update(id, patch)),
									onRemove: (id) => void run("删除 Key", () => api.keys.remove(id)),
									onDetect: (id) => void run("探测地域", () => api.keys.detect(id)),
									onBalance: (id) => void run("查余额", async () => {
										const result = await api.keys.balance(id);
										setBalances((current) => Object.assign({}, current, { [id]: result }));
										return result;
									}),
								}),
							),
							h(
								Section,
								{
									id: "workflows",
									keepMounted: true,
									title: "工作流",
									count: `（${view.workflows.length} 个）`,
									open: open.workflows !== false,
									onToggle: () => setOpen((current) => Object.assign({}, current, { workflows: current.workflows === false })),
								},
								h(WorkflowSection, {
									workflows: view.workflows,
									docs: view.docs,
									busy: busy,
									onSave: (config) => run("保存工作流", () => api.saveWorkflow(config)),
									onDelete: (name) => void run("删除工作流", () => api.deleteWorkflow(name)),
									onProbe: (request) => run("读取工作流", () => api.probeWorkflow(request)),
								}),
							),
							h(
								Section,
								{
									id: "docs",
									title: "提示词优化文档库",
									count: `（${view.docs.length} 个）`,
									open: open.docs === true,
									onToggle: () => setOpen((current) => Object.assign({}, current, { docs: !current.docs })),
								},
								h(DocSection, {
									docs: view.docs,
									onOpen: (docId) => api.docs.get(docId),
									onSave: (doc) => void run("保存文档", () => api.docs.save(doc)),
									onRemove: (docId) => void run("删除文档", () => api.docs.remove(docId)),
								}),
							),
							h(
								Section,
								{
									id: "tasks",
									title: "任务流水",
									count: `（${view.tasks.length} 条）`,
									open: open.tasks === true,
									onToggle: () => {
										setOpen((current) => Object.assign({}, current, { tasks: !current.tasks }));
										if (!open.tasks) void refreshTasks();
									},
								},
								h(TaskSection, {
									tasks: view.tasks,
									api: api,
									busy: busy !== null,
									error: view.taskError,
									status: taskQuery.status,
									hasMore: view.tasks.length >= taskQuery.limit,
									onReload: refreshTasks,
									onFilter: (status) => changeTaskQuery({ limit: 20, status }),
									onMore: () => changeTaskQuery({ limit: taskQuery.limit + 20, status: taskQuery.status }),
									onRefresh: (taskId) => void run("查询任务", () => api.tasks.refresh(taskId), refreshTasks),
									onRetry: (taskId) => void run("补取结果", () => api.tasks.retry(taskId), refreshTasks),
									onCancel: (taskId) => void run("取消任务", () => api.tasks.cancel(taskId), refreshTasks),
									// 改完保留条数（可能删了旧记录）→ 刷新任务列表
									onLimitChanged: refreshTasks,
								}),
							),
						),
				h("p", { className: "rh-dim" }, "本面板只从宿主读取掩码 Key；明文 Key 不会出现在这里。"),
			);
		}

		/** 崩溃隔离：面板内部任何渲染异常都降级成一行错误，绝不白屏设置页。 */
		class PanelBoundary extends BaseComponent {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error: error };
			}
			componentDidCatch(error, info) {
				log.warn("面板渲染异常：", describeError(error), info);
			}
			render() {
				if (this.state.error !== null && this.state.error !== undefined) {
					return h(
						"div",
						{ className: "rh-crash", "data-dsh-runninghub": "", role: "alert" },
						h("strong", null, "RunningHub 面板渲染失败"),
						h("p", { className: "rh-error-text" }, describeError(this.state.error)),
						h("p", { className: "rh-dim" }, "其余设置页不受影响。修复或重装插件后重新打开本页即可。"),
					);
				}
				return h("div", { "data-dsh-runninghub": "" }, this.props.children);
			}
		}

		/**
		 * slot 渲染入口（完整面板）。`embedded: true` 时不画自己的标题，
		 * 供「插件」页面（宿主已经有插件名 + 描述）复用。
		 */
		function RunningHubPanelRoot(props) {
			return h(PanelBoundary, null, h(RunningHubPanel, props || {}));
		}

		/** `plugins.bundle.config` 的 summary 态一行摘要（纯逻辑，可测）。 */
		function summaryLine(status) {
			const entry = status !== null && typeof status === "object" ? status : {};
			const counts = entry.counts !== null && typeof entry.counts === "object" ? entry.counts : {};
			const parts = [poolText(entry.pool)];
			if (counts.workflows !== undefined && counts.workflows !== null) parts.push(`${Number(counts.workflows) || 0} 个工作流`);
			if (counts.tasks !== undefined && counts.tasks !== null) parts.push(`${Number(counts.tasks) || 0} 个任务`);
			return parts.join(" · ");
		}

		/**
		 * summary 态：**只渲染一行**（插件列表/卡片上的那一行）。
		 * 只取一次 `status`（自带 pool + counts），不加载工作流/文档/任务明细。
		 */
		function RunningHubSummary(props) {
			const api = props !== null && props !== undefined && props.api !== undefined ? props.api : null;
			const [state, setState] = useState({ phase: "loading", status: null, error: null });
			useEffect(() => {
				let alive = true;
				if (api === null) {
					setState({ phase: "error", status: null, error: "无宿主接口" });
					return () => {
						alive = false;
					};
				}
				Promise.resolve()
					.then(() => api.status())
					.then(
						(status) => {
							if (alive) setState({ phase: "ready", status: status, error: null });
						},
						(error) => {
							if (alive) setState({ phase: "error", status: null, error: describeError(error) });
						},
					);
				return () => {
					alive = false;
				};
			}, [api]);
			if (state.phase === "loading") {
				return h("span", { className: "rh-summary", "data-dsh-runninghub": "", "data-rh-summary": "", "data-tone": "muted" }, "—");
			}
			if (state.phase === "error") {
				return h(
					"span",
					{ className: "rh-summary", "data-dsh-runninghub": "", "data-rh-summary": "", "data-tone": "error" },
					`读取失败：${state.error}`,
				);
			}
			return h("span", { className: "rh-summary", "data-dsh-runninghub": "", "data-rh-summary": "" }, summaryLine(state.status));
		}

		/**
		 * 造 `plugins.bundle.config` 的组件（按 `view` 两态）。
		 *
		 * `api` 走**闭包**而不是宿主注入：这个槽位的注册项只有 `key` 是文档化必填，
		 * 不能假定它支持 `inject`（那是 `settings.plugins.tab` 的写法）。
		 * 闭包让页面在"宿主没拍平 inject 键"时也照常工作 —— 真机白屏过一次，不再赌。
		 *
		 * ⚠️ 宿主 ownerProps 里的 `form`（`ConfigPageForm`）**故意忽略**：
		 * 那是给"配置存在 loader config 里、由宿主托管读写"的插件用的；
		 * 我们的 Key / 工作流 / 文档都在插件自己的数据目录（`<DSH_HOME>/runninghub`），
		 * 读写全部走 `api`（Remote/HTTP 通道）。接上 `form` 反而会把面板接到一个空表单。
		 */
		function createBundleConfigComponent(api) {
			return function RunningHubBundleConfig(props) {
				const view = props !== null && props !== undefined && typeof props.view === "string" ? props.view : "page";
				if (view === "summary") return h(RunningHubSummary, { api: api });
				return h(RunningHubPanelRoot, { api: api, embedded: true });
			};
		}


		// ------------------------------------------------------------------
		// 4b. 工具卡片（`tool.call.toolview`，key = 工具名）
		// ------------------------------------------------------------------

		/**
		 * 结算态 `ToolResultNode` 的真实结构（源码确证，`probe/_ref/dsh-client-ui-tool/lib/client.js`）：
		 *
		 *   `toolCallPhase(block)`（1804-1816）：`"kind" in block` → `phase:"result"`，否则
		 *   `block.phase === "preparing" ? "preparing" : "start"`。
		 *   `resultText(node)`（179-185）：遍历 `node.content`，
		 *   `block.type === "text" ? block.text : JSON.stringify(block)`。
		 *   `imageReferences(content)`（2735-2768）：图片块是
		 *   `{ type:"image", attachment:{ attachmentId, mediaType, bytes, width, height, name?, originalDimensions? } }`，
		 *   且 **attachment 本身就是传给 `loadImage` 的那个对象**（2837 `refs.map((ref) => ({ attachment: ref }))`）。
		 *   调用头：`block.call = { name, argsRaw }`（`callName` 1818-1820）。
		 */
		/**
		 * 环境是否支持原生 `<datalist>`。
		 *
		 * 不支持的浏览器里 `<datalist>` 只是被忽略、`list` 属性无效果 —— 本来就是"优雅降级"。
		 * 但为了不让用户看到"有建议却点不出来"的怪状态，这里探测一次：不支持就退回纯输入框。
		 */
		function supportsDatalist() {
			try {
				if (typeof window !== "undefined" && window !== null && "HTMLDataListElement" in window) {
					return typeof window.HTMLDataListElement === "function";
				}
				if (typeof document !== "undefined" && document !== null && typeof document.createElement === "function") {
					const probe = document.createElement("datalist");
					return probe !== null && typeof probe === "object" && String(probe.tagName || "").toUpperCase() === "DATALIST";
				}
				return false;
			} catch (error) {
				return false;
			}
		}

		/** 取一个节点字段的"可用建议值"（去掉空串）。 */
		function fieldOptions(node) {
			const list = node !== null && typeof node === "object" && Array.isArray(node.options) ? node.options : [];
			return list.filter((option) => typeof option === "string" && option !== "");
		}

		/**
		 * 一个节点字段的取值控件 —— **三态**：
		 *
		 *   1. `valueType === 'enum'` → 真 `<select>`（真枚举，只能选）；
		 *   2. 非 enum 且 `options.length > 0` → **原生 `<input list>` + `<datalist>`**
		 *      （"可选也可以自己敲"，键盘操作 / 无障碍由浏览器白送，不自造组件）；
		 *      `optionsSource === 'inferred-from-default'` 时旁边写明「已知值，可自由输入」——
		 *      否则用户会以为只有这一个值（真机 `aspect_ratio` 就是这么被锁死的）。
		 *      完整说明放 `title`（宿主写的 `note`）。
		 *   3. 其它 → 纯 `<input>`，不渲染任何建议容器。
		 *
		 * `id` 用 `rh-opt-<nodeId>-<fieldName>`：同名字段会在多个节点出现，必须唯一。
		 * 环境不支持 datalist 时自动退回第 3 态。
		 */
		function NodeFieldInput(props) {
			const node = props !== null && props !== undefined && props.node !== null && typeof props.node === "object" ? props.node : {};
			const value = props !== null && props !== undefined && props.value !== undefined && props.value !== null ? String(props.value) : "";
			const onChange = props !== null && props !== undefined && typeof props.onChange === "function" ? props.onChange : () => {};
			const options = fieldOptions(node);
			const label = props !== null && props !== undefined && typeof props.label === "string" ? props.label : "值";

			// ① 真枚举：只能选
			if (node.valueType === "enum") {
				return h(
					"select",
					{ value: value, onChange: (event) => onChange(event.target.value), "data-rh-field-kind": "enum" },
					options.length === 0 ? h("option", { value: "" }, "（无可选项）") : null,
					options.map((option) => h("option", { key: option, value: option }, option)),
				);
			}

			const inputType = node.valueType === "number" ? "number" : "text";
			const inferred = node.optionsSource === "inferred-from-default";
			const listId = `rh-opt-${String(node.nodeId === undefined || node.nodeId === null ? "x" : node.nodeId)}-${String(
				node.fieldName === undefined || node.fieldName === null ? "field" : node.fieldName,
			)}`;

			// ③ 没有建议值 / 环境不支持 datalist：纯输入框
			if (options.length === 0 || !supportsDatalist()) {
				return h("input", {
					type: inputType,
					value: value,
					placeholder: options.length === 0 ? "自由输入" : `${options.length} 个已知值，可自由输入`,
					onChange: (event) => onChange(event.target.value),
					"data-rh-field-kind": "plain",
				});
			}

			// ② 有建议值：原生 input + datalist（可选可敲）
			return h(
				Fragment,
				null,
				h("input", {
					type: inputType,
					value: value,
					list: listId,
					title: typeof node.note === "string" && node.note !== "" ? node.note : undefined,
					onChange: (event) => onChange(event.target.value),
					"data-rh-field-kind": "suggest",
					"aria-label": label,
				}),
				h(
					"datalist",
					{ id: listId, "data-rh-datalist": "" },
					options.map((option) => h("option", { key: option, value: option }, option)),
				),
				inferred
					? h("span", { className: "rh-dim rh-field-hint", "data-rh-field-hint": "inferred" }, "已知值，可自由输入")
					: null,
			);
		}

		/**
		 * 枚举选项的多行编辑器（**编辑态保留原文**）。
		 *
		 * 这是真机 bug 的修复点：以前 `onChange` 里直接
		 * `split('\n').map(trim).filter(Boolean).join('\n')` 再写回受控 textarea ——
		 * 末尾刚敲出来的那个空行被 `filter(Boolean)` 吃掉 → 用户按回车"没反应"；
		 * 而"打字后换行"能成，是因为那行有内容、不被丢。
		 *
		 * 现在的分工：
		 *   - `onChange`：**只 `setRaw`**，一个字符都不删、不 trim、不过滤；
		 *     同时把**解析后的值**推给上层（这样不 blur 直接点保存也不会丢改动）。
		 *   - `onBlur`：规范化（trim + 丢空行 + 去重 + 保序），并把显示文本同步成规范化结果 ——
		 *     否则用户会看到"我保存了但屏幕没变"。
		 *   - 回车**不拦截**（多行框里回车就是换行）。
		 *
		 * 粘贴多行天然安全：`onChange` 拿到什么就是什么。
		 */
		function OptionsEditor(props) {
			const node = props !== null && props !== undefined && props.node !== null && typeof props.node === "object" ? props.node : {};
			const onCommit = props !== null && props !== undefined && typeof props.onCommit === "function" ? props.onCommit : () => {};
			const [raw, setRaw] = useState(() => optionsToText(node.options));
			const commit = (text) => {
				const options = normalizeOptions(text);
				onCommit(options);
				return options;
			};
			return h("textarea", {
				rows: 4,
				value: raw,
				"data-rh-options-text": "",
				placeholder: "一行一个；可留空表示没有建议值",
				// 只保留原文 —— 绝不在这里规范化
				onChange: (event) => {
					const next = event !== null && event !== undefined && event.target !== null && event.target !== undefined ? String(event.target.value) : "";
					setRaw(next);
					commit(next);
				},
				onBlur: () => {
					// 规范化并把显示文本同步过去（空清单就是空文本，不会是 ['']）
					setRaw(optionsToText(commit(raw)));
				},
			});
		}

		/** 安全 JSON.parse（失败返回 null）。 */
		function parseArgsSafe(call) {
			if (call === null || typeof call !== "object" || typeof call.argsRaw !== "string") return null;
			try {
				const value = JSON.parse(call.argsRaw);
				return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
			} catch (error) {
				return null;
			}
		}

		/** 文本里的 http(s) 链接（去重、限量）—— 兜底：图显示不了也要能点开。 */
		function findLinks(text) {
			const out = [];
			if (typeof text !== "string" || text === "") return out;
			const matches = text.match(/https?:\/\/[^\s"'<>()\]]+/g);
			if (matches === null) return out;
			for (const url of matches) {
				if (!out.includes(url)) out.push(url);
				if (out.length >= 10) break;
			}
			return out;
		}

		/**
		 * 本地绝对路径行的识别（宿主新回执里每行是 `📁 C:\...\a.png`）。
		 *
		 * 正则字面值：`/^\s*(?:📁\s*)?((?:[A-Za-z]:\\|\\\\)[^\r\n]*?)\s*$/`
		 *   - 可选 `📁` 前缀（宿主成功回执用的就是它）；
		 *   - 路径必须是盘符绝对路径 `X:\` 或 UNC `\\server\share`；
		 *   - 路径里**允许空格**（Windows 用户目录很常见），所以不按空白切断。
		 */
		const LOCAL_FILE_LINE = /^\s*(?:📁\s*)?((?:[A-Za-z]:\\|\\\\)[^\r\n]*?)\s*$/;

		/** 从结果摘要或旧版路径行提取本地文件（去重、限量、保留顺序）。 */
		function extractLocalFiles(text) {
			const out = [];
			if (typeof text !== "string" || text === "") return out;
			for (const rawLine of text.split(/\r?\n/)) {
				const match = LOCAL_FILE_LINE.exec(rawLine);
				let paths = match === null ? [] : [match[1].replace(/[，。；、,;]+$/, "").trim()];
				if (rawLine.trimStart().startsWith("{")) {
					try {
						const tasks = JSON.parse(rawLine).data?.tasks;
						paths = (tasks || []).flatMap(task => task.results || []).map(result => result.localPath).filter(path => typeof path === "string");
					} catch { /* 非结果信封，继续按普通文本处理。 */ }
				}
				for (const path of paths) {
					if (path === "" || out.some((entry) => entry.path === path)) continue;
					const segments = path.split(/[\\/]/);
					const last = segments[segments.length - 1];
					out.push({ path: path, name: last === undefined || last === "" ? path : last });
					if (out.length >= 20) return out;
				}
			}
			return out;
		}

		/**
		 * 把一个工具调用块（任意 phase）**安全**摊平成可渲染模型。
		 * 全程防御式读取：形状不认识也绝不抛，最多降级成"只有文本"。
		 */
		function toolCallView(phase, block) {
			const entry = block !== null && typeof block === "object" ? block : {};
			const call = entry.call !== null && typeof entry.call === "object" ? entry.call : null;
			const settled = phase === "result";
			const args = parseArgsSafe(call);
			// 内容块的两条来源（参考实现 shanliuling/dsh-image-gen 的取法）：
			//   `block.resultView.card === 'generic'` → 用 `resultView.content`，否则用 `block.content`；
			//   若首选为空、另一条有值，也认（形状可能随版本漂移）。
			const resultView = entry.resultView !== null && typeof entry.resultView === "object" ? entry.resultView : null;
			const ownContent = Array.isArray(entry.content) ? entry.content : [];
			const viewContent = resultView !== null && Array.isArray(resultView.content) ? resultView.content : [];
			let content = ownContent;
			if (resultView !== null && resultView.card === "generic" && viewContent.length > 0) content = viewContent;
			else if (content.length === 0) content = viewContent;
			const texts = [];
			const refs = [];
			for (const part of content) {
				if (part === null || typeof part !== "object") continue;
				if (part.type === "text") {
					if (typeof part.text === "string") texts.push(part.text);
					continue;
				}
				if (part.type === "image") {
					const attachment = part.attachment;
					if (
						attachment !== null &&
						typeof attachment === "object" &&
						typeof attachment.attachmentId === "string" &&
						attachment.attachmentId !== ""
					) {
						refs.push(attachment);
					} else {
						texts.push("[图片块缺少可用的 attachment 引用]");
					}
					continue;
				}
				try {
					texts.push(JSON.stringify(part, null, 2));
				} catch (error) {
					texts.push(String(part));
				}
			}
			if (texts.length === 0 && entry.error !== null && typeof entry.error === "object") {
				texts.push(`${entry.error.name}: ${entry.error.code}`);
			}
			const text = texts.join("\n");
			const state = !settled
				? entry.phase === "preparing"
					? "preparing"
					: "running"
				: entry.isError === true
					? "error"
					: "ok";
			return {
				settled: settled,
				toolName: call !== null && typeof call.name === "string" ? call.name : "",
				action: args !== null && typeof args.action === "string" ? args.action : "",
				state: state,
				stateLabel: state === "preparing" ? "准备中…" : state === "running" ? "执行中…" : state === "error" ? "失败" : "完成",
				text: text,
				refs: refs,
				links: findLinks(text),
				// 本地文件优先（用户要求：结果展示本地路径，不再展示远端 URL）
				localFiles: extractLocalFiles(text),
			};
		}

		/** 结算内容的纯文本（ErrorBoundary 的兜底内容；绝不抛）。 */
		function safeResultText(block) {
			try {
				return toolCallView("result", block).text;
			} catch (error) {
				return "";
			}
		}

		/**
		 * 读宿主的错误正文（`{ok:false,error:{code,message}}`）。
		 *
		 * 为什么必须读出来：`dsh-attachment-local` 的 `readImageFile` 会**逐字段比对**
		 * 引用与磁盘图片元数据（mediaType / bytes / width / height），不一致就抛
		 * `Stored attachment metadata does not match its reference.`。
		 * 只显示"加载失败"会让人根本猜不到缺了什么 —— 把原文端到卡片上。
		 */
		async function readRouteErrorDetail(response) {
			try {
				if (response === null || response === undefined || typeof response.text !== "function") return "";
				const text = await response.text();
				const parsed = parseMaybeJson(text);
				if (parsed !== null && typeof parsed === "object" && parsed.error !== null && typeof parsed.error === "object") {
					const code = typeof parsed.error.code === "string" ? parsed.error.code : "";
					const message = typeof parsed.error.message === "string" ? parsed.error.message : "";
					if (code !== "" && message !== "") return `${code}：${message}`;
					return code === "" ? message : code;
				}
				return typeof text === "string" ? text.slice(0, 200) : "";
			} catch (error) {
				return "";
			}
		}

		/**
		 * 图片区。取图走**两条腿**（参考实现 `shanliuling/dsh-image-gen` 用的就是路由那条）：
		 *   ① 宿主路由 `POST /plugins/dsh-runninghub-plugin/image`（body `{attachment}`）→ 二进制
		 *      → `blob` → `URL.createObjectURL`；
		 *   ② 聊天给的 `loadImage(attachment)`（`ToolCallCommonProps` 的 session-authorized loader）。
		 * 两条都失败才降级成文字。**卸载时 revoke** 自己建的 objectURL（防内存泄漏）。
		 *
		 * ⚠️ 不走 `tool.call.images` 子槽 —— 它已被内置 `read-image-toolview` 声明，
		 * 再声明一个会**加载期直接 throw**（catalog：a child slot is declared by exactly
		 * one entry）。所以这里自己加载、自己画，并限高免得撑爆聊天。
		 */
		function ToolImages(props) {
			const refs = Array.isArray(props.refs) ? props.refs : [];
			const loadImage = props.loadImage;
			const [urls, setUrls] = useState({});
			const [failures, setFailures] = useState({});
			// 依赖用"稳定字符串"：refs 每次渲染都是新数组，直接当依赖会自激
			const refKey = refs.map((ref) => String(ref.attachmentId)).join("|");
			useEffect(() => {
				let alive = true;
				/** 自己 createObjectURL 出来的 URL，卸载时要 revoke。 */
				const createdUrls = [];

				/** 取一张图：先宿主路由，再聊天 loader。 */
				const loadOne = async (ref) => {
					let routeError = "";
					const canFetch = typeof fetch === "function";
					const canBlob = typeof URL !== "undefined" && URL !== null && typeof URL.createObjectURL === "function";
					if (canFetch && canBlob) {
						try {
							const response = await fetch(IMAGE_ROUTE, {
								method: "POST",
								credentials: "same-origin",
								headers: { "content-type": "application/json" },
								// ⚠️ **整个 attachment 原样透传**，一个字段都不能少：
								// 宿主 `readImage` 会拿引用与磁盘图片元数据**逐字段比对**
								// （mediaType / bytes / width / height），缺一个就报
								// "Stored attachment metadata does not match its reference."。
								// （曾经"精简"成只有 attachmentId+mediaType，真机直接 404/400。）
								// 宿主侧会白名单重建引用，多余字段会被丢弃，所以透传是安全的。
								body: JSON.stringify({ attachment: ref }),
							});
							if (response === null || response === undefined || response.ok !== true) {
								const status = response === null || response === undefined ? "无响应" : response.status;
								// 把宿主说清的错误码与原因一起带出来（例如缺了哪些字段）
								const detail = await readRouteErrorDetail(response);
								throw new Error(detail === "" ? `HTTP ${status}` : `HTTP ${status}：${detail}`);
							}
							const blob = await response.blob();
							const url = URL.createObjectURL(blob);
							createdUrls.push(url);
							return url;
						} catch (error) {
							routeError = describeError(error);
						}
					} else {
						routeError = canFetch ? "环境没有 URL.createObjectURL" : "环境没有 fetch";
					}
					if (typeof loadImage === "function") {
						try {
							const url = await loadImage(ref);
							if (typeof url === "string" && url !== "") return url;
							throw new Error("loadImage 返回了空 URL");
						} catch (error) {
							throw new Error(`图片路由失败（${routeError}）；loadImage 也失败：${describeError(error)}`);
						}
					}
					throw new Error(`图片路由失败（${routeError}）`);
				};

				if (refKey === "") {
					return () => {
						alive = false;
					};
				}
				for (const ref of refs) {
					const key = String(ref.attachmentId);
					loadOne(ref).then(
						(url) => {
							if (alive) setUrls((current) => Object.assign({}, current, { [key]: url }));
						},
						(error) => {
							if (alive) setFailures((current) => Object.assign({}, current, { [key]: describeError(error) }));
						},
					);
				}
				return () => {
					alive = false;
					for (const url of createdUrls) {
						try {
							URL.revokeObjectURL(url);
						} catch (error) {
							/* revoke 失败不影响卸载 */
						}
					}
				};
			}, [refKey, loadImage]);
			if (refs.length === 0) return null;
			return h(
				"div",
				{ className: "rh-tool-images", "data-rh-tool-images": "" },
				refs.map((ref) => {
					const key = String(ref.attachmentId);
					const url = urls[key];
					if (typeof url === "string" && url !== "") {
						return h(
							"a",
							{ key: key, href: url, target: "_blank", rel: "noreferrer", className: "rh-tool-image-link" },
							h("img", {
								className: "rh-tool-image",
								src: url,
								alt: typeof ref.name === "string" && ref.name !== "" ? ref.name : "结果图",
								"data-rh-tool-image": "",
								loading: "lazy",
							}),
						);
					}
					if (typeof failures[key] === "string") {
						return h("span", { key: key, className: "rh-error-text", "data-rh-tool-image-error": "" }, `图片加载失败：${failures[key]}`);
					}
					return h("span", { key: key, className: "rh-dim" }, "图片加载中…");
				}),
			);

		}

		/** 工具卡片内部的行内 ErrorBoundary：崩了只降级这一行，绝不白屏整条聊天。 */
		class ToolRowBoundary extends BaseComponent {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error: error };
			}
			componentDidCatch(error, info) {
				// 记进有界错误收集器：面板上能看到，用户截图带得走
				recordClientError("toolview", error);
				log.warn("工具卡片渲染异常，已降级：", describeError(error), info);
			}
			render() {
				if (this.state.error !== null && this.state.error !== undefined) {
					const fallback = typeof this.props.fallback === "string" ? this.props.fallback : "";
					return h(
						"div",
						{ className: "rh-tool rh-tool-fallback", "data-dsh-runninghub": "", "data-rh-tool-fallback": "" },
						h("p", { className: "rh-error-text" }, `RunningHub 卡片渲染失败，已降级为纯文本：${describeError(this.state.error)}`),
						fallback === "" ? null : h("pre", { className: "rh-tool-text" }, fallback),
					);
				}
				return h("div", { "data-dsh-runninghub": "" }, this.props.children);
			}
		}

		/**
		 * 本地文件区：每个条目可点击，交给宿主的 `openFile(path)` 在 DSH 里打开。
		 *
		 * 标签只放**文件名**、完整路径放 `title` —— 否则长路径会把卡片撑得很宽。
		 * `openFile` 是 owner prop（`ToolCallCommonProps`），可能缺失（老版本/异常组合）→
		 * 缺失时退化成不可点的 `<code>`，仍然能看到路径。
		 */
		function ToolFiles(props) {
			const files = Array.isArray(props.files) ? props.files : [];
			const openFile = props.openFile;
			if (files.length === 0) return null;
			return h(
				"div",
				{ className: "rh-tool-files", "data-rh-tool-files": "" },
				h("span", { className: "rh-dim" }, "本地文件："),
				files.map((file) =>
					typeof openFile === "function"
						? h(
								"button",
								{
									key: file.path,
									type: "button",
									className: "rh-tool-file",
									title: file.path,
									"data-rh-tool-file": file.path,
									onClick: () => {
										try {
											// 传**完整绝对路径**（宿主的 openFile 按路径打开）
											openFile(file.path);
										} catch (error) {
											recordClientError("openFile", error);
										}
									},
								},
								file.name,
							)
						: h("code", { key: file.path, className: "rh-tool-file-static", title: file.path, "data-rh-tool-file": file.path }, file.name),
				),
			);
		}

		/** 卡片头：`runninghub_call · workflow.run · 完成`。 */
		function toolHeader(view) {
			const tone = view.state === "error" ? "error" : view.state === "ok" ? "ok" : "info";
			return h(
				"div",
				{ className: "rh-tool-head" },
				h("span", { className: "rh-tool-name" }, view.toolName === "" ? "runninghub" : view.toolName),
				view.action === "" ? null : h("code", { className: "rh-tool-action" }, view.action),
				h(Badge, { tone: tone }, view.stateLabel),
			);
		}

		/** 工具卡片的实际内容（可能抛 —— 外面套了 ToolRowBoundary）。 */
		function RunningHubCallRowInner(props) {
			const phase = props !== null && props !== undefined && typeof props.phase === "string" ? props.phase : "preparing";
			const view = toolCallView(phase, props !== null && props !== undefined ? props.block : null);
			if (!view.settled) {
				return h(
					"div",
					{ className: "rh-tool", "data-rh-tool": "", "data-rh-tool-phase": phase },
					toolHeader(view),
					h("p", { className: "rh-dim" }, phase === "preparing" ? "正在准备参数…" : "正在执行（任务已提交或排队中）…"),
				);
			}
			return h(
				"div",
				{ className: "rh-tool", "data-rh-tool": "", "data-rh-tool-phase": phase, "data-rh-tool-state": view.state },
				toolHeader(view),
				h(ToolImages, { refs: view.refs, loadImage: props.loadImage }),
				// 展示顺序：本地文件 → 远端 URL（旧回执）→ 什么都不显示。
				view.localFiles.length > 0
					? h(ToolFiles, { files: view.localFiles, openFile: props.openFile })
					: view.links.length === 0
						? null
						: h(
								"div",
								{ className: "rh-tool-links", "data-rh-tool-links": "" },
								h("span", { className: "rh-dim" }, "结果链接："),
								view.links.map((url) => h("a", { key: url, href: url, target: "_blank", rel: "noreferrer" }, url)),
							),
				h(
					"details",
					{ className: "rh-tool-details", open: view.text !== "" && view.refs.length === 0 },
					h("summary", null, view.text === "" ? "（无回执文本）" : `回执文本（${view.text.split("\n").length} 行）`),
					h("pre", { className: "rh-tool-text", "data-rh-tool-text": "" }, view.text),
				),
			);
		}

		/**
		 * 聊天里的 RunningHub 工具卡片（注册到 keyed 槽 `tool.call.toolview`，key = 工具名）。
		 * 自带 ErrorBoundary + 纯文本兜底：崩了也只影响这一行。
		 */
		function RunningHubCallRow(props) {
			const safeProps = props !== null && props !== undefined ? props : {};
			return h(ToolRowBoundary, { fallback: safeResultText(safeProps.block) }, h(RunningHubCallRowInner, safeProps));
		}

		/** 注册工具卡片；`tool.call.toolview` 不可用时只 warn（聊天里退回通用行）。 */
		function registerToolViews(scope) {
			const slots = safeGet(scope, "slots");
			if (slots === null || slots === undefined || typeof slots.inject !== "function" || typeof slots.register !== "function") {
				log.warn("slots 不可用，RunningHub 工具卡片未注册（聊天里显示通用行）");
				return null;
			}
			// generator 形态（与内置 searchToolview 一致）：一次注册多个 key，
			// 每个 register 的 disposer 都由宿主正确接管。
			// ⚠️ **不要**传 `children`：`tool.call.images` 已被内置 read-image-toolview 声明，
			//    再声明一个会在加载期直接 throw。
			return slots.inject("tool.call.toolview", function* () {
				yield slots.register({ name: "tool.call.toolview", key: "runninghub_call" }, RunningHubCallRow);
				yield slots.register({ name: "tool.call.toolview", key: "runninghub_search" }, RunningHubCallRow);
			});
		}

		// ------------------------------------------------------------------
		// 5. 插件面
		// ------------------------------------------------------------------

		/** 插件名（= 包名 = ModuleLoader id = bundle id）。 */
		const name = PKG;

		/**
		 * 客户端服务依赖 —— **必须是硬声明**（这是真机"$mount 成功但命名空间永不出现"的根因）。
		 *
		 * Cordis 里 `inject` 决定哪些服务被**真正绑进这个插件的 ctx**：
		 *   - `remote`：通道本体。`$mount` 内部是
		 *     `const callerCtx = this.ctx; … callerCtx.effect(…)` 与
		 *     `callerCtx.typert.remotes.register(contribution)` —— 都要求 `remote` 在作用域里。
		 *     不声明时 `ctx.remote` 只是一个"半可用"的引用，`mountContribution` 里抛的错
		 *     又被 `$mount` 的 `await owned`（await 一个函数）吞掉 → 现象就是
		 *     "$mount 成功 + 注入超时 + 宿主 clientCalls=0"。
		 *   - `slots`：注册 `plugins.bundle.config` 用。
		 * 生产可用的 `dsh-mcp-panel` 也是硬声明 `["slots","locale","remote","sessions"]`。
		 *
		 * 只声明我们真正用的两个：不抄 `locale` / `sessions`（界面全中文、不碰会话），
		 * 少一个硬依赖就少一个"某个组合里激活不了"的风险。
		 *
		 * 注意：声明成硬依赖后，下面的 `safeGet` / try-catch **全部保留** ——
		 * 那是防组合异常的，删了反而更脆。
		 */
		const inject = ["remote", "slots"];

		/**
		 * 注册到 `plugins.bundle.config` —— **本插件自己的「插件页面」**。
		 *
		 * 契约（DSH 运行时 slot 目录 + `ui-plugin-manager` README「Configuration pages」）：
		 *   - 槽名 `plugins.bundle.config`，kind `keyed`，scope `root`；
		 *   - 唯一文档化注册项是 `key`（required），**按 bundle 的 package name 派发** ——
		 *     写成 `id`、或写成 `runninghub` 都不会报错，只是**永远不渲染**；
		 *   - ownerProps `{ view: 'summary' | 'page', form? }`；页面画标题/图标/面包屑，
		 *     我们只在 `page` 态画状态条 + 各折叠区；
		 *   - 只注册**我们自己这个 key**（该槽 `replaceRisk: shadows-shipped-ui`）。
		 *
		 * `slots.register` 本身就是一个 `ctx.effect`，不要再包一层。
		 */
		const BUNDLE_CONFIG_SLOT = "plugins.bundle.config";

		/** 注册本插件的页面配置区；slots 不可用时只 warn，绝不抛。 */
		function registerBundleConfig(scope, api) {
			const slots = safeGet(scope, "slots");
			if (slots === null || slots === undefined || typeof slots.inject !== "function" || typeof slots.register !== "function") {
				log.warn(`${BUNDLE_CONFIG_SLOT} 不可用（slots 服务缺失），RunningHub 配置区未注册；插件其余功能不受影响`);
				return null;
			}
			return slots.inject(BUNDLE_CONFIG_SLOT, () =>
				slots.register({ name: BUNDLE_CONFIG_SLOT, key: PKG }, createBundleConfigComponent(api)),
			);
		}

		/** 等待一批客户端服务就绪再执行；服务已可用时立即执行。 */
		function whenAvailable(ctx, deps, callback) {
			const [first] = deps;
			if (safeGet(ctx, first) !== undefined) {
				callback(ctx);
				return;
			}
			if (typeof ctx.inject !== "function") {
				log.warn(`缺少服务 ${deps.join(",")} 且 ctx.inject 不可用，跳过`);
				return;
			}
			try {
				ctx.inject(deps, (scope) => {
					try {
						callback(scope);
					} catch (error) {
						log.warn("延迟注册失败：", describeError(error));
					}
				});
			} catch (error) {
				log.warn(`ctx.inject(${deps.join(",")}) 失败：`, describeError(error));
			}
		}

		/**
		 * 插件入口。每一步独立降级：**任何一步失败都只记 warn，绝不抛**——
		 * 插件加载失败会让整个工具面消失，UI 崩了更不能拖垮「插件」页面。
		 */
		async function apply(ctx) {
			// ① 样式表（styles.insert 优先，静态包走自有 <style>），随 fiber 卸载清理。
			try {
				ctx.effect(() => insertStyles(PANEL_CSS, ctx), `${PKG}: stylesheet`);
			} catch (error) {
				log.warn("样式注册失败：", describeError(error));
			}

			// ② 面板文案：按用户要求**全中文**（没有 en/zh 双语需求），
			//    所以不再注册 locale 字典 —— 之前那份字典只服务于已移除的 tab 标题。

			// ③ 建 api，并把 Remote 就绪门踢起来（**不阻塞**页面注册）：
			//    $mount → ctx.inject(['remote.runninghub']) → 有界等待注入完成。
			//    ⚠️ mount 只能有一处：api-remotes 对同一份描述符重复 $mount 会以
			//       "is already mounted" 拒绝，所以 apply() 不再自己 mount，
			//       统一交给按 ctx 缓存的就绪门（`REMOTE_GATES`）。
			let api = null;
			try {
				api = createApi(ctx);
				api.ensureRemoteReady();
			} catch (error) {
				log.warn("api 初始化失败：", describeError(error));
			}

			// ⑤ 客户端运行期错误收集器（有界，最近 10 条）。
			//    `$mount` 会吞掉 mountContribution 的异常（`await owned` 是 await 一个函数），
			//    浏览器 console 用户看不到也传不出来 —— 这两个全局钩子是唯一的出口。
			//    收集器自己全程 try/catch，绝不把面板搞崩。
			try {
				ctx.effect(() => installErrorCollector(), `${PKG}: error collector`);
			} catch (error) {
				log.warn("错误收集器安装失败：", describeError(error));
			}

			// ④ 注册本插件自己的「插件页面」配置区（`plugins.bundle.config`）
			//    与聊天里的工具卡片（`tool.call.toolview`）。
			try {
				whenAvailable(ctx, ["slots"], (scope) => {
					registerBundleConfig(scope, api);
					registerToolViews(scope);
				});
			} catch (error) {
				log.warn(`${BUNDLE_CONFIG_SLOT} 注册失败：`, describeError(error));
			}
		}

		// ------------------------------------------------------------------
		// 导出（同时给测试用）
		// ------------------------------------------------------------------

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;

		/** 纯逻辑导出：tests/client 直接断言这些函数与组件。 */
		exports.toggleExpanded = toggleExpanded;
		exports.expandedIdOf = expandedIdOf;
		exports.groupNodes = groupNodes;
		exports.roleGroup = roleGroup;
		exports.roleLabel = roleLabel;
		exports.summarizeWorkflow = summarizeWorkflow;
		exports.optimizerText = optimizerText;
		exports.outputKindLabel = outputKindLabel;
		exports.regionLabel = regionLabel;
		exports.poolText = poolText;
		exports.cooldownText = cooldownText;
		exports.keyStateLabel = keyStateLabel;
		exports.taskState = taskState;
		exports.parseOptionsText = parseOptionsText;
		exports.normalizeOptions = normalizeOptions;
		exports.OptionsEditor = OptionsEditor;
		exports.parseLimitInput = parseLimitInput;
		exports.tasksLimitInfo = tasksLimitInfo;
		exports.optionsToText = optionsToText;
		exports.patchNode = patchNode;
		exports.rangeText = rangeText;
		exports.defaultValueText = defaultValueText;
		exports.nodeDefaultValue = nodeDefaultValue;
		exports.bytesText = bytesText;
		exports.balanceText = balanceText;
		exports.probeSummaryText = probeSummaryText;
		exports.describeError = describeError;
		exports.createApi = createApi;
		exports.buildDescriptors = buildDescriptors;
		exports.DESCRIPTORS = DESCRIPTORS;
		exports.API_METHODS = API_METHODS;
		exports.PANEL_CSS = PANEL_CSS;
		exports.ROOT_ATTR = ROOT_ATTR;
		exports.insertStyles = insertStyles;
		exports.isAlreadyMountedError = isAlreadyMountedError;
		exports.installErrorCollector = installErrorCollector;
		exports.probeNamespace = probeNamespace;
		exports.describeChannelError = describeChannelError;
		exports.BUNDLE_CONFIG_SLOT = BUNDLE_CONFIG_SLOT;
		exports.summaryLine = summaryLine;
		exports.createBundleConfigComponent = createBundleConfigComponent;
		exports.registerBundleConfig = registerBundleConfig;
		exports.registerToolViews = registerToolViews;
		exports.toolCallView = toolCallView;
		exports.safeResultText = safeResultText;
		exports.findLinks = findLinks;
		exports.extractLocalFiles = extractLocalFiles;
		exports.LOCAL_FILE_LINE = LOCAL_FILE_LINE;
		exports.NodeFieldInput = NodeFieldInput;
		exports.supportsDatalist = supportsDatalist;
		/** 组件导出（测试里用桩 React 直接渲染）。 */
		exports.components = {
			RunningHubPanel: RunningHubPanel,
			RunningHubPanelRoot: RunningHubPanelRoot,
			RunningHubBundleConfig: createBundleConfigComponent(null),
			RunningHubSummary: RunningHubSummary,
			RunningHubCallRow: RunningHubCallRow,
			ToolImages: ToolImages,
			ToolFiles: ToolFiles,
			ToolRowBoundary: ToolRowBoundary,
			PanelBoundary: PanelBoundary,
			StatusBar: StatusBar,
			KeySection: KeySection,
			WorkflowSection: WorkflowSection,
			WorkflowDetail: WorkflowDetail,
			DocSection: DocSection,
			TaskSection: TaskSection,
			Section: Section,
			NodeGroups: NodeGroups,
			NodeFieldInput: NodeFieldInput,
			OptionsEditor: OptionsEditor,
			TasksLimitBar: TasksLimitBar,
			TaskSection: TaskSection,
			SectionBoundary: SectionBoundary,
		};

		return module.exports;

	},
});
