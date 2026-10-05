/**
 * tests/client/harness.mjs —— 浏览器半边的最小测试台。
 *
 * 目标：**不装任何第三方包**（无 jsdom、无 React），把 `client/client.js`
 * 当成浏览器里的真实产物跑起来：
 *   1. `createTestReact()` —— 极简 React 桩 + 一个够用的协调器
 *      （按路径保存 hooks，支持 useState/useEffect/useMemo/useRef/类组件），
 *      这样就能真的渲染组件、真的点按钮、真的断言展开行为。
 *   2. `loadClientModule()` —— 用 `new Function` 执行 client.js（它不是模块，
 *      而是 `window.__ModuleLoader__.load({id, factory})` 调用），拿回 factory 的导出。
 *   3. `createStubCtx()` —— apply(ctx) 用的桩 ctx：get/on/provide/effect/inject
 *      + 假的 slots / remote / locale / sessions。
 *
 * 只读 client/client.js，不写任何东西。
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
/** 被测产物的绝对路径。 */
export const CLIENT_PATH = join(HERE, "..", "..", "client", "client.js");

const ELEMENT = Symbol.for("dsh-runninghub.test.element");

/**
 * 造一个 React 桩：`createElement` + `Fragment` + `Component` + 可用的 hooks。
 * hooks 由内部的迷你协调器在渲染时挂上来。
 */
