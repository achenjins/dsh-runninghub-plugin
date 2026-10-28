import test from 'node:test'
import assert from 'node:assert/strict'
import { loadClientModule, createStubCtx, createUrlStub, hosts, byAttr, click, textOf, flushAsync } from './harness.mjs'
import { validateRun } from '../../host/core/workflow.mjs'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const button = (tree, attr, value) => hosts(tree, node => node.props[attr] !== undefined && (value === undefined || node.props[attr] === value))[0]
const workflow = (id, name = '同名工作流') => ({ id, name, rhWorkflowId: id, region: 'cn', outputKind: 'image', nodes: [], promptOptimizer: {} })
const dispose = ctx => { for (const effect of ctx._effects.slice().reverse()) if (typeof effect.dispose === 'function') effect.dispose() }

test('同名工作流删除必须二次确认，并提交被点击记录的稳定 ID', () => {
  const { exports, react } = loadClientModule()
  const deleted = []
  react.render(react.createElement(exports.components.WorkflowSection, {
    workflows: [workflow('111'), workflow('222')], docs: [], onSave() {}, onDelete: id => deleted.push(id),
  }))
  click(button(react.tree, 'data-rh-wf-row', '222')); react.rerender()
  click(button(react.tree, 'data-rh-wf-delete')); react.rerender()
  assert.deepEqual(deleted, [])
  assert.equal(textOf(button(react.tree, 'data-rh-wf-delete')), '确认删除该工作流')
  click(button(react.tree, 'data-rh-wf-delete'))
  assert.deepEqual(deleted, ['222'])
  react.unmount()
})

test('重新读取相同工作流 ID 时，检查节点之外还必须显式确认覆盖', async () => {
  const { exports, react } = loadClientModule()
  const saved = []
  const config = workflow('111', '重新命名')
  react.render(react.createElement(exports.components.WorkflowSection, {
    workflows: [workflow('111', '已有精细配置')], docs: [],
    onProbe: async () => ({ ok: true, config, rhWorkflowId: '111', proposal: { hints: { warnings: [] } } }),
    onSave: async value => { saved.push(value); return { ok: true } },
  }))
  button(react.tree, 'data-rh-probe-input').props.onChange({ target: { value: '111' } }); react.rerender()
  await button(react.tree, 'data-rh-probe-run').props.onClick(); react.rerender()
  button(react.tree, 'data-rh-wf-confirm').props.onChange({ target: { checked: true } }); react.rerender()
  assert.equal(button(react.tree, 'data-rh-wf-save').props.disabled, true)
  assert.match(textOf(react.tree), /已有精细配置/)
  button(react.tree, 'data-rh-probe-overwrite').props.onChange({ target: { checked: true } }); react.rerender()
  await button(react.tree, 'data-rh-wf-save').props.onClick()
  assert.equal(saved[0].id, '111')
  assert.equal(saved[0].overwrite, true)
  react.unmount()
})

test('工作流重命名和克隆按钮使用源记录稳定 ID，并保留未保存草稿', async () => {
  const { exports, react } = loadClientModule()
  let savedWorkflow = { ...workflow('local-source', '原工作流'), rhWorkflowId: '111' }
  const calls = []
  const api = {
    status: async () => ({ keys: [] }), listWorkflows: async () => [savedWorkflow],
    docs: { list: async () => [] }, tasks: { list: async () => [] },
    renameWorkflow: async (id, name) => { calls.push(['rename', id, name]); savedWorkflow = { ...savedWorkflow, name }; return { ok: true, id, name } },
    cloneWorkflow: async (id, name) => { calls.push(['clone', id, name]); return { ok: true, id: 'local-copy', name } },
  }
  react.render(react.createElement(exports.components.RunningHubPanel, { api }))
  await flushAsync(); react.rerender()
  click(button(react.tree, 'data-rh-wf-row', 'local-source')); react.rerender()
  const description = hosts(react.tree, node => node.type === 'label' && textOf(node).startsWith('描述（给模型看）'))[0]
  hosts(description, node => node.type === 'input')[0].props.onChange({ target: { value: '尚未保存的描述' } }); react.rerender()
  button(react.tree, 'data-rh-wf-management-name').props.onChange({ target: { value: '重命名结果' } }); react.rerender()
  await button(react.tree, 'data-rh-wf-rename').props.onClick(); react.rerender()
  assert.deepEqual(calls, [['rename', 'local-source', '重命名结果']])
  assert.equal(button(react.tree, 'data-rh-wf-name').props.value, '重命名结果')
  const afterRename = hosts(react.tree, node => node.type === 'label' && textOf(node).startsWith('描述（给模型看）'))[0]
  assert.equal(hosts(afterRename, node => node.type === 'input')[0].props.value, '尚未保存的描述')
  button(react.tree, 'data-rh-wf-management-name').props.onChange({ target: { value: '克隆结果' } }); react.rerender()
  await button(react.tree, 'data-rh-wf-clone').props.onClick(); react.rerender()
  assert.deepEqual(calls[1], ['clone', 'local-source', '克隆结果'])
  assert.equal(button(react.tree, 'data-rh-wf-name').props.value, '重命名结果')
  assert.equal(button(react.tree, 'data-rh-wf-management-name').props.value, '')
  react.unmount()
})

