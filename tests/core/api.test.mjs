/**
 * tests/core/api.test.mjs —— `host/core/api.mjs` 的契约锁定
 *
 * 用**本地 mock HTTP server**（node:http）跑真实 fetch 往返，不碰外网、不花钱：
 *   端点路径 / 请求体字段名 / 鉴权头 / 成功码（0 与 200）/ 错误分类 / 不重试提交类 / 上传双接口回退。
 *
 * 依据：RHStudio2 `ApiClient.java` + `Http.java`、Python `runninghub_client.py`，
 * 以及官方 API 文档（https://www.runninghub.cn/runninghub-api-doc-cn）—— **冲突时以官方文档为准**，见文件末尾「官方文档锁定区」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  BASE_URLS,
  RunningHubApi,
  ERR,
  STATUS,
  SUCCESS_CODES,
  CODE_TABLE,
  INSTANCE_TYPES,
  normalizeStatus,
  normalizeInstanceType,
  regionOfUrl,
  classifyResponse,
  classifyBusiness,
  hintForCode,
  isSuccessCode,
  isRetryable,
  allowsFakeIp,
  isFakeIpAddress,
  buildFakeIpPolicy,
  parseFakeIpRange,
  normalizeFakeIpHost,
  filterResolvedAddresses,
  DEFAULT_FAKE_IP_HOSTS,
  DEFAULT_FAKE_IP_RANGES,
  isTerminal,
  humanSize,
  maskKey,
  extractFailure,
} from '../../host/core/api.mjs'

/* ───────────────────────────── 测试用 mock server ───────────────────────────── */

/**
 * **整个文件共用一台 mock server**（每个 `startServer()` 只是注册一条按前缀分派的子路由）。
 *
 * 为什么不再"一个 test 起一台"：
 *   本文件有 ~45 个 test，每个 `listen(0)` 起一台、跑完关掉 → 一轮就是 45 台。
 *   Windows 上关掉的端口会进 TIME_WAIT（默认 4 分钟），连着跑几轮就把临时端口耗掉，
 *   表现是**同一时刻好几个毫不相干的 test 一起在 2–3ms 内 `fetch failed`** ——
 *   看着像玄学，其实是端口/TIME_WAIT 耗尽。
 *   共用一台之后，整个文件只占 1 个端口，这类 flake 从根上消失。
 *
 * 兼容性：`startServer()` 的调用方拿到的 `url` 仍是一个"基址"，原样拼 `/task/openapi/create`
 * 就能用；handler 收到的 `rec.url` 也已经**去掉前缀还原成原路径**，所有既有断言不用改。
 */
let sharedSrv = null
const sharedRoutes = new Map()
let sharedSeq = 0

/** 起（或复用）那台共用 server，并注册一条子路由。 */
async function startServer(handler) {
  if (!sharedSrv) {
    const srv = http.createServer(async (req, res) => {
      res.setHeader('Connection', 'close')
      const parts = String(req.url || '/').split('/')
      const prefix = parts[1] || ''
      const entry = sharedRoutes.get(prefix)
      if (!entry) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 404, msg: 'no route registered for prefix ' + prefix }))
        return
      }
      const chunks = []
      for await (const c of req) chunks.push(c)
      const body = Buffer.concat(chunks)
      const rec = {
        method: req.method,
        url: '/' + parts.slice(2).join('/'), // ← 还原成调用方写的原路径
        headers: req.headers,
        raw: body,
        text: body.toString('utf8'),
        json: null,
      }
      try {
        rec.json = JSON.parse(rec.text)
      } catch {
        /* multipart 等非 JSON */
      }
      entry.calls.push(rec)
      await entry.handler(rec, res, entry.calls.length)
    })
    srv.listen(0, '127.0.0.1')
    await once(srv, 'listening')
    // **unref**：否则这台常驻 server 会拖住事件循环，`node --test` 跑完不退出。
    srv.unref()
    sharedSrv = { srv, base: `http://127.0.0.1:${srv.address().port}` }
  }
  const prefix = 't' + String(++sharedSeq)
  const calls = []
  sharedRoutes.set(prefix, { handler, calls })
  return {
    calls,
    url: sharedSrv.base + '/' + prefix,
    async close() {
      sharedRoutes.delete(prefix) // 只摘路由，**不关**共用 server
    },
  }
}

/** 统一 JSON 响应。 */
function json(res, status, obj) {
  const s = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(s)
}

/** 构造一个指向 mock server 的 api（并让两个 region 都指向它）。 */
function apiFor(url, extra = {}) {
  return new RunningHubApi({ baseUrls: { cn: url, overseas: url }, retries: 0, ...extra })
}

/* ───────────────────────────── 纯函数：状态归一化 ───────────────────────────── */

test('normalizeStatus：闭集与别名', () => {
  assert.equal(normalizeStatus('CANCELLED'), STATUS.CANCEL)
  assert.equal(normalizeStatus('canceled'), STATUS.CANCEL)
  assert.equal(normalizeStatus('successful'), STATUS.SUCCESS)
  assert.equal(normalizeStatus('SUCCEED'), STATUS.SUCCESS)
  assert.equal(normalizeStatus('processing'), STATUS.RUNNING)
  assert.equal(normalizeStatus('PENDING'), STATUS.QUEUED)
  assert.equal(normalizeStatus('queue'), STATUS.QUEUED)
  assert.equal(normalizeStatus('CREATED'), STATUS.QUEUED)
  assert.equal(normalizeStatus('failure'), STATUS.FAILED)
  assert.equal(normalizeStatus(''), '')
  assert.equal(normalizeStatus(null), '')
  assert.equal(normalizeStatus('SOMETHING_NEW'), 'SOMETHING_NEW')
})

test('isTerminal / isSuccessCode / regionOfUrl / humanSize', () => {
  assert.equal(isTerminal('SUCCESS'), true)
  assert.equal(isTerminal('FAILED'), true)
  assert.equal(isTerminal('CANCELLED'), true)
  assert.equal(isTerminal('QUEUED'), false)
  assert.equal(isTerminal('RUNNING'), false)
  assert.equal(isSuccessCode(0), true)
  assert.equal(isSuccessCode(200), true, '已定策略：宽容接受 200（见文末 P1-c）')
  assert.equal(isSuccessCode(null), true)
  assert.equal(isSuccessCode(805), false)
  assert.equal(regionOfUrl('https://www.runninghub.cn'), 'cn')
  assert.equal(regionOfUrl('https://www.runninghub.ai/'), 'overseas')
  assert.equal(regionOfUrl('https://mirror.example.com'), null)
  assert.equal(humanSize(512), '512 B')
  assert.equal(humanSize(2048), '2.0 KB')
})

test('classifyBusiness：额度/鉴权/限流关键词优先于数值码', () => {
  assert.equal(classifyBusiness(999, '余额不足'), ERR.QUOTA)
  assert.equal(classifyBusiness(0, 'insufficient balance'), ERR.QUOTA)
  assert.equal(classifyBusiness(999, 'APIKEY_INVALID'), ERR.AUTH)
  assert.equal(classifyBusiness(401, ''), ERR.AUTH)
  assert.equal(classifyBusiness(429, ''), ERR.RATE_LIMIT)
  assert.equal(classifyBusiness(805, '任务执行失败'), ERR.BUSINESS)
  assert.equal(classifyBusiness(500, ''), ERR.SERVER)
  assert.equal(classifyBusiness(404, ''), ERR.BAD_REQUEST)
  for (const message of ['Balance node invalid parameter', 'coin index out of range', '积分节点缺少参数']) {
    assert.equal(classifyBusiness(null, message), ERR.BUSINESS)
  }
  assert.equal(classifyBusiness(null, 'quota exhausted'), ERR.QUOTA)
})

test('超限响应不解析；提交保持结果未知且不重投', async () => {
  let calls = 0
  const api = new RunningHubApi({ maxResponseBytes: 1024, retries: 2, fetchImpl: async () => {
    calls++
    return new Response(JSON.stringify({ code: 0, data: { taskId: 'already-created', padding: 'x'.repeat(2000) } }))
  } })
  const submit = await api.createTask('synthetic-key', 'cn', { workflowId: '1', nodeInfoList: [] })
  assert.equal(submit.ok, false)
  assert.equal(submit.error.code, ERR.TRANSPORT_UNCERTAIN)
  assert.equal(submit.error.uncertain, true)
  assert.equal(calls, 1)
  const query = await api.accountStatus('synthetic-key', 'cn')
  assert.equal(query.error.code, ERR.SERVER)
  assert.equal(calls, 2)
  await assert.rejects(api._readTextBounded({ text: async () => '中'.repeat(400) }), { code: 'RESPONSE_TOO_LARGE' })
})

