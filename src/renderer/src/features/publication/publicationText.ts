import type { PublicationProblem, PublicationState, ResolvePendingResult } from '../../../../shared/publication'
import type { SentKind } from './sentRecords'

export const ATTEMPT_STATE_LABEL: Record<PublicationState, string> = {
  sending: '正在发送',
  confirmed: '已发送',
  failed: '发送失败',
  unknown: '发送结果待确认',
  unconfirmed: '已发送，ID 未确认'
}

/** One sentence for an unresolved attempt; nothing is ever re-sent. */
export const ATTEMPT_STATE_DETAIL: Record<'sending' | 'unknown' | 'unconfirmed', string> = {
  sending: '内容、目标和饼干已固定',
  unknown: '可能已经发出，请到目标处核对',
  unconfirmed: '论坛表示已发送，但未能确认这条发言的编号'
}

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

/** A 待核对 attempt's state, named in words in 历史 (colour only reinforces it). */
export const PENDING_MARK: Record<'sending' | 'unknown' | 'unconfirmed', string> = {
  sending: '正在发送',
  unknown: '结果待确认',
  unconfirmed: '串号未确认'
}

/** Why 已发出／没发出 changed nothing; `not-pending` is answered by reading the list again. */
export function resolveFailureText(reason: Extract<ResolvePendingResult, { ok: false }>['reason'] | 'internal', kind: SentKind): string {
  switch (reason) {
    case 'post-id':
      return kind === 'thread' ? '这个串号已属于另一条发送记录' : '这个串号已属于另一条发送记录，或是所回复的串本身'
    case 'busy':
      return '这次发送还没结束，结束后再选择'
    case 'not-pending':
      return '这条发送已不在待核对中，列表已重新读取'
    case 'storage':
      return '本地存储不可用，没有改动'
    case 'internal':
      return '应用内部请求失败，请重新读取列表后再试'
  }
}
