export const DEFAULT_TASK_LIMIT = 10

/** 未设置或非法值返回 null；0 明确表示不限制。 */
export function parseTaskLimit(value) {
  if (typeof value === 'string') {
    if (!/^\d+$/.test(value.trim())) return null
    value = Number(value.trim())
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}
