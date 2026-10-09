/**
 * `host/core/keys.mjs` —— 多 Key 池 / 地域判定 / 轮换 / 额度冷却
 *
 * 契约（**Lead 已锁定**）：
 *   - `list()` 只返回**掩码**（`maskedKey`），绝不含明文；明文只经 `rawKey(id)` 与 `pick()` 出圈，
 *     且 `pick()` 的结果只给 runner 拼请求用，不许进日志/回执。
 *   - `pick({region})` **跨池绝不回退**：cn 池空了返回 `{ok:false,error:{code:'NO_KEY'}}`，
 *     绝不会把 overseas 的 key 递出去（跨池只会拿到 401，白白浪费一次付费调用）。
 *   - `detectRegion(api, key)` 用 `POST /uc/openapi/accountStatus` 的 `code=0` 判归属，不靠用户声明。
 *
 * 轮换策略（DESIGN §3.4）：
 *   priority 升序 → 冷却未到期 / 失效 / 禁用 跳过 → 同优先级 `lastUsedAt` 最旧优先。
 *   `report(id, outcome)`：
 *     `ok`         → 清冷却、记 lastUsedAt
 *     `AUTH`       → 永久失效（`invalid=true`），换下一个
 *     `QUOTA`      → 标记「余额不足」（不是定时冷却），换下一个；余额不会随时间自己回来，
 *                    所以再次选用前先 `recheckDepleted()` 查 `accountStatus`，有余额才恢复；
 *                    余额查不到时才退回 10 分钟定时冷却（见 `COOLDOWNS.QUOTA`），保证不比旧行为差
 *     `RATE_LIMIT` → 冷却 60 秒，可重试同一把
 *     `TRANSPORT`  → 冷却 30 秒（结果未知，但下一把更稳）
 *
 * @module dsh-runninghub-plugin/host/core/keys
 */

import { maskKey, asString, toNumber, nowMs, lossless, errorShape, shortId, slugify } from './util.mjs'

/** `report()` 接受的 outcome 取值。 */
export const OUTCOMES = ['ok', 'AUTH', 'QUOTA', 'RATE_LIMIT', 'TRANSPORT']

/**
 * 默认冷却时长（毫秒）。
 * `QUOTA` 现在只作为**兜底**：余额不足的 Key 正常靠 `recheckDepleted()` 查余额恢复；
 * 只有余额查询失败（网络 / 服务端）时，才在标记满 10 分钟后按旧策略放行。
 */
export const COOLDOWNS = {
  QUOTA: 10 * 60 * 1000,
  RATE_LIMIT: 60 * 1000,
  TRANSPORT: 30 * 1000,
}

/** 余额不足的 Key 两次余额复查之间至少间隔多久（避免每次提交都打一遍 accountStatus）。 */
export const BALANCE_RECHECK_MS = 60 * 1000

/**
 * 余额回执里是否还有钱（`remainCoins` 或 `remainMoney` 任一大于 0）。
 * 两个字段都缺失 / 不是数字时返回 `null`（未知），调用方不能据此判定"没钱"。
 * @param {{remainCoins?:unknown, remainMoney?:unknown}|null|undefined} data `accountStatus` 的 data
 * @returns {boolean|null} 有余额 true / 没余额 false / 无法判断 null
 */
export function hasFunds(data) {
  if (!data || typeof data !== 'object') return null
  const nums = [data.remainCoins, data.remainMoney]
    .filter((v) => v !== undefined && v !== null && String(v).trim() !== '')
    .map(Number)
    .filter(Number.isFinite)
  if (nums.length === 0) return null
  return nums.some((n) => n > 0)
}

/** 合法 region（`auto` 只在 `add()` 入参里出现，探测后会被落成 cn/overseas）。 */
export const KEY_REGIONS = ['cn', 'overseas']

/* ─────────────────────────────── 地域探测 ─────────────────────────────── */

