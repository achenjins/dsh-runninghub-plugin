/**
 * tests/core/workflow.test.mjs —— `host/core/workflow.mjs` 的契约锁定
 *
 * **用真实工作流 JSON**（`tests/fixtures/Qwen-Image-2.1-*.json`，随仓库分发）：
 * 它们是 ComfyUI **UI 格式**（带 `nodes` + `definitions.subgraphs`），所以这里同时锁定了
 * 「UI 格式 → API 格式」的 subgraph 展开，以及 `nodesOf()` 里的 7 条角色推断规则。
 *
 * 另外用**手写的 API 格式**夹具锁定 `{"__value__":[...]}` 包装、枚举提示、以及 `buildNodeInfoList` 形状。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  analyzeWorkflow,
  normalizeWorkflow,
  buildNodeInfoList,
  validateRun,
  summarizeRoles,
  inferOutputs,
  unwrapValue,
  isOverridable,
  alignWidgets,
  defaultValues,
  draftConfig,
  stringifyValue,
  looksCategorical,
  dedupeNodes,
  nodeScore,
  explicitOptionsOf,
  ROLES,
} from '../../host/core/workflow.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/**
 * 真实工作流夹具的目录 —— **在仓库内**（`tests/fixtures/`）。
 *
 * ⚠️ 早先这里指向仓库**外面**的工作区（`../../../workflows`），于是本机全绿、
 * **别人克隆下来 13 个测试直接红**（文件不存在）。
 * 「测试读仓库外的路径」是发布前最容易漏的一类洞：本机永远发现不了。
 *
 * 夹具已收进 `tests/fixtures/`（约 141 KB，已确认不含绝对路径 / 账号痕迹 / 上传文件名）。
 */
const FIXTURES = path.resolve(HERE, '..', 'fixtures')

