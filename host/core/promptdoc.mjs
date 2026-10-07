/**
 * `host/core/promptdoc.mjs` —— 提示词优化文档（CRUD + 给模型看的渲染）
 *
 * 契约（**Lead 已锁定**）：
 *   - `renderForModel(doc)` → `string`，带「必须按本文档优化提示词」的说明头。
 *   - `needsReadBadge(config)` → `boolean`：工作流是否要求"运行前先读文档"。
 *   - `slugify(name)` → 稳定 slug。
 *
 * 业务语义（DESIGN §0.1 / §5.1）：
 *   - 用户可给工作流挂一份提示词规范（txt/md 原样存在 `<dataDir>/prompts/`）。
 *   - `needsReadBadge(config) === true` 时，具名 `workflow.get` 必须直接写明
 *     「运行前必须先用 `runninghub_call({action:'prompt.doc_read'})` 读该文档再优化提示词」。
 *   - `asSubagentSystemPrompt === true` → 把文档当系统提示词交给**无工具、极简模式**子代理写提示词；
 *     否则文档只是给主模型的参考材料。两种模式渲染出来的头不一样，别混。
 *
 * @module dsh-runninghub-plugin/host/core/promptdoc
 */

import { asString, lossless, errorShape, slugify as utilSlugify } from './util.mjs'

/** 文档正文的硬上限（防呆：1MB 的 md 灌进上下文会把会话打死）。 */
export const MAX_DOC_BYTES = 1024 * 1024

/** 渲染给模型时的正文截断上限（超出会明确告知被截断）。 */
export const MAX_RENDER_CHARS = 40000

/**
 * 稳定 slug（工具层与 `store` 共用同一套规则）。
 * @param {unknown} name 名称
 * @param {string} [fallback] 兜底
 * @returns {string} slug
 */
export function slugify(name, fallback = 'doc') {
  return utilSlugify(name, fallback)
}

/**
 * 工作流是否要求「运行前必须先读提示词优化文档」。
 *
 * 为真的条件（**三个都满足**）：
 *   1. `promptOptimizer.enabled === true`
 *   2. `promptOptimizer.docId` 非空
 *   3. `promptOptimizer.asSubagentSystemPrompt === true`
 *      —— 只有"文档当系统提示词交给子代理"这种强约束才需要阅读徽标；
 *      纯参考材料（false）不拦运行，否则会平白多一轮交互。
 *
 * @param {object} config 工作流配置
 * @returns {boolean} 需要先读文档为 true
 */
export function needsReadBadge(config) {
  const p = config && typeof config === 'object' ? config.promptOptimizer : null
  if (!p || typeof p !== 'object') return false
  return p.enabled === true && asString(p.docId) !== '' && p.asSubagentSystemPrompt === true
}

/**
 * 该工作流是否启用了提示词优化（不管有没有徽标）。
 * @param {object} config 工作流配置
 * @returns {boolean} 启用为 true
 */
export function optimizerEnabled(config) {
  const p = config && typeof config === 'object' ? config.promptOptimizer : null
  return !!(p && typeof p === 'object' && p.enabled === true)
}

/**
 * 把文档渲染成给 LLM 的文本（**含必须按此文档优化提示词的说明头**）。
 *
 * 头分两种，取决于是否当子代理系统提示词：
 *   - `asSubagentSystemPrompt: true` → 「这是硬性规范，逐条遵守，不要偏离」
 *   - 否则 → 「这是参考资料，尽量对齐风格」
 *
 * @param {{id?:string,name?:string,content?:string,meta?:object}|string} doc 文档（`store.getPromptDoc()` 的结果，或直接给正文）
 * @param {{workflow?:object, mode?:'subagent'|'reference'}} [opts] `workflow` 用于在头里点名工作流
 * @returns {string} 给模型的文本
 */
