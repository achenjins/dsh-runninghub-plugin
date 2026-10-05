/** JSON-safe values shared by the host and optional protocol core. */
export function losslessSanitize(root, recordPrimitiveFixes = true) {
  const fixes = []
  const seen = new Set()
  const walk = (v, at) => {
    if (v === null) return null
    const t = typeof v
    if (t === 'string' || t === 'boolean') return v
    if (t === 'number') {
      if (!Number.isFinite(v)) {
        fixes.push(at + '=' + String(v) + '→null')
        return null
      }
      if (Object.is(v, -0)) {
        fixes.push(at + '=-0→0')
        return 0
      }
      return v
    }
    if (t === 'undefined' || t === 'function' || t === 'symbol') {
      if (recordPrimitiveFixes) fixes.push(at + '=' + t + '→丢弃')
      return undefined
    }
    if (t === 'bigint') {
      const n = Number(v)
      const safe = Number.isSafeInteger(n)
      if (recordPrimitiveFixes) fixes.push(at + '=bigint→' + (safe ? 'number' : 'string'))
      return safe ? n : String(v)
    }
    if (seen.has(v)) {
      fixes.push(at + '=循环引用→[Circular]')
      return '[Circular]'
    }
    seen.add(v)
    try {
      if (Array.isArray(v)) {
        const out = []
        for (let i = 0; i < v.length; i++) {
          const w = walk(v[i], at + '[' + String(i) + ']')
          out.push(w === undefined ? null : w)
        }
        return out
      }
      if (v instanceof Date) {
        fixes.push(at + '=Date→ISO')
        return Number.isFinite(v.getTime()) ? v.toISOString() : null
      }
      if (v instanceof Map) {
        fixes.push(at + '=Map→数组')
        return Array.from(v.entries(), (e, i) => walk(e, at + '<map' + String(i) + '>'))
      }
      if (v instanceof Set) {
        fixes.push(at + '=Set→数组')
        return Array.from(v.values(), (e, i) => {
          const w = walk(e, at + '<set' + String(i) + '>')
          return w === undefined ? null : w
        })
      }
      if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
        fixes.push(at + '=二进制(' + String(v.byteLength) + 'B)→{bytes}')
        return { bytes: v.byteLength, why: 'binary-not-json' }
      }
      if (typeof v.toJSON === 'function' && !isPlainObject(v)) {
        try {
          return walk(v.toJSON(), at + '<toJSON>')
        } catch {
          // If toJSON fails, retain the instance's enumerable fields.
        }
      }
      const out = {}
      for (const k of Object.keys(v)) {
        const w = walk(v[k], at + '.' + k)
        if (w !== undefined) {
          if (k === '__proto__') Object.defineProperty(out, k, { value: w, enumerable: true, writable: true, configurable: true })
          else out[k] = w
        }
      }
      return out
    } finally {
      seen.delete(v)
    }
  }
  const value = walk(root, 'value')
  return { value: value === undefined ? null : value, fixes }
}

export function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}
