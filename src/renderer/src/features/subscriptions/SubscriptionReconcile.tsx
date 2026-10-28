import { useEffect, useId, useLayoutEffect, useMemo, useRef, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { ForumId, ThreadSummary } from '../../../../shared/forum'
import type {
  SubscriptionChoice,
  SubscriptionDifference,
  SubscriptionMergeSource,
  SubscriptionOverview,
  SubscriptionPlan,
  SubscriptionPlanItem,
  SubscriptionPreview
} from '../../../../shared/subscriptions'
import { Icon, Spinner } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { Modal, ModalHeader } from '../../components/Modal'
import { formatRecordTime } from '../../lib/time'
import { useSettingsOpener } from '../../lib/settingsOpener'
import { useRovingFocus } from '../../lib/useRovingFocus'
import { ThreadRow } from '../feed/ThreadRow'
import type { ImageView } from '../image/imageView'
import { useImageScope } from '../image/useImageLoad'
import { useListImageViewer } from '../image/useListImageViewer'
import { ReconcileButton, WriteStatus } from './SubscriptionActivity'
import {
  choiceOf,
  currentItemIndex,
  differenceGroups,
  missingSide,
  planCounts,
  previewCurrent,
  taskMode,
  writeCounts,
  type ExecuteOutcome,
  type ReconcileMode,
  type ReconcileTask
} from './reconcileState'
import { isReconcilable } from './subscriptionListState'
import { ACTION_NAME, PLAN_STATE_TEXT, SOURCE_NAME, failureText, observationState, planItemText, reportSummary, sourceBlocker, stopReasonText, verificationText } from './subscriptionText'
import { useSubscriptionsContext } from './useSubscriptions'

/** Title of the view and of history entries. */
const MODE_TITLE: Record<ReconcileMode, string> = {
  sync: '同步与合并',
  merge: '从旧 UUID 合并'
}

/** The operation in a one-line result. */
const MODE_NAME: Record<ReconcileMode, string> = {
  sync: '同步',
  merge: '合并'
}

const CHOICE_TEXT: Record<ReconcileMode, Partial<Record<SubscriptionChoice, string>>> = {
  sync: { both: '两端都订阅', none: '两端都取消', skip: '不动' },
  merge: { both: '加入', skip: '不动' }
}

const CHOICE_ORDER: Record<ReconcileMode, SubscriptionChoice[]> = {
  sync: ['both', 'none', 'skip'],
  merge: ['both', 'skip']
}

/** What keeps a preview from starting at all; one sentence, or null. */
export function previewBlocker(overview: SubscriptionOverview, mode: ReconcileMode): string | null {
  const sources = mode === 'sync' ? (['app', 'web'] as const) : (['app'] as const)
  for (const source of sources) {
    const blocker = sourceBlocker(overview, source)
    if (blocker !== null) return blocker
  }
  return null
}

function usePlanFor(previewId: string | null): SubscriptionPlan | null {
  const { plans } = useSubscriptionsContext()
  return previewId === null ? null : (plans?.find((plan) => plan.preview.id === previewId) ?? null)
}

/** Why a preview did not complete, and whether settings (not a retry) is the way out. */
function previewFailureLine(reason: Extract<ReconcileTask, { phase: 'preview-failed' }>['reason'], overview: SubscriptionOverview, mode: ReconcileMode): { text: string; settings: boolean } {
  switch (reason) {
    case 'locked':
    case 'unconfigured':
    case 'missing':
    case 'invalid-uuid':
      return { text: previewBlocker(overview, mode) ?? failureText(reason).replace(/，未执行$/, ''), settings: true }
    case 'cancelled':
      return { text: '已停止读取', settings: false }
    case 'busy':
      return { text: '另一项订阅操作正在进行', settings: false }
    case 'storage':
      return { text: '本地存储不可用', settings: false }
    case 'internal':
      return { text: '读取请求失败', settings: false }
    default:
      return { text: failureText(reason), settings: false }
  }
}

/**
 * 同步与合并 (or 从旧 UUID 合并): the differences of both fixed collections on one page, a choice
 * per thread, one execution from the bottom bar. Lives in the subscription pane; the task itself is
 * app-wide. The pane returns to its list when a plan finishes.
 */
export function ReconcileView({
  headingRef,
  forumNames,
  selectedThreadId,
  onOpenThread,
  onRestart,
  onBack
}: {
  headingRef: RefObject<HTMLHeadingElement | null>
  forumNames: ReadonlyMap<ForumId, string>
  selectedThreadId: string | null
  onOpenThread: (thread: ThreadSummary) => void
  /** Reads a fresh preview of the given mode (the pane checks blockers first). */
  onRestart: (mode: ReconcileMode, mergeSource: SubscriptionMergeSource | null) => void
  onBack: () => void
}) {
  const { overview, task, active, execute, stopTask } = useSubscriptionsContext()
  const openSettings = useSettingsOpener()
  const scrollRef = useRef<HTMLDivElement>(null)
  const { images, open: viewerOpen, viewer } = useListImageViewer(useImageScope(scrollRef), scrollRef)
  const mode: ReconcileMode = task === null ? 'sync' : taskMode(task)
  const mergeSource = task?.mergeSource ?? null
  const preview = task !== null && (task.phase === 'preview' || task.phase === 'executing' || task.phase === 'finished') ? task.preview : null
  const plan = usePlanFor(task?.phase === 'executing' || task?.phase === 'finished' ? task.preview.id : null)

  // When the phase changes the control the user pressed may disappear: if focus dropped, put it on
  // the heading, but only while this view is shown.
  const phase = task?.phase ?? 'none'
  const lastPhase = useRef(phase)
  useLayoutEffect(() => {
    if (lastPhase.current === phase) return
    lastPhase.current = phase
    const root = scrollRef.current
    if (root === null || root.offsetParent === null) return
    const focused = document.activeElement
    if (focused === null || focused === document.body || (root.contains(focused) && !focused.isConnected)) headingRef.current?.focus()
  }, [phase, headingRef])

  const restart = () => onRestart(mode, mergeSource)
  const sides =
    preview === null
      ? null
      : preview.mode === 'sync'
        ? `${preview.leftLabel} ⇄ ${preview.rightLabel}`
        : `${mergeSource?.label ?? preview.leftLabel} → ${preview.rightLabel}`

  let body: ReactNode = null
  if (overview !== null) {
    if (task === null) {
      const blocker = previewBlocker(overview, 'sync')
      body = (
        <Line
          tone={blocker !== null ? 'warn' : 'info'}
          text={blocker ?? (active !== null ? '另一项订阅操作正在进行，结束后再读取' : '还没有读取两端订阅')}
          action={
            blocker !== null
              ? openSettings === null
                ? null
                : { label: '打开设置', run: () => openSettings('subscriptions') }
              : { label: active !== null ? '重试' : '读取', run: restart, disabled: active !== null }
          }
        />
      )
    } else if (task.phase === 'previewing') {
      body = (
        <>
          {task.notice === 'stale' && <StaleLine />}
          <div className="list-placeholder sub-recon-skeleton" aria-busy="true" aria-label="正在读取两端订阅">
            <div aria-hidden="true">
              {Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="row-skeleton">
                  <span className="skeleton-line is-short" />
                  <span className="skeleton-line" />
                  <span className="skeleton-line is-mid" />
                </div>
              ))}
            </div>
          </div>
        </>
      )
    } else if (task.phase === 'preview-failed') {
      const failure = previewFailureLine(task.reason, overview, task.mode)
      body = (
        <Line
          tone={task.reason === 'cancelled' ? 'info' : 'error'}
          text={failure.text}
          action={failure.settings ? (openSettings === null ? null : { label: '打开设置', run: () => openSettings('subscriptions') }) : { label: '重试', run: restart }}
        />
      )
    } else {
      body = (
        <Differences
          task={task}
          plan={plan}
          overview={overview}
          forumNames={forumNames}
          selectedThreadId={selectedThreadId}
          images={images}
          onOpenThread={onOpenThread}
          onRestart={restart}
        />
      )
    }
  }

  return (
    <>
      <div ref={scrollRef} className="list-scroll sub-recon-root" tabIndex={-1} data-pane-focus="" inert={viewerOpen}>
        <header className="list-header">
          <h2 className="list-title" ref={headingRef} tabIndex={-1}>
            <span className="list-kind">订阅</span>
            <span className="list-name">{MODE_TITLE[mode]}</span>
          </h2>
          {sides !== null && <p className="sub-recon-meta">{sides}</p>}
        </header>
        <div className="sub-recon">
          <WriteStatus />
          {body}
        </div>
        <ActionBar task={task} plan={plan} overview={overview} onExecute={() => void execute()} onStop={stopTask} onBack={onBack} />
      </div>
      {viewer}
    </>
  )
}

