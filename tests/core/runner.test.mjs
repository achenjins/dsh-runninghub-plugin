/**
 * tests/core/runner.test.mjs —— `host/core/runner.mjs` 的契约锁定
 *
 * 用**本地 mock HTTP server**（`node:http`）模拟 RunningHub 的
 * 「提交 → 排队 → 运行 → 成功 → 输出」全链路，**不碰外网、不花钱**。
 * 断言：submit 立即返回 · 轮询拿到 SUCCESS · 结果被下载并落盘 · 失败任务带 failedReason ·
 * 提交阶段 TRANSPORT_UNCERTAIN 绝不重投 · resume 恢复 · 跨池不回退。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { once } from 'node:events'

import { TaskRunner, projectTask, describeOutput, pollDelay, POLL_BACKOFF, POLL_MAX_MS, STALL_WARN_AFTER } from '../../host/core/runner.mjs'
import { RunningHubApi } from '../../host/core/api.mjs'
import { KeyPool } from '../../host/core/keys.mjs'
import { Store } from '../../host/core/store.mjs'
import { analyzeWorkflow } from '../../host/core/workflow.mjs'

/* ─────────────────────────────── 测试脚手架 ─────────────────────────────── */

/**
 * **整个文件共用一台 mock RH server**（每个 `startServer()` 只是注册一条按前缀分派的子路由）。
 *
 * 为什么不再"一个 test 起一台"：本文件有 ~28 个 test，每个 `listen(0)` 起一台、跑完关掉。
 * Windows 上关掉的端口会进 TIME_WAIT（默认 4 分钟），连着跑几轮就把临时端口耗掉，
 * 表现是**同一时刻好几个毫不相干的 test 一起在几毫秒内 `fetch failed`** ——
 * 看着像玄学，其实是端口/TIME_WAIT 耗尽。共用一台之后整个文件只占 1 个端口。
 *
 * 兼容性：调用方拿到的 `url` 仍是可拼 `/task/openapi/create` 的基址；
 * `route` 收到的 `rec.url` 已**去掉前缀还原成原路径**，既有断言不用改。
 */
let sharedSrv = null
const sharedRoutes = new Map()
let sharedSeq = 0

async function startServer(route) {
  if (!sharedSrv) {
    const srv = http.createServer(async (req, res) => {
      res.setHeader('Connection', 'close')
      const parts = String(req.url || '/').split('/')
      const prefix = parts[1] || ''
      const entry = sharedRoutes.get(prefix)
      if (!entry) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 404, msg: 'no route for prefix ' + prefix }))
        return
      }
      const chunks = []
      for await (const c of req) chunks.push(c)
      const raw = Buffer.concat(chunks)
      const rec = {
        method: req.method,
        url: '/' + parts.slice(2).join('/'), // ← 还原成调用方写的原路径
        headers: req.headers,
        raw,
        text: raw.toString('utf8'),
        json: null,
      }
      try {
        rec.json = JSON.parse(rec.text)
      } catch {
        /* ignore */
      }
      entry.calls.push(rec)
      entry.route(rec, res, entry.state, entry.calls.length)
    })
    srv.listen(0, '127.0.0.1')
    await once(srv, 'listening')
    // **unref**：常驻 server 会拖住事件循环，`node --test` 跑完就不退出了。
    srv.unref()
    sharedSrv = { srv, base: `http://127.0.0.1:${srv.address().port}` }
  }
  const prefix = 'r' + String(++sharedSeq)
  const calls = []
  const state = {}
  sharedRoutes.set(prefix, { route, calls, state })
  return {
    calls,
    state,
    url: sharedSrv.base + '/' + prefix,
    async close() {
      sharedRoutes.delete(prefix) // 只摘路由，**不关**共用 server
    },
  }
}

/** JSON 响应。 */
function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

/** 建临时数据目录。 */
async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rh-runner-'))
}

/** 一份最小可跑的 API 格式工作流。 */
function workflowConfig() {
  const analysis = analyzeWorkflow({
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat' }, _meta: { title: 'Prompt' } },
    '8': { class_type: 'SaveImage', inputs: {} },
  })
  return {
    id: 'wf_test',
    name: '测试工作流',
    rhWorkflowId: '1988',
    region: 'cn',
    outputKind: 'image',
    instanceType: 'default',
    nodes: analysis.nodes,
  }
}