/** 读一个真实工作流 JSON（夹具缺失时给出可判的错误，而不是一句 ENOENT）。 */
function readWf(name) {
  const p = path.join(FIXTURES, name)
  if (!fs.existsSync(p)) {
    throw new Error('测试夹具缺失：' + p + '（夹具随仓库分发，见 tests/fixtures/）')
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

const T2I = () => readWf('Qwen-Image-2.1-T2I.json')
const EDIT = () => readWf('Qwen-Image-2.1-Image-Edit.json')
const BG = () => readWf('Qwen-Image-2.1-Remove-Background.json')

/* ═══════════════════════ 真实工作流：subgraph 展开 ═══════════════════════ */

test('normalizeWorkflow：真实 UI 格式工作流能展开成 API 格式（subgraph 展开）', () => {
  const r = normalizeWorkflow(T2I())
  assert.equal(r.ok, true)
  assert.equal(r.source, 'ui')
  // 顶层 5 个节点里有 2 个 MarkdownNote（纯前端）被丢掉，剩下 ResolutionSelector + subgraph(1) + SaveImageAdvanced
  const ids = Object.keys(r.api)
  assert.ok(ids.includes('13'), 'ResolutionSelector 应在')
  assert.ok(ids.includes('461'), 'SaveImageAdvanced 应在')
  assert.ok(ids.some((i) => i.startsWith('459:')), 'subgraph 内部节点应被展平为 459:*')
  assert.equal(ids.includes('463'), false, 'MarkdownNote 必须被丢掉')
  assert.equal(ids.includes('468'), false, 'MarkdownNote 必须被丢掉')
  // 内部关键节点都在
  const flat = ids.filter((i) => i.startsWith('459:')).sort()
  assert.deepEqual(flat, ['459:451', '459:452', '459:453', '459:454', '459:456', '459:457', '459:458'])
  assert.equal(r.api['459:456'].class_type, 'EmptyLatentImage')
  assert.equal(r.api['459:458'].class_type, 'KSampler')
})

test('subgraph 展开：host 的 widgets_values 严格灌进 subgraph 的非媒体入参（12/12）', () => {
  const r = normalizeWorkflow(T2I())
  assert.equal(r.ok, true)
  // 实测对应关系：prompt / negative_prompt / cfg / steps / width / height /
  //                scheduler / scheduler_1 / seed / unet_name / clip_name / vae_name
  assert.equal(r.api['459:451'].inputs.unet_name, 'qwen_image_2.1_int8_convrot.safetensors')
  assert.equal(r.api['459:453'].inputs.clip_name, 'qwen3vl_8b_int8_convrot.safetensors')
  assert.equal(r.api['459:454'].inputs.vae_name, 'qwen_image_2.1_vae_bf16.safetensors')
  assert.equal(r.api['459:456'].inputs.width, 1024)
  assert.equal(r.api['459:456'].inputs.height, 1024)
  assert.equal(r.api['459:458'].inputs.seed, 593103825222985)
  assert.equal(r.api['459:458'].inputs.steps, 25)
  assert.equal(r.api['459:458'].inputs.cfg, 1)
  assert.equal(r.api['459:458'].inputs.sampler_name, 'euler')
  assert.equal(r.api['459:458'].inputs.scheduler, 'simple')
  assert.match(r.api['459:452'].inputs.prompt, /^Greyscale fashion editorial/)
  assert.equal(r.api['459:452'].inputs.negative_prompt, '')
})

test('subgraph 展开：媒体入参（IMAGE）不占 widgets_values，改走外部连线', () => {
  const r = normalizeWorkflow(EDIT())
  assert.equal(r.ok, true)
  // 16 个非媒体入参 ↔ 16 个 widgets_values（实测）；Edit 子图里的文本编码节点是 #474
  assert.match(r.api['459:474'].inputs.prompt, /^Keep the character/)
  assert.equal(r.api['459:458'].inputs.cfg, 1)
  assert.equal(r.api['459:458'].inputs.seed, 1070478148268574)
  assert.equal(r.api['459:469'].inputs.device, 'auto')
  assert.equal(r.api['459:469'].inputs.dtype, 'default')
  // 顶层两个 LoadImage 被保留
  assert.equal(r.api['470'].class_type, 'LoadImage')
  assert.equal(r.api['475'].class_type, 'LoadImage')
})

test('alignWidgets：跳过 control_after_generate，忽略尾部多余 widget', () => {
  // KSampler 真实数据
  assert.deepEqual(alignWidgets(['seed', 'steps', 'cfg', 'sampler_name', 'scheduler'], [0, 'fixed', 25, 1, 'euler', 'simple', 1]), [0, 25, 1, 'euler', 'simple'])
  // EmptyLatentImage 真实数据（尾部 batch_size 无对应字段）
  assert.deepEqual(alignWidgets(['width', 'height'], [1024, 1024, 1]), [1024, 1024])
  // 一一对应
  assert.deepEqual(alignWidgets(['a', 'b'], [1, 2]), [1, 2])
})

/* ═══════════════════════ 真实工作流：角色推断 ═══════════════════════ */

test('analyzeWorkflow(T2I)：识别正向/负向提示词、宽高、seed/steps/cfg', () => {
  const r = analyzeWorkflow(T2I())
  assert.equal(r.ok, true)
  assert.equal(r.outputKind, 'image')
  assert.equal(r.hints.source, 'ui')
  assert.ok(r.nodeCount > 5)

  const roles = summarizeRoles(r.nodes)
  assert.equal(roles.prompt, 1, '恰好一个主提示词')
  assert.equal(roles.negative_prompt, 1)
  assert.ok(roles.number >= 3)

  // 正向提示词
  const p = r.nodes.find((n) => n.role === 'prompt')
  assert.equal(p.nodeId, '459:452')
  assert.equal(p.fieldName, 'prompt')
  assert.equal(p.valueType, 'string')
  assert.equal(p.required, true)
  assert.match(p.default, /^Greyscale fashion editorial/)
  // 负向提示词（同节点另一字段）
  const neg = r.nodes.find((n) => n.role === 'negative_prompt')
  assert.equal(neg.nodeId, '459:452')
  assert.equal(neg.fieldName, 'negative_prompt')
  assert.equal(neg.default, '')

  // EmptyLatentImage 的宽高
  const w = r.nodes.find((n) => n.fieldName === 'width')
  const h = r.nodes.find((n) => n.fieldName === 'height')
  assert.equal(w.nodeId, '459:456')
  assert.equal(w.default, 1024)
  assert.equal(w.valueType, 'number')
  assert.equal(w.min, 64)
  assert.equal(w.max, 4096)
  assert.equal(w.step, 8)
  assert.equal(h.nodeId, '459:456')
  assert.equal(h.default, 1024)

  // KSampler 的 seed/steps/cfg
  const seed = r.nodes.find((n) => n.role === 'seed')
  assert.equal(seed.nodeId, '459:458')
  assert.equal(seed.fieldName, 'seed')
  assert.equal(seed.default, 593103825222985)
  const steps = r.nodes.find((n) => n.fieldName === 'steps')
  assert.equal(steps.nodeId, '459:458')
  assert.equal(steps.default, 25)
  const cfg = r.nodes.find((n) => n.fieldName === 'cfg')
  assert.equal(cfg.default, 1)

  // hints 指向
  assert.equal(r.hints.promptNodeId, '459:452')
  assert.equal(r.hints.negativeNodeId, '459:452')
  assert.equal(r.hints.widthNodeId, '459:456')
  assert.equal(r.hints.seedNodeId, '459:458')
  assert.equal(r.hints.hasPrompt, true)
  assert.equal(r.hints.needsMedia, false)
})

test('analyzeWorkflow(Edit)：识别出 LoadImage 素材节点 + needsMedia', () => {
  const r = analyzeWorkflow(EDIT())
  assert.equal(r.ok, true)
  assert.equal(r.outputKind, 'image')
  const media = r.nodes.filter((n) => n.role === 'image')
  assert.equal(media.length, 2, '两个 LoadImage')
  assert.deepEqual(media.map((n) => n.nodeId), ['470', '475'])
  assert.equal(media[0].fieldName, 'image')
  assert.equal(media[0].required, true, '第一张图是编辑目标 → 必填')
  assert.equal(media[1].required, false, '后续槽位是可选的参考图')
  assert.equal(r.hints.needsMedia, true)
  // 子图内部的文本字段也识别到了（Edit 子图里是 #474）
  const p = r.nodes.find((n) => n.role === 'prompt')
  assert.equal(p.nodeId, '459:474')
  assert.match(p.default, /^Keep the character/)
})

test('analyzeWorkflow(Remove-Background)：同样识别（与 Edit 共用子图）', () => {
  const r = analyzeWorkflow(BG())
  assert.equal(r.ok, true)
  assert.equal(r.outputKind, 'image')
  assert.equal(r.nodes.filter((n) => n.role === 'image').length, 1)
  assert.match(r.nodes.find((n) => n.role === 'prompt').default, /^Remove the background/)
})

/*
 * 这里原本有一条「研究阶段留的两份副本与主副本是同一份数据、分析结果必须一致」的测试。
 * 那些副本当初放在**仓库外面**，夹具收进 `tests/fixtures/` 之后只剩一份权威副本，
 * 这条"两份副本要一致"的检查自然失去意义 —— 已删除，
 * 换成下面一条更有用的：**同一份输入必须产出确定性的结果**。
 */
test('analyzeWorkflow 对同一份输入是确定性的（跑两次结果完全一致）', () => {
  for (const [name, wf] of [['T2I', T2I()], ['Edit', EDIT()], ['BG', BG()]]) {
    const a = analyzeWorkflow(wf)
    const b = analyzeWorkflow(wf)
    assert.equal(a.ok, true, name)
    assert.equal(b.outputKind, a.outputKind, name)
    assert.deepEqual(b.nodes, a.nodes, name + '：同一份工作流两次分析必须逐字相同')
  }
})

test('三个真实工作流：node 形状必须完全符合协议层约定', () => {
  const allowedRoles = new Set(ROLES)
  for (const wf of [T2I(), EDIT(), BG()]) {
    const r = analyzeWorkflow(wf)
    assert.equal(r.ok, true)
    for (const n of r.nodes) {
      assert.equal(typeof n.nodeId, 'string', JSON.stringify(n))
      assert.equal(typeof n.classType, 'string')
      assert.equal(typeof n.title, 'string')
      assert.ok(allowedRoles.has(n.role), '未知 role: ' + n.role)
      assert.equal(typeof n.fieldName, 'string')
      assert.equal(typeof n.label, 'string')
      assert.equal(typeof n.required, 'boolean')
      assert.ok(['string', 'number', 'boolean', 'enum'].includes(n.valueType), '未知 valueType: ' + n.valueType)
      assert.equal(typeof n.group, 'string')
      assert.equal(typeof n.note, 'string')
      assert.equal(typeof n.overridable, 'boolean')
      if (n.valueType === 'number') {
        assert.equal(typeof n.min, 'number')
        assert.equal(typeof n.max, 'number')
      }
      if (n.valueType === 'enum') assert.ok(Array.isArray(n.options))
      // lossless：不能有 undefined 值
      assert.deepEqual(JSON.parse(JSON.stringify(n)), n)
    }
  }
})

/* ═══════════════════════ API 格式夹具（__value__ / 枚举 / 各规则） ═══════════════════════ */

/** 一份典型的「官方 getJsonApiFormat」API 格式夹具。 */
function apiFixture() {
  return {
    '3': {
      class_type: 'KSampler',
      inputs: {
        seed: 156680208700286,
        steps: 20,
        cfg: 8,
        sampler_name: 'euler',
        scheduler: 'normal',
        denoise: 1,
        model: ['4', 0],
        positive: ['6', 0],
        negative: ['7', 0],
        latent_image: ['5', 0],
      },
      _meta: { title: 'KSampler' },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: { __value__: ['a beautiful cat', true] }, clip: ['4', 1] }, _meta: { title: 'CLIP Text Encode (Prompt)' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry, bad', clip: ['4', 1] }, _meta: { title: 'Negative Prompt' } },
    '8': { class_type: 'SaveImage', inputs: { filename_prefix: 'ComfyUI', images: ['9', 0] } },
  }
}

test('normalizeWorkflow：接受 API 格式 / JSON 字符串 / 外层 {code,data:{prompt}}', () => {
  const api = apiFixture()
  assert.equal(normalizeWorkflow(api).source, 'api')
  assert.equal(normalizeWorkflow(JSON.stringify(api)).ok, true)
  const wrapped = normalizeWorkflow({ code: 0, data: { prompt: JSON.stringify(api) } })
  assert.equal(wrapped.ok, true)
  assert.equal(wrapped.source, 'wrapper')
  assert.equal(wrapped.api['6'].class_type, 'CLIPTextEncode')
  const wrappedObj = normalizeWorkflow({ code: 200, data: { prompt: api } })
  assert.equal(wrappedObj.ok, true)
})

test('normalizeWorkflow：失败时返回 {ok:false,error} 而不是抛', () => {
  assert.equal(normalizeWorkflow('{ 不是 json').ok, false)
  assert.equal(normalizeWorkflow(42).ok, false)
  assert.equal(normalizeWorkflow({}).ok, false)
  assert.equal(normalizeWorkflow({ foo: 'bar' }).ok, false)
  assert.equal(normalizeWorkflow({ data: { prompt: '{{{' } }).ok, false)
  const r = normalizeWorkflow(null)
  assert.equal(r.ok, false)
  assert.equal(typeof r.error.message, 'string')
})

test('unwrapValue / isOverridable：`{"__value__":[值,可编辑]}` 包装（排雷 §6）', () => {
  assert.deepEqual(unwrapValue({ __value__: [false, true] }), { value: false, wrapped: true, editable: true })
  assert.equal(isOverridable({ __value__: [false, true] }), true)
  assert.equal(isOverridable({ __value__: ['x', false] }), false)
  assert.equal(isOverridable('裸值'), false)
  assert.deepEqual(unwrapValue({ __value__: ['', true] }), { value: '', wrapped: true, editable: true })
  assert.deepEqual(unwrapValue(7), { value: 7, wrapped: false, editable: false })
  assert.deepEqual(unwrapValue({ __value__: [] }), { value: null, wrapped: true, editable: true })
})

test('规则 1：text 为空串 → negative_prompt；标题含 Negative → negative_prompt', () => {
  const r = analyzeWorkflow(apiFixture())
  assert.equal(r.ok, true)
  const pos = r.nodes.filter((n) => n.role === 'prompt')
  const neg = r.nodes.filter((n) => n.role === 'negative_prompt')
  assert.equal(pos.length, 1)
  assert.equal(pos[0].nodeId, '6')
  assert.equal(pos[0].default, 'a beautiful cat', '__value__ 必须被还原成裸值')
  assert.equal(pos[0].overridable, true, '__value__[1]=true → 可覆盖')
  assert.equal(neg.length, 1)
  assert.equal(neg[0].nodeId, '7')
  assert.equal(neg[0].default, 'blurry, bad')
  assert.equal(neg[0].overridable, false)

  // 只有 text，且是空串、标题中性 → 判为 negative（规则 1）
  const only = analyzeWorkflow({ '1': { class_type: 'CLIPTextEncode', inputs: { text: '' }, _meta: { title: 'CLIP Text Encode' } } })
  assert.equal(only.nodes.filter((n) => n.role === 'negative_prompt').length, 1)
  assert.equal(only.nodes.filter((n) => n.role === 'prompt').length, 0)
})

test('规则 4/5/6：KSampler 的 seed/steps/cfg、EmptyLatent 宽高、枚举 options 只来自已有取值', () => {
  const r = analyzeWorkflow(apiFixture())
  const seed = r.nodes.find((n) => n.role === 'seed')
  assert.equal(seed.default, 156680208700286)
  const steps = r.nodes.find((n) => n.fieldName === 'steps')
  assert.equal(steps.default, 20)
  assert.equal(steps.min, 1)
  assert.equal(steps.max, 200)
  const cfg = r.nodes.find((n) => n.fieldName === 'cfg')
  assert.equal(cfg.default, 8)
  assert.equal(cfg.step, 0.5)

  const w = r.nodes.find((n) => n.fieldName === 'width')
  assert.equal(w.nodeId, '5')
  assert.equal(w.default, 512)
  assert.equal(w.step, 8)

  const sampler = r.nodes.find((n) => n.fieldName === 'sampler_name')
  assert.equal(sampler.role, 'select')
  // ⚠️ **这条断言在 task-9 改过**：旧期望是 `valueType === 'enum'`，那是**编码了 bug 的化石** ——
  //    JSON 里只有 `"euler"` 一个值、没有候选清单，把它当枚举就会把字段锁死
  //    （用户改不了采样器）。正确的是降级成可自由输入的 string，`options` 只作建议值。
  assert.equal(sampler.valueType, 'string')
  assert.equal(sampler.optionsSource, 'inferred-from-default')
  assert.deepEqual(sampler.options, ['euler'], '建议值要保留')
  const sched = r.nodes.find((n) => n.fieldName === 'scheduler')
  assert.deepEqual(sched.options, ['normal'])
  assert.equal(sched.valueType, 'string')
  const ckpt = r.nodes.find((n) => n.fieldName === 'ckpt_name')
  assert.deepEqual(ckpt.options, ['sd_xl_base_1.0.safetensors'])
  assert.equal(ckpt.valueType, 'string')
})

test('规则 6b：options 只从工作流已有取值汇聚，不编造', () => {
  const api = {
    '1': { class_type: 'KSamplerA', inputs: { sampler_name: 'euler', seed: 1, steps: 10, cfg: 1 } },
    '2': { class_type: 'KSamplerA', inputs: { sampler_name: 'dpmpp_2m', seed: 2, steps: 10, cfg: 1 } },
    '3': { class_type: 'SaveImage', inputs: {} },
  }
  const r = analyzeWorkflow(api)
  const opts = r.nodes.filter((n) => n.fieldName === 'sampler_name').map((n) => n.options).flat()
  assert.deepEqual([...new Set(opts)].sort(), ['dpmpp_2m', 'euler'])
})

test('规则 7：其余进 other；连线字段（["4",0]）绝不产出可编辑节点', () => {
  const api = {
    '1': { class_type: 'SomeWeirdNode', inputs: { caption: 'a free text', upstream: ['2', 0], flag: true, mode: 'fast' } },
    '2': { class_type: 'SaveImage', inputs: {} },
  }
  const r = analyzeWorkflow(api)
  const names = r.nodes.map((n) => n.fieldName)
  assert.equal(names.includes('upstream'), false, '连线字段不可编辑')
  assert.equal(r.nodes.find((n) => n.fieldName === 'caption').role, 'other', '自由文本 → other')
  assert.equal(r.nodes.find((n) => n.fieldName === 'flag').role, 'boolean')
  // `mode: 'fast'` 是分类值 → select（不是 other）；见 looksCategorical
  assert.equal(r.nodes.find((n) => n.fieldName === 'mode').role, 'select')
})

test('looksCategorical：只在值是**字符串**时判枚举（数值滑块不能被误判）', () => {
  assert.equal(looksCategorical('aspect_ratio', '9:16 (Portrait Widescreen)', 'ResolutionSelector'), true)
  assert.equal(looksCategorical('sampler_name', 'euler', 'KSampler'), true)
  assert.equal(looksCategorical('mode', 'fast', 'X'), true)
  // 值是数字 → 不是枚举（哪怕字段名叫 scale / resolution）
  assert.equal(looksCategorical('scale', 1.5, 'X'), false)
  assert.equal(looksCategorical('resolution', 1024, 'ResolutionSelector'), false)
  // 普通自由文本
  assert.equal(looksCategorical('caption', 'a cat', 'X'), false)
  assert.equal(looksCategorical('text', 'hello', 'CLIPTextEncode'), false)
  // `Selector` 类节点的字符串字段一律当分类值
  assert.equal(looksCategorical('whatever', 'v1', 'ResolutionSelector'), true)
  // `weight_dtype` 这类"前缀 + dtype"
  assert.equal(looksCategorical('weight_dtype', 'default', 'UNETLoader'), true)
  assert.equal(looksCategorical('upscale_method', 'nearest-exact', 'ImageUpscaleWithModel'), true)
})

test('aspect_ratio / ResolutionSelector：分类归组对，但**不许锁死**（task-9）', () => {
  const r = analyzeWorkflow({
    '13': {
      class_type: 'ResolutionSelector',
      inputs: { aspect_ratio: { __value__: ['9:16 (Portrait Widescreen)', true] }, megapixels: 1, multiple: 8 },
      _meta: { title: 'Resolution Selector' },
    },
    '8': { class_type: 'SaveImage', inputs: {} },
  })
  const ar = r.nodes.find((n) => n.fieldName === 'aspect_ratio')
  assert.equal(ar.role, 'select', '它确实是"选一个"的字段')
  assert.equal(ar.group, '选项')
  assert.equal(ar.overridable, true)
  assert.equal(ar.default, '9:16 (Portrait Widescreen)')
  // **关键**：JSON 没给候选清单，只有当前值 → 不许是 enum
  // ⚠️ **这条断言在 task-9 改过**：旧期望 `valueType === 'enum'` 是**编码了 bug 的化石** ——
  //    真机上就是它把用户的画面比例锁死的（"值「16:9 (Widescreen)」不在允许的枚举里"）。
  assert.notEqual(ar.valueType, 'enum')
  assert.equal(ar.valueType, 'string')
  assert.equal(ar.optionsSource, 'inferred-from-default')
  assert.deepEqual(ar.options, ['9:16 (Portrait Widescreen)'], '已知值保留为建议')
  assert.match(ar.note, /没有候选清单/)
  // megapixels 是数值字段（NUMBER_HINTS 有），仍走 number，且范围标注来源
  const mp = r.nodes.find((n) => n.fieldName === 'megapixels')
  assert.equal(mp.role, 'number')
  assert.equal(mp.valueType, 'number')
  assert.equal(mp.boundsSource, 'heuristic', 'min/max 是插件给的区间，必须标注来源')
})

test('**单选项锁死**：只有 1 个已知值的分类字段绝不落成 enum（task-9 的核心判据）', () => {
  // 真机 node 424 的字面形状
  const r = analyzeWorkflow({
    '424': {
      class_type: 'ResolutionSelector',
      inputs: { aspect_ratio: '9:16 (Portrait Widescreen)', megapixels: 2, multiple: 32 },
      _meta: { title: 'Resolution Selector' },
    },
    '8': { class_type: 'SaveImage', inputs: {} },
  })
  for (const n of r.nodes) {
    if (Array.isArray(n.options) && n.options.length === 1) {
      assert.notEqual(n.valueType, 'enum', n.fieldName + '：只有一个选项就不是下拉框')
      assert.equal(n.optionsSource, 'inferred-from-default')
    }
  }
  // 逐个断言关键字段
  const ar = r.nodes.find((n) => n.fieldName === 'aspect_ratio')
  assert.notEqual(ar.valueType, 'enum')
  assert.equal(ar.optionsSource, 'inferred-from-default')

  // 用户改比例**必须全通过**（真机上旧版本这里会 ❌）
  const cfg = { nodes: r.nodes, region: 'cn' }
  for (const v of ['16:9 (Widescreen)', '1:1 (Square)', '4:3', '21:9 (Ultrawide)', '完全自定义的值']) {
    const res = validateRun(cfg, { params: { 424: { aspect_ratio: v } } }, { hasKeyForRegion: () => true })
    assert.equal(res.ok, true, '「' + v + '」不该被拦：' + JSON.stringify(res.issues))
    assert.equal(res.issues.some((i) => i.code === 'ENUM_OUT_OF_RANGE'), false)
  }
})

test('真枚举（optionsSource: workflow/user）**仍然**被越界校验拦住', () => {
  // `workflow`：同一工作流里观测到 2 个不同取值 → 有选择空间的证据
  const r = analyzeWorkflow({
    '1': { class_type: 'KSampler', inputs: { sampler_name: 'euler', seed: 1, steps: 1, cfg: 1 } },
    '2': { class_type: 'KSampler', inputs: { sampler_name: 'dpmpp_2m', seed: 2, steps: 1, cfg: 1 } },
    '8': { class_type: 'SaveImage', inputs: {} },
  })
  const sn = r.nodes.find((n) => n.fieldName === 'sampler_name')
  assert.equal(sn.valueType, 'enum')
  assert.equal(sn.optionsSource, 'workflow')
  assert.deepEqual(sn.options, ['dpmpp_2m', 'euler'])
  const cfg = { nodes: r.nodes, region: 'cn' }
  assert.equal(validateRun(cfg, { params: { sampler_name: 'euler' } }, { hasKeyForRegion: () => true }).ok, true)
  const bad = validateRun(cfg, { params: { sampler_name: 'bogus' } }, { hasKeyForRegion: () => true })
  assert.equal(bad.ok, false, '真枚举必须拦')
  assert.equal(bad.issues[0].code, 'ENUM_OUT_OF_RANGE')

  // `user`：用户在 configure 里显式给定 options → 也是真枚举
  const cfgUser = {
    nodes: [{ nodeId: '1', fieldName: 'sampler_name', role: 'select', valueType: 'enum', options: ['euler', 'dpmpp_2m'], optionsSource: 'user' }],
    region: 'cn',
  }
  const u = validateRun(cfgUser, { params: { '1:sampler_name': 'bogus' } }, { hasKeyForRegion: () => true })
  assert.equal(u.ok, false)
  assert.equal(u.issues[0].code, 'ENUM_OUT_OF_RANGE')
  assert.match(u.issues[0].hint, /显式给定/)
})

test('老配置（无 optionsSource）向后兼容：≥2 选项仍拦，**单选项自动解锁**', () => {
  // 老版本落盘的配置全是 `enum` + 1 个选项 —— 那正是被锁死的那批
  const legacySingle = { nodes: [{ nodeId: '424', fieldName: 'aspect_ratio', role: 'select', valueType: 'enum', options: ['9:16 (Portrait Widescreen)'] }], region: 'cn' }
  assert.equal(
    validateRun(legacySingle, { params: { 424: { aspect_ratio: '16:9 (Widescreen)' } } }, { hasKeyForRegion: () => true }).ok,
    true,
    '单选项老配置要自动解锁，否则用户不重新 probe 就永远改不了',
  )
  // 用户手工配的真枚举一定 ≥2 个选项 → 不受这条例外影响
  const legacyReal = { nodes: [{ nodeId: '424', fieldName: 'sampler_name', role: 'select', valueType: 'enum', options: ['euler', 'dpmpp_2m'] }], region: 'cn' }
  assert.equal(
    validateRun(legacyReal, { params: { 424: { sampler_name: 'bogus' } } }, { hasKeyForRegion: () => true }).ok,
    false,
    '老的真枚举不能被放开',
  )
})

test('explicitOptionsOf：识别真 combo 的几种形状', () => {
  assert.deepEqual(explicitOptionsOf(['a', 'b']), ['a', 'b'])
  assert.deepEqual(explicitOptionsOf({ options: ['a', 'b'] }), ['a', 'b'])
  assert.deepEqual(explicitOptionsOf({ values: ['x'] }), ['x'])
  assert.deepEqual(explicitOptionsOf({ enum: [1, 2] }), ['1', '2'], '数字选项也认，转字符串')
  assert.deepEqual(explicitOptionsOf({ __value__: [['a', 'b'], true] }), ['a', 'b'], '清单被 __value__ 包住也认')
  assert.deepEqual(explicitOptionsOf('euler'), [], '裸值不是清单')
  assert.deepEqual(explicitOptionsOf({ __value__: ['euler', true] }), [], '包装里的裸值也不是清单')
  assert.deepEqual(explicitOptionsOf(null), [])

  // JSON 里带显式清单 → workflow 来源的真枚举
  const r = analyzeWorkflow({
    '1': { class_type: 'MyPicker', inputs: { mode: { options: ['fast', 'slow'] } }, _meta: { title: 'Picker' } },
    '8': { class_type: 'SaveImage', inputs: {} },
  })
  const mode = r.nodes.find((n) => n.fieldName === 'mode')
  assert.equal(mode.valueType, 'enum')
  assert.equal(mode.optionsSource, 'workflow')
  assert.deepEqual(mode.options, ['fast', 'slow'])
})

test('用户 override 给了 options → optionsSource=user 且被校验；只改 label 不会把来源洗成 user', () => {
  const base = analyzeWorkflow({
    '1': { class_type: 'KSampler', inputs: { sampler_name: 'euler', seed: 1, steps: 1, cfg: 1 } },
    '8': { class_type: 'SaveImage', inputs: {} },
  })
  // ① 只改 label：来源必须保持 inferred-from-default（否则"顺手改个名"会把字段变成永久锁）
  const a = analyzeWorkflow(
    { '1': { class_type: 'KSampler', inputs: { sampler_name: 'euler', seed: 1, steps: 1, cfg: 1 } }, '8': { class_type: 'SaveImage', inputs: {} } },
    { overrides: [{ nodeId: '1', fieldName: 'sampler_name', label: '采样器' }] },
  )
  const n1 = a.nodes.find((n) => n.fieldName === 'sampler_name')
  assert.equal(n1.label, '采样器')
  assert.equal(n1.optionsSource, 'inferred-from-default')
  assert.notEqual(n1.valueType, 'enum')
  // ② 显式给 options：来源变 user，且被拦
  const b = analyzeWorkflow(
    { '1': { class_type: 'KSampler', inputs: { sampler_name: 'euler', seed: 1, steps: 1, cfg: 1 } }, '8': { class_type: 'SaveImage', inputs: {} } },
    { overrides: [{ nodeId: '1', fieldName: 'sampler_name', options: ['euler', 'dpmpp_2m'] }] },
  )
  const n2 = b.nodes.find((n) => n.fieldName === 'sampler_name')
  assert.equal(n2.valueType, 'enum')
  assert.equal(n2.optionsSource, 'user')
  assert.equal(validateRun({ nodes: b.nodes }, { params: { sampler_name: 'bogus' } }, { hasKeyForRegion: () => true }).ok, false)
  // base 本身不受影响
  assert.equal(base.nodes.find((n) => n.fieldName === 'sampler_name').optionsSource, 'inferred-from-default')
})

test('数值范围：heuristic 越界是**非阻塞警告**，文案自曝来源（Lead 拍板：插件的猜测不该拦用户的活）', () => {
  const r = analyzeWorkflow({
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '8': { class_type: 'SaveImage', inputs: {} },
  })
  const w = r.nodes.find((n) => n.fieldName === 'width')
  assert.equal(w.boundsSource, 'heuristic', 'width 的 64–4096 是插件手写的常见区间')
  const res = validateRun({ nodes: r.nodes }, { params: { width: 99999 } }, { hasKeyForRegion: () => true })
  assert.equal(res.ok, true, '**不拦**')
  assert.deepEqual(res.issues, [])
  assert.equal(res.warnings.length, 1)
  assert.equal(res.warnings[0].code, 'VALUE_OUT_OF_RANGE')
  assert.equal(res.warnings[0].fieldName, 'width')
  assert.match(res.warnings[0].message, /插件给的常见区间/)
  assert.match(res.warnings[0].message, /服务端仍会校验/)
})

test('**去重不变量**：同一份 nodes[] 里 `(nodeId, fieldName)` 必须唯一（Lead 真机 一个真实的 Qwen-Image-2.1 编辑工作流）', () => {
  // 真机上 KSampler 一个节点被吐出 10 条、同字段两条（一条中文标签+group=采样，一条通用兜底+group=画面），
  // 面板上显示成两套一模一样的参数行。这里对**所有真实工作流**锁死唯一性。
  const samples = [T2I(), EDIT(), BG()]
  samples.push(apiFixture())
  samples.push({
    '416': {
      class_type: 'KSampler',
      inputs: { seed: 1015641285360799, steps: 40, cfg: 1, denoise: 1, sampler_name: 'euler', scheduler: 'simple', model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] },
      _meta: { title: 'KSampler' },
    },
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'qwen.safetensors', weight_dtype: 'default' } },
    '8': { class_type: 'SaveImage', inputs: {} },
  })
  for (const wf of samples) {
    const r = analyzeWorkflow(wf)
    assert.equal(r.ok, true)
    const seen = new Set()
    const dups = []
    for (const n of r.nodes) {
      const key = n.nodeId + '\u0000' + n.fieldName
      if (seen.has(key)) dups.push(n.nodeId + '.' + n.fieldName)
      seen.add(key)
    }
    assert.deepEqual(dups, [], '出现重复的 (nodeId, fieldName)：' + JSON.stringify(dups))
    assert.equal(r.hints.warnings.some((w) => w.includes('重复的 (nodeId, fieldName)')), false, '不该走到兜底去重（说明有分支漏了 return）')
  }
})

