/**
 * dsh-runninghub-plugin · `runninghub_call`
 *
 * 模型侧**唯一的执行入口**。全部动作走一张分发表，未知动作回动作清单（可自纠）。
 *
 * 铁律（每一条都有代价）：
 *   - **付费提交绝不自动重投**：提交阶段网络不确定 → 任务进 `UNCERTAIN`，让用户核对。
 *   - **明文 key 绝不进回执**：所有 key 一律 `maskKey()`。
 *   - **错误不抛异常**：统一 `{ok:false,error:{code,message,hint}}`，模型能据此换策略。
 *   - **任务以后台形式跑**：`workflow.run` 立刻返回 taskId；`task.wait` 才阻塞并取回图片/视频。
 *
 * @module dsh-runninghub-plugin/host/tools/call
 */

import { defineRHTool, renderStructured, ANY_SCHEMA, ok, fail, envelope, maskKey, safeStringify, workflowIdOf, PLUGIN_VERSION } from '../shared.mjs'
import { CALL_ACTIONS, summarizeWorkflow } from './search.mjs'
import { findJobsService, startTaskJob } from '../jobs.mjs'
import path from 'node:path'
import { runtimeRedactor } from '../security.mjs'

const NL = String.fromCharCode(10)

/** 本插件包名 —— 必须与 `package.json`、Remote 命名空间的 `package` 字段、以及 `plugins.bundle.config` 的 key 一致。 */
const PKG_NAME = 'dsh-runninghub-plugin'

/**
 * 默认输出文件夹名（**在会话工作目录下新建**）。
 *
 * 用户明确要求：结果别丢在 `~/.dsh` 里，要落在"当前工作目录下的新建文件夹"。
 * 用 ASCII 名字避免各种文件系统/工具链的编码坑。
 */
const DEFAULT_OUTPUT_FOLDER = 'runninghub-output'

/** 提示词优化子代理的人设（极简、无工具、只管写提示词）。 */
const PROMPT_AGENT_PERSONA =
  '你是一个提示词工程师，只做一件事：把用户的诉求按给定规范改写成一条可直接投喂给图像/视频生成工作流的提示词。' +
  '你没有工具，也不需要工具。只输出提示词本身，不要解释、不要前后缀、不要引号、不要 markdown 代码块。'

/**
 * 构造 `runninghub_call` 工具。
 *
 * @param {(ctx:any)=>import('../runtime.mjs').Runtime} getRuntime 取当前运行时
 * @returns {object} registry-ready 工具定义
 */
export function makeCallTool(getRuntime) {
  return defineRHTool({
    name: 'runninghub_call',
    redactor: (args) => runtimeRedactor(getRuntime(), args),
    description:
      '【RunningHub · 执行】按 action 执行 RunningHub 的一切操作：看工作流详情 / 拉取并推断工作流节点 / 落盘配置 / 校验 / **后台跑工作流** / 查任务 / 取结果（图片会直接在聊天里显示）/ 查余额 / 管 Key / 读提示词优化文档 / 优化提示词 / 自检。' +
      '第一次用请先调 runninghub_search 拿到工作流名与动作清单。action 写错时会返回动作清单。' +
      'workflow.run 默认返回 taskId；可传 waitMs 在提交后等待，或用 task.wait 取回结果。',
    parameters: {
      action: {
        type: 'string',
        description:
          '要执行的动作。可选：' + CALL_ACTIONS.map((a) => a[0]).join(' | '),
      },
      name: { type: 'string', description: '工作流名（workflow.get / update / delete / validate / run / prompt.* 用）' },
      workflowId: { type: 'string', description: 'RunningHub 侧工作流 ID（workflow.probe 用）' },
      region: { type: 'string', description: "'cn'(国内 runninghub.cn) | 'overseas'(海外 runninghub.ai)。Key 不通用，必须与 key 的地域一致" },
      prompt: { type: 'string', description: '正向提示词（workflow.run / prompt.doc_write / prompt.optimize）' },
      negativePrompt: { type: 'string', description: '负向提示词（workflow.run）' },
      params: { type: 'json', description: '节点参数覆盖，形如 {"6":{"text":"a cat"}} 或 {"3":{"seed":123,"steps":20}}；也可用 {"steps":20} 形式按字段名匹配' },
      images: { type: 'json', description: '参考图/视频/音频：{"<nodeId>":"<本地绝对路径 或 RunningHub 文件名>"}。本地路径由插件**自动上传**（与提交用同一把 Key），也接受已经是 RH 文件名的值（不会被重复上传）' },
      taskId: { type: 'string', description: '任务 ID（task.status / task.wait / task.cancel）' },
      timeoutMs: { type: 'integer', description: 'task.wait 的等待上限毫秒，默认 600000（10 分钟），最大 1800000' },
      waitMs: { type: 'integer', description: 'workflow.run 提交后额外等待的毫秒数；0（默认）= 纯后台立刻返回' },
      status: { type: 'string', description: 'task.list 的状态过滤' },
      limit: { type: 'integer', description: 'task.list 返回条数，默认 20' },
      key: { type: 'string', description: 'API Key（key.add）' },
      label: { type: 'string', description: 'Key 备注名（key.add / key.update）' },
      priority: { type: 'integer', description: 'Key 优先级，越小越先用（key.add / key.update），默认 100' },
      id: { type: 'string', description: 'Key 的本地 id（key.update / key.remove / key.detect / key.balance）' },
      patch: { type: 'json', description: 'workflow.update 的局部补丁；或 key.update 的字段补丁' },
      nodes: { type: 'json', description: 'workflow.configure 的节点数组（一般用 workflow.probe 的提案直接改）' },
      config: { type: 'json', description: 'workflow.configure 的完整配置对象（与 nodes 二选一/并用）' },
      docId: { type: 'string', description: '提示词优化文档 id（prompt.doc_read）' },
      content: { type: 'string', description: '提示词优化文档正文（prompt.doc_write）' },
      filename: { type: 'string', description: '文档来源文件名（prompt.doc_write，可选）' },
      userRequest: { type: 'string', description: '用户的原始诉求（prompt.optimize）：子代理据此写提示词' },
      repeat: { type: 'integer', description: 'workflow.run 的批量次数（1–20，默认 1）；每次独立提交' },
      background: { type: 'boolean', description: 'workflow.run：true 时提交后立即返回，忽略 waitMs。宿主有 jobs 服务时会发送完成通知；省略时按 waitMs 决定是否等待' },
      saveDir: { type: 'string', description: 'workflow.run：结果保存目录。相对路径按会话工作目录解析。省略时优先使用 outputDir 配置，再用工作目录/runninghub-output；无法取得工作目录时存到插件数据目录' },
      fileName: { type: 'string', description: 'workflow.run：结果**文件名**（可省扩展名，会自动补 .png/.webp 等；多张图自动去重成 名_2/名_3，绝不互相覆盖）。文件名里可以放中文' },
      confirm: { type: 'boolean', description: '危险动作（workflow.delete）需显式 true' },
    },
    output: { schema: ANY_SCHEMA, render: renderStructured },
    isConcurrencySafe: () => false,
    timeoutMs: 1800000,
    async execute(args, exec) {
      const rt = getRuntime()
      const redact = runtimeRedactor(rt, args)
      const action = String((args && args.action) || '').trim()
      if (action.length === 0) return unknownAction('（空）')

      const handler = HANDLERS[action]
      if (!handler) return unknownAction(action)

      const coreErr = rt.requireCore()
      if (coreErr && action !== 'diagnostics') {
        return fail(
          'CORE_NOT_LOADED',
          '插件协议层未装载，所有动作都不可用：' + String((coreErr.error && coreErr.error.message) || ''),
          '调 runninghub_call({action:"diagnostics"}) 看 loadError；多数是插件包不完整。',
        )
      }

      try {
        const out = await handler({ rt, args: args || {}, exec })
        if (action.startsWith('key.') && action !== 'key.balance' && out && out.ok === true && typeof rt.flushPersistence === 'function') {
          const saved = await rt.flushPersistence()
          if (!saved.ok) return fail('STORE_WRITE_FAILED', 'Key 修改尚未保存到磁盘', '修改仅在当前进程中生效；请检查数据目录权限和磁盘空间。')
        }
        return finalize(out)
      } catch (e) {
        rt.warn(redact('动作 ' + action + ' 失败：' + String((e && e.stack) || e)))
        return fail('INTERNAL', '动作 ' + action + ' 执行异常：' + String((e && e.message) || e))
      }
    },
  })
}