/** 组装一套 runner + 依赖。 */
async function makeRig({ route, region = 'cn', key = 'rh_cn_test_key_0001', download, attach, sleep, now, firstPollDelayMs = 5 } = {}) {
  const dir = await tmpDir()
  const srv = await startServer(route)
  const store = new Store({ dataDir: dir })
  await store.init()
  const api = new RunningHubApi({ baseUrls: { cn: srv.url, overseas: srv.url }, retries: 0 })
  const keys = new KeyPool()
  keys.add({ id: 'k1', key, region })
  const events = []
  const logs = []
  const runner = new TaskRunner({
    api,
    keys,
    store,
    download,
    attach,
    onEvent: (e, p) => events.push({ e, p }),
    logger: {
      info: (...a) => logs.push('INFO ' + a.map(String).join(' ')),
      warn: (...a) => logs.push('WARN ' + a.map(String).join(' ')),
      error: (...a) => logs.push('ERROR ' + a.map(String).join(' ')),
    },
    sleep: sleep || ((ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20)))),
    firstPollDelayMs,
    now,
  })
  return {
    dir,
    srv,
    store,
    api,
    keys,
    runner,
    events,
    logs,
    /** 失败时把日志带进断言消息，免得只看到一句 "false !== true"。 */
    why: () => logs.filter((l) => !l.startsWith('INFO')).join(' | ') || '（无 warn/error 日志）',
    async close() {
      runner.stop()
      await srv.close()
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

/**
 * 语义类 `wait()` 的预算：**只关心语义，不关心延迟**。
 * `node --test` 会并行跑多个测试文件；收口链路（轮询 → 下载 → 落盘 → attach）在满载时
 * 偶尔会慢过 2–3s，用小预算就会偶发红 —— 那是测试自身的抖动，不是产品缺陷。
 */
const WAIT_BUDGET = 20000

/** 宽松取数（流水里的计数字段落过盘，类型不保证）。 */
function toNum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * 等到 `fn()` 为真（或超时）。
 * 默认给到 10s：`node --test` 会**并行跑多个测试文件**，本文件里每个 test 都起一个 mock server，
 * 机器满载时 3s 会偶发性不够（单独跑同一个 test 却是绿的，这就是典型的跨文件负载抖动）。
 */
async function until(fn, timeoutMs = 10000) {
  const start = Date.now()
  for (;;) {
    if (await fn()) return true
    if (Date.now() - start > timeoutMs) return false
    await new Promise((r) => setTimeout(r, 10))
  }
}

/* ─────────────────────────────── 纯函数 ─────────────────────────────── */

test('pollDelay：3s → 5s → 10s → 封顶 15s', () => {
  assert.deepEqual(POLL_BACKOFF, [3000, 5000, 10000])
  assert.equal(pollDelay(0), 3000)
  assert.equal(pollDelay(1), 5000)
  assert.equal(pollDelay(2), 10000)
  assert.equal(pollDelay(3), POLL_MAX_MS)
  assert.equal(pollDelay(99), 15000)
})

test('describeOutput：URL / 对象 / fileType 推断 kind；隐写载图不假装是普通图片', () => {
  assert.deepEqual(describeOutput('https://x/a.png'), { url: 'https://x/a.png', kind: 'image', filename: 'a.png', declaredType: '' })
  assert.equal(describeOutput({ fileUrl: 'https://x/v.mp4' }).kind, 'video')
  assert.equal(describeOutput({ url: 'https://x/a.wav' }).kind, 'audio')
  assert.equal(describeOutput({ fileUrl: 'https://x/m.glb' }).kind, '3d')
  assert.equal(describeOutput({ url: 'https://x/no-ext' }, 'video').kind, 'video')
  // 完全推不出类型时用兜底 kind 补扩展名（落盘文件名不该没有扩展名）
  assert.equal(describeOutput({ url: 'https://x/no-ext' }).filename, 'no-ext.png')
  assert.equal(describeOutput({ url: 'https://x/no-ext' }, 'video').filename, 'no-ext.mp4')
  assert.equal(describeOutput({ url: '' }).url, '')
  // 声明的 fileType 与 URL 扩展名冲突 = 「隐写载图」（视频藏在 PNG 里）→ 按声明类型 + 明确提示
  const duck = describeOutput({ fileUrl: 'https://x/a.png', fileType: 'mp4' })
  assert.equal(duck.kind, 'video')
  assert.equal(duck.steganography, true)
  assert.match(duck.note, /隐写载图/)
})

test('projectTask：只输出掩码 key，且是 lossless JSON', () => {
  const p = projectTask({
    taskId: 'T1',
    keyMasked: 'rh_c****0001',
    status: 'SUCCESS',
    createdAt: 1,
    nodeInfoList: [{ nodeId: '6', fieldName: 'text', fieldValue: 'x' }],
    outputs: [{ fileUrl: 'https://x/a.png' }],
  })
  assert.equal(p.taskId, 'T1')
  assert.equal(p.status, 'SUCCESS')
  assert.equal(p.nodeInfoCount, 1)
  assert.equal('key' in p, false, 'projectTask 绝不带明文 key')
  assert.deepEqual(JSON.parse(JSON.stringify(p)), p)
  assert.equal(projectTask({ status: 'running' }).status, 'RUNNING')
})

/* ─────────────────────────────── 快乐路径 ─────────────────────────────── */

test('submit **立即返回** taskId/jobId/status=QUEUED，轮询在后台跑', async () => {
  const rig = await makeRig({
    route(rec, res, state) {
      if (rec.url === '/task/openapi/create') {
        state.created = true
        return json(res, 200, { code: 0, data: { taskId: 'T-100', taskStatus: 'QUEUED' } })
      }
      if (rec.url === '/task/openapi/outputs') {
        // 前两次排队，第三次成功
        state.polls = (state.polls || 0) + 1
        if (state.polls < 3) return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
        return json(res, 200, { code: 0, data: [{ fileUrl: rig.srv.url + '/out/a.png', fileType: 'png' }] })
      }
      if (rec.url === '/out/a.png') {
        res.writeHead(200, { 'content-type': 'image/png' })
        return res.end(Buffer.from([137, 80, 78, 71]))
      }
      return json(res, 404, { code: 404, msg: 'not found' })
    },
  })
  try {
    const t0 = Date.now()
    const r = await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: '一只猫' } })
    const elapsed = Date.now() - t0
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.taskId, 'T-100')
    assert.ok(r.jobId.startsWith('rhjob_'))
    assert.equal(r.status, 'QUEUED')
    assert.equal(r.region, 'cn')
    assert.equal(r.keyMasked, 'rh_c****0001')
    assert.ok(elapsed < 500, 'submit 必须是立即返回，实测 ' + String(elapsed) + 'ms')

    // 后台轮询把它推到 SUCCESS（等到结果也落地，避免与收尾竞态）
    const done = await until(async () => {
      const t = await rig.runner.get('T-100')
      return t && t.status === 'SUCCESS' && Array.isArray(t.results) && t.results.length > 0
    })
    assert.equal(done, true, '轮询应把任务推到 SUCCESS 并收齐结果')

    // 结果被下载并落到 outputs/<taskId>/
    const files = await rig.store.listOutputs('T-100')
    assert.deepEqual(files, ['a.png'])
    const bytes = await fs.readFile(path.join(rig.store.outputDir('T-100'), 'a.png'))
    assert.deepEqual(Array.from(bytes), [137, 80, 78, 71])

    const task = await rig.runner.get('T-100')
    assert.equal(task.results.length, 1)
    assert.equal(task.results[0].kind, 'image')
    assert.equal(task.results[0].url, rig.srv.url + '/out/a.png')
    assert.ok(task.results[0].localPath.endsWith('a.png'))
    assert.equal(task.finishedAt > 0, true)

    // 事件
    const names = rig.events.map((x) => x.e)
    assert.ok(names.includes('task.submitted'))
    assert.ok(names.includes('task.progress'))
    assert.ok(names.includes('task.done'))
  } finally {
    await rig.close()
  }
})