test('classifyResponse：HTTP 401 / 429 / 5xx / 业务码 / 非 JSON 提交', () => {
  assert.equal(classifyResponse({ httpStatus: 401, json: {}, text: '{}' }).error.code, ERR.AUTH)
  assert.equal(classifyResponse({ httpStatus: 403, json: {}, text: '{}' }).error.code, ERR.AUTH)
  assert.equal(classifyResponse({ httpStatus: 429, json: {}, text: '{}' }).error.code, ERR.RATE_LIMIT)
  assert.equal(classifyResponse({ httpStatus: 503, json: {}, text: 'x' }).error.code, ERR.SERVER)
  const q = classifyResponse({ httpStatus: 200, json: { code: 402, msg: '余额不足' }, text: '' })
  assert.equal(q.error.code, ERR.QUOTA)
  const b = classifyResponse({ httpStatus: 200, json: { code: 1234, msg: '参数不对' }, text: '' })
  assert.equal(b.error.code, ERR.BUSINESS)
  assert.equal(b.error.bizCode, 1234)
  // 2xx + 非 JSON：提交类 = 结果不确定；查询类 = 服务端异常
  const u = classifyResponse({ httpStatus: 200, json: null, text: '<html>', submit: true })
  assert.equal(u.error.code, ERR.TRANSPORT_UNCERTAIN)
  assert.equal(u.error.uncertain, true)
  assert.equal(classifyResponse({ httpStatus: 200, json: null, text: '<html>' }).error.code, ERR.SERVER)
  // 2xx + code 0 = 成功
  const ok = classifyResponse({ httpStatus: 200, json: { code: 0, data: { a: 1 } }, text: '' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.data, { a: 1 })
  // 2xx + code 200 = 成功（宽容策略）；收紧要用 successCodes:[0]
  assert.equal(classifyResponse({ httpStatus: 200, json: { code: 200, data: {} }, text: '' }).ok, true)
  assert.equal(classifyResponse({ httpStatus: 200, json: { code: 200, data: {} }, text: '', successCodes: [0] }).ok, false)
})

test('maskKey 与 extractFailure', () => {
  assert.equal(maskKey('rh_1234567890abcd'), 'rh_1****abcd')
  assert.equal(maskKey('short'), 'sh****')
  assert.equal(maskKey(''), '（未设置）')
  assert.equal(
    extractFailure({ failedReason: { exception_message: 'OOM', node_name: 'KSampler' } }, ''),
    'OOM [node:KSampler]',
  )
  assert.equal(extractFailure(null, '直接失败'), '直接失败')
})

test('BASE_URLS 固定为官方两套基址', () => {
  assert.deepEqual(BASE_URLS, { cn: 'https://www.runninghub.cn', overseas: 'https://www.runninghub.ai' })
})

/* ───────────────────────────── 断点：accountStatus ───────────────────────────── */

test('accountStatus：POST /uc/openapi/accountStatus，body {apikey} + Bearer', async () => {
  const srv = await startServer((rec, res) => {
    json(res, 200, {
      code: 0,
      data: { remainCoins: '1234', remainMoney: '12.34', currency: 'CNY', currentTaskCounts: '2', apiType: 'NORMAL' },
    })
  })
  try {
    const api = apiFor(srv.url)
    const r = await api.accountStatus('rh_secret_key_0001', 'cn')
    assert.equal(r.ok, true)
    assert.equal(r.data.remainCoins, '1234')
    assert.equal(r.data.currentTaskCounts, '2')
    assert.equal(r.data.apiType, 'NORMAL')
    const c = srv.calls[0]
    assert.equal(c.method, 'POST')
    assert.equal(c.url, '/uc/openapi/accountStatus')
    assert.equal(c.headers.authorization, 'Bearer rh_secret_key_0001')
    assert.deepEqual(c.json, { apikey: 'rh_secret_key_0001' }) // 注意是 apikey（全小写），不是 apiKey
  } finally {
    await srv.close()
  }
})

test('accountStatus：code=200 默认算成功（宽容策略）；可收紧到官方原教旨 [0]', async () => {
  const srv = await startServer((rec, res) => json(res, 200, { code: 200, data: { remainCoins: '7' } }))
  try {
    const r = await apiFor(srv.url).accountStatus('k', 'cn')
    assert.equal(r.ok, true)
    assert.equal(r.data.remainCoins, '7')
    assert.equal(r.data.remainMoney, '', '缺失的余额字段留空，不补成 0（否则会被当成没钱）')
    // 收紧后 200 就是业务错误（官方错误码表里没有 200，收紧不会掩盖官方错误）
    const r2 = await apiFor(srv.url, { successCodes: [0] }).accountStatus('k', 'cn')
    assert.equal(r2.ok, false)
    assert.equal(r2.error.bizCode, 200)
  } finally {
    await srv.close()
  }
})

test('accountStatus：**无 code 字段**（v2 族）—— 有 status 交给调用方，只有 errorCode 才判请求级失败', async () => {
  const s = await startServer((rec, res, n) => {
    if (n === 1) return json(res, 200, { taskId: 'x', status: 'SUCCESS', errorCode: 0, errorMessage: '' })
    // 没有可识别的 status → 按 errorCode 判成请求级失败
    return json(res, 200, { errorCode: 1601, errorMessage: 'ApiKey verification failed' })
  })
  try {
    assert.equal((await apiFor(s.url).accountStatus('k', 'cn')).ok, true)
    const bad = await apiFor(s.url).accountStatus('k', 'cn')
    assert.equal(bad.ok, false)
    assert.equal(bad.error.bizCode, 1601)
    assert.equal(bad.error.code, ERR.AUTH)
  } finally {
    await s.close()
  }
})

test('accountStatus：401 → AUTH；余额不足 → QUOTA', async () => {
  const s1 = await startServer((rec, res) => json(res, 401, { code: 401, msg: 'APIKEY_INVALID' }))
  const s2 = await startServer((rec, res) => json(res, 200, { code: 812, msg: '账户余额不足，请充值' }))
  try {
    const a1 = await apiFor(s1.url).accountStatus('k', 'cn')
    assert.equal(a1.ok, false)
    assert.equal(a1.error.code, ERR.AUTH)
    const a2 = await apiFor(s2.url).accountStatus('k', 'cn')
    assert.equal(a2.ok, false)
    assert.equal(a2.error.code, ERR.QUOTA)
  } finally {
    await s1.close()
    await s2.close()
  }
})

/* ───────────────────────────── 断点：getWorkflowJson ───────────────────────────── */

test('getWorkflowJson：POST /api/openapi/getJsonApiFormat，data.prompt 字符串要 parse', async () => {
  const promptObj = { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'cat' }, _meta: { title: 'Prompt' } } }
  const srv = await startServer((rec, res) => json(res, 200, { code: 0, data: { prompt: JSON.stringify(promptObj) } }))
  try {
    const api = apiFor(srv.url)
    for (const input of ['1988', 'https://www.runninghub.cn/post/1988?inviteCode=test', 'https://runninghub.ai/ai-detail/1988/', 'https://www.runninghub.cn/workflow-detail/1988#nodes']) {
      const r = await api.getWorkflowJson('rh_key_abcd1234', 'cn', input)
      assert.equal(r.ok, true)
      assert.equal(r.workflowId, '1988')
      assert.deepEqual(r.workflow, promptObj)
      assert.equal(srv.calls.at(-1).json.workflowId, '1988')
    }
    for (const input of ['https://example.com/post/1988', 'https://runninghub.cn.evil.test/post/1988', 'https://runninghub.cn/?workflowId=1988']) {
      const r = await api.getWorkflowJson('k', 'cn', input)
      assert.equal(r.error.code, ERR.BAD_REQUEST)
    }
    assert.equal(srv.calls.length, 4, '错误地址不应请求 API')
    const c = srv.calls[0]
    assert.equal(c.url, '/api/openapi/getJsonApiFormat')
    assert.equal(c.json.apiKey, 'rh_key_abcd1234') // 这里是大写 I 的 apiKey
    assert.equal(c.json.workflowId, '1988')
    assert.equal(c.headers.authorization, 'Bearer rh_key_abcd1234')
  } finally {
    await srv.close()
  }
})

test('getWorkflowJson：data.prompt 已是对象也认；缺 prompt → BUSINESS', async () => {
  const s = await startServer((rec, res, n) => {
    if (n === 1) return json(res, 200, { code: 0, data: { prompt: { '1': { class_type: 'X', inputs: {} } } } })
    return json(res, 200, { code: 0, data: {} })
  })
  try {
    const api = apiFor(s.url)
    const a = await api.getWorkflowJson('k', 'cn', '1')
    assert.equal(a.ok, true)
    assert.equal(a.workflow['1'].class_type, 'X')
    const b = await api.getWorkflowJson('k', 'cn', '2')
    assert.equal(b.ok, false)
    assert.equal(b.error.code, ERR.BUSINESS)
  } finally {
    await s.close()
  }
})

/* ───────────────────────────── 断点：createTask ───────────────────────────── */

test('createTask：POST /task/openapi/create，字段名与 instanceType 小写', async () => {
  const srv = await startServer((rec, res) =>
    json(res, 200, { code: 0, data: { taskId: 'T-1', taskStatus: 'QUEUED' } }),
  )
  try {
    const api = apiFor(srv.url)
    const r = await api.createTask('rh_k_12345678', 'cn', {
      workflowId: '1988',
      nodeInfoList: [{ nodeId: '6', fieldName: 'text', fieldValue: 'a cat' }],
      instanceType: 'Ultra',
      addMetadata: true,
    })
    assert.equal(r.ok, true)
    assert.equal(r.taskId, 'T-1')
    assert.equal(r.taskStatus, 'QUEUED')
    const c = srv.calls[0]
    assert.equal(c.url, '/task/openapi/create')
    assert.equal(c.json.apiKey, 'rh_k_12345678')
    assert.equal(c.json.workflowId, '1988')
    assert.equal(c.json.addMetadata, true)
    assert.equal(c.json.instanceType, 'ultra') // 官方要小写
    assert.deepEqual(c.json.nodeInfoList, [{ nodeId: '6', fieldName: 'text', fieldValue: 'a cat' }])
  } finally {
    await srv.close()
  }
})

