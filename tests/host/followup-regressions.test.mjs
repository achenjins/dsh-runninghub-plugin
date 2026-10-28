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
import { cloneConfiguredWorkflow, mergeWorkflowNodes } from '../../host/workflow-match.mjs'
import { TaskRunner } from '../../host/core/runner.mjs'

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

test('必填提示词不能静默使用模板；显式参数和确认模板可运行，素材仍可选', async t => {
  const { rt, store, tool, config } = await fixture(t)
  const nodes = [
    { nodeId: '494', fieldName: 'prompt', role: 'prompt', required: true, valueType: 'string', default: 'template-prompt' },
    { nodeId: '420', fieldName: 'image', role: 'image', required: false, valueType: 'string', default: '' },
    { nodeId: '495', fieldName: 'text', role: 'prompt', required: true, valueType: 'string', default: 'secondary-template-fragment' },
  ]
  await store.saveWorkflow({ ...config, nodes })
  let submissions = 0
  rt.runner = { submit: async () => { submissions++; return { ok: true, taskId: 't', status: 'RUNNING' } } }
  for (const values of [{}, { prompt: null }, { prompt: '   ' }, { params: { '494:prompt': '  ' } }]) {
    for (const action of ['workflow.validate', 'workflow.run']) {
      const result = await tool.execute({ action, args: { name: 'wf', ...values } }, {})
      assert.equal(result.error.code, 'VALIDATION_FAILED')
      assert.match(result.text, /useDefaults:true/)
    }
  }
  assert.equal(submissions, 0, '缺少提示词时没有上传或付费提交')
  for (const values of [{ prompt: 'new-prompt' }, { params: { '494:prompt': 'explicit' } }, { useDefaults: true }]) {
    assert.equal((await tool.execute({ action: 'workflow.run', args: { name: 'wf', ...values } }, {})).ok, true)
  }
  assert.equal(submissions, 3)
  assert.equal(workflow.validateRun({ nodes }, { prompt: 'primary-input' }).ok, true, '辅助提示词片段仍可沿用配置默认值')
  assert.equal(workflow.validateRun({ nodes: [{ ...nodes[0], default: '   ' }] }, { useDefaults: true }).ok, false)
})

test('预检默认仅展示变化和可见警告，完整字段显式读取，长提示词不复制全文', async t => {
  const { store, tool, config } = await fixture(t)
  await store.saveWorkflow({ ...config, nodes: [
    { nodeId: '1', fieldName: 'prompt', role: 'prompt', required: true, valueType: 'string', default: 'template-marker' },
    { nodeId: '2', fieldName: 'duration', role: 'number', valueType: 'number', min: 1, max: 15, boundsSource: 'heuristic', default: 5 },
    { nodeId: '3', fieldName: 'mode', role: 'select', valueType: 'string', default: 'unchanged-marker' },
  ] })
  const args = { name: 'wf', prompt: 'long-prompt-'.repeat(100), params: { '2:duration': 99 } }
  const result = await tool.execute({ action: 'workflow.validate', args }, {})
  const rendered = tool.output.render({}, result).map(block => block.text || '').join('\n')
  assert.equal(result.ok, true)
  assert.match(rendered, /无阻塞问题.*警告/)
  assert.match(rendered, /99.*大于上限 15/)
  assert.match(rendered, /\| 节点:字段/)
  assert.doesNotMatch(rendered, /unchanged-marker|"nodeInfoList"|"overrides"/)
  assert.equal(result.data.overrides.length, 2)
  assert.equal(rendered.includes(args.prompt), false)
  const full = await tool.execute({ action: 'workflow.validate', args: { ...args, details: true } }, {})
  assert.equal(full.data.nodeInfoList.length, 3)
  assert.match(full.text, /unchanged-marker/)
  assert.equal(full.text.split(args.prompt).length - 1, 1)
})

test('清理明细后重启仍可查费用和文件历史，不保留提示词/节点/附件，不重复 URL', async t => {
  const { rt, store, tool } = await fixture(t)
  const now = Date.now()
  const url = 'https://results.invalid/old.png'
  await store.saveTask({ taskId: 'old', status: 'SUCCESS', createdAt: now - 26 * 3600000, finishedAt: now - 25 * 3600000,
    consumeCoins: 15, promptPreview: 'private-prompt', key: 'private-key', nodeInfoList: [{ private: true }],
    outputs: [url], results: [{ url, localPath: 'C:\\out\\old.png', attachment: { private: true } }] })
  await store.saveTask({ taskId: 'new', status: 'SUCCESS', createdAt: now, finishedAt: now, results: [{ localPath: 'C:\\out\\new.png' }] })
  assert.equal((await store.taskLimit(1)).ok, true)
  assert.equal(await store.getTask('old'), undefined)
  const restarted = new Store({ dataDir: store.dataDir })
  rt.store = restarted
  rt.runner = new TaskRunner({ store: restarted })
  const status = await tool.execute({ action: 'task.status', args: { taskId: 'old' } }, {})
  assert.equal(status.data.task.archived, true)
  assert.equal(status.data.task.consumeCoins, 15)
  assert.equal(status.data.task.results[0].localPath, 'C:\\out\\old.png')
  assert.doesNotMatch(JSON.stringify(status), /private-prompt|private-key|nodeInfoList|attachment/)
  assert.equal(JSON.stringify(status).split(url).length - 1, 1)
  assert.equal((await tool.execute({ action: 'task.list' }, {})).data.tasks.length, 1)
  const history = await tool.execute({ action: 'task.list', args: { sinceHours: 0 } }, {})
  assert.equal(history.data.tasks.length, 2)
  assert.equal((await tool.execute({ action: 'task.wait', args: { taskId: 'old' } }, {})).error.code, 'TASK_DETAIL_PRUNED')
  assert.equal((await tool.execute({ action: 'task.retry', args: { taskId: 'old' } }, {})).error.code, 'TASK_DETAIL_PRUNED')
  const text = tool.output.render({}, history).map(block => block.text || '').join('\n')
  assert.equal(text.split('C:\\out\\old.png').length - 1, 1)
  assert.doesNotMatch(text, /https:\/\/results/, '已提供本地路径时不再复制远端链接')
  assert.match(text, /15 币/)
})

