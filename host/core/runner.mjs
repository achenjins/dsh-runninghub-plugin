/**
 * `host/core/runner.mjs` —— 后台任务：提交 / 轮询 / 下载 / 落盘 / 通知
 *
 * 契约（**Lead 已锁定**）：
 *   - `new TaskRunner({api, keys, store, download, attach, onEvent, logger})`
 *   - `submit({workflowConfig, values, region, images})` → **立即返回** `{ok, taskId, jobId, status:'QUEUED'}`
 *   - `wait(taskId, timeoutMs)` → `{ok, task, results:[{kind,url?,localPath?,attachment?}]}`（**不取消任务**）
 *   - `cancel(taskId)` / `resume()` / `list()` / `get(taskId)` / `stop()`
 *   - **核心层不认识 DSH**：要通知外部就调注入的 `onEvent(event, payload)`；
 *     要变成聊天附件就调注入的 `attach({taskId, kind, bytes, url, filename, path})`。
 *
 * ⚠️ **两个可选注入的精确语义（很容易被误读成别的形状）**：
 *   - `download(spec)` —— **是「下载 + 落盘 + 附件」的整体接管，不是 URL 下载器**。
 *     `spec = {taskId, url, filename, kind, index}`；返回 `{ok, path?, bytes?:number, attachment?}`。
 *     **不注入**（推荐）就走内置路径：`api.downloadBytes(url)` → `store.writeOutput(taskId, filename, bytes)` → `attach(...)`。
 *     千万别写成 `(url, opts) => api.downloadBytes(url, opts)` —— spec 是对象，会被当 URL 解析并抛
 *     `Failed to parse URL from [object Object]`。
 *   - `attach(spec)` —— 返回**附件对象本身**（`ImageAttachmentRef` / `FileAttachmentRef`）或 `undefined`，
 *     **不要**返回 `{ok, attachment}`（那会变成两层嵌套，render 出来的 image block 不合法）。
 *     拆包由注入方做：`const r = await save(...); return r.ok ? r.attachment : undefined`。
 *
 * 排雷语义（DESIGN §5.3 / §7）：
 *   - **提交阶段 TRANSPORT_UNCERTAIN** → 任务进 `UNCERTAIN` 状态，**绝不重投**，等用户核对。
 *   - **查询阶段 uncertain** → 继续轮询（查询是幂等的，不值得把任务判死）。
 *   - `tasks/<taskId>.json` 是唯一真相 → 插件重启后 `resume()` 能把没跑完的轮询接上。
 *   - 轮询退避 3s → 5s → 10s，上限 15s；`unref()` 的定时器，不会拖住 Node 退出。
 *
 * @module dsh-runninghub-plugin/host/core/runner
 */

import fsSync from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'

import { asString, toNumber, nowMs, lossless, errorShape, clip, shortId, maskKey } from './util.mjs'
import { STATUS, normalizeStatus, isTerminal } from './api.mjs'
import { buildNodeInfoList, validateRun } from './workflow.mjs'

/** 轮询退避阶梯（毫秒），最后一级封顶。 */
export const POLL_BACKOFF = [3000, 5000, 10000]
/** 退避上限。 */
export const POLL_MAX_MS = 15000
/** 单个任务的最长轮询时间（默认 30 分钟）。 */
export const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000
/** 一次 `wait()` 的默认上限。 */
export const DEFAULT_WAIT_MS = 60 * 1000
/** 收口时下载全部结果的**总预算**（慢 CDN 不能让终态写盘无限期拖住）。 */
export const DEFAULT_DOWNLOAD_MS = 60 * 1000

/**
 * 取路径里的文件名（**跨平台**：Windows 的 `E:\a\b.png` 在 POSIX 上 `path.basename` 会整串返回）。
 * @param {string} p 路径
 * @returns {string} 文件名（取不到时回落到 `upload.bin`）
 */
export function basenameOf(p) {
  const s = asString(p)
  const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  const base = cut >= 0 ? s.slice(cut + 1) : s
  return base !== '' ? base : 'upload.bin'
}
/** 连续多少次"查不到可用状态"后给一次可见提示（只提示，不放弃）。 */
export const STALL_WARN_AFTER = 6

/** `fileType`/kind → 扩展名（文件名缺扩展名时补齐，别落一堆叫 `9` 的文件）。 */
export const EXT_OF_TYPE = {
  png: 'png',
  jpg: 'jpg',
  jpeg: 'jpg',
  webp: 'webp',
  gif: 'gif',
  bmp: 'bmp',
  tiff: 'tiff',
  mp4: 'mp4',
  mov: 'mov',
  webm: 'webm',
  avi: 'avi',
  mkv: 'mkv',
  mp3: 'mp3',
  wav: 'wav',
  flac: 'flac',
  m4a: 'm4a',
  ogg: 'ogg',
  glb: 'glb',
  gltf: 'gltf',
  obj: 'obj',
  fbx: 'fbx',
  stl: 'stl',
  txt: 'txt',
  json: 'json',
  image: 'png',
  video: 'mp4',
  audio: 'wav',
  text: 'txt',
}

/** 终态。 */
export const FINAL_STATUSES = [STATUS.SUCCESS, STATUS.FAILED, STATUS.CANCEL, STATUS.ERROR, STATUS.UNCERTAIN]

/**
 * 轮询退避：第 n 次轮询用多少毫秒。
 *
 * ⚠️ `POLL_MAX_MS`（15s）是**退避增长的上限**，不是"配置值的上限"。
 * 早先写成 `Math.min(POLL_MAX_MS, initial * scale)`，于是用户把 `pollIntervalMs`
 * 配成 60s 时，实际间隔反而被**压到 15s** —— "逐步增加"变成了"逐步降低"。
 * 现在把配置值当**下限**，退避阶梯只在它之上往上长。
 *
 * @param {number} attempt 已轮询次数（从 0 开始）
 * @param {number} [initialMs] 配置的起始间隔
 * @returns {number} 毫秒
 */
export function pollDelay(attempt, initialMs = POLL_BACKOFF[0]) {
  const i = Math.max(0, Math.floor(toNumber(attempt, 0)))
  const initial = Math.max(1, toNumber(initialMs, POLL_BACKOFF[0]))
  const scale = i < POLL_BACKOFF.length ? POLL_BACKOFF[i] / POLL_BACKOFF[0] : 5 * 2 ** Math.min(i - 3, 20)
  return Math.max(initial, Math.min(POLL_MAX_MS, Math.round(initial * scale)))
}

/**
 * 从输出项里猜文件类型。
 *
 * **显式 `fileType` 字段优先于 URL 扩展名**：RH 的「隐写载图」（社区叫小黄鸭：视频/音频藏在 PNG 里）
 * 正是 `fileType=mp4` 而 URL 以 `.png` 结尾。这时按声明类型走，并打上 `steganography:true`，
 * **不假装它是普通图片**（DESIGN 排雷 §7.7）。
 *
 * @param {unknown} item 输出项（字符串 URL / `{fileUrl,fileType,url,fileName}`）
 * @param {string} [fallbackKind] 工作流的 outputKind
 * @returns {{url:string,kind:string,filename:string,declaredType:string,steganography?:boolean,note?:string}} 结果
 */
