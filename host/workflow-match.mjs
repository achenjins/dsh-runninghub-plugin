import { randomUUID } from 'node:crypto'
import { normalizeInstanceType } from './instance-type.mjs'

/** Exact names and IDs take precedence over case-insensitive aliases. */
export function matchWorkflow(list, name) {
  const target = String(name || '').trim()
  if (!target) return null
  const lower = target.toLowerCase()
  const idHit = list.find(w => String(w.id || '') === target)
  if (idHit) return idHit
  const exact = list.filter(w => String(w.name || '') === target)
  if (exact.length > 1) throw Object.assign(new Error('工作流名称有歧义，请使用本地 id：' + exact.map(w => w.id).join(' / ')), { code: 'WORKFLOW_AMBIGUOUS' })
  if (exact.length === 1) return exact[0]
  const names = list.filter(w => String(w.name || '').toLowerCase() === lower)
  const matches = names.length ? names : list.filter(w => String(w.displayNameEn || '').toLowerCase() === lower)
  if (matches.length > 1) throw Object.assign(new Error('工作流名称或别名有歧义，请使用本地 id：' + matches.map(w => w.id).join(' / ')), { code: 'WORKFLOW_AMBIGUOUS' })
  return matches[0] || null
}

/** Validate saved node records; arrays in workflow.update are complete replacements. */
export function workflowNodeIssues(config, strict = false) {
  if (!Array.isArray(config.nodes)) return ['nodes 必须是完整节点数组']
  const seen = new Set()
  const issues = []
  for (const node of config.nodes) {
    if (!node || typeof node !== 'object' || !String(node.nodeId ?? '').trim() || !String(node.fieldName ?? '').trim()) {
      issues.push('每条节点必须包含 nodeId 和 fieldName；nodes 数组会整体替换，请先读取完整配置')
      continue
    }
    if (strict && (!['prompt', 'negative_prompt', 'image', 'video', 'audio', 'number', 'select', 'boolean', 'seed', 'other'].includes(node.role) || !['string', 'number', 'boolean', 'enum', 'json'].includes(node.valueType))) issues.push('替换 nodes 时每条记录都必须包含完整的 role 与 valueType，请先读取原配置后修改')
    const key = String(node.nodeId) + '\u0000' + String(node.fieldName)
    if (seen.has(key)) issues.push('重复节点字段：' + node.nodeId + ':' + node.fieldName)
    seen.add(key)
  }
  return issues
}

const nodeKey = node => JSON.stringify([String(node.nodeId), String(node.fieldName)])
const nodeLabel = node => String(node.nodeId) + ':' + String(node.fieldName)

/** Report field names rather than copying both complete node arrays into a receipt. */
export function workflowNodeDiff(before = [], after = []) {
  const old = new Map(before.map(node => [nodeKey(node), node]))
  const next = new Map(after.map(node => [nodeKey(node), node]))
  return {
    added: [...next].filter(([key]) => !old.has(key)).map(([, node]) => nodeLabel(node)),
    removed: [...old].filter(([key]) => !next.has(key)).map(([, node]) => nodeLabel(node)),
    changed: [...next].filter(([key]) => old.has(key)).map(([key, node]) => ({ key: nodeLabel(node),
      fields: [...new Set([...Object.keys(old.get(key)), ...Object.keys(node)])]
        .filter(field => JSON.stringify(old.get(key)[field]) !== JSON.stringify(node[field])),
    })).filter(item => item.fields.length),
  }
}

/** Refresh graph facts on selected fields; keep manual labels, options, bounds and defaults. */
export function mergeWorkflowNodes(before, incoming) {
  const next = new Map(incoming.map(node => [nodeKey(node), node]))
  return before.map(node => {
    const fresh = next.get(nodeKey(node))
    if (!fresh) return node
    const merged = { ...node }
    for (const key of ['classType', 'title', 'targets']) if (fresh[key] !== undefined) merged[key] = fresh[key]
    return merged
  })
}

/** Serialize boundary saves so concurrent creates cannot bypass conflict checks. */
function serializeWorkflows(store, run) {
  return typeof store._serialize === 'function' ? store._serialize(store.resolve('workflows'), run) : run()
}

