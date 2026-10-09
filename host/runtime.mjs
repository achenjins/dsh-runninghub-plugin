/**
 * dsh-runninghub-plugin · 运行时装载器
 *
 * 职责：把 `host/core/**`（纯协议层，零 DSH 依赖）装配成一个 `Runtime`，并把 DSH 侧的能力
 * （attachments / subagents / 日志）以**回调**形式注入进去。
 *
 * 设计要点：
 *   - **核心层缺席不能炸插件**：`host/core/index.mjs` 动态 import，失败只记 `loadError`，
 *     工具照常注册但回执里明说"协议层未装载"。这样"插件坏了"与"DSH 换了"永远分得清。
 *   - 路径全部相对 `import.meta.url`，不依赖 cwd（宿主可能从任意目录启动）。
 *   - `warnings` 保留最近 40 条，供面板和 diagnostics 查看；完整记录交给宿主日志。
 *
 * @module dsh-runninghub-plugin/host/runtime
 */

import path from 'node:path'
import os from 'node:os'
import { PKG_ROOT, maskKey, fail, ok, HOST_API, PLUGIN_VERSION, resolveProxyRoute } from './shared.mjs'
import { redactForRuntime } from './security.mjs'
import { DEFAULT_TASK_LIMIT, parseTaskLimit } from './task-policy.mjs'
export { parseTaskLimit } from './task-policy.mjs'

/** 运行期状态（每次 apply 一份） */
export class Runtime {
  constructor({ ctx, config, logger }) {
    this.ctx = ctx
    this.config = config
    this.logger = logger
    this.warnings = []
    this.core = null
    this.loadError = null
    this.api = null
    this.pool = null
    this.store = null
    this.runner = null
    this.workflow = null
    this.promptdoc = null
    this.startedAt = Date.now()
    this.disposed = false
    this._persistQueue = Promise.resolve({ ok: true })
    /** 宿主 API 解析结论（诊断里要报，用来一眼区分「插件坏了」与「DSH 换了」） */
    this.hostApiOk = !!HOST_API.ok
    this.hostApiSource = HOST_API.source + (HOST_API.resolvedPath ? ' @ ' + HOST_API.resolvedPath : '')
    this.version = PLUGIN_VERSION
  }

