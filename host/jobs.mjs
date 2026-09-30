/**
 * dsh-runninghub-plugin · DSH 原生后台作业桥
 *
 * 为什么需要这一层（而不是自己攒一个后台队列）：
 *   - `ctx.jobs` 的 job 会**自动出现在模型的标准 `job_list` / `job_output` 里**
 *     （`dsh-tool-jobs` 的 `job_list` 只按 owner 过滤，不按 kind 过滤），
 *     模型不用学新工具就能看进度；
 *   - **job 结算时会自动给 owner 会话注入一条完成通知** —— 用户说"帮我把这张图跑出来"
 *     然后去干别的，跑完模型会被叫醒。这条只有走 `ctx.jobs` 才有。
 *
 * 三条实测结论（来自 dsh-api 的源码级核查，别推翻）：
 *   1. `JobKind` 的 TS 类型只有 `'bash'|'subagent'`，但**运行时零限制**，
 *      只校验 kind 是非空字符串（`dsh-jobs-local/lib/index.js`）。官方插件
 *      `dsh-mcp-panel` 就用 `kind:'mcp-probe'` 在跑，所以 `'runninghub'` 是安全的。
 *   2. `jobs.start` 之前**必须有 controller 服务这个 owner**；我们在 `index.mjs` 里
 *      `ctx.inject(['jobs'], scope => scope.effect(() => scope.jobs.attachController(...)))`。
 *   3. `owner` 不传 = unowned —— 所有会话都看得见，但**不会注入完成通知**。
 *      所以这里恒传 `owner = 当前会话 id`。
 *
 * 设计红线：这一层**尽力而为**。任何一步不成立（没有 jobs 服务、start 抛错、owner 缺失）
 * 都只 warn，然后退回"纯后台 + task.wait"的老路 —— 功能降级，但绝不失败。
 *
 * @module dsh-runninghub-plugin/host/jobs
 */

/** 自定义 job kind：会变成 `runninghub-N` 这样的 id。 */
export const JOB_KIND = 'runninghub'

/**
 * 从 ctx 里找 jobs 服务。
 *
 * @param {any} ctx 插件上下文
 * @returns {any|null}
 */
export function findJobsService(ctx) {
  try {
    const jobs = ctx && typeof ctx.get === 'function' ? ctx.get('jobs') : null
    return jobs && typeof jobs.start === 'function' ? jobs : null
  } catch {
    return null
  }
}

/**
 * 把一个已经在跑的后台任务包成 DSH 作业。
 *
 * 调用时机：`runner.submit()` **之后**（那时才有 taskId）。
 * `jobs.start` 是同步返回 id 的，而我们的 `done` promise 在后台继续跑，
 * 所以「提交立刻返回」这条语义没有被破坏。
 *
 * @param {object} args
 * @param {any} args.jobs ctx.jobs
 * @param {any} args.runner TaskRunner
 * @param {string} args.taskId RunningHub 任务 id
 * @param {string} args.label 作业标题（模型在 job_list 里看到的）
 * @param {string|undefined} args.owner 会话 id（**必传**，否则没有完成通知）
 * @param {number} args.maxWaitMs done 里最多等多久
 * @param {object} [args.meta] 额外信息（工作流名、地域、提示词摘要），会写进作业输出
 * @returns {string|null} jobId；包不起来就返回 null（调用方退回纯后台）
 */
