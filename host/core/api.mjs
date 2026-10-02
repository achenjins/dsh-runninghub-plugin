/**
 * `host/core/api.mjs` —— RunningHub OpenAPI 全部 HTTP 端点（协议层最底下一层）
 *
 * 契约（**Lead 已锁定，改名要先说**）：
 *   - 成功 `{ok:true, ...}`；失败 `{ok:false, error:{code,message,hint?}}`，**不抛异常**（除非编程错误）。
 *     `code` ∈ `AUTH|QUOTA|RATE_LIMIT|SERVER|TRANSPORT_UNCERTAIN|BUSINESS|BAD_REQUEST`
 *     （扩展：`UPLOAD_FAILED` / `NOT_IMPLEMENTED` / `ABORTED` / `CONFIG`）。
 *   - 每个请求都可注入 `fetchImpl` 与 `baseUrl`；构造器 `{fetchImpl, timeoutMs, logger}`。
 *   - 提交类 POST（`createTask` / `upload*`）**绝不自动重试**：可能已经扣费 / 已经收下文件。
 *     查询类（`accountStatus` / `getWorkflowJson` / `query*` / `cancelTask`）幂等，可指数退避重试。
 *   - 明文 key 绝不进日志、绝不进返回值；日志一律走 `maskKey()`。
 *
 * 端点（依据 RHStudio2 `ApiClient.java` + Python `runninghub_client.py` 实测）：
 *   POST /uc/openapi/accountStatus          {apikey}          + Bearer
 *   POST /api/openapi/getJsonApiFormat      {apiKey,workflowId}+ Bearer（官方示例另带 Host）
 *   POST /openapi/v2/media/upload/binary    multipart file    + Bearer   ← 新接口，体积上限更严
 *   POST /task/openapi/upload               multipart apiKey/fileType/file  ← 旧接口，兜底
 *   POST /task/openapi/create               {apiKey,workflowId,nodeInfoList,addMetadata,instanceType}
 *   POST /task/openapi/status               {apiKey,taskId}
 *   POST /task/openapi/outputs              {apiKey,taskId}
 *   POST /openapi/v2/query                  {taskId}          + Bearer
 *   POST /task/openapi/cancel               {apiKey,taskId}
 *   GET  <url>                              结果文件流式下载
 *
 * @module dsh-runninghub-plugin/host/core/api
 */

import { maskKey, clip, toNumber, asString, trimBaseUrl, lossless, errorShape } from './util.mjs'
import { createRedactor } from '../security.mjs'

/** 两套基址：key 与工作流都不通用，绝不互相回退。 */
export const BASE_URLS = {
  cn: 'https://www.runninghub.cn',
  overseas: 'https://www.runninghub.ai',
}

/** 合法 region 取值。 */
export const REGIONS = ['cn', 'overseas']

/** 稳定错误码枚举（前 7 个是 Lead 锁定的契约值）。 */
export const ERR = {
  AUTH: 'AUTH',
  QUOTA: 'QUOTA',
  RATE_LIMIT: 'RATE_LIMIT',
  SERVER: 'SERVER',
  TRANSPORT_UNCERTAIN: 'TRANSPORT_UNCERTAIN',
  BUSINESS: 'BUSINESS',
  BAD_REQUEST: 'BAD_REQUEST',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  NOT_AVAILABLE: 'NOT_AVAILABLE',
  ABORTED: 'ABORTED',
  CONFIG: 'CONFIG',
}

/** 任务状态词表（归一化后的闭集）。 */
export const STATUS = {
  CREATE: 'CREATE',
  QUEUED: 'QUEUED',
  RUNNING: 'RUNNING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  CANCEL: 'CANCEL',
  ERROR: 'ERROR',
  UNCERTAIN: 'UNCERTAIN',
}

/** 终态集合：进到这里就不要再轮询了。 */
export const TERMINAL_STATUSES = [STATUS.SUCCESS, STATUS.FAILED, STATUS.CANCEL, STATUS.ERROR, STATUS.UNCERTAIN]

/** 已知状态全集（用来判断 `status` 字段是否"认得出来"）。 */
export const KNOWN_STATUSES = [STATUS.CREATE, STATUS.QUEUED, STATUS.RUNNING, STATUS.SUCCESS, STATUS.FAILED, STATUS.CANCEL, STATUS.ERROR, STATUS.UNCERTAIN]

/** 默认 UA —— 官方上传示例只带 UA + Content-Type，多余 Accept-* 头曾让旧接口 500。 */
const USER_AGENT = 'dsh-runninghub-plugin/0.1.3'

/** 默认响应体上限（16MB）：防止异常大响应把插件内存打爆。 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

/** 结果文件默认下载上限（512MB）。 */
export const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024

/* ───────────────────────────────── 工具函数 ───────────────────────────────── */

/** 基址 → region；`https://www.runninghub.ai` → `'overseas'`，未知 → `null`。 @param {unknown} baseUrl 基址 @returns {'cn'|'overseas'|null} */
export function regionOfUrl(baseUrl) {
  const s = trimBaseUrl(baseUrl).toLowerCase()
  if (s === '') return null
  for (const r of REGIONS) if (s === BASE_URLS[r] || s.startsWith(BASE_URLS[r])) return r
  if (s.includes('runninghub.ai')) return 'overseas'
  if (s.includes('runninghub.cn')) return 'cn'
  return null
}

/**
 * 把 RH 各端点返回的状态串归一化到闭集（大小写不敏感）。
 * `CANCELLED/CANCELED → CANCEL` · `SUCCESSFUL/SUCCEED → SUCCESS` · `PENDING/QUEUE → QUEUED` ·
 * `PROCESSING → RUNNING` · `FAIL/FAILURE → FAILED` · 未知非空 → 原样大写 · 空 → `''`。
 * @param {unknown} raw 原始状态
 * @returns {string} 归一化状态（可能为 `''`）
 */
export function normalizeStatus(raw) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase()
  if (s === '') return ''
  if (s === 'CANCELLED' || s === 'CANCELED' || s === 'CANCEL') return STATUS.CANCEL
  if (s === 'SUCCESS' || s === 'SUCCESSFUL' || s === 'SUCCEED' || s === 'DONE' || s === 'COMPLETED') return STATUS.SUCCESS
  if (s === 'FAILED' || s === 'FAIL' || s === 'FAILURE' || s === 'TASK_FAILED') return STATUS.FAILED
  if (s === 'RUNNING' || s === 'PROCESSING' || s === 'EXECUTING') return STATUS.RUNNING
  if (s === 'QUEUED' || s === 'QUEUE' || s === 'PENDING' || s === 'WAITING' || s === 'CREATED') return STATUS.QUEUED
  if (s === 'CREATE') return STATUS.CREATE
  if (s === 'ERROR') return STATUS.ERROR
  if (s === 'UNCERTAIN') return STATUS.UNCERTAIN
  return s
}

/** 是否终态。 @param {unknown} status 归一化状态 @returns {boolean} 终态为 true */
export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(normalizeStatus(status))
}

/** 取响应里的可读消息（`msg` → `message` → `errorMessage` → `error`）。 @param {any} j 响应 JSON @returns {string} 消息文本 */
function pickMessage(j) {
  if (!j || typeof j !== 'object') return ''
  for (const k of ['msg', 'message', 'errorMessage', 'error', 'errorMsg', 'errMsg', 'detail']) {
    const v = j[k]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
    if (v && typeof v === 'object' && typeof v.message === 'string' && v.message.trim() !== '') return v.message.trim()
  }
  return ''
}

/** 取响应里的业务 code（**只认 `code`**）。
 *
 * 不把 `status` 当 code：`/openapi/v2/**` 提交族与 `/openapi/v2/query` 的响应体里**根本没有 `code`**，
 * 它们用 `status`（`QUEUED|RUNNING|SUCCESS|FAILED`）表达成败；把 `status` 误读成数字码会串味。
 * （依据：rh-docs `docs/api/endpoints.json` + `docs/api/workflow-json.md`，官方 schema 原文。）
 * @param {any} j 响应 JSON
 * @returns {number|null} 业务 code（无 → `null`）
 */
