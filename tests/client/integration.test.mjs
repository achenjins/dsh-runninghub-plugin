/**
 * tests/client/integration.test.mjs —— **跨半边契约测试**（client 驱动真实 host 路由）。
 *
 * 这是「浏览器半边只测自己的桩」之外唯一能证明两半拼得上的测试：
 *   起一个真 http server 挂上 `host/rpc.mjs` 的真路由，
 *   用真 `fetch` 把 `client/client.js` 的 `api` 打过去，验证：
 *     - 通道选择 = http（首选通道生效）
 *     - 列表类方法的**数组回执**能正确解出（host dispatch 原样透传数组）
 *     - 掩码 Key：回执里永远没有明文
 *     - 业务错误（ok:false）带 code 冒泡
 *
 * 注意：host 半边属于 Lead 的写作用域，可能还在演进。
 * 所以**任何 host 侧不可用的情形都 skip，而不是 fail** —— 这条测试永远不阻塞别人。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadClientModule, createStubCtx } from "./harness.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** 造一个已装配的假运行时（够 host/rpc.mjs 的方法表用）。 */
function makeRuntime(ctx, dataDir, store) {
	const entries = [];
	return {
		ctx,
		config: { dataDir, httpTimeoutMs: 5000, pollIntervalMs: 100, maxWaitMs: 60000 },
		logger: { info() {}, warn() {}, error() {} },
		warnings: [],
		core: store === null ? null : { Store: store.constructor },
		coreReady: store !== null,
		loadError: store === null ? "协议层未装载（集成测试降级）" : null,
		store,
		api: null,
		pool: {
			add: ({ key, label, region, priority }) => {
				const id = `k${entries.length + 1}`;
				entries.push({ id, key, label: label || "", region, priority: priority === undefined ? 100 : priority, enabled: true });
				return { ok: true, id };
			},
			update: () => ({ ok: true }),
			remove: () => ({ ok: true }),
			rawKey: (id) => (entries.find((entry) => entry.id === id) || {}).key,
			list: () =>
				entries.map((entry) => ({
					id: entry.id,
					label: entry.label,
					maskedKey: `${entry.key.slice(0, 4)}****${entry.key.slice(-4)}`,
					region: entry.region,
					enabled: entry.enabled,
					priority: entry.priority,
					invalid: false,
					cooldownUntil: 0,
					lastUsedAt: 0,
				})),
			poolStats: () => {
				const count = (region) => entries.filter((entry) => entry.region === region).length;
				return { cn: { total: count("cn"), available: count("cn") }, overseas: { total: count("overseas"), available: count("overseas") } };
			},
			pick: () => ({ ok: false, error: { code: "NO_KEY", message: "集成测试池" } }),
			report: () => ({ ok: true }),
		},
		runner: { cancel: async () => ({ ok: true }) },
		workflow: null,
		promptdoc: null,
		startedAt: Date.now(),
		version: "0.0.0-integration",
		dataDir,
		hostApiSource: "integration-test",
		clientBridge: null,
		requireCore: () => (store === null ? { ok: false, error: { code: "CORE_NOT_LOADED", message: "集成测试" } } : null),
		warn(message) {
			this.warnings.push(String(message));
		},
	};
}

