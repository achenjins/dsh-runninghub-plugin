/**
 * 一次性收尾：把真机上**已经被旧版写出去的明文 Key** 迁移并清理干净。
 *
 * 背景：旧版 `host/runtime.mjs` 把 KeyPool 状态（**含明文 key**）写进了 `state.json`，
 * 而 `state.json` 还会被自动备份成 `.bak-<ts>`。修复后的插件在启动时会自动迁移
 * （读 `state.keys` → 写 `secrets.json` → 抹掉 `state.json` 里的 keys），
 * 但 **`.bak-*` 备份不在自动迁移范围内**，必须显式删掉，否则明文会一直躺在盘上。
 *
 * 本脚本做的事情，与插件启动时的新逻辑一致 —— 只是现在就跑，不用等重启：
 *   1. 备份现场（万一要回滚）
 *   2. 把 state.json 里的 keys 迁进 secrets.json（0600）
 *   3. 抹掉 state.json 里的 keys 字段
 *   4. 删除所有含明文 Key 的 `state.json.bak-*`
 *   5. 扫盘复核：除 secrets.json 外，任何文件都不含明文 Key
 *
 *   node tools/scrub-legacy-secrets.mjs [--dataDir <路径>] [--dry-run]
 *
 * @module dsh-runninghub-plugin/tools/scrub-legacy-secrets
 */

import path from 'node:path'
import os from 'node:os'
import { readdir, readFile, writeFile, copyFile, unlink, stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const di = argv.indexOf('--dataDir')
const dataDir = path.resolve(
  di >= 0 && argv[di + 1] ? argv[di + 1] : path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'runninghub'),
)

const log = (s) => process.stdout.write(s + String.fromCharCode(10))

/** 递归列出所有文件。 */
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

/** 从任意 JSON 文本里挖出所有"像 API Key"的明文串（用来扫盘复核，不预设具体值）。 */
function keyLikeStrings(text) {
  const out = new Set()
  // RunningHub 的 key 是 32 位十六进制；也兼容更长的 alnum/_- 串
  for (const m of String(text).matchAll(/"([0-9a-f]{32})"/gi)) out.add(m[1])
  for (const m of String(text).matchAll(/"([A-Za-z0-9_-]{32,64})"/g)) out.add(m[1])
  return out
}

