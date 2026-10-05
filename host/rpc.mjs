/**
 * dsh-runninghub-plugin · host ↔ 浏览器半边 的数据通道
 *
 * ## 为什么用 HTTP 路由而不是 Remote 描述符
 *
 * DSH 有两套浏览器插件机制：
 *   - **A 套（我们的）**：静态客户端包，`factory(require)`，与 host 通信用
 *     `ctx.remote.$mount(contribution)` + Typert 描述符；
 *   - **B 套**：动态浏览器半边，才有内置的 `host.call`。
 *
 * 描述符方案要求 host 侧 `class X extends TypertRemoteService`，而
 * `TypertRemoteService extends Service`（cordis）—— **基类身份必须与宿主是同一个模块实例**。
 * 我们的插件是无构建的 `.mjs`，`@deepseek-ai/dsh-typert-protocol` 只能从
 * profile / 全局 npm 目录解析，而宿主自己是从 app.asar 里解析的。两者是不是同一个实例
 * **无法在离线环境确认**，赌错就是"面板永远白屏"。
 *
 * 所以这里走 **`ctx.webServer.register` 的 HTTP 路由**：
 *   - 纯 `node:http` 语义，零外部依赖，没有模块身份问题；
 *   - 就在用户已经打开的那个 GUI 源上（同源），不需要新端口、不需要新服务；
 *   - 浏览器半边 `client/client.js` 已经内置了这条通道作为兜底（`fetch(HTTP_PATH)`）。
 *
 * 代价与对策：HTTP 路由比 RPC 暴露面大，所以这里做了三层收敛 ——
 *   ① 只收 `POST` + `content-type: application/json`（跨站表单发不出来，跨域 fetch 会先撞预检）；
 *   ② 带 `Origin` 时必须是同源（挡 CSRF）；没有 Origin 的（curl/本机脚本）放行，但只读得到掩码；
 *   ③ **回执里永远只有掩码 Key**，明文 key 只在 host 内存里（`rt.pool.rawKey()`）。
 *
 * @module dsh-runninghub-plugin/host/rpc
 */

import { maskKey, workflowIdOf } from './shared.mjs'
import { runtimeRedactor, redactForRuntime } from './security.mjs'
import { matchWorkflow } from './workflow-match.mjs'

/** 面板用的 HTTP 路由前缀（浏览器半边必须用同一个常量）。 */
export const HTTP_PATH = '/plugins/dsh-runninghub-plugin/api'

/**
 * 图片字节路由（**exact**）。
 *
 * 浏览器半边的工具卡片用它把 `{type:'image', attachment}` 变成 `<img>`：
 *   POST {attachment}  →  图片二进制
 *
 * 为什么必须存在这条路（而不是靠 `loadImage`）：DSH 的 `tool.call.toolview`
 * 是**按工具名 dispatch 的 keyed 槽**，没注册 toolview 的工具走 "generic row"，
 * 而图片画廊 `tool.call.images` 只被内置 `read-image-toolview` 声明过
 * （catalog：*"registering a second toolview that declares the same child throws at load"*）。
 * 所以自定义工具要显示图，只能自己注册 toolview + 自己拿字节。
 *
 * 做法与同类生产插件 `shanliuling/dsh-image-gen` 一致（`src/image-route.ts`）：
 * 同源校验 + 只收 POST/JSON + 限长 body + `attachments.readImage(ref)` 回二进制。
 */
export const IMAGE_PATH = '/plugins/dsh-runninghub-plugin/image'

/** 图片路由允许的请求体上限（一个 attachment ref 而已，64 KiB 绰绰有余）。 */
const MAX_IMAGE_BODY_BYTES = 64 * 1024

/**
 * 同源判定：`Origin` 存在且与 `Host` 不一致就拒绝。
 *
 * 与 `makeHandler` 里的 `sameOrigin` 同义，但这里**必须放宽**：
 * 有些客户端不发 `Origin`（同源 `fetch` 在某些情况下不带），
 * 缺省不能直接判死，否则卡片取不到图。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {boolean}
 */
function imageSameOrigin(req) {
  const origin = req.headers && req.headers.origin
  const host = req.headers && req.headers.host
  if (typeof origin !== 'string' || origin.length === 0) return true
  if (typeof host !== 'string' || host.length === 0) return true
  return origin === 'http://' + host || origin === 'https://' + host
}

/**
 * 校验并收窄一个来自浏览器的图片引用。
 *
 * 这是**不可信输入**：只接受 `{attachmentId: string, mediaType: 'image/*'}`，
 * 其余字段一律丢弃后重建（不把浏览器给的 width/height/name 当真）。
 *
 * @param {unknown} value 请求体
 * @returns {{attachmentId:string, mediaType:string} | null} 合法引用或 null
 */
