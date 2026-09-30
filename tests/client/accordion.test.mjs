/**
 * tests/client/accordion.test.mjs —— 用户点名要的硬行为：
 *
 *   「配置的页面简洁点，不要所有工作流都展开，选择一个工作流栏才会展开显示具体节点」
 *
 * 因此这里既测纯逻辑 reducer，也**真渲染**组件、真点按钮：
 *   1. 三个工作流进来时，默认全部折叠（0 个详情节点）；
 *   2. 点第 2 行 → 只有第 2 行展开；
 *   3. 再点第 3 行 → 第 2 行收起、第 3 行展开（同时只展开一个）；
 *   4. 点已展开的第 3 行 → 全部收起。
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { loadClientModule, hosts, click, textOf } from "./harness.mjs";

/** 三个工作流：名字、节点 id 全部互不相同，便于断言"谁被渲染了"。 */
function makeWorkflows() {
	const kinds = ["image", "video", "audio"];
	return [1, 2, 3].map((n) => ({
		name: `工作流${n}`,
		displayNameEn: `wf-${n}`,
		outputKind: kinds[n - 1],
		description: `第 ${n} 个`,
		nodeCount: 2,
		rhWorkflowId: `900${n}`,
		region: "cn",
		nodes: [
			{
				nodeId: `${n}01`,
				classType: "CLIPTextEncode",
				role: "prompt",
				fieldName: "text",
				label: `正向提示词${n}`,
				required: true,
				defaultValue: n === 1 ? "一只猫" : undefined,
				default: n === 1 ? undefined : "一只狗", // 兼容旧字段名
				group: "提示词",
			},
			{
				nodeId: `${n}02`,
				classType: "KSampler",
				role: "seed",
				fieldName: "seed",
				required: false,
				default: 42,
				min: 0,
				max: 100,
				step: 1,
			},
		],
		promptOptimizer: {
			enabled: n === 2,
			docId: null,
			asSubagentSystemPrompt: false,
			targetNodeId: null,
			extraInstruction: "",
		},
	}));
}

/** 渲染 WorkflowSection 并返回 { tree, rerender, rows() , details() } 。 */
function mountSection(exports, react, overrides = {}) {
	const props = Object.assign(
		{
			workflows: makeWorkflows(),
			docs: [{ docId: "d1", name: "风格指南" }],
			busy: null,
			onSave: () => {},
			onDelete: () => {},
			onProbe: async () => null,
		},
		overrides,
	);
	const renderer = react;
	let tree = renderer.render(react.createElement(exports.components.WorkflowSection, props));
	const api = {
		tree: () => tree,
		rows: () => hosts(tree, (node) => node.props["data-rh-wf-row"] !== undefined),
		details: () => hosts(tree, (node) => node.props["data-rh-wf-detail"] !== undefined),
		expandedIds: () =>
			hosts(tree, (node) => node.props["data-rh-wf-row"] !== undefined && node.props["data-rh-expanded"] === "true").map(
				(node) => node.props["data-rh-wf-row"],
			),
		row: (id) => hosts(tree, (node) => node.props["data-rh-wf-row"] === id)[0] ?? null,
		click: (id) => {
			click(api.row(id));
			tree = renderer.rerender();
		},
		rerender: () => {
			tree = renderer.rerender();
		},
		text: () => textOf(tree),
		hasNode: (nodeId) => hosts(tree, (node) => node.props["data-rh-node"] === nodeId).length > 0,
	};
	return api;
}

describe("toggleExpanded（纯逻辑）", () => {
	test("点第 2 个 → 只有 2 开；再点 3 → 2 关 3 开；点已开的 2 → 全关", async () => {
		const { exports } = loadClientModule();
		const toggle = exports.toggleExpanded;

		let state = null; // 初始：全部折叠
		assert.equal(state, null);

		state = toggle(state, "2");
		assert.equal(state, "2", "点 2 → 只有 2 开");

		state = toggle(state, "3");
		assert.equal(state, "3", "再点 3 → 2 关、3 开（同时只开一个）");

		state = toggle(state, "3");
		assert.equal(state, null, "点已展开的 3 → 全关");
	});

	test("对象形态的状态也能用，且不改原对象", () => {
		const { exports } = loadClientModule();
		const before = { expandedId: "a", other: 1 };
		const after = exports.toggleExpanded(before, "b");
		assert.equal(after.expandedId, "b");
		assert.equal(after.other, 1);
		assert.equal(before.expandedId, "a", "不应就地修改");
		assert.equal(exports.toggleExpanded({ expandedId: "b" }, "b").expandedId, null);
		assert.equal(exports.expandedIdOf(null), null);
		assert.equal(exports.expandedIdOf({ expandedId: "x" }), "x");
	});
});

