/**
 * 宿主 API 的解析与兜底。
 *
 * 两个方向都出过问题：`dsh-tools` 只能被 `import()` 载入时，同步 require 会误判成「宿主缺席」；
 * 而一旦走到内置 defineTool，它输出的 schema 又必须过得了宿主 `tools.register` 的校验，
 * 否则整个插件激活失败（`unsupported JSON schema`）。
 *
 * @module dsh-runninghub-plugin/tests/host/host-api-fallback
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { ANY_SCHEMA, HOST_DIR, localDefineTool } from '../../host/shared.mjs'

const run = promisify(execFile)

function fallbackTool(extra = {}) {
  return localDefineTool({
    name: 'demo_tool',
    description: 'demo',
    parameters: {
      action: { type: 'string', required: true },
      args: { type: 'json', description: 'free form' },
    },
    output: { schema: ANY_SCHEMA, render: () => [] },
    execute: async (args) => args,
    ...extra,
  })
}

test('内置 defineTool 把 { type: "json" } 编译成宿主接受的任意值节点', () => {
  const tool = fallbackTool()
  assert.deepEqual(tool.output.schema, {})
  assert.deepEqual(tool.parameters, {
    type: 'object',
    properties: { action: { type: 'string' }, args: { description: 'free form' } },
    required: ['action'],
  })
  assert.deepEqual(ANY_SCHEMA, { type: 'json' }, '共享常量不能被改写')
})

test('内置 defineTool 保留输出 schema 的注解和具体类型', () => {
  const annotated = fallbackTool({ output: { schema: { type: 'json', description: 'any' }, render: () => [] } })
  assert.deepEqual(annotated.output.schema, { description: 'any' })
  const concrete = { type: 'object', properties: {}, additionalProperties: true }
  assert.deepEqual(fallbackTool({ output: { schema: concrete, render: () => [] } }).output.schema, concrete)
})

test('dsh-tools 只能被 import() 载入时仍解析到宿主版本', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-host-api-'))
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), root)
    assert.ok(relative.startsWith('rh-host-api-') && !relative.includes(path.sep))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  await fs.cp(HOST_DIR, path.join(root, 'host'), { recursive: true })
  const tools = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-tools')
  await fs.mkdir(tools, { recursive: true })
  await fs.writeFile(path.join(tools, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module', exports: './index.mjs' }))
  // top-level await 让同步 require 抛 ERR_REQUIRE_ASYNC_MODULE，只有 import() 能载入。
  await fs.writeFile(path.join(tools, 'index.mjs'), 'await Promise.resolve()\nexport const defineTool = () => ({})\n')

  const entry = pathToFileURL(path.join(root, 'host', 'shared.mjs')).href
  const script = `const { HOST_API } = await import(${JSON.stringify(entry)}); process.stdout.write(JSON.stringify({ source: HOST_API.source, resolvedPath: HOST_API.resolvedPath }))`
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    env: { ...process.env, DSH_HOME: path.join(root, 'home'), APPDATA: '' },
  })
  const result = JSON.parse(stdout)
  assert.equal(result.source, 'host-package')
  assert.equal(path.basename(result.resolvedPath), 'index.mjs')
})
