/**
 * `host/core/workflow.mjs` —— 工作流 JSON → 参数模型（节点角色推断）
 *
 * 契约（**Lead 已锁定**）：
 *   - `analyzeWorkflow(apiJson)` → `{ok, nodes:[...], outputKind, nodeCount, hints}`
 *     `node` 形状严格按 DESIGN §3.2：`{nodeId,classType,title,role,fieldName,label,required,default,valueType,min?,max?,step?,options?,group,note,overridable}`
 *   - `buildNodeInfoList(config, values)` → `[{nodeId,fieldName,fieldValue}]`，**fieldValue 一律字符串化**（官方示例是字符串）。
 *   - `validateRun(config, values, opts?)` → `{ok, issues:[{code,nodeId?,fieldName?,message,hint?}]}`
 *   - `summarizeRoles(nodes)` → `{prompt,negative_prompt,image,video,audio,number,select,boolean,seed,other}`
 *   - **推断结果必须可被用户/AI 覆盖**：每个 node 都带 `overridable`，配置里同 `(nodeId,fieldName)` 的显式条目优先。
 *
 * 接受的输入形状（`normalizeWorkflow` 负责归一化，顺序即优先级）：
 *   ① RH `getJsonApiFormat` 的外层响应：`{code,data:{prompt:"<json 字符串>"}}`（`prompt` 是**字符串**，要 `JSON.parse`）
 *   ② ComfyUI **API 格式**：`{"6":{"class_type":"CLIPTextEncode","inputs":{...},"_meta":{"title":"..."}}}`
 *   ③ ComfyUI **UI 格式**：`{nodes:[{id,type,mode,widgets_values,inputs,links}],links:[...],definitions:{subgraphs:[...]}}`
 *      —— 含 **subgraph 展开**（实测：host 节点的 `widgets_values[i]` 与 `subgraph.inputs` 里
 *      **非 IMAGE/VIDEO/AUDIO 类型**的第 i 项严格对齐；三个 Qwen 工作流 12/12、16/16、16/16 全中）。
 *
 * 角色推断规则见 DESIGN §4，另有两条实测补充（1b / 6b）：
 *   1b. 同一节点可能有多个文本字段（如 Qwen 的 `TextEncodeQwenImage21` 同时有 `prompt` 与
 *       `negative_prompt`）→ 按字段名判角色，**同名节点会产出多条 node 记录**（合法：nodeId 相同、fieldName 不同）。
 *   6b. `options` **只**来自工作流里已有的取值（同 class_type 的其它节点同名字段），绝不编造。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * **`optionsSource`：RunningHub API 格式不携带候选清单**（写给下一个改这块的人）
 *
 * 这是**实测**结论，不是推断：把手上全部真实工作流数据（约 **800KB**）全量搜
 * `"options"` / `"values"` / `"enum"` / `"choices"` / `"enumValues"` / `"candidates"`
 * —— **命中 0 次**；另外把 RunningHub 官方 API 文档全表过了一遍，**没有任何接口返回节点候选值**。
 *
 * 所以 `optionsSource:'workflow'` 的识别只有两条路：
 *   ① **显式清单形状**（`[a,b,c]` / `{options:[…]}` / `{values:[…]}` / `{enum:[…]}` /
 *      `{__value__:[[a,b],true]}`）—— 由 `explicitOptionsOf()` 识别。**真实数据中从未出现过。**
 *   ② **同一工作流里观测到 ≥2 个不同取值** —— 有"选择空间"的证据，这才是实际依赖的主路径。
 *
 * 只有 ①② 之一成立才允许落成 `valueType:'enum'`；**仅由当前值反推**的一律降级成标量
 * （`optionsSource:'inferred-from-default'`，`options` 仅作建议）——
 * "只有一个选项的下拉框不是下拉框，是一把锁"：Lead 真机 一个真实的 Qwen-Image-2.1 编辑工作流 上，
 * node 424 的 `aspect_ratio` 就是这么把用户的画面比例锁死的。
 *
 * 同理 `boundsSource` 区分 `structural`（算法定义 → 阻塞）/ `heuristic`（插件手写的常见区间 → **只警告**）。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * @module dsh-runninghub-plugin/host/core/workflow
 */

import { asString, toNumber, lossless, errorShape, isPlainObject, clip } from './util.mjs'

/** 输出类型全集（DESIGN §3.2）。 */
export const OUTPUT_KINDS = ['image', 'video', 'audio', '3d', 'text', 'mixed']

/** 角色全集（DESIGN §3.2，顺序即 `summarizeRoles` 的键序）。 */
export const ROLES = ['prompt', 'negative_prompt', 'image', 'video', 'audio', 'number', 'select', 'boolean', 'seed', 'other']

/**
 * **结构性**范围：由算法/采样器的定义决定，不是我们的猜测。
 * 越界 = 结构性不可能 → `validateRun` **硬拦**（`boundsSource:'structural'`）。
 *
 * 例：`denoise` 是比例，`0..1` 之外无意义；`seed` 是非负整数。
 */
export const STRUCTURAL_BOUNDS = {
  denoise: { min: 0, max: 1, step: 0.01 },
  seed: { min: 0, max: 9007199254740991, step: 1 },
}

/**
 * **常见区间**（DESIGN §4.5）：我们手写的"一般这么用"，**不是工作流的契约**。
 * 越界 → `validateRun` 只给**非阻塞警告**（`boundsSource:'heuristic'`），照跑，
 * 让 RunningHub 服务端去拒 —— 它的报错比我们的猜测准。
 * （Lead 2026-09 拍板：**插件的猜测不该拦用户的活**；数值范围和枚举是同一类"编造"。）
 */
export const HEURISTIC_BOUNDS = {
  width: { min: 64, max: 4096, step: 8 },
  height: { min: 64, max: 4096, step: 8 },
  batch_size: { min: 1, max: 16, step: 1 },
  steps: { min: 1, max: 200, step: 1 },
  cfg: { min: 0, max: 30, step: 0.5 },
  resolution: { min: 0, max: 4096, step: 32 },
  megapixels: { min: 0.1, max: 16, step: 0.1 },
  strength: { min: 0, max: 2, step: 0.05 },
}

/** 数值字段的表（结构性 + 常见区间合并视图，DESIGN §4.5 说的就是这张表）。 */
export const NUMBER_HINTS = { ...HEURISTIC_BOUNDS, ...STRUCTURAL_BOUNDS }

/** 下拉字段名（DESIGN §4.6）。 */
export const ENUM_FIELDS = [
  'sampler_name', 'scheduler', 'ckpt_name', 'unet_name', 'clip_name', 'vae_name', 'lora_name', 'dtype', 'device',
  'sampler', 'type', 'format', 'output_format', 'upscale_method', 'interpolation',
]

/**
 * 「明显是分类值」的字段名模式（**只在值是字符串时**才当枚举，见 `looksCategorical`）。
 *
 * 补上这个是因为真机 一个真实的 Qwen-Image-2.1 编辑工作流 里 `ResolutionSelector` 的 `aspect_ratio`
 * 默认值是 `"9:16 (Portrait Widescreen)"` —— 一眼是枚举，但不在 `ENUM_FIELDS` 里，
 * 被归成了 `other`（面板上给用户一个自由文本框，很容易填错）。
 */
const CATEGORICAL_FIELD = /(^|_)(aspect|ratio|orientation|mode|quality|style|size|preset|fit|crop|alignment|resolution|scale|dtype)$/i

/** `weight_dtype` 这类"前缀 + dtype"的字段也当分类值（真机 UNETLoader 上是 `default` / `fp8_e4m3fn` 这种枚举）。 */
const CATEGORICAL_SUFFIX = /_(dtype|format|method|mode|type)$/i

/** class_type 里带这些词 = 该节点就是"选一个"的控件，它的字符串字段都是分类值。 */
const SELECTOR_CLASS = /(selector|dropdown|option|combo|picker|chooser)/i

/**
 * 这个字段是不是"分类值"（枚举）。
 *
 * **值是字符串**才算 —— 否则 `scale: 1.5` 这种数值滑块会被误判成只有一个选项的枚举。
 * @param {string} field 字段名
 * @param {unknown} value 裸值（已拆 `__value__`）
 * @param {string} classType class_type
 * @returns {boolean} 是分类值为 true
 */
export function looksCategorical(field, value, classType) {
  if (typeof value !== 'string') return false
  const f = String(field)
  if (ENUM_FIELDS.includes(f.toLowerCase())) return true
  if (CATEGORICAL_FIELD.test(f)) return true
  if (CATEGORICAL_SUFFIX.test(f)) return true
  if (SELECTOR_CLASS.test(String(classType))) return true
  return false
}

