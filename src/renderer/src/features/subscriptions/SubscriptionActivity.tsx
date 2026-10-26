import type { SubscriptionOperation } from '../../../../shared/subscriptions'
import { Icon, Spinner } from '../../components/Icon'
import { isReconcilable } from './subscriptionListState'
import { ACTION_NAME, SOURCE_NAME, failureText, needsReconcile } from './subscriptionText'
import { useSubscriptionsContext, type ActiveWrite, type WriteNotice } from './useSubscriptions'

function objectLine(write: Pick<ActiveWrite, 'source' | 'threadId' | 'label'>): string {
  const label = write.label.trim()
  return `${SOURCE_NAME[write.source]} · No.${write.threadId}${label === '' || label === `No.${write.threadId}` ? '' : `「${label}」`}`
}

/** One sentence for a journal entry whose result is not settled; its 核对订阅 sits beside it. */
export function unsettledText(operation: SubscriptionOperation): string {
  const what = ACTION_NAME[operation.action]
  if (operation.state === 'pending' || operation.report === 'unknown') return `${what}结果未知`
  return operation.reportError?.kind === 'rate-limited' ? `${what}结果未确认：限流或需要验证` : `${what}结果未确认`
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
  const running = active?.kind === 'reconcile' && active.threadId === operation.threadId && active.source === operation.source
  return (
    <button
      type="button"
      className="btn btn-small"
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

/**
 * One sentence plus 核对订阅, where the unsettled write belongs (its row, or under 加入). `tabIndex`
 * follows the row's roving tab stop.
 */
export function UnsettledLine({ operation, text, tabIndex }: { operation: SubscriptionOperation; text?: string; tabIndex?: number }) {
  return (
    <div className="sub-inline is-warn">
      <Icon name="alert" size={14} className="sub-inline-icon" />
      <span className="sub-inline-text">{text ?? unsettledText(operation)}</span>
      <ReconcileButton operation={operation} tabIndex={tabIndex} />
    </div>
  )
}

/**
 * The active write / 核对 and the result of the last one. Always rendered (a polite live region),
 * so a change of state is announced wherever the user is. `placed`: results shown in place by the
 * view (in a row) and so not repeated here.
 */
export function WriteStatus({ placed }: { placed?: (notice: WriteNotice) => boolean }) {
  const { active, lastWrite, dismissLastWrite, stopReadback } = useSubscriptionsContext()
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
          <button type="button" className="btn btn-small" onClick={stopReadback} disabled={active.stopRequested}>
            {active.kind === 'change' ? '停止回读' : '停止核对'}
          </button>
        </div>
      )}
      {active === null && lastWrite !== null && placed?.(lastWrite) !== true && <WriteResult notice={lastWrite} onDismiss={dismissLastWrite} />}
    </div>
  )
}

/** The result as one line. */
function resultLine(notice: WriteNotice): { tone: 'done' | 'warn' | 'error'; text: string } {
  const { write, outcome } = notice
  const what = write.kind === 'change' ? ACTION_NAME[write.action] : '核对'
  const object = objectLine(write)
  switch (outcome.type) {
    case 'done':
      if (outcome.operation.reportError?.kind === 'rate-limited') return { tone: 'warn', text: `${what}结果未确认（限流或需要验证）：${object}` }
      if (needsReconcile(outcome.operation)) return { tone: 'warn', text: `${what}结果未确认：${object}` }
      return { tone: 'done', text: write.kind === 'change' ? `已${what}：${object}` : `核对完成：${object}` }
    case 'refused':
      if (outcome.reason === 'result-storage') return { tone: 'warn', text: `${what}结果未知：${object}` }
      return { tone: 'error', text: `${what}未执行：${failureText(outcome.reason)}` }
    case 'failed':
      return write.kind === 'change' ? { tone: 'error', text: `${what}结果未知：${object}` } : { tone: 'error', text: '核对请求失败' }
  }
}

function WriteResult({ notice, onDismiss }: { notice: WriteNotice; onDismiss: () => void }) {
  const { operations, active } = useSubscriptionsContext()
  const { tone, text } = resultLine(notice)
  const unsettled = tone === 'done' ? null : unsettledEntryOf(notice, operations, active)
  return (
    <div className={`sub-write is-${tone}`}>
      <Icon name={tone === 'done' ? 'check' : 'alert'} className="sub-write-icon" />
      <div className="sub-write-text">
        <p className="sub-write-title">{text}</p>
      </div>
      {unsettled !== null && <ReconcileButton operation={unsettled} />}
      <button type="button" className="icon-btn" onClick={onDismiss} aria-label="关闭这条结果">
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}
