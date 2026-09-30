/**
 * tests/core/keys.test.mjs —— `host/core/keys.mjs` 的契约锁定
 *
 * 覆盖任务书点名的 5 条：额度不足→换 key · 401→标记失效并换 key · 跨池不回退 ·
 * 同优先级最久未用优先 · 冷却到期后重新可用。另外锁定：`list()` 永不含明文。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { KeyPool, detectRegion, COOLDOWNS, OUTCOMES } from '../../host/core/keys.mjs'

/** 造一个可控时钟。 */
function fakeClock(start = 1_700_000_000_000) {
  let t = start
  return {
    now: () => t,
    advance(ms) {
      t += ms
    },
  }
}

const K = {
  cn1: 'rh_cn_aaaaaaaaaaaa1111',
  cn2: 'rh_cn_bbbbbbbbbbbb2222',
  cn3: 'rh_cn_cccccccccccc3333',
  ov1: 'rh_ov_dddddddddddd4444',
}

function poolWith(clock, entries) {
  const saved = []
  const p = new KeyPool({ now: clock.now, onPersist: (s) => saved.push(s) })
  for (const e of entries) {
    const r = p.add(e)
    assert.equal(r.ok, true, JSON.stringify(r))
  }
  p._saved = saved
  return p
}

/* ─────────────────────────────── add / list ─────────────────────────────── */

test('add：重复 key 会被拒（避免失败时白轮一次）', () => {
  const c = fakeClock()
  const p = poolWith(c, [{ id: 'a', key: K.cn1, region: 'cn' }])
  const dup = p.add({ id: 'b', key: K.cn1, region: 'cn' })
  assert.equal(dup.ok, false)
  assert.match(dup.error.message, /已经在池子里/)
  assert.equal(p.size, 1)
})

test('add：空 key 被拒；id 冲突被拒', () => {
  const c = fakeClock()
  const p = new KeyPool({ now: c.now })
  assert.equal(p.add({ key: '' }).ok, false)
  assert.equal(p.add({ id: 'x', key: K.cn1, region: 'cn' }).ok, true)
  assert.equal(p.add({ id: 'x', key: K.cn2, region: 'cn' }).ok, false)
})

test('list()：**绝不含明文 key**，只给 maskedKey', () => {
  const c = fakeClock()
  const p = poolWith(c, [
    { id: 'a', key: K.cn1, region: 'cn', label: '主号' },
    { id: 'b', key: K.ov1, region: 'overseas' },
  ])
  const list = p.list()
  assert.equal(list.length, 2)
  const json = JSON.stringify(list)
  for (const secret of Object.values(K)) assert.equal(json.includes(secret), false, '明文 key 泄漏到 list()')
  assert.equal(list.find((x) => x.id === 'a').maskedKey.startsWith('rh_c'), true)
  assert.equal(list.find((x) => x.id === 'a').label, '主号')
  // publicJSON 也不含明文
  assert.equal(JSON.stringify(p.publicJSON()).includes(K.cn1), false)
})

/* ─────────────────────────────── pick 基本语义 ─────────────────────────────── */

test('pick：priority 升序优先', () => {
  const c = fakeClock()
  const p = poolWith(c, [
    { id: 'low', key: K.cn1, region: 'cn', priority: 5 },
    { id: 'high', key: K.cn2, region: 'cn', priority: 1 },
  ])
  assert.equal(p.pick({ region: 'cn' }).id, 'high')
})

test('pick：同优先级 → **最久未用优先**（lastUsedAt 最旧）', () => {
  const c = fakeClock()
  const p = poolWith(c, [
    { id: 'a', key: K.cn1, region: 'cn', priority: 0 },
    { id: 'b', key: K.cn2, region: 'cn', priority: 0 },
    { id: 'c', key: K.cn3, region: 'cn', priority: 0 },
  ])
  // 依次用 a、b、c → 之后应该轮回到 a
  assert.equal(p.pick({ region: 'cn' }).id, 'a')
  assert.equal(p.pick({ region: 'cn' }).id, 'b')
  assert.equal(p.pick({ region: 'cn' }).id, 'c')
  assert.equal(p.pick({ region: 'cn' }).id, 'a')
})

