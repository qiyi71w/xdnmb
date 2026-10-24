import { useId } from 'react'
import type { SubscriptionOperation } from '../../../../shared/subscriptions'
import { Icon, Spinner } from '../../components/Icon'
import { formatLocalTime } from '../../lib/format'
import { isReconcilable, isRunningChange } from './subscriptionListState'
import {
  ACTION_NAME,
  SOURCE_NAME,
  contextText,
  evidenceText,
  failureText,
  needsReconcile,
  reportSummary,
  verificationText
} from './subscriptionText'
import { useSubscriptionsContext, type ActiveWrite, type WriteNotice } from './useSubscriptions'

function objectLine(write: Pick<ActiveWrite, 'source' | 'threadId' | 'label'>): string {
  const label = write.label.trim()
  return `${SOURCE_NAME[write.source]} · No.${write.threadId}${label === '' || label === `No.${write.threadId}` ? '' : `「${label}」`}`
}

/**
 * The active write / 核对 and the result of the last one. Always rendered (a polite live region),
 * so a change of state is announced wherever the user is.
 */
export function WriteStatus() {
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
            <p className="sub-write-detail">
              {active.kind === 'change'
                ? `已先保存这次意图，使用配置代次 ${active.generation}；等待服务端报告后回读核对。之后切换来源或身份不会改变这次操作。`
                : `只读核对，使用这条记录当时的身份与配置代次 ${active.generation}，不会再次发出写入。`}
            </p>
            {active.stopRequested && (
              <p className="sub-write-detail">已请求停止读取；已经发出的写入不会因此撤回。</p>
            )}
          </div>
          <button type="button" className="btn btn-small" onClick={stopReadback} disabled={active.stopRequested}>
            {active.kind === 'change' ? '停止回读' : '停止核对'}
          </button>
        </div>
      )}
      {active === null && lastWrite !== null && <WriteResult notice={lastWrite} onDismiss={dismissLastWrite} />}
    </div>
  )
}

