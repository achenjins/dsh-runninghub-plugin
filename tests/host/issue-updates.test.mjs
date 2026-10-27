import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../../host/core/store.mjs'
import { KeyPool, detectRegion } from '../../host/core/keys.mjs'
import { TaskRunner } from '../../host/core/runner.mjs'
import * as workflow from '../../host/core/workflow.mjs'
import * as promptdoc from '../../host/core/promptdoc.mjs'
import { HANDLERS, makeCallTool, MAX_TOOL_WAIT_MS } from '../../host/tools/call.mjs'
import { buildMethods } from '../../host/rpc.mjs'
import { startTaskJob } from '../../host/jobs.mjs'

const node = { nodeId: '6', fieldName: 'text', role: 'prompt', valueType: 'string', default: 'old' }
const config = { id: 'wf', name: 'Workflow', rhWorkflowId: '123', region: 'cn', nodes: [node] }

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-updates-'))
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), dir)
    assert.ok(relative.startsWith('rh-updates-') && !relative.includes(path.sep))
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const store = new Store({ dataDir: dir })
  await store.init()
  const pool = new KeyPool()
  pool.add({ id: 'k', key: 'synthetic-test-key', region: 'cn' })
  const rt = { store, pool, workflow, promptdoc, core: { detectRegion }, config: {}, ctx: { get() {} }, requireCore: () => null, warn() {}, warnings: [] }
  return { dir, store, pool, rt, methods: buildMethods(rt), tool: makeCallTool(() => rt) }
}

test('同名保存拒绝、覆盖必须明确，歧义名称不能误删，稳定 id 可精确删除', async t => {
  const { store, methods } = await fixture(t)
  assert.equal((await methods.saveWorkflow({ config })).ok, true)
  assert.equal((await methods.saveWorkflow({ config: { ...config, nodes: [] } })).error.code, 'WORKFLOW_EXISTS')
  assert.equal((await store.getWorkflow('wf')).nodes.length, 1)
  assert.equal((await methods.saveWorkflow({ config: { ...config, id: 'other' } })).error.code, 'NAME_CONFLICT')
  assert.equal((await methods.saveWorkflow({ config: { ...config, overwrite: true, description: 'changed' } })).ok, true)
  assert.equal((await store.getWorkflow('wf')).description, 'changed')
  // Existing legacy duplicates remain individually addressable by id.
  await store.saveWorkflow({ ...config, id: 'other', rhWorkflowId: '456' })
  assert.equal((await methods.deleteWorkflow({ name: 'Workflow' })).error.code, 'WORKFLOW_AMBIGUOUS')
  assert.equal((await methods.deleteWorkflow({ name: 'other' })).ok, true)
  assert.ok(await store.getWorkflow('wf'))
  assert.equal(await store.getWorkflow('other'), undefined)
})

test('workflow.update 拒绝不完整节点数组，完整数组仍按整体替换', async t => {
  const { store, rt } = await fixture(t)
  await store.saveWorkflow(config)
  for (const partial of [{ nodeId: '6', max: 50 }, { nodeId: '6', fieldName: 'text', max: 50 }]) {
    const result = await HANDLERS['workflow.update']({ rt, args: { name: 'wf', patch: { nodes: [partial] } } })
    assert.equal(result.error.code, 'INVALID_WORKFLOW')
    assert.deepEqual((await store.getWorkflow('wf')).nodes, [node])
  }
  const replacement = { ...node, nodeId: '7', default: 'replacement' }
  assert.equal((await HANDLERS['workflow.update']({ rt, args: { name: 'wf', patch: { nodes: [replacement] } } })).ok, true)
  assert.deepEqual((await store.getWorkflow('wf')).nodes, [replacement])
})

