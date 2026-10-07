/**
 * dsh-runninghub-plugin · host 半边的公共设施
 *
 * 三件事，都是被教训换来的：
 *   1. `resolveDefineTool()` —— DSH 升级时 `@deepseek-ai/dsh-tools` 的安装位置会变。
 *      解析不到就让整个插件在载入期挂掉，表现是「两个工具凭空消失」，故障现象与真因不在一层。
 *      所以这里多路径解析 + 内置等价实现兜底，永远给得出一个能用的 defineTool。
 *   2. `losslessSanitize()` —— 宿主用比 JSON.stringify 严格得多的 lossless-JSON 门校验工具返回值：
 *      undefined 值 / NaN / ±Infinity / -0 / Date / Map / Set / 类实例 / 循环引用一律拒收，
 *      并把**整条工具通道**打死。所有返回值统一过这一关。
 *   3. `maskKey()` —— 明文 API Key 绝不进日志、绝不进工具回执。这是硬边界。
 *
 * @module dsh-runninghub-plugin/host/shared
 */

import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { maskKey, createRedactor } from './security.mjs'
import { losslessSanitize } from './lossless.mjs'
export { maskKey }
export { losslessSanitize }

/* ────────────────────────────── 1. defineTool 解析 ────────────────────────────── */

/** 本文件所在目录（host/） */
export const HOST_DIR = path.dirname(fileURLToPath(import.meta.url))
/** 包根目录 */
export const PKG_ROOT = path.dirname(HOST_DIR)

/**
 * 候选解析**根**。DSH 的安装形态至少有三种，必须都覆盖：
 *   1. Electron 桌面版（`...\deepseekharness\resources\app.asar`，进程自己的模块图）；
 *   2. 全局 npm 安装：`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\` —— 它的
 *      `node_modules` 里才有 `dsh-tools` / `schemastery`；
 *   3. profile 的 `node_modules`（插件自带依赖时）。
 * 每一个都是「试一下，不行就下一个」，任何一步抛错都不影响别的。
 */
function candidateRoots() {
  const roots = [HOST_DIR, PKG_ROOT]
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  roots.push(home, path.join(home, 'node_modules'), path.join(home, 'dsh-runtimes'))
  const appData = process.env.APPDATA
  if (appData) roots.push(path.join(appData, 'npm', 'node_modules'), path.join(appData, 'npm'))
  // Electron：可执行文件旁的 resources / unpacked 目录
  try {
    if (process.resourcesPath) roots.push(process.resourcesPath, path.join(process.resourcesPath, 'app.asar.unpacked'))
    if (process.execPath) roots.push(path.dirname(process.execPath))
  } catch {
    /* 非 Electron 环境没有这些 */
  }
  roots.push('/usr/lib/node_modules', '/usr/local/lib/node_modules')
  return roots.filter((r) => typeof r === 'string' && r.length > 0)
}

/**
 * 迭代「可用的模块解析锚点」：先给候选根本身，再顺着它找到 DSH 自己的安装位置，
 * 把它的包目录与其 `node_modules` 也加进来 —— `dsh-tools` / `schemastery`
 * 常常只存在于 `<...>/@deepseek-ai/dsh/node_modules/` 下，从别处解析不到。
 */
function* candidateAnchors() {
  const seen = new Set()
  const push = (a) => {
    if (typeof a === 'string' && a.length > 0 && !seen.has(a)) {
      seen.add(a)
      return a
    }
    return null
  }
  for (const r of candidateRoots()) {
    const a0 = push(r)
    if (a0) yield a0
    for (const probe of ['@deepseek-ai/dsh/package.json', '@deepseek-ai/dsh-tools/package.json']) {
      let pkgDir = null
      try {
        pkgDir = path.dirname(createRequire(path.join(r, 'noop.js')).resolve(probe))
      } catch {
        continue
      }
      for (const cand of [pkgDir, path.join(pkgDir, 'node_modules'), path.dirname(pkgDir), path.join(path.dirname(pkgDir), 'node_modules')]) {
        const a = push(cand)
        if (a) yield a
      }
    }
  }
}

/** 复用宿主的代理路由；可选模块缺席时走直接连接。 */
export async function resolveProxyRoute() {
  try {
    const mod = await import('@deepseek-ai/dsh-http-proxy')
    if (typeof mod.proxyRouteFor === 'function') return mod.proxyRouteFor
  } catch { /* 继续按宿主安装位置解析 */ }
  for (const anchor of candidateAnchors()) {
    try {
      const entry = createRequire(path.join(anchor, 'noop.js')).resolve('@deepseek-ai/dsh-http-proxy')
      const mod = await import(pathToFileURL(entry).href)
      if (typeof mod.proxyRouteFor === 'function') return mod.proxyRouteFor
    } catch { /* 该位置没有代理模块 */ }
  }
  return null
}

