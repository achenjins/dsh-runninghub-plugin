/**
 * 输出落盘：**目录可配** + **文件名可由 AI 指定**（`workflow.run` 的 `saveDir` / `fileName`）。
 *
 * 为什么值得单独测：
 *   - 用户的核心诉求就是"图存到我要的目录、叫我要的名字"，这条链错了等于功能没做；
 *   - **去重是硬需求**：一次任务出 4 张图时 AI 只会给一个 `fileName`，
 *     不去重就会互相覆盖，最后只剩一张（这种 bug 用户要跑完才发现）；
 *   - `fileName` 是**外部输入**（AI/用户给的），必须防目录穿越。
 *
 * @module dsh-runninghub-plugin/tests/core/store-output
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import { Store } from '../../host/core/store.mjs'

/** 起一个用临时目录的 store。 */
async function freshStore(opts = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-out-data-'))
  const outputsRoot = opts.outputsRoot || (await fs.mkdtemp(path.join(os.tmpdir(), 'rh-out-root-')))
  const store = new Store({ dataDir, outputsRoot, logger: null })
  return { store, dataDir, outputsRoot }
}

const bytes = (n) => new Uint8Array(Array.from({ length: n }, (_, i) => i % 256))

test('outputsRoot：缺省 = <dataDir>/outputs；显式给出则用显式的', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-def-'))
  const a = new Store({ dataDir })
  assert.equal(a.outputsRoot, path.join(dataDir, 'outputs'), '缺省应落在 <dataDir>/outputs')

  const custom = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-cus-'))
  const b = new Store({ dataDir, outputsRoot: custom })
  assert.equal(b.outputsRoot, path.resolve(custom), '显式 outputsRoot 应生效')
  // 数据目录本身不受影响 —— 工作流配置 / 任务流水 / 机密仍留在 dataDir
  assert.equal(b.dataDir, path.resolve(dataDir), 'dataDir 不该被 outputsRoot 影响')
})

test('writeOutput：缺省落到 <outputsRoot>/<taskId>/<真实文件名>', async () => {
  const { store, outputsRoot } = await freshStore()
  const r = await store.writeOutput('t1', 'orig.png', bytes(8))
  assert.equal(r.ok, true)
  assert.equal(r.path, path.join(outputsRoot, 't1', 'orig.png'))
  assert.equal(r.bytes, 8)
  assert.equal((await fs.stat(r.path)).size, 8, '文件应真的在磁盘上')
})

test('saveDir：单任务覆盖落盘目录 —— **扁平放进该文件夹**，不影响别的任务', async () => {
  const { store, outputsRoot } = await freshStore()
  const custom = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-save-'))

  store.setTaskOutput('withDir', { dir: custom })
  const a = await store.writeOutput('withDir', 'a.png', bytes(4))
  const b = await store.writeOutput('noDir', 'b.png', bytes(4))

  // 给了 saveDir 就是**目标文件夹本身**（用户要的是一个文件夹，不是每次新建一个）
  assert.equal(a.path, path.join(custom, 'a.png'), 'saveDir 应是目标文件夹本身（扁平）')
  assert.ok(!a.path.includes('withDir'), '不该再套一层 taskId 子目录')
  // 没给的仍走老布局（<outputsRoot>/<taskId>）
  assert.equal(b.path, path.join(outputsRoot, 'noDir', 'b.png'), '没给 saveDir 的任务不受影响')
})

test('fileName：套用文件名；**省扩展名时自动补真实扩展名**', async () => {
  const { store, outputsRoot } = await freshStore()

  store.setTaskOutput('n1', { fileName: '英雄立绘' }) // 无扩展名
  const a = await store.writeOutput('n1', 'remote_x.png', bytes(3))
  assert.equal(path.basename(a.path), '英雄立绘.png', '应补上真实扩展名且保留中文')

  store.setTaskOutput('n2', { fileName: 'shot.webp' }) // 自带扩展名
  const b = await store.writeOutput('n2', 'remote_x.png', bytes(3))
  assert.equal(path.basename(b.path), 'shot.webp', '自带扩展名时原样使用（不叠加）')

  // 真实文件名没有扩展名 → 不硬补
  store.setTaskOutput('n3', { fileName: 'raw' })
  const c = await store.writeOutput('n3', 'noext', bytes(3))
  assert.equal(path.basename(c.path), 'raw', '真实文件无扩展名时不补')
  assert.ok(c.path.startsWith(outputsRoot), '仍在 outputsRoot 下')
})

