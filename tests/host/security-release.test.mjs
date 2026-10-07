import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRedactor, maskKey } from '../../host/security.mjs'
import { Store } from '../../host/core/store.mjs'
import { KeyPool } from '../../host/core/keys.mjs'
import { RunningHubApi } from '../../host/core/api.mjs'
import { createRuntime } from '../../host/runtime.mjs'
import { buildMethods } from '../../host/rpc.mjs'
import { makeCallTool } from '../../host/tools/call.mjs'
import { makeSearchTool } from '../../host/tools/search.mjs'
import { scanReleaseFile, packageFiles, auditGitHistory, auditGitIndex } from '../../tools/check-release.mjs'
import { loadClientModule, createStubCtx, flushAsync } from '../client/harness.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const secret = 'synthetic-' + '0123456789abcdef'.repeat(2)
const another = 'synthetic-' + 'fedcba9876543210'.repeat(2)
const fresh = 'synthetic-' + 'abcdef1234567890'.repeat(2)

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-security-'))
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), dir)
    assert.ok(relative.startsWith('rh-security-') && !relative.includes(path.sep))
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return dir
}

function runtime() {
  const logs = []
  const rt = createRuntime({ ctx: { get: () => undefined }, config: {}, logger: { warn: (message) => logs.push(message) } })
  rt.core = {}
  rt.pool = new KeyPool()
  rt.pool.add({ id: 'one', key: secret, region: 'cn' })
  rt.pool.add({ id: 'two', key: another, region: 'overseas' })
  return { rt, logs }
}

test('统一脱敏处理消息、嵌套 JSON、不同 Key 和认证字段，并保持协议与已有掩码', () => {
  const redact = createRedactor([secret, 'k'])
  const raw = { taskId: 'task-key', taskStatus: 'RUNNING', keyMasked: '46eb********06340', note: 'failed ' + secret,
    nested: { authorization: 'Bearer ' + another, apiKey: another }, envelope: JSON.stringify({ error: 'failed ' + secret }),
    [secret]: 'private member name', short: 'key=k',
  }
  const out = redact(raw)
  assert.equal(out.taskId, 'task-key')
  assert.equal(out.taskStatus, 'RUNNING')
  assert.equal(out.keyMasked, raw.keyMasked)
  assert.ok(!JSON.stringify(out).includes(secret))
  assert.ok(!JSON.stringify(out).includes(another))
  assert.equal(out.short, 'key=****')
  assert.deepEqual(redact(out), out)
  assert.equal(maskKey('a'), '****')
  const signedUrl = 'https://cdn.example.invalid/result.png?token=opaque-signature-value&expires=123'
  assert.equal(redact({ url: signedUrl }).url, signedUrl)
  assert.equal(redact('[下载结果](' + signedUrl + ')'), '[下载结果](' + signedUrl + ')')
  assert.ok(!redact('下载 https://cdn.example.invalid/result?token=' + secret).includes(secret))
  assert.ok(!redact('{"note":"\\u0073' + secret.slice(1) + '"}').includes(secret.slice(1)))
})

test('API 回执中的其它凭据与第二层 JSON 也脱敏，短测试 Key 不破坏字段名', async () => {
  // ⚠️ `knownSecrets` 是**生产真实形态**：`runtime.mjs` 一定会注入「池里全部明文 Key」
  //    的惰性函数。这里如实模拟，否则测的就不是线上行为。
  //
  // 为什么必须这样：脱敏曾经完全依赖「按字段名掩码」（`key`/`token`/`secret`…命中就掩）。
  // 那条路能兜住"服务端回显别的凭据"，但代价是**把工作流节点里叫 `api_key`/`token`
  // 的正常参数也改成 `sk-l****epme`**，而它还会作为节点默认值被原样提交给平台 ——
  // 静默损坏一次付费请求，且不报任何错。
  // 现在改成「按**字面量**抹已知密钥」：既盖住池里每一把 Key，又不碰用户的正常参数。
  const api = new RunningHubApi({
    knownSecrets: () => [secret, another],
    fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: {
      key: another, authorization: 'Bearer ' + secret, note: 'apiKey=' + another,
      wrapped: JSON.stringify({ apiKey: another }), taskStatus: 'RUNNING',
    } })),
  })
  const result = await api.accountStatus('k', 'cn')
  assert.equal(result.ok, true)
  assert.equal(result.data.raw.taskStatus, 'RUNNING')
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.ok(!JSON.stringify(result).includes(another))
})