export function renderForModel(doc, opts = {}) {
  const d = typeof doc === 'string' ? { content: doc } : doc && typeof doc === 'object' ? doc : {}
  const name = asString(d.name) || asString(d.id) || '提示词优化文档'
  const raw = asString(d.content)
  const wfName = asString(opts.workflow && (opts.workflow.name || opts.workflow.displayNameEn))
  const asSystem =
    opts.mode === 'subagent' ||
    (opts.mode === undefined && !!(opts.workflow && opts.workflow.promptOptimizer && opts.workflow.promptOptimizer.asSubagentSystemPrompt === true))

  const head = []
  head.push('【提示词优化文档·必须遵守】')
  head.push('文档名：' + name)
  if (wfName !== '') head.push('适用工作流：' + wfName)
  head.push('')
  if (asSystem) {
    head.push('这份文档是**硬性规范**：你要写的提示词必须逐条遵守下面全部要求，不要自行发挥、不要遗漏约束。')
    head.push('如果用户的请求与文档冲突，**以文档为准**，并说明你按文档做了哪些取舍。')
  } else {
    head.push('这份文档是**参考资料**：请尽量按它的风格、结构与用词来优化提示词。')
    head.push('如果用户的请求与文档冲突，以用户为准，但要在回执里点明你偏离了文档的哪一条。')
  }
  head.push('')

  let body = raw
  let truncatedNote = ''
  if (body.length > MAX_RENDER_CHARS) {
    truncatedNote =
      '\n\n[…文档过长，已截断到 ' +
      String(MAX_RENDER_CHARS) +
      ' 字符（原文 ' +
      String(body.length) +
      ' 字符）。需要完整内容请分段读，或让用户精简文档。]'
    body = body.slice(0, MAX_RENDER_CHARS)
  }
  return head.join('\n') + body + truncatedNote
}

/**
 * 生成给「无工具极简子代理」的系统提示词（`prompt.optimize` 走子代理模式时用）。
 * @param {object} doc 文档
 * @param {{workflow?:object, userRequest?:string, extraInstruction?:string, targetField?:string}} [opts] 上下文
 * @returns {string} 系统提示词
 */
export function buildSubagentSystemPrompt(doc, opts = {}) {
  const extra = asString(opts.extraInstruction)
  const target = asString(opts.targetField) || '提示词'
  const lines = []
  lines.push('你是一个**只负责写提示词**的助手。你没有工具，也不要请求工具；直接输出最终提示词正文。')
  lines.push('只输出提示词本身，不要解释、不要 Markdown 代码块围栏、不要加"提示词："之类的前缀。')
  lines.push('你要填写的字段是：' + target + '。')
  lines.push('')
  lines.push(renderForModel(doc, { workflow: opts.workflow, mode: 'subagent' }))
  if (extra !== '') {
    lines.push('')
    lines.push('【用户的额外要求】')
    lines.push(extra)
  }
  return lines.join('\n')
}

/**
 * 文档 CRUD（薄封装 `Store`，把"文档"与"存储路径"的映射收在一处）。
 * @example
 * const docs = new PromptDocs({ store })
 * await docs.write({ name: '电影感', content: '...' })
 * console.log(docs.render(await docs.read('电影感')))
 */
export class PromptDocs {
  /**
   * @param {{store:object}} deps `store` 是 `Store` 实例
   */
  constructor(deps = {}) {
    this.store = deps.store
  }

  /** 底层 store 是否可用。 @returns {boolean} 可用为 true */
  get ready() {
    return !!(this.store && typeof this.store.getPromptDoc === 'function')
  }

  /**
   * 列全部文档元数据。
   * @returns {Promise<object[]>} `[{id,name,sourceFilename,updatedAt,bytes}]`
   */
  async list() {
    if (!this.ready) return []
    const list = await this.store.listPromptDocs()
    return lossless(Array.isArray(list) ? list : [])
  }

  /**
   * 读一个文档（支持按 id 或按 name 找）。
   * @param {string} nameOrId 文档名或 id
   * @returns {Promise<object|undefined>} 文档（`{id,name,content,meta}`）
   */
  async read(nameOrId) {
    if (!this.ready) return undefined
    const key = asString(nameOrId)
    if (key === '') return undefined
    const direct = await this.store.getPromptDoc(key)
    if (direct) return direct
    const slug = slugify(key)
    if (slug !== key) {
      const bySlug = await this.store.getPromptDoc(slug)
      if (bySlug) return bySlug
    }
    // 再按 name 模糊找一次
    for (const meta of await this.list()) {
      if (asString(meta.name) === key || asString(meta.id) === key) {
        const hit = await this.store.getPromptDoc(meta.id)
        if (hit) return hit
      }
    }
    return undefined
  }