/** 统一收口：保证每个回执都有可读 text 与结构化 envelope。 */
function finalize(out) {
  if (!out || typeof out !== 'object') return fail('INTERNAL', '动作没有返回结果')
  if (out.ok === false) {
    const err = out.error || {}
    out.text =
      (out.text ? String(out.text) + NL + NL : '') +
      '❌ ' + String(err.code || 'ERROR') + '：' + String(err.message || '') +
      (err.hint ? NL + '   → ' + String(err.hint) : '')
  }
  if (typeof out.envelope !== 'string') {
    const env = safeStringify({ ok: out.ok !== false, ...(out.error ? { error: out.error } : {}), ...(out.data === undefined ? {} : { data: out.data }) })
    out.envelope = env === null ? '' : env
  }
  if (typeof out.text !== 'string') out.text = ''
  return out
}

/** 未知动作 → 回动作清单（模型可自纠，不用人插手）。 */
function unknownAction(action) {
  const lines = ['❌ 不认识的 action：' + action, '', renderActionListText()]
  return {
    ok: false,
    error: { code: 'UNKNOWN_ACTION', message: '不认识的 action：' + action, hint: '从下面的清单里选一个' },
    text: lines.join(NL),
    envelope: safeStringify({ ok: false, code: 'UNKNOWN_ACTION', action }) || '',
  }
}

function renderActionListText() {
  const out = ['可用动作：']
  for (const [n, sig, d] of CALL_ACTIONS) out.push('  · ' + n + ' ' + sig + ' —— ' + d)
  return out.join(NL)
}

/* ───────────────────────────────── 工具小函数 ───────────────────────────────── */

function num(v, dflt, lo, hi) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo === undefined ? -Infinity : lo, Math.min(hi === undefined ? Infinity : hi, n))
}

function truthy(v) {
  return v === true || v === 'true' || v === 1 || v === '1'
}

/** 从参数里挑工作流配置（按 name 或 displayNameEn，大小写不敏感）。 */
async function findWorkflow(rt, name) {
  const target = String(name || '').trim()
  if (target.length === 0) return { error: fail('BAD_REQUEST', '缺少 name（工作流名）', '先调 runninghub_search 看有哪些工作流') }
  const list = (await rt.store.listWorkflows()) || []
  const lower = target.toLowerCase()
  const hit =
    list.find((w) => String(w.name) === target) ||
    list.find((w) => String(w.displayNameEn || '').toLowerCase() === lower) ||
    list.find((w) => String(w.id) === target) ||
    list.find((w) => String(w.name).toLowerCase() === lower)
  if (!hit) {
    const names = list.map((w) => String(w.name)).slice(0, 30)
    return {
      error: fail(
        'WORKFLOW_NOT_FOUND',
        '本地没有名为「' + target + '」的工作流配置',
        names.length === 0
          ? '本机还没有任何工作流配置，先按 skill `runninghub-workflow-setup` 走一遍配置流程。'
          : '现有工作流：' + names.join(' / '),
      ),
    }
  }
  return { wf: hit }
}

/** 解析 region：显式 > 工作流配置 > 池里唯一可用的地域。 */
function resolveRegion(rt, explicit, wf) {
  const r = String(explicit || (wf && wf.region) || '').trim().toLowerCase()
  if (r === 'cn' || r === 'overseas') return r
  const stats = rt.pool && typeof rt.pool.poolStats === 'function' ? rt.pool.poolStats() : null
  if (stats) {
    const cnOk = stats.cn && stats.cn.available > 0
    const osOk = stats.overseas && stats.overseas.available > 0
    if (cnOk && !osOk) return 'cn'
    if (osOk && !cnOk) return 'overseas'
  }
  return 'cn'
}

/* ───────────────────────────────── 动作实现 ───────────────────────────────── */

const HANDLERS = {}

/* ── 工作流：看详情 ── */
HANDLERS['workflow.get'] = async ({ rt, args }) => {
  const found = await findWorkflow(rt, args.name)
  if (found.error) return found.error
  const wf = found.wf
  const s = summarizeWorkflow(wf)
  const lines = []
  lines.push('【工作流】' + s.name + (s.displayNameEn ? ' (' + s.displayNameEn + ')' : ''))
  lines.push('  RunningHub ID：' + (s.rhWorkflowId || '（未设置）') + ' · 地域：' + s.region + ' · 输出：' + s.outputKindLabel)
  if (s.description) lines.push('  说明：' + s.description)
  if (s.tags.length) lines.push('  标签：' + s.tags.join(' / '))
  lines.push('')
  lines.push('  节点（' + String(s.nodeCount) + ' 个）：')
  for (const n of wf.nodes || []) {
    const bits = ['    · [' + n.role + '] node ' + n.nodeId + ' · ' + n.classType + ' · 字段 ' + n.fieldName]
    if (n.label) bits.push('· ' + n.label)
    if (n.required) bits.push('· 必填')
    if (n.valueType === 'number' && (n.min !== undefined || n.max !== undefined)) bits.push('· 范围 ' + String(n.min) + '–' + String(n.max))
    if (Array.isArray(n.options) && n.options.length) bits.push('· 可选值 ' + n.options.join('|'))
    if (n.default !== undefined && n.default !== null && n.default !== '') bits.push('· 默认 ' + JSON.stringify(n.default))
    lines.push(bits.join(' '))
  }
  const opt = wf.promptOptimizer || {}
  lines.push('')
  lines.push('  提示词优化：' + (opt.enabled ? '已开启' : '未开启') + (opt.docId ? ' · 文档 ' + opt.docId : '') + (opt.asSubagentSystemPrompt ? ' · **子代理模式**' : ''))
  if (opt.enabled && opt.docId) {
    lines.push('  ⚠ 运行前必须先读文档：runninghub_call({action:"prompt.doc_read", name:"' + s.name + '"})')
    lines.push(
      opt.asSubagentSystemPrompt
        ? '    读完调 runninghub_call({action:"prompt.optimize", name:"' + s.name + '", userRequest:"…"})，由无工具子代理按文档写提示词。'
        : '    该工作流未开子代理模式：你需要**自己**按文档把用户诉求改写成本工作流的提示词。',
    )
  }
  return { ok: true, text: lines.join(NL), data: wf }
}

