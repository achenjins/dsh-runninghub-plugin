import test from 'node:test'
import assert from 'node:assert/strict'
import { createTestReact, loadClientModule, hosts, byAttr, click, textOf, flushAsync } from './harness.mjs'

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function mountDocs(t) {
  const { exports, react } = loadClientModule()
  const reads = { a: deferred(), b: deferred() }
  react.render(react.createElement(exports.components.DocSection, {
    docs: [{ docId: 'a', name: 'A' }, { docId: 'b', name: 'B' }],
    onOpen: id => reads[id].promise,
    onSave() {}, onRemove() {},
  }))
  t.after(() => react.unmount())
  return {
    react, reads,
    open(id) {
      click(hosts(react.tree, node => node.props['data-rh-doc-open'] === id)[0])
      react.rerender()
    },
    content: () => byAttr(react.tree, 'data-rh-doc-content'),
    name: () => byAttr(react.tree, 'data-rh-doc-name'),
    clear() {
      click(hosts(react.tree, node => node.type === 'button' && textOf(node) === '清空')[0])
      react.rerender()
    },
    upload(file) {
      const pending = byAttr(react.tree, 'data-rh-doc-file').props.onChange({ target: { files: [file] } })
      react.rerender()
      return pending
    },
  }
}

test('文档读取乱序时，旧响应不能覆盖最近选择及其未保存修改', async t => {
  const view = mountDocs(t)
  view.open('a')
  view.open('b')
  view.reads.b.resolve({ name: 'B', content: 'B-body' })
  await flushAsync()
  view.react.rerender()
  view.content().props.onChange({ target: { value: 'B-unsaved-edit' } })
  view.react.rerender()
  view.reads.a.resolve({ name: 'A', content: 'A-body' })
  await flushAsync()
  view.react.rerender()
  assert.equal(view.name().props.value, 'B')
  assert.equal(view.content().props.value, 'B-unsaved-edit')
  assert.match(textOf(view.react.tree), /编辑：b/)
})

test('较早文档读取完成时，不会提前清除最新请求的读取状态', async t => {
  const view = mountDocs(t)
  view.open('a')
  view.open('b')
  view.reads.a.resolve({ name: 'A', content: 'A-body' })
  await flushAsync()
  view.react.rerender()
  assert.equal(view.content().props.value, '')
  assert.equal(textOf(hosts(view.react.tree, node => node.props['data-rh-doc-open'] === 'b')[0]), '读取中…')
  view.reads.b.resolve({ name: 'B', content: 'B-body' })
  await flushAsync()
  view.react.rerender()
  assert.equal(view.content().props.value, 'B-body')
  assert.equal(textOf(hosts(view.react.tree, node => node.props['data-rh-doc-open'] === 'b')[0]), '编辑')
})

test('清空后新建的草稿不被尚未结束的读取或文件导入覆盖', async t => {
  for (const source of ['document', 'file']) {
    await t.test(source, async t => {
      const view = mountDocs(t)
      const file = deferred()
      if (source === 'document') view.open('a')
      else view.upload({ name: 'import.md', text: () => file.promise })
      view.clear()
      view.name().props.onChange({ target: { value: 'New draft' } })
      view.content().props.onChange({ target: { value: 'New unsaved text' } })
      view.react.rerender()
      if (source === 'document') view.reads.a.resolve({ name: 'A', content: 'A-body' })
      else file.resolve('Imported body')
      await flushAsync()
      view.react.rerender()
      assert.equal(view.name().props.value, 'New draft')
      assert.equal(view.content().props.value, 'New unsaved text')
      assert.match(textOf(view.react.tree), /新建 \/ 上传文档/)
    })
  }
})

test('文件导入和远端文档读取交错时，只保留最新选择的内容', async t => {
  const view = mountDocs(t)
  view.open('a')
  await view.upload({ name: 'import.md', text: async () => 'Imported body' })
  view.react.rerender()
  view.reads.a.resolve({ name: 'A', content: 'A-body' })
  await flushAsync()
  view.react.rerender()
  assert.equal(view.name().props.value, 'import')
  assert.equal(view.content().props.value, 'Imported body')

  const file = deferred()
  const uploading = view.upload({ name: 'late.md', text: () => file.promise })
  view.open('b')
  view.reads.b.resolve({ name: 'B', content: 'B-body' })
  await flushAsync()
  view.react.rerender()
  file.resolve('Late imported body')
  await uploading
  view.react.rerender()
  assert.equal(view.name().props.value, 'B')
  assert.equal(view.content().props.value, 'B-body')
})

test('文档编辑器卸载后，迟到读取不再更新组件状态', async () => {
  const react = createTestReact()
  const read = deferred()
  const originalUseState = react.useState
  let unmounted = false
  let lateUpdates = 0
  let totalUpdates = 0
  react.useState = initial => {
    const [value, setValue] = originalUseState(initial)
    return [value, next => { totalUpdates++; if (unmounted) lateUpdates++; setValue(next) }]
  }
  const { exports } = loadClientModule({ react })
  react.render(react.createElement(exports.components.DocSection, {
    docs: [{ docId: 'a', name: 'A' }], onOpen: () => read.promise,
    onSave() {}, onRemove() {},
  }))
  click(byAttr(react.tree, 'data-rh-doc-open'))
  assert.ok(totalUpdates > 0, '状态观测必须在组件加载前安装并捕获读取中的更新')
  react.unmount()
  unmounted = true
  read.resolve({ name: 'A', content: 'Late content' })
  await flushAsync()
  assert.equal(lateUpdates, 0)
})

test('自检完成和快照刷新后，面板仍显示返回的诊断正文', async t => {
  const { exports, react } = loadClientModule()
  t.after(() => react.unmount())
  let snapshots = 0
  const api = {
    status: async () => { snapshots++; return { keys: [] } },
    listWorkflows: async () => [], docs: { list: async () => [] }, tasks: { list: async () => [] },
    diagnostics: async () => ({ ok: true, coreReady: false, loadError: 'diagnostics-evidence-123' }),
  }
  react.render(react.createElement(exports.components.RunningHubPanel, { api }))
  await flushAsync()
  react.rerender()
  click(hosts(react.tree, node => node.type === 'button' && textOf(node) === '自检')[0])
  await flushAsync()
  react.rerender()
  const notice = hosts(react.tree, node => node.props.className === 'rh-notice').map(textOf).join('')
  assert.match(notice, /自检：.*coreReady.*false.*loadError.*diagnostics-evidence-123/s)
  assert.equal(snapshots, 2, '诊断正文在操作后的快照刷新后仍保留')
})