function pickBizCode(j) {
  if (!j || typeof j !== 'object') return null
  const v = j.code
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/** 取响应里的 `errorCode`（v2 无 code 族用它表达失败）。 @param {any} j 响应 JSON @returns {number|null} errorCode */
function pickErrorCode(j) {
  if (!j || typeof j !== 'object') return null
  for (const src of [j, j.data]) {
    if (!src || typeof src !== 'object') continue
    const v = src.errorCode
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  }
  return null
}

/**
 * 成功码：官方文档写的唯一成功码是 `0`（`/openapi/v2/media/upload/binary` 的官方原文是「0 成功，非0失败」）。
 *
 * ⚠️ **冲突与取舍（Lead 已决策，DESIGN §7.5 明文要求"宽容接受 200"）**：
 *   - 官方错误码表（301–1520，见 `docs/api/ERROR-CODES.md`）里**根本没有 200**，
 *     所以把 200 当成功**不会掩盖任何官方错误**；
 *   - 而参照实现 `runninghub_client.py` 的实测注释说「新接口成功码为 200」，
 *     RHStudio2 真机也在 `upload/binary` 上见过 200 —— 只认 0 会让真机上传直接失败。
 *   - 两边不对称：宽容的代价≈0，严格的代价=上传挂掉。**所以默认 `[0, 200]`**。
 *   - 想收紧（官方原教旨）：`new RunningHubApi({ successCodes: [0] })`。
 */
export const SUCCESS_CODES = [0, 200]

/**
 * 是否成功码。
 * - `code` 存在 → 必须在 `successCodes` 里。
 * - `code` 缺失（v2 提交族 / `query` / `price-preview` 都没有）→ 交给 `status`/`errorCode` 判，
 *   这里先算「没有业务码层面的失败」。
 * @param {number|null} code 业务 code
 * @param {number[]} [successCodes] 成功码表（默认 `[0, 200]`）
 * @returns {boolean} 是成功码为 true
 */
export function isSuccessCode(code, successCodes = SUCCESS_CODES) {
  if (code === null) return true
  return (Array.isArray(successCodes) ? successCodes : SUCCESS_CODES).includes(code)
}

/* ───────────────── 官方错误码表（docs/api/ERROR-CODES.md） ───────────────── */

/**
 * **数值码优先表**。放在关键词判定**之前**，这是 rh-docs task-5 复现出来的 P0 修复关键：
 *
 * 官方 `doc-8287338` 里有 **11 个以 `APIKEY_` 开头**的错误标识：
 * `APIKEY_INVALID_NODE_INFO`(803) / `APIKEY_FILE_SIZE_EXCEEDED`(809) / `APIKEY_TASK_NOT_FOUND`(807) /
 * `APIKEY_TASK_IS_RUNNING`(804) / `APIKEY_TASK_STATUS_ERROR`(805) / `APIKEY_UPLOAD_FAILED`(808) /
 * `APIKEY_TASK_IS_QUEUED`(813) …
 * 它们**全是业务错误**（参数不对、文件太大、任务不存在），但字面里都带 "apikey"。
 * 一旦被关键词判成 `AUTH`，就会走到 `KeyPool.report(id,'AUTH')` → `_invalid.add(id)`，
 * 而 `_invalid` **只能靠 UI 手动 reset 清除** ——
 * **用户配错一个 nodeId 就能把一把健康的 key 永久标死**。所以数值表必须先行。
 */
export const CODE_TABLE = {
  // ── AUTH：真正表达"这把 key 不认"的
  801: ERR.AUTH,
  802: ERR.AUTH,
  811: ERR.AUTH,
  1002: ERR.AUTH,
  1014: ERR.AUTH,
  // ── QUOTA：钱包/额度
  416: ERR.QUOTA, // TASK_CREATE_FAILED_BY_NOT_ENOUGH_WALLET
  812: ERR.QUOTA,
  // ── RATE_LIMIT / 资源等待
  421: ERR.RATE_LIMIT,
  1003: ERR.RATE_LIMIT,
  1520: ERR.RATE_LIMIT,
  415: ERR.RATE_LIMIT, // TASK_INSTANCE_MAXED：独占机器不足，官方原文"请等待 30-120 秒后重试"
  // ── SERVER：系统侧，重试有意义（官方原文都写了"请稍后重试"）
  500: ERR.SERVER,
  1005: ERR.SERVER,
  1010: ERR.SERVER,
  1012: ERR.SERVER,
  // ── BAD_REQUEST：请求本身不对
  301: ERR.BAD_REQUEST,
  380: ERR.BAD_REQUEST,
  412: ERR.BAD_REQUEST,
  433: ERR.BAD_REQUEST,
  1001: ERR.BAD_REQUEST, // Invalid URL, please check your link
  1007: ERR.BAD_REQUEST,
  1009: ERR.BAD_REQUEST,
  // ── BUSINESS：**必须以 BUSINESS 收口**的 `APIKEY_*` 业务标识（P0 的正面清单）
  803: ERR.BUSINESS, // APIKEY_INVALID_NODE_INFO
  804: ERR.BUSINESS, // APIKEY_TASK_IS_RUNNING
  805: ERR.BUSINESS, // APIKEY_TASK_STATUS_ERROR
  807: ERR.BUSINESS, // APIKEY_TASK_NOT_FOUND
  808: ERR.BUSINESS, // APIKEY_UPLOAD_FAILED
  809: ERR.BUSINESS, // APIKEY_FILE_SIZE_EXCEEDED
  813: ERR.BUSINESS, // APIKEY_TASK_IS_QUEUED
}

/** 官方码 → 给用户的处置建议（只挑会改变用户行为的几条）。 */
export const CODE_HINTS = {
  415: '独占型 API 机器数不足：等 30–120 秒重试即可，**key 本身没问题**',
  416: '钱包余额不足：去 RunningHub 充值；该 key 会自动冷却并换号',
  801: '请先在 RunningHub 后台创建 API Key',
  802: 'API Key 验证失败：确认这把 key 属于当前地域（国内/海外不通用）',
  803: 'nodeInfoList 与工作流不匹配：通常是 nodeId/fieldName 写错了，用 workflow.validate 复查',
  807: '任务不存在：taskId 可能写错，或本地流水指向了别的地域',
  809: '文件超过该 key 的体积上限：换旧接口重传或压缩文件',
  1003: '请求过于频繁（每分钟上限）：退避后重试同一把 key',
  1520: '单用户并发任务数已达上限：等前面的任务跑完',
  1005: 'RunningHub 系统内部错误：查询类会自动重试',
  1010: '服务暂不可用：查询类会自动重试',
  1012: '上游服务响应异常：稍后重试',
}

/**
 * 额度类关键词（多语言）。注意 `not[_ ]?enough` 必须同时覆盖 `not enough` 与 `not_enough`
 * ——官方标识是 `TASK_CREATE_FAILED_BY_NOT_ENOUGH_WALLET`（下划线），只写空格版会漏（rh-docs P1-a）。
 */
const QUOTA_PATTERNS = [
  /余额/, /额度/, /欠费/, /充值/, /积分/, /点数/,
  /insufficient/i, /\bbalance\b/i, /\bquota\b/i, /not[_ ]?enough/i, /no[_ ]?enough/i, /\bwallet\b/i, /\bcredits?\b/i, /\bcoins?\b/i,
]
/**
 * 鉴权类关键词。**必须是能表达"key 本身无效"的完整形态**，且用 `\b` 锚定，
 * 免得 `APIKEY_INVALID` 把 `APIKEY_INVALID_NODE_INFO` 也吃掉（P0）。
 */
const AUTH_PATTERNS = [
  /apikey_invalid\b/i, // ← `\b` 之后是 `_` 时不算边界，所以 APIKEY_INVALID_NODE_INFO **不会**命中
  /apikey_unauthorized/i,
  /corpapikey_invalid/i,
  /apikey_unsupported/i,
  /invalid api[_ ]?key/i,
  /api[_ ]?key is invalid/i,
  /apikey verification failed/i, // 官方 upload 接口的原文：`ApiKey verification failed: API Key不存在`
  /api[_ ]?key\s*不存在/i,
  /unauthorized/i,
  /鉴权/, /未授权/, /key\s*无效/i,
]
/** 限流 / 稍后重试类关键词。 */
const RATE_PATTERNS = [/too many/i, /rate[_ ]?limit/i, /频繁/, /限流/, /请稍后/, /稍后重试/, /retry later/i]

/**
 * 业务 code + 文案 → 稳定错误码。
 *
 * **顺序很重要**：① 官方数值码表 → ② 关键词 → ③ 数值区间兜底。
 * 把关键词放前面就是 P0（见 `CODE_TABLE` 的注释）。
 * @param {number|null} code 业务 code
 * @param {string} msg 可读消息
 * @returns {string} `ERR.*` 之一
 */
export function classifyBusiness(code, msg) {
  // ① 官方数值码表优先
  if (code !== null && CODE_TABLE[code] !== undefined) return CODE_TABLE[code]

  // ② 关键词兜底（处理 code 缺失或表外 code 的情况）
  const m = String(msg || '')
  if (QUOTA_PATTERNS.some((re) => re.test(m))) return ERR.QUOTA
  if (AUTH_PATTERNS.some((re) => re.test(m))) return ERR.AUTH
  if (RATE_PATTERNS.some((re) => re.test(m))) return ERR.RATE_LIMIT

  // ③ 数值区间兜底（只在 HTTP 语义区间内，不碰 8xx/1xxx 业务码）
  if (code === 401 || code === 403) return ERR.AUTH
  if (code === 402) return ERR.QUOTA
  if (code === 429) return ERR.RATE_LIMIT
  if (code === 400 || code === 404 || code === 405 || code === 406 || code === 422) return ERR.BAD_REQUEST
  // 只有 5xx 段才当服务端错误：RH 的业务码会跑到 8xx（如 805 = 任务状态错误），
  // 那不是 HTTP 5xx，不能误判成 SERVER，否则会被无脑重试。
  if (code !== null && code >= 500 && code < 600) return ERR.SERVER
  return ERR.BUSINESS
}

/**
 * 把一个业务码翻译成给用户的处置建议（没有就返回 `''`）。
 * @param {number|null} code 业务 code
 * @returns {string} 建议
 */
export function hintForCode(code) {
  return code !== null && CODE_HINTS[code] !== undefined ? CODE_HINTS[code] : ''
}

/** 实例类型官方 enum（官方 schema `x-apifox-overrides`：default=24G / plus=48G / ultra=84G）。 */
export const INSTANCE_TYPES = ['default', 'plus', 'ultra']

/** 常见别名 → 官方 enum（参照实现里的 `Standard/Plus/Ultra` 就是这套）。 */
const INSTANCE_ALIASES = { standard: 'default', std: 'default', normal: 'default', basic: 'default', pro: 'plus', premium: 'ultra', max: 'ultra' }

/**
 * 归一化 `instanceType` 到官方 enum（大小写不敏感 + 常见别名）。
 * @param {unknown} value 原始值
 * @returns {{ok:true,value:string}|{ok:false,error:object}} 结果（`default` 表示"不带该字段"）
 */
export function normalizeInstanceType(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase()
  if (raw === '') return { ok: true, value: 'default' }
  if (INSTANCE_TYPES.includes(raw)) return { ok: true, value: raw }
  if (INSTANCE_ALIASES[raw]) return { ok: true, value: INSTANCE_ALIASES[raw] }
  return {
    ok: false,
    error: errorShape(ERR.BAD_REQUEST, '不认识的 instanceType：' + String(value), {
      hint: '官方 enum 只有 ' + INSTANCE_TYPES.join(' / ') + '（分别 24G / 48G / 84G）',
    }),
  }
}

/**
 * HTTP 状态码 → 稳定错误码（业务 code 缺失或不可信时的兜底）。
 * @param {number} httpStatus HTTP 状态码
 * @returns {string} `ERR.*` 之一
 */
export function classifyHttp(httpStatus) {
  const s = toNumber(httpStatus, 0)
  if (s === 401 || s === 403) return ERR.AUTH
  if (s === 402) return ERR.QUOTA
  if (s === 429) return ERR.RATE_LIMIT
  if (s === 400 || s === 404 || s === 405 || s === 406 || s === 408 || s === 413 || s === 415 || s === 422) return ERR.BAD_REQUEST
  if (s >= 500) return ERR.SERVER
  return ERR.BUSINESS
}

/**
 * 错误码 → 是否值得**同一把 key** 再试一次（仅幂等调用；提交类永远 false）。
 * @param {string} code 稳定错误码
 * @returns {boolean} 可重试为 true
 */
export function isRetryable(code) {
  return code === ERR.RATE_LIMIT || code === ERR.SERVER || code === ERR.TRANSPORT_UNCERTAIN
}

/* ───────────────────────────────── 错误对象 ───────────────────────────────── */

/** 协议层内部异常（只在模块内部 throw，公开方法一律转成 `{ok:false,error}`）。 */
export class RhError extends Error {
  /**
   * @param {string} code 稳定错误码
   * @param {string} message 人类可读原因
   * @param {object} [extra] `hint` / `httpStatus` / `bizCode` / `uncertain` / `body`
   */
  constructor(code, message, extra = {}) {
    super(String(message || code))
    this.name = 'RhError'
    this.code = String(code)
    this.hint = extra.hint ? String(extra.hint) : undefined
    this.httpStatus = Number.isFinite(extra.httpStatus) ? extra.httpStatus : undefined
    this.bizCode = Number.isFinite(extra.bizCode) ? extra.bizCode : undefined
    this.uncertain = extra.uncertain === true
    this.body = extra.body
  }
  /** 转成 lossless 的 `{code,message,hint?}` 形状（**不含堆栈、不含明文 key**）。 @returns {{code:string,message:string}} 错误对象 */
  toShape() {
    return errorShape(this.code, this.message, {
      hint: this.hint,
      httpStatus: this.httpStatus,
      bizCode: this.bizCode,
      uncertain: this.uncertain ? true : undefined,
    })
  }
}

/** 由 `RhError` 或任意异常构造失败回执。 @param {any} e 异常 @param {string} [fallbackCode] 兜底码 @returns {{ok:false,error:object}} */
export function failFrom(e, fallbackCode = ERR.BUSINESS) {
  if (e instanceof RhError) return { ok: false, error: e.toShape() }
  const msg = String((e && e.message) || e || '未知错误')
  return { ok: false, error: errorShape(fallbackCode, msg) }
}

/* ───────────────────────────── 请求结果的分类 ───────────────────────────── */

/**
 * 由 HTTP 响应 + 已解析 body 判定成功/失败（**不抛**）。
 * @param {{httpStatus:number, json:any, text:string, submit?:boolean, successCodes?:number[]}} r 响应快照
 * @returns {{ok:true, data:any}|{ok:false, error:RhError}} 判定结果
 */
export function classifyResponse(r) {
  const httpStatus = toNumber(r.httpStatus, 0)
  const j = r.json
  const text = String(r.text == null ? '' : r.text)
  const msg = pickMessage(j)
  const code = pickBizCode(j)
  const bodySnippet = clip(j ? JSON.stringify(j) : text, 300)

  // 1) HTTP 层就不 OK —— 先按状态码定性，再用业务 code/文案细化。
  if (httpStatus < 200 || httpStatus >= 300) {
    let k = classifyHttp(httpStatus)
    if (k === ERR.BUSINESS) k = classifyBusiness(code, msg)
    const uncertain = r.submit === true && httpStatus >= 500
    if (uncertain) k = ERR.TRANSPORT_UNCERTAIN
    const hint =
      uncertain
        ? '提交响应为服务端错误，任务可能已经创建并扣费。请先到 RunningHub 核对，勿自动重投。'
        : k === ERR.AUTH
        ? 'API Key 无效或已失效：换一把该地域的 key，或重新探测地域'
        : k === ERR.QUOTA
          ? '该 key 额度/余额不足：KeyPool 会自动冷却并换号'
          : k === ERR.RATE_LIMIT
            ? '请求过于频繁：退避后重试同一把 key'
            : k === ERR.SERVER
              ? 'RunningHub 服务端异常：查询类可重试，提交类请先核实是否已创建任务'
              : undefined
    return {
      ok: false,
      error: new RhError(k, msg || 'HTTP ' + String(httpStatus), {
        hint,
        httpStatus,
        ...(uncertain ? { uncertain: true } : {}),
        bizCode: code === null ? undefined : code,
        body: bodySnippet,
      }),
    }
  }

  // 2) 2xx 但 body 不是 JSON —— 无法确认业务语义。
  if (!j || typeof j !== 'object') {
    const k = r.submit ? ERR.TRANSPORT_UNCERTAIN : ERR.SERVER
    return {
      ok: false,
      error: new RhError(k, '响应不是 JSON（HTTP ' + String(httpStatus) + '）' + (text ? '：' + clip(text, 160) : ''), {
        hint: r.submit
          ? '提交类请求的响应无法解析，**任务可能已经创建并扣费**：不要自动重发，先按 taskId/流水核对'
          : '查询类请求可以重试',
        httpStatus,
        uncertain: r.submit === true,
        body: bodySnippet,
      }),
    }
  }

  // 3) 2xx + JSON：业务 code 决定成败。
  //    `code` 缺失（`/openapi/v2/**` 提交族 / `query` / `price-preview` 的官方 schema 里没有 `code`）
  //    → 改看 `errorCode`：非 0 就是失败；再不然就把判读权交给调用方（如 `queryV2` 读 `status`）。
  const successCodes = Array.isArray(r.successCodes) ? r.successCodes : SUCCESS_CODES
  if (code === null) {
    // v2 族带 `status`（task 级状态）：成败由 status 表达，判读权交给调用方（queryV2 / queryOutputs）。
    const st = normalizeStatus(j.status || (j.data && typeof j.data === 'object' ? j.data.status : ''))
    if (KNOWN_STATUSES.includes(st)) return { ok: true, data: j.data === undefined ? j : j.data }
    // 没有可用 status 时才看 `errorCode`（请求级失败）
    const ec = pickErrorCode(j)
    if (ec !== null && ec !== 0) {
      return {
        ok: false,
        error: new RhError(classifyBusiness(ec, msg), msg || 'errorCode=' + String(ec), {
          httpStatus,
          bizCode: ec,
          body: bodySnippet,
        }),
      }
    }
    return { ok: true, data: j.data === undefined ? j : j.data }
  }
  if (successCodes.includes(code)) return { ok: true, data: j.data === undefined ? j : j.data }

  const k = classifyBusiness(code, msg)
  return {
    ok: false,
    error: new RhError(k, msg || '业务错误 code=' + String(code), {
      hint:
        hintForCode(code) ||
        (k === ERR.QUOTA
          ? '该 key 额度不足：KeyPool 会自动冷却 10 分钟并换号'
          : k === ERR.AUTH
            ? 'Key 无效：标记失效并换号'
            : undefined),
      httpStatus,
      bizCode: code === null ? undefined : code,
      body: bodySnippet,
    }),
  }
}

/* ────────────────────────────────── 客户端 ────────────────────────────────── */

/**
 * RunningHub HTTP 客户端。所有公开方法**只返回结果对象，不抛异常**。
 *
 * @example
 * const api = new RunningHubApi({ logger: console })
 * const r = await api.createTask(key, 'cn', { workflowId, nodeInfoList })
 * if (!r.ok) console.warn(r.error.code, r.error.message)
 */
export class RunningHubApi {
  /**
   * @param {object} [opts]
   * @param {typeof fetch} [opts.fetchImpl] 注入的 fetch（默认 `globalThis.fetch`），单测里换成 mock
   * @param {number} [opts.timeoutMs] 默认单请求超时（毫秒，默认 30000；提交类自动放宽到 60000）
   * @param {{info?:Function,warn?:Function,error?:Function,debug?:Function}} [opts.logger] 日志器（可省）
   * @param {number} [opts.retries] 幂等调用的最大重试次数（默认 2）
   * @param {object} [opts.baseUrls] 覆盖基址表（自建代理时用）
   * @param {Function} [opts.sleepImpl] 注入的 sleep（默认 util.sleep）
   * @param {boolean} [opts.hostHeader] 是否给 getJsonApiFormat 带 `Host` 头（undici 会忽略该 forbidden header，默认 false）
   * @param {() => string[]} [opts.knownSecrets] 返回**当前池里全部明文 Key**（用于把服务端回显的
   *   其它凭据也按字面量抹掉）。只在传输层脱敏时用；拿不到就不给，不影响功能。
   */
  constructor(opts = {}) {
    this.fetchImpl = opts.fetchImpl || globalThis.fetch
    if (typeof this.fetchImpl !== 'function') {
      throw new TypeError('RunningHubApi: 需要 globalThis.fetch 或注入 fetchImpl')
    }
    /**
     * 已知密钥的来源（池里所有 Key）。传输层用它做**字面量**脱敏 —— 这样既能抹掉
     * 服务端回显的任意一把凭据，又不至于按字段名误伤用户的业务参数（见 `_send`）。
     * 惰性求值：池是后装配的，所以给函数而不是数组快照。
     */
    this.knownSecrets = typeof opts.knownSecrets === 'function' ? opts.knownSecrets : opts.knownSecrets || null
    this.timeoutMs = Math.max(100, toNumber(opts.timeoutMs, 30000))
    this.submitTimeoutMs = Math.max(this.timeoutMs, toNumber(opts.submitTimeoutMs, 60000))
    this.logger = opts.logger || null
    this.retries = Math.max(0, Math.floor(toNumber(opts.retries, 2)))
    this.baseUrls = { ...BASE_URLS, ...(opts.baseUrls || {}) }
    this.sleepImpl = typeof opts.sleepImpl === 'function' ? opts.sleepImpl : null
    this.hostHeader = opts.hostHeader === true
    this.maxResponseBytes = Math.max(1024, toNumber(opts.maxResponseBytes, MAX_RESPONSE_BYTES))
    /** 成功码表：官方唯一成功码是 `0`；真机若证实 v2 上传返回 200，传 `[0, 200]` 兼容。 */
    this.successCodes = Array.isArray(opts.successCodes) && opts.successCodes.length > 0 ? opts.successCodes : SUCCESS_CODES
  }

  /** 内部控制台日志；**永远只输出掩码**。 @param {'info'|'warn'|'error'|'debug'} level 级别 @param {string} msg 消息 @param {object} [meta] 附加字段 @returns {void} */
  _log(level, msg, meta) {
    const fn = this.logger && (this.logger[level] || this.logger.log)
    if (typeof fn !== 'function') return
    try {
      fn.call(this.logger, '[rh-api] ' + msg, meta ? lossless(meta) : '')
    } catch {
      /* 日志失败永不影响主流程 */
    }
  }

  /**
   * region → 基址。`region` 也可直接给一个 http(s) 基址。
   * @param {string} region `'cn'|'overseas'|<baseUrl>`
   * @returns {string} 基址（去尾斜杠）
   */
  baseUrlFor(region) {
    const s = String(region == null ? '' : region).trim()
    if (/^https?:\/\//i.test(s)) return trimBaseUrl(s)
    return trimBaseUrl(this.baseUrls[s] || this.baseUrls.cn)
  }

  /** 当前生效的基址表快照。 @returns {{cn:string,overseas:string}} 基址表 */
  get bases() {
    return { cn: trimBaseUrl(this.baseUrls.cn), overseas: trimBaseUrl(this.baseUrls.overseas) }
  }

  /**
   * 发一个请求并做重试/超时/响应体限长（**不含业务判定**）。
   * @param {object} spec 请求规格
   * @returns {Promise<{ok:true,httpStatus:number,json:any,text:string}|{ok:false,error:RhError}>} 传输层结果
   */
  async _send(spec) {
    const url = String(spec.url)
    const authorization = spec.headers && (spec.headers.Authorization || spec.headers.authorization)
    const secret = typeof authorization === 'string' ? authorization.replace(/^Bearer\s+/i, '') : ''
    // ⚠️ **必须 byName:false**。
    //
    // 这一层的产物会**回流成业务数据**（工作流 JSON → 节点 default → 提交参数），
    // 不是单纯的诊断文本。按字段名掩码会命中 ComfyUI/RunningHub 工作流里常见的
    // 节点入参名（`token` / `api_key` / `secret` / `password` / `authorization`），
    // 把它改成 `sk-l****epme`，然后 `buildNodeInfoList` 会把改写过的 default
    // **原样提交**给平台 —— 静默提交一个残缺值，不报任何错。
    //
    // 字面量匹配（只抹我们真正持有的那些 Key）既堵住了"服务端回显凭据"，
    // 又不会碰用户的正常参数。按名字的掩码留给日志/错误出口。
    //
    // ⚠️ 已知密钥不只是**本次这把**：服务端也可能回显**池里别的 key**
    //（例如 `/api-key/list`、或某个接口把别的凭据对象原样带回）。所以要把
    // 池里全部 key 一起作为字面量传进来 —— 这正好替代了原来"按字段名掩码"
    // 想达到的效果，却没有它的副作用。
    const known = []
    try {
      const extra = typeof this.knownSecrets === 'function' ? this.knownSecrets() : this.knownSecrets
      for (const item of Array.isArray(extra) ? extra : []) if (typeof item === 'string' && item !== '') known.push(item)
    } catch {
      /* 拿不到池就只抹本次这把 */
    }
    const redact = createRedactor(secret === '' ? known : [secret, ...known], { byName: false })
    const attempts = Math.max(1, (spec.retries ?? 0) + 1)
    const timeoutMs = Math.max(1000, toNumber(spec.timeoutMs, this.timeoutMs))
    let last = null
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const ac = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        ac.abort()
      }, timeoutMs)
      if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
      const onOuterAbort = () => ac.abort()
      if (spec.signal) {
        if (spec.signal.aborted) {
          clearTimeout(timer)
          return { ok: false, error: new RhError(ERR.ABORTED, '调用方已取消', { hint: '不是服务端错误' }) }
        }
        try {
          spec.signal.addEventListener('abort', onOuterAbort, { once: true })
        } catch {
          /* 非标准 signal：忽略 */
        }
      }
      const started = Date.now()
      try {
        const res = await this.fetchImpl(url, {
          method: spec.method || 'POST',
          headers: spec.headers,
          body: spec.body,
          signal: ac.signal,
          redirect: 'follow',
        })
        const httpStatus = toNumber(res && res.status, 0)
        const rawText = await this._readTextBounded(res)
        const json = redact(parseJsonLoose(rawText))
        const text = json ? JSON.stringify(json) : redact(rawText)
        this._log('debug', redact((spec.method || 'POST') + ' ' + pathOf(url) + ' → HTTP ' + String(httpStatus)), {
          ms: Date.now() - started,
          attempt,
          key: spec.keyMasked,
        })
        // HTTP 层/业务码可重试（429、5xx、业务限流）且还有配额 → 退避后重试。
        // 提交类（spec.submit）的 retries 恒为 0，走不到这里，绝不会重发。
        if (attempt < attempts) {
          const verdict = classifyResponse({ httpStatus, json, text, submit: spec.submit === true, successCodes: this.successCodes })
          if (!verdict.ok && isRetryable(verdict.error.code)) {
            last = verdict.error
            this._log('warn', redact('可重试失败 ' + pathOf(url) + ' ' + verdict.error.code + '（attempt ' + String(attempt) + '/' + String(attempts) + '）'), {
              key: spec.keyMasked,
            })
            clearTimeout(timer)
            if (spec.signal && typeof spec.signal.removeEventListener === 'function') spec.signal.removeEventListener('abort', onOuterAbort)
            await this._sleep(400 * 2 ** (attempt - 1))
            continue
          }
        }
        return { ok: true, httpStatus, json, text }
      } catch (e) {
        const abortedByOuter = !!(spec.signal && spec.signal.aborted)
        const name = e && e.name
        if (abortedByOuter) {
          clearTimeout(timer)
          if (spec.signal && typeof spec.signal.removeEventListener === 'function') spec.signal.removeEventListener('abort', onOuterAbort)
          return { ok: false, error: new RhError(ERR.ABORTED, '调用方已取消', { hint: '不是服务端错误' }) }
        }
        const isAbort = name === 'AbortError' || name === 'TimeoutError' || timedOut
        const code = isAbort || isNetworkError(e) ? ERR.TRANSPORT_UNCERTAIN : ERR.BUSINESS
        last = new RhError(
          code,
          isAbort
            ? (timedOut ? '请求超时（' + String(timeoutMs) + 'ms）' : '请求被中断')
            : '网络错误：' + redact((e && e.message) || e),
          {
            hint: isAbort
              ? '连接中断/超时 → **服务端结果未知**；提交类绝不自动重发'
              : '本地网络异常 → 结果未知',
            uncertain: true,
          },
        )
        this._log('warn', redact('transport 失败 ' + pathOf(url) + '（attempt ' + String(attempt) + '/' + String(attempts) + '）: ' + last.message), {
          key: spec.keyMasked,
        })
        if (attempt < attempts && isRetryable(code)) {
          await this._sleep(400 * 2 ** (attempt - 1))
          clearTimeout(timer)
          if (spec.signal && typeof spec.signal.removeEventListener === 'function') spec.signal.removeEventListener('abort', onOuterAbort)
          continue
        }
        clearTimeout(timer)
        if (spec.signal && typeof spec.signal.removeEventListener === 'function') spec.signal.removeEventListener('abort', onOuterAbort)
        return { ok: false, error: last }
      } finally {
        clearTimeout(timer)
        if (spec.signal && typeof spec.signal.removeEventListener === 'function') spec.signal.removeEventListener('abort', onOuterAbort)
      }
    }
    return { ok: false, error: last || new RhError(ERR.TRANSPORT_UNCERTAIN, '请求失败') }
  }

  /** 有上限地读响应体文本（超限截断并标记）。 @param {any} res Response-like @returns {Promise<string>} 文本 */
  async _readTextBounded(res) {
    const max = this.maxResponseBytes
    try {
      const body = res && res.body
      if (body && typeof body.getReader === 'function') {
        const reader = body.getReader()
        const chunks = []
        let total = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          total += value.byteLength
          chunks.push(value)
          if (total > max) {
            try {
              await reader.cancel()
            } catch {
              /* 取消失败不影响 */
            }
            break
          }
        }
        return decodeUtf8(concatBytes(chunks))
      }
      const text = typeof res.text === 'function' ? await res.text() : ''
      return String(text).slice(0, max)
    } catch (e) {
      // 读体失败 = 传输不确定：交给上层按“响应不是 JSON”处理
      throw e
    }
  }

  /** 退避等待（可注入，默认走真实 setTimeout）。 @param {number} ms 毫秒 @returns {Promise<void>} */
  _sleep(ms) {
    const delay = Math.max(0, toNumber(ms, 0))
    if (this.sleepImpl) return this.sleepImpl(delay)
    return new Promise((r) => {
      const t = setTimeout(r, delay)
      if (t && typeof t.unref === 'function') t.unref()
    })
  }

  /**
   * 统一的「发请求 → 判成败」包装。
   * @param {object} spec 请求规格 + `{submit?:boolean, retries?:number, keyMasked?:string}`
   * @returns {Promise<{ok:true,data:any,raw:any,httpStatus:number}|{ok:false,error:object}>} 结果对象
   */
  async _call(spec) {
    const retries = spec.submit ? 0 : (spec.retries ?? this.retries)
    const sent = await this._send({ ...spec, retries, keyMasked: spec.keyMasked })
    if (!sent.ok) return { ok: false, error: sent.error.toShape() }
    const verdict = classifyResponse({
      httpStatus: sent.httpStatus,
      json: sent.json,
      text: sent.text,
      submit: spec.submit === true,
      successCodes: this.successCodes,
    })
    if (!verdict.ok) return { ok: false, error: verdict.error.toShape() }
    return { ok: true, data: verdict.data, raw: sent.json, httpStatus: sent.httpStatus }
  }

  /** 构造 JSON POST 的 headers（只在需要时带 Authorization）。 @param {string} key 明文 key（仅用于拼 header） @param {string} [base] 基址 @returns {object} headers */
  _jsonHeaders(key, base) {
    const h = { 'Content-Type': 'application/json; charset=utf-8', 'User-Agent': USER_AGENT }
    if (key) h.Authorization = 'Bearer ' + String(key)
    if (this.hostHeader && base) {
      try {
        h.Host = new URL(base).host
      } catch {
        /* 非法基址：忽略 */
      }
    }
    return h
  }

  /* ─────────────────────────────── 账号 ─────────────────────────────── */

  /**
   * 账号状态（**地域探测的唯一依据**）。`POST /uc/openapi/accountStatus`
   * @param {string} key 明文 key
   * @param {string} region `'cn'|'overseas'` 或基址
   * @param {{signal?:AbortSignal}} [opts] 可选
   * @returns {Promise<{ok:true,data:{remainCoins:string,remainMoney:string,currency:string,currentTaskCounts:string,apiType:string,raw:any}}|{ok:false,error:object}>} 结果
   */
  async accountStatus(key, region, opts = {}) {
    const base = this.baseUrlFor(region)
    const r = await this._call({
      url: base + '/uc/openapi/accountStatus',
      method: 'POST',
      headers: this._jsonHeaders(key, base),
      body: JSON.stringify({ apikey: String(key || '') }),
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      keyMasked: maskKey(key),
    })
    if (!r.ok) return r
    const d = r.data && typeof r.data === 'object' ? r.data : {}
    return {
      ok: true,
      data: {
        remainCoins: String(d.remainCoins ?? '0'),
        remainMoney: String(d.remainMoney ?? '0'),
        currency: String(d.currency ?? 'CNY'),
        currentTaskCounts: String(d.currentTaskCounts ?? d.currentTaskCount ?? '0'),
        apiType: String(d.apiType ?? ''),
        raw: lossless(d),
      },
    }
  }

  /* ─────────────────────────────── 工作流 ─────────────────────────────── */

  /**
   * 取工作流 API 格式 JSON。`POST /api/openapi/getJsonApiFormat`
   * 响应 `data.prompt` 是**字符串**，这里已经 `JSON.parse` 好。
   * 成功码同时认 `0` 与 `200`（`classifyResponse` 负责）。
   * @param {string} key 明文 key
   * @param {string} region `'cn'|'overseas'` 或基址
   * @param {string} workflowId RunningHub 工作流 ID
   * @param {{signal?:AbortSignal}} [opts] 可选
   * @returns {Promise<{ok:true,workflow:object,raw:any}|{ok:false,error:object}>} 结果
   */
  async getWorkflowJson(key, region, workflowId, opts = {}) {
    const base = this.baseUrlFor(region)
    const r = await this._call({
      url: base + '/api/openapi/getJsonApiFormat',
      method: 'POST',
      headers: this._jsonHeaders(key, base),
      body: JSON.stringify({ apiKey: String(key || ''), workflowId: String(workflowId || '') }),
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      keyMasked: maskKey(key),
    })
    if (!r.ok) return r
    const d = r.data && typeof r.data === 'object' ? r.data : {}
    const prompt = d.prompt
    let workflow = null
    if (prompt && typeof prompt === 'object') {
      workflow = prompt
    } else if (typeof prompt === 'string' && prompt.trim() !== '') {
      try {
        workflow = JSON.parse(prompt)
      } catch (e) {
        return {
          ok: false,
          error: errorShape(ERR.BUSINESS, 'data.prompt 不是合法 JSON：' + String((e && e.message) || e), {
            hint: '把原始响应片段发给维护者：' + clip(prompt, 200),
          }),
        }
      }
    }
    if (!workflow || typeof workflow !== 'object') {
      return {
        ok: false,
        error: errorShape(ERR.BUSINESS, '响应缺少 data.prompt', {
          hint: '确认 workflowId 正确、且该 key 有权限访问这个工作流（data 字段：' + clip(JSON.stringify(d), 200) + '）',
        }),
      }
    }
    return { ok: true, workflow, raw: lossless(r.raw) }
  }

  /* ─────────────────────────────── 上传 ─────────────────────────────── */

  /**
   * 组装 multipart body（优先用平台自带 `FormData`/`Blob`，零依赖）。
   * @param {Record<string,string>} fields 普通字段
   * @param {string} fileField 文件字段名
   * @param {Uint8Array} bytes 文件字节
   * @param {string} filename 文件名
   * @returns {FormData} 表单
   */
  _form(fields, fileField, bytes, filename) {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields || {})) fd.append(k, String(v))
    const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
    const view = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const name = String(filename || 'upload.bin')
    let part
    if (typeof globalThis.File === 'function') part = new File([view], name)
    else part = new Blob([view])
    fd.append(fileField, part, name)
    return fd
  }

  /**
   * 新接口上传。`POST /openapi/v2/media/upload/binary`，multipart 字段 `file`，Bearer 鉴权。
   * **体积上限比旧接口严**，失败要给 `uploadFile` 去回退。
   * @param {string} key 明文 key
   * @param {string} region `'cn'|'overseas'` 或基址
   * @param {Uint8Array} bytes 文件字节
   * @param {string} filename 文件名
   * @param {{fileType?:string,signal?:AbortSignal}} [opts] 可选
   * @returns {Promise<{ok:true,fileName:string,downloadUrl:string,raw:any}|{ok:false,error:object}>} 结果
   */
  async uploadBinary(key, region, bytes, filename, opts = {}) {
    const base = this.baseUrlFor(region)
    const form = this._form({}, 'file', bytes, filename)
    const r = await this._call({
      url: base + '/openapi/v2/media/upload/binary',
      method: 'POST',
      headers: { Authorization: 'Bearer ' + String(key || ''), 'User-Agent': USER_AGENT },
      body: form,
      signal: opts.signal,
      timeoutMs: Math.max(this.submitTimeoutMs, toNumber(opts.timeoutMs, 0)),
      submit: true,
      keyMasked: maskKey(key),
    })
    if (!r.ok) return r
    const d = r.data && typeof r.data === 'object' ? r.data : {}
    const fileName = String(d.filename || d.fileName || d.name || '')
    const downloadUrl = String(d.download_url || d.downloadUrl || '')
    if (fileName === '' && downloadUrl === '') {
      return {
        ok: false,
        error: errorShape(ERR.UPLOAD_FAILED, '新接口上传响应缺少 filename/download_url', {
          hint: '原始 data：' + clip(JSON.stringify(d), 200),
        }),
      }
    }
    return { ok: true, fileName, downloadUrl, raw: lossless(d) }
  }

  /**
   * 旧接口上传。`POST /task/openapi/upload`，multipart 字段 `apiKey`/`fileType`/`file`。
   * @param {string} key 明文 key
   * @param {string} region `'cn'|'overseas'` 或基址
   * @param {Uint8Array} bytes 文件字节
   * @param {string} filename 文件名
   * @param {string} [fileType] `image|audio|video|input`（默认 `input`）
   * @param {{signal?:AbortSignal}} [opts] 可选
   * @returns {Promise<{ok:true,fileName:string,downloadUrl:string,raw:any}|{ok:false,error:object}>} 结果
   */
  async uploadLegacy(key, region, bytes, filename, fileType = 'input', opts = {}) {
    const base = this.baseUrlFor(region)
    const t = ['image', 'audio', 'video', 'input'].includes(String(fileType)) ? String(fileType) : 'input'
    const form = this._form({ apiKey: String(key || ''), fileType: t }, 'file', bytes, filename)
    const r = await this._call({
      url: base + '/task/openapi/upload',
      method: 'POST',
      headers: { Authorization: 'Bearer ' + String(key || ''), 'User-Agent': USER_AGENT },
      body: form,
      signal: opts.signal,
      timeoutMs: Math.max(this.submitTimeoutMs, toNumber(opts.timeoutMs, 0)),
      submit: true,
      keyMasked: maskKey(key),
    })
    if (!r.ok) return r
    const d = r.data && typeof r.data === 'object' ? r.data : {}
    const fileName = String(d.fileName || d.filename || d.name || '')
    if (fileName === '') {
      return {
        ok: false,
        error: errorShape(ERR.UPLOAD_FAILED, '旧接口上传响应缺少 data.fileName', { hint: '原始 data：' + clip(JSON.stringify(d), 200) }),
      }
    }
    return { ok: true, fileName, downloadUrl: String(d.download_url || d.downloadUrl || ''), raw: lossless(d) }
  }

  /**
   * 上传一个文件：**先新接口，失败（含体积上限 809）必回退旧接口**。
   * 两边都失败时把两边的真实错误都带回来——只报一句 "HTTP 500" 用户没法自查。
   * @param {string} key 明文 key
   * @param {string} region `'cn'|'overseas'` 或基址
   * @param {Uint8Array} bytes 文件字节
   * @param {string} filename 文件名
   * @param {{fileType?:string,signal?:AbortSignal}} [opts] 可选
   * @returns {Promise<{ok:true,fileName:string,downloadUrl:string,via:'v2'|'legacy',attempts:object[]}|{ok:false,error:object}>} 结果
   */
  async uploadFile(key, region, bytes, filename, opts = {}) {
    const size = bytes && bytes.byteLength ? bytes.byteLength : 0
    const attempts = []
    const v2 = await this.uploadBinary(key, region, bytes, filename, opts)
    attempts.push({ via: 'v2', path: '/openapi/v2/media/upload/binary', ok: v2.ok, error: v2.ok ? null : v2.error })
    if (v2.ok) {
      this._log('info', '上传成功（新接口） ' + String(size) + 'B ' + String(filename), { key: maskKey(key) })
      return { ok: true, fileName: v2.fileName, downloadUrl: v2.downloadUrl, via: 'v2', attempts: lossless(attempts) }
    }
    this._log('warn', '新接口上传失败，回退旧接口：' + v2.error.message, { key: maskKey(key), code: v2.error.code })

    const legacy = await this.uploadLegacy(key, region, bytes, filename, opts.fileType, opts)
    attempts.push({ via: 'legacy', path: '/task/openapi/upload', ok: legacy.ok, error: legacy.ok ? null : legacy.error })
    if (legacy.ok) {
      this._log('info', '上传成功（旧接口兜底） ' + String(size) + 'B ' + String(filename), { key: maskKey(key) })
      return { ok: true, fileName: legacy.fileName, downloadUrl: legacy.downloadUrl, via: 'legacy', attempts: lossless(attempts) }
    }

    const sizeNote = bytesTooBig(v2.error) || bytesTooBig(legacy.error)
      ? '（新接口体积上限比旧接口严得多；两个接口都拒绝时才是这把 key 的真实限制）'
      : ''
    /** 把官方业务码写进给人看的那句话：排障时 `809` 比 `BUSINESS` 有用得多。 */
    const describeAttempt = (tag, e) =>
      tag + ' ' + e.code + (e.bizCode !== undefined ? '/官方码 ' + String(e.bizCode) : '') + '：' + clip(e.message, 160)
    return {
      ok: false,
      error: errorShape(ERR.UPLOAD_FAILED, '上传失败（' + humanSize(size) + '）：两个接口都拒绝了' + sizeNote, {
        ...(v2.error.code === legacy.error.code && [ERR.AUTH, ERR.QUOTA, ERR.RATE_LIMIT].includes(v2.error.code) ? { cause: v2.error.code } : {}),
        hint: describeAttempt('新接口', v2.error) + ' ｜ ' + describeAttempt('旧接口', legacy.error),
        attempts: lossless(attempts),
      }),
    }
  }

  /* ─────────────────────────────── 任务 ─────────────────────────────── */

  /**
   * 提交任务。`POST /task/openapi/create`
   * **本方法永不自动重试**（可能已扣费）；返回失败时区分「明确被拒」与「结果不确定」。
   * @param {string} key 明文 key
   * @param {string} region `'cn'|'overseas'` 或基址
   * @param {{workflowId:string,nodeInfoList?:object[],instanceType?:string,addMetadata?:boolean,usePersonalQueue?:boolean,workflow?:string,signal?:AbortSignal}} spec 提交参数
   * @returns {Promise<{ok:true,taskId:string,taskStatus:string,raw:any}|{ok:false,error:object}>} 结果
   */
  async createTask(key, region, spec = {}) {
    const base = this.baseUrlFor(region)
    const body = {
      apiKey: String(key || ''),
      workflowId: String(spec.workflowId || ''),
      addMetadata: spec.addMetadata !== false,
    }
    if (Array.isArray(spec.nodeInfoList) && spec.nodeInfoList.length > 0) body.nodeInfoList = spec.nodeInfoList
    // 官方 enum 只有 default|plus|ultra；`standard` 之类会被翻成 default，未知值直接拒（别把脏值发给服务端）
    const it = normalizeInstanceType(spec.instanceType)
    if (!it.ok) return it
    if (it.value !== 'default') body.instanceType = it.value
    if (spec.usePersonalQueue !== undefined) body.usePersonalQueue = String(spec.usePersonalQueue)
    if (spec.workflow !== undefined) body.workflow = String(spec.workflow)

    const r = await this._call({
      url: base + '/task/openapi/create',
      method: 'POST',
      headers: this._jsonHeaders(key, base),
      body: JSON.stringify(body),
      signal: spec.signal,
      timeoutMs: this.submitTimeoutMs,
      submit: true,
      keyMasked: maskKey(key),
    })
    if (!r.ok) return r
    const d = r.data && typeof r.data === 'object' ? r.data : {}
    const taskId = String(d.taskId || d.taskID || d.id || '')
    if (taskId === '') {
      return {
        ok: false,
        error: errorShape(ERR.TRANSPORT_UNCERTAIN, '提交响应缺少 taskId，无法确认任务是否已创建', {
          hint: '**不要自动重发**（可能已扣费）：先去 RunningHub 后台/任务列表核对，或用 workflowId 找回最近任务',
          uncertain: true,
        }),
      }
    }
    const taskStatus = normalizeStatus(d.taskStatus) || STATUS.QUEUED
    return { ok: true, taskId, taskStatus, raw: lossless(d) }
  }

  /**
   * 查任务状态。`POST /task/openapi/status`（幂等，可重试）
   * @param {string} key 明文 key
   * @param {string} region `'cn'|'overseas'` 或基址
   * @param {string} taskId 任务 ID
   * @param {{signal?:AbortSignal}} [opts] 可选
   * @returns {Promise<{ok:true,status:string,raw:any}|{ok:false,error:object}>} 结果
   */
  async queryStatus(key, region, taskId, opts = {}) {
    const base = this.baseUrlFor(region)
    const r = await this._call({
      url: base + '/task/openapi/status',
      method: 'POST',
      headers: this._jsonHeaders(key, base),
      body: JSON.stringify({ apiKey: String(key || ''), taskId: String(taskId || '') }),
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      keyMasked: maskKey(key),
    })
    if (!r.ok) return r
    // `data` 可能是字符串状态（老接口），也可能是对象（新接口/网关包装）。
    const d = r.data
    let status = ''
    if (typeof d === 'string' || typeof d === 'number') status = normalizeStatus(d)
    else if (d && typeof d === 'object') status = normalizeStatus(d.taskStatus || d.status)
    return { ok: true, status, raw: lossless(r.raw) }
  }

  /**
   * 查任务输出。`POST /task/openapi/outputs`（幂等，可重试）
   * 兼容三种形状：`data` 是数组（已完成）· `data.taskStatus` 显式状态 · `msg` 文案启发式。
   * @param {string} key 明文 key
   * @param {string} region `'cn'|'overseas'` 或基址
   * @param {string} taskId 任务 ID
   * @param {{signal?:AbortSignal}} [opts] 可选
   * @returns {Promise<{ok:true,status:string,outputs:object[],failedReason:string,raw:any}|{ok:false,error:object}>} 结果
   */
  async queryOutputs(key, region, taskId, opts = {}) {
    const base = this.baseUrlFor(region)
    const sent = await this._send({
      url: base + '/task/openapi/outputs',
      method: 'POST',
      headers: this._jsonHeaders(key, base),
      body: JSON.stringify({ apiKey: String(key || ''), taskId: String(taskId || '') }),
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      retries: this.retries,
      keyMasked: maskKey(key),
    })
    if (!sent.ok) return { ok: false, error: sent.error.toShape() }

    const j = sent.json
    const httpStatus = sent.httpStatus
    if (httpStatus < 200 || httpStatus >= 300) {
      const verdict = classifyResponse({ httpStatus, json: j, text: sent.text })
      return { ok: false, error: verdict.ok ? errorShape(ERR.BUSINESS, 'HTTP ' + String(httpStatus)) : verdict.error.toShape() }
    }
    const code = pickBizCode(j)
    const msg = pickMessage(j)
    const data = j && typeof j === 'object' ? j.data : undefined

    // ① data 直接是输出数组 → 成功
    if (Array.isArray(data)) {
      return { ok: true, status: STATUS.SUCCESS, outputs: lossless(data), failedReason: '', raw: lossless(j) }
    }
    // ② **官方业务码**（`docs/api/endpoints.json` 逐字对齐；这些全是 HTTP 200）：
    //    804 → `APIKEY_TASK_IS_RUNNING`（`data.netWssUrl` 只有运行态才给，不用 ws 就别读它）
    //    813 → `APIKEY_TASK_IS_QUEUED`（`data:null`）
    //    805 → `APIKEY_TASK_STATUS_ERROR`（`data.failedReason`）
    if (code === 804) return { ok: true, status: STATUS.RUNNING, outputs: [], failedReason: '', raw: lossless(j) }
    if (code === 813) return { ok: true, status: STATUS.QUEUED, outputs: [], failedReason: '', raw: lossless(j) }
    if (code === 805) {
      return {
        ok: true,
        status: STATUS.FAILED,
        outputs: [],
        failedReason: extractFailure(data, msg) || '任务执行失败（APIKEY_TASK_STATUS_ERROR）',
        raw: lossless(j),
      }
    }
    // ③ data 里有显式 taskStatus（部分网关会包一层）
    if (data && typeof data === 'object') {
      const explicit = normalizeStatus(data.taskStatus || data.status)
      const outputs = Array.isArray(data.outputs) ? data.outputs : Array.isArray(data.results) ? data.results : []
      if (explicit !== '') {
        const failedReason = explicit === STATUS.FAILED || explicit === STATUS.ERROR ? extractFailure(data, msg) : ''
        return { ok: true, status: explicit, outputs: lossless(outputs), failedReason, raw: lossless(j) }
      }
      if (outputs.length > 0) {
        return { ok: true, status: STATUS.SUCCESS, outputs: lossless(outputs), failedReason: '', raw: lossless(j) }
      }
    }
    // ④ code 缺失（v2 族）→ 读顶层 `status`，结果可能在顶层 `results` 或 `data.results`
    if (code === null) {
      const st = normalizeStatus(j.status || (data && typeof data === 'object' ? data.status : ''))
      if (st !== '') {
        const topResults = Array.isArray(j.results) ? j.results : Array.isArray(j.outputs) ? j.outputs : null
        const outputs =
          topResults ||
          (data && typeof data === 'object'
            ? Array.isArray(data.results)
              ? data.results
              : Array.isArray(data.outputs)
                ? data.outputs
                : []
            : [])
        const failedReason =
          st === STATUS.FAILED || st === STATUS.ERROR ? extractFailure(data, msg || asString(j.errorMessage)) : ''
        return { ok: true, status: st, outputs: lossless(outputs), failedReason, raw: lossless(j) }
      }
      return {
        ok: false,
        error: errorShape(ERR.BUSINESS, '查询输出响应既没有 code 也没有 status', { httpStatus, body: clip(JSON.stringify(j), 200) }),
      }
    }
    // ⑤ code=0 但 data 为空 → 还没产出，继续等
    if (code === 0) {
      return { ok: true, status: STATUS.RUNNING, outputs: [], failedReason: '', raw: lossless(j) }
    }
    // ⑥ 其余业务失败：key/额度类要让上层换 key；剩下的当业务错误返回
    const k = classifyBusiness(code, msg)
    if (k === ERR.AUTH || k === ERR.QUOTA || k === ERR.RATE_LIMIT) {
      return {
        ok: false,
        error: new RhError(k, msg || '业务错误 code=' + String(code), {
          httpStatus,
          bizCode: code === null ? undefined : code,
        }).toShape(),
      }
    }
    if (/FAIL|STATUS_ERROR/i.test(msg)) {
      return { ok: true, status: STATUS.FAILED, outputs: [], failedReason: extractFailure(data, msg), raw: lossless(j) }
    }
    return {
      ok: false,
      error: errorShape(k, msg || '查询输出失败 code=' + String(code), { httpStatus, bizCode: code === null ? undefined : code }),
    }
  }

  /**
   * v2 查询。`POST /openapi/v2/query`（Bearer，`{taskId}`）
   *
   * 官方 schema 里这个端点**没有 `code`**，返回 `taskId/status/errorCode/errorMessage/results/...`，
   * 成败读 `status`（enum：`QUEUED|RUNNING|SUCCESS|FAILED`，**没有 `CREATE`**）；
   * `results[].{url,outputType,text}`（`text` 是文本输出，没有 url）。
   * @param {string} key 明文 key
   * @param {string} region `'cn'|'overseas'` 或基址
   * @param {string} taskId 任务 ID
   * @param {{signal?:AbortSignal}} [opts] 可选
   * @returns {Promise<{ok:true,status:string,results:object[],failedReason:string,errorCode:number,raw:any}|{ok:false,error:object}>} 结果
   */
  async queryV2(key, region, taskId, opts = {}) {
    const base = this.baseUrlFor(region)
    const r = await this._call({
      url: base + '/openapi/v2/query',
      method: 'POST',
      headers: this._jsonHeaders(key, base),
      body: JSON.stringify({ taskId: String(taskId || '') }),
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      keyMasked: maskKey(key),
    })
    if (!r.ok) return r
    const d = r.data && typeof r.data === 'object' ? r.data : {}
    const status = normalizeStatus(d.status || d.taskStatus)
    const errorCode = toNumber(d.errorCode, 0)
    const results = Array.isArray(d.results) ? d.results : Array.isArray(d.outputs) ? d.outputs : []
    const failedReason =
      normalizeStatus(status) === STATUS.FAILED || normalizeStatus(status) === STATUS.ERROR || errorCode !== 0
        ? extractFailure(d, String(d.errorMessage || d.msg || ''))
        : ''
    return { ok: true, status, results: lossless(results), failedReason, errorCode, raw: lossless(r.raw) }
  }

  /**
   * 取消任务。`POST /task/openapi/cancel`
   * @param {string} key 明文 key
   * @param {string} region `'cn'|'overseas'` 或基址
   * @param {string} taskId 任务 ID
   * @param {{signal?:AbortSignal}} [opts] 可选
   * @returns {Promise<{ok:true,raw:any}|{ok:false,error:object}>} 结果
   */
  async cancelTask(key, region, taskId, opts = {}) {
    const base = this.baseUrlFor(region)
    const r = await this._call({
      url: base + '/task/openapi/cancel',
      method: 'POST',
      headers: this._jsonHeaders(key, base),
      body: JSON.stringify({ apiKey: String(key || ''), taskId: String(taskId || '') }),
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      keyMasked: maskKey(key),
    })
    if (!r.ok) return r
    return { ok: true, raw: lossless(r.raw) }
  }

  /**
   * 价格预览。`POST /openapi/v2/price-preview/<modelPath>`
   *
   * 官方用法（apiId 454850620，原文）：「将 `/**` 替换为对应的模型 API 路由即可，
   * **使用和发起任务相同的参数**。例如 `/openapi/v2/rhart-image-g/image-to-image`
   * → 调用 `/openapi/v2/price-preview/rhart-image-g/image-to-image`」。
   *
   * 成功判定读 **`errorCode`**（这一族响应里**没有 `code`**）：`0` 即成功。
   * 字段：`estimatedPrice / currency / priceText / priceTextEn / freeLimit / freeLimitCount /
   * remainingFreeLimitCount / isFreeThisCall`。
   *
   * ⚠️ **绝不抛，也绝不阻断主流程**：报价只是"跑之前先知道要花多少钱"的辅助信息。
   * 拿不到价就返回 `NOT_AVAILABLE`（Lead 的 `workflow.price` 会渲染成「价格未知，仍可运行」）。
   * 只有 **`AUTH`/`QUOTA`** 原样保留 —— 那两个是用户必须去处理 key 的情况，
   * 折叠成"价格未知"会把真问题藏起来。
   *
   * @param {string} key 明文 key
   * @param {string} region `'cn'|'overseas'` 或基址
   * @param {{modelPath:string, payload?:object, signal?:AbortSignal}} spec `modelPath` 是模型路由（可带前导斜杠）
   * @returns {Promise<{ok:true,estimatedPrice:number,currency:string,priceText:string,priceTextEn:string,freeLimit:boolean,freeLimitCount:number|null,remainingFreeLimitCount:number|null,isFreeThisCall:boolean,raw:any}|{ok:false,error:object}>} 结果
   */
  async pricePreview(key, region, spec = {}) {
    const rawPath = asString(spec && spec.modelPath).trim().replace(/^\/+/, '')
    if (rawPath === '') {
      return {
        ok: false,
        error: errorShape(ERR.NOT_AVAILABLE, 'pricePreview 需要 modelPath（模型 API 路由）', {
          hint: '形如 "rhart-image-g/image-to-image"；官方模板：/openapi/v2/price-preview/<模型路由>',
        }),
      }
    }
    const base = this.baseUrlFor(region)
    const payload = spec && typeof spec.payload === 'object' && spec.payload !== null ? spec.payload : {}
    const r = await this._call({
      url: base + '/openapi/v2/price-preview/' + rawPath,
      method: 'POST',
      headers: this._jsonHeaders(key, base),
      body: JSON.stringify(payload),
      signal: spec.signal,
      timeoutMs: spec.timeoutMs,
      keyMasked: maskKey(key),
    })
    if (!r.ok) {
      // AUTH / QUOTA 是用户必须处理的；其余一律折叠成"报价拿不到"
      const code = asString(r.error && r.error.code)
      if (code === ERR.AUTH || code === ERR.QUOTA) return r
      return {
        ok: false,
        error: errorShape(ERR.NOT_AVAILABLE, '拿不到价格：' + asString(r.error && r.error.message), {
          hint: '报价失败不影响运行；换个模型路径或直接跑（工作流本身仍会按官方计费）',
          cause: code,
          bizCode: r.error && r.error.bizCode,
        }),
      }
    }
    const d = r.data && typeof r.data === 'object' ? r.data : r.raw && typeof r.raw === 'object' ? r.raw : {}
    const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
    return {
      ok: true,
      estimatedPrice: toNumber(d.estimatedPrice, 0),
      currency: asString(d.currency),
      priceText: asString(d.priceText),
      priceTextEn: asString(d.priceTextEn),
      freeLimit: d.freeLimit === true,
      freeLimitCount: numOrNull(d.freeLimitCount),
      remainingFreeLimitCount: numOrNull(d.remainingFreeLimitCount),
      isFreeThisCall: d.isFreeThisCall === true,
      raw: lossless(d),
    }
  }

  /**
   * 队列/并发状态。**`GET /openapi/v2/queue/status`**（注意是 GET，不是 POST）+ Bearer。
   *
   * 官方字段：`data.apiKeyType`（`EXCLUSIVE` 独占 / `SHARED` 共享 / `NORMAL` 消费级）·
   * `data.concurrentLimit`（integer）· `data.runningCount` / `queuedCount` / `totalCurrentTasks`
   * （schema 里是 **string**，这里统一转成 number 方便直接用；原值在 `raw` 里）。
   *
   * 比 `accountStatus.currentTaskCounts` 信息量足得多，正好补 DESIGN §7.8「并发额度要提前告知」。
   * @param {string} key 明文 key
   * @param {string} region `'cn'|'overseas'` 或基址
   * @param {{signal?:AbortSignal}} [opts] 可选
   * @returns {Promise<{ok:true,apiKeyType:string,concurrentLimit:number,runningCount:number,queuedCount:number,totalCurrentTasks:number,raw:any}|{ok:false,error:object}>} 结果
   */
  async queueStatus(key, region, opts = {}) {
    const base = this.baseUrlFor(region)
    const r = await this._call({
      url: base + '/openapi/v2/queue/status',
      method: 'GET',
      headers: this._jsonHeaders(key, base),
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      keyMasked: maskKey(key),
    })
    if (!r.ok) return r
    const d = r.data && typeof r.data === 'object' ? r.data : {}
    return {
      ok: true,
      apiKeyType: asString(d.apiKeyType),
      concurrentLimit: toNumber(d.concurrentLimit, 0),
      runningCount: toNumber(d.runningCount, 0),
      queuedCount: toNumber(d.queuedCount, 0),
      totalCurrentTasks: toNumber(d.totalCurrentTasks, 0),
      raw: lossless(d),
    }
  }

  /**
   * 列出该账号下的 API Key（官方**已脱敏**，形如 `46eb********06340`）。
   *
   * `GET /openapi/v2/api-key/list`（GET）+ Bearer；`data[].{key,apiKeyName,status,quotaLimit,quotaUsed,visible,expireAt,expireInMinute,createdAt}`。
   * 用途：多 Key 额度面板。**返回值再过一遍 `maskKey()`** —— 官方虽然脱敏了，
   * 但我们这条链路的硬边界是"绝不让任何看起来像 key 的串进回执"，不赌上游。
   * @param {string} key 明文 key
   * @param {string} region `'cn'|'overseas'` 或基址
   * @param {{signal?:AbortSignal}} [opts] 可选
   * @returns {Promise<{ok:true,keys:object[]}|{ok:false,error:object}>} 结果
   */
  async listApiKeys(key, region, opts = {}) {
    const base = this.baseUrlFor(region)
    const r = await this._call({
      url: base + '/openapi/v2/api-key/list',
      method: 'GET',
      headers: this._jsonHeaders(key, base),
      signal: opts.signal,
      timeoutMs: opts.timeoutMs,
      keyMasked: maskKey(key),
    })
    if (!r.ok) return r
    const arr = Array.isArray(r.data) ? r.data : Array.isArray(r.raw && r.raw.data) ? r.raw.data : []
    const keys = arr.map((k) =>
      lossless({
        // 官方已经脱敏成 `46eb********06340`；再 maskKey 一次会把它压成 `46eb****6340`（反而更差）。
        // 判据：真实 key 不含 `*`，所以「带 `*` 就原样留着，不带才掩」——两种情况都不会泄漏明文。
        key: (() => {
          const raw = asString(k && k.key)
          return raw.includes('*') ? raw : maskKey(raw)
        })(),
        apiKeyName: asString(k && k.apiKeyName),
        status: toNumber(k && k.status, 0),
        quotaLimit: k && k.quotaLimit !== undefined && k.quotaLimit !== null ? k.quotaLimit : null,
        quotaUsed: toNumber(k && k.quotaUsed, 0),
        visible: !!(k && k.visible),
        expireAt: k && k.expireAt !== undefined && k.expireAt !== null ? k.expireAt : null,
        expireInMinute: k && k.expireInMinute !== undefined && k.expireInMinute !== null ? k.expireInMinute : null,
        createdAt: asString(k && k.createdAt),
      }),
    )
    return { ok: true, keys }
  }

  /* ─────────────────────────────── 下载 ─────────────────────────────── */

  /**
   * 流式下载结果文件，带字节上限（**本方法返回二进制，不是 lossless JSON**；只给 runner 落盘用）。
   * @param {string} url 结果 URL
   * @param {{maxBytes?:number,headers?:object,signal?:AbortSignal,timeoutMs?:number}} [opts] 可选
   * @returns {Promise<{ok:true,bytes:Uint8Array,size:number,contentType:string,truncated:boolean}|{ok:false,error:object}>} 结果
   */
  async downloadBytes(url, opts = {}) {
    const authorization = opts.headers && (opts.headers.Authorization || opts.headers.authorization)
    const redact = createRedactor(typeof authorization === 'string' ? [authorization.replace(/^Bearer\s+/i, '')] : [], { byName: false })
    const maxBytes = Math.max(1, toNumber(opts.maxBytes, MAX_DOWNLOAD_BYTES))
    const timeoutMs = Math.max(1000, toNumber(opts.timeoutMs, 120000))
    const ac = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ac.abort()
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    const onOuterAbort = () => ac.abort()
    if (opts.signal) {
      if (opts.signal.aborted) {
        clearTimeout(timer)
        return { ok: false, error: errorShape(ERR.ABORTED, '调用方已取消下载') }
      }
      try {
        opts.signal.addEventListener('abort', onOuterAbort, { once: true })
      } catch {
        /* 忽略 */
      }
    }
    try {
      const res = await this.fetchImpl(String(url), {
        method: 'GET',
        headers: { 'User-Agent': USER_AGENT, ...(opts.headers || {}) },
        signal: ac.signal,
      })
      const httpStatus = toNumber(res && res.status, 0)
      if (httpStatus < 200 || httpStatus >= 300) {
        return {
          ok: false,
          error: errorShape(classifyHttp(httpStatus), '下载结果文件失败：HTTP ' + String(httpStatus), {
            hint: 'RH 侧结果文件会过期（跨天复用要重跑），也可能是链接已失效',
            httpStatus,
          }),
        }
      }
      const contentType = String((res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '')
      const body = res.body
      if (body && typeof body.getReader === 'function') {
        const reader = body.getReader()
        const chunks = []
        let total = 0
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          total += value.byteLength
          if (total > maxBytes) {
            try {
              await reader.cancel()
            } catch {
              /* 忽略 */
            }
            return {
              ok: false,
              error: errorShape(ERR.BAD_REQUEST, '下载超过上限 ' + humanSize(maxBytes) + '，已拒绝', {
                hint: '调大 maxBytes 或改走 URL 直传（不要把大文件读进内存）',
              }),
            }
          }
          chunks.push(value)
        }
        return { ok: true, bytes: concatBytes(chunks), size: total, contentType, truncated: false }
      }
      const buf = new Uint8Array(await res.arrayBuffer())
      if (buf.byteLength > maxBytes) {
        return { ok: false, error: errorShape(ERR.BAD_REQUEST, '下载超过上限 ' + humanSize(maxBytes) + '，已拒绝') }
      }
      return { ok: true, bytes: buf, size: buf.byteLength, contentType, truncated: false }
    } catch (e) {
      if (opts.signal && opts.signal.aborted) return { ok: false, error: errorShape(ERR.ABORTED, '调用方已取消下载') }
      const name = e && e.name
      return {
        ok: false,
        error: errorShape(
          name === 'AbortError' || name === 'TimeoutError' || timedOut ? ERR.TRANSPORT_UNCERTAIN : ERR.BUSINESS,
          '下载失败：' + redact(String((e && e.message) || e)),
          { hint: '结果文件会过期，可直接重试一次；仍失败就重跑工作流' },
        ),
      }
    } finally {
      clearTimeout(timer)
      if (opts.signal && typeof opts.signal.removeEventListener === 'function') opts.signal.removeEventListener('abort', onOuterAbort)
    }
  }
}