test('createTask：instanceType=default 时**不带**该字段', async () => {
  const srv = await startServer((rec, res) => json(res, 200, { code: 0, data: { taskId: 'T-2' } }))
  try {
    await apiFor(srv.url).createTask('k', 'cn', { workflowId: 'w', nodeInfoList: [], instanceType: 'default' })
    assert.equal('instanceType' in srv.calls[0].json, false)
  } finally {
    await srv.close()
  }
})

test('createTask：**提交类绝不自动重试**（连接被拒也只请求一次）', async () => {
  let hits = 0
  const srv = await startServer((rec, res) => {
    hits += 1
    res.destroy() // 直接掐断连接
  })
  try {
    const api = apiFor(srv.url, { retries: 5 })
    const r = await api.createTask('k', 'cn', { workflowId: 'w' })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, ERR.TRANSPORT_UNCERTAIN)
    assert.equal(r.error.uncertain, true)
    assert.equal(hits, 1, '提交类请求次数必须为 1')
  } finally {
    await srv.close()
  }
})

test('createTask：超时 → TRANSPORT_UNCERTAIN 且不重发', async () => {
  let hits = 0
  const srv = await startServer(() => {
    hits += 1
    /* 故意不响应，等客户端超时 */
  })
  try {
    const api = apiFor(srv.url, { timeoutMs: 150, retries: 3, submitTimeoutMs: 150 })
    const r = await api.createTask('k', 'cn', { workflowId: 'w' })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, ERR.TRANSPORT_UNCERTAIN)
    assert.equal(hits, 1)
  } finally {
    await srv.close()
  }
})

test('createTask：响应缺 taskId → TRANSPORT_UNCERTAIN（可能已扣费）', async () => {
  const srv = await startServer((rec, res) => json(res, 200, { code: 0, data: { foo: 'bar' } }))
  try {
    const r = await apiFor(srv.url).createTask('k', 'cn', { workflowId: 'w' })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, ERR.TRANSPORT_UNCERTAIN)
    assert.match(r.error.hint || '', /不要自动重发/)
  } finally {
    await srv.close()
  }
})

/* ───────────────────────────── 断点：查询 ───────────────────────────── */

test('queryStatus：data 为字符串状态', async () => {
  const srv = await startServer((rec, res) => json(res, 200, { code: 0, data: 'RUNNING' }))
  try {
    const r = await apiFor(srv.url).queryStatus('k', 'cn', 'T-1')
    assert.equal(r.ok, true)
    assert.equal(r.status, STATUS.RUNNING)
    assert.equal(srv.calls[0].url, '/task/openapi/status')
    assert.deepEqual(srv.calls[0].json, { apiKey: 'k', taskId: 'T-1' })
  } finally {
    await srv.close()
  }
})

test('queryOutputs：data 是数组 → SUCCESS + outputs', async () => {
  const outs = [{ fileUrl: 'https://x/1.png', fileType: 'png' }]
  const srv = await startServer((rec, res) => json(res, 200, { code: 0, data: outs }))
  try {
    const r = await apiFor(srv.url).queryOutputs('k', 'cn', 'T-1')
    assert.equal(r.ok, true)
    assert.equal(r.status, STATUS.SUCCESS)
    assert.deepEqual(r.outputs, outs)
    assert.equal(srv.calls[0].url, '/task/openapi/outputs')
  } finally {
    await srv.close()
  }
})

test('queryOutputs：data.taskStatus=FAILED → 带 failedReason', async () => {
  const srv = await startServer((rec, res) =>
    json(res, 200, {
      code: 0,
      data: { taskStatus: 'FAILED', failedReason: { exception_message: 'CUDA OOM', node_name: 'KSampler' } },
    }),
  )
  try {
    const r = await apiFor(srv.url).queryOutputs('k', 'cn', 'T-1')
    assert.equal(r.ok, true)
    assert.equal(r.status, STATUS.FAILED)
    assert.equal(r.failedReason, 'CUDA OOM [node:KSampler]')
  } finally {
    await srv.close()
  }
})

test('queryOutputs：code 805 = APIKEY_TASK_STATUS_ERROR → 任务失败（带 failedReason）', async () => {
  const srv = await startServer((rec, res) =>
    json(res, 200, {
      code: 805,
      msg: 'APIKEY_TASK_STATUS_ERROR',
      data: { failedReason: { exception_message: 'CUDA OOM', node_name: 'KSampler', node_id: '458', traceback: 'l1\nl2\nRuntimeError: CUDA OOM' } },
    }),
  )
  try {
    const r = await apiFor(srv.url).queryOutputs('k', 'cn', 'T-1')
    assert.equal(r.ok, true)
    assert.equal(r.status, STATUS.FAILED)
    assert.match(r.failedReason, /CUDA OOM/)
    assert.match(r.failedReason, /KSampler/)
  } finally {
    await srv.close()
  }
})

test('queryOutputs：官方业务码 804=RUNNING / 813=QUEUED（全 HTTP 200）', async () => {
  const srv = await startServer((rec, res, n) => {
    if (n === 1) return json(res, 200, { code: 804, msg: 'APIKEY_TASK_IS_RUNNING', data: { netWssUrl: 'wss://x/1' } })
    return json(res, 200, { code: 813, msg: 'APIKEY_TASK_IS_QUEUED', data: null })
  })
  try {
    const a = await apiFor(srv.url).queryOutputs('k', 'cn', 'T-1')
    assert.equal(a.ok, true)
    assert.equal(a.status, STATUS.RUNNING)
    assert.deepEqual(a.outputs, [])
    const b = await apiFor(srv.url).queryOutputs('k', 'cn', 'T-1')
    assert.equal(b.status, STATUS.QUEUED)
  } finally {
    await srv.close()
  }
})

test('queryOutputs：**无 code 字段**（v2 族）read status', async () => {
  const srv = await startServer((rec, res) => json(res, 200, { status: 'RUNNING', errorCode: 0 }))
  try {
    const r = await apiFor(srv.url).queryOutputs('k', 'cn', 'T-1')
    assert.equal(r.ok, true)
    assert.equal(r.status, STATUS.RUNNING)
  } finally {
    await srv.close()
  }
})

test('queryOutputs：code 0 + data 为空 → 仍在跑（不误判成功）', async () => {
  const srv = await startServer((rec, res) => json(res, 200, { code: 0, data: null }))
  try {
    const r = await apiFor(srv.url).queryOutputs('k', 'cn', 'T-1')
    assert.equal(r.ok, true)
    assert.equal(r.status, STATUS.RUNNING)
    assert.deepEqual(r.outputs, [])
  } finally {
    await srv.close()
  }
})

test('queryOutputs：401 → AUTH（让 KeyPool 换 key）', async () => {
  const srv = await startServer((rec, res) => json(res, 401, { code: 401, msg: 'APIKEY_INVALID' }))
  try {
    const r = await apiFor(srv.url).queryOutputs('k', 'cn', 'T-1')
    assert.equal(r.ok, false)
    assert.equal(r.error.code, ERR.AUTH)
  } finally {
    await srv.close()
  }
})

test('queryV2：POST /openapi/v2/query，Bearer + results（官方 schema：无 code，读 status）', async () => {
  const srv = await startServer((rec, res) =>
    json(res, 200, { taskId: 'T-9', status: 'SUCCESS', errorCode: 0, errorMessage: '', results: [{ url: 'https://x/a.png', outputType: 'png', text: '' }] }),
  )
  try {
    const r = await apiFor(srv.url).queryV2('rh_key_0001', 'cn', 'T-9')
    assert.equal(r.ok, true)
    assert.equal(r.status, STATUS.SUCCESS)
    assert.deepEqual(r.results, [{ url: 'https://x/a.png', outputType: 'png', text: '' }])
    const c = srv.calls[0]
    assert.equal(c.url, '/openapi/v2/query')
    assert.deepEqual(c.json, { taskId: 'T-9' }) // v2 只传 taskId
    assert.equal(c.headers.authorization, 'Bearer rh_key_0001')
  } finally {
    await srv.close()
  }
})

test('queryV2：errorCode!=0 即使 status 缺失也判失败', async () => {
  const srv = await startServer((rec, res) =>
    json(res, 200, { taskId: 'T-9', status: 'FAILED', errorCode: 1500, errorMessage: '工作流不存在', results: [] }),
  )
  try {
    const r = await apiFor(srv.url).queryV2('k', 'cn', 'T-9')
    assert.equal(r.ok, true)
    assert.equal(r.status, STATUS.FAILED)
    assert.match(r.failedReason, /工作流不存在/)
    assert.equal(r.errorCode, 1500)
  } finally {
    await srv.close()
  }
})

test('cancelTask：POST /task/openapi/cancel', async () => {
  const srv = await startServer((rec, res) => json(res, 200, { code: 0, data: null }))
  try {
    const r = await apiFor(srv.url).cancelTask('k', 'cn', 'T-3')
    assert.equal(r.ok, true)
    assert.equal(srv.calls[0].url, '/task/openapi/cancel')
    assert.deepEqual(srv.calls[0].json, { apiKey: 'k', taskId: 'T-3' })
  } finally {
    await srv.close()
  }
})

