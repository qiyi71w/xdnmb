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

export const KIND_HELP: Record<ReminderKind, string> = {
  all: '这个串里起点之后的新回复',
  po: '只看 PO 页里起点之后的新回复',
  quote: '明确引用你已确认的发言编号的回复'
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
  shifted: '页面顺序有变化，已从第 1 页重新核对',
  gaps: '目标范围内有页没有取得',
  'count-mismatch': '回复数与实际取得的不一致',
  'target-unverified': '没能确认最后一页，下次有效检查继续探测',
  'boundary-uncertain': '部分回复无法确认是否在提醒起点之后'
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

/** One line on the state of a thread, with the read failure reason when there is one. */
export function stateDetail(group: ThreadReminderGroup): string {
  switch (group.state) {
    case 'baseline-pending':
      return '还不能证明有回复晚于提醒起点；之后的检查会先建立基线'
    case 'checking':
      return '本轮检查正在读取这个串'
    case 'done':
      return '本轮已读到检查开始时固定的目标位置'
    case 'incomplete':
      return '本轮没有读到固定的目标位置，已确认的结果保留，下次有效检查继续'
    case 'failed':
      return group.lastError === null
        ? '本轮没能读取这个串，之前的结果保留，规则不变'
        : `${describeReadError(group.lastError)}${group.lastError.serverMessage !== undefined ? `；论坛提示：${group.lastError.serverMessage}` : ''}。之前的结果保留，规则不变`
    case 'uncertain':
      return '读到了目标位置，但覆盖有问题，可能有没确认的新内容'
  }
}

/**
 * What "no confirmed reminder" means for this thread. Only a finished check without any coverage
 * issue may say the range was checked; anything else says the result is not complete.
 */
export function emptyText(group: ThreadReminderGroup): string {
  if (group.state === 'baseline-pending') return '还没有建立基线，目前没有可确认的新提醒。'
  if (group.state === 'checking') return '正在检查，目前还没有确认的新提醒。'
  if (group.lastCheckedAt === null) return '还没有检查过，目前没有确认的新提醒。'
  if (!hasCoverageProblem(group)) return '本轮已查到目标位置，没有确认的新提醒。'
  return '目前没有确认的新提醒；检查不完整，这不代表没有新内容。'
}

/** Progress of the running round. */
export function progressText(round: CheckRound): string {
  const failed = round.threadsFailed > 0 ? `，失败 ${round.threadsFailed} 个` : ''
  return `正在检查：已处理 ${round.threadsDone} / ${round.threadsTotal} 个串${failed}`
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
  return `上次检查（${formatLocalTime(round.startedAt)} 开始）${ended}：已处理 ${round.threadsDone} / ${round.threadsTotal} 个串${failed}，新提醒 ${round.newEvents} 条`
}

const COVERAGE_TEXT: Record<ReminderNotificationRecord['coverage'], string> = {
  complete: '',
  partial: '；那一轮检查未完成，通知只含已确认的命中',
  interrupted: '；那一轮检查被中断，通知只含已确认的命中',
  'failed-some': '；部分串检查失败，通知的数量不是全部新增'
}

/** The last notification attempt; never claims delivery unless the system reported it shown. */
export function notificationText(record: ReminderNotificationRecord): { text: string; warn: boolean } {
  const what = `${record.threadCount} 个串 ${record.eventCount} 条提醒（${formatLocalTime(record.registeredAt)}）`
  const coverage = COVERAGE_TEXT[record.coverage]
  switch (record.state) {
    case 'shown':
      return { text: `已显示系统通知：${what}${coverage}`, warn: false }
    case 'registered':
      return { text: `已登记通知，尚未确认系统是否显示：${what}${coverage}`, warn: true }
    case 'unavailable':
      return { text: `系统通知不可用，结果只在此列表：${what}${coverage}`, warn: true }
    case 'failed':
      return { text: `系统通知发送失败，结果只在此列表：${what}${coverage}`, warn: true }
    case 'unknown':
      return { text: `应用在通知尝试完成前结束，系统通知是否显示未知，结果只在此列表：${what}${coverage}`, warn: true }
  }
}

/** Why a manual check did not start. No automatic retry follows. */
export function refusalText(result: Extract<CheckRequestResult, { accepted: false }>): string {
  switch (result.reason) {
    case 'running':
      return '已有检查正在进行，没有重复开始'
    case 'cooldown':
      return `距上次检查开始不足 60 秒，没有开始；${secondsText(result.retryAfterMs)}后可以再次检查，不会自动重试`
    case 'storage':
      return '本地存储不可用，没有开始检查'
  }
}

export function secondsText(ms: number): string {
  return `约 ${Math.max(1, Math.ceil(ms / 1000))} 秒`
}
