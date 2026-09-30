/**
 * 一键安装 / 卸载到 DSH profile（幂等、带备份、可回滚）
 *
 * ## 两种装配方式（**二选一，同时存在会重复注册同名工具**）
 *
 * | 方式 | 怎么做 | 出现在「插件」页面？ | 适用 |
 * |---|---|---|---|
 * | **bundle**（默认，推荐） | profile 的 `package.json` → `dependencies`(link:) + `dsh.profile.bundles` | ✅ 会 | 想让它像正式插件一样可见 / 可启停 |
 * | `--patch`（旧法） | profile 的 `cordis.patch.yml` 里 insert 一段 | ❌ 不会 | 不方便改 package.json 时 |
 *
 * 我最初用了 `--patch`，结果用户打开「插件」页面**找不到它** ——
 * 那个页面列的是 **`dsh.profile.bundles`**，而手工 insert 只是 loader 条目，不在清单里。
 * 所以现在默认走 bundle 方式。
 *
 *   node tools/install.mjs                  # bundle 方式装到 desktop profile
 *   node tools/install.mjs --patch          # 用补丁层 insert 方式装（旧法）
 *   node tools/install.mjs --profile web    # 装到别的 profile
 *   node tools/install.mjs --dry-run        # 只看会改什么，不落盘
 *   node tools/install.mjs --uninstall      # 卸载（两种方式都还原）
 *
 * @module dsh-runninghub-plugin/tools/install
 */

import path from 'node:path'
import os from 'node:os'
import { readFile, writeFile, copyFile, mkdir, lstat, symlink, rm, readlink, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG_NAME = 'dsh-runninghub-plugin'
const ENTRY_ID = 'dsh-runninghub-plugin'
const MARKER = '# >>> dsh-runninghub-plugin (managed by tools/install.mjs)'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes('--' + name)
const opt = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}

const dryRun = flag('dry-run')
const uninstall = flag('uninstall')
const profileName = opt('profile', process.env.DSH_PROFILE || 'desktop')
const dshHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh')
const profileDir = path.join(dshHome, 'profiles', profileName)
const patchPath = path.join(profileDir, 'cordis.patch.yml')
const pkgJsonPath = path.join(profileDir, 'package.json')
const linkPath = path.join(profileDir, 'node_modules', PKG_NAME)

const log = (...a) => process.stdout.write(a.join(' ') + String.fromCharCode(10))
const say = (icon, msg) => log('  ' + icon + ' ' + msg)

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** 待追加的补丁片段（幂等：先按 loadEntryIds 查重）。 */
const PATCH_BLOCK = [
  '',
  MARKER,
  '# 与 package.json 的 dsh.profile.bundles **二选一**（都写会重复注册同名工具）。',
  '# 卸载：node tools/install.mjs --uninstall',
  '- insert:',
  '    - id: ' + ENTRY_ID,
  '      name: ' + PKG_NAME,
  '      config:',
  '        registerSkill: true',
  '        exposeClientPanel: true',
  '',
].join(String.fromCharCode(10))

/* ────────────────────────── YAML 解析（只做到够用，不引依赖） ────────────────────────── */

/**
 * 把一个 YAML 顶层补丁文本切成「顶层条目」。
 *
 * 顶层条目 = 以 `- ` 开头的行，到下一个顶层 `- ` 行为止（含中间所有缩进行）。
 * 注释行跟着它**前面**的条目走 —— 这样「注释 + insert」会被当成一段，
 * 删除时不会留下孤儿注释。
 *
 * @param {string} text cordis.patch.yml 原文
 * @returns {Array<{lines: string[], start: number, end: number}>}
 */
function topLevelEntries(text) {
  const lines = String(text == null ? '' : text).split(String.fromCharCode(10))
  const entries = []
  let pendingComments = []
  let cur = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^-\s/.test(line)) {
      if (cur) {
        cur.end = i
        entries.push(cur)
      }
      cur = { lines: [...pendingComments, line], start: i - pendingComments.length, end: lines.length }
      pendingComments = []
      continue
    }
    if (/^\s*#/.test(line) || line.trim() === '') {
      if (cur) cur.lines.push(line)
      else pendingComments.push(line)
      continue
    }
    if (cur) cur.lines.push(line)
    else pendingComments.push(line)
  }
  if (cur) entries.push(cur)
  return entries
}