/** 纯前端节点：UI 格式里存在，API 格式里不存在，转换时丢掉。 */
const UI_ONLY_CLASSES = new Set(['MarkdownNote', 'Note', 'ImageCompare', 'Reroute', 'PrimitiveNode', 'PreviewAny', 'Bookmark', 'Group'])

/** 媒体类型：subgraph 里这些类型永远由外部连线喂，不占 `widgets_values`。 */
const MEDIA_TYPES = new Set(['IMAGE', 'VIDEO', 'AUDIO', 'MASK', 'LATENT'])

/** `control_after_generate` 这一档是前端虚拟 widget，出现在 `widgets_values` 里但不在 `inputs` 里。 */
const VIRTUAL_WIDGET_VALUES = new Set(['fixed', 'randomize', 'increment', 'decrement'])

/* ═══════════════════════════ 1. `{"__value__": [...]}` 包装 ═══════════════════════════ */

/**
 * 拆 RH 的 `{"__value__": [<值>, <可编辑标记>]}` 包装（DESIGN 排雷 §6）。
 *
 * **语义说明**：DESIGN 只给了 `[false, true]` 这一个样例，社区对两位的含义有两种读法
 * （`[值, 可编辑]` 与 `[入参, 出参]`）。本实现按 DESIGN 的「据其值类型定为 boolean/number/string」
 * 取 **第 0 位为裸值**，第 1 位为可编辑标记；`rh-docs` 的 `docs/api/**` 出来后如有出入会改这里，
 * 并在 `tests/core/workflow.test.mjs` 里锁死。
 *
 * @param {unknown} v 字段值
 * @returns {{value:any, wrapped:boolean, editable:boolean}} 拆包结果
 */
export function unwrapValue(v) {
  if (isPlainObject(v) && Array.isArray(v.__value__)) {
    const arr = v.__value__
    const value = arr.length > 0 ? arr[0] : null
    // 只有明确的 `[值, true]` 才算“可编辑”；`[x, false]` 视为不可覆盖
    const editable = arr.length >= 2 ? arr[1] === true : true
    return { value, wrapped: true, editable }
  }
  return { value: v, wrapped: false, editable: false }
}

/**
 * 该字段是否是 RH 的「可覆盖」标记。
 * @param {unknown} v 字段值
 * @returns {boolean} 是 `__value__` 包装且标记为可真时为 true
 */
export function isOverridable(v) {
  const u = unwrapValue(v)
  return u.wrapped && u.editable
}

/** 是否为「节点连线」（`["3", 0]` 形状）。 @param {unknown} v 字段值 @returns {boolean} 是连线为 true */
export function isLink(v) {
  return Array.isArray(v) && v.length >= 1 && (typeof v[0] === 'string' || typeof v[0] === 'number')
}

/* ═══════════════════════════ 2. 输入归一化（三种形状 → API 格式） ═══════════════════════════ */

/**
 * 把任意形状的工作流输入归一化成 ComfyUI API 格式。
 * @param {unknown} input 工作流（字符串 / 外层响应 / API 格式 / UI 格式）
 * @returns {{ok:true, api:Record<string,{class_type:string,inputs:object,_meta?:object}>, source:'api'|'ui'|'wrapper', warnings:string[]}|{ok:false,error:object}} 归一化结果
 */
export function normalizeWorkflow(input) {
  const warnings = []
  let raw = input

  // ① 字符串：可能是 getJsonApiFormat 的 data.prompt
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch (e) {
      return { ok: false, error: errorShape('BAD_WORKFLOW', '工作流 JSON 字符串解析失败：' + String((e && e.message) || e)) }
    }
  }
  if (!isPlainObject(raw)) {
    return { ok: false, error: errorShape('BAD_WORKFLOW', '工作流必须是对象或 JSON 字符串，收到 ' + typeof raw) }
  }

  // ①b 外层响应 `{code,data:{prompt}}`（RH 官方接口原样返回时）
  let source = null
  if (raw.data && isPlainObject(raw.data) && raw.data.prompt !== undefined) {
    const p = raw.data.prompt
    if (typeof p === 'string') {
      try {
        raw = JSON.parse(p)
      } catch (e) {
        return { ok: false, error: errorShape('BAD_WORKFLOW', 'data.prompt 不是合法 JSON：' + String((e && e.message) || e)) }
      }
    } else {
      raw = p
    }
    source = 'wrapper'
    if (!isPlainObject(raw)) return { ok: false, error: errorShape('BAD_WORKFLOW', 'data.prompt 解析后不是对象') }
  } else if (typeof raw.prompt === 'string' && !raw.nodes && !raw['0']) {
    // `{prompt:"..."}` 的裸包装
    try {
      raw = JSON.parse(raw.prompt)
      source = 'wrapper'
    } catch {
      /* 不是包装，继续往下走 */
    }
  }

  // ② UI 格式
  if (Array.isArray(raw.nodes)) {
    const conv = uiToApi(raw, warnings)
    if (!conv.ok) return conv
    return { ok: true, api: conv.api, source: source || 'ui', warnings }
  }

  // ③ API 格式（`{id: {class_type, inputs}}`）
  const api = {}
  let count = 0
  for (const [id, node] of Object.entries(raw)) {
    if (!isPlainObject(node)) continue
    if (typeof node.class_type !== 'string' || !isPlainObject(node.inputs)) continue
    api[String(id)] = node
    count += 1
  }
  if (count === 0) {
    return {
      ok: false,
      error: errorShape('BAD_WORKFLOW', '工作流里没有可识别的节点（既不是 API 格式也不是 UI 格式）', {
        hint: '顶层键：' + clip(Object.keys(raw).slice(0, 12).join(','), 120),
      }),
    }
  }
  return { ok: true, api, source: source || 'api', warnings }
}

/**
 * UI 格式 → API 格式（含 subgraph 展开）。
 * @param {object} ui UI 格式工作流
 * @param {string[]} warnings 收集告警
 * @returns {{ok:true,api:object}|{ok:false,error:object}} 结果
 */