function WriteResult({ notice, onDismiss }: { notice: WriteNotice; onDismiss: () => void }) {
  const { write, outcome } = notice
  const what = write.kind === 'change' ? ACTION_NAME[write.action] : '核对'
  let tone: 'done' | 'warn' | 'error' = 'done'
  let title: string
  let lines: string[] = []
  switch (outcome.type) {
    case 'done': {
      const operation = outcome.operation
      title = `${what}已记录：${objectLine(write)}`
      lines = [`服务端报告：${reportSummary(operation)}`, `回读核对：${verificationText(operation)}`]
      if (operation.reportError?.kind === 'rate-limited') {
        tone = 'warn'
        lines.push('因限流或需要验证，已停止自动回读；稍后可在操作记录中手动核对，不会自动重发。')
      } else if (needsReconcile(operation)) {
        tone = 'warn'
        lines.push('结果尚不能确认，可在操作记录中手动核对；不会自动重发。')
      }
      break
    }
    case 'refused':
      if (outcome.reason === 'result-storage') {
        // The write was dispatched; only its local record failed. Never present this as 未执行.
        tone = 'warn'
        title = `${what}的结果未知：${failureText(outcome.reason)}`
        lines = [objectLine(write), '请在操作记录中核对（只读，不会重发写入），不要直接重复操作。']
        break
      }
      tone = 'error'
      title = `${what}未执行：${failureText(outcome.reason)}`
      lines = [objectLine(write)]
      break
    case 'failed':
      tone = 'error'
      title = write.kind === 'change' ? `${what}的结果未知：应用内部请求失败` : '核对请求失败：应用内部请求失败'
      lines =
        write.kind === 'change'
          ? [objectLine(write), '写入可能已经发出。请在操作记录中核对，不要直接重复操作。']
          : [objectLine(write), '没有发出任何写入，可以稍后再核对。']
      break
  }
  return (
    <div className={`sub-write is-${tone}`}>
      <Icon name={tone === 'done' ? 'check' : 'alert'} className="sub-write-icon" />
      <div className="sub-write-text">
        <p className="sub-write-title">{title}</p>
        {lines.map((line) => (
          <p key={line} className="sub-write-detail">
            {line}
          </p>
        ))}
      </div>
      <button type="button" className="icon-btn" onClick={onDismiss} aria-label="关闭这条结果">
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}

/** Local journal of every write, including ones made under earlier sources, UUIDs or bindings. */
export function OperationJournal() {
  const { operations, operationsFailed, refreshOperations, active } = useSubscriptionsContext()
  const headingId = useId()
  const unresolved = operations?.filter((operation) => isReconcilable(operation, active)).length ?? 0

  return (
    <details className="sub-journal">
      <summary>
        <Icon name="chevron" size={14} className="disclosure-icon" />
        <span className="sub-journal-label" id={headingId}>
          操作记录
        </span>
        {unresolved > 0 && <span className="tag tag-sage">{unresolved} 条待核对</span>}
      </summary>
      <div className="sub-journal-body">
        {operationsFailed && (
          <div className="notice notice-cached is-compact" role="status">
            <Icon name="alert" className="notice-icon" />
            <p className="notice-text">操作记录读取失败，下面可能不是最新状态</p>
            <button type="button" className="btn btn-small" onClick={() => void refreshOperations()}>
              重试
            </button>
          </div>
        )}
        {operations === null && !operationsFailed && <p className="settings-empty">正在读取操作记录…</p>}
        {operations !== null && operations.length === 0 && <p className="sub-journal-empty">还没有加入或取消订阅的记录。</p>}
        {operations !== null && operations.length > 0 && (
          <ul className="sub-journal-list" aria-labelledby={headingId}>
            {operations.map((operation) => (
              <JournalItem key={operation.id} operation={operation} />
            ))}
          </ul>
        )}
      </div>
    </details>
  )
}

const STATE_TAG: Record<SubscriptionOperation['state'], { text: string; className: string }> = {
  // A pending entry is only shown as running while its own change is active; see isRunningChange.
  pending: { text: '待核对', className: 'tag tag-sage' },
  settled: { text: '已记录', className: 'tag' },
  'needs-reconciliation': { text: '待核对', className: 'tag tag-sage' }
}
const RUNNING_TAG = { text: '进行中', className: 'tag' }

function JournalItem({ operation }: { operation: SubscriptionOperation }) {
  const { active, busy, reconcile } = useSubscriptionsContext()
  const tag = isRunningChange(operation, active) ? RUNNING_TAG : STATE_TAG[operation.state]
  const canReconcile = isReconcilable(operation, active)
  const reconciling = active?.kind === 'reconcile' && active.threadId === operation.threadId && active.source === operation.source
  return (
    <li className="sub-journal-item">
      <div className="sub-journal-head">
        <p className="sub-journal-title">
          {ACTION_NAME[operation.action]} · {objectLine({ source: operation.source, threadId: operation.threadId, label: operation.objectLabel })}
        </p>
        <span className={tag.className}>{tag.text}</span>
      </div>
      <p className="sub-journal-meta">
        {formatLocalTime(operation.createdAt)} · {contextText(operation.context, operation.source)}
      </p>
      <dl className="sub-facts">
        <div>
          <dt>服务端报告</dt>
          <dd>
            {reportSummary(operation)}
          </dd>
        </div>
        <div>
          <dt>回读核对</dt>
          <dd>{verificationText(operation)}</dd>
        </div>
        <div>
          <dt>操作前观察</dt>
          <dd>{evidenceText(operation.before)}</dd>
        </div>
        <div>
          <dt>回读观察</dt>
          <dd>{evidenceText(operation.after)}</dd>
        </div>
      </dl>
      {canReconcile && (
        <div className="sub-journal-actions">
          <button
            type="button"
            className="btn btn-small"
            onClick={() => void reconcile(operation)}
            disabled={busy}
            aria-label={`核对：${ACTION_NAME[operation.action]} No.${operation.threadId}`}
          >
            {reconciling ? '正在核对…' : '核对'}
          </button>
          <span className="field-hint">只读取，使用这条记录当时的身份与代次，不重发写入。</span>
        </div>
      )}
    </li>
  )
}