function Line({
  tone,
  text,
  action
}: {
  tone: 'info' | 'warn' | 'error'
  text: string
  action: { label: string; run: () => void; disabled?: boolean } | null
}) {
  const className = tone === 'error' ? 'notice notice-error is-compact' : tone === 'warn' ? 'notice notice-cached is-compact' : 'notice is-compact'
  return (
    <div className={className} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={tone === 'info' ? 'info' : 'alert'} className="notice-icon" />
      <p className="notice-text">{text}</p>
      {action !== null && (
        <button type="button" className="btn btn-small btn-page" aria-disabled={action.disabled || undefined} onClick={() => !action.disabled && action.run()}>
          {action.label}
        </button>

      )}
    </div>
  )
}

function StaleLine() {
  return (
    <p className="notice-inline sub-recon-stale" role="status">
      <Icon name="info" size={14} />
      <span>订阅有变化，已重新预览</span>
    </p>
  )
}

function groupTitle(preview: SubscriptionPreview, presentOn: SubscriptionDifference['presentOn'], mergeSource: SubscriptionMergeSource | null, count: number): string {
  if (preview.mode === 'merge') return `只在${mergeSource?.label ?? '之前的 App UUID'}（${count}）`
  return presentOn === 'web' ? `只在网页订阅（${count}）` : `只在 App 订阅（${count}）`
}

