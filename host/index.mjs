/**
 * dsh-runninghub-plugin · 插件入口（host 半边）
 *
 * 给模型两个工具：
 *   runninghub_search  —— 发现：本地有哪些工作流 / 任务 / Key / 提示词优化文档
 *   runninghub_call    —— 执行：看详情、拉取并推断节点、落盘配置、后台跑、取结果、查余额、管 Key
 * 外加一个 bundled skill `runninghub-workflow-setup`（AI 辅助配置工作流的流程书）。
 *
 * 三条设计红线（都有代价，别改）：
 *   1. **工具必须同步注册**：装配放后台补，装配失败也只是回执里说 `CORE_NOT_LOADED`。
 *      工具"凭空消失"是最难排查的故障，宁可让工具在、但把原因写在回执里。
 *   2. **`inject` 只要 `tools`**：`skills` / `subagents` / `attachments` / `credentials` 全部走
 *      `ctx.get()` 可选读。少一个服务不该让整个插件 failed。
 *   3. **`apply` 不抛**：整段包 try/catch，最坏情况是工具在、但每次都回一句可读错误。
 *
 * @module dsh-runninghub-plugin
 */

import { createRuntime, initRuntime, resolveDataDirFallback } from './runtime.mjs'
import { HOST_API, SCHEMASTERY, PLUGIN_VERSION, maskKey } from './shared.mjs'
import { makeSearchTool } from './tools/search.mjs'
import { makeCallTool } from './tools/call.mjs'
import { buildSkillRegistration, SKILL_NAME } from './skill.mjs'
import { redactForRuntime } from './security.mjs'
import { DEFAULT_TASK_LIMIT, parseTaskLimit } from './task-policy.mjs'

/** 插件名：与包名、loader 条目 id 一致。 */
export const name = 'dsh-runninghub-plugin'

/**
 * 硬依赖只有 `tools`。
 * 其余（skills / subagents / attachments / commands / webServer / credentials）都是**可选**，
 * 缺了只会降级，不会让 fiber failed。
 */
export const inject = ['tools']

/**
 * 配置 schema。
 * schemastery 在宿主的安装位置会随 DSH 升级而变，所以走运行时多路径解析（见 shared.mjs）；
 * 解析不到时退化为"无 schema"，`apply` 里照样做一遍归一化，功能不受影响。
 */
export const Config = SCHEMASTERY.ok
  ? SCHEMASTERY.z.object({
      dataDir: SCHEMASTERY.z.string().default(''),
      /**
       * 生成结果的**本地保存文件夹**（绝对路径）。
       *
       * **留空即为推荐用法**：结果存到 `workflow.run` 当时那个**会话工作目录**下的
       * `runninghub-output/`（新建）—— 素材就躺在项目里，不用去 `~/.dsh` 翻。
       * 填了则所有任务都落到这个文件夹；单次调用还能用 `workflow.run({saveDir})` 覆盖。
       *
       * 只影响**输出文件**；工作流配置 / 任务流水 / 机密仍留在 `dataDir`
       * —— 那些是插件的状态，不该跟着用户的素材目录跑。
       */
      outputDir: SCHEMASTERY.z.string().default(''),
      /** 最近完成的任务记录上限；0 不限制。面板保存的设置优先，活任务另行保留。 */
      maxTasks: SCHEMASTERY.z.natural().default(DEFAULT_TASK_LIMIT),
      httpTimeoutMs: SCHEMASTERY.z.natural().default(60000),
      pollIntervalMs: SCHEMASTERY.z.natural().default(3000),
      maxWaitMs: SCHEMASTERY.z.natural().default(1800000),
      registerSkill: SCHEMASTERY.z.boolean().default(true),
      exposeClientPanel: SCHEMASTERY.z.boolean().default(true),
      baseUrls: SCHEMASTERY.z.any().default({}),
    })
  : undefined