test('submit：createTask 请求体带小写 instanceType、nodeInfoList；返回值不含明文 key', async () => {
  const rig = await makeRig({
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-1' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'SUCCESS' } })
    },
  })
  try {
    const cfg = { ...workflowConfig(), instanceType: 'Ultra' }
    const r = await rig.runner.submit({ workflowConfig: cfg, values: { prompt: 'hi' }, region: 'cn' })
    assert.equal(r.ok, true)
    const create = rig.srv.calls.find((c) => c.url === '/task/openapi/create')
    assert.equal(create.json.instanceType, 'ultra')
    assert.deepEqual(create.json.nodeInfoList, [{ nodeId: '6', fieldName: 'text', fieldValue: 'hi' }])
    assert.equal(JSON.stringify(r).includes('rh_cn_test_key_0001'), false, '回执里绝不能有明文 key')
    const task = await rig.runner.get('T-1')
    assert.equal(JSON.stringify(task).includes('rh_cn_test_key_0001'), false, '流水里绝不能有明文 key')
  } finally {
    await rig.close()
  }
})

test('wait：成功时返回 task + results（含 attachment）', async () => {
  const attached = []
  const rig = await makeRig({
    attach: async (spec) => {
      attached.push(spec.filename)
      return { kind: 'image', name: spec.filename, bytes: spec.bytes ? spec.bytes.byteLength : 0 }
    },
    route(rec, res, state) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-200' } })
      if (rec.url === '/task/openapi/outputs') return json(res, 200, { code: 0, data: [{ fileUrl: rig.srv.url + '/o/b.png' }] })
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from([1, 2, 3]))
    },
  })
  try {
    await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    const w = await rig.runner.wait('T-200', WAIT_BUDGET)
    assert.equal(w.ok, true, JSON.stringify(w.error || {}))
    assert.equal(w.timedOut, false)
    assert.equal(w.task.status, 'SUCCESS')
    assert.equal(w.results.length, 1)
    assert.equal(w.results[0].kind, 'image')
    assert.deepEqual(w.results[0].attachment, { kind: 'image', name: 'b.png', bytes: 3 })
    assert.deepEqual(attached, ['b.png'])
  } finally {
    await rig.close()
  }
})