/* ── 工作流：从 RunningHub 拉 JSON 并推断节点（AI 辅助配置第一步） ── */
HANDLERS['workflow.probe'] = async ({ rt, args }) => {
  const workflowId = String(args.workflowId || '').trim()
  if (workflowId.length === 0) {
    return fail('BAD_REQUEST', '缺少 workflowId', '问用户要 RunningHub 工作流链接（形如 https://www.runninghub.cn/ai-detail/<id>），从 URL 里取数字 ID')
  }
  const region = resolveRegion(rt, args.region, null)
  const picked = rt.pool.pick({ region })
  if (!picked || picked.ok === false) {
    return fail(
      'NO_KEY',
      '「' + region + '」池里没有可用 Key，取不了工作流 JSON',
      '国内(runninghub.cn)与海外(runninghub.ai)的 Key **不通用**。让用户提供该地域的 Key，再 runninghub_call({action:"key.add", key:"…"})。',
    )
  }
  let res
  try {
    res = await rt.api.getWorkflowJson(picked.key, region, workflowId)
  } finally {
    if (picked.id) rt.pool.report(picked.id, 'ok')
  }
  if (!res || res.ok === false) {
    const code = (res && res.error && res.error.code) || 'UNKNOWN'
    if (picked.id) rt.pool.report(picked.id, code)
    return fail(code, '取工作流 JSON 失败：' + String((res && res.error && res.error.message) || ''), '确认工作流 ID 属于「' + region + '」这个平台，且该 Key 有权限读它。')
  }
  const analyzed = rt.workflow.analyzeWorkflow(res.workflow)
  if (!analyzed || analyzed.ok === false) {
    return fail('PARSE_FAILED', '工作流 JSON 解析失败：' + String((analyzed && analyzed.error && analyzed.error.message) || ''))
  }
  const lines = []
  lines.push('【工作流提案】来自 RunningHub 工作流 ' + workflowId + '（' + region + '）')
  lines.push('  推断输出类型：' + String(analyzed.outputKind) + ' · 节点 ' + String(analyzed.nodeCount) + ' 个')
  lines.push('')
  lines.push('  推断出的节点角色（**请逐条向用户确认**，不要默认全对）：')
  for (const n of analyzed.nodes || []) {
    lines.push(
      '    · node ' + n.nodeId + ' · ' + n.classType + ' · role=' + n.role + ' · 字段 ' + n.fieldName +
        (n.valueType ? ' · 类型 ' + n.valueType : '') +
        (n.default !== undefined && n.default !== null && n.default !== '' ? ' · 默认 ' + JSON.stringify(n.default).slice(0, 60) : ''),
    )
  }
  lines.push('')
  lines.push('  下一步：把这些提案连同下面这几个问题一起问用户 ——')
  lines.push('    1) 哪个节点是正向提示词？（当前推断：' + firstOfRole(analyzed.nodes, 'prompt') + '）')
  lines.push('    2) 有没有负向提示词？（）')
  lines.push('    3) 有哪些参考图/视频/音频节点？（）')
  lines.push('    4) 哪些数值参数要让用户可调？范围是多少？（）')
  lines.push('    5) 这个工作流叫什么名字？输出是图 / 视频 / 音频 / 3D？（）')
  lines.push('    6) 用国内还是海外的 Key？（）')
  lines.push('    7) 要不要开提示词优化？要不要挂优化文档？要不要用子代理模式？（）')
  lines.push('  确认后调 runninghub_call({action:"workflow.configure", ...}) 落盘。')
  return { ok: true, text: lines.join(NL), data: { proposal: analyzed, rhWorkflowId: workflowId, region } }
}

function firstOfRole(nodes, role) {
  const hit = (nodes || []).find((n) => n.role === role)
  return hit ? 'node ' + hit.nodeId : '无'
}

/* ── 工作流：落盘配置 ── */
HANDLERS['workflow.configure'] = async ({ rt, args }) => {
  const cfg = { ...(args.config && typeof args.config === 'object' ? args.config : {}) }
  if (args.name) cfg.name = String(args.name)
  if (args.workflowId) cfg.rhWorkflowId = String(args.workflowId)
  if (args.region) cfg.region = String(args.region)
  if (Array.isArray(args.nodes)) cfg.nodes = args.nodes
  if (cfg.nodes === undefined && cfg.config === undefined) {
    return fail('BAD_REQUEST', '缺少 nodes 或 config', '先 workflow.probe 拿提案，人工确认后把 nodes 传进来')
  }
  const name = String(cfg.name || '').trim()
  if (name.length === 0) return fail('BAD_REQUEST', '缺少 name（工作流名）', '问用户给这个工作流起个名字')
  const id = workflowIdOf({ ...cfg, name })
  const saved = await rt.store.saveWorkflow({ ...cfg, id, name, updatedAt: Date.now(), schemaVersion: 1 })
  if (!saved || saved.ok === false) {
    return fail('SAVE_FAILED', '落盘失败：' + String((saved && saved.error && saved.error.message) || ''))
  }
  return {
    ok: true,
    text: '✅ 已保存工作流「' + name + '」(id ' + id + ')。' + NL + '  现在它出现在 runninghub_search 的列表里了；可以 workflow.validate 自检，或直接 workflow.run 跑一次。',
    data: { name, id },
  }
}

/* ── 工作流：局部更新 ── */
HANDLERS['workflow.update'] = async ({ rt, args }) => {
  const found = await findWorkflow(rt, args.name)
  if (found.error) return found.error
  const patch = args.patch && typeof args.patch === 'object' ? args.patch : null
  if (!patch) return fail('BAD_REQUEST', '缺少 patch', 'patch 是一个对象，只写要改的字段，例如 {"promptOptimizer":{"enabled":true,"docId":"xxx"}}')
  const merged = deepMerge(found.wf, patch)
  merged.updatedAt = Date.now()
  const saved = await rt.store.saveWorkflow(merged)
  if (!saved || saved.ok === false) return fail('SAVE_FAILED', '更新失败：' + String((saved && saved.error && saved.error.message) || ''))
  return { ok: true, text: '✅ 已更新工作流「' + String(found.wf.name) + '」的 ' + Object.keys(patch).join(' / ') + ' 字段。' }
}

/* ── 工作流：删除 ── */
HANDLERS['workflow.delete'] = async ({ rt, args }) => {
  if (!truthy(args.confirm)) {
    return fail('NEED_CONFIRM', '删除是不可逆的，需要 confirm:true', '先跟用户确认一次，再带 confirm:true 重调')
  }
  const found = await findWorkflow(rt, args.name)
  if (found.error) return found.error
  const r = await rt.store.deleteWorkflow(found.wf.id || found.wf.name)
  if (r && r.ok === false) return fail('DELETE_FAILED', String((r.error && r.error.message) || ''))
  return { ok: true, text: '✅ 已删除本地配置「' + String(found.wf.name) + '」（RunningHub 侧的工作流没动）。' }
}

/* ── 工作流：干跑校验 ── */
HANDLERS['workflow.validate'] = async ({ rt, args }) => {
  const found = await findWorkflow(rt, args.name)
  if (found.error) return found.error
  const wf = found.wf
  const issues = []
  if (!wf.rhWorkflowId) issues.push({ code: 'NO_WORKFLOW_ID', message: '没有设置 RunningHub 工作流 ID' })
  if (!(wf.nodes || []).some((n) => n.role === 'prompt')) issues.push({ code: 'NO_PROMPT_NODE', message: '没有标记任何正向提示词节点' })
  for (const n of wf.nodes || []) {
    if (n.required && (n.default === undefined || n.default === null || n.default === '')) {
      issues.push({ code: 'REQUIRED_EMPTY', nodeId: n.nodeId, message: '节点 ' + n.nodeId + '（' + n.fieldName + '）标了必填但没有默认值' })
    }
  }
  const region = resolveRegion(rt, args.region, wf)
  const stats = rt.pool.poolStats ? rt.pool.poolStats() : null
  const poolOk = stats ? (stats[region] ? stats[region].available : 0) : 0
  if (poolOk === 0) {
    issues.push({ code: 'NO_KEY', message: '「' + region + '」池里没有可用 Key（Key 国内/海外不通用）' })
  }
  const lines = ['【校验】' + String(wf.name) + '（地域 ' + region + '，可用 Key ' + String(poolOk) + ' 把）']
  if (issues.length === 0) lines.push('  ✅ 没发现问题，可以 workflow.run。')
  else for (const i of issues) lines.push('  ⚠ [' + i.code + '] ' + i.message)
  return { ok: issues.length === 0, ...(issues.length ? { error: { code: 'VALIDATION_FAILED', message: issues.map((i) => i.message).join('；') } } : {}), text: lines.join(NL), data: { issues, region } }
}