function imageRefFromBody(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'body 必须是对象' }
  const raw = /** @type {Record<string, unknown>} */ (value).attachment
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'attachment 必须是对象' }
  const r = /** @type {Record<string, unknown>} */ (raw)

  const attachmentId = r.attachmentId
  if (typeof attachmentId !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(attachmentId)) {
    return { ok: false, reason: 'attachmentId 必须是 sha256:<64 位十六进制>' }
  }
  const mediaType = r.mediaType
  if (typeof mediaType !== 'string' || !mediaType.startsWith('image/')) {
    return { ok: false, reason: 'mediaType 必须是 image/*' }
  }

  // ⚠️ readImage 会拿引用**逐字段比对**图片元数据，缺任何一个都必然失败 → 提前拒掉
  const missing = []
  for (const key of ['bytes', 'width', 'height']) {
    if (!Number.isInteger(r[key]) || Number(r[key]) <= 0) missing.push(key)
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        'attachment 缺少 ' +
        missing.join(' / ') +
        ' —— readImage 会比对引用与图片元数据，缺字段必然报 "Stored attachment metadata does not match its reference."；请回传 saveImage 给的**完整**引用',
    }
  }

  /** @type {Record<string, unknown>} */
  const ref = {
    attachmentId,
    mediaType,
    bytes: Number(r.bytes),
    width: Number(r.width),
    height: Number(r.height),
  }
  if (typeof r.name === 'string' && r.name.length > 0 && r.name.length <= 260) ref.name = r.name
  // 归一化过的图会带 originalDimensions（比对用不到，但透传保持引用完整）
  const od = r.originalDimensions
  if (typeof od === 'object' && od !== null && !Array.isArray(od)) {
    const o = /** @type {Record<string, unknown>} */ (od)
    if (Number.isInteger(o.width) && Number.isInteger(o.height) && Number(o.width) > 0 && Number(o.height) > 0) {
      ref.originalDimensions = { width: Number(o.width), height: Number(o.height) }
    }
  }
  return { ok: true, ref }
}

/**
 * 造图片路由的 handler。
 *
 * @param {import('./runtime.mjs').Runtime} rt
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
function makeImageHandler(rt) {
  return async function imageHandler(req, res) {
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (method !== 'POST') {
      respond(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只接受 POST' } })
      return
    }
    if (!isJsonContentType(req)) {
      respond(res, 415, { ok: false, error: { code: 'BAD_CONTENT_TYPE', message: 'Content-Type 必须是 application/json' } })
      return
    }
    if (!imageSameOrigin(req)) {
      respond(res, 403, { ok: false, error: { code: 'CROSS_ORIGIN', message: '拒绝跨源请求' } })
      return
    }

    let body
    try {
      body = await readBody(req, MAX_IMAGE_BODY_BYTES)
    } catch (e) {
      respond(res, 413, { ok: false, error: { code: 'BODY_TOO_LARGE', message: String((e && e.message) || e) } })
      return
    }

    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      respond(res, 400, { ok: false, error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } })
      return
    }

    const parsedRef = imageRefFromBody(parsed)
    if (parsedRef.ok !== true) {
      respond(res, 400, { ok: false, error: { code: 'BAD_ATTACHMENT', message: parsedRef.reason } })
      return
    }
    const ref = parsedRef.ref

    const attachments = rt.ctx && typeof rt.ctx.get === 'function' ? rt.ctx.get('attachments') : null
    if (!attachments || typeof attachments.readImage !== 'function') {
      respond(res, 503, { ok: false, error: { code: 'NO_ATTACHMENTS', message: '宿主没有可读的 attachments 服务' } })
      return
    }

    try {
      const stored = await attachments.readImage(ref)
      const data = stored && stored.data
      if (!data) throw new Error('readImage 返回空数据')
      const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data)
      const mediaType = (stored.ref && stored.ref.mediaType) || ref.mediaType
      res.writeHead(200, {
        'content-type': mediaType,
        'content-length': String(bytes.byteLength),
        // 内容寻址的不可变对象，但可能含用户私图 → private + 长缓存
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
      })
      res.end(bytes)
    } catch (e) {
      respond(res, 404, redactForRuntime(rt, { ok: false, error: { code: 'IMAGE_UNAVAILABLE', message: String((e && e.message) || e) } }))
    }
  }
}

/** 请求体上限：工作流配置（含节点数组）可能很大，8 MB 足够且不至于被撑爆内存。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/**
 * 注册 host 侧数据通道。
 *
 * @param {any} ctx 插件上下文
 * @param {import('./runtime.mjs').Runtime} rt 运行时
 * @returns {Promise<(() => void)|null>} disposer；起不来返回 null（调用方只 warn）
 */
