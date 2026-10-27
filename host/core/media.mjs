import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const finite = value => (typeof value === 'number' || typeof value === 'string') && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined

/** Only copy measurements actually reported by a source; false and zero are valid. */
export function mediaFields(source = {}) {
  if (!source || typeof source !== 'object') return {}
  const fields = {}
  for (const key of ['width', 'height', 'duration', 'fps', 'bytes']) {
    const value = finite(source[key])
    if (value !== undefined) fields[key] = value
  }
  if (typeof source.hasAudio === 'boolean') fields.hasAudio = source.hasAudio
  return fields
}

function imageSize(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (bytes.length >= 10 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2
    while (offset + 4 <= bytes.length && bytes[offset] === 255) {
      const marker = bytes[offset + 1]
      if (marker === 255) { offset++; continue }
      if ([0xd8, 0x01].includes(marker) || marker >= 0xd0 && marker <= 0xd7) { offset += 2; continue }
      if ([0xd9, 0xda].includes(marker)) break
      const size = bytes.readUInt16BE(offset + 2)
      if (size < 2 || offset + 2 + size > bytes.length) break
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 7) {
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
      }
      offset += 2 + size
    }
  }
  return {}
}

/** Read a saved local result. ffprobe is optional, bounded, and never opens network inputs. */
export async function inspectMedia(file, kind, { run = runFile, timeoutMs = 2000 } = {}) {
  const metadata = {}
  try {
    const local = path.resolve(file)
    const stat = await fs.stat(local)
    if (!stat.isFile()) return metadata
    metadata.bytes = stat.size
    metadata.metadataSource = 'file'
    if (kind === 'image') {
      const handle = await fs.open(local, 'r')
      try {
        const bytes = Buffer.alloc(Math.min(stat.size, 65536))
        const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
        Object.assign(metadata, imageSize(bytes.subarray(0, bytesRead)))
      } finally { await handle.close() }
      if (metadata.width && metadata.height) return metadata
    }
    if (!['image', 'video', 'audio'].includes(kind)) return metadata
    const { stdout } = await run('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe', '-show_entries', 'stream=codec_type,width,height,avg_frame_rate,duration:format=duration', '-of', 'json', local], {
      windowsHide: true, timeout: Math.max(1, Math.min(2000, timeoutMs)), maxBuffer: 256 * 1024, encoding: 'utf8',
    })
    const parsed = JSON.parse(stdout)
    if (!Array.isArray(parsed.streams) || parsed.streams.length === 0) return metadata
    const video = parsed.streams.find(stream => stream.codec_type === 'video')
    Object.assign(metadata, mediaFields({ width: video?.width, height: video?.height, duration: parsed.format?.duration ?? video?.duration }))
    const rate = String(video?.avg_frame_rate || '').split('/')
    const fps = rate.length === 2 ? Number(rate[0]) / Number(rate[1]) : Number(rate[0])
    if (Number.isFinite(fps) && fps > 0) metadata.fps = fps
    metadata.hasAudio = parsed.streams.some(stream => stream.codec_type === 'audio')
    metadata.metadataSource = 'ffprobe'
  } catch { /* Missing ffprobe or malformed media must not lose a successfully saved result. */ }
  return metadata
}
