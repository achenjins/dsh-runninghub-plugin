/** RunningHub instance tiers. Shared by configuration saves and task submission. */
export const INSTANCE_TYPES = ['default', 'plus', 'ultra']
const ALIASES = { standard: 'default', std: 'default', normal: 'default', basic: 'default', pro: 'plus', premium: 'ultra', max: 'ultra' }

export function normalizeInstanceType(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase()
  if (raw === '') return { ok: true, value: 'default' }
  if (INSTANCE_TYPES.includes(raw)) return { ok: true, value: raw }
  if (Object.hasOwn(ALIASES, raw)) return { ok: true, value: ALIASES[raw] }
  return { ok: false, error: { code: 'BAD_REQUEST', message: '不认识的 instanceType：' + String(value),
    hint: '运行设备只能选择 default / plus / ultra（分别 24G / 48G / 84G）',
  } }
}
