/** Exact names and IDs take precedence over case-insensitive aliases. */
export function matchWorkflow(list, name) {
  const target = String(name || '').trim()
  if (!target) return null
  const lower = target.toLowerCase()
  let idHit = null
  let nameHit = null
  let aliasHit = null
  for (const w of list) {
    const workflowName = String(w.name || '')
    if (workflowName === target) return w
    if (!idHit && String(w.id || '') === target) idHit = w
    if (!nameHit && workflowName.toLowerCase() === lower) nameHit = w
    if (!aliasHit && String(w.displayNameEn || '').toLowerCase() === lower) aliasHit = w
  }
  return idHit || nameHit || aliasHit
}