test('KSampler 绝不 fall-through 到通用兜底：seed 的 role 稳定为 `seed`，label/group 用专门的', () => {
  const r = analyzeWorkflow({
    '416': {
      class_type: 'KSampler',
      inputs: { seed: 1015641285360799, steps: 40, cfg: 1, denoise: 1, sampler_name: 'euler', scheduler: 'simple' },
      _meta: { title: 'KSampler' },
    },
    '8': { class_type: 'SaveImage', inputs: {} },
  })
  const byField = new Map()
  for (const n of r.nodes) {
    if (!byField.has(n.fieldName)) byField.set(n.fieldName, [])
    byField.get(n.fieldName).push(n)
  }
  for (const f of ['seed', 'steps', 'cfg', 'denoise', 'sampler_name', 'scheduler']) {
    assert.equal(byField.get(f).length, 1, f + ' 只能有一条')
  }
  // role / label / group 都是"专门推断"那一套，不是通用兜底
  const seed = byField.get('seed')[0]
  assert.equal(seed.role, 'seed', 'seed 的 role 必须稳定为 seed（不能一条 seed 一条 number）')
  assert.equal(seed.label, '随机种子')
  assert.equal(seed.group, '采样')
  assert.equal(byField.get('steps')[0].label, '采样步数')
  assert.equal(byField.get('cfg')[0].label, 'CFG 强度')
  assert.equal(byField.get('denoise')[0].label, '去噪强度')
  assert.equal(byField.get('sampler_name')[0].group, '采样')
  assert.equal(byField.get('scheduler')[0].group, '采样')
  // role 与 valueType 一致
  for (const n of r.nodes) {
    if (n.valueType === 'enum') assert.equal(n.role, 'select', n.fieldName + '：enum 必须配 select')
    if (n.role === 'seed') assert.equal(n.valueType, 'number')
  }
})

