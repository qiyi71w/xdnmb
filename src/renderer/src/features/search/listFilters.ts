// Filters of one list view: 版面／时间／含图 on the thread's main post, the same
// `ContentFilters` local search uses, and on 历史's pages a 关键词. They only choose among items
// already on screen: nothing is read to fill the list and the selected thread keeps being read.

import type { Post, ThreadId } from '../../../../shared/forum'
import { normalizeSearchText, type ContentFilters, type SearchFilters } from '../../../../shared/search'
import { matchContentFilters } from '../../../../shared/search-filters'

/** Main-post metadata a list item is judged by; a field is null when not known. */
export interface ListItemMeta {
  forumId: string | null
  createdAt: string | null
  hasImage: boolean | null
}

export function contentFilterCount(filters: ContentFilters): number {
  return (
    (filters.forumId !== null ? 1 : 0) +
    (filters.fromDate !== null || filters.toDate !== null ? 1 : 0) +
    (filters.image !== 'any' ? 1 : 0)
  )
}

/** Enabled filters of a list: its content filters (none when it has no such fields) plus a 关键词 in use. */
export function listFilterCount(filters: ContentFilters | null, keyword: string): number {
  return (filters === null ? 0 : contentFilterCount(filters)) + (parseKeyword(keyword) !== null ? 1 : 0)
}

/** Enabled filters of the search page: the list filters plus 发言类型. */
export function searchFilterCount(filters: SearchFilters): number {
  return contentFilterCount(filters) + (filters.postKind !== 'any' ? 1 : 0)
}

/**
 * A 关键词 as matched: its text, normalized as local search normalizes it, and the 串号 it names when
 * it is a whole number, or `No.` (any case, spaces allowed before the digits) and one.
 */
export interface Keyword {
  text: string
  number: string | null
}

/** null when the 关键词 is only spaces: not in use. Outer spaces are dropped, inner ones kept. */
export function parseKeyword(raw: string): Keyword | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  return { text: normalizeSearchText(trimmed), number: /^(?:no\.\s*)?(\d+)$/i.exec(trimmed)?.[1] ?? null }
}

/** What one list item is judged by for a 关键词. */
export interface KeywordFields {
  /** Matched as literal substrings; null for a field the item does not have. */
  texts: readonly (string | null)[]
  /** 串号 compared exactly with a 关键词 that names one; null for a number not confirmed yet. */
  numbers: readonly (string | null)[]
  /** Judged without its main post: only by number and kept title. */
  partial: boolean
}

/** An exact 串号 or the text inside any field: either one matches. */
export function matchKeyword(keyword: Keyword, fields: KeywordFields): boolean {
  if (keyword.number !== null && fields.numbers.includes(keyword.number)) return true
  return fields.texts.some((text) => text !== null && normalizeSearchText(text).includes(keyword.text))
}

/**
 * A thread row's 关键词 fields: its main post's title and text, or, when the main post is not held
 * here, the title kept for the row alone. Replies are never matched.
 */
export function threadKeywordFields(threadId: ThreadId, head: Post | null, title: string | null): KeywordFields {
  return head === null
    ? { texts: [title], numbers: [threadId], partial: true }
    : { texts: [head.title, head.plainText], numbers: [threadId], partial: false }
}

/** Image evidence of a post: present, known absent (explicit empty fields), or unknown. */
export function postHasImage(post: Post): boolean | null {
  if (post.image !== null) return true
  return post.imageKnown === true ? false : null
}

/** Metadata of a thread taken from its main post. */
export function headMeta(head: Post): ListItemMeta {
  return { forumId: head.forumId, createdAt: head.createdAt, hasImage: postHasImage(head) }
}

/**
 * Whether a list item stays shown and whether that rests on unknown fields. Unknown metadata never
 * hides an item: it stays, marked uncertain. `meta` null: nothing is known about the thread yet.
 */
export function judgeListItem(meta: ListItemMeta | null, filters: ContentFilters): { shown: boolean; uncertain: boolean } {
  if (contentFilterCount(filters) === 0) return { shown: true, uncertain: false }
  if (meta === null) return { shown: true, uncertain: true }
  const verdict = matchContentFilters(meta, filters)
  return verdict.matches ? { shown: true, uncertain: verdict.uncertain } : { shown: false, uncertain: false }
}

export interface FilteredList<T> {
  shown: { item: T; uncertain: boolean }[]
  hidden: number
  uncertain: number
  /** Items judged by a 关键词 without their main post, shown or not. */
  partial: number
}

/** A list's 关键词 (null when not in use) and how it reads one item. */
export interface KeywordJudge<T> {
  keyword: Keyword | null
  fieldsOf: (item: T) => KeywordFields
}

/**
 * Items kept by both the content filters and the 关键词. A 关键词 mismatch always hides an item,
 * unknown fields never: an item judged on unknown metadata stays, marked uncertain.
 */
export function filterList<T>(
  items: readonly T[],
  metaOf: (item: T) => ListItemMeta | null,
  filters: ContentFilters,
  keyword: KeywordJudge<T> | null = null
): FilteredList<T> {
  const shown: { item: T; uncertain: boolean }[] = []
  let hidden = 0
  let uncertain = 0
  let partial = 0
  for (const item of items) {
    if (keyword !== null && keyword.keyword !== null) {
      const fields = keyword.fieldsOf(item)
      if (fields.partial) partial += 1
      if (!matchKeyword(keyword.keyword, fields)) {
        hidden += 1
        continue
      }
    }
    const verdict = judgeListItem(metaOf(item), filters)
    if (!verdict.shown) {
      hidden += 1
      continue
    }
    if (verdict.uncertain) uncertain += 1
    shown.push({ item, uncertain: verdict.uncertain })
  }
  return { shown, hidden, uncertain, partial }
}
