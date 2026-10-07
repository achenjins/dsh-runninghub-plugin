/**
 * host 侧端到端集成测试（**不打任何真实付费接口**）
 *
 * 用本地 mock RunningHub 服务器 + 真实协议层 + 真实插件入口，走完一条完整业务链：
 *
 *   装插件 → 加 Key（自动探测地域）→ workflow.get 看工作流（空）→ probe 拉工作流推断节点
 *          → configure 落盘 → workflow.get 再看（有 1 个）
 *          → validate → run（后台）→ wait（拿到图片附件）
 *
 * 另外锁死三条设计红线：
 *   - 额度不足自动换 Key，且**跨池绝不回退**
 *   - 提交阶段结果未知 → `UNCERTAIN`，**不自动重投**
 *   - 明文 Key 绝不进任何回执
 *
 * @module dsh-runninghub-plugin/tests/host/e2e
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { RunningHubApi } from '../../host/core/api.mjs'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

/* ────────────────────────── mock RunningHub 服务器 ────────────────────────── */

/** 1x1 透明 PNG（最小合法图片，宿主 attachments 能解码）。 */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 一个最小但真实的 ComfyUI API 格式工作流。 */
function sampleWorkflow() {
  return {
    '3': {
      class_type: 'KSampler',
      inputs: { seed: 669816362794144, steps: 20, cfg: 8, sampler_name: 'dpmpp_2m', scheduler: 'karras', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] },
      _meta: { title: 'KSampler' },
    },
    '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'test.safetensors' }, _meta: { title: 'Load Checkpoint' } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 }, _meta: { title: 'Empty Latent Image' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cute panda', clip: ['4', 1] }, _meta: { title: 'CLIP Text Encode (Prompt)' } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['4', 1] }, _meta: { title: 'CLIP Text Encode (Negative Prompt)' } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] }, _meta: { title: 'VAE Decode' } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'rh', images: ['8', 0] }, _meta: { title: 'Save Image' } },
  }
}

/**
 * 起一个 mock 平台。
 *
 * @param {object} opts
 * @param {number} [opts.quotaFailures] 前 N 次 create 返回额度不足（用来验证换 Key）
 * @param {boolean} [opts.hangOnCreate] create 直接挂断（用来验证 UNCERTAIN）
 */