export async function registerHostRpc(ctx, rt) {
  const apiHandler = makeHandler(rt)
  const imageHandler = makeImageHandler(rt)

  /**
   * 把两条路由挂到一个 webServer 实例上。
   * @param {any} webServer
   * @returns {() => void} 卸载函数
   */
  const mount = (webServer) => {
    const offApi = webServer.register({ kind: 'prefix', path: HTTP_PATH, handler: apiHandler })
    let offImage = null
    try {
      offImage = webServer.register({ kind: 'exact', path: IMAGE_PATH, handler: imageHandler })
    } catch (e) {
      // 图片路由挂了不算致命：面板通道（HTTP_PATH）仍然可用，只是聊天里看不到图。
      rt.warn('注册图片路由失败（' + IMAGE_PATH + '）：' + String((e && e.message) || e))
    }
    rt.httpBridgeUnavailable = null
    return () => {
      try {
        if (typeof offImage === 'function') offImage()
      } catch {
        /* 摘路由失败不影响卸载 */
      }
      try {
        if (typeof offApi === 'function') offApi()
      } catch {
        /* 同上 */
      }
    }
  }

  const webServer = ctx && typeof ctx.get === 'function' ? ctx.get('webServer') : null
  if (webServer && typeof webServer.register === 'function') {
    let dispose
    try {
      dispose = mount(webServer)
    } catch (e) {
      rt.warn('注册面板路由失败（' + HTTP_PATH + '）：' + String((e && e.message) || e))
      return null
    }
    // 记录通道状态，供 diagnostics / 面板状态栏显示
    rt.clientBridge = { kind: 'http', path: HTTP_PATH }
    return () => {
      rt.clientBridge = null
      try {
        dispose()
      } catch {
        /* 摘路由失败不影响卸载 */
      }
    }
  }

  // ── webServer 此刻不在组合里 ──
  //
  // ⚠️ **不要立刻放弃**。`ctx.get('webServer')` 是**一次性快照**：本插件可能在
  // web 承载服务之前就 apply 完了（真机上就发生过：明明装配了 web 组合，
  // 这里却读到 undefined）。用 `ctx.inject(['webServer'], …)` 等它出现 ——
  // 与 `host/rpc-remote.mjs` 等 `typert` 是同一个套路。
  //
  // 服务一到就挂路由；服务消失由 scope.effect 自动摘除。
  try {
    const detach = ctx.inject(['webServer'], (scope) => scope.effect(
      () => {
        const live = scope.get ? scope.get('webServer') : scope.webServer
        if (!live || typeof live.register !== 'function') return () => {}
        const dispose = mount(live)
        rt.clientBridge = { kind: 'http', path: HTTP_PATH }
        return () => {
          rt.clientBridge = null
          dispose()
        }
      },
      'dsh-runninghub-plugin: webServer routes (api + image)',
    ))
    rt.httpBridgeUnavailable = 'webServer 尚未出现，已挂 ctx.inject 等待（面板暂用 Remote 通道）'
    return typeof detach === 'function' ? detach : null
  } catch (e) {
    // 兜底：任何异常都不能让 apply 抛出去
    rt.httpBridgeUnavailable = '宿主没有 webServer 服务'
    void e
    return null
  }
}

/**
 * 给方法表套一层**调用记账**。
 *
 * 为什么需要它：用户报"面板打不开"时，最要紧的一件事是分清
 *   （a）客户端**根本没把请求发到宿主**（`$mount` 失败 / 注入没就绪 / 通道选错），还是
 *   （b）请求到了宿主但处理失败。
 * 这两种情况的排查方向完全相反，而在浏览器 console 看不到的情况下，
 * **宿主侧有没有收到调用**是唯一能自证的信号。
 *
 * 计数进 `rt.clientCalls`，`diagnostics` 会原样报出来。
 *
 * @param {import('./runtime.mjs').Runtime} rt
 * @param {Record<string, Function>} methods 原始方法表
 * @returns {Record<string, Function>} 记账后的方法表（每条记：次数 + 最近一次时间 + 最近一次错误码）
 */