async function main() {
  log('[scrub] 数据目录：' + dataDir)
  log('[scrub] 模式：' + (dryRun ? 'dry-run（不落盘）' : '实际执行'))

  const files = await walk(dataDir)
  if (files.length === 0) {
    log('  目录为空或不存在 —— 没有需要清理的东西。')
    return
  }

  const statePath = path.join(dataDir, 'state.json')
  const secretsPath = path.join(dataDir, 'secrets.json')

  let state = {}
  try {
    state = JSON.parse(await readFile(statePath, 'utf8'))
  } catch {
    state = {}
  }
  let secrets = {}
  try {
    secrets = JSON.parse(await readFile(secretsPath, 'utf8'))
  } catch {
    secrets = {}
  }

  const legacyPool = state.keys
  const legacyKeys = legacyPool ? keyLikeStrings(JSON.stringify(legacyPool)) : new Set()
  log('  state.json 里是否有旧版 Key 池：' + (legacyPool ? '**是**（含 ' + String(legacyKeys.size) + ' 个明文 Key）' : '否'))
  log('  secrets.json 是否已存在：' + (Object.keys(secrets).length > 0 ? '是' : '否'))

  // 找出所有含明文 Key 的备份文件
  const tainted = []
  for (const f of files) {
    if (f.abs === secretsPath) continue
    let text = ''
    try {
      text = await readFile(f.abs, 'utf8')
    } catch {
      continue
    }
    if (keyLikeStrings(text).size > 0) tainted.push(f.rel)
  }
  log('  含明文 Key 的非机密文件：' + (tainted.length === 0 ? '无（干净）' : tainted.join(' / ')))

  if (dryRun) {
    log('[scrub] dry-run：以上是**将会**进行的改动，未落盘。')
    return
  }

  // 幂等：没有任何东西要改，就别做任何写入（尤其别留回滚备份 —— 那是又一份明文副本）
  if (!legacyPool && tainted.length === 0) {
    log('')
    log('[scrub] 没有任何需要改动的东西 → **不做任何写入**（幂等，不留备份）。')
    return
  }

  // ① 备份现场
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const f of ['state.json', 'secrets.json']) {
    const p = path.join(dataDir, f)
    try {
      await stat(p)
      await copyFile(p, p + '.prescrub-' + stamp)
      log('  ↳ 已备份 ' + f + ' → ' + f + '.prescrub-' + stamp)
    } catch {
      /* 文件不存在，跳过 */
    }
  }

  // ② 迁移 keys → secrets.json
  if (legacyPool) {
    const merged = { ...secrets }
    if (!merged.pool) merged.pool = legacyPool
    merged.updatedAt = Date.now()
    await writeFile(secretsPath, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 })
    try {
      const { chmod } = await import('node:fs/promises')
      await chmod(secretsPath, 0o600)
    } catch {
      /* Windows 上是 no-op */
    }
    log('  ✅ 已把 Key 池迁移到 secrets.json（并尝试 0600）')
  }

  // ③ 抹掉 state.json 里的 keys（必须整体覆写 —— saveState 是浅合并，删不掉字段）
  if (legacyPool) {
    delete state.keys
    state.legacyKeysMigratedAt = Date.now()
    await writeFile(statePath, JSON.stringify(state, null, 2), 'utf8')
    log('  ✅ 已抹掉 state.json 的 keys 字段（其它字段保留）')
  }

  // ④ 删掉仍含明文的非机密文件
  //
  // ⚠️ 必须**在改写之后再扫一遍**，不能直接用 ① 之前那份 tainted 清单：
  // 刚才被我们重写成干净内容的 `state.json` 也在那份清单里，照着删会把它一起删掉
  // （第一版就是这么写的，实测把刚写好的干净 state.json 也删了 —— 无害但没必要）。
  const afterRewrite = await walk(dataDir)
  const stillTainted = []
  for (const f of afterRewrite) {
    if (f.abs === secretsPath) continue
    let text = ''
    try {
      text = await readFile(f.abs, 'utf8')
    } catch {
      continue
    }
    if (keyLikeStrings(text).size > 0) stillTainted.push(f.rel)
  }

  let removed = 0
  for (const rel of stillTainted) {
    try {
      await unlink(path.join(dataDir, rel))
      removed += 1
      log('  ✅ 已删除含明文 Key 的文件：' + rel)
    } catch (e) {
      log('  ⚠ 删除失败 ' + rel + '：' + String((e && e.message) || e))
    }
  }
  const keptClean = tainted.filter((t) => !stillTainted.includes(t))
  if (keptClean.length > 0) log('  ↳ 这些文件已被就地改写干净，保留：' + keptClean.join(' / '))

  // ⑤ 扫盘复核
  const after = await walk(dataDir)
  const still = []
  for (const f of after) {
    if (f.abs === secretsPath) continue
    if (f.rel.includes('.prescrub-')) continue // 我们自己的回滚备份，下面单独说明
    let text = ''
    try {
      text = await readFile(f.abs, 'utf8')
    } catch {
      continue
    }
    if (keyLikeStrings(text).size > 0) still.push(f.rel)
  }
  log('')
  log('[scrub] 结果：删除明文文件 ' + String(removed) + ' 个')
  log('[scrub] 复核：除 secrets.json 外' + (still.length === 0 ? '**已无明文 Key** ✅' : '仍有 ' + still.join(' / ') + ' ❌'))
  log('')
  log('  注意：`*.prescrub-' + stamp + '` 是我们刚做的回滚备份，**里面同样含明文 Key**。')
  log('        确认没问题后请手动删掉它们：')
  log('          Remove-Item "' + dataDir + '\\*.prescrub-*"')
}

main().catch((e) => {
  log('❌ 清理失败：' + String((e && e.stack) || e))
  process.exit(1)
})
