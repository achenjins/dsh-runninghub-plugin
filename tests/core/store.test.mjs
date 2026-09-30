/**
 * tests/core/store.test.mjs —— `host/core/store.mjs` 的契约锁定
 *
 * 每个 test 用一个独立的临时 dataDir（`node:os` tmpdir），跑完删干净。
 * 重点：数据目录解析优先级 · 原子写 · 备份保留 5 份 · 坏文件不炸 · 并发写串行化 ·
 * secrets 0600 · 任务/工作流/文档/输出的增删查。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { Store, resolveDataDir, safeName, KEEP_BACKUPS } from '../../host/core/store.mjs'

/** 建一个临时沙盒目录。 */
async function tmpDir(label = 'rhstore') {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), label + '-'))
  return d
}

/** 建一个 store（自动记 warn）。 */
function makeStore(dir, extra = {}) {
  const warns = []
  const store = new Store({
    dataDir: dir,
    logger: { warn: (...a) => warns.push(a.join(' ')), info: () => {}, error: (...a) => warns.push('ERR ' + a.join(' ')) },
    ...extra,
  })
  store._warns = warns
  return store
}

/* ─────────────────────────────── 目录解析 ─────────────────────────────── */

test('resolveDataDir：opts.dataDir > DSH_HOME/runninghub > ~/.dsh/runninghub', () => {
  assert.equal(resolveDataDir({ dataDir: 'C:\\x\\y' }), path.resolve('C:\\x\\y'))
  assert.equal(resolveDataDir({ env: { DSH_HOME: 'C:\\dsh' } }), path.join(path.resolve('C:\\dsh'), 'runninghub'))
  assert.equal(resolveDataDir({ env: {}, home: 'C:\\home' }), path.join(path.resolve('C:\\home'), '.dsh', 'runninghub'))
  // 空 DSH_HOME 视为未设置
  assert.equal(resolveDataDir({ env: { DSH_HOME: '  ' }, home: '/h' }), path.join(path.resolve('/h'), '.dsh', 'runninghub'))
  // dataDir 优先于 DSH_HOME
  assert.equal(resolveDataDir({ dataDir: '/a', env: { DSH_HOME: '/dsh' } }), path.resolve('/a'))
})

test('safeName：防目录穿越', () => {
  assert.equal(safeName('../../etc/passwd'), 'etc-passwd')
  assert.equal(safeName('a/b\\c'), 'a-b-c')
  assert.equal(safeName('  '), 'item')
  assert.equal(safeName('Qwen 文生图'), 'Qwen-文生图')
  assert.equal(safeName('...'), 'item')
})

/* ─────────────────────────────── init / 原子写 ─────────────────────────────── */