test('wait：超时返回当前投影 + timedOut:true，**不取消任务**', async () => {
  const rig = await makeRig({
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-300' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    const w = await rig.runner.wait('T-300', 1000)
    assert.equal(w.ok, true)
    assert.equal(w.timedOut, true)
    assert.equal(w.task.status, 'RUNNING')
    // 没有发过 cancel
    assert.equal(rig.srv.calls.some((c) => c.url === '/task/openapi/cancel'), false)
    // 后台轮询仍在跑
    assert.deepEqual(rig.runner.liveTaskIds(), ['T-300'])
  } finally {
    await rig.close()
  }
})

test('wait：未知 taskId → TASK_NOT_FOUND', async () => {
  const rig = await makeRig({ route: (rec, res) => json(res, 200, { code: 0 }) })
  try {
    const w = await rig.runner.wait('不存在', 100)
    assert.equal(w.ok, false)
    assert.equal(w.error.code, 'TASK_NOT_FOUND')
    assert.equal((await rig.runner.wait('', 100)).ok, false)
  } finally {
    await rig.close()
  }
})

/* ─────────────────────────────── 失败路径 ─────────────────────────────── */

test('任务 FAILED → 带 failedReason，事件 task.failed', async () => {
  const rig = await makeRig({
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-400' } })
      return json(res, 200, {
        code: 0,
        data: { taskStatus: 'FAILED', failedReason: { exception_message: 'CUDA out of memory', node_name: 'KSampler' } },
      })
    },
  })
  try {
    await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    const done = await until(async () => {
      const t = await rig.runner.get('T-400')
      return t && t.status === 'FAILED'
    })
    assert.equal(done, true)
    const w = await rig.runner.wait('T-400', WAIT_BUDGET)
    assert.equal(w.ok, false)
    assert.equal(w.error.code, 'TASK_FAILED')
    assert.match(w.error.message, /CUDA out of memory/)
    assert.match(w.error.message, /node:KSampler/)
    assert.ok(rig.events.some((x) => x.e === 'task.failed'))
  } finally {
    await rig.close()
  }
})

test('**提交阶段 TRANSPORT_UNCERTAIN → 记 UNCERTAIN，绝不重投**', async () => {
  let createHits = 0
  const rig = await makeRig({
    route(rec, res) {
      if (rec.url === '/task/openapi/create') {
        createHits += 1
        return res.destroy() // 连接中断：结果未知
      }
      return json(res, 200, { code: 0 })
    },
  })
  try {
    const r = await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'TRANSPORT_UNCERTAIN')
    assert.equal(r.error.uncertain, true)
    assert.match(r.error.hint, /绝不自动重发|不要重发|核对/)
    assert.equal(createHits, 1, '提交类请求只允许发一次')

    // 本地落了一条 UNCERTAIN 流水
    const tasks = await rig.store.listTasks()
    const un = tasks.find((t) => t.status === 'UNCERTAIN')
    assert.ok(un, '必须落一条 UNCERTAIN 流水')
    assert.equal(un.uncertain, true)
    assert.match(un.hint, /绝不自动重发/)
    assert.equal(un.region, 'cn')
    assert.ok(rig.events.some((x) => x.e === 'task.uncertain'))
    // 等待也不会把它捡起来重投
    assert.deepEqual(rig.runner.liveTaskIds(), [])
  } finally {
    await rig.close()
  }
})

test('提交时 AUTH → 该 key 标记失效；QUOTA → 冷却（供上层换 key）', async () => {
  const rigAuth = await makeRig({ route: (rec, res) => json(res, 401, { code: 401, msg: 'APIKEY_INVALID' }) })
  try {
    const r = await rigAuth.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'AUTH')
    assert.equal(rigAuth.keys.list()[0].invalid, true)
  } finally {
    await rigAuth.close()
  }

  const rigQuota = await makeRig({ route: (rec, res) => json(res, 200, { code: 812, msg: '账户余额不足，请充值' }) })
  try {
    const r = await rigQuota.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'QUOTA')
    assert.ok(rigQuota.keys.list()[0].cooldownRemainingMs > 0)
  } finally {
    await rigQuota.close()
  }

  // P0 回归：803（APIKEY_INVALID_NODE_INFO）是业务错误，**绝不能**把健康 key 永久标失效
  const rigBiz = await makeRig({ route: (rec, res) => json(res, 200, { code: 803, msg: 'APIKEY_INVALID_NODE_INFO' }) })
  try {
    const r = await rigBiz.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'BUSINESS')
    const k = rigBiz.keys.list()[0]
    assert.equal(k.invalid, false, '803 绝不能标失效（只有 UI 手动 reset 才能清掉）')
    assert.equal(k.cooldownRemainingMs, 0, '803 也不该冷却')
    assert.equal(rigBiz.keys.poolStats().cn.available, 1, 'key 必须仍然可用')
  } finally {
    await rigBiz.close()
  }
})

test('**跨池绝不回退**：cn 工作流但只有海外 key → NO_KEY，一个请求都不发', async () => {
  const rig = await makeRig({
    region: 'overseas',
    key: 'rh_ov_test_key_0002',
    route: (rec, res) => json(res, 200, { code: 0, data: { taskId: 'T-9' } }),
  })
  try {
    const r = await rig.runner.submit({ workflowConfig: { ...workflowConfig(), region: 'cn' }, values: { prompt: 'x' } })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'NO_KEY')
    assert.equal(rig.srv.calls.length, 0, '绝不能跨池借 key 去发请求')
    assert.equal(JSON.stringify(r).includes('rh_ov_test_key_0002'), false)
  } finally {
    await rig.close()
  }
})

