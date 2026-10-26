import type {
  CheckRequestResult,
  CheckRound,
  CoverageIssue,
  ReminderCloseReason,
  ReminderKind,
  ReminderNotificationRecord,
  ReminderOverview,
  ReminderRule,
  ThreadCheckState,
  ThreadReminderGroup
} from '../../../../shared/reminders'
import { describeReadError, formatLocalTime } from '../../lib/format'

export const KIND_NAME: Record<ReminderKind, string> = {
  all: '全串更新',
  po: 'PO追更',
  quote: '引用我的发言'
}

/** Short form for chips and trigger labels. */
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

/** State and start of one rule, in words: never just a color. */
export function ruleStateText(rule: ReminderRule): string {
  if (rule.enabled) return rule.startedAt === null ? '已开启' : `已开启 · 起点 ${formatLocalTime(rule.startedAt)}`
  if (rule.startedAt === null) return '未开启'
  return `${rule.closedBy === null ? '已关闭' : CLOSED_BY[rule.closedBy]} · 上次起点 ${formatLocalTime(rule.startedAt)}`
}

export function enabledKinds(rules: Record<ReminderKind, ReminderRule>): ReminderKind[] {
  return (['all', 'po', 'quote'] as const).filter((kind) => rules[kind].enabled)
}

export const STATE_NAME: Record<ThreadCheckState, string> = {
  'baseline-pending': '待建立基线',
  checking: '检查中',
  done: '本轮已查到目标',
  incomplete: '尚未补完',
  failed: '读取失败',
  uncertain: '覆盖不确定'
}

export const ISSUE_TEXT: Record<CoverageIssue, string> = {
  shifted: '页面顺序有变化，已重新核对',
  gaps: '有页没有取得',
  'count-mismatch': '回复数与取得的不一致',
  'target-unverified': '没能确认最后一页',
  'boundary-uncertain': '部分回复无法确认是否在起点之后',
  'quote-unverified': '部分被引用的发言没能取得，无法确认是否引用了你'
}

/** Whether a thread's coverage leaves something unknown (never folded into the confirmed count). */
export function hasCoverageProblem(group: ThreadReminderGroup): boolean {
  return (
    group.state === 'incomplete' ||
    group.state === 'failed' ||
    group.state === 'uncertain' ||
    group.issues.length > 0 ||
    group.uncertainCount > 0
  )
}

export function overviewHasCoverageProblem(overview: ReminderOverview): boolean {
  return overview.threads.some(hasCoverageProblem)
}

/** The read failure behind a failed thread; the state name says the rest. */
export function stateDetail(group: ThreadReminderGroup): string {
  if (group.state !== 'failed' || group.lastError === null) return ''
  return `${describeReadError(group.lastError)}${group.lastError.serverMessage !== undefined ? `；论坛提示：${group.lastError.serverMessage}` : ''}`
}

/**
 * What "no confirmed reminder" means for this thread. Only a finished check without any coverage
 * issue may say the range was checked; anything else says the result is not complete.
 */
export function emptyText(group: ThreadReminderGroup): string {
  if (group.state === 'baseline-pending' || group.state === 'checking') return '还没有确认的提醒'
  if (group.lastCheckedAt === null) return '还没有检查过'
  if (!hasCoverageProblem(group)) return '已查完，没有新提醒'
  return '没有确认的新提醒，检查不完整'
}

/** Progress of the running round. */
export function progressText(round: CheckRound): string {
  const failed = round.threadsFailed > 0 ? `，失败 ${round.threadsFailed} 个` : ''
  return `正在检查：${round.threadsDone} / ${round.threadsTotal} 个串${failed}`
}

/** How the last round ended, in words. */
export function roundOutcomeText(round: CheckRound): string {
  let ended: string
  switch (round.state) {
    case 'running':
      ended = '仍在进行'
      break
    case 'finished':
      ended = '本轮结束'
      break
    case 'cancelled':
      ended = '已取消'
      break
    case 'interrupted':
      ended =
        round.stopReason === 'rate-limited'
          ? '被中断（限流或需要验证）'
          : round.stopReason === 'quit'
            ? '被中断（退出）'
            : round.stopReason === 'crash'
              ? '被中断（上次异常结束）'
              : round.stopReason === 'user'
                ? '已取消'
                : '被中断'
      break
  }
  const failed = round.threadsFailed > 0 ? `，失败 ${round.threadsFailed} 个` : ''
  return `上次检查${ended}：${round.threadsDone} / ${round.threadsTotal} 个串${failed}，新提醒 ${round.newEvents} 条`
}

const COVERAGE_TEXT: Record<ReminderNotificationRecord['coverage'], string> = {
  complete: '',
  partial: '（检查未完成）',
  interrupted: '（检查被中断）',
  'failed-some': '（部分串检查失败）'
}

/** The last notification attempt; never claims delivery unless the system reported it shown. */
export function notificationText(record: ReminderNotificationRecord): { text: string; warn: boolean } {
  const what = `${record.threadCount} 个串 ${record.eventCount} 条提醒（${formatLocalTime(record.registeredAt)}）`
  const coverage = COVERAGE_TEXT[record.coverage]
  switch (record.state) {
    case 'shown':
      return { text: `已通知：${what}${coverage}`, warn: false }
    case 'registered':
      return { text: `通知未确认显示：${what}${coverage}`, warn: true }
    case 'unavailable':
      return { text: `系统通知不可用：${what}${coverage}`, warn: true }
    case 'failed':
      return { text: `系统通知失败：${what}${coverage}`, warn: true }
    case 'unknown':
      return { text: `通知是否显示未知：${what}${coverage}`, warn: true }
  }
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
  return `约 ${Math.max(1, Math.ceil(ms / 1000))} 秒`
}
