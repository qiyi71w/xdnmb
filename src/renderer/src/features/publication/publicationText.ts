import type { PublicationProblem, PublicationState } from '../../../../shared/publication'

export const ATTEMPT_STATE_LABEL: Record<PublicationState, string> = {
  sending: '正在发送',
  confirmed: '已发送',
  failed: '发送失败',
  unknown: '发送结果待确认',
  unconfirmed: '已发送，ID 未确认'
}

/** What an unresolved attempt means and what the app will (not) do about it. */
export const ATTEMPT_STATE_DETAIL: Record<'sending' | 'unknown' | 'unconfirmed', string> = {
  sending: '内容、目标和饼干已固定，不会因切换页面或更改默认饼干而改变。',
  unknown: '请求可能已经到达论坛，但没有得到确定结果。汐岛不会自动重发；请到目标串或版面核对是否已经发出。',
  unconfirmed: '论坛表示已发送，但未能确认这条发言的编号，因此没有记为自己的发言。内容保留用于核对，不会当作失败重发。'
}

/**
 * Why a send was refused or stopped; none of them retries or queues. Use this wording for refusals,
 * which happen before any intent is recorded, so `storage` there means nothing was sent.
 */
export const PROBLEM_TEXT: Record<PublicationProblem, string> = {
  storage: '本地存储不可用，无法先记录发送意图，所以没有发送',
  identity: '发言饼干不可用（未选择、已移除或无法读取），请重新选择',
  attachment: '附图的本地副本不可用，请重新添加或移除图片',
  target: '发言目标无效，或版面尚未知',
  empty: '没有可发送的内容',
  busy: '这块饼干有一次发送还没结束，请等它有结果后再手动发送（不会排队）',
  interval: '这块饼干在该版面的发言间隔太短，请稍后手动再发（不会排队或自动重试）',
  rejected: '论坛拒绝了这次发言',
  'rate-limited': '论坛限制了发言频率，已停止，不会自动重试',
  captcha: '论坛要求验证码，汐岛无法代为完成，已停止',
  network: '网络连接失败',
  response: '论坛的响应无法识别'
}

/**
 * Problem wording for a recorded attempt. Its intent was already durable before the request, so a
 * `storage` problem here means the result could not be saved after sending, not that nothing was sent.
 */
export const ATTEMPT_PROBLEM_TEXT: Record<PublicationProblem, string> = {
  ...PROBLEM_TEXT,
  storage: '本地存储没能保存发送结果，这次发言可能已经发出'
}