/* ── 工作流：跑之前先问价 ── */
HANDLERS['workflow.price'] = async ({ rt, args }) => {
  const found = await findWorkflow(rt, args.name)
  if (found.error) return found.error
  const wf = found.wf
  // price-preview 只对**标准模型 API**（`/openapi/v2/<model-path>`）有效；
  // ComfyUI 工作流走 `/task/openapi/create`，官方没给它的报价接口 —— 如实说明，不假装能报。
  const modelPath = String(args.modelPath || wf.modelPath || '').trim()
  if (modelPath.length === 0) {
    return {
      ok: true,
      text:
        'ℹ 「' + String(wf.name) + '」是 ComfyUI 工作流（走 `/task/openapi/create`），' +
        'RunningHub 的**报价接口只对标准模型 API 有效**，这个工作流问不到价。' +
        NL + '  · 想看够不够钱：runninghub_call({action:"account.balance"})' +
        NL + '  · 想直接跑：runninghub_call({action:"workflow.run", name:"' + String(wf.name) + '"})',
      data: { supported: false, reason: 'comfyui-workflow-not-quotable' },
    }
  }
  const region = resolveRegion(rt, args.region, wf)
  const picked = rt.pool.pick({ region })
  if (!picked || picked.ok === false) return fail('NO_KEY', '「' + region + '」池里没有可用 Key')
  if (typeof rt.api.pricePreview !== 'function') {
    return fail('NOT_AVAILABLE', '协议层没有 pricePreview（core 版本较旧）')
  }
  const r = await rt.api.pricePreview(picked.key, region, { modelPath, payload: {} })
  if (!r || r.ok === false) {
    const code = (r && r.error && r.error.code) || 'NOT_AVAILABLE'
    // AUTH / QUOTA 原样上抛：那是用户必须去处理 key 的事，折成"价格未知"会把真问题藏起来。
    if (code === 'AUTH' || code === 'QUOTA') {
      rt.pool.report(picked.id, code)
      return fail(code, String((r.error && r.error.message) || '查价被拒'), (r.error && r.error.hint) || '')
    }
    return {
      ok: true,
      text:
        'ℹ 价格未知（' + code + '：' + String((r && r.error && r.error.message) || '') + '）。' +
        NL + '  **报价失败不该拦住你干活** —— 仍可直接 runninghub_call({action:"workflow.run", name:"' + String(wf.name) + '"})。',
      data: { supported: false, code, error: (r && r.error) || null },
    }
  }
  rt.pool.report(picked.id, 'ok')
  const free = r.isFreeThisCall
    ? '本次免费'
    : r.remainingFreeLimitCount !== null && r.remainingFreeLimitCount !== undefined
      ? '剩余免费额度 ' + String(r.remainingFreeLimitCount) + ' 次'
      : '无免费额度信息'
  const price = String(r.priceText || r.priceTextEn || (r.estimatedPrice !== undefined ? String(r.estimatedPrice) + ' ' + String(r.currency || '') : '未知')).trim()
  return {
    ok: true,
    text: ['【报价】' + String(wf.name) + '（' + region + ' · ' + modelPath + '）', '  预计花费：**' + price + '**', '  免费情况：' + free].join(NL),
    data: r,
  }
}

/* ── 工作流：后台跑 ── */
HANDLERS['workflow.run'] = async ({ rt, args, exec }) => {
  const found = await findWorkflow(rt, args.name)
  if (found.error) return found.error
  const wf = found.wf
  const region = resolveRegion(rt, args.region, wf)

  // 提示词优化文档的前置提醒（不阻断，但必须说清）
  const opt = wf.promptOptimizer || {}
  const preLines = []
  if (opt.enabled && opt.docId) {
    preLines.push(
      '⚠ 该工作流开了提示词优化且挂了文档。若这次还没读过，先 runninghub_call({action:"prompt.doc_read", name:"' + String(wf.name) + '"})' +
        (opt.asSubagentSystemPrompt ? '，再 prompt.optimize 让子代理写提示词。' : '，由你自己按文档改写提示词。'),
    )
  }

  const values = {
    prompt: args.prompt === undefined ? undefined : String(args.prompt),
    negativePrompt: args.negativePrompt === undefined ? undefined : String(args.negativePrompt),
    params: args.params && typeof args.params === 'object' ? args.params : {},
    images: args.images && typeof args.images === 'object' ? args.images : {},
  }

  // ── 本地保存位置 ──
  //
  // 用户的要求：**默认存到「当前工作目录下的新建文件夹」**，而不是 `~/.dsh` 里。
  // 优先级（高 → 低）：
  //   ① `saveDir`（调用时给；**相对路径按会话工作目录解析**，也接受绝对路径）
  //   ② 插件配置的 `outputDir`
  //   ③ 默认：`<会话工作目录>/runninghub-output`  ← 主路径
  //   ④ 万一拿不到会话工作目录：退回 `<数据目录>/outputs/<taskId>`（store 的默认布局）
  //
  // 会话工作目录来自 `exec.agent.session.header.cwd`（dsh-tools 自己的字段，
  // ptc.js:592 / index.js:1423 都这么取）。
  const sessionCwd = (() => {
    const h = exec && exec.agent && exec.agent.session && exec.agent.session.header
    const c = h && typeof h.cwd === 'string' ? h.cwd.trim() : ''
    return c !== '' ? c : ''
  })()
  const rawSaveDir = typeof args.saveDir === 'string' ? args.saveDir.trim() : ''
  const targetDir = (() => {
    if (rawSaveDir !== '') return path.isAbsolute(rawSaveDir) ? rawSaveDir : path.resolve(sessionCwd || '.', rawSaveDir)
    if (typeof rt.config.outputDir === 'string' && rt.config.outputDir.trim() !== '') return rt.config.outputDir.trim()
    if (sessionCwd !== '') return path.join(sessionCwd, DEFAULT_OUTPUT_FOLDER)
    return ''
  })()
  const baseFileName = typeof args.fileName === 'string' ? args.fileName.trim() : ''

  // `validateRun` 返回 `{ok, issues, warnings}`：**`ok` 只看 `issues`**。
  // `warnings` 是非阻塞的"插件猜测"（如 `steps` 超出我们手写的常见区间）——
  // 那是提示，不是拦路虎：照跑，让 RunningHub 服务端去判，它的报错比我们准。
  // （rh-core task-9：Lead 拍板"插件的猜测不该拦用户的活"。）
  const validation = rt.workflow.validateRun ? rt.workflow.validateRun(wf, values) : { ok: true, issues: [], warnings: [] }
  if (validation && validation.ok === false) {
    return fail('VALIDATION_FAILED', '参数校验没过：' + validation.issues.map((i) => i.message).join('；'), '按 runninghub_call({action:"workflow.get"}) 的节点说明补齐必填项')
  }
  const validationWarnings = Array.isArray(validation && validation.warnings) ? validation.warnings : []
  if (validationWarnings.length > 0) {
    // **非阻塞**：只提示、照跑（rh-core task-9 / Lead 拍板：插件的猜测不该拦用户的活）。
    // 压成一行，别把回执刷长。
    preLines.push('⚠ 提示：' + validationWarnings.map((i) => i.message).join('；') + '　（不影响运行）')
  }

  const repeat = Math.max(1, Math.min(20, Math.trunc(num(args.repeat, 1, 1, 20))))
  // 官方 schema 里 instanceType 的 enum 是**小写** `default|plus|ultra`
  // （`Standard/Plus/Ultra` 会被拒或不被识别）。这里统一归一化，
  // 让用户/AI 在配置里怎么写都不会踩。
  const instanceType = normalizeInstanceType(wf.instanceType)
  const submitted = []
  let submissionError = null
  for (let i = 0; i < repeat; i++) {
    const output = {}
    if (targetDir !== '') output.dir = targetDir
    if (baseFileName !== '') output.fileName = repeat > 1 ? baseFileName + '_' + String(i + 1) : baseFileName
    const r = await rt.runner.submit({ workflowConfig: { ...wf, instanceType }, values, region, output })
    if (!r || r.ok !== true) {
      submissionError = { ...((r && r.error) || { code: 'SUBMIT_FAILED', message: '提交失败' }), failedIndex: i + 1 }
      break
    }
    submitted.push(r)
  }

  // ── 包进 DSH 原生作业：模型能用标准 job_list/job_output 看进度，
  //    且任务完成时会**自动给这个会话注入一条完成通知**（这就是"后台跑"的意义）。
  //    包不起来也只是没有通知，任务本身照跑。
  let jobId = null
  try {
    const jobs = findJobsService(rt.ctx)
    if (jobs && submitted.length > 0) {
      const owner = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : undefined
      jobId = startTaskJob({
        jobs,
        runner: rt.runner,
        // ⚠️ 传**全部** taskId（repeat>1 时提交了多个）：只等第一个的话，
        //    其余任务跑完没人通知，作业会提前显示"完成"。
        taskIds: submitted.map((s) => String(s.taskId)),
        label: 'RunningHub · ' + String(wf.name) + (submitted.length > 1 ? ' ×' + String(submitted.length) : ''),
        owner,
        maxWaitMs: rt.config && rt.config.maxWaitMs ? rt.config.maxWaitMs : 1800000,
        meta: {
          workflowName: String(wf.name),
          region,
          promptPreview: values.prompt ? String(values.prompt).slice(0, 80) : '',
        },
      })
    }
  } catch (e) {
    rt.warn('任务未包成 DSH 作业（不影响任务本身）：' + String((e && e.message) || e))
  }

  if (submissionError) {
    return {
      ok: false,
      error: submissionError,
      text: '第 ' + submissionError.failedIndex + '/' + repeat + ' 个任务提交失败。' +
        (submitted.length ? NL + '已提交的任务仍在运行，请勿整批重投：' + NL + submitted.map((s) => '  · ' + s.taskId).join(NL) : ''),
      data: { tasks: submitted, jobId, requested: repeat, submittedCount: submitted.length },
    }
  }

  // ── 后台模式：提交完就返回，AI 去干别的 ──
  //
  // 与前台的区别只有一个：**这里不 await**。任务本身已经在跑，作业也已经挂上，
  // 跑完会由 `ctx.jobs` 自动往这个会话注入完成通知（含本地路径）。
  // 这也是"后台"真正有意义的地方 —— 生图动辄一两分钟，不该把一次工具调用堵在那儿。
  const background = args.background === true
  const waitMs = background ? 0 : Math.trunc(num(args.waitMs, 0, 0, 1800000))
  const lines = []
  // 回执**故意压到最短**：用户要的是"跑没跑、图在哪"，不是一串内部状态。
  // 图片本身已经在聊天里渲染出来了，远端 URL 属于冗余信息，不再重复。
  if (preLines.length) lines.push(...preLines)

  if (background) {
    lines.push('🚀 后台生图中 · ' + String(submitted.length) + ' 个 · ' + String(wf.name) + (jobId ? ' · 作业 ' + jobId : ''))
    for (const s of submitted) lines.push('  · ' + String(s.taskId))
    lines.push((jobId ? '跑完会自动通知（含本地路径）。' : '宿主未提供后台通知，请主动取回结果。') + '要继续等就用：runninghub_call({action:"task.wait", taskId:"' + String(submitted[0].taskId) + '"})')
    return { ok: true, text: lines.join(NL), data: { tasks: submitted, jobId, background: true } }
  }

  if (waitMs <= 0) {
    lines.push('🚀 已提交 ' + String(submitted.length) + ' 个（' + region + '）· ' + String(wf.name) + (jobId ? ' · 作业 ' + jobId : ''))
    for (const s of submitted) lines.push('  · ' + String(s.taskId))
    lines.push('取结果：runninghub_call({action:"task.wait", taskId:"' + String(submitted[0].taskId) + '"})')
    return { ok: true, text: lines.join(NL), data: { tasks: submitted, jobId } }
  }

  const results = []
  for (const s of submitted) results.push(await rt.runner.wait(s.taskId, waitMs))
  return attachResults({ rt, lines, results, submitted })
}