  /**
   * 写一个文档（新建或覆盖）。
   * @param {{name?:string, id?:string, content:string, sourceFilename?:string}} doc 文档
   * @returns {Promise<{ok:true,id:string,bytes:number}|{ok:false,error:object}>} 结果
   */
  async write(doc) {
    if (!this.ready) return { ok: false, error: errorShape('NOT_IMPLEMENTED', 'store 不可用，无法写文档') }
    const content = asString(doc && doc.content)
    if (content === '') {
      return { ok: false, error: errorShape('BAD_REQUEST', '文档内容不能为空', { hint: 'prompt.doc_write 需要 content' }) }
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_DOC_BYTES) {
      return {
        ok: false,
        error: errorShape('BAD_REQUEST', '文档超过 ' + String(Math.round(MAX_DOC_BYTES / 1024)) + 'KB 上限', {
          hint: '提示词规范不该这么大；拆成多份或精简后再传',
        }),
      }
    }
    const name = asString(doc && doc.name) || asString(doc && doc.id)
    const id = asString(doc && doc.id) || slugify(name, 'doc')
    const r = await this.store.savePromptDoc({ id, name: name || id, content, sourceFilename: asString(doc && doc.sourceFilename) })
    if (!r || r.ok !== true) return r || { ok: false, error: errorShape('STORE_WRITE_FAILED', '保存失败') }
    return { ok: true, id: r.id, bytes: r.bytes }
  }

  /**
   * 删一个文档。
   * @param {string} nameOrId 文档名或 id
   * @returns {Promise<{ok:true,removed:boolean,id:string}|{ok:false,error:object}>} 结果
   */
  async remove(nameOrId) {
    if (!this.ready) return { ok: false, error: errorShape('NOT_IMPLEMENTED', 'store 不可用') }
    const doc = await this.read(nameOrId)
    const id = doc ? asString(doc.id) : slugify(asString(nameOrId))
    const r = await this.store.deletePromptDoc(id)
    return { ok: true, removed: !!(r && r.removed), id }
  }

  /**
   * 渲染给模型（`prompt.doc_read` 的回执正文）。
   * @param {string} nameOrId 文档名或 id
   * @param {{workflow?:object}} [opts] 上下文
   * @returns {Promise<{ok:true,id:string,name:string,text:string,bytes:number}|{ok:false,error:object}>} 结果
   */
  async render(nameOrId, opts = {}) {
    const doc = await this.read(nameOrId)
    if (!doc) {
      return {
        ok: false,
        error: errorShape('DOC_NOT_FOUND', '找不到提示词文档：' + asString(nameOrId), {
          hint: '用 prompt.doc_write 先写一份，或在配置页里上传 txt/md',
        }),
      }
    }
    const text = renderForModel(doc, { workflow: opts.workflow })
    return { ok: true, id: asString(doc.id), name: asString(doc.name), text, bytes: Buffer.byteLength(asString(doc.content), 'utf8') }
  }

  /**
   * 组装一次 `prompt.optimize` 需要的东西（主模型自优化 / 子代理代写都由工具层决定）。
   * @param {object} config 工作流配置
   * @param {string} [userRequest] 用户原始请求
   * @returns {Promise<{ok:true,mode:'subagent'|'reference'|'off',systemPrompt:string,docText:string,docId:string,targetNodeId:string,userRequest:string}|{ok:false,error:object}>} 结果
   */
  async prepareOptimize(config, userRequest) {
    const p = config && typeof config === 'object' ? config.promptOptimizer : null
    if (!p || p.enabled !== true) {
      return {
        ok: true,
        mode: 'off',
        systemPrompt: '',
        docText: '',
        docId: '',
        targetNodeId: '',
        userRequest: asString(userRequest),
      }
    }
    let docText = ''
    const docId = asString(p.docId)
    if (docId !== '') {
      const doc = await this.read(docId)
      if (!doc) {
        return {
          ok: false,
          error: errorShape('DOC_NOT_FOUND', '工作流配置指向的提示词文档不存在：' + docId, {
            hint: '文档可能被删了：用 prompt.doc_write 补一份，或在配置里把 docId 置空',
          }),
        }
      }
      docText = renderForModel(doc, { workflow: config, mode: p.asSubagentSystemPrompt === true ? 'subagent' : 'reference' })
    }
    const targetNode = Array.isArray(config.nodes) ? config.nodes.find((n) => n && n.role === 'prompt') : null
    const targetNodeId = asString(p.targetNodeId) || (targetNode ? asString(targetNode.nodeId) : '')
    const targetField = targetNode ? asString(targetNode.fieldName) : 'prompt'
    const mode = p.asSubagentSystemPrompt === true ? 'subagent' : 'reference'
    return {
      ok: true,
      mode,
      systemPrompt:
        p.asSubagentSystemPrompt === true
          ? buildSubagentSystemPrompt({ name: docId || '文档', content: docText }, { workflow: config, userRequest, extraInstruction: p.extraInstruction, targetField })
          : '',
      docText,
      docId,
      targetNodeId,
      targetField,
      userRequest: asString(userRequest),
    }
  }
}

/**
 * 便捷工厂。
 * @param {{store:object}} deps 依赖
 * @returns {PromptDocs} 实例
 */
export function createPromptDocs(deps) {
  return new PromptDocs(deps)
}