export function createTestReact() {
	const stores = new Map(); // path -> { hooks: [], index: 0 }
	const classes = new Map(); // path -> class instance
	let current = null; // 当前渲染中的 hooks store
	let dirty = false;
	let rootElement = null;
	let lastTree = null;
	const pendingEffects = [];

	const Fragment = Symbol.for("dsh-runninghub.test.fragment");

	function createElement(type, props, ...children) {
		const normalized = {};
		let key = null;
		if (props !== null && props !== undefined) {
			for (const name of Object.keys(props)) {
				if (name === "key") key = props[name];
				else if (name !== "ref") normalized[name] = props[name];
			}
		}
		normalized.children = children.length === 0 ? undefined : children.length === 1 ? children[0] : children;
		return { $$typeof: ELEMENT, type, key: key === null || key === undefined ? null : String(key), props: normalized };
	}

	class Component {
		constructor(props) {
			this.props = props;
			this.state = {};
		}
		setState(next) {
			this.state = Object.assign({}, this.state, typeof next === "function" ? next(this.state) : next);
			dirty = true;
		}
	}

	const React = { createElement, Fragment, Component };

	function storeOf(path) {
		let store = stores.get(path);
		if (store === undefined) {
			store = { hooks: [], index: 0 };
			stores.set(path, store);
		}
		return store;
	}

	// ---- hooks（必须在 current 指向渲染中的 store 时调用） ----

	React.useState = (initial) => {
		const store = current;
		const index = store.index++;
		if (!(index in store.hooks)) store.hooks[index] = typeof initial === "function" ? initial() : initial;
		const setState = (next) => {
			const previous = store.hooks[index];
			const value = typeof next === "function" ? next(previous) : next;
			if (Object.is(previous, value)) return;
			store.hooks[index] = value;
			dirty = true;
		};
		return [store.hooks[index], setState];
	};
	React.useRef = (initial) => {
		const store = current;
		const index = store.index++;
		if (!(index in store.hooks)) store.hooks[index] = { current: initial };
		return store.hooks[index];
	};
	React.useMemo = (factory, deps) => {
		const store = current;
		const index = store.index++;
		const previous = store.hooks[index];
		if (previous === undefined || depsChanged(previous.deps, deps)) store.hooks[index] = { deps, value: factory() };
		return store.hooks[index].value;
	};
	React.useCallback = (fn, deps) => React.useMemo(() => fn, deps);
	React.useEffect = (effect, deps) => {
		const store = current;
		const index = store.index++;
		const previous = store.hooks[index];
		if (previous === undefined || depsChanged(previous.deps, deps)) pendingEffects.push({ store, index, deps, effect });
	};

	function depsChanged(previous, next) {
		if (previous === undefined || next === undefined) return true;
		if (previous.length !== next.length) return true;
		return previous.some((value, index) => !Object.is(value, next[index]));
	}

	// ---- 协调器 ----

	function renderChildren(children, path) {
		const out = [];
		let index = 0;
		// 真实 React 会把嵌套数组/条件子节点拍平，这里必须同样处理。
		const walkChildren = (value) => {
			if (value === null || value === undefined || typeof value === "boolean") return;
			if (Array.isArray(value)) {
				for (const item of value) walkChildren(item);
				return;
			}
			const segment = typeof value === "object" && value.key !== null && value.key !== undefined ? `k:${value.key}` : `i:${index}`;
			index += 1;
			const rendered = renderNode(value, `${path}/${segment}`);
			if (rendered !== null) out.push(rendered);
		};
		walkChildren(children);
		return out;
	}

	function renderNode(element, path) {
		if (element === null || element === undefined || typeof element === "boolean") return null;
		if (typeof element === "string" || typeof element === "number") return { kind: "text", text: String(element), path };
		const type = element.type;
		const props = element.props || {};
		if (type === Fragment) return { kind: "fragment", path, children: renderChildren(props.children, path) };
		if (typeof type === "function") {
			if (typeof type.prototype?.render === "function") {
				let instance = classes.get(path);
				if (instance === undefined) {
					instance = new type(props);
					instance.setState = (next) => {
						instance.state = Object.assign({}, instance.state, typeof next === "function" ? next(instance.state) : next);
						dirty = true;
					};
					classes.set(path, instance);
				}
				instance.props = props;
				const savedForClass = current;
				current = null;
				try {
					return renderNode(instance.render(), `${path}/out`);
				} catch (error) {
					// 迷你版错误边界：getDerivedStateFromError + 重渲染
					if (typeof type.getDerivedStateFromError !== "function") throw error;
					instance.state = Object.assign({}, instance.state, type.getDerivedStateFromError(error) || {});
					if (typeof instance.componentDidCatch === "function") instance.componentDidCatch(error, { componentStack: "" });
					return renderNode(instance.render(), `${path}/out`);
				} finally {
					current = savedForClass;
				}
			}
			const store = storeOf(path);
			const saved = current;
			current = store;
			store.index = 0;
			let output;
			try {
				output = type(props);
			} finally {
				current = saved;
			}
			return renderNode(output, `${path}/out`);
		}
		if (typeof type === "string") return { kind: "host", type, props, path, children: renderChildren(props.children, path) };
		return null;
	}

	function runEffects() {
		const queue = pendingEffects.splice(0, pendingEffects.length);
		for (const entry of queue) {
			entry.store.hooks[entry.index]?.dispose?.();
			const dispose = entry.effect();
			entry.store.hooks[entry.index] = { deps: entry.deps, dispose };
		}
	}

	function render(element) {
		rootElement = element;
		dirty = false;
		lastTree = renderNode(element, "root");
		runEffects();
		return lastTree;
	}

	// 把迷你协调器直接挂在 React 桩上：测试里既当 React 用，也当渲染器用。
	React.render = render;
	React.rerender = () => render(rootElement);
	React.reset = () => {
		stores.clear();
		classes.clear();
		pendingEffects.length = 0;
	};
	/** 卸载：跑掉所有 effect 的清理函数（验证 revokeObjectURL 这类收尾）。 */
	React.unmount = () => {
		for (const store of stores.values()) {
			for (const slot of store.hooks) {
				if (slot !== null && typeof slot === "object" && typeof slot.dispose === "function") {
					try {
						slot.dispose();
					} catch (error) {
						/* 清理失败不影响测试 */
					}
				}
			}
		}
		rootElement = null;
		lastTree = null;
	};
	Object.defineProperty(React, "tree", {
		get: () => lastTree,
	});
	Object.defineProperty(React, "dirty", {
		get: () => dirty,
	});
	return React;
}

