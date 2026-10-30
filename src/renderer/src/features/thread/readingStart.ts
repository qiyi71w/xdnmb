import type { OperationId, ReadOutcome, ThreadPageResult } from '../../../../shared/api'
import type { PostId, ReadingMode, ThreadId } from '../../../../shared/forum'
import type { ReadingAnchor, ThreadReadingState } from '../../../../shared/reading'
import type { ThreadOpen } from '../tabs/tabsState'

/** Where a reader puts its reading line after loading a range. */
export type ReaderPosition =
  | { kind: 'top' }
  /** Restore a remembered anchor (snapshot or saved position); `anchor.page` is loaded. */
  | { kind: 'anchor'; anchor: ReadingAnchor }
  /** Put an explicit post (quote or search target) at the reading line; `page` is loaded. */
  | { kind: 'post'; postId: PostId; page: number }
  /** Top of a page (页码 jump, or the page of a reminder's first new reply). */
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
 * page was obtained. `current` is checked before the page read; `null` = no longer wanted.
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
    const { postId, page, mode } = open.target
    return { mode, position: postId === null ? { kind: 'page', page } : { kind: 'post', postId, page } }
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
