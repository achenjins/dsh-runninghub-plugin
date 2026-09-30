import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { Store } from '../../host/core/store.mjs'
import { KeyPool } from '../../host/core/keys.mjs'
import { TaskRunner, pollDelay } from '../../host/core/runner.mjs'
import { RunningHubApi } from '../../host/core/api.mjs'
import { validateRun, buildNodeInfoList } from '../../host/core/workflow.mjs'
import { scrubLegacySecrets } from '../../tools/scrub-legacy-secrets.mjs'
import { buildMethods } from '../../host/rpc.mjs'
import { bootRuntime, createRuntime, attachResult } from '../../host/runtime.mjs'
import { normalizeConfig } from '../../host/index.mjs'
import { HANDLERS, makeCallTool } from '../../host/tools/call.mjs'
import { startTaskJob } from '../../host/jobs.mjs'

const neverSleep = () => new Promise(() => {})
const workflow = { id: 'wf', name: 'Workflow', rhWorkflowId: '123', region: 'cn', nodes: [] }

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-regression-'))
  const store = new Store({ dataDir: dir })
  await store.init()
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), dir)
    assert.ok(relative.startsWith('rh-regression-') && !relative.includes(path.sep))
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const pool = new KeyPool()
  pool.add({ id: 'cn1', key: 'synthetic-cn-first', region: 'cn', priority: 0 })
  pool.add({ id: 'cn2', key: 'synthetic-cn-second', region: 'cn', priority: 1 })
  pool.add({ id: 'os1', key: 'synthetic-overseas', region: 'overseas' })
  const rt = { store, pool, workflow: { validateRun }, config: {}, warnings: [], warn() {}, ctx: { get: () => undefined } }
  const runner = (api, extra = {}) => {
    const value = new TaskRunner({ store, keys: pool, api, sleep: neverSleep, ...extra })
    t.after(() => value.stop())
    return value
  }
  return { dir, store, pool, rt, runner }
}

test('工作流经过面板读写后保留校验来源，空范围不会变成零', async (t) => {
  const { store, rt } = await fixture(t)
  await store.saveWorkflow({ ...workflow, nodes: [
    { nodeId: '1', fieldName: 'steps', valueType: 'number', min: 1, max: 100, boundsSource: 'heuristic', default: 20 },
    { nodeId: '2', fieldName: 'mode', valueType: 'enum', options: ['a', 'b'], optionsSource: 'inferred-from-default' },
    { nodeId: '3', fieldName: 'count', valueType: 'number' },
  ] })
  const methods = buildMethods(rt)
  const config = (await methods.listWorkflows())[0]
  await methods.saveWorkflow({ config })
  const saved = await store.getWorkflow('wf')
  const result = validateRun(saved, { params: { steps: 101, mode: 'c', count: 10 } })
  assert.equal(result.ok, true)
  assert.equal(result.warnings.length, 1)
  assert.equal(saved.nodes[0].boundsSource, 'heuristic')
  assert.equal(saved.nodes[1].optionsSource, 'inferred-from-default')
  assert.equal(saved.nodes[2].max, undefined)
})

test('文档改名更新原 ID，同时保留来源文件和时间', async (t) => {
  const { store, rt } = await fixture(t)
  await store.savePromptDoc({ id: 'stable', name: 'Original', content: 'v1', sourceFilename: 'style.md' })
  const methods = buildMethods(rt)
  const result = await methods.docsSave({ doc: { docId: 'stable', name: 'Renamed', content: 'v2' } })
  assert.equal(result.docId, 'stable')
  const doc = await methods.docsGet({ docId: 'stable' })
  assert.equal(doc.content, 'v2')
  assert.equal(doc.filename, 'style.md')
  assert.ok(doc.updatedAt > 0)
  assert.equal((await methods.docsList()).length, 1)
})

test('任务列表在筛选后限制数量，RPC 与模型工具一致', async (t) => {
  const { store, rt } = await fixture(t)
  for (let i = 1; i <= 4; i++) await store.saveTask({ taskId: 't' + i, createdAt: i, status: i % 2 ? 'SUCCESS' : 'RUNNING' })
  const items = await buildMethods(rt).tasksList({ limit: 1 })
  assert.deepEqual(items.map((item) => item.taskId), ['t4'])
  const result = await HANDLERS['task.list']({ rt, args: { limit: 1, status: 'SUCCESS' } })
  assert.deepEqual(result.data.tasks.map((item) => item.taskId), ['t3'])
})

