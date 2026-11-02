import type { SubscriptionOperation } from '../../../../shared/subscriptions'
import { useLayoutEffect, useRef } from 'react'
import { Icon, Spinner } from '../../components/Icon'
import { useClearOnLeave } from '../../lib/useClearOnLeave'
import { activeFor, isReconcilable } from './subscriptionListState'
import { ACTION_NAME, SOURCE_NAME, dismissFailureText, failureText, needsReconcile, readbackText } from './subscriptionText'
import { useSubscriptionsContext, type ActiveWrite, type WriteNotice } from './useSubscriptions'

function objectLine(write: Pick<ActiveWrite, 'source' | 'threadId' | 'label'>): string {
  const label = write.label.trim()
  return `${SOURCE_NAME[write.source]} · No.${write.threadId}${label === '' || label === `No.${write.threadId}` ? '' : `「${label}」`}`
}

/**
 * One sentence for a journal entry whose result is not settled, ending with what its latest
 * readback or 核对 saw; its 核对订阅 and × sit beside it.
 */
export function unsettledText(operation: SubscriptionOperation): string {
  const what = ACTION_NAME[operation.action]
  const head = operation.state === 'pending' || operation.report === 'unknown' ? `${what}结果未知` : `${what}结果未确认`
  const details = [operation.reportError?.kind === 'rate-limited' ? '限流或需要验证' : null, readbackText(operation)].filter(
    (item): item is string => item !== null
  )
  return details.length === 0 ? head : `${head}：${details.join('；')}`
}

/**
 * The journal entry a finished write left to be checked: the entry itself for a recorded result,
 * else the newest entry of the same write (an orphan intent after a failed or unsaved result).
 */
export function unsettledEntryOf(
  notice: WriteNotice,
  operations: readonly SubscriptionOperation[] | null,
  active: ActiveWrite | null
): SubscriptionOperation | null {
  const { write, outcome } = notice
  if (outcome.type === 'done') {
    const current = operations?.find((item) => item.id === outcome.operation.id) ?? outcome.operation
    return isReconcilable(current, active) ? current : null
  }
  if (write.kind !== 'change' || (outcome.type === 'refused' && outcome.reason !== 'result-storage')) return null
  return (
    operations?.find(
      (item) =>
        item.threadId === write.threadId &&
        item.source === write.source &&
        item.action === write.action &&
        item.context.generation === write.generation &&
        isReconcilable(item, active)
    ) ?? null
  )
}

/**
 * 核对订阅 of one journal entry: a read-only check with the entry's own fixed identity, never a
 * second write. Disabled while any subscription work runs.
 */
export function ReconcileButton({ operation, tabIndex }: { operation: SubscriptionOperation; tabIndex?: number }) {
  const { active, busy, reconcile } = useSubscriptionsContext()
  const running =
    active?.kind === 'reconcile' &&
    activeFor(active, { source: operation.source, threadId: operation.threadId, generation: operation.context.generation })
  return (
    <button
      type="button"
      className="btn btn-small btn-page"
      tabIndex={tabIndex}
      aria-disabled={busy || undefined}
      aria-busy={running || undefined}
      aria-label={`核对订阅 No.${operation.threadId}`}
      onClick={() => {
        if (!busy) void reconcile(operation)
      }}
    >
      {running ? '核对中…' : '核对订阅'}
    </button>
  )
}

/** Where focus goes once a closed reminder left the page: chosen when × is pressed, from the × itself. */
export type FocusAfterDismiss = (from: HTMLElement) => HTMLElement | null

/**
 * × of an unresolved journal entry: closes its reminder durably and releases its protection, local
 * only. It sends nothing, keeps the entry's report and evidence, and says nothing about whether the
 * thread is subscribed. Unavailable while any subscription work runs; a failed save keeps it.
 */
export function DismissButton({
  operation,
  tabIndex,
  className = 'icon-btn sub-dismiss',
  focusAfter
}: {
  operation: SubscriptionOperation
  tabIndex?: number
  className?: string
  focusAfter?: FocusAfterDismiss
}) {
  const { busy, dismiss, dismissing } = useSubscriptionsContext()
  const running = dismissing === operation.id
  /** A 关闭 being saved from this ×, and where focus goes once the saved closure removes the ×. */
  const pending = useRef<{ button: HTMLElement; next: HTMLElement | null } | null>(null)
  // Runs in the commit that removes this × (the closed reminder leaves the page), whenever React
  // makes it relative to the save resolving. Focus moves only if it was still on the × (or was lost
  // with it); focus the user moved elsewhere meanwhile stays where it is.
  useLayoutEffect(
    () => () => {
      const intent = pending.current
      if (intent === null) return
      pending.current = null
      const focused = document.activeElement
      if (focused !== null && focused !== document.body && focused !== intent.button) return
      if (intent.next?.isConnected === true) intent.next.focus()
    },
    []
  )
  return (
    <button
      type="button"
      className={className}
      tabIndex={tabIndex}
      aria-label={`关闭 No.${operation.threadId} 的待核对提示`}
      title={busy && !running ? '另一项订阅操作正在进行' : '关闭提示：不更改远端订阅，也不会重发'}
      aria-disabled={busy || undefined}
      aria-busy={running || undefined}
      onClick={(event) => {
        if (busy) return
        const button = event.currentTarget
        pending.current = { button, next: focusAfter?.(button) ?? null }
        void dismiss(operation).then((saved) => {
          // Not saved: the reminder and this × stay, and so does the focus.
          if (!saved) pending.current = null
        })
      }}
    >
      <Icon name="close" size={14} />
    </button>
  )
}

