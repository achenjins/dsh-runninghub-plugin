/**
 * tests/core/promptdoc.test.mjs —— `host/core/promptdoc.mjs` 的契约锁定
 *
 * 重点：`needsReadBadge()` 的三条件 · `renderForModel()` 的说明头（两种模式不一样）·
 * 文档 CRUD 往返（走真实 `Store`）· 超长文档截断 · 子代理系统提示词。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

import {
  PromptDocs,
  renderForModel,
  needsReadBadge,
  optimizerEnabled,
  buildSubagentSystemPrompt,
  slugify,
  MAX_RENDER_CHARS,
} from '../../host/core/promptdoc.mjs'
import { Store } from '../../host/core/store.mjs'

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'rh-doc-'))
}

/** 建一个带真 store 的 PromptDocs。 */
async function makeDocs() {
  const dir = await tmpDir()
  const store = new Store({ dataDir: dir })
  await store.init()
  return {
    dir,
    store,
    docs: new PromptDocs({ store }),
    async close() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

/* ─────────────────────────────── slugify ─────────────────────────────── */

test('slugify：稳定、可复现、中文保留、空输入有兜底', () => {
  assert.equal(slugify('电影感 Prompt'), '电影感-prompt')
  assert.equal(slugify('  a  b  '), 'a-b')
  assert.equal(slugify(''), 'doc')
  assert.equal(slugify('!!!'), 'doc')
  assert.equal(slugify('!!!', 'x'), 'x')
  assert.equal(slugify('A/B\\C'), 'a-b-c')
  // 幂等
  const once = slugify('Qwen 文生图 v2')
  assert.equal(slugify(once), once)
})

/* ─────────────────────────────── needsReadBadge ─────────────────────────────── */

test('needsReadBadge：三条件都满足才为真', () => {
  const base = { enabled: true, docId: 'd1', asSubagentSystemPrompt: true }
  assert.equal(needsReadBadge({ promptOptimizer: base }), true)
  assert.equal(needsReadBadge({ promptOptimizer: { ...base, enabled: false } }), false, '没启用优化 → 不拦')
  assert.equal(needsReadBadge({ promptOptimizer: { ...base, docId: null } }), false, '没挂文档 → 不拦')
  assert.equal(needsReadBadge({ promptOptimizer: { ...base, docId: '' } }), false)
  assert.equal(needsReadBadge({ promptOptimizer: { ...base, asSubagentSystemPrompt: false } }), false, '只是参考资料 → 不拦')
  assert.equal(needsReadBadge({}), false)
  assert.equal(needsReadBadge(null), false)
  assert.equal(needsReadBadge({ promptOptimizer: {} }), false)
  assert.equal(optimizerEnabled({ promptOptimizer: { enabled: true } }), true)
  assert.equal(optimizerEnabled({}), false)
})

/* ─────────────────────────────── renderForModel ─────────────────────────────── */

test('renderForModel：必须带「必须按本文档优化提示词」的说明头', () => {
  const text = renderForModel({ name: '风格指南', content: '只用电影感打光。' })
  assert.match(text, /提示词优化文档/)
  assert.match(text, /必须/)
  assert.match(text, /风格指南/)
  assert.match(text, /只用电影感打光。/)
  assert.ok(text.indexOf('必须') < text.indexOf('只用电影感打光。'), '说明头必须在前')
})

test('renderForModel：子代理模式的头是「硬性规范」，参考模式的头是「参考资料」', () => {
  const doc = { name: 'D', content: '正文' }
  const sub = renderForModel(doc, { mode: 'subagent' })
  assert.match(sub, /硬性规范/)
  assert.match(sub, /以文档为准/)
  const ref = renderForModel(doc, { mode: 'reference' })
  assert.match(ref, /参考资料/)
  assert.match(ref, /以用户为准/)
  assert.notEqual(sub, ref, '两种模式的渲染必须不同')
  // 由 workflow.promptOptimizer.asSubagentSystemPrompt 自动决定
  assert.match(renderForModel(doc, { workflow: { promptOptimizer: { asSubagentSystemPrompt: true } } }), /硬性规范/)
  assert.match(renderForModel(doc, { workflow: { promptOptimizer: { asSubagentSystemPrompt: false } } }), /参考资料/)
  // 传字符串也认
  assert.match(renderForModel('裸正文'), /裸正文/)
})

test('renderForModel：头里点名工作流；超长文档明确截断', () => {
  const text = renderForModel({ name: 'D', content: 'x' }, { workflow: { name: 'Qwen 文生图' } })
  assert.match(text, /Qwen 文生图/)
  const long = renderForModel({ name: 'D', content: 'a'.repeat(MAX_RENDER_CHARS + 500) })
  assert.match(long, /已截断到/)
  assert.ok(long.length < MAX_RENDER_CHARS + 2000)
})

test('buildSubagentSystemPrompt：无工具 + 只输出正文 + 带文档规范', () => {
  const s = buildSubagentSystemPrompt({ name: 'D', content: '不要写水印' }, { extraInstruction: '要国风', targetField: '负向提示词' })
  assert.match(s, /没有工具/)
  assert.match(s, /直接输出最终提示词正文/)
  assert.match(s, /不要写水印/)
  assert.match(s, /要国风/)
  assert.match(s, /负向提示词/)
})

/* ─────────────────────────────── CRUD ─────────────────────────────── */

test('PromptDocs：write/read/list/remove 往返（正文原样）', async () => {
  const rig = await makeDocs()
  try {
    const content = '# 规范\n\n1. 必须写「电影感打光」\n2. 禁止出现文字\n'
    const w = await rig.docs.write({ name: '电影感', content, sourceFilename: 'style.md' })
    assert.equal(w.ok, true)
    assert.equal(w.id, '电影感')

    const doc = await rig.docs.read('电影感')
    assert.equal(doc.content, content)
    assert.equal(doc.name, '电影感')

    const list = await rig.docs.list()
    assert.equal(list.length, 1)
    assert.equal(list[0].sourceFilename, 'style.md')
    assert.deepEqual(JSON.parse(JSON.stringify(list)), list, 'list 必须是 lossless JSON')

    const r = await rig.docs.remove('电影感')
    assert.equal(r.ok, true)
    assert.equal(r.removed, true)
    assert.equal(await rig.docs.read('电影感'), undefined)
  } finally {
    await rig.close()
  }
})

test('PromptDocs.read：支持 id、name、以及按 name 兜底查找', async () => {
  const rig = await makeDocs()
  try {
    await rig.docs.write({ id: 'doc-abc', name: '可读名', content: 'x' })
    assert.equal((await rig.docs.read('doc-abc')).content, 'x')
    assert.equal((await rig.docs.read('可读名')).content, 'x')
    assert.equal(await rig.docs.read('不存在'), undefined)
    assert.equal(await rig.docs.read(''), undefined)
  } finally {
    await rig.close()
  }
})

test('PromptDocs.write：拒绝空内容与超大内容', async () => {
  const rig = await makeDocs()
  try {
    const empty = await rig.docs.write({ name: 'a', content: '' })
    assert.equal(empty.ok, false)
    assert.equal(empty.error.code, 'BAD_REQUEST')
    const huge = await rig.docs.write({ name: 'a', content: 'x'.repeat(1024 * 1024 + 1) })
    assert.equal(huge.ok, false)
    assert.match(huge.error.message, /上限/)
  } finally {
    await rig.close()
  }
})

test('PromptDocs.render：回执带 id/name/text/bytes；找不到 → DOC_NOT_FOUND', async () => {
  const rig = await makeDocs()
  try {
    await rig.docs.write({ name: 'D', content: '正文内容' })
    const r = await rig.docs.render('D')
    assert.equal(r.ok, true)
    assert.equal(r.name, 'D')
    assert.match(r.text, /正文内容/)
    assert.match(r.text, /必须/)
    assert.equal(r.bytes, Buffer.byteLength('正文内容', 'utf8'))
    const miss = await rig.docs.render('没有这个')
    assert.equal(miss.ok, false)
    assert.equal(miss.error.code, 'DOC_NOT_FOUND')
  } finally {
    await rig.close()
  }
})

test('PromptDocs：store 不可用时降级而不是抛', async () => {
  const docs = new PromptDocs({})
  assert.equal(docs.ready, false)
  assert.deepEqual(await docs.list(), [])
  assert.equal(await docs.read('x'), undefined)
  assert.equal((await docs.write({ name: 'a', content: 'b' })).error.code, 'NOT_IMPLEMENTED')
  assert.equal((await docs.remove('a')).error.code, 'NOT_IMPLEMENTED')
})

/* ─────────────────────────────── prepareOptimize ─────────────────────────────── */

test('prepareOptimize：没开优化 → mode=off，不读文档', async () => {
  const rig = await makeDocs()
  try {
    const r = await rig.docs.prepareOptimize({ promptOptimizer: { enabled: false } }, '画只猫')
    assert.equal(r.ok, true)
    assert.equal(r.mode, 'off')
    assert.equal(r.docText, '')
    assert.equal(r.userRequest, '画只猫')
  } finally {
    await rig.close()
  }
})

test('prepareOptimize：开了子代理模式 → 给出 systemPrompt；文档被删 → DOC_NOT_FOUND', async () => {
  const rig = await makeDocs()
  try {
    await rig.docs.write({ id: 'style', name: '风格', content: '冷色调' })
    const cfg = {
      nodes: [{ nodeId: '6', fieldName: 'text', role: 'prompt' }],
      promptOptimizer: { enabled: true, docId: 'style', asSubagentSystemPrompt: true, targetNodeId: null, extraInstruction: '要 4K' },
    }
    const r = await rig.docs.prepareOptimize(cfg, '画只猫')
    assert.equal(r.ok, true)
    assert.equal(r.mode, 'subagent')
    assert.equal(r.docId, 'style')
    assert.equal(r.targetNodeId, '6')
    assert.equal(r.targetField, 'text')
    assert.match(r.systemPrompt, /没有工具/)
    assert.match(r.docText, /冷色调/)
    // 参考模式不给 systemPrompt
    const r2 = await rig.docs.prepareOptimize({ ...cfg, promptOptimizer: { ...cfg.promptOptimizer, asSubagentSystemPrompt: false } }, 'x')
    assert.equal(r2.mode, 'reference')
    assert.equal(r2.systemPrompt, '')
    // 文档被删
    await rig.docs.remove('style')
    const bad = await rig.docs.prepareOptimize(cfg, 'x')
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'DOC_NOT_FOUND')
  } finally {
    await rig.close()
  }
})

test('needsReadBadge 与 prepareOptimize 的 mode 一致（徽标=子代理模式）', async () => {
  const rig = await makeDocs()
  try {
    await rig.docs.write({ id: 'd', name: 'D', content: 'c' })
    const cfg = { nodes: [], promptOptimizer: { enabled: true, docId: 'd', asSubagentSystemPrompt: true } }
    assert.equal(needsReadBadge(cfg), true)
    assert.equal((await rig.docs.prepareOptimize(cfg, '')).mode, 'subagent')
  } finally {
    await rig.close()
  }
})
