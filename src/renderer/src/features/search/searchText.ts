import type { ReadError } from '../../../../shared/api'
import type { ReadingMode, ThreadCoverage } from '../../../../shared/forum'
import type { SearchFetch, SearchHit } from '../../../../shared/search'
import { describeReadError, formatLocalTime, formatPageList } from '../../lib/format'
import type { SearchFailure } from './searchState'

export const MODE_TEXT: Record<ReadingMode, string> = { all: '全部回复', po: '只看 PO' }

export const RETENTION_TEXT: Record<SearchHit['retention'], string> = {
  cache: '普通缓存',
  offline: '离线副本',
  subscription: '订阅记录（受保护）'
}

const LOCATION_SOURCE: Record<NonNullable<SearchHit['location']>['source'], string> = {
  page: '串页面',
  offline: '离线副本',
  list: '串列表'
}

/** Where the hit was observed: mode, page, when and from what. */
export function locationText(location: SearchHit['location']): string {
  if (location === null) return '没有记录所在页'
  const mode = location.mode === 'po' ? '只看 PO ' : ''
  return `${mode}第 ${location.page} 页 · ${formatLocalTime(location.fetchedAt)} 取得 · 来自${LOCATION_SOURCE[location.source]}`
}

export function imageText(hasImage: boolean | null): string {
  return hasImage === null ? '图片未知' : hasImage ? '有图' : '无图'
}

export function failureText(failure: SearchFailure): string {
  switch (failure) {
    case 'storage':
      return '本地存储不可用'
    case 'index-unavailable':
      return '搜索索引不可用'
    case 'busy':
      return '另一个搜索步骤还在进行，请稍后再试'
    case 'expired':
      return '这次搜索已过期'
    case 'internal':
      return '应用内部请求失败'
  }
}

/** Observed pages of one mode, gaps and end candidate; never called complete. */
export function coverageText(coverage: ThreadCoverage): string {
  const pages = coverage.pages.map((page) => page.page)
  if (pages.length === 0) return `${MODE_TEXT[coverage.mode]}：本机还没有取得任何页`
  const parts = [`${MODE_TEXT[coverage.mode]}：本机有第 ${formatPageList(pages)} 页`]
  if (coverage.gaps.length > 0) parts.push(`缺第 ${formatPageList(coverage.gaps)} 页`)
  parts.push(coverage.endCandidatePage === null ? '尚未读到末尾候选' : `第 ${coverage.endCandidatePage} 页为末尾候选`)
  return parts.join('，')
}

function fetchErrorText(error: SearchFetch['error']): string | null {
  if (error === null) return null
  if (error === 'storage') return '本地存储失败'
  if (error === 'page-limit') return '达到单次获取的页数上限'
  return readErrorText(error)
}

export function readErrorText(error: ReadError): string {
  return `${describeReadError(error)}${error.serverMessage !== undefined ? `；论坛提示：${error.serverMessage}` : ''}`
}

/** Status line of an explicit full-thread fetch: actual pages, failure and what was kept. */
export function fetchText(fetch: SearchFetch): string {
  const got = fetch.pages.length === 0 ? '还没有取得新页' : `已取得第 ${formatPageList(fetch.pages)} 页`
  const reason = fetchErrorText(fetch.error)
  switch (fetch.state) {
    case 'running':
      return `正在获取：${got}`
    case 'stopped':
      return reason === null ? `获取结束：${got}` : `获取停止（${reason}）：${got}`
    case 'cancelled':
      return `已取消：${got}，已取得的内容保留`
    case 'failed':
      return `${fetch.failedPage === null ? '获取失败' : `第 ${fetch.failedPage} 页读取失败`}${reason === null ? '' : `（${reason}）`}：${got}，已取得的内容保留`
  }
}

export interface TextPart {
  text: string
  match: boolean
}

/**
 * Splits `text` around literal occurrences of `query` (NFC, case-insensitive), for marking them.
 * Marks nothing when case folding changes the text's length (positions would not line up).
 */
export function highlightParts(text: string, query: string): TextPart[] {
  const needle = query.normalize('NFC').toLowerCase()
  const source = text.normalize('NFC')
  const folded = source.toLowerCase()
  if (needle === '' || folded.length !== source.length) return [{ text, match: false }]
  const parts: TextPart[] = []
  let from = 0
  for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length)) {
    if (at > from) parts.push({ text: source.slice(from, at), match: false })
    parts.push({ text: source.slice(at, at + needle.length), match: true })
    from = at + needle.length
  }
  if (from < source.length) parts.push({ text: source.slice(from), match: false })
  return parts.length === 0 ? [{ text, match: false }] : parts
}