/**
 * 运行时探测一把 key 归属哪个地域（**这是唯一可信判据，不靠字符串猜**）。
 *
 * 依次对 cn / overseas 调 `accountStatus`，第一个 `code=0` 的就是归属；
 * 两边都失败 → `'invalid'`（key 本身无效，或网络不通）。
 *
 * @param {{accountStatus:Function}} api `RunningHubApi`（或任何有 `accountStatus(key, region)` 的对象）
 * @param {string} key 明文 key
 * @param {{cache?:{get:Function,set:Function}, signal?:AbortSignal, regions?:string[]}} [opts]
 *        `cache` 是外部注入的缓存接口（`state.json` 由调用方负责落盘）
 * @returns {Promise<'cn'|'overseas'|'invalid'>} 归属地域
 */
export async function detectRegion(api, key, opts = {}) {
  if (!api || typeof api.accountStatus !== 'function') return 'invalid'
  const regions = Array.isArray(opts.regions) && opts.regions.length > 0 ? opts.regions : ['cn', 'overseas']
  const cache = opts.cache
  if (cache && typeof cache.get === 'function') {
    try {
      const cached = await cache.get(maskKey(key))
      if (cached === 'cn' || cached === 'overseas') return cached
    } catch {
      /* 缓存失败不阻塞探测 */
    }
  }
  for (const region of regions) {
    let r
    try {
      r = await api.accountStatus(key, region, opts.signal ? { signal: opts.signal } : {})
    } catch {
      continue
    }
    if (r && r.ok) {
      if (cache && typeof cache.set === 'function') {
        try {
          await cache.set(maskKey(key), region)
        } catch {
          /* 写缓存失败不影响结果 */
        }
      }
      return region
    }
  }
  return 'invalid'
}

/* ─────────────────────────────── 内部工具 ─────────────────────────────── */

