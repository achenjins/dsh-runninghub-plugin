/**
 * dsh-runninghub-plugin · `runninghub_search`
 *
 * 模型侧**唯一的发现入口**（与 `runninghub_call` 构成两层：先 search 才知道有什么，再 call 去用）。
 * 与本地 `autocad` / `github` MCP 的 `search_tools` 同构，模型不需要预先知道任何工作流名。
 *
 * 这个工具的回执必须**自带说明书**：模型第一次调它时对 RunningHub 一无所知，
 * 所以工作流条目里要带上 outputKind、必填项、是否需要先读提示词优化文档，以及可用的 call 动作清单。
 *
 * @module dsh-runninghub-plugin/host/tools/search
 */

import { defineRHTool, renderStructured, ANY_SCHEMA, ok, fail, envelope } from '../shared.mjs'
import { runtimeRedactor } from '../security.mjs'

/** `runninghub_call` 的动作清单 —— search 回执里要教给模型。 */
export const CALL_ACTIONS = [
  ['workflow.get', '{ name }', '看某个工作流的完整节点配置（哪个节点是提示词/参考图/可调参数、取值范围）'],
  ['workflow.probe', '{ workflowId, region? }', '按 RunningHub 工作流 ID 拉官方 JSON 并推断节点角色，返回**提案**（不落盘）—— AI 辅助配置的第一步'],
  ['workflow.configure', '{ name, rhWorkflowId, nodes?, ... }', '落盘一个工作流配置（AI 辅助配置的终点）'],
  ['workflow.update', '{ name, patch }', '局部更新（改节点角色/枚举/开关等）'],
  ['workflow.delete', '{ name }', '删除本地工作流配置（不动 RunningHub 侧）'],
  ['workflow.validate', '{ name }', '干跑校验：必填项、枚举越界、该地域有没有可用 key'],
  ['workflow.price', '{ name, modelPath? }', '**跑之前先问价**（免费额度 / 预计花费）；只对标准模型 API 型工作流有效'],
  ['workflow.run', '{ name, prompt?, negativePrompt?, params?, images?, saveDir?, fileName?, background?, repeat?, waitMs? }', '生图。**background:true = 后台生图**（立刻返回、跑完自动通知，AI 可继续干活）；不给就前台等到出图。saveDir 指定保存文件夹（相对名按工作目录解析，默认「工作目录/runninghub-output」），fileName 指定文件名'],
  ['task.list', '{ status?, limit? }', '本地任务流水'],
  ['task.limit', '{ limit? }', '看/改**任务流水保留条数**（默认 10，0 = 不限制）。超出的**真删除**，但只删终态任务 —— 还在跑的一律保留'],
  ['task.status', '{ taskId }', '查任务（远端 + 本地）'],
  ['task.wait', '{ taskId, timeoutMs? }', '等到终态；成功则下载结果并**在聊天里显示图片/视频**'],
  ['task.cancel', '{ taskId }', '取消任务'],
  ['account.balance', '{ region? }', '查余额 / 当前任务数 / 并发与排队 / 账号类型'],
  ['account.queue', '{ region? }', '查并发上限与排队情况（跑之前先看会不会排很久）'],
  ['account.keys', '{}', '看 key 池（掩码）、地域与冷却状态'],
  ['key.add', '{ key, label?, region?, priority? }', '加一把 key（region 省略则自动探测国内/海外）'],
  ['key.update', '{ id, patch?, label?, priority?, region? }', '改一把 key 的标签 / 优先级 / 地域 / 启用状态'],
  ['key.remove', '{ id }', '删掉一把 key'],
  ['key.detect', '{ id }', '重新探测这把 key 属于国内还是海外'],
  ['key.balance', '{ id }', '用这把 key 查余额'],
  ['prompt.doc_read', '{ name | docId }', '读提示词优化文档全文'],
  ['prompt.doc_write', '{ name, content, filename? }', '写/覆盖提示词优化文档'],
  ['prompt.optimize', '{ name, userRequest }', '按工作流配置的开关优化提示词（开了子代理模式就交给无工具子代理）'],
  ['diagnostics', '{}', '插件自检'],
]