test('核心缺席和内部异常都有可读错误，不产生空成功文本', async t => {
  const { rt, tool } = await fixture(t)
  rt.requireCore = () => ({ error: { message: 'missing core' } })
  const missing = await tool.execute({ action: 'workflow.get' }, {})
  assert.match(tool.output.render({}, missing).map(block => block.text || '').join(''), /CORE_NOT_LOADED.*missing core/s)
  rt.requireCore = () => null
  rt.store.listWorkflows = async () => { throw new Error('synthetic failure') }
  const failed = await tool.execute({ action: 'workflow.get' }, {})
  assert.match(failed.text, /INTERNAL.*synthetic failure/s)
  assert.equal(failed.envelope, undefined)
})

test('文档名称、文档 id 和明确工作流选择均可读，附加指令在自行模式可见', async t => {
  const { store, rt, tool } = await fixture(t)
  const saved = await store.savePromptDoc({ name: 'Style Guide', content: 'Follow the style.' })
  await store.saveWorkflow({ ...config, promptOptimizer: { enabled: true, docId: saved.id, extraInstruction: 'No text in frame' } })
  const byName = await tool.execute({ action: 'prompt.doc_read', args: { name: 'Style Guide' } }, {})
  assert.equal(byName.ok, true)
  assert.match(byName.text, /Follow the style/)
  const byWorkflow = await tool.execute({ action: 'prompt.doc_read', args: { workflow: 'Workflow' } }, {})
  assert.match(byWorkflow.text, /No text in frame/)
  const listed = await tool.execute({ action: 'prompt.doc_list' }, {})
  assert.match(listed.text, /Style Guide/)
  const optimized = await HANDLERS['prompt.optimize']({ rt, args: { name: 'wf', userRequest: 'A forest' } })
  assert.equal(optimized.data.extraInstruction, 'No text in frame')
  const missing = await tool.execute({ action: 'prompt.doc_read', args: { name: 'missing document' } }, {})
  assert.equal(missing.error.code, 'DOC_NOT_FOUND')
})

test('文档新建碰撞不会覆盖，明确覆盖和按 id 编辑仍可用', async t => {
  const { methods, store } = await fixture(t)
  const first = await methods.docsSave({ doc: { name: 'Style Guide', content: 'first' } })
  assert.ok(first.docId)
  const collision = await methods.docsSave({ doc: { name: 'style_guide', content: 'second' } })
  assert.equal(collision.error.code, 'DOC_EXISTS')
  assert.equal((await store.getPromptDoc(first.docId)).content, 'first')
  assert.equal((await methods.docsSave({ doc: { name: 'style_guide', content: 'second', overwrite: true } })).ok, true)
  assert.equal((await methods.docsSave({ doc: { docId: first.docId, name: 'Renamed', content: 'edited' } })).docId, first.docId)
  const outcomes = await Promise.all([1, 2].map(value => store.savePromptDoc({ name: 'Concurrent', content: String(value), createOnly: true })))
  assert.equal(outcomes.filter(result => result.ok).length, 1)
  assert.equal(outcomes.find(result => !result.ok).error.code, 'DOC_EXISTS')
})

test('业务错误不冷却 Key，短探测区分认证与临时失败，auto 更新先确认地域', async t => {
  const { pool, rt, methods } = await fixture(t)
  for (const code of ['BUSINESS', 'BAD_REQUEST', 'CAPACITY']) pool.report('k', code)
  assert.equal(pool.isAvailable('k'), true)
  const options = []
  const api = { accountStatus: async (_key, _region, opts) => { options.push(opts); return { ok: false, error: { code: 'SERVER' } } } }
  assert.equal(await detectRegion(api, 'synthetic-test-key'), 'unknown')
  assert.ok(options.every(opts => opts.timeoutMs === 10000 && opts.retries === 0))
  assert.equal(await detectRegion({ accountStatus: async () => ({ ok: false, error: { code: 'AUTH' } }) }, 'synthetic-test-key'), 'invalid')
  rt.api = api
  assert.equal((await methods.keysUpdate({ id: 'k', patch: { region: 'auto' } })).error.code, 'DETECT_UNAVAILABLE')
  assert.equal(pool.list()[0].region, 'cn')
  rt.api = { accountStatus: async (_key, region) => region === 'overseas' ? { ok: true } : { ok: false, error: { code: 'AUTH' } } }
  assert.equal((await methods.keysUpdate({ id: 'k', patch: { region: 'auto' } })).ok, true)
  assert.equal(pool.list()[0].region, 'overseas')
  const unresolved = new KeyPool()
  unresolved.add({ id: 'auto', key: 'synthetic-auto-key', region: 'auto' })
  assert.equal(unresolved.poolStats().cn.available, 0)
})

