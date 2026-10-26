import type { DraftSaveInput } from '../../shared/drafts'
import type { PendingChoice, PublicationAttempt, PublicationProblem, PublicationState } from '../../shared/publication'

/** Original limit of one send, from its recorded intent. A quit never extends or restarts it. */
export const PUBLISH_DEADLINE_MS = 60_000

/** The result of one attempt as written to storage. */
export interface PublicationFinish {
  id: string
  state: Exclude<PublicationState, 'sending'>
  problem: PublicationProblem | null
  postId: string | null
  threadId: string | null
  at: string
  /**
   * The result was reached without a window; a failed / unknown result then stays listed for the
   * next start until dismissed. Any later result clears it.
   */
  launchNotice?: boolean
}

/** A stored resolution of a 待核对 attempt; see `PublicationStore.resolvePublication`. */
export type PublicationResolution =
  | { ok: true; attempt: PublicationAttempt }
  | { ok: false; reason: 'not-pending' | 'post-id' }

export interface PublicationStore {
  /** Atomically creates intent + attachment reference, or returns existing requestId. Rejects a draft locked by an unresolved attempt. */
  createPublication(input: { requestId: string; editorId: string; payload: DraftSaveInput; forumId: string; at: string; switchThreadIdentity?: boolean }): Promise<PublicationAttempt>
  listPublications(): Promise<PublicationAttempt[]>
  getPublication(id: string): Promise<PublicationAttempt | null>
  /** Atomic result + claimed-ID check + thread preference initialization + draft disposition. */
  finishPublication(input: PublicationFinish): Promise<PublicationAttempt>
  /** Startup only: sending becomes unknown with a launch notice; never sends. */
  recoverPublications(at: string): Promise<void>
  /**
   * The user ends a 待核对 attempt that is not running. `sent`: confirmed by the user, with the post
   * number when given; the source draft is removed and the attachment released, as for a checked
   * confirmation. `not-sent`: failed, its payload saved as a draft keeping the attachment. Atomic.
   */
  resolvePublication(input: { id: string; choice: PendingChoice; postId: string | null; at: string }): Promise<PublicationResolution>
  /** Attempts carrying a launch notice, oldest first. */
  listLaunchNotices(): Promise<PublicationAttempt[]>
  dismissLaunchNotices(ids: string[]): Promise<void>
  getPoWarningEnabled(): Promise<boolean>
  setPoWarningEnabled(enabled: boolean): Promise<void>
  /** Last intent start for this identity in this forum; survives restarts. */
  lastPublicationAt(credentialId: string, forumId: string): Promise<string | null>
}

export type PublishReport =
  | { state: 'confirmed'; postId: string; threadId: string }
  | { state: 'unconfirmed'; problem: PublicationProblem | null }
  | { state: 'failed' | 'unknown'; problem: PublicationProblem }

export interface PublicationAdapter {
  /**
   * One POST then, only on explicit success, exactly one same-session getLastPost and public
   * confirmation. No retries. `onAccepted` runs once when the forum reported the POST a success,
   * before the ID confirmation starts.
   */
  publish(input: { payload: DraftSaveInput; userhash: string; attachment: { path: string; format: string } | null; onAccepted?: () => void }): Promise<PublishReport>
}
