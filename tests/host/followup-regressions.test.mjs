import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../../host/core/store.mjs'
import { KeyPool } from '../../host/core/keys.mjs'
import * as core from '../../host/core/index.mjs'
import * as workflow from '../../host/core/workflow.mjs'
import * as promptdoc from '../../host/core/promptdoc.mjs'
import { makeCallTool } from '../../host/tools/call.mjs'
import { makeSearchTool } from '../../host/tools/search.mjs'
import { renderStructured } from '../../host/shared.mjs'
import { buildMethods } from '../../host/rpc.mjs'
import { cloneConfiguredWorkflow } from '../../host/workflow-match.mjs'

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-followup-'))
  t.after(async () => {
    assert.equal(path.dirname(dir), os.tmpdir())
    assert.ok(path.basename(dir).startsWith('rh-followup-'))
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const store = new Store({ dataDir: dir })
  await store.init()
  const pool = new KeyPool()
  pool.add({ id: 'k', key: 'synthetic-followup-key', region: 'cn' })
  const config = { id: 'wf', name: 'Workflow', rhWorkflowId: '123', region: 'cn', nodes: [], description: 'summary-marker' }
  await store.saveWorkflow(config)
  const rt = { store, pool, core, workflow, promptdoc, config: {}, ctx: { get() {} }, requireCore: () => null, warn() {}, warnings: [] }
  return { rt, store, config, tool: makeCallTool(() => rt) }
}

const exec = signal => ({ signal, agent: { id: 'session' } })

test('工作流列表仅渲染一份摘要，具名配置仍可读取，空信封保持禁止 JSON 的语义', async t => {
  const { tool, store, config } = await fixture(t)
  await store.saveWorkflow({ ...config, nodes: [{ nodeId: '1', fieldName: 'text', role: 'prompt', valueType: 'string', default: 'node-marker' }] })
  const overview = await tool.execute({ action: 'workflow.get' }, {})
  const overviewText = tool.output.render({}, overview).map(block => block.text || '').join('\n')
  assert.equal(overview.envelope, undefined)
  assert.equal(overviewText.split('summary-marker').length - 1, 1)
  assert.doesNotMatch(overviewText, /node-marker|"workflows"/)
  const details = await tool.execute({ action: 'workflow.get', args: { name: 'wf' } }, {})
  assert.match(tool.output.render({}, details).map(block => block.text || '').join('\n'), /node-marker/)
  assert.deepEqual(renderStructured({}, { text: 'summary', data: { duplicate: true }, envelope: '' }), [{ type: 'text', text: 'summary' }])
})

test('显式后台提交立即交还会话，工具/索引/回执都说明继续对话与完成通知', async t => {
  const { rt, tool } = await fixture(t)
  let jobSpec, waits = 0
  rt.ctx.get = () => ({ start(spec) { jobSpec = spec; return 'background-job' } })
  rt.runner = {
    submit: async () => ({ ok: true, taskId: 'paid-once', status: 'RUNNING' }),
    wait: async () => { waits++; return { ok: true, task: { taskId: 'paid-once', status: 'SUCCESS' }, results: [{ kind: 'image', localPath: 'output.png' }] } },
  }
  const result = await tool.execute({ action: 'workflow.run', args: { name: 'wf', background: true, waitMs: 120000 } }, exec())
  assert.equal(waits, 0, '后台提交不内联等待')
  assert.equal(result.data.notifyOnCompletion, true)
  assert.equal(result.data.jobId, 'background-job')
  assert.match(result.text, /继续处理会话.*结束本轮回复等待通知/)
  assert.match(result.text, /不要立即 task.wait/)
  assert.match(tool.description, /background:true.*继续会话/)
  assert.match((await makeSearchTool().execute({})).text, /background.*继续会话或结束本轮回复/)
  assert.equal(tool.output.render({}, result).filter(block => block.type === 'text').length, 1)
  const completion = await jobSpec.run({ append() {}, updateProgress() {} }).done
  assert.equal(waits, 1)
  assert.equal(completion.status, 'completed')
  assert.match(completion.result, /output\.png/)
  assert.match(completion.result, /若尚未.*取回结果/)
})

test('提交中停止不会新增后台作业，包括最后一次提交后才收到 abort', async t => {
  const { rt, tool } = await fixture(t)
  for (const background of [false, true]) for (const repeat of [1, 2]) {
    let jobs = 0, submissions = 0
    const controller = new AbortController()
    rt.ctx.get = () => ({ start() { jobs++; return 'must-not-start' } })
    rt.runner = { submit: async () => { submissions++; controller.abort(); return { ok: true, taskId: 'paid', status: 'RUNNING' } } }
    const result = await tool.execute({ action: 'workflow.run', args: { name: 'wf', repeat, background } }, exec(controller.signal))
    assert.equal(result.error.code, 'ABORTED')
    assert.equal(submissions, 1)
    assert.equal(jobs, 0)
    assert.equal(result.data.jobId, null)
    assert.match(result.text, /远端已受理任务未取消/)
  }
})

test('部分提交失败只为显式后台模式创建通知；缺少会话 owner 不承诺通知', async t => {
  const { rt, tool } = await fixture(t)
  for (const background of [false, true]) {
    let submissions = 0, jobs = 0
    rt.ctx.get = () => ({ start() { jobs++; return 'job' } })
    rt.runner = { submit: async () => ++submissions === 1 ? { ok: true, taskId: 'paid', status: 'RUNNING' } : { ok: false, error: { code: 'BUSINESS', message: 'second submission rejected' } } }
    const result = await tool.execute({ action: 'workflow.run', args: { name: 'wf', repeat: 2, background } }, exec())
    assert.equal(result.error.code, 'BUSINESS')
    assert.equal(jobs, background ? 1 : 0)
    assert.equal(result.data.notifyOnCompletion, background)
    assert.equal(result.data.tasks[0].taskId, 'paid')
  }
  let jobs = 0
  rt.ctx.get = () => ({ start() { jobs++; return 'unowned' } })
  rt.runner = { submit: async () => ({ ok: true, taskId: 'paid', status: 'RUNNING' }) }
  const unowned = await tool.execute({ action: 'workflow.run', args: { name: 'wf', background: true } }, {})
  assert.equal(jobs, 0)
  assert.equal(unowned.data.notifyOnCompletion, false)
  assert.match(unowned.text, /请主动取回结果/)
})

test('克隆沿用统一 ID 校验，中文 ID 可保存也可克隆', async t => {
  const { store } = await fixture(t)
  const result = await cloneConfiguredWorkflow(store, 'wf', '中文副本', '中文副本')
  assert.equal(result.ok, true)
  assert.equal((await store.getWorkflow('中文副本')).name, '中文副本')
  assert.equal((await cloneConfiguredWorkflow(store, 'wf', 'Unsafe', '.wf')).error.code, 'BAD_REQUEST')
})

test('文档判重只由存储层执行，兜底名称不误报，冲突回执提供明确覆盖参数', async t => {
  const { rt, store, tool } = await fixture(t)
  const methods = buildMethods(rt)
  await store.savePromptDoc({ id: rt.core.slugify('!!!'), name: 'Existing', content: 'keep' })
  const punctuation = await methods.docsSave({ doc: { name: '!!!', content: 'new' } })
  assert.equal(punctuation.ok, true)
  assert.equal((await store.getPromptDoc(punctuation.docId)).content, 'new')
  await tool.execute({ action: 'prompt.doc_write', args: { name: 'Style Guide', content: 'original' } }, {})
  for (const conflict of [
    await methods.docsSave({ doc: { name: 'Style Guide', content: 'replacement' } }),
    await tool.execute({ action: 'prompt.doc_write', args: { name: 'Style Guide', content: 'replacement' } }, {}),
  ]) {
    assert.equal(conflict.error.code, 'DOC_EXISTS')
    assert.match(conflict.error.message, /overwrite:true/)
    assert.match(conflict.error.message, /docId:/)
  }
  assert.equal((await store.getPromptDoc('style-guide')).content, 'original')
  assert.equal((await methods.docsSave({ doc: { name: 'Style Guide', content: 'replacement', overwrite: true } })).ok, true)
  assert.equal((await store.getPromptDoc('style-guide')).content, 'replacement')
})