test('并行任务写入同一目录时，每份内容都保留', async (t) => {
  const { dir, store } = await fixture(t)
  const output = path.join(dir, 'shared-output')
  const contents = ['first', 'second', 'third', 'fourth']
  contents.forEach((_, i) => store.setTaskOutput('t' + i, { dir: output, fileName: 'image' }))
  const writes = await Promise.all(contents.map((value, i) => store.writeOutput('t' + i, 'remote.png', value)))
  assert.ok(writes.every((item) => item.ok))
  assert.equal(new Set(writes.map((item) => item.path)).size, contents.length)
  assert.deepEqual(await Promise.all(writes.map((item) => fs.readFile(item.path, 'utf8'))), contents)
})

test('Key 迁移在没有后续操作时也持久化，备份保留其它字段', async (t) => {
  const { dir, store } = await fixture(t)
  const legacy = { keys: { entries: [{ id: 'old', key: 'synthetic-legacy-key', region: 'cn' }] }, keep: 42 }
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(legacy))
  await fs.writeFile(path.join(dir, 'state.json.bak-1'), JSON.stringify(legacy))
  const boot = () => bootRuntime({ ctx: { get: () => undefined }, config: { dataDir: dir }, logger: null })
  const first = await boot()
  assert.equal(first.pool.size, 1)
  assert.equal((await store.readSecrets()).pool.entries.length, 1)
  assert.equal((await store.loadState()).keys, undefined)
  const backup = JSON.parse(await fs.readFile(path.join(dir, 'state.json.bak-1'), 'utf8'))
  assert.equal(backup.keys, undefined)
  assert.equal(backup.keep, 42)
  assert.equal((await boot()).pool.size, 1)
})

test('机密文件写失败时保留旧 Key，不能宣称迁移完成', async (t) => {
  const { dir, store } = await fixture(t)
  const original = Store.prototype.writeSecrets
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ keys: { entries: [{ id: 'old', key: 'synthetic-old', region: 'cn' }] } }))
  Store.prototype.writeSecrets = async () => ({ ok: false, error: { code: 'STORE_WRITE_FAILED', message: 'disk full' } })
  try {
    const rt = await bootRuntime({ ctx: { get: () => undefined }, config: { dataDir: dir }, logger: null })
    assert.equal(rt.pool.size, 1)
    assert.ok((await store.loadState()).keys)
    assert.ok(rt.warnings.some((item) => item.includes('迁移未完成')))
  } finally {
    Store.prototype.writeSecrets = original
  }
})

test('恢复旧版本不完整迁移遗留的 state 备份', async (t) => {
  const { dir, store } = await fixture(t)
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({ legacyKeysMigratedAt: 1 }))
  await fs.writeFile(path.join(dir, 'state.json.bak-2'), JSON.stringify({ keys: { entries: [{ id: 'recovered', key: 'synthetic-backup', region: 'cn' }] } }))
  const rt = await bootRuntime({ ctx: { get: () => undefined }, config: { dataDir: dir }, logger: null })
  assert.equal(rt.pool.rawKey('recovered'), 'synthetic-backup')
  assert.equal((await store.readSecrets()).pool.entries.length, 1)
})

test('输出目录、轮询间隔和等待预算经过装配后生效', async (t) => {
  const { dir } = await fixture(t)
  const outputDir = path.join(dir, 'custom')
  const config = normalizeConfig({ dataDir: dir, outputDir, pollIntervalMs: 123, maxWaitMs: 4567 })
  const rt = await bootRuntime({ ctx: { get: () => undefined }, config, logger: null })
  assert.equal(rt.coreReady, true)
  assert.equal(rt.store.outputsRoot, outputDir)
  assert.equal(rt.runner.firstPollDelayMs, 123)
  assert.equal(rt.runner.pollIntervalMs, 123)
  assert.equal(rt.runner.maxWaitMs, 4567)
  assert.equal(rt.runner.taskTimeoutMs, 4567)
  assert.ok(pollDelay(1, 123) < pollDelay(1))
  rt.pool.add({ id: 'saved', key: 'synthetic-persist', region: 'cn' })
  rt.pool.update('saved', { label: 'latest' })
  assert.equal((await rt.flushPersistence()).ok, true)
  assert.equal((await rt.store.readSecrets()).pool.entries[0].label, 'latest')
})