async function saveChecked(store, config, overwrite = false) {
    // Keep this boundary independent of core loading. These checks accept only IDs
    // Store.safeName would persist unchanged, so conflict checks use the real filename.
    const id = config.id
    if (typeof id !== 'string' || !id || id.length > 96 || !/^[0-9A-Za-z_\u4e00-\u9fff][0-9A-Za-z._\u4e00-\u9fff-]*$/.test(id) || id.includes('..') || id.includes('--')) {
      return { ok: false, error: { code: 'BAD_REQUEST', message: '本地 id 必须是 1–96 位安全文件名，不能以点或连字符开头，不能包含路径、连续点或连续连字符' } }
    }
    const issues = workflowNodeIssues(config)
    if (issues.length) return { ok: false, error: { code: 'INVALID_WORKFLOW', message: issues.join('；') } }
    const name = String(config.name || '').trim().toLowerCase()
    if (!name) return { ok: false, error: { code: 'BAD_REQUEST', message: '工作流名称不能为空' } }
    const list = await store.listWorkflows()
    if (list.some(w => String(w.id).toLowerCase() === id.toLowerCase() && String(w.id) !== id)) {
      return { ok: false, error: { code: 'WORKFLOW_ID_CONFLICT', message: '本地 id 与已有配置仅大小写不同，请使用原 id 更新或选择不同 id 克隆' } }
    }
    if (list.some(w => String(w.id) !== String(config.id) && String(w.name || '').trim().toLowerCase() === name)) {
      return { ok: false, error: { code: 'NAME_CONFLICT', message: '已有同名工作流，请使用不同名称或更新原有本地 id' } }
    }
    if (!overwrite && list.some(w => String(w.id) === String(config.id))) {
      return { ok: false, error: { code: 'WORKFLOW_EXISTS', message: '该工作流 id 已有配置，确认覆盖后传 overwrite:true' } }
    }
    const instance = normalizeInstanceType(config.instanceType)
    if (!instance.ok) return instance
    const saved = { ...config, name: String(config.name).trim(), instanceType: instance.value }
    delete saved.overwrite
    return store.saveWorkflow(saved)
}

export async function saveConfiguredWorkflow(store, config, overwrite = false) {
  return serializeWorkflows(store, () => saveChecked(store, config, overwrite))
}

/** Rename keeps the local identity; cloning always creates another local identity. */
async function copyOrRename(store, selector, newName, clone, newId) {
  return serializeWorkflows(store, async () => {
    const name = String(newName || '').trim()
    if (!name) return { ok: false, error: { code: 'BAD_REQUEST', message: '缺少新工作流名' } }
    const source = matchWorkflow(await store.listWorkflows(), selector)
    if (!source) return { ok: false, error: { code: 'WORKFLOW_NOT_FOUND', message: '找不到工作流 ' + String(selector) } }
    const id = clone ? (newId === undefined ? 'clone-' + randomUUID() : newId) : source.id
    const config = { ...source, id, name }
    if (clone) {
      delete config.createdAt
      // Aliases must still select the source unambiguously after a clone.
      config.displayNameEn = ''
    }
    const result = await saveChecked(store, config, !clone)
    return result?.ok === false ? result : { ok: true, id, name, warnings: await workflowLint(store, config) }
  })
}

export function renameConfiguredWorkflow(store, selector, newName) {
  return copyOrRename(store, selector, newName, false)
}

export function cloneConfiguredWorkflow(store, selector, newName, newId) {
  return copyOrRename(store, selector, newName, true, newId)
}

export async function workflowLint(store, config) {
  const warnings = []
  const opt = config.promptOptimizer || {}
  if (opt.docId && !await store.getPromptDoc(String(opt.docId))) warnings.push('提示词文档不存在：' + opt.docId)
  if (opt.targetNodeId && !config.nodes.some(n => String(n.nodeId) === String(opt.targetNodeId) && n.role === 'prompt')) warnings.push('提示词目标节点不存在或不是正向提示词：' + opt.targetNodeId)
  for (const node of config.nodes || []) {
    if (node.optionsSource === 'user' && Array.isArray(node.options) && node.options.length) {
      warnings.push(node.nodeId + ':' + node.fieldName + ' 的枚举来自用户提供；插件无法核实是否属于当前 RH 工作流 ' + String(config.rhWorkflowId || '（未设置）') + '，请确认来源，不要直接复用其它工作流的选项。')
    }
  }
  return warnings
}
