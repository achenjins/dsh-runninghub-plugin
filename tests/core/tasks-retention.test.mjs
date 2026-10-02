/**
 * 任务流水的**保留策略**：默认只留最近 10 条，超出的真删除。
 *
 * 为什么值得单独测：这是**破坏性**行为（真删文件），而它写在高频路径上
 * （每次 `saveTask` 都可能触发）。最容易犯的两个错：
 *   ① 把**还在跑**的任务也删了 —— 删掉就没法恢复轮询、后台作业也拿不到结算；
 *   ② 「最近」按文件名排而不是按 `createdAt` —— taskId 是雪花号，字符串序
 *      和创建时间序**不一定一致**，会删掉新的留下旧的。
 *
 * @module dsh-runninghub-plugin/tests/core/tasks-retention
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { Store } from '../../host/core/store.mjs'
import { resolveMaxTasksFallback, parseTaskLimit } from '../../host/runtime.mjs'
import { normalizeConfig } from '../../host/index.mjs'

async function freshStore(opts = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-ret-'))
  return new Store({ dataDir, maxTasks: opts.maxTasks === undefined ? 10 : opts.maxTasks })
}

/** 造一条任务记录。`createdAt` 显式给，避免依赖真实时间。 */
const task = (id, status, createdAt) => ({ taskId: id, status, createdAt, workflowName: 'w' })

async function idsOf(store) {
  return (await store.listTasks()).map((t) => t.taskId)
}

test('★ 配置 → 运行时这条路也要给出 10（别被 `Number(null) === 0` 骗了）', () => {
  // 血泪：`Number(null) === 0`、`Number('') === 0`。早先写成
  //   `Number.isFinite(Number(state && state.taskLimit))` → state 为 null/{} 时
  // 算出 0，被当成"显式设成不限制" → **用户刚要求的功能静默失效**。
  // 直接用 Store 构造的单元测试照不出来（它们绕过了配置解析），所以这条必须单独钉。
  assert.equal(parseTaskLimit(undefined), null, 'undefined = 未设置')
  assert.equal(parseTaskLimit(null), null, '★ null 不是 0')
  assert.equal(parseTaskLimit(''), null, "★ 空串不是 0")
  assert.equal(parseTaskLimit('abc'), null)
  assert.equal(parseTaskLimit(0), 0, '但**显式** 0 就是不限制')
  assert.equal(parseTaskLimit(-3), 0, '负数夹到 0')
  assert.equal(parseTaskLimit(10.7), 10)

  assert.equal(resolveMaxTasksFallback(normalizeConfig({}), null), 10, '★ 没配任何东西时应是 10')
  assert.equal(resolveMaxTasksFallback(normalizeConfig({}), {}), 10, '★ 空 state 时应是 10')
  assert.equal(resolveMaxTasksFallback(normalizeConfig({ maxTasks: 25 }), null), 25)
  assert.equal(resolveMaxTasksFallback(normalizeConfig({ maxTasks: 0 }), null), 0, '显式 0 = 不限制')
  // 面板改过的状态优先于配置
  assert.equal(resolveMaxTasksFallback(normalizeConfig({ maxTasks: 25 }), { taskLimit: 3 }), 3)
  assert.equal(resolveMaxTasksFallback(normalizeConfig({ maxTasks: 25 }), { taskLimit: 0 }), 0)
})

test('默认保留条数是 10', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-ret-def-'))
  assert.equal(new Store({ dataDir: dir }).maxTasks, 10)
  assert.equal(new Store({ dataDir: dir, maxTasks: 0 }).maxTasks, 0, '0 是合法值（不限制）')
  assert.equal(new Store({ dataDir: dir, maxTasks: -5 }).maxTasks, 0, '负数夹到 0')
})

test('saveTask 会自动清理：只留最近 N 条终态记录', async () => {
  const store = await freshStore({ maxTasks: 3 })
  // 顺序写入 6 条终态任务
  for (let i = 1; i <= 6; i += 1) await store.saveTask(task('t' + String(i), 'SUCCESS', i * 100))
  const ids = await idsOf(store)
  assert.deepEqual(ids, ['t4', 't5', 't6'], '应只剩最近 3 条，实际：' + ids.join(','))
})

