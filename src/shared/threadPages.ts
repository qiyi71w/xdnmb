import { comparePostIds, type CoveragePage, type ThreadPage } from './forum'

/** Mode-specific ReplyCount includes deleted replies; Tips is outside the 19-reply page split. */
export function threadTotalPages(replyCount: number | null): number | null {
  return replyCount === null ? null : Math.max(1, Math.ceil(replyCount / 19))
}

/** A nonempty response that repeats a lower page must never become the requested page. */
export function pageCapFor(
  page: ThreadPage,
  observed: readonly Pick<CoveragePage, 'page' | 'replyIds'>[]
): number | null {
  const first = page.replies[0]?.id
  if (page.page <= 1 || first === undefined) return null
  let cap: number | null = null
  for (const lower of observed) {
    if (lower.page >= page.page || lower.replyIds.length === 0) continue
    const duplicate = lower.replyIds.length === page.replies.length &&
      lower.replyIds.every((id, index) => id === page.replies[index]?.id)
    const previousLast = lower.page === page.page - 1 ? lower.replyIds.at(-1) : undefined
    if (duplicate || (previousLast !== undefined && comparePostIds(first, previousLast) <= 0)) {
      cap = Math.max(cap ?? 1, lower.page)
    }
  }
  return cap
}
