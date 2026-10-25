import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { ThreadId } from '../../../../shared/forum'
import type {
  SubscriptionCandidate,
  SubscriptionMergeSource,
  SubscriptionObservation,
  SubscriptionOverview,
  SubscriptionPlan,
  SubscriptionPreview
} from '../../../../shared/subscriptions'
import { Icon, Spinner } from '../../components/Icon'
import { FailureNotice, Loading } from '../../components/Notices'
import { formatLocalTime } from '../../lib/format'
import { useSettingsOpener } from '../../lib/settingsOpener'
import { WriteStatus } from './SubscriptionActivity'
// PROTOTYPE (throwaway): automatic reads are silent; only failures show.
import { PROTOTYPE_ENABLED } from '../directory/prototype/prototypeStore'
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
import {
  askedThreads,
  LinkageLine,
  ReminderChoiceField,
  useReminderAsk,
  type ReminderAsk,
  type ReminderChoice,
  type ReminderLinkage
} from '../reminders/ReminderLinkage'

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
        {overview === null ? (
          !PROTOTYPE_ENABLED && <Loading>正在读取订阅设置…</Loading>
        ) : task === null || task.phase === 'preview-failed' ? (
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
      ? '另一项订阅操作正在进行，完成后才能预览'
      : blockers.length > 0
        ? blockers.join('；')
        : mode === 'merge' && chosen === null
          ? '请先选择要从哪个旧 UUID 合并'
          : '预览只读取两端，不写入；执行前还要你逐项勾选并确认。'
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
          <p className="sub-recon-text">
            比较 App 订阅与网页订阅，逐项列出对两端的影响。第一次同步（或更换 UUID、网页同步对象之后的第一次）只提出新增；之后才会依据已确认的共同订阅提出删除候选。
          </p>
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
          <p className="sub-recon-text">
            读取之前用过的某个 App UUID 的集合，把当前 App 订阅没有的串加入当前集合。旧集合和本地阅读资料不会被改动，也不会删除任何串。
          </p>
          {mergeSourcesFailed && (
            <div className="notice notice-error is-compact" role="alert">
              <Icon name="alert" className="notice-icon" />
              <div className="notice-text">
                <p className="notice-title">用过的 App UUID 读取失败</p>
                <p className="notice-detail">
                  {mergeSources === null
                    ? '无法确定有哪些旧 UUID 可以合并，这不表示没有。'
                    : '下面是之前读到的列表，可能不是最新状态。'}
                </p>
              </div>
              <button type="button" className="btn btn-small" onClick={() => void refreshMergeSources()}>
                重试
              </button>
            </div>
          )}
          {!PROTOTYPE_ENABLED && mergeSources === null && !mergeSourcesFailed && <Loading>正在读取用过的 App UUID…</Loading>}
          {mergeSources !== null && !mergeSourcesFailed && sources.length === 0 && (
            <p className="sub-recon-empty">还没有其他用过的 App UUID。更换 UUID 后，之前的那个会出现在这里。</p>
          )}
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
              <dd>{chosen === null ? '尚未选择' : `${chosen.label}（只读，不改动）`}</dd>
            </div>
            <div>
              <dt>加入到</dt>
              <dd>当前 {SOURCE_NAME.app} · {appObjectText(overview)}</dd>
            </div>
          </dl>
        </>
      )}

      <div className="sub-recon-actions">
        <button type="button" className="btn btn-primary" disabled={disabled} aria-describedby={hintId} onClick={() => void startPreview(mode, mode === 'merge' ? chosen : null)}>
          {mode === 'sync' ? '预览同步' : '预览合并'}
        </button>
        {blockers.length > 0 && openSettings !== null && (
          <button type="button" className="btn" onClick={() => openSettings('subscriptions')}>
            打开设置
          </button>
        )}
      </div>
      <p className="field-hint" id={hintId}>
        {hint}
      </p>
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
      <div className="notice-text">
        <p className="notice-title">
          {MODE_NAME[task.mode]}预览没有完成：{text}
        </p>
        <p className="notice-detail">预览只读取，没有发出任何写入。可以重新预览。</p>
      </div>
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
        <div className="sub-recon-progress-text">
          <p>正在逐页读取{what}，直到空页或出错为止。</p>
          <p className="field-hint">预览只读取，不写入；页数多时需要一些时间。</p>
          {task.stopRequested && <p className="field-hint">已请求停止：正在进行的那一页结束后不再继续读取。</p>}
        </div>
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