function withCallAccounting(rt, methods) {
  const counts = (rt.clientCalls = rt.clientCalls || { total: 0, byMethod: {}, lastAt: 0, lastError: null })
  const out = {}
  for (const [name, fn] of Object.entries(methods)) {
    out[name] = async (params) => {
      counts.total += 1
      counts.lastAt = Date.now()
      counts.byMethod[name] = (counts.byMethod[name] || 0) + 1
      try {
        const r = await fn(params)
        if (r && r.ok === false) counts.lastError = name + ':' + String((r.error && r.error.code) || 'ERROR')
        else counts.lastError = null
        return r
      } catch (e) {
        counts.lastError = name + ':THREW:' + String((e && e.message) || e).slice(0, 120)
        throw e
      }
    }
  }
  return out
}

/** 造一个 Node http 风格的 handler。 */
function makeHandler(rt) {
  return async function handler(req, res) {
    const method = String((req && req.method) || 'GET').toUpperCase()
    if (method === 'OPTIONS') {
      // 不主动开 CORS：跨域预检一律拒绝，浏览器就不会把跨站请求发出去
      respond(res, 405, { ok: false, error: { code: 'CORS_DENIED', message: '本路由不允许跨域访问' } })
      return
    }
    if (method !== 'POST') {
      respond(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: '只接受 POST' } })
      return
    }
    if (!isJsonContentType(req)) {
      respond(res, 415, { ok: false, error: { code: 'BAD_CONTENT_TYPE', message: 'Content-Type 必须是 application/json' } })
      return
    }
    if (!sameOrigin(req)) {
      respond(res, 403, { ok: false, error: { code: 'CROSS_ORIGIN', message: '拒绝跨源请求' } })
      return
    }

    let body
    try {
      body = await readBody(req, MAX_BODY_BYTES)
    } catch (e) {
      respond(res, 413, { ok: false, error: { code: 'BODY_TOO_LARGE', message: String((e && e.message) || e) } })
      return
    }

    let payload
    try {
      payload = body.length === 0 ? {} : JSON.parse(body)
    } catch (e) {
      respond(res, 400, { ok: false, error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } })
      return
    }

    const redact = runtimeRedactor(rt, payload)
    let out
    try {
      out = await dispatch(rt, payload)
    } catch (e) {
      rt.warn(redact('面板请求 ' + String(payload && payload.method) + ' 异常：' + String((e && e.stack) || e)))
      out = redact({ ok: false, error: { code: 'INTERNAL', message: String((e && e.message) || e) } })
    }
    respond(res, 200, out)
  }
}

/**
 * 注册**全部**可用通道：Remote（首选，若可解析到 Typert）＋ HTTP 路由（保底）。
 *
 * 两条腿都要：
 *   - Remote 是官方 RPC，走宿主已认证的连接，浏览器半边优先用它；
 *   - HTTP 路由零依赖、必然可用，是 Remote 起不来时的保底。
 * 任一成功就算通道可用；**两条都失败**才 warn 并让面板显示"后端未装配"。
 *
 * @param {any} ctx 插件上下文
 * @param {import('./runtime.mjs').Runtime} rt 运行时
 * @returns {Promise<(() => void)|null>}
 */
export async function registerClientBridge(ctx, rt) {
  // 两条腿共用同一份**记账后**的方法表 —— 谁调过、调了几次，宿主侧看得见。
  const methods = withCallAccounting(rt, buildMethods(rt))
  const disposers = []

  // ① Remote（官方）：解析不到 @deepseek-ai/dsh-typert-protocol 就自动跳过
  try {
    const mod = await import('./rpc-remote.mjs')
    if (mod && typeof mod.registerRemoteBridge === 'function') {
      const d = await mod.registerRemoteBridge(ctx, rt, methods)
      if (typeof d === 'function') {
        disposers.push(d)
        rt.clientBridge = { kind: 'remote', namespace: 'runninghub' }
      }
    }
  } catch (e) {
    rt.warn('Remote 桥装载失败（不影响 HTTP 通道）：' + String((e && e.message) || e))
  }

  // ② HTTP（保底）
  try {
    const d = await registerHostRpc(ctx, rt)
    if (typeof d === 'function') {
      disposers.push(d)
      rt.clientBridge = rt.clientBridge
        ? { ...rt.clientBridge, httpPath: HTTP_PATH }
        : { kind: 'http', path: HTTP_PATH }
    }
  } catch (e) {
    rt.warn('HTTP 路由注册失败：' + String((e && e.message) || e))
  }

  if (disposers.length === 0) {
    rt.warn('配置面板的两条数据通道都没起来（模型侧两个工具不受影响）；面板会显示"后端未装配"')
    return null
  }
  return () => {
    rt.clientBridge = null
    for (const d of disposers) {
      try {
        d()
      } catch {
        /* 逐条清理，一条失败不影响别的 */
      }
    }
  }
}

