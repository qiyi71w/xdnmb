import type { DraftId, DraftSaveInput, PostTarget, SavedDraft } from './drafts'
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

/**
 * Why a send was refused or stopped; none of them retries or queues. Use this wording for refusals,
 * which happen before any intent is recorded, so `storage` there means nothing was sent.
 */
export const PROBLEM_TEXT: Record<PublicationProblem, string> = {
  storage: '本地存储不可用，没有发送',
  identity: '发言饼干不可用（未选择、已移除或无法读取），请重新选择',
  attachment: '附图的本地副本不可用，请重新添加或移除图片',
  target: '发言目标无效，或版面尚未知',
  empty: '没有可发送的内容',
  busy: '这块饼干有一次发送还没结束',
  interval: '这块饼干在该版面的发言间隔太短，请稍后再发',
  rejected: '论坛拒绝了这次发言',
  'rate-limited': '论坛限制了发言频率，已停止',
  captcha: '论坛要求验证码，已停止',
  network: '网络连接失败',
  response: '论坛的响应无法识别'
}

/**
 * Problem wording for a recorded attempt. Its intent was already durable before the request, so a
 * `storage` problem here means the result could not be saved after sending, not that nothing was sent.
 */
export const ATTEMPT_PROBLEM_TEXT: Record<PublicationProblem, string> = {
  ...PROBLEM_TEXT,
  storage: '发送结果没能保存，这次发言可能已经发出'
}

/**
 * An explicit failure (a `failed` attempt: the forum rejected it, rate limit, captcha, unusable
 * identity), whose content was saved as a draft. Carries no content and no cookie.
 */
export interface SendFailureNotice {
  attemptId: string
  draftId: DraftId
  problem: PublicationProblem
  target: PostTarget
}

/** The failure notice of a recorded attempt; `null` unless it failed and its draft was saved. */
export function sendFailureNotice(attempt: PublicationAttempt): SendFailureNotice | null {
  if (attempt.state !== 'failed' || attempt.problem === null || attempt.savedDraftId === null) return null
  return { attemptId: attempt.id, draftId: attempt.savedDraftId, problem: attempt.problem, target: attempt.payload.target }
}

/** “发送失败：<原因>” — the in-app notice's message and the system notification's title. */
export function sendFailureTitle(problem: PublicationProblem): string {
  return `发送失败：${ATTEMPT_PROBLEM_TEXT[problem]}`
}

/** Main → renderer event channels of `PublicationApi.onFailureNotice` / `onOpenDraft`. */
export const PUBLICATION_FAILURE_CHANNEL = 'publication:failure-notice'
export const PUBLICATION_OPEN_DRAFT_CHANNEL = 'publication:open-draft'

export interface PublicationApi {
  submit(input: SubmitInput): Promise<SubmitResult>
  /** The token owns the frozen payload. Cancel has no identity or suppression side effects. */
  resolvePrompt(input: { token: string; choice: 'switch' | 'current' | 'cancel'; suppress: boolean }): Promise<SubmitResult | { kind: 'cancelled' }>
  listAttempts(): Promise<{ ok: true; attempts: PublicationAttempt[] } | { ok: false; reason: 'storage' }>
  getAttempt(input: { attemptId: string }): Promise<{ ok: true; attempt: PublicationAttempt | null; draft: SavedDraft | null } | { ok: false; reason: 'storage' }>
  getPoWarning(): Promise<{ enabled: boolean }>
  setPoWarning(input: { enabled: boolean }): Promise<{ ok: boolean; enabled: boolean }>
  /**
   * An explicit failure to show as an in-app notice: the window was in front when it happened, or
   * is shown again after its system notification could not be shown.
   */
  onFailureNotice(listener: (notice: SendFailureNotice) => void): () => void
  /** A failure's system notification was clicked (the window is already shown): open its draft. */
  onOpenDraft(listener: (notice: SendFailureNotice) => void): () => void
}