test('dedupeNodes：保留分更高的那条；分数相同保留先出现的', () => {
  const better = { nodeId: '1', fieldName: 'cfg', role: 'number', label: 'CFG 强度', group: '采样', valueType: 'number' }
  const worse = { nodeId: '1', fieldName: 'cfg', role: 'number', label: 'cfg', group: '画面', valueType: 'number' }
  assert.deepEqual(dedupeNodes([better, worse]).nodes, [better])
  assert.deepEqual(dedupeNodes([worse, better]).nodes, [better], '顺序反过来也要留下好的那条（且位置不变）')
  assert.equal(dedupeNodes([better, worse]).dropped, 1)
  const a = { nodeId: '1', fieldName: 'x', role: 'other', label: 'x', group: '其它', valueType: 'string' }
  const b = { nodeId: '1', fieldName: 'x', role: 'other', label: 'x', group: '其它', valueType: 'string' }
  assert.equal(dedupeNodes([a, b]).nodes[0], a, '分数相同保留先出现的')
  assert.deepEqual(dedupeNodes([]).nodes, [])
  assert.equal(dedupeNodes(null).dropped, 0)
  // 不同 nodeId 或不同 fieldName 绝不合并
  assert.equal(dedupeNodes([better, { ...better, nodeId: '2' }, { ...better, fieldName: 'steps' }]).nodes.length, 3)
})