function uiToApi(ui, warnings) {
  const api = {}
  const links = Array.isArray(ui.links) ? ui.links : []
  const subgraphs = (ui.definitions && Array.isArray(ui.definitions.subgraphs) ? ui.definitions.subgraphs : []).slice()
  const subById = new Map(subgraphs.map((s) => [String(s.id), s]))

  /**
   * 展开一层节点集合。
   * @param {object[]} nodes 节点数组
   * @param {object[]} nodeLinks 该层的 links
   * @param {string} prefix 展平 id 前缀
   * @param {string} scope 作用域标签（日志用）
   * @param {number} depth 递归深度
   * @returns {void}
   */
  const expand = (nodes, nodeLinks, prefix, scope, depth) => {
    if (depth > 5) {
      warnings.push('subgraph 嵌套超过 5 层，已停止展开：' + scope)
      return
    }
    const linkById = new Map((Array.isArray(nodeLinks) ? nodeLinks : []).map((l) => [String(l.id), l]))
    for (const n of Array.isArray(nodes) ? nodes : []) {
      if (!n || typeof n !== 'object') continue
      const cls = asString(n.type)
      if (cls === '') continue
      if (UI_ONLY_CLASSES.has(cls)) continue
      const flatId = prefix + String(n.id)
      const sg = subById.get(cls)

      if (!sg) {
        // ── 普通节点：widgets_values → 有 widget 描述的 inputs，按序对齐
        const inputs = {}
        const widgetInputs = (Array.isArray(n.inputs) ? n.inputs : []).filter((i) => i && i.widget && i.name)
        const names = widgetInputs.map((i) => asString(i.name))
        const values = alignWidgets(names, Array.isArray(n.widgets_values) ? n.widgets_values : [])
        for (let i = 0; i < names.length; i++) {
          if (values[i] !== undefined) inputs[names[i]] = values[i]
        }
        // 连线：`["<originFlatId>", slot]`；指向 -10/-20 的代理槽在本层无意义，跳过
        for (const slot of Array.isArray(n.inputs) ? n.inputs : []) {
          if (!slot || slot.link === undefined || slot.link === null) continue
          const link = linkById.get(String(slot.link))
          if (!link) continue
          const origin = Number(link.origin_id)
          if (origin <= 0) continue
          inputs[asString(slot.name)] = [prefix + String(link.origin_id), toNumber(link.origin_slot, 0)]
        }
        api[flatId] = {
          class_type: cls,
          inputs,
          ...(n.title ? { _meta: { title: asString(n.title) } } : {}),
        }
        continue
      }

      // ── subgraph host 节点：把内部节点展平进同一级，并把 host 的 widgets 灌进 subgraph 的入参
      const sgInputs = Array.isArray(sg.inputs) ? sg.inputs : []
      /** `sg.inputs` 里「可填写」（非媒体）槽位的**原始下标**，顺序与 `widgets_values` 严格一致（实测 12/12、16/16、16/16）。 */
      const widgetSgIdx = []
      sgInputs.forEach((s, i) => {
        if (!MEDIA_TYPES.has(asString(s.type).toUpperCase())) widgetSgIdx.push(i)
      })
      const values = Array.isArray(n.widgets_values) ? n.widgets_values : []
      if (values.length !== widgetSgIdx.length) {
        warnings.push(
          'subgraph "' + asString(sg.name) + '" 的 widgets_values(' + String(values.length) + ') 与可填写入参(' + String(widgetSgIdx.length) + ') 数量不一致，按较短的截断',
        )
      }
      /** sg.inputs 下标（字符串）→ 外层喂进来的值。**键必须是 sg.inputs 的下标**，不是 widget 序号。 */
      const outerValues = {}
      for (let wi = 0; wi < widgetSgIdx.length && wi < values.length; wi++) {
        outerValues[String(widgetSgIdx[wi])] = values[wi]
      }
      // host 节点上的显式连线（按 **槽位名** 对齐到 sg.inputs；名字在 subgraph 提升后是保持一致的）
      const attachOuter = (slotName, linkId) => {
        if (linkId === undefined || linkId === null) return
        const l = linkById.get(String(linkId))
        if (!l || Number(l.origin_id) <= 0) return
        const sgIdx = sgInputs.findIndex((s) => asString(s.name) === asString(slotName))
        if (sgIdx < 0) return
        outerValues[String(sgIdx)] = [prefix + String(l.origin_id), toNumber(l.origin_slot, 0)]
      }
      for (const slot of Array.isArray(n.inputs) ? n.inputs : []) {
        if (!slot || slot.link === undefined || slot.link === null) continue
        attachOuter(slot.name, slot.link)
      }
      // 兜底：老格式里 host 连线可能记在本层 links 上（target_id = host 的 id）
      for (const l of Array.isArray(nodeLinks) ? nodeLinks : []) {
        if (Number(l.target_id) !== Number(n.id)) continue
        const si = toNumber(l.target_slot, -1)
        if (si < 0 || si >= sgInputs.length) continue
        if (Number(l.origin_id) <= 0) continue
        outerValues[String(si)] = [prefix + String(l.origin_id), toNumber(l.origin_slot, 0)]
      }
      /** subgraph 内部 id → 展平 id。 */
      const innerPrefix = flatId + ':'
      // 递归展开内部节点（内部 links 里 origin_id=-10 的是 subgraph 入参）
      expand(sg.nodes, sg.links, innerPrefix, asString(sg.name), depth + 1)
      // 把内部节点里「由 subgraph 入参喂进来」的槽替换成外层值；媒体槽没有外层值就**不写**（留给连线）
      for (const l of Array.isArray(sg.links) ? sg.links : []) {
        if (Number(l.origin_id) !== -10) continue
        const targetNode = api[innerPrefix + String(l.target_id)]
        if (!targetNode) continue
        const targetName = fieldNameOfSlot(sg, l.target_id, toNumber(l.target_slot, -1))
        if (targetName === '') continue
        const outer = outerValues[String(toNumber(l.origin_slot, -1))]
        if (outer === undefined) {
          delete targetNode.inputs[targetName]
          continue
        }
        targetNode.inputs[targetName] = outer
      }
    }
  }

  expand(ui.nodes, links, '', 'root', 0)
  if (Object.keys(api).length === 0) {
    return { ok: false, error: errorShape('BAD_WORKFLOW', 'UI 格式工作流展开后没有任何节点') }
  }
  return { ok: true, api }
}

/**
 * 找 subgraph 内某节点的第 slot 个输入槽对应的字段名。
 * @param {object} sg subgraph 定义
 * @param {number|string} nodeId 内部节点 id
 * @param {number} slot 输入槽序号
 * @returns {string} 字段名（找不到 → `''`）
 */
function fieldNameOfSlot(sg, nodeId, slot) {
  const node = (Array.isArray(sg.nodes) ? sg.nodes : []).find((m) => m && String(m.id) === String(nodeId))
  if (!node) return ''
  const ins = Array.isArray(node.inputs) ? node.inputs : []
  const s = ins[slot]
  return s && s.name ? asString(s.name) : ''
}

/**
 * 把 `widgets_values` 按位置对齐到 widget 字段名，并跳过前端虚拟 widget（`control_after_generate`）。
 *
 * 真实数据实测：
 *   KSampler     names=[seed,steps,cfg,sampler_name,scheduler]  values=[0,"fixed",25,1,"euler","simple",1]
 *                → 第 1 位 "fixed" 是虚拟 widget，跳过；尾部 denoise=1 无对应字段，忽略。
 *   EmptyLatentImage names=[width,height]  values=[1024,1024,1] → 尾部 batch_size 忽略。
 * @param {string[]} names widget 字段名（按 inputs 顺序）
 * @param {unknown[]} values `widgets_values`
 * @returns {unknown[]} 与 `names` 等长的值数组（未匹配到为 `undefined`）
 */
export function alignWidgets(names, values) {
  const out = new Array(names.length).fill(undefined)
  let vi = 0
  for (let ni = 0; ni < names.length && vi < values.length; ni++) {
    out[ni] = values[vi]
    vi += 1
    // 刚吃掉的是 seed 系字段，且紧跟着一个 control_after_generate 取值 → 把虚拟值也吃掉
    if (/seed/i.test(names[ni]) && vi < values.length && typeof values[vi] === 'string' && VIRTUAL_WIDGET_VALUES.has(values[vi])) {
      vi += 1
    }
  }
  return out
}

/* ═══════════════════════════ 3. 角色推断 ═══════════════════════════ */

/** 文本字段优先级（越靠前越像“正向提示词”）。 */
const TEXT_FIELD_ORDER = ['text', 'prompt', 'positive', 'positive_prompt', 'negative_prompt', 'negative', 'text_g', 'text_l']

/** 取节点标题。 @param {object} node API 节点 @returns {string} 标题 */
function titleOf(node) {
  return asString(node && node._meta && node._meta.title)
}

/**
 * 从 `inputs` 里挑文本候选字段。
 * @param {object} node API 节点
 * @returns {{field:string,value:string,negative:boolean}[]} 候选
 */
function textCandidates(node) {
  const inputs = node.inputs || {}
  const keys = Object.keys(inputs)
  const rank = (k) => {
    const i = TEXT_FIELD_ORDER.indexOf(k)
    return i === -1 ? 99 : i
  }
  const out = []
  for (const k of keys.sort((a, b) => rank(a) - rank(b))) {
    if (isLink(inputs[k])) continue
    const u = unwrapValue(inputs[k])
    if (typeof u.value !== 'string') continue
    out.push({ field: k, value: u.value, negative: false })
  }
  return out
}

/**
 * 判断一个 `(class_type, fieldName)` 的字符串字段是不是文本提示词（而不是文件名/枚举）。
 * @param {string} field 字段名
 * @returns {boolean} 是文本候选为 true
 */
function looksLikeTextField(field) {
  const f = field.toLowerCase()
  if (ENUM_FIELDS.includes(f)) return false
  if (/(name|path|file|filename|url|token|key|_id)$/.test(f)) return false
  return true
}

/**
 * 为单个 API 节点产出配置记录（可能多条：如同时有 prompt 与 negative_prompt）。
 * @param {string} nodeId 节点 id
 * @param {object} node API 节点
 * @param {Map<string,Set<string>>} enumHints 同 class_type 的枚举取值提示
 * @returns {object[]} node 记录数组
 */