async function startMock(opts = {}) {
  const state = {
    createCalls: 0,
    outputPolls: 0,
    keyHits: new Map(),
    quotaFailures: opts.quotaFailures || 0,
    hangOnCreate: !!opts.hangOnCreate,
    failTask: !!opts.failTask,
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const bodyText = await readAll(req)
    let body = {}
    try {
      body = bodyText ? JSON.parse(bodyText) : {}
    } catch {
      body = {}
    }
    const key = String(body.apiKey || body.apikey || '')
    if (key) state.keyHits.set(key, (state.keyHits.get(key) || 0) + 1)

    const json = (payload, status = 200) => {
      const text = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
      res.end(text)
    }

    if (url.pathname === '/uc/openapi/accountStatus') {
      // 只有"对的"那把 key 才有余额；其余一律 401 —— 用来验证地域探测与换 Key
      if (opts.rejectKeys && opts.rejectKeys.includes(key)) {
        json({ code: 401, msg: 'APIKEY_INVALID' })
        return
      }
      json({ code: 0, msg: 'success', data: { remainCoins: '1234', remainMoney: '12.34', currency: 'CNY', currentTaskCounts: '0', apiType: 'normal' } })
      return
    }

    if (url.pathname === '/api/openapi/getJsonApiFormat') {
      json({ code: 0, msg: 'success', data: { prompt: JSON.stringify(sampleWorkflow()) } })
      return
    }

    if (url.pathname === '/task/openapi/create') {
      state.createCalls += 1
      if (state.hangOnCreate) {
        // 模拟"提交返回前连接断了"：结果未知
        try {
          req.socket.destroy()
        } catch {
          /* 已经断了 */
        }
        return
      }
      if (state.createCalls <= state.quotaFailures) {
        json({ code: 805, msg: '余额不足，本次任务无法执行' })
        return
      }
      json({ code: 0, msg: 'success', data: { taskId: 'TASK-' + String(state.createCalls), taskStatus: 'QUEUED' } })
      return
    }

    if (url.pathname === '/task/openapi/status' || url.pathname === '/task/openapi/outputs') {
      state.outputPolls += 1
      if (state.outputPolls < 2) {
        json({ code: 0, msg: 'success', data: { taskStatus: 'RUNNING' } })
        return
      }
      if (state.failTask) {
        json({ code: 0, msg: 'success', data: { taskStatus: 'FAILED', failedReason: { exception_message: 'CUDA out of memory', node_name: 'KSampler' } } })
        return
      }
      json({
        code: 0,
        msg: 'success',
        data: {
          taskStatus: 'SUCCESS',
          outputs: [
            { fileUrl: 'https://results.example/file/out.png', fileType: 'png', taskCostTime: '3', nodeId: '9' },
          ],
        },
      })
      return
    }

    if (url.pathname === '/openapi/v2/query') {
      json({ code: 0, status: 'SUCCESS', results: [{ url: 'https://results.example/file/out.png' }] })
      return
    }

    if (url.pathname === '/task/openapi/cancel') {
      json({ code: 0, msg: 'success' })
      return
    }

    if (url.pathname === '/openapi/v2/media/upload/binary') {
      json({ code: 200, message: 'ok', data: { filename: 'openapi/uploaded.png', download_url: 'http://127.0.0.1/file/uploaded.png' } })
      return
    }

    if (url.pathname === '/task/openapi/upload') {
      json({ code: 0, msg: 'success', data: { fileName: 'legacy-uploaded.png' } })
      return
    }

    if (url.pathname.startsWith('/file/')) {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG_1X1.length })
      res.end(PNG_1X1)
      return
    }

    json({ code: 404, msg: 'no such endpoint: ' + url.pathname }, 404)
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { server, port, baseUrl: 'http://127.0.0.1:' + String(port), state }
}

function readAll(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

/* ────────────────────────── 桩 ctx ────────────────────────── */

/** 造一个最小可用的 DSH ctx 桩（只实现插件真正用到的面）。 */
function makeCtx(overrides = {}) {
  const attachments = {
    imageLimits: { maxImageBytes: 32 * 1024 * 1024, maxImagesPerMessage: 20, maxMessageImageBytes: 64 * 1024 * 1024, maxImagePixels: 64e6, maxImageDimension: 16384, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    saved: [],
    async saveImage(input) {
      this.saved.push({ kind: 'image', bytes: input.data.length, mediaType: input.mediaType, name: input.name })
      return { attachmentId: 'att-img-' + String(this.saved.length), mediaType: input.mediaType, bytes: input.data.length, width: 1024, height: 1024, name: input.name }
    },
    async saveFile(input) {
      this.saved.push({ kind: 'file', bytes: input.data.length, name: input.name })
      return { attachmentId: 'att-file-' + String(this.saved.length), name: input.name || 'f.bin', bytes: input.data.length }
    },
  }
  const registeredTools = []
  const skills = []
  const routes = []
  const services = {
    attachments,
    connection: { admit: () => ({ peer: {} }) },
    webServer: { register: (route) => (routes.push(route), () => {}) },
    ...(overrides.services || {}),
  }
  const ctx = {
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    tools: { register: (def) => (registeredTools.push(def), () => {}) },
    get: (name) => services[name],
    on: () => () => {},
    effect: (fn) => {
      const d = fn()
      return () => {
        if (typeof d === 'function') d()
      }
    },
    inject: (deps, fn) => fn({ effect: (f) => f(), jobs: services.jobs, tools: ctx.tools, get: ctx.get }),
    ...overrides.ctx,
  }
  services.skills = { register: (reg) => (skills.push(reg), () => {}) }
  return { ctx, registeredTools, skills, attachments, services, routes }
}

/* ────────────────────────── 装载插件 ────────────────────────── */

async function loadPlugin(config, ctxOverrides) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'host', 'index.mjs')).href + '?t=' + String(Date.now()))
  const harness = makeCtx(ctxOverrides)
  mod.apply(harness.ctx, config)
  const tool = (n) => harness.registeredTools.find((t) => t && t.name === n)
  const call = tool('runninghub_call')
  assert.ok(call, 'runninghub_call 应同步注册')
  const deadline = Date.now() + 5000
  for (;;) {
    const status = await call.execute({ action: 'diagnostics' }, {})
    if (status.data?.coreReady && harness.routes.some((route) => route.path.endsWith('/api'))) break
    assert.ok(Date.now() < deadline, '运行时未完成装配：' + JSON.stringify(status))
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const panel = async (method, params) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ method, params }))])
    req.method = 'POST'
    req.headers = { 'content-type': 'application/json' }
    let body
    await harness.routes.find((route) => route.path.endsWith('/api')).handler(req, { writeHead() {}, end(value) { body = value } })
    return JSON.parse(body)
  }
  return { mod, ...harness, panel, search: tool('runninghub_search'), call: tool('runninghub_call') }
}