/** 任务书点名的场景 ①②：额度不足 → 换 key；401 → 标记失效并换 key。 */
test('report(QUOTA) → 换下一把；report(AUTH) → 标记失效并换下一把', () => {
  const c = fakeClock()
  const p = poolWith(c, [
    { id: 'a', key: K.cn1, region: 'cn' },
    { id: 'b', key: K.cn2, region: 'cn' },
  ])
  const first = p.pick({ region: 'cn' })
  assert.equal(first.id, 'a')
  p.report('a', 'QUOTA')
  assert.equal(p.list().find((x) => x.id === 'a').invalid, false, '额度不足只是冷却，不是失效')
  assert.ok(p.list().find((x) => x.id === 'a').cooldownUntil > 0)

  const second = p.pick({ region: 'cn' })
  assert.equal(second.id, 'b', '额度不足后必须换 key')
  p.report('b', 'AUTH')
  assert.equal(p.list().find((x) => x.id === 'b').invalid, true, '401 必须标记失效')

  // 两把都不可用 → 明确 NO_KEY/POOL_EMPTY，而不是硬塞一把
  const third = p.pick({ region: 'cn' })
  assert.equal(third.ok, false)
  assert.equal(third.error.code, 'POOL_EMPTY')
  assert.match(third.error.hint, /绝不跨池回退/)
})

test('冷却到期后重新可用（额度冷却 10 分钟）', () => {
  const c = fakeClock()
  const p = poolWith(c, [{ id: 'a', key: K.cn1, region: 'cn' }])
  p.report('a', 'QUOTA')
  assert.equal(p.pick({ region: 'cn' }).ok, false, '冷却中不可用')
  c.advance(COOLDOWNS.QUOTA - 1)
  assert.equal(p.pick({ region: 'cn' }).ok, false, '还没到期')
  c.advance(1)
  const again = p.pick({ region: 'cn' })
  assert.equal(again.ok, true, '到期后必须重新可用')
  assert.equal(again.id, 'a')
})

test('RATE_LIMIT 冷却 60s、TRANSPORT 冷却 30s（默认值锁定）', () => {
  assert.equal(COOLDOWNS.RATE_LIMIT, 60_000)
  assert.equal(COOLDOWNS.TRANSPORT, 30_000)
  assert.deepEqual(OUTCOMES, ['ok', 'AUTH', 'QUOTA', 'RATE_LIMIT', 'TRANSPORT'])

  const c = fakeClock()
  const p = poolWith(c, [{ id: 'a', key: K.cn1, region: 'cn' }])
  p.report('a', 'RATE_LIMIT')
  assert.equal(p.list()[0].cooldownRemainingMs, 60_000)
  c.advance(60_000)
  assert.equal(p.pick({ region: 'cn' }).ok, true)

  p.report('a', 'TRANSPORT')
  assert.equal(p.list()[0].cooldownRemainingMs, 30_000)
  c.advance(30_000)
  assert.equal(p.pick({ region: 'cn' }).ok, true)
})

test('report(report|ok) 清掉冷却', () => {
  const c = fakeClock()
  const p = poolWith(c, [{ id: 'a', key: K.cn1, region: 'cn' }])
  p.report('a', 'QUOTA')
  assert.ok(p.list()[0].cooldownRemainingMs > 0)
  p.report('a', 'ok')
  assert.equal(p.list()[0].cooldownRemainingMs, 0)
  assert.equal(p.pick({ region: 'cn' }).ok, true)
})

test('report：自定义 cooldownMs 覆盖默认', () => {
  const c = fakeClock()
  const p = poolWith(c, [{ id: 'a', key: K.cn1, region: 'cn' }])
  p.report('a', 'QUOTA', { cooldownMs: 1000 })
  assert.equal(p.list()[0].cooldownRemainingMs, 1000)
})

/* ───────────────────────────── 跨池绝不回退（硬边界） ───────────────────────────── */