/* ────────────────────────── 具体方法实现 ────────────────────────── */

/**
 * 逻辑方法名 → 实现。
 *
 * 命名与 `client/client.js` 的 `API_METHODS` 表**一一对应**
 * （`keys.add` → `keysAdd`）。改名字要同时改两边。
 */
export function buildMethods(rt) {
  const M = {}
  const persistKeys = async (result) => {
    if (result && result.ok && typeof rt.flushPersistence === 'function') {
      const saved = await rt.flushPersistence()
      if (!saved.ok) return fail('STORE_WRITE_FAILED', 'Key 修改尚未保存到磁盘，请检查数据目录权限和磁盘空间')
    }
    return result
  }

  M.status = async () => {
    const keys = rt.pool && rt.pool.list ? rt.pool.list() : []
    const stats = rt.pool && rt.pool.poolStats ? rt.pool.poolStats() : { cn: { total: 0, available: 0 }, overseas: { total: 0, available: 0 } }
    const lists = await Promise.allSettled([
      Promise.resolve().then(() => rt.store.listWorkflows()),
      Promise.resolve().then(() => rt.store.listTasks()),
      Promise.resolve().then(() => rt.store.listPromptDocs()),
    ])
    const [workflows, tasks, docs] = lists.map(result => result.status === 'fulfilled' ? result.value || [] : [])
    return {
      ok: true,
      dataDir: rt.dataDir,
      version: rt.version,
      coreReady: rt.coreReady,
      loadError: rt.loadError ? String(rt.loadError).slice(0, 1500) : null,
      bridge: rt.clientBridge || null,
      keys,
      pool: stats,
      counts: { keys: keys.length, workflows: workflows.length, tasks: tasks.length, docs: docs.length },
      warnings: rt.warnings.slice(-40),
    }
  }

  M.listWorkflows = async () => {
    const list = (await rt.store.listWorkflows()) || []
    // UI 要看到节点，所以不裁剪；但把敏感字段剔掉
    return list.map(publicWorkflow)
  }

  M.saveWorkflow = async ({ config }) => {
    const cfg = config && typeof config === 'object' ? config : null
    if (!cfg || !cfg.name) return fail('BAD_REQUEST', '缺少工作流名')
    const id = workflowIdOf(cfg)
    const saved = await rt.store.saveWorkflow({ ...normalizeIncoming(cfg), id, name: String(cfg.name), updatedAt: Date.now(), schemaVersion: 1 })
    if (saved && saved.ok === false) return saved
    return { ok: true, id, name: String(cfg.name) }
  }

  M.deleteWorkflow = async ({ name }) => {
    const wf = await findWorkflowByName(rt, name)
    if (!wf) return fail('WORKFLOW_NOT_FOUND', '找不到工作流 ' + String(name))
    const r = await rt.store.deleteWorkflow(wf.id || wf.name)
    return r && r.ok === false ? r : { ok: true }
  }

  M.probeWorkflow = async ({ request }) => {
    const req = request && typeof request === 'object' ? request : {}
    const workflowId = String(req.workflowId || '').trim()
    if (!workflowId) return fail('BAD_REQUEST', '缺少工作流 ID')
    const region = pickRegion(rt, req.region)
    const picked = rt.pool.pick({ region })
    if (!picked || picked.ok === false) return fail('NO_KEY', '「' + region + '」池里没有可用 Key')
    let res
    try {
      res = await rt.api.getWorkflowJson(picked.key, region, workflowId)
    } finally {
      rt.pool.report(picked.id, 'ok')
    }
    if (!res || res.ok === false) {
      const code = (res && res.error && res.error.code) || 'UNKNOWN'
      rt.pool.report(picked.id, code)
      return res || fail('UNKNOWN', '取工作流失败')
    }
    const analyzed = rt.workflow.analyzeWorkflow(res.workflow)
    if (!analyzed || analyzed.ok === false) return fail('PARSE_FAILED', '工作流 JSON 解析失败')
    return { ok: true, rhWorkflowId: workflowId, region, proposal: analyzed }
  }

  M.keysAdd = async ({ entry }) => {
    const e = entry && typeof entry === 'object' ? entry : {}
    const key = String(e.key || '').trim()
    if (!key) return fail('BAD_REQUEST', '缺少 API Key')
    let region = String(e.region || 'auto').toLowerCase()
    if (region !== 'cn' && region !== 'overseas') {
      if (!rt.core.detectRegion) return fail('UNSUPPORTED', '协议层不支持地域探测，请显式选择国内/海外')
      region = await rt.core.detectRegion(rt.api, key)
      if (region === 'invalid') return fail('AUTH', '这把 Key 在国内与海外两个平台上都验不过')
    }
    const r = rt.pool.add({ key, label: e.label ? String(e.label) : '', region, priority: Number.isFinite(Number(e.priority)) ? Number(e.priority) : 100, enabled: true })
    if (r && r.ok === false) return r
    return persistKeys({ ok: true, id: r && r.id, region })
  }

  M.keysUpdate = async ({ id, patch }) => persistKeys(rt.pool.update(String(id || ''), patch && typeof patch === 'object' ? patch : {}))
  M.keysRemove = async ({ id }) => persistKeys(rt.pool.remove(String(id || '')))

  M.keysDetect = async ({ id }) => {
    const raw = rt.pool.rawKey ? rt.pool.rawKey(String(id || '')) : undefined
    if (!raw) return fail('NOT_FOUND', '找不到这把 Key')
    if (!rt.core.detectRegion) return fail('UNSUPPORTED', '协议层不支持地域探测')
    const region = await rt.core.detectRegion(rt.api, raw)
    if (region === 'invalid') return fail('AUTH', '这把 Key 在两个平台上都验不过')
    rt.pool.update(String(id), { region })
    return persistKeys({ ok: true, region })
  }

  M.keysBalance = async ({ id }) => {
    const keyId = String(id || '')
    const raw = keyId ? rt.pool.rawKey && rt.pool.rawKey(keyId) : undefined
    const entry = keyId && rt.pool.list ? (rt.pool.list() || []).find((k) => String(k.id) === keyId) : null
    if (keyId && !raw) return fail('NOT_FOUND', '找不到这把 Key')
    const region = entry ? entry.region : pickRegion(rt, undefined)
    const key = raw || (() => {
      const p = rt.pool.pick({ region })
      return p && p.ok !== false ? p.key : null
    })()
    if (!key) return fail('NO_KEY', '「' + region + '」池里没有可用 Key')
    const r = await rt.api.accountStatus(key, region)
    if (keyId) rt.pool.report(keyId, r && r.ok !== false ? 'ok' : (r && r.error && r.error.code) || 'TRANSPORT')
    if (!r || r.ok === false) return r || fail('UNKNOWN', '查余额失败')
    return { ok: true, region, maskedKey: maskKey(key), ...(r.data || {}) }
  }

  M.docsList = async () => {
    const list = (await rt.store.listPromptDocs()) || []
    // 列表不带正文（可能几十 KB），正文用 docsGet 单取
    return list.map((d) => ({ docId: String(d.docId || d.id || ''), name: String(d.name || ''), bytes: Number(d.bytes || 0), filename: String(d.sourceFilename || d.filename || ''), updatedAt: Number(d.updatedAt || 0) }))
  }

  M.docsGet = async ({ docId }) => {
    const doc = await rt.store.getPromptDoc(String(docId || ''))
    if (!doc) return fail('DOC_NOT_FOUND', '找不到文档')
    return { ok: true, docId: String(doc.docId || doc.id || ''), name: String(doc.name || ''), content: String(doc.content || ''), filename: String(doc.sourceFilename || doc.filename || ''), updatedAt: Number(doc.updatedAt || 0) }
  }

  M.docsSave = async ({ doc }) => {
    const d = doc && typeof doc === 'object' ? doc : {}
    if (!d.name) return fail('BAD_REQUEST', '缺少文档名')
    const id = d.docId ? String(d.docId) : undefined
    const previous = id ? await rt.store.getPromptDoc(id) : null
    const r = await rt.store.savePromptDoc({ name: String(d.name), content: String(d.content || ''), sourceFilename: d.filename === undefined ? String((previous && previous.sourceFilename) || '') : String(d.filename), id })
    if (r && r.ok === false) return r
    return { ok: true, docId: String((r && (r.docId || r.id)) || d.docId || '') }
  }

  M.docsRemove = async ({ docId }) => {
    const r = await rt.store.deletePromptDoc(String(docId || ''))
    return r && r.ok === false ? r : { ok: true }
  }

  M.tasksList = async ({ limit }) => {
    const n = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(200, Math.trunc(Number(limit)))) : 20
    const list = (await rt.store.listTasks({ limit: n })) || []
    return list.map(publicTask)
  }

  M.tasksGet = async ({ taskId }) => {
    const t = await rt.store.getTask(String(taskId || ''))
    if (!t) return fail('TASK_NOT_FOUND', '找不到任务')
    return publicTask(t)
  }

  M.tasksCancel = async ({ taskId }) => {
    const r = await rt.runner.cancel(String(taskId || ''))
    return r && r.ok === false ? r : { ok: true }
  }

  /** 不传 limit 读取设置；传非负整数保存并清理，0 表示不限制。 */
  M.tasksLimit = ({ limit }) => rt.store.taskLimit(limit)

  M.diagnostics = async () => {
    const d = {}
    try {
      Object.assign(d, await M.status())
    } catch {
      /* 状态取不到也要给出诊断 */
    }
    d.hostApi = rt.hostApiSource
    d.uptimeMs = Date.now() - rt.startedAt
    d.dataDir = rt.dataDir
    d.loadError = rt.loadError ? String(rt.loadError).slice(0, 3000) : null
    d.warnings = rt.warnings.slice(-40)
    d.bridge = rt.clientBridge || null
    return d
  }

  /** 通用桥：`{method, params}` 走同一个表，方便后端加动作时前端不用改。 */
  M.call = async ({ callJson }) => {
    let parsed = callJson
    if (typeof callJson === 'string') {
      try {
        parsed = JSON.parse(callJson)
      } catch {
        return fail('BAD_JSON', 'callJson 不是合法 JSON')
      }
    }
    const method = String((parsed && parsed.method) || '')
    const params = (parsed && parsed.params) || {}
    const fn = M[method]
    if (typeof fn !== 'function') return fail('UNKNOWN_METHOD', '不认识的 host 方法：' + method)
    return fn(params)
  }

  return Object.fromEntries(Object.entries(M).map(([name, fn]) => [name, async (params = {}) => {
    const redact = runtimeRedactor(rt, params, name)
    try {
      return redact(await fn(params))
    } catch (e) {
      const message = redact(String((e && e.message) || e))
      rt.warn('面板请求 ' + name + ' 异常：' + message)
      return fail('INTERNAL', message)
    }
  }]))
}

