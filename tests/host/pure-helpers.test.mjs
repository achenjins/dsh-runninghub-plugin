import test from 'node:test'
import assert from 'node:assert/strict'
import { losslessSanitize as hostSanitize } from '../../host/shared.mjs'
import { losslessSanitize as coreSanitize, isPlainObject } from '../../host/core/util.mjs'
import { matchWorkflow } from '../../host/workflow-match.mjs'
import { makeCallTool } from '../../host/tools/call.mjs'
import { buildMethods } from '../../host/rpc.mjs'

test('shared sanitizer preserves host and core fixes reporting', () => {
  const source = { absent: undefined, small: 7n, large: 9007199254740993n, fn() {}, symbol: Symbol('x'), nan: NaN, zero: -0 }
  const expected = { small: 7, large: '9007199254740993', nan: null, zero: 0 }
  const host = hostSanitize(source)
  const core = coreSanitize(source)
  assert.deepEqual(host.value, expected)
  assert.deepEqual(core.value, expected)
  assert.deepEqual(core.fixes, ['value.nan=NaN→null', 'value.zero=-0→0'])
  assert.equal(host.fixes.length, 7)
  assert.equal(isPlainObject(Object.create(null)), true)
  assert.equal(isPlainObject([]), false)
})

test('toJSON instances may appear more than once without becoming false cycles', () => {
  class Value {
    toJSON() { return { answer: 42 } }
  }
  class Broken {
    answer = 3
    toJSON() { throw new Error('unavailable') }
  }
  const value = new Value()
  const broken = new Broken()
  for (const sanitize of [hostSanitize, coreSanitize]) {
    assert.deepEqual(sanitize([value, value, broken, broken]).value, [{ answer: 42 }, { answer: 42 }, { answer: 3 }, { answer: 3 }])
    const circular = {}
    circular.self = circular
    assert.deepEqual(sanitize(circular).value, { self: '[Circular]' })
  }
})

test('sanitized collections and own __proto__ fields survive a JSON roundtrip', () => {
  const source = JSON.parse('{"__proto__":{"businessField":true},"name":"value"}')
  source.set = new Set([undefined, () => {}, Symbol('x'), 2])
  source.map = new Map([['undefined', undefined]])
  for (const sanitize of [hostSanitize, coreSanitize]) {
    const { value } = sanitize(source)
    assert.deepEqual(value.set, [null, null, null, 2])
    assert.deepEqual(value.map, [['undefined', null]])
    assert.equal(Object.getPrototypeOf(value), Object.prototype)
    assert.equal(Object.hasOwn(value, '__proto__'), true)
    assert.deepEqual(JSON.parse(JSON.stringify(value)), value)
  }
})

test('workflow matching gives exact names and IDs precedence over aliases', () => {
  const alias = { id: 'alias', name: 'Other', displayNameEn: 'real' }
  const exactId = { id: 'real', name: 'Actual' }
  const exactName = { id: 'name', name: 'real' }
  const insensitiveName = { id: 'case', name: 'REAL' }
  assert.equal(matchWorkflow([alias, exactId], ' real '), exactId)
  assert.equal(matchWorkflow([alias, exactId, exactName], 'real'), exactName)
  assert.equal(matchWorkflow([alias, insensitiveName], 'real'), insensitiveName)
  assert.equal(matchWorkflow([alias], ' REAL '), alias)
  assert.equal(matchWorkflow([alias], ''), null)
  assert.equal(matchWorkflow([alias], 'missing'), null)
})

test('RPC deletion and model workflow lookup select the same record', async () => {
  const list = [
    { id: 'alias', name: 'Alias', displayNameEn: 'real', nodes: [] },
    { id: 'real', name: 'Actual', nodes: [] },
  ]
  let deleted
  const rt = {
    store: {
      async listWorkflows() { return list },
      async deleteWorkflow(id) { deleted = id; return { ok: true } },
    },
    requireCore() { return null },
    warn() {},
  }
  const result = await makeCallTool(() => rt).execute({ action: 'workflow.get', name: ' real ' }, {})
  assert.equal(result.ok, true)
  assert.equal(result.data.id, 'real')
  const removed = await buildMethods(rt).deleteWorkflow({ name: ' real ' })
  assert.equal(removed.ok, true)
  assert.equal(deleted, result.data.id)
})
