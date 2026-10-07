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
import { buildMethods } from '../../host/rpc.mjs'
import { makeCallTool } from '../../host/tools/call.mjs'
import { makeSearchTool } from '../../host/tools/search.mjs'

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

    assert.equal((await rt.flushPersistence()).ok, true, 'Key 持久化必须成功')
    const files = await walk(dir)

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
    const stateText = await readFile(statePath, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null // 尚未写非机密状态。
      throw error
    })
    if (stateText !== null) assert.equal(JSON.parse(stateText).keys, undefined, 'state.json 里不该有 keys 字段')
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

    // initRuntime 返回时迁移应已完成，无需再次轮询。
    const stateText = await readFile(path.join(dir, 'state.json'), 'utf8')
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
    const rt = await boot(dir)
    const call = makeCallTool(() => rt)
    const search = makeSearchTool()
    const add = await buildMethods(rt).keysAdd({ entry: { key: PLAINTEXT, region: 'cn', label: '回执测试' } })
    const keys = await call.execute({ action: 'account.keys' }, {})
    const diag = await call.execute({ action: 'diagnostics' }, {})
    const srch = await search.execute({}, {})

    for (const [name, out] of [['keysAdd', add], ['account.keys', keys], ['diagnostics', diag], ['search', srch]]) {
      const text = JSON.stringify(out)
      assert.ok(!text.includes(PLAINTEXT), '**' + name + ' 的回执里出现了明文 Key**')
    }
    assert.match(JSON.stringify(keys), /\*\*\*\*/, 'account.keys 应给出掩码形式')
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})