test('★ 业务参数不被误伤：字段名叫 api_key / token / secret 的**正常值**必须原样保留', async () => {
  // 真机形态：ComfyUI 工作流的节点入参里 `token` / `api_key` / `secret` 很常见，
  // 它们的值是**用户的业务参数**，不是凭据。按字段名掩码会把
  // `{ api_key: 'sk-live-keepme' }` 改成 `sk-l****epme`，然后 buildNodeInfoList
  // 会把改写过的 default **原样提交** —— 静默提交残缺值。
  const nodeParams = { text: 'a cat', token: 'node-token-abc', api_key: 'sk-live-keepme', password: 'not-a-credential', seed: 42 }
  const api = new RunningHubApi({
    knownSecrets: () => [secret],
    fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: { prompt: { '6': { class_type: 'LLMNode', inputs: nodeParams } } } })),
  })
  const result = await api.getWorkflowJson('k', 'cn', '1234567890')
  const inputs = result.workflow['6'].inputs
  assert.deepEqual(inputs, nodeParams, '★ 业务参数必须逐字保留（这是"静默提交残缺值"的护栏）')
  // 同时：**本次使用的 Key**若被回显，仍必须被抹掉
  const echoed = await new RunningHubApi({
    knownSecrets: () => [secret],
    fetchImpl: async () => new Response(JSON.stringify({ code: 0, data: { msg: 'bad ' + secret } })),
  }).accountStatus('k', 'cn')
  assert.ok(!JSON.stringify(echoed).includes(secret), '回显的本次 Key 仍须被抹')
})

test('工作流经面板和模型工具读写后保留普通认证同名参数与 JSON 信封', async (t) => {
  const dir = await temporary(t)
  const store = new Store({ dataDir: dir })
  await store.init()
  const { rt } = runtime()
  rt.store = store
  const params = { token: 'node-token-abc', api_key: 'user-business-value', password: 'not-a-credential' }
  const wrapped = JSON.stringify(params, null, 2)
  await store.saveWorkflow({ id: 'wf', name: 'Workflow', rhWorkflowId: '123', region: 'cn', nodes: [
    { nodeId: '1', fieldName: 'options', valueType: 'json', default: params },
    { nodeId: '2', fieldName: 'wrapped', valueType: 'json', default: wrapped },
  ] })
  const methods = buildMethods(rt)
  const config = (await methods.listWorkflows())[0]
  assert.deepEqual(config.nodes[0].defaultValue, params)
  assert.equal(config.nodes[1].defaultValue, wrapped)
  assert.equal((await methods.saveWorkflow({ config })).ok, true)
  assert.deepEqual((await store.getWorkflow('wf')).nodes[0].default, params)

  const tool = makeCallTool(() => rt)
  const result = await tool.execute({ action: 'workflow.get', name: 'Workflow', params }, {})
  assert.equal(result.ok, true)
  assert.deepEqual(result.data.nodes[0].default, params)
  assert.deepEqual(JSON.parse(result.envelope).data.nodes[0].default, params)
  assert.equal(result.data.nodes[1].default, wrapped)
  assert.equal((await tool.execute({ action: 'workflow.configure', config: result.data }, {})).ok, true)
  assert.deepEqual((await store.getWorkflow('wf')).nodes[0].default, params)
})