export function describeOutput(item, fallbackKind = 'image') {
  let url = ''
  let rawType = ''
  let filename = ''
  let nodeId = ''
  if (typeof item === 'string') {
    url = item
  } else if (item && typeof item === 'object') {
    url = asString(item.fileUrl || item.file_url || item.url || item.download_url || item.downloadUrl)
    rawType = asString(item.fileType || item.file_type || item.outputType)
    // `nodeId` **不是**文件名（RH 的旧族输出项里它只是产出节点的 id）
    filename = asString(item.fileName || item.filename || item.file_name)
    nodeId = item.nodeId !== undefined && item.nodeId !== null ? asString(item.nodeId) : ''
  }
  const urlText = (url + ' ' + filename).toLowerCase()
  if (filename === '') {
    const base = url.split('?')[0].split('/').pop() || ''
    filename = base !== '' ? base : 'output-' + shortId()
  }  /** 从一段文本里认类型（既认扩展名，也认裸的类型 token 如 `png`/`mp4`）。 @param {string} s 文本 @returns {string} 类型或 `''` */
  const kindOfText = (s) => {
    if (!s) return ''
    if (/\.(mp4|mov|webm|avi|mkv)\b/.test(s) || s.includes('video') || /\b(mp4|mov|webm|avi|mkv)\b/.test(s)) return 'video'
    if (/\.(mp3|wav|flac|m4a|ogg)\b/.test(s) || s.includes('audio') || /\b(mp3|wav|flac|m4a|ogg)\b/.test(s)) return 'audio'
    if (/\.(glb|gltf|obj|fbx|stl)\b/.test(s) || s.includes('3d') || /\b(glb|gltf|obj|fbx|stl)\b/.test(s)) return '3d'
    if (/\.(txt|json|md|csv)\b/.test(s) || /\b(txt|json|md|csv|text)\b/.test(s)) return 'text'
    if (/\.(png|jpe?g|webp|gif|bmp|tiff?)\b/.test(s) || s.includes('image') || /\b(png|jpe?g|webp|gif|bmp|tiff?)\b/.test(s)) return 'image'
    return ''
  }
  const declared = kindOfText(rawType.toLowerCase())
  const byUrl = kindOfText(urlText)
  const fb = ['image', 'video', 'audio', '3d', 'text'].includes(asString(fallbackKind)) ? asString(fallbackKind) : 'image'
  const kind = declared || byUrl || fb
  // 文件名缺扩展名时用声明的类型补上：`store.writeOutput()` 会拿它当落盘文件名，
  // 一堆没有扩展名的文件（如 `9`）既不能双击打开，也让下游按扩展名判类型失效。
  if (!/\.[0-9a-z]{1,5}$/i.test(filename)) {
    const ext = EXT_OF_TYPE[rawType.toLowerCase()] || EXT_OF_TYPE[kind] || ''
    if (ext) filename = filename + '.' + ext
  }
  const out = { url, kind, filename, declaredType: rawType }
  if (nodeId !== '') out.nodeId = nodeId
  if (declared && byUrl && declared !== byUrl) {
    out.steganography = true
    out.note =
      'RH 声明的类型是 ' +
      declared +
      '，但文件名/链接看起来是 ' +
      byUrl +
      '：这很可能是「隐写载图」（视频/音频藏在 PNG 里）。原图已保留，可用支持提取的工具（如 RHStudio2）取出真实内容。'
  }
  return out
}

/**
 * 把任务记录投影成给模型/UI 看的 lossless JSON（**不含明文 key**）。
 * @param {object} task 任务记录
 * @returns {object} 投影
 */
export function projectTask(task) {
  const t = task && typeof task === 'object' ? task : {}
  return lossless({
    taskId: asString(t.taskId),
    jobId: asString(t.jobId),
    workflowName: asString(t.workflowName),
    workflowId: asString(t.workflowId),
    region: asString(t.region),
    keyMasked: asString(t.keyMasked),
    status: normalizeStatus(t.status) || STATUS.QUEUED,
    instanceType: asString(t.instanceType),
    createdAt: toNumber(t.createdAt, 0),
    updatedAt: toNumber(t.updatedAt, 0),
    finishedAt: toNumber(t.finishedAt, 0),
    pollCount: toNumber(t.pollCount, 0),
    nodeInfoCount: Array.isArray(t.nodeInfoList) ? t.nodeInfoList.length : 0,
    promptPreview: clip(asString(t.promptPreview), 120),
    outputs: Array.isArray(t.outputs) ? t.outputs : [],
    results: Array.isArray(t.results) ? t.results : [],
    failedReason: asString(t.failedReason),
    errorCode: asString(t.errorCode),
    errorMessage: asString(t.errorMessage),
    queryFailures: toNumber(t.queryFailures, 0),
    lastQueryError: asString(t.lastQueryError),
    uncertain: t.uncertain === true,
    hint: asString(t.hint),
  })
}

/* ══════════════════════════════ TaskRunner ══════════════════════════════ */

/**
 * 后台任务执行器。构造后即可 `submit()`；轮询在内部定时器上跑，`stop()` 收尾。
 */
export class TaskRunner {
  /**
   * @param {object} deps 依赖（全部由 Lead 注入）
   * @param {object} deps.api `RunningHubApi`
   * @param {object} deps.keys `KeyPool`
   * @param {object} deps.store `Store`
   * @param {(spec:{taskId:string,url:string,filename:string,kind:string}) => Promise<{ok:boolean,bytes?:Uint8Array,path?:string,error?:object}>} [deps.download] 下载器（默认用 `api.downloadBytes` + `store.writeOutput`）
   * @param {(spec:{taskId:string,kind:string,bytes?:Uint8Array,url:string,filename:string,path?:string}) => Promise<any>} [deps.attach] 变成聊天附件（DSH 侧实现）
   * @param {(event:string, payload:object) => void} [deps.onEvent] 事件回调（`task.submitted` / `task.progress` / `task.done` / `task.failed` / `task.uncertain`）
   * @param {object} [deps.logger] 日志器
   * @param {()=>number} [deps.now] 注入时钟（测试用）
   * @param {(ms:number)=>Promise<void>} [deps.sleep] 注入等待（测试用）
   * @param {number} [deps.taskTimeoutMs] 单任务轮询上限
   * @param {number} [deps.maxWaitMs] `wait()` 的硬上限
   */
  constructor(deps = {}) {
    this.api = deps.api
    this.keys = deps.keys
    this.store = deps.store
    this.download = typeof deps.download === 'function' ? deps.download : null
    this.attach = typeof deps.attach === 'function' ? deps.attach : null
    this.onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : null
    this.logger = deps.logger || null
    this.now = typeof deps.now === 'function' ? deps.now : nowMs
    this.sleepImpl = typeof deps.sleep === 'function' ? deps.sleep : null
    this.taskTimeoutMs = Math.max(1000, toNumber(deps.taskTimeoutMs, DEFAULT_TASK_TIMEOUT_MS))
    this.maxWaitMs = Math.max(1000, toNumber(deps.maxWaitMs, 30 * 60 * 1000))
    /** 收口时下载全部结果的总预算（默认 60s）。 */
    this.downloadTimeoutMs = Math.max(1000, toNumber(deps.downloadTimeoutMs, DEFAULT_DOWNLOAD_MS))
    /**
     * 文件系统访问（`{existsSync, readFile}`）。默认走 `node:fs`；**单测注入假实现**即可
     * 不碰真实磁盘地验证"本地路径 → 上传"这条链。
     */
    this.fs = deps.fs && typeof deps.fs.existsSync === 'function' && typeof deps.fs.readFile === 'function'
      ? deps.fs
      : { existsSync: (p) => fsSync.existsSync(p), readFile: (p) => fsPromises.readFile(p) }
    /** 第一次轮询前等多久（默认 3s；单测注入小值即可秒级跑完）。 */
    this.firstPollDelayMs = Math.max(0, toNumber(deps.firstPollDelayMs, POLL_BACKOFF[0]))
    this.pollIntervalMs = Math.max(1, toNumber(deps.pollIntervalMs, POLL_BACKOFF[0]))
    /** @type {Map<string, {task:object, stopped:boolean}>} 在跑的任务 */
    this._live = new Map()
    this._taskLocks = new Map()
    this._stopped = false
  }

  /** 安全日志（**只输出掩码**）。 @param {'info'|'warn'|'error'} level 级别 @param {string} msg 消息 @param {object} [meta] 附加 @returns {void} */
  _log(level, msg, meta) {
    const fn = this.logger && (this.logger[level] || this.logger.log)
    if (typeof fn !== 'function') return
    try {
      fn.call(this.logger, '[rh-runner] ' + msg, meta ? lossless(meta) : '')
    } catch {
      /* 忽略 */
    }
  }