/** 把 runner.wait 的结果投影成「文本 + 图片附件」的回执。 */
async function attachResults({ rt, lines, results, submitted }) {
  const images = []
  const files = []
  const anyFail = []
  const pending = []
  for (const w of results) {
    if (!w || w.ok === false) {
      anyFail.push(String((w && w.error && w.error.message) || '等待失败'))
      continue
    }
    if (w.timedOut === true) pending.push(String((w.task && w.task.taskId) || '未知任务'))
    for (const r of (w.results || [])) {
      if (r && r.attachment && r.kind === 'image') images.push(r.attachment)
      else if (r && r.attachment) files.push(r.attachment)
    }
  }
  // `task.hint` 是 runner 在"连续查不到可用状态"时写下的**给人看**的提示。
  // 它默认只进日志，而日志没人看 —— 这里把它抬进回执，让模型/用户真的看见。
  for (const t of [...(submitted || []), ...results.map((w) => (w && w.task) || null)]) {
    if (t && typeof t.hint === 'string' && t.hint.length > 0 && !lines.some((l) => l.includes(t.hint))) {
      lines.push('  ⚠ ' + t.hint)
    }
  }
  // ── 回执**压到最短** ──
  //
  // 用户要的是"跑完没、图在哪"，不是一串内部状态：
  //   · 图片已经在聊天里渲染出来了 → 远端 URL 是冗余的，**不重复给**；
  //   · 每个任务的 taskId / 状态也不再逐行罗列（作业通知里都有）；
  //   · 只留一行结论 + 本地路径。
  const localPaths = []
  let seconds = 0
  let coins = 0
  for (const w of results) {
    const t = (w && w.task) || null
    if (t) {
      const a = Number(t.createdAt) || 0
      const b = Number(t.finishedAt) || 0
      if (a > 0 && b > a) seconds = Math.max(seconds, Math.round((b - a) / 1000))
      for (const o of t.outputs || []) {
        const c = Number(o && o.consumeCoins)
        if (Number.isFinite(c) && c > 0) coins += c
      }
    }
    for (const r of (w && w.results) || []) {
      if (r && typeof r.localPath === 'string' && r.localPath.length > 0) localPaths.push(r.localPath)
      if (r && r.error) lines.push('  ⚠ 结果文件未保存：' + String(r.error) + (r.url ? ' · ' + String(r.url) : ''))
      if (r && r.note) lines.push('  ℹ ' + String(r.note))
      if (r && r.kind === 'text' && r.text) lines.push(String(r.text))
    }
  }
  const summary = []
  if (seconds > 0) summary.push(String(seconds) + 's')
  if (coins > 0) summary.push(String(coins) + ' 币')
  lines.push(
    (anyFail.length ? '❌ 失败' : pending.length ? '⏳ 等待结束，任务仍在运行' : '✅ 完成') +
      ' · ' +
      String(images.length + files.length) +
      ' 个' +
      (summary.length > 0 ? ' · ' + summary.join(' · ') : ''),
  )
  for (const p of localPaths) lines.push('📁 ' + p)
  for (const id of pending) lines.push('继续取结果：runninghub_call({action:"task.wait", taskId:"' + id + '"})')

  const text = lines.join(NL)
  const out = { ok: anyFail.length === 0, text, data: { tasks: submitted, results, timedOut: pending.length > 0 } }
  if (images.length) out.images = images
  if (files.length) out.files = files
  if (anyFail.length) out.error = { code: 'TASK_FAILED', message: anyFail.join('；') }
  return out
}

/* ── 任务 ── */
HANDLERS['task.list'] = async ({ rt, args }) => {
  const limit = Math.trunc(num(args.limit, 20, 1, 200))
  const st = args.status ? String(args.status).toUpperCase() : null
  const items = (await rt.store.listTasks({ limit, ...(st ? { status: st } : {}) })) || []
  const lines = ['【任务】共 ' + String(items.length) + ' 条：']
  for (const t of items) {
    lines.push('  · ' + String(t.taskId) + ' · ' + String(t.status) + ' · ' + String(t.workflowName || '') + (t.error ? ' · ⚠' + String(t.error) : '') + (t.hint ? ' · ' + String(t.hint) : ''))
  }
  if (items.length === 0) lines.push('  （空）')
  return { ok: true, text: lines.join(NL), data: { tasks: items } }
}

HANDLERS['task.limit'] = async ({ rt, args }) => {
  // 不传 limit = 只读
  if (args.limit === undefined || args.limit === null || args.limit === '') {
    const all = (await rt.store.listTasks()) || []
    return {
      ok: true,
      text: '【任务流水】当前保留最近 ' + (rt.store.maxTasks === 0 ? '全部（未限制）' : String(rt.store.maxTasks) + ' 条') + ' · 现有 ' + String(all.length) + ' 条',
      data: { limit: rt.store.maxTasks, count: all.length },
    }
  }
  const n = Number(args.limit)
  if (!Number.isFinite(n) || n < 0) return fail('BAD_REQUEST', 'limit 必须是不小于 0 的数字（0 = 不限制）')
  const next = Math.floor(n)
  rt.store.maxTasks = next
  try {
    const state = (await rt.store.loadState()) || {}
    const saved = await rt.store.saveState({ ...state, taskLimit: next })
    if (saved && saved.ok === false) {
      return fail('SAVE_FAILED', '保留条数没能写入 state.json：' + String((saved.error && saved.error.message) || ''))
    }
  } catch (e) {
    return fail('SAVE_FAILED', '保留条数没能写入 state.json：' + String((e && e.message) || e))
  }
  const r = await rt.store.pruneTasks(next)
  const removed = (r && r.removed) || []
  return {
    ok: true,
    text:
      '✅ 任务流水改为保留最近 ' + (next === 0 ? '全部（未限制）' : String(next) + ' 条') +
      (removed.length > 0 ? ' · 已删除 ' + String(removed.length) + ' 条最旧的终态记录' : '') +
      '（**只删终态**，还在跑的任务一律保留）',
    data: { limit: next, removed },
  }
}