test('查询类**会**重试（429 → 第二次成功）', async () => {
  const srv = await startServer((rec, res, n) => {
    if (n === 1) return json(res, 429, { code: 429, msg: 'too many requests' })
    return json(res, 200, { code: 0, data: 'SUCCESS' })
  })
  try {
    const api = apiFor(srv.url, { retries: 2, sleepImpl: async () => {} })
    const r = await api.queryStatus('k', 'cn', 'T-1')
    assert.equal(r.ok, true)
    assert.equal(r.status, STATUS.SUCCESS)
    assert.equal(srv.calls.length, 2)
  } finally {
    await srv.close()
  }
})

/* ───────────────────────────── 断点：上传双接口回退 ───────────────────────────── */

test('uploadFile：新接口成功 → via=v2', async () => {
  const srv = await startServer((rec, res) => {
    if (rec.url === '/openapi/v2/media/upload/binary') {
      return json(res, 200, { code: 0, data: { filename: 'openapi/a.png', download_url: 'https://x/a.png' } })
    }
    return json(res, 500, { code: 1, msg: '不该走到这里' })
  })
  try {
    const r = await apiFor(srv.url).uploadFile('rh_key_0001', 'cn', new Uint8Array([1, 2, 3]), 'a.png', {
      fileType: 'image',
    })
    assert.equal(r.ok, true)
    assert.equal(r.fileName, 'openapi/a.png')
    assert.equal(r.via, 'v2')
    assert.equal(srv.calls.length, 1)
    assert.match(srv.calls[0].headers['content-type'], /^multipart\/form-data; boundary=/)
    assert.match(srv.calls[0].raw.toString('latin1'), /name="file"/)
    assert.equal(srv.calls[0].headers.authorization, 'Bearer rh_key_0001')
  } finally {
    await srv.close()
  }
})

test('uploadFile：新接口 809 体积超限 → **必须**回退旧接口成功', async () => {
  const srv = await startServer((rec, res) => {
    if (rec.url === '/openapi/v2/media/upload/binary') {
      return json(res, 200, { code: 809, msg: 'FILE_SIZE_EXCEEDED' })
    }
    return json(res, 200, { code: 0, data: { fileName: 'openapi/b.png' } })
  })
  try {
    const r = await apiFor(srv.url).uploadFile('rh_key_0001', 'cn', new Uint8Array([1, 2, 3, 4]), 'b.png', {
      fileType: 'image',
    })
    assert.equal(r.ok, true)
    assert.equal(r.via, 'legacy')
    assert.equal(r.fileName, 'openapi/b.png')
    assert.equal(srv.calls.length, 2)
    const legacy = srv.calls[1]
    assert.equal(legacy.url, '/task/openapi/upload')
    const latin = legacy.raw.toString('latin1')
    assert.match(latin, /name="apiKey"/)
    assert.match(latin, /name="fileType"/)
    assert.match(latin, /image/)
    assert.match(latin, /name="file"/)
    // multipart 头与文件字节之间必须有空行，否则服务端把文件魔数当 MIME 头解析
    assert.match(latin, /filename="b\.png"\r\nContent-Type:[^\r]*\r\n\r\n/)
  } finally {
    await srv.close()
  }
})

test('uploadFile：两边都失败 → UPLOAD_FAILED，两边错误都在', async () => {
  const srv = await startServer((rec, res) => {
    if (rec.url === '/openapi/v2/media/upload/binary') return json(res, 200, { code: 809, msg: 'too large' })
    return json(res, 500, { code: 500, msg: 'internal error' })
  })
  try {
    const r = await apiFor(srv.url).uploadFile('k', 'cn', new Uint8Array([1]), 'c.png')
    assert.equal(r.ok, false)
    assert.equal(r.error.code, ERR.UPLOAD_FAILED)
    assert.match(r.error.hint, /新接口/)
    assert.match(r.error.hint, /旧接口/)
    assert.match(r.error.message, /体积上限/)
    assert.equal(srv.calls.length, 2)
  } finally {
    await srv.close()
  }
})

test('uploadFile：新接口返回 code 0 + fileName 也认（旧形状）', async () => {
  const srv = await startServer((rec, res) => json(res, 200, { code: 0, data: { fileName: 'openapi/d.png' } }))
  try {
    const r = await apiFor(srv.url).uploadFile('k', 'cn', new Uint8Array([1]), 'd.png')
    assert.equal(r.ok, true)
    assert.equal(r.via, 'v2')
    assert.equal(r.fileName, 'openapi/d.png')
  } finally {
    await srv.close()
  }
})

test('uploadFile：新接口官方字段 data.filename + data.download_url', async () => {
  const srv = await startServer((rec, res) => {
    if (rec.url === '/openapi/v2/media/upload/binary') {
      // 官方示例形状：{code:0, message, data:{type, download_url, filename, size}}
      return json(res, 200, { code: 0, message: 'OK', data: { type: 'image', download_url: 'https://x/e.png', filename: 'openapi/e.png', size: 3 } })
    }
    return json(res, 500, { code: 1, msg: '不该走到这里' })
  })
  try {
    const r = await apiFor(srv.url).uploadFile('k', 'cn', new Uint8Array([1, 2, 3]), 'e.png')
    assert.equal(r.ok, true)
    assert.equal(r.via, 'v2')
    assert.equal(r.fileName, 'openapi/e.png')
    assert.equal(r.downloadUrl, 'https://x/e.png')
    assert.equal(srv.calls.length, 1)
  } finally {
    await srv.close()
  }
})

test('uploadFile：新接口官方错误形状 `code:401 + message`（注意是 message 不是 msg）→ AUTH', async () => {
  const srv = await startServer((rec, res) => {
    if (rec.url === '/openapi/v2/media/upload/binary') {
      return json(res, 200, { code: 401, message: 'ApiKey verification failed: API Key不存在' })
    }
    return json(res, 200, { code: 0, data: { fileName: 'openapi/f.png' } })
  })
  try {
    const r = await apiFor(srv.url).uploadFile('k', 'cn', new Uint8Array([1]), 'f.png')
    // v2 被拒 → 回退 legacy 成功
    assert.equal(r.ok, true)
    assert.equal(r.via, 'legacy')
    assert.equal(r.attempts[0].error.code, 'AUTH')
    assert.match(r.attempts[0].error.message, /ApiKey verification failed/)
  } finally {
    await srv.close()
  }
})

/* ───────────────────────────── 断点：下载 ───────────────────────────── */

test('downloadBytes：流式下载 + 字节上限', async () => {
  const srv = await startServer((rec, res) => {
    if (rec.url === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      return res.end(Buffer.alloc(4096, 7))
    }
    res.writeHead(200, { 'content-type': 'image/png' })
    res.end(Buffer.from([137, 80, 78, 71]))
  })
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-download-test-'))
  try {
    const api = apiFor(srv.url, { fetchImpl: (url, options) => fetch(url.replace('https://outputs.example', srv.url), options) })
    const a = await api.downloadBytes('https://outputs.example/small')
    assert.equal(a.ok, true)
    assert.equal(a.size, 4)
    assert.equal(a.contentType, 'image/png')
    assert.deepEqual(Array.from(a.bytes), [137, 80, 78, 71])
    const b = await api.downloadBytes('https://outputs.example/big', { maxBytes: 100 })
    assert.equal(b.ok, false)
    assert.match(b.error.message, /上限/)
    const file = path.join(tempDir, 'result.tmp')
    const saved = await api.downloadTo('https://outputs.example/small', file)
    assert.equal(saved.ok, true, JSON.stringify(saved))
    assert.deepEqual(await fs.readFile(file), Buffer.from([137, 80, 78, 71]))
    const partial = path.join(tempDir, 'too-big.tmp')
    assert.equal((await api.downloadTo('https://outputs.example/big', partial, { maxBytes: 100 })).ok, false)
    await assert.rejects(fs.stat(partial), { code: 'ENOENT' })
    let cancelled = false
    const streaming = new RunningHubApi({ fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(64)); controller.enqueue(new Uint8Array(200)) },
      cancel() { cancelled = true },
    })) })
    assert.equal((await streaming.downloadTo('https://outputs.example/stream', partial, { maxBytes: 100 })).ok, false)
    assert.equal(cancelled, true)
    await assert.rejects(fs.stat(partial), { code: 'ENOENT' })
    cancelled = false
    assert.equal((await streaming.downloadTo('https://outputs.example/stream', file)).ok, false, '已有文件不能被覆盖')
    assert.equal(cancelled, true, '打开目标失败仍应关闭响应流')
    assert.equal((await fs.readFile(file)).length, 4)
  } finally {
    await srv.close()
    await fs.rm(tempDir, { recursive: true, force: true })
  }
})