test('明确的认证或额度拒绝会换同地域 Key，未知提交结果不换', async (t) => {
  const { runner, store } = await fixture(t)
  const calls = []
  const successful = runner({ createTask: async (key) => {
    calls.push(key)
    return key === 'synthetic-cn-first' ? { ok: false, error: { code: 'QUOTA', message: 'quota' } } : { ok: true, taskId: 'accepted' }
  } })
  assert.equal((await successful.submit({ workflowConfig: workflow })).ok, true)
  assert.deepEqual(calls, ['synthetic-cn-first', 'synthetic-cn-second'])
  const uncertainCalls = []
  const uncertain = runner({ createTask: async (key) => {
    uncertainCalls.push(key)
    return { ok: false, error: { code: 'TRANSPORT_UNCERTAIN', uncertain: true, message: 'connection lost' } }
  } })
  const result = await uncertain.submit({ workflowConfig: workflow })
  assert.equal(result.error.uncertain, true)
  assert.equal(uncertainCalls.length, 1)
  assert.equal((await store.getTask(result.error.localTaskId)).status, 'UNCERTAIN')
})

test('轮询跳过失效 Key，并把后续错误归到实际使用的 Key', async (t) => {
  const { runner, pool } = await fixture(t)
  const value = runner({})
  pool.report('cn1', 'AUTH')
  const task = { keyId: 'cn1', region: 'cn' }
  assert.equal(value._keyFor(task), 'synthetic-cn-second')
  assert.equal(task.keyId, 'cn2')
  value._applyQuery(task, { ok: false, code: 'AUTH' })
  assert.equal(pool.list().find((key) => key.id === 'cn2').invalid, true)
  assert.equal(pool.list().find((key) => key.id === 'os1').invalid, false)
  pool.update('cn1', { key: 'synthetic-moved', region: 'overseas' })
  pool.update('cn2', { key: 'synthetic-healthy', region: 'cn' })
  assert.equal(value._keyFor({ keyId: 'cn1', region: 'cn' }), 'synthetic-healthy')
})

test('刷新超时任务时使用记录中的地域，收集结果后才公布成功', async (t) => {
  const { dir, store, rt, runner } = await fixture(t)
  const output = { dir: path.join(dir, 'recovered-output'), fileName: 'recovered' }
  await store.saveTask({ taskId: 'remote', region: 'overseas', keyId: 'os1', status: 'ERROR', errorCode: 'TIMEOUT', createdAt: 1, results: [], output })
  const calls = []
  let downloads = 0
  rt.runner = runner({ queryOutputs: async (key, region) => {
    calls.push({ key, region })
    return { ok: true, status: 'SUCCESS', outputs: [{ url: 'https://example.invalid/result.png', fileType: 'png' }] }
  }, downloadBytes: async () => { downloads++; return { ok: true, bytes: Buffer.from('data') } } })
  const results = await Promise.all([
    HANDLERS['task.status']({ rt, args: { taskId: 'remote', region: 'cn' } }),
    rt.runner.status('remote', { refresh: true }),
  ])
  assert.ok(results.every((item) => item.ok))
  assert.deepEqual(calls, [{ key: 'synthetic-overseas', region: 'overseas' }])
  assert.equal(downloads, 1)
  const saved = await store.getTask('remote')
  assert.equal(saved.status, 'SUCCESS')
  assert.equal(saved.errorCode, '')
  assert.equal(saved.results.length, 1)
  assert.equal(saved.results[0].localPath, path.join(output.dir, 'recovered.png'))
  assert.equal(await fs.readFile(saved.results[0].localPath, 'utf8'), 'data')
  assert.ok(saved.finishedAt > 0)
})

test('下载的保存设置在重启恢复后仍然生效', async (t) => {
  const { dir, store, pool, runner } = await fixture(t)
  const value = runner({ createTask: async () => ({ ok: true, taskId: 'restart' }) })
  const output = { dir: path.join(dir, 'chosen'), fileName: 'chosen-name' }
  await value.submit({ workflowConfig: workflow, output })
  value.stop()
  const restoredStore = new Store({ dataDir: dir })
  const restored = new TaskRunner({ store: restoredStore, keys: pool, api: {}, sleep: neverSleep })
  t.after(() => restored.stop())
  await restored.resume()
  assert.equal(restoredStore.outputDir('restart'), output.dir)
  const saved = await restoredStore.writeOutput('restart', 'original.png', 'result')
  assert.equal(path.basename(saved.path), 'chosen-name.png')
  assert.deepEqual((await store.getTask('restart')).output, output)
})