/** 动作清单的紧凑文本（给模型读）。 */
export function renderActionList() {
  const lines = ['可用动作（用 runninghub_call 调用）：']
  for (const [name, sig, desc] of CALL_ACTIONS) lines.push('  · ' + name + ' ' + sig + ' —— ' + desc)
  return lines.join(String.fromCharCode(10))
}

const OUTPUT_KIND_LABEL = {
  image: '生图',
  video: '生视频',
  audio: '生音频',
  '3d': '生 3D',
  text: '文本',
  mixed: '混合输出',
  unknown: '未知输出',
}

/** 一个工作流的紧凑摘要行。 */
export function summarizeWorkflow(wf) {
  const roles = (wf && wf.nodes) || []
  const count = (role) => roles.filter((n) => n && n.role === role).length
  const optimizer = (wf && wf.promptOptimizer) || {}
  return {
    name: String((wf && wf.name) || ''),
    displayNameEn: String((wf && wf.displayNameEn) || ''),
    outputKind: String((wf && wf.outputKind) || 'unknown'),
    outputKindLabel: OUTPUT_KIND_LABEL[String((wf && wf.outputKind) || 'unknown')] || '未知输出',
    description: String((wf && wf.description) || ''),
    tags: Array.isArray(wf && wf.tags) ? wf.tags.map(String) : [],
    rhWorkflowId: String((wf && wf.rhWorkflowId) || ''),
    region: String((wf && wf.region) || 'cn'),
    nodeCount: roles.length,
    roles: {
      prompt: count('prompt'),
      negative: count('negative_prompt'),
      image: count('image'),
      video: count('video'),
      audio: count('audio'),
      number: count('number'),
      select: count('select'),
      boolean: count('boolean'),
      seed: count('seed'),
    },
    promptOptimizer: {
      enabled: !!optimizer.enabled,
      docId: optimizer.docId ? String(optimizer.docId) : null,
      asSubagentSystemPrompt: !!optimizer.asSubagentSystemPrompt,
    },
    needsRead: !!(optimizer.enabled && optimizer.docId),
    updatedAt: Number((wf && wf.updatedAt) || 0) || 0,
  }
}

/** 摘要 → 人读行。 */
function summaryLine(s) {
  const parts = [s.name]
  if (s.displayNameEn) parts.push('(' + s.displayNameEn + ')')
  parts.push('· ' + s.outputKindLabel)
  parts.push('· ' + String(s.nodeCount) + ' 节点')
  if (s.roles.prompt > 0) parts.push('· 提示词×' + String(s.roles.prompt))
  if (s.roles.negative > 0) parts.push('· 负向×' + String(s.roles.negative))
  if (s.roles.image > 0) parts.push('· 参考图×' + String(s.roles.image))
  if (s.promptOptimizer.enabled) parts.push('· 提示词优化开' + (s.promptOptimizer.asSubagentSystemPrompt ? '(子代理)' : ''))
  if (s.needsRead) parts.push('· ⚠需先读优化文档')
  if (s.description) parts.push('— ' + s.description)
  return '  · ' + parts.join(' ')
}

/** 模糊匹配（name / displayNameEn / tags / description）。 */
function matches(s, query) {
  if (!query) return true
  const q = String(query).toLowerCase()
  return [s.name, s.displayNameEn, s.description, ...(s.tags || [])]
    .map((x) => String(x || '').toLowerCase())
    .some((x) => x.includes(q))
}

/**
 * 构造 `runninghub_search` 工具。
 *
 * @param {(ctx:any)=>import('../runtime.mjs').Runtime} getRuntime 取当前运行时
 * @returns {object} registry-ready 工具定义
 */
