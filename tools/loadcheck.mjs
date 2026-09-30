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
import { fileURLToPath, pathToFileURL } from 'node:url'

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
check(mod.Config !== undefined, 'export const Config（schemastery 解析成功时存在）')
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
  inject: (deps, fn) => {
    effects.push(fn)
  },
}

try {
  mod.apply(stubCtx, {})
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

/* ── 真调一次 search：核心层还没装载时必须是可读回执，而不是抛异常 ── */
const searchTool = registered.find((t) => t && t.name === 'runninghub_search')
if (searchTool) {
  try {
    const out = await searchTool.execute({ kind: 'workflow' }, {})
    check(!!out && typeof out === 'object', 'search 在核心层缺席时返回对象（不抛）')
    check(typeof (out && out.text) === 'string' && out.text.length > 0, 'search 回执有可读 text')
    check(!!(out && out.error) === true, "search 在核心层缺席时给出 error.code" + (out && out.error ? '=' + out.error.code : ''))
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
if (problems.length > 0) {
  process.stdout.write('\n[loadcheck] 失败 ' + String(problems.length) + ' 项：\n' + problems.join('\n') + '\n')
  process.exit(1)
}
process.stdout.write('\n[loadcheck] 全部通过 · 工具 ' + names.join(', ') + '\n')
