import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { Store } from '../../host/core/store.mjs'
import { TaskRunner } from '../../host/core/runner.mjs'
import { normalizeConfig } from '../../host/index.mjs'
import { bootRuntime, parseTaskLimit } from '../../host/runtime.mjs'
import { buildMethods } from '../../host/rpc.mjs'
import { HANDLERS } from '../../host/tools/call.mjs'
import { startTaskJob } from '../../host/jobs.mjs'
import { REMOTE_METHODS, diffMethodList } from '../../host/remote-manifest.mjs'
import { TYPERT } from '../../typert.host.mjs'
import { loadClientModule } from '../client/harness.mjs'

async function fixture(t, opts = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-ret-fix-'))
  const store = new Store({ dataDir, maxTasks: 0, ...opts })
  await store.init()
  t.after(async () => {
    await store._prunePending
    const relative = path.relative(os.tmpdir(), dataDir)
    assert.ok(relative.startsWith('rh-ret-fix-') && !relative.includes(path.sep))
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const rt = { store, config: {}, ctx: { get() {} }, warn() {}, workflow: { validateRun: () => ({ ok: true }) } }
  return { store, rt }
}

const record = (taskId, createdAt, extra = {}) => ({ taskId, status: 'SUCCESS', createdAt, ...extra })
const idsOf = async (store) => (await store.listTasks()).map(task => task.taskId)
const workflow = { id: 'wf', name: 'Workflow', rhWorkflowId: '123', region: 'cn', nodes: [] }

test('未设置及非法配置回退 10，显式 0 保持不限制', () => {
  for (const value of [null, undefined, '', '   ', -1, 1.5, true, false, [], [1], {}, '1e2', Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(parseTaskLimit(value), null)
    assert.equal(normalizeConfig({ maxTasks: value }).maxTasks, 10)
  }
  for (const value of [0, '0', ' 0 ', 25, '25']) assert.equal(normalizeConfig({ maxTasks: value }).maxTasks, Number(value))
})

test('老任务最后完成时保留结果，wait 不误报失败', async (t) => {
  const { store } = await fixture(t, { maxTasks: 1 })
  await store.saveTask(record('old', 1, { status: 'RUNNING' }))
  await store.saveTask(record('new', 2, { finishedAt: 20 }))
  const runner = new TaskRunner({ store, now: () => 30, sleep: async () => {
    await runner._settle('old', { status: 'SUCCESS' })
  } })
  runner._collect = async () => [{ kind: 'text', text: 'old result' }]
  const result = await runner.wait('old', 1000)
  assert.equal(result.ok, true)
  assert.equal(result.results[0].text, 'old result')
  assert.deepEqual(await idsOf(store), ['old'])
  assert.equal((await runner.wait('old', 1000)).ok, true)
})

test('等待过程中其它任务先完成，不会删除等待者的结果', async (t) => {
  const { store } = await fixture(t, { maxTasks: 1 })
  await store.saveTask(record('waiting', 1, { status: 'RUNNING' }))
  const runner = new TaskRunner({ store, sleep: async () => {
    await store.saveTask(record('waiting', 1, { finishedAt: 10, results: [{ kind: 'text', text: 'result' }] }))
    await store.saveTask(record('newest', 2, { finishedAt: 20 }))
  } })
  const result = await runner.wait('waiting', 1000)
  assert.equal(result.ok, true)
  assert.equal(result.results[0].text, 'result')
  assert.deepEqual(await idsOf(store), ['newest'])
  assert.equal(store._taskRefs.size, 0)
})

test('wait 异常及未知任务都会释放保护', async (t) => {
  const { store } = await fixture(t, { maxTasks: 1 })
  const runner = new TaskRunner({ store, sleep: async () => { throw new Error('interrupted') } })
  assert.equal((await runner.wait('missing', 1000)).error.code, 'TASK_NOT_FOUND')
  await store.saveTask(record('active', 1, { status: 'RUNNING' }))
  await assert.rejects(runner.wait('active', 1000), /interrupted/)
  assert.equal(store._taskRefs.size, 0)
})

test('TIMEOUT、NO_KEY、POLL_CRASH 及 UNCERTAIN 在降低上限后仍可查询', async (t) => {
  const { store } = await fixture(t)
  for (const errorCode of ['TIMEOUT', 'NO_KEY', 'POLL_CRASH']) {
    await store.saveTask(record(errorCode, 1, { status: 'ERROR', errorCode }))
  }
  await store.saveTask(record('uncertain', 1, { status: 'UNCERTAIN' }))
  await store.saveTask(record('older-done', 2))
  await store.saveTask(record('new-done', 3))
  const result = await store.taskLimit(1)
  assert.deepEqual(result.removed, ['older-done'])
  for (const id of ['TIMEOUT', 'NO_KEY', 'POLL_CRASH', 'uncertain']) assert.ok(await store.getTask(id))
  assert.equal(result.kept, 5)
})

test('清理扫描后状态改变时不删除记录', async (t) => {
  const { store } = await fixture(t)
  await store.saveTask(record('old', 1))
  await store.saveTask(record('new', 2))
  const original = store.listTasks.bind(store)
  let changed = false
  store.listTasks = async (...args) => {
    const snapshot = await original(...args)
    if (!changed) {
      changed = true
      await store.saveTask(record('old', 1, { status: 'RUNNING' }))
    }
    return snapshot
  }
  assert.deepEqual((await store.pruneTasks(1)).removed, [])
  assert.equal((await store.getTask('old')).status, 'RUNNING')
})

test('RPC 和工具保存失败不会切换策略或触发后续删除', async (t) => {
  const { store, rt } = await fixture(t)
  await store.saveState({ taskLimit: 0 })
  for (let i = 1; i <= 4; i++) await store.saveTask(record('t' + i, i))
  store.saveState = async () => ({ ok: false, error: { message: 'disk full' } })
  const rpc = await buildMethods(rt).tasksLimit({ limit: 1 })
  const tool = await HANDLERS['task.limit']({ rt, args: { limit: 1 } })
  for (const result of [rpc, tool]) assert.equal(result.error.code, 'SAVE_FAILED')
  assert.equal(store.maxTasks, 0)
  assert.equal((await store.loadState()).taskLimit, 0)
  await store.saveTask(record('next', 5))
  assert.equal((await idsOf(store)).length, 5)
})

test('并发设置按调用顺序保存，旧清理不会在新策略生效后继续执行', async (t) => {
  const { store, rt } = await fixture(t)
  for (let i = 1; i <= 5; i++) await store.saveTask(record('t' + i, i))
  const [first, second] = await Promise.all([
    buildMethods(rt).tasksLimit({ limit: 1 }),
    HANDLERS['task.limit']({ rt, args: { limit: 0 } }),
  ])
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(store.maxTasks, 0)
  assert.equal((await store.loadState()).taskLimit, 0)
  await store.saveTask(record('after', 6))
  assert.deepEqual(await idsOf(store), ['t5', 'after'])
})

test('部分删除失败返回真实条数及失败 ID，设置仍已保存', async (t) => {
  const { store } = await fixture(t, { fsImpl: { ...fs, unlink: async (file) => {
    if (path.basename(file) === 't2.json') throw Object.assign(new Error('denied'), { code: 'EACCES' })
    return fs.unlink(file)
  } } })
  for (let i = 1; i <= 3; i++) await store.saveTask(record('t' + i, i))
  const result = await store.taskLimit(1)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'TASK_PRUNE_FAILED')
  assert.match(result.error.message, /已保存为 1/)
  assert.deepEqual(result.failed, ['t2'])
  assert.deepEqual(result.removed, ['t1'])
  assert.equal(result.kept, 2)
  assert.equal(store.maxTasks, 1)
  assert.equal((await store.loadState()).taskLimit, 1)
  assert.deepEqual(await idsOf(store), ['t2', 't3'])
})

test('自动清理删除失败会记录警告，并保留已保存的结果', async (t) => {
  const warnings = []
  const { store } = await fixture(t, { maxTasks: 1, logger: { warn: message => warnings.push(message) }, fsImpl: {
    ...fs, unlink: async (file) => {
      if (path.extname(file) === '.json') throw Object.assign(new Error('denied'), { code: 'EACCES' })
      return fs.unlink(file)
    },
  } })
  await store.saveTask(record('old', 1))
  assert.equal((await store.saveTask(record('new', 2))).ok, true)
  assert.deepEqual(await idsOf(store), ['old', 'new'])
  assert.ok(warnings.some(message => message.includes('未能删除')))
})

test('轮询更新不扫描任务目录；不限制时 kept 仍是实际条数', async (t) => {
  const { store } = await fixture(t, { maxTasks: 1 })
  let scans = 0
  const original = store.listTasks.bind(store)
  store.listTasks = async (...args) => { scans++; return original(...args) }
  for (let i = 0; i < 20; i++) await store.saveTask(record('active', 1, { status: 'RUNNING', pollCount: i }))
  assert.equal(scans, 0)
  const result = await store.pruneTasks(0)
  assert.equal(result.kept, 1)
  assert.deepEqual(result.removed, [])
})

test('启动时默认或已保存的相同上限均会清理，显式 0 不清理', async (t) => {
  for (const saved of [undefined, 10, 0]) {
    await t.test('taskLimit=' + String(saved), async (t) => {
      const { store } = await fixture(t)
      for (let i = 1; i <= 15; i++) await store.saveTask(record('t' + i, i))
      if (saved !== undefined) await store.saveState({ taskLimit: saved })
      const runtime = await bootRuntime({ ctx: { get() {} }, config: normalizeConfig({ dataDir: store.dataDir }) })
      t.after(() => runtime.runner?.stop())
      assert.equal(runtime.coreReady, true, runtime.loadError)
      assert.equal((await runtime.store.listTasks()).length, saved === 0 ? 15 : 10)
    })
  }
})

test('批量提交期间保护早完成的记录，前台能取回超过上限的全部结果', async (t) => {
  const { store, rt } = await fixture(t, { maxTasks: 1 })
  await store.saveWorkflow(workflow)
  let submitted = 0
  const runner = new TaskRunner({ store })
  runner.submit = async () => {
    if (submitted) await store.saveTask(record('t' + submitted, submitted, { finishedAt: submitted, results: [{ kind: 'text', text: 'result-' + submitted }] }))
    const taskId = 't' + ++submitted
    await store.saveTask(record(taskId, submitted, { status: 'RUNNING' }))
    return { ok: true, taskId }
  }
  const wait = runner.wait.bind(runner)
  runner.wait = async (...args) => {
    if (args[0] === 't1') await store.saveTask(record('t20', 20, { finishedAt: 20, results: [{ kind: 'text', text: 'result-20' }] }))
    return wait(...args)
  }
  rt.runner = runner
  const result = await HANDLERS['workflow.run']({ rt, args: { name: workflow.name, repeat: 20, waitMs: 1000 } })
  assert.equal(result.ok, true)
  assert.equal(result.data.tasks.length, 20)
  assert.deepEqual(result.data.tasks.map(item => item.results[0].text), Array.from({ length: 20 }, (_, i) => '> result-' + (i + 1)))
  assert.deepEqual(await idsOf(store), ['t20'])
  assert.equal(store._taskRefs.size, 0)
})

test('后台作业等待前保护整批任务，结算后释放', async (t) => {
  const { store } = await fixture(t, { maxTasks: 1 })
  const ids = Array.from({ length: 12 }, (_, i) => 'job' + (i + 1))
  for (const [i, id] of ids.entries()) await store.saveTask(record(id, i + 1, { status: 'RUNNING' }))
  const runner = new TaskRunner({ store })
  let spec
  startTaskJob({ jobs: { start: value => { spec = value; return 'job' } }, runner, taskIds: ids })
  for (const [i, id] of ids.entries()) await store.saveTask(record(id, i + 1, { results: [{ kind: 'text', text: id }] }))
  assert.equal((await idsOf(store)).length, ids.length)
  const outcome = await spec.run({ append() {}, updateProgress() {} }).done
  assert.equal(outcome.status, 'completed')
  for (const id of ids) assert.ok(outcome.result.includes(id))
  assert.deepEqual(await idsOf(store), ['job12'])
  assert.equal(store._taskRefs.size, 0)
})

test('后台作业启动失败时释放任务保护', async (t) => {
  const { store } = await fixture(t)
  const runner = new TaskRunner({ store })
  assert.equal(startTaskJob({ jobs: { start() { throw new Error('unavailable') } }, runner, taskId: 't1' }), null)
  assert.equal(store._taskRefs.size, 0)
})

test('客户端、RPC 和官方 Typert manifest 的方法清单一致', () => {
  const methods = buildMethods({})
  assert.deepEqual(diffMethodList(methods), { missing: [], extra: [] })
  const client = loadClientModule().exports
  assert.deepEqual(client.DESCRIPTORS.map(item => item.method).sort(), [...REMOTE_METHODS].sort())
  assert.deepEqual(TYPERT.invocations.map(item => item.method).sort(), [...REMOTE_METHODS].sort())
})
