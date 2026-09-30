/**
 * host ↔ 浏览器半边 HTTP 通道的契约与安全测试
 *
 * 这条通道是配置面板唯一的**保证可用**的数据面（Remote 描述符只是增强），
 * 所以它的边界要当成公开接口来测：
 *   - 协议：`POST {method, params}` → `{ok:true,...}` / `{ok:false,error}`
 *   - 安全：非 POST 拒、非 JSON 拒、跨源拒、超大 body 拒、**回执永不含明文 Key**
 *
 * @module dsh-runninghub-plugin/tests/host/rpc
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

/** 起一个只挂我们路由的真 http server，然后用真 fetch 打它。 */
async function startRouteServer(dataDir) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'host', 'index.mjs')).href + '?t=' + String(Date.now()))
  const rpc = await import(pathToFileURL(path.join(ROOT, 'host', 'rpc.mjs')).href)

  const routes = []
  const services = {}
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: () => () => {} },
    get: (n) => services[n],
    on: () => () => {},
    effect: (fn) => {
      const d = fn()
      return () => typeof d === 'function' && d()
    },
    inject: () => {},
  }
  services.webServer = {
    register: (route) => {
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
  }

  // 附件服务的桩：图片路由靠 `attachments.readImage(ref)` 取字节。
  // 只认一个"已存在"的 attachmentId，其它一律抛 —— 好让 404 分支也被测到。
  const KNOWN_IMAGE = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 4, width: 2, height: 2 }
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  services.attachments = {
    readImage: async (ref) => {
      if (!ref || ref.attachmentId !== KNOWN_IMAGE.attachmentId) throw new Error('not found')
      return { ref: { ...KNOWN_IMAGE }, data: imageBytes }
    },
  }

  // 造一个"已装配"的运行时。
  // 优先用 core/index.mjs 的桶导出；它还没落地时退回直接 import store.mjs
  // —— 让这条通道的测试**不依赖协议层是否完工**。
  let core = await import(pathToFileURL(path.join(ROOT, 'host', 'core', 'index.mjs')).href).catch(() => null)
  if (!core) {
    const storeMod = await import(pathToFileURL(path.join(ROOT, 'host', 'core', 'store.mjs')).href).catch(() => null)
    if (storeMod) core = storeMod
  }
  const logger = { info() {}, warn() {}, error() {} }
  const store = core && core.Store ? new core.Store({ dataDir, logger }) : null
  const rt = {
    ctx,
    config: { dataDir, httpTimeoutMs: 5000, pollIntervalMs: 100, maxWaitMs: 60000 },
    logger: ctx.logger,
    warnings: [],
    core,
    coreReady: !!core,
    loadError: core ? null : '协议层未装载（测试降级）',
    store,
    api: null,
    pool: makeFakePool(),
    runner: { cancel: async () => ({ ok: true }) },
    workflow: core,
    promptdoc: core,
    startedAt: Date.now(),
    version: '0.1.0-test',
    dataDir,
    hostApiSource: 'test',
    clientBridge: null,
    requireCore: () => (core ? null : { ok: false, error: { code: 'CORE_NOT_LOADED', message: 'test' } }),
    warn(m) {
      this.warnings.push(String(m))
    },
  }

  assert.ok(store, 'store.mjs 必须可用（这条测试依赖它落盘）')

  const disposer = await rpc.registerHostRpc(ctx, rt)
  assert.ok(disposer, 'registerHostRpc 应成功（webServer 桩可用）')

  // 现在注册**两条**路由：
  //   ① HTTP_PATH（prefix）—— 面板的 RPC 兜底通道；
  //   ② IMAGE_PATH（exact）—— 把 {attachment} 换成图片二进制，供聊天里的工具卡片 <img> 用。
  // 图片路由是必需的：DSH 的 tool.call.toolview 按工具名 dispatch，未注册的工具走
  // generic row，而图片画廊 tool.call.images 只被内置 read-image-toolview 声明过，
  // 自定义工具要显示图只能自己注册卡片 + 自己取字节。
  assert.equal(routes.length, 2, '应注册 2 条路由（面板 API + 图片字节）')

  const api = routes.find((r) => r.path === rpc.HTTP_PATH)
  const image = routes.find((r) => r.path === rpc.IMAGE_PATH)
  assert.ok(api, '应注册面板路由 ' + rpc.HTTP_PATH)
  assert.equal(api.kind, 'prefix')
  assert.ok(image, '应注册图片路由 ' + rpc.IMAGE_PATH)
  assert.equal(image.kind, 'exact', '图片路由必须是 exact（避免前缀吞掉别的东西）')

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    for (const r of routes) {
      const hit = r.kind === 'prefix' ? url.pathname.startsWith(r.path) : url.pathname === r.path
      if (hit) {
        void r.handler(req, res)
        return
      }
    }
    res.writeHead(404).end('nope')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const base = 'http://127.0.0.1:' + String(server.address().port)
  return { server, base, rt, rpc, store, disposer }
}

