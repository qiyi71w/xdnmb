import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ThreadId } from '../../../../shared/forum'
import type { SubscriptionObservation, SubscriptionOperation } from '../../../../shared/subscriptions'
import { Icon, Spinner } from '../../components/Icon'
import { useSettingsOpener } from '../../lib/settingsOpener'
import { usePopover } from '../../lib/usePopover'
import { askedThreads, useReminderAsk, type ReminderChoice } from '../reminders/ReminderLinkage'
import { ChangeConfirm, changeDraft, SUBSCRIPTION_OBSERVED_EVENT, type ChangeDraft } from '../subscriptions/SubscriptionPane'
import { blocksNewWrite, selectionKey, sourceObjectRef } from '../subscriptions/subscriptionListState'
import { SOURCE_NAME, failureText, needsReconcile, sourceBlocker } from '../subscriptions/subscriptionText'
import { useSubscriptionsContext } from '../subscriptions/useSubscriptions'

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
 * 订阅／已订阅 in the thread toolbar. A press opens the same confirmation as the subscription list
 * (one explicit write, never retried); an unsettled result offers only the read-only 核对.
 */
export function SubscribeButton({
  threadId,
  label,
  onOpenChange
}: {
  threadId: ThreadId
  label: string
  /** The confirmation opened or closed (it covers posts: the reader stops judging reading). */
  onOpenChange: (open: boolean) => void
}) {
  const { overview, operations, active, busy, change, reconcile } = useSubscriptionsContext()
  const openSettings = useSettingsOpener()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const popover = usePopover(triggerRef, panelRef)
  const panelId = useId()

  const report = useRef(onOpenChange)
  useEffect(() => {
    report.current = onOpenChange
  })
  useEffect(() => {
    report.current(popover.open)
  }, [popover.open])
  useEffect(() => () => report.current(false), [])

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

  /** Frozen when the confirmation opens; a later source switch makes it stale instead. */
  const [draft, setDraft] = useState<ChangeDraft | null>(null)
  const [reminderChoice, setReminderChoice] = useState<ReminderChoice>('keep')
  const reminderAsk = useReminderAsk(popover.open && draft?.action === 'remove' ? [threadId] : null)
  const toggle = () => {
    if (!popover.open) {
      setDraft(changeDraft(overview, membership.kind === 'in' ? 'remove' : 'add', threadId, label))
      setReminderChoice('keep')
    }
    popover.toggle()
  }
  // Like the list's confirmation: focus starts on 返回, never on the write.
  useLayoutEffect(() => {
    if (popover.open) cancelRef.current?.focus()
  }, [popover.open])

  if (overview === null) return null
  const blocker = sourceBlocker(overview, overview.source)

  const confirm = () => {
    if (draft === null) return
    const asked = draft.action === 'remove' ? askedThreads(reminderAsk, [threadId]) : []
    if (asked === null) return
    popover.close()
    void change({
      source: draft.source,
      threadId,
      action: draft.action,
      expectedGeneration: draft.generation,
      label: draft.label,
      reminders: asked.length === 0 ? null : { threadIds: asked, choice: reminderChoice, result: null }
    })
  }

  if (membership.kind === 'pending' || reconciling) {
    return (
      <button type="button" className="btn subscribe-btn" disabled aria-busy="true">
        <Spinner />
        {reconciling ? '核对中…' : membership.kind === 'pending' && membership.action === 'remove' ? '取消中…' : '订阅中…'}
      </button>
    )
  }

  if (membership.kind === 'unknown') {
    return (
      <button
        type="button"
        className="btn subscribe-btn is-warning"
        disabled={busy}
        title="上次操作的结果未确认；核对只读取，不会再次写入"
        onClick={() => void reconcile(membership.operation)}
      >
        <Icon name="alert" />
        核对订阅
      </button>
    )
  }

  const subscribed = membership.kind === 'in'
  const stale = draft !== null && draft.selection !== selection
  const blockedReason =
    blocker ??
    (!overview.writable
      ? '本地存储不可写'
      : busy
        ? '另一项订阅操作正在进行'
        : operations?.some((item) => blocksNewWrite(item, { source: overview.source, objectRef, threadId }))
          ? '这个串有待核对的操作，请先在订阅页核对'
          : null)

  return (
    <span
      className="subscribe"
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (popover.open && next !== null && !event.currentTarget.contains(next)) popover.close(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={subscribed ? 'btn subscribe-btn is-on' : 'btn subscribe-btn'}
        aria-pressed={subscribed}
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        aria-controls={popover.open ? panelId : undefined}
        disabled={membership.kind === 'loading'}
        title={SOURCE_NAME[overview.source]}
        onClick={toggle}
      >
        <Icon name={subscribed ? 'check' : 'bookmark'} />
        {subscribed ? '已订阅' : '订阅'}
      </button>
      {popover.open && draft !== null && (
        <div ref={panelRef} id={panelId} className="subscribe-panel" role="dialog" aria-label={subscribed ? '取消订阅' : '订阅'}>
          <ChangeConfirm
            draft={draft}
            stale={stale}
            blockedReason={blockedReason}
            cancelRef={cancelRef}
            onConfirm={confirm}
            onCancel={() => popover.close()}
            reminderAsk={draft.action === 'remove' ? reminderAsk : null}
            reminderChoice={reminderChoice}
            onReminderChoice={setReminderChoice}
          />
          {blocker !== null && openSettings !== null && (
            <button type="button" className="btn btn-small" onClick={() => openSettings('subscriptions')}>
              打开设置
            </button>
          )}
        </div>
      )}
    </span>
  )
}

/** One line for the last write of this thread made anywhere in the app; nothing once it is dismissed. */
export function SubscribeNote({ threadId }: { threadId: ThreadId }) {
  const { lastWrite, active, dismissLastWrite } = useSubscriptionsContext()
  if (active !== null || lastWrite === null || lastWrite.write.threadId !== threadId) return null
  const { write, outcome } = lastWrite
  const what = write.kind === 'change' ? (write.action === 'add' ? '订阅' : '取消订阅') : '核对'
  let text: string
  let warn = true
  switch (outcome.type) {
    case 'done':
      if (outcome.operation.reportError?.kind === 'rate-limited') text = `${what}结果未确认：限流或需要验证`
      else if (needsReconcile(outcome.operation)) text = `${what}结果未确认`
      else {
        text = `${what}完成`
        warn = false
      }
      break
    case 'refused':
      text = outcome.reason === 'result-storage' ? `${what}结果未知，请核对` : `${what}未执行：${failureText(outcome.reason)}`
      break
    case 'failed':
      text = write.kind === 'change' ? `${what}结果未知，请核对` : '核对请求失败'
      break
  }
  return (
    <span className={warn ? 'subscribe-note toolbar-warning' : 'subscribe-note'}>
      {warn && <Icon name="alert" size={14} />}
      {text}
      <button type="button" className="icon-btn subscribe-note-close" onClick={dismissLastWrite} aria-label="关闭这条结果">
        <Icon name="close" size={12} />
      </button>
    </span>
  )
}