/** 收集树里所有宿主节点。 */
export function hosts(tree, predicate) {
	const out = [];
	const walk = (node) => {
		if (node === null || node === undefined) return;
		if (node.kind === "host") {
			if (predicate === undefined || predicate(node)) out.push(node);
			for (const child of node.children) walk(child);
			return;
		}
		if (node.kind === "fragment") {
			for (const child of node.children) walk(child);
		}
	};
	walk(tree);
	return out;
}

/** 按属性名找第一个宿主节点（属性存在即算命中）。 */
export function byAttr(tree, attribute) {
	return hosts(tree, (node) => node.props[attribute] !== undefined)[0] ?? null;
}

/** 收集整棵树的文本。 */
export function textOf(tree) {
	let out = "";
	const walk = (node) => {
		if (node === null || node === undefined) return;
		if (node.kind === "text") {
			out += node.text;
			return;
		}
		if (node.children) for (const child of node.children) walk(child);
	};
	walk(tree);
	return out;
}

/** 触发一个宿主节点的 onClick。 */
export function click(node) {
	if (node === null) throw new Error("click(): 节点不存在");
	if (typeof node.props.onClick !== "function") throw new Error(`click(): ${node.type} 没有 onClick`);
	node.props.onClick({ target: node, currentTarget: node, preventDefault() {}, stopPropagation() {} });
}

/**
 * 执行 client.js，拿回 factory 的导出。
 * @returns {{ exports: object, registrations: object[], document: object, console: object, react: object }}
 */
export function loadClientModule(options = {}) {
	const react = options.react ?? createTestReact();
	const registrations = [];
	const styleElements = [];
	const head = {
		children: styleElements,
		appendChild(element) {
			styleElements.push(element);
			element.isConnected = true;
			return element;
		},
		append(element) {
			return this.appendChild(element);
		},
	};
	const documentListeners = new Map();
	const documentStub = {
		hidden: false,
		addEventListener(type, listener) {
			if (!documentListeners.has(type)) documentListeners.set(type, new Set());
			documentListeners.get(type).add(listener);
		},
		removeEventListener(type, listener) {
			documentListeners.get(type)?.delete(listener);
		},
		head,
		documentElement: head,
		createElement(tag) {
			return {
				tagName: String(tag).toUpperCase(),
				attributes: {},
				dataset: {},
				style: {},
				children: [],
				textContent: "",
				isConnected: false,
				setAttribute(name, value) {
					this.attributes[name] = value;
				},
				remove() {
					this.isConnected = false;
					const index = styleElements.indexOf(this);
					if (index >= 0) styleElements.splice(index, 1);
				},
			};
		},
		querySelector() {
			return null;
		},
	};
	const listeners = new Map(); // type -> Set<listener>
	const windowStub = {
		__ModuleLoader__: {
			load(registration) {
				registrations.push(registration);
			},
		},
		// 真浏览器有事件系统：错误收集器要挂 unhandledrejection / error
		addEventListener(type, listener) {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type).add(listener);
		},
		removeEventListener(type, listener) {
			const set = listeners.get(type);
			if (set !== undefined) set.delete(listener);
		},
		// 现代浏览器都有它；`supportsDatalist()` 正是读这个做特性检测。
		// 测试传 `windowExtras: { HTMLDataListElement: undefined }` 可模拟"不支持 datalist"。
		HTMLDataListElement: function HTMLDataListElement() {},
		...(options.windowExtras ?? {}),
	};
	/** 测试里手动派发 window 事件（模拟"没人接收的 Promise 拒绝"）。 */
	const emitWindowEvent = (type, event) => {
		for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
	};
	const logs = [];
	const consoleStub = {
		log: (...args) => logs.push(["log", ...args]),
		warn: (...args) => logs.push(["warn", ...args]),
		error: (...args) => logs.push(["error", ...args]),
	};
	const requireStub = (specifier) => {
		if (specifier === "react") return react;
		if (specifier === "react/jsx-runtime") {
			return {
				jsx: (type, props) => react.createElement(type, props),
				jsxs: (type, props) => react.createElement(type, props),
				Fragment: react.Fragment,
			};
		}
		throw new Error(`client-modules: require("${specifier}") missed the module table`);
	};
	const source = readFileSync(CLIENT_PATH, "utf8");
	// client.js 不是模块：它自己调用 window.__ModuleLoader__.load(...)。
	// `URL` 也作为参数注入，便于测试 objectURL（真浏览器里自然就是全局 URL）。
	const run = new Function("window", "document", "console", "fetch", "styles", "URL", source);
	run(windowStub, documentStub, consoleStub, options.fetch, options.styles, options.URL ?? createUrlStub());
	if (registrations.length !== 1) throw new Error(`期望恰好 1 次 __ModuleLoader__.load，实际 ${registrations.length}`);
	const registration = registrations[0];
	return {
		registration,
		exports: registration.factory(requireStub),
		document: documentStub,
		styleElements,
		console: consoleStub,
		logs,
		react,
		emitDocumentEvent: (type) => { for (const listener of documentListeners.get(type) || []) listener(); },
		require: requireStub,
		emitWindowEvent,
		listeners,
	};
}

