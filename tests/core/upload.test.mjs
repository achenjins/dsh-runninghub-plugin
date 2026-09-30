/**
 * tests/core/upload.test.mjs —— `images` 的「本地路径 → 自动上传」链路（task-12）
 *
 * ## 为什么单独一个文件
 * 真机事故：工具描述承诺「插件会自动上传」，但 `api.uploadFile()` **全仓没有任何调用点** ——
 * 本地 Windows 路径被原样塞进 `nodeInfoList`，RunningHub 3 秒后回一句
 * `[node:LoadImage#420] ["image - Invalid image file: E:\..."]`，用户完全看不懂。
 *
 * 根因是**所有测试都只喂"已经是 RH 文件名"的值**，没有任何一条从"本地路径"这个入口进来 ——
 * 桩比生产宽松，测试就在骗自己。所以这个文件的每一条都**从本地路径入口进**。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { once } from 'node:events'

import { TaskRunner, basenameOf } from '../../host/core/runner.mjs'
import { RunningHubApi } from '../../host/core/api.mjs'
import { KeyPool } from '../../host/core/keys.mjs'
import { Store } from '../../host/core/store.mjs'
import { analyzeWorkflow } from '../../host/core/workflow.mjs'

/* ─────────────────────────────── 脚手架 ─────────────────────────────── */

/** 全文件共用一台 mock server（每个 case 注册一条前缀子路由），避免端口/TIME_WAIT 耗尽。 */
let sharedSrv = null
const sharedRoutes = new Map()
let sharedSeq = 0

async function startServer(route) {
  if (!sharedSrv) {
    const srv = http.createServer(async (req, res) => {
      res.setHeader('Connection', 'close')
      const parts = String(req.url || '/').split('/')
      const entry = sharedRoutes.get(parts[1] || '')
      if (!entry) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"code":404}')
        return
      }
      const chunks = []
      for await (const c of req) chunks.push(c)
      const raw = Buffer.concat(chunks)
      const rec = { method: req.method, url: '/' + parts.slice(2).join('/'), headers: req.headers, raw, text: raw.toString('utf8'), json: null }
      try {
        rec.json = JSON.parse(rec.text)
      } catch {
        /* multipart */
      }
      entry.calls.push(rec)
      entry.route(rec, res, entry.state, entry.calls.length)
    })
    srv.listen(0, '127.0.0.1')
    await once(srv, 'listening')
    srv.unref()
    sharedSrv = { srv, base: `http://127.0.0.1:${srv.address().port}` }
  }
  const prefix = 'u' + String(++sharedSeq)
  const calls = []
  const state = {}
  sharedRoutes.set(prefix, { route, calls, state })
  return {
    calls,
    state,
    url: sharedSrv.base + '/' + prefix,
    async close() {
      sharedRoutes.delete(prefix)
    },
  }
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

/** 一个带 LoadImage 节点（role=image）的工作流配置。 */
function cfgWithImage(extraNodeId) {
  const api = {
    '420': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' }, _meta: { title: 'Load Image' } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat' }, _meta: { title: 'Prompt' } },
    '8': { class_type: 'SaveImage', inputs: {} },
  }
  if (extraNodeId) api[extraNodeId] = { class_type: 'LoadImage', inputs: { image: 'p2.png' }, _meta: { title: 'Load Image 2' } }
  const a = analyzeWorkflow(api)
  return { id: 'wf_img', name: '图像编辑', rhWorkflowId: '1988', region: 'cn', outputKind: 'image', nodes: a.nodes }
}

/** 假文件系统：`existsSync` 只对给定集合为真；`readFile` 返回固定内容。 */
function fakeFs(files) {
  const reads = []
  return {
    reads,
    existsSync: (p) => Object.prototype.hasOwnProperty.call(files, p),
    async readFile(p) {
      reads.push(p)
      if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error('ENOENT')
      return files[p]
    },
  }
}

/**
 * 组装 runner。
 * @param {object} o 选项：`route` 必给；`keys` 可给多把；`files` 假 FS 内容
 */