test('查询阶段的 TRANSPORT_UNCERTAIN 只是继续轮询（查询幂等）', async () => {
  const rig = await makeRig({
    route(rec, res, state) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-500' } })
      if (rec.url === '/task/openapi/outputs') {
        state.polls = (state.polls || 0) + 1
        if (state.polls === 1) return res.destroy() // 第一次查询断连
        return json(res, 200, { code: 0, data: [{ fileUrl: rig.srv.url + '/o/c.png' }] })
      }
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from([9]))
    },
  })
  try {
    await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    const done = await until(async () => {
      const t = await rig.runner.get('T-500')
      return t && t.status === 'SUCCESS'
    })
    assert.equal(done, true, '查询断连不该把任务判死')
    assert.ok(rig.srv.state.polls >= 2)
  } finally {
    await rig.close()
  }
})

test('提交前校验不过 → NODE_MISSING，且不发请求、不惩罚 key', async () => {
  const rig = await makeRig({ route: (rec, res) => json(res, 200, { code: 0, data: { taskId: 'T-1' } }) })
  try {
    const analysis = analyzeWorkflow({
      '6': { class_type: 'TextEncodeQwenImage21', inputs: { prompt: '' } },
      '8': { class_type: 'SaveImage', inputs: {} },
    })
    const cfg = { id: 'w', name: 'W', rhWorkflowId: '1', region: 'cn', nodes: analysis.nodes }
    const r = await rig.runner.submit({ workflowConfig: cfg, values: {} })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'NODE_MISSING')
    assert.equal(rig.srv.calls.length, 0)
    assert.equal(rig.keys.list()[0].invalid, false)
    assert.equal(rig.keys.list()[0].cooldownRemainingMs, 0)
  } finally {
    await rig.close()
  }
})

/* ─────────────────────────────── cancel / resume / list / stop ─────────────────────────────── */

test('cancel：调 /task/openapi/cancel 并把本地置 CANCEL', async () => {
  const rig = await makeRig({
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-600' } })
      if (rec.url === '/task/openapi/cancel') return json(res, 200, { code: 0, data: null })
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    const c = await rig.runner.cancel('T-600')
    assert.equal(c.ok, true, JSON.stringify(c))
    assert.equal(c.task.status, 'CANCEL')
    assert.deepEqual(rig.runner.liveTaskIds(), [])
    assert.equal((await rig.runner.cancel('不存在')).error.code, 'TASK_NOT_FOUND')
  } finally {
    await rig.close()
  }
})

test('★ cancel 一个**已经结束**的任务：当作"已结束"成功返回，绝不甩业务错误', async () => {
  // 血泪：真机上用户在面板里对一个 SUCCESS 任务点了「取消」，
  // RunningHub 回业务错误 → 面板渲染成红色报错（clientCalls.lastError = tasksCancel:BUSINESS）。
  // 取消一个跑完的任务本来就没意义，正确回应是"它已经结束了"。
  let cancelCalls = 0
  const rig = await makeRig({
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-601' } })
      if (rec.url === '/task/openapi/cancel') {
        cancelCalls += 1
        return json(res, 200, { code: 0, data: null })
      }
      // ⚠️ 结果 URL **必须指向本机 mock**：早先写成 `https://x/a.png`（不可解析的域名）时，
      //    收口会卡在 DNS 上，终态迟迟不落盘 → `wait()` 超时、cancel 走错分支，
      //    这个 test 于是变成偶发红。测试要自洽，别依赖外网。
      if (rec.url === '/a.png') {
        res.writeHead(200, { 'content-type': 'image/png' })
        return res.end(Buffer.from([137, 80, 78, 71]))
      }
      return json(res, 200, { code: 0, data: { taskStatus: 'SUCCESS', results: [{ fileUrl: rig.srv.url + '/a.png', fileType: 'png' }] } })
    },
  })
  try {
    await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    // 用 `until`（默认 10s）而不是 `wait(…, 5000)`：并行跑测试文件时 5s 会偶发不够，
    // 而这条测试要验的是 **cancel 语义**，不是"收口必须在 5s 内完成"。
    const done = await until(async () => {
      const t = await rig.runner.get('T-601')
      return t && t.status === 'SUCCESS' && Array.isArray(t.results) && t.results.length > 0
    })
    assert.equal(done, true, '任务应先跑成功并收齐结果；' + rig.why())

    const before = cancelCalls
    const c = await rig.runner.cancel('T-601')
    assert.equal(c.ok, true, '取消已结束任务必须是**成功**而不是失败：' + JSON.stringify(c))
    assert.equal(c.alreadyFinished, true, '必须标记 alreadyFinished，面板据此显示友好文案')
    assert.equal(c.status, 'SUCCESS')
    assert.equal(cancelCalls, before, '★ 已终态就不该再打 RunningHub 的 cancel 接口（白费一次调用）')
  } finally {
    await rig.close()
  }
})