  warn(msg) {
    const s = redactForRuntime(this, String(msg))
    this.warnings.push(s)
    if (this.warnings.length > 40) this.warnings.splice(0, this.warnings.length - 40)
    try {
      this.logger && this.logger.warn && this.logger.warn(s)
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  /** 协议层是否已装载 */
  get coreReady() {
    return this.core !== null
  }

  /** 数据目录（核心层缺席时也要能答出来，供 diagnostics 用） */
  get dataDir() {
    if (this.store && this.store.dataDir) return this.store.dataDir
    return resolveDataDirFallback(this.config)
  }

  /** 全部工具动作的统一入口：核心层缺席时给出可读失败而不是堆栈。 */
  requireCore() {
    if (this.coreReady) return null
    return fail(
      'CORE_NOT_LOADED',
      '插件协议层未装载：' + String(this.loadError || '未知原因'),
      '看 runninghub_call({action:"diagnostics"}) 的 loadError 字段；多数情况是插件包不完整（host/core/ 缺失）。',
    )
  }

  flushPersistence() {
    return this._persistQueue
  }
}

/** 核心层缺席时的数据目录兜底解析（与核心层同一套口径，避免两处漂移）。 */
export function resolveDataDirFallback(config) {
  const explicit = config && typeof config.dataDir === 'string' && config.dataDir.trim().length > 0 ? config.dataDir.trim() : null
  if (explicit) return path.resolve(explicit)
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0 ? process.env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh')
  return path.join(home, 'runninghub')
}

/**
 * 输出根目录兜底解析：配置 `outputDir` 优先，缺省 `<dataDir>/outputs`。
 *
 * 只影响**生成结果的落盘位置**；工作流配置 / 任务流水 / 机密仍留在 `dataDir`。
 * 单次任务还可用 `workflow.run({saveDir})` 覆盖（`store.setTaskOutput`）。
 *
 * @param {any} config 归一化后的配置
 * @param {string} dataDir 已解析的数据目录
 * @returns {string} 绝对路径
 */
export function resolveOutputDirFallback(config, dataDir) {
  const explicit = config && typeof config.outputDir === 'string' && config.outputDir.trim().length > 0 ? config.outputDir.trim() : null
  if (explicit) return path.resolve(explicit)
  return path.join(dataDir, 'outputs')
}

/** 优先使用面板保存的 taskLimit，再读配置；0 表示不限制。 */
export function resolveMaxTasksFallback(config, state) {
  const fromState = parseTaskLimit(state && state.taskLimit)
  if (fromState !== null) return fromState
  const fromConfig = parseTaskLimit(config && config.maxTasks)
  if (fromConfig !== null) return fromConfig
  return DEFAULT_TASK_LIMIT
}

/**
 * 同步创建运行时外壳（**不加载任何东西**）。
 *
 * 为什么拆成 create + init：`apply()` 里工具必须**同步注册**。
 * 如果工具注册要等异步装配，装配一慢/一失败，模型侧就是「工具凭空消失」——
 * 那正是 blender 插件踩过的坑。拆开以后：工具先出现，装配在后台补，
 * 没装配好时工具回执明说 `CORE_NOT_LOADED`，用户和模型都看得见。
 *
 * @param {{ctx:any, config:any, logger:any}} args
 * @returns {Runtime}
 */
export function createRuntime({ ctx, config, logger }) {
  return new Runtime({ ctx, config, logger })
}

/**
 * 异步装配（**永远 resolve**：核心层加载失败也只是 coreReady=false + loadError）。
 *
 * @param {Runtime} rt createRuntime 建好的外壳（会被就地填充）
 * @returns {Promise<Runtime>}
 */
export async function initRuntime(rt) {
  const { ctx, config, logger } = rt

  let core = null
  try {
    core = await import('./core/index.mjs')
  } catch (e) {
    rt.warn('协议层 host/core/index.mjs 加载失败，尝试按模块逐个装载：' + String((e && e.message) || e))
    core = await loadCoreModulewise(rt)
  }

  // ── 日志器：核心层不认识 DSH，只给它一个 {info,warn,error} 的最小面 ──
  const coreLogger = {
    info: (m) => safeLog(logger, 'info', redactForRuntime(rt, m)),
    warn: (m) => safeLog(logger, 'warn', redactForRuntime(rt, m)),
    error: (m) => safeLog(logger, 'error', redactForRuntime(rt, m)),
  }

  try {
    // ── 存储 ──
    const dataDir = resolveDataDirFallback(config)
    if (typeof core.Store === 'function') {
      // 输出根目录：配置 `outputDir` 优先，否则 `<dataDir>/outputs`。
      // 单次任务还能用 `workflow.run({saveDir})` 覆盖（见 store.setTaskOutput）。
      rt.store = new core.Store({
        dataDir,
        logger: coreLogger,
        outputsRoot: resolveOutputDirFallback(config, dataDir),
        // 这里只能用 `config`：`state` 要等 store 建好之后才能读（`loadState` 依赖 store），
        // 顺序上天然循环。所以先用配置值建，读完 state 再覆盖（见下面那行）。
        maxTasks: resolveMaxTasksFallback(config, null),
      })
    } else {
      rt.warn('core.Store 未导出')
    }

    // ── 状态：**明文 Key 只许进 secrets.json（0600）**，绝不能进 state.json ──
    //
    // 血泪：KeyPool 的持久化状态里**含明文 key**（runner 要用它发请求）。
    // 早先把这份状态写进了 `state.json`（普通权限、还会被备份成多份 .bak），
    // 等于把用户的 API Key 明文摊在磁盘上 —— 正好违反本项目自己的红线
    // 「明文 Key 绝不落盘到非机密文件」。现在：
    //   · KeyPool 状态 → `secrets.json`（store 内部按 0600 写）
    //   · 其它非机密状态（如探测缓存）→ `state.json`
    let state = {}
    if (rt.store && typeof rt.store.loadState === 'function') {
      try {
        state = (await rt.store.loadState()) || {}
      } catch (e) {
        rt.warn('loadState 失败：' + String((e && e.message) || e))
      }
    }

    // 任务流水保留条数：**面板实时改过的 `state.taskLimit` 优先于配置 `maxTasks`**
    //（否则用户改完、重启又被配置默认值顶回去）。
    // 必须在读完 state 之后覆盖 —— 上面建 store 时还读不到 state。
    if (rt.store) {
      rt.store.maxTasks = resolveMaxTasksFallback(config, state)
      try {
        const result = await rt.store.pruneTasks()
        if (!result.ok) rt.warn(result.error.message)
      } catch (error) {
        rt.warn('任务记录清理失败：' + String(error?.message || error))
      }
    }
    let secrets = {}
    if (rt.store && typeof rt.store.readSecrets === 'function') {
      try {
        secrets = (await rt.store.readSecrets()) || {}
      } catch (e) {
        rt.warn('readSecrets 失败：' + String((e && e.message) || e))
      }
    }
    // 兼容早期误写在 state.json 里的 key 池状态：读到就迁移走，并在迁移后抹掉。
    //
    // ⚠️ 两处边界都必须防住：
    //   ① `rt.store` 可能**未装载**（核心层缺席）。直接 `rt.store.findLegacyKeyPool()`
    //      会抛 `Cannot read properties of null`，把真正的失败原因（如 `core.Store 未导出`）
    //      盖进 loadError，诊断直接退化 —— 缺模块时最需要看清原因，恰恰最看不清。
    //   ② 判据是「机密里**真的有 key**」而不是「有 pool 字段」：`secrets.json` 里
    //      `pool:{entries:[]}` 是真值但**空**的池，若当成"已经持久化过"，下面就会
    //      抹掉 state.json 的明文池 → **Key 彻底丢且无从恢复**。
    const poolHasKeys = (p) => Array.isArray(p && p.entries) && p.entries.length > 0
    const legacyFromDisk =
      rt.store && typeof rt.store.findLegacyKeyPool === 'function'
        ? await rt.store.findLegacyKeyPool().catch(() => null)
        : null
    const legacyPool = state.keys || (!poolHasKeys(secrets.pool) ? legacyFromDisk : null) || null
    // 机密里已有 key 时以它为准（那是当前真相）；否则用迁移来源。
    const persistedPool = poolHasKeys(secrets.pool) ? secrets.pool : legacyPool || secrets.pool || null
    if (legacyPool) {
      const canWrite = rt.store && typeof rt.store.writeSecrets === 'function'
      // 先确认机密文件写成功，再清理旧记录；启动后没有操作也不能丢 Key。
      const saved = poolHasKeys(secrets.pool)
        ? { ok: true }
        : canWrite
          ? await rt.store.writeSecrets({ ...secrets, pool: legacyPool, updatedAt: Date.now() })
          : { ok: false, error: { message: 'Store 未装载，无法把旧 Key 写进机密文件' } }
      if (saved.ok) await stripLegacyKeysFromState(rt)
      else rt.warn('旧 Key 迁移未完成，已保留 state.json：' + String(saved.error && saved.error.message))
    }
    if (rt.store && typeof rt.store.readSecrets === 'function') {
      const afterSecrets = await rt.store.readSecrets().catch(() => null)
      if (afterSecrets && afterSecrets.pool) await rt.store.scrubLegacySecretBackups()
    }

    // ── HTTP 客户端 ──
    if (typeof core.RunningHubApi === 'function') {
      rt.api = new core.RunningHubApi({
        logger: coreLogger,
        proxyRouteFor: await resolveProxyRoute(),
        timeoutMs: numberOr(config.httpTimeoutMs, 60000),
        fakeIpHosts: config.fakeIpHosts,
        fakeIpRanges: config.fakeIpRanges,
        // 只在显式配置时覆盖基址（验收测试打本地 mock server，或用户走自建/代理域名）
        ...(config.baseUrls && Object.keys(config.baseUrls).length > 0 ? { baseUrls: config.baseUrls } : {}),
        // 传输层脱敏用「池里全部明文 Key」做**字面量**替换。
        //
        // 为什么不是只给本次这把：服务端可能回显**别的**凭据（`/api-key/list` 之类）。
        // 早先靠"按字段名掩码"来兜这个，代价是把工作流节点里叫 `api_key`/`token` 的
        // **正常参数**也改成 `sk-l****epme`，还会作为节点默认值被静默提交。
        // 改成字面量后两者兼得。
        //
        // ⚠️ 池在本行**之后**才装配 → 必须给惰性函数，调用时再读 `rt.pool`。
        knownSecrets: () => {
          try {
            const list = rt.pool && typeof rt.pool.list === 'function' ? rt.pool.list() : []
            const out = []
            for (const entry of list) {
              const raw = rt.pool && typeof rt.pool.rawKey === 'function' ? rt.pool.rawKey(entry.id) : ''
              if (typeof raw === 'string' && raw !== '') out.push(raw)
            }
            return out
          } catch {
            return []
          }
        },
      })
    } else {
      rt.warn('core.RunningHubApi 未导出')
    }

    // ── Key 池 ──
    if (typeof core.KeyPool === 'function') {
      rt.pool = new core.KeyPool({
        state: persistedPool,
        logger: coreLogger,
        // ⚠️ 这份状态**含明文 key**（runner 发请求要用）→ 只能落 secrets.json。
        // 落 state.json 就等于把 Key 明文摊在磁盘上，还会被备份成多份。
        onPersist: (poolState) => {
          rt._persistQueue = rt._persistQueue.then(() => persistSecrets(rt, { pool: poolState }))
        },
      })
    } else {
      rt.warn('core.KeyPool 未导出')
    }

    // ── 协议层模块引用 ──
    rt.workflow = core
    rt.promptdoc = core

    // ── 后台任务运行器 ──
    if (typeof core.TaskRunner === 'function' && rt.api && rt.pool && rt.store) {
      rt.runner = new core.TaskRunner({
        api: rt.api,
        keys: rt.pool,
        store: rt.store,
        logger: coreLogger,
        pollIntervalMs: numberOr(config.pollIntervalMs, 3000),
        firstPollDelayMs: numberOr(config.pollIntervalMs, 3000),
        taskTimeoutMs: numberOr(config.maxWaitMs, 1800000),
        maxWaitMs: numberOr(config.maxWaitMs, 1800000),
        // 注意：**不要**注入 `download`。runner 的注入契约是
        // `download(spec) -> {ok, path?, bytes?:number, attachment?}`（下载 + 落盘 + 附件一把抓），
        // 而我们想要的正是它**内置**的那条路（`api.downloadBytes` → `store.writeOutput` → `attach`）。
        // 之前错写成 `(url, opts) => api.downloadBytes(url, opts)`，结果 spec 对象被当成 URL 传进去，
        // 真机上会表现成"任务成功但图下不来"。内置路径已在 runner 单测里覆盖，交给它更稳。
        attach: async (input) => {
          const r = await attachResult(ctx, input, rt)
          if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code })
          return r.attachment
        },
        onEvent: (ev) => safeLog(logger, 'info', '[runninghub] task ' + JSON.stringify(ev && ev.type ? ev.type : ev)),
      })
    } else if (typeof core.TaskRunner === 'function') {
      rt.warn('TaskRunner 未装配：api / pool / store 三者未全部就绪')
    } else {
      rt.warn('core.TaskRunner 未导出')
    }
    if (!rt.store || !rt.api || !rt.pool || !rt.runner) throw new Error('协议层缺少必要模块，无法完成装配')
    rt.core = core
  } catch (e) {
    rt.loadError = String((e && e.stack) || (e && e.message) || e)
    rt.warn('协议层装配失败：' + String((e && e.message) || e))
  }