test('**跨池绝不回退**：cn 池空了也不返回海外 key', () => {
  const c = fakeClock()
  const p = poolWith(c, [{ id: 'ov', key: K.ov1, region: 'overseas', priority: 0 }])
  const r = p.pick({ region: 'cn' })
  assert.equal(r.ok, false)
  assert.equal(r.error.code, 'NO_KEY')
  assert.equal('key' in r, false, '失败结果里绝不能带 key')
  const s = JSON.stringify(r)
  assert.equal(s.includes(K.ov1), false)
  assert.equal(s.includes('dddddddddddd'), false)
  // 反向同理
  const p2 = poolWith(c, [{ id: 'cn', key: K.cn1, region: 'cn' }])
  const r2 = p2.pick({ region: 'overseas' })
  assert.equal(r2.ok, false)
  assert.equal(r2.error.code, 'NO_KEY')
})

test('pick：exclude 跳过指定 id；默认 region=cn', () => {
  const c = fakeClock()
  const p = poolWith(c, [
    { id: 'a', key: K.cn1, region: 'cn' },
    { id: 'b', key: K.cn2, region: 'cn' },
  ])
  assert.equal(p.pick({ region: 'cn', exclude: ['a'] }).id, 'b')
  assert.equal(p.pick().id, 'a', '不给 region 时默认 cn')
})

test('pick：禁用/失效的 key 永不被选中，但也不阻塞同池其它 key', () => {
  const c = fakeClock()
  const p = poolWith(c, [
    { id: 'a', key: K.cn1, region: 'cn', enabled: false },
    { id: 'b', key: K.cn2, region: 'cn' },
  ])
  assert.equal(p.pick({ region: 'cn' }).id, 'b', '禁用的 a 不该被选中')
  p.report('b', 'AUTH')
  assert.equal(p.pick({ region: 'cn' }).ok, false, 'a 禁用 + b 失效 → 无可用')
  c.advance(1000)
  p.update('a', { enabled: true })
  assert.equal(p.pick({ region: 'cn' }).id, 'a', '启用后 a 从未用过 → 最旧优先')
  c.advance(1000)
  p.reset('b')
  assert.equal(p.pick({ region: 'cn' }).id, 'b', 'b 停用更久（lastUsedAt 更旧）')
  c.advance(1000)
  p.update('a', { priority: -1 })
  assert.equal(p.pick({ region: 'cn' }).id, 'a', 'priority 升序优先于 lastUsedAt')
})

/* ─────────────────────────────── 持久化 ─────────────────────────────── */

test('toJSON / fromJSON：冷却 / 失效 / lastUsedAt 都能往返', () => {
  const c = fakeClock()
  const p = poolWith(c, [
    { id: 'a', key: K.cn1, region: 'cn' },
    { id: 'b', key: K.cn2, region: 'cn' },
  ])
  p.pick({ region: 'cn' })
  p.report('b', 'QUOTA')
  p.report('a', 'AUTH')
  const state = p.toJSON()

  const p2 = new KeyPool({ now: c.now })
  const r = p2.fromJSON(state)
  assert.equal(r.ok, true)
  assert.equal(r.count, 2)
  assert.equal(JSON.stringify(p2.list()), JSON.stringify(p.list()))
  assert.equal(p2.rawKey('a'), K.cn1, '明文 key 必须完整往返（它落的是 0600 的 secrets）')
  // 恢复后语义一致：两把都不可用
  assert.equal(p2.pick({ region: 'cn' }).ok, false)
})

test('onPersist：每次状态变化都被回调一次（落盘钩子）', () => {
  const c = fakeClock()
  let n = 0
  const p = new KeyPool({ now: c.now, onPersist: () => (n += 1) })
  p.add({ id: 'a', key: K.cn1, region: 'cn' })
  p.pick({ region: 'cn' })
  p.report('a', 'ok')
  assert.ok(n >= 3)
})

test('onPersist 抛异常不影响内存态', () => {
  const c = fakeClock()
  const p = new KeyPool({
    now: c.now,
    onPersist: () => {
      throw new Error('磁盘满了')
    },
  })
  assert.equal(p.add({ id: 'a', key: K.cn1, region: 'cn' }).ok, true)
  assert.equal(p.pick({ region: 'cn' }).ok, true)
})

