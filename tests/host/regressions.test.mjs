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

test('预检使用本次输入和运行校验规则，批量运行只校验一次', async (t) => {
  const { store, rt } = await fixture(t)
  const config = { ...workflow, nodes: [
    { nodeId: '1', fieldName: 'text', role: 'prompt', required: true, default: '' },
    { nodeId: '2', fieldName: 'text', role: 'negative_prompt', required: true, default: '' },
    { nodeId: '3', fieldName: 'image', role: 'image', required: true, default: '' },
    { nodeId: '4', fieldName: 'steps', role: 'number', valueType: 'number', min: 1, max: 50, boundsSource: 'user', default: 20 },
    { nodeId: '4', fieldName: 'cfg', role: 'number', valueType: 'number', max: 20, boundsSource: 'heuristic', default: 8 },
    { nodeId: '4', fieldName: 'mode', valueType: 'enum', options: ['a', 'b'], optionsSource: 'user', default: 'a' },
  ] }
  await store.saveWorkflow(config)
  const input = { prompt: 'a cat', negativePrompt: 'blur', images: { '3': 'openapi/input.png' }, params: { steps: 30, cfg: 30 } }
  for (const values of [input, { ...input, images: {} }, { ...input, params: { steps: 60, mode: 'unknown' } }]) {
    const expected = validateRun(config, values)
    const actual = await HANDLERS['workflow.validate']({ rt, args: { name: 'Workflow', ...values } })
    assert.equal(actual.ok, expected.ok)
    assert.deepEqual(actual.data.issues, expected.issues)
    assert.deepEqual(actual.data.warnings, expected.warnings)
  }
  const requests = []
  rt.runner = { submit: async request => {
    requests.push(request)
    request.uploadCache.set('synthetic-upload', 'metadata')
    return { ok: true, taskId: 'task-' + requests.length }
  } }
  let checks = 0
  rt.workflow.validateRun = (...args) => { checks++; return validateRun(...args) }
  assert.equal((await HANDLERS['workflow.run']({ rt, args: { name: 'Workflow', ...input, images: {} } })).ok, false)
  assert.equal(requests.length, 0, '缺少素材时不提交任务')
  checks = 0
  assert.equal((await HANDLERS['workflow.run']({ rt, args: { name: 'Workflow', ...input, repeat: 2 } })).ok, true)
  assert.equal(checks, 1)
  assert.ok(requests.every(request => request.validated === true))
  assert.equal(requests[0].uploadCache, requests[1].uploadCache)
  assert.equal(requests[0].uploadCache.size, 0, '提交结束后释放批次缓存')
  await store.saveWorkflow({ ...config, nodes: config.nodes.filter(node => !['prompt', 'negative_prompt'].includes(node.role)) })
  assert.equal((await HANDLERS['workflow.validate']({ rt, args: { name: 'Workflow', images: input.images } })).ok, true, '无提示词的素材处理工作流也可使用')
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

test('面板保留状态筛选，模型历史只返回24小时内的ID和结果链接', async (t) => {
  const { store, rt } = await fixture(t)
  const now = Date.now()
  for (let i = 1; i <= 4; i++) await store.saveTask({ taskId: 't' + i, createdAt: now - 5000 + i,
    finishedAt: i === 1 ? now - 25 * 60 * 60 * 1000 : now - 1000 + i,
    status: i % 2 ? 'SUCCESS' : 'RUNNING', workflowName: 'private-workflow', promptPreview: 'private-prompt',
    outputs: [{ fileUrl: 'https://results.example/' + i + '.png' }], results: [{ url: 'https://results.example/' + i + '.png' }] })
  const items = await buildMethods(rt).tasksList({ limit: 1 })
  assert.deepEqual(items.map((item) => item.taskId), ['t4'])
  const filtered = await buildMethods(rt).tasksList({ limit: 1, status: 'success' })
  assert.deepEqual(filtered.map((item) => item.taskId), ['t3'])
  await store.saveTask({ taskId: 'empty', createdAt: now, finishedAt: now, status: 'SUCCESS' })
  rt.requireCore = () => null
  const result = await makeCallTool(() => rt).execute({ action: 'task.list', limit: 1 }, {})
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.deepEqual(result.data.tasks, [{ id: 't3', links: ['https://results.example/3.png'] }])
  assert.deepEqual(JSON.parse(result.envelope), { ok: true, data: result.data })
  const rendered = makeCallTool(() => rt).output.render({}, result).map(block => block.text || '').join('\n')
  assert.equal(rendered.match(/https:\/\/results\.example\/3\.png/g)?.length, 1)
  assert.doesNotMatch(JSON.stringify(result), /private-workflow|private-prompt|1\.png|2\.png|4\.png/)
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

test('工作流探测只报告实际错误一次；显式验证成功才恢复失效 Key', async (t) => {
  const { rt, pool } = await fixture(t)
  let verified = false
  rt.core = { detectRegion: async () => verified ? 'cn' : 'invalid' }
  rt.api = {
    getWorkflowJson: async () => ({ ok: false, error: { code: 'AUTH', message: 'bad key' } }),
    accountStatus: async () => verified ? { ok: true, data: { remainCoins: 1 } } : { ok: false, error: { code: 'AUTH' } },
  }
  const reports = []
  const report = pool.report.bind(pool)
  pool.report = (id, outcome) => { reports.push([id, outcome]); return report(id, outcome) }
  const methods = buildMethods(rt)
  for (const probe of [
    () => HANDLERS['workflow.probe']({ rt, args: { workflowId: '123', region: 'cn' } }),
    () => methods.probeWorkflow({ request: { workflowId: '123', region: 'cn' } }),
  ]) {
    pool.reset('cn1')
    reports.length = 0
    assert.equal((await probe()).ok, false)
    assert.deepEqual(reports, [['cn1', 'AUTH']])
  }
  for (const verify of [
    () => HANDLERS['key.detect']({ rt, args: { id: 'cn1' } }),
    () => HANDLERS['key.balance']({ rt, args: { id: 'cn1' } }),
    () => methods.keysDetect({ id: 'cn1' }),
    () => methods.keysBalance({ id: 'cn1' }),
  ]) {
    verified = false
    pool.report('cn1', 'AUTH')
    assert.equal((await verify()).ok, false)
    assert.equal(pool.list().find(key => key.id === 'cn1').invalid, true)
    verified = true
    assert.equal((await verify()).ok, true)
    assert.equal(pool.isAvailable('cn1'), true)
  }
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

test('下载与附件分别重试，成功文件和付费任务不会重复创建，补发只读取本地', async (t) => {
  const { store, rt, runner } = await fixture(t)
  const downloads = []
  const attached = []
  let downloadFailed = true
  let attachFailed = true
  let createCalls = 0
  const value = runner({
    createTask() { createCalls += 1 },
    async downloadBytes(url) {
      downloads.push(url)
      if (url.endsWith('/download.png') && downloadFailed) {
        downloadFailed = false
        return { ok: false, error: { code: 'DOWNLOAD_FAILED', message: 'CDN offline' } }
      }
      return { ok: true, bytes: Buffer.from(url) }
    },
  }, {
    async attach(spec) {
      attached.push(spec.filename)
      if (spec.filename === 'attachment.png' && attachFailed) {
        attachFailed = false
        throw Object.assign(new Error('attachment service offline'), { code: 'ATTACH_FAILED' })
      }
      assert.equal(spec.bytes.toString(), spec.url)
      return { attachmentId: spec.filename + '-' + attached.length }
    },
  })
  rt.runner = value
  const task = { taskId: 'paid-once', status: 'SUCCESS', createdAt: Date.now(), outputs: [
    'https://example.test/good.png', 'https://example.test/download.png', 'https://example.test/attachment.png',
  ] }
  await store.saveTask(task)
  await value._settle(task.taskId, task)
  const initial = await store.getTask(task.taskId)
  assert.equal(initial.status, 'SUCCESS')
  assert.ok(initial.results[2].localPath)
  assert.equal(initial.results[2].error, undefined)
  assert.equal(initial.results[2].attachmentErrorCode, 'ATTACH_FAILED')
  const methods = buildMethods(rt)
  const displayed = await methods.tasksGet({ taskId: task.taskId })
  assert.equal(displayed.results[0].attachmentId, initial.results[0].attachment.attachmentId)
  assert.equal(displayed.results[1].errorCode, 'DOWNLOAD_FAILED')
  assert.equal(displayed.results[2].attachmentError, 'attachment service offline')
  const waited = await HANDLERS['task.wait']({ rt, args: { taskId: task.taskId } })
  assert.equal(waited.ok, false)
  assert.equal(waited.error.code, 'RESULT_INCOMPLETE')
  assert.match(waited.text, /已保存 2 个 · 附件 1 个/)
  assert.match(waited.text, /task.retry/)
  assert.doesNotMatch(waited.text, /已作为附件返回/)

  let jobSpec
  startTaskJob({ jobs: { start(spec) { jobSpec = spec; return 'job' } }, runner: value, taskId: task.taskId })
  const notice = await jobSpec.run({ append() {}, updateProgress() {} }).done
  assert.match(notice.result, /已保存 2 个文件/)
  assert.match(notice.result, /附件未就绪/)
  assert.match(notice.result, /task.retry/)

  const retried = await HANDLERS['task.retry']({ rt, args: { taskId: task.taskId } })
  assert.equal(retried.ok, true)
  assert.equal(retried.images.length, 3)
  assert.deepEqual(downloads, [...task.outputs, task.outputs[1]])
  assert.deepEqual(attached, ['good.png', 'attachment.png', 'download.png', 'attachment.png'])
  const saved = await store.getTask(task.taskId)
  assert.equal(saved.finishedAt, initial.finishedAt)
  assert.equal(saved.results[0].localPath, initial.results[0].localPath)
  assert.ok(saved.results.every(result => !result.error && !result.attachmentError))
  assert.equal((await store.listOutputs(task.taskId)).length, 3)

  assert.equal((await methods.tasksRefresh({ taskId: task.taskId })).status, 'SUCCESS')
  const panelRetry = await methods.tasksRetry({ taskId: task.taskId })
  assert.equal(panelRetry.status, 'SUCCESS')
  assert.ok(panelRetry.results.every(result => result.attachmentId && !result.attachmentError))
  assert.equal(downloads.length, 4)

  const resent = await HANDLERS['task.retry']({ rt, args: { taskId: task.taskId, resend: true } })
  assert.equal(resent.ok, true)
  assert.equal(downloads.length, 4)
  assert.equal(attached.length, 7)
  assert.equal(createCalls, 0)
  assert.equal((await store.getTask(task.taskId)).status, 'SUCCESS')

  store.saveTask = async () => ({ ok: false, error: { message: 'disk full' } })
  const unsaved = await value.retryResults(task.taskId)
  assert.equal(unsaved.ok, false)
  assert.equal(unsaved.error.code, 'STORE_WRITE_FAILED')
})

test('任务工具默认返回摘要，详情显式读取，完整请求保留在本地', async (t) => {
  const { store, rt } = await fixture(t)
  await store.saveWorkflow({ ...workflow, nodes: [{ nodeId: '1', fieldName: 'text', role: 'prompt', default: 'default prompt' }] })
  const now = Date.now()
  const attachment = { attachmentId: 'image-reference', width: 512, height: 512 }
  const outputs = [{ url: 'https://results.example/output.png', consumeCoins: 16 }]
  const results = [{ kind: 'image', filename: 'output.png', url: outputs[0].url, localPath: 'C:\\output\\output.png', attachment }]
  const task = { taskId: 'completed', status: 'SUCCESS', createdAt: now - 5000, finishedAt: now - 1000,
    progress: '100%',
    workflowName: 'private-workflow', promptPreview: 'private-prompt', nodeInfoCount: 5,
    nodeInfoList: [{ nodeId: 'private-node', fieldValue: 'private-value' }], keyMasked: 'private-key-mask', outputs, results }
  await store.saveTask(task)
  let outcome = { ok: true, task, results, timedOut: false }
  rt.requireCore = () => null
  rt.runner = {
    submit: async () => ({ ok: true, ...task }),
    wait: async () => outcome,
    retryResults: async () => outcome,
    status: async () => outcome,
  }
  const tool = makeCallTool(() => rt)
  const expected = [{ taskId: task.taskId, status: 'SUCCESS', results: [{ kind: 'image', filename: 'output.png', localPath: results[0].localPath, url: results[0].url }] }]
  for (const args of [
    { action: 'workflow.run', name: 'Workflow', prompt: 'private-prompt', waitMs: 1000 },
    { action: 'task.wait', taskId: task.taskId },
    { action: 'task.retry', taskId: task.taskId },
  ]) {
    const out = await tool.execute(args, {})
    assert.equal(out.ok, true, JSON.stringify(out))
    assert.deepEqual(out.data, { tasks: expected, timedOut: false })
    const rendered = tool.output.render(args, out)
    const text = rendered.filter(block => block.type === 'text').map(block => block.text).join('\n')
    assert.doesNotMatch(JSON.stringify(out.data) + text, /private-|promptPreview|nodeInfo|keyMasked|consumeCoins|attachmentId/)
    assert.equal(text.split(results[0].url).length - 1, 1, '在线链接只出现一次')
    assert.equal(text.split(JSON.stringify(results[0].localPath).slice(1, -1)).length - 1, 1, '本地路径只出现一次')
    assert.deepEqual(rendered.filter(block => block.type === 'image'), [{ type: 'image', attachment }])
  }
  const submitted = await tool.execute({ action: 'workflow.run', name: 'Workflow' }, {})
  assert.deepEqual(submitted.data.tasks, [{ taskId: task.taskId, status: 'SUCCESS' }])
  const status = await tool.execute({ action: 'task.status', taskId: task.taskId }, {})
  assert.deepEqual(status.data.task, { taskId: task.taskId, status: 'SUCCESS', progress: '100%' })
  assert.doesNotMatch(status.envelope, /private-|outputs|results|promptPreview|nodeInfo|keyMasked/)
  const details = await tool.execute({ action: 'task.status', taskId: task.taskId, details: true }, {})
  assert.deepEqual(details.data.task, task)
  outcome = { ...outcome, task: { ...task, finishedAt: now - 25 * 60 * 60 * 1000 } }
  const expired = await tool.execute({ action: 'task.retry', taskId: task.taskId, resend: true }, {})
  assert.doesNotMatch(expired.envelope, /https:\/\//)
  assert.equal(expired.images.length, 1, '链接过期仍可补发本地附件')
  outcome = { ...outcome, ok: false, error: { code: 'STORE_WRITE_FAILED', message: 'disk full' }, task: { ...task, persisted: false } }
  const failed = await tool.execute({ action: 'task.retry', taskId: task.taskId }, {})
  assert.equal(failed.error.code, 'STORE_WRITE_FAILED')
  assert.equal(failed.data.tasks[0].persisted, false)
  assert.doesNotMatch(failed.envelope, /private-|promptPreview|nodeInfo|keyMasked/)
  const failedStatus = await tool.execute({ action: 'task.status', taskId: task.taskId }, {})
  assert.equal(failedStatus.ok, false)
  assert.equal(failedStatus.error.code, 'STORE_WRITE_FAILED')
  assert.equal(failedStatus.data.task.persisted, false)
  assert.doesNotMatch(failedStatus.envelope, /private-|outputs|results|promptPreview|nodeInfo|keyMasked/)
  const stored = await store.getTask(task.taskId)
  assert.equal(stored.promptPreview, task.promptPreview)
  assert.deepEqual(stored.nodeInfoList, task.nodeInfoList)
  assert.deepEqual(stored.outputs, outputs)
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
  assert.equal(requests[0].uploadCache, requests[1].uploadCache)
  assert.equal(requests[0].uploadCache.size, 0, '部分提交失败后也释放批次缓存')
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
  const reference = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGmQAAAAASUVORK5CYII=', 'base64')
  await fs.writeFile(local, reference)
  const uploads = []
  const requests = []
  const value = runner({
    uploadFile: async (_key, _region, bytes, filename, opts) => { uploads.push({ bytes: bytes.length, filename, type: opts.fileType }); return { ok: true, fileName: 'openapi/ref.png' } },
    createTask: async (_key, _region, payload) => { requests.push(payload); return { ok: true, taskId: 'material-' + requests.length } },
  })
  const config = { ...workflow, nodes: [{ nodeId: '1', fieldName: 'image', role: 'image', required: true, default: local }] }
  assert.equal((await value.submit({ workflowConfig: config })).ok, true)
  assert.deepEqual(uploads, [{ bytes: reference.length, filename: 'ref.png', type: 'image' }])
  assert.equal(requests[0].nodeInfoList[0].fieldValue, 'openapi/ref.png')
  const missing = await value.submit({ workflowConfig: config, values: { images: { 1: path.join(dir, 'missing.png') } } })
  assert.equal(missing.error.code, 'MATERIAL_NOT_FOUND')
  assert.equal(requests.length, 1)
  assert.equal((await value.submit({ workflowConfig: config, values: { images: { image: 'openapi/already.png' } } })).ok, true)
  assert.equal(requests[1].nodeInfoList[0].fieldValue, 'openapi/already.png')
  assert.equal(uploads.length, 1)
  const invalid = path.join(dir, 'not-an-image.png')
  const secret = path.join(dir, 'secrets.json')
  const oversized = path.join(dir, 'oversized.png')
  await fs.writeFile(invalid, 'config text')
  await fs.writeFile(secret, reference)
  await fs.writeFile(oversized, reference)
  await fs.truncate(oversized, 128 * 1024 * 1024 + 1)
  for (const [file, code] of [[invalid, 'MATERIAL_TYPE_REFUSED'], [secret, 'MATERIAL_REFUSED'], [oversized, 'MATERIAL_TOO_LARGE']]) {
    const refused = await value.submit({ workflowConfig: config, values: { images: { 1: file } } })
    assert.equal(refused.error.code, code)
  }
  assert.equal(uploads.length, 1, '不合法素材不能上传')
  assert.equal(requests.length, 2, '不合法素材不能创建收费任务')
})

test('云端提交和终态保存失败时保留 taskId，补存成功前不宣布完成也不重复下载', async t => {
  const { store, runner } = await fixture(t)
  await store.saveTask({ taskId: 'older', status: 'SUCCESS', createdAt: 1 })
  const save = store.saveTask.bind(store)
  let writable = false
  let created = 0
  let queried = 0
  let downloaded = 0
  const events = []
  store.saveTask = task => writable ? save(task) : Promise.resolve({ ok: false, error: { code: 'STORE_WRITE_FAILED', message: 'disk full' } })
  const value = runner({
    createTask: async () => { created++; return { ok: true, taskId: 'paid-task' } },
    queryOutputs: async () => { queried++; return { ok: true, status: 'SUCCESS', outputs: [{ url: 'https://results.example/result.png' }] } },
    downloadTo: async (_url, file) => { downloaded++; await fs.writeFile(file, 'result'); return { ok: true, path: file, size: 6 } },
  }, { onEvent: event => events.push(event) })
  const submitted = await value.submit({ workflowConfig: workflow })
  assert.equal(submitted.ok, true)
  assert.equal(submitted.taskId, 'paid-task')
  assert.equal(submitted.persisted, false)
  assert.match(submitted.hint, /请勿重复提交/)
  assert.equal(await store.getTask('paid-task'), undefined)
  assert.equal((await value.list({ status: 'QUEUED', limit: 1 }))[0].taskId, 'paid-task')
  assert.equal((await value.list({ status: 'SUCCESS', limit: 1 }))[0].taskId, 'older')
  await value._tick('paid-task')
  assert.equal((await value.wait('paid-task')).error.code, 'STORE_WRITE_FAILED')
  assert.equal((await value.list({ status: 'SUCCESS', limit: 1 }))[0].persisted, false)
  assert.deepEqual(value.liveTaskIds(), ['paid-task'])
  assert.equal(events.includes('task.done'), false)
  writable = true
  await value._tick('paid-task')
  assert.equal((await value.wait('paid-task')).ok, true)
  assert.deepEqual(value.liveTaskIds(), [])
  assert.equal(events.filter(event => event === 'task.done').length, 1)
  assert.deepEqual({ created, queried, downloaded }, { created: 1, queried: 1, downloaded: 1 })
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