  return rt
}

/**
 * 协议层的**逐模块兜底装载**。
 *
 * 为什么要有它：`core/index.mjs` 是个桶文件，少一个模块就整桶 import 失败。
 * 那时候"少了一个模块"会被报成"协议层未装载"—— 诊断信息**指向错误的层**，
 * 排查的人会去查插件装配，而真因是某个 `.mjs` 文件不在包里。
 * 逐模块装载能把"缺哪个"精确地说出来，同时让已经存在的模块照常工作。
 *
 * @param {Runtime} rt
 * @returns {Promise<object|null>} 合并后的模块命名空间；一个都没装上也返回 null
 */
async function loadCoreModulewise(rt) {
  const names = ['util', 'api', 'keys', 'store', 'workflow', 'runner', 'promptdoc']
  const merged = {}
  let loaded = 0
  for (const n of names) {
    try {
      const mod = await import('./core/' + n + '.mjs')
      for (const [k, v] of Object.entries(mod)) {
        if (merged[k] === undefined) merged[k] = v
      }
      loaded += 1
    } catch (e) {
      const msg = String((e && e.message) || e)
      // util/api/keys/store/workflow/runner 是骨架；promptdoc 可选
      if (n === 'promptdoc') rt.warn('可选模块 core/promptdoc.mjs 未装载：' + msg)
      else rt.warn('模块 core/' + n + '.mjs 未装载（这个模块的功能会不可用）：' + msg)
    }
  }
  if (loaded === 0) {
    rt.loadError = '协议层一个模块都没装载上（host/core/ 目录缺失或全部 import 失败）'
    return null
  }
  rt.warn('协议层按逐模块方式装载了 ' + String(loaded) + ' 个模块（缺 core/index.mjs 桶文件）')
  return merged
}