  /** 发事件（失败不影响主流程）。 @param {string} event 事件名 @param {object} payload 载荷 @returns {void} */
  _emit(event, payload) {
    if (!this.onEvent) return
    try {
      this.onEvent(event, lossless(payload))
    } catch (e) {
      this._log('warn', 'onEvent(' + event + ') 抛异常：' + String((e && e.message) || e))
    }
  }

  /** 当前时间。 @returns {number} epoch ms */
  nowMs() {
    const v = toNumber(this.now(), 0)
    return v > 0 ? v : nowMs()
  }

  /** 等待（可注入）。 @param {number} ms 毫秒 @returns {Promise<void>} */
  _sleep(ms) {
    if (this.sleepImpl) return this.sleepImpl(Math.max(0, ms))
    return new Promise((r) => {
      const t = setTimeout(r, Math.max(0, ms))
      if (t && typeof t.unref === 'function') t.unref()
    })
  }

  /* ────────────────────────────── 读写流水 ────────────────────────────── */

  /** 读任务流水（找不到 / 读失败 → `undefined`，**不抛**）。 @param {string} taskId 任务 id @returns {Promise<object|undefined>} 任务 */
  async get(taskId) {
    if (!this.store || typeof this.store.getTask !== 'function') return undefined
    try {
      const t = await this.store.getTask(taskId)
      return t && typeof t === 'object' ? t : undefined
    } catch (e) {
      this._log('warn', '读任务流水失败：' + String((e && e.message) || e))
      return undefined
    }
  }

  /**
   * 写任务流水（**不抛**：注入的 store 自己抛异常也只记 warn）。
   * `tasks/<taskId>.json` 是唯一真相，所以这里绝不能因为一次落盘抖动把调用方带崩。
   * @param {object} task 任务
   * @returns {Promise<boolean>} 是否写成功
   */
  async _save(task) {
    if (!this.store || typeof this.store.saveTask !== 'function') return false
    try {
      const r = await this.store.saveTask({ ...task, updatedAt: this.nowMs() }, { backup: false })
      if (!r || r.ok !== true) this._log('warn', '写任务流水失败：' + asString(r && r.error && r.error.message))
      return !!(r && r.ok)
    } catch (e) {
      this._log('warn', '写任务流水抛异常：' + String((e && e.message) || e))
      return false
    }
  }

  /** 列任务投影（给 `task.list` 用）。 @param {{status?:string, limit?:number}} [opts] 过滤 @returns {Promise<object[]>} 投影数组 */
  async list(opts = {}) {
    if (!this.store || typeof this.store.listTasks !== 'function') return []
    let tasks = []
    try {
      tasks = await this.store.listTasks({ status: opts.status, limit: opts.limit })
    } catch (e) {
      this._log('warn', '列任务流水失败：' + String((e && e.message) || e))
      return []
    }
    return tasks.map(projectTask)
  }

  /* ────────────────────── 参考素材：本地路径 → 上传 ────────────────────── */

  /**
   * 判断一个 `images` 值**是不是本地文件路径**（而不是"已经是 RH 文件名"）。
   *
   * 存在的文件需要上传；缺失的显式本地路径由 `_resolveImages` 报错。
   * `openapi/a.png` 等服务端文件名可以直接使用。
   * @param {string} value 原始值
   * @returns {boolean} 需要上传为 true
   */
  _isLocalPath(value) {
    const v = asString(value)
    if (v === '') return false
    try {
      return this.fs.existsSync(v) === true
    } catch {
      return false
    }
  }

  /**
   * 把 `values.images` 里的**本地路径**逐个上传成 RH 文件名，其余原样放行。
   *
   * **必须用与 create 同一把 key、同一个 region**：换 key 上传会让文件落在另一把 key 的
   * 上下文里，create 时就找不到它 —— 所以这一步只能在 `keys.pick()` 之后做。
   *
   * 失败语义：**如实失败，绝不把本地路径透传出去**。透传的后果是 RunningHub 在 3 秒后回一句
   * `[node:LoadImage#420] ["image - Invalid image file: E:\..."]` —— 用户完全看不懂，
   * 而且以为"插件会上传"。宁可在本地就说清"第 2 个素材（节点 420）上传失败"。
   * @param {string} key 明文 key（与 create 同一把）
   * @param {string} region 地域
   * @param {object} values 运行参数（会被浅拷贝后替换 `images`）
   * @param {object} cfg 工作流配置（用来按节点 role 定 `fileType`）
   * @returns {Promise<{ok:true,values:object,uploads:object[]}|{ok:false,error:object}>} 结果
   */
  async _resolveImages(key, region, values, cfg) {
    const nodes = Array.isArray(cfg && cfg.nodes) ? cfg.nodes : []
    const media = nodes.filter((n) => n && ['image', 'audio', 'video'].includes(n.role))

    // ── 素材集合 = 「调用方显式传的 images」 ∪ 「媒体角色节点的生效值（含配置默认值）」 ──
    //
    // ⚠️ 这里**不能**用 `media.length` 当开关。早先的写法是
    //     `media.length ? <只取 media 节点的值> : values.images`，
    //     于是配置里只要有**一个**媒体节点，调用方传给**其它节点**的条目就被整个丢掉 ——
    //     那些条目**既不进上传、也不进存在性检查**，但 buildNodeInfoList 仍会从原始
    //     `values.images` 取到它们，结果**本地绝对路径原样发给 RunningHub**：
    //     正是这一层要根除的 `Invalid image file: E:\...`（旧代码全量上传，属回退）。
    //
    // 用**并集**：显式传入的条目一律参与上传与存在性检查；媒体节点上的配置默认值也照旧参与
    //（那是"配置里写死了本地素材"的场景）。两者按 `(nodeId, fieldName)` 规范化后合并，
    // 所以同一个素材**不会**被上传两次。
    const explicit = values && typeof values.images === 'object' && values.images !== null ? values.images : {}
    // 复用 buildNodeInfoList 的键解析（`resolveTarget`）把调用方给的键（`420` / `420:image` / 角色名…）
    // 规范成 (nodeId, fieldName)，不自己重写一套。
    const explicitTargets = new Set(
      Object.keys(explicit).length > 0
        ? buildNodeInfoList(cfg, { images: explicit }).map((item) => item.nodeId + '\u0000' + item.fieldName)
        : [],
    )
    const isMediaNode = (item) => media.some((n) => String(n.nodeId) === item.nodeId && n.fieldName === item.fieldName)
    const images = Object.fromEntries(
      buildNodeInfoList(cfg, values, { includeDefaults: true })
        .filter((item) => explicitTargets.has(item.nodeId + '\u0000' + item.fieldName) || isMediaNode(item))
        .map((item) => [item.nodeId + ':' + item.fieldName, item.fieldValue]),
    )

    const entries = Object.entries(images).filter(([, v]) => v !== undefined && v !== null && asString(v) !== '')
    if (entries.length === 0) return { ok: true, values, uploads: [] }
    for (const [nodeRef, raw] of entries) {
      const value = asString(raw)
      const local = path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || /^(\.\.?[\\/]|file:)/.test(value)
      if (local && !this._isLocalPath(value)) {
        return { ok: false, error: errorShape('MATERIAL_NOT_FOUND', '参考素材不存在或无法访问：' + value, { nodeId: nodeRef.split(':')[0], hint: '检查本地路径；已上传的素材请使用 RunningHub 返回的文件名。' }) }
      }
    }
    if (!this.api || typeof this.api.uploadFile !== 'function') {
      // 没有上传能力时**不能**把路径透传：那正是线上那个看不懂的远端报错
      const hasPath = entries.some(([, v]) => this._isLocalPath(v))
      if (hasPath) {
        return {
          ok: false,
          error: errorShape('UPLOAD_FAILED', '参考素材是本地路径，但当前 api 不支持上传', {
            hint: '请在配置里改用 RunningHub 侧已有的文件名，或升级插件',
          }),
        }
      }
      return { ok: true, values, uploads: [] }
    }

    /** 按节点 role 决定 `fileType`（旧上传接口要它）。 @param {string} nodeId 节点 id @returns {string} `image|audio|video` */
    const fileTypeOf = (nodeId) => {
      const n = nodes.find((x) => x && String(x.nodeId) === String(nodeId))
      const role = asString(n && n.role)
      if (role === 'video') return 'video'
      if (role === 'audio') return 'audio'
      return 'image'
    }

    const next = { ...images }
    const uploads = []
    for (let i = 0; i < entries.length; i++) {
      const [nodeRef, raw] = entries[i]
      const nodeId = nodeRef.split(':')[0]
      const value = asString(raw)
      if (!this._isLocalPath(value)) {
        // 已经是 RH 文件名 → **原样放行**（老调用方靠这条活着，别弄坏）
        uploads.push({ nodeId, action: 'passthrough', fileName: value })
        continue
      }
      let bytes
      try {
        bytes = await this.fs.readFile(value)
      } catch (e) {
        return {
          ok: false,
          error: errorShape('UPLOAD_FAILED', '第 ' + String(i + 1) + '/' + String(entries.length) + ' 个素材读不到：' + value, {
            hint: '节点 ' + nodeId + ' · ' + String((e && e.message) || e) + '（该文件存在性检查通过但读取失败，可能是权限或文件被占用）',
          }),
        }
      }
      const filename = basenameOf(value)
      const up = await this.api.uploadFile(key, region, bytes, filename, { fileType: fileTypeOf(nodeId) })
      if (!up || up.ok !== true) {
        const err = (up && up.error) || errorShape('UPLOAD_FAILED', '上传失败')
        return {
          ok: false,
          error: errorShape('UPLOAD_FAILED', '第 ' + String(i + 1) + '/' + String(entries.length) + ' 个素材上传失败（节点 ' + nodeId + '：' + filename + '）', {
            // `uploadFile` 已经把 v2 / legacy 两边的真实错误都带在 hint 里了，原样传出
            hint: asString(err.hint) || asString(err.message),
            nodeId: String(nodeId),
            index: i + 1,
            total: entries.length,
            cause: asString(err.cause || err.code),
            attempts: err.attempts,
          }),
        }
      }
      next[nodeRef] = up.fileName
      uploads.push({ nodeId, action: 'uploaded', fileName: asString(up.fileName), bytes: bytes.length, via: asString(up.via), fileType: fileTypeOf(nodeId) })
      this._log('info', '素材已上传 node ' + nodeId + ' → ' + asString(up.fileName) + '（' + String(bytes.length) + 'B · via ' + asString(up.via) + '）')
    }
    return { ok: true, values: { ...values, images: next }, uploads }
  }

