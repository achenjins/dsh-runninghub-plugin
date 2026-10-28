import { normalizeStatus, reportedTaskCost } from './api.mjs'

/** Durable receipt only: never retain prompts, request nodes, keys or attachment payloads. */
export function taskHistoryRecord(task) {
  const record = { taskId: String(task.taskId), status: normalizeStatus(task.status), archived: true }
  for (const key of ['remoteTaskId', 'workflowId', 'workflowName', 'region', 'createdAt', 'finishedAt', 'updatedAt', 'errorCode']) {
    if (task[key] !== undefined && task[key] !== '') record[key] = task[key]
  }
  const cost = reportedTaskCost(task)
  if (cost.consumeCoins === undefined) {
    const costs = (task.outputs || []).map(output => reportedTaskCost(output).consumeCoins).filter(value => value !== undefined)
    if (costs.length) cost.consumeCoins = costs.reduce((sum, value) => sum + value, 0)
  }
  Object.assign(record, cost)
  const files = new Map()
  for (const key of ['outputs', 'results']) {
    for (const raw of Array.isArray(task[key]) ? task[key] : []) {
      const output = typeof raw === 'string' ? { url: raw } : raw
      const item = {}
      if (typeof (output?.url || output?.fileUrl) === 'string') item.url = output.url || output.fileUrl
      for (const field of ['localPath', 'filename', 'kind']) {
        if (typeof output?.[field] === 'string' && output[field]) item[field] = output[field]
      }
      const id = item.url || item.fileUrl || item.localPath || item.filename
      if (id) files.set(id, { ...files.get(id), ...item })
    }
  }
  record.results = [...files.values()]
  return record
}
