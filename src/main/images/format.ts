import type { FileHandle } from 'node:fs/promises'
import type { ImageFormat } from '../../shared/images'

/** Decoded size the renderer is allowed to allocate for one image. */
export const MAX_IMAGE_SIDE = 32_767
export const MAX_IMAGE_PIXELS = 150_000_000

export type Inspection =
  | { ok: true; format: ImageFormat; width: number; height: number }
  | { ok: false; reason: 'html' | 'not-image' | 'too-large' }

const HEAD_BYTES = 64 * 1024

function startsWith(head: Buffer, bytes: readonly number[], offset = 0): boolean {
  return head.length >= offset + bytes.length && bytes.every((byte, index) => head[offset + index] === byte)
}

/** An HTML/XML document: first non-blank character (after an optional BOM) is `<`. */
function looksLikeMarkup(head: Buffer): boolean {
  let index = startsWith(head, [0xef, 0xbb, 0xbf]) ? 3 : 0
  while (index < head.length && [0x09, 0x0a, 0x0d, 0x20].includes(head[index] as number)) index++
  return head[index] === 0x3c
}

function size(format: ImageFormat, width: number, height: number): Inspection {
  if (!(width > 0 && height > 0)) return { ok: false, reason: 'not-image' }
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE || width * height > MAX_IMAGE_PIXELS) {
    return { ok: false, reason: 'too-large' }
  }
  return { ok: true, format, width, height }
}

function webp(head: Buffer): Inspection {
  const chunk = head.toString('latin1', 12, 16)
  if (chunk === 'VP8X' && head.length >= 30) {
    return size('webp', head.readUIntLE(24, 3) + 1, head.readUIntLE(27, 3) + 1)
  }
  if (chunk === 'VP8 ' && head.length >= 30 && startsWith(head, [0x9d, 0x01, 0x2a], 23)) {
    return size('webp', head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff)
  }
  if (chunk === 'VP8L' && head.length >= 25 && head[20] === 0x2f) {
    const bits = head.readUInt32LE(21)
    return size('webp', (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1)
  }
  return { ok: false, reason: 'not-image' }
}

/** Walks JPEG segments to the first SOFn frame header; reads beyond the head when needed. */
async function jpeg(file: FileHandle, length: number): Promise<Inspection> {
  const marker = Buffer.alloc(9)
  let offset = 2
  while (offset + 4 <= length) {
    const { bytesRead } = await file.read(marker, 0, 9, offset)
    if (bytesRead < 4 || marker[0] !== 0xff) return { ok: false, reason: 'not-image' }
    const type = marker[1] as number
    // Fill bytes between segments.
    if (type === 0xff) { offset++; continue }
    // Standalone markers carry no length.
    if (type === 0x01 || (type >= 0xd0 && type <= 0xd7)) { offset += 2; continue }
    if (type === 0xd9 || type === 0xda) return { ok: false, reason: 'not-image' }
    const segmentLength = marker.readUInt16BE(2)
    if (segmentLength < 2) return { ok: false, reason: 'not-image' }
    const isFrame = type >= 0xc0 && type <= 0xcf && type !== 0xc4 && type !== 0xc8 && type !== 0xcc
    if (isFrame) {
      if (bytesRead < 9) return { ok: false, reason: 'not-image' }
      return size('jpeg', marker.readUInt16BE(7), marker.readUInt16BE(5))
    }
    offset += 2 + segmentLength
  }
  return { ok: false, reason: 'not-image' }
}

/**
 * Identifies a downloaded file by its own bytes: JPEG, PNG, GIF or WebP signature plus a readable
 * size header. The forum extension and response MIME are not consulted, so a `.png` holding JPEG
 * bytes is a JPEG. Markup is `html`; SVG and anything else is `not-image`. Full decoding happens in
 * the sandboxed renderer.
 */
export async function inspectImage(file: FileHandle, length: number): Promise<Inspection> {
  const head = Buffer.alloc(Math.min(HEAD_BYTES, length))
  const { bytesRead } = await file.read(head, 0, head.length, 0)
  const bytes = head.subarray(0, bytesRead)
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return jpeg(file, length)
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (bytes.length < 24 || bytes.toString('latin1', 12, 16) !== 'IHDR') return { ok: false, reason: 'not-image' }
    return size('png', bytes.readUInt32BE(16), bytes.readUInt32BE(20))
  }
  const gif = bytes.toString('latin1', 0, 6)
  if (gif === 'GIF87a' || gif === 'GIF89a') {
    if (bytes.length < 10) return { ok: false, reason: 'not-image' }
    return size('gif', bytes.readUInt16LE(6), bytes.readUInt16LE(8))
  }
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return webp(bytes)
  return { ok: false, reason: looksLikeMarkup(bytes) ? 'html' : 'not-image' }
}