/** 在全部锚点上按顺序试解析若干候选包名，返回第一个成功的结果。 */
function requireAnywhere(names) {
  const tried = []
  for (const anchor of candidateAnchors()) {
    for (const nm of names) {
      try {
        const req = createRequire(path.join(anchor, 'noop.js'))
        const mod = req(nm)
        return { ok: true, mod, name: nm, anchor, resolve: () => req.resolve(nm) }
      } catch (e) {
        tried.push(anchor + ' → ' + nm + '：' + String((e && e.message) || e).split(String.fromCharCode(10))[0].slice(0, 100))
      }
    }
  }
  return { ok: false, tried }
}

/** 内置的 defineTool 等价实现（只在真货解析不到时启用）。 */
function localDefineTool(options) {
  const props = {}
  const required = []
  for (const [key, spec] of Object.entries(options.parameters || {})) {
    const s = spec || {}
    const out = {}
    const t = s.type === 'json' ? undefined : s.type
    if (t !== undefined) out.type = t
    if (s.description !== undefined) out.description = s.description
    if (s.enum !== undefined) out.enum = s.enum
    if (s.items !== undefined) out.items = s.items
    if (s.default !== undefined) out.default = s.default
    props[key] = out
    if (s.required === true) required.push(key)
  }
  const parameters = { type: 'object', properties: props }
  if (required.length > 0) parameters.required = required
  const tool = {
    name: options.name,
    description: options.description,
    parameters,
    output: { schema: options.output && options.output.schema ? options.output.schema : { type: 'json' }, render: options.output.render },
    execute: async (args, exec) => options.execute(args || {}, exec),
  }
  if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs
  if (options.isConcurrencySafe) tool.isConcurrencySafe = (args) => options.isConcurrencySafe(args)
  if (options.presentCall) tool.presentCall = (args) => options.presentCall(args)
  if (options.presentResult) tool.presentResult = (args, result) => options.presentResult(args, result)
  if (options.finalizeContent) tool.finalizeContent = (exec, result) => options.finalizeContent(exec, result)
  return tool
}

/** 解析结论（跑一次，缓存；诊断里会报出来，方便一眼区分「插件坏了」与「宿主换了」）。 */
export const HOST_API = (() => {
  const hit = requireAnywhere(['@deepseek-ai/dsh-tools'])
  if (hit.ok) {
    const fn = (hit.mod && hit.mod.defineTool) || (hit.mod && hit.mod.default && hit.mod.default.defineTool)
    if (typeof fn === 'function') {
      let resolvedPath = null
      try {
        resolvedPath = hit.resolve()
      } catch {
        /* resolve 失败不影响：函数已经拿到了 */
      }
      return { ok: true, defineTool: fn, source: 'host-package', anchor: hit.anchor, resolvedPath, tried: [] }
    }
  }
  return {
    ok: false,
    defineTool: localDefineTool,
    source: 'builtin-fallback',
    anchor: null,
    resolvedPath: null,
    tried: hit.tried || [],
  }
})()

/**
 * 插件版本 —— **必须与 `package.json` 的 `version` 一致**，`tests/version.test.mjs`
 * 会盯着这条（改一处忘另一处会让 `diagnostics`/`User-Agent` 报错版本，排查时白费时间）。
 */
export const PLUGIN_VERSION = '0.1.5'

/* ────────────────────────────── 1b. schemastery 解析 ────────────────────────────── */

/**
 * `schemastery` 在不同 DSH 版本间是**有 scope / 无 scope 两种包名**
 * （`schemastery` ↔ `@deepseek-ai/schemastery`）。静态 import 无法条件化，
 * 只声明其中一个就会在换宿主时 `ERR_MODULE_NOT_FOUND`，表现为整个插件消失。
 * 所以走运行时多锚点解析（与 dsh-tools 同一套锚点）。
 *
 * @returns {any|null} schemastery 的默认导出，解析不到返回 null
 */
export function resolveSchemastery() {
  const hit = requireAnywhere(['@deepseek-ai/schemastery', 'schemastery'])
  if (!hit.ok) return null
  const z = (hit.mod && hit.mod.default) || hit.mod
  return z && typeof z.object === 'function' ? z : null
}

/** schemastery 解析结论（诊断里要报）。 */
export const SCHEMASTERY = (() => {
  const z = resolveSchemastery()
  return { ok: z !== null, z }
})()

/* ────────────────────────────── 3. 工具定义 / 回执 ────────────────────────────── */

/** 图片/文本混合回执的 render：把 value 投影成宿主认识的 ContentBlock[]。 */
export function renderStructured(_args, value) {
  const blocks = []
  if (value && typeof value.envelope === 'string' && value.envelope.length > 0) {
    blocks.push({ type: 'text', text: value.envelope })
  }
  blocks.push({ type: 'text', text: String((value && value.text) || '') })
  if (value && value.image) blocks.push({ type: 'image', attachment: value.image })
  if (value && Array.isArray(value.images)) for (const im of value.images) blocks.push({ type: 'image', attachment: im })
  if (value && value.file) blocks.push({ type: 'file', attachment: value.file })
  if (value && Array.isArray(value.files)) for (const f of value.files) blocks.push({ type: 'file', attachment: f })
  return blocks
}