/**
 * 把**含明文 Key** 的状态写进 `secrets.json`（store 内部按 0600 写）。
 *
 * @param {Runtime} rt
 * @param {object} patch 要合并进 secrets.json 的字段（如 `{pool}`）
 */
async function persistSecrets(rt, patch) {
  try {
    if (!rt.store || typeof rt.store.readSecrets !== 'function' || typeof rt.store.writeSecrets !== 'function') return { ok: false }
    const current = (await rt.store.readSecrets()) || {}
    const saved = await rt.store.writeSecrets({ ...current, ...patch, updatedAt: Date.now() })
    if (!saved.ok) rt.warn('机密状态落盘失败：' + String(saved.error && saved.error.message))
    return saved
  } catch (e) {
    rt.warn('机密状态落盘失败：' + String((e && e.message) || e))
    return { ok: false, error: { code: 'STORE_WRITE_FAILED', message: String(e.message || e) } }
  }
}

/**
 * 清理早期版本误写在 `state.json` 里的 Key 池状态（**含明文 Key**）。
 *
 * ⚠️ 这里**必须用 `writeJson` 整体覆写，不能用 `saveState`** ——
 * `saveState` 是**浅合并**（`{...prev, ...obj}`），先 `delete current.keys` 再 `saveState(current)`
 * 会把 `prev` 里的 `keys` 又合并回来，等于什么都没删（第一版就是这么写的，被测试抓出来了）。
 *
 * 只删 `keys` 这一个字段，其它非机密状态原样保留。
 *
 * @param {Runtime} rt
 */
