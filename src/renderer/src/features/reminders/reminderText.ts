import {
  REMINDER_KINDS,
  type CheckRequestResult,
  type CoverageIssue,
  type ReminderCloseReason,
  type ReminderKind,
  type ReminderRule,
  type ReminderThreadRow
} from '../../../../shared/reminders'
import { describeReadError } from '../../lib/format'

export const KIND_NAME: Record<ReminderKind, string> = {
  all: '全串更新',
  po: 'PO追更',
  quote: '引用我的发言'
}

/** Short form for counts and trigger labels. */
export const KIND_SHORT: Record<ReminderKind, string> = {
  all: '全串',
  po: 'PO',
  quote: '引用'
}

const CLOSED_BY: Record<ReminderCloseReason, string> = {
  user: '已关闭',
  unsubscribe: '取消订阅时关闭',
  'sync-delete': '同步删除时关闭'
}

/** State of one rule, in words: never just a color. */
export function ruleStateText(rule: ReminderRule): string {
  if (rule.enabled) return '已开启'
  return rule.closedBy === null ? '未开启' : CLOSED_BY[rule.closedBy]
}

export function enabledKinds(rules: Record<ReminderKind, ReminderRule>): ReminderKind[] {
  return REMINDER_KINDS.filter((kind) => rules[kind].enabled)
}

/** `全串:3 PO:2 引用:1`: enabled, non-zero kinds in the fixed order; null when nothing is counted. */
export function countsText(row: Pick<ReminderThreadRow, 'rules' | 'counts'>): string | null {
  const parts = REMINDER_KINDS.filter((kind) => row.rules[kind].enabled && row.counts[kind] > 0).map(
    (kind) => `${KIND_SHORT[kind]}:${row.counts[kind]}`
  )
  return parts.length === 0 ? null : parts.join(' ')
}

/** Whether any kind of the row has a count (清除提醒 has something to clear). */
export function hasCounts(row: Pick<ReminderThreadRow, 'counts'>): boolean {
  return REMINDER_KINDS.some((kind) => row.counts[kind] > 0)
}

/** Fixed order of the reasons on a row's warning. */
const ISSUE_ORDER: readonly CoverageIssue[] = [
  'read-failed',
  'not-found',
  'rate-limited',
  'incomplete',
  'count-decreased',
  'count-invalid',
  'quote-unverified'
]

/**
 * Why a row's reminders may be missing something (覆盖问题), in words, or null when nothing is.
 * The forum's own message of the failed read is added once.
 */
export function issuesText(row: Pick<ReminderThreadRow, 'issues' | 'lastError' | 'unverifiedQuotes'>): string | null {
  if (row.issues.length === 0) return null
  const parts = ISSUE_ORDER.filter((issue) => row.issues.includes(issue)).map((issue) => {
    switch (issue) {
      case 'read-failed':
        return row.lastError === null ? '读取失败' : `读取失败：${describeReadError(row.lastError)}`
      case 'not-found':
        return '串不存在'
      case 'rate-limited':
        return '论坛限流，本次检查中断'
      case 'incomplete':
        return '引用尚未补完，下次检查接续'
      case 'count-decreased':
        return '回复数变小，已重设基线'
      case 'count-invalid':
        return '回复数缺失或异常'
      case 'quote-unverified':
        return row.unverifiedQuotes > 0 ? `${row.unverifiedQuotes} 条回复引用的发言未能核实` : '部分回复引用的发言未能核实'
    }
  })
  const serverMessage = row.lastError?.serverMessage
  if (serverMessage !== undefined && serverMessage !== '') parts.push(`论坛提示：${serverMessage}`)
  return parts.join('；')
}

/** Why a manual check did not start. No automatic retry follows. */
export function refusalText(result: Extract<CheckRequestResult, { accepted: false }>): string {
  switch (result.reason) {
    case 'running':
      return '已有检查正在进行'
    case 'cooldown':
      return `${secondsText(result.retryAfterMs)}后可再次检查`
    case 'storage':
      return '本地存储不可用，没有开始检查'
  }
}

export function secondsText(ms: number): string {
  return `${Math.max(1, Math.ceil(ms / 1000))} 秒`
}