test('结果下载拒绝本机、特殊协议及重定向到内网，并复用宿主代理', async (t) => {
  const api = new RunningHubApi()
  for (const url of ['http://127.0.0.1/private', 'http://[::1]/private', 'http://2130706433/private', 'file:///private', 'http://localhost/private']) {
    const result = await api.downloadBytes(url)
    assert.equal(result.ok, false, url)
    assert.equal(result.error.code, ERR.BAD_REQUEST, JSON.stringify(result))
  }
  let calls = 0
  const redirected = new RunningHubApi({ fetchImpl: async () => {
    calls++
    return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/credentials' } })
  } })
  const result = await redirected.downloadBytes('https://outputs.example/image.png')
  assert.equal(result.error.code, ERR.BAD_REQUEST)
  assert.equal(calls, 1)
  const dispatcher = {}
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.dispatcher, dispatcher)
    assert.equal(options.redirect, 'manual')
    return new Response(new Uint8Array([7, 8]))
  })
  const proxyApi = new RunningHubApi({ proxyRouteFor: () => ({ proxied: true, dispatcher }) })
  assert.deepEqual((await proxyApi.downloadBytes('https://outputs.example/proxy')).bytes, new Uint8Array([7, 8]))
})

/* ───────────────────────────── 断点：其他 ───────────────────────────── */

/*
 * TUN 代理的 fake-IP 放行 —— 这是**放宽 SSRF 防护**的一个口子，
 * 所以放行条件必须被逐条钉死：多放一个域名、多放一个端口、
 * 或者让非 HTTPS 也能过，都是安全回归。
 */
test('★ fake-IP 放行只对该 CDN 的 HTTPS 默认端口生效', () => {
  const allow = (u) => allowsFakeIp(new URL(u))
  // 该放行的：唯一一个已知在 TUN 下会解析到 fake-IP 的结果 CDN
  assert.equal(allow('https://rh-images-tos.xiaoyaoyou.com/image.png'), true)
  assert.equal(allow('https://rh-images-tos.xiaoyaoyou.com/a/b/c.png?x=1'), true, '路径与查询串不影响判定')
  // 该拒绝的：协议 / 端口 / 域名，逐个维度都不能松
  assert.equal(allow('http://rh-images-tos.xiaoyaoyou.com/image.png'), false, '明文 HTTP 不放行')
  assert.equal(allow('https://rh-images-tos.xiaoyaoyou.com:8443/image.png'), false, '显式非默认端口不放行')
  // ⚠️ `:443` 会被 URL 规范化掉（`new URL(...).port === ''`），所以它**等价于缺省端口**，
  //    放行是对的。这里把这两个事实都钉住，免得后来人以为"写了端口就该拒"而误改判定。
  assert.equal(new URL('https://rh-images-tos.xiaoyaoyou.com:443/i.png').port, '', 'URL 会吃掉默认端口')
  assert.equal(allow('https://rh-images-tos.xiaoyaoyou.com:443/image.png'), true, ':443 等价于缺省端口')
  assert.equal(allow('https://evil-xiaoyaoyou.com/image.png'), false, '★ 不能是后缀匹配')
  assert.equal(allow('https://xrh-images-tos.xiaoyaoyou.com/image.png'), false, '★ 前缀拼接也不行')
  assert.equal(allow('https://a.xiaoyaoyou.com/image.png'), false, '子域不放行')
  assert.equal(allow('https://other.example/image.png'), false, '其它域名不放行')
  assert.equal(allow('https://127.0.0.1/image.png'), false, '本机地址不放行')
})

test('★ fake-IP 段判定：只有 198.18.0.0/15', () => {
  for (const ip of ['198.18.0.0', '198.18.0.1', '198.18.255.255', '198.19.0.1', '198.19.255.254']) {
    assert.equal(isFakeIpAddress(ip), true, ip + ' 属于 198.18.0.0/15')
  }
  for (const ip of ['198.17.0.1', '198.20.0.1', '198.51.100.1', '127.0.0.1', '10.0.0.1', '192.168.1.1', '169.254.169.254', '8.8.8.8', '::1', 'not-an-ip']) {
    assert.equal(isFakeIpAddress(ip), false, ip + ' 不该被当成 fake-IP')
  }
})

/* ── #4：放行名单 / 网段可配置，但匹配方式与安全约束不放宽 ── */

test('#4：默认放行名单覆盖 RH 官方结果域名，默认网段仍是 198.18.0.0/15', () => {
  assert.deepEqual([...DEFAULT_FAKE_IP_HOSTS].sort(), ['rh-images-1252422369.cos.ap-beijing.myqcloud.com', 'rh-images-tos.xiaoyaoyou.com', 'rh-images.xiaoyaoyou.com'])
  assert.deepEqual([...DEFAULT_FAKE_IP_RANGES], ['198.18.0.0/15'])
  const allow = (u) => allowsFakeIp(new URL(u))
  assert.equal(allow('https://rh-images.xiaoyaoyou.com/x/output/a.png'), true)
  assert.equal(allow('https://rh-images-1252422369.cos.ap-beijing.myqcloud.com/a.jpg'), true)
  assert.equal(allow('https://RH-IMAGES.xiaoyaoyou.com/a.png'), true, '主机名大小写不敏感（URL 本身会小写化）')
  assert.equal(allow('https://user:pw@rh-images.xiaoyaoyou.com/a.png'), false, '带账号密码不放行')
  assert.equal(allow('https://rh-images.xiaoyaoyou.com.evil.example/a.png'), false, '★ 不能是前缀匹配')
})

test('#4：fakeIpHosts 只追加精确主机名；非法条目（通配 / IP / 端口 / 协议）被丢弃', () => {
  const policy = buildFakeIpPolicy({ hosts: ['videos.runninghub.example', '*.xiaoyaoyou.com', '198.18.0.9', 'cdn.example:8443', 'https://x.example', 'single'] })
  assert.equal(allowsFakeIp(new URL('https://videos.runninghub.example/v.mp4'), policy), true)
  assert.equal(allowsFakeIp(new URL('https://a.videos.runninghub.example/v.mp4'), policy), false, '★ 追加的域名同样不做后缀匹配')
  assert.equal(allowsFakeIp(new URL('https://rh-images.xiaoyaoyou.com/a.png'), policy), true, '默认名单仍在')
  assert.equal(allowsFakeIp(new URL('http://videos.runninghub.example/v.mp4'), policy), false, '仍然只认 HTTPS')
  assert.equal(allowsFakeIp(new URL('https://videos.runninghub.example:8443/v.mp4'), policy), false, '仍然不认显式端口')
  assert.deepEqual(policy.rejected, ['host:*.xiaoyaoyou.com', 'host:198.18.0.9', 'host:cdn.example:8443', 'host:https://x.example', 'host:single'])
  assert.equal(normalizeFakeIpHost('CDN.Example.COM.'), 'cdn.example.com')
})

test('#4：fakeIpRanges 可替换默认网段，但绝不允许覆盖本机 / 元数据 / 组播段', () => {
  const policy = buildFakeIpPolicy({ ranges: ['28.0.0.0/8'] })
  assert.equal(isFakeIpAddress('28.1.2.3', policy), true)
  assert.equal(isFakeIpAddress('198.18.0.1', policy), false, '给了自定义网段就替换默认值')
  assert.equal(isFakeIpAddress('198.18.0.1'), true, '默认策略不受影响')
  for (const bad of ['127.0.0.0/8', '0.0.0.0/8', '169.254.0.0/16', '169.254.169.254/32', '224.0.0.0/4', '240.0.0.0/8', '0.0.0.0/0', '10.0.0.0/7', '10.0.0.0/8', '10.8.0.0/16', '172.16.0.0/12', '172.20.0.0/16', '192.168.0.0/16', '192.168.1.0/24', '198.18.1.0/15', '::1/128', 'nope', '1.2.3.4/33']) {
    assert.equal(parseFakeIpRange(bad), null, bad + ' 必须被拒')
  }
  assert.notEqual(parseFakeIpRange('100.64.0.0/10'), null, '100.64/10 有真实的 fake-IP 用法，保留')
  assert.deepEqual(parseFakeIpRange(' 198.18.0.0/15 '), { base: (198 << 24 | 18 << 16) >>> 0, bits: 15, text: '198.18.0.0/15' })
  const fallback = buildFakeIpPolicy({ ranges: ['127.0.0.0/8'] })
  assert.equal(isFakeIpAddress('198.19.0.1', fallback), true, '全部非法 → 退回默认段')
  assert.deepEqual(fallback.rejected, ['range:127.0.0.0/8'])
})

test('#4：被拒时错误信息写明主机名与解析地址，并给出该改哪项设置', () => {
  const policy = buildFakeIpPolicy()
  const notListed = filterResolvedAddresses('video-cdn.example', [{ address: '198.18.3.4', family: 4 }], false, policy)
  assert.equal(notListed.ok, false)
  assert.match(notListed.error.message, /video-cdn\.example/)
  assert.match(notListed.error.message, /198\.18\.3\.4/)
  assert.match(notListed.error.hint, /fakeIpHosts/)

  // 代理改过 fake-ip-range（如 CGNAT 段 100.64.0.0/10）：主机在名单里但网段不对 → 提示改 fakeIpRanges
  const otherRange = filterResolvedAddresses('rh-images.xiaoyaoyou.com', [{ address: '100.100.0.7', family: 4 }], true, policy)
  assert.equal(otherRange.ok, false)
  assert.match(otherRange.error.hint, /fakeIpRanges/)

  const custom = buildFakeIpPolicy({ ranges: ['100.64.0.0/10'] })
  assert.equal(filterResolvedAddresses('rh-images.xiaoyaoyou.com', [{ address: '100.100.0.7', family: 4 }], true, custom).ok, true)
  assert.equal(filterResolvedAddresses('other.example', [{ address: '100.100.0.7', family: 4 }], false, custom).ok, false, '名单外主机仍然拒')
  assert.equal(filterResolvedAddresses('rh-images.xiaoyaoyou.com', [{ address: '127.0.0.1', family: 4 }], true, custom).ok, false, '本机地址任何时候都拒')
  assert.match(filterResolvedAddresses('x.example', [{ address: '10.0.0.5', family: 4 }], false, policy).error.hint, /内网/)
  assert.equal(filterResolvedAddresses('x.example', [{ address: '8.8.8.8', family: 4 }], false, policy).ok, true)
})