test('★ 同名去重：一次出 3 张同名图**绝不互相覆盖**', async () => {
  const { store } = await freshStore()
  store.setTaskOutput('batch', { fileName: 'hero' })

  const names = []
  for (let i = 0; i < 3; i += 1) {
    const r = await store.writeOutput('batch', 'remote.png', bytes(4 + i))
    names.push(path.basename(r.path))
  }
  assert.deepEqual(names, ['hero.png', 'hero_2.png', 'hero_3.png'], '三张应各自落盘，不覆盖')

  // 三份内容都在，且大小分别是 4 / 5 / 6 —— 证明没有后者覆盖前者
  const sizes = await Promise.all(names.map(async (n) => (await fs.stat(path.join(store.outputDir('batch'), n))).size))
  assert.deepEqual(sizes, [4, 5, 6], '三份内容都得在（覆盖的话就只剩最后一份）')
})

test('★ fileName 是外部输入：目录穿越必须被中和', async () => {
  const { store, outputsRoot } = await freshStore()
  const dir = store.outputDir('evil')

  for (const nasty of ['../../escape', '..\\..\\escape', 'a/b/c', '....//x']) {
    store.setTaskOutput('evil', { fileName: nasty })
    const r = await store.writeOutput('evil', 'x.png', bytes(1))
    assert.equal(r.ok, true, '不该抛：' + nasty)
    const rel = path.relative(dir, r.path)
    assert.ok(!rel.startsWith('..'), '不许写到任务目录之外：' + nasty + ' → ' + r.path)
    assert.ok(r.path.startsWith(outputsRoot), '必须仍在 outputsRoot 内：' + r.path)
  }
})

test('setTaskOutput({}) / 空字段 = 清除覆盖，回到全局 outputsRoot', async () => {
  const { store, outputsRoot } = await freshStore()
  store.setTaskOutput('t', { dir: path.join(os.tmpdir(), 'rh-gone-'), fileName: 'zzz' })
  store.setTaskOutput('t', {}) // 清空
  const r = await store.writeOutput('t', 'plain.png', bytes(2))
  assert.equal(r.path, path.join(outputsRoot, 't', 'plain.png'), '覆盖清掉后应回默认目录')
  assert.equal(path.basename(r.path), 'plain.png', '文件名也应回默认')
})

test('显式 opts.root 的优先级高于任务的 saveDir', async () => {
  const { store } = await freshStore()
  const taskDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-t-'))
  const callDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-c-'))
  store.setTaskOutput('p', { dir: taskDir })
  const r = await store.writeOutput('p', 'f.png', bytes(1), { root: callDir })
  assert.equal(r.path, path.join(callDir, 'f.png'), '调用方显式 root 应赢（且是扁平）')
})

test('★ 用户要的形态：文件**直接躺在那一个文件夹里**（不再一层 taskId）', async () => {
  const { store } = await freshStore()
  // 模拟会话工作目录下的新建文件夹
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-wd-'))
  const folder = path.join(workdir, 'runninghub-output')

  store.setTaskOutput('taskA', { dir: folder, fileName: '黑龙骑士' })
  const a = await store.writeOutput('taskA', 'remote_1.png', bytes(10))
  store.setTaskOutput('taskB', { dir: folder, fileName: '黑龙骑士' })
  const b = await store.writeOutput('taskB', 'remote_2.png', bytes(20))

  assert.equal(a.path, path.join(folder, '黑龙骑士.png'))
  assert.equal(b.path, path.join(folder, '黑龙骑士_2.png'), '不同任务同名也要去重（同一文件夹不会互相覆盖）')

  const listed = (await fs.readdir(folder)).sort()
  assert.deepEqual(listed, ['黑龙骑士.png', '黑龙骑士_2.png'], '文件夹里就这两个文件，路径深度只有一层')
})

test('listOutputs：输出目录可能是**用户指定的任意文件夹**，也要列得出来', async () => {
  const { store } = await freshStore()
  const custom = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-lo-'))
  store.setTaskOutput('lt', { dir: custom })
  await store.writeOutput('lt', 'one.png', bytes(3))
  await store.writeOutput('lt', 'two.png', bytes(4))
  assert.deepEqual(await store.listOutputs('lt'), ['one.png', 'two.png'])
  // 目录不存在时不抛，回空数组
  assert.deepEqual(await store.listOutputs('nope'), [])
})
