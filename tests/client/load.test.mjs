/**
 * tests/client/load.test.mjs —— 加载 / 注册 / 通道适配层的验收测试。
 *
 * 覆盖：
 *   1. client.js 能被浏览器式加载（`window.__ModuleLoader__.load`），factory 可调用，
 *      导出含 name / inject / apply，并额外导出可测的纯逻辑。
 *   2. `apply(桩 ctx)` 不抛异常；样式用 `<style data-dsh-runninghub>` 注入并挂进 ctx.effect。
 *   3. 注册进 `settings.plugins.tab`：id / order / label thunk / inject() → 组件 props.api。
 *   4. Remote 贡献：package + 描述符形状（api-remotes 要求 codec.mode === 'strict'）。
 *   5. **Cordis 注入规则**：非注入作用域读 `remote.runninghub` 必须抛；面板必须只走注入作用域
 *      （这块是真机踩过的坑：读属性抛错 → Remote 通道被判死 → 面板顶部红字、状态栏全 `—`）。
 *   6. 通道优先级：Remote（真机主通道）→ HTTP（有 webServer 的组合兜底）→ 宿主服务直连。
 *   7. 健壮性：缺 slots / 缺 remote / api 为 null 时的降级，绝不抛、绝不白屏。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { loadClientModule, createStubCtx, createTestReact, createUrlStub, flushAsync, hosts, textOf, byAttr, click } from "./harness.mjs";

const PKG = "dsh-runninghub-plugin";

/** 记录 fetch 调用的桩。 */
function fetchStub(handler) {
	const calls = [];
	const stub = async (url, init) => {
		const body = JSON.parse(init.body);
		calls.push({ url, init, body });
		return handler(body, calls.length);
	};
	stub.calls = calls;
	return stub;
}

