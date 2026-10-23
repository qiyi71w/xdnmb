import { MAX_MARK_READ_IDS } from '../../../../shared/api'
import type { PostId, ReadingMode } from '../../../../shared/forum'
import type { ReadingAnchor, ThreadReadingState, UnreadPost } from '../../../../shared/reading'
import type { ThreadOpen } from '../tabs/tabsState'

/** Where a reader puts its reading line after loading a range. */
export type ReaderPosition =
  | { kind: 'top' }
  /** Restore a remembered anchor (snapshot or saved position); `anchor.page` is loaded. */
  | { kind: 'anchor'; anchor: ReadingAnchor }
  /** Put an explicit post (target, 首条未读) at the reading line; `page` is loaded. */
  | { kind: 'post'; postId: PostId; page: number }
  /** Top of a page (页码 jump). */
  | { kind: 'page'; page: number }
  /** Last loaded post (末尾). */
  | { kind: 'last' }

export interface ReaderStart {
  mode: ReadingMode
  position: ReaderPosition
}

/** Page the reader loads first for a start position. */
export function startPage(position: ReaderPosition): number {
  switch (position.kind) {
    case 'anchor':
      return position.anchor.page
    case 'post':
    case 'page':
      return position.page
    case 'top':
    case 'last':
      return 1
  }
}

/** Saved position of one mode, or the top of page 1. */
export function savedStart(state: ThreadReadingState | null, mode: ReadingMode): ReaderStart {
  const saved = state?.positions[mode] ?? null
  return { mode, position: saved === null ? { kind: 'top' } : { kind: 'anchor', anchor: saved.anchor } }
}

/**
 * Opening a thread: an explicit target wins (shown in its own mode), then the entry's snapshot
 * (back/forward), then the saved position of the saved mode preference, then page 1 top.
 */
export function decideStart(open: ThreadOpen, state: ThreadReadingState | null): ReaderStart {
  if (open.target !== null) {
    return { mode: open.target.mode, position: { kind: 'post', postId: open.target.postId, page: open.target.page } }
  }
  if (open.snapshot !== null) return { mode: open.snapshot.mode, position: { kind: 'anchor', anchor: open.snapshot.anchor } }
  return savedStart(state, state?.mode ?? 'all')
}

/** Confirmed unread posts known to sit on a page of `mode`, excluding posts read since the last fetch. */
export function unreadInMode(state: ThreadReadingState | null, mode: ReadingMode, readNow: ReadonlySet<PostId>): UnreadPost[] {
  if (state === null) return []
  return state.unread.filter((post) => post.pages[mode] !== null && !readNow.has(post.postId))
}

/** IDs for one `markRead` call each. */
export function markReadChunks(postIds: readonly PostId[]): PostId[][] {
  const chunks: PostId[][] = []
  for (let start = 0; start < postIds.length; start += MAX_MARK_READ_IDS) {
    chunks.push(postIds.slice(start, start + MAX_MARK_READ_IDS))
  }
  return chunks
}
