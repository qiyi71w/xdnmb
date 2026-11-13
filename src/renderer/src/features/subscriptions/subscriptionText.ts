import type { ThreadSummary } from '../../../../shared/forum'
import type {
  SubscriptionAction,
  SubscriptionFailure,
  SubscriptionObservation,
  SubscriptionOperation,
  SubscriptionOverview,
  SubscriptionPlan,
  SubscriptionPlanItem,
  SubscriptionRemovalItem,
  SubscriptionRemovalStop,
  SubscriptionSource,
  SubscriptionArrangement
} from '../../../../shared/subscriptions'
import { completeSubscriptionObservation, MAX_APP_UUID_LENGTH } from '../../../../shared/subscriptions'
import { describeReadError, meaningfulTitle } from '../../lib/format'
import { formatClockTime } from '../../lib/time'
import type { ArrangementNote } from './subscriptionListState'
import type { RemovalOutcome } from './useSubscriptions'

// Fixed copy only. Nothing here ever includes a UUID, a userhash or any other secret: the
// renderer only knows local references, names and generations.

export const SOURCE_NAME: Record<SubscriptionSource, string> = {
  app: 'App 订阅',
  web: '网页订阅'
}

export const SOURCE_SHORT: Record<SubscriptionSource, string> = {
  app: 'App',
  web: '网页'
}

/** The 更多 menu's order choices, in menu order. */
export const ARRANGEMENT_NAME: Record<SubscriptionArrangement, string> = {
  remote: '按订阅顺序排列',
  app: '按 App 顺序排列',
  web: '按网页顺序排列'
}

const ARRANGEMENT_WAITING: Record<SubscriptionSource, string> = {
  app: '读完 App 订阅后按 App 顺序排列',
  web: '读完网页订阅后按网页顺序排列'
}

/** The line above a list shown in another side's order, or waiting for that side to be read to the end. */
export function arrangementNoteText(note: ArrangementNote): string {
  return note.kind === 'arranged' ? ARRANGEMENT_NAME[note.base] : ARRANGEMENT_WAITING[note.base]
}

export const ACTION_NAME: Record<SubscriptionAction, string> = {
  add: '加入订阅',
  remove: '取消订阅'
}

/** Short human name of a thread for confirmations and records: its title, else an excerpt. */
export function threadLabel(thread: ThreadSummary): string {
  const title = meaningfulTitle(thread.head.title)
  if (title !== null) return title
  const excerpt = thread.head.plainText.replace(/\s+/g, ' ').trim()
  return excerpt === '' ? `No.${thread.head.id}` : excerpt.slice(0, 30)
}

/** Fixed web sync object as the user named it; never the cookie itself. */
export function webObjectText(overview: SubscriptionOverview): string {
  switch (overview.webSelection.state) {
    case 'none':
      return '未绑定'
    case 'missing':
      return '已移除，需要重新选择'
    case 'selected':
      return overview.webName === null ? `#${overview.webSelection.credentialId}` : `「${overview.webName}」`
  }
}

/** Why the source cannot be read or written right now; null when nothing local blocks it. */
export function sourceBlocker(overview: SubscriptionOverview, source: SubscriptionSource): string | null {
  if (overview.protection === 'unavailable') return '系统凭据保护不可用，订阅身份暂时无法使用'
  if (source === 'app') return overview.appConfigured ? null : '尚未设置 App 订阅 UUID'
  switch (overview.webSelection.state) {
    case 'none':
      return '尚未绑定网页同步对象'
    case 'missing':
      return '网页同步对象已移除，需要重新选择'
    case 'selected':
      return null
  }
}

export function failureText(reason: SubscriptionFailure): string {
  switch (reason) {
    case 'storage':
      return '本地存储不可用，未执行'
    case 'result-storage':
      return '写入可能已经发出，但本地未能保存结果'
    case 'locked':
      return '系统凭据保护不可用或无法解密，未执行'
    case 'unconfigured':
      return '订阅身份尚未设置（App UUID 或网页同步对象），未执行'
    case 'missing':
      return '网页同步对象已移除，需要在设置中重新选择，未执行'
    case 'invalid-uuid':
      return `UUID 需为 1–${MAX_APP_UUID_LENGTH} 个字符，未更改`
    case 'stale':
      return '订阅配置已变化，未执行'
    case 'busy':
      return '另一项订阅操作正在进行，或这个串的上次操作待核对，未执行'
    case 'not-found':
      return '找不到这条记录'
    case 'invalid-selection':
      return '所选条目不属于这份预览，未执行'
    case 'cancelled':
      return '已停止'
  }
}

