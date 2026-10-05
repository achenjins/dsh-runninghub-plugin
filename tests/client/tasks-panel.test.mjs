import test from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as settle } from 'node:timers/promises'
import { createTestReact, loadClientModule, byAttr, hosts, textOf, click } from './harness.mjs'

test('任务结果区展示每项失败、附件与本地路径，终态不再取消', async t => {
  const react = createTestReact()
  const copied = []
  const actions = []
  const { exports } = loadClientModule({ react, windowExtras: { navigator: { clipboard: { writeText: async path => copied.push(path) } } } })
  t.after(() => react.unmount())
  const path = 'E:\\results\\image.png'
  react.render(react.createElement(exports.components.TaskSection, {
    api: { tasksLimit: async () => ({ limit: 10, count: 2 }) },
    tasks: [
      { taskId: 'done', status: 'SUCCESS', progress: '', hint: '已有结果，不必重新生成', results: [
        { filename: 'image.png', url: 'https://example.com/image.png', localPath: path, attachmentError: '附件保存失败' },
        { filename: 'video.mp4', error: '下载超时' },
      ] },
      { taskId: 'live', status: 'RUNNING', progress: 35 },
    ],
    onRefresh: id => actions.push(['refresh', id]),
    onRetry: id => actions.push(['retry', id]),
    onCancel: id => actions.push(['cancel', id]),
  }))
  assert.match(textOf(react.tree), /已有结果，不必重新生成.*已保存.*附件保存失败.*下载超时/)
  assert.deepEqual(hosts(react.tree, node => node.props['data-rh-task-cancel'] !== undefined).map(node => node.props['data-rh-task-cancel']), ['live'])
  assert.equal(hosts(react.tree, node => node.props.className === 'rh-progress').length, 1)
  assert.ok(hosts(react.tree, node => node.type === 'a').every(node => /^https:\/\//.test(node.props.href)))
  click(byAttr(react.tree, 'data-rh-task-copy-path'))
  click(byAttr(react.tree, 'data-rh-task-retry'))
  click(byAttr(react.tree, 'data-rh-task-refresh'))
  await settle()
  react.rerender()
  assert.deepEqual(copied, [path])
  assert.deepEqual(actions, [['retry', 'done'], ['refresh', 'done']])
  assert.match(textOf(react.tree), /路径已复制/)
})

test('筛选和加载更多保持查询，任务操作只刷新任务且旧响应不覆盖新筛选', async t => {
  const react = createTestReact()
  const { exports } = loadClientModule({ react })
  t.after(() => react.unmount())
  const calls = { status: 0, workflows: 0, docs: 0, tasks: [], retry: [] }
  let resolveOld
  const rows = limit => Array.from({ length: limit }, (_, i) => ({ taskId: `done-${i}`, status: 'SUCCESS', results: [{ error: '下载超时' }] }))
  const api = {
    status: async () => { calls.status++; return { keys: [] } },
    listWorkflows: async () => { calls.workflows++; return [] },
    docs: { list: async () => { calls.docs++; return [] } },
    tasksLimit: async () => ({ limit: 0, count: 50 }),
    tasks: {
      list: (limit, status) => {
        calls.tasks.push([limit, status])
        return status === 'RUNNING' ? new Promise(resolve => { resolveOld = resolve }) : Promise.resolve(rows(limit))
      },
      retry: async id => { calls.retry.push(id) },
    },
  }
  react.render(react.createElement(exports.components.RunningHubPanel, { api }))
  await settle()
  react.rerender()
  click(hosts(react.tree, node => node.props['data-rh-section'] === 'tasks')[0])
  await settle()
  react.rerender()
  byAttr(react.tree, 'data-rh-task-filter').props.onChange({ target: { value: 'RUNNING' } })
  react.rerender()
  byAttr(react.tree, 'data-rh-task-filter').props.onChange({ target: { value: 'SUCCESS' } })
  await settle()
  react.rerender()
  resolveOld([{ taskId: 'stale', status: 'RUNNING' }])
  await settle()
  react.rerender()
  assert.equal(hosts(react.tree, node => node.props['data-rh-task'] === 'stale').length, 0)
  click(byAttr(react.tree, 'data-rh-tasks-more'))
  await settle()
  react.rerender()
  click(byAttr(react.tree, 'data-rh-tasks-refresh'))
  await settle()
  react.rerender()
  click(byAttr(react.tree, 'data-rh-task-retry'))
  await settle()
  react.rerender()
  assert.deepEqual(calls.tasks, [[20, ''], [20, ''], [20, 'RUNNING'], [20, 'SUCCESS'], [40, 'SUCCESS'], [40, 'SUCCESS'], [40, 'SUCCESS']])
  assert.deepEqual(calls.retry, ['done-0'])
  assert.deepEqual([calls.status, calls.workflows, calls.docs], [1, 1, 1])
})

test('活动任务轮询在隐藏、终态和卸载时停止', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const react = createTestReact()
  const { exports, document, emitDocumentEvent } = loadClientModule({ react })
  t.after(() => react.unmount())
  let calls = 0
  const props = { api: { tasksLimit: async () => ({ limit: 10, count: 1 }) }, onReload: async () => { calls++ } }
  const render = status => react.render(react.createElement(exports.components.TaskSection, { ...props, tasks: [{ taskId: 't', status }] }))
  render('RUNNING')
  t.mock.timers.tick(2999)
  assert.equal(calls, 0)
  t.mock.timers.tick(1)
  await settle()
  assert.equal(calls, 1)
  document.hidden = true
  emitDocumentEvent('visibilitychange')
  t.mock.timers.tick(6000)
  assert.equal(calls, 1)
  document.hidden = false
  emitDocumentEvent('visibilitychange')
  t.mock.timers.tick(3000)
  await settle()
  assert.equal(calls, 2)
  render('SUCCESS')
  t.mock.timers.tick(3000)
  assert.equal(calls, 2)
  render('RUNNING')
  react.unmount()
  t.mock.timers.tick(9000)
  assert.equal(calls, 2)
})
