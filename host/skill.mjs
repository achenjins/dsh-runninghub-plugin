/**
 * dsh-runninghub-plugin · skill 注册
 *
 * 用户要的「AI 辅助配置工作流」= 模型读一份**插件自带的 skill**，按里面的流程问用户问题、
 * 调 `runninghub_call` 落盘配置。skill 正文在 `skills/runninghub-workflow-setup/SKILL.md`，
 * 这里把它注册进 DSH 的技能目录。
 *
 * 三个细节：
 *   - 路径**相对 `import.meta.url`**，不依赖 cwd（宿主可能从任意目录启动）。
 *   - 注册的是**正文**（YAML frontmatter 被剥掉）—— frontmatter 的字段已经在注册参数里表达了，
 *     重复一遍只会让模型看到两份元数据。
 *   - `skills` 服务是**可选依赖**：没有它只 warn，插件其余部分照常工作。
 *
 * @module dsh-runninghub-plugin/host/skill
 */

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { HOST_DIR } from './shared.mjs'

/** skill 的稳定标识（kebab-case，与目录名一致）。 */
export const SKILL_NAME = 'runninghub-workflow-setup'

/** skill 正文文件的绝对路径。 */
export function skillPath() {
  return path.join(HOST_DIR, '..', 'skills', SKILL_NAME, 'SKILL.md')
}

/** 剥掉 YAML frontmatter（保留正文；解析失败就原样返回）。 */
export function stripFrontmatter(raw) {
  const s = String(raw == null ? '' : raw)
  if (!s.startsWith('---')) return s
  const end = s.indexOf(String.fromCharCode(10) + '---', 3)
  if (end < 0) return s
  let rest = s.slice(end + 4)
  if (rest.startsWith(String.fromCharCode(13))) rest = rest.slice(1)
  if (rest.startsWith(String.fromCharCode(10))) rest = rest.slice(1)
  return rest
}

/** 从 frontmatter 里取一个标量字段（取不到返回空串）。 */
export function frontmatterField(raw, key) {
  const s = String(raw == null ? '' : raw)
  if (!s.startsWith('---')) return ''
  const end = s.indexOf(String.fromCharCode(10) + '---', 3)
  if (end < 0) return ''
  const head = s.slice(3, end)
  for (const line of head.split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    if (line.slice(0, idx).trim() !== key) continue
    let v = line.slice(idx + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    return v
  }
  return ''
}

/**
 * 读出并组装 skill 注册对象（**不注册**，注册由调用方在 effect 里做，便于清理）。
 *
 * @returns {Promise<{ok:true, registration:object}|{ok:false, reason:string}>}
 */
export async function buildSkillRegistration() {
  const abs = skillPath()
  let raw
  try {
    raw = await readFile(abs, 'utf8')
  } catch (e) {
    return { ok: false, reason: 'skill 文件读不到（' + abs + '）：' + String((e && e.message) || e) }
  }
  const description =
    frontmatterField(raw, 'description') ||
    '用提问的方式帮用户把一个 RunningHub 工作流配置进 dsh-runninghub-plugin：拉工作流 JSON、识别节点、逐项确认后落盘。'
  const whenToUse = frontmatterField(raw, 'whenToUse')
  return {
    ok: true,
    registration: {
      name: SKILL_NAME,
      description,
      ...(whenToUse ? { whenToUse } : {}),
      content: stripFrontmatter(raw),
      source: 'bundled',
      path: abs,
      resourceBase: { kind: 'directory', path: path.dirname(abs) },
      invocation: { modelInvocable: true, userInvocable: true },
    },
  }
}

