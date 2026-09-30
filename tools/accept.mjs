/**
 * 唯一验收入口 —— 一条命令跑完全部检查
 *
 *   node tools/accept.mjs            # 全部跑，任何一项失败就非零退出
 *   node tools/accept.mjs --json     # 末尾多打一行机器可读的汇总
 *
 * 为什么要有它：检查散在多处（离线装载 / 单测），分开跑就一定有人漏跑一项，
 * 然后"我本地是好的"。**一个入口、一个退出码**，才是可交给别人复核的验收。
 *
 * 两步：
 *   ① 离线装载自检 —— 无宿主桩里把 host + client 加载一次（抓语法/导出错误）
 *   ② 全量测试     —— 337 条，**串行**跑（见下面那条注释里的血泪）
 *
 * 判据：
 *   - 任一步骤非零退出 → 整体失败
 *   - 步骤**找不到** → 记为 skip（不算失败，但会在汇总里显式列出，不静默）
 *   - WARN 不算失败
 *
 * @module dsh-runninghub-plugin/tools/accept
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const asJson = argv.includes('--json')

/** 跑一条命令，返回 {code, out}。不抛（找不到可执行文件也算一种结果）。 */
function run(cmd, args) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd: ROOT,
        shell: false,
        windowsHide: true,
        // 子进程 stdio 钉成 UTF-8：Windows 控制台默认 cp936，脚本里打一个 ✅ 就会
        // UnicodeEncodeError 崩掉 —— 那是**环境问题，不是验收失败**，别误报。
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })
    } catch (e) {
      resolve({ code: -1, out: 'spawn 失败：' + String((e && e.message) || e) })
      return
    }
    let out = ''
    child.stdout.on('data', (d) => {
      out += String(d)
    })
    child.stderr.on('data', (d) => {
      out += String(d)
    })
    child.on('error', (e) => resolve({ code: -1, out: out + String.fromCharCode(10) + '运行失败：' + String((e && e.message) || e) }))
    child.on('close', (code) => resolve({ code: code === null ? -1 : code, out }))
  })
}

/** 取输出里最后一条匹配行（用于把子步骤的关键结论抬进汇总）。 */
function lastMatch(text, re) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => re.test(l))
  return lines.length > 0 ? lines[lines.length - 1].trim() : ''
}

const steps = [
  {
    name: '离线装载自检',
    cmd: process.execPath,
    args: ['tools/loadcheck.mjs'],
    check: 'tools/loadcheck.mjs',
    summary: (o) => lastMatch(o, /\[loadcheck\]/),
  },
  {
    name: '单元测试 + 集成测试',
    cmd: process.execPath,
    // ⚠️ **必须串行**（`--test-concurrency=1`）。
    //
    // 血泪：默认并行跑时每个测试文件各起 HTTP server / 定时器，
    // 一旦机器上有别的重活（编辑器、渲染、另一个 agent），事件循环被抢，
    // 定时器相关的断言就间歇性假红 —— 实测同一份代码出现过
    // 「1 个失败 / 6 个失败 / 全绿」三种结果，而 `tests/core/*` 单独连跑 3 次全绿。
    // **验收门必须是确定性的**，否则"全绿"这三个字没有意义。
    //
    // 代价：约 10s → 约 30s。验收门要的是可信，不是快。
    args: ['--test', '--test-concurrency=1', 'tests/**/*.test.mjs'],
    // 用 tests/ 目录存在性判断（glob 不是字面路径，不能直接 existsSync）
    check: 'tests',
    summary: (o) => {
      const t = lastMatch(o, /^ℹ tests /)
      const p = lastMatch(o, /^ℹ pass /)
      const f = lastMatch(o, /^ℹ fail /)
      const line = [t, p, f].filter(Boolean).join(' · ')

      // 失败时**把具体是哪几条挂出来**。
      //
      // 血泪：这条门曾经只报 "297/298"，我要另外跑十几次才捞到那条 flaky 用例的名字。
      // 验收门失败时必须自证"失败在哪"，否则每次都得重跑碰运气。
      const failed = String(o || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.startsWith('✖ ') && !l.startsWith('✖ failing'))
        .slice(0, 5)
      const suffix = failed.length > 0 ? ' ｜ 失败用例：' + failed.join(' / ') : ''
      return (line || '（没解析到汇总行 —— 可能一个用例都没跑）') + suffix
    },
  },
]

const results = []
for (const s of steps) {
  const missing = s.check ? !existsSync(path.join(ROOT, s.check)) : false
  if (missing) {
    results.push({ ...s, status: 'skip(缺文件)', code: 0, summary: '' })
    process.stdout.write('⏭  ' + s.name + ' —— 缺 ' + s.check + '，跳过' + String.fromCharCode(10))
    continue
  }
  process.stdout.write('▶  ' + s.name + ' …' + String.fromCharCode(10))
  const r = await run(s.cmd, s.args)
  const summary = (() => {
    try {
      return s.summary(r.out)
    } catch {
      return ''
    }
  })()
  const failed = r.code !== 0
  results.push({ ...s, status: failed ? 'fail' : 'pass', code: r.code, summary })
  process.stdout.write(
    (failed ? '✖  ' : '✔  ') + s.name + ' → exit ' + String(r.code) + (summary ? ' · ' + summary : '') + String.fromCharCode(10),
  )
  if (failed) {
    // 失败时把尾部输出打出来 —— 只说"失败了"而不给证据，等于没验
    const tail = String(r.out || '').split(/\r?\n/).slice(-25).join(String.fromCharCode(10))
    process.stdout.write('----- 输出尾部 -----' + String.fromCharCode(10) + tail + String.fromCharCode(10) + '--------------------' + String.fromCharCode(10))
  }
}

const failed = results.filter((r) => r.status === 'fail')
const passed = results.filter((r) => r.status === 'pass')
const skipped = results.filter((r) => r.status.startsWith('skip'))

process.stdout.write(String.fromCharCode(10))
process.stdout.write(
  '验收汇总：通过 ' + String(passed.length) + ' · 失败 ' + String(failed.length) + ' · 跳过 ' + String(skipped.length) +
    ' → ' + (failed.length === 0 ? '**全部通过**' : '**有失败项**') + String.fromCharCode(10),
)
if (skipped.length > 0) process.stdout.write('  （跳过：' + skipped.map((s) => s.name + '[' + s.status + ']').join('、') + '）' + String.fromCharCode(10))
if (asJson) {
  process.stdout.write(
    'ACCEPT_JSON ' +
      JSON.stringify({
        ok: failed.length === 0,
        passed: passed.length,
        failed: failed.length,
        skipped: skipped.length,
        steps: results.map((r) => ({ name: r.name, status: r.status, code: r.code, summary: r.summary })),
      }) +
      String.fromCharCode(10),
  )
}
process.exit(failed.length === 0 ? 0 : 1)