/** 把任意来源的配置归一化（schema 缺席时也要能跑）。 */
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {}
  const pos = (v, d) => {
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : d
  }
  const baseUrls = {}
  if (c.baseUrls && typeof c.baseUrls === 'object') {
    for (const k of ['cn', 'overseas']) {
      const v = c.baseUrls[k]
      if (typeof v === 'string' && v.trim().length > 0) baseUrls[k] = v.trim()
    }
  }
  return {
    dataDir: typeof c.dataDir === 'string' ? c.dataDir.trim() : '',
    outputDir: typeof c.outputDir === 'string' ? c.outputDir.trim() : '',
    // `0` 是**合法值**（不限制），所以不能用 `pos()`（它把 0 当无效退回默认）。
    maxTasks: parseTaskLimit(c.maxTasks) ?? DEFAULT_TASK_LIMIT,
    httpTimeoutMs: pos(c.httpTimeoutMs, 60000),
    pollIntervalMs: pos(c.pollIntervalMs, 3000),
    maxWaitMs: pos(c.maxWaitMs, 1800000),
    registerSkill: c.registerSkill === undefined ? true : !!c.registerSkill,
    exposeClientPanel: c.exposeClientPanel === undefined ? true : !!c.exposeClientPanel,
    baseUrls,
  }
}

