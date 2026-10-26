import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { ThreadId } from '../../../../shared/forum'
import type {
  SubscriptionCandidate,
  SubscriptionMergeSource,
  SubscriptionObservation,
  SubscriptionOperation,
  SubscriptionOverview,
  SubscriptionPlan,
  SubscriptionPreview
} from '../../../../shared/subscriptions'
import { Icon, Spinner } from '../../components/Icon'
import { formatRecordTime } from '../../lib/time'
import { useSettingsOpener } from '../../lib/settingsOpener'
import { ReconcileButton, UnsettledLine, WriteStatus } from './SubscriptionActivity'
import {
  countByAction,
  currentItemIndex,
  groupCandidates,
  otherLabel,
  previewCurrent,
  targetLabel,
  threadLabels,
  type ReconcileMode,
  type ReconcileTask
} from './reconcileState'
import { isReconcilable } from './subscriptionListState'
import {
  ACTION_NAME,
  PLAN_STATE_TEXT,
  SOURCE_NAME,
  coverageText,
  failureText,
  observationState,
  planItemText,
  reportSummary,
  sourceBlocker,
  stopReasonText,
  verificationText,
  webObjectText
} from './subscriptionText'
import { useSubscriptionsContext } from './useSubscriptions'

const MODE_NAME: Record<ReconcileMode, string> = {
  sync: '双向同步',
  merge: '合并搬运'
}

function appObjectText(overview: SubscriptionOverview): string {
  return overview.appConfigured ? `本机引用 #${overview.context.appCredentialId ?? '未知'}` : '未设置'
}

function itemName(threadId: ThreadId, labels: ReadonlyMap<ThreadId, string>): string {
  const label = labels.get(threadId)
  return label === undefined || label === `No.${threadId}` ? `No.${threadId}` : `No.${threadId}「${label}」`
}

/** Absence is only what this read did not see, never proof of what the other side holds. */
function reasonText(preview: SubscriptionPreview, candidate: SubscriptionCandidate): string {
  const other = otherLabel(preview, candidate.target)
  const target = targetLabel(preview, candidate.target)
  if (candidate.action === 'add') return `${other}读到了，${target}这次没有读到`
  return `上次确认时两端都有，这次没有在${other}读到；勾选后从${target}取消`
}

/**
 * 同步与合并: explicit preview of both fixed collections, per-item choice, one execution and the
 * durable history. Lives in the subscription pane; the task itself is app-wide.
 */
export function ReconcileView({ headingRef, onBack }: { headingRef: RefObject<HTMLHeadingElement | null>; onBack: () => void }) {
  const { overview, task } = useSubscriptionsContext()
  const rootRef = useRef<HTMLDivElement>(null)

  // When the phase changes the control the user pressed usually disappears: move focus to the new
  // region's heading, but only if focus was in this view (or dropped), never from another tab.
  const phase = task === null ? 'start' : task.phase === 'preview-failed' ? 'start' : task.phase
  const lastPhase = useRef(phase)
  useLayoutEffect(() => {
    if (lastPhase.current === phase) return
    lastPhase.current = phase
    const root = rootRef.current
    if (root === null || root.offsetParent === null) return
    const focused = document.activeElement
    if (focused !== null && focused !== document.body && !root.contains(focused)) return
    root.querySelector<HTMLElement>('[data-phase-focus]')?.focus()
  }, [phase])

  return (
    <div ref={rootRef} className="sub-recon-root">
      <header className="list-header">
        <div className="list-title-row">
          <h2 className="list-title" ref={headingRef} tabIndex={-1}>
            <span className="list-kind">订阅</span>
            <span className="list-name">同步与合并</span>
          </h2>
          <button type="button" className="btn btn-small" onClick={onBack}>
            <Icon name="arrowLeft" size={14} />
            返回列表
          </button>
        </div>
      </header>
      <div className="sub-recon">
        <WriteStatus />
        {overview === null ? null : task === null || task.phase === 'preview-failed' ? (
          <StartPanel overview={overview} task={task} />
        ) : task.phase === 'previewing' ? (
          <PreviewProgress task={task} />
        ) : task.phase === 'preview' ? (
          <PreviewPanel overview={overview} task={task} />
        ) : task.phase === 'executing' ? (
          <PlanProgress task={task} />
        ) : (
          <PlanOutcome task={task} />
        )}
        <PlanHistory />
      </div>
    </div>
  )
}