test('#4：RunningHubApi 接受 fakeIpHosts / fakeIpRanges 配置，非法项告警而不是崩溃', () => {
  const warns = []
  const api = new RunningHubApi({ fakeIpHosts: ['videos.runninghub.example', 'bad host'], fakeIpRanges: ['28.0.0.0/8'], logger: { warn: (m) => warns.push(String(m)) } })
  assert.equal(api.fakeIpPolicy.hosts.has('videos.runninghub.example'), true)
  assert.equal(isFakeIpAddress('28.9.9.9', api.fakeIpPolicy), true)
  assert.ok(warns.some((w) => w.includes('bad host')))
})

test('非该 CDN 的地址解析到 fake-IP 仍被拒绝下载', async () => {
  // 端到端确认放行开关**没有**泄漏到其它域名：走真实 DNS 解析路径，
  // `localhost` 会解析到环回地址，必须照旧拒绝（放行开关为 false 时不看 198.18/19 段）。
  const api = new RunningHubApi()
  for (const url of ['http://198.18.0.1/private', 'https://198.19.0.1/private']) {
    const result = await api.downloadBytes(url)
    assert.equal(result.ok, false, url + ' 必须被拒')
    assert.equal(result.error.code, ERR.BAD_REQUEST, JSON.stringify(result))
  }
})

test('pricePreview：POST /openapi/v2/price-preview/<modelPath>，读 errorCode 判成败', async () => {
  const srv = await startServer((rec, res) =>
    json(res, 200, {
      errorCode: 0,
      errorMessage: '',
      estimatedPrice: 0.35,
      currency: 'CNY',
      priceText: '0.35 元',
      priceTextEn: '0.35 CNY',
      freeLimit: true,
      freeLimitCount: 100,
      remainingFreeLimitCount: 97,
      isFreeThisCall: false,
    }),
  )
  try {
    const r = await apiFor(srv.url).pricePreview('rh_key_0001', 'cn', {
      modelPath: '/rhart-image-g/image-to-image',
      payload: { prompt: 'a cat' },
    })
    assert.equal(r.ok, true, JSON.stringify(r.error || {}))
    assert.equal(r.estimatedPrice, 0.35)
    assert.equal(r.currency, 'CNY')
    assert.equal(r.priceText, '0.35 元')
    assert.equal(r.freeLimit, true)
    assert.equal(r.remainingFreeLimitCount, 97)
    assert.equal(r.isFreeThisCall, false)
    const c = srv.calls[0]
    assert.equal(c.method, 'POST')
    assert.equal(c.url, '/openapi/v2/price-preview/rhart-image-g/image-to-image', '前导斜杠要去掉，不能出现 //')
    assert.equal(c.headers.authorization, 'Bearer rh_key_0001')
    assert.deepEqual(c.json, { prompt: 'a cat' }, '参数要原样透传（官方：使用和发起任务相同的参数）')
  } finally {
    await srv.close()
  }
})

test('pricePreview：**绝不抛**，拿不到价 → NOT_AVAILABLE（不阻断用户干活）', async () => {
  // ① 没给 modelPath → 一个请求都不发
  const srv = await startServer((rec, res) => json(res, 200, { errorCode: 0 }))
  try {
    const r0 = await apiFor(srv.url).pricePreview('k', 'cn', {})
    assert.equal(r0.ok, false)
    assert.equal(r0.error.code, 'NOT_AVAILABLE')
    assert.equal(srv.calls.length, 0, '参数不全时不该发请求')
  } finally {
    await srv.close()
  }

  // ② 模型路径不存在（errorCode != 0）→ NOT_AVAILABLE，带原始 cause/bizCode
  const bad = await startServer((rec, res) => json(res, 200, { errorCode: 1404, errorMessage: '模型不存在' }))
  try {
    const r = await apiFor(bad.url).pricePreview('k', 'cn', { modelPath: 'nope/nope' })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'NOT_AVAILABLE')
    assert.equal(r.error.bizCode, 1404)
    assert.match(r.error.message, /模型不存在/)
    assert.match(r.error.hint, /报价失败不影响运行/)
  } finally {
    await bad.close()
  }

  // ③ 端点直接 404 → 也是 NOT_AVAILABLE（不抛）
  const gone = await startServer((rec, res) => json(res, 404, { message: 'Not Found' }))
  try {
    const r = await apiFor(gone.url).pricePreview('k', 'cn', { modelPath: 'x/y' })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'NOT_AVAILABLE')
  } finally {
    await gone.close()
  }

  // ④ 网络断了也不能抛
  const dead = await startServer((rec, res) => res.destroy())
  try {
    const r = await apiFor(dead.url).pricePreview('k', 'cn', { modelPath: 'x/y' })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'NOT_AVAILABLE')
  } finally {
    await dead.close()
  }

  // ⑤ AUTH 原样保留（用户必须去处理 key，不能被"价格未知"盖住）
  const auth = await startServer((rec, res) => json(res, 401, { code: 802, msg: 'APIKEY_INVALID' }))
  try {
    const r = await apiFor(auth.url).pricePreview('k', 'cn', { modelPath: 'x/y' })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, ERR.AUTH)
  } finally {
    await auth.close()
  }
})

test('queueStatus：**GET** /openapi/v2/queue/status（不是 POST），counts 转成 number', async () => {
  const srv = await startServer((rec, res) =>
    json(res, 200, {
      code: 0,
      msg: 'success',
      data: { apiKeyType: 'EXCLUSIVE', concurrentLimit: 3, runningCount: '1', queuedCount: '2', totalCurrentTasks: '3' },
    }),
  )
  try {
    const r = await apiFor(srv.url).queueStatus('rh_key_0001', 'cn')
    assert.equal(r.ok, true, JSON.stringify(r.error || {}))
    assert.equal(r.apiKeyType, 'EXCLUSIVE')
    assert.equal(r.concurrentLimit, 3)
    assert.equal(r.runningCount, 1, 'schema 里是 string，要转 number')
    assert.equal(r.queuedCount, 2)
    assert.equal(r.totalCurrentTasks, 3)
    const c = srv.calls[0]
    assert.equal(c.method, 'GET', '必须是 GET')
    assert.equal(c.url, '/openapi/v2/queue/status')
    assert.equal(c.headers.authorization, 'Bearer rh_key_0001')
    assert.equal(c.text, '', 'GET 不该带 body')
    assert.deepEqual(JSON.parse(JSON.stringify(r)), r)
  } finally {
    await srv.close()
  }
})

test('queueStatus：401 → AUTH（可判可换 key）', async () => {
  const srv = await startServer((rec, res) => json(res, 401, { code: 802, msg: 'APIKEY_INVALID' }))
  try {
    const r = await apiFor(srv.url).queueStatus('k', 'cn')
    assert.equal(r.ok, false)
    assert.equal(r.error.code, ERR.AUTH)
  } finally {
    await srv.close()
  }
})

test('listApiKeys：GET /openapi/v2/api-key/list，且返回值里的 key 再过一遍掩码', async () => {
  const srv = await startServer((rec, res) =>
    json(res, 200, {
      code: 0,
      data: [
        { key: '46eb********06340', apiKeyName: '主号', status: 1, quotaLimit: null, quotaUsed: 12, visible: true, expireAt: null, expireInMinute: null, createdAt: '2026-01-01' },
      ],
    }),
  )
  try {
    const r = await apiFor(srv.url).listApiKeys('k', 'cn')
    assert.equal(r.ok, true)
    assert.equal(r.keys.length, 1)
    assert.equal(r.keys[0].key, '46eb********06340')
    assert.equal(r.keys[0].apiKeyName, '主号')
    assert.equal(r.keys[0].quotaUsed, 12)
    assert.equal(srv.calls[0].method, 'GET')
    assert.equal(srv.calls[0].url, '/openapi/v2/api-key/list')
    // 万一上游没脱敏，也必须被我们再掩一次
    const leaky = await startServer((rec, res) => json(res, 200, { code: 0, data: [{ key: 'rh_LEAKED_SECRET_abcdef123456' }] }))
    try {
      const r2 = await apiFor(leaky.url).listApiKeys('k', 'cn')
      assert.equal(JSON.stringify(r2).includes('rh_LEAKED_SECRET_abcdef123456'), false, '上游没脱敏时我们必须兜住')
    } finally {
      await leaky.close()
    }
  } finally {
    await srv.close()
  }
})

test('region 可用基址字符串覆盖（自建代理场景）', () => {
  const api = new RunningHubApi({ baseUrls: { cn: 'http://127.0.0.1:1/' } })
  assert.equal(api.baseUrlFor('cn'), 'http://127.0.0.1:1')
  assert.equal(api.baseUrlFor('https://my.proxy/x/'), 'https://my.proxy/x')
  assert.deepEqual(api.bases, { cn: 'http://127.0.0.1:1', overseas: BASE_URLS.overseas })
})