test('历史回执保存失败不会删除唯一明细，修复后可重试清理', async t => {
  const { store } = await fixture(t)
  await store.saveTask({ taskId: 'old', status: 'SUCCESS', createdAt: 1 })
  await store.saveTask({ taskId: 'new', status: 'SUCCESS', createdAt: 2 })
  const write = store.writeJson.bind(store)
  store.writeJson = async (rel, ...args) => rel.startsWith('task-history') ? { ok: false, error: { message: 'disk full' } } : write(rel, ...args)
  assert.equal((await store.taskLimit(1)).ok, false)
  assert.ok(await store.getTask('old'))
  store.writeJson = write
  assert.equal((await store.pruneTasks()).ok, true)
  assert.equal(await store.getTask('old'), undefined)
  assert.equal((await store.getTaskHistory('old')).taskId, 'old')
})

test('探测差异与保守合并按完整节点字段匹配，保留人工选择与约束且可只预览', async t => {
  const { rt, store, tool, config } = await fixture(t)
  const node = { nodeId: '434', fieldName: 'image', role: 'image', valueType: 'string', label: '参考图4', default: '', required: false }
  const option = { nodeId: 'a:b', fieldName: 'mode', role: 'select', valueType: 'enum', label: '人工画幅', options: ['wide', 'tall'], optionsSource: 'user', default: 'wide' }
  await store.saveWorkflow({ ...config, nodes: [node, option] })
  rt.api = { getWorkflowJson: async () => ({ ok: true, workflowId: '123', workflow: {
    '434': { class_type: 'LoadImage', inputs: { image: '' } },
    '9': { class_type: 'ImageBatch', inputs: { image_6: ['434', 0] } },
    '10': { class_type: 'SaveImage', inputs: { images: ['9', 0] } },
  } }) }
  const probe = await tool.execute({ action: 'workflow.probe', args: { workflowId: '123' } }, {})
  assert.equal(probe.data.comparisons[0].id, 'wf')
  const fresh = probe.data.config.nodes.find(item => item.nodeId === '434')
  assert.equal(fresh.targets[0].fieldName, 'image_6')
  assert.equal(probe.data.mediaNodes, undefined, '默认不重复素材节点的 targets')
  const patch = { nodes: [fresh, { ...option, label: 'auto-label', valueType: 'string', options: [] }, { ...option, nodeId: 'extra' }] }
  const args = { name: 'wf', patch, mergeNodes: true, dryRun: true }
  const preview = await tool.execute({ action: 'workflow.update', args }, {})
  assert.equal(preview.ok, true)
  assert.deepEqual(preview.data.diff.added, [])
  assert.deepEqual((await store.getWorkflow('wf')).nodes, [node, option])
  assert.equal((await tool.execute({ action: 'workflow.update', args: { ...args, dryRun: false } }, {})).ok, true)
  const saved = await store.getWorkflow('wf')
  assert.equal(saved.nodes.length, 2)
  assert.equal(saved.nodes[0].label, '参考图4')
  assert.equal(saved.nodes[0].targets[0].fieldName, 'image_6')
  assert.deepEqual(saved.nodes[1], option)
  const validation = await tool.execute({ action: 'workflow.validate', args: { name: 'wf', images: { '434': 'openapi/input.png' } } }, {})
  assert.match(validation.text, /434:image → 9:image_6/)
  const configure = await tool.execute({ action: 'workflow.configure', args: { config: { ...saved, nodes: [] }, dryRun: true } }, {})
  assert.equal(configure.data.diff.removed.length, 2)
  assert.equal((await store.getWorkflow('wf')).nodes.length, 2)
  const legacy = { ...option, min: 1, max: 15 }
  delete legacy.optionsSource
  const merged = mergeWorkflowNodes([legacy], [{ ...legacy, optionsSource: 'inferred-from-default', boundsSource: 'heuristic', default: 'tall' }])
  assert.deepEqual(merged, [legacy], '缺少来源标记的老手工约束不能被推断数据放宽')
})

test('自行优化可省去已读取的规范，首次调用和子代理仍获得正文', async t => {
  const { store, config, tool } = await fixture(t)
  await store.savePromptDoc({ id: 'guide', name: 'Guide', content: 'doc-body-marker' })
  await store.saveWorkflow({ ...config, promptOptimizer: { enabled: true, docId: 'guide', extraInstruction: 'extra-marker' } })
  const args = { name: 'wf', userRequest: 'cat' }
  const first = await tool.execute({ action: 'prompt.optimize', args }, {})
  assert.match(first.data.docText, /doc-body-marker/)
  const seen = await tool.execute({ action: 'prompt.optimize', args: { ...args, includeDoc: false } }, {})
  assert.equal(seen.data.docId, 'guide')
  assert.equal(seen.data.extraInstruction, 'extra-marker')
  assert.equal(seen.data.docText, undefined)
  assert.doesNotMatch(JSON.stringify(seen), /doc-body-marker/)
})