function nodesOf(nodeId, node, enumHints) {
  const cls = asString(node.class_type)
  const cl = cls.toLowerCase()
  const compact = cl.replace(/[\s_-]/g, '')
  const title = titleOf(node)
  const inputs = node.inputs || {}
  const out = []
  const base = { nodeId, classType: cls, title }

  /**
   * 造一条记录。
   * @param {object} spec 字段规格
   * @returns {object} 记录
   */
  const mk = (spec) =>
    lossless({
      ...base,
      role: spec.role,
      fieldName: spec.fieldName,
      label: spec.label,
      required: spec.required === true,
      default: spec.default,
      valueType: spec.valueType,
      ...(spec.min !== undefined ? { min: spec.min } : {}),
      ...(spec.max !== undefined ? { max: spec.max } : {}),
      ...(spec.step !== undefined ? { step: spec.step } : {}),
      // `min/max` 是**谁说的**：`heuristic` = 插件给的常见区间，`workflow` = 工作流/节点自带。
      // 校验器与 UI 都要能区分"硬约束"与"参考值"，否则又变成"把插件猜测当契约"。
      ...(spec.boundsSource !== undefined ? { boundsSource: spec.boundsSource } : {}),
      ...(spec.options ? { options: spec.options } : {}),
      // `options` 是**哪来的**：`workflow`（JSON 里的显式清单 / 同工作流多处观测到 ≥2 个值）·
      // `user`（用户在 workflow.configure 里显式给定）· `inferred-from-default`（只有当前值反推）。
      // **只有前两种才允许被 validateRun 当枚举校验**。
      ...(spec.optionsSource !== undefined ? { optionsSource: spec.optionsSource } : {}),
      group: spec.group || '其它',
      note: spec.note || '',
      overridable: spec.overridable === true,
    })

  /* 规则 1：文本编码节点 */
  const isText =
    compact.includes('cliptextencode') ||
    compact.includes('textencode') ||
    compact.includes('prompttext') ||
    cl.includes('text encode') ||
    compact.includes('prompt')
  if (isText) {
    const cands = textCandidates(node).filter((c) => looksLikeTextField(c.field))
    const hasExplicitNegative = cands.some((c) => /negative/i.test(c.field))
    let usedPrompt = false
    let usedNegative = false
    for (const c of cands) {
      const fn = c.field.toLowerCase()
      let role = 'prompt'
      if (/negative|neg_/.test(fn)) role = 'negative_prompt'
      else if (/positive|^text$|^prompt$|^text_g$/.test(fn)) {
        // DESIGN 规则 1：`text` 为空串、或标题含 negative → negative_prompt
        const titleNegative = /negative|负向|反向/i.test(title)
        if ((fn === 'text' && c.value.trim() === '' && !hasExplicitNegative) || titleNegative) role = 'negative_prompt'
      }
      if (role === 'prompt') {
        if (usedPrompt) role = 'prompt' // 允许多条，但只有第一条标记为主提示词
        usedPrompt = true
      }
      if (role === 'negative_prompt') {
        if (usedNegative) continue
        usedNegative = true
      }
      const u = unwrapValue(inputs[c.field])
      out.push(
        mk({
          role,
          fieldName: c.field,
          label: role === 'prompt' ? '正向提示词' : '负向提示词',
          required: role === 'prompt',
          default: asString(u.value),
          valueType: 'string',
          group: '提示词',
          overridable: isOverridable(inputs[c.field]),
          note: usedPrompt && role === 'prompt' && out.some((o) => o.role === 'prompt') ? '同工作流里还有别的主提示词节点，UI 会折叠' : '',
        }),
      )
    }
    if (out.length > 0) return out
  }

  /* 规则 2：加载类节点（图片/视频/音频） */
  const media = matchMediaRole(compact, cl)
  if (media) {
    const field = pickMediaField(inputs, media.field)
    out.push(
      mk({
        role: media.role,
        fieldName: field,
        label: media.label,
        required: true,
        default: '',
        valueType: 'string',
        group: '输入素材',
        overridable: isOverridable(inputs[field]),
      }),
    )
    return out
  }

  /* 规则 4：KSampler 系 */
  if (/^ksampler/.test(compact) || compact.includes('samplercustom') || compact.includes('sampler')) {
    if (!isLink(inputs.seed) && inputs.seed !== undefined) {
      out.push(
        mk({
          role: 'seed',
          fieldName: 'seed',
          label: '随机种子',
          required: false,
          default: scalarDefault(inputs.seed),
          valueType: 'number',
          ...NUMBER_HINTS.seed,
          boundsSource: 'structural',
          group: '采样',
          overridable: isOverridable(inputs.seed),
        }),
      )
    }
    for (const f of ['steps', 'cfg', 'denoise']) {
      if (inputs[f] === undefined || isLink(inputs[f])) continue
      out.push(
        mk({
          role: 'number',
          fieldName: f,
          label: f === 'steps' ? '采样步数' : f === 'cfg' ? 'CFG 强度' : '去噪强度',
          required: false,
          default: scalarDefault(inputs[f]),
          valueType: 'number',
          ...(NUMBER_HINTS[f] || {}),
          boundsSource: STRUCTURAL_BOUNDS[f] ? 'structural' : 'heuristic',
          group: '采样',
          overridable: isOverridable(inputs[f]),
        }),
      )
    }
    for (const f of ENUM_FIELDS) {
      if (inputs[f] === undefined || isLink(inputs[f])) continue
      out.push(makeEnumNode(mk, f, inputs[f], enumHints, cls, '采样'))
    }
    // ⚠️ **必须 return**：KSampler 已把 seed/steps/cfg/denoise/sampler_name/scheduler 全部收走，
    // 再往下走「规则 3+6+7 的通用兜底」会把同一批字段**用另一套 label/group 再 push 一遍**
    // （真实工作流实测：一个 KSampler 吐出 10 条，面板上出现两套一模一样的参数行）。
    // 这是 Lead 在真机 一个真实的 Qwen-Image-2.1 编辑工作流 上抓到的去重缺陷，根因就在这里。
    if (out.length > 0) return out
  }

  /* 规则 5：EmptyLatent 系 + 任何宽高字段 */
  const isLatent = compact.includes('emptylatent') || compact.includes('emptysd3latent')
  if (isLatent) {
    for (const f of ['width', 'height', 'batch_size']) {
      if (inputs[f] === undefined || isLink(inputs[f])) continue
      const u = unwrapValue(inputs[f])
      if (typeof u.value !== 'number') continue
      out.push(
        mk({
          role: 'number',
          fieldName: f,
          label: f === 'width' ? '宽度' : f === 'height' ? '高度' : '批量张数',
          required: false,
          default: u.value,
          valueType: 'number',
          ...(NUMBER_HINTS[f] || {}),
          boundsSource: STRUCTURAL_BOUNDS[f] ? 'structural' : 'heuristic',
          group: '画面',
          overridable: isOverridable(inputs[f]),
        }),
      )
    }
    if (out.length > 0) return out
  }

  /* 规则 3 + 6 + 7：其余字段逐个看 */
  for (const [field, raw] of Object.entries(inputs)) {
    if (isLink(raw)) continue
    const explicit = explicitOptionsOf(raw)
    const u = unwrapValue(raw)
    const v = u.value
    if (v === null || v === undefined || typeof v === 'object') {
      // 值本身是对象：只有带**显式候选清单**的真 combo 包装才处理（如 `{options:[a,b]}`）
      if (explicit.length > 0) out.push(makeEnumNode(mk, field, raw, enumHints, cls, '选项'))
      continue
    }
    const overridable = isOverridable(raw)
    const fl = field.toLowerCase()
    // 规则 6a：带显式候选清单 → 真枚举（优先于数值/分类判断）
    if (explicit.length > 0) {
      out.push(makeEnumNode(mk, field, raw, enumHints, cls, '选项'))
      continue
    }
    // 规则 5b：任何节点上的宽高/分辨率字段都当数值
    if (NUMBER_HINTS[fl] && typeof v === 'number') {
      out.push(
        mk({
          role: 'number',
          fieldName: field,
          label: field,
          required: false,
          default: v,
          valueType: 'number',
          ...NUMBER_HINTS[fl],
          boundsSource: STRUCTURAL_BOUNDS[fl] ? 'structural' : 'heuristic',
          group: '画面',
          overridable,
        }),
      )
      continue
    }
    // 规则 6：明显是下拉的字段（**值必须是字符串** —— 否则 `scale: 1.5` 这类数值滑块会被误判）
    if (looksCategorical(field, v, cls) || enumHints.get(cls + '.' + field)?.size > 1) {
      out.push(makeEnumNode(mk, field, raw, enumHints, cls, looksCategorical(field, v, cls) ? '选项' : '其它'))
      continue
    }
    if (typeof v === 'boolean') {
      out.push(mk({ role: 'boolean', fieldName: field, label: field, required: false, default: v, valueType: 'boolean', group: '开关', overridable }))
      continue
    }
    if (typeof v === 'number') {
      out.push(mk({ role: 'number', fieldName: field, label: field, required: false, default: v, valueType: 'number', group: '其它', overridable }))
      continue
    }
    if (typeof v === 'string') {
      out.push(mk({ role: 'other', fieldName: field, label: field, required: false, default: v, valueType: 'string', group: '其它', overridable }))
    }
  }
  return out
}

/**
 * 造一条 enum 记录（options 只从工作流已有取值里取，绝不编造）。
 * @param {Function} mk 记录工厂
 * @param {string} field 字段名
 * @param {unknown} raw 原始值
 * @param {Map<string,Set<string>>} enumHints 取值提示
 * @param {string} cls class_type
 * @param {string} group 分组
 * @returns {object} 记录
 */
