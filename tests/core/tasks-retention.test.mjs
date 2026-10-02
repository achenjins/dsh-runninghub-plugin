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
import { recoverableLimitFor } from '../../host/core/store.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { Store } from '../../host/core/store.mjs'
import { resolveMaxTasksFallback, parseTaskLimit } from '../../host/runtime.mjs'
import { normalizeConfig } from '../../host/index.mjs'

async function freshStore(t, opts = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-ret-'))
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), dataDir)
    assert.ok(relative.startsWith('rh-ret-') && !relative.includes(path.sep))
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
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
  assert.equal(parseTaskLimit(-3), null)
  assert.equal(parseTaskLimit(10.7), null)

  assert.equal(resolveMaxTasksFallback(normalizeConfig({}), null), 10, '★ 没配任何东西时应是 10')
  assert.equal(resolveMaxTasksFallback(normalizeConfig({}), {}), 10, '★ 空 state 时应是 10')
  assert.equal(resolveMaxTasksFallback(normalizeConfig({ maxTasks: 25 }), null), 25)
  assert.equal(resolveMaxTasksFallback(normalizeConfig({ maxTasks: 0 }), null), 0, '显式 0 = 不限制')
  // 面板改过的状态优先于配置
  assert.equal(resolveMaxTasksFallback(normalizeConfig({ maxTasks: 25 }), { taskLimit: 3 }), 3)
  assert.equal(resolveMaxTasksFallback(normalizeConfig({ maxTasks: 25 }), { taskLimit: 0 }), 0)
})

test('默认保留条数是 10', async (t) => {
  const dir = (await freshStore(t)).dataDir
  assert.equal(new Store({ dataDir: dir }).maxTasks, 10)
  assert.equal(new Store({ dataDir: dir, maxTasks: 0 }).maxTasks, 0, '0 是合法值（不限制）')
  assert.equal(new Store({ dataDir: dir, maxTasks: -5 }).maxTasks, 10, '非法配置回退默认值')
})

test('saveTask 会自动清理：只留最近 N 条终态记录', async (t) => {
  const store = await freshStore(t, { maxTasks: 3 })
  // 顺序写入 6 条终态任务
  for (let i = 1; i <= 6; i += 1) await store.saveTask(task('t' + String(i), 'SUCCESS', i * 100))
  const ids = await idsOf(store)
  assert.deepEqual(ids, ['t4', 't5', 't6'], '应只剩最近 3 条，实际：' + ids.join(','))
})

