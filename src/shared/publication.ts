import type { DraftSaveInput, SavedDraft } from './drafts'
import type { CredentialId } from './identity'

/**
 * `confirmed`: sent, its post known. `unconfirmed`: the forum reported success but the post could
 * not be named; it is sent all the same. `unknown`: the request reached the forum and then its
 * result was lost; a read-only check ends it as confirmed or failed. `failed`: not sent (its content
 * is in a draft), or, with problem `unverified`, an unknown send the check could not find.
 */
export type PublicationState = 'sending' | 'confirmed' | 'failed' | 'unknown' | 'unconfirmed'
export type PublicationProblem = 'storage' | 'identity' | 'attachment' | 'target' | 'empty' | 'busy' | 'interval' | 'rejected' | 'rate-limited' | 'captcha' | 'network' | 'response' | 'unverified'

/** Still in progress: its editor and source draft stay locked until it is sent or failed. */
export function isUnsettled(attempt: Pick<PublicationAttempt, 'state'>): boolean {
  return attempt.state === 'sending' || attempt.state === 'unknown'
}

/** Sent: listed in 发送记录, with its post number when known. */
export function isSent(attempt: Pick<PublicationAttempt, 'state'>): boolean {
  return attempt.state === 'confirmed' || attempt.state === 'unconfirmed'
}

/** A durable, immutable submission. No secret or arbitrary path crosses this boundary. */
export interface PublicationAttempt {
  id: string
  requestId: string
  editorId: string
  draftId: string | null
  payload: DraftSaveInput
  state: PublicationState
  problem: PublicationProblem | null
  createdAt: string
  updatedAt: string
  /** The post this attempt created (a new thread's own number for a thread); set exactly when `confirmed`. */
  postId: string | null
  /** The thread the post is in; set exactly when `confirmed`. */
  threadId: string | null
  /**
   * The 饼干 ID of the sending cookie as known locally when the intent was recorded; kept when the
   * cookie's ID later changes or the cookie is removed. Null when it was unknown then.
   */
  cookieId: string | null
  /** A failed submission's automatically saved draft, if that transaction succeeded. */
  savedDraftId: string | null
}

export interface SubmitInput {
  /** A fresh UUID for each explicit send; reuse while awaiting the same send's result. */
  requestId: string
  editorId: string
  payload: DraftSaveInput
}

/** The thread's main post carries the 饼干 ID of another imported cookie than the one about to send. */
export interface PoPrompt {
  token: string
  currentName: string
  poName: string
  poCredentialId: CredentialId
  /** False when the matching cookie's secret is missing or cannot be decrypted. */
  canSwitch: boolean
}

export type SubmitResult =
  | { kind: 'attempt'; attempt: PublicationAttempt }
  | { kind: 'prompt'; prompt: PoPrompt }
  | { kind: 'refused'; reason: PublicationProblem }

export interface PublicationApi {
  submit(input: SubmitInput): Promise<SubmitResult>
  /** The token owns the frozen payload. Cancel has no identity or suppression side effects. */
  resolvePrompt(input: { token: string; choice: 'switch' | 'current' | 'cancel'; suppress: boolean }): Promise<SubmitResult | { kind: 'cancelled' }>
  listAttempts(): Promise<{ ok: true; attempts: PublicationAttempt[] } | { ok: false; reason: 'storage' }>
  getAttempt(input: { attemptId: string }): Promise<{ ok: true; attempt: PublicationAttempt | null; draft: SavedDraft | null } | { ok: false; reason: 'storage' }>
  getPoWarning(): Promise<{ enabled: boolean }>
  setPoWarning(input: { enabled: boolean }): Promise<{ ok: boolean; enabled: boolean }>
}