  /* ────────────────────────────── 提交 ────────────────────────────── */

  /**
   * 组装提交参数（纯函数，便于单测与 `task.status` 复用）。
   * @param {object} req `submit` 的入参
   * @returns {{ok:true, region:string, nodeInfoList:object[], instanceType:string, workflowId:string}|{ok:false,error:object}} 结果
   */
  _prepare(req) {
    const cfg = req && req.workflowConfig
    if (!cfg || typeof cfg !== 'object') {
      return { ok: false, error: errorShape('WORKFLOW_NOT_FOUND', 'submit 需要 workflowConfig') }
    }
    const workflowId = asString(cfg.rhWorkflowId)
    if (workflowId === '') {
      return {
        ok: false,
        error: errorShape('WORKFLOW_NOT_FOUND', '工作流配置缺少 rhWorkflowId', {
          hint: '先用 workflow.probe 取回节点提案，再 workflow.configure 落盘',
        }),
      }
    }
    const region = asString(req.region) || asString(cfg.region) || 'cn'
    // 图片：允许 images 直接给 RH 文件名；也可以给 {nodeId: value} 语义
    const values = { ...(req.values && typeof req.values === 'object' ? req.values : {}) }
    if (req.images && typeof req.images === 'object') {
      values.images = { ...(values.images || {}), ...req.images }
    }
    const nodeInfoList = buildNodeInfoList(cfg, values)
    const instanceType = asString(req.instanceType) || asString(cfg.instanceType) || 'default'
    return { ok: true, region, nodeInfoList, instanceType, workflowId, values }
  }

  /**
   * 提交任务并**立即返回**。轮询在后台定时器上进行。
   *
   * @param {{workflowConfig:object, values?:object, region?:string, images?:object, instanceType?:string, validated?:boolean}} req 提交请求
   * @returns {Promise<{ok:true,taskId:string,jobId:string,status:string,region:string,instanceType:string,nodeInfoCount:number,keyMasked:string}|{ok:false,error:object}>} 结果
   */
  async submit(req = {}) {
    if (this._stopped) return { ok: false, error: errorShape('STOPPED', '插件已停止，无法提交新任务') }
    const prep = this._prepare(req)
    if (!prep.ok) return prep
    const cfg = req.workflowConfig
    const { region, instanceType, workflowId } = prep

    // ① 选 key —— **只在本 region 池里选，绝不跨池回退**
    if (!this.keys || typeof this.keys.pick !== 'function') {
      return { ok: false, error: errorShape('NO_KEY', 'TaskRunner 没有注入 keys') }
    }
    // ② 干跑校验（必填 / 枚举 / 范围）；只在没显式说 validated 时跑
    if (req.validated !== true) {
      const chk = validateRun({ ...cfg, region }, prep.values)
      if (!chk.ok) {
        return {
          ok: false,
          error: errorShape('NODE_MISSING', '运行前校验没过：' + chk.issues.map((i) => i.message).join('；'), {
            hint: '用 workflow.validate 看完整问题清单',
            issues: chk.issues,
          }),
        }
      }
    }

    const attempted = []
    let lastFailure = null
    let picked, submitted, nodeInfoList
    for (;;) {
      picked = this.keys.pick({ region, exclude: attempted })
      if (!picked || picked.ok !== true) {
        return lastFailure || { ok: false, error: (picked && picked.error) || errorShape('NO_KEY', 'region=' + region + ' 没有可用 key') }
      }
      attempted.push(picked.id)
      // 只对明确拒绝的认证/额度/限流错误换 Key；未知提交结果必须立即停止。
      const resolved = await this._resolveImages(picked.key, region, prep.values, cfg)
      if (!resolved.ok) {
        const cause = asString(resolved.error && (resolved.error.cause || resolved.error.code))
        if (['AUTH', 'QUOTA', 'RATE_LIMIT'].includes(cause)) {
          this.keys.report(picked.id, cause)
          lastFailure = resolved
          continue
        }
        return resolved
      }
      nodeInfoList = buildNodeInfoList(cfg, resolved.values, { includeDefaults: true })
      submitted = await this.api.createTask(picked.key, region, { workflowId, nodeInfoList, instanceType, addMetadata: true })
      if (submitted && submitted.ok === true) break
      lastFailure = await this._handleSubmitFailure(picked, submitted, cfg, region, nodeInfoList, instanceType, workflowId)
      const err = lastFailure.error || {}
      if (err.uncertain || !['AUTH', 'QUOTA', 'RATE_LIMIT'].includes(err.code)) return lastFailure
    }

    const taskId = asString(submitted.taskId)
    const jobId = shortId('rhjob')
    const at = this.nowMs()
    const task = {
      taskId,
      jobId,
      workflowId,
      workflowName: asString(cfg.name) || asString(cfg.displayNameEn) || workflowId,
      workflowConfigId: asString(cfg.id),
      outputKind: asString(cfg.outputKind) || 'image',
      output: req.output && typeof req.output === 'object' ? { ...req.output } : null,
      region,
      keyId: picked.id,
      keyMasked: picked.maskedKey || maskKey(picked.key),
      instanceType,
      status: normalizeStatus(submitted.taskStatus) || STATUS.QUEUED,
      createdAt: at,
      trackingStartedAt: at,
      updatedAt: at,
      finishedAt: 0,
      pollCount: 0,
      nodeInfoList: lossless(nodeInfoList),
      promptPreview: clip(asString(prep.values.prompt), 200),
      outputs: [],
      results: [],
      failedReason: '',
      uncertain: false,
    }
    this.keys.report(picked.id, 'ok')
    await this._save(task)
    this._log('info', '提交成功 taskId=' + taskId + ' region=' + region + ' ' + asString(task.keyMasked))
    this._emit('task.submitted', { taskId, jobId, status: task.status, workflowName: task.workflowName, region })
    this._startPolling(task)
    return {
      ok: true,
      taskId,
      jobId,
      status: task.status,
      region,
      instanceType,
      nodeInfoCount: nodeInfoList.length,
      keyMasked: asString(task.keyMasked),
    }
  }