test('输出推断：SaveImage/SaveVideo/SaveAudio/SaveAnimatedWEBP/VHS_VideoCombine', () => {
  assert.equal(analyzeWorkflow({ '1': { class_type: 'SaveImage', inputs: {} }, '2': { class_type: 'KSampler', inputs: { seed: 1, steps: 1, cfg: 1 } } }).outputKind, 'image')
  assert.equal(analyzeWorkflow({ '1': { class_type: 'VHS_VideoCombine', inputs: {} } }).outputKind, 'video')
  assert.equal(analyzeWorkflow({ '1': { class_type: 'SaveAudio', inputs: {} } }).outputKind, 'audio')
  assert.equal(analyzeWorkflow({ '1': { class_type: 'SaveAnimatedWEBP', inputs: {} } }).outputKind, 'image')
  assert.equal(analyzeWorkflow({ '1': { class_type: 'SaveImage', inputs: {} }, '2': { class_type: 'SaveVideo', inputs: {} } }).outputKind, 'mixed')
  const inf = inferOutputs({ '1': { class_type: 'SaveImage' }, '2': { class_type: 'PreviewImage' } })
  assert.deepEqual(inf.kinds, ['image'])
  assert.equal(inf.outputs.length, 2)
})

test('analyzeWorkflow：overrides 覆盖推断结果；不存在的 override 进 warnings', () => {
  const r = analyzeWorkflow(apiFixture(), {
    overrides: [
      { nodeId: '6', fieldName: 'text', label: '我的主提示词', group: '画面' },
      { nodeId: '不存在', fieldName: 'x', label: 'y' },
    ],
  })
  assert.equal(r.ok, true)
  const p = r.nodes.find((n) => n.nodeId === '6' && n.fieldName === 'text')
  assert.equal(p.label, '我的主提示词')
  assert.equal(p.group, '画面')
  assert.equal(p.role, 'prompt', 'override 不该把 role 弄丢')
  assert.equal(r.hints.warnings.some((w) => w.includes('不存在')), true)
})

