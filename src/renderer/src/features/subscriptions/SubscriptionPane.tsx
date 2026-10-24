import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject
} from 'react'
import type { ForumId, ThreadId, ThreadSummary } from '../../../../shared/forum'
import type {
  SubscriptionAction,
  SubscriptionObservation,
  SubscriptionOverview,
  SubscriptionResult,
  SubscriptionSource
} from '../../../../shared/subscriptions'
import { Icon } from '../../components/Icon'
import { FailureNotice, Loading } from '../../components/Notices'
import { formatLocalTime } from '../../lib/format'
import { useSettingsOpener } from '../../lib/settingsOpener'
import { useRovingFocus } from '../../lib/useRovingFocus'
import { ThreadRow } from '../feed/ThreadRow'
import { ContentRegistryContext, useRegisterContent } from '../tabs/contentRegistry'
import { OperationJournal, WriteStatus } from './SubscriptionActivity'
import { ReconcileView } from './SubscriptionReconcile'
import {
  blocksNewWrite,
  displayedObservation,
  initialSubscriptionListState,
  selectionKey,
  sourceObjectRef,
  subscriptionListReducer,
  type SubscriptionListState
} from './subscriptionListState'
import {
  ACTION_NAME,
  SOURCE_NAME,
  SOURCE_SHORT,
  coverageText,
  failureText,
  sourceBlocker,
  threadLabel,
  webObjectText
} from './subscriptionText'
import { useSubscriptionsContext } from './useSubscriptions'
import '../feed/feed.css'
import '../identity/identity.css'
import './subscriptions.css'

/** A write the user asked for, frozen with the source and identity combination shown when asked. */
interface ChangeDraft {
  action: SubscriptionAction
  threadId: ThreadId
  label: string
  source: SubscriptionSource
  generation: number
  selection: string
  /** Local reference of the remote collection this write targets (App UUID ref or web credential). */
  objectRef: string | null
  identity: string
}

const THREAD_ID = /^\d{1,20}$/

/** Both identities, the viewed source's first; the fixed web sync object is always named. Never a secret. */
function identityLine(overview: SubscriptionOverview): string {
  const app = `App UUID：${overview.appConfigured ? `已设置 · 本机引用 #${overview.context.appCredentialId ?? '未知'}` : '未设置'}`
  const web = `网页同步对象：${webObjectText(overview)}`
  const [first, second] = overview.source === 'app' ? [app, web] : [web, app]
  return `${first}；${second} · 配置代次 ${overview.context.generation}`
}

/**
 * Remote subscription list of the currently selected source (App / 网页), in the tab's list slot.
 * Reads page 1 when the user navigates here or switches source here; further pages, refresh and
 * 停止 are explicit. Old observations stay on screen (labelled) when a read fails, is cancelled or
 * is partial; results arriving for a previous source or identity combination are dropped.
 */
