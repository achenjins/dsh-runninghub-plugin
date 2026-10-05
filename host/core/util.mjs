/**
 * `host/core/util.mjs` —— 协议层内部公共设施（**不对外暴露给工具层，不给模型看**）
 *
 * 契约：
 *   - 零第三方依赖，只用 `node:*` 内建。
 *   - 不 import 任何 DSH 包；本文件不产生任何副作用（可被 `node --test` 直接加载）。
 *   - `maskKey()` 是**硬边界**：任何要落日志 / 进回执 / 进 UI 快照的 key 都必须先过它。
 *   - `losslessSanitize()` 保证返回值满足宿主的 lossless-JSON 门（无 undefined 值、
 *     无 NaN/±Infinity/-0、无 Date/Map/Set/类实例/循环引用）。
 *
 * 为什么单独一个文件：api / keys / store / workflow / runner / promptdoc 六个模块都要用这几个
 * 函数，复制六份必然漂移。它不是新契约，只是这六个模块共享的私有底座。
 *
 * @module dsh-runninghub-plugin/host/core/util
 */

/* ────────────────────────────────── 掩码 ────────────────────────────────── */

import { maskKey } from '../security.mjs'
import { losslessSanitize as sanitize } from '../lossless.mjs'
export { maskKey }
export { isPlainObject } from '../lossless.mjs'

/** 空 key 的占位文本（和 `host/shared.mjs` 的 `maskKey` 保持一致）。 */
export const MASK_EMPTY = '（未设置）'

/**
 * 递归掩码：把对象/数组里所有疑似 API Key 的字段值替换成掩码串。
 * 用于「外层对象形状未知但又必须落盘/回执」的兜底路径。
 * @param {unknown} value 任意值
 * @param {{keys?: string[]}} [opts] `keys` 覆盖默认的敏感字段名清单
 * @returns {unknown} 新对象（不修改入参）
 */
export function maskDeep(value, opts) {
  const names = new Set(
    (opts && opts.keys) || ['apikey', 'api_key', 'apikeyvalue', 'key', 'secret', 'token', 'password', 'authorization'],
  )
  const seen = new Set()
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v
    if (seen.has(v)) return '[Circular]'
    seen.add(v)
    if (Array.isArray(v)) {
      const out = v.map(walk)
      seen.delete(v)
      return out
    }
    const out = {}
    for (const [k, val] of Object.entries(v)) {
      if (names.has(k.toLowerCase()) && typeof val === 'string') out[k] = maskKey(val)
      else out[k] = walk(val)
    }
    seen.delete(v)
    return out
  }
  return walk(value)
}

/* ─────────────────────────── lossless JSON 消毒 ─────────────────────────── */

/**
 * 把任意值投影成宿主 lossless-JSON 门能收的形状，并把每处改动记进 `fixes`（不静默）。
 *
 * undefined → 丢键（数组元素 → null，长度不塌）· 非有限数 → null · -0 → 0 ·
 * bigint → number（超安全整数则 string）· Date → ISO 串 · Map/Set → 数组 ·
 * 二进制视图 → `{bytes, why}` · 循环引用 → `'[Circular]'` · 函数/symbol → 丢键
 *
 * @param {unknown} root 任意值
 * @returns {{ value: any, fixes: string[] }} 消毒后的值 + 修复记录
 */
export function losslessSanitize(root) {
  // Keep the core's existing fixes policy; host tool results record primitive fixes too.
  return sanitize(root, false)
}

/**
 * `losslessSanitize` 的纯函数版（不要 fixes）。
 * @param {unknown} v 任意值
 * @returns {any} 可直接交给宿主的 lossless 值
 */
export function lossless(v) {
  return losslessSanitize(v).value
}

/* ────────────────────────────────── 类型 ────────────────────────────────── */

/**
 * 安全取字符串（`null`/`undefined` → `''`；对象 → JSON 串）。
 * @param {unknown} v 任意值
 * @returns {string} 字符串
 */
export function asString(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return String(v)
  }
}

/**
 * 安全取有限数；非数字/NaN/±Infinity 返回 `fallback`。
 * @param {unknown} v 任意值
 * @param {number} [fallback] 兜底值（默认 0）
 * @returns {number} 有限数
 */
export function toNumber(v, fallback = 0) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  if (typeof v === 'boolean') return v ? 1 : 0
  return Number.isFinite(fallback) ? fallback : 0
}