test('summarizeRoles：未知 role 归 other；空输入全 0', () => {
  assert.deepEqual(summarizeRoles([]), { prompt: 0, negative_prompt: 0, image: 0, video: 0, audio: 0, number: 0, select: 0, boolean: 0, seed: 0, other: 0 })
  const s = summarizeRoles([{ role: 'prompt' }, { role: 'prompt' }, { role: '???' }])
  assert.equal(s.prompt, 2)
  assert.equal(s.other, 1)
})

/* ═══════════════════════ buildNodeInfoList ═══════════════════════ */

test('buildNodeInfoList：prompt / negativePrompt / params / images → 官方形状，fieldValue 全字符串', () => {
  const analysis = analyzeWorkflow(apiFixture())
  const cfg = { rhWorkflowId: '1988', region: 'cn', nodes: analysis.nodes }
  const list = buildNodeInfoList(cfg, {
    prompt: '一只戴墨镜的猫',
    negativePrompt: '模糊',
    params: { '5': { width: 1024, height: 768 }, '3:steps': 30, '3:cfg': 7.5 },
    images: {},
  })
  // 形状严格是 {nodeId, fieldName, fieldValue}
  for (const item of list) {
    assert.deepEqual(Object.keys(item).sort(), ['fieldName', 'fieldValue', 'nodeId'])
    assert.equal(typeof item.nodeId, 'string')
    assert.equal(typeof item.fieldName, 'string')
    assert.equal(typeof item.fieldValue, 'string', 'fieldValue 一律字符串化：' + JSON.stringify(item))
  }
  const byKey = new Map(list.map((x) => [x.nodeId + '.' + x.fieldName, x.fieldValue]))
  assert.equal(byKey.get('6.text'), '一只戴墨镜的猫')
  assert.equal(byKey.get('7.text'), '模糊')
  assert.equal(byKey.get('5.width'), '1024', '数字必须转字符串')
  assert.equal(byKey.get('5.height'), '768')
  assert.equal(byKey.get('3.steps'), '30')
  assert.equal(byKey.get('3.cfg'), '7.5')
  // 没覆盖的字段绝不进列表
  assert.equal(list.some((x) => x.fieldName === 'seed'), false)
})

