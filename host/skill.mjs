/**
 * dsh-runninghub-plugin · skill 注册
 *
 * 插件自带两份 skill，正文在 `skills/<name>/SKILL.md`，这里把它们注册进 DSH 的技能目录：
 *   - `runninghub-workflow-setup`：「AI 辅助配置工作流」—— 模型按流程问用户问题、调 `runninghub_call` 落盘配置。
 *   - `runninghub-generate`：生成内容的操作手册 —— 用户一要生图 / 生视频就先读它，
 *     免得模型不会用插件（不取结果、乱猜节点、超时就重投付费任务）。
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

/** 插件自带的 skill：稳定标识（kebab-case，与目录名一致）+ frontmatter 读不到 description 时的兜底说明。 */
export const SKILLS = [
  {
    name: 'runninghub-workflow-setup',
    fallbackDescription: '用提问的方式帮用户把一个 RunningHub 工作流配置进 dsh-runninghub-plugin：拉工作流 JSON、识别节点、逐项确认后落盘。',
  },
  {
    name: 'runninghub-generate',
    fallbackDescription: '用 RunningHub 工作流生成图片、视频、音频的操作手册：选工作流、写提示词、提交任务、取回结果。用户一要生成内容就先读这份。',
  },
]

/** 全部 skill 的标识。 */
export const SKILL_NAMES = SKILLS.map((s) => s.name)

/** skill 正文文件的绝对路径。 */
export function skillPath(name) {
  return path.join(HOST_DIR, '..', 'skills', name, 'SKILL.md')
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
 * 读出并组装一份 skill 的注册对象（**不注册**，注册由调用方在 effect 里做，便于清理）。
 *
 * @param {{name:string, fallbackDescription:string}} skill `SKILLS` 里的一项
 * @returns {Promise<{ok:true, registration:object}|{ok:false, reason:string}>}
 */
export async function buildSkillRegistration(skill) {
  const abs = skillPath(skill.name)
  let raw
  try {
    raw = await readFile(abs, 'utf8')
  } catch (e) {
    return { ok: false, reason: 'skill 文件读不到（' + abs + '）：' + String((e && e.message) || e) }
  }
  const description = frontmatterField(raw, 'description') || skill.fallbackDescription
  const whenToUse = frontmatterField(raw, 'whenToUse')
  return {
    ok: true,
    registration: {
      name: skill.name,
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