/** Why the last × of this entry was not saved, if it was not. */
export function DismissError({ operation }: { operation: SubscriptionOperation }) {
  const { dismissFailure } = useSubscriptionsContext()
  if (dismissFailure?.id !== operation.id) return null
  return (
    <span className="sub-inline-error" role="alert">
      {dismissFailureText(dismissFailure.reason)}
    </span>
  )
}

/**
 * One sentence plus 核对订阅 and ×, where the unsettled write belongs (its row, or under 加入).
 * `tabIndex` follows the row's roving tab stop.
 */
export function UnsettledLine({
  operation,
  text,
  tabIndex,
  focusAfter
}: {
  operation: SubscriptionOperation
  text?: string
  tabIndex?: number
  focusAfter?: FocusAfterDismiss
}) {
  return (
    <div className="sub-inline is-warn">
      <Icon name="alert" size={14} className="sub-inline-icon" />
      <span className="sub-inline-text">{text ?? unsettledText(operation)}</span>
      <ReconcileButton operation={operation} tabIndex={tabIndex} />
      <DismissButton operation={operation} tabIndex={tabIndex} focusAfter={focusAfter} />
      <DismissError operation={operation} />
    </div>
  )
}

/**
 * The active write / 核对 and the result of the last one. Always rendered (a polite live region),
 * so a change of state is announced wherever the user is. `placed`: write results shown in place by
 * the view (in a row) and so not repeated here; a 核对's own result always shows here.
 * `focusAfter`: where focus goes when × closes the result's reminder.
 */
export function WriteStatus({
  displayed,
  placed,
  focusAfter
}: {
  displayed: boolean
  placed?: (notice: WriteNotice) => boolean
  focusAfter?: FocusAfterDismiss
}) {
  const { active, lastWrite, dismissLastWrite, clearSuccessfulWrite, stopReadback } = useSubscriptionsContext()
  useClearOnLeave(displayed, () => clearSuccessfulWrite(lastWrite))
  return (
    <div className="sub-write-region" role="status">
      {active !== null && (
        <div className="sub-write is-active">
          <Spinner />
          <div className="sub-write-text">
            <p className="sub-write-title">
              {active.kind === 'change' ? `正在${ACTION_NAME[active.action]}` : '正在核对'}：{objectLine(active)}
            </p>
            {active.stopRequested && <p className="sub-write-detail">已停止回读</p>}
          </div>
          {/* Kept focusable once asked (focus stays here); a second press does nothing. */}
          <button
            type="button"
            className="btn btn-small btn-page"
            aria-disabled={active.stopRequested || undefined}
            onClick={() => {
              if (!active.stopRequested) stopReadback()
            }}
          >
            {active.kind === 'change' ? '停止回读' : '停止核对'}
          </button>
        </div>
      )}
      {active === null && lastWrite !== null && (lastWrite.write.kind === 'reconcile' || placed?.(lastWrite) !== true) && (
        <WriteResult notice={lastWrite} onDismiss={dismissLastWrite} focusAfter={focusAfter} />
      )}
    </div>
  )
}

/** The result as one line, and what its readback or 核对 saw. */
function resultLine(notice: WriteNotice): { tone: 'done' | 'warn' | 'error'; text: string; detail?: string | null } {
  const { write, outcome } = notice
  const what = write.kind === 'change' ? ACTION_NAME[write.action] : '核对'
  const object = objectLine(write)
  switch (outcome.type) {
    case 'done': {
      const detail = readbackText(outcome.operation)
      if (outcome.operation.reportError?.kind === 'rate-limited') return { tone: 'warn', text: `${what}结果未确认（限流或需要验证）：${object}`, detail }
      if (needsReconcile(outcome.operation)) return { tone: 'warn', text: `${what}结果未确认：${object}`, detail }
      return { tone: 'done', text: write.kind === 'change' ? `已${what}：${object}` : `核对完成：${object}`, detail: write.kind === 'change' ? null : detail }
    }
    case 'refused':
      if (outcome.reason === 'result-storage') return { tone: 'warn', text: `${what}结果未知：${object}` }
      return { tone: 'error', text: `${what}未执行：${failureText(outcome.reason)}` }
    case 'failed':
      return write.kind === 'change' ? { tone: 'error', text: `${what}结果未知：${object}` } : { tone: 'error', text: '核对请求失败' }
  }
}

/**
 * The last result. While it leaves an unresolved entry, its × is that entry's durable 关闭; otherwise
 * × only hides this line.
 */
function WriteResult({ notice, onDismiss, focusAfter }: { notice: WriteNotice; onDismiss: () => void; focusAfter?: FocusAfterDismiss }) {
  const { operations, active } = useSubscriptionsContext()
  const { tone, text, detail } = resultLine(notice)
  const unsettled = tone === 'done' ? null : unsettledEntryOf(notice, operations, active)
  return (
    <div className={`sub-write is-${tone}`}>
      <Icon name={tone === 'done' ? 'check' : 'alert'} className="sub-write-icon" />
      <div className="sub-write-text">
        <p className="sub-write-title">{text}</p>
        {detail != null && <p className="sub-write-detail">{detail}</p>}
        {unsettled !== null && <DismissError operation={unsettled} />}
      </div>
      {unsettled !== null && <ReconcileButton operation={unsettled} />}
      {unsettled !== null ? (
        <DismissButton operation={unsettled} className="icon-btn" focusAfter={focusAfter} />
      ) : (
        <button type="button" className="icon-btn" onClick={onDismiss} aria-label="关闭这条结果">
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  )
}
