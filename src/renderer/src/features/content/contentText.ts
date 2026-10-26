import type { ContentResult, OfflineCopy, RetainedEntry } from '../../../../shared/content'
import type { ImageError } from '../../../../shared/images'
import { describeReadError, meaningfulTitle } from '../../lib/format'

/** Decimal units: the cache limit is set in decimal gigabytes (1 GB = 1,000,000,000 bytes). */
export const BYTES_PER_GB = 1_000_000_000
/** Largest accepted limit, in GB; keeps the byte count a safe integer. */
export const MAX_LIMIT_GB = 1_000_000

const UNITS = [
  { size: 1_000_000_000_000, name: 'TB' },
  { size: 1_000_000_000, name: 'GB' },
  { size: 1_000_000, name: 'MB' },
  { size: 1_000, name: 'KB' }
] as const

/** `1234567` → `1.2 MB` (decimal units). */
export function formatBytes(bytes: number): string {
  for (const unit of UNITS) {
    if (bytes >= unit.size) {
      const value = bytes / unit.size
      return `${value >= 100 ? Math.round(value) : Number(value.toFixed(value >= 10 ? 1 : 2))} ${unit.name}`
    }
  }
  return `${bytes} 字节`
}

/** Exact byte count with grouping, for titles and confirmations. */
export function exactBytes(bytes: number): string {
  return `${bytes.toLocaleString('zh-CN')} 字节`
}

/**
 * Parses a decimal GB amount (`2`, `1.5`, `0.25`) into whole bytes without floating-point error.
 * Returns null for anything else, including more than nine decimals or a value above the maximum.
 */
export function parseLimitGb(text: string): number | null {
  const match = /^(\d{1,7})(?:\.(\d{1,9}))?$/.exec(text.trim())
  if (match === null) return null
  const whole = Number(match[1])
  if (whole > MAX_LIMIT_GB) return null
  const fraction = Number((match[2] ?? '').padEnd(9, '0'))
  const bytes = whole * BYTES_PER_GB + fraction
  return bytes > MAX_LIMIT_GB * BYTES_PER_GB ? null : bytes
}

/** Limit as the input shows it: `2000000000` → `2`, `1500000000` → `1.5`. */
export function limitToGbText(bytes: number): string {
  const whole = Math.floor(bytes / BYTES_PER_GB)
  const fraction = String(bytes % BYTES_PER_GB).padStart(9, '0').replace(/0+$/, '')
  return fraction === '' ? String(whole) : `${whole}.${fraction}`
}

/** A refused content operation, or null when the IPC call itself failed. */
export type Refused = Extract<ContentResult<unknown>, { ok: false }> | null

/** Calls a content operation; a rejected IPC call becomes `null` (internal failure). */
export async function attempt<T>(call: () => Promise<ContentResult<T>>): Promise<ContentResult<T> | null> {
  try {
    return await call()
  } catch {
    return null
  }
}

/** Why a content operation was refused. */
export function contentFailureText(result: Refused): string {
  if (result === null) return '应用内部请求失败'
  return result.reason === 'busy' ? '本地存储正忙，请稍后重试' : '本地存储不可用或写入失败'
}

const IMAGE_REASON_TEXT: Record<ImageError['reason'], string> = {
  'no-image': '本地没有这条发言或它没有图片',
  'unsupported-source': '图片地址无法识别',
  network: '网络失败',
  timeout: '网络超时',
  'http-status': '图片服务器返回错误状态',
  redirect: '图片服务器要求重定向，未跟随',
  html: '图片服务器返回了网页而不是图片',
  'not-image': '返回内容不是支持的图片格式',
  'too-large': '图片超过大小或像素上限',
  storage: '本地写入失败或空间不足'
}

export function describeImageError(error: ImageError): string {
  const text = IMAGE_REASON_TEXT[error.reason]
  return error.httpStatus === undefined ? text : `${text}（HTTP ${error.httpStatus}）`
}

/** Why saving stopped short, or null when nothing failed. */
export function offlineErrorText(copy: OfflineCopy): string | null {
  const error = copy.error
  if (error === null) return null
  const at = copy.failedPage === null ? '' : `第 ${copy.failedPage} 页`
  if (error === 'storage') return `${at}${at === '' ? '' : '：'}本地写入失败或空间不足`
  if (error === 'page-limit') return `达到单次保存的页数上限${at === '' ? '' : `（停在${at}）`}`
  const server = error.serverMessage === undefined ? '' : `；论坛提示：${error.serverMessage}`
  return `${at === '' ? '读取' : `${at}读取`}失败：${describeReadError(error)}${server}`
}

/** Short state of a copy for buttons and list rows. */
export function offlineStateText(copy: OfflineCopy): string {
  switch (copy.state) {
    case 'saving':
      return '正在保存'
    case 'cancelled':
      return '已取消，保留已完成部分'
    case 'interrupted':
      return '上次保存被中断，保留已完成部分'
    case 'stopped':
      if (copy.error !== null) return '因错误停止，保留已完成部分'
      return copy.endCandidatePage === null ? '已停止' : `已读到末尾候选（第 ${copy.endCandidatePage} 页为空）`
  }
}

/**
 * Originals line: saved against expected, never counting thumbnails. The counts cover the whole
 * copy; `includeImages` only says whether the latest save or update fetched originals.
 */
export function offlineImagesText(copy: OfflineCopy): string {
  const counts = `原图 ${copy.savedImages} / ${copy.imageCount} 张已保存${copy.imageFailures.length > 0 ? `，${copy.imageFailures.length} 张失败` : ''}`
  if (copy.includeImages) return counts
  return `${counts}；最近一次仅保存文字`
}

/** What needs attention about a copy, or null for a normal one (stopped with no error and no failed originals). */
export interface OfflineAttention {
  kind: 'saving' | 'warning'
  /** One line built from the state, error and originals texts above. */
  text: string
}

export function offlineAttention(copy: OfflineCopy): OfflineAttention | null {
  if (copy.state === 'saving') return { kind: 'saving', text: offlineStateText(copy) }
  const error = offlineErrorText(copy)
  const images = copy.imageFailures.length > 0 ? offlineImagesText(copy) : null
  // A stopped copy without an error says only what went wrong with its originals.
  const state = copy.state === 'stopped' && error === null ? null : offlineStateText(copy)
  if (state === null && images === null) return null
  return { kind: 'warning', text: [state, error, images].filter((part) => part !== null).join('；') }
}

export interface RetainedHeading {
  text: string
  /** `number`: the heading is `No.<id>`, so the row's meta leaves the number out (it appears once). */
  source: 'title' | 'excerpt' | 'number'
}

/**
 * How a 浏览 row of 历史 names its thread: the title, else the first line of the head post held
 * locally (`excerpt`, shown on one line), else the number.
 */
export function retainedHeading(entry: RetainedEntry): RetainedHeading {
  const title = meaningfulTitle(entry.title)
  if (title !== null) return { text: title, source: 'title' }
  const line = entry.excerpt
    ?.split('\n')
    .map((part) => part.trim())
    .find((part) => part !== '')
  if (line !== undefined) return { text: line, source: 'excerpt' }
  return { text: `No.${entry.threadId}`, source: 'number' }
}