function makeEnumNode(mk, field, raw, enumHints, cls, group) {
  const u = unwrapValue(raw)
  const hint = enumHints.get(cls + '.' + field) || enumHints.get('*.' + field)
  const explicit = explicitOptionsOf(raw)
  const observed = new Set()
  if (hint) for (const v of hint) observed.add(String(v))
  if (typeof u.value === 'string' || typeof u.value === 'number') {
    if (String(u.value) !== '') observed.add(String(u.value))
  }
  const observedList = Array.from(observed).sort()

  // ① JSON 里的**显式候选清单**（真 combo）→ 可以当枚举
  if (explicit.length > 0) {
    return mk({
      role: 'select',
      fieldName: field,
      label: field,
      required: false,
      default: asString(u.value),
      valueType: 'enum',
      options: explicit,
      optionsSource: 'workflow',
      group,
      overridable: isOverridable(raw),
    })
  }

  // ② 同一工作流里**观测到 ≥2 个不同取值** → 有选择空间的证据，可以当枚举
  if (observedList.length >= 2) {
    return mk({
      role: 'select',
      fieldName: field,
      label: field,
      required: false,
      default: asString(u.value),
      valueType: 'enum',
      options: observedList,
      optionsSource: 'workflow',
      note: '候选值来自本工作流里实际出现过的取值（不是节点自带的完整清单）',
      group,
      overridable: isOverridable(raw),
    })
  }

  // ③ **只有当前值** → **绝不许冒充枚举**。
  //    "只有一个选项的下拉框不是下拉框，是一把锁" —— 用户会被 validateRun 彻底锁死，
  //    真机 一个真实的 Qwen-Image-2.1 编辑工作流 的 node 424 `aspect_ratio` 就是这么被锁住画面比例的。
  //    这里降级成可自由输入的标量，`options` 只作为**建议值**保留，并标注来源。
  const asNumber = typeof u.value === 'number'
  const note =
    observedList.length === 0
      ? '工作流 JSON 里没有候选清单，也不带当前值：按自由输入处理'
      : '工作流 JSON 只带当前值（' +
        observedList.join(' / ') +
        '），**没有候选清单**（RunningHub 开放 API 不返回节点候选值）；可自由输入，已见过的取值仅作建议'
  return mk({
    role: 'select',
    fieldName: field,
    label: field,
    required: false,
    default: asString(u.value),
    valueType: asNumber ? 'number' : 'string',
    options: observedList,
    optionsSource: 'inferred-from-default',
    group,
    note,
    overridable: isOverridable(raw),
  })
}

/**
 * 从字段值里抽**显式候选清单**（真 combo 的三种常见形状）。
 *
 * 实测：三个 Qwen 工作流 + `wf_index.json` 共 800KB 里 `"options"/"values"/"enum"/"choices"`
 * **一次都没出现过** —— 所以这条路径目前是"有就用"的兜底，主要靠 `observedList.length >= 2`。
 * @param {unknown} raw 原始字段值
 * @returns {string[]} 候选值（没有 → `[]`）
 */
export function explicitOptionsOf(raw) {
  const pick = (v) => (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' || typeof x === 'number') ? v.map(String) : [])
  if (Array.isArray(raw)) return pick(raw)
  if (isPlainObject(raw)) {
    for (const k of ['options', 'values', 'enum', 'choices', 'enumValues', 'candidates']) {
      const got = pick(raw[k])
      if (got.length > 0) return got
    }
    // `{"__value__": [[a,b,c], true]}` —— 清单被包在 __value__ 里
    if (Array.isArray(raw.__value__)) {
      const got = pick(raw.__value__[0])
      if (got.length > 0) return got
    }
  }
  return []
}

/** 标量默认值（去包装 + 去 -0）。 @param {unknown} raw 原始值 @returns {any} 标量 */
function scalarDefault(raw) {
  const u = unwrapValue(raw)
  return u.value === undefined ? null : u.value
}

/**
 * 加载类节点 → 角色。
 * @param {string} compact class_type 压缩小写
 * @param {string} cl class_type 小写
 * @returns {{role:string,field:string,label:string}|null} 角色或 `null`
 */
function matchMediaRole(compact, cl) {
  if (compact.includes('loadimage') || cl.includes('load image') || compact.includes('imageloader')) {
    return { role: 'image', field: 'image', label: '输入图片' }
  }
  if (compact.includes('loadvideo') || cl.includes('video upload') || compact.includes('videoupload') || compact.includes('vhs_loadvideo')) {
    return { role: 'video', field: 'video', label: '输入视频' }
  }
  if (compact.includes('loadaudio') || cl.includes('audio upload') || compact.includes('audioupload')) {
    return { role: 'audio', field: 'audio', label: '输入音频' }
  }
  return null
}

/**
 * 挑出媒体字段名（优先 `image`/`video`/`audio`，其次同义名）。
 * @param {object} inputs 节点 inputs
 * @param {string} preferred 首选字段
 * @returns {string} 字段名
 */
function pickMediaField(inputs, preferred) {
  if (inputs && inputs[preferred] !== undefined) return preferred
  for (const k of Object.keys(inputs || {})) {
    if (k.toLowerCase() === preferred) return k
  }
  for (const k of Object.keys(inputs || {})) {
    if (k.toLowerCase().startsWith(preferred)) return k
  }
  return preferred
}

/**
 * 推断输出侧类型（DESIGN §4 末段）。
 * @param {Record<string,object>} api API 格式工作流
 * @returns {{kinds:string[],outputs:{nodeId:string,classType:string,kind:string}[]}} 结果
 */
export function inferOutputs(api) {
  const outputs = []
  const kinds = new Set()
  for (const [nodeId, node] of Object.entries(api || {})) {
    const cls = asString(node && node.class_type)
    const c = cls.toLowerCase().replace(/[\s_-]/g, '')
    let kind = ''
    if (c.includes('savevideo') || c.includes('videocombine') || c.includes('savewebm') || c.includes('saveanimated')) {
      kind = c.includes('animatedwebp') || c.includes('saveanimatedwebp') ? 'image' : 'video'
    } else if (c.includes('saveaudio') || c.includes('audiocombine')) kind = 'audio'
    else if (c.includes('saveimage') || c.includes('previewimage') || c.includes('imagesave')) kind = 'image'
    else if (c.includes('save3d') || c.includes('savegltf') || c.includes('saveobj') || c.includes('savemesh')) kind = '3d'
    if (kind) {
      outputs.push({ nodeId, classType: cls, kind })
      kinds.add(kind)
    }
  }
  return { kinds: Array.from(kinds).sort(), outputs }
}

/**
 * 节点 id 比较：支持 `"459:474"` 这种 subgraph 展平 id（按冒号分段做数值比较）。
 * @param {unknown} a 左 id
 * @param {unknown} b 右 id
 * @returns {number} `<0` / `0` / `>0`
 */
export function compareNodeIds(a, b) {
  const pa = asString(a).split(':').map((s) => toNumber(s, Number.MAX_SAFE_INTEGER))
  const pb = asString(b).split(':').map((s) => toNumber(s, Number.MAX_SAFE_INTEGER))
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = i < pa.length ? pa[i] : -1
    const y = i < pb.length ? pb[i] : -1
    if (x !== y) return x - y
  }
  return 0
}

/**
 * `(nodeId, fieldName)` 去重时用来挑"更好那条"的评分。
 *
 * 真机 一个真实的 Qwen-Image-2.1 编辑工作流 上，同一个 KSampler 的 `cfg` 被吐了两条：
 * 一条是专门推断的（中文标签「CFG 强度」、`group=采样`、`role=seed/number` 更具体），
 * 另一条是通用 widget 兜底（`group=画面/其它`、label 就是字段名、seed 被降级成 `number`）。
 * 面板上会显示成两套一模一样的参数行，用户/AI 都不知道该配哪个 —— 所以按分数留一条。
 * @param {object} n 节点记录
 * @returns {number} 分数（越大越好）
 */
export function nodeScore(n) {
  let s = 0
  if (n && n.group && n.group !== '其它') s += 4 // 分过组 = 有专门推断路径认领过
  if (n && /[\u4e00-\u9fff]/.test(asString(n.label))) s += 3 // 中文标签 = 人/规则专门标注过
  if (n && ROLE_SPECIFIC.has(asString(n.role))) s += 2 // seed/prompt/image… 比 number/other 具体
  if (n && asString(n.role) === 'other') s -= 3
  if (n && n.valueType === 'enum' && Array.isArray(n.options) && n.options.length > 0) s += 1
  if (n && typeof n.note === 'string' && n.note !== '') s += 1
  return s
}

/** 比 `number`/`other` 更具体的角色（去重时优先保留）。 */
const ROLE_SPECIFIC = new Set(['prompt', 'negative_prompt', 'image', 'video', 'audio', 'seed', 'select', 'boolean'])

