import type { PublicationState } from '../../../../shared/publication'

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
