import type { DraftSaveInput, SavedDraft } from './drafts'
import type { CredentialId } from './identity'

export type PublicationState = 'sending' | 'confirmed' | 'failed' | 'unknown' | 'unconfirmed'
export type PublicationProblem = 'storage' | 'identity' | 'attachment' | 'target' | 'empty' | 'busy' | 'interval' | 'rejected' | 'rate-limited' | 'captcha' | 'network' | 'response'
/**
 * Who established a confirmed attempt: the read-back check right after sending (`check`), or the
 * user afterwards by answering 已发出 for a 待核对 attempt (`user`).
 */
export type PublicationConfirmation = 'check' | 'user'
/** States that may already have taken effect on the forum: listed as 待核对 until the user ends them. */
export const PENDING_STATES: readonly PublicationState[] = ['sending', 'unknown', 'unconfirmed']

export function isPending(attempt: Pick<PublicationAttempt, 'state'>): boolean {
  return PENDING_STATES.includes(attempt.state)
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
  /**
   * The post this attempt created (a new thread's own number for a thread). Always set for a
   * `check` confirmation; a `user` confirmation may leave it null (the user did not give one).
   */
  postId: string | null
  /**
   * The thread the post is in. Set whenever known: a confirmed reply always has its target thread;
   * a new thread confirmed by the user without a number has none.
   */
  threadId: string | null
  /** Set exactly when `state` is `confirmed`. */
  confirmedBy: PublicationConfirmation | null
  /**
   * The 饼干 ID of the sending cookie as known locally when the intent was recorded; kept when the
   * cookie's ID later changes or the cookie is removed. Null when it was unknown then.
   */
  cookieId: string | null
  /** A failed submission's automatically saved draft, if that transaction succeeded. */
  savedDraftId: string | null
}

/**
 * How the user ends a 待核对 attempt. `sent`: it took effect; `postId` optionally names the post
 * (the new thread's number, or the reply's own number). `not-sent`: its content goes to a draft,
 * keeping the attached image. Both change local records only; nothing is sent or read remotely.
 */
export type PendingChoice = 'sent' | 'not-sent'
export interface ResolvePendingInput {
  attemptId: string
  choice: PendingChoice
  /** Digits only; must be null for `not-sent`. */
  postId: string | null
}
export type ResolvePendingResult =
  | { ok: true; attempt: PublicationAttempt }
  /**
   * `not-pending`: no such attempt, or it is no longer 待核对. `busy`: its send is still running.
   * `post-id`: the number already belongs to another sent record, or is the reply's own thread.
   */
  | { ok: false; reason: 'not-pending' | 'busy' | 'post-id' | 'storage' }

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
  /** Ends one 待核对 attempt by the user's answer. Local only: never sends or reads the forum. */
  resolvePending(input: ResolvePendingInput): Promise<ResolvePendingResult>
  getAttempt(input: { attemptId: string }): Promise<{ ok: true; attempt: PublicationAttempt | null; draft: SavedDraft | null } | { ok: false; reason: 'storage' }>
  getPoWarning(): Promise<{ enabled: boolean }>
  setPoWarning(input: { enabled: boolean }): Promise<{ ok: boolean; enabled: boolean }>
}
