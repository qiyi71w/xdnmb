import {
  REMINDER_KINDS,
  type CheckRequestResult,
  type CoverageIssue,
  type ReminderKind,
  type ReminderRule,
  type ReminderThreadRow
} from '../../../../shared/reminders'
import { describeReadError } from '../../lib/format'
import { formatClockTime } from '../../lib/time'

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

/**
 * Issues meaning the latest check could not finish reading the thread, its count or the quote pages
 * the baseline needs (`incomplete`): a pending baseline stays pending until a later check.
 */
const UNFINISHED_ISSUES: readonly CoverageIssue[] = ['read-failed', 'not-found', 'rate-limited', 'count-invalid', 'incomplete']

/** Enabled kinds still waiting for their 提醒基线, and whether the thread's latest check left it unfinished. */
export interface BaselineState {
  kinds: ReminderKind[]
  failed: boolean
}

/**
 * The baseline state of a thread's rules, or null when every enabled kind is counting. `issues`:
 * the thread's coverage issues, null where only the rules are known (never reported as failed).
 * Main schedules the reading; nothing here starts a check.
 */
export function baselineState(rules: Record<ReminderKind, ReminderRule>, issues: readonly CoverageIssue[] | null): BaselineState | null {
  const kinds = REMINDER_KINDS.filter((kind) => rules[kind].enabled && rules[kind].baseline === 'pending')
  if (kinds.length === 0) return null
  return { kinds, failed: issues !== null && issues.some((issue) => UNFINISHED_ISSUES.includes(issue)) }
}

/** End of a 提醒 row's meta: `全串、PO等待建立基线`, or `全串、PO基线未建立` after an unfinished read. */
export function baselineRowText(state: BaselineState): string {
  const kinds = state.kinds.map((kind) => KIND_SHORT[kind]).join('、')
  return state.failed ? `${kinds}基线未建立` : `${kinds}等待建立基线`
}

/** Added to a row's issue reasons while a baseline its latest check left unfinished is still pending. */
export const BASELINE_RETRY_TEXT = '下次检查时重试建立基线'

/**
 * A thread's 提醒 menu: which kinds are not counting yet and, after an unfinished read, why (`reasons`,
 * the row's `issuesText`).
 */
export function baselineMenuText(state: BaselineState, reasons: string | null): string {
  const kinds = state.kinds.map((kind) => KIND_NAME[kind]).join('、')
  if (!state.failed) return `${kinds}等待建立基线，建立后的新回复才计数`
  return reasons === null ? `${kinds}基线未建立，下次检查时重试` : `${kinds}基线未建立（${reasons}），下次检查时重试`
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

/** Start of every 论坛限流 message; `rateLimitRetry` gives the rest. */
export const RATE_LIMIT_TEXT = '论坛限流，提醒检查已暂停'

/**
 * When checking resumes during a rate-limit episode: `HH:MM 后重试` at the automatic retry, or
 * 自动检查已关闭 when none comes because the timer is off; null when neither is known.
 */
export function rateLimitRetry(retryAt: string | null, autoOff: boolean): string | null {
  if (retryAt !== null) return `${formatClockTime(retryAt)} 后重试`
  return autoOff ? '自动检查已关闭' : null
}