/** 一个顶层条目是不是「装载本插件的 insert」。 */
function isOurInsert(entry) {
  const block = entry.lines.join(String.fromCharCode(10))
  if (!/^\s*-\s*insert:\s*$/m.test(block)) return false
  return new RegExp('^\\s*-\\s*id:\\s*[\'"]?' + ENTRY_ID + '[\'"]?\\s*$', 'm').test(block)
}

/** 该 insert 条目里一共有几个 `- id:`（用来判断是不是"只装了我们的"）。 */
function idCount(entry) {
  return entry.lines.filter((l) => /^\s*-\s*id:\s*\S/.test(l)).length
}

/** 找出「装载本插件」的顶层条目索引。 */
function findOurEntries(text) {
  const entries = topLevelEntries(text)
  const hits = []
  entries.forEach((e, idx) => {
    // 直接命中：我们的 insert 段
    if (isOurInsert(e)) {
      hits.push({ idx, entry: e, kind: 'insert' })
      return
    }
    // 也可能被别人合并进他们自己的 insert（用户手工挪过），只报不删
    if (new RegExp('^\\s*-\\s*id:\\s*[\'"]?' + ENTRY_ID + '[\'"]?\\s*$', 'm').test(e.lines.join(String.fromCharCode(10)))) {
      hits.push({ idx, entry: e, kind: 'foreign-insert' })
    }
  })
  return { entries, hits }
}

