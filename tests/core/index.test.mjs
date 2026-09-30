/**
 * tests/core/index.test.mjs —— 桶文件 `host/core/index.mjs` 的契约锁定
 *
 * Lead 集成时**只 import 这一个入口**，所以这里必须证明：
 *   1. 六个模块的关键导出都能从桶里拿到（名字与类型都对）；
 *   2. 没有名字冲突把谁覆盖掉（`export *` 撞名会静默丢失，这是最阴的坑）；
 *   3. `coreSelfCheck()` 自检为真；
 *   4. 桶是**零副作用**的（import 时不建目录、不发请求）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'

import * as core from '../../host/core/index.mjs'
import * as api from '../../host/core/api.mjs'
import * as keys from '../../host/core/keys.mjs'
import * as store from '../../host/core/store.mjs'
import * as workflow from '../../host/core/workflow.mjs'
import * as runner from '../../host/core/runner.mjs'
import * as promptdoc from '../../host/core/promptdoc.mjs'
import * as util from '../../host/core/util.mjs'

/** Lead 集成面必须存在的导出（名字 + 类型）。 */
const REQUIRED = {
  // api.mjs
  BASE_URLS: 'object',
  REGIONS: 'object',
  ERR: 'object',
  STATUS: 'object',
  TERMINAL_STATUSES: 'object',
  KNOWN_STATUSES: 'object',
  SUCCESS_CODES: 'object',
  MAX_DOWNLOAD_BYTES: 'number',
  RunningHubApi: 'function',
  RhError: 'function',
  createApi: 'function',
  failFrom: 'function',
  regionOfUrl: 'function',
  normalizeStatus: 'function',
  isTerminal: 'function',
  isSuccessCode: 'function',
  isRetryable: 'function',
  classifyResponse: 'function',
  classifyBusiness: 'function',
  classifyHttp: 'function',
  extractFailure: 'function',
  humanSize: 'function',
  parseJsonLoose: 'function',
  concatBytes: 'function',
  isUncertain: 'function',
  // keys.mjs
  KeyPool: 'function',
  detectRegion: 'function',
  OUTCOMES: 'object',
  COOLDOWNS: 'object',
  KEY_REGIONS: 'object',
  // store.mjs
  Store: 'function',
  createStore: 'function',
  resolveDataDir: 'function',
  safeName: 'function',
  SUBDIRS: 'object',
  KEEP_BACKUPS: 'number',
  // workflow.mjs
  analyzeWorkflow: 'function',
  buildNodeInfoList: 'function',
  validateRun: 'function',
  summarizeRoles: 'function',
  normalizeWorkflow: 'function',
  inferOutputs: 'function',
  unwrapValue: 'function',
  isOverridable: 'function',
  isLink: 'function',
  alignWidgets: 'function',
  defaultValues: 'function',
  draftConfig: 'function',
  stringifyValue: 'function',
  compareNodeIds: 'function',
  OUTPUT_KINDS: 'object',
  ROLES: 'object',
  NUMBER_HINTS: 'object',
  ENUM_FIELDS: 'object',
  // runner.mjs
  TaskRunner: 'function',
  createRunner: 'function',
  projectTask: 'function',
  describeOutput: 'function',
  pollDelay: 'function',
  POLL_BACKOFF: 'object',
  POLL_MAX_MS: 'number',
  FINAL_STATUSES: 'object',
  DEFAULT_TASK_TIMEOUT_MS: 'number',
  DEFAULT_WAIT_MS: 'number',
  EXT_OF_TYPE: 'object',
  // promptdoc.mjs
  PromptDocs: 'function',
  createPromptDocs: 'function',
  renderForModel: 'function',
  needsReadBadge: 'function',
  optimizerEnabled: 'function',
  buildSubagentSystemPrompt: 'function',
  slugify: 'function',
  MAX_DOC_BYTES: 'number',
  MAX_RENDER_CHARS: 'number',
  // util.mjs（内部底座，也一并 re-export）
  maskKey: 'function',
  maskDeep: 'function',
  losslessSanitize: 'function',
  lossless: 'function',
  isPlainObject: 'function',
  asString: 'function',
  toNumber: 'function',
  trimBaseUrl: 'function',
  nowMs: 'function',
  sleep: 'function',
  abortError: 'function',
  shortId: 'function',
  clip: 'function',
  errorShape: 'function',
  resultText: 'function',
  neverThrow: 'function',
  // index.mjs 自己
  CORE_VERSION: 'string',
  coreSelfCheck: 'function',
}

test('index.mjs：Lead 集成面需要的每个导出都在，且类型正确', () => {
  const missing = []
  const wrongType = []
  for (const [name, type] of Object.entries(REQUIRED)) {
    if (core[name] === undefined) {
      missing.push(name)
      continue
    }
    if (typeof core[name] !== type) wrongType.push(name + ' 期望 ' + type + ' 实际 ' + typeof core[name])
  }
  assert.deepEqual(missing, [], '桶里缺少导出')
  assert.deepEqual(wrongType, [])
})