/**
 * 挂载插件。
 *
 * @param {any} ctx cordis 上下文（携带 tools）
 * @param {any} rawConfig loader 传入的配置
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  let rt

  // ── 日志：宿主给了 ctx.logger 就用，没给就退回 console（前缀统一，便于过滤）──
  const logger = {
    info: (m) => emitLog(ctx, 'info', redactForRuntime(rt, m)),
    warn: (m) => emitLog(ctx, 'warn', redactForRuntime(rt, m)),
    error: (m) => emitLog(ctx, 'error', redactForRuntime(rt, m)),
  }

  // ── 运行时外壳**同步**建好（工具立刻可用），装配在后台补 ──
  rt = createRuntime({ ctx, config, logger })

  void (async () => {
    try {
      await initRuntime(rt)
      if (rt.disposed) {
        if (rt.runner) rt.runner.stop()
        return
      }
      logger.info(
        '[runninghub] 协议层' + (rt.coreReady ? '已就绪' : '未装载：' + String(rt.loadError || '').slice(0, 200)) +
          ' · 数据目录 ' + rt.dataDir,
      )
      // 恢复未完成任务的轮询（进程重启不该丢掉排队中的任务）
      if (rt.runner && typeof rt.runner.resume === 'function') {
        try {
          await rt.runner.resume()
        } catch (e) {
          rt.warn('resume 失败：' + String((e && e.message) || e))
        }
      }
    } catch (e) {
      rt.warn('运行时装配异常：' + String((e && e.stack) || e))
      logger.error('[runninghub] 运行时装配异常：' + String((e && e.message) || e))
    }
  })()

  /** 工具侧的取运行时入口（永远返回同一个对象）。 */
  const getRuntime = () => rt

  // ── 两个工具：同步注册，任何情况下都不缺席 ──
  try {
    ctx.effect(() => ctx.tools.register(makeSearchTool(getRuntime)), 'dsh-runninghub-plugin: runninghub_search')
    ctx.effect(() => ctx.tools.register(makeCallTool(getRuntime)), 'dsh-runninghub-plugin: runninghub_call')
  } catch (e) {
    logger.error('[runninghub] 工具注册失败（插件本体已加载，但模型看不到工具）：' + String((e && e.message) || e))
    throw e
  }

  // ── DSH 原生后台作业：把工作流运行挂进 ctx.jobs ──
  //
  // `ctx.jobs.start` 之前必须有 controller 服务这个 owner，所以这里先挂一个。
  // `jobs` 不在 inject 里（可选依赖）：宿主没这个服务时整段跳过，退回「纯后台 + task.wait」。
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['jobs'], (scope) => {
        scope.effect(() => scope.jobs.attachController('dsh-runninghub-plugin'), 'dsh-runninghub-plugin: jobs controller')
      })
    }
  } catch (e) {
    rt.warn('jobs controller 未挂上（后台任务仍可用，只是不会进 job_list）：' + String((e && e.message) || e))
  }

  // ── skill：可选服务，缺了只 warn ──
  ctx.effect(() => {
    if (!config.registerSkill) return () => {}
    const skills = ctx.get('skills')
    if (!skills || typeof skills.register !== 'function') {
      rt.warn('宿主没有 skills 服务：AI 辅助配置工作流所需的 skill `' + SKILL_NAME + '` 未注册（其余功能不受影响）')
      return () => {}
    }
    let alive = true
    let disposer = null
    void (async () => {
      const built = await buildSkillRegistration()
      if (!built.ok) {
        rt.warn('skill 未注册：' + built.reason)
        return
      }
      if (!alive) return
      try {
        disposer = skills.register(built.registration)
        logger.info('[runninghub] skill `' + SKILL_NAME + '` 已注册')
      } catch (e) {
        rt.warn('skill 注册失败：' + String((e && e.message) || e))
      }
    })()
    return () => {
      alive = false
      try {
        if (typeof disposer === 'function') disposer()
      } catch {
        /* 清理失败不影响卸载 */
      }
    }
  }, 'dsh-runninghub-plugin: skill')

  // ── 浏览器半边（配置面板）的数据通道：可选，缺了面板就只显示"后端未装配" ──
  ctx.effect(() => {
    if (!config.exposeClientPanel) return () => {}
    let alive = true
    let disposer = null
    void (async () => {
      try {
        const mod = await import('./rpc.mjs')
        if (!alive || !mod) return
        // Remote（官方 RPC）+ HTTP 路由，两条腿一起挂；任一可用面板就能工作
        if (typeof mod.registerClientBridge === 'function') {
          disposer = await mod.registerClientBridge(ctx, rt)
        } else if (typeof mod.registerHostRpc === 'function') {
          disposer = await mod.registerHostRpc(ctx, rt)
        }
        if (!alive && typeof disposer === 'function') disposer()
      } catch (e) {
        // 面板通道起不来不影响模型侧两个工具；但要在诊断里留痕
        rt.warn('配置面板通道未装配（模型侧工具不受影响）：' + String((e && e.message) || e))
      }
    })()
    return () => {
      alive = false
      try {
        if (typeof disposer === 'function') disposer()
      } catch {
        /* 清理失败不影响卸载 */
      }
    }
  }, 'dsh-runninghub-plugin: client bridge')

  // ── 卸载：停掉后台轮询定时器，避免 HMR 反复挂载时泄漏 ──
  ctx.effect(() => () => {
    rt.disposed = true
    try {
      if (rt.runner && typeof rt.runner.stop === 'function') rt.runner.stop()
    } catch {
      /* 停不掉也不能让卸载失败 */
    }
  }, 'dsh-runninghub-plugin: teardown')

  logger.info(
    '[runninghub v' + PLUGIN_VERSION + '] 已挂载 · 宿主 API ' + HOST_API.source + ' · 数据目录 ' + resolveDataDirFallback(config) +
      (SCHEMASTERY.ok ? '' : ' · ⚠ schemastery 未解析到，配置校验降级'),
  )
}

/** 统一日志出口（宿主 logger 的面在版本间变过，所以只试最常见的几个方法）。 */
function emitLog(ctx, level, msg) {
  const text = String(msg)
  try {
    const lg = ctx && ctx.logger
    if (lg && typeof lg[level] === 'function') {
      lg[level](text)
      return
    }
    if (level === 'error') console.error(text)
    else if (level === 'warn') console.warn(text)
    else console.log(text)
  } catch {
    /* 日志失败绝不影响主流程 */
  }
}

export { maskKey }
