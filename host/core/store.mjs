/**
 * `host/core/store.mjs` —— 插件数据目录读写（原子写 + 备份 + 坏文件容错 + 写串行化）
 *
 * 契约（**Lead 已锁定**）：
 *   - `resolveDataDir(opts)`：`opts.dataDir` → `env.DSH_HOME/runninghub` → `~/.dsh/runninghub`。
 *   - 所有方法 **async 且不抛**：读不到返回 `undefined`/`null`/`[]`，写失败返回 `{ok:false,error}`。
 *   - **原子写**：先写 `*.tmp-<rand>` 再 `fs.rename`；覆盖前把旧文件备份成 `<name>.bak-<ts>`，只留最近 5 份。
 *   - **坏文件不炸**：JSON.parse 失败 → 返回兜底值 + 记 warn，并把坏文件改名成 `.corrupt-<ts>` 留证。
 *   - **写串行化**：同一进程内同一路径的写按 FIFO 排队（简单 promise 链），并发 `saveTask` 不会互相截断。
 *   - `secrets.json` 落盘权限 **0600**（Windows 上 chmod 是尽力而为，会在 UI 上提示）。
 *
 * 目录布局（DESIGN §3.1）：
 * ```
 * <dataDir>/
 * ├── keys.json          非机密元数据
 * ├── secrets.json       API Key 本体（0600）
 * ├── state.json         key 冷却 / 上次用量快照
 * ├── workflows/<id>.json
 * ├── prompts/<id>.md  +  prompts/<id>.meta.json
 * ├── tasks/<taskId>.json
 * ├── outputs/<taskId>/…
 * └── logs/
 * ```
 *
 * @module dsh-runninghub-plugin/host/core/store
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { asString, toNumber, nowMs, lossless, errorShape, shortId, slugify } from './util.mjs'
import { normalizeStatus } from './api.mjs'
import { DEFAULT_TASK_LIMIT, parseTaskLimit } from '../task-policy.mjs'

// ERROR 可能等待恢复，UNCERTAIN 需要核对提交结果；停止轮询不等于可以删除。
const canPruneTask = (task) => ['SUCCESS', 'FAILED', 'CANCEL'].includes(normalizeStatus(task && task.status))
/** 待恢复（ERROR）/ 待核对（UNCERTAIN）：不能按普通上限删，但也**不能无界**。 */
const isRecoverableTask = (task) => ['ERROR', 'UNCERTAIN'].includes(normalizeStatus(task && task.status))
const completedAt = (task) => toNumber(task.finishedAt, 0) || toNumber(task.createdAt, 0)

/**
 * 「待恢复 / 待核对」记录的**独立上限**。
 *
 * ⚠️ 这一类必须**单独设限**，否则本插件的核心承诺会失效：
 * 一次 `TRANSPORT_UNCERTAIN`（提交结果未知）或一次 `TIMEOUT / NO_KEY / POLL_CRASH`
 * 都会落一条这类记录。如果它们被排除出清理范围**又不给上限**，
 * `tasks/` 就会无界增长 —— 实测「上限 10」时能堆到 110 条，面板也越拉越长，
 * 而用户看到的设置明明是「保留最近 10 条」。
 *
 * 折中：它们比普通已结束记录**留得久**（`max(20, 2N)`），但仍有硬上限。
 * `maxTasks === 0`（显式不限制）时返回 0，表示这一类同样不设限。
 *
 * @param {number} max 普通已结束记录的保留上限
 * @returns {number} 待恢复/待核对记录的保留上限（0 = 不限制）
 */
export const recoverableLimitFor = (max) => (max <= 0 ? 0 : Math.max(20, max * 2))

/** 子目录清单。 */
export const SUBDIRS = ['workflows', 'prompts', 'tasks', 'outputs', 'logs', 'tmp']

/** 备份保留份数。 */
export const KEEP_BACKUPS = 5