/** Why a difference that was common at the last sync is missing now; in the row's meta line. */
function originText(item: SubscriptionDifference): string | null {
  const missing = SOURCE_NAME[missingSide(item)]
  if (item.provenance === null) return null
  if (item.provenance.kind === 'local-removal') return `${formatRecordTime(item.provenance.at)} 在汐岛取消了 ${missing}`
  return `上次同步后，${missing} 里不在了`
}

function Differences({
  task,
  plan,
  overview,
  forumNames,
  selectedThreadId,
  images,
  onOpenThread,
  onRestart
}: {
  task: Extract<ReconcileTask, { phase: 'preview' | 'executing' | 'finished' }>
  plan: SubscriptionPlan | null
  overview: SubscriptionOverview
  forumNames: ReadonlyMap<ForumId, string>
  selectedThreadId: string | null
  images: ImageView
  onOpenThread: (thread: ThreadSummary) => void
  onRestart: () => void
}) {
  const { setChoice } = useSubscriptionsContext()
  const { preview, choices, mergeSource } = task
  const hintId = useId()
  const groups = useMemo(() => differenceGroups(preview), [preview])
  const ids = useMemo(() => preview.items.map((item) => item.threadId), [preview])
  const roving = useRovingFocus(ids, selectedThreadId)
  const current = previewCurrent(preview, overview.context)
  const editable = task.phase === 'preview' && current
  const incomplete = [
    { label: preview.leftLabel, observation: preview.left },
    { label: preview.rightLabel, observation: preview.right }
  ].flatMap(({ label, observation }) => {
    const state = observationState(observation)
    return state.complete ? [] : [`${label}没有读完：${state.text}`]
  })
  // Where 两端都取消 is not offered, the whole preview shares the reason.
  const noneHint = preview.firstSync
    ? '第一次同步不提供“两端都取消”'
    : incomplete.length > 0
      ? '有一端没有读完，不提供“两端都取消”'
      : '这一项不提供“两端都取消”'
  const planItems = useMemo(() => new Map(plan?.items.map((item, index) => [item.candidate.id, { item, index }]) ?? []), [plan])
  const currentIndex = plan === null ? -1 : currentItemIndex(plan)

  return (
    <>
      {task.phase === 'preview' && task.notice === 'stale' && <StaleLine />}
      {!current && task.phase === 'preview' && <Line tone="error" text="订阅身份已变化，这份预览不能执行" action={{ label: '重新预览', run: onRestart }} />}
      {incomplete.length > 0 && task.phase === 'preview' && (
        <Line tone="warn" text={incomplete.join('；')} action={{ label: '重试', run: onRestart }} />
      )}
      <p id={hintId} className="visually-hidden">
        {noneHint}
      </p>

      {preview.items.length === 0 ? (
        <p className="sub-recon-empty" role="status">
          {incomplete.length > 0
            ? preview.mode === 'sync'
              ? '已读到的部分里，两端订阅一致'
              : '已读到的部分里，没有要加入的串'
            : preview.mode === 'sync'
              ? '两端订阅一致'
              : '旧 UUID 里的串都已在当前 App 订阅中'}
          <KaomojiDecor state="reconcileEmpty" />
        </p>
      ) : (
        <div className="sub-diff" onKeyDown={roving.onKeyDown}>
          {groups.map((group) => {
            const title = groupTitle(preview, group.presentOn, mergeSource, group.items.length)
            const groupIds = group.items.map((item) => item.id)
            return (
              <section key={group.presentOn} className="sub-diff-group" aria-label={title}>
                <div className="sub-diff-head">
                  <h3 className="sub-diff-title">{title}</h3>
                  {editable && (
                    <div className="sub-diff-bulk">
                      <button type="button" className="btn btn-small btn-quiet" aria-label={`${title}：全部${CHOICE_TEXT[preview.mode].both}`} onClick={() => setChoice(groupIds, 'both')}>
                        全部{CHOICE_TEXT[preview.mode].both}
                      </button>
                      <button type="button" className="btn btn-small btn-quiet" aria-label={`${title}：全部不动`} onClick={() => setChoice(groupIds, 'skip')}>
                        全部不动
                      </button>
                    </div>
                  )}
                </div>
                <ul className="thread-list sub-diff-list">
                  {group.items.map((item) => {
                    const itemProps = roving.itemProps(item.threadId)
                    const origin = originText(item)
                    const entry = planItems.get(item.id)
                    return (
                      <li key={item.id} className="sub-row sub-diff-row">
                        <ThreadRow
                          thread={item.thread}
                          forumName={item.thread.head.forumId !== null ? (forumNames.get(item.thread.head.forumId) ?? null) : null}
                          selected={item.threadId === selectedThreadId}
                          images={images}
                          onOpen={() => onOpenThread(item.thread)}
                          itemProps={itemProps}
                          tabMenu
                          metaEnd={origin === null ? undefined : <span className="sub-diff-origin">{origin}</span>}
                        />
                        <div className="sub-diff-end">
                          {task.phase === 'preview' ? (
                            <ChoiceControl
                              item={item}
                              mode={preview.mode}
                              choice={choiceOf(item, choices)}
                              disabled={!current}
                              tabIndex={itemProps.tabIndex}
                              hintId={hintId}
                              hint={noneHint}
                              onChange={(choice) => setChoice([item.id], choice)}
                            />
                          ) : (
                            <ItemState mode={preview.mode} choice={choiceOf(item, choices)} entry={entry} current={entry !== undefined && entry.index === currentIndex} />
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      )}
    </>
  )
}

/**
 * Exclusive choice of one difference as a radio group styled like the segmented control: one tab
 * stop (the checked option, following the row's roving stop), arrow keys move and choose.
 */
function ChoiceControl({
  item,
  mode,
  choice,
  disabled,
  tabIndex,
  hintId,
  hint,
  onChange
}: {
  item: SubscriptionDifference
  mode: ReconcileMode
  choice: SubscriptionChoice
  disabled: boolean
  tabIndex: number
  hintId: string
  /** Why an option is not offered (only 两端都取消 ever is not). */
  hint: string
  onChange: (choice: SubscriptionChoice) => void
}) {
  const groupRef = useRef<HTMLDivElement>(null)
  const options = CHOICE_ORDER[mode]
  const usable = options.filter((option) => item.choices.includes(option))

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (step === 0 && event.key !== 'Home' && event.key !== 'End') return
    // Row navigation (↑／↓ on the rows) never sees keys handled here.
    event.preventDefault()
    event.stopPropagation()
    if (disabled || usable.length === 0) return
    const at = usable.indexOf(choice)
    const next =
      event.key === 'Home' ? usable[0] : event.key === 'End' ? usable.at(-1) : usable[(Math.max(at, 0) + step + usable.length) % usable.length]
    if (next === undefined) return
    onChange(next)
    groupRef.current?.querySelector<HTMLElement>(`[data-choice="${next}"]`)?.focus()
  }

  return (
    <div ref={groupRef} className="segmented sub-choice" role="radiogroup" aria-label={`No.${item.threadId} 的处理`} aria-disabled={disabled || undefined} onKeyDown={onKeyDown}>
      {options.map((option) => {
        const offered = item.choices.includes(option)
        const checked = option === choice
        return (
          <button
            key={option}
            type="button"
            role="radio"
            className="segmented-item"
            data-choice={option}
            aria-checked={checked}
            aria-disabled={!offered || disabled || undefined}
            aria-describedby={offered ? undefined : hintId}
            title={offered ? undefined : hint}
            tabIndex={checked ? tabIndex : -1}
            onClick={() => {
              if (offered && !disabled) onChange(option)
            }}
          >
            {CHOICE_TEXT[mode][option]}
          </button>
        )
      })}
    </div>
  )
}

/** While and after the plan runs: the row's write and how far it got, in place of its choice. */
function ItemState({
  mode,
  choice,
  entry,
  current
}: {
  mode: ReconcileMode
  choice: SubscriptionChoice
  entry: { item: SubscriptionPlanItem } | undefined
  current: boolean
}) {
  if (choice === 'skip') return <span className="sub-diff-skip">不动</span>
  const state = entry === undefined ? { text: '等待', tone: 'idle' as const } : planItemText(entry.item, current)
  return (
    <span className="sub-diff-state">
      <span className="sub-diff-choice">{CHOICE_TEXT[mode][choice]}</span>
      <span className={`tag sub-plan-state is-${state.tone}`}>
        {current && <Spinner />}
        {state.text}
      </span>
    </span>
  )
}

/** The fixed bottom row: execute (its label states the writes), stop while running, back to the list. */
function ActionBar({
  task,
  plan,
  overview,
  onExecute,
  onStop,
  onBack
}: {
  task: ReconcileTask | null
  plan: SubscriptionPlan | null
  overview: SubscriptionOverview | null
  onExecute: () => void
  onStop: () => void
  onBack: () => void
}) {
  const { active } = useSubscriptionsContext()
  const hintId = useId()
  const shown = task !== null && (task.phase === 'preview' || task.phase === 'executing') && task.preview.items.length > 0
  let label = ''
  let blocked = true
  let hint: string | null = null
  if (shown) {
    if (task.phase === 'executing') {
      const total = plan?.items.length ?? 0
      const done = plan?.items.filter((item) => item.state !== 'pending').length ?? 0
      label = plan === null ? '正在核对两端…' : `正在执行 ${done} / ${total}`
    } else {
      const counts = writeCounts(task.preview, task.choices)
      const parts = [counts.add > 0 ? `加入 ${counts.add}` : null, counts.remove > 0 ? `取消 ${counts.remove}` : null].filter((part) => part !== null)
      label = parts.length === 0 ? '执行：无改动' : `执行：${parts.join(' · ')}`
      const current = previewCurrent(task.preview, overview?.context ?? null)
      if (active !== null) hint = '另一项订阅操作正在进行，结束后才能执行'
      blocked = parts.length === 0 || !current || active !== null
    }
  }
  return (
    <div className="sub-recon-bar">
      <div className="sub-recon-actions">
        {shown && (
          <button
            type="button"
            className="btn btn-primary"
            // aria-disabled, not disabled: focus stays on it while the plan starts and runs.
            aria-disabled={blocked || undefined}
            aria-busy={task.phase === 'executing' || undefined}
            aria-describedby={hint === null ? undefined : hintId}
            onClick={() => {
              if (!blocked) onExecute()
            }}
          >
            {task.phase === 'executing' && <Spinner />}
            {label}
          </button>
        )}
        {task?.phase === 'executing' && (
          <button type="button" className="btn btn-page" aria-disabled={task.stopRequested || undefined} onClick={() => !task.stopRequested && onStop()}>
            {task.stopRequested ? '正在停止…' : '停止后续写入'}
          </button>
        )}
        <button type="button" className="btn btn-page" onClick={onBack}>
          返回列表
        </button>
      </div>
      {hint !== null && (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
    </div>
  )
}

// ---------- One-line result on the list ----------

function resultLine(
  mode: ReconcileMode,
  outcome: ExecuteOutcome,
  plan: SubscriptionPlan | null
): { tone: 'done' | 'warn' | 'error'; text: string; view: boolean } {
  const name = MODE_NAME[mode]
  if (plan === null) {
    if (outcome.type === 'refused') {
      if (outcome.reason === 'cancelled') return { tone: 'warn', text: `${name}没有执行：已在写入前停止`, view: false }
      if (outcome.reason === 'result-storage') return { tone: 'warn', text: `${name}结果未知：${failureText(outcome.reason)}`, view: true }
      return { tone: 'error', text: `${name}：${failureText(outcome.reason)}`, view: false }
    }
    return { tone: 'warn', text: `${name}结果未知`, view: true }
  }
  const counts = planCounts(plan)
  const head = plan.state === 'completed' ? `${name}完成` : plan.state === 'running' ? `${name}进行中` : `${name}${PLAN_STATE_TEXT[plan.state]}`
  const done = [counts.added > 0 ? `加入 ${counts.added}` : null, counts.removed > 0 ? `取消 ${counts.removed}` : null].filter((part) => part !== null)
  const problems = [
    counts.failed > 0 ? `${counts.failed} 项失败` : null,
    counts.unknown > 0 ? `${counts.unknown} 项结果未确认` : null,
    counts.notRun > 0 ? `${counts.notRun} 项未执行` : null
  ].filter((part) => part !== null)
  const text = `${head}：${done.length === 0 ? '没有改动' : done.join('，')}${problems.length === 0 ? '' : `；${problems.join('，')}`}`
  const tone = counts.failed > 0 ? 'error' : problems.length > 0 || plan.state !== 'completed' ? 'warn' : 'done'
  return { tone, text, view: tone !== 'done' }
}

/**
 * The finished sync / merge as one line at the top of the list; 查看 opens its record when
 * something failed or is unknown. Always rendered as a polite live region.
 */
export function ReconcileResult({ onView }: { onView: (planId: string | null) => void }) {
  const { task, dismissTask } = useSubscriptionsContext()
  const finished = task?.phase === 'finished' ? task : null
  const stored = usePlanFor(finished?.preview.id ?? null)
  const plan = stored ?? (finished?.outcome.type === 'plan' ? finished.outcome.plan : null)
  const line = finished === null ? null : resultLine(finished.preview.mode, finished.outcome, plan)
  return (
    <div className="sub-write-region" role="status">
      {line !== null && (
        <div className={`sub-write is-${line.tone}`}>
          <Icon name={line.tone === 'done' ? 'check' : 'alert'} className="sub-write-icon" />
          <div className="sub-write-text">
            <p className="sub-write-title">{line.text}</p>
          </div>
          {line.view && (
            <button type="button" className="btn btn-small btn-page" onClick={() => onView(plan?.id ?? null)}>
              查看
            </button>
          )}
          <button type="button" className="icon-btn" onClick={dismissTask} aria-label="关闭这条结果">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
    </div>
  )
}

// ---------- 同步记录 ----------

const HISTORY_TAG: Record<SubscriptionPlan['state'], string> = {
  running: 'tag',
  completed: 'tag',
  stopped: 'tag tag-warn',
  interrupted: 'tag tag-warn'
}

/** Plans with something to look at: stopped, interrupted, or an item failed / unknown. */
export function plansNeedingAttention(plans: readonly SubscriptionPlan[] | null): number {
  return plans?.filter((plan) => plan.state === 'stopped' || plan.state === 'interrupted' || plan.items.some((item) => item.state === 'failed' || item.state === 'unknown')).length ?? 0
}

function planSummary(plan: SubscriptionPlan): string {
  const counts = planCounts(plan)
  if (plan.items.length === 0) return '没有改动'
  const parts = [
    counts.added > 0 ? `加入 ${counts.added}` : null,
    counts.removed > 0 ? `取消 ${counts.removed}` : null,
    counts.failed > 0 ? `${counts.failed} 项失败` : null,
    counts.unknown > 0 ? `${counts.unknown} 项结果未确认` : null,
    counts.notRun > 0 ? `${counts.notRun} 项未执行` : null
  ].filter((part) => part !== null)
  return parts.length === 0 ? '没有改动' : parts.join('，')
}

/**
 * Read-only plan history, including plans interrupted by a restart (there is no resume). Reads only
 * a plan's items, mode and times: stored previews may be of an older shape. `focusPlanId` opens and
 * scrolls to that plan (查看 from the one-line result).
 */
export function ReconcileHistoryDialog({
  focusPlanId,
  onClose,
  fallbackFocus
}: {
  focusPlanId: string | null
  onClose: () => void
  /** Where focus goes when the control that opened it is gone (the 更多 menu item). */
  fallbackFocus: () => HTMLElement | null
}) {
  const { plans, plansFailed, refreshPlans } = useSubscriptionsContext()
  const titleId = useId()
  const focusRef = useRef<HTMLLIElement>(null)

  useEffect(() => {
    void refreshPlans()
  }, [refreshPlans])
  const found = focusPlanId !== null && plans?.some((plan) => plan.id === focusPlanId) === true
  useEffect(() => {
    if (found) focusRef.current?.scrollIntoView({ block: 'nearest' })
  }, [found])

  return (
    <Modal className="sub-history-dialog" labelledBy={titleId} onClose={onClose} closeOnBackdrop fallbackFocus={fallbackFocus}>
      <ModalHeader title="同步记录" titleId={titleId} closeLabel="关闭同步记录" onClose={onClose} />
      <div className="modal-body sub-history-body" aria-busy={(plans === null && !plansFailed) || undefined}>
        {plansFailed && (
          <div className="notice notice-cached is-compact" role="status">
            <Icon name="alert" className="notice-icon" />
            <p className="notice-text">
              记录读取失败，下面可能不是最新状态
              <KaomojiDecor state="failure" />
            </p>
            <button type="button" className="btn btn-small" onClick={() => void refreshPlans()}>
              重试
            </button>
          </div>
        )}
        {plans !== null && plans.length === 0 && (
          <p className="sub-journal-empty">
            还没有同步或合并记录
            <KaomojiDecor state="syncJournalEmpty" />
          </p>
        )}
        {plans !== null && plans.length > 0 && (
          <ul className="sub-journal-list" aria-labelledby={titleId}>
            {plans.map((plan) => (
              <li key={plan.id} ref={plan.id === focusPlanId ? focusRef : undefined} className="sub-journal-item">
                <div className="sub-journal-head">
                  <p className="sub-journal-title">{plan.preview.mode === 'merge' ? '从旧 UUID 合并' : '同步'}</p>
                  <span className={HISTORY_TAG[plan.state]}>{PLAN_STATE_TEXT[plan.state]}</span>
                </div>
                <p className="sub-journal-meta">
                  {formatRecordTime(plan.createdAt)} 开始
                  {plan.finishedAt !== null && ` · ${formatRecordTime(plan.finishedAt)} 结束`}
                </p>
                <p className="sub-journal-summary">
                  {planSummary(plan)}
                  {stopReasonText(plan) !== null && `（${stopReasonText(plan)}）`}
                </p>
                {plan.items.length > 0 && (
                  <details className="sub-plan-details" open={plan.id === focusPlanId || undefined}>
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
    </Modal>
  )
}

/** Each written item with its state, the server report and the readback kept apart; failed or unknown ones offer the read-only 核对订阅. */
function PlanItems({ plan }: { plan: SubscriptionPlan }) {
  const { operations, active } = useSubscriptionsContext()
  const currentIndex = currentItemIndex(plan)
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
                No.{item.candidate.threadId}
                <span className="sub-plan-effect">
                  {ACTION_NAME[item.candidate.action]} · {SOURCE_NAME[item.candidate.target]}
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