function makeFakePool() {
  const entries = []
  return {
    add({ key, label, region, priority }) {
      const id = 'k' + String(entries.length + 1)
      entries.push({ id, key, label: label || '', region, priority: priority === undefined ? 100 : priority, enabled: true })
      return { ok: true, id }
    },
    update: () => ({ ok: true }),
    remove: () => ({ ok: true }),
    rawKey: (id) => (entries.find((e) => e.id === id) || {}).key,
    list: () => entries.map((e) => ({ id: e.id, label: e.label, maskedKey: e.key.slice(0, 4) + '****' + e.key.slice(-4), region: e.region, enabled: e.enabled, priority: e.priority, invalid: false, cooldownUntil: 0, lastUsedAt: 0 })),
    poolStats: () => ({
      cn: { total: entries.filter((e) => e.region === 'cn').length, available: entries.filter((e) => e.region === 'cn').length },
      overseas: { total: entries.filter((e) => e.region === 'overseas').length, available: entries.filter((e) => e.region === 'overseas').length },
    }),
    pick: () => ({ ok: false, error: { code: 'NO_KEY', message: 'test pool' } }),
    report: () => ({ ok: true }),
  }
}

async function withServer(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rh-rpc-'))
  const h = await startRouteServer(dir)
  try {
    return await fn(h)
  } finally {
    // ⚠️ 拆服务器必须**主动掐掉存活连接**。
    //
    // 血泪：`fetch`（undici）默认 **keep-alive**，用例跑完连接还挂在池里；
    // 而 `server.close(cb)` 会**等所有连接自然结束**才回调 —— 于是每个用例都要等
    // socket 超时，端口被一批批攥住。全仓连跑时表现为**随机某个用例
    // `fetch failed`**（验收门曾出现过一次 "337 里 1 红"，而单独跑那个文件 4/4 全绿）。
    //
    // 先 `close()` 停止接受新连接，再 `closeAllConnections()` 掐掉存活的，回调立刻返回。
    const closed = new Promise((r) => h.server.close(r))
    try {
      if (typeof h.server.closeAllConnections === 'function') h.server.closeAllConnections()
    } catch {
      /* 老 Node 没有这个方法就退回原行为 */
    }
    await closed
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/** 发一次 JSON-RPC 请求。 */
async function call(base, method, params, init = {}) {
  const res = await fetch(base + '/plugins/dsh-runninghub-plugin/api', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
    body: JSON.stringify({ method, params }),
    ...init,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 响应留给断言看原文 */
  }
  return { status: res.status, json, text }
}

test('协议：status / listWorkflows / 写操作 / 通用桥都能走通', async () => {
  await withServer(async ({ base, store }) => {
    // status
    const st = await call(base, 'status', {})
    assert.equal(st.status, 200)
    assert.equal(st.json.ok, true, 'status 应 ok：' + st.text)
    assert.ok(typeof st.json.dataDir === 'string' && st.json.dataDir.length > 0, 'status 要报数据目录')
    assert.ok(st.json.counts && typeof st.json.counts.workflows === 'number', 'status 要有 counts')

    // listWorkflows（初始为空）—— 列表类方法**直接返回数组**（与 client 侧的期望一致）
    const lw = await call(base, 'listWorkflows', {})
    assert.ok(Array.isArray(lw.json), 'listWorkflows 要返回数组：' + lw.text)
    assert.equal(lw.json.length, 0, '一开始应该是空的')

    // 写一个工作流，再读回来
    const cfg = { name: 'RPC 测试流', displayNameEn: 'rpc-test', rhWorkflowId: 'W1', region: 'cn', outputKind: 'image', description: 'd', tags: ['t'], nodes: [{ nodeId: '6', classType: 'CLIPTextEncode', role: 'prompt', fieldName: 'text', label: 'P', required: true, defaultValue: 'x', valueType: 'string', min: null, max: null, step: null, options: [], group: '', note: '' }], promptOptimizer: { enabled: false, docId: null, asSubagentSystemPrompt: false, targetNodeId: null, extraInstruction: '' } }
    const sv = await call(base, 'saveWorkflow', { config: cfg })
    assert.equal(sv.json.ok, true, 'saveWorkflow 应成功：' + sv.text)

    const lw2 = await call(base, 'listWorkflows', {})
    assert.ok(Array.isArray(lw2.json), 'listWorkflows 要返回数组：' + lw2.text)
    assert.ok(lw2.json.some((w) => w.name === 'RPC 测试流'), '刚存的工作流应出现在列表里')
    const saved = lw2.json.find((w) => w.name === 'RPC 测试流')
    assert.equal(saved.nodes.length, 1, 'listWorkflows 要带节点（面板展开时要用）')
    assert.equal(saved.nodes[0].defaultValue, 'x', '节点默认值字段必须是 defaultValue')

    // 通用桥等价于直连方法（列表类方法同样直接返回数组）
    const viaBridge = await call(base, 'call', { callJson: JSON.stringify({ method: 'listWorkflows', params: {} }) })
    assert.ok(Array.isArray(viaBridge.json), '通用桥应可用：' + viaBridge.text)
    assert.equal(viaBridge.json.length, 1, '通用桥应与直连返回同样的数据')

    // 通用桥调一个返回对象的动作
    const viaBridge2 = await call(base, 'call', { callJson: JSON.stringify({ method: 'status', params: {} }) })
    assert.equal(viaBridge2.json.ok, true, '通用桥 status 应可用：' + viaBridge2.text)
    assert.ok(store, 'store 应该是真的')

    // 未知方法必须是可判的失败，而不是 500
    const bad = await call(base, 'nopeNope', {})
    assert.equal(bad.status, 200, '业务失败也走 HTTP 200，判据看 body')
    assert.equal(bad.json.ok, false)
    assert.equal(bad.json.error.code, 'UNKNOWN_METHOD')
  })
})

test('安全：回执里永远没有明文 Key；跨源 / 非 JSON / 非 POST 一律拒', async () => {
  await withServer(async ({ base }) => {
    const PLAIN = 'CN-KEY-abcdef0123456789abcdef'
    const add = await call(base, 'keysAdd', { entry: { key: PLAIN, label: 'l', region: 'cn', priority: 1 } })
    assert.equal(add.json.ok, true, 'keysAdd 应成功：' + add.text)
    assert.ok(!add.text.includes(PLAIN), '**keysAdd 的回执里出现了明文 Key**')

    const list = await call(base, 'status', {})
    assert.ok(!list.text.includes(PLAIN), '**status 的回执里出现了明文 Key**')
    assert.match(list.text, /\*\*\*\*/, 'status 应给出掩码形式的 Key')

    // 跨源：带不匹配的 Origin 必须 403
    const cross = await fetch(base + '/plugins/dsh-runninghub-plugin/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example.com' },
      body: JSON.stringify({ method: 'status', params: {} }),
    })
    assert.equal(cross.status, 403, '跨源请求必须被拒')

    // 非 JSON content-type
    const wrongCt = await fetch(base + '/plugins/dsh-runninghub-plugin/api', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    })
    assert.equal(wrongCt.status, 415, '非 JSON content-type 必须被拒')

    // 非 POST
    const getRes = await fetch(base + '/plugins/dsh-runninghub-plugin/api')
    assert.equal(getRes.status, 405, 'GET 必须被拒')

    // OPTIONS（预检）不允许，这样浏览器就不会把跨站请求发出去
    const opts = await fetch(base + '/plugins/dsh-runninghub-plugin/api', { method: 'OPTIONS' })
    assert.equal(opts.status, 405, 'OPTIONS 不允许（刻意不开 CORS）')
    assert.equal(opts.headers.get('access-control-allow-origin'), null, '不能回 CORS 放行头')
  })
})