async function makeRig({ route, keys: keyDefs, files = {}, uploadFile } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-up-'))
  const srv = await startServer(route)
  const store = new Store({ dataDir: dir })
  await store.init()
  const api = new RunningHubApi({ baseUrls: { cn: srv.url, overseas: srv.url }, retries: 0 })
  if (uploadFile) api.uploadFile = uploadFile
  const pool = new KeyPool()
  for (const k of keyDefs || [{ id: 'k1', key: 'rh_cn_key_ONE_1111', region: 'cn' }]) pool.add(k)
  const nodeFs = fakeFs(files)
  const runner = new TaskRunner({
    api,
    keys: pool,
    store,
    fs: nodeFs,
    onEvent: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    firstPollDelayMs: 5,
  })
  return {
    dir,
    srv,
    store,
    api,
    keys: pool,
    runner,
    nodeFs,
    async close() {
      runner.stop()
      await srv.close()
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
    },
  }
}

const LOCAL = '<workspace>\\DSH\\1\\qwenimage\\参考图\\黑白漫画原图.png'

/* ─────────────────────────────── 纯函数 ─────────────────────────────── */

test('basenameOf：Windows 路径在任意平台上都能取到文件名', () => {
  assert.equal(basenameOf('E:\\a\\b\\黑白漫画原图.png'), '黑白漫画原图.png')
  assert.equal(basenameOf('/tmp/x/a.png'), 'a.png')
  assert.equal(basenameOf('a.png'), 'a.png')
  // `E:\` 这种"整盘根"没有文件名 → 兜底 `upload.bin`（宁可给个安全默认，也不要空文件名）
  assert.equal(basenameOf('E:\\'), 'upload.bin')
  assert.equal(basenameOf(''), 'upload.bin')
})

/* ─────────────────── 核心：本地路径 → 上传 → nodeInfoList ─────────────────── */