async function main() {
  log('[install] 包目录：' + PKG_ROOT)
  log('[install] profile：' + profileDir)
  log('[install] 模式：' + (uninstall ? '卸载' : '安装') + (dryRun ? '（dry-run，不落盘）' : ''))

  if (!(await exists(profileDir))) {
    log('❌ profile 目录不存在：' + profileDir)
    log('   可用的 profile：')
    try {
      const { readdir } = await import('node:fs/promises')
      for (const d of await readdir(path.join(dshHome, 'profiles'), { withFileTypes: true })) {
        if (d.isDirectory()) log('     · ' + d.name)
      }
    } catch {
      /* 列不出来就算了 */
    }
    process.exit(1)
  }

  /* ── 读现状 ── */
  const patchRaw = (await exists(patchPath)) ? await readFile(patchPath, 'utf8') : ''
  const scan = findOurEntries(patchRaw)
  const ourInsert = scan.hits.find((h) => h.kind === 'insert') || null
  const foreignHit = scan.hits.find((h) => h.kind === 'foreign-insert') || null
  const hasBlock = ourInsert !== null
  let linkState = 'none'
  try {
    const st = await lstat(linkPath)
    if (st.isSymbolicLink()) linkState = 'link:' + String(await readlink(linkPath))
    else linkState = 'dir'
  } catch {
    linkState = 'none'
  }

  log('')
  log('[现状]')
  say(hasBlock ? '●' : '○', 'cordis.patch.yml 里' + (hasBlock ? '已有' : '没有') + '本插件的 insert 段')
  if (foreignHit) {
    say('⚠', '本插件的 id 出现在**别人**的 insert 段里（不是安装脚本写的）—— 卸载时会跳过它，请手动处理')
  }
  say(linkState === 'none' ? '○' : '●', 'node_modules/' + PKG_NAME + ' → ' + (linkState === 'none' ? '不存在' : linkState))

  /* ── 卸载 ── */
  if (uninstall) {
    log('')
    log('[卸载]')
    if (hasBlock) {
      // 只在「这一段 insert 里只有我们一个条目」时才整段删；否则拒绝，避免误删别人的插件
      const onlyOurs = idCount(ourInsert.entry) === 1
      if (!onlyOurs) {
        say('⚠', '这个 insert 段里还有别的条目（' + String(idCount(ourInsert.entry)) + ' 个），为安全起见**不自动删**')
        say('·', '请手动删除 ' + patchPath + ' 里 id 为 ' + ENTRY_ID + ' 的那一项')
      } else {
        const entries = scan.entries
        const kept = entries.filter((e) => e !== ourInsert.entry).map((e) => e.lines.join(String.fromCharCode(10))).join(String.fromCharCode(10))
        const next = kept.replace(/\n{3,}/g, String.fromCharCode(10, 10))
        if (dryRun) say('·', '会从 cordis.patch.yml 移除本插件的 insert 段（-' + String(patchRaw.length - next.length) + ' 字节）')
        else {
          await backup(patchPath)
          await writeFile(patchPath, next, 'utf8')
          say('✅', '已从 cordis.patch.yml 移除本插件的 insert 段')
        }
      }
    } else say('·', 'cordis.patch.yml 里没有本插件段落，跳过')

    // bundle 方式也要还原：从 dependencies 与 dsh.profile.bundles 里摘掉
    try {
      const pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8'))
      const inDep = !!(pkg.dependencies && pkg.dependencies[PKG_NAME])
      const inBundles = Array.isArray(pkg?.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes(PKG_NAME)
      if (!inDep && !inBundles) say('·', 'profile package.json 里没有本插件，跳过')
      else if (dryRun) say('·', '会从 profile package.json 移除 dependencies / dsh.profile.bundles 里的本插件')
      else {
        await backup(pkgJsonPath)
        if (pkg.dependencies) delete pkg.dependencies[PKG_NAME]
        if (Array.isArray(pkg?.dsh?.profile?.bundles)) {
          pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== PKG_NAME)
        }
        await writeFile(pkgJsonPath, JSON.stringify(pkg, null, 2) + String.fromCharCode(10), 'utf8')
        say('✅', '已从 profile package.json 摘掉本插件（bundle 方式）')
      }
    } catch (e) {
      say('⚠', '处理 profile package.json 失败：' + String((e && e.message) || e))
    }

    if (linkState !== 'none') {
      if (dryRun) say('·', '会删除链接 ' + linkPath)
      else {
        await rm(linkPath, { recursive: true, force: true })
        say('✅', '已删除 ' + linkPath)
      }
    } else say('·', '链接不存在，跳过')

    log('')
    log('[下一步] **重启 DSH** 卸载才生效。')
    log('  数据目录（工作流配置 / Key / 任务流水）没有动，要清就手动删 <DSH_HOME>/runninghub。')
    return
  }

  /* ── 安装 ── */
  log('')
  log('[安装]')

  // ① 链接
  if (linkState === 'none') {
    if (dryRun) say('·', '会创建链接 ' + linkPath + ' → ' + PKG_ROOT)
    else {
      await mkdir(path.dirname(linkPath), { recursive: true })
      // Windows 目录链接用 junction（不需要管理员权限），其它平台用 dir
      await symlink(PKG_ROOT, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
      say('✅', '已创建链接 ' + linkPath)
    }
  } else if (linkState.startsWith('link:')) {
    const target = linkState.slice(5)
    if (path.resolve(target).toLowerCase() === PKG_ROOT.toLowerCase()) say('✅', '链接已存在且指向本包')
    else say('⚠', '链接已存在但指向别处：' + target + '（要改就手动删掉重建）')
  } else say('⚠', linkPath + ' 是个真实目录，不是链接 —— 跳过（请手动处理）')

  // ② 装配方式
  const usePatch = flag('patch')
  if (usePatch) {
    // 旧法：补丁层 insert（**不会**出现在「插件」页面的清单里）
    if (hasBlock) say('✅', 'cordis.patch.yml 里已有 insert 段（幂等，不重复写）')
    else if (dryRun) say('·', '会往 cordis.patch.yml 追加 ' + String(PATCH_BLOCK.length) + ' 字节的 insert 段')
    else {
      await backup(patchPath)
      const next = patchRaw.endsWith(String.fromCharCode(10)) || patchRaw.length === 0 ? patchRaw + PATCH_BLOCK : patchRaw + String.fromCharCode(10) + PATCH_BLOCK
      await writeFile(patchPath, next, 'utf8')
      say('✅', '已往 cordis.patch.yml 追加 insert 段（原文件已备份）')
    }
  } else {
    // 新法（默认）：注册成 profile bundle —— 这样才会出现在「插件」页面，且可被启停
    let pkg = null
    try {
      pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8'))
    } catch (e) {
      say('❌', '读不到 profile package.json：' + String((e && e.message) || e))
      process.exit(1)
    }
    const spec = 'link:' + PKG_ROOT.replace(/\\/g, '/')
    const alreadyDep = pkg.dependencies && pkg.dependencies[PKG_NAME] === spec
    const alreadyBundle = Array.isArray(pkg?.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes(PKG_NAME)

    if (alreadyDep && alreadyBundle) {
      say('✅', 'profile 已是 bundle 方式（dependencies + bundles 都在，幂等）')
    } else if (dryRun) {
      say('·', '会写 `dependencies["' + PKG_NAME + '"] = "' + spec + '"`')
      say('·', '会把 `' + PKG_NAME + '` 加进 `dsh.profile.bundles`')
    } else {
      await backup(pkgJsonPath)
      pkg.dependencies = pkg.dependencies || {}
      pkg.dependencies[PKG_NAME] = spec
      pkg.dsh = pkg.dsh || {}
      pkg.dsh.profile = pkg.dsh.profile || {}
      pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
      if (!pkg.dsh.profile.bundles.includes(PKG_NAME)) pkg.dsh.profile.bundles.push(PKG_NAME)
      await writeFile(pkgJsonPath, JSON.stringify(pkg, null, 2) + String.fromCharCode(10), 'utf8')
      say('✅', '已把本包注册成 profile bundle（package.json 已备份）')
    }

    // bundle 方式与补丁段**互斥**：发现手工 insert 就移除，否则重启后会重复注册同名工具
    if (hasBlock) {
      if (dryRun) say('·', '会移除 cordis.patch.yml 里的手工 insert 段（避免重复注册）')
      else {
        const onlyOurs = idCount(ourInsert.entry) === 1
        if (!onlyOurs) {
          say('⚠', 'cordis.patch.yml 里那段 insert 还有别的条目，**不自动删** —— 请手动删掉 id 为 ' + ENTRY_ID + ' 的那一项')
        } else {
          const kept = scan.entries.filter((e) => e !== ourInsert.entry).map((e) => e.lines.join(String.fromCharCode(10))).join(String.fromCharCode(10))
          await backup(patchPath)
          await writeFile(patchPath, kept.replace(/\n{3,}/g, String.fromCharCode(10, 10)), 'utf8')
          say('✅', '已移除 cordis.patch.yml 里的手工 insert 段（bundle 与 patch 二选一）')
        }
      }
    }
    say('ℹ', 'bundle 方式还需要同步锁文件：在本 profile 目录跑一次 `pnpm install`')
  }

  log('')
  log('[下一步]')
  log('  1. 在本 profile 目录跑一次 `pnpm install`（bundle 方式需要它把 link: 写进锁文件）。')
  log('  2. **重启 DSH**。')
  log('  3. 重启后 **刷新浏览器页面**（Ctrl+R）—— 客户端插件要重新加载才会出现页签。')
  log('  4. 问模型：`runninghub_call({action:"diagnostics"})` —— 看到 `coreReady: true` 就是装好了。')
  log('  5. 「插件」页面里应能看到本插件（bundle 方式）；设置 → 插件里应有 RunningHub 页签。')
  log('')
  log('[回滚]')
  log('  node tools/install.mjs --profile ' + profileName + ' --uninstall')
  log('  或手工还原最近的 *.bak-rhplugin-* 备份。')
}

/** 覆盖前先备份（保留原文件名 + 时间戳）。 */
async function backup(p) {
  if (!(await exists(p))) return
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dst = p + '.bak-rhplugin-' + ts
  await copyFile(p, dst)
  log('  ↳ 已备份：' + path.basename(dst))
}

main().catch((e) => {
  log('❌ 安装脚本异常：' + String((e && e.stack) || e))
  process.exit(1)
})