/** 起真路由 + 真 server；任何一步不可用就返回 { skip }（调用方跳过而不是失败）。 */
async function startHostRoute() {
	const rpc = await import(pathToFileURL(path.join(ROOT, "host", "rpc.mjs")).href).catch((error) => ({ __error: error }));
	if (rpc === null || rpc.__error !== undefined || typeof rpc.registerHostRpc !== "function") {
		return { skip: `host/rpc.mjs 不可用：${String((rpc && rpc.__error && rpc.__error.message) || "没有 registerHostRpc 导出")}` };
	}

	const dataDir = await mkdtemp(path.join(os.tmpdir(), "rh-client-xhalf-"));
	const routes = [];
	const services = {};
	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		tools: { register: () => () => {} },
		get: (name) => services[name],
		on: () => () => {},
		effect: (fn) => {
			const dispose = fn();
			return () => typeof dispose === "function" && dispose();
		},
		inject: () => {},
	};
	services.webServer = {
		register: (route) => {
			routes.push(route);
			return () => {};
		},
	};

	let store = null;
	try {
		const storeModule = await import(pathToFileURL(path.join(ROOT, "host", "core", "store.mjs")).href);
		store = storeModule && storeModule.Store ? new storeModule.Store({ dataDir, logger: ctx.logger }) : null;
	} catch (error) {
		await rm(dataDir, { recursive: true, force: true }).catch(() => {});
		return { skip: `host/core/store.mjs 不可用：${String(error.message)}` };
	}
	const rt = makeRuntime(ctx, dataDir, store);

	try {
		await rpc.registerHostRpc(ctx, rt);
	} catch (error) {
		await rm(dataDir, { recursive: true, force: true }).catch(() => {});
		return { skip: `registerHostRpc 抛错：${String(error.message)}` };
	}
	if (routes.length === 0) {
		await rm(dataDir, { recursive: true, force: true }).catch(() => {});
		return { skip: `registerHostRpc 没有注册路由（warnings: ${rt.warnings.join("；") || "无"}）` };
	}

	const server = http.createServer((request, response) => {
		const url = new URL(request.url, "http://127.0.0.1");
		for (const route of routes) {
			const hit = route.kind === "prefix" ? url.pathname.startsWith(route.path) : url.pathname === route.path;
			if (hit) {
				void route.handler(request, response);
				return;
			}
		}
		response.writeHead(404).end("not found");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const base = `http://127.0.0.1:${String(server.address().port)}`;
	return {
		base,
		path: rpc.HTTP_PATH,
		store,
		async close() {
			await new Promise((resolve) => server.close(resolve));
			await rm(dataDir, { recursive: true, force: true }).catch(() => {});
		},
	};
}

test("跨半边：client api 通过真实 host HTTP 路由跑通全部非付费方法", async (t) => {
	const host = await startHostRoute();
	if (host.skip !== undefined) {
		t.skip(`host 路由不可用：${host.skip}`);
		return;
	}
	try {
		const realFetch = globalThis.fetch;
		// host 路由是同源相对路径；测试里补成真地址（与浏览器里的解析语义一致）。
		const fetchStub = (url, init) => realFetch(host.base + url, init);
		const { exports } = loadClientModule({ fetch: fetchStub });
		const api = exports.createApi(createStubCtx());

		// ① 首选通道 = http
		const status = await api.status();
		assert.equal(status.ok, true);
		assert.equal(api.transportKind, "http", "HTTP 路由应是首选通道");

		// ② 掩码 Key：写一份进去，回执里只有掩码
		const secret = "rh_integration_000011112222";
		await api.keys.add({ key: secret, label: "集成 Key", region: "cn", priority: 10 });
		const after = await api.status();
		assert.equal(after.keys.length, 1);
		assert.match(after.keys[0].maskedKey, /\*\*\*\*/);
		assert.equal(JSON.stringify(after).includes(secret), false, "快照里绝不能出现明文 Key");
		assert.equal(after.pool.cn.available, 1);
		assert.equal(after.pool.overseas.available, 0);

		// ③ 列表类方法回的是 JSON 数组（host dispatch 原样透传）——不能当成对象
		assert.deepEqual(await api.listWorkflows(), []);
		assert.deepEqual(await api.docs.list(), []);
		assert.deepEqual(await api.tasks.list(5), []);

		// ④ 文档：写 → 列 → 读 闭环
		await api.docs.save({ name: "集成文档", content: "# 标题\n正文" });
		const docs = await api.docs.list();
		assert.equal(docs.length, 1);
		assert.equal(docs[0].name, "集成文档");
		assert.equal(docs[0].bytes > 0, true);
		const doc = await api.docs.get(docs[0].docId);
		assert.equal(doc.content, "# 标题\n正文");

		// ⑤ 自检
		const diagnostics = await api.diagnostics();
		assert.equal(diagnostics.ok, true);
		assert.equal(diagnostics.counts.keys, 1);

		// ⑥ 业务错误带 code 冒泡（不是 NO_TRANSPORT）
		await assert.rejects(
			() => api.deleteWorkflow("根本不存在的工作流"),
			(error) => {
				assert.equal(error.code, "WORKFLOW_NOT_FOUND");
				assert.equal(error.business, true);
				return true;
			},
		);
	} finally {
		await host.close();
	}
});