test('提交会使用本地默认值，调用参数可以覆盖默认值', async (t) => {
  const { runner } = await fixture(t)
  let payload
  const value = runner({ createTask: async (_key, _region, spec) => { payload = spec; return { ok: true, taskId: 'defaults' } } })
  const config = { ...workflow, nodes: [
    { nodeId: '1', fieldName: 'text', role: 'prompt', default: 'local prompt' },
    { nodeId: '2', fieldName: 'steps', role: 'number', valueType: 'number', default: 30 },
  ] }
  assert.equal((await value.submit({ workflowConfig: config, values: { params: { steps: 40 } } })).ok, true)
  assert.deepEqual(payload.nodeInfoList, [
    { nodeId: '1', fieldName: 'text', fieldValue: 'local prompt' },
    { nodeId: '2', fieldName: 'steps', fieldValue: '40' },
  ])
})

test('等待超时在模型回执和后台作业中均不显示完成', async () => {
  const waited = { ok: true, timedOut: true, task: { taskId: 'waiting', status: 'RUNNING' }, results: [] }
  const runner = { wait: async () => waited }
  const result = await HANDLERS['task.wait']({ rt: { runner }, args: { taskId: 'waiting' } })
  assert.equal(result.data.timedOut, true)
  assert.match(result.text, /仍在运行/)
  assert.doesNotMatch(result.text, /✅.*完成/)
  let spec
  startTaskJob({ jobs: { start: (value) => { spec = value; return 'job' } }, runner, taskId: 'waiting' })
  const outcome = await spec.run({ append() {}, updateProgress() {} }).done
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /仍在运行/)
})

test('批量部分失败保留已创建的任务、输出设置和后台作业', async (t) => {
  const { dir, store, rt } = await fixture(t)
  await store.saveWorkflow(workflow)
  let jobSpec
  rt.ctx.get = (name) => name === 'jobs' ? { start: (spec) => { jobSpec = spec; return 'job-partial' } } : undefined
  const requests = []
  rt.runner = { submit: async (request) => {
    requests.push(request)
    return requests.length === 1 ? { ok: true, taskId: 'paid-task' } : { ok: false, error: { code: 'TRANSPORT_UNCERTAIN', uncertain: true, localTaskId: 'uncertain-record', message: 'unknown' } }
  } }
  const result = await HANDLERS['workflow.run']({ rt, args: { name: 'Workflow', repeat: 3, saveDir: dir, fileName: 'image' } })
  assert.equal(result.ok, false)
  assert.equal(requests.length, 2)
  assert.equal(result.data.tasks[0].taskId, 'paid-task')
  assert.equal(result.data.jobId, 'job-partial')
  assert.equal(result.error.localTaskId, 'uncertain-record')
  assert.match(result.text, /勿整批重投/)
  assert.deepEqual(requests[0].output, { dir, fileName: 'image_1' })
  assert.ok(jobSpec)
})

test('key.balance 查询指定 Key 的地域和账户', async (t) => {
  const { rt } = await fixture(t)
  const queried = []
  rt.api = { accountStatus: async (key, region) => { queried.push({ key, region }); return { ok: true, data: { remainCoins: 123 } } } }
  const result = await HANDLERS['key.balance']({ rt, args: { id: 'os1' } })
  assert.equal(result.ok, true)
  assert.deepEqual(queried, [{ key: 'synthetic-overseas', region: 'overseas' }])
  assert.equal((await HANDLERS['key.balance']({ rt, args: { id: 'missing' } })).error.code, 'NOT_FOUND')
})

test('核心装配失败时 diagnostics 仍能返回加载原因', async (t) => {
  const { dir } = await fixture(t)
  const rt = createRuntime({ ctx: { get: () => undefined }, config: { dataDir: dir }, logger: null })
  rt.loadError = 'module missing'
  const result = await makeCallTool(() => rt).execute({ action: 'diagnostics' }, {})
  assert.equal(result.ok, true)
  assert.equal(result.data.coreReady, false)
  assert.equal(result.data.loadError, 'module missing')
})

