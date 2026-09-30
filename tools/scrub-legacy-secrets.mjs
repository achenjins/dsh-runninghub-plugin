/** Migrate legacy Key fields without deleting unrelated workflow or task files. */
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { Store, resolveDataDir } from '../host/core/store.mjs'

async function readOptionalJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error('Cannot read ' + path.basename(file) + (error instanceof SyntaxError ? ': invalid JSON' : ': ' + error.message))
  }
}

export async function scrubLegacySecrets({ dataDir = resolveDataDir(), dryRun = false, log = () => {} } = {}) {
  const store = new Store({ dataDir })
  const state = await readOptionalJson(store.resolve('state.json'))
  const secrets = await readOptionalJson(store.resolve('secrets.json'))
  const legacyPool = state.keys || (!secrets.pool && await store.findLegacyKeyPool())
  const names = await store.fs.readdir(store.dataDir).catch((error) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  const backups = names.filter((name) => /^(state|secrets)\.json\.(bak-|prescrub-)/.test(name))
  log('数据目录：' + store.dataDir)
  log('旧 Key 池：' + (legacyPool ? '存在' : '无'))
  log('待检查的历史备份：' + backups.length)
  if (dryRun) {
    log('预览结束，未修改文件。仅处理 state 的 keys 字段和已知的机密备份。')
    return { ok: true, dryRun: true, legacyPool: !!legacyPool, backups: backups.length }
  }

  // Save the pool first. Never remove its only surviving copy after a failed write.
  if (legacyPool && !secrets.pool) {
    const saved = await store.writeSecrets({ ...secrets, pool: legacyPool, updatedAt: Date.now() })
    if (!saved.ok) throw new Error(saved.error.message)
    log('Key 池已保存到 secrets.json。')
  }
  if (state.keys) {
    delete state.keys
    state.legacyKeysMigratedAt = Date.now()
    const saved = await store.writeJson('state.json', state, { backup: false })
    if (!saved.ok) throw new Error(saved.error.message)
    log('state.json 的旧 Key 字段已清理，其它字段保留。')
  }
  // A readable current secrets pool must exist before discarding historical copies.
  if ((await readOptionalJson(store.resolve('secrets.json'))).pool) {
    const result = await store.scrubLegacySecretBackups()
    if (!result.ok) throw new Error('部分备份未能清理：' + result.errors.join('；'))
    log('已清理状态备份 ' + result.cleaned + ' 份，机密备份 ' + result.pruned + ' 份。')
  } else if (backups.length) {
    log('没有可用的当前 Key 池，保留历史备份供恢复。')
  }
  return { ok: true }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const di = argv.indexOf('--dataDir')
  if (di >= 0 && (!argv[di + 1] || argv[di + 1].startsWith('--'))) {
    process.stderr.write('--dataDir 需要一个目录路径\n')
    process.exitCode = 1
  } else {
    scrubLegacySecrets({
      dataDir: di >= 0 ? argv[di + 1] : resolveDataDir(),
      dryRun: argv.includes('--dry-run'),
      log: (message) => process.stdout.write(message + '\n'),
    }).catch((error) => {
      process.stderr.write('清理失败：' + error.message + '\n')
      process.exitCode = 1
    })
  }
}