test('★ 绝不删非终态任务：活任务即使最旧也必须留着', async () => {
  const store = await freshStore({ maxTasks: 2 })
  // t0 是最旧的，但还在跑 —— 必须保留，否则重启无法恢复轮询
  await store.saveTask(task('t0', 'RUNNING', 100))
  for (const [id, ts] of [['t1', 200], ['t2', 300], ['t3', 400], ['t4', 500]]) {
    await store.saveTask(task(id, 'SUCCESS', ts))
  }
  const ids = await idsOf(store)
  assert.ok(ids.includes('t0'), '★ 活任务被误删了：' + ids.join(','))
  // 终态部分仍应压到 2 条
  const done = ids.filter((id) => id !== 't0')
  assert.deepEqual(done, ['t3', 't4'], '终态应只留最近 2 条，实际：' + done.join(','))
})

test('「最近」按 createdAt 排，不是按 taskId 字符串序', async () => {
  const store = await freshStore({ maxTasks: 2 })
  // 故意让 taskId 的字符串序与时间序**相反**
  await store.saveTask(task('zzz', 'SUCCESS', 100)) // 最旧
  await store.saveTask(task('mmm', 'SUCCESS', 200))
  await store.saveTask(task('aaa', 'SUCCESS', 300)) // 最新
  assert.deepEqual(await idsOf(store), ['mmm', 'aaa'], '应按 createdAt 保留，实际：' + (await idsOf(store)).join(','))
})

test('maxTasks = 0 表示不限制', async () => {
  const store = await freshStore({ maxTasks: 0 })
  for (let i = 1; i <= 25; i += 1) await store.saveTask(task('t' + String(i), 'SUCCESS', i))
  assert.equal((await idsOf(store)).length, 25, '不限制时一条都不该删')
})

test('pruneTasks(limit) 可显式覆盖上限，并返回被删的 id', async () => {
  const store = await freshStore({ maxTasks: 0 }) // 先不自动清理
  for (let i = 1; i <= 6; i += 1) await store.saveTask(task('t' + String(i), 'SUCCESS', i))
  assert.equal((await idsOf(store)).length, 6)
  const r = await store.pruneTasks(2)
  assert.deepEqual(r.removed.sort(), ['t1', 't2', 't3', 't4'], '应报告被删的 4 条：' + r.removed.join(','))
  assert.deepEqual(await idsOf(store), ['t5', 't6'])
})

test('未超限时不动任何文件（也不该报删）', async () => {
  const store = await freshStore({ maxTasks: 10 })
  for (let i = 1; i <= 10; i += 1) await store.saveTask(task('t' + String(i), 'SUCCESS', i))
  const r = await store.pruneTasks(10)
  assert.deepEqual(r.removed, [])
  assert.equal((await idsOf(store)).length, 10)
})

test('失败的终态（FAILED / CANCEL / ERROR）同样可被清理', async () => {
  const store = await freshStore({ maxTasks: 2 })
  await store.saveTask(task('a', 'FAILED', 100))
  await store.saveTask(task('b', 'CANCEL', 200))
  await store.saveTask(task('c', 'ERROR', 300))
  await store.saveTask(task('d', 'SUCCESS', 400))
  const ids = await idsOf(store)
  assert.equal(ids.length, 2, '非终态的只剩 2 条，实际：' + ids.join(','))
  assert.deepEqual(ids, ['c', 'd'])
})

test('QUEUED / RUNNING / CREATE 是活任务，不被清理（UNCERTAIN 属终态，可清）', async () => {
  const store = await freshStore({ maxTasks: 3 })
  await store.saveTask(task('q', 'QUEUED', 100))
  await store.saveTask(task('r', 'RUNNING', 200))
  await store.saveTask(task('c', 'CREATE', 300))
  await store.saveTask(task('s', 'SUCCESS', 400))
  const ids = await idsOf(store)
  for (const live of ['q', 'r', 'c']) {
    assert.ok(ids.includes(live), live + ' 是活任务，不该被删：' + ids.join(','))
  }
  assert.ok(ids.includes('s'), '最新的终态记录也该在')

  // UNCERTAIN 在 api.mjs 里**是终态**（提交结果未知，不再轮询）。
  // 所以它**可以**被清理 —— 这里把这个事实钉住，免得有人以为它是活的。
  const store2 = await freshStore({ maxTasks: 1 })
  await store2.saveTask(task('u', 'UNCERTAIN', 100))
  await store2.saveTask(task('n', 'SUCCESS', 200))
  const ids2 = await idsOf(store2)
  assert.deepEqual(ids2, ['n'], 'UNCERTAIN 是终态，超限时会被清掉，实际：' + ids2.join(','))
})