test('返回值里绝不出现明文 key（日志与错误回执）', async () => {
  const seen = []
  const secret = 'rh_SUPER_SECRET_abcdef123456'
  const srv = await startServer((rec, res) => json(res, 500, { code: 500, msg: 'boom ' + secret }))
  try {
    const api = apiFor(srv.url, {
      logger: {
        info: (...a) => seen.push(JSON.stringify(a)),
        warn: (...a) => seen.push(JSON.stringify(a)),
        error: (...a) => seen.push(JSON.stringify(a)),
        debug: (...a) => seen.push(JSON.stringify(a)),
      },
    })
    await api.createTask(secret, 'cn', { workflowId: 'w' })
    assert.equal(seen.some((s) => s.includes(secret)), false, '日志里出现了明文 key')
    assert.equal(seen.some((s) => s.includes('rh_S****3456')), true, '日志里应出现掩码')
  } finally {
    await srv.close()
  }
})

test('所有失败回执都是 lossless JSON（无 undefined 值）', async () => {
  const srv = await startServer((rec, res) => json(res, 200, { code: 1234, msg: '' }))
  try {
    const r = await apiFor(srv.url).getWorkflowJson('k', 'cn', 'w')
    assert.equal(r.ok, false)
    const roundTrip = JSON.parse(JSON.stringify(r))
    assert.deepEqual(roundTrip, r)
  } finally {
    await srv.close()
  }
})

/* ═══════════════════════════════════════════════════════════════════════════
 * 官方文档锁定区
 *
 * 证据来源：RunningHub 官方 API 文档（https://www.runninghub.cn/runninghub-api-doc-cn ，
 * 40 个官方文档页逐字段核对）。**冲突时以官方文档为准**。
 *
 * 锁定条款（每条都有上面的测试对着锁）：
 *   O1. `POST /uc/openapi/accountStatus` 的 body 字段是 **`apikey`（全小写）**，不是 `apiKey`；
 *       同一请求的 header 仍是 `Authorization: Bearer <key>`。
 *   O2. `instanceType` 官方 enum 是 **小写 `default|plus|ultra`**（24G/48G/84G）。
 *       参照实现 RHStudio2 的 `Standard/Plus/Ultra` **没有官方依据**，不采用。
 *   O3. 成功码 **只有 `0`**（官方原文「0 成功，非0失败」）。
 *       `runninghub_client.py` 的「新接口 200」实测注释与官方冲突 → 按官方只认 0，
 *       需要时用 `new RunningHubApi({ successCodes: [0,200] })` 一行兼容。
 *   O4. `/openapi/v2/**` 的**提交族 / `query` / `price-preview`** 响应里**根本没有 `code`**，
 *       成败读 `status` / `errorCode`；只有 `media/upload/binary` 和三个管理端点有 `code`。
 *       因此 `pickBizCode()` **只读 `code`**，不把 `status` 当数字码。
 *   O5. 上传接口的官方错误字段是 **`message`**（不是 `msg`）——`pickMessage()` 两个都认。
 *   O6. `/task/openapi/outputs` 用业务码表达状态（全 HTTP 200）：
 *       `0`=成功(data[]) · `804`=APIKEY_TASK_IS_RUNNING · `813`=APIKEY_TASK_IS_QUEUED · `805`=APIKEY_TASK_STATUS_ERROR。
 *   O7. `failedReason` 官方字段：`current_outputs/exception_type/node_name/current_inputs/traceback/node_id/exception_message`。
 *   O8. `data.prompt` 是**字符串**（schema `{"type":"string"}`），要 `JSON.parse`（O 项已有测试）。
 *   O9. v2 状态 enum 只有 `QUEUED|RUNNING|SUCCESS|FAILED`（**没有 `CREATE`**）；
 *       `create`/`ai-app/run` 的 `data.taskStatus` 是 `CREATE|SUCCESS|FAILED|RUNNING|QUEUED`。
 *       `normalizeStatus()` 两族都覆盖。
 *   O10. `taskId` 在官方 schema 里**不是 required**，但每个官方示例都传 → 我们始终传。
 *   O11. 官方明确：`control_after_generate` 是**纯前端**字段（API 格式里找不到）→
 *        `workflow.mjs` 的 `alignWidgets()` 必须跳过它（已在 workflow.test.mjs 锁定）。
 *   O12. 官方明确：API 会**强制重置 `seed`**，要保 seed 必须放进 `nodeInfoList`。
 * ═══════════════════════════════════════════════════════════════════════════ */

test('O1 锁定：accountStatus body 字段是 apikey（全小写）+ Bearer header', async () => {
  const srv = await startServer((rec, res) => json(res, 200, { code: 0, data: {} }))
  try {
    await apiFor(srv.url).accountStatus('rh_key_0001', 'cn')
    const c = srv.calls[0]
    assert.deepEqual(Object.keys(c.json), ['apikey'])
    assert.equal(c.json.apiKey, undefined, '官方 schema 里没有 apiKey 这个字段')
    assert.equal(c.headers.authorization, 'Bearer rh_key_0001')
  } finally {
    await srv.close()
  }
})

test('O2 锁定：instanceType 官方 enum 是小写 default/plus/ultra', async () => {
  const seen = []
  const srv = await startServer((rec, res) => {
    seen.push(rec.json && rec.json.instanceType)
    return json(res, 200, { code: 0, data: { taskId: 'T' } })
  })
  try {
    const api = apiFor(srv.url)
    for (const t of ['default', 'plus', 'ultra', 'PLUS']) {
      await api.createTask('k', 'cn', { workflowId: 'w', instanceType: t })
    }
    assert.deepEqual(seen, [undefined, 'plus', 'ultra', 'plus'])
    for (const v of seen) {
      if (v !== undefined) assert.ok(['default', 'plus', 'ultra'].includes(v), 'instanceType 必须小写且属于官方 enum')
    }
  } finally {
    await srv.close()
  }
})

test('O3/O4 锁定：成功码 [0,200]（宽容策略）；无 code 时读 errorCode', () => {
  assert.deepEqual(SUCCESS_CODES, [0, 200])
  assert.equal(isSuccessCode(0), true)
  assert.equal(isSuccessCode(null), true)
  assert.equal(isSuccessCode(200), true)
  // 无 code + **可识别 status** → 判读权交给调用方（task 级状态，不当作请求失败）
  const taskFailed = classifyResponse({ httpStatus: 200, json: { status: 'FAILED', errorCode: 804, errorMessage: 'x' }, text: '' })
  assert.equal(taskFailed.ok, true, 'task 级 FAILED 由 queryV2/queryOutputs 解释，不是请求级错误')
  assert.equal(classifyResponse({ httpStatus: 200, json: { status: 'SUCCESS', errorCode: 0 }, text: '' }).ok, true)
  // 无 code + **无可识别 status** + errorCode!=0 → 请求级失败
  const reqFailed = classifyResponse({ httpStatus: 200, json: { errorCode: 1601, errorMessage: 'ApiKey verification failed' }, text: '' })
  assert.equal(reqFailed.ok, false)
  assert.equal(reqFailed.error.bizCode, 1601)
  // status 不会被误读成数字业务码
  const running = classifyResponse({ httpStatus: 200, json: { status: 'RUNNING' }, text: '' })
  assert.equal(running.ok, true)
})

test('O5 锁定：上传错误字段是 message（也兼容 msg）', async () => {
  const srv = await startServer((rec, res, n) => {
    if (rec.url.includes('/openapi/v2/media/upload/binary')) {
      return json(res, 200, n === 1 ? { code: 500, message: 'from-message' } : { code: 500, msg: 'from-msg' })
    }
    return json(res, 500, { code: 500, msg: 'legacy fail' })
  })
  try {
    const api = apiFor(srv.url)
    const a = await api.uploadBinary('k', 'cn', new Uint8Array([1]), 'a.png')
    assert.equal(a.ok, false)
    assert.equal(a.error.message, 'from-message')
    const b = await api.uploadBinary('k', 'cn', new Uint8Array([1]), 'a.png')
    assert.equal(b.error.message, 'from-msg')
  } finally {
    await srv.close()
  }
})

test('O7 锁定：failedReason 的官方字段都能读出来', () => {
  const s = extractFailure(
    {
      failedReason: {
        current_outputs: [],
        exception_type: 'RuntimeError',
        node_name: 'KSampler',
        node_id: '458',
        current_inputs: {},
        traceback: 'Traceback...\nRuntimeError: CUDA out of memory',
        exception_message: 'CUDA out of memory',
      },
    },
    '',
  )
  assert.match(s, /CUDA out of memory/)
  assert.match(s, /RuntimeError/)
  assert.match(s, /KSampler/)
  assert.match(s, /458/)
})

test('O9 锁定：两族状态 enum 都能归一化', () => {
  // v2 族：QUEUED|RUNNING|SUCCESS|FAILED
  for (const s of ['QUEUED', 'RUNNING', 'SUCCESS', 'FAILED']) assert.equal(normalizeStatus(s), s)
  // create/ai-app 族：多一个 CREATE
  assert.equal(normalizeStatus('CREATE'), STATUS.CREATE)
  assert.equal(normalizeStatus('CREATE') !== normalizeStatus('QUEUED'), true)
})