/** 任意 schema 的占位（我们的回执是自由形状的文本信封）。 */
export const ANY_SCHEMA = { type: 'json' }

/**
 * 统一的工具工厂：加版本前缀 → 跑 execute → 兜异常 → lossless 消毒 → 非静默记录修复。
 *
 * **execute 抛异常不再等于整条通道失败**：异常被就地转成 `{ok:false,error}` 回执，
 * 模型看到的是可读原因，而不是一句 "tool returned invalid output"。
 *
 * @param {object} spec defineTool 的入参（description 会被加上 [vX.Y.Z] 前缀）
 * @returns {object} registry-ready 工具定义
 */
export function defineRHTool(spec) {
  const { redactor: makeRedactor, ...definition } = spec
  const wrapped = {
    ...definition,
    description: '[v' + PLUGIN_VERSION + '] ' + String((spec && spec.description) || ''),
    execute: async (args, exec) => {
      const redact = typeof makeRedactor === 'function' ? makeRedactor(args) : createRedactor()
      let raw
      try {
        raw = await spec.execute(args || {}, exec)
      } catch (e) {
        raw = {
          ok: false,
          text: '工具执行异常（已被插件兜住，宿主通道未受影响）：' + String((e && e.stack) || (e && e.message) || e),
          error: { code: 'INTERNAL', message: String((e && e.message) || e) },
        }
      }
      const { value, fixes } = losslessSanitize(raw)
      if (fixes.length > 0) {
        const note =
          '⚠️ 回执已消毒 ' +
          String(fixes.length) +
          ' 处非 lossless-JSON 值（宿主门会拒收 undefined/NaN/Infinity/-0）：' +
          fixes.slice(0, 6).join(' · ') +
          (fixes.length > 6 ? ' …等' : '')
        try {
          if (value && typeof value === 'object' && typeof value.text === 'string') {
            value.text += String.fromCharCode(10) + note
          } else if (value && typeof value === 'object') {
            value.__losslessNote = note
          }
        } catch {
          /* 提示失败不影响返回 */
        }
      }
      return redact(value)
    },
  }
  return HOST_API.defineTool(wrapped)
}

/* ────────────────────────────── 4. 其他小工具 ────────────────────────────── */

/** 统一成功回执。 */
export function ok(payload) {
  return { ok: true, ...(payload || {}) }
}

/** 统一失败回执（**不抛异常**：错误码稳定可判，模型能据此换策略）。 */
export function fail(code, message, hint) {
  return { ok: false, error: { code: String(code), message: String(message == null ? '' : message), ...(hint ? { hint: String(hint) } : {}) } }
}

/** 安全 JSON.stringify（循环引用不炸）。 */
export function safeStringify(v) {
  try {
    return JSON.stringify(v)
  } catch {
    return null
  }
}

/** 单行 JSON 信封（宿主没有 json block，所以用一个纯 JSON 的 text block 代替）。 */
export function envelope(obj) {
  const s = safeStringify(obj)
  return s === null ? null : s
}

/** 远端生成的文字作为引用展示，短回执不复制整段上游输出。 */
export function quoteRemote(value, limit = 1024) {
  const text = String(value ?? '').replace(/\r\n?/g, '\n')
  const excerpt = text.length > limit ? text.slice(0, limit) + '\n[已截短，完整内容保留在任务记录]' : text
  return excerpt.replace(/^/gm, '> ')
}

/**
 * 把任意名字压成稳定的文件系统安全 slug（用于工作流 / 文档 id）。
 *
 * 中文名压不出 ASCII 时退回一串短哈希 —— **不能返回空串**，
 * 否则同名的多个工作流会撞到同一个文件、互相覆盖。
 *
 * @param {string} name 原始名字
 * @returns {string} 非空 slug
 */
export function slugify(name) {
  const s = String(name == null ? '' : name).trim()
  const ascii = s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
  if (ascii.length > 0) return ascii.slice(0, 64)
  // 全中文（或全符号）→ 用稳定的短哈希，保证同名映射到同一 id、异名不撞车
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return 'wf-' + (h >>> 0).toString(36) + '-' + String(s.length)
}

/**
 * 推导一个工作流配置的本地 id。
 * 优先用显式 id，其次 RunningHub 工作流 ID（同 ID 重配 = 覆盖同一份），最后用名字 slug。
 *
 * @param {{id?:string, rhWorkflowId?:string, name?:string, displayNameEn?:string}} cfg
 * @returns {string} 非空 id
 */
export function workflowIdOf(cfg) {
  const c = cfg || {}
  const explicit = String(c.id || '').trim()
  if (explicit.length > 0) return explicit
  const rh = String(c.rhWorkflowId || '').trim()
  if (rh.length > 0) return slugify('rh-' + rh)
  const en = String(c.displayNameEn || '').trim()
  if (en.length > 0) return slugify(en)
  return slugify(String(c.name || 'workflow'))
}