test('buildNodeInfoList：images 映射到 image 节点；布尔转 "true"/"false"', () => {
  const analysis = analyzeWorkflow(EDIT())
  const cfg = { nodes: analysis.nodes }
  const list = buildNodeInfoList(cfg, { images: { 470: 'openapi/portrait.png' } })
  assert.deepEqual(list, [{ nodeId: '470', fieldName: 'image', fieldValue: 'openapi/portrait.png' }])
  assert.equal(stringifyValue(true), 'true')
  assert.equal(stringifyValue(false), 'false')
  assert.equal(stringifyValue(1024), '1024')
  assert.equal(stringifyValue(null), '')
  assert.equal(stringifyValue(NaN), '')
})

test('buildNodeInfoList：空的 prompt / 未给的值不产生覆盖项；纯后台调用可以为空数组', () => {
  const analysis = analyzeWorkflow(apiFixture())
  const cfg = { nodes: analysis.nodes }
  assert.deepEqual(buildNodeInfoList(cfg, {}), [])
  assert.deepEqual(buildNodeInfoList(cfg, { prompt: '' }), [])
  assert.deepEqual(buildNodeInfoList(cfg, null), [])
  assert.deepEqual(buildNodeInfoList(null, { prompt: 'x' }), [])
})

test('buildNodeInfoList：同一 (nodeId,field) 后写覆盖先写（去重）', () => {
  const analysis = analyzeWorkflow(apiFixture())
  const cfg = { nodes: analysis.nodes }
  const list = buildNodeInfoList(cfg, { prompt: 'A', params: { '6': 'B' } })
  const hit = list.filter((x) => x.nodeId === '6' && x.fieldName === 'text')
  assert.equal(hit.length, 1)
  assert.equal(hit[0].fieldValue, 'B')
})

test('buildNodeInfoList：`runninghub_call` 的 params 键形状全部支持', () => {
  const analysis = analyzeWorkflow(apiFixture())
  const cfg = { nodes: analysis.nodes }
  // ① `{"6":{"text":"a cat"}}`（工具 schema 文档里的第一种）
  assert.deepEqual(buildNodeInfoList(cfg, { params: { 6: { text: 'a cat' } } }), [
    { nodeId: '6', fieldName: 'text', fieldValue: 'a cat' },
  ])
  // ② `{"3":{"seed":123,"steps":20}}`（第二种）
  assert.deepEqual(buildNodeInfoList(cfg, { params: { 3: { seed: 123, steps: 20 } } }), [
    { nodeId: '3', fieldName: 'seed', fieldValue: '123' },
    { nodeId: '3', fieldName: 'steps', fieldValue: '20' },
  ])
  // ③ `{"steps":20}` 按**字段名**匹配（第三种）
  assert.deepEqual(buildNodeInfoList(cfg, { params: { steps: 20 } }), [{ nodeId: '3', fieldName: 'steps', fieldValue: '20' }])
  assert.deepEqual(buildNodeInfoList(cfg, { params: { width: 768 } }), [{ nodeId: '5', fieldName: 'width', fieldValue: '768' }])
  // ④ `"6:text"` 精确键
  assert.deepEqual(buildNodeInfoList(cfg, { params: { '6:text': 'x' } }), [{ nodeId: '6', fieldName: 'text', fieldValue: 'x' }])
  // ⑤ 角色名
  assert.deepEqual(buildNodeInfoList(cfg, { params: { prompt: 'p' } }), [{ nodeId: '6', fieldName: 'text', fieldValue: 'p' }])
  // 未知键被忽略而不是炸
  assert.deepEqual(buildNodeInfoList(cfg, { params: { 不存在的键: 1 } }), [])
})

/* ═══════════════════════ validateRun ═══════════════════════ */

test('validateRun：明确输入必须映射到已配置字段，不再静默丢弃', () => {
  const cfg = { nodes: [
    { nodeId: '1', fieldName: 'steps', role: 'number', valueType: 'number' },
    { nodeId: '2', fieldName: 'width', role: 'number', valueType: 'number' },
    { nodeId: '3', fieldName: 'file', role: 'other', valueType: 'string' },
  ] }
  for (const values of [
    { prompt: '提示词' },
    { negativePrompt: '负面提示词' },
    { params: { missing: '' } },
    { params: { '1': { width: 512 } } },
    { params: { number: { width: 512 } } },
    { images: { missing: 'openapi/a.png' } },
    { params: [] },
    { images: null },
  ]) {
    const result = validateRun(cfg, values)
    assert.equal(result.ok, false, JSON.stringify(values))
    assert.equal(result.issues[0].code, 'INPUT_NOT_MAPPED')
  }
  const values = { params: { '1': { steps: 20 }, '2:width': 512 }, images: { '3:file': 'openapi/a.png' } }
  assert.equal(validateRun(cfg, values).ok, true)
  const issues = []
  assert.deepEqual(buildNodeInfoList(cfg, { params: { '1': { missing: 'x' } } }, { issues }), [])
  assert.equal(issues[0].code, 'INPUT_NOT_MAPPED')
})

test('validateRun：缺必填 prompt → NODE_MISSING', () => {
  // 工作流里本来就没有提示词文本（空串）→ 必须报 NODE_MISSING
  const analysis = analyzeWorkflow({
    '6': { class_type: 'TextEncodeQwenImage21', inputs: { prompt: '', negative_prompt: '' } },
    '8': { class_type: 'SaveImage', inputs: {} },
  })
  const cfg = { nodes: analysis.nodes, region: 'cn' }
  assert.equal(validateRun(cfg, { prompt: 'hi' }).ok, true)
  const bad = validateRun(cfg, {})
  assert.equal(bad.ok, false)
  assert.ok(bad.issues.some((i) => i.code === 'NODE_MISSING' && i.nodeId === '6' && i.fieldName === 'prompt'))
  // 工作流自带默认提示词时，用户不给也能跑（默认值就是工作流自己的值）
  const a2 = analyzeWorkflow(apiFixture())
  assert.equal(validateRun({ nodes: a2.nodes }, {}).ok, true)
})