/* ═══════════════════════════════════════════════════════════════════════════
 * 官方文档核验修复锁定区
 * ═══════════════════════════════════════════════════════════════════════════ */

test('P0 锁定：`APIKEY_*` 业务标识**绝不**被判成 AUTH（会把健康 key 永久标失效）', () => {
  // 官方 doc-8287338 的 11 个 APIKEY_* 标识，逐条喂进去
  const cases = [
    [803, 'APIKEY_INVALID_NODE_INFO', ERR.BUSINESS],
    [809, 'APIKEY_FILE_SIZE_EXCEEDED', ERR.BUSINESS],
    [807, 'APIKEY_TASK_NOT_FOUND', ERR.BUSINESS],
    [804, 'APIKEY_TASK_IS_RUNNING', ERR.BUSINESS],
    [805, 'APIKEY_TASK_STATUS_ERROR', ERR.BUSINESS],
    [808, 'APIKEY_UPLOAD_FAILED', ERR.BUSINESS],
    [813, 'APIKEY_TASK_IS_QUEUED', ERR.BUSINESS],
  ]
  for (const [code, id, expect] of cases) {
    assert.equal(classifyBusiness(code, id), expect, id + ' 应为 ' + expect)
  }
  // 真正表达"这把 key 不认"的官方码，仍然必须是 AUTH
  for (const code of [801, 802, 811, 1002, 1014]) {
    assert.equal(classifyBusiness(code, 'whatever'), ERR.AUTH, String(code) + ' 应为 AUTH')
  }
  // `apikey_invalid\b` 用词边界锚定：精确标识命中，带后缀的不命中
  assert.equal(classifyBusiness(null, 'APIKEY_INVALID'), ERR.AUTH)
  assert.equal(classifyBusiness(null, 'APIKEY_INVALID_NODE_INFO'), ERR.BUSINESS)
  assert.equal(classifyBusiness(null, 'ApiKey verification failed: API Key不存在'), ERR.AUTH)
})

test('P0 端到端：createTask 返回 803 时**不会**让 KeyPool 标失效', async () => {
  const srv = await startServer((rec, res) =>
    json(res, 200, { code: 803, msg: 'APIKEY_INVALID_NODE_INFO', data: null }),
  )
  try {
    const r = await apiFor(srv.url).createTask('rh_healthy_key_0001', 'cn', { workflowId: 'w' })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, ERR.BUSINESS)
    assert.match(r.error.hint, /nodeInfoList/)
    assert.notEqual(r.error.code, ERR.AUTH)
  } finally {
    await srv.close()
  }
})

test('P1-a 锁定：416 not_enough_wallet → QUOTA（下划线形态也要认）', () => {
  assert.equal(classifyBusiness(416, 'TASK_CREATE_FAILED_BY_NOT_ENOUGH_WALLET'), ERR.QUOTA)
  assert.equal(classifyBusiness(812, ''), ERR.QUOTA)
  assert.equal(classifyBusiness(null, 'not_enough_balance'), ERR.QUOTA)
  assert.equal(classifyBusiness(null, 'not enough'), ERR.BUSINESS, '没有余额语义的消息不能冷却 Key')
  assert.equal(classifyBusiness(null, '钱包余额不足'), ERR.QUOTA)
})

test('P1-b 锁定：1005/1010/1012 系统内部错误 → SERVER（查询类该重试的必须重试）', () => {
  assert.equal(classifyBusiness(1005, 'Internal server error, please retry later'), ERR.SERVER)
  assert.equal(classifyBusiness(1010, '服务暂不可用'), ERR.SERVER)
  assert.equal(classifyBusiness(1012, '上游服务响应异常'), ERR.SERVER)
  assert.equal(classifyBusiness(500, ''), ERR.SERVER)
  for (const c of [1005, 1010, 1012, 500]) assert.equal(isRetryable(classifyBusiness(c, '')), true, String(c) + ' 应可重试')
})

test('P2 锁定：415 TASK_INSTANCE_MAXED 是资源等待（可重试），不是坏请求', () => {
  assert.equal(classifyBusiness(415, 'TASK_INSTANCE_MAXED'), ERR.CAPACITY)
  assert.equal(isRetryable(ERR.CAPACITY), true)
  assert.match(hintForCode(415), /30–120|30-120/)
})

test('#3：1520 / 415 归为 CAPACITY（容量已满），不再与 Key 限流（RATE_LIMIT）混用', () => {
  assert.equal(classifyBusiness(1520, '单用户并发任务数已达上限'), ERR.CAPACITY)
  assert.equal(classifyBusiness(415, ''), ERR.CAPACITY)
  // 官方 421 TASK_QUEUE_MAXED 原文「共享型 API 并发上限，请自行排队」→ 同属容量问题
  assert.equal(classifyBusiness(421, 'TASK_QUEUE_MAXED'), ERR.CAPACITY)
  // 真正的 Key 限流（1003「请降低请求速度」）仍是 RATE_LIMIT
  assert.equal(classifyBusiness(1003, ''), ERR.RATE_LIMIT)
  assert.match(hintForCode(1520), /本地排队/)
  assert.match(hintForCode(415), /key 本身没问题/)
})

test('#3：提交返回 1520 → classifyResponse 给出 CAPACITY + 官方码', () => {
  const r = classifyResponse({ httpStatus: 200, json: { code: 1520, msg: 'TASK_USER_CONCURRENT_LIMIT' }, text: '', submit: true })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, ERR.CAPACITY)
  assert.equal(r.error.bizCode, 1520)
  assert.notEqual(r.error.uncertain, true, '明确的业务码不是「结果不确定」')
})

test('P2 锁定：301/380/412/433/1007/1009 → BAD_REQUEST；官方码表覆盖完整', () => {
  for (const c of [301, 380, 412, 433, 1007, 1009]) {
    assert.equal(classifyBusiness(c, ''), ERR.BAD_REQUEST, String(c) + ' 应为 BAD_REQUEST')
  }
  // 表里每个 code 都能给出稳定分类
  for (const [codeStr, expect] of Object.entries(CODE_TABLE)) {
    assert.equal(classifyBusiness(Number(codeStr), ''), expect, 'CODE_TABLE[' + codeStr + ']')
  }
  assert.match(hintForCode(809), /体积|压缩/)
  assert.equal(hintForCode(99999), '')
})

test('P1-c 锁定：默认 successCodes 是 [0,200]（已定的宽容策略）', () => {
  assert.deepEqual(SUCCESS_CODES, [0, 200])
  assert.equal(isSuccessCode(0), true)
  assert.equal(isSuccessCode(200), true)
  assert.equal(isSuccessCode(803), false)
  // 仍可收紧到官方原教旨
  assert.equal(isSuccessCode(200, [0]), false)
  assert.equal(classifyResponse({ httpStatus: 200, json: { code: 200, data: { a: 1 } }, text: '' }).ok, true)
  assert.equal(classifyResponse({ httpStatus: 200, json: { code: 200, data: {} }, text: '', successCodes: [0] }).ok, false)
})

test('P2-4 锁定：instanceType 归一化 + 白名单（脏值不发给服务端）', () => {
  assert.deepEqual(INSTANCE_TYPES, ['default', 'plus', 'ultra'])
  assert.deepEqual(normalizeInstanceType('Plus'), { ok: true, value: 'plus' })
  assert.deepEqual(normalizeInstanceType('ULTRA'), { ok: true, value: 'ultra' })
  assert.deepEqual(normalizeInstanceType('Standard'), { ok: true, value: 'default' }, '参照实现的别名要翻')
  assert.deepEqual(normalizeInstanceType(''), { ok: true, value: 'default' })
  assert.deepEqual(normalizeInstanceType(undefined), { ok: true, value: 'default' })
  const bad = normalizeInstanceType('supercomputer')
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, ERR.BAD_REQUEST)
  assert.match(bad.error.hint, /default \/ plus \/ ultra/)
})

test('P2-4 端到端：createTask 收到脏 instanceType 直接拒，不发请求', async () => {
  const srv = await startServer((rec, res) => json(res, 200, { code: 0, data: { taskId: 'T' } }))
  try {
    const r = await apiFor(srv.url).createTask('k', 'cn', { workflowId: 'w', instanceType: 'supercomputer' })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, ERR.BAD_REQUEST)
    assert.equal(srv.calls.length, 0, '脏值不该发出去')
  } finally {
    await srv.close()
  }
})

test('P2-3 锁定：上传双失败时 hint 里带官方码', async () => {
  const srv = await startServer((rec, res) => {
    if (rec.url === '/openapi/v2/media/upload/binary') return json(res, 200, { code: 809, message: 'FILE_SIZE_EXCEEDED' })
    return json(res, 200, { code: 1008, msg: 'File size limit exceeded' })
  })
  try {
    const r = await apiFor(srv.url).uploadFile('k', 'cn', new Uint8Array([1]), 'a.png')
    assert.equal(r.ok, false)
    assert.match(r.error.hint, /新接口.*809/, '官方码要出现在给人看的 hint 里')
    assert.match(r.error.hint, /旧接口.*1008/)
    assert.equal(r.error.attempts[0].error.bizCode, 809)
    assert.equal(r.error.attempts[1].error.bizCode, 1008)
  } finally {
    await srv.close()
  }
})
