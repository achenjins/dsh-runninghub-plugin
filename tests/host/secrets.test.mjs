/**
 * 机密落盘卫生测试 —— **明文 API Key 只能出现在 `secrets.json` 里**
 *
 * 这条测试是被真事故逼出来的：KeyPool 的持久化状态里**含明文 key**
 * （runner 发请求要用它），而它一度被写进了 `state.json` ——
 * 一个普通权限、还会被自动备份成多份 `.bak` 的文件。
 * 等于把用户的 API Key 明文摊在磁盘上，正好违反本项目自己的红线。
 *
 * 判据（全部是**扫盘**，不是读代码）：
 *   1. 加了 Key 之后，数据目录里**除 `secrets.json` 外的任何文件**都不得出现明文 key（含 `.bak`）；
 *   2. `secrets.json` 里**必须**能找到它（否则重启就丢 Key，用户会以为插件坏了）；
 *   3. 旧版误写在 `state.json` 里的 `keys` 字段要被自动迁移 + 抹掉。
 *
 * @module dsh-runninghub-plugin/tests/host/secrets
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const PLAINTEXT = 'CN-SECRET-KEY-0123456789abcdef-XYZ'

/** 递归列出目录下所有文件。 */
async function walk(dir, base = dir, out = []) {
  let entries = []
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await walk(p, base, out)
    else out.push({ abs: p, rel: path.relative(base, p) })
  }
  return out
}

/**
 * 轮询等到条件成立（**不要用固定 sleep**）。
 *
 * 血泪：原来写的是 `await sleep(300)` 然后立刻断言 —— 单跑这个文件永远绿，
 * 但和 `e2e` / `rpc` 一起跑时（Node 测试运行器默认并行文件），事件循环被抢，
 * 落盘的几个异步 fs 操作在 300ms 内没跑完，就报"数据目录里一个文件都没有"。
 * **那是测试的缺陷，不是产品的缺陷** —— 固定 sleep 在并行环境下必然间歇性假红。
 *
 * @param {() => Promise<unknown>|unknown} fn 条件（真值即返回）
 * @param {{timeoutMs?:number, stepMs?:number}} [opts]
 * @returns {Promise<unknown|null>} 成立时的值；超时返回 null
 */
async function waitFor(fn, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, stepMs))
  }
}

/** 起一个「已装配」的宿主环境（用真 Store + 真 KeyPool + 真 runtime 装配路径）。 */
async function boot(dataDir) {
  const indexMod = await import(pathToFileURL(path.join(ROOT, 'host', 'index.mjs')).href + '?t=' + String(Date.now()))
  const runtimeMod = await import(pathToFileURL(path.join(ROOT, 'host', 'runtime.mjs')).href)

  const cfg = indexMod.normalizeConfig({ dataDir })
  const rt = runtimeMod.createRuntime({ ctx: { get: () => undefined, logger: {} }, config: cfg, logger: { info() {}, warn() {}, error() {} } })
  await runtimeMod.initRuntime(rt)
  assert.equal(rt.coreReady, true, '协议层应装载成功（核心层缺席时这条测试没有意义）')
  return rt
}

