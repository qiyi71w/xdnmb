import type { DraftSaveInput, SavedDraft } from './drafts'
import type { CredentialId } from './identity'

export type PublicationState = 'sending' | 'confirmed' | 'failed' | 'unknown' | 'unconfirmed'
export type PublicationProblem = 'storage' | 'identity' | 'attachment' | 'target' | 'empty' | 'busy' | 'interval' | 'rejected' | 'rate-limited' | 'captcha' | 'network' | 'response'

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
  postId: string | null
  threadId: string | null
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
