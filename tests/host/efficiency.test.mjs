import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { Store } from '../../host/core/store.mjs'
import { TaskRunner } from '../../host/core/runner.mjs'
import { Runtime } from '../../host/runtime.mjs'
import { buildMethods } from '../../host/rpc.mjs'
import { HANDLERS } from '../../host/tools/call.mjs'

const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-efficiency-'))
  const reads = { tasks: 0, workflows: 0, prompts: 0 }
  const store = new Store({ dataDir, maxTasks: 0, fsImpl: {
    ...fs,
    readFile: async (file, ...args) => {
      const dir = path.basename(path.dirname(file))
      if (Object.hasOwn(reads, dir)) reads[dir]++
      return fs.readFile(file, ...args)
    },
  } })
  await store.init()
  t.after(async () => {
    await store._prunePending
    const relative = path.relative(os.tmpdir(), dataDir)
    assert.ok(relative.startsWith('rh-efficiency-') && !relative.includes(path.sep))
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return { store, reads, rt: { store, config: {}, warnings: [], dataDir } }
}

test('面板同时读取状态与明细只扫描一遍，加载更多可超过 200 条', async t => {
  const { store, reads, rt } = await fixture(t)
  await Promise.all(Array.from({ length: 220 }, (_, i) => fs.writeFile(store.resolve('tasks', 't' + i + '.json'), JSON.stringify({
    taskId: 't' + i, status: 'RUNNING', createdAt: i,
  }))))
  await store.saveWorkflow({ id: 'wf', name: 'Workflow' })
  await store.savePromptDoc({ id: 'doc', name: 'Document', content: 'text' })
  for (const dir of Object.keys(reads)) reads[dir] = 0
  const methods = buildMethods(rt)
  const [status, workflows, docs, tasks] = await Promise.all([
    methods.status(), methods.listWorkflows(), methods.docsList(), methods.tasksList({ limit: 20 }),
  ])
  assert.equal(status.counts.tasks, 220)
  assert.equal(workflows.length, 1)
  assert.equal(docs.length, 1)
  assert.equal(tasks.length, 20)
  assert.deepEqual(reads, { tasks: 220, workflows: 1, prompts: 1 })
  assert.equal((await methods.tasksList({ limit: 220 })).length, 220)
  assert.equal(reads.tasks, 220, '未变的任务不重复读取 JSON')
  await fs.writeFile(store.resolve('tasks', 't219.json'), JSON.stringify({ taskId: 't219', status: 'SUCCESS', createdAt: 219, results: [{ text: 'edited' }] }))
  assert.equal((await methods.tasksList({ status: 'SUCCESS' }))[0].results[0].text, 'edited')
  assert.equal(reads.tasks, 221, '外部改动只重读改变的记录')
})

test('未超限的清理复用未变记录；释放未知或运行中的任务不扫描', async t => {
  const { store, reads } = await fixture(t)
  await store.saveTask({ taskId: 'active', status: 'RUNNING', createdAt: 1 })
  for (const limit of [0, 10]) {
    reads.tasks = 0
    const result = await store.pruneTasks(limit)
    assert.equal(result.kept, 1)
    assert.deepEqual(result.removed, [])
    assert.equal(reads.tasks, limit === 0 ? 1 : 0)
  }
  store.maxTasks = 10
  const runner = new TaskRunner({ store, now: () => 1000, sleep: async () => { throw new Error('interrupted') } })
  reads.tasks = 0
  assert.equal((await runner.wait('missing', 1000)).error.code, 'TASK_NOT_FOUND')
  assert.equal(reads.tasks, 1)
  reads.tasks = 0
  await assert.rejects(runner.wait('active', 1000), /interrupted/)
  assert.equal(reads.tasks, 1)
  assert.equal(store._taskRefs.size, 0)
})

test('清理期间并发新增任务仍返回实际条数', async t => {
  const { store } = await fixture(t)
  await store.saveTask({ taskId: 'old', status: 'SUCCESS', createdAt: 1 })
  await store.saveTask({ taskId: 'new', status: 'SUCCESS', createdAt: 2 })
  const remove = store.deleteTask.bind(store)
  store.deleteTask = async id => {
    await store.saveTask({ taskId: 'added', status: 'RUNNING', createdAt: 3 })
    return remove(id)
  }
  const result = await store.pruneTasks(1)
  assert.deepEqual(result.removed, ['old'])
  assert.equal(result.kept, 2)
})

test('临时放宽清理上限不丢失取结果期间延期的清理', async t => {
  const { store } = await fixture(t)
  await store.saveTask({ taskId: 'old', status: 'SUCCESS', createdAt: 1 })
  await store.saveTask({ taskId: 'new', status: 'SUCCESS', createdAt: 2 })
  store.maxTasks = 1
  const release = store.retainTasks(['old'])
  assert.deepEqual((await store.pruneTasks()).removed, [])
  assert.deepEqual((await store.pruneTasks(0)).removed, [])
  await release()
  assert.deepEqual((await store.listTasks()).map(task => task.taskId), ['new'])
})

test('写入后列表不复用较早尚未完成的扫描', async t => {
  const { store } = await fixture(t)
  await store.saveTask({ taskId: 't', status: 'RUNNING', createdAt: 1 })
  const get = store.getTask.bind(store)
  const started = deferred()
  const release = deferred()
  let first = true
  store.getTask = async id => {
    const task = await get(id)
    if (first) {
      first = false
      started.resolve()
      await release.promise
    }
    return task
  }
  const old = store.listTasks()
  await started.promise
  await store.saveTask({ taskId: 't', status: 'SUCCESS', createdAt: 1, results: [{ text: 'saved' }] })
  assert.equal((await store.listTasks())[0].status, 'SUCCESS')
  release.resolve()
  assert.equal((await old)[0].status, 'RUNNING')
})

test('多个等待者共享轮询，收集结果并落盘之后才返回成功', async t => {
  const { store, reads } = await fixture(t)
  await store.saveTask({ taskId: 't', status: 'RUNNING', createdAt: 1 })
  let nextSleep = deferred()
  const runner = new TaskRunner({ store, now: () => 1000, sleep: () => {
    const gate = deferred()
    nextSleep.resolve(gate)
    return gate.promise
  } })
  const collecting = deferred()
  runner._collect = () => collecting.promise
  reads.tasks = 0
  const waits = [runner.wait('t', 5000), runner.wait('t', 10000)]
  const firstPoll = await nextSleep.promise
  assert.equal(reads.tasks, 1, '初始读取也应合并')
  nextSleep = deferred()
  const settling = runner._settle('t', { status: 'SUCCESS' })
  firstPoll.resolve()
  const secondPoll = await nextSleep.promise
  assert.equal(reads.tasks, 3, '两轮等待共用读取，另一次是结算读取')
  collecting.resolve([{ kind: 'text', text: 'saved result' }])
  await settling
  secondPoll.resolve()
  const results = await Promise.all(waits)
  for (const result of results) {
    assert.equal(result.ok, true)
    assert.equal(result.results[0].text, 'saved result')
  }
  assert.equal(reads.tasks, 4)
  assert.equal(runner._waitReads.size, 0)
  assert.equal(store._taskRefs.size, 0)
})

test('告警只保留最近 40 条，面板和诊断能看到最新告警', async () => {
  const rt = new Runtime({ ctx: {}, config: {}, logger: { warn() {} } })
  rt.store = { listWorkflows: async () => [], listTasks: async () => [], listPromptDocs: async () => [] }
  rt.core = {}
  for (let i = 0; i < 100; i++) rt.warn('warning-' + i)
  assert.equal(rt.warnings.length, 40)
  assert.equal(rt.warnings[0], 'warning-60')
  const methods = buildMethods(rt)
  const status = await methods.status()
  const diagnostics = await HANDLERS.diagnostics({ rt })
  assert.equal(status.warnings.at(-1), 'warning-99')
  assert.equal(diagnostics.data.warnings.at(-1), 'warning-99')
  assert.match(diagnostics.text, /warning-99/)
})