describe("WorkflowSection（真渲染 + 真点击）", () => {
	test("三个工作流默认全部折叠，只渲染一行摘要", () => {
		const react = loadClientModule().react;
		const { exports } = loadClientModule({ react });
		const view = mountSection(exports, react);

		assert.equal(view.rows().length, 3, "应有三行");
		assert.deepEqual(view.expandedIds(), [], "默认不能有任何一行是展开的");
		assert.equal(view.details().length, 0, "默认不能渲染任何节点详情");
		assert.equal(view.hasNode("101"), false, "未展开的工作流不应渲染节点");
		assert.equal(view.hasNode("201"), false);

		// 摘要行：名称 + outputKind 徽章 + 节点数 + 提示词优化状态
		const text = view.text();
		assert.match(text, /工作流1/);
		assert.match(text, /工作流2/);
		assert.match(text, /视频/);
		assert.match(text, /2 节点/);
		assert.match(text, /提示词优化 关/);
		assert.match(text, /提示词优化 开/);
	});

	test("点第 2 行 → 只有第 2 行展开（节点表出现）", () => {
		const react = loadClientModule().react;
		const { exports } = loadClientModule({ react });
		const view = mountSection(exports, react);

		view.click("工作流2");

		assert.deepEqual(view.expandedIds(), ["工作流2"], "只有第 2 行展开");
		assert.equal(view.details().length, 1, "同时只展开一个");
		assert.equal(view.details()[0].props["data-rh-wf-detail"], "工作流2");
		assert.equal(view.hasNode("201"), true, "展开后应渲染第 2 个工作流的节点");
		assert.equal(view.hasNode("101"), false, "第 1 个工作流仍未展开");
		assert.equal(view.hasNode("301"), false, "第 3 个工作流仍未展开");
	});

	test("再点第 3 行 → 第 2 行收起、第 3 行展开", () => {
		const react = loadClientModule().react;
		const { exports } = loadClientModule({ react });
		const view = mountSection(exports, react);

		view.click("工作流2");
		view.click("工作流3");

		assert.deepEqual(view.expandedIds(), ["工作流3"], "展开 3 时 2 必须自动收起");
		assert.equal(view.details().length, 1);
		assert.equal(view.details()[0].props["data-rh-wf-detail"], "工作流3");
		assert.equal(view.hasNode("201"), false, "第 2 个工作流的节点必须消失");
		assert.equal(view.hasNode("301"), true);
	});

	test("点已展开的第 2 行 → 全部收起", () => {
		const react = loadClientModule().react;
		const { exports } = loadClientModule({ react });
		const view = mountSection(exports, react);

		view.click("工作流2");
		view.click("工作流2");

		assert.deepEqual(view.expandedIds(), []);
		assert.equal(view.details().length, 0);
		assert.equal(view.hasNode("201"), false);
	});

	test("展开内容：分组 + 节点表格列 + 提示词优化表单", () => {
		const react = loadClientModule().react;
		const { exports } = loadClientModule({ react });
		const view = mountSection(exports, react);
		view.click("工作流1");
		const text = view.text();

		// 分组（§4：提示词 / 参考素材 / 参数 / 其它）
		for (const group of ["提示词", "参数"]) assert.match(text, new RegExp(group), `缺少分组 ${group}`);
		// 节点表格的关键列
		for (const column of ["节点", "类型", "角色", "字段", "默认值", "范围 / 枚举", "必填"]) {
			assert.match(text, new RegExp(column.replace("/", "\\/")), `缺少列 ${column}`);
		}
		assert.match(text, /CLIPTextEncode/);
		assert.match(text, /正向提示词/);
		assert.match(text, /一只猫/);
		assert.match(text, /min 0 · max 100 · step 1/);
		// 提示词优化表单
		assert.match(text, /启用提示词优化/);
		assert.match(text, /风格指南/, "文档下拉应列出已存文档");
		assert.match(text, /无工具极简子代理/);
	});

	test("节点行的『编辑』打开内联编辑器（role / label / options 等字段）", () => {
		const react = loadClientModule().react;
		const { exports } = loadClientModule({ react });
		const view = mountSection(exports, react);
		view.click("工作流1");

		const buttons = hosts(view.tree(), (node) => node.props["data-rh-node-edit"] === "101");
		assert.equal(buttons.length, 1, "每个节点行应有一个『编辑』按钮");
		click(buttons[0]);
		view.rerender();
		const editor = hosts(view.tree(), (node) => node.props["data-rh-node-editor"] === "101");
		assert.equal(editor.length, 1, "点编辑后应出现内联编辑器");
		// 编辑器里能改 role / label / options / group
		const text = textOf(view.tree());
		for (const field of ["角色", "显示名 label", "枚举 options（一行一个）", "分组 group", "必填"]) {
			assert.match(text, new RegExp(field.replace(/[()]/g, "\\$&")), `内联编辑器缺少 ${field}`);
		}
		const optionTexts = hosts(view.tree(), (node) => node.type === "option").map((node) => textOf(node));
		for (const role of ["prompt", "negative_prompt", "image", "video", "audio", "number", "select", "boolean", "seed", "other"]) {
			const label = `${exports.roleLabel(role)}（${role}）`;
			assert.ok(optionTexts.includes(label), `role 下拉缺少 ${label}`);
		}
	});

	test("busy 时保存按钮禁用（防连点）", () => {
		const react = loadClientModule().react;
		const { exports } = loadClientModule({ react });
		const view = mountSection(exports, react, { busy: "工作流1" });
		view.click("工作流1");
		const save = hosts(view.tree(), (node) => node.props["data-rh-wf-save"] === "工作流1")[0];
		assert.ok(save, "应有保存按钮");
		assert.equal(save.props.disabled, true);
	});
});
