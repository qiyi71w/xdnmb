import type { ThreadSummary } from '../../../../shared/forum'
import type {
  SubscriptionAction,
  SubscriptionContext,
  SubscriptionFailure,
  SubscriptionObservation,
  SubscriptionOperation,
  SubscriptionOverview,
  SubscriptionPlan,
  SubscriptionPlanItem,
  SubscriptionSource
} from '../../../../shared/subscriptions'
import { describeReadError, formatLocalTime, formatPageList, meaningfulTitle } from '../../lib/format'

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

/** Identity combination behind a source: App local reference or the fixed web sync object. */
export function contextText(context: SubscriptionContext, source: SubscriptionSource): string {
  const ref =
    source === 'app'
      ? context.appCredentialId === null
        ? 'App UUID 未设置'
        : `App UUID 本机引用 #${context.appCredentialId}`
      : context.webCredentialId === null
        ? '网页同步对象未绑定'
        : `网页同步对象 #${context.webCredentialId}`
  return `${ref} · 配置代次 ${context.generation}`
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
      return '网页同步对象已移除，需要重新选择；不会自动改用其他饼干'
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
      return '订阅配置已变化，未按旧配置执行，请重新确认'
    case 'busy':
      return '另一项订阅操作正在进行，或这个串还有待核对的操作，未执行'
    case 'not-found':
      return '找不到这条记录'
    case 'invalid-selection':
      return '所选条目不属于这份预览，或有重复，未执行；请重新预览后再勾选'
    case 'cancelled':
      return '已按要求停止，之后的读取与步骤没有继续'
  }
}

function reportText(operation: SubscriptionOperation): string {
  switch (operation.report) {
    case 'pending':
      return '尚未收到服务端报告'
    case 'success':
      return '服务端报告成功（不代表集合一定发生了变化）'
    case 'rejected':
      return '服务端拒绝了这次请求'
    case 'unknown':
      return '没有取得服务端报告，请求可能已经生效'
  }
}

/** Report plus its error classification (e.g. 限流或需要验证), so a stopped result never hides why. */
export function reportSummary(operation: SubscriptionOperation): string {
  const reason = operation.reportError === null ? '' : `（${describeReadError(operation.reportError)}）`
  return `${reportText(operation)}${reason}`
}

export function verificationText(operation: SubscriptionOperation): string {
  switch (operation.verification) {
    case 'present':
      return '回读看到这个串在订阅中'
    case 'absent-supported':
      return '回读从第 1 页连续读到结束候选都没有这个串，且有原有效观察与成功报告为依据'
    case 'absent-unproven':
      return '回读没有找到这个串，但依据不足，不能证明它已不在订阅中'
    case 'mismatch':
      return '回读结果与服务端报告不一致'
    case 'unknown':
      return '尚未取得可用的回读'
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

/** One-line page coverage of an observation, e.g. `第 1–3 页 · 10/24 09:12 · 第 3 页为空（结束候选）`. */
export function coverageText(observation: SubscriptionObservation): string {
  const pages = observation.pages
  if (pages.length === 0) return '还没有取得任何一页'
  const parts = [`已读取第 ${formatPageList(pages.map((page) => page.page))} 页`]
  const last = pages.at(-1)
  if (last !== undefined) parts.push(`${formatLocalTime(last.fetchedAt)} 获取`)
  const end = pages.find((page) => page.endCandidate)
  if (end !== undefined) parts.push(`第 ${end.page} 页为空（结束候选）`)
  else if (observation.nextPage !== null) parts.push(`第 ${observation.nextPage} 页起未读取`)
  return parts.join(' · ')
}

/** Short evidence line for a journal entry's before/after observation. */
export function evidenceText(observation: SubscriptionObservation | null): string {
  if (observation === null) return '无'
  const base = coverageText(observation)
  if (observation.error !== null) return `${base} · 第 ${observation.error.page} 页读取失败`
  if (observation.cancelled) return `${base} · 已取消`
  return base
}

/** One observation's state for a preview: how far it got and why it may be incomplete. */
export function observationState(observation: SubscriptionObservation): { complete: boolean; text: string } {
  if (observation.error !== null) {
    return { complete: false, text: `第 ${observation.error.page} 页读取失败（${describeReadError(observation.error.detail)}），之后的页没有读取` }
  }
  if (observation.cancelled) return { complete: false, text: `已停止，第 ${observation.nextPage ?? ''} 页起没有读取` }
  if (observation.nextPage !== null) return { complete: false, text: `第 ${observation.nextPage} 页起没有读取` }
  return { complete: true, text: '已连续读到空页（结束候选）；读取期间远端仍可能变化' }
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
      return plan.state === 'interrupted' ? '应用在执行过程中关闭，计划没有继续，也不会在启动时自动继续' : null
    case 'item-failed':
      return '有一项失败，已停止后续写入'
    case 'item-unknown':
      return '有一项结果无法确认，已停止后续写入'
    case 'cancelled':
      return '按你的要求停止了后续步骤；已经发出的写入不会撤回'
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