/** 把面板请求派发到方法表。 */
async function dispatch(rt, payload) {
  const method = String((payload && payload.method) || '')
  const params = (payload && payload.params) || {}
  if (!method) return fail('BAD_REQUEST', '缺少 method')
  const methods = buildMethods(rt)
  const fn = methods[method]
  if (typeof fn !== 'function') return runtimeRedactor(rt, payload)(fail('UNKNOWN_METHOD', '不认识的 host 方法：' + method))
  const out = await fn(params)
  return out && typeof out === 'object' ? out : { ok: true, value: out === undefined ? null : out }
}

/* ────────────────────────── 投影与工具函数 ────────────────────────── */

/**
 * 面板 → 存储方向的归一化。
 *
 * 面板（client/client.js）用的是 **`defaultValue`**（`default` 是 JS 保留字，写起来别扭），
 * 而协议层 / DESIGN §3.2 的节点形状用 **`default`**。转换只在这一处做，
 * 两个半边就永远不会因为字段名对不上而"存进去了、读出来是 null"。
 *
 * @param {object} cfg 面板传来的工作流配置
 * @returns {object} 可交给 store 的配置
 */
function normalizeIncoming(cfg) {
  const out = { ...cfg }
  if (Array.isArray(cfg.nodes)) {
    out.nodes = cfg.nodes.map((n) => {
      const node = { ...n }
      if (node.defaultValue !== undefined && node.default === undefined) node.default = node.defaultValue
      delete node.defaultValue
      for (const field of ['min', 'max', 'step']) if (node[field] === null) delete node[field]
      return node
    })
  }
  return out
}