/** 文件名安全化：只留字母数字与 `-_.`，其余转 `-`（防目录穿越）。 @param {unknown} name 原始名 @param {string} [fallback] 兜底 @returns {string} 安全文件名 */
export function safeName(name, fallback = 'item') {
  const s = asString(name)
    .trim()
    .replace(/[^0-9A-Za-z._\u4e00-\u9fff-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+/, '')
    .replace(/\.{2,}/g, '.')
  const clipped = s.slice(0, 96)
  return clipped.length > 0 ? clipped : fallback
}

/**
 * 解析数据目录。
 * @param {{dataDir?:string, env?:object, home?:string}} [opts] `dataDir` 显式覆盖；`env`/`home` 便于单测注入
 * @returns {string} 绝对路径（不保证已存在）
 */
export function resolveDataDir(opts = {}) {
  const explicit = asString(opts.dataDir).trim()
  if (explicit !== '') return path.resolve(explicit)
  const env = opts.env && typeof opts.env === 'object' ? opts.env : process.env
  const dshHome = asString(env && env.DSH_HOME).trim()
  if (dshHome !== '') return path.join(path.resolve(dshHome), 'runninghub')
  const home = asString(opts.home).trim() || os.homedir()
  return path.join(path.resolve(home), '.dsh', 'runninghub')
}

/**
 * 严格 id 归一化：**空/缺失返回 `''`**（不给兜底名，否则 `save({})` 会写出一个叫 `item` 的文件）。
 * @param {unknown} v 原始 id
 * @returns {string} 安全 id 或 `''`
 */
function idOf(v) {
  const raw = asString(v).trim()
  return raw === '' ? '' : safeName(raw, '')
}

/* ──────────────────────────────── Store ──────────────────────────────── */

/**
 * 数据存储。一个实例管一个 dataDir；所有写操作串行、原子、先备份。
 *
 * @example
 * const store = new Store({ dataDir: resolveDataDir(config) })
 * await store.saveWorkflow({ id: 'wf_x', name: 'Qwen 文生图' })
 * const wf = await store.getWorkflow('wf_x')
 */
export class Store {
  /**
   * @param {{dataDir?:string, logger?:object, env?:object, home?:string, fsImpl?:object}} [opts] `logger` 可省
   */
  constructor(opts = {}) {
    this.dataDir = resolveDataDir(opts)
    this.logger = opts.logger || null
    this.fs = opts.fsImpl || fs
    /**
     * 输出的**根目录**（绝对路径）。缺省 `<dataDir>/outputs`。
     *
     * 为什么单独拎出来：用户希望把生成的图直接落到自己指定的文件夹
     * （比如项目素材库），而不必去 `~/.dsh/runninghub/outputs/<taskId>/` 里翻。
     * 只影响**输出文件**，工作流配置 / 任务流水 / 机密仍留在 `dataDir` —— 那些是插件的状态，
     * 不该跟着用户的素材目录跑。
     *
     * @type {string}
     */
    this.outputsRoot = typeof opts.outputsRoot === 'string' && opts.outputsRoot.trim().length > 0
      ? path.resolve(opts.outputsRoot.trim())
      : path.join(this.dataDir, 'outputs')
    /**
     * 单任务级的输出覆盖（taskId → `{dir?, fileName?}`）。
     *
     * 为什么放在 store 上而不是穿参进 runner：落盘发生在 runner 内部的下载链里
     * （`api.downloadBytes` → `store.writeOutput`），把参数一路穿进 runner
     * 要改三四层签名。放这里，提交时 `setTaskOutput(taskId, {dir, fileName})`
     * 一句就够，且下载时机（可能几分钟后）自动生效。
     *
     * @type {Map<string, {dir?:string, fileName?:string}>}
     */
    this.outputByTask = new Map()
    /** 最近完成的任务记录上限；0 不限制，待恢复和待核对的记录另行保留。 */
    this.maxTasks = parseTaskLimit(opts.maxTasks) ?? DEFAULT_TASK_LIMIT
    this._taskRefs = new Map()
    this._pruneBlocked = new Set()
    this._taskRevision = 0
    this._lists = new Map()
    this._prunePending = null
    this._pruneRequested = false
    /** @type {Map<string, Promise<any>>} 写队列（同一绝对路径 FIFO） */
    this._queues = new Map()
    this._ready = null
  }

  /**
   * 记住某任务的输出覆盖（来自 `workflow.run` 的 `saveDir` / `fileName` 参数）。
   *
   * @param {string} taskId 任务 id
   * @param {{dir?:string, fileName?:string}} [spec] 两个字段都可省；都空 = 清除覆盖
   * @returns {void}
   */
  setTaskOutput(taskId, spec) {
    const key = safeName(taskId, '')
    if (key === '') return
    /** @type {{dir?:string, fileName?:string}} */
    const next = {}
    if (spec && typeof spec.dir === 'string' && spec.dir.trim().length > 0) next.dir = path.resolve(spec.dir.trim())
    if (spec && typeof spec.fileName === 'string' && spec.fileName.trim().length > 0) next.fileName = spec.fileName.trim()
    if (next.dir === undefined && next.fileName === undefined) this.outputByTask.delete(key)
    else this.outputByTask.set(key, next)
  }

  /**
   * 把用户/AI 给的文件名规则套到真实文件名上。
   *
   * 规则（顺序敏感）：
   *   1. `fileName` 里有扩展名 → 原样用它；
   *   2. 没有扩展名 → 补上真实文件的扩展名（`hero` + `.png` → `hero.png`）；
   *   3. 真实文件也没有扩展名 → 不补。
   *
   * @param {string} realName 下载下来的真实文件名
   * @param {string} wanted 用户给的名字
   * @returns {string} 套用后的文件名
   */
  _applyNaming(realName, wanted) {
    const realExt = path.extname(realName)
    const wantedExt = path.extname(wanted)
    if (wantedExt !== '') return safeName(wanted, realName)
    return safeName(wanted + realExt, realName)
  }

  /**
   * 在目标目录里找一个不冲突的文件名（`hero.png` → `hero_2.png` → `hero_3.png`…）。
   *
   * ⚠️ 必须有这一步：一次任务出 4 张图时，AI 给的 `fileName` 是同一个
   * （比如 `hero`），不去重就会**互相覆盖**，最后只剩最后一张。
   *
   * @param {string} dirAbs 目标目录（绝对）
   * @param {string} name 期望文件名
   * @returns {Promise<string>} 一个当前不存在的文件名
   */
  async _uniqueName(dirAbs, name) {
    const ext = path.extname(name)
    const stem = ext === '' ? name : name.slice(0, -ext.length)
    let candidate = name
    for (let i = 2; i <= 999; i += 1) {
      try {
        await this.fs.access(path.join(dirAbs, candidate))
      } catch {
        return candidate // 不存在 → 可用
      }
      candidate = stem + '_' + String(i) + ext
    }
    return stem + '_' + shortId() + ext
  }

  /** 安全日志（不抛）。 @param {'info'|'warn'|'error'} level 级别 @param {string} msg 消息 @param {object} [meta] 附加 @returns {void} */
  _log(level, msg, meta) {
    const fn = this.logger && (this.logger[level] || this.logger.log)
    if (typeof fn !== 'function') return
    try {
      fn.call(this.logger, '[rh-store] ' + msg, meta ? lossless(meta) : '')
    } catch {
      /* 忽略 */
    }
  }

  /** 绝对路径（相对 dataDir）。 @param {...string} parts 路径片段 @returns {string} 绝对路径 */
  resolve(...parts) {
    return path.join(this.dataDir, ...parts.map((p) => asString(p)))
  }

  /** 某个子目录的绝对路径。 @param {string} kind 子目录名 @returns {string} 绝对路径 */
  dir(kind) {
    return this.resolve(kind)
  }

  /**
   * 建目录（幂等）。**任何写操作前都会自动调**，所以一般不用手动调。
   * @returns {Promise<{ok:true,dataDir:string}>} 结果
   */
  async init() {
    if (!this._ready) {
      this._ready = (async () => {
        await this.fs.mkdir(this.dataDir, { recursive: true })
        for (const d of SUBDIRS) await this.fs.mkdir(this.resolve(d), { recursive: true })
      })().catch((e) => {
        this._ready = null
        throw e
      })
    }
    try {
      await this._ready
      return { ok: true, dataDir: this.dataDir }
    } catch (e) {
      this._log('error', '建数据目录失败：' + String((e && e.message) || e))
      return { ok: false, error: errorShape('STORE_INIT_FAILED', '无法创建数据目录：' + String((e && e.message) || e), { hint: this.dataDir }) }
    }
  }

  /**
   * 同一路径的写串行化（FIFO promise 链）。
   * @template T
   * @param {string} absPath 绝对路径
   * @param {() => Promise<T>} fn 要串行执行的写操作
   * @returns {Promise<T>} 结果
   */
  _serialize(absPath, fn) {
    const prev = this._queues.get(absPath) || Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.then(() => undefined, () => undefined)
    this._queues.set(absPath, tail)
    void tail.then(() => {
      if (this._queues.get(absPath) === tail) this._queues.delete(absPath)
    })
    return next
  }

  /**
   * 读 JSON。**坏文件不炸**：解析失败 → 记 warn + 返回 `fallback`。
   * @param {string} rel 相对 dataDir 的路径
   * @param {any} [fallback] 读不到时的兜底（默认 `null`）
   * @returns {Promise<any>} 内容或兜底
   */
  async readJson(rel, fallback = null) {
    const abs = this.resolve(rel)
    try {
      const text = await this.fs.readFile(abs, 'utf8')
      try {
        return JSON.parse(text)
      } catch (e) {
        // SyntaxError.message can include the source text, including a private Key.
        this._log('warn', 'JSON 损坏，返回兜底值：' + rel)
        // 留证据：把坏文件改名，别让下次写覆盖掉现场
        try {
          if (['secrets.json', 'state.json'].includes(path.basename(abs))) await this.fs.chmod(abs, 0o600).catch(() => {})
          await this.fs.rename(abs, abs + '.corrupt-' + String(nowMs()))
          this._invalidateList(abs)
        } catch {
          /* 改名失败也无所谓 */
        }
        return fallback
      }
    } catch (e) {
      if (e && e.code === 'ENOENT') return fallback
      this._log('warn', '读文件失败：' + rel + '（' + String((e && e.message) || e) + '）')
      return fallback
    }
  }

  /**
   * 带重试的 `rename`。
   *
   * ⚠️ **Windows 必需**：`rename` 覆盖一个**正被读取**的文件会拿到 `EPERM`
   * （Windows 不允许对已打开的文件做 rename；POSIX 没这问题）。
   * 我们的场景正好天天踩：runner 一边高频写 `tasks/<id>.json`，一边有 `task.status` /
   * 面板在 `readFile` 同一个文件 —— 撞上就整次落盘丢失，表现为
   * 「任务明明在跑，流水却停在旧状态」，而且只在 Windows 偶发。
   * 杀毒/索引器短暂占用也会给 `EPERM`/`EACCES`/`EBUSY`。
   *
   * 这几类都是**瞬时**的，退避重试即可；其它错误（ENOSPC 等）立即上抛。
   * @param {string} from 源路径（tmp）
   * @param {string} to 目标路径
   * @param {number} [attempts] 最多试几次
   * @returns {Promise<void>}
   */
  async _renameWithRetry(from, to, attempts = 6) {
    let last = null
    for (let i = 0; i < attempts; i++) {
      try {
        await this.fs.rename(from, to)
        return
      } catch (e) {
        last = e
        const code = e && e.code
        if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw e
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 8 * (i + 1)))
      }
    }
    throw last
  }

  /**
   * 写 JSON（**原子 + 覆盖前备份**）。
   *
   * `secrets.json` 强制使用 0600 权限且不生成备份。
   * 其它机密文件的调用方需显式传入相同选项。
   * `writeSecrets()` 还会清理历史机密备份和崩溃留下的临时副本。
   * @param {string} rel 相对 dataDir 的路径
   * @param {any} value 要写的内容（会走 `JSON.stringify(v, null, 2)`）
   * @param {{backup?:boolean, mode?:number}} [opts] `backup=false` 跳过备份（高频写 / **机密写**）
   * @returns {Promise<{ok:true,path:string,bytes:number,backups:number}|{ok:false,error:object}>} 结果
   */
  async writeJson(rel, value, opts = {}) {
    const abs = this.resolve(rel)
    if (path.basename(abs) === 'secrets.json') opts = { ...opts, backup: false, mode: 0o600 }
    return this._serialize(abs, () => this._writeJsonNow(abs, rel, value, opts))
  }

  /** `writeJson` 的实际实现（已在串行队列里）。 @param {string} abs 绝对路径 @param {string} rel 相对路径 @param {any} value 内容 @param {object} opts 选项 @returns {Promise<object>} 结果 */
  async _writeJsonNow(abs, rel, value, opts) {
    try {
      await this.init()
      await this.fs.mkdir(path.dirname(abs), { recursive: true })
      let text
      try {
        text = JSON.stringify(value, null, 2)
      } catch (e) {
        return { ok: false, error: errorShape('STORE_BAD_VALUE', '内容无法 JSON 序列化：' + String((e && e.message) || e)) }
      }
      if (text === undefined) text = 'null'
      const backups = opts.backup === false ? 0 : await this._backup(abs)
      const tmp = abs + '.tmp-' + shortId()
      try {
        await this.fs.writeFile(tmp, text, { encoding: 'utf8', mode: opts.mode === undefined ? 0o644 : opts.mode })
        await this._renameWithRetry(tmp, abs)
        this._invalidateList(abs)
      } finally {
        await this.fs.unlink(tmp).catch(() => {})
      }
      return { ok: true, path: abs, bytes: Buffer.byteLength(text, 'utf8'), backups }
    } catch (e) {
      this._log('error', '写失败：' + rel + '（' + String((e && e.message) || e) + '）')
      return { ok: false, error: errorShape('STORE_WRITE_FAILED', '写文件失败：' + String((e && e.message) || e), { hint: rel }) }
    }
  }

  /**
   * 覆盖前备份到 `<name>.bak-<ts>`，并只保留最近 `KEEP_BACKUPS` 份。
   * @param {string} abs 目标绝对路径
   * @returns {Promise<number>} 本次产生的备份数（目标不存在则 0）
   */
  async _backup(abs) {
    try {
      await this.fs.access(abs)
    } catch {
      return 0
    }
    const bak = abs + '.bak-' + String(nowMs())
    try {
      await this.fs.copyFile(abs, bak)
    } catch (e) {
      this._log('warn', '备份失败（继续写）：' + String((e && e.message) || e))
      return 0
    }
    await this._pruneBackups(abs)
    return 1
  }

  /** 删掉多余的备份，只留最近 N 份。 @param {string} abs 目标绝对路径 @returns {Promise<number>} 删除数量 */
  async _pruneBackups(abs) {
    const dir = path.dirname(abs)
    const base = path.basename(abs)
    const prefix = base + '.bak-'
    let names
    try {
      names = await this.fs.readdir(dir)
    } catch {
      return 0
    }
    const baks = names
      .filter((n) => n.startsWith(prefix))
      .map((n) => ({ n, ts: toNumber(n.slice(prefix.length), 0) }))
      .sort((a, b) => b.ts - a.ts)
    let removed = 0
    for (const b of baks.slice(KEEP_BACKUPS)) {
      try {
        await this.fs.unlink(path.join(dir, b.n))
        removed += 1
      } catch {
        /* 删不掉就算了 */
      }
    }
    return removed
  }

  /**
   * 列目录里以 `suffix` 结尾的文件名（不含路径）。
   * @param {string} rel 相对 dataDir 的目录
   * @param {{suffix?:string, stripSuffix?:boolean}} [opts] 过滤
   * @returns {Promise<string[]>} 文件名列表（目录不存在 → `[]`）
   */
  async listDir(rel, opts = {}) {
    const abs = this.resolve(rel)
    let names
    try {
      names = await this.fs.readdir(abs)
    } catch (e) {
      if (e && e.code !== 'ENOENT') this._log('warn', '列目录失败：' + rel + '（' + String((e && e.message) || e) + '）')
      return []
    }
    let out = names.filter((n) => !n.endsWith('.tmp') && !n.includes('.tmp-') && !n.includes('.bak-') && !n.includes('.corrupt-'))
    if (opts.suffix) {
      const suf = String(opts.suffix)
      out = out.filter((n) => n.endsWith(suf))
      if (opts.stripSuffix !== false) out = out.map((n) => n.slice(0, -suf.length))
    }
    return out
  }

  /**
   * 删文件（不存在也算成功）。
   * @param {string} rel 相对 dataDir 的路径
   * @returns {Promise<{ok:true,removed:boolean}|{ok:false,error:object}>} 结果
   */
  async remove(rel) {
    const abs = this.resolve(rel)
    try {
      await this.fs.unlink(abs)
      this._invalidateList(abs)
      return { ok: true, removed: true }
    } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: true, removed: false }
      return { ok: false, error: errorShape('STORE_REMOVE_FAILED', '删文件失败：' + String((e && e.message) || e), { hint: rel }) }
    }
  }

  /**
   * 删整个子树（任务输出目录清理用）。
   * @param {string} rel 相对 dataDir 的目录
   * @returns {Promise<{ok:true,removed:boolean}|{ok:false,error:object}>} 结果
   */
  async removeDir(rel) {
    const abs = this.resolve(rel)
    try {
      await this.fs.rm(abs, { recursive: true, force: true })
      this._lists.delete(abs)
      if (abs === this.dir('tasks')) this._taskRevision++
      return { ok: true, removed: true }
    } catch (e) {
      return { ok: false, error: errorShape('STORE_REMOVE_FAILED', '删目录失败：' + String((e && e.message) || e), { hint: rel }) }
    }
  }

  /* ─────────────────────────────── 工作流 ─────────────────────────────── */

  _invalidateList(abs) {
    const dir = path.dirname(abs)
    this._lists.delete(dir)
    if (dir === this.dir('tasks')) this._taskRevision++
  }

  /** 同时请求同一目录时共用一次扫描；只共享进行中的读取，写入后立即失效。 */
  _listRecords(rel, suffix, read) {
    const dir = this.dir(rel)
    if (this._lists.has(dir)) return this._lists.get(dir)
    const pending = (async () => {
      const ids = await this.listDir(rel, { suffix })
      const records = new Array(ids.length)
      let next = 0
      await Promise.all(Array.from({ length: Math.min(8, ids.length) }, async () => {
        while (next < ids.length) {
          const index = next++
          records[index] = await read(ids[index])
        }
      }))
      return records
    })().finally(() => {
      if (this._lists.get(dir) === pending) this._lists.delete(dir)
    })
    this._lists.set(dir, pending)
    return pending
  }

  /** 列全部工作流配置（跳过损坏项，不抛）。 @returns {Promise<object[]>} 工作流数组 */
  async listWorkflows() {
    const out = (await this._listRecords('workflows', '.json', id => this.getWorkflow(id)))
      .filter(wf => wf && typeof wf === 'object')
    out.sort((a, b) => toNumber(a.updatedAt, 0) - toNumber(b.updatedAt, 0))
    return out
  }

  /**
   * 读单个工作流。
   * @param {string} id 工作流 id（= 文件名去 `.json`）
   * @returns {Promise<object|undefined>} 配置或 `undefined`
   */
  async getWorkflow(id) {
    const key = idOf(id)
    if (!key) return undefined
    const v = await this.readJson(path.join('workflows', key + '.json'), undefined)
    return v && typeof v === 'object' ? v : undefined
  }

  /**
   * 落盘工作流配置（自动补 `updatedAt`；`createdAt` 首次写时补）。
   * @param {object} wf 工作流配置（必须有 `id`）
   * @returns {Promise<{ok:true,id:string,path:string}|{ok:false,error:object}>} 结果
   */
  async saveWorkflow(wf) {
    const id = idOf(wf && wf.id)
    if (!wf || typeof wf !== 'object' || !id) {
      return { ok: false, error: errorShape('BAD_REQUEST', 'saveWorkflow 需要带 id 的对象') }
    }
    const now = nowMs()
    const prev = await this.getWorkflow(id)
    const doc = { ...wf, id, createdAt: toNumber(wf.createdAt, 0) || (prev && toNumber(prev.createdAt, 0)) || now, updatedAt: now }
    const r = await this.writeJson(path.join('workflows', id + '.json'), lossless(doc))
    if (!r.ok) return r
    return { ok: true, id, path: r.path }
  }

  /**
   * 删工作流配置（**不删 RH 侧工作流**）。
   * @param {string} id 工作流 id
   * @returns {Promise<{ok:true,removed:boolean}>} 结果
   */
  async deleteWorkflow(id) {
    const key = idOf(id)
    if (!key) return { ok: true, removed: false }
    return this.remove(path.join('workflows', key + '.json'))
  }

  /* ─────────────────────────── 提示词优化文档 ─────────────────────────── */

  /** 列全部提示词文档的元数据（按 updatedAt 升序）。 @returns {Promise<object[]>} `[{id,name,sourceFilename,updatedAt,bytes}]` */
  async listPromptDocs() {
    const out = await this._listRecords('prompts', '.meta.json', async id => {
      const meta = await this.readJson(path.join('prompts', id + '.meta.json'), null)
      return meta && typeof meta === 'object'
        ? { id: safeName(meta.id) || id, ...meta }
        : { id, name: id, updatedAt: 0, bytes: 0 }
    })
    return out.slice().sort((a, b) => toNumber(a.updatedAt, 0) - toNumber(b.updatedAt, 0))
  }

  /**
   * 读一个提示词文档（正文 + 元数据）。
   * @param {string} id 文档 id
   * @returns {Promise<{id:string,name:string,content:string,meta:object}|undefined>} 文档或 `undefined`
   */
  async getPromptDoc(id) {
    const key = idOf(id)
    if (!key) return undefined
    let content = null
    try {
      content = await this.fs.readFile(this.resolve('prompts', key + '.md'), 'utf8')
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        // 兼容「只存了 meta 没存正文」的破损状态
        const metaOnly = await this.readJson(path.join('prompts', key + '.meta.json'), null)
        if (!metaOnly) return undefined
        return { id: key, name: asString(metaOnly.name) || key, content: '', meta: metaOnly }
      }
      this._log('warn', '读提示词文档失败：' + key + '（' + String((e && e.message) || e) + '）')
      return undefined
    }
    const meta = (await this.readJson(path.join('prompts', key + '.meta.json'), null)) || {}
    return {
      id: key,
      name: asString(meta.name) || key,
      content: asString(content),
      sourceFilename: asString(meta.sourceFilename),
      updatedAt: toNumber(meta.updatedAt, 0),
      bytes: toNumber(meta.bytes, 0),
      meta: { id: key, name: asString(meta.name) || key, sourceFilename: asString(meta.sourceFilename), updatedAt: toNumber(meta.updatedAt, 0), bytes: toNumber(meta.bytes, 0) },
    }
  }

  /**
   * 保存提示词优化文档（正文原样存 `<id>.md`，元数据存 `<id>.meta.json`）。
   * @param {{id?:string,name?:string,content:string,sourceFilename?:string}} doc 文档
   * @returns {Promise<{ok:true,id:string,bytes:number}|{ok:false,error:object}>} 结果
   */
  async savePromptDoc(doc) {
    if (!doc || typeof doc !== 'object' || typeof doc.content !== 'string') {
      return { ok: false, error: errorShape('BAD_REQUEST', 'savePromptDoc 需要 {name, content}') }
    }
    const name = asString(doc.name) || asString(doc.id)
    const id = idOf(doc.id || doc.docId) || slugify(name, 'doc-' + shortId('doc'))
    await this.init()
    const abs = this.resolve('prompts', id + '.md')
    const bytes = Buffer.byteLength(doc.content, 'utf8')
    try {
      // 正文同样走「tmp + rename + 备份」，避免半截文件
      await this._serialize(abs, async () => {
        await this._backup(abs)
        const tmp = abs + '.tmp-' + shortId()
        await this.fs.writeFile(tmp, doc.content, 'utf8')
        await this._renameWithRetry(tmp, abs)
      })
    } catch (e) {
      return { ok: false, error: errorShape('STORE_WRITE_FAILED', '写提示词文档失败：' + String((e && e.message) || e)) }
    }
    const meta = {
      id,
      name: name || id,
      sourceFilename: asString(doc.sourceFilename || doc.filename),
      updatedAt: nowMs(),
      bytes,
    }
    const mr = await this.writeJson(path.join('prompts', id + '.meta.json'), meta)
    if (!mr.ok) return mr
    return { ok: true, id, bytes }
  }

  /**
   * 删提示词文档（正文 + 元数据一起删）。
   * @param {string} id 文档 id
   * @returns {Promise<{ok:true,removed:boolean}>} 结果
   */
  async deletePromptDoc(id) {
    const key = idOf(id)
    if (!key) return { ok: true, removed: false }
    const a = await this.remove(path.join('prompts', key + '.md'))
    const b = await this.remove(path.join('prompts', key + '.meta.json'))
    if (!a.ok) return a
    if (!b.ok) return b
    return { ok: true, removed: a.removed || b.removed }
  }

  /* ──────────────────────────────── 任务 ──────────────────────────────── */

  /**
   * 列任务流水（按 createdAt 升序）。坏文件跳过。
   * @param {{limit?:number,status?:string}} [opts] 可选过滤
   * @returns {Promise<object[]>} 任务数组
   */
  async listTasks(opts = {}) {
    const out = (await this._listRecords('tasks', '.json', id => this.getTask(id)))
      .filter(t => t && typeof t === 'object' && (!opts.status || asString(t.status) === asString(opts.status)))
    out.sort((a, b) => toNumber(a.createdAt, 0) - toNumber(b.createdAt, 0))
    const limit = Math.floor(toNumber(opts.limit, 0))
    return limit > 0 ? out.slice(-limit) : out
  }

  /**
   * 读单个任务流水。
   * @param {string} taskId 任务 id
   * @returns {Promise<object|undefined>} 任务或 `undefined`
   */
  async getTask(taskId) {
    const key = idOf(taskId)
    if (!key) return undefined
    const v = await this.readJson(path.join('tasks', key + '.json'), undefined)
    return v && typeof v === 'object' ? v : undefined
  }

  /**
   * 写任务流水。**`tasks/<taskId>.json` 是任务的唯一真相**（重启后靠它恢复轮询）。
   * @param {object} task 任务记录（必须有 `taskId`）
   * @param {{backup?:boolean}} [opts] 高频写建议 `backup:false`
   * @returns {Promise<{ok:true,id:string,path:string}|{ok:false,error:object}>} 结果
   */
  async saveTask(task, opts = {}) {
    const id = idOf(task && (task.taskId || task.id))
    if (!task || typeof task !== 'object' || !id) {
      return { ok: false, error: errorShape('BAD_REQUEST', 'saveTask 需要带 taskId 的对象') }
    }
    const doc = { ...task, taskId: id, updatedAt: nowMs() }
    const r = await this.writeJson(path.join('tasks', id + '.json'), lossless(doc), { backup: opts.backup === true })
    if (!r.ok) return r
    // 两类记录都要调度清理：
    //   ① 普通已结束（SUCCESS/FAILED/CANCEL）—— 按 `maxTasks`
    //   ② 待恢复/待核对（ERROR/UNCERTAIN）—— 按**独立上限**（recoverableLimitFor）
    //      ⚠️ 漏掉 ② 会让这一类无界增长：它们不出现在 ① 的候选里，
    //      如果写入时也不触发调度，就永远等不到清理。
    if (this.maxTasks > 0 && (canPruneTask(doc) || isRecoverableTask(doc))) await this._scheduleTaskPrune()
    return { ok: true, id, path: r.path }
  }

  /** RPC 和工具共用的保留设置；先保存，再切换策略并清理。 */
  taskLimit(limit) {
    return this._serialize(this.dir('tasks'), async () => {
      if (limit === undefined || limit === null || (typeof limit === 'string' && limit.trim() === '')) {
        return { ok: true, limit: this.maxTasks, count: (await this.listTasks()).length, recoverableLimit: recoverableLimitFor(this.maxTasks) }
      }
      const next = parseTaskLimit(limit)
      if (next === null) return { ok: false, error: errorShape('BAD_REQUEST', 'limit 必须是非负安全整数（0 = 不限制）') }
      try {
        const saved = await this.saveState({ taskLimit: next })
        if (!saved || !saved.ok) throw new Error(saved?.error?.message || '写入失败')
      } catch (error) {
        return { ok: false, error: errorShape('SAVE_FAILED', '保留条数未能写入 state.json：' + String(error?.message || error)) }
      }
      this.maxTasks = next
      const result = await this._pruneTasksNow(next)
      if (!result.ok) result.error.message = '保留条数已保存为 ' + next + '，但' + result.error.message
      return { ...result, limit: next }
    })
  }

  /** 保留最近完成的 N 条记录，另保留运行、待恢复、待核对和取结果中的任务。 */
  pruneTasks(limit) {
    return this._serialize(this.dir('tasks'), () => this._pruneTasksNow(parseTaskLimit(limit) ?? this.maxTasks))
  }

  async _pruneTasksNow(max) {
    const revision = this._taskRevision
    const all = await this.listTasks()
    const removed = []
    const failed = []
    const recoverableMax = recoverableLimitFor(max)
    const byTime = (a, b) => completedAt(a) - completedAt(b)

    // ① 普通已结束记录（SUCCESS / FAILED / CANCEL）：保留最近 `max` 条
    const done = max > 0 ? all.filter(canPruneTask).sort(byTime) : []
    // ② 待恢复 / 待核对（ERROR / UNCERTAIN）：另有独立上限，留得久但**不能无界**
    const recoverable = recoverableMax > 0 ? all.filter(isRecoverableTask).sort(byTime) : []
    /** @type {Array<{task:object, recoverable:boolean}>} */
    const candidates = []
    if (max > 0) {
      for (const t of done.slice(0, Math.max(0, done.length - max))) candidates.push({ task: t, recoverable: false })
    }
    if (recoverableMax > 0) {
      for (const t of recoverable.slice(0, Math.max(0, recoverable.length - recoverableMax))) {
        candidates.push({ task: t, recoverable: true })
      }
    }

    for (const { task, recoverable: wasRecoverable } of candidates) {
      const id = idOf(task.taskId || task.id)
      if (!id) continue
      if (this._taskRefs.has(id)) {
        this._pruneBlocked.add(id)
        continue
      }
      try {
        // 与写入共用文件队列：扫描后状态改变或开始取结果时，跳过这条记录。
        const result = await this._serialize(this.resolve('tasks', id + '.json'), async () => {
          const fresh = await this.getTask(id)
          if (!fresh) return null
          if (this._taskRefs.has(id)) {
            this._pruneBlocked.add(id)
            return null
          }
          // 扫描之后状态变了 → 归类可能已不同，保守跳过，交给下一轮按新状态判
          if (isRecoverableTask(fresh) !== wasRecoverable) return null
          if (!wasRecoverable && !canPruneTask(fresh)) return null
          if (JSON.stringify(fresh) !== JSON.stringify(task)) return null
          return this.deleteTask(id)
        })
        if (result?.ok === false) failed.push(id)
        else if (result?.removed === true) {
          removed.push(id)
          this.outputByTask.delete(id)
        }
      } catch {
        failed.push(id)
      }
    }
    if (removed.length > 0) {
      this._log('info', '已清理 ' + String(removed.length) + ' 条任务记录')
    }
    // 只有扫描期间发生其它写入，才需要重新统计；自身成功删除可直接扣除。
    const kept = this._taskRevision === revision + removed.length
      ? all.length - removed.length : (await this.listTasks()).length
    const result = { ok: failed.length === 0, kept, removed, recoverableLimit: recoverableMax }
    if (failed.length) {
      result.failed = failed
      result.error = errorShape('TASK_PRUNE_FAILED', String(failed.length) + ' 条任务记录未能删除，请检查数据目录权限后重试')
    }
    return result
  }

  /** 合并并发清理请求；运行中的任务更新不触发扫描。 */
  _scheduleTaskPrune() {
    this._pruneRequested = true
    if (this._prunePending) return this._prunePending
    const pending = (async () => {
      do {
        this._pruneRequested = false
        try {
          const result = await this.pruneTasks()
          if (!result.ok) this._log('warn', result.error.message)
        } catch {
          this._log('warn', '任务记录清理失败，请检查数据目录权限')
        }
      } while (this._pruneRequested)
    })().finally(() => {
      this._prunePending = null
      if (this._pruneRequested) return this._scheduleTaskPrune()
    })
    this._prunePending = pending
    return pending
  }

  /** 在等待或批量作业取完结果前保护记录；返回可重复调用的释放函数。 */
  retainTasks(taskIds) {
    const ids = [...new Set(taskIds.map(idOf).filter(Boolean))]
    for (const id of ids) this._taskRefs.set(id, (this._taskRefs.get(id) || 0) + 1)
    let released = false
    return async () => {
      if (released) return
      released = true
      let unprotected = false
      for (const id of ids) {
        const count = this._taskRefs.get(id) - 1
        if (count > 0) this._taskRefs.set(id, count)
        else {
          this._taskRefs.delete(id)
          if (this._pruneBlocked.delete(id)) unprotected = true
        }
      }
      if (unprotected && this.maxTasks > 0) await this._scheduleTaskPrune()
    }
  }

  /**
   * 删任务流水。
   * @param {string} taskId 任务 id
   * @returns {Promise<{ok:true,removed:boolean}>} 结果
   */
  async deleteTask(taskId) {
    const key = idOf(taskId)
    if (!key) return { ok: true, removed: false }
    return this.remove(path.join('tasks', key + '.json'))
  }

  /* ─────────────────────────────── 输出文件 ─────────────────────────────── */

  /**
   * 某任务的输出目录（绝对路径）。
   *
   * 两种语义：
   *   · **给了 `root`** → 那就是**目标文件夹本身**（用户要的"存到某个文件夹"，扁平放，
   *     不再套 taskId 子目录 —— 用户要的是一个文件夹，不是每次新建一个）；
   *   · **没给 `root`** → 退回 `<outputsRoot>/<taskId>`（插件数据目录下的老布局，
   *     只在拿不到会话工作目录时才会走到）。
   *
   * @param {string} taskId 任务 id
   * @param {string} [root] 目标文件夹的绝对路径
   * @returns {string} 绝对路径
   */
  outputDir(taskId, root) {
    if (typeof root === 'string' && root.trim().length > 0) return path.resolve(root.trim())
    // 也认任务级覆盖（`setTaskOutput({dir})`）—— 否则 `listOutputs()` 会去
    // 老位置找文件，而文件其实在用户指定的文件夹里。
    const perTask = this.outputByTask.get(safeName(taskId, '')) || {}
    if (typeof perTask.dir === 'string' && perTask.dir.length > 0) return perTask.dir
    return path.join(this.outputsRoot, safeName(taskId, 'unknown'))
  }

  /**
   * 列某任务已下载的输出文件。
   * @param {string} taskId 任务 id
   * @returns {Promise<string[]>} 文件名列表
   */
  async listOutputs(taskId) {
    // 用绝对目录而不是 'outputs/<taskId>' 相对路径 —— 输出目录可能是用户指定的
    // 任意文件夹（saveDir / 工作目录下的新建文件夹），不再固定在 dataDir 下面。
    const dir = this.outputDir(taskId)
    try {
      await this.init()
      const names = await this.fs.readdir(dir)
      return names.filter((n) => typeof n === 'string' && !n.includes('.tmp-')).sort()
    } catch {
      return []
    }
  }

  /**
   * 写一个输出文件（**原子写**，二进制安全）。
   *
   * @param {string} taskId 任务 id
   * @param {string} filename 文件名
   * @param {Uint8Array|string} data 内容
   * @param {{root?:string}} [opts] `root` 覆盖本次落盘根目录（比任务的 `saveDir` 优先级更高）
   * @returns {Promise<{ok:true,path:string,bytes:number}|{ok:false,error:object}>} 结果
   */
  async writeOutput(taskId, filename, data, opts = {}) {
    const key = safeName(taskId, '')
    const taskSpec = this.outputByTask.get(key) || {}
    // 目录优先级：调用方显式 root > 该任务 saveDir > 全局 outputsRoot
    const override =
      (opts && typeof opts.root === 'string' && opts.root.trim().length > 0 ? opts.root : null) ||
      taskSpec.dir ||
      null
    const dirAbs = this.outputDir(taskId, override)
    const realName = safeName(filename, 'output.bin')
    try {
      await this.init()
      await this.fs.mkdir(dirAbs, { recursive: true })
      // 命名：AI 给了 fileName 就用它（补扩展名），然后**必须去重** ——
      // 一次出多张图时名字相同会互相覆盖，最后只剩一张。
      // 选文件名和提交文件在同一个目录锁内，避免两个任务同时选中同名路径。
      return await this._serialize(dirAbs, async () => {
        const wanted = taskSpec.fileName ? this._applyNaming(realName, taskSpec.fileName) : realName
        const name = await this._uniqueName(dirAbs, wanted)
        const abs = path.join(dirAbs, name)
        const tmp = abs + '.tmp-' + shortId()
        try {
          await this.fs.writeFile(tmp, data)
          await this._renameWithRetry(tmp, abs)
        } finally {
          await this.fs.unlink(tmp).catch(() => {})
        }
        const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : (data && data.byteLength) || 0
        return { ok: true, path: abs, bytes }
      })
    } catch (e) {
      return { ok: false, error: errorShape('STORE_WRITE_FAILED', '写输出文件失败：' + String((e && e.message) || e)) }
    }
  }

  /* ─────────────────────────────── 机密 ─────────────────────────────── */

  /**
   * 读机密（`secrets.json`）。
   * @returns {Promise<object>} 机密对象（读不到 → `{}`）
   */
  async readSecrets() {
    const v = await this.readJson('secrets.json', {})
    return v && typeof v === 'object' ? v : {}
  }

  /**
   * 写机密（`secrets.json`，**权限 0600，且不留备份**）。值建议直接用 `KeyPool.toJSON()` 的 state。
   *
   * ⚠️ **为什么这里显式 `backup:false`**（Lead 真机抓到的泄漏）：
   * `writeJson` 默认会在覆盖前留 `<name>.bak-<ts>`，而备份里是**同一份明文 Key**、
   * 且**不走 0600** —— 留 5 份备份等于把暴露面乘以 5，直接违反本项目红线
   * 「明文 Key 只许落 secrets.json」。机密的"防损坏"价值远低于"少一份明文副本"的价值，
   * 而原子写（tmp + rename）已经保证写不坏。
   *
   * 顺带**自愈**：历史版本（或别的调用方）可能已经在盘上留下 `secrets.json.bak-*`，
   * 本方法见到就删 —— 否则已经泄漏过的用户永远清不掉。
   * @param {object} obj 机密对象
   * @returns {Promise<{ok:true,path:string,mode:number,prunedBackups:number}|{ok:false,error:object}>} 结果
   */
  async writeSecrets(obj) {
    const r = await this.writeJson('secrets.json', lossless(obj && typeof obj === 'object' ? obj : {}), {
      mode: 0o600,
      backup: false,
    })
    if (!r.ok) return r
    const prunedBackups = await this._pruneSecretBackups()
    let mode = 0o600
    try {
      await this.fs.chmod(this.resolve('secrets.json'), 0o600)
      const st = await this.fs.stat(this.resolve('secrets.json'))
      mode = st.mode & 0o777
    } catch (e) {
      // Windows 上 chmod 基本是 no-op：不报错，但要在 UI 上红字说明
      this._log('warn', 'secrets.json chmod 0600 未生效（Windows 常见）：' + String((e && e.message) || e))
      mode = 0
    }
    return { ok: true, path: r.path, mode, prunedBackups }
  }

  /**
   * 删掉数据目录下所有 `secrets.json.bak-*`（里面是明文 Key 的副本）。
   * 只删这一个前缀，不碰别的文件的正常备份。
   * @returns {Promise<number>} 删掉的份数
   */
  async _pruneSecretBackups() {
    let names
    try {
      names = await this.fs.readdir(this.dataDir)
    } catch {
      return 0
    }
    let removed = 0
    for (const n of names) {
      if (!/^secrets\.json\.(bak-|prescrub-|tmp-)/.test(n)) continue
      try {
        await this.fs.unlink(this.resolve(n))
        removed += 1
      } catch (e) {
        this._log('warn', '清理机密备份失败：' + n + '（' + String(e.message || e) + '）')
      }
    }
    if (removed > 0) this._log('warn', '清掉了 ' + String(removed) + ' 份 secrets.json 明文备份（历史上不该留下）')
    return removed
  }

  /** 清理旧机密备份；state 备份保留其它字段，避免误删工作流或任务文件。 */
  async scrubLegacySecretBackups() {
    const pruned = await this._pruneSecretBackups()
    let cleaned = 0
    const errors = []
    const all = await this.fs.readdir(this.dataDir).catch(() => [])
    for (const name of all) {
      if (/^secrets\.json\.(bak-|prescrub-|tmp-)/.test(name)) errors.push(name)
      if (!/^state\.json\.(bak-|prescrub-)/.test(name)) continue
      try {
        const value = JSON.parse(await this.fs.readFile(this.resolve(name), 'utf8'))
        if (!value || typeof value !== 'object' || value.keys === undefined) continue
        delete value.keys
        const saved = await this.writeJson(name, value, { backup: false })
        if (!saved.ok) throw new Error(saved.error.message)
        cleaned++
      } catch (e) {
        errors.push(name)
        this._log('warn', '清理旧状态备份失败：' + name + (e instanceof SyntaxError ? '（JSON 损坏）' : '（' + String(e.message || e) + '）'))
      }
    }
    return { ok: errors.length === 0, pruned, cleaned, errors }
  }

  /** 恢复旧迁移留下的备份，只在 secrets.json 尚无 Key 池时调用。 */
  async findLegacyKeyPool() {
    const names = await this.fs.readdir(this.dataDir).catch(() => [])
    const backups = names.filter((name) => /^state\.json\.(bak-|prescrub-)/.test(name)).sort().reverse()
    for (const name of backups) {
      try {
        const value = JSON.parse(await this.fs.readFile(this.resolve(name), 'utf8'))
        if (value && value.keys && Array.isArray(value.keys.entries)) return value.keys
      } catch {
        // 损坏的备份保留，继续检查下一份。
      }
    }
    return null
  }

  /* ─────────────────────────────── 状态 / 日志 ─────────────────────────────── */

  /** 读 `state.json`（key 冷却 / 上次用量快照）。 @returns {Promise<object>} 状态对象 */
  async loadState() {
    const v = await this.readJson('state.json', {})
    return v && typeof v === 'object' ? v : {}
  }

  /**
   * 写 `state.json`（**浅合并**到已有内容）。
   *
   * ⚠️ **两个隐蔽陷阱**（Lead 真机踩过，务必读完）：
   *   1. **只能增改字段，不能删字段**：实现是 `{...prev, ...obj}`，`delete state.keys` 之后再
   *      `saveState(state)` 会把删掉的键**从 prev 合并回来** —— 静默失败，看起来"什么都没发生"。
   *      要删字段请用 `writeJson('state.json', 全量对象)` 整体覆写。
   *   2. **不要往这里放机密**：`state.json` 是普通文件，覆盖前会留 `.bak-*` 副本。
   *      明文 Key 一律走 `writeSecrets()`（它显式禁用了备份并强制 0600）。
   * @param {object} obj 要合并进去的字段
   * @returns {Promise<{ok:true}|{ok:false,error:object}>} 结果
   */
  async saveState(obj) {
    const prev = await this.loadState()
    return this.writeJson('state.json', lossless({ ...prev, ...(obj && typeof obj === 'object' ? obj : {}) }))
  }

  /**
   * 追加一行日志到 `<dataDir>/logs/<name>.log`（**调用方负责先掩码**）。
   * @param {string} name 日志名（如 `plugin`）
   * @param {string} line 内容
   * @returns {Promise<{ok:boolean}>} 结果（永不抛）
   */
  async log(name, line) {
    const file = this.resolve('logs', safeName(name, 'plugin') + '.log')
    const text = '[' + new Date(nowMs()).toISOString() + '] ' + asString(line) + '\n'
    try {
      await this.init()
      await this._serialize(file, () => this.fs.appendFile(file, text, 'utf8'))
      return { ok: true }
    } catch {
      return { ok: false }
    }
  }

  /**
   * 存储概览（给 `diagnostics` 用）。
   * @returns {Promise<{ok:true,dataDir:string,writable:boolean,counts:object,secretsMode:number|null,error?:string}>} 概览
   */
  async stats() {
    const initR = await this.init()
    const counts = { workflows: 0, promptDocs: 0, tasks: 0, outputs: 0 }
    let secretsMode = null
    let probeError = ''
    try {
      counts.workflows = (await this.listDir('workflows', { suffix: '.json' })).length
      counts.promptDocs = (await this.listDir('prompts', { suffix: '.meta.json' })).length
      counts.tasks = (await this.listDir('tasks', { suffix: '.json' })).length
      counts.outputs = (await this.listDir('outputs')).length
      const st = await this.fs.stat(this.resolve('secrets.json'))
      secretsMode = st.mode & 0o777
    } catch (e) {
      if (!(e && e.code === 'ENOENT')) probeError = String((e && e.message) || e)
    }
    // 可写探针：写一个 tmp 立刻删掉
    let writable = false
    try {
      const probe = this.resolve('tmp', 'probe-' + shortId() + '.txt')
      await this.fs.writeFile(probe, 'ok')
      await this.fs.unlink(probe)
      writable = true
    } catch (e) {
      probeError = probeError || String((e && e.message) || e)
    }
    return {
      ok: true,
      dataDir: this.dataDir,
      writable,
      counts,
      secretsMode,
      ...(initR.ok ? {} : { error: initR.error.message }),
      ...(probeError ? { error: probeError } : {}),
    }
  }

  /** 便于工具层拼 `label`：把 id 变成用户可读名（找不到就回落到 id）。 @param {string} id 工作流 id @returns {Promise<string>} 名称 */
  async workflowLabel(id) {
    const wf = await this.getWorkflow(id)
    return asString(wf && (wf.name || wf.displayNameEn)) || asString(id)
  }
}

/**
 * 便捷工厂。
 * @param {object} [opts] 同 `Store` 构造器
 * @returns {Store} 实例
 */
export function createStore(opts) {
  return new Store(opts)
}