test('批量通知即使部分失败仍保留成功路径，超时不冒充失败', async () => {
  let spec
  const jobs = { start(value) { spec = value; return 'job' } }
  const runner = { wait: async id => id === 'success' ? { ok: true, task: { taskId: id, status: 'SUCCESS' }, results: [{ localPath: 'C:\\out\\success.png' }] } : id === 'pending' ? { ok: true, timedOut: true, task: { taskId: id, status: 'RUNNING' } } : { ok: false, task: { taskId: id, status: 'FAILED' }, error: { message: 'synthetic failure' } } }
  startTaskJob({ jobs, runner, taskIds: ['success', 'failed', 'pending'] })
  const outcome = await spec.run({ append() {}, updateProgress() {} }).done
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /success\.png/)
  assert.match(outcome.detail, /pending.*仍在运行|仍在运行.*pending/s)
  assert.match(outcome.detail, /task.wait/)
  startTaskJob({ jobs, runner, taskIds: ['success', 'pending'] })
  const pending = await spec.run({ append() {}, updateProgress() {} }).done
  assert.equal(pending.status, 'completed')
  assert.doesNotMatch(pending.result, /部分任务失败/)
})

test('默认提交不挂重复通知，后台提交才挂；批量等待共享入口预算并透传 signal', async t => {
  const { rt, store } = await fixture(t)
  await store.saveWorkflow(config)
  let jobs = 0
  rt.ctx.get = () => ({ start() { jobs++; return 'job' } })
  const calls = []
  const controller = new AbortController()
  let at = 10000
  t.mock.method(Date, 'now', () => at)
  rt.runner = {
    async submit(req) { at += 100; assert.equal(req.baseDir, 'C:\\session'); return { ok: true, taskId: 't' + at, status: 'RUNNING' } },
    async wait(id, budget, opts) { calls.push({ id, budget, signal: opts.signal }); at += 100; return { ok: true, timedOut: true, task: { taskId: id, status: 'RUNNING' } } },
  }
  const exec = { signal: controller.signal, agent: { id: 'session', session: { header: { cwd: 'C:\\session' } } } }
  await HANDLERS['workflow.run']({ rt, args: { name: 'wf' }, exec })
  assert.equal(jobs, 0)
  await HANDLERS['workflow.run']({ rt, args: { name: 'wf', background: true }, exec })
  assert.equal(jobs, 1)
  await HANDLERS['workflow.run']({ rt, args: { name: 'wf', repeat: 2, waitMs: 1800000 }, exec })
  assert.ok(calls[0].budget <= MAX_TOOL_WAIT_MS - 200)
  assert.ok(calls[1].budget < calls[0].budget)
  assert.equal(calls[0].signal, controller.signal)
})

test('关闭 skill 时没有失效引导，预检展示覆盖字段，任务费用只取明确回执', async t => {
  const { rt, store } = await fixture(t)
  rt.config.registerSkill = false
  const tool = makeCallTool(() => rt)
  assert.doesNotMatch(tool.description, /先读 skill/)
  assert.doesNotMatch((await tool.execute({ action: 'workflow.get' }, {})).text, /skill/)
  await store.saveWorkflow(config)
  const validation = await tool.execute({ action: 'workflow.validate', args: { name: 'wf', prompt: 'changed' } }, {})
  assert.equal(validation.data.nodeInfoList[0].fieldValue, 'changed')
  rt.runner = { wait: async () => ({ ok: true, task: { taskId: 't', status: 'SUCCESS', outputs: [{ consumeCoins: '14' }] }, results: [{ kind: 'video', localPath: 'x.mp4', width: 480, height: 864, hasAudio: false }] }) }
  const waited = await tool.execute({ action: 'task.wait', args: { taskId: 't' } }, {})
  assert.equal(waited.data.tasks[0].consumeCoins, 14)
  assert.equal(waited.data.tasks[0].results[0].hasAudio, false)
  assert.match(waited.text, /14.*币/)
  assert.equal(waited.envelope, undefined)
})