test('明文 API Key 只落 secrets.json；state.json 与其备份里都不得出现', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rh-secret-'))
  try {
    const rt = await boot(dir)

    // 加一把 key 并触发一次持久化（onPersist 是 KeyPool 状态变化时调的）
    const added = rt.pool.add({ key: PLAINTEXT, label: '单测用', region: 'cn', priority: 1, enabled: true })
    assert.ok(added && added.ok !== false, 'key.add 应成功')
    // 主动再触发一次 report，确保 onPersist 真的跑过（有些实现只在状态变化时回调）
    rt.pool.report(added.id, 'QUOTA')

    // 轮询等落盘完成（**不要固定 sleep** —— 并行跑测试时会假红，见 waitFor 的注释）
    const files = await waitFor(async () => {
      const f = await walk(dir)
      return f.length > 0 ? f : null
    })
    assert.ok(files, '数据目录在 5 秒内一个文件都没有 —— 说明根本没落盘，这条测试就没验到东西')

    const offenders = []
    for (const f of files) {
      let text = ''
      try {
        text = await readFile(f.abs, 'utf8')
      } catch {
        continue
      }
      if (text.includes(PLAINTEXT) && path.basename(f.rel) !== 'secrets.json') offenders.push(f.rel)
    }
    assert.deepEqual(offenders, [], '明文 Key 泄漏到了非机密文件：' + offenders.join(' / '))

    // 必须有一条能找到它，否则重启就丢 Key
    const secretsPath = path.join(dir, 'secrets.json')
    let secretsText = ''
    try {
      secretsText = await readFile(secretsPath, 'utf8')
    } catch {
      /* 下面断言会报 */
    }
    assert.ok(secretsText.includes(PLAINTEXT), 'secrets.json 里必须存着明文 Key（否则重启后 Key 会丢）')

    // 顺带确认状态文件里没有 keys 字段
    const statePath = path.join(dir, 'state.json')
    try {
      const st = JSON.parse(await readFile(statePath, 'utf8'))
      assert.equal(st.keys, undefined, 'state.json 里不该有 keys 字段')
    } catch {
      /* 没有 state.json 也算通过（没写过非机密状态） */
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('旧版误写在 state.json 里的 keys 会被迁移到 secrets.json 并抹掉', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rh-migrate-'))
  try {
    // 造一个"旧版留下的现场"：state.json 里有明文 keys
    await writeFile(
      path.join(dir, 'state.json'),
      JSON.stringify({ keys: { entries: [{ id: 'k1', key: PLAINTEXT, region: 'cn' }], version: 1 }, somethingElse: 42 }),
      'utf8',
    )

    const rt = await boot(dir)

    // 等迁移真的落盘（同样不用固定 sleep）
    const stateText = await waitFor(async () => {
      const t = await readFile(path.join(dir, 'state.json'), 'utf8').catch(() => '')
      try {
        return JSON.parse(t).keys === undefined ? t : null
      } catch {
        return null
      }
    })
    assert.ok(stateText, '5 秒内 state.json 里的 keys 仍未抹掉')
    assert.ok(!stateText.includes(PLAINTEXT), '迁移后 state.json 里不该再有明文 Key')
    const st = JSON.parse(stateText)
    assert.equal(st.keys, undefined, 'keys 字段应被抹掉')
    assert.equal(st.somethingElse, 42, '**只删 keys**，其它字段必须原样保留（别把人家的东西一起抹了）')
    assert.ok(st.legacyKeysMigratedAt > 0, '应留下迁移时间戳，便于排查')

    // 迁移过来的 key 应该还在池子里可用
    const list = rt.pool.list() || []
    assert.ok(list.some((k) => String(k.maskedKey).includes('****')), '迁移后池子里应还能看到（掩码形式的）Key')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

test('工具回执与诊断里不出现明文 Key（含密钥池列表）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rh-receipt-'))
  try {
    const indexMod = await import(pathToFileURL(path.join(ROOT, 'host', 'index.mjs')).href + '?t=' + String(Date.now()))
    const tools = []
    const services = {}
    const ctx = {
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      tools: { register: (d) => (tools.push(d), () => {}) },
      get: (n) => services[n],
      on: () => () => {},
      effect: (fn) => {
        const d = fn()
        return () => typeof d === 'function' && d()
      },
      inject: () => {},
    }
    indexMod.apply(ctx, { dataDir: dir })
    await new Promise((r) => setTimeout(r, 250))

    const call = tools.find((t) => t && t.name === 'runninghub_call')
    const search = tools.find((t) => t && t.name === 'runninghub_search')
    assert.ok(call && search, '两个工具都应注册')

    const add = await call.execute({ action: 'key.add', key: PLAINTEXT, region: 'cn', label: '回执测试' }, {})
    const keys = await call.execute({ action: 'account.keys' }, {})
    const diag = await call.execute({ action: 'diagnostics' }, {})
    const srch = await search.execute({ kind: 'all' }, {})

    for (const [name, out] of [['key.add', add], ['account.keys', keys], ['diagnostics', diag], ['search', srch]]) {
      const text = JSON.stringify(out)
      assert.ok(!text.includes(PLAINTEXT), '**' + name + ' 的回执里出现了明文 Key**')
    }
    assert.match(JSON.stringify(keys), /\*\*\*\*/, 'account.keys 应给出掩码形式')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