/**
 * 按 `(nodeId, fieldName)` 去重，保留分数更高的那条（**分数相同保留先出现的那条**）。
 * 这是"最后一道防线"：每个推断分支各自 `return` 才是根治，但只要以后有人加分支忘了 return，
 * 这里能保证面板不会出现重复行。
 * @param {object[]} nodes 节点数组
 * @returns {{nodes:object[], dropped:number}} 结果
 */
export function dedupeNodes(nodes) {
  const out = []
  const at = new Map()
  let dropped = 0
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const key = String(n.nodeId) + '\u0000' + String(n.fieldName)
    const idx = at.get(key)
    if (idx === undefined) {
      at.set(key, out.length)
      out.push(n)
      continue
    }
    dropped += 1
    if (nodeScore(n) > nodeScore(out[idx])) out[idx] = n
  }
  return { nodes: out, dropped }
}

/**
 * 统计各角色的节点数。
 * @param {object[]} nodes `analyzeWorkflow` 产出的节点数组
 * @returns {Record<string,number>} 每个角色多少个
 */
export function summarizeRoles(nodes) {
  const out = {}
  for (const r of ROLES) out[r] = 0
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const r = asString(n && n.role)
    if (out[r] === undefined) out.other += 1
    else out[r] += 1
  }
  return out
}

/**
 * 把工作流 JSON 解析成参数模型。
 * @param {unknown} apiJson 工作流（字符串 / `{data:{prompt}}` / API 格式 / UI 格式）
 * @param {{overrides?:object[]}} [opts] `overrides` 是用户在配置里显式改过的节点（同 `(nodeId,fieldName)` 覆盖推断结果）
 * @returns {{ok:true,nodes:object[],outputKind:string,nodeCount:number,hints:object}|{ok:false,error:object}} 分析结果
 */
export function analyzeWorkflow(apiJson, opts = {}) {
  const norm = normalizeWorkflow(apiJson)
  if (!norm.ok) return norm
  const api = norm.api
  const warnings = norm.warnings.slice()

  // 枚举取值提示：同 class_type + 同 field 在别处出现过的标量值
  /** @type {Map<string,Set<string>>} */
  const enumHints = new Map()
  for (const [, node] of Object.entries(api)) {
    const cls = asString(node.class_type)
    for (const [f, raw] of Object.entries(node.inputs || {})) {
      if (isLink(raw)) continue
      const v = unwrapValue(raw).value
      if (typeof v !== 'string' && typeof v !== 'number') continue
      // 用 looksCategorical 而不是 ENUM_FIELDS：`aspect_ratio` 这类"分类但不在白名单"的字段
      // 也要参与取值汇聚 —— 同一工作流里出现 ≥2 个不同取值，才是"有选择空间"的真证据。
      if (!looksCategorical(f, v, cls)) continue
      const key = cls + '.' + f
      if (!enumHints.has(key)) enumHints.set(key, new Set())
      enumHints.get(key).add(String(v))
    }
  }

  const nodes = []
  for (const [nodeId, node] of Object.entries(api)) {
    for (const rec of nodesOf(nodeId, node, enumHints)) nodes.push(rec)
  }
  nodes.sort((a, b) => compareNodeIds(a.nodeId, b.nodeId) || (a.fieldName < b.fieldName ? -1 : 1))

  // **最后一道去重防线**：`(nodeId, fieldName)` 必须唯一（面板上不能出现两套一样的参数行）。
  // 根治在各推断分支的 `return`，这里是防止以后有人加分支忘了 return 的兜底。
  const dd = dedupeNodes(nodes)
  if (dd.dropped > 0) {
    warnings.push('推断出了 ' + String(dd.dropped) + ' 条重复的 (nodeId, fieldName) 记录，已按"有专门标签/分组"优先保留一条（推断分支可能漏了 return）')
  }
  const finalNodes = dd.nodes

  // 素材节点：同一 role 只有**第一个**是必填（模板里 image_1 是编辑目标，image_2..10 是可选参考图）。
  // 全标必填会让「只给一张图」直接被 validateRun 拦下，反而挡住正常用法。
  const seenMediaRole = new Set()
  for (const n of finalNodes) {
    if (n.role !== 'image' && n.role !== 'video' && n.role !== 'audio') continue
    if (seenMediaRole.has(n.role)) {
      n.required = false
      n.note = n.note || '同类型素材的后续槽位，可选'
    } else {
      seenMediaRole.add(n.role)
    }
  }

  // 用户/AI 的显式覆盖优先
  const overrides = Array.isArray(opts.overrides) ? opts.overrides : []
  for (const ov of overrides) {
    if (!ov || typeof ov !== 'object') continue
    const idx = finalNodes.findIndex((n) => String(n.nodeId) === String(ov.nodeId) && n.fieldName === ov.fieldName)
    if (idx < 0) {
      warnings.push('overrides 里的 nodeId=' + asString(ov.nodeId) + ' fieldName=' + asString(ov.fieldName) + ' 在工作流里不存在，已忽略')
      continue
    }
    const patch = { ...ov, overridable: true }
    // **用户在 configure 里显式给了候选清单 → 那是真枚举**（`optionsSource:'user'`），
    // validateRun 会按它拦；反过来，用户只改了 label/required 时**不能**把来源洗成 user，
    // 否则一个被锁死的字段会被"顺手改个名字"变成永久锁。
    const userOptions = Array.isArray(ov.options) ? ov.options.filter((x) => x !== null && x !== undefined) : null
    if (userOptions && userOptions.length > 0) {
      patch.optionsSource = asString(ov.optionsSource) || 'user'
      if (patch.valueType === undefined) patch.valueType = 'enum'
    }
    finalNodes[idx] = lossless({ ...finalNodes[idx], ...patch })
  }

  const inf = inferOutputs(api)
  const outputKind = inf.kinds.length === 0 ? 'image' : inf.kinds.length === 1 ? inf.kinds[0] : 'mixed'
  if (inf.kinds.length === 0) warnings.push('没找到 SaveImage/SaveVideo/SaveAudio 之类的输出节点，outputKind 兜底为 image')

  const roles = summarizeRoles(finalNodes)
  const primaryPrompt = finalNodes.find((n) => n.role === 'prompt')
  const primaryNegative = finalNodes.find((n) => n.role === 'negative_prompt')
  const mediaNodes = finalNodes.filter((n) => n.role === 'image' || n.role === 'video' || n.role === 'audio')
  const findField = (f) => finalNodes.find((n) => n.fieldName === f)

  const hints = lossless({
    source: norm.source,
    roles,
    outputs: inf.outputs,
    warnings,
    promptNodeId: primaryPrompt ? primaryPrompt.nodeId : null,
    promptFieldName: primaryPrompt ? primaryPrompt.fieldName : null,
    negativeNodeId: primaryNegative ? primaryNegative.nodeId : null,
    negativeFieldName: primaryNegative ? primaryNegative.fieldName : null,
    mediaNodes: mediaNodes.map((n) => ({ nodeId: n.nodeId, fieldName: n.fieldName, role: n.role })),
    widthNodeId: findField('width') ? findField('width').nodeId : null,
    heightNodeId: findField('height') ? findField('height').nodeId : null,
    seedNodeId: findField('seed') ? findField('seed').nodeId : null,
    stepsNodeId: findField('steps') ? findField('steps').nodeId : null,
    cfgNodeId: findField('cfg') ? findField('cfg').nodeId : null,
    /** 该工作流是否需要用户提供素材（决定 UI 里是否显示上传框） */
    needsMedia: mediaNodes.length > 0,
    /** 该工作流是否有可覆盖的提示词 */
    hasPrompt: !!primaryPrompt,
  })

  return { ok: true, nodes: lossless(finalNodes), outputKind, nodeCount: Object.keys(api).length, hints }
}

/* ═══════════════════════════ 4. 运行参数 → nodeInfoList ═══════════════════════════ */

/**
 * 把「一次运行的用户输入」映射成官方 `nodeInfoList`。
 *
 * `values` 形状（全部可选，缺省即不覆盖该字段）：
 * ```js
 * {
 *   prompt: '一只猫',                 // → role=prompt 的节点
 *   negativePrompt: '模糊',           // → role=negative_prompt 的节点
 *   params: { '6': 'x', '5:width': 1024, '13': { height: 768 } },  // nodeId / `nodeId:field` / `{field:value}`
 *   images: { '39': 'E:\\refs\\a.png', '40': 'openapi/b.png' },   // nodeId → **本地路径 或** RH 文件名
 *                                                                //   本地路径由 `runner.submit()` 用**同一把 key**
 *                                                                //   上传后替换成 fileName；已是 RH 文件名的原样放行
 * }
 * ```
 * **`fieldValue` 一律字符串化**（官方示例是字符串；数字/布尔也转字符串）。
 *
 * @param {object} config 工作流配置（`{rhWorkflowId, nodes:[...]}`）
 * @param {object} values 用户输入
 * @param {{includeDefaults?:boolean, issues?:object[]}} [opts] 收集未映射输入，供提交前校验使用
 * @returns {{nodeId:string,fieldName:string,fieldValue:string}[]} nodeInfoList（去重后，后写的覆盖先写的）
 */
