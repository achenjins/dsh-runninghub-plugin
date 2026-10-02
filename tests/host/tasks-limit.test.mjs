/**
 * 「任务流水保留条数」的**对外通道**：RPC 方法 `tasksLimit` 与工具动作 `task.limit`。
 *
 * 为什么与 `tasks-retention.test.mjs` 分开：那边测的是 store 的**策略**
 *（删谁、不删谁），这边测的是**入口**——面板与模型都能改这个数，
 * 而入口最容易犯的错是「把合法的 0 当成没传」和「改完没落盘」。
 *
 * @module dsh-runninghub-plugin/tests/host/tasks-limit
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { Store } from '../../host/core/store.mjs'
import { buildMethods } from '../../host/rpc.mjs'
import { HANDLERS } from '../../host/tools/call.mjs'

async function rig(t, { maxTasks = 10 } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-limit-'))
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), dataDir)
    assert.ok(relative.startsWith('rh-limit-') && !relative.includes(path.sep))
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const store = new Store({ dataDir, maxTasks })
  const rt = { store, dataDir }
  return { rt, store, methods: buildMethods(rt) }
}

/** 造 n 条终态任务。 */
async function seed(store, n) {
  for (let i = 1; i <= n; i += 1) {
    await store.saveTask({ taskId: 't' + String(i), status: 'SUCCESS', createdAt: i * 100, workflowName: 'w' })
  }
}

test('tasksLimit 只读：不传 limit 时回当前上限与条数', async (t) => {
  const { methods, store } = await rig(t, { maxTasks: 7 })
  await seed(store, 3)
  const r = await methods.tasksLimit({})
  assert.equal(r.limit, 7)
  assert.equal(r.count, 3)
})

test('tasksLimit 写：改上限 + 落盘 + 立刻清理', async (t) => {
  const { rt, methods, store } = await rig(t, { maxTasks: 0 }) // 先不限制，方便铺数据
  await seed(store, 6)
  const r = await methods.tasksLimit({ limit: 2 })
  assert.equal(r.ok, true)
  assert.equal(r.limit, 2)
  assert.equal(r.removed.length, 4, '超出的 4 条应被删')
  assert.equal((await store.listTasks()).length, 2)

  // ★ 必须落盘：不落盘的话用户改完、重启就被配置值顶回去
  const state = await store.loadState()
  assert.equal(state.taskLimit, 2, 'taskLimit 必须写进 state.json')

  // 重启（新建 store，走 state 覆盖）后仍是 2
  const store2 = new Store({ dataDir: rt.dataDir, maxTasks: 10 })
  const state2 = await store2.loadState()
  assert.equal(state2.taskLimit, 2)
})

test('★ tasksLimit({limit:0}) 是**合法的 0**，不能被当成"没传"', async (t) => {
  const { methods, store } = await rig(t, { maxTasks: 3 })
  await seed(store, 3)
  const r = await methods.tasksLimit({ limit: 0 })
  assert.equal(r.ok, true, '显式 0 应被接受：' + JSON.stringify(r))
  assert.equal(r.limit, 0)
  assert.equal(store.maxTasks, 0)
  // 0 = 不限制：再存到 5 条也不该被压回 3 条（上限还是 3 的话这里只剩 3）
  await seed(store, 5)
  const r2 = await methods.tasksLimit({}) // 只读才回 count（写路径回的是 {limit, removed}）
  assert.equal(r2.count, 5, '0 = 不限制：不该被压到 3 条，实际 ' + String(r2.count))
})

test('tasksLimit 拒绝非法值（负数 / 非数字）', async (t) => {
  const { methods } = await rig(t)
  for (const bad of [-1, 'abc', NaN, 1.5, true, [], [1], {}, Number.MAX_SAFE_INTEGER + 1, '1e2']) {
    const r = await methods.tasksLimit({ limit: bad })
    assert.equal(r.ok, false, '应拒绝：' + JSON.stringify(bad))
    assert.equal(r.error.code, 'BAD_REQUEST')
  }
})

test('tasksLimit 落盘失败要如实报错，不能假装改成功', async (t) => {
  const { store, methods } = await rig(t)
  store.saveState = async () => ({ ok: false, error: { message: '磁盘满了' } })
  const r = await methods.tasksLimit({ limit: 5 })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'SAVE_FAILED')
  assert.match(String(r.error.message), /磁盘满了/)
  assert.equal(store.maxTasks, 10)
})

test('工具动作 task.limit：只读 / 改 / 非法值', async (t) => {
  const { rt, store } = await rig(t, { maxTasks: 0 })
  await seed(store, 4)

  const read = await HANDLERS['task.limit']({ rt, args: {} })
  assert.equal(read.ok, true)
  assert.equal(read.data.limit, 0)
  assert.equal(read.data.count, 4)
  assert.match(read.text, /未限制/)

  const set = await HANDLERS['task.limit']({ rt, args: { limit: 2 } })
  assert.equal(set.ok, true)
  assert.equal(set.data.limit, 2)
  assert.equal(set.data.removed.length, 2)
  assert.match(set.text, /待恢复、待核对/)

  const bad = await HANDLERS['task.limit']({ rt, args: { limit: -5 } })
  assert.equal(bad.ok, false)
  assert.equal(bad.error.code, 'BAD_REQUEST')
})

test('★ 活任务在改上限时也不被删（入口层同样受保护）', async (t) => {
  const { rt, store } = await rig(t, { maxTasks: 0 })
  await store.saveTask({ taskId: 'live', status: 'RUNNING', createdAt: 1 })
  await seed(store, 5)
  const r = await HANDLERS['task.limit']({ rt, args: { limit: 1 } })
  assert.equal(r.ok, true)
  const ids = (await store.listTasks()).map((t) => t.taskId)
  assert.ok(ids.includes('live'), '活任务被删了：' + ids.join(','))
  assert.equal(ids.length, 2, '1 条终态 + 1 条活任务')
})
