import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { inspectMedia, mediaFields } from '../../host/core/media.mjs'
import { RunningHubApi, reportedTaskCost } from '../../host/core/api.mjs'
import { TaskRunner, projectTask } from '../../host/core/runner.mjs'

async function fixture(t, bytes = Buffer.alloc(32)) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-media-'))
  t.after(async () => {
    assert.equal(path.dirname(dir), os.tmpdir())
    assert.ok(path.basename(dir).startsWith('rh-media-'))
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  const file = path.join(dir, 'result.bin')
  await fs.writeFile(file, bytes)
  return file
}

test('PNG 文件头即可返回真实尺寸和字节数，无需 ffprobe', async t => {
  const png = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
  png.write('IHDR', 12)
  png.writeUInt32BE(480, 16)
  png.writeUInt32BE(864, 20)
  const file = await fixture(t, png)
  const result = await inspectMedia(file, 'image', { run: () => assert.fail('PNG header does not need a subprocess') })
  assert.deepEqual(result, { bytes: 24, metadataSource: 'file', width: 480, height: 864 })
})

test('媒体探测测量视频流、时长、帧率与真实无音轨，命令只读本地文件且有上限', async t => {
  const file = await fixture(t)
  const result = await inspectMedia(file, 'video', { timeoutMs: 700, run: async (command, args, options) => {
    assert.equal(command, 'ffprobe')
    assert.equal(args.at(-1), file)
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'file,pipe')
    assert.equal(options.windowsHide, true)
    assert.equal(options.timeout, 700)
    return { stdout: JSON.stringify({ streams: [{ codec_type: 'video', width: 480, height: 864, avg_frame_rate: '24000/1001' }], format: { duration: '5.1667' } }) }
  } })
  assert.deepEqual(result, { bytes: 32, metadataSource: 'ffprobe', width: 480, height: 864, duration: 5.1667, fps: 24000 / 1001, hasAudio: false })
})

test('缺少探测器或畸形媒体只返回已知字节数，不伪造时长或丢弃文件', async t => {
  const file = await fixture(t)
  for (const run of [async () => { throw Object.assign(new Error('not installed'), { code: 'ENOENT' }) }, async () => ({ stdout: '{bad' }), async () => ({ stdout: '{"streams":[]}' })]) {
    assert.deepEqual(await inspectMedia(file, 'video', { run }), { bytes: 32, metadataSource: 'file' })
  }
  assert.deepEqual(mediaFields({ hasAudio: false, bytes: 0, duration: '0', width: null, height: undefined }), { hasAudio: false, bytes: 0, duration: 0 })
  assert.deepEqual(mediaFields(null), {})
  assert.deepEqual(mediaFields({ width: false, duration: ' ' }), {})
})

test('任务级 consumeCoins 从两个查询接口传递并持久保留，余额不参与费用计算', async () => {
  for (const body of [{ code: 0, data: { status: 'SUCCESS', outputs: [], consumeCoins: '14' } }, { status: 'SUCCESS', results: [], consumeCoins: '0' }]) {
    const api = new RunningHubApi({ fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }), retries: 0 })
    const result = body.code === 0 ? await api.queryOutputs('synthetic-key', 'cn', 't') : await api.queryV2('synthetic-key', 'cn', 't')
    assert.equal(result.consumeCoins, body.code === 0 ? 14 : 0)
    const runner = new TaskRunner({ api: { queryOutputs: async () => ({ ...result, outputs: [] }) } })
    const query = await runner._queryOnce('synthetic-key', 'cn', 't')
    const task = { taskId: 't', nodeInfoList: [{ nodeId: '1', fieldName: 'value', fieldValue: '5' }] }
    runner._applyQuery(task, query)
    runner._applyQuery(task, { ok: true, status: 'SUCCESS', outputs: [] })
    assert.equal(projectTask(task).consumeCoins, result.consumeCoins)
    assert.deepEqual(projectTask(task).nodeInfoList, task.nodeInfoList)
  }
  assert.deepEqual(reportedTaskCost({ remainCoins: 18404 }), {})
  assert.deepEqual(reportedTaskCost({ consumeCoins: false }), {})
  const wrapped = new RunningHubApi({ fetchImpl: async () => new Response(JSON.stringify({ code: 0, consumeCoins: '14', data: { status: 'SUCCESS', results: [] } }), { status: 200 }) })
  assert.equal((await wrapped.queryV2('synthetic-key', 'cn', 't')).consumeCoins, 14)
})

test('下载结果保留上游元信息，并使用本地测量纠正实际输出值', async () => {
  const runner = new TaskRunner({
    download: async () => ({ ok: true, path: 'saved.mp4', bytes: 10 }),
    inspectMedia: async () => ({ width: 480, height: 864, duration: 5.1667, fps: 24, hasAudio: false, bytes: 10, metadataSource: 'ffprobe' }),
  })
  const results = await runner._collect({ taskId: 't', outputs: [{ url: 'https://example.invalid/a.mp4', duration: 5, hasAudio: true }], outputKind: 'video' })
  assert.equal(results[0].duration, 5.1667)
  assert.equal(results[0].hasAudio, false)
  assert.equal(results[0].metadataSource, 'ffprobe')
  runner.inspectMedia = async () => { throw new Error('metadata unavailable') }
  assert.equal((await runner._collect({ taskId: 't', outputs: [{ url: 'https://example.invalid/a.mp4', hasAudio: false }] }))[0].localPath, 'saved.mp4')
})

test('可选媒体探测耗时不挤占后续输出的下载预算', async () => {
  let clock = 1000
  let downloads = 0
  const runner = new TaskRunner({
    now: () => clock,
    downloadTimeoutMs: 1000,
    download: async () => { downloads++; return { ok: true, path: 'saved.mp4', bytes: 10 } },
    inspectMedia: async () => { clock += 2000; return {} },
  })
  const results = await runner._collect({ taskId: 't', outputs: ['https://example.invalid/a.mp4', 'https://example.invalid/b.mp4'] })
  assert.equal(downloads, 2)
  assert.equal(results.every(result => result.localPath === 'saved.mp4'), true)
})