test('★ cancel：本地还是 RUNNING 但远端已结束 → 不报业务错误，改判"已结束"', async () => {
  // 本地流水可能落后于远端。这时 cancel 接口会失败，但我们**不能**把一个
  // 对用户毫无意义的业务错误码原样抛上去 —— 再查一次，若已终态就照实说。
  const rig = await makeRig({
    // 轮询推到很远：**保证** cancel 时本地还是 QUEUED，才真正走到"远端已结束"那条分支
    // （否则轮询先收口成 SUCCESS，测试就名不副实了）。
    firstPollDelayMs: 60_000,
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-602' } })
      if (rec.url === '/task/openapi/cancel') {
        // 远端拒绝取消（因为已经跑完了）
        return json(res, 200, { code: 808, msg: 'task already finished' })
      }
      return json(res, 200, { code: 0, data: { taskStatus: 'SUCCESS', results: [] } })
    },
  })
  try {
    const s = await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    assert.equal(s.ok, true)
    assert.equal((await rig.runner.get('T-602')).status, 'QUEUED', '前置条件：本地还没到终态')
    // 直接取消（此时本地记的是 QUEUED，还没轮询到终态）
    const c = await rig.runner.cancel('T-602')
    assert.equal(c.ok, true, '应改判为"已结束"而不是失败：' + JSON.stringify(c))
    assert.equal(c.alreadyFinished, true)
    assert.equal(c.status, 'SUCCESS')
  } finally {
    await rig.close()
  }
})

test('resume：只捡未完成任务；幂等（终态不重跑）', async () => {
  const rig = await makeRig({
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-700' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    // 伪造「插件重启前的流水」
    await rig.store.saveTask({ taskId: 'T-RUN', status: 'RUNNING', region: 'cn', createdAt: Date.now(), keyId: 'k1' })
    await rig.store.saveTask({ taskId: 'T-OK', status: 'SUCCESS', region: 'cn', createdAt: Date.now(), keyId: 'k1' })
    await rig.store.saveTask({ taskId: 'T-BAD', status: 'FAILED', region: 'cn', createdAt: Date.now(), keyId: 'k1' })
    const r = await rig.runner.resume()
    assert.equal(r.ok, true)
    assert.deepEqual(r.resumed, ['T-RUN'])
    assert.equal(r.scanned, 3)
    assert.deepEqual(rig.runner.liveTaskIds(), ['T-RUN'])
    // 再 resume 一次不会重复起
    const r2 = await rig.runner.resume()
    assert.deepEqual(r2.resumed, ['T-RUN'])
    assert.deepEqual(rig.runner.liveTaskIds(), ['T-RUN'])
  } finally {
    await rig.close()
  }
})

test('list / status / get / liveTaskIds', async () => {
  const rig = await makeRig({
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-800' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'SUCCESS' } })
    },
  })
  try {
    await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: '一只猫' } })
    await until(async () => (await rig.runner.get('T-800')).status === 'SUCCESS')
    const list = await rig.runner.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].taskId, 'T-800')
    assert.equal(list[0].workflowName, '测试工作流')
    assert.equal(list[0].promptPreview, '一只猫')
    assert.deepEqual(JSON.parse(JSON.stringify(list)), list)
    const st = await rig.runner.status('T-800')
    assert.equal(st.ok, true)
    assert.equal(st.task.status, 'SUCCESS')
    assert.equal((await rig.runner.status('nope')).error.code, 'TASK_NOT_FOUND')
    assert.equal(await rig.runner.get('nope'), undefined)
  } finally {
    await rig.close()
  }
})

test('stop：清掉所有轮询定时器，之后不再发起查询', async () => {
  const rig = await makeRig({
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-900' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    await until(async () => rig.srv.calls.some((c) => c.url === '/task/openapi/outputs'))
    const before = rig.srv.calls.length
    rig.runner.stop()
    assert.deepEqual(rig.runner.liveTaskIds(), [])
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(rig.srv.calls.length, before, 'stop 之后不该再有请求')
    // 已停用的插件不能再创建会扣费的远端任务。
    const r = await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'STOPPED')
    assert.equal(rig.srv.calls.length, before)
    assert.deepEqual(rig.runner.liveTaskIds(), [])
  } finally {
    await rig.close()
  }
})

test('输出没有 URL 时如实记录（隐写载图不假装是普通图片）', async () => {
  const rig = await makeRig({
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-A' } })
      return json(res, 200, { code: 0, data: [{ fileType: 'png', nodeId: '9' }] })
    },
  })
  try {
    await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    await until(async () => (await rig.runner.get('T-A')).status === 'SUCCESS')
    const w = await rig.runner.wait('T-A', WAIT_BUDGET)
    assert.equal(w.ok, true)
    assert.equal(w.results.length, 1)
    assert.equal(w.results[0].url, '')
    assert.match(w.results[0].error, /没有 URL/)
  } finally {
    await rig.close()
  }
})