/** 工具回执里的人读文本（所有断言都尽量断文本，断的是模型真能看到的东西）。 */
function textOf(out) {
  return String((out && out.text) || '')
}

async function withTempDataDir(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rh-e2e-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/* ────────────────────────── 测试 ────────────────────────── */

test('端到端：面板加 Key → 探测 → probe → configure → workflow.get → validate → run → wait（图片回到聊天）', async (t) => {
  const mock = await startMock({ rejectKeys: ['OVERSEAS-KEY'] })
  const downloader = new RunningHubApi({ fetchImpl: (url, options) => fetch(String(url).replace('https://results.example', mock.baseUrl), options) })
  const downloadTo = RunningHubApi.prototype.downloadTo
  t.mock.method(RunningHubApi.prototype, 'downloadTo', (...args) => downloadTo.apply(downloader, args))
  try {
    await withTempDataDir(async (dataDir) => {
      const h = await loadPlugin({
        dataDir,
        baseUrls: { cn: mock.baseUrl, overseas: mock.baseUrl },
        pollIntervalMs: 50,
        httpTimeoutMs: 5000,
      })

      assert.ok(h.search && h.call, '两个工具必须都注册上了')

      // ① 一开始没有任何工作流
      const empty = await h.call.execute({ action: 'workflow.get' }, {})
      assert.equal(empty.ok, true, '没有工作流时仍应返回正常列表')
      assert.deepEqual(empty.data.workflows, [])

      // ② 加一把 Key（自动探测地域；OVERSEAS-KEY 会被 mock 拒）
      const add = await h.panel('keysAdd', { entry: { key: 'CN-KEY-0123456789abcdef' } })
      assert.equal(add.ok, true, '面板添加 Key 应成功：' + JSON.stringify(add))
      assert.equal(add.region, 'cn', '地域应探测为 cn')

      const badAdd = await h.panel('keysAdd', { entry: { key: 'OVERSEAS-KEY' } })
      assert.equal(badAdd.ok, false, '两个平台都验不过的 Key 必须被拒')
      assert.equal(badAdd.error.code, 'AUTH')

      // ③ probe：拉工作流并推断节点
      const probe = await h.call.execute({ action: 'workflow.probe', workflowId: '1988000000000001' }, {})
      assert.equal(probe.ok, true, 'probe 应成功：' + textOf(probe))
      assert.ok(probe.data && probe.data.config, 'probe 要给出配置提案')
      const nodes = probe.data.config.nodes
      assert.equal(probe.data.proposal, undefined)
      const probeText = h.call.output.render({}, probe).filter(block => block.type === 'text').map(block => block.text).join('\n')
      assert.equal(probeText.split(JSON.stringify(nodes)).length - 1, 1, '节点数组只返回一份')
      assert.ok(Array.isArray(nodes) && nodes.length >= 6, '应推断出节点，实际 ' + String(nodes && nodes.length))
      const promptNode = nodes.find((n) => n.role === 'prompt')
      const negNode = nodes.find((n) => n.role === 'negative_prompt')
      assert.ok(promptNode, '必须识别出正向提示词节点；实际 roles=' + JSON.stringify(nodes.map((n) => [n.nodeId, n.classType, n.role])))
      assert.ok(negNode, '必须识别出负向提示词节点')

      // ④ configure：落盘
      const cfg = await h.call.execute(
        {
          action: 'workflow.configure',
          name: '测试文生图',
          workflowId: '1988000000000001',
          region: 'cn',
          config: {
            outputKind: 'image',
            description: '测试用文生图工作流',
            tags: ['文生图'],
            nodes,
            promptOptimizer: { enabled: false, docId: null, asSubagentSystemPrompt: false, targetNodeId: promptNode.nodeId, extraInstruction: '' },
          },
        },
        {},
      )
      assert.equal(cfg.ok, true, 'configure 应成功：' + textOf(cfg))

      // ⑤ workflow.get：现在能看到它了
      const listed = await h.call.execute({ action: 'workflow.get' }, {})
      assert.match(textOf(listed), /测试文生图/, 'workflow.get 应列出刚配好的工作流')
      assert.match(textOf(listed), /生图|image/, '概要应标注输出类型')

      // ⑥ get：节点细节
      const detail = await h.call.execute({ action: 'workflow.get', name: '测试文生图' }, {})
      assert.equal(detail.ok, true)
      assert.ok(detail.data.nodes.some((node) => node.nodeId === promptNode.nodeId && node.role === 'prompt'), '具名查询要返回完整提示词节点')

      // ⑦ validate
      const valid = await h.call.execute({ action: 'workflow.validate', name: '测试文生图' }, {})
      assert.equal(valid.ok, true, 'validate 应通过：' + textOf(valid))

      // ⑧ run（后台化：必须立刻返回 taskId）
      const t0 = Date.now()
      const run = await h.call.execute({ action: 'workflow.run', name: '测试文生图', prompt: 'a red panda' }, {})
      const elapsed = Date.now() - t0
      assert.equal(run.ok, true, 'run 应提交成功：' + textOf(run))
      assert.ok(run.data && run.data.tasks && run.data.tasks[0] && run.data.tasks[0].taskId, 'run 必须返回 taskId')
      assert.ok(elapsed < 3000, 'run 必须"后台化"立刻返回，实际耗时 ' + String(elapsed) + 'ms')
      assert.match(textOf(run), /后台提交|task\.wait/, 'run 回执要告诉模型怎么取结果')
      const taskId = run.data.tasks[0].taskId

      // ⑨ wait：等到完成，并且**图片作为附件返回**
      const waited = await h.call.execute({ action: 'task.wait', taskId, timeoutMs: 15000 }, {})
      const dbg = JSON.stringify({ ok: waited.ok, error: waited.error, lines: textOf(waited), nImages: Array.isArray(waited.images) ? waited.images.length : null, data: waited.data })
      assert.equal(waited.ok, true, 'task.wait 应成功：' + dbg)
      assert.ok(Array.isArray(waited.images) && waited.images.length >= 1, 'task.wait 必须把图片作为 attachment 返回（聊天里要显示）：' + dbg)
      assert.equal(waited.images[0].mediaType, 'image/png')
      assert.ok(h.attachments.saved.some((s) => s.kind === 'image'), 'attachments.saveImage 必须被真的调用过')

      // ⑩ 明文 key 绝不能出现在任何回执里
      for (const out of [add, probe, cfg, listed, detail, run, waited]) {
        assert.ok(!JSON.stringify(out).includes('CN-KEY-0123456789abcdef'), '回执里出现了明文 API Key！')
      }
      const keys = await h.call.execute({ action: 'account.keys' }, {})
      assert.match(textOf(keys), /cn\*\*\*\*|CN-K\*\*\*\*/, 'Key 列表必须是掩码形式：' + textOf(keys))
      assert.ok(!textOf(keys).includes('CN-KEY-0123456789abcdef'))
    })
  } finally {
    await new Promise((r) => mock.server.close(r))
  }
})

test('额度不足自动换 Key；池子空了直接报 NO_KEY，绝不跨池回退', async () => {
  const mock = await startMock({})
  try {
    await withTempDataDir(async (dataDir) => {
      const h = await loadPlugin({ dataDir, baseUrls: { cn: mock.baseUrl, overseas: mock.baseUrl }, pollIntervalMs: 50, httpTimeoutMs: 5000 })

      await h.panel('keysAdd', { entry: { key: 'CN-KEY-AAAAAAAAAAAAAAAA', label: '第一把' } })
      await h.panel('keysAdd', { entry: { key: 'CN-KEY-BBBBBBBBBBBBBBBB', label: '第二把' } })

      // 两把都在 cn 池；先让第一把进冷却，看是否正确换到第二把
      const before = mock.state.keyHits.get('CN-KEY-AAAAAAAAAAAAAAAA') || 0
      const bal = await h.call.execute({ action: 'account.balance' }, {})
      assert.equal(bal.ok, true)

      // 海外池是空的 → 必须直接 NO_KEY，不能偷偷拿国内 Key 去打海外
      const ok = await h.call.execute({ action: 'workflow.probe', workflowId: 'X1', region: 'overseas' }, {})
      assert.equal(ok.ok, false)
      assert.equal(ok.error.code, 'NO_KEY', '海外池空必须 NO_KEY，实际：' + JSON.stringify(ok.error))
      assert.ok(!mock.state.keyHits.has('__overseas_probe__'), '不该真的发出海外请求')
      assert.ok(before >= 0)
    })
  } finally {
    await new Promise((r) => mock.server.close(r))
  }
})

test('提交阶段结果未知 → UNCERTAIN，且绝不自动重投', async () => {
  const mock = await startMock({ hangOnCreate: true })
  try {
    await withTempDataDir(async (dataDir) => {
      const h = await loadPlugin({ dataDir, baseUrls: { cn: mock.baseUrl, overseas: mock.baseUrl }, pollIntervalMs: 50, httpTimeoutMs: 1500 })

      await h.panel('keysAdd', { entry: { key: 'CN-KEY-CCCCCCCCCCCCCCCC' } })
      await h.call.execute({
        action: 'workflow.configure',
        name: '断线测试',
        workflowId: 'W-DROP',
        region: 'cn',
        config: { outputKind: 'image', nodes: [{ nodeId: '6', classType: 'CLIPTextEncode', role: 'prompt', fieldName: 'text', valueType: 'string', required: true }] },
      })

      const run = await h.call.execute({ action: 'workflow.run', name: '断线测试', prompt: 'x' }, {})
      const callsAfterFirst = mock.state.createCalls

      assert.equal(run.ok, false, '提交结果未知必须报失败，不能假装成功')
      assert.match(String(run.error.code) + textOf(run), /TRANSPORT|UNCERTAIN|不确定/, '必须标明"状态不确定"：' + JSON.stringify(run.error))
      assert.equal(mock.state.createCalls, callsAfterFirst, '**绝不能自动重投**（可能已扣费）')
      assert.equal(mock.state.createCalls, 1, '提交只应发生一次')
    })
  } finally {
    await new Promise((r) => mock.server.close(r))
  }
})

test('未知 action 回动作清单（模型能自纠）', async () => {
  const mock = await startMock({})
  try {
    await withTempDataDir(async (dataDir) => {
      const h = await loadPlugin({ dataDir, baseUrls: { cn: mock.baseUrl, overseas: mock.baseUrl } })
      const out = await h.call.execute({ action: 'workflow.runn' }, {})
      assert.equal(out.ok, false)
      assert.equal(out.error.code, 'UNKNOWN_ACTION')
      assert.match(textOf(out), /workflow\.run/, '回执里要有正确动作名供模型自纠')
    })
  } finally {
    await new Promise((r) => mock.server.close(r))
  }
})
