import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { auditGitIndex, auditGitHistory } from '../../tools/check-release.mjs'

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rh-verification-'))
  t.after(async () => {
    const relative = path.relative(os.tmpdir(), dir)
    assert.ok(relative.startsWith('rh-verification-') && !relative.includes(path.sep))
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  return dir
}

test('验收缺步骤或没有实际测试时失败；完整步骤执行后成功', async (t) => {
  const dir = await fixture(t)
  await fs.mkdir(path.join(dir, 'tools'))
  await fs.copyFile(new URL('../../tools/accept.mjs', import.meta.url), path.join(dir, 'tools/accept.mjs'))
  const run = () => {
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const result = spawnSync(process.execPath, ['tools/accept.mjs', '--json'], {
      cwd: dir, encoding: 'utf8', windowsHide: true, env,
    })
    assert.equal(result.error, undefined)
    const line = result.stdout.split('\n').find((line) => line.startsWith('ACCEPT_JSON '))
    assert.ok(line, result.stdout + result.stderr)
    return { status: result.status, summary: JSON.parse(line.slice('ACCEPT_JSON '.length)) }
  }
  let result = run()
  assert.equal(result.status, 1)
  assert.equal(result.summary.ok, false)
  assert.equal(result.summary.failed, 3)
  assert.equal(result.summary.skipped, 0)

  for (const file of ['check-release.mjs', 'loadcheck.mjs']) await fs.writeFile(path.join(dir, 'tools', file), '')
  await fs.mkdir(path.join(dir, 'tests'))
  await fs.writeFile(path.join(dir, 'tests/empty.test.mjs'), "import test from 'node:test'\ntest.skip('fixture', () => {})\n")
  result = run()
  assert.equal(result.status, 1, '全部跳过的测试不能算通过')
  assert.equal(result.summary.ok, false)
  assert.equal(result.summary.failed, 1)

  await fs.writeFile(path.join(dir, 'tests/empty.test.mjs'), "import test from 'node:test'\ntest('fixture', () => {})\n")
  result = run()
  assert.equal(result.status, 0)
  assert.equal(result.summary.ok, true)
  assert.equal(result.summary.passed, 3)
})

test('批量 Git 扫描按字节读取中文、二进制和无效 UTF-8，不跳过后续凭据对象', async (t) => {
  const dir = await fixture(t)
  const git = (args) => execFileSync('git', args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  git(['init', '--quiet'])
  await fs.writeFile(path.join(dir, 'a.bin'), Buffer.from([0xff, 0x0a, 0x00, 0xfe]))
  await fs.writeFile(path.join(dir, 'b.mjs'), '// 中文前缀\nconst API_KEY = "' + '0123456789abcdef'.repeat(2) + '"')
  await fs.writeFile(path.join(dir, 'c.mjs'), 'export const text = "中文尾部"\n')
  git(['add', '.'])
  const index = auditGitIndex(dir)
  assert.equal(index.entries, 3)
  assert.deepEqual(index.findings.map((item) => [item.file, item.line, item.kind]), [['b.mjs', 2, 'credential-literal']])
  git(['-c', 'user.name=Verification Fixture', '-c', 'user.email=verification@example.invalid', 'commit', '-qm', 'fixture'])
  await fs.unlink(path.join(dir, 'b.mjs'))
  git(['add', '-u'])
  git(['-c', 'user.name=Verification Fixture', '-c', 'user.email=verification@example.invalid', 'commit', '-qm', 'remove fixture'])
  const history = auditGitHistory(dir)
  assert.equal(history.blobs, 3)
  assert.deepEqual(history.findings.map((item) => [item.file, item.line, item.kind]), [['b.mjs', 2, 'credential-literal']])
  assert.equal(JSON.stringify({ index, history }).includes('0123456789abcdef'.repeat(2)), false)
})
