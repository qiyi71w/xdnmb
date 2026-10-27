import type { PublicationState } from '../../../../shared/publication'
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
 * A send whose connection broke after the request reached the forum, and that the read-only check
 * could not find: it may have gone out all the same. A new thread is looked for in its forum (版面),
 * a reply in its thread (串).
 */
export function unverifiedText(kind: SentKind): string {
  const place = kind === 'thread' ? '版面' : '串'
  return `可能已经发出：发送后连接中断，汐岛没在${place}里找到这条，内容已存为草稿。重发前先到${place}里看一眼。`
}
