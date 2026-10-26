import type { Post } from '../../../../shared/forum'
import { parseForumTime } from '../../lib/time'

/** How much older than the page's second thread the first one must be. */
const PINNED_MIN_AGE_MS = 30 * 24 * 3_600_000

/**
 * Whether the first thread of a forum or timeline list page is a 置顶串. The forum has no pinned
 * marker, only the position: the first thread of page 1, posted by an admin, at least 30 days
 * older than the page's second thread. Undecided (false) for other pages, a page with fewer than
 * two threads, or either time unparsable.
 */
export function isPinnedThread(page: number, threads: readonly { head: Pick<Post, 'isAdmin' | 'createdAt'> }[]): boolean {
  const [first, second] = threads
  if (page !== 1 || first === undefined || second === undefined || first.head.isAdmin !== true) return false
  const firstAt = first.head.createdAt === null ? null : parseForumTime(first.head.createdAt)
  const secondAt = second.head.createdAt === null ? null : parseForumTime(second.head.createdAt)
  return firstAt !== null && secondAt !== null && secondAt.getTime() - firstAt.getTime() >= PINNED_MIN_AGE_MS
}