/**
 * 让挂起的 promise / 微任务落地（fire-and-forget 的 $mount → inject 链需要它）。
 * @returns {Promise<void>}
 */
export function flushAsync() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 最小 `URL` 桩：记录 createObjectURL / revokeObjectURL，供测试断言。 */
export function createUrlStub() {
	let counter = 0;
	const created = [];
	const revoked = [];
	return {
		createObjectURL(blob) {
			counter += 1;
			const url = `blob:runninghub-${counter}`;
			created.push({ url, blob });
			return url;
		},
		revokeObjectURL(url) {
			revoked.push(url);
		},
		_created: created,
		_revoked: revoked,
	};
}

/**
 * apply(ctx) 用的桩 ctx。**如实模拟 Cordis 的注入规则**（这是本文件最重要的一条）：
 *
 *   - `ctx.get('remote')` → 返回带 `$mount` 的 remote 服务（**不抛**）。
 *   - 在非注入作用域读 `remote.runninghub`（命名空间服务）→ **抛**
 *     `cannot get property "remote.runninghub" without inject`。
 *     （真机就是这么抛的：client 曾因此在 `$mount` 之前判死整条 Remote 通道。）
 *   - `ctx.inject(['remote.runninghub'], cb)` → **异步**回调（`injectDelayMs` 之后），
 *     `scope.remote.runninghub` 才是可用对象。
 *     ⚠️ 必须异步：真机上注入要等命名空间真正出现，面板首屏几乎必然跑在它之前。
 *     桩若同步回调，就永远测不出"首屏没等 Remote → 掉 HTTP → 405"那个竞态。
 *   - `$mount` 在**没有 remoteNamespace**、或给了 `mountError` 时 **reject**
 *     （真机上命名空间没挂上就是这个表现），用来分别覆盖两条失败分支。
 *
 * 桩比被测代码宽松 = 测试在骗自己。所以这里宁可抛，也不给"随便读"的便利。
 *
 * @param {object} [overrides] `{ ctx, remoteNamespace, namespace, services, injectDelayMs, mountError }`
 * @returns 带 `_effects` / `_registered` / `_mounted` / `_remoteNamespaceReads` 记账字段的 ctx。
 */
