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
 * @param {Iterable<string>} [secrets] 需要抹掉的**字面量**（本插件自己持有的密钥）。
 * @param {{byName?: boolean}} [opts]
 *   `byName`（默认 true）= 额外按**字段名**掩码（`credentialField` 命中就掩，不管值是不是凭据）。
 *   ⚠️ **只用于诊断/日志出口**。业务数据出口必须传 `byName:false`：
 *   ComfyUI / RunningHub 工作流的节点入参里 `token` / `api_key` / `secret` 这些名字**很常见**，
 *   按名字掩码会把用户的正常参数改成 `sk-l****epme`，而且它会作为节点默认值被**原样提交** ——
 *   静默损坏付费请求，且不报任何错。字面量匹配（只抹我们真正持有的那把）不会误伤。
 * @returns {(value: unknown) => unknown} 脱敏函数（对 string / 数组 / 对象递归）
 */
export function createRedactor(secrets = [], opts = {}) {
  const byName = opts.byName !== false
  const known = [...new Set(secrets.filter((value) => typeof value === 'string' && value.length > 0))].sort((a, b) => b.length - a.length)
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
    return out.split(/(https?:\/\/[^\s"'<>]+)/gi).map((part) => {
      if (/^https?:\/\//i.test(part)) return part.replace(/(https?:\/\/)[^\s\/@]+@/gi, '$1****@')
      const withBearer = part.replace(/\bBearer[ \t]+([A-Za-z0-9._~+*\/-]+=*)/gi, (_match, token) => 'Bearer ' + maskKey(token))
      // 按名字的关键字掩码只对诊断文本做；业务数据里 `api_key` 是合法参数名。
      if (!byName) return withBearer
      return withBearer.replace(/(\b(?:api[-_]?key|secret|token|password|authorization|access[-_]?token|refresh[-_]?token)\b["']?\s*[:=]\s*["']?)([^\s"'&,;}\]]+)/gi,
        (_match, prefix, token) => prefix + maskKey(token))
    }).join('')
  }
  const seen = new Set()
  const walk = (value) => {
    if (typeof value === 'string') {
      // Envelopes and workflow responses can contain a second JSON layer.
      if (/^\s*[{[]/.test(value)) {
        try { return JSON.stringify(walk(JSON.parse(value))) } catch { /* plain text */ }
      }
      return redactText(value)
    }
    if (!value || typeof value !== 'object') return value
    // ⚠️ 只递归「普通对象 / 数组」。Uint8Array / Date / Map / Set 之类走下面的
    //    `Object.entries` + `Object.fromEntries` 会被**静默拍平**
    //    （`Uint8Array([1,2,3])` → `{"0":1,"1":2,"2":3}`、`Date`/`Map` → `{}`）。
    //    当前回执里没有字节数组（附件用的是数字 `bytes`），所以不是活 bug；
    //    但 `defineRHTool` 对**整条回执**做这件事，将来任何 handler 回一个
    //    Uint8Array 就会被悄悄改写。非普通对象一律原样放行。
    if (!Array.isArray(value)) {
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) return value
    }
    if (seen.has(value)) return '[Circular]'
    seen.add(value)
    const out = Array.isArray(value) ? value.map(walk) : Object.fromEntries(Object.entries(value).map(([name, item]) => {
      let publicName = name
      for (const secret of known) if (secret.length > 8) publicName = publicName.split(secret).join(maskKey(secret))
      const redacted = byName && credentialField.test(name) && typeof item === 'string'
        ? (/^Bearer\s+/i.test(item) ? 'Bearer ' + maskKey(item.replace(/^Bearer\s+/i, '')) : maskKey(item))
        : walk(item)
      return [publicName, redacted]
    }))
    seen.delete(value)
    return out
  }
  return walk
}

function credentialsIn(value, out, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  for (const [name, item] of Object.entries(value)) {
    if (credentialField.test(name) && typeof item === 'string') out.push(item.replace(/^Bearer\s+/i, ''))
    else if (item && typeof item === 'object') credentialsIn(item, out, seen)
  }
}

/** Capture before a Key update/removal so errors cannot reveal the old value. */
export function runtimeRedactor(rt, request = null) {
  const secrets = []
  try {
    for (const entry of rt?.pool?.list?.() || []) secrets.push(rt.pool.rawKey?.(entry.id))
  } catch { /* Unloaded runtime can still redact credential fields. */ }
  credentialsIn(request, secrets)
  return createRedactor(secrets)
}

export function redactForRuntime(rt, value) {
  return runtimeRedactor(rt)(value)
}