  /**
   * 提交失败的统一处理：区分「明确被拒（换 key 有意义）」与「结果不确定（绝不重投）」。
   * @param {object} picked `keys.pick()` 的结果
   * @param {any} submitted `api.createTask` 的结果
   * @param {object} cfg 工作流配置
   * @param {string} region 地域
   * @param {object[]} nodeInfoList 参数
   * @param {string} instanceType 机型
   * @param {string} workflowId 工作流 id
   * @returns {Promise<{ok:false,error:object}>} 失败回执
   */
  async _handleSubmitFailure(picked, submitted, cfg, region, nodeInfoList, instanceType, workflowId) {
    const err = (submitted && submitted.error) || errorShape('BUSINESS', '提交失败')
    const code = asString(err.code)

    // 结果不确定：任务可能已经建好并扣费 → **不重投**，落一条 UNCERTAIN 流水等用户核对
    if (code === 'TRANSPORT_UNCERTAIN' || err.uncertain === true) {
      const taskId = 'uncertain-' + shortId()
      const at = this.nowMs()
      const task = {
        taskId,
        jobId: shortId('rhjob'),
        workflowId,
        workflowName: asString(cfg.name) || workflowId,
        region,
        keyId: picked.id,
        keyMasked: picked.maskedKey || maskKey(picked.key),
        instanceType,
        status: STATUS.UNCERTAIN,
        createdAt: at,
        updatedAt: at,
        finishedAt: at,
        pollCount: 0,
        nodeInfoList: lossless(nodeInfoList),
        outputs: [],
        results: [],
        failedReason: asString(err.message),
        errorCode: code,
        errorMessage: asString(err.message),
        uncertain: true,
        hint: '提交阶段连接中断/超时：**任务可能已经创建并扣费，绝不自动重发**。请到 RunningHub 后台按工作流核对最近任务，确认没有后再重跑。',
      }
      this.keys.report(picked.id, 'TRANSPORT')
      await this._save(task)
      this._log('warn', '提交结果不确定，已记 UNCERTAIN：' + asString(err.message))
      this._emit('task.uncertain', { taskId, workflowId, message: asString(err.message) })
      return { ok: false, error: errorShape('TRANSPORT_UNCERTAIN', asString(err.message), { hint: task.hint, uncertain: true, localTaskId: taskId }) }
    }

    // 明确被拒：按分类回报，方便上层换 key 重试
    const outcome = code === 'AUTH' ? 'AUTH' : code === 'QUOTA' ? 'QUOTA' : code === 'RATE_LIMIT' ? 'RATE_LIMIT' : null
    if (outcome) this.keys.report(picked.id, outcome)
    return { ok: false, error: err }
  }

  /* ────────────────────────────── 轮询 ────────────────────────────── */

  /**
   * 启动后台轮询（幂等）。
   *
   * 用**可注入的 `_sleep`** 而不是裸 `setTimeout`：单测把 sleep 换快之后整条链路秒级跑完，
   * 生产里 `_sleep` 的定时器已经 `unref()`，不会拖住 Node 退出。
   * @param {object} task 任务记录
   * @returns {void}
   */
  _startPolling(task) {
    const taskId = asString(task.taskId)
    if (taskId === '' || this._stopped) return
    const existing = this._live.get(taskId)
    if (existing && !existing.stopped) return
    const entry = { task: { ...task }, stopped: false }
    if (task.output && this.store && typeof this.store.setTaskOutput === 'function') this.store.setTaskOutput(taskId, task.output)
    this._live.set(taskId, entry)
    this._pollChain(taskId, this.firstPollDelayMs)
  }

  /**
   * 排下一次轮询。
   *
   * **必须带 `.catch`**：`void promise.then(...)` 一旦 `_tick` 抛异常（落盘抖动、注入的 download 抛、
   * 任何没被内层 try 兜住的错），整条轮询链会**静默死掉** —— 任务永远停在 RUNNING，
   * `wait()` 只能等到超时，而且日志里什么都没有。这类"链子断了却没人知道"是最难查的。
   * 现在：崩了就记 error 日志 + 退避后重来（查询是幂等的），连续崩 5 次才收口成 ERROR。
   * @param {string} taskId 任务 id
   * @param {number} delayMs 延迟
   * @returns {void}
   */
  _pollChain(taskId, delayMs) {
    void this._sleep(Math.max(0, toNumber(delayMs, 0)))
      .then(() => this._tick(taskId))
      .catch((e) => this._onPollCrash(taskId, e))
  }

  /**
   * 轮询链异常的处理（**不让链子死掉**）。
   * @param {string} taskId 任务 id
   * @param {any} e 异常
   * @returns {void}
   */
  _onPollCrash(taskId, e) {
    const entry = this._live.get(taskId)
    const msg = String((e && e.message) || e)
    this._log('error', '轮询链异常 taskId=' + taskId + '（任务仍在 RH 侧跑）：' + clip(String((e && e.stack) || msg), 300))
    if (!entry || entry.stopped || this._stopped) return
    entry.crashes = toNumber(entry.crashes, 0) + 1
    if (entry.crashes > 5) {
      void this._finish(taskId, {
        status: STATUS.ERROR,
        errorCode: 'POLL_CRASH',
        errorMessage: '轮询连续异常 5 次，已停止：' + msg,
        hint: '任务在 RH 侧可能已完成：用 task.status 单查，或重开插件后 resume() 继续轮询',
      })
      return
    }
    this._pollChain(taskId, pollDelay(entry.crashes, this.pollIntervalMs))
  }

  /**
   * 一次轮询：查状态 → 终态则收口。
   * @param {string} taskId 任务 id
   * @returns {Promise<void>}
   */
  async _tick(taskId) {
    return this._withTaskLock(taskId, () => this._tickNow(taskId))
  }

  _withTaskLock(taskId, fn) {
    const previous = this._taskLocks.get(taskId) || Promise.resolve()
    const next = previous.then(fn, fn)
    const tail = next.then(() => undefined, () => undefined)
    this._taskLocks.set(taskId, tail)
    void tail.then(() => {
      if (this._taskLocks.get(taskId) === tail) this._taskLocks.delete(taskId)
    })
    return next
  }

