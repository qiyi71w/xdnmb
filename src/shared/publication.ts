import type { DraftId, DraftSaveInput, PostTarget, SavedDraft } from './drafts'
import type { CredentialId } from './identity'
import type { Post } from './forum'

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
  /**
   * A failed attempt's error text from the forum's response (its first `<p class="error">`),
   * whitespace collapsed, at most 120 characters ending in “…” when cut. Plain text, never HTML;
   * absent when the forum gave none and on attempts recorded before it was kept.
   */
  forumMessage?: string
  /** Locally held confirmed post, supplied by list reads only; never changes the submission payload. */
  preview?: Post
}

export interface SubmitInput {
  /** A fresh UUID for each explicit send; reuse while awaiting the same send's result. */
  requestId: string
  editorId: string
  payload: DraftSaveInput
}

/** One cookie the PO question offers. */
export interface PoCandidate {
  credentialId: CredentialId
  name: string
  /** Its 饼干 ID as imported; null when unknown. */
  cookieId: string | null
  /** `current`: the cookie the editor was about to send with; `po`: its 饼干 ID is the main post's. */
  role: 'current' | 'po'
  /** Why it cannot send now (its secret is missing or cannot be decrypted); null when it can. */
  unavailable: 'unreadable' | null
}

/** The thread's main post carries the 饼干 ID of other imported cookies than the one about to send. */
export interface PoPrompt {
  token: string
  /** The current cookie first, then every imported cookie with the main post's 饼干 ID, in 饼干管理 order. */
  candidates: PoCandidate[]
  /** Selected when the question opens: the first usable PO cookie, else the current cookie. */
  initial: CredentialId
}

/** Answer to a PO question: send with one of its usable candidates, or send nothing. */
export type PoAnswer = { kind: 'cancel' } | { kind: 'send'; credentialId: CredentialId; suppress: boolean }

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
  response: '论坛的响应无法识别',
  unverified: '发送后连接中断，没能确认是否已发出'
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
 * An explicit failure (a `failed` attempt: the forum's own verdict after the request was sent —
 * rejection, rate limit, captcha, unusable identity), whose content was saved as a draft. Carries
 * no content and no cookie; `editorId` is the renderer's editor that sent it.
 */
export interface SendFailureNotice {
  attemptId: string
  editorId: string
  draftId: DraftId
  problem: PublicationProblem
  target: PostTarget
  /** Shown in the app only; a system notification never carries it. */
  forumMessage?: string
}

/** The failure notice of a recorded attempt; `null` unless it failed and its draft was saved. */
export function sendFailureNotice(attempt: PublicationAttempt): SendFailureNotice | null {
  if (attempt.state !== 'failed' || attempt.problem === null || attempt.savedDraftId === null) return null
  return {
    attemptId: attempt.id, editorId: attempt.editorId, draftId: attempt.savedDraftId, problem: attempt.problem, target: attempt.payload.target,
    ...(attempt.forumMessage === undefined ? {} : { forumMessage: attempt.forumMessage })
  }
}

/** “发送失败：<原因>” — the in-app notice's message and the system notification's title. */
export function sendFailureTitle(problem: PublicationProblem): string {
  return `发送失败：${ATTEMPT_PROBLEM_TEXT[problem]}`
}

/** Main → renderer event channels of `PublicationApi.onFailureNotice` / `onOpenDraft` / `onChanged`. */
export const PUBLICATION_FAILURE_CHANNEL = 'publication:failure-notice'
export const PUBLICATION_OPEN_DRAFT_CHANNEL = 'publication:open-draft'
export const PUBLICATION_CHANGED_CHANNEL = 'publication:changed'

export interface PublicationApi {
  submit(input: SubmitInput): Promise<SubmitResult>
  /**
   * The token owns the frozen payload. Cancel has no identity or suppression side effects; sending
   * with a PO candidate also makes it the thread's 发言饼干. Anything but a usable candidate of this
   * question is refused.
   */
  resolvePrompt(input: { token: string; answer: PoAnswer }): Promise<SubmitResult | { kind: 'cancelled' }>
  listAttempts(): Promise<{ ok: true; attempts: PublicationAttempt[] } | { ok: false; reason: 'storage' }>
  getAttempt(input: { attemptId: string }): Promise<{ ok: true; attempt: PublicationAttempt | null; draft: SavedDraft | null } | { ok: false; reason: 'storage' }>
  getPoWarning(): Promise<{ enabled: boolean }>
  setPoWarning(input: { enabled: boolean }): Promise<{ ok: boolean; enabled: boolean }>
  /**
   * An explicit failure to show as an in-app notice. `missed` false: the window was in front when
   * it happened; true: the window is shown again after its system notification could not be shown.
   */
  onFailureNotice(listener: (notice: SendFailureNotice, missed: boolean) => void): () => void
  /** A failure's system notification was clicked (the window is already shown): open its draft. */
  onOpenDraft(listener: (notice: SendFailureNotice) => void): () => void
  /**
   * A stored send changed without this window asking (the automatic check named its post, or ended
   * an unknown one): read sends and drafts again. Returns an unsubscribe function.
   */
  onChanged(listener: () => void): () => void
}