/* ═══════════════════════════════════════════════════════════════════════════
 * 输出项字段名锁定区
 *
 * 真实环境只有这一处能证明我们读对了字段，所以**两族的字段名都锁在这里**：
 *   旧族 `/task/openapi/outputs`（RHStudio2 实测）：`{fileUrl, fileType, nodeId, taskCostTime}`
 *   新族 `/openapi/v2/query`（官方 schema）：`results[].{url, outputType, text}`
 * `describeOutput()` 必须两族都认；两族都不给的字段（如 `taskCostTime`）不影响判读。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('字段名锁定：旧族 fileUrl/fileType/nodeId 与新族 url/outputType/text 都认', async () => {
  // 旧族（Lead 的 mock 就是这个形状）：`nodeId` 不是文件名，文件名只能从 URL 推
  const legacy = { fileUrl: 'https://cdn/x/a.png', fileType: 'png', taskCostTime: 12.5, nodeId: '9' }
  assert.deepEqual(describeOutput(legacy), {
    url: 'https://cdn/x/a.png',
    kind: 'image',
    filename: 'a.png',
    declaredType: 'png',
    nodeId: '9',
  })
  // 显式给了文件名就用它
  assert.equal(describeOutput({ fileUrl: 'https://cdn/x/a.png', fileName: 'my.png' }).filename, 'my.png')
  // **Lead 实测踩到的坑**：`nodeId:'9'` 绝不能变成文件名；缺扩展名时用 fileType 补
  assert.equal(describeOutput({ fileUrl: 'https://x/out.png', fileType: 'png', nodeId: '9' }).filename, 'out.png')
  assert.equal(describeOutput({ fileUrl: 'https://x/out', fileType: 'png', nodeId: '9' }).filename, 'out.png')
  assert.equal(describeOutput({ fileUrl: 'https://x/out', fileType: 'mp4' }).filename, 'out.mp4')
  assert.equal(describeOutput({ url: '', outputType: 'text', text: 'hi' }).filename.endsWith('.txt'), true)
  // 已有扩展名就不重复补
  assert.equal(describeOutput({ fileUrl: 'https://x/out.webp', fileType: 'png' }).filename, 'out.webp')
  // 新族（官方 v2 schema）
  const v2img = { url: 'https://cdn/x/b.png', outputType: 'png', text: '' }
  assert.equal(describeOutput(v2img).url, 'https://cdn/x/b.png')
  assert.equal(describeOutput(v2img).kind, 'image')
  const v2vid = { url: 'https://cdn/x/c.mp4', outputType: 'mp4', text: '' }
  assert.equal(describeOutput(v2vid).kind, 'video')
  // 新族文本结果：只有 text 没有 url
  const v2text = { url: '', outputType: 'text', text: '一只猫在跳舞' }
  assert.equal(describeOutput(v2text).kind, 'text')
  assert.equal(describeOutput(v2text).url, '')

  // 端到端：新族形状的输出项能被收成结果。
  // 这里**注入 `download`**（文档里那个「整体接管」钩子）：既锁住了注入契约，
  // 又让这条"字段名"测试不依赖真实 HTTP 下载 —— 后者在并行跑测试文件时偶发变慢，
  // 会把一条纯字段名的断言拖成 10s 超时。
  const specs = []
  const rig = await makeRig({
    download: async (spec) => {
      specs.push(spec)
      return { ok: true, path: '/fake/' + spec.filename, bytes: 3 }
    },
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-F' } })
      return json(res, 200, {
        taskId: 'T-F',
        status: 'SUCCESS',
        errorCode: 0,
        errorMessage: '',
        results: [
          { url: 'https://cdn.example/o/e.png', outputType: 'png', text: '' },
          { url: '', outputType: 'text', text: '这是一段文本结果' },
        ],
      })
    },
  })
  try {
    await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    const done = await until(async () => {
      const t = await rig.runner.get('T-F')
      return t && t.status === 'SUCCESS' && Array.isArray(t.results) && t.results.length === 2
    })
    assert.equal(done, true, '任务应收口成 2 条结果；' + rig.why())
    const t = await rig.runner.get('T-F')
    assert.equal(t.results[0].kind, 'image')
    assert.equal(t.results[0].url, 'https://cdn.example/o/e.png')
    assert.equal(t.results[1].kind, 'text')
    assert.equal(t.results[1].text, '这是一段文本结果')
    // 注入的 download 拿到的 filename 必须带扩展名（Lead 真机踩过的坑）
    assert.deepEqual(specs.map((s) => s.filename), ['e.png'])
    assert.equal(specs[0].kind, 'image')
    assert.equal(t.results[0].localPath, '/fake/e.png')
  } finally {
    await rig.close()
  }
})

test('注入的 download 优先于内置下载（Lead 可以接管）', async () => {
  const seen = []
  const rig = await makeRig({
    download: async (spec) => {
      seen.push(spec)
      return { ok: true, path: 'D:/fake/x.png', bytes: 42 }
    },
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-B' } })
      return json(res, 200, { code: 0, data: [{ fileUrl: 'https://cdn.example/a.png' }] })
    },
  })
  try {
    await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    await until(async () => (await rig.runner.get('T-B')).status === 'SUCCESS')
    assert.equal(seen.length, 1)
    assert.equal(seen[0].taskId, 'T-B')
    assert.equal(seen[0].url, 'https://cdn.example/a.png')
    assert.equal(seen[0].filename, 'a.png')
    const t = await rig.runner.get('T-B')
    assert.equal(t.results[0].localPath, 'D:/fake/x.png')
    assert.equal(t.results[0].bytes, 42)
  } finally {
    await rig.close()
  }
})

test('落盘抖动：submit 不崩、轮询链**不静默死掉**、盘恢复后照样推进', async () => {
  const rig = await makeRig({
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-D' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    const realSave = rig.store.saveTask.bind(rig.store)
    let boom = true
    rig.store.saveTask = async (...a) => {
      if (boom) throw new Error('磁盘暂时不可写')
      return realSave(...a)
    }
    // ① 落盘抛异常，submit 自己不能崩
    const r = await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    assert.equal(r.ok, true, '落盘失败不该把 submit 带崩；' + rig.why())
    // ② 异常被就地兜住并记 warn（而不是变成 unhandled rejection 把链子打断）
    const guarded = await until(async () => rig.logs.some((l) => l.includes('写任务流水')), 5000)
    assert.equal(guarded, true, '落盘异常必须被记下来；' + rig.why())
    // ③ 磁盘恢复 → 流水重新可写、任务继续推进
    boom = false
    const advanced = await until(async () => {
      const t = await rig.runner.get('T-D')
      return t && t.pollCount >= 1
    }, 8000)
    assert.equal(advanced, true, '盘恢复后轮询必须继续；' + rig.why())
    const t = await rig.runner.get('T-D')
    assert.notEqual(t.status, 'ERROR')
  } finally {
    await rig.close()
  }
})

test('_onPollCrash：轮询链抛异常时记 error、**保留 live 条目**、退避后重试', async () => {
  const rig = await makeRig({ route: (rec, res) => json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } }) })
  try {
    // 手工放一个 live 条目，直接触发崩溃处理
    rig.runner._live.set('T-X', { task: { taskId: 'T-X', status: 'RUNNING', region: 'cn' }, stopped: false })
    rig.runner._onPollCrash('T-X', new Error('注入的意外异常'))
    assert.equal(rig.logs.some((l) => l.startsWith('ERROR') && l.includes('轮询链异常')), true, '必须记 error 日志')
    assert.equal(rig.runner._live.has('T-X'), true, '条目必须保留（链子要能接上），而不是被丢掉')
    assert.equal(rig.runner._live.get('T-X').crashes, 1, '要记崩溃次数，用于 5 次后收口')
    // 收口后（entries 已被 stop）不再重试
    rig.runner._live.get('T-X').stopped = true
    const before = rig.logs.length
    rig.runner._onPollCrash('T-X', new Error('再来一次'))
    assert.ok(rig.logs.length > before, '仍然要记日志')
    assert.equal(rig.runner._live.get('T-X').crashes, 1, '已停止的条目不再累计')
  } finally {
    await rig.close()
  }
})

test('queryFailures：**空 status 不算查询成功**，跨过阈值提示一次（rh-docs C14b）', async () => {
  // v2 对旧族 taskId 返回空 status（既没有 status 也没有 code）
  const rig = await makeRig({
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-S' } })
      return json(res, 200, { errorCode: 0, errorMessage: '' }) // 没有 status
    },
  })
  try {
    await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    const grew = await until(async () => {
      const t = await rig.runner.get('T-S')
      return t && toNum(t.queryFailures) >= STALL_WARN_AFTER
    })
    assert.equal(grew, true, '空 status 必须累计 queryFailures；' + rig.why())
    const t = await rig.runner.get('T-S')
    assert.equal(t.status, 'QUEUED', '**不覆盖**已有状态')
    assert.match(String(t.lastQueryError), /EMPTY_STATUS/)
    assert.match(String(t.hint), /连续 6 次/)
    assert.equal(rig.events.some((e) => e.e === 'task.stalled'), true, '要发一次 task.stalled 事件')
    assert.equal(rig.logs.some((l) => l.startsWith('WARN') && l.includes('拿不到可用状态')), true)
    // 只提示一次（阈值那一次），不是每轮都刷屏
    assert.equal(rig.events.filter((e) => e.e === 'task.stalled').length, 1)
  } finally {
    await rig.close()
  }
})

test('queryFailures：拿到可用状态后清零（提示不会一直挂着）', async () => {
  const rig = await makeRig({
    route(rec, res, state) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-Z' } })
      state.polls = (state.polls || 0) + 1
      if (state.polls <= 2) return json(res, 200, { errorCode: 0 }) // 空 status
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    await rig.runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    const cleared = await until(async () => {
      const t = await rig.runner.get('T-Z')
      return t && toNum(t.queryFailures) === 0 && t.status === 'RUNNING'
    })
    assert.equal(cleared, true, '拿到可用状态后 queryFailures 必须清零；' + rig.why())
  } finally {
    await rig.close()
  }
})

test('onEvent 抛异常不影响任务推进', async () => {
  const dir = await tmpDir()
  const srv = await startServer((rec, res) => {
    if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-C' } })
    return json(res, 200, { code: 0, data: { taskStatus: 'SUCCESS' } })
  })
  try {
    const store = new Store({ dataDir: dir })
    const api = new RunningHubApi({ baseUrls: { cn: srv.url, overseas: srv.url }, retries: 0 })
    const keys = new KeyPool()
    keys.add({ id: 'k1', key: 'k', region: 'cn' })
    const runner = new TaskRunner({
      api,
      keys,
      store,
      onEvent: () => {
        throw new Error('订阅方炸了')
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 10))),
    })
    const r = await runner.submit({ workflowConfig: workflowConfig(), values: { prompt: 'x' } })
    assert.equal(r.ok, true)
    const ok = await until(async () => (await runner.get('T-C')).status === 'SUCCESS')
    assert.equal(ok, true)
    runner.stop()
  } finally {
    await srv.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