test('容错：坏 JSON / 缺 method / 超大 body 都给出可判错误而不是崩', async () => {
  await withServer(async ({ base }) => {
    const bad = await fetch(base + '/plugins/dsh-runninghub-plugin/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    assert.equal(bad.status, 400, '坏 JSON 应 400')
    const badJson = await bad.json()
    assert.equal(badJson.ok, false)
    assert.equal(badJson.error.code, 'BAD_JSON')

    const noMethod = await call(base, '', {})
    assert.equal(noMethod.status, 200, '缺 method 走业务失败')
    assert.equal(noMethod.json.ok, false)
    assert.equal(noMethod.json.error.code, 'BAD_REQUEST')

    // 超大 body：9 MiB（上限 8 MiB）
    const huge = 'x'.repeat(9 * 1024 * 1024)
    let status = 0
    try {
      const res = await fetch(base + '/plugins/dsh-runninghub-plugin/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ method: 'status', params: { pad: huge } }),
      })
      status = res.status
      await res.text().catch(() => '')
    } catch {
      // fetch 可能因为服务端主动断连而 reject —— 这也算"拒了"
      status = 413
    }
    assert.equal(status, 413, '超大 body 应 413（实际 ' + String(status) + '）')
  })
})

/**
 * 图片字节路由。
 *
 * 为什么值得单测：聊天里的工具卡片靠它把 `{type:'image', attachment}` 变成 `<img>`。
 * 它是**唯一**一条把宿主附件字节暴露给浏览器的通道，所以它的每一条拒绝分支
 * （非 POST / 非 JSON / 跨源 / 坏引用 / 不存在的附件）都必须真的拒掉 ——
 * 一旦漏了跨源或形状校验，就变成"任意网页可以拿 attachmentId 读用户私图"。
 */
