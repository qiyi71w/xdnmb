import { MAX_MARK_READ_IDS, type OperationId, type ReadOutcome, type ThreadPageResult } from '../../../../shared/api'
import type { PostId, ReadingMode, ThreadId } from '../../../../shared/forum'
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
 * 打开原串 (from a quote card or a search result): reads the page the thread resumes at — its saved
 * mode preference and that mode's saved position — so the navigation is committed only once that
 * page was obtained (spec I6). `current` is checked before the page read; `null` = no longer wanted.
 */
export async function readResumePage(
  threadId: ThreadId,
  operationId: OperationId,
  current: () => boolean
): Promise<ReadOutcome<ThreadPageResult> | null> {
  const reading = await window.xidao.readingState.get({ threadId }).catch(() => null)
  if (!current()) return null
  const start = savedStart(reading, reading?.mode ?? 'all')
  return window.xidao.reading.readThreadPage({ operationId, threadId, mode: start.mode, page: startPage(start.position) })
}

/**
 * Opening a thread: an explicit target wins (shown in its own mode), then the entry's snapshot
 * (back/forward) unless the thread's reading data was cleared since it was taken (`generation`),
 * then the saved position of the saved mode preference, then page 1 top.
 */
export function decideStart(open: ThreadOpen, state: ThreadReadingState | null, generation: number): ReaderStart {
  if (open.target !== null) {
    return { mode: open.target.mode, position: { kind: 'post', postId: open.target.postId, page: open.target.page } }
  }
  if (open.snapshot !== null && open.snapshot.generation === generation) {
    return { mode: open.snapshot.mode, position: { kind: 'anchor', anchor: open.snapshot.anchor } }
  }
  return savedStart(state, state?.mode ?? 'all')
}

/**
 * Start plus temporary state of a newly mounted reader. A display is temporary (`temporaryOf` names
 * the saved preference it stands in for) when an explicit target opens in a mode other than the
 * preference, or when coming back to an entry that was left during such a display while the
 * preference still differs. A plain snapshot, a snapshot voided by a later history clear, or another
 * tab changing the preference meanwhile, never makes a display temporary.
 */
export function decideView(
  open: ThreadOpen,
  state: ThreadReadingState | null,
  generation: number
): { start: ReaderStart; temporaryOf: ReadingMode | null } {
  const start = decideStart(open, state, generation)
  const preference = state?.mode ?? 'all'
  const snapshot = open.snapshot !== null && open.snapshot.generation === generation ? open.snapshot : null
  const wasTemporary = open.target !== null || (snapshot !== null && snapshot.temporaryOf !== null)
  return { start, temporaryOf: wasTemporary && start.mode !== preference ? preference : null }
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

/**
 * 全部标为已读 in bounded chunks. `writable` is asked before every chunk and once after the last:
 * a history clear that blocked or reset the thread meanwhile stops the batch, so no later chunk is
 * sent and the caller must not show the posts as read. `markRead` resolves to whether it saved.
 */
export async function markAllInChunks(
  postIds: readonly PostId[],
  writable: () => boolean,
  markRead: (chunk: PostId[]) => Promise<boolean>
): Promise<{ failed: boolean; stopped: boolean }> {
  let failed = false
  for (const chunk of markReadChunks(postIds)) {
    if (!writable()) return { failed, stopped: true }
    try {
      if (!(await markRead(chunk))) failed = true
    } catch {
      failed = true
    }
  }
  return { failed, stopped: !writable() }
}
