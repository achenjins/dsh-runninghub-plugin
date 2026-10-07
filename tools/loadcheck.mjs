/**
 * 离线装载自检：不依赖 DSH，直接 import 插件入口，检查导出面与两个工具的 schema。
 *
 * 用途：改完 host 半边先跑这个 —— 能在 1 秒内发现语法错、import 环路、defineTool 解析失败，
 * 而不用去重启整个 DSH 桌面版（那是最贵的验证方式，留到最后）。
 *
 *   node tools/loadcheck.mjs
 *
 * @module dsh-runninghub-plugin/tools/loadcheck
 */

import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SCHEMASTERY } from '../host/shared.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.join(HERE, '..', 'host', 'index.mjs')

const problems = []
const notes = []

function check(cond, label) {
  if (cond) notes.push('  ✅ ' + label)
  else problems.push('  ❌ ' + label)
}

process.stdout.write('[loadcheck] import ' + ENTRY + '\n')

let mod
try {
  mod = await import(pathToFileURL(ENTRY).href + '?t=' + String(Date.now()))
} catch (e) {
  process.stdout.write('  ❌ import 失败：' + String((e && e.stack) || e) + '\n')
  process.exit(1)
}

check(typeof mod.name === 'string' && mod.name.length > 0, 'export const name = ' + JSON.stringify(mod.name))
check(Array.isArray(mod.inject) && mod.inject.includes('tools'), 'export const inject 含 tools：' + JSON.stringify(mod.inject))
check(typeof mod.apply === 'function', 'export function apply(ctx, config)')
check(SCHEMASTERY.ok ? mod.Config !== undefined : mod.Config === undefined, SCHEMASTERY.ok ? 'Config 已使用宿主 schemastery' : 'schemastery 未安装，使用 normalizeConfig 归一化配置')
check(typeof mod.normalizeConfig === 'function', 'export normalizeConfig')

/* ── 用桩 ctx 真跑一遍 apply，看两个工具注册成什么样 ── */
const registered = []
const effects = []
const listeners = []
const logLines = []
const stubCtx = {
  logger: {
    info: (m) => logLines.push(['info', String(m)]),
    warn: (m) => logLines.push(['warn', String(m)]),
    error: (m) => logLines.push(['error', String(m)]),
  },
  tools: {
    register: (def) => {
      registered.push(def)
      return () => {}
    },
  },
  get: () => undefined,
  on: (...a) => {
    listeners.push(a)
    return () => {}
  },
  effect: (fn) => {
    const d = fn()
    effects.push(d)
    return () => {
      if (typeof d === 'function') d()
    }
  },
  // 可选服务没有装载，宿主不会执行这些注入回调。
  inject: () => () => {},
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rh-loadcheck-'))
process.once('beforeExit', async () => {
  const relative = path.relative(os.tmpdir(), dataDir)
  if (relative.startsWith('rh-loadcheck-') && !relative.includes(path.sep)) {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }).catch(() => { process.exitCode = 1 })
  }
})
try {
  mod.apply(stubCtx, { dataDir, registerSkill: false, exposeClientPanel: false })
} catch (e) {
  problems.push('  ❌ apply(stubCtx) 抛异常：' + String((e && e.stack) || e))
}

check(registered.length === 2, 'apply 注册了 2 个工具（实际 ' + String(registered.length) + '）')
const names = registered.map((t) => t && t.name)
check(names.includes('runninghub_search'), 'runninghub_search 已注册：' + JSON.stringify(names))
check(names.includes('runninghub_call'), 'runninghub_call 已注册：' + JSON.stringify(names))

for (const t of registered) {
  check(!!t && typeof t.description === 'string' && t.description.length > 20, String(t && t.name) + ' 有 description')
  check(!!t && t.parameters && t.parameters.type === 'object' && !!t.parameters.properties, String(t && t.name) + ' parameters 是 JSON Schema object')
  check(!!t && typeof t.execute === 'function', String(t && t.name) + ' 有 execute')
  check(!!t && t.output && typeof t.output.render === 'function', String(t && t.name) + ' 有 output.render')
}

/* ── search 只读静态动作索引，核心层未装载时仍可用 ── */
const searchTool = registered.find((t) => t && t.name === 'runninghub_search')
if (searchTool) {
  try {
    const out = await searchTool.execute({}, {})
    check(!!out && out.ok === true, 'search 在核心层缺席时仍返回动作索引')
    check(typeof (out && out.text) === 'string' && out.text.length > 0, 'search 回执有可读 text')
    check(Object.keys(searchTool.parameters.properties).length === 0 && out.text.includes('workflow.get') && out.text.includes('task.list'), 'search 无参数，返回全部动作使用方式')
  } catch (e) {
    problems.push('  ❌ search 执行抛异常：' + String((e && e.stack) || e))
  }
}

const callTool = registered.find((t) => t && t.name === 'runninghub_call')
if (callTool) {
  try {
    const out = await callTool.execute({ action: '__no_such_action__' }, {})
    check(typeof (out && out.text) === 'string' && out.text.includes('workflow.run'), '未知 action 的回执里带动作清单（模型可自纠）')
  } catch (e) {
    problems.push('  ❌ call 未知 action 抛异常：' + String((e && e.stack) || e))
  }
}

process.stdout.write(notes.join('\n') + '\n')
for (const dispose of effects.reverse()) {
  if (typeof dispose === 'function') dispose()
}
if (problems.length > 0) {
  process.stdout.write('\n[loadcheck] 失败 ' + String(problems.length) + ' 项：\n' + problems.join('\n') + '\n')
  process.exitCode = 1
} else {
  process.stdout.write('\n[loadcheck] 全部通过 · 工具 ' + names.join(', ') + '\n')
}