test('提交 HTTP 502 记为未知结果，服务端回显的 Key 不进入回执', async () => {
  const secret = 'synthetic-secret-only-for-this-test'
  let calls = 0
  const api = new RunningHubApi({ fetchImpl: async () => {
    calls++
    return new Response(JSON.stringify({ code: 502, msg: 'upstream failure ' + secret }), { status: 502 })
  } })
  const result = await api.createTask(secret, 'cn', { workflowId: '123' })
  assert.equal(result.error.code, 'TRANSPORT_UNCERTAIN')
  assert.equal(result.error.uncertain, true)
  assert.equal(calls, 1)
  assert.equal(JSON.stringify(result).includes(secret), false)
})

test('图片附件保留宿主返回的原始尺寸元数据', async () => {
  const originalDimensions = { width: 4000, height: 2000 }
  const ref = { attachmentId: 'sha256:' + 'a'.repeat(64), mediaType: 'image/png', bytes: 8, width: 2000, height: 1000, originalDimensions }
  const result = await attachResult({ get: () => ({ saveImage: async () => ref }) }, {
    kind: 'image', filename: 'image.png', bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  })
  assert.deepEqual(result.attachment.originalDimensions, originalDimensions)
})

test('旧密钥清理只修改已知字段，不删除含长 ID 的工作流', async (t) => {
  const { dir, store } = await fixture(t)
  const legacy = { keys: { entries: [{ id: 'legacy', key: 'a'.repeat(32), region: 'cn' }] }, keep: 'b'.repeat(32) }
  const legitimate = { id: 'c'.repeat(32), model: 'd'.repeat(64) }
  const unrelated = store.resolve('workflows', 'legitimate.json')
  await fs.writeFile(unrelated, JSON.stringify(legitimate))
  await fs.writeFile(store.resolve('state.json'), JSON.stringify(legacy))
  await fs.writeFile(store.resolve('state.json.bak-1'), JSON.stringify(legacy))
  await fs.writeFile(store.resolve('secrets.json.prescrub-old'), JSON.stringify({ pool: legacy.keys }))
  await scrubLegacySecrets({ dataDir: dir, dryRun: true })
  assert.deepEqual(await store.loadState(), legacy)
  await scrubLegacySecrets({ dataDir: dir })
  assert.deepEqual(JSON.parse(await fs.readFile(unrelated, 'utf8')), legitimate)
  assert.equal((await store.readSecrets()).pool.entries[0].key, 'a'.repeat(32))
  assert.deepEqual(JSON.parse(await fs.readFile(store.resolve('state.json.bak-1'), 'utf8')), { keep: 'b'.repeat(32) })
  assert.equal((await fs.readdir(dir)).includes('secrets.json.prescrub-old'), false)
  await scrubLegacySecrets({ dataDir: dir })
  assert.deepEqual(JSON.parse(await fs.readFile(unrelated, 'utf8')), legitimate)
})

test('提示词写入指定节点，失效的目标配置不会静默改写其它节点', () => {
  const config = { ...workflow, promptOptimizer: { targetNodeId: '2' }, nodes: [
    { nodeId: '1', fieldName: 'text', role: 'prompt', default: 'first prompt' },
    { nodeId: '2', fieldName: 'text', role: 'prompt', default: 'second prompt' },
  ] }
  const payload = buildNodeInfoList(config, { prompt: 'chosen' }, { includeDefaults: true })
  assert.deepEqual(payload.map((item) => item.fieldValue), ['first prompt', 'chosen'])
  config.promptOptimizer.targetNodeId = 'deleted'
  assert.equal(validateRun(config, { prompt: 'chosen' }).issues[0].code, 'PROMPT_TARGET_NOT_FOUND')
})

test('优化文档进入子代理系统提示词，丢失文档时明确失败', async (t) => {
  const { store, rt } = await fixture(t)
  const config = { ...workflow, promptOptimizer: { enabled: true, docId: 'rules', asSubagentSystemPrompt: true } }
  await store.saveWorkflow(config)
  await store.savePromptDoc({ id: 'rules', name: 'Rules', content: 'Use exactly three sentences.' })
  rt.promptdoc = { renderForModel: (doc) => doc.content }
  let request
  let disposed = false
  rt.ctx.get = () => ({ list: () => ['spawn'], start: async (_provider, spec) => {
    request = spec
    return { result: Promise.resolve({ output: [{ type: 'text', text: 'Optimized.' }] }), dispose: () => { disposed = true } }
  } })
  const result = await HANDLERS['prompt.optimize']({ rt, args: { name: 'Workflow', userRequest: 'A cat' }, exec: { agent: {} } })
  assert.equal(result.ok, true)
  assert.match(request.persona, /Use exactly three sentences/)
  assert.match(request.prompt[0].text, /A cat/)
  assert.doesNotMatch(request.prompt[0].text, /Use exactly three sentences/)
  assert.deepEqual(request.toolFilter, { allow: [] })
  assert.equal(disposed, true)
  await store.deletePromptDoc('rules')
  assert.equal((await HANDLERS['prompt.optimize']({ rt, args: { name: 'Workflow', userRequest: 'A cat' } })).error.code, 'DOC_NOT_FOUND')
})