test('Key 标签和优先级输入保留本地草稿，失焦或回车才各提交一次', () => {
  const { exports, react } = loadClientModule()
  const patches = []
  const key = { id: 'k1', label: '旧标签', priority: 100, region: 'cn' }
  const render = () => react.render(react.createElement(exports.components.KeySection, { keys: [key], balances: {}, onPatch: (...args) => patches.push(args) }))
  render()
  for (const value of ['新', '新标', '新标签']) {
    button(react.tree, 'data-rh-key-field', 'label').props.onChange({ target: { value } }); react.rerender()
  }
  render()
  assert.equal(button(react.tree, 'data-rh-key-field', 'label').props.value, '新标签')
  assert.deepEqual(patches, [])
  button(react.tree, 'data-rh-key-field', 'label').props.onBlur()
  assert.deepEqual(patches, [['k1', { label: '新标签' }]])
  for (const value of ['2', '20']) {
    button(react.tree, 'data-rh-key-field', 'priority').props.onChange({ target: { value } }); react.rerender()
  }
  button(react.tree, 'data-rh-key-field', 'priority').props.onKeyDown({ key: 'Enter', preventDefault() {} })
  button(react.tree, 'data-rh-key-field', 'priority').props.onBlur()
  assert.deepEqual(patches[1], ['k1', { priority: 20 }])
  assert.equal(patches.length, 2)
  react.unmount()
})

test('Key 优先级保存被拒绝后恢复真实值，并保留页面错误提示', async () => {
  const { exports, react } = loadClientModule()
  const api = {
    status: async () => ({ keys: [{ id: 'k1', priority: 100, region: 'cn' }] }),
    listWorkflows: async () => [], docs: { list: async () => [] }, tasks: { list: async () => [] },
    keys: { update: async () => { throw Object.assign(new Error('优先级必须是非负安全整数'), { code: 'BAD_REQUEST' }) } },
  }
  react.render(react.createElement(exports.components.RunningHubPanel, { api }))
  await flushAsync(); react.rerender()
  click(button(react.tree, 'data-rh-section', 'keys')); react.rerender()
  button(react.tree, 'data-rh-key-field', 'priority').props.onChange({ target: { value: '1.5' } }); react.rerender()
  await button(react.tree, 'data-rh-key-field', 'priority').props.onBlur(); react.rerender()
  assert.equal(button(react.tree, 'data-rh-key-field', 'priority').props.value, '100')
  assert.match(textOf(react.tree), /优先级必须是非负安全整数/)
  react.unmount()
})

test('迟到的 Key 保存失败不能覆盖等待期间的新输入', async () => {
  const rejected = deferred()
  const { exports, react } = loadClientModule()
  react.render(react.createElement(exports.components.KeySection, {
    keys: [{ id: 'k1', priority: 100, region: 'cn' }], balances: {}, onPatch: () => rejected.promise,
  }))
  button(react.tree, 'data-rh-key-field', 'priority').props.onChange({ target: { value: '1.5' } }); react.rerender()
  const committing = button(react.tree, 'data-rh-key-field', 'priority').props.onBlur()
  button(react.tree, 'data-rh-key-field', 'priority').props.onChange({ target: { value: '200' } }); react.rerender()
  rejected.resolve({ ok: false, error: { code: 'BAD_REQUEST' } })
  await committing; react.rerender()
  assert.equal(button(react.tree, 'data-rh-key-field', 'priority').props.value, '200')
  react.unmount()
})