HANDLERS['task.status'] = async ({ rt, args }) => {
  const taskId = String(args.taskId || '').trim()
  if (!taskId) return fail('BAD_REQUEST', '缺少 taskId')
  const result = await rt.runner.status(taskId, { refresh: true })
  if (!result || result.ok !== true) return result || fail('QUERY_FAILED', '查询任务失败')
  const task = result.task
  const lines = ['【任务】' + taskId, '  状态：' + task.status + ' · 地域：' + task.region + ' · 工作流：' + task.workflowName]
  if (task.errorMessage || task.failedReason) lines.push('  错误：' + String(task.errorMessage || task.failedReason))
  if (task.hint) lines.push('  ⚠ ' + task.hint)
  return { ok: true, text: lines.join(NL), data: { task } }
}

HANDLERS['task.wait'] = async ({ rt, args }) => {
  const taskId = String(args.taskId || '').trim()
  if (!taskId) return fail('BAD_REQUEST', '缺少 taskId')
  const timeoutMs = Math.trunc(num(args.timeoutMs, 600000, 1000, 1800000))
  const w = await rt.runner.wait(taskId, timeoutMs)
  if (!w || w.ok === false) {
    return fail((w && w.error && w.error.code) || 'TASK_FAILED', '任务未成功：' + String((w && w.error && w.error.message) || ''), 'task.status 看细节；TRANSPORT_UNCERTAIN 时**不要重投**，先让用户去 RunningHub 后台核对。')
  }
  const t = w.task || {}
  if (w.timedOut === true) return attachResults({ rt, lines: ['任务 ' + taskId + ' 当前状态：' + String(t.status)], results: [w], submitted: [t] })
  const lines = ['✅ 任务 ' + taskId + ' 完成（' + String(t.status) + '）']
  const nImg = (w.results || []).filter((r) => r.kind === 'image').length
  const nOther = (w.results || []).length - nImg
  if (nImg) lines.push('  ' + String(nImg) + ' 张图片见下方（已作为附件返回，直接显示在聊天里）。')
  if (nOther) lines.push('  ' + String(nOther) + ' 个其它结果（视频/音频/文件）作为附件返回。')
  if (!(w.results || []).length) lines.push('  这次没有可下载的结果文件（任务成功但没有输出？检查工作流是否包含 SaveImage/SaveVideo 之类节点）。')
  return attachResults({ rt, lines, results: [w], submitted: [t] })
}

HANDLERS['task.cancel'] = async ({ rt, args }) => {
  const taskId = String(args.taskId || '').trim()
  if (!taskId) return fail('BAD_REQUEST', '缺少 taskId')
  const r = await rt.runner.cancel(taskId)
  // 取消一个**已经结束**的任务不是失败 —— 用户点了个无意义的按钮，
  // 正确回应是"它已经结束了"，而不是甩一个业务错误码让面板标红。
  if (r && r.alreadyFinished === true) {
    return { ok: true, text: 'ℹ 任务 ' + taskId + ' 已经结束（' + String(r.status || '') + '），无需取消' }
  }
  if (!r || r.ok === false) return fail((r && r.error && r.error.code) || 'CANCEL_FAILED', String((r && r.error && r.error.message) || ''))
  return { ok: true, text: '✅ 已请求取消 ' + taskId }
}

/* ── 账号 ── */
HANDLERS['account.balance'] = async ({ rt, args }) => {
  const id = String(args.id || '').trim()
  const entry = id ? rt.pool.list().find((key) => key.id === id) : null
  if (id && !entry) return fail('NOT_FOUND', '找不到 Key ' + id)
  const region = entry ? entry.region : resolveRegion(rt, args.region, null)
  const picked = entry ? { ok: true, id, key: rt.pool.rawKey(id) } : rt.pool.pick({ region })
  if (!picked || picked.ok === false) {
    return fail('NO_KEY', '「' + region + '」池里没有可用 Key', '先 key.add 加一把该地域的 Key（国内/海外不通用）')
  }
  const r = await rt.api.accountStatus(picked.key, region)
  if (!r || r.ok === false) {
    const code = (r && r.error && r.error.code) || 'UNKNOWN'
    rt.pool.report(picked.id, code)
    return fail(code, '查余额失败：' + String((r && r.error && r.error.message) || ''))
  }
  rt.pool.report(picked.id, 'ok')
  const d = r.data || {}
  const lines = [
    '【余额】' + region + ' · Key ' + maskKey(picked.key),
    '  剩余币：' + String(d.remainCoins === undefined ? '?' : d.remainCoins) + ' · 剩余金额：' + String(d.remainMoney === undefined ? '?' : d.remainMoney) + ' ' + String(d.currency || ''),
    '  当前任务数：' + String(d.currentTaskCounts === undefined ? '?' : d.currentTaskCounts) + ' · 账号类型：' + String(d.apiType || '?'),
  ]
  // 并发/排队一起看才有意义 —— accountStatus 只给一个 currentTaskCounts，
  // 信息量不够（DESIGN §7.8 点名的坑）。拿不到就静默跳过，不因为一个附加查询让查余额失败。
  let queue = null
  if (typeof rt.api.queueStatus === 'function') {
    try {
      const q = await rt.api.queueStatus(picked.key, region)
      if (q && q.ok === true) {
        queue = q
        lines.push(
          '  并发：上限 ' + String(q.concurrentLimit) + ' · 运行中 ' + String(q.runningCount) +
            ' · 排队 ' + String(q.queuedCount) + ' · 当前任务 ' + String(q.totalCurrentTasks) +
            (q.apiKeyType ? ' · Key 类型 ' + String(q.apiKeyType) : ''),
        )
        if (q.queuedCount > 0) lines.push('  ⚠ 有 ' + String(q.queuedCount) + ' 个任务在排队 —— 现在提交会等更久。')
      }
    } catch {
      /* 附加信息拿不到就算了 */
    }
  }
  return { ok: true, text: lines.join(NL), data: { ...d, queue } }
}

/* ── 账号：并发与排队 ── */
HANDLERS['account.queue'] = async ({ rt, args }) => {
  const region = resolveRegion(rt, args.region, null)
  const picked = rt.pool.pick({ region })
  if (!picked || picked.ok === false) {
    return fail('NO_KEY', '「' + region + '」池里没有可用 Key', '先 key.add 加一把该地域的 Key（国内/海外不通用）')
  }
  if (typeof rt.api.queueStatus !== 'function') {
    return fail('NOT_AVAILABLE', '协议层没有 queueStatus（core 版本较旧）')
  }
  const q = await rt.api.queueStatus(picked.key, region)
  if (!q || q.ok === false) {
    const code = (q && q.error && q.error.code) || 'UNKNOWN'
    rt.pool.report(picked.id, code)
    return fail(code, '查队列失败：' + String((q && q.error && q.error.message) || ''))
  }
  rt.pool.report(picked.id, 'ok')
  const lines = [
    '【并发 / 队列】' + region + ' · Key ' + maskKey(picked.key),
    '  并发上限：' + String(q.concurrentLimit) + ' · 运行中：' + String(q.runningCount) + ' · 排队：' + String(q.queuedCount) + ' · 当前任务：' + String(q.totalCurrentTasks),
  ]
  if (q.apiKeyType) lines.push('  Key 类型：' + String(q.apiKeyType) + '（EXCLUSIVE = 独占并发，SHARED = 共享）')
  if (q.runningCount >= q.concurrentLimit && q.concurrentLimit > 0) {
    lines.push('  ⚠ 已经跑满并发上限 —— 现在提交只会进排队。')
  }
  return { ok: true, text: lines.join(NL), data: q }
}

