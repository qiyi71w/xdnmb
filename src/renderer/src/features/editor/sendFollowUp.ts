import type { QuoteLocation } from '../../../../shared/api'
import { sameTarget, type PostTarget } from '../../../../shared/drafts'
import type { PostId, ThreadId } from '../../../../shared/forum'
import type { PublicationAttempt } from '../../../../shared/publication'
import type { ThreadSnapshot } from '../tabs/tabsState'

/**
 * What the tab a send came from does once that send has its result (spec 刷新与发送后的更新).
 * - `reply`: the tab still shows the thread: refresh it; with a confirmed post ID, then locate that
 *   reply like a quote jump, a new back step to `source` (where the reader was when the send
 *   started; null when the tab shows another entry of the thread now: read when jumping).
 * - `thread`: the tab still shows the forum list: refresh it so it lists the new thread; then, with
 *   a confirmed post ID, open the new thread there as a new step (back returns to that list).
 */
export type SendFollowUp =
  | { kind: 'reply'; tabId: number; entryKey: number; threadId: ThreadId; postId: PostId | null; source: ThreadSnapshot | null }
  | { kind: 'thread'; tabId: number; entryKey: number; forumId: string; threadId: ThreadId | null }

/** The tab a send came from, read when the send started: its current entry and reading position. */
export interface SendOrigin {
  tabId: number
  /** Null when the tab no longer existed. */
  entryKey: number | null
  /** The entry's reader position; null without a reader on screen. */
  source: ThreadSnapshot | null
}

/** A tab's current history entry and the post targets it shows now. */
export interface ShownEntry {
  tabId: number
  entryKey: number
  targets: readonly PostTarget[]
}

/**
 * The follow-up of a send's own result: confirmed, or sent with its ID unconfirmed. `shown` is the
 * sending tab now. Nothing for other results, or when the tab no longer shows the send's thread /
 * forum list.
 */
export function planSendFollowUp(attempt: PublicationAttempt, origin: SendOrigin, shown: ShownEntry | null): SendFollowUp | null {
  if (shown === null || shown.tabId !== origin.tabId || (attempt.state !== 'confirmed' && attempt.state !== 'unconfirmed')) return null
  const target = attempt.payload.target
  if (!shown.targets.some((item) => sameTarget(item, target))) return null
  const postId = attempt.state === 'confirmed' ? attempt.postId : null
  const { tabId, entryKey } = shown
  return target.kind === 'reply'
    ? { kind: 'reply', tabId, entryKey, threadId: target.threadId, postId, source: origin.entryKey === entryKey ? origin.source : null }
    : { kind: 'thread', tabId, entryKey, forumId: target.forumId, threadId: postId === null ? null : (attempt.threadId ?? postId) }
}

export interface SendFollowUpDeps {
  /** The plan's entry is still the current entry of its tab and still shows the send's target. */
  stillShown: (plan: SendFollowUp) => boolean
  /** Refreshes the reader of the entry; settles when that refresh has ended (or there is none). */
  refreshThread: (entryKey: number) => Promise<void>
  /** Refreshes the forum list of the entry, superseding one running; settles once the list shows the result (or there is none). */
  refreshList: (entryKey: number) => Promise<void>
  /** Quote locate of a post, from local records. */
  locate: (postId: PostId) => Promise<QuoteLocation>
  /** Reads the thread's last page (full listing), recording its replies for a later locate. */
  readThreadEnd: (threadId: ThreadId) => Promise<void>
  /** Commits a located reply as a quote jump from the entry. */
  openLocated: (plan: SendFollowUp & { kind: 'reply' }, location: QuoteLocation & { status: 'located' }) => void
  /** Opens the new thread from the forum list entry, as choosing it in the list does. */
  openThread: (plan: SendFollowUp & { kind: 'thread' }, threadId: ThreadId) => void
}

/**
 * Runs a follow-up. Every step after a wait first checks the tab still shows the target; a tab
 * that moved on is left alone. A reply that cannot be located stays a plain refresh.
 */
export async function runSendFollowUp(plan: SendFollowUp, deps: SendFollowUpDeps): Promise<void> {
  if (plan.kind === 'thread') {
    // First, so both the list beside the new thread (split) and the one back returns to show it.
    await deps.refreshList(plan.entryKey)
    if (plan.threadId !== null && deps.stillShown(plan)) deps.openThread(plan, plan.threadId)
    return
  }
  await deps.refreshThread(plan.entryKey)
  const { postId } = plan
  if (postId === null || !deps.stillShown(plan)) return
  let location = await deps.locate(postId)
  // The refresh reads only up to the reader's range: a reply on a later page is not recorded yet.
  if (location.status !== 'located' && location.status !== 'cancelled') {
    if (!deps.stillShown(plan)) return
    await deps.readThreadEnd(plan.threadId)
    if (!deps.stillShown(plan)) return
    location = await deps.locate(postId)
  }
  if (location.status !== 'located' || location.threadId !== plan.threadId || !deps.stillShown(plan)) return
  deps.openLocated(plan, location)
}