async function stripLegacyKeysFromState(rt) {
  try {
    if (!rt.store || typeof rt.store.loadState !== 'function' || typeof rt.store.writeJson !== 'function') return
    const current = (await rt.store.loadState()) || {}
    if (current.keys === undefined) return
    delete current.keys
    current.legacyKeysMigratedAt = Date.now()
    const saved = await rt.store.writeJson('state.json', current, { backup: false })
    if (!saved.ok) throw new Error(saved.error && saved.error.message)
    rt.warn('已从 state.json 抹掉明文 Key 池状态（改存 secrets.json）')
  } catch (e) {
    rt.warn('清理 state.json 里的旧 Key 状态失败（请手动检查该文件）：' + String((e && e.message) || e))
  }
}

function safeLog(logger, level, msg) {
  try {
    if (logger && typeof logger[level] === 'function') logger[level](String(msg))
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function numberOr(v, dflt) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : dflt
}

/* ────────────────────────── DSH 侧能力注入 ────────────────────────── */

/**
 * 把一份结果字节变成聊天里能渲染的附件。
 * 图片走 `attachments.saveImage`（→ `{type:'image'}` block），其它走 `saveFile`（→ `{type:'file'}`）。
 *
 * @param {any} ctx 插件上下文
 * @param {{taskId:string, kind:'image'|'video'|'audio'|'file', bytes:Uint8Array, url?:string, filename:string}} input
 * @returns {Promise<{ok:boolean, attachment?:any, contentType?:string, error?:any}>}
 */
export async function attachResult(ctx, input, rt) {
  const attachments = ctx && typeof ctx.get === 'function' ? ctx.get('attachments') : null
  if (!attachments) {
    return { ok: false, error: { code: 'NO_ATTACHMENTS', message: '宿主没有 attachments 服务，结果只落了本地文件' } }
  }
  const bytes = input && input.bytes
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return { ok: false, error: { code: 'EMPTY_BYTES', message: '结果字节为空' } }
  }
  const filename = String((input && input.filename) || 'result.bin')
  // 判断图片类型**先嗅探字节、再看扩展名** —— RunningHub 的输出项常常没有扩展名
  // （比如 filename 直接是 nodeId "9"），只看文件名会把 PNG 判成非图片、
  // 走 saveFile 而不是 saveImage，结果就是"图片没显示在聊天里"。
  const mediaType = sniffImageMediaType(bytes) || guessImageMediaType(filename)
  try {
    if (input.kind === 'image' && mediaType) {
      const limits = attachments.imageLimits || {}
      const allowed = Array.isArray(limits.mediaTypes) ? limits.mediaTypes : []
      if (allowed.length > 0 && !allowed.includes(mediaType)) {
        return { ok: false, error: { code: 'IMAGE_TYPE_REFUSED', message: '宿主不接受 ' + mediaType + '（允许：' + allowed.join('/') + '）' } }
      }
      const ref = await attachments.saveImage({ data: bytes, mediaType, name: withImageExt(filename, mediaType) })
      return {
        ok: true,
        contentType: mediaType,
        attachment: {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
          ...(ref.originalDimensions === undefined ? {} : { originalDimensions: ref.originalDimensions }),
        },
      }
    }
    const ref = await attachments.saveFile({ data: bytes, name: filename })
    return {
      ok: true,
      contentType: 'application/octet-stream',
      attachment: { attachmentId: ref.attachmentId, name: ref.name, bytes: ref.bytes },
    }
  } catch (e) {
    if (rt) rt.warn('附件落盘失败：' + String((e && e.message) || e))
    return { ok: false, error: { code: 'ATTACH_FAILED', message: String((e && e.message) || e) } }
  }
}

