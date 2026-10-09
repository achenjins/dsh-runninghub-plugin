/** runninghub_search 只发现动作，不读取业务数据。 */
import { defineRHTool, renderStructured, ANY_SCHEMA } from '../shared.mjs'

/** 动作名、参数与简介；具体数据由 runninghub_call 按需返回。 */
export const CALL_ACTIONS = [
  ['workflow.get', '{ name?, query? }', '搜索工作流；不传名称只返回简介，传名称返回该工作流的完整节点配置'],
  ['workflow.probe', '{ workflowId, region? }', '读取远程工作流，返回一份待确认的 config 配置提案'],
  ['workflow.configure', '{ name, workflowId, nodes?, config? }', '保存工作流配置'],
  ['workflow.update', '{ name, patch }', '更新工作流配置'],
  ['workflow.delete', '{ name, confirm:true }', '删除本地工作流配置'],
  ['workflow.validate', '{ name, prompt?, negativePrompt?, params?, images?, region? }', '按运行规则预检输入参数与可用 Key，不提交任务'],
  ['workflow.price', '{ name, modelPath? }', '查询标准模型 API 的预计费用'],
  ['workflow.run', '{ name, prompt?, negativePrompt?, params?, images?, saveDir?, fileName?, repeat?, background?, waitMs? }', '提交生成任务，返回任务 ID'],
  ['task.list', '{ limit? }', '查询最近24小时的生成记录，只返回本地ID和在线结果链接'],
  ['task.limit', '{ limit? }', '查看或设置任务记录保留条数，0 表示不限'],
  ['task.status', '{ taskId, details? }', '查询最新状态摘要；details:true 返回任务详情'],
  ['task.wait', '{ taskId, timeoutMs? }', '等待任务并取回结果附件'],
  ['task.retry', '{ taskId, resend? }', '补下载或补附件；resend:true 从本地补发全部附件'],
  ['task.cancel', '{ taskId }', '取消任务（本地排队中的任务只撤销排队，不会扣费）'],
  ['task.adopt', '{ taskId, remoteTaskId }', '待核对任务：用户在 RunningHub 后台找到远端任务后，把它接回继续轮询并取结果'],
  ['task.dismiss', '{ taskId, reason? }', '待核对任务：用户确认 RunningHub 上没有创建时手动结案'],
  ['account.balance', '{ region? }', '查询余额与账号状态'],
  ['account.queue', '{ region? }', '查询并发与排队情况'],
  ['account.keys', '{}', '查看 Key 池的掩码信息'],
  ['key.detect', '{ id }', '重新验证 Key 所属地域，成功后恢复可用状态'],
  ['key.balance', '{ id }', '查询指定 Key 的余额'],
  ['prompt.doc_read', '{ name | docId }', '读取提示词优化文档'],
  ['prompt.doc_write', '{ name, content, filename? }', '保存提示词优化文档'],
  ['prompt.optimize', '{ name, userRequest }', '按工作流配置优化提示词'],
  ['diagnostics', '{}', '查看插件诊断信息'],
]

export function renderActionList() {
  return ['用 runninghub_call({action:"动作名", ...参数}) 调用：', ...CALL_ACTIONS.map(([name, params, description]) => name + ' ' + params + ' — ' + description)].join('\n')
}

export function makeSearchTool() {
  return defineRHTool({
    name: 'runninghub_search',
    description: '无参数。获取 runninghub_call 各动作的使用方式。工作流、生成记录和其它业务数据请用 call 调用对应动作查询。',
    parameters: {},
    output: { schema: ANY_SCHEMA, render: renderStructured },
    isConcurrencySafe: () => true,
    execute() {
      return { ok: true, text: renderActionList() }
    },
  })
}
