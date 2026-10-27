import type { DraftSaveInput } from '../../shared/drafts'
import type { PublicationAttempt, PublicationProblem, PublicationState } from '../../shared/publication'

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
  /** A failed result's forum error text, as `PublishReport` gave it; ignored for other states. */
  forumMessage?: string
}

export interface PublicationStore {
  /** Atomically creates intent + attachment reference, or returns existing requestId. Rejects a draft locked by an unresolved attempt. */
  createPublication(input: { requestId: string; editorId: string; payload: DraftSaveInput; forumId: string; at: string; switchThreadIdentity?: boolean }): Promise<PublicationAttempt>
  listPublications(): Promise<PublicationAttempt[]>
  getPublication(id: string): Promise<PublicationAttempt | null>
  /**
   * Atomic result + claimed-ID check + thread preference initialization + draft disposition. A sent
   * result (`confirmed` or `unconfirmed`) removes the source draft and releases the attachment.
   */
  finishPublication(input: PublicationFinish): Promise<PublicationAttempt>
  /** Startup only: sending becomes unknown with a launch notice; never sends. */
  recoverPublications(at: string): Promise<void>
  /**
   * An `unknown` attempt its check could not find: failed (`unverified`), its payload saved as a
   * draft keeping the attachment; the launch notice mark is kept as it is. Atomic. Any other state
   * is returned unchanged.
   */
  failUnverifiedPublication(input: { id: string; at: string }): Promise<PublicationAttempt>
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
  /** `forumMessage`: the forum's own error text (see `PublicationAttempt.forumMessage`), when it gave one. */
  | { state: 'failed'; problem: PublicationProblem; forumMessage?: string }
  | { state: 'unknown'; problem: PublicationProblem }

export interface PublicationAdapter {
  /**
   * One POST then, only on explicit success, exactly one same-session getLastPost and public
   * confirmation. No retries. `onAccepted` runs once when the forum reported the POST a success,
   * before the ID confirmation starts. A POST failing before its connection was established (or an
   * attachment that cannot be read) never reached the forum: `failed`; any later failure: `unknown`.
   */
  publish(input: { payload: DraftSaveInput; userhash: string; attachment: { path: string; format: string } | null; onAccepted?: () => void }): Promise<PublishReport>
}
