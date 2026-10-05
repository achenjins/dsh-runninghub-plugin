/** Read-only checks for the Git tree/history and the npm package file list. */
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sensitiveFile = /(?:^|\/)(?:secrets\.json|state\.json)(?:$|[.-])|(?:^|\/)\.env(?:$|\.)|(?:^|\/)\.npmrc$|\.(?:bak|corrupt|prescrub|tmp)-|\.(?:pem|key|p12|pfx|tgz)$/i

export function scanReleaseFile(file, content = '') {
  const name = file.replaceAll('\\', '/')
  const findings = []
  if (sensitiveFile.test(name) && path.posix.basename(name) !== '.env.example') findings.push({ file: name, kind: 'sensitive-file' })
  const tests = name.startsWith('tests/')
  const synthetic = (token) => tests && (/synthetic|(?:^|[_-])(?:fake|test|example|canary)(?:[_-]|$)|^rh_integration_|^rh_LEAKED_SECRET_|^rh_SUPER_SECRET_/i.test(token) || /^(.)\1+$/.test(token))
  const patterns = [
    /\b(?:[A-Za-z][A-Za-z0-9_]*[_-])?(?:api[_-]?key|apikeyvalue|secret|token|password|authorization|key)\b["']?\s*[:=]\s*["'](?:Bearer\s+)?([A-Za-z0-9._-]{24,})["']/gi,
    /\b(?:[A-Za-z][A-Za-z0-9_]*[_-])?(?:API_?KEY|TOKEN|SECRET|PASSWORD|KEY)\s*=\s*([A-Za-z0-9._-]{24,})(?=\s|$)/gi,
    /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{25,})\b/g,
  ]
  const text = String(content)
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (!synthetic(match[1])) findings.push({ file: name, line: text.slice(0, match.index).split('\n').length, kind: 'credential-literal' })
    }
  }
  // Never include the matched value or source line in reports.
  return findings
}

