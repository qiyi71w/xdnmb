import { useEffect, useId, useMemo, useState } from 'react'
import type { ThreadId } from '../../../../shared/forum'
import type { SubscriptionObservation, SubscriptionOperation } from '../../../../shared/subscriptions'
import { Icon, Spinner } from '../../components/Icon'
import { SUBSCRIPTION_OBSERVED_EVENT } from '../subscriptions/SubscriptionPane'
import { decideChange, selectionKey, sourceObjectRef } from '../subscriptions/subscriptionListState'
import { SOURCE_NAME, failureText, needsReconcile } from '../subscriptions/subscriptionText'
import { useSubscriptionsContext } from '../subscriptions/useSubscriptions'

/** The thread toolbar's borderless button with a collapsible label. */
const BUTTON = 'btn tb-btn subscribe-btn'

type Membership =
  | { kind: 'loading' }
  | { kind: 'in' }
  | { kind: 'out' }
  /** A write of this thread is running in this window. */
  | { kind: 'pending'; action: 'add' | 'remove' }
  /** The latest write's result is not settled: only the read-only 核对 is offered. */
  | { kind: 'unknown'; operation: SubscriptionOperation }

/**
 * Whether the thread is in the viewed source's subscriptions, from the newest evidence: the
 * running write, the latest journal entry for this thread and remote collection, or the stored
 * list observation. A rejected write is no evidence either way.
 */
function membershipOf(
  threadId: ThreadId,
  observation: SubscriptionObservation | null | undefined,
  operation: SubscriptionOperation | undefined
): Membership {
  const observedAt = observation?.startedAt ?? ''
  if (operation !== undefined && operation.report !== 'rejected' && operation.createdAt >= observedAt) {
    if (operation.state !== 'settled' || needsReconcile(operation)) return { kind: 'unknown', operation }
    if (operation.verification === 'present') return { kind: 'in' }
    if (operation.verification === 'absent-supported') return { kind: 'out' }
  }
  if (observation === undefined) return { kind: 'loading' }
  return observation?.ids.includes(threadId) === true ? { kind: 'in' } : { kind: 'out' }
}

/**
 * 订阅／已订阅 in the thread toolbar: a press writes once at once (`decideChange`), never retried and
 * without confirmation; an unsettled result turns the button into the read-only 核对订阅.
 */
export function SubscribeButton({ threadId, label }: { threadId: ThreadId; label: string }) {
  const { overview, operations, active, busy, change, reconcile } = useSubscriptionsContext()
  const reasonId = useId()

  const source = overview?.source ?? null
  const selection = overview === null ? null : selectionKey(overview)
  const objectRef = overview === null ? null : sourceObjectRef(overview.context, overview.source)

  /** Stored observation of the viewed source; `undefined` until read. */
  const [observation, setObservation] = useState<SubscriptionObservation | null | undefined>(undefined)
  useEffect(() => {
    if (source === null) return
    let alive = true
    const load = () => {
      window.xidao.subscriptions.getObservation({ source }).then(
        (next) => {
          if (alive) setObservation(next)
        },
        () => {
          if (alive) setObservation(null)
        }
      )
    }
    load()
    window.addEventListener(SUBSCRIPTION_OBSERVED_EVENT, load)
    return () => {
      alive = false
      window.removeEventListener(SUBSCRIPTION_OBSERVED_EVENT, load)
    }
    // A write's readback stores a new observation: read again whenever the journal changes.
  }, [source, selection, operations])

  const operation = useMemo(
    () =>
      source === null
        ? undefined
        : operations?.find(
            (item) => item.threadId === threadId && item.source === source && sourceObjectRef(item.context, item.source) === objectRef
          ),
    [operations, threadId, source, objectRef]
  )

  const writing = active !== null && active.kind === 'change' && active.threadId === threadId && active.source === source ? active : null
  const membership: Membership = writing !== null ? { kind: 'pending', action: writing.action } : membershipOf(threadId, observation, operation)
  const reconciling = active !== null && active.kind === 'reconcile' && active.threadId === threadId && active.source === source

  if (overview === null) return null

  if (membership.kind === 'pending' || reconciling) {
    const text = reconciling ? '核对中…' : membership.kind === 'pending' && membership.action === 'remove' ? '取消中…' : '订阅中…'
    // The press turns this same button pending: aria-disabled keeps the focus on it.
    return (
      <button type="button" className={BUTTON} aria-disabled aria-busy="true" title={text}>
        <Spinner />
        <span className="btn-label">{text}</span>
      </button>
    )
  }

  if (membership.kind === 'unknown') {
    return (
      <button
        type="button"
        className={`${BUTTON} is-warning`}
        aria-disabled={busy || undefined}
        title="核对订阅"
        onClick={() => {
          if (!busy) void reconcile(membership.operation)
        }}
      >
        <Icon name="alert" />
        <span className="btn-label">核对订阅</span>
      </button>
    )
  }

  const subscribed = membership.kind === 'in'

  const decision = decideChange({
    overview,
    operations,
    busy,
    action: subscribed ? 'remove' : 'add',
    threadId,
    label,
    unresolved: '这个串的上次操作待核对'
  })
  const blockedReason = decision.kind === 'blocked' ? decision.reason : null
  const text = subscribed ? '已订阅' : '订阅'
  return (
    <button
      type="button"
      className={subscribed ? `${BUTTON} is-on` : BUTTON}
      aria-pressed={subscribed}
      aria-disabled={membership.kind === 'loading' || blockedReason !== null || undefined}
      aria-describedby={blockedReason !== null ? reasonId : undefined}
      title={blockedReason ?? `${SOURCE_NAME[overview.source]}：${subscribed ? '取消订阅' : '订阅'}`}
      onClick={() => {
        if (membership.kind !== 'loading' && decision.kind === 'write') void change(decision.request)
      }}
    >
      <Icon name={subscribed ? 'check' : 'bookmark'} />
      <span className="btn-label">{text}</span>
      {blockedReason !== null && (
        <span id={reasonId} className="visually-hidden">
          {blockedReason}
        </span>
      )}
    </button>
  )
}

/**
 * One line for the last write of this thread made anywhere in the app; nothing once it is dismissed.
 * A confirmed result is the button itself (已订阅／订阅); only failures and unknown outcomes leave a
 * line, whose 核对 is the button's 核对订阅.
 */
export function SubscribeNote({ threadId }: { threadId: ThreadId }) {
  const { lastWrite, active, dismissLastWrite } = useSubscriptionsContext()
  if (active !== null || lastWrite === null || lastWrite.write.threadId !== threadId) return null
  const { write, outcome } = lastWrite
  const what = write.kind === 'change' ? (write.action === 'add' ? '订阅' : '取消订阅') : '核对'
  let text: string
  switch (outcome.type) {
    case 'done':
      if (outcome.operation.reportError?.kind === 'rate-limited') text = `${what}结果未确认：限流或需要验证`
      else if (needsReconcile(outcome.operation)) text = `${what}结果未确认`
      else return null
      break
    case 'refused':
      text = outcome.reason === 'result-storage' ? `${what}结果未知` : `${what}未执行：${failureText(outcome.reason)}`
      break
    case 'failed':
      text = write.kind === 'change' ? `${what}结果未知` : '核对请求失败'
      break
  }
  return (
    <span className="subscribe-note toolbar-warning">
      <Icon name="alert" size={14} />
      {text}
      <button type="button" className="icon-btn subscribe-note-close" onClick={dismissLastWrite} aria-label="关闭这条结果">
        <Icon name="close" size={12} />
      </button>
    </span>
  )
}