test('init：建出全部子目录；重复调用幂等', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    const r = await s.init()
    assert.equal(r.ok, true)
    for (const sub of ['workflows', 'prompts', 'tasks', 'outputs', 'logs', 'tmp']) {
      const st = await fs.stat(path.join(d, sub))
      assert.equal(st.isDirectory(), true, sub + ' 应存在')
    }
    assert.equal((await s.init()).ok, true)
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('writeJson + readJson：往返；写的是 pretty JSON；无 tmp 残留', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    const w = await s.writeJson('state.json', { a: 1, b: ['x'] })
    assert.equal(w.ok, true)
    assert.deepEqual(await s.readJson('state.json'), { a: 1, b: ['x'] })
    const text = await fs.readFile(path.join(d, 'state.json'), 'utf8')
    assert.match(text, /\n {2}"a": 1/)
    const names = await fs.readdir(d)
    assert.equal(names.some((n) => n.includes('.tmp-')), false, 'tmp 文件必须已被 rename 掉')
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('readJson：不存在的文件返回兜底值，不抛', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    assert.equal(await s.readJson('nope.json'), null)
    assert.deepEqual(await s.readJson('nope.json', { def: 1 }), { def: 1 })
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('**坏 JSON 不炸**：返回兜底 + 记 warn + 现场改名 .corrupt-*', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    await s.init()
    await fs.writeFile(path.join(d, 'state.json'), '{ 这不是 JSON', 'utf8')
    const v = await s.readJson('state.json', { fallback: true })
    assert.deepEqual(v, { fallback: true })
    assert.equal(s._warns.some((w) => w.includes('JSON 损坏')), true)
    const names = await fs.readdir(d)
    assert.equal(names.some((n) => n.includes('.corrupt-')), true, '坏文件应被改名留证')
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('覆盖前备份 + 只保留最近 5 份', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    // 第一次写没有备份
    assert.equal((await s.writeJson('x.json', { n: 0 })).backups, 0)
    for (let i = 1; i <= 8; i++) await s.writeJson('x.json', { n: i })
    const names = (await fs.readdir(d)).filter((n) => n.startsWith('x.json.bak-'))
    assert.equal(names.length, KEEP_BACKUPS, '备份应只留 ' + String(KEEP_BACKUPS) + ' 份')
    assert.deepEqual(await s.readJson('x.json'), { n: 8 })
    // 最新的备份应当是 n=7
    const newest = names.map((n) => Number(n.split('.bak-')[1])).sort((a, b) => b - a)[0]
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(d, 'x.json.bak-' + String(newest)), 'utf8')), { n: 7 })
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('backup:false 时不产生备份（高频任务流水用）', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    await s.writeJson('y.json', { n: 1 })
    await s.writeJson('y.json', { n: 2 }, { backup: false })
    const names = (await fs.readdir(d)).filter((n) => n.includes('.bak-'))
    assert.equal(names.length, 0)
    assert.deepEqual(await s.readJson('y.json'), { n: 2 })
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('writeJson：不可序列化的值返回错误对象而不是抛', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    const cyc = {}
    cyc.self = cyc
    const r = await s.writeJson('c.json', cyc)
    assert.equal(r.ok, false)
    assert.equal(r.error.code, 'STORE_BAD_VALUE')
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('**并发写同一路径被串行化**（不会互相截断）', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    const tasks = []
    for (let i = 0; i < 40; i++) tasks.push(s.writeJson('race.json', { n: i, pad: 'x'.repeat(2000) }, { backup: false }))
    const rs = await Promise.all(tasks)
    assert.equal(rs.every((r) => r.ok), true)
    const final = await s.readJson('race.json')
    assert.equal(typeof final.n, 'number')
    // 文件必须是完整 JSON（截断的话上面这句就已经炸了）
    assert.equal(final.pad.length, 2000)
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('一次写失败不会毒化后续写（promise 链自愈）', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    const cyc = {}
    cyc.self = cyc
    assert.equal((await s.writeJson('bad.json', cyc)).ok, false)
    assert.equal((await s.writeJson('bad.json', { ok: 1 })).ok, true)
    assert.deepEqual(await s.readJson('bad.json'), { ok: 1 })
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

/* ─────────────────────────────── listDir / remove ─────────────────────────────── */

test('listDir：过滤 tmp/bak/corrupt；支持后缀与去后缀', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    await s.init()
    for (const n of ['a.json', 'b.json', 'c.md', 'a.json.bak-1', 'b.json.tmp-xyz', 'd.json.corrupt-9']) {
      await fs.writeFile(path.join(d, 'tmp', n), 'x')
    }
    const all = await s.listDir('tmp')
    assert.deepEqual(all.sort(), ['a.json', 'b.json', 'c.md'])
    assert.deepEqual((await s.listDir('tmp', { suffix: '.json' })).sort(), ['a', 'b'])
    assert.deepEqual((await s.listDir('tmp', { suffix: '.json', stripSuffix: false })).sort(), ['a.json', 'b.json'])
    assert.deepEqual(await s.listDir('不存在的目录'), [])
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('remove：删文件；不存在也算成功；removeDir 递归删', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    await s.writeJson('gone.json', { a: 1 })
    assert.equal((await s.remove('gone.json')).removed, true)
    assert.equal((await s.remove('gone.json')).removed, false)
    await s.writeOutput('T1', 'a.png', new Uint8Array([1]))
    assert.equal((await s.removeDir('outputs/T1')).ok, true)
    assert.deepEqual(await s.listOutputs('T1'), [])
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

/* ─────────────────────────────── 工作流 ─────────────────────────────── */

test('工作流：saveWorkflow 自动补 createdAt/updatedAt；get/list/delete', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    const r = await s.saveWorkflow({ id: 'wf_a', name: 'Qwen 文生图', rhWorkflowId: '1988' })
    assert.equal(r.ok, true)
    const wf = await s.getWorkflow('wf_a')
    assert.equal(wf.name, 'Qwen 文生图')
    assert.ok(wf.createdAt > 0)
    assert.ok(wf.updatedAt >= wf.createdAt)
    // 二次保存保留 createdAt
    const first = wf.createdAt
    await s.saveWorkflow({ ...wf, name: '改名' })
    assert.equal((await s.getWorkflow('wf_a')).createdAt, first)
    await s.saveWorkflow({ id: 'wf_b', name: 'B' })
    assert.deepEqual((await s.listWorkflows()).map((x) => x.id), ['wf_a', 'wf_b'])
    assert.equal((await s.deleteWorkflow('wf_a')).removed, true)
    assert.equal(await s.getWorkflow('wf_a'), undefined)
    assert.equal((await s.deleteWorkflow('wf_a')).removed, false)
    assert.equal((await s.saveWorkflow({})).ok, false)
    assert.equal((await s.saveWorkflow(null)).ok, false)
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('工作流：listWorkflows 跳过坏文件而不是整个炸掉', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    await s.saveWorkflow({ id: 'good', name: 'OK' })
    await fs.writeFile(path.join(d, 'workflows', 'bad.json'), '{{{', 'utf8')
    const list = await s.listWorkflows()
    assert.deepEqual(list.map((x) => x.id), ['good'])
    assert.equal(s._warns.some((w) => w.includes('JSON 损坏')), true)
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

/* ─────────────────────────────── 提示词文档 ─────────────────────────────── */

test('提示词文档：save/get/list/delete（正文原样存，中文不转义）', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    const content = '# 风格指南\n\n必须使用「电影感打光」。\n'
    const r = await s.savePromptDoc({ name: '电影感', content, sourceFilename: 'style.md' })
    assert.equal(r.ok, true)
    assert.ok(r.bytes > 0)
    const doc = await s.getPromptDoc(r.id)
    assert.equal(doc.content, content, '正文必须原样往返')
    assert.equal(doc.name, '电影感')
    assert.equal(doc.meta.sourceFilename, 'style.md')
    const raw = await fs.readFile(path.join(d, 'prompts', r.id + '.md'), 'utf8')
    assert.equal(raw, content, '落盘不该被 JSON 转义')
    const list = await s.listPromptDocs()
    assert.equal(list.length, 1)
    assert.equal(list[0].name, '电影感')
    assert.equal((await s.deletePromptDoc(r.id)).removed, true)
    assert.equal(await s.getPromptDoc(r.id), undefined)
    assert.equal((await s.savePromptDoc({ content: 123 })).ok, false)
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('提示词文档：空正文也合法；id 缺省时按 name 生成', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    const r = await s.savePromptDoc({ name: 'Empty Doc', content: '' })
    assert.equal(r.ok, true)
    assert.equal(r.id, 'empty-doc')
    const doc = await s.getPromptDoc('empty-doc')
    assert.equal(doc.content, '')
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

/* ─────────────────────────────── 任务 ─────────────────────────────── */

test('任务：saveTask/getTask/listTasks（status 过滤 + limit 取最近 N）', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    for (let i = 0; i < 5; i++) {
      await s.saveTask({ taskId: 'T' + String(i), status: i % 2 === 0 ? 'SUCCESS' : 'FAILED', createdAt: 1000 + i })
    }
    assert.equal((await s.getTask('T1')).status, 'FAILED')
    assert.equal((await s.listTasks()).length, 5)
    assert.deepEqual((await s.listTasks({ status: 'SUCCESS' })).map((x) => x.taskId), ['T0', 'T2', 'T4'])
    assert.deepEqual((await s.listTasks({ limit: 2 })).map((x) => x.taskId), ['T3', 'T4'])
    assert.equal((await s.saveTask({})).ok, false)
    assert.equal(await s.getTask('nope'), undefined)
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('任务：高频写（backup:false）不产生备份文件', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    for (let i = 0; i < 12; i++) await s.saveTask({ taskId: 'T', status: 'RUNNING', pollCount: i })
    const names = await fs.readdir(path.join(d, 'tasks'))
    assert.deepEqual(names, ['T.json'])
    assert.equal((await s.getTask('T')).pollCount, 11)
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

/* ─────────────────────────────── 输出文件 ─────────────────────────────── */

test('输出：outputDir / writeOutput（二进制）/ listOutputs', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    assert.equal(s.outputDir('T9'), path.join(d, 'outputs', 'T9'))
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    const w = await s.writeOutput('T9', 'result.png', png)
    assert.equal(w.ok, true)
    assert.equal(w.bytes, 8)
    assert.deepEqual(Array.from(await fs.readFile(w.path)), Array.from(png))
    assert.deepEqual(await s.listOutputs('T9'), ['result.png'])
    assert.deepEqual(await s.listOutputs('不存在'), [])
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

/* ─────────────────────────────── 机密 ─────────────────────────────── */

test('机密：writeSecrets 走 0600（POSIX 上真生效）', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    const r = await s.writeSecrets({ entries: [{ id: 'a', key: 'rh_secret' }] })
    assert.equal(r.ok, true)
    assert.deepEqual(await s.readSecrets(), { entries: [{ id: 'a', key: 'rh_secret' }] })
    if (process.platform !== 'win32') {
      assert.equal(r.mode, 0o600, 'secrets.json 必须是 0600')
      const st = await fs.stat(path.join(d, 'secrets.json'))
      assert.equal(st.mode & 0o777, 0o600)
    }
    assert.deepEqual(await s.readSecrets(), { entries: [{ id: 'a', key: 'rh_secret' }] })
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('机密：文件缺失时 readSecrets 返回 {}', async () => {
  const d = await tmpDir()
  try {
    assert.deepEqual(await makeStore(d).readSecrets(), {})
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

/* ────────────────────── 机密落盘卫生（Lead 真机抓到的泄漏） ────────────────────── */

test('**机密不留备份**：反复写 secrets.json 也不产生任何 .bak-*（备份=同一份明文）', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    const SECRET = 'rh_LEAK_CANARY_0123456789abcdef'
    for (let i = 0; i < 8; i++) {
      const r = await s.writeSecrets({ pool: { entries: [{ id: 'a', key: SECRET, region: 'cn' }], n: i } })
      assert.equal(r.ok, true)
      assert.equal(r.prunedBackups, 0, '没有历史遗留时不该清出东西')
    }
    const names = await fs.readdir(d)
    assert.deepEqual(names.filter((n) => n.includes('.bak-')), [], 'secrets.json 绝不能留备份')
    // 而且**整个数据目录**里，除了 secrets.json 自己，任何文件都不得含明文
    for (const n of names) {
      const abs = path.join(d, n)
      if ((await fs.stat(abs)).isDirectory() || n === 'secrets.json') continue
      assert.equal((await fs.readFile(abs, 'utf8')).includes(SECRET), false, n + ' 里出现了明文 key')
    }
    // secrets.json 本身必须能读回来（否则重启丢 key）
    assert.equal(JSON.stringify(await s.readSecrets()).includes(SECRET), true)
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('**自愈**：盘上已有历史遗留的 secrets.json.bak-* 会被清掉', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    await s.init()
    const SECRET = 'rh_LEAK_CANARY_0123456789abcdef'
    // 伪造「历史版本留下的明文备份」
    await fs.writeFile(path.join(d, 'secrets.json.bak-111'), JSON.stringify({ pool: { entries: [{ key: SECRET }] } }), 'utf8')
    await fs.writeFile(path.join(d, 'secrets.json.bak-222'), JSON.stringify({ pool: { entries: [{ key: SECRET }] } }), 'utf8')
    // 别的文件的正常备份**不能**被误删
    await fs.writeFile(path.join(d, 'state.json.bak-333'), '{"keep":true}', 'utf8')

    const r = await s.writeSecrets({ pool: {} })
    assert.equal(r.ok, true)
    assert.equal(r.prunedBackups, 2, '两份历史明文备份都要清掉')

    const names = await fs.readdir(d)
    assert.equal(names.some((n) => n.startsWith('secrets.json.bak-')), false, '明文副本必须消失')
    assert.equal(names.includes('state.json.bak-333'), true, '别的文件的备份不能被误删')
    assert.equal(s._warns.some((w) => w.includes('明文备份')), true, '要记一条 warn')
    // 扫盘：整个数据目录里再也找不到那把 canary
    for (const n of names) {
      const abs = path.join(d, n)
      if ((await fs.stat(abs)).isDirectory()) continue
      assert.equal((await fs.readFile(abs, 'utf8')).includes(SECRET), false, n + ' 仍含明文')
    }
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

/* ──────────── Windows 上 rename 被瞬时占用 → 必须重试（否则落盘静默丢失） ──────────── */

test('★ rename 撞上 EPERM 要**退避重试**（Windows：目标文件正被读时 rename 会被拒）', async () => {
  const d = await tmpDir()
  try {
    // 造一个 rename 前 2 次抛 EPERM、第 3 次才成功的假 fs（真实 fs 的其余部分照用）
    const real = await import('node:fs/promises')
    let attempts = 0
    const flaky = {
      ...real,
      rename: async (from, to) => {
        attempts += 1
        if (attempts <= 2) {
          const e = new Error("EPERM: operation not permitted, rename '" + from + "' -> '" + to + "'")
          e.code = 'EPERM'
          throw e
        }
        return real.rename(from, to)
      },
    }
    const s = makeStore(d, { fsImpl: flaky })
    const r = await s.writeJson('flaky.json', { n: 1 })
    assert.equal(r.ok, true, '前两次 EPERM 之后必须成功：' + JSON.stringify(r))
    assert.equal(attempts, 3, '应该是"失败两次、第三次成功"')
    assert.deepEqual(await s.readJson('flaky.json'), { n: 1 })
    // tmp 文件不留残骸
    const names = await fs.readdir(d)
    assert.equal(names.some((n) => n.includes('.tmp-')), false)
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('rename 的重试**只针对瞬时错误**：ENOSPC 之类立即上抛，不做无意义重试', async () => {
  const d = await tmpDir()
  try {
    const real = await import('node:fs/promises')
    let attempts = 0
    const full = {
      ...real,
      rename: async () => {
        attempts += 1
        const e = new Error('ENOSPC: no space left on device')
        e.code = 'ENOSPC'
        throw e
      },
    }
    const s = makeStore(d, { fsImpl: full })
    const r = await s.writeJson('nospace.json', { n: 1 })
    assert.equal(r.ok, false)
    assert.match(r.error.message, /ENOSPC/)
    assert.equal(attempts, 1, '非瞬时错误不该重试')
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('rename 一直 EPERM → 最终如实失败（不假装写成功）', async () => {
  const d = await tmpDir()
  try {
    const real = await import('node:fs/promises')
    const stuck = {
      ...real,
      rename: async () => {
        const e = new Error('EPERM: forever locked')
        e.code = 'EPERM'
        throw e
      },
    }
    const s = makeStore(d, { fsImpl: stuck })
    const r = await s.writeJson('stuck.json', { n: 1 })
    assert.equal(r.ok, false, '一直失败就必须报失败，不能静默当成功')
    assert.match(r.error.message, /EPERM/)
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('saveState 浅合并：**删字段会静默失败**（要用 writeJson 整体覆写）', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    await s.saveState({ keys: [{ id: 'a', key: 'rh_x' }], region: 'cn' })
    // 调用方想"删掉 keys"
    const cur = await s.loadState()
    delete cur.keys
    await s.saveState(cur)
    assert.equal('keys' in (await s.loadState()), true, '浅合并会把删掉的键合并回来 —— 这就是那个坑')
    // 正确做法：整体覆写
    const cur2 = await s.loadState()
    delete cur2.keys
    await s.writeJson('state.json', cur2)
    assert.equal('keys' in (await s.loadState()), false)
    assert.equal((await s.loadState()).region, 'cn')
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

/* ─────────────────────────────── state / log / stats ─────────────────────────────── */

test('state：saveState 是浅合并，不丢别的键', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    await s.saveState({ region: 'cn', lastUsage: { coins: 10 } })
    await s.saveState({ lastUsage: { coins: 8 } })
    assert.deepEqual(await s.loadState(), { region: 'cn', lastUsage: { coins: 8 } })
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('log：追加写，不抛', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    assert.equal((await s.log('plugin', 'hello')).ok, true)
    assert.equal((await s.log('plugin', 'world')).ok, true)
    const text = await fs.readFile(path.join(d, 'logs', 'plugin.log'), 'utf8')
    assert.match(text, /hello/)
    assert.match(text, /world/)
    assert.equal(text.split('\n').filter(Boolean).length, 2)
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('stats：报出 dataDir / 可写 / 计数', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    await s.saveWorkflow({ id: 'w1', name: 'W' })
    await s.saveTask({ taskId: 'T1', status: 'SUCCESS' })
    await s.savePromptDoc({ name: 'D', content: 'x' })
    const st = await s.stats()
    assert.equal(st.ok, true)
    assert.equal(st.dataDir, d)
    assert.equal(st.writable, true)
    assert.equal(st.counts.workflows, 1)
    assert.equal(st.counts.tasks, 1)
    assert.equal(st.counts.promptDocs, 1)
    assert.deepEqual(JSON.parse(JSON.stringify(st)), st)
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})

test('所有返回值都是 lossless JSON', async () => {
  const d = await tmpDir()
  try {
    const s = makeStore(d)
    const vals = [
      await s.init(),
      await s.writeJson('a.json', { a: 1 }),
      await s.readJson('a.json'),
      await s.listWorkflows(),
      await s.getWorkflow('nope'),
      await s.saveWorkflow({ id: 'w', name: 'W' }),
      await s.deleteWorkflow('w'),
      await s.listPromptDocs(),
      await s.savePromptDoc({ name: 'd', content: 'c' }),
      await s.listTasks(),
      await s.saveTask({ taskId: 'T' }),
      await s.readSecrets(),
      await s.writeSecrets({}),
      await s.loadState(),
      await s.saveState({ x: 1 }),
      await s.stats(),
    ]
    // `getX` 找不到时返回 undefined（Lead 契约）——undefined 不是 lossless JSON 值，
    // 所以工具层必须先把「找不到」转成 null/错误回执；这里只校验**有值**的那些。
    for (const v of vals) {
      if (v === undefined) continue
      assert.deepEqual(JSON.parse(JSON.stringify(v)), v)
    }
  } finally {
    await fs.rm(d, { recursive: true, force: true })
  }
})