/* ───────────────────────────── 内部小工具（不进契约） ───────────────────────────── */

/** 宽松 JSON 解析：失败返回 null（HTML 错误页不会炸）。 @param {string} text 文本 @returns {any|null} 解析结果 */
export function parseJsonLoose(text) {
  const s = String(text == null ? '' : text).trim()
  if (s === '') return null
  if (!s.startsWith('{') && !s.startsWith('[')) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * 从失败对象里提取可读原因。
 *
 * `failedReason` 的官方字段（`docs/api/endpoints.json` 里 `/task/openapi/outputs` 的示例字面值）：
 * `current_outputs` / `exception_type` / `node_name` / `current_inputs` / `traceback` / `node_id` /
 * `exception_message`。这里挑对用户最有用的三样：异常信息、异常类型、出错节点；
 * traceback 只留最后一行（够定位，又不至于把回执灌爆）。
 * @param {any} data 响应 data
 * @param {string} fallback 兜底文案
 * @returns {string} 可读原因
 */
export function extractFailure(data, fallback) {
  const fr = data && typeof data === 'object' ? data.failedReason || data.failed_reason : null
  const fb = typeof fallback === 'string' ? fallback : ''
  if (fr && typeof fr === 'object') {
    const em = String(fr.exception_message || fr.message || '')
    const et = String(fr.exception_type || '')
    const node = String(fr.node_name || fr.nodeName || '')
    const nodeId = fr.node_id !== undefined && fr.node_id !== null ? String(fr.node_id) : ''
    const parts = []
    if (em) parts.push(em)
    if (et && !em.includes(et)) parts.push('(' + et + ')')
    if (node) parts.push('[node:' + node + (nodeId && nodeId !== node ? '#' + nodeId : '') + ']')
    const tb = String(fr.traceback || '')
    if (tb) {
      const lines = tb.split('\n').filter((l) => l.trim() !== '')
      const last = lines.length > 0 ? lines[lines.length - 1] : ''
      if (last && !em.includes(last)) parts.push('| ' + clip(last, 160))
    }
    if (parts.length > 0) return parts.join(' ')
    try {
      return JSON.stringify(fr)
    } catch {
      return fb
    }
  }
  if (typeof fr === 'string' && fr.trim() !== '') return fr.trim()
  return fb
}

/** URL → path（日志用，避免把 query 里的敏感串打出来）。 @param {string} url URL @returns {string} path */
function pathOf(url) {
  try {
    const u = new URL(String(url))
    return u.pathname
  } catch {
    return clip(url, 60)
  }
}

/** 是否网络类异常（fetch reject 的 TypeError / ECONN*）。 @param {any} e 异常 @returns {boolean} 是网络错误为 true */
function isNetworkError(e) {
  if (!e) return false
  if (e.name === 'TypeError') return true
  const code = e.code || (e.cause && e.cause.code)
  return typeof code === 'string' && /^(ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR)/.test(code)
}

/** 上传错误里是否提示体积超限。 @param {any} err 错误对象 @returns {boolean} 体积超限为 true */
function bytesTooBig(err) {
  if (!err) return false
  const s = (String(err.message || '') + ' ' + String(err.hint || '')).toLowerCase()
  return err.bizCode === 809 || s.includes('809') || s.includes('size') || s.includes('too large') || s.includes('过大') || s.includes('上限')
}

/** 人类可读体积。 @param {number} n 字节数 @returns {string} 形如 `1.4 MB` */
export function humanSize(n) {
  const b = toNumber(n, 0)
  if (b < 1024) return String(b) + ' B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB'
  return (b / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}

/** 合并多个 Uint8Array。 @param {Uint8Array[]} chunks 分片 @returns {Uint8Array} 合并结果 */
export function concatBytes(chunks) {
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/** UTF-8 解码（优先 TextDecoder，退回 Buffer）。 @param {Uint8Array} bytes 字节 @returns {string} 文本 */
function decodeUtf8(bytes) {
  if (typeof TextDecoder === 'function') return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  return Buffer.from(bytes).toString('utf8')
}

/** 结果码 → 是否「结果不确定」（提交类失败时用来决定要不要让用户核对）。 @param {any} errorShapeOrCode 错误对象或错误码 @returns {boolean} 不确定为 true */
export function isUncertain(errorShapeOrCode) {
  const o = errorShapeOrCode && typeof errorShapeOrCode === 'object' ? errorShapeOrCode : { code: errorShapeOrCode }
  return o.uncertain === true || o.code === ERR.TRANSPORT_UNCERTAIN
}

/** 便捷工厂（语义等价于 `new RunningHubApi(opts)`）。 @param {object} [opts] 同构造器 @returns {RunningHubApi} 客户端 */
export function createApi(opts) {
  return new RunningHubApi(opts)
}

export { maskKey }
