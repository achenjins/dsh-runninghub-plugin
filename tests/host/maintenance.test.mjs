import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Store } from '../../host/core/store.mjs'
import { scrubLegacySecrets } from '../../tools/scrub-legacy-secrets.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const PACKAGE = 'dsh-runninghub-plugin'
const legacyPool = { entries: [{ id: 'legacy', key: 'synthetic-review-key', region: 'cn' }] }
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value))
const readJson = async (file) => JSON.parse(await fs.readFile(file, 'utf8'))

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-maintenance-'))
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), dir)
    assert.ok(relative.startsWith('rh-maintenance-') && !relative.includes(path.sep))
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return dir
}

async function legacyFixture(t) {
  const dir = await temporary(t)
  const state = { keys: legacyPool, keep: 'unrelated' }
  await writeJson(path.join(dir, 'state.json'), state)
  await writeJson(path.join(dir, 'state.json.bak-review'), state)
  await writeJson(path.join(dir, 'secrets.json'), { pool: { entries: [] } })
  await writeJson(path.join(dir, 'secrets.json.prescrub-review'), { pool: legacyPool })
  return dir
}

test('旧 Key 清理先把非空旧池迁移到空 secrets 池，再清理旧副本', async (t) => {
  const dir = await legacyFixture(t)
  await scrubLegacySecrets({ dataDir: dir })
  assert.deepEqual((await readJson(path.join(dir, 'secrets.json'))).pool, legacyPool)
  const state = await readJson(path.join(dir, 'state.json'))
  assert.equal(state.keys, undefined)
  assert.equal(state.keep, 'unrelated')
  assert.ok(state.legacyKeysMigratedAt > 0)
  assert.deepEqual(await readJson(path.join(dir, 'state.json.bak-review')), { keep: 'unrelated' })
  assert.equal((await fs.readdir(dir)).includes('secrets.json.prescrub-review'), false)
  await scrubLegacySecrets({ dataDir: dir })
  assert.deepEqual((await readJson(path.join(dir, 'secrets.json'))).pool, legacyPool)
})

test('旧 Key 迁移保存失败时保留当前记录和每一份恢复副本', async (t) => {
  const dir = await legacyFixture(t)
  const files = await fs.readdir(dir)
  const before = await Promise.all(files.map(file => fs.readFile(path.join(dir, file), 'utf8')))
  t.mock.method(Store.prototype, 'writeSecrets', async () => ({ ok: false, error: { message: 'synthetic disk full' } }))
  await assert.rejects(scrubLegacySecrets({ dataDir: dir }), /synthetic disk full/)
  assert.deepEqual(await fs.readdir(dir), files)
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(path.join(dir, file), 'utf8'))), before)
})

test('损坏的当前池不能作为已迁移证明，空旧池也不能遮住恢复副本', async (t) => {
  for (const legacy of [legacyPool, { entries: [{}] }]) {
    const dir = await legacyFixture(t)
    await writeJson(path.join(dir, 'secrets.json'), { pool: { entries: [{}] } })
    await writeJson(path.join(dir, 'state.json'), { keys: legacy, keep: true })
    await scrubLegacySecrets({ dataDir: dir })
    assert.deepEqual((await readJson(path.join(dir, 'secrets.json'))).pool, legacyPool)
    assert.equal((await readJson(path.join(dir, 'state.json'))).keys, undefined)
  }
})

test('没有非空当前池或旧池时不清理可能仍可恢复的机密备份', async (t) => {
  const dir = await temporary(t)
  await writeJson(path.join(dir, 'secrets.json'), { pool: { entries: [] } })
  await writeJson(path.join(dir, 'secrets.json.prescrub-review'), { pool: legacyPool })
  await scrubLegacySecrets({ dataDir: dir })
  assert.deepEqual(await readJson(path.join(dir, 'secrets.json.prescrub-review')), { pool: legacyPool })
})

test('空 secrets 池也能从旧 state 备份恢复 Key', async (t) => {
  const dir = await temporary(t)
  await writeJson(path.join(dir, 'secrets.json'), { pool: { entries: [] } })
  await writeJson(path.join(dir, 'state.json.bak-review'), { keys: legacyPool, keep: true })
  await scrubLegacySecrets({ dataDir: dir })
  assert.deepEqual((await readJson(path.join(dir, 'secrets.json'))).pool, legacyPool)
  assert.deepEqual(await readJson(path.join(dir, 'state.json.bak-review')), { keep: true })
})

test('bundle 与 patch 双向切换始终只保留一个注册并保留其它插件', async (t) => {
  const dir = await temporary(t)
  const profile = path.join(dir, 'profiles', 'web')
  await fs.mkdir(profile, { recursive: true })
  const packageFile = path.join(profile, 'package.json')
  const patchFile = path.join(profile, 'cordis.patch.yml')
  await writeJson(packageFile, { name: 'synthetic-profile', private: true, dependencies: { other: '*' }, dsh: { profile: { bundles: ['other'] } } })
  await fs.writeFile(patchFile, '- insert:\n    - id: other\n      name: other\n')
  const install = (args) => execFileSync(process.execPath, ['tools/install.mjs', '--profile', 'web', ...args], {
    cwd: ROOT, env: { ...process.env, DSH_HOME: dir }, encoding: 'utf8', windowsHide: true,
  })
  install([])
  const bundlePackage = await fs.readFile(packageFile, 'utf8')
  const bundlePatch = await fs.readFile(patchFile, 'utf8')
  install(['--patch', '--dry-run'])
  assert.equal(await fs.readFile(packageFile, 'utf8'), bundlePackage)
  assert.equal(await fs.readFile(patchFile, 'utf8'), bundlePatch)
  install(['--patch'])
  install(['--patch'])
  let pkg = await readJson(packageFile)
  assert.deepEqual(pkg.dsh.profile.bundles, ['other'])
  assert.ok(pkg.dependencies[PACKAGE].startsWith('link:'))
  assert.equal(pkg.dependencies.other, '*')
  let patch = await fs.readFile(patchFile, 'utf8')
  assert.equal((patch.match(/id: dsh-runninghub-plugin/g) || []).length, 1)
  assert.match(patch, /id: other/)
  install([])
  pkg = await readJson(packageFile)
  assert.deepEqual(pkg.dsh.profile.bundles, ['other', PACKAGE])
  patch = await fs.readFile(patchFile, 'utf8')
  assert.doesNotMatch(patch, /id: dsh-runninghub-plugin/)
  assert.match(patch, /id: other/)
})

test('patch 安装支持没有 package.json 的旧 profile', async (t) => {
  const dir = await temporary(t)
  const profile = path.join(dir, 'profiles', 'web')
  await fs.mkdir(profile, { recursive: true })
  execFileSync(process.execPath, ['tools/install.mjs', '--profile', 'web', '--patch'], {
    cwd: ROOT, env: { ...process.env, DSH_HOME: dir }, encoding: 'utf8', windowsHide: true,
  })
  assert.match(await fs.readFile(path.join(profile, 'cordis.patch.yml'), 'utf8'), /id: dsh-runninghub-plugin/)
})