test('图片路由：合法引用回二进制；非 POST / 非 JSON / 跨源 / 坏引用 / 不存在 一律拒', async () => {
  await withServer(async ({ base, rpc }) => {
    const url = base + rpc.IMAGE_PATH
    const KNOWN = 'sha256:' + 'a'.repeat(64)
    // ⚠️ 必须是**完整**引用：`readImage` 会拿它和图片元数据**逐字段比对**
    //    （mediaType / bytes / width / height），少一个字段必然报
    //    "Stored attachment metadata does not match its reference."
    //    真机就是这么翻车的 —— 所以残缺引用必须回 400 并说清缺了什么，
    //    而不是变成一条看不懂的 404。
    const good = { attachment: { attachmentId: KNOWN, mediaType: 'image/png', bytes: 4, width: 2, height: 2 } }

    // ① 正常路径：回 200 + 正确 content-type + 原始字节
    const okRes = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(good),
    })
    assert.equal(okRes.status, 200, '合法引用应 200')
    assert.equal(okRes.headers.get('content-type'), 'image/png')
    assert.equal(okRes.headers.get('x-content-type-options'), 'nosniff', '必须带 nosniff')
    const bytes = Buffer.from(await okRes.arrayBuffer())
    assert.deepEqual([...bytes], [0x89, 0x50, 0x4e, 0x47], '回的必须是原始字节')

    // ② 非 POST → 405
    const getRes = await fetch(url, { method: 'GET' })
    assert.equal(getRes.status, 405, 'GET 应 405')
    await getRes.text().catch(() => '')

    // ③ 非 JSON content-type → 415
    const textRes = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(good) })
    assert.equal(textRes.status, 415, '非 JSON 应 415')
    await textRes.text().catch(() => '')

    // ④ 跨源 → 403
    const crossRes = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify(good),
    })
    assert.equal(crossRes.status, 403, '跨源应 403')
    await crossRes.text().catch(() => '')

    // ⑤ 坏引用 → 400
    //    最后一组是**真机踩过的坑**：只给 attachmentId + mediaType（漏 bytes/width/height）。
    //    这种引用喂给 readImage 必然被元数据比对拒掉，所以路由要提前 400 并**说明缺了哪些字段**。
    const badCases = [
      { attachment: { mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }, // 缺 attachmentId
      { attachment: { attachmentId: 'x', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }, // id 不是 sha256
      { attachment: { attachmentId: KNOWN, mediaType: 'text/html', bytes: 1, width: 1, height: 1 } }, // 非图片
      { attachment: { attachmentId: KNOWN, mediaType: 'image/png' } }, // ← 缺 bytes/width/height
      { attachment: { attachmentId: KNOWN, mediaType: 'image/png', bytes: 4, width: 2 } }, // ← 缺 height
      { attachment: null },
      {},
    ]
    for (const bad of badCases) {
      const badRes = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bad),
      })
      assert.equal(badRes.status, 400, '坏引用应 400：' + JSON.stringify(bad))
      await badRes.text().catch(() => '')
    }

    // ⑤b 残缺引用必须**说清楚缺了什么**（不然又变成一条看不懂的 404）
    const partial = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attachment: { attachmentId: KNOWN, mediaType: 'image/png' } }),
    })
    const partialBody = await partial.json()
    assert.match(String(partialBody.error.message), /bytes/, '错误信息要指出缺 bytes')
    assert.match(String(partialBody.error.message), /width/, '错误信息要指出缺 width')
    assert.match(String(partialBody.error.message), /height/, '错误信息要指出缺 height')

    // ⑥ 不存在的附件 → 404（不是 500）
    const missingRes = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ attachment: { attachmentId: 'sha256:' + 'b'.repeat(64), mediaType: 'image/png', bytes: 8, width: 4, height: 4 } }),
    })
    assert.equal(missingRes.status, 404, '不存在的附件应 404')
    await missingRes.text().catch(() => '')

    // ⑦ 坏 JSON → 400
    const badJson = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json at all',
    })
    assert.equal(badJson.status, 400, '坏 JSON 应 400')
    await badJson.text().catch(() => '')
  })
})