/** 工作流 → 面板可见形状（**不含任何机密**）。 */
function publicWorkflow(wf) {
  return {
    id: String(wf.id || ''),
    name: String(wf.name || ''),
    displayNameEn: String(wf.displayNameEn || ''),
    rhWorkflowId: String(wf.rhWorkflowId || ''),
    region: String(wf.region || 'cn'),
    outputKind: String(wf.outputKind || 'unknown'),
    description: String(wf.description || ''),
    tags: Array.isArray(wf.tags) ? wf.tags.map(String) : [],
    instanceType: String(wf.instanceType || 'default'),
    nodes: Array.isArray(wf.nodes)
      ? wf.nodes.map((n) => ({
          nodeId: String(n.nodeId || ''),
          classType: String(n.classType || ''),
          title: String(n.title || ''),
          role: String(n.role || 'other'),
          fieldName: String(n.fieldName || ''),
          label: String(n.label || ''),
          required: !!n.required,
          defaultValue: n.default === undefined ? null : n.default,
          valueType: String(n.valueType || 'string'),
          min: n.min === undefined ? null : n.min,
          max: n.max === undefined ? null : n.max,
          step: n.step === undefined ? null : n.step,
          options: Array.isArray(n.options) ? n.options.map(String) : [],
          optionsSource: String(n.optionsSource || ''),
          boundsSource: String(n.boundsSource || ''),
          group: String(n.group || ''),
          note: String(n.note || ''),
        }))
      : [],
    promptOptimizer: {
      enabled: !!(wf.promptOptimizer && wf.promptOptimizer.enabled),
      docId: (wf.promptOptimizer && wf.promptOptimizer.docId) || null,
      asSubagentSystemPrompt: !!(wf.promptOptimizer && wf.promptOptimizer.asSubagentSystemPrompt),
      targetNodeId: (wf.promptOptimizer && wf.promptOptimizer.targetNodeId) || null,
      extraInstruction: String((wf.promptOptimizer && wf.promptOptimizer.extraInstruction) || ''),
    },
    createdAt: Number(wf.createdAt || 0),
    updatedAt: Number(wf.updatedAt || 0),
  }
}