export function makeSearchTool(getRuntime) {
  return defineRHTool({
    name: 'runninghub_search',
    redactor: (args) => runtimeRedactor(getRuntime(), args),
    description:
      '【RunningHub · 发现】列出本机已配置的 RunningHub 工作流概要（生图 / 生视频 / 生音频 / 3D）、任务流水、Key 池、提示词优化文档。' +
      '做任何 RunningHub 操作前**先调这个**：它会告诉你有哪些工作流可用、每个是干什么的、运行前要不要先读提示词优化文档，以及 runninghub_call 支持的全部动作。' +
      'kind=workflow（默认）看工作流；kind=task 看任务；kind=key 看 Key 池；kind=prompt_doc 看提示词优化文档；kind=all 全看。',
    parameters: {
      kind: { type: 'string', description: "看什么：'workflow'(默认) | 'task' | 'key' | 'prompt_doc' | 'all'" },
      query: { type: 'string', description: '按名称 / 英文名 / 标签 / 描述模糊过滤（工作流与任务都适用）' },
      status: { type: 'string', description: "kind='task' 时按状态过滤：QUEUED | RUNNING | SUCCESS | FAILED | CANCEL | UNCERTAIN" },
      limit: { type: 'integer', description: '最多返回多少条，默认 20' },
    },
    output: { schema: ANY_SCHEMA, render: renderStructured },
    isConcurrencySafe: () => true,
    timeoutMs: 60000,
    async execute(args) {
      const rt = getRuntime()
      const kind = String((args && args.kind) || 'workflow').trim() || 'workflow'
      const query = args && args.query ? String(args.query) : ''
      const limit = clampInt(args && args.limit, 1, 200, 20)

      const sections = []
      const payload = { ok: true, kind, query, items: [], needsRead: [] }

      const coreErr = rt.requireCore()
      if (coreErr) {
        const text =
          'RunningHub 插件协议层未装载，暂时什么都查不到。' +
          String.fromCharCode(10) +
          '原因：' +
          String((coreErr.error && coreErr.error.message) || '') +
          String.fromCharCode(10) +
          '请把 `runninghub_call({action:"diagnostics"})` 的回执发给用户。'
        return { ...fail('CORE_NOT_LOADED', text), text, envelope: envelope({ ok: false, code: 'CORE_NOT_LOADED' }) }
      }

      /* ── 工作流 ── */
      if (kind === 'workflow' || kind === 'all') {
        let list = []
        try {
          list = (await rt.store.listWorkflows()) || []
        } catch (e) {
          rt.warn('listWorkflows 失败：' + String((e && e.message) || e))
        }
        const items = list.map(summarizeWorkflow).filter((s) => matches(s, query)).slice(0, limit)
        payload.items = items
        payload.needsRead = items.filter((s) => s.needsRead).map((s) => s.name)
        sections.push(
          items.length === 0
            ? '【工作流】本机还没有配置任何 RunningHub 工作流。' +
                String.fromCharCode(10) +
                '  → 需要配置时，先读插件自带 skill `runninghub-workflow-setup`，按它的流程问用户要工作流 ID，然后调 runninghub_call({action:"workflow.probe"})。'
            : '【工作流】共 ' + String(items.length) + ' 个（本地已配置）：' + String.fromCharCode(10) + items.map(summaryLine).join(String.fromCharCode(10)),
        )
        const needRead = items.filter((s) => s.needsRead)
        if (needRead.length > 0) {
          sections.push(
            '⚠️ 下面这些工作流开了提示词优化且挂了文档，**运行前必须先读文档再优化提示词**：' +
              String.fromCharCode(10) +
              needRead
                .map(
                  (s) =>
                    '  · ' +
                    s.name +
                    ' → runninghub_call({action:"prompt.doc_read", name:"' +
                    s.name +
                    '"})' +
                    (s.promptOptimizer.asSubagentSystemPrompt
                      ? '（该工作流已开启子代理模式：读完文档后调 runninghub_call({action:"prompt.optimize", name:"' + s.name + '", userRequest:"…"})，由无工具子代理按文档写提示词）'
                      : '（该工作流未开子代理模式：你需要**自己**按文档把用户的诉求改写成提示词，再传给 workflow.run）'),
                )
                .join(String.fromCharCode(10)),
          )
        }
      }

      /* ── 任务 ── */
      if (kind === 'task' || kind === 'all') {
        let list = []
        try {
          list = (await rt.store.listTasks()) || []
        } catch (e) {
          rt.warn('listTasks 失败：' + String((e && e.message) || e))
        }
        const st = args && args.status ? String(args.status).toUpperCase() : null
        const items = list.filter((t) => (!st || String(t.status || '').toUpperCase() === st) && (!query || String(t.workflowName || t.name || '').toLowerCase().includes(query.toLowerCase()))).slice(-limit)
        payload.tasks = items
        sections.push(
          items.length === 0
            ? '【任务】本地没有匹配的任务记录。'
            : '【任务】' +
                String.fromCharCode(10) +
                items
                  .map(
                    (t) =>
                      '  · ' +
                      String(t.taskId || '') +
                      ' · ' +
                      String(t.status || '') +
                      ' · ' +
                      String(t.workflowName || '') +
                      (t.progress ? ' · ' + String(t.progress) : '') +
                      (t.error ? ' · ⚠ ' + String(t.error) : ''),
                  )
                  .join(String.fromCharCode(10)),
        )
      }

      /* ── Key ── */
      if (kind === 'key' || kind === 'all') {
        const keys = safeList(rt.pool)
        const stats = rt.pool && typeof rt.pool.poolStats === 'function' ? rt.pool.poolStats() : { cn: { total: 0, available: 0 }, overseas: { total: 0, available: 0 } }
        payload.keys = keys
        payload.pool = stats
        sections.push(
          '【Key 池】国内 ' +
            String(stats.cn.total) +
            ' 把（可用 ' +
            String(stats.cn.available) +
            '）· 海外 ' +
            String(stats.overseas.total) +
            ' 把（可用 ' +
            String(stats.overseas.available) +
            '）' +
            String.fromCharCode(10) +
            (keys.length === 0
              ? '  → 一把 key 都没有。让用户提供 RunningHub API Key，然后调 runninghub_call({action:"key.add", key:"…"})。注意国内(runninghub.cn)与海外(runninghub.ai)的 key **不通用**。'
              : keys
                  .map(
                    (k) =>
                      '  · ' +
                      String(k.id) +
                      ' · ' +
                      String(k.maskedKey) +
                      ' · ' +
                      String(k.region) +
                      ' · ' +
                      (k.invalid ? '已失效' : k.enabled === false ? '已禁用' : '正常') +
                      (k.cooldownUntil && k.cooldownUntil > Date.now() ? ' · 冷却中至 ' + new Date(k.cooldownUntil).toISOString() : '') +
                      (k.label ? ' · ' + String(k.label) : ''),
                  )
                  .join(String.fromCharCode(10))),
        )
      }

      /* ── 提示词优化文档 ── */
      if (kind === 'prompt_doc' || kind === 'all') {
        let docs = []
        try {
          docs = (await rt.store.listPromptDocs()) || []
        } catch (e) {
          rt.warn('listPromptDocs 失败：' + String((e && e.message) || e))
        }
        payload.docs = docs
        sections.push(
          docs.length === 0
            ? '【提示词优化文档】本机还没有任何文档。'
            : '【提示词优化文档】' +
                String.fromCharCode(10) +
                docs
                  .map(
                    (d) =>
                      '  · ' +
                      String(d.name || d.id) +
                      (d.docId || d.id ? ' (id ' + String(d.docId || d.id) + ')' : '') +
                      (d.bytes ? ' · ' + String(d.bytes) + 'B' : '') +
                      ' → runninghub_call({action:"prompt.doc_read", docId:"' + String(d.docId || d.id) + '"})',
                  )
                  .join(String.fromCharCode(10)),
        )
      }

      sections.push(renderActionList())

      const text = sections.join(String.fromCharCode(10) + String.fromCharCode(10))
      return { ok: true, text, envelope: envelope(payload) || '', items: payload.items }
    },
  })
}

function safeList(pool) {
  try {
    return pool && typeof pool.list === 'function' ? pool.list() || [] : []
  } catch {
    return []
  }
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.min(hi, Math.trunc(n)))
}