test('并发面板操作中先完成一个不会提前解除其它操作的 busy 状态', async () => {
  const { exports, react } = loadClientModule()
  const detecting = deferred(), balancing = deferred()
  const api = {
    status: async () => ({ keys: [{ id: 'k1', label: '', priority: 100, region: 'cn' }] }),
    listWorkflows: async () => [workflow('111')], docs: { list: async () => [] }, tasks: { list: async () => [] },
    keys: { detect: () => detecting.promise, balance: () => balancing.promise },
  }
  react.render(react.createElement(exports.components.RunningHubPanel, { api }))
  await flushAsync(); react.rerender()
  click(button(react.tree, 'data-rh-section', 'keys')); react.rerender()
  click(button(react.tree, 'data-rh-wf-row', '111')); react.rerender()
  click(button(react.tree, 'data-rh-key-detect', 'k1'))
  click(button(react.tree, 'data-rh-key-balance', 'k1'))
  react.rerender()
  detecting.resolve({ ok: true }); await flushAsync(); react.rerender()
  assert.equal(button(react.tree, 'data-rh-wf-save').props.disabled, true)
  balancing.resolve({ ok: true }); await flushAsync(); react.rerender()
  assert.equal(button(react.tree, 'data-rh-wf-save').props.disabled, false)
  react.unmount()
})

test('通过真实父级异步保存文档后 selected 使用宿主返回 ID，冲突必须再次确认', async () => {
  const { exports, react } = loadClientModule()
  const writes = []
  const api = {
    status: async () => ({ keys: [] }), listWorkflows: async () => [], tasks: { list: async () => [] },
    docs: { list: async () => [], save: async doc => {
      writes.push(doc)
      if (doc.name.endsWith('-副本') && !doc.overwrite) { const error = new Error('该文档已存在'); error.code = 'DOC_EXISTS'; throw error }
      return { ok: true, docId: doc.name.endsWith('-副本') ? 'copy-id' : 'new-id' }
    } },
  }
  react.render(react.createElement(exports.components.RunningHubPanel, { api }))
  await flushAsync(); react.rerender()
  click(button(react.tree, 'data-rh-section', 'docs')); react.rerender()
  button(react.tree, 'data-rh-doc-name').props.onChange({ target: { value: '指南' } })
  button(react.tree, 'data-rh-doc-content').props.onChange({ target: { value: '正文' } }); react.rerender()
  await button(react.tree, 'data-rh-doc-save').props.onClick(); react.rerender()
  assert.match(textOf(react.tree), /编辑：new-id/)
  click(hosts(react.tree, node => node.type === 'button' && textOf(node) === '另存为')[0])
  await flushAsync(); react.rerender()
  assert.equal(writes[1].overwrite, false)
  assert.match(textOf(react.tree), /确认覆盖已有文档/)
  await button(react.tree, 'data-rh-doc-overwrite').props.onClick(); react.rerender()
  assert.equal(writes[2].overwrite, true)
  assert.match(textOf(react.tree), /编辑：copy-id/)
  react.unmount()
})

test('同一客户端模块停用后重新 apply 使用新 Remote 命名空间', async () => {
  const { exports } = loadClientModule()
  const first = createStubCtx({ remoteNamespace: { status: async () => ({ generation: 1 }) } })
  await exports.apply(first)
  assert.equal((await exports.createApi(first).status()).generation, 1)
  dispose(first)
  const second = createStubCtx({ remoteNamespace: { status: async () => ({ generation: 2 }) } })
  await exports.apply(second)
  assert.equal((await exports.createApi(second).status()).generation, 2)
  assert.equal(second._mounted.length, 1)
  dispose(second)
})