/** 任务 → 面板可见形状（结果只给 URL 与本地路径，不给字节）。 */
function publicTask(t) {
  return {
    taskId: String(t.taskId || ''),
    status: String(t.status || ''),
    workflowName: String(t.workflowName || t.name || ''),
    workflowId: String(t.workflowId || ''),
    region: String(t.region || ''),
    createdAt: Number(t.createdAt || 0),
    updatedAt: Number(t.updatedAt || 0),
    progress: String(t.progress || ''),
    error: String(t.error || t.errorMessage || t.failedReason || ''),
    errorCode: String(t.errorCode || ''),
    hint: String(t.hint || ''),
    results: Array.isArray(t.results)
      ? t.results.map((r) => ({
          kind: String((r && r.kind) || 'file'),
          url: String((r && r.url) || ''),
          localPath: String((r && r.localPath) || ''),
          filename: String((r && r.filename) || ''),
          error: String((r && r.error) || ''),
          note: String((r && r.note) || ''),
        }))
      : [],
  }
}

/** 找同名工作流（与 call.mjs 同一套匹配口径）。 */
async function findWorkflowByName(rt, name) {
  const list = (await rt.store.listWorkflows()) || []
  return matchWorkflow(list, name)
}

/** 与 call.mjs 同一套 region 解析。 */
function pickRegion(rt, explicit) {
  const r = String(explicit || '').trim().toLowerCase()
  if (r === 'cn' || r === 'overseas') return r
  const stats = rt.pool && rt.pool.poolStats ? rt.pool.poolStats() : null
  if (stats) {
    const cnOk = stats.cn && stats.cn.available > 0
    const osOk = stats.overseas && stats.overseas.available > 0
    if (cnOk && !osOk) return 'cn'
    if (osOk && !cnOk) return 'overseas'
  }
  return 'cn'
}

function fail(code, message, hint) {
  return { ok: false, error: { code: String(code), message: String(message), ...(hint ? { hint: String(hint) } : {}) } }
}

/* ────────────────────────── HTTP 细节 ────────────────────────── */

function isJsonContentType(req) {
  const ct = String((req && req.headers && req.headers['content-type']) || '')
  return ct.toLowerCase().includes('application/json')
}

/** 带 Origin 时必须是同源（挡 CSRF）；没有 Origin 的（curl / 本机脚本）放行。 */
function sameOrigin(req) {
  const origin = req && req.headers ? req.headers.origin : null
  if (!origin) return true
  const host = String((req.headers && (req.headers.host || req.headers['x-forwarded-host'])) || '')
  if (!host) return false
  try {
    const u = new URL(String(origin))
    return u.host === host
  } catch {
    return false
  }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let total = 0
    const chunks = []
    req.on('data', (c) => {
      total += c.length
      if (total > maxBytes) {
        reject(new Error('请求体超过 ' + String(maxBytes) + ' 字节上限'))
        try {
          req.destroy()
        } catch {
          /* 已经断了 */
        }
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (e) => reject(e))
  })
}

function respond(res, status, payload) {
  let body = '{}'
  try {
    body = JSON.stringify(payload === undefined ? null : payload)
  } catch {
    body = '{"ok":false,"error":{"code":"SERIALIZE_FAILED","message":"回执无法序列化"}}'
    status = 500
  }
  const buf = Buffer.from(body, 'utf8')
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(buf.length),
      'cache-control': 'no-store',
      // 不开 CORS：跨域读不到回执
      'x-content-type-options': 'nosniff',
    })
    res.end(buf)
  } catch {
    /* 连接已经没了 */
  }
}
