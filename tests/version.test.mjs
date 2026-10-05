/** 发布版本、实际请求 Header 和诊断回执必须一致。 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { PLUGIN_VERSION } from '../host/shared.mjs'
import { CORE_VERSION } from '../host/core/index.mjs'
import { RunningHubApi } from '../host/core/api.mjs'
import { makeCallTool } from '../host/tools/call.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

test('版本号一致：package.json / PLUGIN_VERSION / CORE_VERSION / 请求 User-Agent', async () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, 'package.json 的 version 应是 x.y.z')
  assert.equal(PLUGIN_VERSION, pkg.version, 'host/shared.mjs 的 PLUGIN_VERSION 与 package.json 不一致')
  assert.equal(CORE_VERSION, pkg.version, 'host/core/index.mjs 的 CORE_VERSION 与 package.json 不一致')

  let headers
  const api = new RunningHubApi({ fetchImpl: async (_url, options) => {
    headers = new Headers(options.headers)
    return new Response(JSON.stringify({ code: 0, data: {} }))
  } })
  assert.equal((await api.accountStatus('synthetic-version-key', 'cn')).ok, true)
  assert.equal(headers.get('User-Agent'), 'dsh-runninghub-plugin/' + pkg.version)
})

test('诊断使用运行时版本，缺省时使用插件版本', async () => {
  const rt = { requireCore: () => null, warnings: [], startedAt: Date.now(), warn() {} }
  const call = makeCallTool(() => rt)
  assert.equal((await call.execute({ action: 'diagnostics' }, {})).data.version, pkg.version)
  rt.version = 'runtime-version-fixture'
  assert.equal((await call.execute({ action: 'diagnostics' }, {})).data.version, rt.version)
})