/** 优先级越小越先用；缺省 100，显式值必须是非负安全整数。 */
export function normalizePriority(value, fallback = 100) {
  if (value === undefined) return fallback
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** 归一化一条 key 记录（缺字段补默认；**丢弃明文以外的调用方私有字段**）。 @param {any} e 原始记录 @returns {object} 规范记录 */
function normalizeEntry(e) {
  return {
    id: asString(e && e.id) || shortId('key'),
    key: asString(e && e.key),
    label: asString(e && e.label),
    region: KEY_REGIONS.includes(e && e.region) ? e.region : 'auto',
    baseUrl: asString(e && e.baseUrl),
    enabled: !(e && e.enabled === false),
    priority: normalizePriority(e && e.priority) ?? 100,
    note: asString(e && e.note),
    createdAt: Math.max(0, Math.floor(toNumber(e && e.createdAt, 0))) || nowMs(),
  }
}

/* ──────────────────────────────── KeyPool ──────────────────────────────── */

/**
 * 多 Key 池。所有方法同步、纯内存；持久化交给注入的 `onPersist(state)`。
 *
 * @example
 * const pool = new KeyPool({ state: store.loadState().keys, onPersist: (s) => store.saveState({ ...s }) })
 * const picked = pool.pick({ region: 'cn' })
 * if (!picked.ok) return picked          // {ok:false,error:{code:'NO_KEY'}}
 * await api.createTask(picked.key, 'cn', spec)
 * pool.report(picked.id, 'ok')
 */
export class KeyPool {
  /**
   * @param {object} [opts]
   * @param {{entries?:object[], cooldowns?:Record<string,number>, invalid?:string[], lastUsedAt?:Record<string,number>, depleted?:Record<string,number>, balances?:object}} [opts.state] 先前 `toJSON()` 的状态
   * @param {(state:object)=>void} [opts.onPersist] Key、冷却或失效状态变化后回调；轮换时间只更新内存
   * @param {{warn?:Function,info?:Function,error?:Function}} [opts.logger] 日志器（可省）
   * @param {()=>number} [opts.now] 注入时钟（单测用）
   */
  constructor(opts = {}) {
    /** @type {Map<string, object>} id → 记录（**含明文 key**，只在进程内） */
    this._entries = new Map()
    /** @type {Map<string, number>} id → 冷却到期时间戳 */
    this._cooldowns = new Map()
    /** @type {Set<string>} 永久失效的 id */
    this._invalid = new Set()
    /** @type {Map<string, number>} id → 上次使用时间戳 */
    this._lastUsedAt = new Map()
    /** @type {Map<string, number>} id → 被判「余额不足」的时间戳（充值前不再选用） */
    this._depleted = new Map()
    /** @type {Map<string, {remainCoins:string, remainMoney:string, currency:string, checkedAt:number}>} 最近一次查到的余额 */
    this._balances = new Map()
    /** @type {Map<string, number>} id → 上次尝试复查余额的时间（成功与否都记，用于限频） */
    this._balanceTriedAt = new Map()
    this.onPersist = typeof opts.onPersist === 'function' ? opts.onPersist : null
    this.logger = opts.logger || null
    this._now = typeof opts.now === 'function' ? opts.now : nowMs
    if (opts.state && typeof opts.state === 'object') this.fromJSON(opts.state)
  }

  /** 时钟（可注入）。 @returns {number} epoch ms */
  now() {
    const v = toNumber(this._now(), 0)
    return v > 0 ? v : nowMs()
  }

  /** 安全日志（只输出掩码与 id）。 @param {'info'|'warn'|'error'} level 级别 @param {string} msg 消息 @param {object} [meta] 附加 @returns {void} */
  _log(level, msg, meta) {
    const fn = this.logger && (this.logger[level] || this.logger.log)
    if (typeof fn !== 'function') return
    try {
      fn.call(this.logger, '[rh-keys] ' + msg, lossless(meta || {}))
    } catch {
      /* 忽略 */
    }
  }

  /** 状态变化后落盘钩子（失败不抛）。 @returns {void} */
  _persist() {
    if (!this.onPersist) return
    try {
      this.onPersist(this.toJSON())
    } catch {
      /* 落盘失败不影响内存态 */
    }
  }

  /**
   * 加一把 key。
   * @param {{key:string,label?:string,region?:'cn'|'overseas'|'auto',priority?:number,enabled?:boolean,note?:string,id?:string,baseUrl?:string}} entry 记录
   * @returns {{ok:true,id:string,entry:object}|{ok:false,error:object}} 结果（`entry` 是掩码版）
   */
  add(entry) {
    if (normalizePriority(entry && entry.priority) === null) {
      return { ok: false, error: errorShape('BAD_REQUEST', 'priority 必须是非负安全整数') }
    }
    const e = normalizeEntry(entry)
    if (e.key === '') {
      return { ok: false, error: errorShape('BAD_REQUEST', 'key 不能为空', { hint: 'add({key}) 需要明文 key' }) }
    }
    if (this._entries.has(e.id)) {
      return { ok: false, error: errorShape('BAD_REQUEST', 'id 已存在：' + e.id, { hint: '换一个 id，或改用 update()' }) }
    }
    const dup = this.findByKey(e.key)
    if (dup) {
      return {
        ok: false,
        error: errorShape('BAD_REQUEST', '这把 key 已经在池子里（id=' + dup.id + '）', { hint: '重复添加同一把 key 只会在失败时白轮一次' }),
      }
    }
    this._entries.set(e.id, e)
    this._log('info', '加 key ' + e.id + ' region=' + e.region + ' ' + maskKey(e.key))
    this._persist()
    return { ok: true, id: e.id, entry: this._publicView(e.id) }
  }

  /**
   * 按明文 key 找记录（内部去重用）。 @param {string} key 明文 key @returns {object|undefined} 记录
   */
  findByKey(key) {
    const k = asString(key)
    for (const e of this._entries.values()) if (e.key === k) return e
    return undefined
  }

  /**
   * 局部更新（`key` 也可改；改 key 会顺手清掉失效标记与冷却）。
   * @param {string} id 记录 id
   * @param {object} patch 要改的字段
   * @returns {{ok:true,entry:object}|{ok:false,error:object}} 结果
   */
  update(id, patch) {
    const e = this._entries.get(asString(id))
    if (!e) return { ok: false, error: errorShape('NOT_FOUND', '没有这个 key id：' + asString(id)) }
    const p = patch && typeof patch === 'object' ? patch : {}
    const priority = normalizePriority(p.priority, e.priority)
    if (priority === null) return { ok: false, error: errorShape('BAD_REQUEST', 'priority 必须是非负安全整数') }
    if (p.key !== undefined && asString(p.key) !== '') {
      e.key = asString(p.key)
      this._invalid.delete(e.id)
      this._cooldowns.delete(e.id)
      this._clearDepleted(e.id)
      this._balances.delete(e.id)
    }
    if (p.label !== undefined) e.label = asString(p.label)
    if (p.note !== undefined) e.note = asString(p.note)
    if (p.region !== undefined) e.region = KEY_REGIONS.includes(p.region) ? p.region : 'auto'
    if (p.enabled !== undefined) e.enabled = p.enabled !== false
    e.priority = priority
    if (p.baseUrl !== undefined) e.baseUrl = asString(p.baseUrl)
    this._log('info', '更新 key ' + e.id + ' → region=' + e.region + ' enabled=' + String(e.enabled))
    this._persist()
    return { ok: true, entry: this._publicView(e.id) }
  }

  /**
   * 删一把 key。
   * @param {string} id 记录 id
   * @returns {{ok:true,id:string}|{ok:false,error:object}} 结果
   */
  remove(id) {
    const key = asString(id)
    if (!this._entries.has(key)) return { ok: false, error: errorShape('NOT_FOUND', '没有这个 key id：' + key) }
    this._entries.delete(key)
    this._cooldowns.delete(key)
    this._invalid.delete(key)
    this._lastUsedAt.delete(key)
    this._clearDepleted(key)
    this._balances.delete(key)
    this._log('info', '删除 key ' + key)
    this._persist()
    return { ok: true, id: key }
  }

  /**
   * Key 列表（**永远掩码，绝不含明文 key**）。
   * @param {{region?:string, includeDisabled?:boolean}} [opts] 可选过滤
   * @returns {object[]} `[{id,label,maskedKey,region,enabled,priority,cooldownUntil,invalid,lastUsedAt}]`
   */
  list(opts = {}) {
    const out = []
    for (const e of this._entries.values()) {
      if (opts.region && e.region !== opts.region) continue
      if (opts.includeDisabled === false && !e.enabled) continue
      out.push(this._publicView(e.id))
    }
    out.sort((a, b) => a.priority - b.priority || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
    return out
  }

  /** 单条记录的掩码视图。 @param {string} id 记录 id @returns {object|null} 掩码记录 */
  _publicView(id) {
    const e = this._entries.get(id)
    if (!e) return null
    const t = this.now()
    const cd = this._cooldowns.get(id) || 0
    const balance = this._balances.get(id)
    return {
      id: e.id,
      label: e.label,
      maskedKey: maskKey(e.key),
      region: e.region,
      baseUrl: e.baseUrl,
      enabled: e.enabled,
      priority: e.priority,
      note: e.note,
      createdAt: e.createdAt,
      cooldownUntil: cd > t ? cd : 0,
      cooldownRemainingMs: cd > t ? cd - t : 0,
      invalid: this._invalid.has(id),
      depleted: this._depleted.has(id),
      depletedAt: this._depleted.get(id) || 0,
      balance: balance ? { ...balance } : null,
      lastUsedAt: this._lastUsedAt.get(id) || 0,
    }
  }

  /**
   * 拿明文 key（**仅供内部的紧急路径 / 迁移工具**；正常调用一律用 `pick()`）。
   * 结果**绝不能**进日志、进回执、进 UI 快照。
   * @param {string} id 记录 id
   * @returns {string|undefined} 明文 key
   */
  rawKey(id) {
    const e = this._entries.get(asString(id))
    return e ? e.key : undefined
  }

  /**
   * 是否现在可用（未禁用、未失效、没在冷却）。
   * @param {string} id 记录 id
   * @returns {boolean} 可用为 true
   */
  isAvailable(id) {
    const e = this._entries.get(asString(id))
    if (!e || !e.enabled) return false
    if (this._invalid.has(e.id)) return false
    if (this._depleted.has(e.id)) return false
    return (this._cooldowns.get(e.id) || 0) <= this.now()
  }

  /**
   * 选一把 key。**只在本 region 池内选，绝不跨池回退。**
   *
   * 排序：`priority` 升序 → 同优先级 `lastUsedAt` 最旧优先（都没用过时按 createdAt）。
   * @param {{region?:string, exclude?:string[]}} [opts] `region` 缺省时用 `'cn'`
   * @returns {{ok:true,id:string,key:string,region:string,label:string,maskedKey:string,priority:number}|{ok:false,error:object}} 结果
   */
  pick(opts = {}) {
    const region = KEY_REGIONS.includes(opts.region) ? opts.region : 'cn'
    const exclude = new Set(Array.isArray(opts.exclude) ? opts.exclude.map(asString) : [])
    const t = this.now()
    const cands = []
    let poolTotal = 0
    let allCooling = 0
    let allInvalid = 0
    let allDisabled = 0
    let allDepleted = 0
    for (const e of this._entries.values()) {
      if (e.region !== region) continue // ← 跨池绝不回退
      poolTotal += 1
      if (!e.enabled) {
        allDisabled += 1
        continue
      }
      if (this._invalid.has(e.id)) {
        allInvalid += 1
        continue
      }
      if (this._depleted.has(e.id)) {
        allDepleted += 1
        continue
      }
      if ((this._cooldowns.get(e.id) || 0) > t) {
        allCooling += 1
        continue
      }
      if (exclude.has(e.id)) continue
      cands.push(e)
    }
    if (cands.length === 0) {
      const code = poolTotal === 0 ? 'NO_KEY' : 'POOL_EMPTY'
      const why =
        poolTotal === 0
          ? '当前 region=' + region + ' 池里一把 key 都没有'
          : 'region=' + region + ' 共 ' + String(poolTotal) + ' 把，全部不可用（冷却 ' + String(allCooling) + ' / 余额不足 ' + String(allDepleted) + ' / 失效 ' + String(allInvalid) + ' / 禁用 ' + String(allDisabled) + '）'
      return {
        ok: false,
        error: errorShape(code, why, {
          hint:
            (allDepleted > 0 ? '有 ' + String(allDepleted) + ' 把 Key 余额不足：充值后在面板点「查余额」即可恢复。' : '') +
            '**绝不跨池回退**：国内(runninghub.cn)与海外(runninghub.ai)的 key 不通用，跨池只会拿到 401。请补一把该地域的 key，或换一个 region 的工作流。',
          region,
          stats: lossless(this.poolStats()),
        }),
      }
    }
    cands.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      const la = this._lastUsedAt.get(a.id) || 0
      const lb = this._lastUsedAt.get(b.id) || 0
      if (la !== lb) return la - lb
      return a.createdAt - b.createdAt
    })
    const chosen = cands[0]
    // 轮换信息随下次状态变更一同保存，不为每次请求重写 secrets。
    this._lastUsedAt.set(chosen.id, t)
    return {
      ok: true,
      id: chosen.id,
      key: chosen.key,
      region: chosen.region,
      label: chosen.label,
      maskedKey: maskKey(chosen.key),
      priority: chosen.priority,
    }
  }

  /**
   * 回报一次调用的结果，更新冷却 / 失效 / 余额不足状态。
   *
   * `QUOTA` 不再是定时冷却：余额不会在 10 分钟后自己回来。这里只把 Key 标成「余额不足」，
   * 充值后由 `recheckDepleted()`（提交前自动）或面板的「查余额」（`recordBalance`）恢复。
   * 显式传 `cooldownMs` 时保持旧语义（按时长冷却），给需要定时行为的调用方留口子。
   * @param {string} id 记录 id
   * @param {'ok'|'AUTH'|'QUOTA'|'RATE_LIMIT'|'TRANSPORT'} outcome 结果分类
   * @param {{cooldownMs?:number, message?:string}} [opts] `cooldownMs` 覆盖默认冷却
   * @returns {{ok:true,id:string,state:object}|{ok:false,error:object}} 结果
   */
  report(id, outcome, opts = {}) {
    const e = this._entries.get(asString(id))
    if (!e) return { ok: false, error: errorShape('NOT_FOUND', '没有这个 key id：' + asString(id)) }
    const t = this.now()
    const o = OUTCOMES.includes(outcome) ? outcome : 'TRANSPORT'
    let changed
    if (o === 'ok') {
      changed = this._cooldowns.delete(e.id)
      this._lastUsedAt.set(e.id, t)
      if (this._clearDepleted(e.id)) changed = true
    } else if (o === 'QUOTA' && opts.cooldownMs === undefined) {
      changed = !this._depleted.has(e.id)
      if (changed) this._depleted.set(e.id, t)
      this._balanceTriedAt.set(e.id, t)
      this._log('warn', 'key ' + e.id + ' (' + maskKey(e.key) + ') 余额不足，充值并复查余额前不再选用')
    } else if (o === 'AUTH') {
      changed = !this._invalid.has(e.id)
      this._invalid.add(e.id)
      this._log('warn', 'key ' + e.id + ' (' + maskKey(e.key) + ') 已标记失效（AUTH）')
    } else {
      const ms = Math.max(0, toNumber(opts.cooldownMs, COOLDOWNS[o] ?? COOLDOWNS.TRANSPORT))
      changed = this._cooldowns.get(e.id) !== t + ms
      this._cooldowns.set(e.id, t + ms)
      this._log('warn', 'key ' + e.id + ' (' + maskKey(e.key) + ') 冷却 ' + String(ms) + 'ms（' + o + '）')
    }
    if (changed) this._persist()
    return { ok: true, id: e.id, state: this._publicView(e.id) }
  }

  /**
   * 清掉失效标记 / 冷却；显式重新验证成功后由入口调用。
   * @param {string} id 记录 id
   * @returns {{ok:true,entry:object}|{ok:false,error:object}} 结果
   */
  reset(id) {
    const e = this._entries.get(asString(id))
    if (!e) return { ok: false, error: errorShape('NOT_FOUND', '没有这个 key id：' + asString(id)) }
    const changed = this._invalid.has(e.id) || this._cooldowns.has(e.id) || this._depleted.has(e.id)
    this._invalid.delete(e.id)
    this._cooldowns.delete(e.id)
    this._clearDepleted(e.id)
    this._log('info', '重置 key ' + e.id + ' 的失效、冷却与余额不足标记')
    if (changed) this._persist()
    return { ok: true, entry: this._publicView(e.id) }
  }

  /**
   * 显式验证这把 Key **能用**之后（地域探测 / 查余额成功）调用：清掉失效标记与冷却，
   * 但**不**清「余额不足」—— 那个只看余额本身（见 `recordBalance`）。
   * @param {string} id 记录 id
   * @returns {{ok:true,entry:object}|{ok:false,error:object}} 结果
   */
  markVerified(id) {
    const e = this._entries.get(asString(id))
    if (!e) return { ok: false, error: errorShape('NOT_FOUND', '没有这个 key id：' + asString(id)) }
    const wasInvalid = this._invalid.delete(e.id)
    const wasCooling = this._cooldowns.delete(e.id)
    const changed = wasInvalid || wasCooling
    if (changed) this._persist()
    return { ok: true, entry: this._publicView(e.id) }
  }

  /** 清掉「余额不足」标记。 @param {string} id 记录 id @returns {boolean} 原来有标记为 true */
  _clearDepleted(id) {
    this._balanceTriedAt.delete(id)
    return this._depleted.delete(id)
  }

  /**
   * 记录一次余额查询的结果，并据此更新「余额不足」标记。
   *
   * - 查到了且有余额（`remainCoins`/`remainMoney` 任一 > 0）→ 清标记，Key 恢复可用；
   * - 查到了但没余额 → 保持标记（**不会**因为一次 0 余额就把从没报过 QUOTA 的 Key 打死，
   *   有的账号可能走别的计费方式，只有真的提交被拒才算余额不足）；
   * - 查询失败 → 退回旧的定时策略：标记满 `COOLDOWNS.QUOTA` 后放行，保证不比原来差。
   * @param {string} id 记录 id
   * @param {{ok:boolean, data?:object}} result `api.accountStatus()` 的结果
   * @returns {{ok:true,id:string,state:object}|{ok:false,error:object}} 结果
   */
  recordBalance(id, result) {
    const e = this._entries.get(asString(id))
    if (!e) return { ok: false, error: errorShape('NOT_FOUND', '没有这个 key id：' + asString(id)) }
    const t = this.now()
    this._balanceTriedAt.set(e.id, t)
    let changed = false
    if (result && result.ok === true) {
      const d = result.data && typeof result.data === 'object' ? result.data : {}
      this._balances.set(e.id, {
        remainCoins: asString(d.remainCoins),
        remainMoney: asString(d.remainMoney),
        currency: asString(d.currency),
        checkedAt: t,
      })
      changed = true
      if (hasFunds(d) === true && this._depleted.has(e.id)) {
        this._clearDepleted(e.id)
        this._log('info', 'key ' + e.id + ' (' + maskKey(e.key) + ') 复查到余额，恢复可用')
      }
    } else {
      const since = this._depleted.get(e.id)
      if (since !== undefined && t - since >= COOLDOWNS.QUOTA) {
        this._clearDepleted(e.id)
        changed = true
        this._log('warn', 'key ' + e.id + ' 余额复查失败，按旧策略在 ' + String(COOLDOWNS.QUOTA) + 'ms 后放行')
      }
    }
    if (changed) this._persist()
    return { ok: true, id: e.id, state: this._publicView(e.id) }
  }

  /**
   * 列出某个 region 里**该复查余额**的「余额不足」Key（距上次尝试已超过 `BALANCE_RECHECK_MS`）。
   * @param {string} [region] 只看这个地域；缺省看全部
   * @returns {string[]} id 列表
   */
  depletedDue(region) {
    const t = this.now()
    const out = []
    for (const [id] of this._depleted) {
      const e = this._entries.get(id)
      if (!e || !e.enabled || this._invalid.has(id)) continue
      if (region && e.region !== region) continue
      if (t - (this._balanceTriedAt.get(id) || 0) < BALANCE_RECHECK_MS) continue
      out.push(id)
    }
    return out
  }

  /**
   * 提交前调用：对本地域里到期的「余额不足」Key 查一次余额，有钱的恢复可用。
   * **不抛**：查询异常按失败处理（触发定时兜底）。
   * @param {{accountStatus:Function}} api `RunningHubApi`
   * @param {string} region 地域
   * @returns {Promise<string[]>} 本次恢复可用的 id
   */
  async recheckDepleted(api, region) {
    if (!api || typeof api.accountStatus !== 'function') return []
    const restored = []
    for (const id of this.depletedDue(region)) {
      const e = this._entries.get(id)
      if (!e) continue
      let r
      try {
        r = await api.accountStatus(e.key, e.region)
      } catch {
        r = { ok: false }
      }
      this.recordBalance(id, r)
      if (!this._depleted.has(id)) restored.push(id)
    }
    return restored
  }

  /**
   * 两池概览（给 `account.keys` / `diagnostics` 用）。
   * @returns {{cn:{total:number,available:number},overseas:{total:number,available:number}}} 统计
   */
  poolStats() {
    const out = { cn: { total: 0, available: 0 }, overseas: { total: 0, available: 0 } }
    for (const e of this._entries.values()) {
      const bucket = KEY_REGIONS.includes(e.region) ? e.region : 'cn'
      out[bucket].total += 1
      if (this.isAvailable(e.id)) out[bucket].available += 1
    }
    return out
  }

  /**
   * 完整状态快照（**含明文 key，落盘用**；`secrets.json` 必须 0600）。
   * 想给模型/UI 看请用 `list()`。
   * @returns {{entries:object[],cooldowns:object,invalid:string[],lastUsedAt:object}} 状态
   */
  toJSON() {
    return {
      entries: Array.from(this._entries.values(), (e) => ({ ...e })),
      cooldowns: Object.fromEntries(this._cooldowns),
      invalid: Array.from(this._invalid),
      lastUsedAt: Object.fromEntries(this._lastUsedAt),
      depleted: Object.fromEntries(this._depleted),
      balances: Object.fromEntries(Array.from(this._balances, ([k, v]) => [k, { ...v }])),
    }
  }

  /**
   * **不含明文 key** 的对外快照（UI / 回执 / diagnostics 用）。
   * @returns {{keys:object[],stats:object}} 掩码快照
   */
  publicJSON() {
    return { keys: lossless(this.list()), stats: lossless(this.poolStats()) }
  }

  /**
   * 从 `toJSON()` 的状态恢复。
   * @param {{entries?:object[],cooldowns?:object,invalid?:string[],lastUsedAt?:object}} state 状态
   * @returns {{ok:true,count:number}} 结果
   */
  fromJSON(state) {
    const s = state && typeof state === 'object' ? state : {}
    this._entries.clear()
    this._cooldowns.clear()
    this._invalid.clear()
    this._lastUsedAt.clear()
    this._depleted.clear()
    this._balances.clear()
    this._balanceTriedAt.clear()
    const entries = Array.isArray(s.entries) ? s.entries : Array.isArray(s) ? s : []
    for (const raw of entries) {
      const e = normalizeEntry(raw)
      if (e.key === '') continue
      this._entries.set(e.id, e)
    }
    if (s.cooldowns && typeof s.cooldowns === 'object') {
      for (const [k, v] of Object.entries(s.cooldowns)) {
        const n = toNumber(v, 0)
        if (n > 0) this._cooldowns.set(k, n)
      }
    }
    if (Array.isArray(s.invalid)) for (const id of s.invalid) this._invalid.add(asString(id))
    if (s.lastUsedAt && typeof s.lastUsedAt === 'object') {
      for (const [k, v] of Object.entries(s.lastUsedAt)) this._lastUsedAt.set(k, toNumber(v, 0))
    }
    if (s.depleted && typeof s.depleted === 'object') {
      for (const [k, v] of Object.entries(s.depleted)) {
        const n = toNumber(v, 0)
        if (n > 0) this._depleted.set(k, n)
      }
    }
    if (s.balances && typeof s.balances === 'object') {
      for (const [k, v] of Object.entries(s.balances)) {
        if (!v || typeof v !== 'object') continue
        this._balances.set(k, {
          remainCoins: asString(v.remainCoins),
          remainMoney: asString(v.remainMoney),
          currency: asString(v.currency),
          checkedAt: toNumber(v.checkedAt, 0),
        })
      }
    }
    return { ok: true, count: this._entries.size }
  }

  /** 池子里 key 的总数。 @returns {number} 数量 */
  get size() {
    return this._entries.size
  }

  /**
   * 由「明文 key 字符串数组」批量建池（UI 里粘贴多行 key 的场景）。
   * @param {(string|object)[]} items key 字符串或记录对象
   * @param {{region?:string,priority?:number}} [defaults] 默认字段
   * @returns {{ok:true,added:number,skipped:number,ids:string[]}} 结果
   */
  addMany(items, defaults = {}) {
    const ids = []
    let skipped = 0
    for (const item of Array.isArray(items) ? items : []) {
      const entry =
        typeof item === 'string'
          ? { key: item.trim(), region: defaults.region || 'auto', priority: defaults.priority }
          : { ...(item || {}), region: (item && item.region) || defaults.region || 'auto' }
      if (!entry.key) {
        skipped += 1
        continue
      }
      const r = this.add(entry)
      if (r.ok) ids.push(r.id)
      else skipped += 1
    }
    return { ok: true, added: ids.length, skipped, ids }
  }

  /**
   * 给一把（还没入池的）key 生成建议 id：`<region>-<slug(label)>`。
   * @param {string} label 标签 @param {string} [region] 地域 @returns {string} 建议 id
   */
  static suggestId(label, region = 'cn') {
    return String(region) + '-' + slugify(label || 'key', 'key')
  }
}