export function buildNodeInfoList(config, values, opts = {}) {
  const nodes = Array.isArray(config && config.nodes) ? config.nodes : []
  const v = values && typeof values === 'object' ? values : {}
  const unmapped = (input) => {
    if (opts.issues) opts.issues.push({ code: 'INPUT_NOT_MAPPED', message: '输入 ' + input + ' 没有对应的已配置节点字段', hint: '查看该工作流的完整节点配置后使用正确的节点 ID 或字段名' })
  }
  /** @type {Map<string,{nodeId:string,fieldName:string,fieldValue:string}>} */
  const out = new Map()
  const put = (nodeId, fieldName, raw) => {
    if (nodeId === undefined || nodeId === null || fieldName === undefined || fieldName === null) return
    const key = String(nodeId) + '\u0000' + String(fieldName)
    out.set(key, { nodeId: String(nodeId), fieldName: String(fieldName), fieldValue: stringifyValue(raw) })
  }

  if (opts.includeDefaults === true) {
    for (const node of nodes) {
      if (node && node.default !== undefined && node.default !== null && node.default !== '') {
        put(node.nodeId, node.fieldName, node.default)
      }
    }
  }

  // promptOptimizer.targetNodeId 可指定正向或负向的提示词节点。
  const byRole = (role) => nodes.filter((n) => n && n.role === role)
  if (v.prompt !== undefined && v.prompt !== null && String(v.prompt) !== '') {
    const targetId = asString(config && config.promptOptimizer && config.promptOptimizer.targetNodeId)
    const target = targetId
      ? nodes.find((n) => n && String(n.nodeId) === targetId && ['prompt', 'negative_prompt'].includes(n.role))
      : byRole('prompt')[0]
    if (target) put(target.nodeId, target.fieldName, v.prompt)
    else if (targetId) {
      if (opts.issues) opts.issues.push({ code: 'PROMPT_TARGET_NOT_FOUND', message: '指定的提示词节点 ' + targetId + ' 不存在，请重新选择目标节点' })
    } else unmapped('prompt')
  }
  if (v.negativePrompt !== undefined && v.negativePrompt !== null && String(v.negativePrompt) !== '') {
    const target = byRole('negative_prompt')[0]
    if (target) put(target.nodeId, target.fieldName, v.negativePrompt)
    else unmapped('negativePrompt')
  }

  // ② params：三种键形状都支持
  if (v.params !== undefined && !isPlainObject(v.params)) unmapped('params（必须是对象）')
  else if (v.params) {
    for (const [key, value] of Object.entries(v.params)) {
      const target = resolveTarget(nodes, key)
      if (!target) {
        unmapped('params[' + JSON.stringify(key) + ']')
        continue
      }
      if (value === undefined || value === null || value === '') continue
      if (isPlainObject(value)) {
        for (const [f, val] of Object.entries(value)) {
          if (!target.fields.includes(f)) {
            unmapped('params[' + JSON.stringify(key) + '][' + JSON.stringify(f) + ']')
            continue
          }
          if (val === undefined || val === null) continue
          put(target.nodeId, f, val)
        }
      } else {
        put(target.nodeId, target.fieldName, value)
      }
    }
  }

  // ③ images：nodeId → **本地路径 或** RH 文件名。这里**只做透传** ——
  //    本地路径 → 上传的那一步在 `runner.submit()` 里（必须与 create 用同一把 key），
  //    `buildNodeInfoList` 是纯函数，不碰磁盘、不发请求。
  if (v.images !== undefined && !isPlainObject(v.images)) unmapped('images（必须是对象）')
  else if (v.images) {
    for (const [key, value] of Object.entries(v.images)) {
      const target = resolveTarget(nodes, key)
      if (!target) {
        unmapped('images[' + JSON.stringify(key) + ']')
        continue
      }
      if (value === undefined || value === null || value === '') continue
      put(target.nodeId, target.fieldName, value)
    }
  }

  return Array.from(out.values())
}

/**
 * `params`/`images` 的键 → 目标节点 + 字段。
 *
 * 键形状（**按这个顺序试**，先命中先赢）：
 *   1. `"6:text"` / `"6:width"` —— `nodeId:fieldName` 精确匹配
 *   2. `"6"`                    —— 纯 nodeId，取该节点的字段（`{field:value}` 时按对象里的键）
 *   3. `"prompt"` / `"negative_prompt"` / `"image"` —— **角色名**
 *   4. `"steps"` / `"width"` / `"seed"` —— **字段名**（`runninghub_call` 的 `params` 文档就写了这种用法）
 *
 * @param {object[]} nodes 配置里的节点
 * @param {string} key 键
 * @returns {{nodeId:string,fieldName:string,fields:string[]}|null} 目标
 */
function resolveTarget(nodes, key) {
  const k = asString(key)
  if (k === '') return null

  // 1. `nodeId:field`
  const colon = k.indexOf(':')
  if (colon > 0) {
    const nid = k.slice(0, colon)
    const f = k.slice(colon + 1)
    const hit = nodes.find((n) => n && String(n.nodeId) === nid && n.fieldName === f)
    if (hit) return { nodeId: hit.nodeId, fieldName: hit.fieldName, fields: [hit.fieldName] }
  }

  // 2. 纯 nodeId
  const same = nodes.filter((n) => n && String(n.nodeId) === k)
  if (same.length > 0) {
    // 同一节点多条记录时，优先 `prompt`（主提示词），否则第一条
    const preferred = same.find((n) => n.role === 'prompt') || same[0]
    return { nodeId: preferred.nodeId, fieldName: preferred.fieldName, fields: same.map((n) => n.fieldName) }
  }

  // 3. 角色名
  const byRole = nodes.filter((n) => n && asString(n.role) === k)
  if (byRole.length > 0) {
    return { nodeId: byRole[0].nodeId, fieldName: byRole[0].fieldName, fields: byRole.filter((n) => String(n.nodeId) === String(byRole[0].nodeId)).map((n) => n.fieldName) }
  }

  // 4. 字段名（`params:{"steps":20}` 这种写法）
  const byField = nodes.filter((n) => n && asString(n.fieldName) === k)
  if (byField.length > 0) {
    return { nodeId: byField[0].nodeId, fieldName: byField[0].fieldName, fields: byField.map((n) => n.fieldName) }
  }
  return null
}

/**
 * 官方 `fieldValue` 一律字符串化（数字/布尔都转字符串；对象转 JSON 串）。
 * @param {unknown} v 值
 * @returns {string} 字符串
 */
export function stringifyValue(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : ''
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return String(v)
  }
}

/* ═══════════════════════════ 5. 干跑校验 ═══════════════════════════ */

/**
 * 干跑校验：必填缺失 / 枚举越界 / 数值越范围 / region 没 key。**不联网、不落盘**。
 *
 * ## 阻塞 vs 非阻塞（Lead 2026-09 拍板的分界）
 *
 * 原则：**插件的猜测不该拦用户的活**。
 * - **`issues`（阻塞，`ok = issues.length === 0`）**：必填缺失 · **真枚举**越界
 *   （`optionsSource` 为 `workflow`/`user`）· `boundsSource === 'workflow'` 的范围越界 ·
 *   **结构性不可能**（`boundsSource === 'structural'`，如 `denoise` 0–1、`seed` 非负整数）·
 *   类型错误（`VALUE_NOT_A_NUMBER` —— 工作流 JSON 里该字段本来就是数字，不是我们在猜）。
 * - **`warnings`（不阻塞，照跑）**：`boundsSource === 'heuristic'` 的范围越界 ——
 *   `NUMBER_HINTS` 是我们手写的"常见区间"，**不是工作流契约**；用户想跑 `steps: 200`、
 *   `megapixels: 20` 该由 **RunningHub 服务端**去拒，它的报错比我们准。
 *
 * 老配置（无 `boundsSource` / 无 `optionsSource`）**按阻塞处理**（向后兼容，别把用户手工配的约束放开），
 * 唯一例外见下面 `legacySingleOption` 的注释。
 *
 * @param {object} config 工作流配置
 * @param {object} values 用户输入（同 `buildNodeInfoList`）
 * @param {{pool?:{pick:Function}, hasKeyForRegion?:Function}} [opts] 传入 `pool` 时顺带检查 region 池
 * @returns {{ok:boolean, issues:object[], warnings:object[]}} 结果（`ok` **只看 `issues`**）
 */