function PreviewRules({ preview, complete }: { preview: SubscriptionPreview; complete: boolean }) {
  const removals = preview.items.some((item) => item.action === 'remove')
  let rule: { tone: 'info' | 'warn'; text: string }
  if (preview.mode === 'merge') {
    rule = { tone: 'info', text: '合并只加入，不删除；旧集合保持不变。' }
  } else if (preview.firstSync) {
    rule = {
      tone: 'info',
      text: '这是当前 App UUID 与网页同步对象的第一次同步：只提出把一端有、另一端没有的串加入另一端，不提出删除。执行并确认之后，两端共同的串才会成为以后判断删除的依据。'
    }
  } else if (preview.deletionsAllowed) {
    rule = {
      tone: 'info',
      text: '删除候选只来自上次确认时两端都有、现在一端缺少的串。删除候选默认不勾选；不勾选就不会动它。'
    }
  } else {
    rule = {
      tone: 'warn',
      text: '这次有一端没有完整读到空页、读取出错或身份有变化，因此不推断任何删除，只列出新增。'
    }
  }
  return (
    <div className="sub-recon-rules">
      <p className={rule.tone === 'warn' ? 'notice-inline is-warning' : 'notice-inline'}>
        <Icon name={rule.tone === 'warn' ? 'alert' : 'info'} size={14} />
        <span>{rule.text}</span>
      </p>
      {removals && (
        <p className="notice-inline is-warning">
          <Icon name="alert" size={14} />
          <span>
            删除候选只表示这次读取没有在一端读到该串，不能证明是你主动删除的。即使两端都连续读到了空页，读取也不是同一时刻的原子快照，读取期间远端仍可能变化；请逐项核对后再勾选。
          </span>
        </p>
      )}
      {!complete && (
        <p className="notice-inline is-warning">
          <Icon name="alert" size={14} />
          <span>有一端只读到部分页：只能按已读到的页比较，没读到的页里可能还有订阅。</span>
        </p>
      )}
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
  /** Selected deletions whose threads may have reminders: asked once for the whole plan. */
  const removals = useMemo(() => {
    if (!confirming) return null
    const ids = [...new Set(preview.items.filter((item) => item.action === 'remove' && selected.has(item.id)).map((item) => item.threadId))]
    return ids.length === 0 ? null : ids
  }, [confirming, preview, selected])
  const reminderAsk = useReminderAsk(removals)
  const [reminderChoice, setReminderChoice] = useState<ReminderChoice>('keep')
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
    setReminderChoice('keep')
    executeRef.current?.focus()
  }
  const onConfirmKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    closeConfirm()
  }

  const left = preview.mode === 'sync' ? 'App 端' : '读取自（旧集合，不改动）'
  const right = preview.mode === 'sync' ? '网页端' : '加入到（当前 App 订阅）'

  return (
    <section className="sub-recon-panel" aria-labelledby={titleId}>
      <div className="sub-recon-head">
        <h3 className="sub-recon-title" id={titleId} tabIndex={-1} data-phase-focus="">
          {MODE_NAME[preview.mode]}预览
        </h3>
        <p className="sub-recon-meta">
          {formatLocalTime(preview.createdAt)} 读取 · 配置代次 {preview.context.generation}
        </p>
      </div>

      {!current && (
        <div className="notice notice-error is-compact" role="alert">
          <Icon name="alert" className="notice-icon" />
          <div className="notice-text">
            <p className="notice-title">这份预览已失效</p>
            <p className="notice-detail">App UUID 或网页同步对象在预览之后变了。预览固定的是之前的对象，不会改用新的身份执行；请重新预览。</p>
          </div>
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
          {!complete
            ? preview.mode === 'sync'
              ? '没有可以安全执行的候选。有一端没有完整读取，这只是按已读到的页做的部分比较，不表示两端订阅一致。'
              : '没有可以安全执行的候选。有一端没有完整读取，这只是按已读到的页做的部分比较，不表示旧集合的串都已在当前集合里。'
            : preview.mode === 'sync'
              ? '按已读到的内容，两端订阅一致，没有需要改变的项。'
              : '旧集合中读到的串都已在当前集合里，没有需要加入的项。'}
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
                {group.action === 'remove' && <p className="sub-recon-group-hint">删除候选，默认不勾选。</p>}
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
          {total === 0
            ? preview.mode === 'sync'
              ? '没有勾选任何项：执行只记录这次比较，不改动两端。'
              : '没有勾选任何项。'
            : `已勾选 ${total} 项：加入 ${counts.add} 项${counts.remove > 0 ? `，取消 ${counts.remove} 项` : ''}`}
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
          reminder={{
            ask: reminderAsk,
            all: removals ?? [],
            choice: reminderChoice,
            onChoice: setReminderChoice,
            labelOf: (threadId) => itemName(threadId, labels)
          }}
          onConfirm={() => {
            const asked = removals === null ? [] : askedThreads(reminderAsk, removals)
            if (asked === null) return
            const linkage: ReminderLinkage | null = asked.length === 0 ? null : { threadIds: asked, choice: reminderChoice, result: null }
            setConfirming(false)
            setReminderChoice('keep')
            void execute(linkage)
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
  onConfirm,
  reminder
}: {
  preview: SubscriptionPreview
  selected: ReadonlySet<string>
  cancelRef: RefObject<HTMLButtonElement | null>
  onKeyDown: (event: KeyboardEvent) => void
  onCancel: () => void
  onConfirm: () => void
  /** One 保留 / 关闭 choice for every selected deletion whose thread has enabled reminders. */
  reminder: {
    ask: ReminderAsk | null
    all: readonly ThreadId[]
    choice: ReminderChoice
    onChoice: (choice: ReminderChoice) => void
    labelOf: (threadId: ThreadId) => string
  }
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
          <p>不会改动两端。确认后，开始前重新读取两端仍与预览一致时，两端共同的串会记为确认基线。</p>
        ) : (
          <ul className="sub-confirm-list">
            {groups.map((group) => (
              <li key={group.key}>
                {ACTION_NAME[group.action]}：{targetLabel(preview, group.target)} · {group.items.length} 项
              </li>
            ))}
          </ul>
        )}
        <p>开始前会重新读取两端受影响的范围，核对配置代次、两端对象、集合与页覆盖；有任何变化就整份作废、不发出任何写入，需要重新预览。</p>
        <p>这只是开始前的检查，不是锁定：确认之后，外部仍可能同时改变订阅。</p>
        {!empty && (
          <p>按列表顺序逐项执行，每项先在本机保存意图，再写入并回读核对。某项失败或无法确认时立即停止后续写入；之前成功的保留，不会自动撤回或补救。</p>
        )}
        {preview.mode === 'merge' && <p>旧集合不会被改动。</p>}
      </div>
      <ReminderChoiceField
        ask={reminder.ask}
        all={reminder.all}
        choice={reminder.choice}
        onChoice={reminder.onChoice}
        labelOf={reminder.labelOf}
        single={false}
      />
      <div className="credential-confirm-actions">
        <button
          type="button"
          className={removes ? 'btn btn-small btn-danger' : 'btn btn-small btn-primary'}
          onClick={onConfirm}
          disabled={reminder.ask?.status === 'loading'}
        >
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
          <p>{plan === null ? '正在重新读取两端并核对，确认没有变化后才开始写入…' : `已处理 ${done} / ${total} 项`}</p>
          <p className="field-hint">进度来自本机保存的记录，这里定时重读本机记录，不额外请求论坛。</p>
          {task.stopRequested && <p className="field-hint">已请求停止：不再开始新的读取或写入；已经发出的写入不会撤回。</p>}
          {task.reminders !== null && <LinkageLine linkage={task.reminders} className="field-hint" />}
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

function PlanOutcome({ task }: { task: Extract<ReconcileTask, { phase: 'finished' }> }) {
  const { dismissTask, startPreview, busy } = useSubscriptionsContext()
  const stored = usePlanFor(task.preview.id)
  const { outcome } = task
  const plan = stored ?? (outcome.type === 'plan' ? outcome.plan : null)
  const titleId = useId()

  let notice: { tone: 'error' | 'warn'; title: string; detail: string } | null = null
  if (outcome.type === 'failed') {
    notice = {
      tone: 'warn',
      title: '执行请求失败，结果未知',
      detail: plan === null ? '本机没有找到这次计划的记录；若之后出现，以记录为准。请在操作记录中核对，不要直接重复执行。' : '下面是本机保存的逐项结果，以它为准。'
    }
  } else if (outcome.type === 'refused') {
    switch (outcome.reason) {
      case 'stale':
        notice = { tone: 'error', title: '没有执行：两端或订阅身份在预览之后变了', detail: '开始前重新读取时发现变化，没有发出任何写入。请重新预览。' }
        break
      case 'cancelled':
        notice = { tone: 'warn', title: '已在第一次写入前停止', detail: '没有发出任何写入。' }
        break
      case 'result-storage':
        notice = { tone: 'warn', title: `结果未知：${failureText(outcome.reason)}`, detail: '请在操作记录中核对（只读，不会重发写入），不要直接重复执行。' }
        break
      default:
        notice = { tone: 'error', title: `没有执行：${failureText(outcome.reason)}`, detail: '这份预览已用过；如需继续，请重新预览。' }
    }
  }

  return (
    <section className="sub-recon-panel" aria-labelledby={titleId}>
      <h3 className="sub-recon-title" id={titleId} tabIndex={-1} data-phase-focus="">
        {MODE_NAME[task.preview.mode]}计划结果
      </h3>
      {/* The local reminder choice is reported on its own, whatever the plan's remote outcome. */}
      {task.reminders !== null && <LinkageLine linkage={task.reminders} className="sub-recon-linkage" />}
      {notice !== null && (
        <div className={notice.tone === 'error' ? 'notice notice-error is-compact' : 'notice notice-cached is-compact'} role="alert">
          <Icon name="alert" className="notice-icon" />
          <div className="notice-text">
            <p className="notice-title">{notice.title}</p>
            <p className="notice-detail">{notice.detail}</p>
          </div>
        </div>
      )}
      {plan !== null && (
        <>
          <PlanSummary plan={plan} />
          <PlanItems plan={plan} />
        </>
      )}
      <p className="field-hint">这份预览已经用过，不能再次执行。未执行的项不会自动继续；如需继续，请重新读取并预览。</p>
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
    lines.push(plan.preview.mode === 'sync' ? '没有改动两端；这次两端共同读到的串已记为确认基线。' : '没有改动任何集合。')
  } else {
    lines.push(`已确认 ${confirmed} 项 · 失败 ${failed} 项 · 无法确认 ${unknown} 项 · 未执行 ${notRun} 项`)
  }
  if (plan.state !== 'completed' && plan.state !== 'running' && confirmed > 0) {
    lines.push(`部分完成：已确认的 ${confirmed} 项保留，不会撤回。`)
  }
  if (unknown > 0) lines.push('无法确认的项可能已经生效，可在下方逐项核对；不会自动重发。')
  if (plan.preview.mode === 'merge') lines.push('旧集合没有被改动。')
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
                <button
                  type="button"
                  className="btn btn-small"
                  disabled={busy}
                  onClick={() => void reconcile(operation)}
                  aria-label={`核对：${ACTION_NAME[item.candidate.action]} No.${item.candidate.threadId}`}
                >
                  核对
                </button>
                <span className="field-hint">只读取，使用这一项当时的身份，不重发写入。</span>
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
        {!PROTOTYPE_ENABLED && plans === null && !plansFailed && <p className="settings-empty">正在读取记录…</p>}
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
                  {formatLocalTime(plan.createdAt)} 开始
                  {plan.finishedAt !== null && ` · ${formatLocalTime(plan.finishedAt)} 结束`} · 配置代次 {plan.preview.context.generation}
                </p>
                {plan.state === 'interrupted' && (
                  <p className="sub-journal-meta">启动时不会自动继续；如需继续，请重新预览。</p>
                )}
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