/** 取某个槽的注册项（每个槽必须恰好一条，否则直接失败）。 */
function registeredFor(ctx, slotName, key) {
	const list = ctx._registered.filter((entry) => entry.options.name === slotName && (key === undefined || entry.options.key === key));
	assert.equal(list.length, 1, `${slotName}${key === undefined ? "" : `#${key}`} 应恰好注册一条，实际 ${list.length}`);
	return list[0];
}

/** 快捷方式：本插件页面配置区的注册项。 */
function bundleConfigOf(ctx) {
	return registeredFor(ctx, "plugins.bundle.config");
}

/** fetch 回执：HTTP 一律 200，判据看 body。 */
function jsonResponse(body) {
	return {
		ok: true,
		status: 200,
		async text() {
			return JSON.stringify(body);
		},
	};
}

describe("client.js 加载", () => {
	test("注册 factory，id 是包名，factory 可调用", () => {
		const loaded = loadClientModule();
		assert.equal(loaded.registration.id, PKG);
		assert.equal(typeof loaded.registration.factory, "function");
	});

	test("导出 name / inject / apply", () => {
		const { exports } = loadClientModule();
		assert.equal(exports.name, PKG);
		assert.ok(Array.isArray(exports.inject), "inject 必须是数组");
		// ★ 硬声明：真机那次"$mount 成功但命名空间永不出现"就是 inject 漏了 remote。
		//   Cordis 只把**声明过**的服务绑进插件 ctx；不声明 → $mount 内部拿不到 callerCtx.typert。
		assert.ok(exports.inject.includes("remote"), "inject 必须声明 remote（通道本体）");
		assert.ok(exports.inject.includes("slots"), "inject 必须声明 slots（注册 plugins.bundle.config）");
		assert.deepEqual(exports.inject.slice().sort(), ["remote", "slots"], "只声明真正用到的两个，不抄 locale/sessions");
		assert.equal(typeof exports.apply, "function");
	});

	test("纯逻辑也被导出（供测试断言）", () => {
		const { exports } = loadClientModule();
		for (const key of ["toggleExpanded", "groupNodes", "summarizeWorkflow", "parseOptionsText", "patchNode", "poolText"]) {
			assert.equal(typeof exports[key], "function", `${key} 应被导出`);
		}
		assert.equal(typeof exports.components.WorkflowSection, "function");
	});
});

describe("apply(ctx)", () => {
	test("桩 ctx 上不抛，并且注册进 plugins.bundle.config（key = 包名）", async () => {
		const react = createTestReact();
		const { exports, styleElements } = loadClientModule({ react });
		// declared = 插件真实声明的 inject → 桩按 Cordis 语义只放行这两个服务
		const ctx = createStubCtx({ declared: exports.inject });
		await exports.apply(ctx);

		// 样式：自有 <style data-dsh-runninghub>，且挂进了 ctx.effect
		assert.equal(styleElements.length, 1, "应注入一个 <style>");
		assert.equal(styleElements[0].tagName, "STYLE");
		assert.ok("data-dsh-runninghub" in styleElements[0].attributes, "style 必须带 data-dsh-runninghub 标记");
		assert.ok(ctx._effects.some((entry) => entry.label.includes("stylesheet")), "样式必须在 ctx.effect 里注册");

		// slot 注册：本插件自己的「插件页面」配置区
		assert.equal(ctx._slotInjectKeys.includes("plugins.bundle.config"), true);
		const { options, component } = bundleConfigOf(ctx);
		assert.equal(options.name, "plugins.bundle.config");
		assert.equal(options.key, PKG, "key 必须是包名字面值（宿主按 bundle 的 package name 派发）");
		assert.equal(options.id, undefined, "keyed 槽不认 id：写了 id 不报错但永远不渲染");
		assert.equal(typeof component, "function");

		// apply 期间绝不能去"试读"命名空间服务（真机就是这么炸的）
		assert.equal(ctx._remoteNamespaceReads, 0, "apply() 不允许在非注入作用域读 remote.runninghub");
	});

	test("Remote 贡献：package + 描述符形状满足 api-remotes 的严格校验", async () => {
		const { exports } = loadClientModule();
		const ctx = createStubCtx();
		await exports.apply(ctx);
		// Remote 挂载是 fire-and-forget（不阻塞页面注册），等一个宏任务让它落地
		await flushAsync();

		assert.equal(ctx._mounted.length, 1, "应对 remote.$mount 一次");
		const contribution = ctx._mounted[0];
		assert.equal(contribution.package, PKG);
		assert.ok(Array.isArray(contribution.descriptors) && contribution.descriptors.length > 0);
		const seen = new Set();
		for (const descriptor of contribution.descriptors) {
			assert.equal(descriptor.service, "runninghub");
			assert.equal(descriptor.namespace, "runninghub");
			assert.equal(descriptor.invocation.kind, "direct");
			assert.ok(descriptor.id.startsWith(`${PKG}#runninghub/`));
			const endpoint = `${descriptor.namespace}/${descriptor.method}`;
			assert.ok(!seen.has(endpoint), `描述符重复：${endpoint}`);
			seen.add(endpoint);
			// 与 host/rpc-remote.mjs 的 PARAMS_WIRE 契约一致：每个方法只有 1 个 `params` 字段
			assert.equal(descriptor.parameters.length, 1, `${endpoint} 必须只有一个 params 字段`);
			const parameter = descriptor.parameters[0];
			assert.equal(parameter.name, "params");
			assert.equal(parameter.wire, "params");
			assert.equal(parameter.source, "json");
			assert.equal(parameter.acceptsUndefined, true, "零参方法要允许省略");
			// `requireStrictCodec` 只认 mode === 'strict'（证据：api-remotes validateContribution）
			assert.equal(parameter.codec.mode, "strict", `${endpoint}.${parameter.name} 需要 strict codec`);
		}
		// 通用桥 + 每个逻辑方法
		assert.ok(seen.has("runninghub/call"), "必须有通用桥 runninghub/call");
		for (const logical of Object.keys(exports.API_METHODS)) {
			assert.ok(seen.has(`runninghub/${exports.API_METHODS[logical].host}`), `缺少 ${logical}`);
		}
	});

	test("styles.insert 可用时优先用它（B 套符号面兼容）", async () => {
		const inserted = [];
		const stylesStub = {
			insert(css) {
				inserted.push(css);
				return () => {};
			},
		};
		const { exports, styleElements } = loadClientModule({ styles: stylesStub });
		const ctx = createStubCtx();
		await exports.apply(ctx);
		assert.equal(inserted.length, 1, "应走 styles.insert");
		assert.equal(styleElements.length, 0, "不应再自建 <style>");
		assert.ok(inserted[0].includes("[data-dsh-runninghub]"));
	});

	test("缺 slots：不抛，也不注册（只降级）", async () => {
		const { exports } = loadClientModule();
		const ctx = createStubCtx();
		ctx.get = () => undefined; // 所有服务都拿不到
		ctx.slots = undefined; // 连注入属性也没有（inject 声明了但宿主没提供）
		ctx.remote = undefined;
		ctx.inject = undefined;
		await exports.apply(ctx);
		assert.equal(ctx._registered.length, 0);
	});

	test("缺 remote：不抛，仍能注册 tab", async () => {
		const { exports } = loadClientModule();
		const ctx = createStubCtx();
		const slots = ctx.get("slots");
		ctx.get = (key) => (key === "remote" ? undefined : key === "slots" ? slots : undefined);
		await exports.apply(ctx);
		assert.ok(ctx._registered.length >= 1, "缺 remote 也要能注册（配置区 + 工具卡片）");
		assert.equal(bundleConfigOf(ctx).options.key, PKG);
	});

	test("slots.register 抛错也不冒泡（apply 永不抛）", async () => {
		const { exports } = loadClientModule();
		const ctx = createStubCtx();
		const slots = ctx.get("slots");
		slots.register = () => {
			throw new Error("slot 爆炸");
		};
		ctx.get = (key) => (key === "slots" ? slots : undefined);
		await assert.doesNotReject(() => exports.apply(ctx));
	});
});

describe("CSS 作用域", () => {
	test("每条规则都以 [data-dsh-runninghub] 前缀（不污染全局样式）", () => {
		const { exports } = loadClientModule();
		const css = exports.PANEL_CSS;
		assert.ok(css.length > 500);
		// 选择器行 = 以 `{` 结尾（单行规则）或以 `,` 结尾（多行选择器组）；
		// @media 里只允许再嵌一层我们的作用域选择器。
		const selectorLines = css
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.endsWith("{") || line.endsWith(","));
		assert.ok(selectorLines.length >= 10, `选择器行太少（${selectorLines.length}），CSS 可能没被完整导出`);
		for (const line of selectorLines) {
			const selector = line.replace(/[{,]$/, "").trim();
			assert.ok(
				selector.startsWith("[data-dsh-runninghub]") || selector.startsWith("@media"),
				`未加作用域的规则：${selector}`,
			);
		}
		assert.ok(css.includes("@media (prefers-color-scheme: dark)"), "需要深色主题兜底");
	});
});

describe("Cordis 注入规则（真机回归）", () => {
	/** 走完 apply()（$mount → ctx.inject 命名空间）的 api —— 与真机装配顺序一致。 */
	async function setupApi(remoteNamespace, options = {}) {
		const { exports } = loadClientModule({ fetch: options.fetch });
		const ctx = createStubCtx({ remoteNamespace: remoteNamespace ?? null, declared: options.declared ?? exports.inject });
		await exports.apply(ctx);
		await flushAsync();
		return { api: exports.createApi(ctx), ctx, exports };
	}

	test("★ inject 硬声明：桩如实模拟「没声明就读不到服务」", () => {
		// ① 声明齐了 → 正常可读
		const okCtx = createStubCtx({ declared: ["remote", "slots"] });
		assert.equal(typeof okCtx.remote.$mount, "function");
		assert.equal(typeof okCtx.slots.register, "function");

		// ② 漏声明 remote → 读 ctx.remote 抛（真机那次就是这种故障）
		const badCtx = createStubCtx({ declared: ["slots"] });
		assert.throws(() => badCtx.remote, /cannot get property "remote" without inject/);
		assert.equal(badCtx._undeclaredReads, 1);

		// ③ 空 inject（我们之前的写法）→ remote / slots 都读不到
		const emptyCtx = createStubCtx({ declared: [] });
		assert.throws(() => emptyCtx.remote, /without inject/);
		assert.throws(() => emptyCtx.slots, /without inject/);
		// 但可选读 ctx.get 仍然不抛（Cordis 的语义）
		assert.equal(typeof emptyCtx.get("remote").$mount, "function");
	});

	test("★ 面板在真实 inject 语义下也能装配起来（声明对了才注册得上）", async () => {
		const { exports } = loadClientModule();
		const ctx = createStubCtx({ declared: exports.inject, remoteNamespace: { status: async () => ({ ok: true, value: {} }) } });
		await exports.apply(ctx);
		await flushAsync();
		assert.equal(bundleConfigOf(ctx).options.key, PKG, "声明对了必须能注册");
		assert.equal(ctx._undeclaredReads, 0, `任何时候都不该去读没声明的服务（读到过：${ctx._undeclaredProps.join(",")}）`);
	});

	test("桩如实模拟宿主：非注入作用域读 remote.runninghub 必须抛", () => {
		const ctx = createStubCtx({ remoteNamespace: { call: async () => ({ ok: true }) } });
		const remote = ctx.get("remote"); // ctx.get('remote') 本身不抛
		assert.equal(typeof remote.$mount, "function");
		assert.throws(() => remote.runninghub, /cannot get property "remote\.runninghub" without inject/);
		assert.equal(ctx._remoteNamespaceReads, 1, "这次违规读必须被记账");
	});

	test("注入作用域里 remote.runninghub 才是可用对象（且要等 $mount 之后、注入是异步的）", async () => {
		const service = { status: async () => ({ ok: true, value: {} }) };
		const ctx = createStubCtx({ remoteNamespace: service });
		let injected = null;
		ctx.inject(["remote.runninghub"], (scope) => {
			injected = scope.remote.runninghub;
		});
		assert.equal(injected, null, "$mount 之前不该回调");
		await ctx.get("remote").$mount({ package: PKG, descriptors: [] });
		assert.equal(injected, null, "注入是**异步**的：$mount 刚 resolve 时还拿不到（真机就是这样）");
		await flushAsync();
		assert.equal(injected, service, "下一个宏任务才拿到命名空间服务");
		assert.equal(ctx._remoteNamespaceReads, 0);
	});

	test("★ 回归护栏：面板必须只从注入作用域拿服务（改回 remote[NS] 立刻红）", async () => {
		const seen = [];
		const { api, ctx } = await setupApi({
			call: async (params) => {
				seen.push(JSON.parse(params.callJson));
				return { ok: true, value: JSON.stringify({ ok: true, value: { version: "remote-ok", dataDir: "D:/rh" } }) };
			},
		});

		const status = await api.status();
		assert.deepEqual(status, { version: "remote-ok", dataDir: "D:/rh" }, "Remote 通道必须真的通");
		assert.equal(api.transportKind, "remote");
		assert.deepEqual(seen[0], { method: "status", params: {} });

		// 这一条是护栏：旧实现 `remote[NS]` 会抛 / 至少会把这个计数打上去
		assert.equal(ctx._remoteNamespaceReads, 0, "绝不能在非注入作用域读 remote.runninghub（真机白屏根因）");
	});

	test("★ 用户可见症状回归：面板顶部不再出现 without inject 红字，状态栏有数据", async () => {
		const react = createTestReact();
		const remoteNamespace = {
			status: async () => ({
				ok: true,
				value: {
					ok: true,
					dataDir: "D:/dsh/runninghub",
					version: "0.2.0",
					keys: [],
					pool: { cn: { total: 0, available: 0 }, overseas: { total: 0, available: 0 } },
					warnings: [],
				},
			}),
			listWorkflows: async () => ({ ok: true, value: [] }),
			docsList: async () => ({ ok: true, value: [] }),
			tasksList: async () => ({ ok: true, value: [] }),
		};
		const { exports } = loadClientModule({ react });
		const ctx = createStubCtx({ remoteNamespace });
		await exports.apply(ctx);
		await flushAsync();

		// 用**注册进去的那个组件**（真机就是它被渲染），走 page 态
		const registered = bundleConfigOf(ctx).component;
		react.render(react.createElement(registered, { view: "page" }));
		await flushAsync();
		await flushAsync();
		react.rerender();

		const text = textOf(react.tree);
		assert.doesNotMatch(text, /without inject/, "真机那条红字不能再出现");
		assert.doesNotMatch(text, /读取宿主快照失败/);
		assert.match(text, /D:\/dsh\/runninghub/, "状态栏应显示宿主数据目录");
		assert.equal(ctx._remoteNamespaceReads, 0);
	});
});

describe("plugins.bundle.config（本插件自己的「插件页面」）", () => {
	/** 完全模拟宿主渲染：拿 apply() 真注册进去的那个组件。 */
	async function mountRegistered(remoteNamespace, options = {}) {
		const react = createTestReact();
		const { exports } = loadClientModule({ react });
		const ctx = createStubCtx({ remoteNamespace: remoteNamespace ?? null });
		await exports.apply(ctx);
		await flushAsync();
		// 配置区 1 条 + 工具卡片 2 条（runninghub_call / runninghub_search）
		assert.equal(ctx._registered.length, 3, "应注册 1 个配置区 + 2 个工具卡片");
		return { react, ctx, exports, registration: bundleConfigOf(ctx) };
	}

	/** 一个能喂饱面板的命名空间服务。 */
	function healthyNamespace() {
		return {
			status: async () => ({
				ok: true,
				value: {
					ok: true,
					dataDir: "D:/dsh/runninghub",
					version: "0.2.0",
					keys: [],
					counts: { keys: 0, workflows: 3, tasks: 2, docs: 1 },
					pool: { cn: { total: 2, available: 1 }, overseas: { total: 1, available: 0 } },
					warnings: [],
				},
			}),
			listWorkflows: async () => ({ ok: true, value: [] }),
			docsList: async () => ({ ok: true, value: [] }),
			tasksList: async () => ({ ok: true, value: [] }),
		};
	}

	test("slot 名与 key 的字面值：plugins.bundle.config / dsh-runninghub-plugin", async () => {
		const { ctx, registration } = await mountRegistered(healthyNamespace());
		assert.equal(ctx._slotInjectKeys.includes("plugins.bundle.config"), true, "必须 inject 了 plugins.bundle.config");
		assert.equal(registration.options.name, "plugins.bundle.config");
		assert.equal(registration.options.key, "dsh-runninghub-plugin");
		assert.equal(registration.options.key, PKG, "key 就是包名（不是 'runninghub'、不是 id）");
		// keyed 槽的注册项里不该出现 id（写了不报错，但宿主只认 key）
		assert.equal("id" in registration.options, false);
		// 只传文档化的两个字段：多传的字段（id/order/label/inject…）在这个槽位上没有契约，
		// 万一宿主做严格校验就会让整块配置区注册失败 —— 宁可不传。
		assert.deepEqual(Object.keys(registration.options).sort(), ["key", "name"]);
	});

	test("不再注册 settings.plugins.tab（用户要求「改到」= 搬走，不是两处都留）", async () => {
		const { exports } = loadClientModule();
		const ctx = createStubCtx();
		await exports.apply(ctx);
		const slotNames = ctx._registered.map((entry) => entry.options.name);
		assert.deepEqual([...new Set(slotNames)].sort(), ["plugins.bundle.config", "tool.call.toolview"], "只应注册这两个槽");
		assert.equal(slotNames.includes("settings.plugins.tab"), false);
		assert.notEqual(ctx._slotInjectKey, "settings.plugins.tab");
		// 源码里也不该再有它的注册调用（只允许注释里提到它）
		const source = readFileSync(new URL("../../client/client.js", import.meta.url), "utf8");
		assert.equal(/slots\.inject\(\s*["']settings\.plugins\.tab["']/.test(source), false, "settings.plugins.tab 的注册必须删干净");
	});

	test("summary 态：只渲染一行摘要，不渲染完整面板", async () => {
		const { react, registration } = await mountRegistered(healthyNamespace());
		react.render(react.createElement(registration.component, { view: "summary" }));
		await flushAsync();
		react.rerender();

		const tree = react.tree;
		const summary = hosts(tree, (node) => node.props["data-rh-summary"] !== undefined);
		assert.equal(summary.length, 1, "summary 态应恰好一个摘要节点");
		assert.match(textOf(summary[0]), /国内 1\/2 可用 · 海外 0\/1 可用 · 3 个工作流 · 2 个任务/);

		// ★ 不许出现完整面板的任何特征
		assert.equal(hosts(tree, (node) => node.props["data-rh-panel"] !== undefined).length, 0, "summary 态不许渲染完整面板");
		assert.equal(hosts(tree, (node) => node.props["data-rh-status"] !== undefined).length, 0, "summary 态不许渲染状态栏");
		assert.equal(hosts(tree, (node) => node.props["data-rh-section-box"] !== undefined).length, 0, "summary 态不许渲染折叠区");
		assert.equal(hosts(tree, (node) => node.props["data-rh-workflows"] !== undefined).length, 0, "summary 态不许渲染工作流列表");
		assert.equal(hosts(tree, (node) => node.type === "table").length, 0, "summary 态不许渲染任何表格");
		// 一行 = 摘要节点内部不含 <p>/<div> 这种块级结构
		assert.equal(hosts(summary[0], (node) => node.type === "p" || node.type === "div").length, 0, "summary 必须是一行文本");
	});

	test("summary 态：数据未就绪走占位，失败给可读文案（都不炸）", async () => {
		// 未就绪：status 永不 resolve → 停在占位
		const pending = { status: () => new Promise(() => {}) };
		const first = await mountRegistered(pending);
		first.react.render(first.react.createElement(first.registration.component, { view: "summary" }));
		assert.match(textOf(first.react.tree), /—/);

		// 失败：错误码要出现在那一行里
		const failing = { status: async () => ({ ok: false, error: { code: "NO_KEY", message: "国内池没有可用 Key" } }) };
		const second = await mountRegistered(failing);
		second.react.render(second.react.createElement(second.registration.component, { view: "summary" }));
		await flushAsync();
		second.react.rerender();
		const text = textOf(second.react.tree);
		assert.match(text, /读取失败/);
		assert.match(text, /NO_KEY/);
	});

	test("page 态：渲染完整面板，且不再重复大标题（宿主页面已有插件名 + 描述）", async () => {
		const { react, registration } = await mountRegistered(healthyNamespace());
		react.render(react.createElement(registration.component, { view: "page" }));
		await flushAsync();
		await flushAsync();
		react.rerender();

		const tree = react.tree;
		const panel = hosts(tree, (node) => node.props["data-rh-panel"] !== undefined);
		assert.equal(panel.length, 1, "page 态应渲染完整面板");
		assert.equal(panel[0].props["data-rh-embedded"], "true", "嵌入宿主页面");
		assert.ok(hosts(tree, (node) => node.props["data-rh-status"] !== undefined).length > 0, "page 态要有状态栏");
		assert.ok(hosts(tree, (node) => node.props["data-rh-section-box"] !== undefined).length > 0, "page 态要有折叠区");
		assert.match(textOf(tree), /D:\/dsh\/runninghub/);

		// 不重复标题：没有 h1/h2/h3/h4 级别的大标题
		assert.equal(hosts(tree, (node) => ["h1", "h2", "h3", "h4"].includes(node.type)).length, 0, "page 态不许画自己的大标题");
		assert.doesNotMatch(textOf(tree), /RunningHub 工作流/);
	});

	test("view 缺失时按 page 处理（保守：宿主没传 view 也能看到完整配置）", async () => {
		const { react, registration } = await mountRegistered(healthyNamespace());
		react.render(react.createElement(registration.component, {}));
		assert.equal(hosts(react.tree, (node) => node.props["data-rh-panel"] !== undefined).length, 1);
	});

	test("组件不依赖宿主拍平 inject：只给 view 也能拿到数据（走闭包）", async () => {
		const { react, registration } = await mountRegistered(healthyNamespace());
		// 宿主若只传 { view }，props.api 是 undefined —— 面板仍必须工作
		react.render(react.createElement(registration.component, { view: "page" }));
		await flushAsync();
		await flushAsync();
		react.rerender();
		const text = textOf(react.tree);
		assert.doesNotMatch(text, /面板没有拿到宿主接口/, "api 走闭包，不该依赖 host 注入 props");
		assert.match(text, /D:\/dsh\/runninghub/);
	});

	test("缺 slots 服务：不抛、不注册（只 warn）", async () => {
		const { exports } = loadClientModule();
		const ctx = createStubCtx();
		ctx.get = () => undefined;
		ctx.slots = undefined;
		ctx.remote = undefined;
		ctx.inject = undefined;
		await assert.doesNotReject(() => exports.apply(ctx));
		assert.equal(ctx._registered.length, 0);
	});

	test("纯逻辑：summaryLine 组合方式", () => {
		const { exports } = loadClientModule();
		assert.equal(
			exports.summaryLine({ pool: { cn: { total: 3, available: 2 }, overseas: { total: 1, available: 0 } }, counts: { workflows: 5, tasks: 1 } }),
			"国内 2/3 可用 · 海外 0/1 可用 · 5 个工作流 · 1 个任务",
		);
		// counts 缺失时只出池子那半句，不抛
		assert.equal(exports.summaryLine({ pool: { cn: { total: 0, available: 0 }, overseas: { total: 0, available: 0 } } }), "国内 0/0 可用 · 海外 0/0 可用");
		assert.equal(typeof exports.summaryLine(null), "string");
	});
});

describe("tool.call.toolview（聊天里的工具卡片）", () => {
	/** 造 apply 之后的 ctx（含工具卡片注册）。fetch / URL 都可注入。 */
	async function setup(options = {}) {
		const react = createTestReact();
		const url = options.url ?? createUrlStub();
		const loaded = loadClientModule({ react, fetch: options.fetch, URL: url });
		const { exports } = loaded;
		const ctx = createStubCtx({ remoteNamespace: options.remoteNamespace ?? null });
		await exports.apply(ctx);
		await flushAsync();
		return { react, ctx, exports, url, loaded };
	}

	/** 真渲染一个工具卡片并按需 rerender。 */
	async function renderRow(react, component, props, passes = 2) {
		react.render(react.createElement(component, props));
		for (let index = 0; index < passes; index += 1) {
			await flushAsync();
			react.rerender();
		}
		return react.tree;
	}

	/** 宿主图片路由的 fetch 桩：POST → 二进制。 */
	function imageFetch(handler) {
		const calls = [];
		const stub = async (url, init) => {
			const body = init !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : null;
			calls.push({ url, init, body });
			if (handler !== undefined) return handler(url, init, calls.length);
			return {
				ok: true,
				status: 200,
				async blob() {
					return { size: 4, type: "image/png" };
				},
			};
		};
		stub.calls = calls;
		return stub;
	}

	/** 一个真实的结算态 ToolResultNode（结构取自 dsh-client-ui-tool 的 resultText / imageReferences 契约）。 */
	function resultBlock(overrides = {}) {
		return Object.assign(
			{
				kind: "tool-result",
				callId: "call-1",
				call: { name: "runninghub_call", argsRaw: JSON.stringify({ action: "task.wait", taskId: "t-1" }) },
				isError: false,
				content: [
					{ type: "text", text: "任务完成：https://rh-images-tos.example.com/a.png" },
					{
						type: "image",
						attachment: { attachmentId: "att-1", mediaType: "image/png", bytes: 2048, width: 512, height: 512, name: "a.png" },
					},
				],
			},
			overrides,
		);
	}

	const IMAGE_ROUTE = "/plugins/dsh-runninghub-plugin/image";

	test("注册字面参数：key = 工具名、**没有 children**（声明 tool.call.images 会加载期 throw）", async () => {
		const { ctx } = await setup();
		assert.equal(ctx._slotInjectKeys.includes("tool.call.toolview"), true, "必须 inject tool.call.toolview");
		const callRow = registeredFor(ctx, "tool.call.toolview", "runninghub_call");
		const searchRow = registeredFor(ctx, "tool.call.toolview", "runninghub_search");
		assert.equal(callRow.options.name, "tool.call.toolview");
		assert.equal(callRow.options.key, "runninghub_call");
		// ★ 防回归：`tool.call.images` 已被内置 read-image-toolview 声明，再声明会 throw
		assert.equal("children" in callRow.options, false, "不能声明 children");
		assert.equal(callRow.options.children, undefined);
		assert.equal("id" in callRow.options, false, "keyed 槽只认 key");
		assert.equal(typeof callRow.component, "function");
		assert.equal(searchRow.options.key, "runninghub_search");
		assert.equal(searchRow.component, callRow.component, "两个 key 共用一个组件");
		// generator 形态的 inject 回调：两个 disposer 都要被 yield 出来
		assert.equal(ctx._yieldedDisposers.length, 2);
	});

	test("★ result 态：POST 宿主图片路由（body 带 attachment）→ objectURL → <img>", async () => {
		const fetch = imageFetch();
		const { react, ctx, url } = await setup({ fetch });
		const row = registeredFor(ctx, "tool.call.toolview", "runninghub_call").component;
		const tree = await renderRow(react, row, { phase: "result", block: resultBlock(), loadImage: async () => "blob:不该用到" });

		// ① 请求本身
		assert.equal(fetch.calls.length, 1, "应恰好发一次取图请求");
		assert.equal(fetch.calls[0].url, IMAGE_ROUTE);
		assert.equal(fetch.calls[0].init.method, "POST");
		assert.equal(fetch.calls[0].init.headers["content-type"], "application/json");
		assert.equal(fetch.calls[0].init.credentials, "same-origin");
		assert.deepEqual(fetch.calls[0].body, {
			// ★ 必须**整个 attachment 透传**：宿主 readImage 会逐字段比对引用与图片元数据，
			//   缺 bytes/width/height 就会报 "Stored attachment metadata does not match its reference."
			//   （曾经"精简"成两个字段，真机直接不显示图。）
			attachment: {
				attachmentId: "att-1",
				mediaType: "image/png",
				bytes: 2048,
				width: 512,
				height: 512,
				name: "a.png",
			},
		});
		// 三个数值字段一个都不能少（防回归：有人又"精简"掉）
		for (const field of ["attachmentId", "mediaType", "bytes", "width", "height"]) {
			assert.equal(field in fetch.calls[0].body.attachment, true, `body.attachment 必须带 ${field}`);
		}

		// ② 渲染出的图
		const images = hosts(tree, (node) => node.type === "img");
		assert.equal(images.length, 1, "应渲染 1 张结果图");
		assert.equal(images[0].props.src, "blob:runninghub-1");
		assert.equal(url._created.length, 1, "应 createObjectURL 一次");
	});

	test("★ 文本与链接照旧可读（换卡片不能让回执消失）", async () => {
		const { react, ctx } = await setup({ fetch: imageFetch() });
		const row = registeredFor(ctx, "tool.call.toolview", "runninghub_call").component;
		const tree = await renderRow(react, row, { phase: "result", block: resultBlock(), loadImage: async () => "blob:x" });

		const text = textOf(tree);
		assert.match(text, /runninghub_call/);
		assert.match(text, /task\.wait/, "动作名要显示");
		assert.match(text, /完成/, "状态徽章");
		assert.match(text, /任务完成/, "回执文本必须保留");
		const links = hosts(tree, (node) => node.type === "a" && typeof node.props.href === "string" && node.props.href.startsWith("http"));
		assert.ok(links.length >= 1, "回执里的 http(s) URL 要变成可点链接");
		assert.equal(hosts(tree, (node) => node.props["data-rh-tool-text"] !== undefined).length, 1, "回执文本区存在");
	});

	test("★ 图片路由 404：不抛、有文本降级、有链接", async () => {
		const fetch = imageFetch(() => ({
			ok: false,
			status: 404,
			async blob() {
				throw new Error("不该走到这里");
			},
		}));
		const { react, ctx, url } = await setup({ fetch });
		const row = registeredFor(ctx, "tool.call.toolview", "runninghub_call").component;
		let tree = null;
		await assert.doesNotReject(async () => {
			// 连 loadImage 也不给：模拟"路由没实现 + 老宿主没有 loader"
			tree = await renderRow(react, row, { phase: "result", block: resultBlock() });
		});
		assert.equal(hosts(tree, (node) => node.type === "img").length, 0, "拿不到图就不该硬塞 img");
		assert.match(textOf(tree), /图片加载失败/);
		assert.match(textOf(tree), /404/);
		assert.match(textOf(tree), /任务完成/, "文本照旧可读");
		assert.ok(hosts(tree, (node) => node.type === "a" && String(node.props.href).startsWith("http")).length >= 1, "URL 仍可点");
		assert.equal(url._created.length, 0, "没拿到 blob 就不该 createObjectURL");
	});

	test("★ 路由 400：把宿主的 error.code / error.message 原文显示出来（不是只说「加载失败」）", async () => {
		const hostMessage =
			"attachment 缺少 bytes / width / height —— readImage 会比对引用与图片元数据，缺字段必然报 \"Stored attachment metadata does not match its reference.\"；请回传 saveImage 给的完整引用";
		const fetch = imageFetch(() => ({
			ok: false,
			status: 400,
			async text() {
				return JSON.stringify({ ok: false, error: { code: "INVALID_REFERENCE", message: hostMessage } });
			},
			async blob() {
				throw new Error("不该走到这里");
			},
		}));
		const { react, ctx } = await setup({ fetch });
		const row = registeredFor(ctx, "tool.call.toolview", "runninghub_call").component;
		const tree = await renderRow(react, row, { phase: "result", block: resultBlock() });

		const text = textOf(tree);
		assert.match(text, /HTTP 400/);
		assert.match(text, /INVALID_REFERENCE/, "错误码要显示");
		assert.match(text, /缺少 bytes \/ width \/ height/, "★ 宿主说清缺了哪些字段 —— 必须原样端到卡片上");
		assert.match(text, /任务完成/, "文本照旧可读");
	});

	test("★ 路由失败时退回聊天 loader（loadImage），仍能出图", async () => {
		const fetch = imageFetch(() => ({ ok: false, status: 405, async blob() { throw new Error("nope"); } }));
		const { react, ctx } = await setup({ fetch });
		const row = registeredFor(ctx, "tool.call.toolview", "runninghub_call").component;
		const seen = [];
		const tree = await renderRow(react, row, {
			phase: "result",
			block: resultBlock(),
			loadImage: async (attachment) => {
				seen.push(attachment.attachmentId);
				return "blob:from-loadImage";
			},
		});
		const images = hosts(tree, (node) => node.type === "img");
		assert.equal(images.length, 1);
		assert.equal(images[0].props.src, "blob:from-loadImage");
		assert.deepEqual(seen, ["att-1"], "loadImage 收到的是 attachment 本身（与 QueueThumb 用法一致）");
	});

	test("★ 卸载时 revokeObjectURL 被调用（防内存泄漏）", async () => {
		const { react, ctx, url } = await setup({ fetch: imageFetch() });
		const row = registeredFor(ctx, "tool.call.toolview", "runninghub_call").component;
		await renderRow(react, row, { phase: "result", block: resultBlock(), loadImage: async () => "blob:x" });
		assert.equal(url._revoked.length, 0, "还在显示时不该 revoke");
		react.unmount();
		assert.deepEqual(url._revoked, ["blob:runninghub-1"], "卸载必须 revoke 自己建的 objectURL");
	});

	test("preparing / start 态：只有一行状态，不取图、不渲染 <img>、不崩", async () => {
		const fetch = imageFetch();
		const { react, ctx } = await setup({ fetch });
		const row = registeredFor(ctx, "tool.call.toolview", "runninghub_call").component;

		const preparing = await renderRow(react, row, { phase: "preparing", block: { phase: "preparing", callId: "c" }, loadImage: async () => "blob:x" });
		assert.equal(hosts(preparing, (node) => node.type === "img").length, 0, "preparing 不该有图");
		assert.match(textOf(preparing), /准备/);

		const start = await renderRow(react, row, {
			phase: "start",
			block: { phase: "start", callId: "c", name: "runninghub_call", argsRaw: "{}" },
			loadImage: async () => "blob:x",
		});
		assert.equal(hosts(start, (node) => node.type === "img").length, 0, "start 不该有图");
		assert.equal(hosts(start, (node) => node.props["data-rh-tool-fallback"] !== undefined).length, 0, "不该走降级");
		assert.equal(fetch.calls.length, 0, "没结算就不该请求图片");
	});

	test("★ 形状不认识时只降级、不抛（ErrorBoundary 生效，退回纯文本）", async () => {
		const { react, ctx } = await setup({ fetch: imageFetch() });
		const row = registeredFor(ctx, "tool.call.toolview", "runninghub_call").component;
		const hostile = {
			kind: "tool-result",
			callId: "call-boom",
			call: { name: "runninghub_call", argsRaw: "{}" },
			isError: false,
			content: [
				{
					type: "text",
					get text() {
						throw new Error("未来版本的形状炸了");
					},
				},
			],
		};
		let tree = null;
		await assert.doesNotReject(async () => {
			tree = await renderRow(react, row, { phase: "result", block: hostile, loadImage: async () => "blob:x" });
		});
		assert.equal(hosts(tree, (node) => node.props["data-rh-tool-fallback"] !== undefined).length, 1, "应降级成纯文本卡片");
		assert.match(textOf(tree), /已降级为纯文本/);
		// 完全不是对象的 block 也不能抛
		const empty = await renderRow(react, row, { phase: "result", block: null, loadImage: async () => "blob:x" });
		assert.ok(empty !== null);
	});

	test("多张图 + 图片块缺 attachment 时的降级文案 + resultView 分支", async () => {
		const { react, ctx } = await setup({ fetch: imageFetch() });
		const row = registeredFor(ctx, "tool.call.toolview", "runninghub_call").component;
		const block = resultBlock({
			content: [
				{ type: "text", text: "两张图" },
				{ type: "image", attachment: { attachmentId: "a1", mediaType: "image/png", bytes: 10, width: 8, height: 8 } },
				{ type: "image", attachment: { attachmentId: "a2", mediaType: "image/jpeg", bytes: 10, width: 8, height: 8 } },
				{ type: "image" },
			],
		});
		const tree = await renderRow(react, row, { phase: "result", block: block, loadImage: async () => "blob:fallback" });
		const images = hosts(tree, (node) => node.type === "img");
		assert.equal(images.length, 2, "两张有效的图都要渲染");
		assert.equal(images[0].props.src, "blob:runninghub-1");
		assert.equal(images[1].props.src, "blob:runninghub-2");
		assert.match(textOf(tree), /图片块缺少可用的 attachment 引用/);

		// 参考实现的另一条分支：block.content 不在，图在 resultView.content 里
		const viaResultView = resultBlock({
			content: [],
			resultView: {
				card: "generic",
				content: [{ type: "image", attachment: { attachmentId: "rv-1", mediaType: "image/png", bytes: 9, width: 8, height: 8 } }],
			},
		});
		const tree2 = await renderRow(react, row, { phase: "result", block: viaResultView, loadImage: async () => "blob:rv" });
		assert.equal(hosts(tree2, (node) => node.type === "img").length, 1, "resultView.content 里的图也要认");
	});

	test("错误结果（isError）也有明确状态 + 结构化错误兜底文案", async () => {
		const { react, ctx } = await setup({ fetch: imageFetch() });
		const row = registeredFor(ctx, "tool.call.toolview", "runninghub_call").component;
		const tree = await renderRow(react, row, {
			phase: "result",
			block: resultBlock({ isError: true, content: [], error: { name: "RunningHubError", code: "TASK_FAILED" } }),
			loadImage: async () => "blob:x",
		});
		assert.match(textOf(tree), /失败/);
		assert.match(textOf(tree), /RunningHubError: TASK_FAILED/, "content 为空时用结构化错误兜底");
		assert.equal(hosts(tree, (node) => node.props["data-rh-tool-state"] === "error").length, 1);
	});

	test("★ 本地文件优先：📁 行 → 可点击条目（openFile 收到完整路径），URL 不再占主展示位", async () => {
		const { react, ctx } = await setup({ fetch: imageFetch() });
		const row = registeredFor(ctx, "tool.call.toolview", "runninghub_call").component;
		const opened = [];
		const block = resultBlock({
			content: [
				{
					type: "text",
					text: [
						"✅ 完成 · 2 个 · 79s · 16 币",
						"📁 C:\\Users\\demo\\.dsh\\runninghub\\outputs\\a\\20260925_194007_Shot_00001.png",
						"📁 C:\\Users\\demo\\.dsh\\runninghub\\outputs\\a\\20260925_194008_Shot_00002.png",
						"远端备份：https://rh-images-tos.example.com/a.png",
					].join("\n"),
				},
				{ type: "image", attachment: { attachmentId: "att-1", mediaType: "image/png", bytes: 2048, width: 512, height: 512 } },
			],
		});
		const tree = await renderRow(react, row, {
			phase: "result",
			block: block,
			loadImage: async () => "blob:x",
			openFile: (path) => opened.push(path),
		});

		// ① 两个本地文件条目
		const files = hosts(tree, (node) => node.props["data-rh-tool-file"] !== undefined);
		assert.equal(files.length, 2, "应渲染 2 个本地文件条目");
		assert.equal(files[0].props["data-rh-tool-file"], "C:\\Users\\demo\\.dsh\\runninghub\\outputs\\a\\20260925_194007_Shot_00001.png");
		assert.equal(files[1].props["data-rh-tool-file"], "C:\\Users\\demo\\.dsh\\runninghub\\outputs\\a\\20260925_194008_Shot_00002.png");
		// 标签只用文件名，完整路径在 title（别把卡片撑宽）
		assert.equal(textOf(files[0]), "20260925_194007_Shot_00001.png");
		assert.equal(files[0].props.title, "C:\\Users\\demo\\.dsh\\runninghub\\outputs\\a\\20260925_194007_Shot_00001.png");
		assert.match(textOf(tree), /本地文件/);

		// ② URL 不再占主展示位（没有"结果链接"那一栏，也没有 http 链接）
		assert.equal(hosts(tree, (node) => node.props["data-rh-tool-links"] !== undefined).length, 0, "有本地文件时不该再显示结果链接栏");
		assert.equal(hosts(tree, (node) => node.type === "a" && String(node.props.href).startsWith("http")).length, 0);

		// ③ 点击打开：openFile 收到**完整路径**
		click(files[1]);
		assert.deepEqual(opened, ["C:\\Users\\demo\\.dsh\\runninghub\\outputs\\a\\20260925_194008_Shot_00002.png"]);

		// ④ 图片链没被动过
		assert.equal(hosts(tree, (node) => node.type === "img").length, 1, "图片照旧渲染");
	});

	test("本地文件 fallback：只有远端 URL 的旧回执仍能显示，不白屏", async () => {
		const { react, ctx } = await setup({ fetch: imageFetch() });
		const row = registeredFor(ctx, "tool.call.toolview", "runninghub_call").component;
		const tree = await renderRow(react, row, {
			phase: "result",
			block: resultBlock({ content: [{ type: "text", text: "✅ 完成\n🔗 https://rh-images-tos.example.com/legacy.png" }] }),
			loadImage: async () => "blob:x",
		});
		assert.equal(hosts(tree, (node) => node.props["data-rh-tool-file"] !== undefined).length, 0, "没有本地路径就不该有文件条目");
		assert.equal(hosts(tree, (node) => node.props["data-rh-tool-links"] !== undefined).length, 1, "应退回结果链接栏");
		const links = hosts(tree, (node) => node.type === "a" && String(node.props.href).startsWith("http"));
		assert.equal(links.length, 1);
		assert.equal(links[0].props.href, "https://rh-images-tos.example.com/legacy.png");
		assert.equal(hosts(tree, (node) => node.props["data-rh-tool-fallback"] !== undefined).length, 0, "不该走降级");
	});

	test("本地文件与 URL 都没有：不崩、不出现空条目", async () => {
		const { react, ctx } = await setup({ fetch: imageFetch() });
		const row = registeredFor(ctx, "tool.call.toolview", "runninghub_call").component;
		const tree = await renderRow(react, row, {
			phase: "result",
			block: resultBlock({ content: [{ type: "text", text: "✅ 完成 · 1 个 · 79s · 16 币" }] }),
			loadImage: async () => "blob:x",
		});
		assert.equal(hosts(tree, (node) => node.props["data-rh-tool-file"] !== undefined).length, 0);
		assert.equal(hosts(tree, (node) => node.props["data-rh-tool-links"] !== undefined).length, 0);
		assert.equal(hosts(tree, (node) => node.props["data-rh-tool-fallback"] !== undefined).length, 0);
		assert.match(textOf(tree), /完成/, "文本照旧可读");
	});

	test("openFile 缺失时不崩（退化成不可点的 code，路径仍可见）", async () => {
		const { react, ctx } = await setup({ fetch: imageFetch() });
		const row = registeredFor(ctx, "tool.call.toolview", "runninghub_call").component;
		const tree = await renderRow(react, row, {
			phase: "result",
			block: resultBlock({ content: [{ type: "text", text: "📁 C:\\tmp\\a.png" }] }),
			loadImage: async () => "blob:x",
		});
		const files = hosts(tree, (node) => node.props["data-rh-tool-file"] !== undefined);
		assert.equal(files.length, 1);
		assert.equal(files[0].type, "code", "没有 openFile 时不该是可点按钮");
		assert.equal(files[0].props.title, "C:\\tmp\\a.png");
	});

	test("纯逻辑：本地路径提取（📁 前缀 / 裸盘符 / UNC / 去重 / 不误吞 URL）", () => {
		const { exports } = loadClientModule();
		const text = [
			"✅ 完成 · 2 个",
			"📁 C:\\tmp\\a.png",
			"C:\\Program Files\\My App\\b.webp",
			"\\\\server\\share\\c.mp4",
			"📁 C:\\tmp\\a.png",
			"结果链接：https://rh-images-tos.example.com/x.png",
			"任务 t-1 已完成",
		].join("\n");
		const files = exports.extractLocalFiles(text);
		assert.deepEqual(
			files.map((entry) => entry.path),
			["C:\\tmp\\a.png", "C:\\Program Files\\My App\\b.webp", "\\\\server\\share\\c.mp4"],
		);
		assert.deepEqual(files.map((entry) => entry.name), ["a.png", "b.webp", "c.mp4"]);
		// toolCallView 也把它算出来
		const view = exports.toolCallView("result", { content: [{ type: "text", text: text }] });
		assert.equal(view.localFiles.length, 3);
		assert.equal(view.links.length, 1, "URL 仍然被识别（只是不再当主展示）");
		// 空 / 残缺输入
		assert.deepEqual(exports.extractLocalFiles(""), []);
		assert.deepEqual(exports.extractLocalFiles(null), []);
		assert.deepEqual(exports.extractLocalFiles("没有路径"), []);
	});

	test("图片 CSS 有限高（别把聊天撑爆）", () => {
		const { exports } = loadClientModule();
		assert.match(exports.PANEL_CSS, /\.rh-tool-image\s*\{[^}]*max-height:\s*360px/);
	});

	test("纯逻辑：toolCallView 对残缺/异形 block 的防御", () => {
		const { exports } = loadClientModule();
		assert.equal(exports.toolCallView("result", null).text, "");
		assert.equal(exports.toolCallView("result", null).refs.length, 0);
		assert.equal(exports.toolCallView("preparing", { phase: "preparing" }).state, "preparing");
		assert.equal(exports.toolCallView("start", { name: "runninghub_call" }).state, "running");
		const view = exports.toolCallView("result", {
			content: [{ type: "image", attachment: { attachmentId: "x", mediaType: "image/png", bytes: 1, width: 1, height: 1 } }, { type: "reasoning", text: "扩展块" }],
		});
		assert.equal(view.refs.length, 1);
		assert.match(view.text, /扩展块/, "未知块类型要 JSON 出来而不是丢掉");
		assert.deepEqual(exports.findLinks("看 https://a.example.com/x.png 和 https://a.example.com/x.png"), ["https://a.example.com/x.png"]);
	});
});

describe("节点字段三态控件（建议值 + 自由输入）", () => {
	/** 拿导出的组件渲染一次。 */
	function mount(options = {}) {
		const react = createTestReact();
		const { exports } = loadClientModule({ react, windowExtras: options.windowExtras });
		const component = exports.NodeFieldInput;
		const render = (props) => {
			react.render(react.createElement(component, props));
			return react.tree;
		};
		return { react, exports, render };
	}

	test("★ 非 enum + 有建议值 → 原生 input[list] + datalist（可选也可以自己敲），不是 select", () => {
		const { render } = mount();
		const tree = render({
			node: { nodeId: "6", fieldName: "aspect_ratio", valueType: "string", options: ["a", "b"], optionsSource: "inferred-from-default" },
			value: "a",
			onChange: () => {},
		});
		const inputs = hosts(tree, (node) => node.type === "input");
		assert.equal(inputs.length, 1, "应有一个输入框");
		assert.equal(inputs[0].props["data-rh-field-kind"], "suggest");
		assert.equal(inputs[0].props.list, "rh-opt-6-aspect_ratio", "list 指向唯一的 datalist id");
		assert.equal(hosts(tree, (node) => node.type === "select").length, 0, "★ 不是 select（否则用户只能选、改不了）");

		const datalists = hosts(tree, (node) => node.type === "datalist");
		assert.equal(datalists.length, 1);
		assert.equal(datalists[0].props.id, "rh-opt-6-aspect_ratio");
		const suggestions = hosts(datalists[0], (node) => node.type === "option").map((node) => node.props.value);
		assert.deepEqual(suggestions, ["a", "b"], "★ 建议项 a/b 都在");

		// inferred 必须提示"可自由输入"
		const hint = hosts(tree, (node) => node.props["data-rh-field-hint"] === "inferred");
		assert.equal(hint.length, 1, "★ 必须提示可自由输入（别让用户以为只有这一个值）");
		assert.match(textOf(hint[0]), /可自由输入/);
	});

	test("★ enum → 仍然是真下拉，且只有给定选项", () => {
		const { render } = mount();
		const tree = render({ node: { nodeId: "7", fieldName: "sampler", valueType: "enum", options: ["a", "b"] }, value: "b", onChange: () => {} });
		const selects = hosts(tree, (node) => node.type === "select");
		assert.equal(selects.length, 1, "enum 必须是 select");
		assert.equal(selects[0].props["data-rh-field-kind"], "enum");
		assert.equal(hosts(tree, (node) => node.type === "input").length, 0);
		assert.equal(hosts(tree, (node) => node.type === "datalist").length, 0, "enum 不该有 datalist");
		assert.deepEqual(hosts(tree, (node) => node.type === "option").map((node) => node.props.value), ["a", "b"]);
	});

	test("★ 非 enum + options 为空 → 纯输入框，没有建议容器，不崩", () => {
		const { render } = mount();
		const tree = render({ node: { nodeId: "8", fieldName: "seed", valueType: "number", options: [] }, value: "42", onChange: () => {} });
		const inputs = hosts(tree, (node) => node.type === "input");
		assert.equal(inputs.length, 1);
		assert.equal(inputs[0].props["data-rh-field-kind"], "plain");
		assert.equal(inputs[0].props.type, "number");
		assert.equal(hosts(tree, (node) => node.type === "datalist").length, 0, "没有建议值就不该有 datalist");
		assert.equal(hosts(tree, (node) => node.props["data-rh-field-hint"] !== undefined).length, 0);
		// 残缺 node 也不崩
		assert.ok(render({ node: null, value: "", onChange: () => {} }) !== null);
		assert.ok(render({ node: {}, value: "", onChange: () => {} }) !== null);
	});

	test("optionsSource 不是 inferred 时不显示「可自由输入」提示（但建议值照旧）", () => {
		const { render } = mount();
		const tree = render({
			node: { nodeId: "9", fieldName: "ckpt_name", valueType: "string", options: ["m1.safetensors"], optionsSource: "workflow" },
			value: "",
			onChange: () => {},
		});
		assert.equal(hosts(tree, (node) => node.type === "datalist").length, 1);
		assert.equal(hosts(tree, (node) => node.props["data-rh-field-hint"] !== undefined).length, 0);
	});

	test("★ 环境不支持 datalist → 退回纯输入框，不报错", () => {
		const react = createTestReact();
		const { exports } = loadClientModule({ react, windowExtras: { HTMLDataListElement: undefined } });
		assert.equal(exports.supportsDatalist(), false, "桩应报告不支持");
		react.render(
			react.createElement(exports.NodeFieldInput, {
				node: { nodeId: "6", fieldName: "aspect_ratio", valueType: "string", options: ["a", "b"], optionsSource: "inferred-from-default" },
				value: "a",
				onChange: () => {},
			}),
		);
		const tree = react.tree;
		const inputs = hosts(tree, (node) => node.type === "input");
		assert.equal(inputs.length, 1);
		assert.equal(inputs[0].props["data-rh-field-kind"], "plain", "退化成纯输入框");
		assert.equal(hosts(tree, (node) => node.type === "datalist").length, 0);
		assert.equal(hosts(tree, (node) => node.type === "select").length, 0, "也不该退成 select");
	});

	test("同名字段在多个节点并存时 datalist id 唯一", () => {
		const { exports } = loadClientModule();
		/** 从元素树里取 datalist 的 id（元素是普通对象 {type, props}）。 */
		const findId = (element) => {
			const children = Array.isArray(element.props.children) ? element.props.children : [element.props.children];
			for (const child of children) {
				if (child !== null && typeof child === "object" && child.type === "datalist") return child.props.id;
			}
			return null;
		};
		const idA = findId(exports.NodeFieldInput({ node: { nodeId: "6", fieldName: "aspect_ratio", valueType: "string", options: ["a"] }, value: "", onChange: () => {} }));
		const idB = findId(exports.NodeFieldInput({ node: { nodeId: "12", fieldName: "aspect_ratio", valueType: "string", options: ["a"] }, value: "", onChange: () => {} }));
		assert.equal(idA, "rh-opt-6-aspect_ratio");
		assert.equal(idB, "rh-opt-12-aspect_ratio");
		assert.notEqual(idA, idB);
	});

	test("★ 接到节点编辑器：展开工作流后「默认值」用三态控件，改得动", async () => {
		const react = createTestReact();
		const { exports } = loadClientModule({ react });
		const workflow = {
			name: "wf",
			nodes: [
				{
					nodeId: "6",
					classType: "EmptyLatentImage",
					role: "number",
					fieldName: "aspect_ratio",
					label: "画面比例",
					required: false,
					defaultValue: "9:16",
					valueType: "string",
					options: ["9:16 (Portrait Widescreen)", "16:9 (Landscape)"],
					optionsSource: "inferred-from-default",
					note: "可自由输入；已知值：9:16 / 16:9",
				},
			],
			promptOptimizer: { enabled: false },
		};
		react.render(
			react.createElement(exports.components.WorkflowDetail, { workflow: workflow, docs: [], busy: false, onSave: () => {}, onDelete: () => {} }),
		);
		const editButton = hosts(react.tree, (node) => node.props["data-rh-node-edit"] === "6")[0];
		assert.ok(editButton, "节点行应有编辑按钮");
		click(editButton);
		react.rerender();

		const tree = react.tree;
		assert.match(textOf(tree), /默认值/, "编辑器里要有「默认值」字段");
		const input = hosts(tree, (node) => node.type === "input" && node.props["data-rh-field-kind"] === "suggest")[0];
		assert.ok(input, "默认值应是「可选可自由输入」的输入框");
		assert.equal(input.props.list, "rh-opt-6-aspect_ratio");
		assert.equal(input.props.value, "9:16");
		const suggestions = hosts(tree, (node) => node.type === "option").map((node) => node.props.value);
		assert.ok(suggestions.includes("9:16 (Portrait Widescreen)"), "建议项来自宿主给的 options");
		assert.match(textOf(tree), /可自由输入/);
	});
});

describe("枚举选项编辑框（编辑态保留原文，失焦才规范化）", () => {
	/** 挂一个 OptionsEditor，记下上层收到的值。 */
	function mountEditor(initialOptions) {
		const react = createTestReact();
		const { exports } = loadClientModule({ react });
		const committed = [];
		react.render(
			react.createElement(exports.OptionsEditor, {
				node: { nodeId: "6", fieldName: "aspect_ratio", options: initialOptions },
				onCommit: (options) => committed.push(options),
			}),
		);
		/** 当前 textarea 的受控值（就是用户看到的内容）。 */
		const textarea = () => hosts(react.tree, (node) => node.props["data-rh-options-text"] !== undefined)[0];
		const value = () => textarea().props.value;
		/** 真事件驱动：走组件自己的 onChange（模拟浏览器输入 / 回车 / 粘贴）。 */
		const type = (next) => {
			textarea().props.onChange({ target: { value: next }, currentTarget: { value: next } });
			react.rerender();
		};
		const pressEnter = () => type(`${value()}\n`);
		const blur = () => {
			textarea().props.onBlur({ target: textarea() });
			react.rerender();
		};
		return { react, exports, value, type, pressEnter, blur, committed, textarea };
	}

	test("★ 在末尾按回车：内容真的多出一个空行（本 bug 的核心断言）", () => {
		const editor = mountEditor(["a", "b"]);
		assert.equal(editor.value(), "a\nb", "初始是两行");

		editor.pressEnter();
		assert.equal(editor.value(), "a\nb\n", "★ 末尾必须真有一个空行（修复前被 filter 吃掉）");

		editor.pressEnter();
		assert.equal(editor.value(), "a\nb\n\n", "再按一次就是两个空行");
	});

	test("★ 失焦才规范化：空行清掉、去重、保序，并同步回显示文本", () => {
		const editor = mountEditor(["a", "b"]);
		editor.pressEnter();
		editor.pressEnter();
		assert.equal(editor.value(), "a\nb\n\n");

		editor.blur();
		assert.equal(editor.value(), "a\nb", "失焦后空行被清掉（用户看到的就是保存的内容）");
		assert.deepEqual(editor.committed[editor.committed.length - 1], ["a", "b"], "提交给上层的列表不含空行");
	});

	test("★ 粘贴多行：3 行全进、顺序不变（不被折叠）", () => {
		const editor = mountEditor([]);
		editor.type("1:1 (Square)\n2:3 (Portrait Photo)\n3:2 (Photo)");
		assert.equal(editor.value(), "1:1 (Square)\n2:3 (Portrait Photo)\n3:2 (Photo)", "粘贴的 3 行原样保留");
		assert.deepEqual(editor.committed[editor.committed.length - 1], ["1:1 (Square)", "2:3 (Portrait Photo)", "3:2 (Photo)"], "顺序不变");

		// 用户场景：从 RunningHub 页面复制 8 行
		const eight = Array.from({ length: 8 }, (_, index) => `${index + 1}:1 (Ratio ${index + 1})`).join("\n");
		editor.type(eight);
		assert.equal(editor.value(), eight, "8 行一行不少");
		assert.equal(editor.committed[editor.committed.length - 1].length, 8);
	});

	test("★ 全删光：空清单（不是 ['']），不崩", () => {
		const editor = mountEditor(["a", "b"]);
		editor.type("");
		assert.equal(editor.value(), "");
		assert.deepEqual(editor.committed[editor.committed.length - 1], [], "空文本 → 空数组，不能是 ['']");
		editor.blur();
		assert.equal(editor.value(), "");
		assert.deepEqual(editor.committed[editor.committed.length - 1], []);
		// 只剩空行/空白也必须是空清单
		editor.type("\n\n   \n");
		assert.deepEqual(editor.committed[editor.committed.length - 1], [], "只有空行 → 空清单");
	});

	test("编辑态不去重（用户还能看到自己敲的重复行），失焦才去重", () => {
		const editor = mountEditor([]);
		editor.type("a\na\nb");
		assert.equal(editor.value(), "a\na\nb", "编辑态照原样显示");
		editor.blur();
		assert.equal(editor.value(), "a\nb", "失焦后去重");
		assert.deepEqual(editor.committed[editor.committed.length - 1], ["a", "b"]);
	});

	test("不拦截回车（没有 onKeyDown / onKeyPress 把回车吃掉）", () => {
		const editor = mountEditor(["a"]);
		const node = editor.textarea();
		assert.equal(node.props.onKeyDown, undefined, "多行框里回车就是换行，不能拦");
		assert.equal(node.props.onKeyPress, undefined);
	});

	test("纯逻辑：normalizeOptions（trim + 丢空行 + 去重 + 保序）", () => {
		const { exports } = loadClientModule();
		assert.deepEqual(exports.normalizeOptions("  a  \n\n b \na\n"), ["a", "b"]);
		assert.deepEqual(exports.normalizeOptions(""), []);
		assert.deepEqual(exports.normalizeOptions(null), []);
		assert.deepEqual(exports.normalizeOptions("\n\n"), []);
		assert.deepEqual(exports.normalizeOptions("a\r\nb"), ["a", "b"]);
	});

	test("★ aspect_ratio 现在（optionsSource='user' + valueType='enum'）渲染成锁定下拉 <select>", () => {
		const react = createTestReact();
		const { exports } = loadClientModule({ react });
		const realOptions = [
			"1:1 (Square)",
			"2:3 (Portrait Photo)",
			"3:2 (Photo)",
			"3:4 (Portrait)",
			"4:3 (Landscape)",
			"9:16 (Portrait Widescreen)",
			"16:9 (Landscape Widescreen)",
			"21:9 (Ultrawide)",
		];
		react.render(
			react.createElement(exports.NodeFieldInput, {
				node: { nodeId: "6", fieldName: "aspect_ratio", valueType: "enum", options: realOptions, optionsSource: "user" },
				value: "1:1 (Square)",
				onChange: () => {},
			}),
		);
		const selects = hosts(react.tree, (node) => node.type === "select");
		assert.equal(selects.length, 1, "★ 真枚举必须走锁定下拉（分支 ①），与 optionsSource 取值无关");
		assert.equal(selects[0].props["data-rh-field-kind"], "enum");
		assert.equal(hosts(react.tree, (node) => node.type === "input").length, 0);
		assert.equal(hosts(react.tree, (node) => node.type === "datalist").length, 0);
		assert.equal(hosts(react.tree, (node) => node.type === "option").length, 8, "8 个真实比例全在下拉里");
		assert.equal(selects[0].props.value, "1:1 (Square)");
	});
});

describe("任务流水「保留最近 N 条」（tasksLimit）", () => {
	/**
	 * 起 harness：真 ctx + 真 api；calls 记录每次请求的 params。
	 * @param handler 可选的自定义回执 `(params) => result`；不给就是默认行为。
	 * @param options `{ noMethod: true }` = 宿主没有 tasksLimit（老宿主）。
	 */
	async function setupTasks(handler, options = {}) {
		const react = createTestReact();
		const calls = [];
		// 只读回执要**跟着写入走**（真实宿主就是这样），否则会把输入框"弹回"旧值
		let current = 10;
		const namespace =
			options.noMethod === true
				? {}
				: {
						tasksLimit: async (params) => {
							calls.push(params);
							if (handler !== undefined) return { ok: true, value: await handler(params) };
							if (params !== null && typeof params === "object" && "limit" in params) {
								current = params.limit;
								return { ok: true, value: { ok: true, limit: params.limit, removed: [] } };
							}
							return { ok: true, value: { limit: current, count: 7 } };
						},
					};
		const { exports } = loadClientModule({ react });
		const ctx = createStubCtx({ remoteNamespace: namespace, declared: exports.inject });
		await exports.apply(ctx);
		await flushAsync();
		return { react, exports, ctx, calls, api: exports.createApi(ctx) };
	}

	/** 挂 TaskSection（真渲染），并等首次只读落地。 */
	async function mountSection(harness, props = {}) {
		const { react, exports, api } = harness;
		react.render(react.createElement(exports.components.TaskSection, Object.assign({ tasks: [], api: api }, props)));
		await flushAsync();
		await flushAsync();
		react.rerender();
		return react.tree;
	}

	const inputOf = (react) => hosts(react.tree, (node) => node.props["data-rh-task-limit-input"] !== undefined)[0] ?? null;
	const barOf = (react) => hosts(react.tree, (node) => node.props["data-rh-task-limit"] !== undefined)[0] ?? null;
	const errorOf = (react) => hosts(react.tree, (node) => node.props["data-rh-task-limit-error"] !== undefined)[0] ?? null;
	const noticeOf = (react) => hosts(react.tree, (node) => node.props["data-rh-task-limit-notice"] !== undefined)[0] ?? null;

	/** 真事件驱动：改输入框的值。 */
	const type = (react, value) => {
		inputOf(react).props.onChange({ target: { value: value }, currentTarget: { value: value } });
		react.rerender();
	};
	/** 真事件驱动：回车提交（等异步往返落地）。 */
	const pressEnter = async (react) => {
		inputOf(react).props.onKeyDown({ key: "Enter", preventDefault() {} });
		await flushAsync();
		await flushAsync();
		react.rerender();
	};
	/** 真事件驱动：失焦提交。 */
	const blur = async (react) => {
		inputOf(react).props.onBlur({ target: inputOf(react) });
		await flushAsync();
		await flushAsync();
		react.rerender();
	};

	test("API_METHODS：tasksLimit 的 params 是 [limit]", () => {
		const { exports } = loadClientModule();
		assert.deepEqual(exports.API_METHODS.tasksLimit, { host: "tasksLimit", params: ["limit"] });
		// 两条通道共用同一张方法表 → 描述符里也要有
		assert.equal(exports.DESCRIPTORS.map((descriptor) => descriptor.method).includes("tasksLimit"), true);
	});

	test("进面板读一次：显示当前上限与条数，并常驻「0 = 不限制」", async () => {
		const harness = await setupTasks();
		await mountSection(harness);
		const bar = barOf(harness.react);
		assert.ok(bar, "控制条必须渲染出来");
		const text = textOf(bar);
		assert.match(text, /保留最近/);
		assert.match(text, /0 = 不限制/, "必须常驻说明 0 = 不限制");
		assert.match(text, /当前 7 条/, "应显示宿主回的 count");
		assert.match(text, /按完成时间清理/);
		assert.equal(inputOf(harness.react).props.value, "10", "输入框初值 = 当前上限");
		assert.deepEqual(harness.calls, [{}], "进面板只发一次只读请求（params 是空对象）");
	});

	test("★ 输入 25 + 回车 → 恰好一次 {limit:25}，且是数字不是字符串", async () => {
		const harness = await setupTasks();
		await mountSection(harness);
		harness.calls.length = 0;

		type(harness.react, "25");
		assert.equal(harness.calls.length, 0, "只改文本不算提交，不该发请求");
		await pressEnter(harness.react);

		assert.equal(harness.calls.length, 2, "回车：一次写入 + 一次刷新只读");
		assert.deepEqual(harness.calls[0], { limit: 25 });
		assert.equal(typeof harness.calls[0].limit, "number", "★ 必须是数字 25，不能是字符串");
		assert.deepEqual(harness.calls[1], {}, "写入后再读一次刷新 {limit,count}");
		assert.equal(inputOf(harness.react).props.value, "25");
	});

	test("★ 输入 0 → 照发（0 是合法值，不能被真值判断吞掉）", async () => {
		const harness = await setupTasks();
		await mountSection(harness);
		harness.calls.length = 0;

		type(harness.react, "0");
		await pressEnter(harness.react);

		assert.equal(harness.calls.length, 2, "0 必须发出去");
		assert.deepEqual(harness.calls[0], { limit: 0 });
		assert.equal("limit" in harness.calls[0], true, "★ limit 字段必须在（不能因为 0 是假值就被丢）");
	});

	test("失焦提交（与回车等价）", async () => {
		const harness = await setupTasks();
		await mountSection(harness);
		harness.calls.length = 0;
		type(harness.react, "3");
		await blur(harness.react);
		assert.deepEqual(harness.calls[0], { limit: 3 });
	});

	test("★ 非法输入（abc / -1 / 1.5 / 空）→ 不发请求、输入框回滚、给可读提示", async () => {
		const harness = await setupTasks();
		await mountSection(harness);

		for (const bad of ["abc", "-1", "1.5", ""]) {
			harness.calls.length = 0;
			type(harness.react, bad);
			await pressEnter(harness.react);
			assert.equal(harness.calls.length, 0, `「${bad}」不该发请求`);
			assert.equal(inputOf(harness.react).props.value, "10", `「${bad}」应回滚成当前值 10`);
			assert.ok(errorOf(harness.react), `「${bad}」应给出可读提示`);
			assert.match(textOf(errorOf(harness.react)), /0 或正整数/);
		}
	});

	test("★ 返回 removed:['a','b'] → 界面出现「已删除 2 条」", async () => {
		const harness = await setupTasks((params) => {
			if (params !== null && typeof params === "object" && "limit" in params) {
				return { ok: true, limit: params.limit, removed: ["a", "b"] };
			}
			return { limit: 10, count: 10 };
		});
		await mountSection(harness);
		type(harness.react, "5");
		await pressEnter(harness.react);

		const notice = noticeOf(harness.react);
		assert.ok(notice, "应有提示行");
		assert.match(textOf(notice), /已删除 2 条/, "★ 要写清删了几条");
		assert.match(textOf(notice), /较早结束/);
	});

	test("★ 返回 SAVE_FAILED → 可读错误 + 保留旧设置，不崩", async () => {
		const harness = await setupTasks((params) => {
			if (params !== null && typeof params === "object" && "limit" in params) {
				return { ok: false, error: { code: "SAVE_FAILED", message: "磁盘写入失败" } };
			}
			return { limit: 10, count: 7 };
		});
		await mountSection(harness);
		type(harness.react, "99");
		await assert.doesNotReject(async () => {
			await pressEnter(harness.react);
		});

		const error = errorOf(harness.react);
		assert.ok(error, "失败要显示错误");
		assert.match(textOf(error), /SAVE_FAILED/);
		assert.match(textOf(error), /保留条数未修改/);
		assert.equal(inputOf(harness.react).props.value, "10", "失败后回滚显示");
		assert.equal(hosts(harness.react.tree, (node) => node.props["data-rh-section-error"] !== undefined).length, 0, "不该走小节降级");
	});

	test("设置已保存但清理失败时，面板显示实际设置和错误", async () => {
		let current = 10;
		const harness = await setupTasks((params) => {
			if ("limit" in params) {
				current = params.limit;
				return { ok: false, error: { code: "TASK_PRUNE_FAILED", message: "保留条数已保存，但部分记录未能删除" } };
			}
			return { limit: current, count: 7 };
		});
		await mountSection(harness);
		type(harness.react, "2");
		await pressEnter(harness.react);
		assert.equal(inputOf(harness.react).props.value, "2");
		assert.match(textOf(errorOf(harness.react)), /TASK_PRUNE_FAILED/);
		assert.match(textOf(errorOf(harness.react)), /已保存/);
		assert.equal(harness.calls.filter(params => "limit" in params).length, 1);
	});

	test("tasksLimit 不可用（老宿主 / 只读失败）→ 隐藏控制条 + 其余内容照常渲染", async () => {
		// ① 宿主根本没有这个方法
		const noMethod = await setupTasks(undefined, { noMethod: true });
		await mountSection(noMethod, { tasks: [{ taskId: "t-1", status: "SUCCESS", createdAt: Date.now() }] });
		assert.equal(barOf(noMethod.react), null, "没有 tasksLimit 时应隐藏控制条");
		assert.equal(hosts(noMethod.react.tree, (node) => node.props["data-rh-task"] === "t-1").length, 1, "任务列表照常渲染");

		// ② 只读直接抛错
		const failing = await setupTasks(() => {
			throw new Error("宿主炸了");
		});
		await assert.doesNotReject(async () => {
			await mountSection(failing, { tasks: [{ taskId: "t-2", status: "RUNNING", createdAt: Date.now() }] });
		});
		assert.equal(barOf(failing.react), null, "只读失败也应隐藏控制条");
		assert.equal(hosts(failing.react.tree, (node) => node.props["data-rh-task"] === "t-2").length, 1, "其余内容照常");
	});

	test("★ 小节级 ErrorBoundary：控制条渲染崩了只跳过它，其余小节照常", () => {
		const react = createTestReact();
		const { exports } = loadClientModule({ react });
		function Exploding() {
			throw new Error("控制条炸了");
		}
		react.render(
			react.createElement(
				"div",
				null,
				react.createElement(exports.components.SectionBoundary, null, react.createElement(Exploding, null)),
				react.createElement("p", { "data-rh-other": "" }, "其它小节内容"),
			),
		);
		const tree = react.tree;
		assert.equal(hosts(tree, (node) => node.props["data-rh-section-error"] !== undefined).length, 1, "应降级成一行错误");
		assert.match(textOf(tree), /该小节渲染失败/);
		assert.match(textOf(tree), /控制条炸了/);
		assert.equal(hosts(tree, (node) => node.props["data-rh-other"] !== undefined).length, 1, "★ 其它小节照常渲染");
	});

	test("纯逻辑：parseLimitInput / tasksLimitInfo", () => {
		const { exports } = loadClientModule();
		assert.equal(exports.parseLimitInput("0"), 0, "0 是合法值");
		assert.equal(exports.parseLimitInput(" 25 "), 25);
		assert.equal(exports.parseLimitInput(""), null);
		assert.equal(exports.parseLimitInput("abc"), null);
		assert.equal(exports.parseLimitInput("-1"), null);
		assert.equal(exports.parseLimitInput("1.5"), null);
		assert.equal(exports.parseLimitInput("1e3"), null);
		assert.equal(exports.parseLimitInput(null), null);
		assert.deepEqual(exports.tasksLimitInfo({ limit: 10, count: 7 }), { limit: 10, count: 7 });
		assert.deepEqual(exports.tasksLimitInfo({ ok: true, limit: 0, count: 0 }), { limit: 0, count: 0 });
		assert.equal(exports.tasksLimitInfo({ count: 7 }), null, "没有 limit 视为形状不认识");
		assert.equal(exports.tasksLimitInfo(null), null);
		for (const limit of [null, "", true, [], [1], 1.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
			assert.equal(exports.tasksLimitInfo({ limit }), null);
		}
	});
});

describe("api 适配层（Remote 主通道 → HTTP 兜底）", () => {
	/** 造一个只有通用桥的命名空间服务。 */
	function namespaceWithCall(handler) {
		return {
			call: async (params) => handler(params),
		};
	}

	/** 通用桥的成功回执（两层 ok）。 */
	function bridgeOk(value) {
		return { ok: true, value: JSON.stringify({ ok: true, value }) };
	}

	/** 走完 apply() 的 api（与真机装配顺序一致）。 */
	async function setupApi(remoteNamespace, options = {}) {
		const { exports } = loadClientModule({ fetch: options.fetch });
		const ctx = createStubCtx({ remoteNamespace: remoteNamespace ?? null });
		await exports.apply(ctx);
		await flushAsync();
		return { api: exports.createApi(ctx), ctx, exports };
	}

	test("Remote 优先：命名空间可用时一次 HTTP 都不发", async () => {
		const fetch = fetchStub(() => jsonResponse({ ok: true, version: "http" }));
		const { api, ctx } = await setupApi(namespaceWithCall(() => bridgeOk({ version: "remote", dataDir: "D:/x" })), { fetch });

		assert.deepEqual(await api.status(), { version: "remote", dataDir: "D:/x" });
		assert.equal(fetch.calls.length, 0, "Remote 通的时候不该碰 HTTP（真机上每次都会 405）");
		assert.equal(api.transportKind, "remote");
		assert.equal(ctx._remoteNamespaceReads, 0);
	});

	test("Remote 直连方法：一个位置参数 = params 对象（与 host/rpc-remote.mjs 同形）", async () => {
		const seen = [];
		const { api } = await setupApi({
			status: async (params) => {
				seen.push(params);
				return { ok: true, value: { version: "direct" } };
			},
			keysUpdate: async (params) => {
				seen.push(params);
				return { ok: true, value: { updated: true } };
			},
		});
		assert.deepEqual(await api.status(), { version: "direct" });
		assert.deepEqual(seen.at(-1), {}, "零参方法也要传一个 params 对象");
		assert.deepEqual(await api.keys.update("k1", { priority: 5 }), { updated: true });
		assert.deepEqual(seen.at(-1), { id: "k1", patch: { priority: 5 } });
	});

	test("Remote 直连内层业务失败不换通道，也不重复执行修改", async () => {
		const fetch = fetchStub(() => jsonResponse({ ok: true }));
		let writes = 0;
		const { api } = await setupApi({ keysUpdate: async () => {
			writes++;
			return { ok: true, value: { ok: false, error: { code: "SAVE_FAILED", message: "disk full" } } };
		} }, { fetch });
		await assert.rejects(api.keys.update("k1", { priority: 1 }), error => error.code === "SAVE_FAILED" && error.business === true);
		assert.equal(writes, 1);
		assert.equal(fetch.calls.length, 0);
	});

	test("★ 宿主业务码 INTERNAL 必须当业务失败：不许换通道重复执行写操作", async () => {
		// `INTERNAL` 是宿主自己的包装器错误码（host/rpc.mjs 的 dispatch 包装、host/shared.mjs），
		// 不是网关故障。早先客户端把它归进通道故障 → 换 HTTP **再跑一遍** keysUpdate，
		// 而且把真正的失败盖成 HTTP 那次的成功。这条用例把它钉死。
		const fetch = fetchStub(() => jsonResponse({ ok: true, updated: true }));
		let writes = 0;
		const { api } = await setupApi({ keysUpdate: async () => {
			writes++;
			return { ok: false, error: { code: "INTERNAL", message: "boom" } };
		} }, { fetch });
		await assert.rejects(api.keys.update("k1", { priority: 1 }), error => error.code === "INTERNAL" && error.business === true);
		assert.equal(writes, 1, "★ 写操作只许执行一次");
		assert.equal(fetch.calls.length, 0, "★ 不许换通道重跑");
	});

	test("Remote 直连外层网关故障可降级到 HTTP", async () => {
		const fetch = fetchStub(() => jsonResponse({ ok: true, updated: true }));
		const { api } = await setupApi({ keysUpdate: async () => ({ ok: false, error: { code: "gateway/offline", message: "disconnected" } }) }, { fetch });
		assert.deepEqual(await api.keys.update("k1", { priority: 1 }), { ok: true, updated: true });
		assert.equal(fetch.calls.length, 1);
		assert.deepEqual(fetch.calls[0].body, { method: "keysUpdate", params: { id: "k1", patch: { priority: 1 } } });
	});

	test("Remote 通用桥参数形状：call({callJson})，callJson = {method, params}", async () => {
		const seen = [];
		const { api } = await setupApi(
			namespaceWithCall((params) => {
				seen.push(params);
				return { ok: true, value: JSON.stringify({ ok: true, value: { version: "generic" } }) };
			}),
		);
		assert.deepEqual(await api.keys.remove("k9"), { version: "generic" });
		assert.equal(typeof seen[0].callJson, "string");
		assert.deepEqual(JSON.parse(seen[0].callJson), { method: "keysRemove", params: { id: "k9" } });
	});

	test("Remote 业务失败（ok:false）直接抛，带 code，且不换通道重试", async () => {
		const fetch = fetchStub(() => jsonResponse({ ok: true, version: "不应该到这里" }));
		const { api } = await setupApi(
			namespaceWithCall(() => ({ ok: true, value: JSON.stringify({ ok: false, error: { code: "NO_KEY", message: "国内池没有可用 Key" } }) })),
			{ fetch },
		);
		await assert.rejects(
			() => api.status(),
			(error) => {
				assert.equal(error.code, "NO_KEY");
				assert.match(error.message, /国内池没有可用 Key/);
				return true;
			},
		);
		assert.equal(fetch.calls.length, 0, "业务失败不许换通道重试");
	});

	test("Remote 通道级故障（gateway/*）时降级到 HTTP 兜底", async () => {
		const fetch = fetchStub(() => jsonResponse({ ok: true, dataDir: "D:/http", version: "http-fallback" }));
		const { api } = await setupApi(namespaceWithCall(() => ({ ok: false, error: { code: "gateway/offline", message: "载体断开" } })), { fetch });

		const status = await api.status();
		assert.equal(status.version, "http-fallback");
		assert.equal(fetch.calls.length, 1);
		assert.deepEqual(fetch.calls[0].body, { method: "status", params: {} });
		assert.equal(fetch.calls[0].url, "/plugins/dsh-runninghub-plugin/api");
		assert.equal(fetch.calls[0].init.method, "POST");
		assert.equal(fetch.calls[0].init.headers["content-type"], "application/json");
		assert.equal(api.transportKind, "http");
	});

	test("Remote 不可用（未注入）时走 HTTP：body = {method, params}", async () => {
		const fetch = fetchStub(() => jsonResponse({ ok: true }));
		const { api } = await setupApi(null, { fetch });

		await api.keys.update("k1", { priority: 5 });
		assert.deepEqual(fetch.calls[0].body, { method: "keysUpdate", params: { id: "k1", patch: { priority: 5 } } });

		await api.docs.save({ name: "风格", content: "abc" });
		assert.deepEqual(fetch.calls[1].body, { method: "docsSave", params: { doc: { name: "风格", content: "abc" } } });

		await api.tasks.list(20);
		assert.deepEqual(fetch.calls[2].body, { method: "tasksList", params: { limit: 20 } });

		await api.deleteWorkflow("wf-1");
		assert.deepEqual(fetch.calls[3].body, { method: "deleteWorkflow", params: { name: "wf-1" } });
	});

	test("列表类方法直接回 JSON 数组也能用（host dispatch 原样透传数组）", async () => {
		const fetch = fetchStub(() => jsonResponse([{ name: "wf-1" }, { name: "wf-2" }]));
		const { api } = await setupApi(null, { fetch });
		const workflows = await api.listWorkflows();
		assert.ok(Array.isArray(workflows), "应原样返回数组");
		assert.equal(workflows.length, 2);
		assert.deepEqual(fetch.calls[0].body, { method: "listWorkflows", params: {} });
	});

	test("HTTP 兜底也守业务语义：ok:false 直接抛且只发一次请求", async () => {
		const fetch = fetchStub(() => jsonResponse({ ok: false, error: { code: "NO_KEY", message: "没有可用 Key" } }));
		const { api } = await setupApi(null, { fetch });
		await assert.rejects(
			() => api.status(),
			(error) => {
				assert.equal(error.code, "NO_KEY");
				return true;
			},
		);
		assert.equal(fetch.calls.length, 1);
	});

	test("三条通道都没有时报可读错误，而不是 TypeError", async () => {
		const { exports } = loadClientModule();
		const ctx = createStubCtx();
		ctx.get = () => undefined;
		const api = exports.createApi(ctx);
		await assert.rejects(
			() => api.listWorkflows(),
			(error) => {
				assert.equal(error.code, "NO_TRANSPORT");
				// 每个通道一行，且分清"没尝试"与"尝试了失败"（Lead 排查时就是缺这个）
				assert.match(error.message, /Remote：/);
				assert.match(error.message, /HTTP：/);
				assert.match(error.message, /宿主服务：/);
				assert.ok(Array.isArray(error.channels) && error.channels.length >= 3, "error.channels 应逐条列出");
				return true;
			},
		);
	});
});

describe("传输层竞态与诊断（真机 405 的根因）", () => {
	/** 起一个走完 apply() 的 api；注入延迟 / mount 失败 / 静默失败都由 options 控制。 */
	async function setupRace(remoteNamespace, options = {}) {
		const loaded = loadClientModule({ fetch: options.fetch });
		const { exports } = loaded;
		const ctx = createStubCtx({
			remoteNamespace: remoteNamespace ?? null,
			declared: exports.inject,
			injectDelayMs: options.injectDelayMs,
			mountError: options.mountError,
			injectNeverArrives: options.injectNeverArrives,
			mountSwallowsError: options.mountSwallowsError,
		});
		await exports.apply(ctx);
		// ⚠️ 用 apply() 建的那一个 api（同一个 ctx → createApi 返回同一实例），
		//    这样测的才是面板真实走的那条路（同一个就绪门）。
		return { api: exports.createApi(ctx), ctx, exports, loaded };
	}

	test("★ 首屏竞态：$mount 成功但注入延迟 150ms，第一次 status() 仍走 Remote，HTTP 零请求", async () => {
		// 这条就是用户看到的场景：之前首屏没等注入 → 掉 HTTP → desktop 无 webServer → 405
		const fetch = fetchStub(() => jsonResponse({ ok: true, version: "不该走 HTTP" }));
		const { api, ctx } = await setupRace(
			{ status: async () => ({ ok: true, value: { version: "remote-first-paint", dataDir: "D:/rh" } }) },
			{ fetch, injectDelayMs: 150 },
		);

		// 此刻正是竞态窗口：mount 已发生，但注入回调还没被触发
		assert.equal(ctx._injectionsFired, 0, "注入还没发生（这就是真机首屏那个窗口）");
		const started = Date.now();
		const status = await api.status(); // 首屏那次调用
		const elapsed = Date.now() - started;

		assert.deepEqual(status, { version: "remote-first-paint", dataDir: "D:/rh" }, "首屏必须等到 Remote 并拿到数据");
		assert.equal(api.transportKind, "remote");
		assert.equal(fetch.calls.length, 0, "★ 首屏 HTTP 零请求（真机这里会撞 405）");
		assert.ok(elapsed >= 100, `应当真的等到注入（实测 ${elapsed}ms）`);
		assert.equal(ctx._remoteNamespaceReads, 0, "仍然只从注入作用域拿服务");
	});

	test("(b) $mount 抛错：不白等、走 HTTP 兜底，且失败原因可诊断", async () => {
		const fetch = fetchStub(() => jsonResponse({ ok: true, dataDir: "D:/http", version: "http-fallback" }));
		const { api } = await setupRace({ status: async () => ({ ok: true, value: {} }) }, { fetch, mountError: "client api: contribution rejected by host" });

		const started = Date.now();
		const status = await api.status();
		const elapsed = Date.now() - started;

		assert.equal(status.version, "http-fallback");
		assert.equal(api.transportKind, "http");
		assert.ok(elapsed < 500, `$mount 抛错后不能白等 2s（实测 ${elapsed}ms）`);
		// 失败原因必须留下来给状态栏 / 回执引用（旧实现只 console.warn 就丢了）
		assert.match(api.channelReport, /\$mount 失败/);
		assert.match(api.channelReport, /contribution rejected by host/);
	});

	test("★ $mount 被吞掉的错误清单：每条要么判成功态、要么原文进错误框", () => {
		const { exports } = loadClientModule();
		// 这 5 条是 Lead 从源码里列的"会被 $mount 吞掉"的真实错误
		const alreadyMounted = [
			'typert: Remote package "dsh-runninghub-plugin" is already registered',
			'client api: namespace "runninghub" conflicts with an existing Remote namespace',
			"client api: contribution repeats direct method runninghub/status",
			"client api: Remote method runninghub/status is no longer mounted",
		];
		for (const text of alreadyMounted) {
			assert.equal(exports.isAlreadyMountedError(text), true, `应判为"已存在/已注册"（成功态）：${text}`);
		}
		// 这条是真失败：不能判成成功，必须把原文带出去
		const realFailure = "client api: contribution rejected by host";
		assert.equal(exports.isAlreadyMountedError(realFailure), false, "真失败不能判成成功态");
		assert.equal(exports.describeChannelError(realFailure), "failure");
		assert.equal(exports.describeChannelError(alreadyMounted[0]), "already-mounted");
	});

	test("★ 真机形态：$mount 静默失败（resolve 但命名空间没建出来）→ 探测判定为失败并报出真因", async () => {
		const fetch = fetchStub(() => jsonResponse({ ok: true, version: "http-after-silent-failure" }));
		const { api, loaded } = await setupRace(
			{ status: async () => ({ ok: true, value: {} }) },
			{ fetch, mountSwallowsError: "typert: Remote package \"dsh-runninghub-plugin\" is already registered" },
		);
		// 再补一条"没人接收的 Promise 拒绝"，模拟真机上被 $mount 吞掉的那个异常
		loaded.emitWindowEvent("unhandledrejection", {
			reason: new Error('client api: namespace "runninghub" conflicts with an existing Remote namespace'),
		});

		const started = Date.now();
		const status = await api.status();
		const elapsed = Date.now() - started;

		assert.equal(status.version, "http-after-silent-failure", "静默失败后应走 HTTP 兜底");
		assert.equal(api.transportKind, "http");
		assert.ok(elapsed >= 1900, `应等满 ~2s 才放弃（实测 ${elapsed}ms）`);
		// $mount 的 resolve 不可信 → 真实结局靠副作用探测，并写进诊断
		assert.match(api.channelReport, /命名空间 remote\.runninghub 没建出来/);
		assert.equal(api.channelReport.includes("$mount 失败"), false, "这不是抛错路径，而是静默失败路径");
		// ★ 被吞掉的异常必须能捞出来给用户看（浏览器 console 是看不到的）
		const collected = api.listClientErrors();
		assert.equal(collected.length, 1);
		assert.equal(collected[0].kind, "unhandledrejection");
		assert.match(collected[0].msg, /conflicts with an existing Remote namespace/);
	});

	test("★ 错误收集器：有界（最近 10 条）+ 单条截断 + 两种事件都接", async () => {
		const { api, loaded } = await setupRace({ status: async () => ({ ok: true, value: {} }) }, { injectDelayMs: 0 });
		assert.deepEqual(api.listClientErrors(), [], "一开始没有错误");

		loaded.emitWindowEvent("unhandledrejection", { reason: new Error("第一条：Promise 拒绝") });
		loaded.emitWindowEvent("error", { error: new Error("第二条：未捕获异常") });
		loaded.emitWindowEvent("error", { message: "第三条：只有 message 的 error 事件" });
		loaded.emitWindowEvent("unhandledrejection", { reason: "第四条：字符串原因" });
		for (let index = 0; index < 20; index += 1) loaded.emitWindowEvent("error", { message: `噪音 ${index}` });
		loaded.emitWindowEvent("error", { message: "x".repeat(900) });
		loaded.emitWindowEvent("unhandledrejection", { reason: "最后一条：Promise 拒绝" });

		const collected = api.listClientErrors();
		assert.equal(collected.length, 10, "必须有界（只留最近 10 条）");
		assert.equal(collected[0].msg.startsWith("噪音"), true, "最老的已被挤掉");
		assert.equal(collected[collected.length - 1].kind, "unhandledrejection", "unhandledrejection 也要接");
		assert.equal(collected[collected.length - 1].msg, "最后一条：Promise 拒绝");
		assert.equal(
			collected.some((entry) => entry.msg.length === 400 && entry.msg.startsWith("xxx")),
			true,
			"单条截断到 400 字符",
		);
		for (const entry of collected) {
			assert.equal(typeof entry.kind, "string");
			assert.equal(typeof entry.at, "number");
		}
	});

	test("★ 面板把客户端运行期错误显示出来（用户截图就能带真因）", async () => {
		const react = createTestReact();
		const loaded = loadClientModule({ react });
		const { exports } = loaded;
		const ctx = createStubCtx({ remoteNamespace: { status: async () => ({ ok: true, value: {} }) }, declared: exports.inject, mountError: "boom" });
		await exports.apply(ctx);
		// 模拟一个"没人接收的 Promise 拒绝"—— 真机上正是它在 console 里消失
		loaded.emitWindowEvent("unhandledrejection", {
			reason: new Error('typert: Remote package "dsh-runninghub-plugin" is already registered'),
		});

		const registered = bundleConfigOf(ctx).component;
		react.render(react.createElement(registered, { view: "page" }));
		await flushAsync();
		await flushAsync();
		react.rerender();

		const tree = react.tree;
		assert.equal(hosts(tree, (node) => node.props["data-rh-client-errors"] !== undefined).length, 1, "应有折叠错误框");
		const text = textOf(tree);
		assert.match(text, /客户端运行期错误/);
		assert.match(text, /already registered/, "★ 真因原文必须出现在面板上，而不是只进 console");
	});

	test("mount 成功但注入没来：最后靠 `ctx.get` 探测救回来（不误判失败）", async () => {
		const fetch = fetchStub(() => jsonResponse({ ok: true, version: "不该走 HTTP" }));
		const { api } = await setupRace({ status: async () => ({ ok: true, value: { version: "rescued-by-probe" } }) }, { fetch, injectNeverArrives: true });

		const status = await api.status();
		assert.equal(status.version, "rescued-by-probe", "命名空间其实在 → 必须靠探测用上它");
		assert.equal(fetch.calls.length, 0);
		assert.equal(api.transportKind, "remote");
	});

	test("NO_TRANSPORT 回执：每个通道一行，且分清「未尝试」与「尝试失败」", async () => {
		const fetch = fetchStub(() => ({
			ok: false,
			status: 405,
			async text() {
				return "Method Not Allowed";
			},
		}));
		const { api } = await setupRace({ status: async () => ({ ok: true, value: {} }) }, { fetch, mountError: "boom" });

		await assert.rejects(
			() => api.status(),
			(error) => {
				assert.equal(error.code, "NO_TRANSPORT");
				assert.match(error.message, /· Remote：/, "Remote 必须有自己那一行");
				assert.match(error.message, /Remote：.*\$mount 失败：boom/, "Remote 是「未尝试」并写明原因");
				assert.match(error.message, /HTTP：尝试失败：HTTP 405/, "HTTP 是「尝试失败」并写明状态");
				assert.match(error.message, /宿主服务：未尝试/, "宿主服务是「未尝试」");
				assert.equal(error.channels.length >= 3, true);
				return true;
			},
		);
		// 状态栏口径：已判定不可用的 HTTP 也要带原因
		assert.match(api.channelReport, /http（已判定不可用：HTTP 405/);
	});

	test("面板状态栏显示通道诊断（用户截图那行 `通道 —` 不再空白）", async () => {
		const react = createTestReact();
		const { exports } = loadClientModule({ react });
		const ctx = createStubCtx({ remoteNamespace: { status: async () => ({ ok: true, value: {} }) }, declared: exports.inject, mountError: "boom" });
		await exports.apply(ctx);

		const registered = bundleConfigOf(ctx).component;
		react.render(react.createElement(registered, { view: "page" }));
		await flushAsync();
		await flushAsync();
		react.rerender();

		const text = textOf(react.tree);
		assert.match(text, /通道/);
		assert.match(text, /remote（未尝试：\$mount 失败：boom）/, "状态栏必须写明通道为什么不可用");
		assert.match(text, /http（不可用：环境没有 fetch）/);
	});

	test("Remote 就绪后 kind 立刻是 remote（状态栏不再长期显示 http）", async () => {
		const { api } = await setupRace({ status: async () => ({ ok: true, value: { version: "x" } }) }, { injectDelayMs: 30 });
		await api.status();
		assert.equal(api.transportKind, "remote");
		assert.equal(api.channelReport, "remote");
	});
});

describe("崩溃隔离", () => {
	test("api 为 null 时渲染出可读提示，而不是抛异常", () => {
		const react = createTestReact();
		const { exports } = loadClientModule({ react });
		const tree = react.render(react.createElement(exports.components.RunningHubPanelRoot, { api: null }));
		assert.match(textOf(tree), /面板没有拿到宿主接口/);
	});

	test("ErrorBoundary 兜住子组件异常（不拖垮设置页）", () => {
		const react = createTestReact();
		const { exports } = loadClientModule({ react });
		function Exploding() {
			throw new Error("boom");
		}
		const tree = react.render(react.createElement(exports.components.PanelBoundary, null, react.createElement(Exploding, null)));
		const text = textOf(tree);
		assert.match(text, /RunningHub 面板渲染失败/);
		assert.match(text, /boom/);
	});

	test("挂载后的面板能渲染出工作流列表骨架", () => {
		const react = createTestReact();
		const { exports } = loadClientModule({ react });
		const api = {
			transportKind: "remote",
			status: async () => ({ dataDir: "D:/dsh/runninghub", version: "0.1.0", keys: [], pool: { cn: { total: 0, available: 0 }, overseas: { total: 0, available: 0 } }, warnings: [] }),
			listWorkflows: async () => [],
			docs: { list: async () => [] },
			tasks: { list: async () => [] },
			diagnostics: async () => ({}),
		};
		const tree = react.render(react.createElement(exports.components.RunningHubPanelRoot, { api }));
		assert.match(textOf(tree), /RunningHub 工作流/);
		assert.ok(byAttr(tree, "data-rh-panel"), "面板根节点应带 data-rh-panel");
	});

	test("宿主半死不活时状态栏给出可读诊断（coreReady / loadError / warnings）", () => {
		const react = createTestReact();
		const { exports } = loadClientModule({ react });
		const tree = react.render(
			react.createElement(exports.components.StatusBar, {
				status: {
					dataDir: "D:/dsh/runninghub",
					version: "0.1.0",
					region: "cn",
					coreReady: false,
					loadError: "store.mjs 读取失败",
					bridge: "http",
					keys: [{ id: "k1", maskedKey: "rh_****abcd", region: "cn", enabled: true, priority: 10 }],
					pool: { cn: { total: 1, available: 1 }, overseas: { total: 0, available: 0 } },
					warnings: ["海外池没有 Key"],
				},
				transportKind: "http",
				onRefresh() {},
				onDiagnostics() {},
				busy: false,
			}),
		);
		const text = textOf(tree);
		assert.match(text, /宿主核心未就绪/);
		assert.match(text, /store\.mjs 读取失败/);
		assert.match(text, /海外池没有 Key/);
		assert.match(text, /国内 1\/1 可用 · 海外 0\/0 可用/);
		assert.ok(byAttr(tree, "data-rh-host-problem"), "应有宿主问题告警节点");
	});

	test("纯逻辑：余额 / 推断摘要 / 默认值字段名", () => {
		const { exports } = loadClientModule();
		assert.equal(
			exports.balanceText({ remainCoins: 12.5, currency: "RH", currentTaskCounts: 1, apiType: "PLUS" }),
			"余额 12.5 RH · 当前任务 1 · PLUS",
		);
		assert.equal(
			exports.probeSummaryText({ rhWorkflowId: "9001", region: "cn", proposal: { nodes: [1, 2, 3], outputKind: "image", hints: ["a"] } }),
			"推断出 3 个节点 · 输出类型 图 · 地域 国内 · RH 工作流 9001 · 提示 1 条",
		);
		// 宿主用 defaultValue；旧的 default 仍兼容
		assert.equal(exports.nodeDefaultValue({ defaultValue: 7, default: 9 }), 7);
		assert.equal(exports.nodeDefaultValue({ default: 9 }), 9);
		assert.equal(exports.nodeDefaultValue({}), undefined);
	});
});
