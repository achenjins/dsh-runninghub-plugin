/** Redaction at log, API, tool and panel boundaries. No host dependencies. */
export function maskKey(value) {
  const text = String(value == null ? '' : value)
  if (!text) return '（未设置）'
  if (/^[^*\s]{0,4}\*{4,}[^*\s]{0,5}$/.test(text)) return text
  if (text.length < 3) return '****'
  if (text.length <= 8) return text.slice(0, 2) + '****'
  return text.slice(0, 4) + '****' + text.slice(-4)
}

const credentialField = /^(?:api[-_]?key(?:value)?|key|secret|token|password|authorization|(?:access|refresh)[-_]?token|(?:client|private)[-_]?(?:key|secret))$/i
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Known secrets are also removed from free text and JSON stored inside strings.
 *
 * @param {string[]} [secrets] Actual credentials, including values echoed in text.
 * @param {{byName?: boolean}} [opts] Field-name masking is for diagnostics only;
 * business data must use `byName:false` to preserve normal token/api_key fields.
 */
export function createRedactor(secrets = [], opts = {}) {
  const byName = opts.byName !== false
  const known = [...new Set(secrets.filter((value) => typeof value === 'string' && value.length > 0))].sort((a, b) => b.length - a.length)
  let changes = 0
  const redactText = (text) => {
    let out = text
    for (const secret of known) {
      if (secret.length <= 8) {
        const pattern = new RegExp('(?<![A-Za-z0-9_])' + escapeRegex(secret) + '(?![A-Za-z0-9_])', 'g')
        out = out.replace(pattern, () => maskKey(secret))
      } else out = out.split(secret).join(maskKey(secret))
    }
    // Preserve signed result links in both fields and Markdown messages.
    // Known account Keys were already removed above; URL userinfo is private.
    out = out.split(/(https?:\/\/[^\s"'<>]+)/gi).map((part) => {
      if (/^https?:\/\//i.test(part)) return part.replace(/(https?:\/\/)[^\s\/@]+@/gi, '$1****@')
      const withBearer = part.replace(/\bBearer[ \t]+([A-Za-z0-9._~+*\/-]+=*)/gi, (_match, token) => 'Bearer ' + maskKey(token))
      // 按名字的关键字掩码只对诊断文本做；业务数据里 `api_key` 是合法参数名。
      if (!byName) return withBearer
      return withBearer.replace(/(\b(?:api[-_]?key|secret|token|password|authorization|access[-_]?token|refresh[-_]?token)\b["']?\s*[:=]\s*["']?)([^\s"'&,;}\]]+)/gi,
        (_match, prefix, token) => prefix + maskKey(token))
    }).join('')
    if (out !== text) changes++
    return out
  }
  const seen = new Set()
  const walk = (value) => {
    if (typeof value === 'string') {
      // Envelopes and workflow responses can contain a second JSON layer.
      if (/^\s*[{[]/.test(value)) {
        try {
          const before = changes
          const out = walk(JSON.parse(value))
          return changes === before ? value : JSON.stringify(out)
        } catch { /* plain text */ }
      }
      return redactText(value)
    }
    if (!value || typeof value !== 'object') return value
    // Preserve binary and other non-JSON types; sanitize them at the tool boundary.
    if (!Array.isArray(value)) {
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        // Errors can contain credentials even though their properties are not enumerable.
        if (value instanceof Error) {
          return {
            name: redactText(String(value.name || 'Error')),
            message: redactText(String(value.message || '')),
            stack: redactText(String(value.stack || '')).split('\n').slice(0, 5).join('\n'),
          }
        }
        return value
      }
    }
    if (seen.has(value)) { changes++; return '[Circular]' }
    seen.add(value)
    const out = Array.isArray(value) ? value.map(walk) : Object.fromEntries(Object.entries(value).map(([name, item]) => {
      let publicName = name
      for (const secret of known) if (secret.length > 8) publicName = publicName.split(secret).join(maskKey(secret))
      if (publicName !== name) changes++
      const byField = byName && credentialField.test(name) && typeof item === 'string'
      const redacted = byField
        ? (/^Bearer\s+/i.test(item) ? 'Bearer ' + maskKey(item.replace(/^Bearer\s+/i, '')) : maskKey(item))
        : walk(item)
      if (byField && redacted !== item) changes++
      return [publicName, redacted]
    }))
    seen.delete(value)
    return out
  }
  return walk
}

function requestKey(request, method = '', seen = new Set()) {
  if (!request || typeof request !== 'object' || seen.has(request)) return
  seen.add(request)
  if (!method && request.method) return requestKey(request.params, request.method, seen)
  const operation = String(method || request.action || '').trim()
  if (operation === 'call') {
    let call = request.callJson
    if (typeof call === 'string') {
      try { call = JSON.parse(call) } catch { return }
    }
    return requestKey(call, '', seen)
  }
  if (operation === 'key.add') return request.key
  if (operation === 'keysAdd') return request.entry?.key
  if (operation === 'key.update' || operation === 'keysUpdate') return request.patch?.key
}

function runtimeSecrets(rt) {
  const secrets = []
  try {
    for (const entry of rt?.pool?.list?.() || []) secrets.push(rt.pool.rawKey?.(entry.id))
  } catch { /* The pool may not be loaded yet. */ }
  return secrets
}

/** Capture before a Key update/removal so errors cannot reveal the old value. */
export function runtimeRedactor(rt, request = null, method = '') {
  const secrets = runtimeSecrets(rt)
  const key = requestKey(request, method || request?.action || '')
  if (typeof key === 'string') secrets.push(key.trim())
  return createRedactor(secrets, { byName: false })
}

export function redactForRuntime(rt, value) {
  return createRedactor(runtimeSecrets(rt))(value)
}