test('★ 绝不删非终态任务：活任务即使最旧也必须留着', async (t) => {
  const store = await freshStore(t, { maxTasks: 2 })
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

test('「最近」按 createdAt 排，不是按 taskId 字符串序', async (t) => {
  const store = await freshStore(t, { maxTasks: 2 })
  // 故意让 taskId 的字符串序与时间序**相反**
  await store.saveTask(task('zzz', 'SUCCESS', 100)) // 最旧
  await store.saveTask(task('mmm', 'SUCCESS', 200))
  await store.saveTask(task('aaa', 'SUCCESS', 300)) // 最新
  assert.deepEqual(await idsOf(store), ['mmm', 'aaa'], '应按 createdAt 保留，实际：' + (await idsOf(store)).join(','))
})

test('maxTasks = 0 表示不限制', async (t) => {
  const store = await freshStore(t, { maxTasks: 0 })
  for (let i = 1; i <= 25; i += 1) await store.saveTask(task('t' + String(i), 'SUCCESS', i))
  assert.equal((await idsOf(store)).length, 25, '不限制时一条都不该删')
})

test('pruneTasks(limit) 可显式覆盖上限，并返回被删的 id', async (t) => {
  const store = await freshStore(t, { maxTasks: 0 }) // 先不自动清理
  for (let i = 1; i <= 6; i += 1) await store.saveTask(task('t' + String(i), 'SUCCESS', i))
  assert.equal((await idsOf(store)).length, 6)
  const r = await store.pruneTasks(2)
  assert.deepEqual(r.removed.sort(), ['t1', 't2', 't3', 't4'], '应报告被删的 4 条：' + r.removed.join(','))
  assert.deepEqual(await idsOf(store), ['t5', 't6'])
})

test('未超限时不动任何文件（也不该报删）', async (t) => {
  const store = await freshStore(t, { maxTasks: 10 })
  for (let i = 1; i <= 10; i += 1) await store.saveTask(task('t' + String(i), 'SUCCESS', i))
  const r = await store.pruneTasks(10)
  assert.deepEqual(r.removed, [])
  assert.equal((await idsOf(store)).length, 10)
})

test('FAILED / CANCEL 可清理，ERROR 继续保留', async (t) => {
  const store = await freshStore(t, { maxTasks: 2 })
  await store.saveTask(task('a', 'FAILED', 100))
  await store.saveTask(task('b', 'CANCEL', 200))
  await store.saveTask(task('c', 'ERROR', 300))
  await store.saveTask(task('d', 'SUCCESS', 400))
  const ids = await idsOf(store)
  assert.deepEqual(ids, ['b', 'c', 'd'])
})

test('运行和 UNCERTAIN 记录不被清理', async (t) => {
  const store = await freshStore(t, { maxTasks: 3 })
  await store.saveTask(task('q', 'QUEUED', 100))
  await store.saveTask(task('r', 'RUNNING', 200))
  await store.saveTask(task('c', 'CREATE', 300))
  await store.saveTask(task('s', 'SUCCESS', 400))
  const ids = await idsOf(store)
  for (const live of ['q', 'r', 'c']) {
    assert.ok(ids.includes(live), live + ' 是活任务，不该被删：' + ids.join(','))
  }
  assert.ok(ids.includes('s'), '最新的终态记录也该在')

  // 提交结果未知的记录需要人工核对，不能自动删除。
  const store2 = await freshStore(t, { maxTasks: 1 })
  await store2.saveTask(task('u', 'UNCERTAIN', 100))
  await store2.saveTask(task('n', 'SUCCESS', 200))
  const ids2 = await idsOf(store2)
  assert.deepEqual(ids2, ['u', 'n'])
})

/*
 * ─────────────────── 待恢复 / 待核对的**独立上限** ───────────────────
 *
 * 背景：ERROR（TIMEOUT/NO_KEY/POLL_CRASH，靠 `task.status` 复活）和 UNCERTAIN
 * （提交结果未知，是"可能已扣费"的唯一证据）**不能**按普通上限删。
 * 但把它们排除出清理范围**又不给上限**会让「只保留最近 10 条」这句承诺失效 ——
 * 实测上限 10 时能堆到 110 条。所以给了独立上限，下面把它钉死。
 */
test('★ 待恢复/待核对记录也有硬上限：不能因为"要保留"就无界增长', async (t) => {
  const cap = recoverableLimitFor(3)
  assert.equal(cap, 20, '小上限时兜底 20')
  assert.equal(recoverableLimitFor(0), 0, 'maxTasks=0（显式不限制）时这一类也不限制')
  assert.equal(recoverableLimitFor(25), 50, '大上限时 2N')

  for (const status of ['ERROR', 'UNCERTAIN']) {
    const store = await freshStore(t, { maxTasks: 3 })
    for (let i = 1; i <= 40; i += 1) await store.saveTask(task('t' + String(i), status, i))
    const ids = await idsOf(store)
    assert.equal(ids.length, cap, status + ' 应被压到独立上限 ' + String(cap) + '，实际 ' + String(ids.length))
    // 留的是**最新**的那批
    assert.ok(ids.includes('t40'), '最新的必须还在')
    assert.ok(!ids.includes('t1'), '最旧的该被清掉')
  }
})

test('★ 待恢复/待核对与普通记录各算各的上限（互不挤占）', async (t) => {
  const store = await freshStore(t, { maxTasks: 5 })
  for (let i = 1; i <= 12; i += 1) await store.saveTask(task('s' + String(i), 'SUCCESS', i))
  for (let i = 1; i <= 30; i += 1) await store.saveTask(task('e' + String(i), 'ERROR', 100 + i))
  const byStatus = {}
  for (const id of await idsOf(store)) {
    const k = id[0] === 's' ? 'SUCCESS' : 'ERROR'
    byStatus[k] = (byStatus[k] || 0) + 1
  }
  assert.equal(byStatus.SUCCESS, 5, '普通记录按 maxTasks=5')
  assert.equal(byStatus.ERROR, recoverableLimitFor(5), '待恢复记录按独立上限')
})

test('★ 待恢复/待核对记录全满时，继续写仍被压回上限（不会漏调度）', async (t) => {
  // 血泪：早先 `saveTask` 只在 `canPruneTask(doc)` 时调度清理，而这恰好**排除**了
  // ERROR/UNCERTAIN —— 于是这一类写进去就再也没人清理，只能无界堆。
  const store = await freshStore(t, { maxTasks: 1 })
  const cap = recoverableLimitFor(1)
  for (let i = 1; i <= 60; i += 1) await store.saveTask(task('u' + String(i), 'UNCERTAIN', i))
  const ids = await idsOf(store)
  assert.equal(ids.length, cap, '60 条 UNCERTAIN 应收敛到 ' + String(cap) + '，实际 ' + String(ids.length))
  assert.ok(ids.includes('u60'), '最新的仍在')
})

test('maxTasks = 0 时两类都不清理（真·不限制）', async (t) => {
  const store = await freshStore(t, { maxTasks: 0 })
  for (let i = 1; i <= 25; i += 1) await store.saveTask(task('u' + String(i), 'UNCERTAIN', i))
  for (let i = 1; i <= 25; i += 1) await store.saveTask(task('s' + String(i), 'SUCCESS', 1000 + i))
  assert.equal((await idsOf(store)).length, 50, '不限制时一条都不该删')
})