test('默认本地素材会上传；缺失路径在提交前报错，RH 文件名仍可直接使用', async (t) => {
  const { dir, runner } = await fixture(t)
  const local = path.join(dir, 'ref.png')
  await fs.writeFile(local, 'reference')
  const uploads = []
  const requests = []
  const value = runner({
    uploadFile: async (_key, _region, bytes, filename, opts) => { uploads.push({ bytes: bytes.length, filename, type: opts.fileType }); return { ok: true, fileName: 'openapi/ref.png' } },
    createTask: async (_key, _region, payload) => { requests.push(payload); return { ok: true, taskId: 'material-' + requests.length } },
  })
  const config = { ...workflow, nodes: [{ nodeId: '1', fieldName: 'image', role: 'image', required: true, default: local }] }
  assert.equal((await value.submit({ workflowConfig: config })).ok, true)
  assert.deepEqual(uploads, [{ bytes: 9, filename: 'ref.png', type: 'image' }])
  assert.equal(requests[0].nodeInfoList[0].fieldValue, 'openapi/ref.png')
  const missing = await value.submit({ workflowConfig: config, values: { images: { 1: path.join(dir, 'missing.png') } } })
  assert.equal(missing.error.code, 'MATERIAL_NOT_FOUND')
  assert.equal(requests.length, 1)
  assert.equal((await value.submit({ workflowConfig: config, values: { images: { image: 'openapi/already.png' } } })).ok, true)
  assert.equal(requests[1].nodeInfoList[0].fieldValue, 'openapi/already.png')
  assert.equal(uploads.length, 1)
})

test('保存文件失败保留远端 URL，不能返回下载成功', async (t) => {
  const { store, runner } = await fixture(t)
  store.writeOutput = async () => ({ ok: false, error: { code: 'STORE_WRITE_FAILED', message: 'disk full' } })
  const value = runner({ downloadBytes: async () => ({ ok: true, bytes: Buffer.from('image') }) })
  const task = { taskId: 'disk-fail', outputKind: 'video', outputs: [{ url: 'https://example.invalid/image.png', outputType: 'mp4' }] }
  const results = await value._collect(task)
  assert.equal(results[0].error, 'disk full')
  assert.equal(results[0].errorCode, 'STORE_WRITE_FAILED')
  assert.equal(results[0].url, 'https://example.invalid/image.png')
  assert.equal(results[0].localPath, undefined)
  assert.equal(results[0].steganography, true)
})

test('没有后台作业服务时，不承诺发送完成通知', async (t) => {
  const { store, rt } = await fixture(t)
  await store.saveWorkflow(workflow)
  rt.runner = { submit: async () => ({ ok: true, taskId: 'background' }) }
  const result = await HANDLERS['workflow.run']({ rt, args: { name: 'Workflow', background: true } })
  assert.equal(result.ok, true)
  assert.match(result.text, /主动取回结果/)
  assert.doesNotMatch(result.text, /跑完会自动通知/)
})

test('后台完成通知包含下载失败原因、远端地址和文本结果', async () => {
  let spec
  startTaskJob({ jobs: { start: (value) => { spec = value; return 'job-results' } }, taskId: 'result-task', runner: {
    wait: async () => ({ ok: true, task: { status: 'SUCCESS' }, results: [
      { kind: 'image', error: 'disk full', url: 'https://example.invalid/result.png', note: 'carrier image' },
      { kind: 'text', text: 'generated text' },
    ] }),
  } })
  const outcome = await spec.run({ append() {}, updateProgress() {} }).done
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.result, /disk full/)
  assert.match(outcome.result, /https:\/\/example.invalid\/result.png/)
  assert.match(outcome.result, /carrier image/)
  assert.match(outcome.result, /generated text/)
})
