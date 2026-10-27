// Filters of one list view (spec I10): 版面／时间／含图 on the thread's main post, the same
// `ContentFilters` local search uses. They only choose among threads already on screen: nothing is
// read to fill the list and the selected thread keeps being read.

import type { Post } from '../../../../shared/forum'
import type { ContentFilters, SearchFilters } from '../../../../shared/search'
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

/** Enabled filters of the search page: the list filters plus 发言类型. */
export function searchFilterCount(filters: SearchFilters): number {
  return contentFilterCount(filters) + (filters.postKind !== 'any' ? 1 : 0)
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
}

export function filterList<T>(items: readonly T[], metaOf: (item: T) => ListItemMeta | null, filters: ContentFilters): FilteredList<T> {
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