test('多个活跃 ctx 共享的 Remote 不因单个 ctx 卸载而失效', async () => {
  const { exports } = loadClientModule()
  const service = { status: async () => ({ generation: 'shared' }) }
  const first = createStubCtx({ remoteNamespace: service })
  const second = createStubCtx({ remoteNamespace: service })
  await exports.apply(first)
  await exports.createApi(first).status()
  await exports.apply(second)
  assert.equal((await exports.createApi(second).status()).generation, 'shared')
  dispose(first)
  assert.equal((await exports.createApi(second).status()).generation, 'shared')
  assert.equal(second._mounted.length, 0)
  dispose(second)
})

test('图片请求在卸载后完成时不再分配 objectURL', async () => {
  const blob = deferred(), url = createUrlStub()
  const { exports, react } = loadClientModule({ URL: url, fetch: async () => ({ ok: true, blob: () => blob.promise }) })
  react.render(react.createElement(exports.components.ToolImages, { refs: [{ attachmentId: 'a' }] }))
  await flushAsync()
  react.unmount()
  blob.resolve({ size: 4, type: 'image/png' }); await flushAsync()
  assert.equal(url._created.length, 0)
  assert.equal(url._revoked.length, 0)
})

test('宿主传入新 loader 函数不会撤销仍在显示的图片 URL', async () => {
  const url = createUrlStub()
  let fetches = 0
  const { exports, react } = loadClientModule({ URL: url, fetch: async () => { fetches++; return { ok: true, blob: async () => ({ size: 4 }) } } })
  const render = () => react.render(react.createElement(exports.components.ToolImages, { refs: [{ attachmentId: 'a' }], loadImage: async () => 'blob:fallback' }))
  render(); await flushAsync(); react.rerender()
  render(); await flushAsync(); react.rerender()
  assert.equal(fetches, 1)
  assert.equal(url._revoked.length, 0)
  assert.equal(hosts(react.tree, node => node.type === 'img')[0].props.src, 'blob:runninghub-1')
  react.unmount()
  assert.equal(url._revoked.length, 1)
})

test('状态栏渲染宿主 bridge 对象的类型及 namespace/path', () => {
  const { exports, react } = loadClientModule()
  const tree = react.render(react.createElement(exports.components.StatusBar, { status: { bridge: { kind: 'remote', namespace: 'runninghub' } }, transportKind: 'remote' }))
  assert.match(textOf(tree), /remote · runninghub/)
  assert.doesNotMatch(textOf(tree), /\[object Object\]/)
  react.unmount()
})

test('用户修改推断节点的步长后保存为 user 约束，并实际执行校验', async () => {
  const { exports, react } = loadClientModule()
  let saved
  const config = { ...workflow('111'), nodes: [
    { nodeId: '3', fieldName: 'denoise', role: 'number', valueType: 'number', min: 0, max: 1, step: 0.01, boundsSource: 'structural' },
    { nodeId: '4', fieldName: 'width', role: 'number', valueType: 'number', min: 64, max: 2048, step: 8, boundsSource: 'heuristic' },
  ] }
  react.render(react.createElement(exports.components.WorkflowSection, {
    workflows: [config], docs: [], onSave: async value => { saved = value; return { ok: true } },
  }))
  click(button(react.tree, 'data-rh-wf-row', '111')); react.rerender()
  for (const [id, step] of [['3', '0.25'], ['4', '16']]) {
    click(button(react.tree, 'data-rh-node-edit', id)); react.rerender()
    const editor = button(react.tree, 'data-rh-node-editor', id)
    const label = hosts(editor, node => node.type === 'label' && textOf(node) === 'step')[0]
    hosts(label, node => node.type === 'input')[0].props.onChange({ target: { value: step } }); react.rerender()
  }
  await button(react.tree, 'data-rh-wf-save').props.onClick()
  assert.deepEqual(saved.nodes.map(node => [node.step, node.boundsSource]), [[0.25, 'user'], [16, 'user']])
  assert.equal(validateRun(saved, { params: { '3:denoise': 0.5, '4:width': 528 } }).ok, true)
  for (const params of [{ '3:denoise': 0.625 }, { '4:width': 520 }]) {
    const result = validateRun(saved, { params })
    assert.equal(result.ok, false)
    assert.equal(result.issues[0].code, 'VALUE_STEP_MISMATCH')
  }
  react.unmount()
})
