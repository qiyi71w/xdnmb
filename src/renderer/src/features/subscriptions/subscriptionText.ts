import type { ThreadSummary } from '../../../../shared/forum'
import type {
  SubscriptionAction,
  SubscriptionFailure,
  SubscriptionObservation,
  SubscriptionOperation,
  SubscriptionOverview,
  SubscriptionPlan,
  SubscriptionPlanItem,
  SubscriptionSource
} from '../../../../shared/subscriptions'
import { completeSubscriptionObservation } from '../../../../shared/subscriptions'
import { describeReadError, meaningfulTitle } from '../../lib/format'
import { formatClockTime } from '../../lib/time'

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
      return 'UUID 格式无效，未更改'
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