// ---------- Start ----------

function StartPanel({ overview, task }: { overview: SubscriptionOverview; task: Extract<ReconcileTask, { phase: 'preview-failed' }> | null }) {
  const { busy, active, startPreview, dismissTask, mergeSources, mergeSourcesFailed, refreshMergeSources } = useSubscriptionsContext()
  const openSettings = useSettingsOpener()
  const [mode, setMode] = useState<ReconcileMode>(task?.mode ?? 'sync')
  const [choice, setChoice] = useState(task?.mergeSource?.appCredentialId ?? '')
  const titleId = useId()
  const selectId = useId()
  const hintId = useId()

  const current = overview.context.appCredentialId
  // The current App reference is the merge target, never also its source.
  const sources = useMemo(() => (mergeSources ?? []).filter((source) => source.appCredentialId !== current), [mergeSources, current])
  const chosen: SubscriptionMergeSource | null = sources.find((source) => source.appCredentialId === choice) ?? null

  const blockers = (mode === 'sync' ? (['app', 'web'] as const) : (['app'] as const))
    .map((source) => sourceBlocker(overview, source))
    .filter((text): text is string => text !== null)
  const hint =
    active !== null
      ? '另一项订阅操作正在进行'
      : blockers.length > 0
        ? blockers.join('；')
        : mode === 'merge' && chosen === null
          ? '请先选择旧 UUID'
          : null
  const disabled = busy || blockers.length > 0 || (mode === 'merge' && chosen === null)

  return (
    <section className="sub-recon-panel" aria-labelledby={titleId}>
      <h3 className="sub-recon-title" id={titleId} tabIndex={-1} data-phase-focus="">
        开始新的预览
      </h3>
      {task !== null && <PreviewFailure task={task} onDismiss={dismissTask} />}
      <div className="segmented" role="group" aria-label="预览类型">
        {(['sync', 'merge'] as const).map((item) => (
          <button
            key={item}
            type="button"
            className="segmented-item"
            aria-pressed={mode === item}
            onClick={() => {
              setMode(item)
              // Local list only; re-read so a failure is never mistaken for “no earlier UUID”.
              if (item === 'merge' && mode !== 'merge') void refreshMergeSources()
            }}
          >
            {MODE_NAME[item]}
          </button>
        ))}
      </div>

      {mode === 'sync' ? (
        <>
          <dl className="sub-recon-objects">
            <div>
              <dt>{SOURCE_NAME.app}</dt>
              <dd>{appObjectText(overview)}</dd>
            </div>
            <div>
              <dt>{SOURCE_NAME.web}</dt>
              <dd>{webObjectText(overview)}</dd>
            </div>
            <div>
              <dt>配置代次</dt>
              <dd>{overview.context.generation}</dd>
            </div>
          </dl>
        </>
      ) : (
        <>
          {mergeSourcesFailed && (
            <div className="notice notice-error is-compact" role="alert">
              <Icon name="alert" className="notice-icon" />
              <p className="notice-text">用过的 App UUID 读取失败</p>
              <button type="button" className="btn btn-small" onClick={() => void refreshMergeSources()}>
                重试
              </button>
            </div>
          )}
          {mergeSources !== null && !mergeSourcesFailed && sources.length === 0 && <p className="sub-recon-empty">还没有其他用过的 App UUID</p>}
          {sources.length > 0 && (
            <div className="sub-recon-field">
              <label className="field-label" htmlFor={selectId}>
                从哪个旧 UUID 读取
              </label>
              <select id={selectId} className="select-input" value={chosen === null ? '' : choice} onChange={(event) => setChoice(event.target.value)}>
                <option value="">请选择…</option>
                {sources.map((source) => (
                  <option key={source.appCredentialId} value={source.appCredentialId}>
                    {source.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          <dl className="sub-recon-objects">
            <div>
              <dt>读取自</dt>
              <dd>{chosen === null ? '尚未选择' : chosen.label}</dd>
            </div>
            <div>
              <dt>加入到</dt>
              <dd>当前 {SOURCE_NAME.app} · {appObjectText(overview)}</dd>
            </div>
          </dl>
        </>
      )}

      <div className="sub-recon-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled}
          aria-describedby={hint === null ? undefined : hintId}
          onClick={() => void startPreview(mode, mode === 'merge' ? chosen : null)}
        >
          {mode === 'sync' ? '预览同步' : '预览合并'}
        </button>
        {blockers.length > 0 && openSettings !== null && (
          <button type="button" className="btn" onClick={() => openSettings('subscriptions')}>
            打开设置
          </button>
        )}
      </div>
      {hint !== null && (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
    </section>
  )
}

function PreviewFailure({ task, onDismiss }: { task: Extract<ReconcileTask, { phase: 'preview-failed' }>; onDismiss: () => void }) {
  const cancelled = task.reason === 'cancelled'
  const text =
    task.reason === 'internal'
      ? '应用内部请求失败'
      : cancelled
        ? '已按要求停止读取'
        : failureText(task.reason)
  return (
    <div className={cancelled ? 'notice notice-cached is-compact' : 'notice notice-error is-compact'} role={cancelled ? 'status' : 'alert'}>
      <Icon name="alert" className="notice-icon" />
      <p className="notice-text">
        {MODE_NAME[task.mode]}预览没有完成：{text}
      </p>
      <button type="button" className="icon-btn" onClick={onDismiss} aria-label="关闭这条提示">
        <Icon name="close" size={14} />
      </button>
    </div>
  )
}

// ---------- Previewing ----------

function PreviewProgress({ task }: { task: Extract<ReconcileTask, { phase: 'previewing' }> }) {
  const { stopTask } = useSubscriptionsContext()
  const what = task.mode === 'sync' ? 'App 订阅与网页订阅' : `${task.mergeSource?.label ?? '旧 UUID'} 与当前 App 订阅`
  return (
    <section className="sub-recon-panel" aria-label={`${MODE_NAME[task.mode]}预览`}>
      <h3 className="sub-recon-title" tabIndex={-1} data-phase-focus="">
        正在预览{MODE_NAME[task.mode]}
      </h3>
      <div className="sub-recon-progress" role="status">
        <Spinner />
        <p className="sub-recon-progress-text">正在读取{what}…</p>
      </div>
      <div className="sub-recon-actions">
        <button type="button" className="btn" onClick={stopTask} disabled={task.stopRequested}>
          {task.stopRequested ? '正在停止…' : '停止预览'}
        </button>
      </div>
    </section>
  )
}

// ---------- Preview ----------

function ObservationSide({ role, label, observation }: { role: string; label: string; observation: SubscriptionObservation }) {
  const state = observationState(observation)
  return (
    <div className={state.complete ? 'sub-recon-side' : 'sub-recon-side is-partial'}>
      <p className="sub-recon-side-role">{role}</p>
      <p className="sub-recon-side-label">{label}</p>
      <p className="sub-recon-side-detail">
        读到 {observation.ids.length} 个串 · {coverageText(observation)}
      </p>
      <p className="sub-recon-side-state">
        <Icon name={state.complete ? 'check' : 'alert'} size={14} />
        <span>{state.text}</span>
      </p>
    </div>
  )
}

/** Only what limits this preview, one sentence each; nothing when it is complete and plain. */
function PreviewRules({ preview, complete }: { preview: SubscriptionPreview; complete: boolean }) {
  const removals = preview.items.some((item) => item.action === 'remove')
  const rules: string[] = []
  if (preview.mode === 'sync' && preview.firstSync) rules.push('第一次同步只提出新增')
  else if (preview.mode === 'sync' && !preview.deletionsAllowed) rules.push('有一端没有读完或身份有变化，不推断删除')
  if (removals) rules.push('删除候选只表示这次没有在一端读到，不能证明是你删除的')
  if (!complete) rules.push('有一端只读到部分页')
  if (rules.length === 0) return null
  return (
    <div className="sub-recon-rules">
      {rules.map((rule) => (
        <p key={rule} className="notice-inline is-warning">
          <Icon name="alert" size={14} />
          <span>{rule}</span>
        </p>
      ))}
    </div>
  )
}

function PreviewPanel({ overview, task }: { overview: SubscriptionOverview; task: Extract<ReconcileTask, { phase: 'preview' }> }) {
  const { active, setSelected, execute, dismissTask, startPreview } = useSubscriptionsContext()
  const { preview, selected } = task
  const titleId = useId()
  const executeRef = useRef<HTMLButtonElement>(null)
  const cancelConfirmRef = useRef<HTMLButtonElement>(null)
  const [confirming, setConfirming] = useState(false)
  const labels = useMemo(() => threadLabels(preview), [preview])
  const groups = useMemo(() => groupCandidates(preview.items), [preview])
  const complete = observationState(preview.left).complete && observationState(preview.right).complete
  const counts = countByAction(preview, selected)
  const total = counts.add + counts.remove
  const current = previewCurrent(preview, overview.context)
  const blocked = !current ? '订阅身份已变化，这份预览不能再执行' : active !== null ? '另一项订阅操作正在进行，完成后才能执行' : preview.mode === 'merge' && total === 0 ? '请至少勾选一项' : null

  useEffect(() => {
    if (confirming) cancelConfirmRef.current?.focus()
  }, [confirming])
  // A preview that went stale while the confirmation was open cannot be confirmed.
  useEffect(() => {
    if (blocked !== null) setConfirming(false)
  }, [blocked])

  const closeConfirm = () => {
    setConfirming(false)
    executeRef.current?.focus()
  }
  const onConfirmKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    closeConfirm()
  }

  const left = preview.mode === 'sync' ? 'App 端' : '读取自'
  const right = preview.mode === 'sync' ? '网页端' : '加入到'

  return (
    <section className="sub-recon-panel" aria-labelledby={titleId}>
      <div className="sub-recon-head">
        <h3 className="sub-recon-title" id={titleId} tabIndex={-1} data-phase-focus="">
          {MODE_NAME[preview.mode]}预览
        </h3>
        <p className="sub-recon-meta">
          {formatRecordTime(preview.createdAt)} 读取 · 配置代次 {preview.context.generation}
        </p>
      </div>

      {!current && (
        <div className="notice notice-error is-compact" role="alert">
          <Icon name="alert" className="notice-icon" />
          <p className="notice-text">这份预览已失效</p>
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              dismissTask()
              void startPreview(preview.mode, task.mergeSource)
            }}
          >
            重新预览
          </button>
        </div>
      )}

      <div className="sub-recon-sides">
        <ObservationSide role={left} label={preview.leftLabel} observation={preview.left} />
        <ObservationSide role={right} label={preview.rightLabel} observation={preview.right} />
      </div>

      <PreviewRules preview={preview} complete={complete} />

      {preview.items.length === 0 ? (
        <p className="sub-recon-empty" role="status">
          {!complete ? '按已读到的页没有候选' : preview.mode === 'sync' ? '两端订阅一致' : '没有需要加入的项'}
        </p>
      ) : (
        <div className="sub-recon-groups">
          {groups.map((group) => {
            const ids = group.items.map((item) => item.id)
            const allChecked = ids.every((id) => selected.has(id))
            const name = `${ACTION_NAME[group.action]} → ${targetLabel(preview, group.target)}`
            return (
              <fieldset key={group.key} className={group.action === 'remove' ? 'sub-recon-group is-remove' : 'sub-recon-group'} disabled={!current}>
                <legend className="sub-recon-legend">
                  {name}
                  <span className="sub-recon-count">{group.items.length} 项</span>
                </legend>
                <button type="button" className="btn btn-small btn-quiet sub-recon-toggle" onClick={() => setSelected(ids, !allChecked)} aria-label={`${allChecked ? '全不选' : '全选'}：${name}`}>
                  {allChecked ? '全不选' : '全选'}
                </button>
                <ul className="sub-recon-items">
                  {group.items.map((item) => (
                    <li key={item.id}>
                      <label className="sub-recon-item">
                        <input type="checkbox" checked={selected.has(item.id)} onChange={(event) => setSelected([item.id], event.target.checked)} />
                        <span className="sub-recon-item-text">
                          <span className="sub-recon-item-name">{itemName(item.threadId, labels)}</span>
                          <span className="sub-recon-item-reason">{reasonText(preview, item)}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            )
          })}
        </div>
      )}

      <div className="sub-recon-footer">
        <p className="sub-recon-summary" role="status">
          {total === 0 ? '没有勾选任何项' : `已勾选 ${total} 项：加入 ${counts.add} 项${counts.remove > 0 ? `，取消 ${counts.remove} 项` : ''}`}
        </p>
        <div className="sub-recon-actions">
          <button
            type="button"
            ref={executeRef}
            className="btn btn-primary"
            // Not disabled while confirming: focus comes back here from the confirmation.
            disabled={blocked !== null}
            aria-expanded={confirming}
            onClick={() => setConfirming(true)}
          >
            {total === 0 ? '记录这次比较…' : `执行所选 ${total} 项…`}
          </button>
          <button type="button" className="btn" onClick={dismissTask}>
            放弃预览
          </button>
        </div>
        {blocked !== null && <p className="field-hint">{blocked}</p>}
      </div>

      {confirming && blocked === null && (
        <ExecuteConfirm
          preview={preview}
          selected={selected}
          cancelRef={cancelConfirmRef}
          onKeyDown={onConfirmKeyDown}
          onCancel={closeConfirm}
          onConfirm={() => {
            // Sync deletions never ask about or change reminders (spec I8).
            setConfirming(false)
            void execute()
          }}
        />
      )}
    </section>
  )
}

function ExecuteConfirm({
  preview,
  selected,
  cancelRef,
  onKeyDown,
  onCancel,
  onConfirm
}: {
  preview: SubscriptionPreview
  selected: ReadonlySet<string>
  cancelRef: RefObject<HTMLButtonElement | null>
  onKeyDown: (event: KeyboardEvent) => void
  onCancel: () => void
  onConfirm: () => void
}) {
  const titleId = useId()
  const textId = useId()
  // Runs of the selected candidates themselves, so the summary reads in execution order.
  const groups = groupCandidates(preview.items.filter((item) => selected.has(item.id)))
  const removes = groups.some((group) => group.action === 'remove')
  const empty = groups.length === 0
  return (
    <div className={removes ? 'sub-confirm is-remove' : 'sub-confirm'} role="group" aria-labelledby={titleId} aria-describedby={textId} onKeyDown={onKeyDown}>
      <p className="sub-confirm-title" id={titleId}>
        {empty ? '只记录这次比较？' : `执行${MODE_NAME[preview.mode]}计划？`}
      </p>
      <div className="sub-confirm-text" id={textId}>
        {empty ? (
          <p>不会改动两端，两端共同的串记为确认基线。</p>
        ) : (
          <ul className="sub-confirm-list">
            {groups.map((group) => (
              <li key={group.key}>
                {ACTION_NAME[group.action]}：{targetLabel(preview, group.target)} · {group.items.length} 项
              </li>
            ))}
          </ul>
        )}
        <p>开始前会重新读取两端，有变化就不执行。</p>
      </div>
      <div className="credential-confirm-actions">
        <button type="button" className={removes ? 'btn btn-small btn-danger' : 'btn btn-small btn-primary'} onClick={onConfirm}>
          {empty ? '确认记录' : '确认执行'}
        </button>
        <button type="button" ref={cancelRef} className="btn btn-small" onClick={onCancel}>
          返回
        </button>
      </div>
    </div>
  )
}

// ---------- Executing and result ----------

function usePlanFor(previewId: string): SubscriptionPlan | null {
  const { plans } = useSubscriptionsContext()
  return plans?.find((plan) => plan.preview.id === previewId) ?? null
}

function PlanProgress({ task }: { task: Extract<ReconcileTask, { phase: 'executing' }> }) {
  const { stopTask } = useSubscriptionsContext()
  const plan = usePlanFor(task.preview.id)
  const done = plan?.items.filter((item) => item.state !== 'pending').length ?? 0
  const total = task.selectedIds.length
  return (
    <section className="sub-recon-panel" aria-label={`${MODE_NAME[task.preview.mode]}计划`}>
      <h3 className="sub-recon-title" tabIndex={-1} data-phase-focus="">
        正在执行{MODE_NAME[task.preview.mode]}计划
      </h3>
      <div className="sub-recon-progress" role="status">
        <Spinner />
        <div className="sub-recon-progress-text">
          <p>{plan === null ? '正在核对两端…' : `已处理 ${done} / ${total} 项`}</p>
        </div>
      </div>
      <div className="sub-recon-actions">
        <button type="button" className="btn" onClick={stopTask} disabled={task.stopRequested}>
          {task.stopRequested ? '正在停止…' : '停止后续步骤'}
        </button>
      </div>
      {plan !== null && <PlanItems plan={plan} />}
    </section>
  )
}

/**
 * Unsettled journal entries of a plan whose local record was not found: writes of its selected
 * items made since the preview. Each gets its read-only 核对订阅 in place.
 */
function unsettledOfPlan(
  task: Extract<ReconcileTask, { phase: 'finished' }>,
  operations: readonly SubscriptionOperation[] | null,
  active: Parameters<typeof isReconcilable>[1]
): SubscriptionOperation[] {
  const chosen = task.preview.items.filter((item) => task.selectedIds.includes(item.id))
  return (operations ?? []).filter(
    (operation) =>
      operation.createdAt >= task.preview.createdAt &&
      isReconcilable(operation, active) &&
      chosen.some((item) => item.threadId === operation.threadId && item.target === operation.source && item.action === operation.action)
  )
}

function PlanOutcome({ task }: { task: Extract<ReconcileTask, { phase: 'finished' }> }) {
  const { dismissTask, startPreview, busy, operations, active, refreshPlans, refreshOperations } = useSubscriptionsContext()
  const stored = usePlanFor(task.preview.id)
  const { outcome } = task
  const plan = stored ?? (outcome.type === 'plan' ? outcome.plan : null)
  const titleId = useId()

  let notice: { tone: 'error' | 'warn'; text: string } | null = null
  if (outcome.type === 'failed') {
    notice = { tone: 'warn', text: plan === null ? '执行结果未知：本机没有找到这次计划的记录' : '执行结果未知' }
  } else if (outcome.type === 'refused') {
    switch (outcome.reason) {
      case 'stale':
        notice = { tone: 'error', text: '没有执行：两端或订阅身份在预览之后变了' }
        break
      case 'cancelled':
        notice = { tone: 'warn', text: '已在第一次写入前停止' }
        break
      case 'result-storage':
        notice = { tone: 'warn', text: `结果未知：${failureText(outcome.reason)}` }
        break
      default:
        notice = { tone: 'error', text: `没有执行：${failureText(outcome.reason)}` }
    }
  }
  // Without its record the plan's writes are checked here, each from its own journal entry.
  const inPlace = plan === null && (outcome.type === 'failed' || (outcome.type === 'refused' && outcome.reason === 'result-storage'))
  const unsettled = inPlace ? unsettledOfPlan(task, operations, active) : []

  return (
    <section className="sub-recon-panel" aria-labelledby={titleId}>
      <h3 className="sub-recon-title" id={titleId} tabIndex={-1} data-phase-focus="">
        {MODE_NAME[task.preview.mode]}计划结果
      </h3>
      {notice !== null && (
        <div className={notice.tone === 'error' ? 'notice notice-error is-compact' : 'notice notice-cached is-compact'} role="alert">
          <Icon name="alert" className="notice-icon" />
          <p className="notice-text">{notice.text}</p>
          {inPlace && unsettled.length === 0 && (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                void refreshPlans()
                void refreshOperations()
              }}
            >
              重新读取记录
            </button>
          )}
        </div>
      )}
      {unsettled.length > 0 && (
        <ul className="sub-unsettled" aria-label="待核对的订阅操作">
          {unsettled.map((operation) => (
            <li key={operation.id}>
              <UnsettledLine
                operation={operation}
                text={`${ACTION_NAME[operation.action]} → ${SOURCE_NAME[operation.source]} · No.${operation.threadId}：结果未确认`}
              />
            </li>
          ))}
        </ul>
      )}
      {plan !== null && (
        <>
          <PlanSummary plan={plan} />
          <PlanItems plan={plan} />
        </>
      )}
      <div className="sub-recon-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => {
            dismissTask()
            void startPreview(task.preview.mode, task.mergeSource)
          }}
        >
          重新预览
        </button>
        <button type="button" className="btn" onClick={dismissTask}>
          完成
        </button>
      </div>
    </section>
  )
}

function PlanSummary({ plan }: { plan: SubscriptionPlan }) {
  const count = (state: SubscriptionPlan['items'][number]['state']) => plan.items.filter((item) => item.state === state).length
  const confirmed = count('confirmed')
  const failed = count('failed')
  const unknown = count('unknown')
  const notRun = count('skipped') + (plan.state === 'running' ? 0 : count('pending'))
  const reason = stopReasonText(plan)
  const lines: string[] = []
  if (plan.items.length === 0 && plan.state === 'completed') {
    lines.push(plan.preview.mode === 'sync' ? '没有改动两端，已记为确认基线' : '没有改动任何集合')
  } else {
    lines.push(`已确认 ${confirmed} 项 · 失败 ${failed} 项 · 无法确认 ${unknown} 项 · 未执行 ${notRun} 项`)
  }
  const tone = plan.state === 'completed' ? 'is-done' : plan.state === 'running' ? 'is-active' : 'is-warn'
  return (
    <div className={`sub-write ${tone}`} role="status">
      <Icon name={plan.state === 'completed' ? 'check' : 'alert'} className="sub-write-icon" />
      <div className="sub-write-text">
        <p className="sub-write-title">
          {PLAN_STATE_TEXT[plan.state]}
          {reason !== null && `：${reason}`}
        </p>
        {lines.map((line) => (
          <p key={line} className="sub-write-detail">
            {line}
          </p>
        ))}
      </div>
    </div>
  )
}

/** Each selected item with its state and, once written, the journal's report and readback facts. */
function PlanItems({ plan }: { plan: SubscriptionPlan }) {
  const { operations, active, busy, reconcile } = useSubscriptionsContext()
  const labels = useMemo(() => threadLabels(plan.preview), [plan.preview])
  const currentIndex = currentItemIndex(plan)
  if (plan.items.length === 0) return null
  return (
    <ol className="sub-plan-items">
      {plan.items.map((item, index) => {
        const state = planItemText(item, index === currentIndex)
        const operation = item.operationId === null ? undefined : operations?.find((entry) => entry.id === item.operationId)
        const canReconcile = operation !== undefined && plan.state !== 'running' && isReconcilable(operation, active)
        return (
          <li key={item.candidate.id} className="sub-plan-item">
            <div className="sub-plan-head">
              <p className="sub-plan-name">
                {itemName(item.candidate.threadId, labels)}
                <span className="sub-plan-effect">
                  {ACTION_NAME[item.candidate.action]} → {targetLabel(plan.preview, item.candidate.target)}
                </span>
              </p>
              <span className={`tag sub-plan-state is-${state.tone}`}>
                {index === currentIndex && <Spinner />}
                {state.text}
              </span>
            </div>
            {operation !== undefined && (
              <dl className="sub-facts">
                <div>
                  <dt>服务端报告</dt>
                  <dd>{reportSummary(operation)}</dd>
                </div>
                <div>
                  <dt>回读核对</dt>
                  <dd>{verificationText(operation)}</dd>
                </div>
              </dl>
            )}
            {canReconcile && (
              <div className="sub-journal-actions">
                <ReconcileButton operation={operation} />
              </div>
            )}
          </li>
        )
      })}
    </ol>
  )
}

// ---------- History ----------

const HISTORY_TAG: Record<SubscriptionPlan['state'], string> = {
  running: 'tag',
  completed: 'tag',
  stopped: 'tag tag-warn',
  interrupted: 'tag tag-warn'
}

/** Durable plans, including ones interrupted by a restart; there is no resume, only a new preview. */
function PlanHistory() {
  const { plans, plansFailed, refreshPlans } = useSubscriptionsContext()
  const headingId = useId()
  const attention = plans?.filter((plan) => plan.state === 'stopped' || plan.state === 'interrupted').length ?? 0
  return (
    <details className="sub-journal">
      <summary>
        <Icon name="chevron" size={14} className="disclosure-icon" />
        <span className="sub-journal-label" id={headingId}>
          同步与合并记录
        </span>
        {attention > 0 && <span className="tag tag-warn">{attention} 份未完成</span>}
      </summary>
      <div className="sub-journal-body">
        {plansFailed && (
          <div className="notice notice-cached is-compact" role="status">
            <Icon name="alert" className="notice-icon" />
            <p className="notice-text">记录读取失败，下面可能不是最新状态</p>
            <button type="button" className="btn btn-small" onClick={() => void refreshPlans()}>
              重试
            </button>
          </div>
        )}
        {plans !== null && plans.length === 0 && <p className="sub-journal-empty">还没有执行过同步或合并。</p>}
        {plans !== null && plans.length > 0 && (
          <ul className="sub-journal-list" aria-labelledby={headingId}>
            {plans.map((plan) => (
              <li key={plan.id} className="sub-journal-item">
                <div className="sub-journal-head">
                  <p className="sub-journal-title">
                    {MODE_NAME[plan.preview.mode]} · {plan.preview.leftLabel}
                    {plan.preview.mode === 'sync' ? ' ⇄ ' : ' → '}
                    {plan.preview.rightLabel}
                  </p>
                  <span className={HISTORY_TAG[plan.state]}>{PLAN_STATE_TEXT[plan.state]}</span>
                </div>
                <p className="sub-journal-meta">
                  {formatRecordTime(plan.createdAt)} 开始
                  {plan.finishedAt !== null && ` · ${formatRecordTime(plan.finishedAt)} 结束`} · 配置代次 {plan.preview.context.generation}
                </p>
                <PlanSummary plan={plan} />
                {plan.items.length > 0 && (
                  <details className="sub-plan-details">
                    <summary>
                      <Icon name="chevron" size={14} className="disclosure-icon" />
                      逐项结果（{plan.items.length} 项）
                    </summary>
                    <PlanItems plan={plan} />
                  </details>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  )
}