  async _tickNow(taskId) {
    const entry = this._live.get(taskId)
    if (!entry || entry.stopped || this._stopped) return
    const task = entry.task
    const region = asString(task.region) || 'cn'
    const key = this._keyFor(task)
    if (key === '') {
      // key 被判失效/删掉了：不能跨池借，直接判 ERROR 并说清原因
      await this._finish(taskId, {
        status: STATUS.ERROR,
        errorCode: 'NO_KEY',
        errorMessage: '轮询时该任务所属 region 已没有可用的 key',
        hint: '恢复一把 region=' + region + ' 的 key 后用 task.status 继续查（任务本身仍在 RunningHub 侧跑）',
      })
      return
    }

    task.pollCount = toNumber(task.pollCount, 0) + 1
    const ageMs = this.nowMs() - toNumber(task.trackingStartedAt || task.createdAt, 0)
    if (ageMs > this.taskTimeoutMs) {
      await this._finish(taskId, {
        status: STATUS.ERROR,
        errorCode: 'TIMEOUT',
        errorMessage: '超过 ' + String(Math.round(this.taskTimeoutMs / 1000)) + 's 仍未到终态，已停止轮询',
        hint: '任务在 RH 侧可能还在跑：task.status 可以继续单次查询；不要再提交一次（会重复扣费）',
      })
      return
    }

    const q = await this._queryOnce(key, region, taskId)
    if (entry.stopped || this._stopped) return
    this._applyQuery(task, q)

    // **终态不先落盘**：先把结果下完再写一次流水。
    // 否则 `wait()` 会看到「status=SUCCESS 但 results 还是空」的中间态（竞态）。
    if (FINAL_STATUSES.includes(normalizeStatus(task.status))) {
      this._emit('task.progress', { taskId, status: task.status, pollCount: task.pollCount })
      await this._settle(taskId, task)
      return
    }
    await this._save(task)
    this._emit('task.progress', { taskId, status: task.status, pollCount: task.pollCount })
    // 没到终态 → 按退避阶梯继续（仍然走可注入的 sleep；带 catch，链子不会静默断）
    this._pollChain(taskId, pollDelay(task.pollCount, this.pollIntervalMs))
  }

  /**
   * 取任务所属 key 的明文（**只在本 region 池里找**；找不到返回 `''`）。
   * @param {object} task 任务
   * @returns {string} 明文 key 或 `''`
   */
  _keyFor(task) {
    if (!this.keys || typeof this.keys.rawKey !== 'function') return ''
    const direct = this.keys.rawKey(asString(task.keyId))
    const available = typeof this.keys.isAvailable !== 'function' || this.keys.isAvailable(asString(task.keyId))
    const current = typeof this.keys.list === 'function' ? this.keys.list().find((entry) => entry.id === task.keyId) : null
    const sameRegion = !current || current.region === (asString(task.region) || 'cn')
    if (available && sameRegion && typeof direct === 'string' && direct !== '') return direct
    // 原 key 被删了：退而在同 region 里挑一把（仍然不跨池）
    if (typeof this.keys.pick === 'function') {
      const p = this.keys.pick({ region: asString(task.region) || 'cn' })
      if (p && p.ok === true) {
        task.keyId = p.id
        task.keyMasked = p.maskedKey || maskKey(p.key)
        return p.key
      }
    }
    return ''
  }

  /**
   * 查一次任务（`outputs` 优先，失败退回 `/openapi/v2/query`）。
   * **查询阶段的不确定不是错误**：继续轮询即可（查询幂等）。
   * @param {string} key 明文 key
   * @param {string} region 地域
   * @param {string} taskId 任务 id
   * @returns {Promise<object>} 归一化的查询结果
   */
  async _queryOnce(key, region, taskId) {
    const canOutputs = this.api && typeof this.api.queryOutputs === 'function'
    if (canOutputs) {
      const r = await this.api.queryOutputs(key, region, taskId)
      if (r && r.ok === true) {
        return { ok: true, status: normalizeStatus(r.status), outputs: Array.isArray(r.outputs) ? r.outputs : [], failedReason: asString(r.failedReason), via: 'outputs' }
      }
      const code = asString(r && r.error && r.error.code)
      if (code === 'AUTH' || code === 'QUOTA') return { ok: false, code, message: asString(r.error.message) }
      // 其余（含 TRANSPORT_UNCERTAIN / SERVER）继续走 v2 兜底
      if (this.api && typeof this.api.queryV2 === 'function') {
        const v2 = await this.api.queryV2(key, region, taskId)
        if (v2 && v2.ok === true) return { ok: true, status: normalizeStatus(v2.status), outputs: Array.isArray(v2.results) ? v2.results : [], failedReason: asString(v2.failedReason), via: 'v2' }
        return { ok: false, code: asString(v2 && v2.error && v2.error.code), message: asString(v2 && v2.error && v2.error.message) }
      }
      return { ok: false, code, message: asString(r.error.message) }
    }
    const v2 = await this.api.queryV2(key, region, taskId)
    if (v2 && v2.ok === true) return { ok: true, status: normalizeStatus(v2.status), outputs: Array.isArray(v2.results) ? v2.results : [], failedReason: asString(v2.failedReason), via: 'v2' }
    return { ok: false, code: asString(v2 && v2.error && v2.error.code), message: asString(v2 && v2.error && v2.error.message) }
  }

  /**
   * 把查询结果写回任务对象（**查询阶段不确定 = 保持原状态继续轮询**）。
   * @param {object} task 任务
   * @param {object} q 查询结果
   * @returns {void}
   */
  _applyQuery(task, q) {
    if (!q || q.ok !== true) {
      const code = asString(q && q.code)
      if (code === 'AUTH') {
        this.keys.report(asString(task.keyId), 'AUTH')
        task.lastQueryError = 'AUTH'
        return // 下次 _keyFor 会换一把同 region 的 key
      }
      if (code === 'QUOTA') {
        this.keys.report(asString(task.keyId), 'QUOTA')
        task.lastQueryError = 'QUOTA'
        return
      }
      // TRANSPORT_UNCERTAIN / SERVER：查询幂等 → **继续轮询**
      task.lastQueryError = code || 'UNKNOWN'
      task.queryFailures = toNumber(task.queryFailures, 0) + 1
      this._warnIfStalled(task)
      return
    }
    const st = normalizeStatus(q.status)
    if (st === '') {
      // **查得到响应、但拿不到可用状态**（典型：`/openapi/v2/query` 对旧族 taskId 返回空 status）。
      // 这不能算"查询成功" —— 否则 queryFailures 永远是 0，这个指标就变成摆设
      // （rh-docs task-5 的 C14b 抓到的正是这一点）。
      task.queryFailures = toNumber(task.queryFailures, 0) + 1
      task.lastQueryError = q.via ? 'EMPTY_STATUS:' + asString(q.via) : 'EMPTY_STATUS'
      this._warnIfStalled(task)
      return
    }
    task.queryFailures = 0
    task.lastQueryError = ''
    task.status = st
    if (Array.isArray(q.outputs) && q.outputs.length > 0) task.outputs = lossless(q.outputs)
    if (asString(q.failedReason) !== '') task.failedReason = asString(q.failedReason)
    task.queryVia = asString(q.via)
  }

  /**
   * 连续查不到可用状态时给用户一条可见的提示（**只提示，不放弃**）。
   *
   * 真正决定"什么时候不再轮询"的是 `_tick` 的墙钟上限 `taskTimeoutMs`；
   * 这里做的是"别让用户对着一个永远不动的 RUNNING 干等却不知道为什么"。
   * @param {object} task 任务
   * @returns {void}
   */
  _warnIfStalled(task) {
    const n = toNumber(task.queryFailures, 0)
    if (n !== STALL_WARN_AFTER) return // 只在刚跨过阈值那一次提示
    this._log(
      'warn',
      '任务 ' + asString(task.taskId) + ' 连续 ' + String(n) + ' 次查询都拿不到可用状态（最后错误：' + asString(task.lastQueryError) + '），仍在轮询直到超时',
    )
    task.hint =
      '连续 ' + String(n) + ' 次查询都没有返回可用状态（最后：' + asString(task.lastQueryError) + '）。' +
      '任务在 RunningHub 侧可能仍在跑：可以继续等，或去后台按工作流核对。'
    this._emit('task.stalled', {
      taskId: asString(task.taskId),
      queryFailures: n,
      lastQueryError: asString(task.lastQueryError),
      status: normalizeStatus(task.status),
    })
  }