test('★ 本地路径会被上传，**nodeInfoList 里发出去的是 fileName 而不是本地路径**（本次 bug 的核心断言）', async () => {
  const uploads = []
  const rig = await makeRig({
    files: { [LOCAL]: Buffer.from([1, 2, 3, 4, 5]) },
    uploadFile: async (key, region, bytes, filename, opts) => {
      uploads.push({ key, region, size: bytes.length, filename, fileType: opts && opts.fileType })
      return { ok: true, fileName: 'openapi/uploaded.png', downloadUrl: 'https://x/uploaded.png', via: 'v2' }
    },
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-UP' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    const r = await rig.runner.submit({ workflowConfig: cfgWithImage(), values: { prompt: 'x', images: { 420: LOCAL } } })
    assert.equal(r.ok, true, JSON.stringify(r))

    // ① uploadFile 被调用一次，参数含**正确字节数**与**文件名**
    assert.equal(uploads.length, 1, 'uploadFile 必须被调用一次')
    assert.deepEqual(uploads[0].size, 5)
    assert.equal(uploads[0].filename, '黑白漫画原图.png')
    assert.equal(uploads[0].fileType, 'image', 'LoadImage 节点的 fileType 必须是 image')
    assert.equal(uploads[0].region, 'cn')

    // ② **核心断言**：发出去的 nodeInfoList 里是 fileName，不是本地路径
    const create = rig.srv.calls.find((c) => c.url === '/task/openapi/create')
    const item = create.json.nodeInfoList.find((x) => x.nodeId === '420')
    assert.deepEqual(item, { nodeId: '420', fieldName: 'image', fieldValue: 'openapi/uploaded.png' })
    assert.equal(JSON.stringify(create.json).includes('黑白漫画原图'), false, '本地路径绝不能出现在请求体里')
    assert.equal(JSON.stringify(create.json).includes('E:\\\\'), false, '本地盘符绝不能出现在请求体里')
  } finally {
    await rig.close()
  }
})

test('已经是 RH 文件名的值**不会再被上传**（老调用方不能坏）', async () => {
  let uploadCalls = 0
  const rig = await makeRig({
    files: {},
    uploadFile: async () => {
      uploadCalls += 1
      return { ok: true, fileName: 'SHOULD_NOT_HAPPEN', via: 'v2' }
    },
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-PASS' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    // `openapi/a.png` **不是绝对路径**，但它已经是 RH 文件名 —— 用 existsSync 判据才切得对
    const r = await rig.runner.submit({ workflowConfig: cfgWithImage(), values: { prompt: 'x', images: { 420: 'openapi/a.png' } } })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(uploadCalls, 0, '已经是文件名 → 不该上传')
    const create = rig.srv.calls.find((c) => c.url === '/task/openapi/create')
    assert.equal(create.json.nodeInfoList.find((x) => x.nodeId === '420').fieldValue, 'openapi/a.png')
  } finally {
    await rig.close()
  }
})

test('多个节点的素材**各自上传**，且 fileType 按 role 区分（image / video / audio）', async () => {
  const uploads = []
  const rig = await makeRig({
    files: {
      'C:\\imgs\\a.png': Buffer.from([1]),
      'C:\\imgs\\v.mp4': Buffer.from([1, 2]),
      'C:\\imgs\\s.wav': Buffer.from([1, 2, 3]),
    },
    uploadFile: async (key, region, bytes, filename, opts) => {
      uploads.push({ filename, fileType: opts.fileType, size: bytes.length })
      return { ok: true, fileName: 'openapi/' + filename, via: 'legacy' }
    },
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-MULTI' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    const a = analyzeWorkflow({
      '420': { class_type: 'LoadImage', inputs: { image: 'x.png' } },
      '430': { class_type: 'VHS_LoadVideo', inputs: { video: 'x.mp4' } },
      '440': { class_type: 'LoadAudio', inputs: { audio: 'x.wav' } },
      '8': { class_type: 'SaveImage', inputs: {} },
    })
    const cfg = { id: 'w', name: 'W', rhWorkflowId: '1', region: 'cn', outputKind: 'image', nodes: a.nodes }
    const r = await rig.runner.submit({
      workflowConfig: cfg,
      values: { images: { 420: 'C:\\imgs\\a.png', 430: 'C:\\imgs\\v.mp4', 440: 'C:\\imgs\\s.wav' } },
    })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(uploads.length, 3, '三个节点各上传一次')
    assert.deepEqual(uploads.map((u) => u.fileType).sort(), ['audio', 'image', 'video'])
    assert.deepEqual(uploads.map((u) => u.size).sort(), [1, 2, 3], '各文件的真实字节数')
    const create = rig.srv.calls.find((c) => c.url === '/task/openapi/create')
    const sent = Object.fromEntries(create.json.nodeInfoList.map((x) => [x.nodeId, x.fieldValue]))
    assert.deepEqual(sent, { 420: 'openapi/a.png', 430: 'openapi/v.mp4', 440: 'openapi/s.wav' })
  } finally {
    await rig.close()
  }
})

test('★ 上传失败 → 如实失败（带两边原文），**绝不把本地路径透传出去**', async () => {
  const rig = await makeRig({
    files: { 'C:\\imgs\\too-big.png': Buffer.alloc(10) },
    uploadFile: async () => ({
      ok: false,
      error: {
        code: 'UPLOAD_FAILED',
        message: '上传失败（10 B）：两个接口都拒绝了（新接口体积上限比旧接口严得多；两个接口都拒绝时才是这把 key 的真实限制）',
        hint: '新接口 BUSINESS/官方码 809：FILE_SIZE_EXCEEDED ｜ 旧接口 BUSINESS/官方码 1008：File size limit exceeded',
        attempts: [
          { via: 'v2', path: '/openapi/v2/media/upload/binary', ok: false, error: { code: 'BUSINESS', bizCode: 809 } },
          { via: 'legacy', path: '/task/openapi/upload', ok: false, error: { code: 'BUSINESS', bizCode: 1008 } },
        ],
      },
    }),
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-NOPE' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    const r = await rig.runner.submit({ workflowConfig: cfgWithImage(), values: { prompt: 'x', images: { 420: 'C:\\imgs\\too-big.png' } } })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'UPLOAD_FAILED')
    assert.match(r.error.message, /第 1\/1 个素材上传失败/)
    assert.match(r.error.message, /节点 420/)
    assert.match(r.error.message, /too-big\.png/)
    // 两边原文都在
    assert.match(r.error.hint, /新接口.*809/)
    assert.match(r.error.hint, /旧接口.*1008/)
    assert.equal(r.error.nodeId, '420')
    assert.equal(r.error.total, 1)
    // **绝不发 create**，也绝不把路径透传
    assert.equal(rig.srv.calls.some((c) => c.url === '/task/openapi/create'), false, '上传失败就不该提交')
  } finally {
    await rig.close()
  }
})

test('多张图：第 2 张失败时说清"第 2/2 个、节点 XXX"', async () => {
  let n = 0
  const rig = await makeRig({
    files: { 'C:\\a.png': Buffer.from([1]), 'C:\\b.png': Buffer.from([2]) },
    uploadFile: async () => {
      n += 1
      if (n === 1) return { ok: true, fileName: 'openapi/a.png', via: 'v2' }
      return { ok: false, error: { code: 'UPLOAD_FAILED', message: '第二张挂了', hint: '官方码 1008' } }
    },
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-2' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    const a = analyzeWorkflow({
      '420': { class_type: 'LoadImage', inputs: { image: 'x.png' } },
      '421': { class_type: 'LoadImage', inputs: { image: 'y.png' } },
      '8': { class_type: 'SaveImage', inputs: {} },
    })
    const cfg = { id: 'w', name: 'W', rhWorkflowId: '1', region: 'cn', outputKind: 'image', nodes: a.nodes }
    const r = await rig.runner.submit({ workflowConfig: cfg, values: { images: { 420: 'C:\\a.png', 421: 'C:\\b.png' } } })
    assert.equal(r.ok, false)
    assert.match(r.error.message, /第 2\/2 个素材上传失败/)
    assert.match(r.error.message, /节点 421/)
    assert.equal(r.error.index, 2)
    assert.equal(r.error.total, 2)
    assert.equal(rig.srv.calls.some((c) => c.url === '/task/openapi/create'), false, '失败即止，不该提交')
  } finally {
    await rig.close()
  }
})

test('★ 上传与 create 用**同一把 key**（两把 key 时 pick 只发生一次）', async () => {
  const used = []
  const rig = await makeRig({
    keys: [
      { id: 'k1', key: 'rh_cn_key_ONE_AAAA', region: 'cn', priority: 0 },
      { id: 'k2', key: 'rh_cn_key_TWO_BBBB', region: 'cn', priority: 1 },
    ],
    files: { 'C:\\a.png': Buffer.from([9]) },
    uploadFile: async (key) => {
      used.push({ where: 'upload', key })
      return { ok: true, fileName: 'openapi/a.png', via: 'v2' }
    },
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-KEY' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    let picks = 0
    const realPick = rig.keys.pick.bind(rig.keys)
    rig.keys.pick = (o) => {
      picks += 1
      return realPick(o)
    }
    const r = await rig.runner.submit({ workflowConfig: cfgWithImage(), values: { images: { 420: 'C:\\a.png' } } })
    assert.equal(r.ok, true, JSON.stringify(r))
    const create = rig.srv.calls.find((c) => c.url === '/task/openapi/create')
    used.push({ where: 'create', key: create.headers.authorization.replace('Bearer ', '') })
    assert.equal(picks, 1, 'pick 只该发生一次')
    assert.equal(used[0].key, used[1].key, '上传与 create 必须是同一把 key（换 key 会让文件落在别的上下文里）')
    assert.equal(used[0].key, 'rh_cn_key_ONE_AAAA', '且应是 priority 最高的那把')
    // 另一把 key 完全没被用过
    assert.equal(rig.keys.list().find((k) => k.id === 'k2').lastUsedAt, 0)
  } finally {
    await rig.close()
  }
})

test('服务端文件名与 URL 可直接使用，缺失的显式本地路径不能提交', async () => {
  let uploadCalls = 0
  const rig = await makeRig({
    files: {},
    uploadFile: async () => {
      uploadCalls += 1
      return { ok: true, fileName: 'X', via: 'v2' }
    },
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-P' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    for (const v of ['openapi/a.png', 'api/b.png', 'https://x/y.png']) {
      const r = await rig.runner.submit({ workflowConfig: cfgWithImage(), values: { images: { 420: v } } })
      assert.equal(r.ok, true, v + ' → ' + JSON.stringify(r))
    }
    const before = rig.srv.calls.filter((c) => c.url === '/task/openapi/create').length
    for (const v of ['./not-there.png', 'C:\\not\\there.png']) {
      const r = await rig.runner.submit({ workflowConfig: cfgWithImage(), values: { images: { 420: v } } })
      assert.equal(r.error.code, 'MATERIAL_NOT_FOUND')
    }
    assert.equal(rig.srv.calls.filter((c) => c.url === '/task/openapi/create').length, before)
    assert.equal(uploadCalls, 0)
  } finally {
    await rig.close()
  }
})

test('读文件失败（存在但读不到）→ 可判错误，不崩不透传', async () => {
  const rig = await makeRig({
    files: {},
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-E' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    // existsSync 说存在，readFile 却抛（权限/占用）
    rig.runner.fs = { existsSync: () => true, readFile: async () => { throw new Error('EBUSY: 文件被占用') } }
    const r = await rig.runner.submit({ workflowConfig: cfgWithImage(), values: { images: { 420: 'C:\\busy.png' } } })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'UPLOAD_FAILED')
    assert.match(r.error.message, /读不到/)
    assert.match(r.error.hint, /EBUSY/)
    assert.equal(rig.srv.calls.some((c) => c.url === '/task/openapi/create'), false)
  } finally {
    await rig.close()
  }
})

test('api 不支持 uploadFile 且给的是本地路径 → 明确失败，**不透传路径**', async () => {
  const rig = await makeRig({
    files: { 'C:\\a.png': Buffer.from([1]) },
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-N' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    rig.runner.api = { createTask: rig.api.createTask.bind(rig.api) } // 没有 uploadFile
    const r = await rig.runner.submit({ workflowConfig: cfgWithImage(), values: { images: { 420: 'C:\\a.png' } } })
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'UPLOAD_FAILED')
    assert.match(r.error.message, /不支持上传/)
  } finally {
    await rig.close()
  }
})

test('没有 images（或全为空值）时完全不走上传路径', async () => {
  let uploadCalls = 0
  const rig = await makeRig({
    files: {},
    uploadFile: async () => {
      uploadCalls += 1
      return { ok: true, fileName: 'X', via: 'v2' }
    },
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-0' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    const cfg = cfgWithImage()
    // 注意：这个工作流有 `required` 的 LoadImage 节点，所以**空 images 会（正确地）被
    // 干跑校验拦下** —— 本测试只关心一件事：**上传路径不被触发**。
    for (const values of [{}, { images: {} }, { images: { 420: '' } }, { images: { 420: null } }]) {
      const r = await rig.runner.submit({ workflowConfig: cfg, values })
      if (r.ok === false) {
        assert.equal(r.error.code, 'NODE_MISSING', JSON.stringify(values) + ' 只该因"缺必填"失败')
      }
    }
    assert.equal(uploadCalls, 0, '没有任何可上传的值 → 一次都不该调 uploadFile')
  } finally {
    await rig.close()
  }
})

test('真实磁盘冒烟：临时文件走完 uploadFile（默认 node:fs，不注入假 FS）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-real-'))
  const file = path.join(dir, '真实图片.png')
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  await fs.writeFile(file, bytes)
  const seen = []
  const rig = await makeRig({
    uploadFile: async (key, region, got, filename, opts) => {
      seen.push({ size: got.length, filename, fileType: opts.fileType, head: got[0] })
      return { ok: true, fileName: 'openapi/real.png', via: 'v2' }
    },
    route(rec, res) {
      if (rec.url === '/task/openapi/create') return json(res, 200, { code: 0, data: { taskId: 'T-REAL' } })
      return json(res, 200, { code: 0, data: { taskStatus: 'RUNNING' } })
    },
  })
  try {
    // 换成**真实**文件系统（默认 `node:fs`），走一遍真实的 existsSync + readFile
    rig.runner.fs = { existsSync: (p) => fsSync.existsSync(p), readFile: (p) => fs.readFile(p) }
    const r = await rig.runner.submit({ workflowConfig: cfgWithImage(), values: { images: { 420: file } } })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(seen.length, 1)
    assert.equal(seen[0].size, 8, '真实读到的字节数')
    assert.equal(seen[0].filename, '真实图片.png')
    assert.equal(seen[0].head, 137, '确实是那个文件的内容')
    const create = rig.srv.calls.find((c) => c.url === '/task/openapi/create')
    assert.equal(create.json.nodeInfoList.find((x) => x.nodeId === '420').fieldValue, 'openapi/real.png')
  } finally {
    await rig.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})