test('结果下载异常也脱敏显式认证 Header，不改变下载请求使用的凭据', async () => {
  let sent
  const api = new RunningHubApi({ fetchImpl: async (_url, options) => { sent = options.headers.Authorization; throw new Error('download with ' + secret) } })
  const result = await api.downloadBytes('https://example.invalid/result.png', { headers: { Authorization: 'Bearer ' + secret } })
  assert.equal(sent, 'Bearer ' + secret)
  assert.equal(result.ok, false)
  assert.ok(!JSON.stringify(result).includes(secret))
})

test('Remote 方法表和 HTTP 使用的通用方法表均脱敏余额与诊断', async () => {
  const { rt, logs } = runtime()
  rt.api = { accountStatus: async () => ({ ok: true, data: { remainCoins: 1, apiKey: another, note: 'failed ' + secret } }) }
  rt.warn('upstream returned ' + another)
  const methods = buildMethods(rt)
  const result = await methods.keysBalance({ id: 'one' })
  assert.equal(result.remainCoins, 1)
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.ok(!JSON.stringify(result).includes(another))
  assert.ok(!JSON.stringify(await methods.diagnostics()).includes(another))
  assert.ok(!logs.join('\n').includes(another))
})

test('模型工具不提供 Key 明文写入口；拒绝时不回显凭据', async () => {
  const { rt, logs } = runtime()
  const tool = makeCallTool(() => rt)
  for (const action of ['key.add', 'key.update', 'key.remove']) {
    const result = await tool.execute({ action, key: fresh, id: 'one', patch: { key: fresh } }, {})
    assert.equal(result.error.code, 'UNKNOWN_ACTION')
    assert.ok(!JSON.stringify(result).includes(secret))
    assert.ok(!JSON.stringify(result).includes(fresh))
  }
  assert.equal(rt.pool.rawKey('one'), secret)
  for (const field of ['key', 'label', 'priority']) assert.ok(!Object.hasOwn(tool.parameters.properties, field))
  assert.ok(!(await makeSearchTool().execute({})).text.includes('key.add'))
  assert.ok(!logs.join('\n').includes(secret))
  assert.ok(!logs.join('\n').includes(fresh))
})

test('RPC 和通用 Remote 桥捕获未入池的新 Key，删除或更新失败仍遮住旧 Key', async () => {
  for (const method of ['keysAdd', 'keysUpdate', 'keysRemove']) {
    for (const bridge of [false, true]) {
      const { rt, logs } = runtime()
      const remove = rt.pool.remove.bind(rt.pool)
      const mutate = () => { remove('one'); throw new Error('old=' + secret + ' new=' + fresh) }
      rt.pool.add = mutate
      rt.pool.update = mutate
      rt.pool.remove = () => { remove('one'); throw new Error('old=' + secret) }
      const params = method === 'keysAdd' ? { entry: { key: fresh, region: 'cn' } }
        : method === 'keysUpdate' ? { id: 'one', patch: { key: fresh } } : { id: 'one' }
      const methods = buildMethods(rt)
      const result = bridge ? await methods.call({ callJson: JSON.stringify({ method, params }) }) : await methods[method](params)
      assert.equal(result.ok, false)
      assert.ok(!JSON.stringify(result).includes(secret))
      assert.ok(!JSON.stringify(result).includes(fresh))
      assert.ok(!logs.join('\n').includes(secret))
      assert.ok(!logs.join('\n').includes(fresh))
    }
  }
})

test('工作流查询的描述和内部 JSON 信封不会回显池中的 Key', async () => {
  const { rt } = runtime()
  rt.store = { listWorkflows: async () => [{ id: 'wf', name: 'wf', description: 'credential=' + secret, nodes: [] }] }
  const result = await makeCallTool(() => rt).execute({ action: 'workflow.get', name: 'wf' }, {})
  assert.equal(result.ok, true)
  assert.ok(!JSON.stringify(result).includes(secret))
  assert.ok(JSON.parse(result.envelope).data)
})