function git(root, args, input) {
  return execFileSync('git', args, { cwd: root, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
}

/** Read objects in one process. Git sizes are bytes, even for UTF-8 and binary blobs. */
function gitObjects(root, ids) {
  const unique = [...new Set(ids)]
  if (!unique.length) return new Map()
  const data = execFileSync('git', ['cat-file', '--batch'], {
    cwd: root, input: unique.join('\n') + '\n', maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  })
  const objects = new Map()
  let offset = 0
  for (const id of unique) {
    const newline = data.indexOf(10, offset)
    const header = data.subarray(offset, newline).toString('ascii').split(' ')
    const size = Number(header[2])
    const end = newline + 1 + size
    if (newline < 0 || header[0] !== id || !Number.isSafeInteger(size) || size < 0 || end >= data.length || data[end] !== 10) {
      throw new Error('Invalid Git object response')
    }
    if (header[1] === 'blob') objects.set(id, data.subarray(newline + 1, end).toString('utf8'))
    offset = end + 1
  }
  if (offset !== data.length) throw new Error('Unexpected Git object response')
  return objects
}

/** Staged content can differ from the working tree and is what Git will commit. */
export function auditGitIndex(root = ROOT) {
  const entries = git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map((entry) => {
    const split = entry.indexOf('\t')
    return { id: entry.slice(0, split).split(' ')[1], file: entry.slice(split + 1) }
  })
  const objects = gitObjects(root, entries.map((entry) => entry.id))
  const findings = []
  for (const { id, file } of entries) {
    if (!objects.has(id)) continue
    findings.push(...scanReleaseFile(file, objects.get(id)).map((finding) => ({ ...finding, source: 'index', object: id.slice(0, 12) })))
  }
  return { entries: entries.length, findings }
}

export function auditGitHistory(root = ROOT) {
  const entries = git(root, ['rev-list', '--objects', '--all']).trim().split('\n').flatMap((line) => {
    const split = line.indexOf(' ')
    return split < 0 ? [] : [{ id: line.slice(0, split), name: line.slice(split + 1) }]
  })
  const objects = gitObjects(root, entries.map((entry) => entry.id))
  const findings = []
  let blobs = 0
  for (const { id, name } of entries) {
    if (!objects.has(id)) continue
    blobs++
    findings.push(...scanReleaseFile(name, objects.get(id)).map((finding) => ({ ...finding, object: id.slice(0, 12) })))
  }
  return { blobs, findings }
}

/** npm's dry-run is the source of truth; no tarball or lifecycle scripts are run. */
export function packageFiles(root = ROOT) {
  const flags = ['pack', '--dry-run', '--json', '--ignore-scripts']
  let command = 'npm'
  let args = flags
  if (process.platform === 'win32') {
    let cli = process.env.npm_execpath
    if (!cli || !/npm-cli\.js$/.test(cli) || !existsSync(cli)) {
      const npmPath = execFileSync('where.exe', ['npm.cmd'], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0]
      cli = path.join(path.dirname(npmPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    }
    if (!existsSync(cli)) throw new Error('npm CLI unavailable')
    command = process.execPath
    args = [cli, ...flags]
  }
  const output = execFileSync(command, args, {
    cwd: root, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, npm_config_cache: path.join(os.tmpdir(), 'dsh-runninghub-release-npm') },
    stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024,
  })
  return JSON.parse(output)[0].files.map((item) => item.path)
}

export async function auditRelease(root = ROOT) {
  const tracked = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
  const packed = packageFiles(root)
  const findings = []
  const contents = new Map()
  for (const file of new Set([...tracked, ...packed])) {
    const absolute = path.resolve(root, file)
    if (path.relative(root, absolute).startsWith('..')) throw new Error('File outside repository')
    const content = await fs.readFile(absolute, 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return '' // Deleted working-tree file is still checked in history.
      throw error
    })
    contents.set(file, content)
    findings.push(...scanReleaseFile(file, content))
  }
  const manifest = JSON.parse(contents.get('package.json'))
  const required = [manifest.main, 'client/client.js', 'skills/runninghub-workflow-setup/SKILL.md', manifest.dsh?.bundle?.patch]
  for (const value of Object.values(manifest.exports || {})) required.push(typeof value === 'string' ? value : value.default)
  for (const file of required.filter(Boolean)) {
    if (!packed.includes(file.replace(/^\.\//, ''))) findings.push({ file, kind: 'missing-package-entry' })
  }
  for (const file of packed.filter((name) => /\.(?:mjs|js)$/.test(name))) {
    const content = contents.get(file)
    const pattern = /\bfrom\s*["'](\.{1,2}\/[^"']+)["']|\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g
    for (const match of content.matchAll(pattern)) {
      const lineStart = content.lastIndexOf('\n', match.index) + 1
      if (/^\s*(?:\*|\/\/)/.test(content.slice(lineStart, match.index))) continue
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1] || match[2]))
      if (!packed.includes(target)) findings.push({ file, kind: 'missing-package-import', target })
    }
  }
  const history = auditGitHistory(root)
  const index = auditGitIndex(root)
  findings.push(...history.findings)
  findings.push(...index.findings)
  return { ok: findings.length === 0, gitFiles: tracked.length, indexEntries: index.entries, packageFiles: packed.length, historyBlobs: history.blobs, findings }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  auditRelease().then((result) => {
    process.stdout.write('[releasecheck] ' + (result.ok ? '通过' : '失败') + ' · Git 文件 ' + result.gitFiles + ' · 索引条目 ' + result.indexEntries + ' · 安装包文件 ' + result.packageFiles + ' · 历史内容 ' + result.historyBlobs + '\n')
    if (result.findings.length) process.stdout.write(JSON.stringify(result.findings, null, 2) + '\n')
    process.exitCode = result.ok ? 0 : 1
  }).catch(() => {
    // A failed npm/git command may include source content; do not echo its stderr.
    process.stderr.write('[releasecheck] 无法完成检查，请确认 Git、npm 和仓库文件可读。\n')
    process.exitCode = 1
  })
}
