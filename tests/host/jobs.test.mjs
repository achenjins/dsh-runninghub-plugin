/**
 * DSH 原生后台作业桥（`ctx.jobs`）的契约测试。
 *
 * 为什么值得单测：
 *   - 这是"后台生图"的**唯一**交付通道 —— 作业跑完由宿主往会话里注入完成通知，
 *     通知内容写错了，用户就只能自己去翻文件夹；
 *   - **批量是踩过的坑**：`workflow.run({repeat:4})` 提交 4 个任务，
 *     早先只 `wait` 第一个 —— 作业会提前显示"完成"，另外 3 张图跑完没人管。
 *
 * @module dsh-runninghub-plugin/tests/host/jobs
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { startTaskJob, findJobsService, JOB_KIND } from '../../host/jobs.mjs'

/** 造一个假的 ctx.jobs，记录拿到的 spec 并暴露 job 的输出。 */
function makeFakeJobs() {
  const captured = []
  const jobs = {
    start(spec) {
      captured.push(spec)
      return 'job-' + String(captured.length)
    },
  }
  return { jobs, captured }
}

/** 造一个假 job（`append` 进 ring，`updateProgress` 覆盖写）。 */
function drainJob(spec) {
  const ring = []
  let progress = ''
  const job = {
    append: (s) => ring.push(String(s)),
    updateProgress: (s) => {
      progress = String(s)
    },
  }
  const handle = spec.run(job)
  return { handle, ring, progressOf: () => progress }
}

test('单任务：完成通知里带本地路径，并说清怎么把图拿进聊天', async () => {
  const { jobs, captured } = makeFakeJobs()
  const waited = []
  const runner = {
    wait: async (taskId) => {
      waited.push(taskId)
      return {
        ok: true,
        task: { taskId, status: 'SUCCESS', createdAt: 1000, finishedAt: 61000, outputs: [{ consumeCoins: '16' }] },
        results: [{ kind: 'image', url: 'https://x/a.png', localPath: 'C:\\out\\a.png' }],
      }
    },
    cancel: async () => ({ ok: true }),
  }

  const id = startTaskJob({ jobs, runner, taskId: 'T1', owner: 'sess', maxWaitMs: 1000 })
  assert.equal(id, 'job-1')
  assert.equal(captured[0].kind, JOB_KIND)
  assert.equal(captured[0].owner, 'sess', 'owner 必须传 —— 不传就没有完成通知')

  const { handle, ring } = drainJob(captured[0])
  const outcome = await handle.done

  assert.deepEqual(waited, ['T1'])
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.result, /60s/, '结果里应有耗时')
  assert.match(outcome.result, /16 币/, '结果里应有消耗')
  assert.match(outcome.result, /C:\\out\\a\.png/, '★ 结果里必须有本地路径')
  assert.match(outcome.result, /task\.wait/, '★ 必须告诉模型怎么把图拿进聊天')
  assert.ok(
    ring.some((l) => l.includes('C:\\out\\a.png')),
    'ring 里也应有本地路径',
  )
  assert.ok(!ring.some((l) => l.includes('https://x/a.png')), '远端 URL 不该再进通知（冗余）')
})

test('★ 批量：repeat 提交的**每一个**任务都要被等到', async () => {
  const { jobs, captured } = makeFakeJobs()
  const waited = []
  const runner = {
    wait: async (taskId) => {
      waited.push(taskId)
      return {
        ok: true,
        task: { taskId, status: 'SUCCESS', createdAt: 0, finishedAt: 0, outputs: [] },
        results: [{ kind: 'image', localPath: 'C:\\out\\' + taskId + '.png' }],
      }
    },
    cancel: async () => ({ ok: true }),
  }

  startTaskJob({ jobs, runner, taskIds: ['T1', 'T2', 'T3'], maxWaitMs: 1000 })
  const { handle } = drainJob(captured[0])
  const outcome = await handle.done

  assert.deepEqual(waited, ['T1', 'T2', 'T3'], '★★ 三个任务必须都被 wait 到（只等第一个就是bug）')
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.result, /3 个/)
  for (const t of ['T1', 'T2', 'T3']) {
    assert.ok(outcome.result.includes('C:\\out\\' + t + '.png'), t + ' 的本地路径必须在结果里')
  }
})

test('取消：所有任务都下发 cancel，且结算为 killed', async () => {
  const { jobs, captured } = makeFakeJobs()
  const cancelled = []
  const runner = {
    wait: () => new Promise(() => {}), // 永不 settle，靠 cancel 收尾
    cancel: async (t) => {
      cancelled.push(t)
      return { ok: true }
    },
  }
  startTaskJob({ jobs, runner, taskIds: ['A', 'B'], maxWaitMs: 1000 })
  const { handle } = drainJob(captured[0])

  // 等一下让 done 进入 wait，再取消
  await new Promise((r) => setTimeout(r, 5))
  handle.cancel('用户要求')
  assert.deepEqual(cancelled.sort(), ['A', 'B'], '★ 批量取消必须把每个任务都取消')

  // done 不会自己结束（wait 永不 settle）—— 这里只验 cancel 的下发
})

test('失败：任一任务失败 → 作业失败并带上原因', async () => {
  const { jobs, captured } = makeFakeJobs()
  const runner = {
    wait: async () => ({ ok: false, error: { code: 'TASK_FAILED', message: '显存不足' } }),
    cancel: async () => ({ ok: true }),
  }
  startTaskJob({ jobs, runner, taskId: 'F1', maxWaitMs: 1000 })
  const { handle } = drainJob(captured[0])
  const outcome = await handle.done
  assert.equal(outcome.status, 'failed')
  assert.match(outcome.detail, /显存不足/)
})

test('降级：没有 jobs 服务 / 没有 taskId → 返回 null，绝不抛', () => {
  assert.equal(startTaskJob({ jobs: null, runner: {}, taskId: 'T', maxWaitMs: 1 }), null)
  assert.equal(startTaskJob({ jobs: { start: () => 'x' }, runner: {}, taskId: '', maxWaitMs: 1 }), null)
  assert.equal(startTaskJob({ jobs: { start: () => 'x' }, runner: {}, taskIds: [], maxWaitMs: 1 }), null)
})

test('降级：jobs.start 抛错 → 返回 null（任务本身照跑，不该被作业层拖死）', () => {
  const jobs = {
    start: () => {
      throw new Error('jobs 内部炸了')
    },
  }
  assert.equal(startTaskJob({ jobs, runner: {}, taskId: 'T', maxWaitMs: 1 }), null)
})

test('findJobsService：没有 jobs / get 抛错 → null（可选依赖，不抛）', () => {
  assert.equal(findJobsService(null), null)
  assert.equal(findJobsService({}), null)
  assert.equal(findJobsService({ get: () => undefined }), null)
  assert.equal(
    findJobsService({
      get: () => {
        throw new Error('cannot get property "jobs" without inject')
      },
    }),
    null,
  )
  const fake = { start: () => 'x' }
  assert.equal(findJobsService({ get: () => fake }), fake)
})