test('search 只索引动作，不读取业务；workflow.get 默认概要，具名查询才返回节点', async () => {
  let runtimeReads = 0
  const search = makeSearchTool(() => { runtimeReads += 1; throw new Error('search 不应访问业务运行时') })
  const actions = await search.execute({}, {})
  assert.equal(actions.ok, true)
  assert.equal(runtimeReads, 0)
  assert.match(actions.text, /workflow\.get/)
  assert.match(actions.text, /task\.wait/)
  assert.deepEqual(Object.keys(search.parameters.properties), [])
  assert.equal(actions.data, undefined)
  assert.equal(actions.envelope, undefined)

  const { rt } = runtime()
  const historicalNode = 'history-only-node-default'
  const workflows = [
    { id: 'portrait', name: 'Portrait', displayNameEn: 'Portrait', description: '人像精修', outputKind: 'image', tags: ['face'], nodes: [{ nodeId: '6', fieldName: 'text', default: historicalNode }] },
    { id: 'video', name: 'Video', description: '视频循环', outputKind: 'video', tags: ['animation'], nodes: [{ nodeId: '9', fieldName: 'text', default: 'old-video-prompt' }] },
  ]
  rt.store = { listWorkflows: async () => workflows }
  const call = makeCallTool(() => rt)
  const overview = await call.execute({ action: 'workflow.get' }, {})
  assert.deepEqual(overview.data.workflows.map(item => item.name), ['Portrait', 'Video'])
  assert.ok(overview.data.workflows.every(item => !('nodes' in item)))
  assert.ok(!JSON.stringify(overview).includes(historicalNode))
  assert.equal(overview.envelope, '')
  for (const query of ['portrait', 'face', '精修']) {
    const filtered = await call.execute({ action: 'workflow.get', query }, {})
    assert.deepEqual(filtered.data.workflows.map(item => item.name), ['Portrait'])
  }
  const detail = await call.execute({ action: 'workflow.get', name: 'Portrait' }, {})
  assert.deepEqual(detail.data.nodes, workflows[0].nodes)
  assert.equal(JSON.parse(detail.envelope).data.nodes[0].default, historicalNode)
  assert.ok(!detail.text.includes(historicalNode), '节点只放在详细 JSON 中，不在短标题里重复')
})

test('损坏机密与旧状态备份的解析错误不打印输入内容', async (t) => {
  const dir = await temporary(t)
  const logs = []
  const store = new Store({ dataDir: dir, logger: { warn: (message) => logs.push(message) } })
  await store.init()
  await fs.writeFile(store.resolve('secrets.json'), 'invalid ' + secret)
  assert.deepEqual(await store.readSecrets(), {})
  await fs.writeFile(store.resolve('state.json.bak-1'), 'invalid ' + another)
  const cleaned = await store.scrubLegacySecretBackups()
  assert.equal(cleaned.ok, false)
  assert.ok(!logs.join('\n').includes(secret))
  assert.ok(!logs.join('\n').includes(another))
  assert.ok((await fs.readdir(dir)).some((name) => name.startsWith('secrets.json.corrupt-')))
})

test('普通 JSON 写入口也强制机密权限和不留备份，失败后移除机密临时文件', async (t) => {
  const dir = await temporary(t)
  const options = []
  let failRename = false
  const store = new Store({ dataDir: dir, fsImpl: { ...fs,
    writeFile: async (file, data, opts) => { options.push(opts); return fs.writeFile(file, data, opts) },
    rename: async (...args) => { if (failRename) throw Object.assign(new Error('disk failure'), { code: 'EIO' }); return fs.rename(...args) },
  } })
  await store.writeJson('secrets.json', { key: secret })
  await store.writeJson('secrets.json', { key: another }, { mode: 0o644, backup: true })
  assert.ok(options.every((opts) => opts.mode === 0o600))
  assert.equal((await fs.readdir(dir)).some((name) => name.includes('.bak-')), false)
  failRename = true
  assert.equal((await store.writeSecrets({ key: secret })).ok, false)
  assert.equal((await fs.readdir(dir)).some((name) => name.includes('.tmp-')), false)
  assert.equal((await store.readSecrets()).key, another)
})