test('工作流保存和克隆拒绝会被磁盘归一化或仅大小写不同的 id，原配置保持完整', async t => {
  const { rt, store, methods, tool } = await fixture(t)
  await store.saveWorkflow(config)
  for (const id of ['.wf', 'a..b', 'x'.repeat(97), 'wf/', 'WF']) {
    for (const result of [
      await methods.saveWorkflow({ config: { ...config, id, name: 'Replacement', overwrite: true } }),
      await tool.execute({ action: 'workflow.configure', args: { config: { ...config, id, name: 'Replacement' }, overwrite: true } }, {}),
      await methods.cloneWorkflow({ id: 'wf', name: 'Copy', newId: id }),
      await tool.execute({ action: 'workflow.clone', args: { name: 'wf', newName: 'Copy', id } }, {}),
    ]) assert.equal(result.ok, false, id + ' must not overwrite an existing file')
    assert.equal((await store.listWorkflows()).length, 1)
    assert.equal((await store.getWorkflow('wf')).name, 'Workflow')
    assert.deepEqual((await store.getWorkflow('wf')).nodes, [node])
  }
  const copy = await methods.cloneWorkflow({ id: 'wf', name: 'Copy', newId: 'wf-copy' })
  assert.equal(copy.ok, true)
  assert.equal(copy.id, 'wf-copy')
  assert.equal((await methods.renameWorkflow({ id: 'wf-copy', name: 'Renamed' })).ok, true)
  assert.equal((await store.getWorkflow('wf-copy')).name, 'Renamed')
  assert.equal((await HANDLERS['workflow.rename']({ rt, args: { name: 'wf-copy', newName: 'Workflow' } })).error.code, 'NAME_CONFLICT')
})

test('真实 RUNNING 任务的预先取消或插件停止等待不会伪造远端 FAILED', async t => {
  const { rt, store, pool, tool } = await fixture(t)
  await store.saveTask({ taskId: 'running', status: 'RUNNING', region: 'cn', createdAt: Date.now() })
  const runner = new TaskRunner({ api: {}, keys: pool, store })
  rt.runner = runner
  t.after(() => runner.stop())
  const controller = new AbortController()
  controller.abort()
  const result = await tool.execute({ action: 'task.wait', args: { taskId: 'running' } }, { signal: controller.signal })
  assert.equal(result.error.code, 'ABORTED')
  assert.equal(result.data.tasks[0].status, 'UNKNOWN')
  assert.match(result.text, /本地已停止等待.*远端任务未取消/)
  assert.doesNotMatch(result.text, /❌ 失败/)
  assert.equal((await store.getTask('running')).status, 'RUNNING')
  runner.stop()
  const stopped = await tool.execute({ action: 'task.wait', args: { taskId: 'running' } }, {})
  assert.equal(stopped.error.code, 'STOPPED')
  assert.equal(stopped.data.tasks[0].status, 'UNKNOWN')
  rt.runner = { wait: async () => ({ ok: false, task: { taskId: 'running', status: 'RUNNING' }, error: { code: 'ABORTED', message: '本地停止等待' } }) }
  const known = await tool.execute({ action: 'task.wait', args: { taskId: 'running' } }, {})
  assert.equal(known.data.tasks[0].status, 'RUNNING')
  let spec
  startTaskJob({ jobs: { start(value) { spec = value; return 'job' } }, runner: { wait: async () => ({ ok: false, error: { code: 'STOPPED', message: '插件已停止等待，远端未取消' } }) }, taskId: 'running' })
  const outcome = await spec.run({ append() {}, updateProgress() {} }).done
  assert.equal(outcome.status, 'killed')
  assert.match(outcome.result, /running · UNKNOWN/)
})