/* ─────────────────────────────── poolStats ─────────────────────────────── */

test('poolStats：两池分别统计总数与可用数', () => {
  const c = fakeClock()
  const p = poolWith(c, [
    { id: 'a', key: K.cn1, region: 'cn' },
    { id: 'b', key: K.cn2, region: 'cn' },
    { id: 'o', key: K.ov1, region: 'overseas' },
  ])
  assert.deepEqual(p.poolStats(), { cn: { total: 2, available: 2 }, overseas: { total: 1, available: 1 } })
  p.report('a', 'QUOTA')
  p.report('b', 'AUTH')
  assert.deepEqual(p.poolStats(), { cn: { total: 2, available: 0 }, overseas: { total: 1, available: 1 } })
})

/* ─────────────────────────────── detectRegion ─────────────────────────────── */

test('detectRegion：cn 命中就是 cn；cn 失败 overseas 命中就是 overseas；都失败 = invalid', async () => {
  const calls = []
  const mk = (okRegion) => ({
    async accountStatus(key, region) {
      calls.push(region)
      if (region === okRegion) return { ok: true, data: { remainCoins: '1' } }
      return { ok: false, error: { code: 'AUTH', message: 'invalid' } }
    },
  })
  assert.equal(await detectRegion(mk('cn'), K.cn1), 'cn')
  calls.length = 0
  assert.equal(await detectRegion(mk('overseas'), K.ov1), 'overseas')
  assert.deepEqual(calls, ['cn', 'overseas'], '必须先探 cn 再探 overseas')
  assert.equal(await detectRegion(mk(null), 'x'), 'invalid')
  assert.equal(await detectRegion(null, 'x'), 'invalid')
})

test('detectRegion：缓存命中就不再发请求', async () => {
  let hits = 0
  const api = {
    async accountStatus() {
      hits += 1
      return { ok: true, data: {} }
    },
  }
  const mem = new Map()
  const cache = { get: (k) => mem.get(k), set: (k, v) => mem.set(k, v) }
  assert.equal(await detectRegion(api, K.cn1, { cache }), 'cn')
  assert.equal(hits, 1)
  assert.equal(await detectRegion(api, K.cn1, { cache }), 'cn')
  assert.equal(hits, 1, '第二次必须走缓存')
  assert.equal(mem.size, 1)
  assert.equal([...mem.keys()][0].includes(K.cn1), false, '缓存键也必须是掩码')
})

test('detectRegion：accountStatus 抛异常也不炸（返回 invalid）', async () => {
  const api = {
    async accountStatus() {
      throw new Error('网络炸了')
    },
  }
  assert.equal(await detectRegion(api, K.cn1), 'invalid')
})

/* ─────────────────────────────── 其他 ─────────────────────────────── */

test('addMany / suggestId / update / remove / reset', () => {
  const c = fakeClock()
  const p = new KeyPool({ now: c.now })
  const r = p.addMany(['  ', K.cn1, { key: K.cn2, label: '备用' }], { region: 'auto' })
  assert.deepEqual([r.added, r.skipped], [2, 1])
  assert.equal(KeyPool.suggestId('国内 主号', 'cn'), 'cn-国内-主号')
  assert.equal(p.remove('不存在').ok, false)
  assert.equal(p.update('不存在', {}).ok, false)
  assert.equal(p.reset('不存在').ok, false)
  assert.equal(p.report('不存在', 'ok').ok, false)
  assert.equal(p.rawKey('不存在'), undefined)
  assert.equal(p.remove(r.ids[0]).ok, true)
  assert.equal(p.size, 1)
})

test('返回值是 lossless JSON（可 JSON.parse(JSON.stringify(x)) 往返）', () => {
  const c = fakeClock()
  const p = poolWith(c, [{ id: 'a', key: K.cn1, region: 'cn' }])
  for (const v of [p.list(), p.poolStats(), p.publicJSON(), p.pick({ region: 'cn' }), p.pick({ region: 'overseas' })]) {
    assert.deepEqual(JSON.parse(JSON.stringify(v)), v)
  }
})