test('成功写机密文件后清理崩溃留下的旧机密临时副本', async (t) => {
  const dir = await temporary(t)
  const store = new Store({ dataDir: dir })
  await store.init()
  await fs.writeFile(store.resolve('secrets.json.tmp-old'), JSON.stringify({ key: secret }))
  assert.equal((await store.writeSecrets({ key: another })).ok, true)
  assert.equal((await fs.readdir(dir)).includes('secrets.json.tmp-old'), false)
})

test('发布扫描识别明文凭据，但报告不回显值；测试假值和正常 ID 不误报', () => {
  const literal = '0123456789abcdef'.repeat(2)
  const findings = scanReleaseFile('host/config.mjs', 'const API_KEY = "' + literal + '"')
  assert.equal(findings[0].kind, 'credential-literal')
  assert.equal(scanReleaseFile('host/config.mjs', 'const RUNNINGHUB_API_KEY =\n"' + literal + '"')[0].kind, 'credential-literal')
  assert.ok(!JSON.stringify(findings).includes(literal))
  assert.deepEqual(scanReleaseFile('tests/fixture.mjs', 'const key = "' + secret + '"'), [])
  assert.deepEqual(scanReleaseFile('host/config.mjs', 'const workflowId = "' + literal + '"'), [])
  assert.equal(scanReleaseFile('host/cache/secrets.json')[0].kind, 'sensitive-file')
})

test('npm 打包排除嵌套运行数据、环境文件、备份和其它 client 文件', async (t) => {
  const dir = await temporary(t)
  const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'rh-package-fixture', version: '1.0.0', files: manifest.files }))
  for (const file of ['host/index.mjs', 'host/core/util.mjs', 'client/client.js', 'host/cache/secrets.json', 'host/cache/workflows/wf.json', 'host/cache/.env', 'host/index.mjs.bak-old', 'client/private.json']) {
    const absolute = path.join(dir, file)
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    await fs.writeFile(absolute, 'fixture')
  }
  assert.deepEqual(packageFiles(dir).sort(), ['client/client.js', 'host/core/util.mjs', 'host/index.mjs', 'package.json'])
})

test('Git 保护嵌套机密与回滚副本，同时允许 CI 配置跟踪', () => {
  const blocked = ['secrets.json', 'host/cache/secrets.json', 'host/cache/state.json', 'state.json.prescrub-old', '.env.local', 'private.pem', 'account.key', 'release.tgz']
  const result = execFileSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: ROOT, input: blocked.join('\n') + '\n', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  assert.deepEqual(result.trim().split(/\r?\n/), blocked)
  assert.throws(() => execFileSync('git', ['check-ignore', '--no-index', '.github/workflows/check.yml'], { cwd: ROOT, stdio: 'pipe', windowsHide: true }), (error) => error.status === 1)
})

test('Git 历史中已经删除的凭据仍被检测，结果只给文件、行号与对象 ID', async (t) => {
  const dir = await temporary(t)
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  git(['init', '--quiet'])
  await fs.writeFile(path.join(dir, 'leaked.mjs'), 'const API_KEY = "' + '0123456789abcdef'.repeat(2) + '"')
  git(['add', 'leaked.mjs'])
  git(['-c', 'user.name=Audit Fixture', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'fixture secret'])
  await fs.unlink(path.join(dir, 'leaked.mjs'))
  git(['add', '-u'])
  git(['-c', 'user.name=Audit Fixture', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'remove fixture secret'])
  const history = auditGitHistory(dir)
  assert.equal(history.findings[0].file, 'leaked.mjs')
  assert.equal(history.findings[0].line, 1)
  assert.ok(history.findings[0].object)
  assert.ok(!JSON.stringify(history).includes('0123456789abcdef'.repeat(2)))
})

