/**
 * 源码注释不能指向**没有入库**的资料（#7）。
 *
 * `.gitignore` 把 `docs/api/`、`docs/DESIGN.md`、`docs/dsh/*` 等本地资料排除在仓库之外；
 * 源码里再写「见 DESIGN §7.5」「见 docs/api/ERROR-CODES.md」，外部贡献者就无从查证。
 * 需要出处时写结论本身，或链接官方公开文档。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SELF = fileURLToPath(import.meta.url)

/** 本地私有资料的引用形态。 */
const PRIVATE_REFERENCES = [
  /\bDESIGN\s*(?:§|排雷|规则|\.md)/,
  /docs\/(?:api|dsh|local)\//,
  /docs\/(?:DESIGN|REVIEW|ACCEPTANCE)\.md/,
  /(?<![\w-])rh-docs\b/, // `data-rh-docs` 是面板的 DOM 标记，不算
  /\brh-core task-\d/,
]

function walk(dir) {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === 'fixtures' ? [] : walk(file)
    return /\.(?:mjs|js|md|yml)$/.test(entry.name) ? [file] : []
  })
}

test('#7：host / client / skills / tools / tests 不引用未入库的设计文档', () => {
  const files = [
    ...['host', 'client', 'skills', 'tools', 'tests'].flatMap((dir) => walk(path.join(ROOT, dir))),
    path.join(ROOT, 'typert.host.mjs'),
    path.join(ROOT, 'README.md'),
  ].filter((file) => file !== SELF)
  const offenders = []
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, index) => {
      if (PRIVATE_REFERENCES.some((re) => re.test(line))) offenders.push(path.relative(ROOT, file) + ':' + String(index + 1))
    })
  }
  assert.deepEqual(offenders, [], '这些位置引用了未入库的资料，请改成结论本身或官方公开文档链接')
})

test('#7：CI 工作流存在，并在 Ubuntu / Windows × Node 20 / 22 上跑测试与发布检查', () => {
  const ci = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  for (const needle of ['ubuntu-latest', 'windows-latest', "'20'", "'22'", 'npm test', 'npm run check:release', 'fetch-depth: 0']) {
    assert.ok(ci.includes(needle), 'ci.yml 缺少：' + needle)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.test, 'node tools/run-tests.mjs', 'npm test 不能依赖 Node 21+ 才有的 --test glob 展开')
})