test('validateRun：heuristic 数值越界进 warnings；类型错进 issues（`ok` 只看 issues）', () => {
  const analysis = analyzeWorkflow(apiFixture())
  const cfg = { nodes: analysis.nodes }
  // `width` 是 heuristic → 非阻塞
  const r2 = validateRun(cfg, { prompt: 'hi', params: { '5': { width: 99999 } } })
  assert.equal(r2.ok, true)
  assert.deepEqual(r2.issues, [])
  assert.ok(r2.warnings.some((i) => i.code === 'VALUE_OUT_OF_RANGE'))
  // 类型错是结构性的 → 阻塞
  const r3 = validateRun(cfg, { prompt: 'hi', params: { '3:cfg': '不是数字' } })
  assert.ok(r3.issues.some((i) => i.code === 'VALUE_NOT_A_NUMBER'))
  assert.equal(r3.ok, false)
  // 合法值全绿、无警告
  const okRes = validateRun(cfg, { prompt: 'hi', params: { '5': { width: 1024 }, '3:sampler_name': 'euler' } })
  assert.equal(okRes.ok, true)
  assert.deepEqual(okRes.warnings, [])
  // 单取值的 sampler_name 不再是枚举 → 传任意值都不该报 ENUM_OUT_OF_RANGE（task-9）
  const loose = validateRun(cfg, { prompt: 'hi', params: { '3:sampler_name': '不存在的采样器' } })
  assert.equal(loose.issues.some((i) => i.code === 'ENUM_OUT_OF_RANGE'), false)
})

test('structural 边界（denoise 0–1 / seed 非负）仍然**硬拦** —— 算法定义不是猜测', () => {
  const r = analyzeWorkflow({
    '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20, cfg: 8, denoise: 1, sampler_name: 'euler', scheduler: 'normal' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
    '8': { class_type: 'SaveImage', inputs: {} },
  })
  assert.equal(r.nodes.find((n) => n.fieldName === 'denoise').boundsSource, 'structural', 'denoise 0–1 是采样器的定义')
  assert.equal(r.nodes.find((n) => n.fieldName === 'seed').boundsSource, 'structural')
  assert.equal(r.nodes.find((n) => n.fieldName === 'width').boundsSource, 'heuristic', 'width 的 64–4096 是插件猜的')

  const cfg = { nodes: r.nodes }
  const bad = validateRun(cfg, { params: { '3:denoise': 5 } })
  assert.equal(bad.ok, false, 'denoise=5 结构性不可能 → 拦')
  assert.equal(bad.issues[0].code, 'VALUE_OUT_OF_RANGE')
  assert.deepEqual(bad.warnings, [])
  assert.equal(validateRun(cfg, { params: { '3:seed': -1 } }).ok, false, 'seed 负数 → 拦')
  // 老配置（无 boundsSource）按阻塞处理，向后兼容
  const legacy = { nodes: [{ nodeId: '3', fieldName: 'denoise', valueType: 'number', min: 0, max: 1 }] }
  assert.equal(validateRun(legacy, { params: { '3:denoise': 5 } }).ok, false, '无 boundsSource 的老配置仍阻塞')
})

test('validateRun：region 池没 key → NO_KEY（跨池不回退）', () => {
  const analysis = analyzeWorkflow(apiFixture())
  const cfg = { nodes: analysis.nodes, region: 'cn' }
  const emptyPool = { pick: () => ({ ok: false, error: { code: 'NO_KEY' } }) }
  const r = validateRun(cfg, { prompt: 'hi' }, { pool: emptyPool })
  assert.equal(r.ok, false)
  assert.equal(r.issues[0].code, 'NO_KEY')
  assert.match(r.issues[0].hint, /绝不跨池回退/)

  const goodPool = { pick: () => ({ ok: true, id: 'k1' }) }
  assert.equal(validateRun(cfg, { prompt: 'hi' }, { pool: goodPool }).ok, true)
  assert.equal(validateRun(cfg, { prompt: 'hi' }, { hasKeyForRegion: () => true }).ok, true)
  assert.equal(validateRun(cfg, { prompt: 'hi' }, { hasKeyForRegion: () => false }).ok, false)
})

test('validateRun：真实工作流 + 真实 values 全绿', () => {
  const analysis = analyzeWorkflow(EDIT())
  const cfg = { nodes: analysis.nodes, region: 'cn' }
  const r = validateRun(cfg, { prompt: '把背景换成星空', images: { 470: 'openapi/a.png' } }, { hasKeyForRegion: () => true })
  assert.equal(r.ok, true, JSON.stringify(r.issues))
  // 第一张图是必填：一张都不给就要拦下来
  const bad = validateRun(cfg, { prompt: 'x' }, { hasKeyForRegion: () => true })
  assert.ok(bad.issues.some((i) => i.code === 'NODE_MISSING' && i.fieldName === 'image' && i.nodeId === '470'))
  // 但第二张图是可选的参考图，不该拦
  assert.equal(bad.issues.some((i) => i.nodeId === '475'), false)
})

/* ═══════════════════════ defaultValues / draftConfig ═══════════════════════ */

test('defaultValues：给出可编辑参数的默认值', () => {
  const analysis = analyzeWorkflow(apiFixture())
  const v = defaultValues({ nodes: analysis.nodes })
  assert.equal(v.prompt, 'a beautiful cat')
  assert.equal(v.negativePrompt, 'blurry, bad')
  assert.equal(v.params['5:width'], 512)
  assert.equal(v.params['3:steps'], 20)
})

test('draftConfig：产出未落盘的配置骨架（schemaVersion=1）', () => {
  const analysis = analyzeWorkflow(T2I())
  const cfg = draftConfig({ rhWorkflowId: '1988', region: 'cn', name: 'Qwen 文生图', displayNameEn: 'qwen-t2i' }, analysis)
  assert.equal(cfg.rhWorkflowId, '1988')
  assert.equal(cfg.name, 'Qwen 文生图')
  assert.equal(cfg.region, 'cn')
  assert.equal(cfg.outputKind, 'image')
  assert.equal(cfg.instanceType, 'default')
  assert.equal(cfg.schemaVersion, 1)
  assert.deepEqual(cfg.promptOptimizer, { enabled: false, docId: null, asSubagentSystemPrompt: false, targetNodeId: null, extraInstruction: '' })
  assert.ok(cfg.nodes.length > 0)
  assert.deepEqual(JSON.parse(JSON.stringify(cfg)), cfg)
})

test('所有公开返回值都是 lossless JSON', () => {
  const analysis = analyzeWorkflow(T2I())
  const cfg = { nodes: analysis.nodes, region: 'cn' }
  const values = [analysis, defaultValues(cfg), draftConfig({ rhWorkflowId: 'w' }, analysis), validateRun(cfg, {}), inferOutputs({ '1': { class_type: 'SaveImage' } })]
  for (const v of values) assert.deepEqual(JSON.parse(JSON.stringify(v)), v)
})
