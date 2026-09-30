/**
 * 版本号一致性护栏。
 *
 * 为什么值得一条测试：这个版本号曾经散在**四处**（`package.json` / `host/shared.mjs`
 * 的 `PLUGIN_VERSION` / `host/core/index.mjs` 的 `CORE_VERSION` / `host/core/api.mjs`
 * 的 `USER_AGENT`），而且 `host/tools/call.mjs` 的 self-check 还**另写了一份硬编码**。
 * 升版本时漏改任何一处，表现是「诊断里报 0.1.0、包却是 0.1.1」——
 * 排查线上问题时按版本判断"跑的是哪一代"，被误导一次就要多花半小时。
 *
 * 这条测试把这些来源钉在一起：**改一处忘另一处就红**。
 *
 * @module dsh-runninghub-plugin/tests/version
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { PLUGIN_VERSION } from '../host/shared.mjs'
import { CORE_VERSION } from '../host/core/index.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

test('★ 版本号四处必须一致：package.json / PLUGIN_VERSION / CORE_VERSION / USER_AGENT', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json 的 version 应是 x.y.z')
  assert.equal(PLUGIN_VERSION, pkg.version, 'host/shared.mjs 的 PLUGIN_VERSION 与 package.json 不一致')
  assert.equal(CORE_VERSION, pkg.version, 'host/core/index.mjs 的 CORE_VERSION 与 package.json 不一致')

  // UA 里带版本号，只能从源码文本里读（它是模块内的 const）
  const apiSrc = fs.readFileSync(path.join(ROOT, 'host', 'core', 'api.mjs'), 'utf8')
  const ua = apiSrc.match(/const USER_AGENT = '([^']+)'/)
  assert.ok(ua, '没找到 USER_AGENT')
  assert.equal(ua[1], 'dsh-runninghub-plugin/' + pkg.version, 'host/core/api.mjs 的 USER_AGENT 与 package.json 不一致')
})

test('★ self-check 不许硬编码版本号（必须走运行时那份）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'host', 'tools', 'call.mjs'), 'utf8')
  // 找 diagnostics 的 data 里那一行
  const m = src.match(/const data = \{[\s\S]{0,200}?version:\s*([^,\n]+),/)
  assert.ok(m, '没找到 diagnostics 的 version 字段')
  assert.ok(
    !/['"]\d+\.\d+\.\d+['"]/.test(m[1]),
    'diagnostics 里的版本号又被写死了：' + m[1] + '（应使用 rt.version || PLUGIN_VERSION）',
  )
})