  /**
   * 收口：终态后下载结果并通知外部。**只在全部收尾完成后才把终态写进流水**，
   * 这样 `tasks/<taskId>.json` 里看到 SUCCESS 时 `results` 一定已经就绪。
   * @param {string} taskId 任务 id
   * @param {object} [memTask] 内存里最新的任务（比流水更新）
   * @returns {Promise<void>}
   */
  async _settle(taskId, memTask) {
    const entry = this._live.get(taskId)
    if (entry) entry.stopped = true
    this._live.delete(taskId)
    const stored = await this.get(taskId)
    const task = { ...(stored || {}), ...(memTask || entry?.task || {}), taskId }
    if (asString(task.taskId) === '') return

    // 归一化后再比：状态可能来自手改/旧版/外部写入（`'success'`、`'Success'`…），
    // 用裸 `===` 会让"已经是成功"的任务跳过收口（下载结果），于是一直卡在那儿。
    if (normalizeStatus(task.status) === STATUS.SUCCESS) {
      const results = await this._collect(task)
      task.results = results
      task.finishedAt = this.nowMs()
      await this._save(task)
      this._log('info', '任务完成 taskId=' + taskId + '，结果 ' + String(results.length) + ' 个')
      this._emit('task.done', { taskId, jobId: task.jobId, status: task.status, results, workflowName: task.workflowName })
      return
    }
    task.finishedAt = this.nowMs()
    await this._save(task)
    this._log('warn', '任务终态 ' + asString(task.status) + ' taskId=' + taskId + '：' + clip(asString(task.failedReason), 160))
    this._emit('task.failed', {
      taskId,
      jobId: task.jobId,
      status: task.status,
      failedReason: asString(task.failedReason),
      workflowName: task.workflowName,
    })
  }

  /**
   * 下载全部输出，落到 `<dataDir>/outputs/<taskId>/`，并逐个调 `attach()`。
   *
   * **有总预算**（`downloadTimeoutMs`，默认 60s）：结果 URL 挂在慢 CDN 上时，
   * 不能让一次下载把终态写盘无限期拖住 —— 那会导致 `wait()` 明明任务已完成却一直超时。
   * 预算用尽后剩余条目照实记 `error`，然后**照常收口**（不是把整条任务判死）。
   * @param {object} task 任务
   * @returns {Promise<object[]>} `[{kind,url,filename,localPath,attachment?}]`
   */
  async _collect(task) {
    const taskId = asString(task.taskId)
    if (task.output && this.store && typeof this.store.setTaskOutput === 'function') this.store.setTaskOutput(taskId, task.output)
    const kindHint = asString(task.outputKind) || 'image'
    const items = Array.isArray(task.outputs) ? task.outputs : []
    const results = []
    const deadline = this.nowMs() + Math.max(1000, toNumber(this.downloadTimeoutMs, DEFAULT_DOWNLOAD_MS))
    let index = 0
    for (const item of items) {
      index += 1
      const info = describeOutput(item, kindHint)
      const textOut = item && typeof item === 'object' ? asString(item.text) : ''
      if (info.url === '') {
        // 官方 v2 schema：`results[].{url,outputType,text}` —— 文本类结果只有 `text` 没有 `url`。
        if (textOut !== '') {
          results.push(lossless({ kind: 'text', url: '', filename: info.filename, text: textOut }))
          continue
        }
        results.push(lossless({ kind: info.kind, url: '', filename: info.filename, error: '输出项里没有 URL（可能是隐写载图，见 DESIGN 排雷 §7）' }))
        continue
      }
      const left = deadline - this.nowMs()
      if (left <= 500) {
        // 预算用尽：**不再尝试**，但要留一条可读的结果（否则用户以为"任务成功却没结果"）
        results.push(lossless({ kind: info.kind, url: info.url, filename: info.filename, error: '下载超时预算已用尽，未下载；可从此 URL 手动下载。' }))
        continue
      }
      const dl = await this._downloadOne({ taskId, ...info, index, timeoutMs: Math.min(left, 120000) })
      const rec = { kind: info.kind, url: info.url, filename: info.filename }
      if (info.steganography) Object.assign(rec, { steganography: true, note: info.note })
      if (dl.ok) {
        rec.localPath = asString(dl.path)
        rec.bytes = toNumber(dl.bytes, 0)
        if (dl.attachment !== undefined && dl.attachment !== null) rec.attachment = lossless(dl.attachment)
      } else {
        rec.error = asString(dl.error && dl.error.message) || '下载失败'
        rec.errorCode = asString(dl.error && dl.error.code)
      }
      results.push(lossless(rec))
    }
    return results
  }

  /**
   * 下载单个输出（先走注入的 `download`，否则 `api.downloadBytes` + `store.writeOutput`）。
   * @param {{taskId:string,url:string,filename:string,kind:string,index:number,timeoutMs?:number}} spec 规格
   * @returns {Promise<{ok:boolean,path?:string,bytes?:number,attachment?:any,error?:object}>} 结果
   */
  async _downloadOne(spec) {
    try {
      if (this.download) {
        const r = await this.download(spec)
        if (r && r.ok === true) return { ok: true, path: asString(r.path), bytes: toNumber(r.bytes, 0), attachment: r.attachment }
        return { ok: false, error: (r && r.error) || errorShape('TASK_FAILED', '下载失败') }
      }
      if (!this.api || typeof this.api.downloadBytes !== 'function') {
        return { ok: false, error: errorShape('NOT_IMPLEMENTED', '没有注入 download，且 api.downloadBytes 不可用') }
      }
      // 把预算透给 HTTP 层：`downloadBytes` 默认 120s，慢 CDN 会把收口拖到 `wait()` 超时。
      const dl = await this.api.downloadBytes(spec.url, spec.timeoutMs ? { timeoutMs: spec.timeoutMs } : undefined)
      if (!dl || dl.ok !== true) return { ok: false, error: dl && dl.error ? dl.error : errorShape('TASK_FAILED', '下载失败') }
      let localPath = ''
      if (this.store && typeof this.store.writeOutput === 'function') {
        const w = await this.store.writeOutput(spec.taskId, spec.filename, dl.bytes)
        if (!w || w.ok !== true) return { ok: false, error: (w && w.error) || errorShape('STORE_WRITE_FAILED', '结果文件保存失败') }
        localPath = asString(w.path)
      }
      let attachment
      if (this.attach) {
        attachment = await this.attach({
          taskId: spec.taskId,
          kind: spec.kind,
          bytes: dl.bytes,
          url: spec.url,
          filename: spec.filename,
          path: localPath,
        })
      }
      return { ok: true, path: localPath, bytes: dl.bytes ? dl.bytes.byteLength : 0, attachment }
    } catch (e) {
      return { ok: false, error: errorShape('TASK_FAILED', '下载异常：' + String((e && e.message) || e)) }
    }
  }

  /**
   * 收口一个任务并写状态。
   * @param {string} taskId 任务 id
   * @param {object} patch 要合并进流水的字段
   * @returns {Promise<void>}
   */
  async _finish(taskId, patch) {
    const entry = this._live.get(taskId)
    if (entry) {
      entry.stopped = true
    }
    this._live.delete(taskId)
    const task = (await this.get(taskId)) || (entry && entry.task) || { taskId }
    Object.assign(task, patch, { taskId, finishedAt: this.nowMs() })
    await this._save(task)
    this._emit('task.failed', { taskId, status: asString(task.status), failedReason: asString(task.errorMessage), hint: asString(task.hint) })
  }

  /* ────────────────────────────── 对外查询 ────────────────────────────── */

