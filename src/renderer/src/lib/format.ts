import type { ReadError } from '../../../shared/api'
import type { Failure } from './operations'

const KIND_TEXT: Record<ReadError['kind'], string> = {
  'not-found': '目标不存在',
  permission: '无权限，或需要饼干',
  'rate-limited': '被论坛限流，或需要验证',
  network: '网络失败',
  'unknown-structure': '返回内容无法识别',
  'page-cap': '论坛返回了较早的页面',
  identity: '浏览饼干无法使用'
}

/** Copy for errors whose detail alone decides the text. */
const DETAIL_TEXT: Partial<Record<ReadError['detail'], string>> = {
  'identity-missing': '浏览饼干已移除，请在设置中重新选择',
  'identity-locked': '浏览饼干无法使用（系统凭据保护不可用或无法解密）',
  'identity-unknown': '本地存储不可用，无法确定浏览饼干，读取未发出'
}

/** One-line reason for a read error, including the forum's own short message when present. */
export function describeReadError(error: ReadError): string {
  if (error.kind === 'page-cap' && error.highestReadablePage !== undefined) return `论坛只返回到第 ${error.highestReadablePage} 页`
  const detailText = error.kind === 'identity' ? DETAIL_TEXT[error.detail] : undefined
  let text =
    detailText ?? (error.kind === 'network' && error.detail === 'timeout' ? '网络超时' : KIND_TEXT[error.kind])
  if (error.httpStatus !== undefined) text += `（HTTP ${error.httpStatus}）`
  return text
}

/** The read error behind a failure when it is a browse-identity problem (fixed in settings). */
export function identityErrorOf(failure: Failure | ReadError | null): ReadError | null {
  if (failure === null) return null
  const error = 'type' in failure ? (failure.type === 'read' ? failure.error : null) : failure
  return error !== null && error.kind === 'identity' ? error : null
}

export function describeFailure(failure: Failure): string {
  return failure.type === 'read' ? describeReadError(failure.error) : '应用内部请求失败'
}

export function serverMessageOf(failure: Failure | ReadError | null): string | null {
  if (failure === null) return null
  const error = 'type' in failure ? (failure.type === 'read' ? failure.error : null) : failure
  return error?.serverMessage ?? null
}

const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

/** Local time of an ISO timestamp; the raw text when it cannot be parsed. */
export function formatLocalTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : timeFormat.format(date)
}

/** `[1,2,3,5,7,8]` → `1–3、5、7–8` */
export function formatPageList(pages: readonly number[]): string {
  const sorted = [...pages].sort((a, b) => a - b)
  const parts: string[] = []
  let start: number | undefined
  let end: number | undefined
  for (const page of sorted) {
    if (start !== undefined && end !== undefined && page === end + 1) {
      end = page
      continue
    }
    if (start !== undefined && end !== undefined) parts.push(start === end ? `${start}` : `${start}–${end}`)
    start = page
    end = page
  }
  if (start !== undefined && end !== undefined) parts.push(start === end ? `${start}` : `${start}–${end}`)
  return parts.join('、')
}

const DEFAULT_TITLE = '无标题'
const DEFAULT_NAME = '无名氏'

/** Title worth showing, or null for the forum's placeholder. */
export function meaningfulTitle(title: string | null): string | null {
  if (title === null) return null
  const trimmed = title.trim()
  return trimmed === '' || trimmed === DEFAULT_TITLE ? null : trimmed
}

export function meaningfulName(name: string | null): string | null {
  if (name === null) return null
  const trimmed = name.trim()
  return trimmed === '' || trimmed === DEFAULT_NAME ? null : trimmed
}