/** 按文件扩展名猜图片 MIME（宿主只认 png/jpeg/webp/gif）。 */
export function guessImageMediaType(filename) {
  const n = String(filename || '').toLowerCase()
  if (n.endsWith('.png')) return 'image/png'
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg'
  if (n.endsWith('.webp')) return 'image/webp'
  if (n.endsWith('.gif')) return 'image/gif'
  return null
}

/**
 * **按字节魔数**嗅探图片类型（比看扩展名可靠得多）。
 * RunningHub 的输出项经常没有扩展名，只靠文件名会把 PNG 判成非图片。
 *
 * @param {Uint8Array} bytes 文件字节
 * @returns {'image/png'|'image/jpeg'|'image/webp'|'image/gif'|null}
 */
export function sniffImageMediaType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null
  const b = bytes
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) return 'image/gif'
  return null
}

/** 给没有扩展名的文件名补上正确的图片扩展名（宿主/下载器会用到）。 */
export function withImageExt(filename, mediaType) {
  const n = String(filename || 'image')
  const lower = n.toLowerCase()
  const ext = mediaType === 'image/png' ? '.png' : mediaType === 'image/jpeg' ? '.jpg' : mediaType === 'image/webp' ? '.webp' : mediaType === 'image/gif' ? '.gif' : ''
  if (ext === '') return n
  if (lower.endsWith(ext) || (ext === '.jpg' && lower.endsWith('.jpeg'))) return n
  // 已经有别的图片扩展名（但嗅探结果不同）→ 换掉，避免宿主按扩展名误判
  if (/\.(png|jpe?g|webp|gif)$/.test(lower)) return n.replace(/\.(png|jpe?g|webp|gif)$/i, ext)
  return n + ext
}

/**
 * 便捷包装：建外壳 + 装配（测试与 loadcheck 用；插件 apply 里用 createRuntime + initRuntime 两步）。
 *
 * @param {{ctx:any, config:any, logger:any}} args
 * @returns {Promise<Runtime>} 永远 resolve
 */
export async function bootRuntime({ ctx, config, logger }) {
  const rt = new Runtime({ ctx, config, logger })
  return initRuntime(rt)
}

export { maskKey, ok, fail, PKG_ROOT }