export function validateRun(config, values, opts = {}) {
  const issues = []
  const warnings = []
  const nodes = Array.isArray(config && config.nodes) ? config.nodes : []
  const list = buildNodeInfoList(config, values, { includeDefaults: true, issues })
  const provided = new Set(list.map((x) => x.nodeId + '\u0000' + x.fieldName))

  // ① 必填
  for (const n of nodes) {
    if (!n || !n.required) continue
    const filled = provided.has(String(n.nodeId) + '\u0000' + String(n.fieldName))
    const fallback = asString(n.default)
    if (!filled && fallback === '') {
      issues.push({
        code: 'NODE_MISSING',
        nodeId: String(n.nodeId),
        fieldName: asString(n.fieldName),
        message: '必填项没有值：' + (asString(n.label) || asString(n.fieldName)) + '（节点 ' + String(n.nodeId) + '）',
        hint: n.role === 'prompt' ? '传 values.prompt，或 values.params["' + String(n.nodeId) + ':' + asString(n.fieldName) + '"]' : '在 runninghub_call 的 images/params 里补上',
      })
    }
  }

  // ② 枚举越界 / ③ 数值越范围（只校验实际传了值的字段）
  const eff = new Map(list.map((x) => [x.nodeId + '\u0000' + x.fieldName, x.fieldValue]))
  for (const n of nodes) {
    if (!n) continue
    const key = String(n.nodeId) + '\u0000' + String(n.fieldName)
    if (!eff.has(key)) continue
    const raw = eff.get(key)

    if (n.valueType === 'enum') {
      const options = Array.isArray(n.options) ? n.options.map(asString) : []
      // **只有"真枚举"才拦**（Lead 真机抓到的锁死缺陷）：
      //   `workflow`/`user`      → 有候选清单，拦
      //   `inferred-from-default` → 候选清单是**从当前值反推**出来的，拦它就是"把当前值当契约"
      //   **缺省（老配置）**      → 向后兼容地拦，但**单选项例外**：
      //     老版本落盘的配置全是 `enum` + 1 个选项，那正是被锁死的那批；
      //     而用户手工配的真枚举一定 ≥2 个选项，所以这条例外不会放开任何真枚举。
      //
      // ⚠️ `legacySingleOption` 是**有意的取舍**（Lead 明确同意保留），不是漏洞：
      //    它不是"≤1 个选项就不校验"的偷懒，而是"单选项的老配置 = 被 bug 锁死的数据，
      //    放行它们用户才不必重跑 probe 就能解锁"。**别随手删。**
      const source = asString(n.optionsSource)
      const isRealEnum = source === 'workflow' || source === 'user'
      const legacySingleOption = source === '' && options.length <= 1
      if ((isRealEnum || (source === '' && !legacySingleOption)) && options.length > 0 && !options.includes(raw)) {
        issues.push({
          code: 'ENUM_OUT_OF_RANGE',
          nodeId: String(n.nodeId),
          fieldName: asString(n.fieldName),
          message: '值「' + raw + '」不在允许的枚举里：' + options.join(' / '),
          hint:
            source === 'user'
              ? '这是你在 workflow.configure 里显式给定的候选清单'
              : '候选值来自工作流里实际出现过的取值；确需新值请先在工作流里确认',
        })
      }
    } else if (n.valueType === 'number') {
      const num = Number(raw)
      if (!Number.isFinite(num)) {
        // 工作流 JSON 里这个字段本来就是数字 → 类型错是**结构性**的，不是猜测，阻塞
        issues.push({
          code: 'VALUE_NOT_A_NUMBER',
          nodeId: String(n.nodeId),
          fieldName: asString(n.fieldName),
          message: '「' + raw + '」不是数字',
        })
      } else {
        const min = n.min == null ? null : toNumber(n.min, NaN)
        const max = n.max == null ? null : toNumber(n.max, NaN)
        // 范围是**谁**说的决定阻不阻塞：
        //   `heuristic`（缺省也算老配置，向后兼容地阻塞）→ 插件手写的常见区间 → **只警告**
        //   `structural` / `workflow`                    → 算法定义 / 工作流自带 → **阻塞**
        const source = asString(n.boundsSource) || 'legacy'
        const blocking = source !== 'heuristic'
        const bucket = blocking ? issues : warnings
        const why = blocking ? '' : '（该范围是插件给的常见区间，非工作流约束；服务端仍会校验）'
        if (min !== null && Number.isFinite(min) && num < min) {
          bucket.push({
            code: 'VALUE_OUT_OF_RANGE',
            nodeId: String(n.nodeId),
            fieldName: asString(n.fieldName),
            message: '值 ' + String(num) + ' 小于下限 ' + String(min) + why,
            ...(blocking ? {} : { hint: '照跑即可；确实需要更大/更小的值，直接传，由 RunningHub 侧判定' }),
          })
        }
        if (max !== null && Number.isFinite(max) && num > max) {
          bucket.push({
            code: 'VALUE_OUT_OF_RANGE',
            nodeId: String(n.nodeId),
            fieldName: asString(n.fieldName),
            message: '值 ' + String(num) + ' 大于上限 ' + String(max) + why,
            ...(blocking ? {} : { hint: '照跑即可；确实需要更大/更小的值，直接传，由 RunningHub 侧判定' }),
          })
        }
      }
    }
  }

  // ④ region 池里有没有可用 key（**跨池绝不回退**）
  const region = asString(config && config.region) || 'cn'
  if (typeof opts.hasKeyForRegion === 'function') {
    if (opts.hasKeyForRegion(region) !== true) {
      issues.push({
        code: 'NO_KEY',
        message: 'region=' + region + ' 的 key 池里没有可用 key',
        hint: '国内(runninghub.cn)与海外(runninghub.ai)的 key 不通用；**绝不跨池回退**',
      })
    }
  } else if (opts.pool && typeof opts.pool.pick === 'function') {
    const picked = opts.pool.pick({ region })
    if (!picked || picked.ok !== true) {
      issues.push({
        code: picked && picked.error && picked.error.code ? picked.error.code : 'NO_KEY',
        message: 'region=' + region + ' 的 key 池里没有可用 key',
        hint: '国内(runninghub.cn)与海外(runninghub.ai)的 key 不通用；**绝不跨池回退**',
      })
    }
  }

  // `ok` **只看 `issues`**：`warnings` 不阻塞（插件的猜测不该拦用户的活）
  return { ok: issues.length === 0, issues: lossless(issues), warnings: lossless(warnings) }
}

/* ═══════════════════════════ 6. 便捷函数 ═══════════════════════════ */

/**
 * 取配置的默认运行值（UI 表单初值与「只改一个参数」场景）。
 * @param {object} config 工作流配置
 * @returns {{prompt:string,negativePrompt:string,params:object,images:object}} 默认值
 */
export function defaultValues(config) {
  const nodes = Array.isArray(config && config.nodes) ? config.nodes : []
  const params = {}
  const images = {}
  let prompt = ''
  let negativePrompt = ''
  for (const n of nodes) {
    if (!n) continue
    if (n.role === 'prompt' && prompt === '') prompt = asString(n.default)
    else if (n.role === 'negative_prompt' && negativePrompt === '') negativePrompt = asString(n.default)
    else if (n.role === 'image' || n.role === 'video' || n.role === 'audio') images[String(n.nodeId)] = ''
    else if (n.default !== undefined && n.default !== null && n.default !== '') params[String(n.nodeId) + ':' + asString(n.fieldName)] = n.default
  }
  return lossless({ prompt, negativePrompt, params, images })
}

/**
 * 把 AI 的节点提案转成一份**未落盘**的工作流配置骨架（`workflow.probe` 回执用）。
 * @param {{rhWorkflowId:string,region?:string,name?:string,displayNameEn?:string}} meta 元信息
 * @param {object} analysis `analyzeWorkflow` 的结果
 * @returns {object} 配置骨架
 */
export function draftConfig(meta, analysis) {
  const now = Date.now()
  const name = asString(meta && meta.name) || ('工作流 ' + asString(meta && meta.rhWorkflowId))
  return lossless({
    id: asString(meta && meta.id) || asString(meta && meta.rhWorkflowId) || 'wf',
    name,
    displayNameEn: asString(meta && meta.displayNameEn),
    rhWorkflowId: asString(meta && meta.rhWorkflowId),
    region: asString(meta && meta.region) || 'cn',
    outputKind: (analysis && analysis.outputKind) || 'image',
    tags: [],
    description: '',
    instanceType: 'default',
    nodes: (analysis && analysis.nodes) || [],
    promptOptimizer: { enabled: false, docId: null, asSubagentSystemPrompt: false, targetNodeId: null, extraInstruction: '' },
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  })
}