export function createStubCtx(overrides = {}) {
	const namespaceName = overrides.namespace ?? "runninghub";
	const injectDelayMs = overrides.injectDelayMs ?? 0; // 0 = 下一个宏任务（仍然是异步的）
	const mountError = overrides.mountError ?? null;
	/** true = mount 成功但注入**永不**到来（覆盖"等满上限"分支）。 */
	const injectNeverArrives = overrides.injectNeverArrives === true;
	/**
	 * 真机那个致命形态：`$mount` **静默失败** —— 它 resolve（api-gateway 的
	 * `await owned` 是 await 一个函数，把 mountContribution 的异常全吞了），
	 * 但命名空间根本没建出来。用副作用探测才能发现。
	 */
	const mountSwallowsError = overrides.mountSwallowsError ?? null;
	/** 是否声明了 inject: ["remote"]（没声明 → $mount 必然静默失败，见下）。 */
	const remoteDeclared =
		overrides.declared === undefined || overrides.declared === null || overrides.declared.includes("remote");
	const effects = [];
	const registered = [];
	const mounted = [];
	const services = Object.assign({}, overrides.services);
	let namespaceService = overrides.remoteNamespace ?? null;
	let mountedOnce = false;
	const pendingInjections = [];

	/** 注入作用域：只有这里的 `remote.<ns>` 才可读。 */
	function makeScope() {
		const scope = Object.create(ctx);
		scope.remote = {
			$mount: (contribution) => rawRemote.$mount(contribution),
			[namespaceName]: namespaceService,
		};
		return scope;
	}

	/** 异步唤醒等待命名空间的注入回调（真机注入就是异步的）。 */
	function flushInjections() {
		if (namespaceService === null || injectNeverArrives) return;
		const queue = pendingInjections.splice(0, pendingInjections.length);
		for (const callback of queue) fireInjection(callback);
	}

	/** 注入回调真正被调用的那一刻（测试用来观察"竞态窗口"）。 */
	function fireInjection(callback) {
		setTimeout(() => {
			ctx._injectionsFired += 1;
			callback(makeScope());
		}, injectDelayMs);
	}

	const ctx = {
		_effects: effects,
		_registered: registered,
		_mounted: mounted,
		/** 非注入作用域读 `remote.runninghub` 的**次数**（回归断言用，必须是 0）。 */
		_remoteNamespaceReads: 0,
		/** 读了"未 inject 的服务属性"的次数（声明式 inject 的护栏用）。 */
		_undeclaredReads: 0,
		/** 读了哪些未声明的服务属性（诊断用）。 */
		_undeclaredProps: [],
		/** 注入回调**真正触发**过几次（观察竞态窗口用）。 */
		_injectionsFired: 0,
		/** $mount 在"没声明 remote"的情况下被调用过几次（inject 漏声明的铁证）。 */
		_mountWithoutInject: 0,
		_slotInjectKey: null,
		/** 所有被 inject 过的槽名（面板 + 工具卡片）。 */
		_slotInjectKeys: [],
		/** generator 形态 inject 回调 yield 出来的 disposer。 */
		_yieldedDisposers: [],
		get(key) {
			// `ctx.get("remote.<ns>")` 是**官方存在性探测**（可选读，不抛）：
			// api-gateway 的 validateContribution 自己也用它判"命名空间是否已存在"。
			// ⚠️ 但**挂载成功之前它必须不存在** —— 否则就测不出"mount 失败/竞态"。
			if (key === `remote.${namespaceName}`) return mountedOnce && namespaceService !== null ? namespaceService : undefined;
			return services[key];
		},
		on() {
			return () => {};
		},
		provide() {
			return () => {};
		},
		effect(callback, label) {
			const dispose = callback();
			effects.push({ label, dispose });
			return () => {
				if (typeof dispose === "function") dispose();
			};
		},
		inject(deps, callback) {
			const list = Array.isArray(deps) ? deps : [deps];
			if (list.includes(`remote.${namespaceName}`)) {
				// 命名空间服务：只有 $mount 之后才可注入，而且**异步**触发
				if (injectNeverArrives) {
					// 故意不回调：模拟"命名空间始终没出现"
				} else if (mountedOnce && namespaceService !== null) {
					fireInjection(callback);
				} else {
					pendingInjections.push(callback);
				}
				return () => {};
			}
			callback(makeScope());
			return () => {};
		},
	};

	/** 真正的 remote 服务（$mount 的实体；命名空间由 Proxy 挡住）。 */
	const rawRemote = {
		async $mount(contribution) {
			// 真机语义：$mount 一定"被调用过"（先记账）
			mounted.push(contribution);
			if (mountError !== null) throw new Error(mountError);
			// ★ 没声明 inject: ["remote"] 时，$mount 内部的 callerCtx.effect / callerCtx.typert
			//   都拿不到服务 → mountContribution 抛错 → 被 $mount 吞掉 → **静默失败**，
			//   命名空间永远不出现。这就是真机那个 bug，桩必须能复现它。
			if (!remoteDeclared) {
				ctx._mountWithoutInject += 1;
				return async () => {};
			}
			if (mountSwallowsError !== null) {
				// 静默失败：内部异常被 $mount 吞掉，命名空间没建出来，但 $mount 正常 resolve
				return async () => {};
			}
			if (namespaceService === null) {
				throw new Error(`client api: remote namespace "${namespaceName}" could not be mounted (no host half)`);
			}
			mountedOnce = true;
			flushInjections();
			return async () => {};
		},
	};

	/**
	 * 命名空间只在这里被挡住：读 `remote.runninghub` → 抛。
	 * 注意 `$mount` 必须直接来自 target —— 若在 get 陷阱里再读一次 `remoteProxy.$mount`，
	 * 就会无限递归（真踩过：`Maximum call stack size exceeded`）。
	 */
	const remoteProxy = new Proxy(rawRemote, {
		get(target, property) {
			if (property === namespaceName) {
				ctx._remoteNamespaceReads += 1;
				throw new Error(`cannot get property "remote.${namespaceName}" without inject`);
			}
			return target[property];
		},
		has(target, property) {
			return property === namespaceName || property in target;
		},
	});

	services.slots = {
		inject(key, callback) {
			ctx._slotInjectKey = key;
			if (!ctx._slotInjectKeys.includes(key)) ctx._slotInjectKeys.push(key);
			const result = callback();
			// 宿主支持 generator 形态的 inject 回调（内置 searchToolview 就是那样写的）：
			// 把 yield 出来的 disposer 依次收下。
			if (result !== null && typeof result === "object" && typeof result.next === "function") {
				for (const yielded of result) ctx._yieldedDisposers.push(yielded);
				return () => {};
			}
			return result;
		},
		register(options, component) {
			registered.push({ options, component });
			return () => {};
		},
	};
	services.locale = {
		register() {
			return () => {};
		},
		bind() {
			return (key) => key;
		},
	};
	services.remote = remoteProxy;
	services.sessions = {};

	// 声明过 inject 之后，服务在 ctx 上直接可读（Cordis 就是这个语义）
	ctx.remote = remoteProxy;
	ctx.slots = services.slots;
	ctx.locale = services.locale;
	ctx.sessions = services.sessions;

	/** 运行时把命名空间服务接上（模拟宿主注册好了 Remote 命名空间）。 */
	ctx._provideRemoteNamespace = (service) => {
		namespaceService = service;
		mountedOnce = true;
		flushInjections();
	};
	/** 注入作用域里那份服务（测试里偶尔要直接用）。 */
	ctx._namespaceService = () => namespaceService;

	Object.assign(ctx, overrides.ctx);

	// ---- Cordis 注入语义（给 declared 才开启）----
	// 如实模拟：读一个"应用里有、但本作用域没声明"的服务属性 →
	// 抛 `cannot get property "x" without inject`。
	// 这正是真机 `remote.runninghub` 报错的同一种机制；桩不模拟它，
	// 就永远测不出"inject 忘了声明 remote"这类故障。
	if (overrides.declared === undefined || overrides.declared === null) return ctx;
	const declared = overrides.declared;
	const SERVICE_KEYS = new Set(["remote", "slots", "locale", "sessions"]);
	return new Proxy(ctx, {
		get(target, property, receiver) {
			if (typeof property === "string" && SERVICE_KEYS.has(property) && !declared.includes(property)) {
				ctx._undeclaredReads += 1;
				ctx._undeclaredProps.push(property);
				throw new Error(`cannot get property "${property}" without inject`);
			}
			return Reflect.get(target, property, receiver);
		},
	});
}