HANDLERS['account.keys'] = async ({ rt }) => {
  const keys = rt.pool.list ? rt.pool.list() : []
  const stats = rt.pool.poolStats ? rt.pool.poolStats() : {}
  const lines = ['【Key 池】国内 ' + String((stats.cn || {}).total || 0) + ' 把（可用 ' + String((stats.cn || {}).available || 0) + '）· 海外 ' + String((stats.overseas || {}).total || 0) + ' 把（可用 ' + String((stats.overseas || {}).available || 0) + '）']
  for (const k of keys) {
    lines.push('  · ' + String(k.id) + ' · ' + String(k.maskedKey) + ' · ' + String(k.region) + ' · ' + String(k.enabled === false ? '已禁用' : k.invalid ? '已失效' : '正常'))
  }
  return { ok: true, text: lines.join(NL), data: { keys, stats } }
}

HANDLERS['key.add'] = async ({ rt, args }) => {
  const key = String(args.key || '').trim()
  if (!key) return fail('BAD_REQUEST', '缺少 key', '让用户提供 RunningHub API Key（在 runninghub.cn/.ai 的「API 调用」页可以拿到）')
  const region = String(args.region || 'auto').toLowerCase()
  let resolved = region
  if (region !== 'cn' && region !== 'overseas') {
    if (!rt.core.detectRegion) return fail('UNSUPPORTED', '协议层没有 detectRegion，无法自动判定地域', '显式传 region:"cn" 或 "overseas"')
    resolved = await rt.core.detectRegion(rt.api, key)
    if (resolved === 'invalid') {
      return fail('AUTH', '这把 Key 在 runninghub.cn 和 runninghub.ai 上都验不过', '确认 Key 没写错、没过期；国内与海外的 Key **不通用**')
    }
  }
  const r = rt.pool.add({ key, label: args.label ? String(args.label) : '', region: resolved, priority: Math.trunc(num(args.priority, 100, -100000, 100000)), enabled: true })
  if (!r || r.ok === false) return fail((r && r.error && r.error.code) || 'ADD_FAILED', String((r && r.error && r.error.message) || ''))
  return { ok: true, text: '✅ 已加入 Key ' + maskKey(key) + ' · 地域判定为 **' + resolved + '** · id ' + String(r.id || '') }
}

HANDLERS['key.update'] = async ({ rt, args }) => {
  const id = String(args.id || '').trim()
  if (!id) return fail('BAD_REQUEST', '缺少 id')
  const patch = args.patch && typeof args.patch === 'object' ? { ...args.patch } : {}
  if (args.label !== undefined) patch.label = String(args.label)
  if (args.priority !== undefined) patch.priority = Math.trunc(num(args.priority, 100, -100000, 100000))
  if (args.region !== undefined) patch.region = String(args.region)
  const r = rt.pool.update(id, patch)
  if (!r || r.ok === false) return fail((r && r.error && r.error.code) || 'UPDATE_FAILED', String((r && r.error && r.error.message) || ''))
  return { ok: true, text: '✅ 已更新 Key ' + id }
}

HANDLERS['key.remove'] = async ({ rt, args }) => {
  const id = String(args.id || '').trim()
  if (!id) return fail('BAD_REQUEST', '缺少 id')
  const r = rt.pool.remove(id)
  if (!r || r.ok === false) return fail((r && r.error && r.error.code) || 'REMOVE_FAILED', String((r && r.error && r.error.message) || ''))
  return { ok: true, text: '✅ 已移除 Key ' + id }
}

HANDLERS['key.detect'] = async ({ rt, args }) => {
  const id = String(args.id || '').trim()
  if (!id) return fail('BAD_REQUEST', '缺少 id')
  const raw = rt.pool.rawKey ? rt.pool.rawKey(id) : undefined
  if (!raw) return fail('NOT_FOUND', '找不到 Key ' + id)
  if (!rt.core.detectRegion) return fail('UNSUPPORTED', '协议层没有 detectRegion')
  const region = await rt.core.detectRegion(rt.api, raw)
  if (region === 'invalid') return fail('AUTH', '这把 Key 在两个平台上都验不过')
  rt.pool.update(id, { region })
  return { ok: true, text: '✅ Key ' + id + ' 的地域判定为 **' + region + '**' }
}

HANDLERS['key.balance'] = HANDLERS['account.balance']

/* ── 提示词优化文档 ── */
HANDLERS['prompt.doc_read'] = async ({ rt, args }) => {
  let docId = args.docId ? String(args.docId) : null
  if (!docId && args.name) {
    const found = await findWorkflow(rt, args.name)
    if (found.error) return found.error
    docId = (found.wf.promptOptimizer || {}).docId || null
    if (!docId) return fail('NO_DOC', '工作流「' + String(found.wf.name) + '」没有挂提示词优化文档', '可以先 prompt.doc_write 写一份，再 workflow.update 把它挂上')
  }
  if (!docId) return fail('BAD_REQUEST', '缺少 docId 或 name')
  const doc = await rt.store.getPromptDoc(docId)
  if (!doc) return fail('DOC_NOT_FOUND', '找不到文档 ' + docId, '用 runninghub_search({kind:"prompt_doc"}) 看有哪些文档')
  const rendered = rt.promptdoc.renderForModel ? rt.promptdoc.renderForModel(doc) : String(doc.content || '')
  return { ok: true, text: rendered, data: { docId, name: doc.name || '', bytes: String(doc.content || '').length } }
}

HANDLERS['prompt.doc_write'] = async ({ rt, args }) => {
  const name = String(args.name || '').trim()
  const content = String(args.content || '')
  if (!name) return fail('BAD_REQUEST', '缺少 name（文档名）')
  if (!content) return fail('BAD_REQUEST', '缺少 content（文档正文）')
  const r = await rt.store.savePromptDoc({ name, content, filename: args.filename ? String(args.filename) : '', updatedAt: Date.now() })
  if (!r || r.ok === false) return fail('SAVE_FAILED', String((r && r.error && r.error.message) || ''))
  return { ok: true, text: '✅ 已保存提示词优化文档「' + name + '」(docId ' + String(r.docId || r.id || '') + ')。' + NL + '  挂到工作流：runninghub_call({action:"workflow.update", name:"<工作流名>", patch:{"promptOptimizer":{"enabled":true,"docId":"' + String(r.docId || r.id || '') + '"}}})' }
}

