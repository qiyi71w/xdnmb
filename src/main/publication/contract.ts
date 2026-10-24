import type { DraftSaveInput } from '../../shared/drafts'
import type { OwnPost, PublicationAttempt, PublicationProblem, PublicationState } from '../../shared/publication'

export interface PublicationStore {
  /** Atomically creates intent + attachment reference, or returns existing requestId. Rejects a draft locked by an unresolved attempt. */
  createPublication(input: { requestId: string; editorId: string; payload: DraftSaveInput; forumId: string; at: string; switchThreadIdentity?: boolean }): Promise<PublicationAttempt>
  listPublications(): Promise<PublicationAttempt[]>
  getPublication(id: string): Promise<PublicationAttempt | null>
  /** Atomic result + own-post registration + thread preference initialization + draft disposition. */
  finishPublication(input: { id: string; state: Exclude<PublicationState, 'sending'>; problem: PublicationProblem | null; postId: string | null; threadId: string | null; at: string }): Promise<PublicationAttempt>
  /** Startup only: sending becomes unknown; never sends. */
  recoverPublications(at: string): Promise<void>
  listOwnPosts(): Promise<OwnPost[]>
  addManualOwnPost(input: { postId: string; threadId: string; isThread: boolean; at: string }): Promise<void>
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
  /** One POST then, only on explicit success, exactly one same-session getLastPost and public confirmation. No retries. */
  publish(input: { payload: DraftSaveInput; userhash: string; attachment: { path: string; format: string } | null }): Promise<PublishReport>
}