export function SubscriptionPane({
  entryKey,
  forumNames,
  selectedThreadId,
  onOpenThread
}: {
  entryKey: number
  forumNames: ReadonlyMap<ForumId, string>
  selectedThreadId: string | null
  onOpenThread: (thread: ThreadSummary) => void
}) {
  const subscriptions = useSubscriptionsContext()
  const { overview, overviewFailed, refreshOverview, applyOverview, operations, change, busy, task, refreshPlans } = subscriptions
  const openSettings = useSettingsOpener()
  const registry = useContext(ContentRegistryContext)
  const [remembered] = useState(() => {
    const memory = registry?.listMemory.get(entryKey)
    return memory?.kind === 'subscriptions' ? memory : null
  })
  /** 同步与合并 replaces the list in this pane; the list stays mounted (hidden) with its scroll position. */
  const [view, setView] = useState<'list' | 'reconcile'>(remembered?.view ?? 'list')
  const reconcileHeadingRef = useRef<HTMLHeadingElement>(null)
  const reconcileButtonRef = useRef<HTMLButtonElement>(null)
  const viewFocus = useRef(false)
  useLayoutEffect(() => {
    if (!viewFocus.current) return
    viewFocus.current = false
    if (view === 'reconcile') reconcileHeadingRef.current?.focus()
    else reconcileButtonRef.current?.focus()
  }, [view])
  const showView = (next: 'list' | 'reconcile') => {
    viewFocus.current = true
    setView(next)
  }
  const [state, dispatch] = useReducer(
    subscriptionListReducer,
    remembered?.state ?? initialSubscriptionListState,
    (start: SubscriptionListState): SubscriptionListState => ({ ...start, activity: 'idle', stopRequested: false })
  )

  const selection = overview === null ? null : selectionKey(overview)
  const overviewRef = useRef(overview)
  const selectionRef = useRef(selection)
  const stateRef = useRef(state)
  useLayoutEffect(() => {
    overviewRef.current = overview
    selectionRef.current = selection
    stateRef.current = state
  })

  // ---------- Reads ----------
  /** The read this view is waiting for; any other result is stale. */
  const reading = useRef<{ operationId: string; selection: string } | null>(null)
  /** Explicit navigation (no remembered list) or a source switch made here reads page 1. */
  const autoRead = useRef(remembered === null)

  const read = useCallback(async (observationId: string | null) => {
    const current = overviewRef.current
    if (current === null || reading.current !== null) return
    const token = { operationId: crypto.randomUUID(), selection: selectionKey(current) }
    reading.current = token
    dispatch({ type: 'start', activity: observationId === null ? 'first' : 'next' })
    let result: SubscriptionResult<SubscriptionObservation>
    try {
      result = await window.xidao.subscriptions.read({ source: current.source, observationId, operationId: token.operationId })
    } catch {
      if (reading.current !== token) return
      reading.current = null
      dispatch({ type: 'internal', where: 'read' })
      return
    }
    if (reading.current !== token) return
    reading.current = null
    if (selectionRef.current !== token.selection) return
    if (result.ok) dispatch({ type: 'observed', observation: result.value })
    else dispatch({ type: 'refused', reason: result.reason })
  }, [])

  /** Abandons the running read: it is cancelled and its late result discarded. */
  const abandonRead = useCallback(() => {
    const token = reading.current
    if (token === null) return
    reading.current = null
    window.xidao.subscriptions.cancel({ operationId: token.operationId }).catch(() => undefined)
  }, [])

  /** 停止: cancels queued and later pages; the observation it ends with is still shown. */
  const stopRead = useCallback(() => {
    const token = reading.current
    if (token === null) return
    dispatch({ type: 'stop-requested' })
    window.xidao.subscriptions.cancel({ operationId: token.operationId }).catch(() => undefined)
  }, [])

  useEffect(() => abandonRead, [abandonRead])

  // A new selection (first known, source switch, UUID or binding change) starts over with whatever
  // is stored for it; only explicit navigation or a switch made here reads page 1 by itself.
  useEffect(() => {
    const current = overviewRef.current
    if (selection === null || current === null) return
    // Consumed only when the read starts, so an effect replay (StrictMode) cannot lose it.
    const shouldRead = autoRead.current
    if (stateRef.current.selection === selection && !shouldRead) return
    abandonRead()
    dispatch({ type: 'reset', selection })
    dispatch({ type: 'start', activity: 'stored' })
    let alive = true
    const source = current.source
    window.xidao.subscriptions
      .getObservation({ source })
      .then(
        (observation) => {
          if (alive && selectionRef.current === selection) dispatch({ type: 'stored', observation })
        },
        () => {
          if (alive && selectionRef.current === selection) dispatch({ type: 'internal', where: 'stored' })
        }
      )
      .finally(() => {
        if (!alive || selectionRef.current !== selection) return
        const latest = overviewRef.current
        if (!shouldRead || latest === null || sourceBlocker(latest, latest.source) !== null) return
        autoRead.current = false
        void read(null)
      })
    return () => {
      alive = false
    }
  }, [selection, abandonRead, read])

  const refresh = useCallback(() => {
    abandonRead()
    void read(null)
  }, [abandonRead, read])
  // Ctrl/Cmd+R in 同步与合并 only re-reads local history: a preview is always started explicitly.
  useRegisterContent('lists', entryKey, { refresh: view === 'reconcile' ? () => void refreshPlans() : refresh })

  const [switching, setSwitching] = useState<SubscriptionSource | null>(null)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const switchSource = async (source: SubscriptionSource) => {
    if (overview === null || switching !== null || source === overview.source) return
    setSwitching(source)
    setSwitchError(null)
    try {
      const result = await window.xidao.subscriptions.selectSource({ source })
      if (result.ok) {
        autoRead.current = true
        applyOverview(result.value)
      } else setSwitchError(`未切换：${failureText(result.reason)}`)
    } catch {
      setSwitchError('切换请求失败，未切换，请重试')
    } finally {
      setSwitching(null)
    }
  }

  // ---------- Scroll memory (same approach as the forum list) ----------
  const scrollRef = useRef<HTMLDivElement>(null)
  const scrollTop = useRef(remembered?.scrollTop ?? 0)
  useLayoutEffect(() => {
    registry?.listMemory.set(entryKey, { kind: 'subscriptions', state, scrollTop: scrollTop.current, view })
  })
  // The scroller exists only once the overview is known (the loading view has none).
  const overviewKnown = overview !== null
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scroller === null) return
    let hidden = true
    const observer = new ResizeObserver(() => {
      const shown = scroller.clientHeight > 0
      if (shown && hidden && scroller.scrollTop !== scrollTop.current) scroller.scrollTop = scrollTop.current
      hidden = !shown
    })
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [overviewKnown])
  const onScroll = () => {
    const scroller = scrollRef.current
    if (scroller === null || scroller.clientHeight === 0) return
    scrollTop.current = scroller.scrollTop
    registry?.listMemory.set(entryKey, { kind: 'subscriptions', state: stateRef.current, scrollTop: scrollTop.current, view })
  }

  // ---------- Displayed list ----------
  const displayed = displayedObservation(state)
  const threads = useMemo(() => {
    const seen = new Map<string, ThreadSummary>()
    for (const page of displayed?.pages ?? []) for (const thread of page.threads) if (!seen.has(thread.head.id)) seen.set(thread.head.id, thread)
    return [...seen.values()]
  }, [displayed])
  const ids = useMemo(() => threads.map((thread) => thread.head.id), [threads])
  const roving = useRovingFocus(ids, selectedThreadId)

  // ---------- Explicit writes ----------
  const [draft, setDraft] = useState<ChangeDraft | null>(null)
  const draftOpener = useRef<HTMLElement | null>(null)
  const confirmCancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (draft !== null) confirmCancelRef.current?.focus()
  }, [draft])

  const openDraft = (action: SubscriptionAction, threadId: ThreadId, label: string) => {
    if (overview === null || selection === null) return
    draftOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setDraft({
      action,
      threadId,
      label,
      source: overview.source,
      generation: overview.context.generation,
      selection,
      objectRef: sourceObjectRef(overview.context, overview.source),
      identity: identityLine(overview)
    })
  }

  const closeDraft = () => {
    setDraft(null)
    const opener = draftOpener.current
    draftOpener.current = null
    if (opener?.isConnected) opener.focus()
    else scrollRef.current?.focus()
  }

  const confirmDraft = () => {
    if (draft === null) return
    const request = draft
    closeDraft()
    void change({
      source: request.source,
      threadId: request.threadId,
      action: request.action,
      expectedGeneration: request.generation,
      label: request.label
    })
  }

  const blocker = overview === null ? null : sourceBlocker(overview, overview.source)
  const writeBlocked = overview === null || blocker !== null || !overview.writable || busy
  const writeHint = busy
    ? '另一项订阅操作、同步预览或计划正在进行，完成后才能开始新的操作'
    : overview !== null && !overview.writable
      ? '本地存储不可写，无法保存操作意图'
      : blocker
  const taskHint =
    task === null || task.phase === 'preview-failed'
      ? '预览两端差异后逐项确认，或从旧 UUID 合并'
      : task.phase === 'previewing'
        ? '预览正在读取'
        : task.phase === 'preview'
          ? '有一份尚未执行的预览'
          : task.phase === 'executing'
            ? '计划正在执行'
            : '计划已结束，可查看结果'

  const labelOf = (threadId: ThreadId) => {
    const thread = threads.find((item) => item.head.id === threadId)
    return thread === undefined ? `No.${threadId}` : threadLabel(thread)
  }

  // ---------- Render ----------
  if (overview === null) {
    return (
      <section className="list-pane" aria-label="订阅">
        <div className="pane-empty">
          {overviewFailed ? (
            <FailureNotice title="订阅设置读取失败" failure={{ type: 'internal' }} onRetry={() => void refreshOverview()} />
          ) : (
            <Loading>正在读取订阅设置…</Loading>
          )}
        </div>
      </section>
    )
  }

  const source = overview.source
  const shown = state.shown
  const readInFlight = state.activity === 'first' || state.activity === 'next'
  const endPage = displayed?.pages.find((page) => page.endCandidate)?.page ?? null
  const nextPage = shown !== null && shown.error === null && !readInFlight && blocker === null ? shown.nextPage : null

  return (
    <section className="list-pane sub-pane" aria-label={`订阅：${SOURCE_NAME[source]}`}>
      <div
        className="list-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        tabIndex={-1}
        data-pane-focus={view === 'list' ? '' : undefined}
        hidden={view !== 'list'}
      >
        <header className="list-header">
          <div className="list-title-row">
            <h2 className="list-title">
              <span className="list-kind">订阅</span>
              <span className="list-name">{SOURCE_NAME[source]}</span>
            </h2>
            <button
              type="button"
              className="icon-btn"
              onClick={refresh}
              disabled={blocker !== null}
              aria-label="刷新订阅（重新从第 1 页读取）"
              title="刷新订阅"
            >
              <Icon name="refresh" />
            </button>
          </div>
          <div className="sub-source-row">
            <div className="segmented" role="group" aria-label="订阅来源">
              {(['app', 'web'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  className="segmented-item"
                  aria-pressed={source === item}
                  aria-busy={switching === item ? true : undefined}
                  disabled={!overview.writable}
                  onClick={() => void switchSource(item)}
                >
                  {SOURCE_SHORT[item]}
                </button>
              ))}
            </div>
            <p className="sub-identity">{identityLine(overview)}</p>
          </div>
          {switchError !== null && (
            <p className="form-message is-error" role="status">
              <Icon name="alert" size={14} />
              <span>{switchError}</span>
            </p>
          )}
        </header>

        <div className="sub-tools">
          {blocker !== null && (
            <div className="notice notice-cached" role="status">
              <Icon name="alert" className="notice-icon" />
              <div className="notice-text">
                <p className="notice-title">{SOURCE_NAME[source]}暂时无法读取或更改</p>
                <p>{blocker}</p>
              </div>
              {openSettings !== null && (
                <button type="button" className="btn btn-small" onClick={openSettings}>
                  打开设置
                </button>
              )}
            </div>
          )}

          <WriteStatus />

          <div className="sub-recon-entry">
            <button type="button" className="btn btn-small" ref={reconcileButtonRef} onClick={() => showView('reconcile')}>
              同步与合并…
            </button>
            <span className="field-hint">{taskHint}</span>
          </div>

          {draft !== null && (
            <ChangeConfirm
              draft={draft}
              stale={draft.selection !== selection}
              blockedReason={
                busy
                  ? '另一项订阅操作、同步预览或计划正在进行'
                  : operations?.some((item) =>
                        blocksNewWrite(item, { source: draft.source, objectRef: draft.objectRef, threadId: draft.threadId })
                      )
                    ? '这个串还有未核对的操作，请先在操作记录中核对'
                    : null
              }
              cancelRef={confirmCancelRef}
              onConfirm={confirmDraft}
              onCancel={closeDraft}
            />
          )}

          <AddForm
            disabled={writeBlocked || draft !== null}
            hint={writeHint}
            currentThreadId={selectedThreadId}
            onAdd={(threadId) => openDraft('add', threadId, labelOf(threadId))}
          />

          <OperationJournal />
        </div>

        <div className="list-status">
          {state.activity === 'stored' && <Loading>正在读取本机保存的观察…</Loading>}
          {state.activity === 'first' && (
            <div className="sub-reading">
              <Loading>正在读取第 1 页…</Loading>
              <button type="button" className="btn btn-small" onClick={stopRead} disabled={state.stopRequested}>
                {state.stopRequested ? '正在停止…' : '停止读取'}
              </button>
            </div>
          )}
          {state.internalError !== null && (
            <FailureNotice
              title={state.internalError === 'stored' ? '本机保存的观察读取失败' : '订阅读取请求失败，仍显示之前的列表'}
              failure={{ type: 'internal' }}
              onRetry={
                state.internalError === 'read' && blocker === null
                  ? () => void read(shown !== null && shown.nextPage !== null ? shown.id : null)
                  : undefined
              }
              compact
            />
          )}
          {state.refusal !== null && (
            <div className="notice notice-error is-compact" role="alert">
              <Icon name="alert" className="notice-icon" />
              <p className="notice-text">读取未执行：{failureText(state.refusal)}</p>
            </div>
          )}
          {shown !== null && shown.error !== null && (
            <FailureNotice
              title={`读取第 ${shown.error.page} 页失败${displayed !== null ? '，已取得的内容保留' : ''}`}
              failure={{ type: 'read', error: shown.error.detail }}
              onRetry={blocker === null && !readInFlight ? () => void read(shown.id) : undefined}
              retryLabel={`重试第 ${shown.error.page} 页`}
              compact
            />
          )}
          {displayed !== null && displayed !== shown && (
            <div className="notice notice-cached is-compact" role="status">
              <Icon name="archive" className="notice-icon" />
              <p className="notice-text">
                本次没有取得新的列表。下面是 {formatLocalTime(displayed.startedAt)} 开始的较早观察（{coverageText(displayed)}），可能已不是当前状态。
              </p>
            </div>
          )}
          {displayed !== null && displayed === shown && state.shownStored && (
            <p className="notice-inline" role="status">
              <Icon name="archive" size={14} />
              本机保存的观察，{formatLocalTime(displayed.startedAt)} 开始；本次尚未重新读取
            </p>
          )}
          {displayed !== null && (
            <p className={displayed.nextPage !== null ? 'sub-coverage is-partial' : 'sub-coverage'}>
              <Icon name={displayed.nextPage !== null ? 'alert' : 'info'} size={14} />
              <span>
                {coverageText(displayed)}
                {displayed.nextPage !== null && '。只覆盖了部分页，未读取的页里可能还有订阅'}
              </span>
            </p>
          )}
        </div>

        {displayed === null && state.activity === 'idle' && blocker === null && (
          <div className="list-empty">
            <p className="list-empty-title">{shown !== null || state.refusal !== null || state.internalError !== null ? '还没有取得列表' : '还没有读取这份订阅'}</p>
            <p className="list-empty-text">读取只会请求第 1 页；后续页需要再点读取。</p>
            <button type="button" className="btn sub-empty-action" onClick={refresh}>
              读取第 1 页
            </button>
          </div>
        )}

        {displayed !== null && threads.length === 0 && endPage === 1 && (
          <div className="list-empty" role="status">
            <p className="list-empty-title">第 1 页没有订阅</p>
            <p className="list-empty-text">有效的空页只是结束候选，不代表远端一定是空集合。</p>
          </div>
        )}

        {threads.length > 0 && (
          <ul className="thread-list sub-thread-list" aria-label="订阅的串" onKeyDown={roving.onKeyDown}>
            {threads.map((thread) => {
              const itemProps = roving.itemProps(thread.head.id)
              return (
                <li key={thread.head.id} className="sub-row">
                  <ThreadRow
                    thread={thread}
                    forumName={thread.head.forumId !== null ? (forumNames.get(thread.head.forumId) ?? null) : null}
                    selected={thread.head.id === selectedThreadId}
                    onOpen={() => onOpenThread(thread)}
                    itemProps={itemProps}
                  />
                  <button
                    type="button"
                    className="btn btn-small btn-quiet sub-row-action"
                    tabIndex={itemProps.tabIndex}
                    disabled={writeBlocked || draft !== null}
                    onClick={() => openDraft('remove', thread.head.id, threadLabel(thread))}
                    aria-label={`取消订阅 No.${thread.head.id}`}
                  >
                    取消订阅
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        <div className="list-footer">
          {state.activity === 'next' && (
            <div className="sub-reading">
              <Loading>正在读取第 {shown?.nextPage ?? ''} 页…</Loading>
              <button type="button" className="btn btn-small" onClick={stopRead} disabled={state.stopRequested}>
                {state.stopRequested ? '正在停止…' : '停止读取'}
              </button>
            </div>
          )}
          {shown !== null && shown.cancelled && !readInFlight && (
            <p className="list-end">已停止，第 {shown.nextPage ?? ''} 页起没有读取</p>
          )}
          {endPage !== null && endPage > 1 && (
            <p className="list-end">第 {endPage} 页为空，列表可能到此为止（结束候选，不保证是同一时刻的完整快照）</p>
          )}
          {shown !== null && nextPage !== null && (
            <button type="button" className="btn btn-quiet" onClick={() => void read(shown.id)}>
              {shown.cancelled ? '继续读取' : '读取'}第 {nextPage} 页
            </button>
          )}
        </div>
      </div>
      {view === 'reconcile' && (
        <div className="list-scroll" tabIndex={-1} data-pane-focus="">
          <ReconcileView headingRef={reconcileHeadingRef} onBack={() => showView('list')} />
        </div>
      )}
    </section>
  )
}

function ChangeConfirm({
  draft,
  stale,
  blockedReason,
  cancelRef,
  onConfirm,
  onCancel
}: {
  draft: ChangeDraft
  stale: boolean
  blockedReason: string | null
  cancelRef: RefObject<HTMLButtonElement | null>
  onConfirm: () => void
  onCancel: () => void
}) {
  const titleId = useId()
  const textId = useId()
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onCancel()
  }
  const reason = stale ? '订阅来源或身份已变化，这个确认已失效，请重新发起' : blockedReason
  const label = draft.label === `No.${draft.threadId}` ? '' : `「${draft.label}」`
  return (
    <div className={draft.action === 'remove' ? 'sub-confirm is-remove' : 'sub-confirm'} role="group" aria-labelledby={titleId} aria-describedby={textId} onKeyDown={onKeyDown}>
      <p className="sub-confirm-title" id={titleId}>
        {ACTION_NAME[draft.action]}：No.{draft.threadId}
        {label}
      </p>
      <div className="sub-confirm-text" id={textId}>
        <p>
          向{SOURCE_NAME[draft.source]}发出一次请求（{draft.identity}）。
        </p>
        <p>先在本机保存这次意图再发出；不会自动重试，也不会撤回。服务端报告与回读核对分别记录，报告成功不等于集合一定改变。</p>
      </div>
      {reason !== null && (
        <p className="field-warning">
          <Icon name="alert" size={14} />
          <span>{reason}</span>
        </p>
      )}
      <div className="credential-confirm-actions">
        <button
          type="button"
          className={draft.action === 'remove' ? 'btn btn-small btn-danger' : 'btn btn-small btn-primary'}
          onClick={onConfirm}
          disabled={reason !== null}
        >
          确认{ACTION_NAME[draft.action]}
        </button>
        <button type="button" ref={cancelRef} className="btn btn-small" onClick={onCancel}>
          返回
        </button>
      </div>
    </div>
  )
}

function AddForm({
  disabled,
  hint,
  currentThreadId,
  onAdd
}: {
  disabled: boolean
  hint: string | null
  currentThreadId: ThreadId | null
  onAdd: (threadId: ThreadId) => void
}) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const inputId = useId()
  const hintId = useId()
  const errorId = useId()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (disabled) return
    const threadId = value.trim().replace(/^No\./i, '')
    if (!THREAD_ID.test(threadId)) {
      setError('请输入串号（只含数字，例如 50000001）')
      return
    }
    setError(null)
    setValue('')
    onAdd(threadId)
  }

  const describedBy = [hintId, error !== null ? errorId : null].filter(Boolean).join(' ')

  return (
    <form className="sub-add" onSubmit={submit} noValidate>
      <label className="field-label" htmlFor={inputId}>
        按串号加入订阅
      </label>
      <div className="sub-add-row">
        <input
          id={inputId}
          className="text-input"
          value={value}
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder="串号"
          onChange={(event) => {
            setValue(event.target.value)
            if (error !== null) setError(null)
          }}
          aria-invalid={error !== null ? true : undefined}
          aria-describedby={describedBy}
        />
        <button type="submit" className="btn btn-small" disabled={disabled}>
          加入…
        </button>
        {currentThreadId !== null && (
          <button type="button" className="btn btn-small" disabled={disabled} onClick={() => onAdd(currentThreadId)}>
            加入当前串 No.{currentThreadId}…
          </button>
        )}
      </div>
      <p className="field-hint" id={hintId}>
        {hint ?? '确认前会显示将使用的来源与身份；每次只操作一个串。'}
      </p>
      <div id={errorId} role="status" className="form-message-region">
        {error !== null && (
          <p className="form-message is-error">
            <Icon name="alert" size={14} />
            <span>{error}</span>
          </p>
        )}
      </div>
    </form>
  )
}