/** Whether a journal entry should offer the read-only 核对. */
export function needsReconcile(operation: SubscriptionOperation): boolean {
  return (
    operation.state === 'needs-reconciliation' ||
    operation.verification === 'unknown' ||
    operation.verification === 'mismatch' ||
    operation.verification === 'absent-unproven'
  )
}

/**
 * What the latest readback or 核对 of a write saw, with when it started; null before any. A read
 * that stopped early without the thread says so: it is not evidence of absence.
 */
export function readbackText(operation: SubscriptionOperation): string | null {
  const after = operation.after
  if (after === null) return null
  const at = `（${formatClockTime(after.startedAt)}）`
  if (after.ids.includes(operation.threadId)) return `回读看到这个串在订阅中${at}`
  if (after.error !== null) return `回读第 ${after.error.page} 页失败：${describeReadError(after.error.detail)}${at}`
  if (after.cancelled) return `回读已停止，已读的页中没有这个串${at}`
  if (!completeSubscriptionObservation(after)) return `回读未读完，已读的页中没有这个串${at}`
  return `回读读完整份订阅，没有这个串${at}`
}

/** Why closing (×) an unresolved entry was not saved; it and its protection stay. */
export function dismissFailureText(reason: SubscriptionFailure | 'internal'): string {
  if (reason === 'busy') return '关闭未保存：另一项订阅操作正在进行，提示保留'
  return `关闭未保存：${reason === 'internal' ? '应用内部请求失败' : failureText(reason)}，提示保留`
}

function reportText(operation: SubscriptionOperation): string {
  switch (operation.report) {
    case 'pending':
      return '尚未收到服务端报告'
    case 'success':
      return '服务端报告成功'
    case 'rejected':
      return '服务端拒绝了这次请求'
    case 'unknown':
      return '没有取得服务端报告，请求可能已经生效'
  }
}

/** What the server said about one write, kept apart from what the readback observed. */
export function reportSummary(operation: SubscriptionOperation): string {
  const reason = operation.reportError === null ? '' : `（${describeReadError(operation.reportError)}）`
  return `${reportText(operation)}${reason}`
}

export function verificationText(operation: SubscriptionOperation): string {
  switch (operation.verification) {
    case 'present':
      return '回读看到这个串在订阅中'
    case 'absent-supported':
      return '回读从第 1 页读到结束候选都没有这个串'
    case 'absent-unproven':
      return '回读没有找到这个串，但不能证明它已不在订阅中'
    case 'mismatch':
      return '回读结果与服务端报告不一致'
    case 'unknown':
      return '尚未取得可用的回读'
  }
}

/** One observation's state for a preview: how far it got and why it may be incomplete. */
export function observationState(observation: SubscriptionObservation): { complete: boolean; text: string } {
  if (observation.error !== null) {
    return { complete: false, text: `第 ${observation.error.page} 页读取失败（${describeReadError(observation.error.detail)}），之后的页没有读取` }
  }
  if (observation.cancelled) return { complete: false, text: `已停止，第 ${observation.nextPage ?? ''} 页起没有读取` }
  if (observation.nextPage !== null) return { complete: false, text: `第 ${observation.nextPage} 页起没有读取` }
  return { complete: true, text: '已读到空页（结束候选）' }
}

export const PLAN_STATE_TEXT: Record<SubscriptionPlan['state'], string> = {
  running: '执行中',
  completed: '已完成',
  stopped: '已停止',
  interrupted: '已中断'
}

