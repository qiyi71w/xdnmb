import type { PublicationProblem, PublicationState } from '../../../../shared/publication'
import type { SentKind } from './sentRecords'

export const ATTEMPT_STATE_LABEL: Record<PublicationState, string> = {
  sending: '正在发送',
  confirmed: '已发送',
  failed: '发送失败',
  unknown: '正在确认是否已发出',
  unconfirmed: '已发送，串号未确认'
}

/** One sentence for a send still in progress; nothing is ever re-sent. */
export const ATTEMPT_STATE_DETAIL: Record<'sending' | 'unknown', string> = {
  sending: '内容、目标和饼干已固定',
  unknown: '发送后连接中断，正在确认是否已发出…'
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
 * A send whose connection broke after the request reached the forum, and that the read-only check
 * could not find: it may have gone out all the same. A new thread is looked for in its forum (版面),
 * a reply in its thread (串).
 */
export function unverifiedText(kind: SentKind): string {
  const place = kind === 'thread' ? '版面' : '串'
  return `可能已经发出：发送后连接中断，汐岛没在${place}里找到这条，内容已存为草稿。重发前先到${place}里看一眼。`
}
