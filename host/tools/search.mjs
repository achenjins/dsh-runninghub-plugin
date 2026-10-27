/** runninghub_search 只发现动作，不读取业务数据。 */
import { defineRHTool, renderStructured, ANY_SCHEMA } from '../shared.mjs'

/** 动作名、参数与简介；具体数据由 runninghub_call 按需返回。 */
export const CALL_ACTIONS = [
  ['workflow.get', '{ name?, query? }', '搜索工作流；不传名称只返回简介，传名称返回该工作流的完整节点配置'],
  ['workflow.probe', '{ workflowId, region?, includeInternal?, includeGraph? }', '读取远程工作流；默认隐藏内部节点，includeGraph:true 查看连线；返回推断警告与 fetchedAt/cacheId/cacheHit（每次重取，无缓存）'],
  ['workflow.configure', '{ name, workflowId, region?, nodes?, config?, overwrite? }', '保存工作流配置；已有id须明确 overwrite:true，同名不同id拒绝'],
  ['workflow.update', '{ name, patch }', '更新工作流配置；对象局部合并，nodes等数组整体替换，须提供完整记录'],
  ['workflow.rename', '{ name, newName }', '重命名本地配置，保留稳定id和全部节点；同名冲突拒绝'],
  ['workflow.clone', '{ name, newName, id? }', '克隆已保存配置，保留RH工作流和节点，创建新本地id；英文别名清空以免歧义'],
  ['workflow.delete', '{ name, confirm:true }', '删除本地工作流配置'],
  ['workflow.validate', '{ name, prompt?, negativePrompt?, params?, images?, region? }', '预检并列出提交字段及相对默认值的变化；远端表达式不能本地求值，不提交任务'],
  ['workflow.price', '{ name, modelPath? }', '查询标准模型 API 的预计费用'],
  ['workflow.run', '{ name, prompt?, negativePrompt?, params?, images?, region?, saveDir?, fileName?, repeat?, background?, waitMs? }', '提交任务；repeat 为1–20，默认1；waitMs 默认0（立即返回），最大1500000；background:true 忽略 waitMs；saveDir 为保存目录，fileName 为结果文件名'],
  ['task.list', '{ limit? }', '查询最近24小时的本地ID和在线结果链接；limit 默认20，最大200'],
  ['task.limit', '{ limit? }', '查看或设置任务记录保留条数，0 表示不限'],
  ['task.status', '{ taskId, details? }', '查询最新状态摘要；details:true 返回任务详情'],
  ['task.wait', '{ taskId, timeoutMs? }', '等待并取回附件；timeoutMs 默认600000，最大1500000'],
  ['task.retry', '{ taskId, resend? }', '补下载或补附件；resend:true 从本地补发全部附件'],
  ['task.cancel', '{ taskId }', '取消任务（本地排队中的任务只撤销排队，不会扣费）'],
  ['task.adopt', '{ taskId, remoteTaskId }', '待核对任务：用户在 RunningHub 后台找到远端任务后，把它接回继续轮询并取结果'],
  ['task.dismiss', '{ taskId, reason? }', '待核对任务：用户确认 RunningHub 上没有创建时手动结案'],
  ['account.balance', '{ region?, id? }', '查询余额与账号状态；id 可指定本地 Key'],
  ['account.queue', '{ region? }', '查询并发与排队情况'],
  ['account.keys', '{}', '查看 Key 池的掩码信息'],
  ['key.detect', '{ id }', '重新验证 Key 所属地域，成功后恢复可用状态'],
  ['key.balance', '{ id }', '查询指定 Key 的余额'],
  ['prompt.doc_list', '{}', '列出提示词文档id和名称'],
  ['prompt.doc_read', '{ docId? | name? | workflow? }', '读取提示词文档；name可为文档名称或旧版工作流名，workflow明确指定工作流并附加额外指令'],
  ['prompt.doc_write', '{ name, content, filename?, docId?, overwrite? }', '保存提示词优化文档'],
  ['prompt.optimize', '{ name, userRequest }', '按工作流配置优化提示词'],
  ['diagnostics', '{}', '查看插件诊断信息'],
]

export function renderActionList() {
  return [
    '用 runninghub_call({action:"动作名",args:{...参数}}) 调用，? 表示可选；无参数动作可省略 args。',
    'region 为 cn 或 overseas，两地 Key 不通用。params 按节点ID或字段名覆盖参数；images 为 {节点ID:本地绝对路径或RH文件名}，本地文件会自动上传。',
    ...CALL_ACTIONS.map(([name, params, description]) => name + ' ' + params + ' — ' + description),
  ].join('\n')
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