  /**
   * 等到终态（**不取消任务**）。超时返回当前投影 + `timedOut:true`。
   * @param {string} taskId 任务 id
   * @param {number} [timeoutMs] 本次等待上限（默认 60s，硬上限 `maxWaitMs`）
   * @returns {Promise<{ok:true,task:object,results:object[],timedOut:boolean}|{ok:false,error:object,task?:object}>} 结果
   */
  async wait(taskId, timeoutMs) {
    const id = asString(taskId)
    if (id === '') return { ok: false, error: errorShape('BAD_REQUEST', 'wait 需要 taskId') }
    let task = await this.get(id)
    if (!task) return { ok: false, error: errorShape('TASK_NOT_FOUND', '本地没有这个任务的流水：' + id, { hint: '用 task.list 看本地任务' }) }

    const budget = Math.min(Math.max(1000, toNumber(timeoutMs, DEFAULT_WAIT_MS)), this.maxWaitMs)
    const deadline = this.nowMs() + budget
    while (!FINAL_STATUSES.includes(normalizeStatus(task.status))) {
      const left = deadline - this.nowMs()
      if (left <= 0) {
        return { ok: true, task: projectTask(task), results: Array.isArray(task.results) ? task.results : [], timedOut: true }
      }
      await this._sleep(Math.min(1000, Math.max(50, left)))
      const fresh = await this.get(id)
      if (!fresh) break
      task = fresh
    }
    const status = normalizeStatus(task.status)
    if (status === STATUS.SUCCESS) {
      return { ok: true, task: projectTask(task), results: Array.isArray(task.results) ? task.results : [], timedOut: false }
    }
    return {
      ok: false,
      task: projectTask(task),
      error: errorShape(
        status === STATUS.UNCERTAIN ? 'TRANSPORT_UNCERTAIN' : 'TASK_FAILED',
        asString(task.failedReason) || asString(task.errorMessage) || ('任务终态：' + status),
        { hint: asString(task.hint), status },
      ),
    }
  }

  /**
   * 查任务（本地流水；可选向 RH 侧单查一次）。
   * @param {string} taskId 任务 id
   * @param {{refresh?:boolean}} [opts] `refresh:true` 时顺带查一次远端
   * @returns {Promise<{ok:true,task:object}|{ok:false,error:object}>} 结果
   */
  async status(taskId, opts = {}) {
    const id = asString(taskId)
    if (opts.refresh === true) return this._withTaskLock(id, () => this._refreshStatus(id))
    const task = await this.get(id)
    if (!task) return { ok: false, error: errorShape('TASK_NOT_FOUND', '本地没有这个任务的流水：' + id) }
    return { ok: true, task: projectTask(task) }
  }

  async _refreshStatus(id) {
    const task = await this.get(id)
    if (!task) return { ok: false, error: errorShape('TASK_NOT_FOUND', '本地没有这个任务的流水：' + id) }
    const recoverable = normalizeStatus(task.status) === STATUS.ERROR && ['TIMEOUT', 'NO_KEY', 'POLL_CRASH'].includes(task.errorCode)
    if (isTerminal(task.status) && !recoverable) return { ok: true, task: projectTask(task) }
    const key = this._keyFor(task)
    if (!key) return { ok: false, task: projectTask(task), error: errorShape('NO_KEY', '该任务所属地域没有可用 Key') }
    const q = await this._queryOnce(key, asString(task.region) || 'cn', id)
    this._applyQuery(task, q)
    if (!q || !q.ok || !normalizeStatus(q.status)) {
      await this._save(task)
      return { ok: false, task: projectTask(task), error: errorShape(asString(q && q.code) || 'QUERY_FAILED', asString(q && q.message) || '查询没有返回任务状态') }
    }
    if (recoverable) {
      task.errorCode = ''
      task.errorMessage = ''
      task.hint = ''
      task.finishedAt = 0
      task.trackingStartedAt = this.nowMs()
    }
    if (isTerminal(task.status)) await this._settle(id, task)
    else {
      const entry = this._live.get(id)
      if (entry) entry.task = task
      await this._save(task)
      this._startPolling(task)
    }
    return { ok: true, task: projectTask((await this.get(id)) || task) }
  }

  /**
   * 取消任务（RH 侧 + 本地状态）。
   * @param {string} taskId 任务 id
   * @returns {Promise<{ok:true,task:object}|{ok:false,error:object}>} 结果
   */
  async cancel(taskId) {
    return this._withTaskLock(asString(taskId), () => this._cancelNow(taskId))
  }

  async _cancelNow(taskId) {
    const id = asString(taskId)
    const task = await this.get(id)
    if (!task) return { ok: false, error: errorShape('TASK_NOT_FOUND', '本地没有这个任务的流水：' + id) }

    // ── 已经结束的任务：**不是失败**，别让用户看到一个红色业务错误 ──
    //
    // 血泪：用户在面板上对一个已完成的任务点了「取消」，RunningHub 直接回业务错误，
    // 面板就渲染成一条红色报错（真机 `clientCalls.lastError = tasksCancel:BUSINESS`）。
    // 取消一个跑完的任务本来就是无意义操作，正确回应是"它已经结束了"，不是"取消失败"。
    if (isTerminal(task.status)) {
      return {
        ok: true,
        alreadyFinished: true,
        status: normalizeStatus(task.status),
        task: projectTask(task),
      }
    }

    const key = this._keyFor(task)
    if (key === '') {
      return { ok: false, error: errorShape('NO_KEY', 'region=' + asString(task.region) + ' 没有可用 key，无法取消') }
    }
    const r = await this.api.cancelTask(key, asString(task.region) || 'cn', id)
    if (!r || r.ok !== true) {
      // 本地流水可能落后于远端：远端其实已经跑完了，我们却还在拿旧状态去取消。
      // 这时**再查一次** —— 若确实已终态，就当"它已经结束了"处理，而不是把
      // 一个对用户毫无意义的业务错误码原样抛上去。
      const fresh = await this._refreshStatus(id).catch(() => null)
      const freshStatus = fresh && fresh.ok !== false ? normalizeStatus((fresh.task && fresh.task.status) || '') : ''
      if (freshStatus !== '' && isTerminal(freshStatus)) {
        return { ok: true, alreadyFinished: true, status: freshStatus, task: (fresh && fresh.task) || projectTask(task) }
      }
      return { ok: false, error: (r && r.error) || errorShape('BUSINESS', '取消失败') }
    }
    const entry = this._live.get(id)
    if (entry) {
      entry.stopped = true
    }
    this._live.delete(id)
    task.status = STATUS.CANCEL
    task.finishedAt = this.nowMs()
    await this._save(task)
    this._emit('task.failed', { taskId: id, status: STATUS.CANCEL, failedReason: '用户取消' })
    return { ok: true, task: projectTask(task) }
  }

  /**
   * 插件启动时恢复未完成任务的轮询（**幂等**：终态任务不会被重新捡起来）。
   * @returns {Promise<{ok:true,resumed:string[],scanned:number}>} 结果
   */
  async resume() {
    if (!this.store || typeof this.store.listTasks !== 'function') return { ok: true, resumed: [], scanned: 0 }
    const tasks = await this.store.listTasks()
    const resumed = []
    for (const t of tasks) {
      if (!t || typeof t !== 'object') continue
      const st = normalizeStatus(t.status)
      if (FINAL_STATUSES.includes(st)) continue
      if (asString(t.taskId) === '') continue
      this._startPolling(t)
      resumed.push(asString(t.taskId))
    }
    if (resumed.length > 0) this._log('info', '恢复 ' + String(resumed.length) + ' 个未完成任务的轮询')
    return { ok: true, resumed, scanned: tasks.length }
  }

  /** 正在轮询的任务 id 列表。 @returns {string[]} id 数组 */
  liveTaskIds() {
    return Array.from(this._live.keys())
  }

  /** 停掉内部轮询定时器（dispose 时调）。 @returns {void} */
  stop() {
    this._stopped = true
    for (const [, entry] of this._live) entry.stopped = true
    this._live.clear()
  }
}

/**
 * 便捷工厂。
 * @param {object} deps 同 `TaskRunner` 构造器
 * @returns {TaskRunner} 实例
 */
export function createRunner(deps) {
  return new TaskRunner(deps)
}
