import type { PostTarget } from '../../../../shared/drafts'
import type { ForumId, PostId, ThreadId } from '../../../../shared/forum'
import type { CredentialId, IdentityOverview } from '../../../../shared/identity'
import type { PublicationAttempt } from '../../../../shared/publication'

/** What a send went to: a new thread (新串) or a reply (回复); names the 历史 page it is listed on. */
export type SentKind = PostTarget['kind']

/**
 * Where a sent record (a confirmed attempt) opens:
 * - `post`: a reply with its own number, located in its thread the way a quote jump is;
 * - `thread`: the thread itself, opened as usual (a new thread with its number, or a reply the user
 *   confirmed without one);
 * - `forum`: the forum list of a new thread the user confirmed without its number. No thread is
 *   guessed.
 */
export type RecordPlace =
  | { kind: 'post'; threadId: ThreadId; postId: PostId }
  | { kind: 'thread'; threadId: ThreadId }
  | { kind: 'forum'; forumId: ForumId }

export function recordPlace(attempt: Pick<PublicationAttempt, 'payload' | 'postId' | 'threadId'>): RecordPlace {
  const target = attempt.payload.target
  if (target.kind === 'reply') {
    const threadId = attempt.threadId ?? target.threadId
    return attempt.postId === null ? { kind: 'thread', threadId } : { kind: 'post', threadId, postId: attempt.postId }
  }
  const threadId = attempt.threadId ?? attempt.postId
  return threadId === null ? { kind: 'forum', forumId: target.forumId } : { kind: 'thread', threadId }
}

/** A number typed for 已发出: digits only, or nothing (`null`). */
export function parsePostIdInput(text: string): { ok: true; postId: PostId | null } | { ok: false } {
  const value = text.trim()
  if (value === '') return { ok: true, postId: null }
  return /^\d{1,20}$/.test(value) ? { ok: true, postId: value } : { ok: false }
}

/**
 * The 饼干 ID a record was sent with: the one saved with the attempt, else (unknown when it was sent)
 * the one its local imported cookie has now; never fetched. `fallback` says, locally, why there is
 * none: the cookie is gone, has no known ID, or none was referenced. `null` while the cookies are
 * still being read.
 */
export function recordCookie(
  attempt: Pick<PublicationAttempt, 'cookieId' | 'payload'>,
  overview: IdentityOverview | null
): { kind: 'id'; text: string } | { kind: 'fallback'; text: string } | null {
  if (attempt.cookieId !== null) return { kind: 'id', text: attempt.cookieId }
  const credentialId = attempt.payload.credentialId
  if (credentialId === null) return { kind: 'fallback', text: '未记录饼干' }
  if (overview === null) return null
  const credential = overview.credentials.find((item) => item.id === credentialId)
  if (credential === undefined) return { kind: 'fallback', text: '饼干已从本机移除' }
  return credential.cookieId === null ? { kind: 'fallback', text: `饼干「${credential.name}」` } : { kind: 'id', text: credential.cookieId }
}