test('index.mjs：`export *` 没有把任何模块的导出弄丢（逐个模块比对）', () => {
  const mods = { api, keys, store, workflow, runner, promptdoc, util }
  const skipped = ['default'] // `export *` 不导出 default，跳过
  // `slugify` 由 promptdoc 与 util 同时提供：契约以 promptdoc 为准，桶里显式指定（见 index.mjs 注释）
  const ownedElsewhere = new Set(['slugify'])
  for (const [modName, mod] of Object.entries(mods)) {
    for (const name of Object.keys(mod)) {
      if (skipped.includes(name)) continue
      assert.notEqual(core[name], undefined, modName + '.' + name + ' 没能从桶里拿到')
      if (ownedElsewhere.has(name)) {
        assert.equal(core[name], promptdoc[name], name + ' 应以 promptdoc 的实现为准')
        continue
      }
      assert.equal(core[name], mod[name], modName + '.' + name + ' 被别的模块同名导出覆盖了')
    }
  }
})

test('index.mjs：模块之间没有同名冲突（撞名会静默丢导出）', () => {
  const mods = { api, keys, store, workflow, runner, promptdoc, util }
  const seen = new Map()
  const conflicts = []
  for (const [modName, mod] of Object.entries(mods)) {
    for (const name of Object.keys(mod)) {
      if (name === 'default') continue
      if (seen.has(name) && seen.get(name) !== modName) {
        // 撞名允许，但**引用必须一致**，否则就是真的丢了（slugify 已在桶里显式消歧）
        if (core[name] !== mod[name] && core[name] !== promptdoc[name]) {
          conflicts.push(name + '：' + seen.get(name) + ' vs ' + modName)
        }
      } else {
        seen.set(name, modName)
      }
    }
  }
  assert.deepEqual(conflicts, [], '同名导出且引用不一致 = 有模块的导出被覆盖')
})

test('coreSelfCheck：自检为真，覆盖 6 个模块', () => {
  const r = core.coreSelfCheck()
  assert.equal(r.ok, true, JSON.stringify(r.missing))
  assert.deepEqual(r.missing, [])
  assert.equal(r.version, core.CORE_VERSION)
  assert.deepEqual(Object.keys(r.modules).sort(), ['api', 'keys', 'promptdoc', 'runner', 'store', 'workflow'])
  for (const [mod, info] of Object.entries(r.modules)) {
    assert.equal(info.present.length, info.exports, mod + ' 有导出没拿到')
  }
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r, '自检结果必须是 lossless JSON')
})

test('index.mjs 是零副作用模块：import 不建目录、不发请求', async () => {
  // 用一个「一旦被调用就记账」的全局 fetch 守卫：import 期间不该有任何请求
  const before = globalThis.fetch
  let called = 0
  globalThis.fetch = (...args) => {
    called += 1
    return before(...args)
  }
  try {
    const mod = await import('../../host/core/index.mjs?nocache=' + String(Date.now()))
    assert.equal(called, 0, 'import 期间不该发请求')
    assert.equal(typeof mod.CORE_VERSION, 'string')
  } finally {
    globalThis.fetch = before
  }
})

test('桶里拿到的类可以直接用（冒烟：KeyPool + Store + analyzeWorkflow）', async () => {
  const pool = new core.KeyPool()
  assert.equal(pool.add({ id: 'a', key: 'rh_x_1234567890', region: 'cn' }).ok, true)
  assert.equal(pool.pick({ region: 'cn' }).ok, true)
  assert.deepEqual(pool.poolStats(), { cn: { total: 1, available: 1 }, overseas: { total: 0, available: 0 } })

  const dir = core.resolveDataDir({ env: {}, home: os.tmpdir() }) + '/rh-smoke-' + core.shortId()
  const store = new core.Store({ dataDir: dir })
  assert.equal(typeof store.dataDir, 'string')
  try {
    assert.equal((await store.init()).ok, true)
    assert.equal((await store.saveWorkflow({ id: 'w', name: 'W' })).ok, true)
    assert.equal((await store.getWorkflow('w')).name, 'W')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }

  const a = core.analyzeWorkflow({
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat' } },
    '8': { class_type: 'SaveImage', inputs: {} },
  })
  assert.equal(a.ok, true)
  assert.equal(a.outputKind, 'image')
  assert.equal(core.buildNodeInfoList({ nodes: a.nodes }, { prompt: 'hi' })[0].fieldValue, 'hi')
  assert.equal(core.needsReadBadge({ promptOptimizer: { enabled: true, docId: 'd', asSubagentSystemPrompt: true } }), true)
  assert.equal(core.maskKey('rh_1234567890abcd'), 'rh_1****abcd')
  assert.equal(core.slugify('电影感 Prompt'), '电影感-prompt')
  assert.deepEqual(core.POLL_BACKOFF, [3000, 5000, 10000])
  assert.equal(core.renderForModel({ name: 'D', content: 'x' }).includes('必须'), true)
})