export function startTaskJob({ jobs, runner, taskId, taskIds, label, owner, maxWaitMs, meta }) {
  if (!jobs || typeof jobs.start !== 'function') return null
  // 兼容两种入参：`taskId`（单个）/ `taskIds`（批量）。
  // ⚠️ 批量必须支持：`workflow.run({repeat:4})` 会提交 4 个任务，
  //    只等第一个的话，另外 3 个跑完没人通知 —— 用户以为作业早结束了。
  const ids = (Array.isArray(taskIds) && taskIds.length > 0 ? taskIds : [taskId])
    .map((t) => String(t || ''))
    .filter((t) => t !== '')
  if (ids.length === 0) return null

  try {
    const spec = {
      kind: JOB_KIND,
      label: String(label || ('RunningHub 任务 ' + ids[0])),
      ...(owner ? { owner } : {}),
      run: (job) => {
        // 输出策略（按 dsh-api 的源码核查结论，别改用大量 append）：
        //   - `updateProgress()` 是**覆盖写**、不进 ring、显示在 job_list 的那一行 → 放"当前状态"
        //   - `append()` 进 ring，**结算后只保留最后 16 KiB**，且 job_output 是消费式读取
        //     → 只写"值得模型读到"的短行，绝不 append 完整 API 响应
        //   - 关键信息放 `JobOutcome.result`，它**不走 ring**、不受裁剪影响，结算后第一次 read 带出
        const say = (line) => {
          try {
            job.append(String(line) + String.fromCharCode(10))
          } catch {
            /* 作业输出写失败不影响任务本身 */
          }
        }
        const tick = (line) => {
          try {
            job.updateProgress(String(line))
          } catch {
            /* 同上 */
          }
        }

        tick('已提交 ' + String(ids.length) + ' 个任务')
        say(
          '[runninghub] 已提交 ' + String(ids.length) + ' 个' +
            (meta && meta.workflowName ? ' · 工作流 ' + String(meta.workflowName) : '') +
            (meta && meta.region ? ' · 地域 ' + String(meta.region) : ''),
        )
        if (meta && meta.promptPreview) say('[runninghub] 提示词：' + String(meta.promptPreview))

        let cancelled = false
        const done = (async () => {
          try {
            const timeout = Number(maxWaitMs) > 0 ? Number(maxWaitMs) : 1800000
            /** @type {{taskId:string, status:string, results:any[], seconds:number, coins:number}[]} */
            const per = []
            const failures = []
            for (const id of ids) {
              if (cancelled) break
              const w = await runner.wait(id, timeout)
              const task = (w && w.task) || {}
              const results = (w && w.results) || []
              const status = String(task.status || (w && w.ok === false ? 'FAILED' : 'SUCCESS'))
              const a = Number(task.createdAt) || 0
              const b = Number(task.finishedAt) || 0
              let coins = 0
              for (const o of task.outputs || []) {
                const c = Number(o && o.consumeCoins)
                if (Number.isFinite(c) && c > 0) coins += c
              }
              per.push({ taskId: id, status, results, seconds: a > 0 && b > a ? Math.round((b - a) / 1000) : 0, coins })
              if (w && w.ok === false) failures.push(String((w.error && w.error.message) || '任务失败'))
              if (w && w.timedOut === true) failures.push('等待超时，任务 ' + id + ' 仍在运行。用 task.wait 继续取结果，请勿重复提交。')
            }

            if (cancelled) {
              tick('已取消')
              return { status: 'killed', detail: '用户取消了作业' }
            }

            const localPaths = []
            const resultLines = []
            let imageCount = 0
            let seconds = 0
            let coins = 0
            for (const p of per) {
              seconds = Math.max(seconds, p.seconds)
              coins += p.coins
              for (const r of p.results) {
                if (r && r.kind === 'image') imageCount += 1
                if (r && typeof r.localPath === 'string' && r.localPath.length > 0) localPaths.push(r.localPath)
                if (r && r.error) resultLines.push('结果文件未保存：' + String(r.error) + (r.url ? ' · ' + String(r.url) : ''))
                if (r && r.note) resultLines.push(String(r.note))
                if (r && r.kind === 'text' && r.text) resultLines.push(String(r.text))
              }
            }
            const total = per.reduce((n, p) => n + p.results.length, 0)

            if (failures.length > 0) {
              const msg = failures.join('；')
              tick('失败')
              say('[runninghub] ❌ ' + msg)
              return { status: 'failed', detail: msg }
            }

            // 通知**故意压到最短**：用户要的是"跑完没、图在哪"。
            // 远端 URL 不写（图已经在本地了，且 URL 属于冗余信息）。
            const bits = []
            if (seconds > 0) bits.push(String(seconds) + 's')
            if (coins > 0) bits.push(String(coins) + ' 币')
            const head = '✅ 完成 · ' + String(total) + ' 个' + (bits.length > 0 ? ' · ' + bits.join(' · ') : '')
            tick(head)
            say('[runninghub] ' + head)
            for (const p of localPaths) say('📁 ' + p)
            for (const line of resultLines) say(line)

            // `JobOutcome.result` 是**结算后模型真正会读到的正文**，所以把
            // 「图在哪 + 怎么把图拿进聊天」都说清楚（后者只有 task.wait 做得到：
            // 作业结算注入的是文本，图片必须走工具结果才能渲染）。
            const summary =
              head +
              String.fromCharCode(10) +
              localPaths.map((p) => '📁 ' + p).join(String.fromCharCode(10)) +
              (resultLines.length ? String.fromCharCode(10) + resultLines.join(String.fromCharCode(10)) : '') +
              String.fromCharCode(10) +
              '（要在聊天里看到图：runninghub_call({action:"task.wait", taskId:"' + ids[0] + '"}））'
            return { status: 'completed', result: summary }
          } catch (e) {
            const msg = String((e && e.message) || e)
            tick('等待异常')
            say('[runninghub] ❌ 等待异常：' + msg)
            return { status: 'failed', detail: msg }
          }
        })()

        return {
          cancel: (reason) => {
            cancelled = true
            say('[runninghub] 收到取消请求' + (reason ? '：' + String(reason) : ''))
            for (const id of ids) {
              try {
                void Promise.resolve(runner.cancel(id)).catch((error) => {
                  say('[runninghub] 取消 ' + id + ' 失败：' + String((error && error.message) || error))
                })
              } catch {
                /* 取消失败不阻塞作业结算 */
              }
            }
          },
          done,
        }
      },
    }
    const id = jobs.start(spec)
    return id ? String(id) : null
  } catch (e) {
    return null
  }
}