HANDLERS['prompt.optimize'] = async ({ rt, args, exec }) => {
  const found = await findWorkflow(rt, args.name)
  if (found.error) return found.error
  const wf = found.wf
  const opt = wf.promptOptimizer || {}
  const userRequest = String(args.userRequest || args.prompt || '').trim()
  if (!userRequest) return fail('BAD_REQUEST', '缺少 userRequest（用户到底想要什么画面）')

  let docText = ''
  if (opt.docId) {
    const doc = await rt.store.getPromptDoc(opt.docId)
    if (!doc) return fail('DOC_NOT_FOUND', '工作流引用的提示词文档不存在：' + opt.docId, '重新选择文档，或清除 promptOptimizer.docId。')
    docText = rt.promptdoc.renderForModel ? rt.promptdoc.renderForModel(doc) : String(doc.content || '')
  }

  if (!opt.asSubagentSystemPrompt) {
    return {
      ok: true,
      text:
        'ℹ 工作流「' + String(wf.name) + '」**没有**开启子代理模式，所以提示词要由**你自己**来写。' +
        NL + (docText ? NL + '以下是该工作流的提示词优化规范，请严格按它改写：' + NL + NL + docText : NL + '（该工作流没有挂优化文档，按常识写即可。）') +
        NL + NL + '写完把提示词传给：runninghub_call({action:"workflow.run", name:"' + String(wf.name) + '", prompt:"…"})',
      data: { mode: 'self', docText },
    }
  }

  // 子代理模式：无工具、极简、只写提示词
  const subagents = rt.ctx && typeof rt.ctx.get === 'function' ? rt.ctx.get('subagents') : null
  if (!subagents || typeof subagents.start !== 'function') {
    return fail('NO_SUBAGENTS', '宿主没有 subagents 服务，无法用子代理写提示词', '让主模型自己按文档优化（即未开子代理模式的流程）')
  }
  const parent = exec && exec.agent ? exec.agent : null
  if (!parent) return fail('NO_AGENT', '当前工具调用没有 agent 上下文，子代理起不来', '让主模型自己按文档优化')
  const providers = typeof subagents.list === 'function' ? subagents.list() : []
  const provider = providers[0]
  if (!provider) return fail('NO_PROVIDER', '宿主没有注册任何 subagent provider', '让主模型自己按文档优化')

  const promptText =
    '【用户诉求】' + userRequest + NL +
    (opt.extraInstruction ? NL + '【额外要求】' + String(opt.extraInstruction) + NL : '') +
    NL + '请只输出一条可直接投喂的提示词。'

  let run
  try {
    run = await subagents.start(provider, {
      label: 'runninghub-prompt:' + String(wf.name),
      prompt: [{ type: 'text', text: promptText }],
      parent,
      signal: exec && exec.signal ? exec.signal : new AbortController().signal,
      persona: PROMPT_AGENT_PERSONA + (docText ? NL + NL + docText : ''),
      toolFilter: { allow: [] }, // 无工具：极简模式，只写字
    })
  } catch (e) {
    return fail('SUBAGENT_FAILED', '子代理启动失败：' + String((e && e.message) || e), '若宿主拒绝空 toolFilter，请改为主模型自己按文档优化')
  }

  let result
  try {
    result = await run.result
  } finally {
    try {
      if (run && typeof run.dispose === 'function') await run.dispose()
    } catch {
      /* dispose 失败不影响结果 */
    }
  }
  const text = (result && Array.isArray(result.output) ? result.output : [])
    .filter((b) => b && b.type === 'text')
    .map((b) => String(b.text || ''))
    .join(NL)
    .trim()
  if (!text) return fail('EMPTY_PROMPT', '子代理没写出提示词（stopReason ' + String((result && result.stopReason) || '?') + '）')

  return {
    ok: true,
    text:
      '✅ 子代理（无工具极简模式）按文档写好的提示词：' + NL + NL + text + NL + NL +
      '直接跑：runninghub_call({action:"workflow.run", name:"' + String(wf.name) + '", prompt:' + JSON.stringify(text) + '})',
    data: { prompt: text, provider },
  }
}

/* ── 自检 ── */
HANDLERS['diagnostics'] = async ({ rt }) => {
  const keys = rt.pool && rt.pool.list ? rt.pool.list() : []
  const stats = rt.pool && rt.pool.poolStats ? rt.pool.poolStats() : null

  // Remote 通道的**真相探针**：宿主到底有没有把本包注册进 typert？
  // 客户端 `$mount` 成功、但命名空间一直不出现（真机现象）时，
  // 唯一能区分"宿主没注册"与"客户端没挂上"的就是这一项。
  const typertInfo = (() => {
    try {
      const typert = rt.ctx && typeof rt.ctx.get === 'function' ? rt.ctx.get('typert') : null
      if (!typert) return { present: false }
      const out = { present: true, package: PKG_NAME, packageRecord: false, listPackages: null, schemas: null, error: null }
      try {
        out.packageRecord =
          typeof typert.getPackage === 'function' && typert.getPackage(PKG_NAME) !== undefined
      } catch (e) {
        out.error = 'getPackage: ' + String((e && e.message) || e)
      }
      try {
        out.listPackages = typeof typert.listPackages === 'function' ? typert.listPackages({ package: PKG_NAME }).length : null
      } catch {
        /* 第二个探针失败不影响第一个 */
      }
      try {
        out.schemas = typeof typert.list === 'function' ? typert.list({ package: PKG_NAME }).length : null
      } catch {
        /* 同上 */
      }
      return out
    } catch (e) {
      return { present: false, error: String((e && e.message) || e) }
    }
  })()

  const data = {
    // 用运行时那份，别再硬编码：这里曾经写死 `'0.1.0'`，于是 package.json 升到
    // 0.1.1 后 self-check 还在报旧版本 —— 排查时白费时间。
    version: rt.version || PLUGIN_VERSION,
    dataDir: rt.dataDir,
    coreReady: rt.coreReady,
    loadError: rt.loadError ? String(rt.loadError).slice(0, 2000) : null,
    hostApi: { ok: !!rt.hostApiOk, source: rt.hostApiSource || null },
    clientBridge: rt.clientBridge || null,
    typert: typertInfo,
    remoteRegisterError: rt.remoteRegisterError || null,
    // 面板**有没有真的调到宿主** —— 排查"面板打不开"时这是唯一能自证的信号：
    // total=0 → 请求根本没发出来（通道没选对 / $mount 失败 / 注入未就绪）；
    // total>0 → 通道是通的，问题在别处。
    clientCalls: rt.clientCalls || { total: 0, byMethod: {}, lastAt: 0, lastError: null },
    httpBridgeUnavailable: rt.httpBridgeUnavailable || null,
    keyCount: keys.length,
    pool: stats,
    warnings: rt.warnings.slice(0, 40),
    uptimeMs: Date.now() - rt.startedAt,
  }
  const lines = [
    '【RunningHub 插件自检】',
    '  数据目录：' + String(data.dataDir),
    '  协议层：' + (rt.coreReady ? '已装载' : '❌ 未装载 —— ' + String(data.loadError || '').slice(0, 300)),
    '  宿主 API：' + String(data.hostApi.source || '未知'),
    '  配置面板通道：' + (rt.clientBridge ? JSON.stringify(rt.clientBridge) : '未装配（模型侧工具不受影响）'),
    '  typert 注册：' +
      (typertInfo.present
        ? 'ctx.typert 在；本包 package record ' +
          (typertInfo.packageRecord ? '✅ 已注册' : '❌ **未注册**') +
          (typertInfo.listPackages === null ? '' : ' · listPackages ' + String(typertInfo.listPackages)) +
          (typertInfo.schemas === null ? '' : ' · schemas ' + String(typertInfo.schemas))
        : '❌ ctx.typert 不在组合里' + (typertInfo.error ? '（' + typertInfo.error + '）' : '')),
    ...(rt.remoteRegisterError ? ['  ⚠ Remote 注册失败原因：' + String(rt.remoteRegisterError).slice(0, 300)] : []),
    '  面板已调用宿主：' +
      String(data.clientCalls.total) +
      ' 次' +
      (data.clientCalls.total > 0
        ? '（最近 ' + new Date(data.clientCalls.lastAt).toISOString() + (data.clientCalls.lastError ? ' · 最近错误 ' + data.clientCalls.lastError : '') + '）'
        : ' —— **0 次说明请求根本没发到宿主**：通道没选对 / $mount 失败 / 注入未就绪，不是宿主处理失败'),
    '  Key：' + String(keys.length) + ' 把 · 国内可用 ' + String(((stats || {}).cn || {}).available || 0) + ' · 海外可用 ' + String(((stats || {}).overseas || {}).available || 0),
  ]
  if (rt.warnings.length) {
    lines.push('  ⚠ 告警 ' + String(rt.warnings.length) + ' 条：')
    for (const w of rt.warnings.slice(0, 10)) lines.push('    · ' + w)
  }
  lines.push('  时区/时间：' + new Date().toISOString())
  return { ok: true, text: lines.join(NL), data }
}

/**
 * `instanceType` 归一化。
 *
 * 官方 schema 里这个字段的 enum 是**小写** `default | plus | ultra`。
 * 参照实现（github-bot）在真机上踩过 `Standard/Plus/Ultra` 不被识别的坑，
 * 所以这里一律压成小写并做别名映射 —— 配置里怎么写都不会踩。
 *
 * @param {unknown} raw 配置里的值
 * @returns {string} `default` | `plus` | `ultra`
 */
function normalizeInstanceType(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase()
  if (s === 'plus') return 'plus'
  if (s === 'ultra') return 'ultra'
  return 'default'
}

/** 深合并（patch 里的对象递归合并，数组整体替换）。 */
function deepMerge(base, patch) {
  const out = { ...(base || {}) }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v)
    } else {
      out[k] = v
    }
  }
  return out
}

export { HANDLERS }