/**
 * 去掉基址尾部斜杠并 trim。
 * @param {unknown} url 基址
 * @returns {string} 规范化后的基址
 */
export function trimBaseUrl(url) {
  let s = asString(url).trim()
  while (s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/* ──────────────────────────────── 时间/等待 ──────────────────────────────── */

/** 当前毫秒时间戳（集中一处方便测试注入）。 @returns {number} epoch ms */
export function nowMs() {
  return Date.now()
}

/**
 * 可中断的等待。
 * @param {number} ms 毫秒
 * @param {{signal?: AbortSignal}} [opts] 传入 `signal` 时会被 abort 立即打断
 * @returns {Promise<void>} 等待完成；被 abort 时 reject 一个 `AbortError`
 */
export function sleep(ms, opts) {
  const delay = Math.max(0, toNumber(ms, 0))
  const signal = opts && opts.signal
  if (signal && signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    let timer = null
    const onAbort = () => {
      if (timer !== null) clearTimeout(timer)
      reject(abortError())
    }
    timer = setTimeout(() => {
      if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort)
      resolve()
    }, delay)
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
    if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 构造一个标准的 AbortError。 @returns {Error} `err.name === 'AbortError'` */
export function abortError() {
  const e = new Error('操作已被取消')
  e.name = 'AbortError'
  return e
}

/* ────────────────────────────────── 杂项 ────────────────────────────────── */

/** 短随机 id（用于 taskId / jobId / docId；不含易混字符）。 @param {string} [prefix] 前缀 @returns {string} 形如 `task_3f9k2m1a` */
export function shortId(prefix = '') {
  const alphabet = '23456789abcdefghijkmnpqrstuvwxyz'
  let s = ''
  for (let i = 0; i < 8; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)]
  return prefix ? String(prefix) + '_' + s : s
}

/**
 * 稳定 slug：小写、非字母数字转 `-`、折叠、去首尾。中文会被保留（不是 ASCII-only）。
 * @param {unknown} text 输入
 * @param {string} [fallback] 结果为空时的兜底
 * @returns {string} slug
 */
export function slugify(text, fallback = 'workflow') {
  const s = asString(text)
    .trim()
    .toLowerCase()
    .replace(/[\s_/\\]+/g, '-')
    .replace(/[^0-9a-z\u4e00-\u9fff-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return s.length > 0 ? s.slice(0, 64) : fallback
}

/**
 * 截断文本（给日志与回执用，避免把 5MB 响应体灌进上下文）。
 * @param {unknown} text 输入
 * @param {number} [max] 最大长度（默认 400）
 * @returns {string} 截断后的字符串
 */
export function clip(text, max = 400) {
  const s = asString(text)
  const n = Math.max(0, Math.floor(toNumber(max, 400)))
  return s.length <= n ? s : s.slice(0, n) + '…'
}

/**
 * 构造一个 JSON 安全的错误 shape（**不含堆栈、不含明文 key**）。
 * @param {string} code 稳定错误码
 * @param {string} message 人类可读原因
 * @param {object} [extra] 额外字段（`hint` / `httpStatus` / `bizCode` / `uncertain` …）
 * @returns {{code:string,message:string}} lossless 错误对象
 */
export function errorShape(code, message, extra) {
  const out = { code: String(code), message: asString(message) }
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === null || v === '') continue
      out[k] = v
    }
  }
  return lossless(out)
}

/**
 * 把 `{ok:false,error}` / `{ok:true,...}` 的两种结果压成一句可读文本（工具层信封用）。
 * @param {{ok?:boolean, error?:{code?:string,message?:string,hint?:string}}} result 结果对象
 * @returns {string} 可读文本
 */
export function resultText(result) {
  if (!result || typeof result !== 'object') return '（空结果）'
  if (result.ok) return '成功'
  const e = result.error || {}
  return '[' + asString(e.code || 'ERROR') + '] ' + asString(e.message) + (e.hint ? ' —— ' + asString(e.hint) : '')
}

/**
 * 把异步任务包一层「绝不抛」的守卫：抛出的异常转成 `{ok:false,error}`。
 * @template T
 * @param {() => Promise<T>} fn 要执行的函数
 * @param {(e: any) => {ok:false,error:object}} onError 异常 → 结果对象
 * @returns {Promise<T|{ok:false,error:object}>} 原结果或错误结果
 */
export async function neverThrow(fn, onError) {
  try {
    return await fn()
  } catch (e) {
    return onError(e)
  }
}