/** Why a plan stopped early; null when it did not. */
export function stopReasonText(plan: SubscriptionPlan): string | null {
  switch (plan.stopReason) {
    case null:
      return plan.state === 'interrupted' ? '应用在执行中关闭' : null
    case 'item-failed':
      return '有一项失败，已停止后续写入'
    case 'item-unknown':
      return '有一项结果无法确认，已停止后续写入'
    case 'cancelled':
      return '已停止后续步骤'
    default:
      return failureText(plan.stopReason)
  }
}

/** The 批量取消订阅 confirmation: which collection loses how many threads; the web one by its object's name. */
export function removalConfirmTitle(source: SubscriptionSource, webName: string | null, count: number): string {
  if (source === 'app') return `从 App 订阅取消 ${count} 个串？`
  return `从${webName === null ? '网页订阅' : `网页订阅（${webName}）`}取消 ${count} 个串？`
}

/** Why a 批量取消订阅 stopped, said after the item it stopped at when there is one. */
const REMOVAL_STOP: Record<SubscriptionRemovalStop, string> = {
  'item-failed': '没有取消成功，已停止',
  'item-unknown': '结果不明，已停止',
  'rate-limited': '被限流，已停止',
  cancelled: '已停止',
  stale: '订阅配置已变化，已停止',
  storage: '本地存储不可用，已停止',
  'result-storage': '本地未能保存结果，已停止'
}

/**
 * The one line above the list after a 批量取消订阅: how many were removed, where and why it stopped,
 * what is left unknown or failed, and how many were never sent (those stay ticked).
 */
export function removalSummary(outcome: RemovalOutcome): { tone: 'done' | 'warn' | 'error'; text: string } {
  if (outcome.type === 'failed') return { tone: 'warn', text: '取消订阅的结果不明' }
  if (outcome.type === 'refused') {
    return { tone: 'error', text: outcome.reason === 'cancelled' ? '没有取消：已在发出前停止' : `没有取消：${failureText(outcome.reason)}` }
  }
  const { items, stopReason } = outcome.removal
  const count = (kind: SubscriptionRemovalItem['outcome']) => items.filter((item) => item.outcome === kind).length
  // The item it stopped at is the last one sent. Its result is said with it (第 5 个结果不明) instead of
  // in the counts, except after a rate limit, which says why it stopped but not what came of the item.
  const at = stopReason === 'item-failed' || stopReason === 'item-unknown' || stopReason === 'rate-limited'
    ? items.findLastIndex((item) => item.outcome !== 'skipped')
    : -1
  const stopped = at === -1 || stopReason === 'rate-limited' ? null : items[at]!.outcome
  const confirmed = count('confirmed')
  const unknown = count('unknown') - (stopped === 'unknown' ? 1 : 0)
  const failed = count('failed') - (stopped === 'failed' ? 1 : 0)
  const skipped = count('skipped')
  const rest = [
    stopReason === null ? null : at === -1 ? REMOVAL_STOP[stopReason] : `第 ${at + 1} 个${REMOVAL_STOP[stopReason]}`,
    unknown > 0 ? `${unknown} 个结果不明` : null,
    failed > 0 ? `${failed} 个没有取消成功` : null,
    skipped > 0 ? `其余 ${skipped} 个未执行` : null
  ].filter((part) => part !== null)
  const text = `${confirmed > 0 ? `已取消 ${confirmed} 个。` : ''}${rest.length > 0 ? `${rest.join('；')}。` : ''}`
  return { tone: confirmed === items.length ? 'done' : count('failed') > 0 ? 'error' : 'warn', text }
}

/** State of one plan item; `current` marks the item a running plan is working on. */
export function planItemText(item: SubscriptionPlanItem, current: boolean): { text: string; tone: 'done' | 'warn' | 'error' | 'idle' } {
  switch (item.state) {
    case 'pending':
      return current ? { text: '进行中', tone: 'idle' } : { text: '未开始', tone: 'idle' }
    case 'confirmed':
      return { text: '已确认', tone: 'done' }
    case 'failed':
      return { text: item.failure === null ? '失败' : `失败：${failureText(item.failure)}`, tone: 'error' }
    case 'unknown':
      return { text: '无法确认：写入可能已生效', tone: 'warn' }
    case 'skipped':
      return { text: '未执行（计划已停止）', tone: 'idle' }
  }
}