test('工作区已删 Key 但 Git 暂存区仍保留旧内容时，发布检查不能漏过', async (t) => {
  const dir = await temporary(t)
  const literal = '0123456789abcdef'.repeat(2)
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  git(['init', '--quiet'])
  await fs.writeFile(path.join(dir, 'config.mjs'), 'const API_KEY = "' + literal + '"')
  git(['add', 'config.mjs'])
  await fs.writeFile(path.join(dir, 'config.mjs'), 'const API_KEY = process.env.RUNNINGHUB_API_KEY')
  const index = auditGitIndex(dir)
  assert.equal(index.findings[0].file, 'config.mjs')
  assert.equal(index.findings[0].source, 'index')
  assert.ok(!JSON.stringify(index).includes(literal))
})

test('离线装载检查不读取或迁移真实 profile 的 Key 数据', async (t) => {
  const dir = await temporary(t)
  const home = path.join(dir, 'dsh-home')
  const userData = path.join(home, 'runninghub')
  await fs.mkdir(userData, { recursive: true })
  const original = JSON.stringify({ keys: { entries: [{ id: 'old', key: secret, region: 'cn' }] } })
  await fs.writeFile(path.join(userData, 'state.json'), original)
  const output = execFileSync(process.execPath, ['tools/loadcheck.mjs'], { cwd: ROOT, env: { ...process.env, DSH_HOME: home }, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  assert.match(output, /全部通过/)
  assert.equal(await fs.readFile(path.join(userData, 'state.json'), 'utf8'), original)
  assert.deepEqual(await fs.readdir(userData), ['state.json'])
})

test('浏览器 HTTP 代理回显 Key 时先脱敏再截断，错误、控制台和通道诊断都安全', async () => {
  let sent
  const loaded = loadClientModule({ fetch: async (_url, options) => {
    sent = JSON.parse(options.body).params.entry.key
    return { ok: false, status: 502, text: async () => 'proxy ' + 'x'.repeat(180) + ' ' + secret }
  } })
  const ctx = createStubCtx()
  await loaded.exports.apply(ctx)
  await flushAsync()
  const api = loaded.exports.createApi(ctx)
  await assert.rejects(api.keys.add({ key: secret }), (error) => {
    assert.equal(error.code, 'NO_TRANSPORT')
    assert.ok(!error.message.includes('synthetic-'))
    assert.ok(error.message.includes('****'))
    assert.ok(!JSON.stringify(error.channels).includes('synthetic-'))
    return true
  })
  assert.equal(sent, secret)
  assert.ok(!JSON.stringify(loaded.logs).includes('synthetic-'))
  assert.ok(!api.channelReport.includes('synthetic-'))
})

test('浏览器 Remote 错误脱敏后保留业务错误标记，不换通道重复提交', async () => {
  let requests = 0
  let sent
  const loaded = loadClientModule({ fetch: async () => { requests++; throw new Error('unexpected fallback') } })
  const ctx = createStubCtx({ remoteNamespace: {
    call: async ({ callJson }) => {
      sent = JSON.parse(callJson).params.patch.key
      return { ok: true, value: JSON.stringify({ ok: false, error: { code: 'AUTH', message: 'rejected ' + secret, hint: 'check ' + secret } }) }
    },
  } })
  await loaded.exports.apply(ctx)
  await flushAsync()
  const api = loaded.exports.createApi(ctx)
  await assert.rejects(api.keys.update('one', { key: secret }), (error) => {
    assert.equal(error.business, true)
    assert.equal(error.code, 'AUTH')
    assert.ok(![error.message, error.hint, error.stack].join('\n').includes(secret))
    loaded.emitWindowEvent('unhandledrejection', { reason: error })
    return true
  })
  assert.equal(requests, 0)
  assert.equal(sent, secret)
  assert.ok(!JSON.stringify(api.listClientErrors()).includes(secret))
})
