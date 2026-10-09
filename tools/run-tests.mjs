/**
 * 跨平台、跨 Node 版本的测试入口：`node tools/run-tests.mjs [tests 下的子目录...]`
 *
 * 为什么不直接 `node --test "tests/**\/*.test.mjs"`：`--test` 的 glob 展开是 Node 21 才加的，
 * 而 `engines` 声明支持 Node ≥ 20；在 Node 20 上那个带引号的模式会被当成字面文件名，直接报错。
 * 这里自己列出文件（与 `tools/accept.mjs` 同一套规则），再交给 `node --test` 串行执行。
 *
 * 串行（`--test-concurrency=1`）是故意的：并行时各测试文件的本地 HTTP 服务与定时器互相争抢，
 * 定时器类断言会间歇假红。
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 递归列出 `*.test.mjs`（按路径排序，保证各平台顺序一致）。 */
export function testFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap((entry) => {
      const file = path.join(dir, entry.name)
      return entry.isDirectory() ? testFiles(file) : entry.name.endsWith('.test.mjs') ? [file] : []
    })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const subdirs = process.argv.slice(2)
  const roots = subdirs.length > 0 ? subdirs.map((d) => path.join(ROOT, 'tests', d)) : [path.join(ROOT, 'tests')]
  const files = roots.flatMap(testFiles)
  if (files.length === 0) {
    process.stderr.write('[run-tests] 没有找到测试文件：' + roots.join(', ') + '\n')
    process.exit(1)
  }
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: ROOT, stdio: 'inherit', windowsHide: true })
  child.on('exit', (code, signal) => process.exit(signal ? 1 : code ?? 1))
}
