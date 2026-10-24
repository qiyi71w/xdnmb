import type { Post } from '../../../../shared/forum'
import type { ContentFilters } from '../../../../shared/search'
import { matchContentFilters } from '../../../../shared/search-filters'
import { NO_CONTENT_FILTERS } from './searchState'

/**
 * Filters of one list view (spec I10): 版面／时间／含图 on the thread's main post, plus 仅未读 where
 * the list offers it (收藏, 订阅). They only choose among threads already on screen: nothing is
 * read to fill the list and the selected thread keeps being read.
 */
export interface ListFilters {
  content: ContentFilters
  unreadOnly: boolean
}

export const NO_LIST_FILTERS: ListFilters = { content: NO_CONTENT_FILTERS, unreadOnly: false }

/** Main-post metadata a list item is judged by; `unreadCount` null when not known. */
export interface ListItemMeta {
  forumId: string | null
  createdAt: string | null
  hasImage: boolean | null
  unreadCount: number | null
  /** The thread's observed pages have gaps or no end: an unread count of 0 is not proof. */
  coverageUnknown: boolean
}

export function contentFilterCount(filters: ContentFilters): number {
  return (
    (filters.forumId !== null ? 1 : 0) +
    (filters.fromDate !== null || filters.toDate !== null ? 1 : 0) +
    (filters.image !== 'any' ? 1 : 0)
  )
}

export function listFilterCount(filters: ListFilters): number {
  return contentFilterCount(filters.content) + (filters.unreadOnly ? 1 : 0)
}

/** Image evidence of a post: present, known absent (explicit empty fields), or unknown. */
export function postHasImage(post: Post): boolean | null {
  if (post.image !== null) return true
  return post.imageKnown === true ? false : null
}

/** Metadata of a thread taken from its main post; unread state is not part of a post. */
export function headMeta(head: Post): ListItemMeta {
  return { forumId: head.forumId, createdAt: head.createdAt, hasImage: postHasImage(head), unreadCount: null, coverageUnknown: false }
}

/**
 * Whether a list item stays shown and whether that rests on unknown fields. Unknown metadata never
 * hides an item: it stays, marked uncertain. `meta` null: nothing is known about the thread yet.
 */
export function judgeListItem(meta: ListItemMeta | null, filters: ListFilters): { shown: boolean; uncertain: boolean } {
  if (listFilterCount(filters) === 0) return { shown: true, uncertain: false }
  if (meta === null) return { shown: true, uncertain: true }
  let uncertain = false
  if (contentFilterCount(filters.content) > 0) {
    const verdict = matchContentFilters(meta, filters.content)
    if (!verdict.matches) return { shown: false, uncertain: false }
    uncertain = verdict.uncertain
  }
  if (filters.unreadOnly) {
    if (meta.unreadCount === null || (meta.unreadCount === 0 && meta.coverageUnknown)) uncertain = true
    else if (meta.unreadCount === 0) return { shown: false, uncertain: false }
  }
  return { shown: true, uncertain }
}

export interface FilteredList<T> {
  shown: { item: T; uncertain: boolean }[]
  hidden: number
  uncertain: number
}

export function filterList<T>(items: readonly T[], metaOf: (item: T) => ListItemMeta | null, filters: ListFilters): FilteredList<T> {
  const shown: { item: T; uncertain: boolean }[] = []
  let hidden = 0
  let uncertain = 0
  for (const item of items) {
    const verdict = judgeListItem(metaOf(item), filters)
    if (!verdict.shown) {
      hidden += 1
      continue
    }
    if (verdict.uncertain) uncertain += 1
    shown.push({ item, uncertain: verdict.uncertain })
  }
  return { shown, hidden, uncertain }
}
