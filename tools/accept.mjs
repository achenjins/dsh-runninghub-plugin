/**
 * 验收入口：依次检查发布文件、离线装载和测试。
 *
 *   node tools/accept.mjs            # 全部跑，任何一项失败就非零退出
 *   node tools/accept.mjs --json     # 末尾多打一行机器可读的汇总
 *
 *   ① Git 与安装包检查：检查凭据、文件清单和入口依赖。
 *   ② 离线装载自检：使用临时目录和宿主桩检查工具注册。
 *   ③ 全量测试：串行跑，减少定时器用例受到机器负载的干扰。
 *
 * 判据：
 *   - 任一步骤非零退出 → 整体失败
 *   - 缺少必要步骤、没有执行测试 → 整体失败
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
        env: { ...process.env, FORCE_COLOR: '0' },
      })
    } catch (e) {
      resolve({ code: -1, out: 'spawn 失败：' + String((e && e.message) || e) })
      return
    }
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
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
    name: 'Git 与安装包检查',
    cmd: process.execPath,
    args: ['tools/check-release.mjs'],
    check: 'tools/check-release.mjs',
    summary: (o) => lastMatch(o, /\[releasecheck\]/),
  },
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
    // 串行执行避免测试文件之间争抢本地 HTTP 服务和定时器。
    // 显式指定 reporter，重定向输出时仍能解析测试数量与失败用例。
    args: ['--test', '--test-concurrency=1', '--test-reporter=spec', 'tests/**/*.test.mjs'],
    // 用 tests/ 目录存在性判断（glob 不是字面路径，不能直接 existsSync）
    check: 'tests',
    validate: (o) => Number(lastMatch(o, /^ℹ tests /).split(' ').at(-1)) > 0 && Number(lastMatch(o, /^ℹ pass /).split(' ').at(-1)) > 0,
    summary: (o) => {
      const t = lastMatch(o, /^ℹ tests /)
      const p = lastMatch(o, /^ℹ pass /)
      const f = lastMatch(o, /^ℹ fail /)
      const line = [t, p, f].filter(Boolean).join(' · ')

      // 保留失败用例名，避免为了查明失败原因再次全量执行。
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
    results.push({ ...s, status: 'fail', code: 1, summary: '缺少必要文件：' + s.check })
    process.stdout.write('✖  ' + s.name + ' —— 缺 ' + s.check + '\n')
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
  const failed = r.code !== 0 || (s.validate && !s.validate(r.out))
  const code = failed && r.code === 0 ? 1 : r.code
  results.push({ ...s, status: failed ? 'fail' : 'pass', code, summary })
  process.stdout.write(
    (failed ? '✖  ' : '✔  ') + s.name + ' → exit ' + String(code) + (summary ? ' · ' + summary : '') + String.fromCharCode(10),
  )
  if (failed) {
    // 失败时把尾部输出打出来 —— 只说"失败了"而不给证据，等于没验
    const tail = String(r.out || '').split(/\r?\n/).slice(-25).join(String.fromCharCode(10))
    process.stdout.write('----- 输出尾部 -----' + String.fromCharCode(10) + tail + String.fromCharCode(10) + '--------------------' + String.fromCharCode(10))
  }
}

const failed = results.filter((r) => r.status === 'fail')
const passed = results.filter((r) => r.status === 'pass')

process.stdout.write(String.fromCharCode(10))
process.stdout.write(
  '验收汇总：通过 ' + String(passed.length) + ' · 失败 ' + String(failed.length) +
    ' → ' + (failed.length === 0 ? '**全部通过**' : '**有失败项**') + String.fromCharCode(10),
)
if (asJson) {
  process.stdout.write(
    'ACCEPT_JSON ' +
      JSON.stringify({
        ok: failed.length === 0,
        passed: passed.length,
        failed: failed.length,
        skipped: 0,
        steps: results.map((r) => ({ name: r.name, status: r.status, code: r.code, summary: r.summary })),
      }) +
      String.fromCharCode(10),
  )
}
process.exit(failed.length === 0 ? 0 : 1)
