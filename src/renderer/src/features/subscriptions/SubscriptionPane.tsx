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
  type MouseEvent as ReactMouseEvent
} from 'react'
import type { ForumId, ThreadId, ThreadSummary } from '../../../../shared/forum'
import type { ContentFilters } from '../../../../shared/search'
import type {
  SubscriptionAction,
  SubscriptionMergeSource,
  SubscriptionObservation,
  SubscriptionOperation,
  SubscriptionOverview,
  SubscriptionResult,
  SubscriptionSource
} from '../../../../shared/subscriptions'
import { ContextMenu, contextMenuPoint, isContextMenuKey, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { selectionCopyItem } from '../../components/copyMenuItems'
import { Icon } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { RefreshIcon, useRefreshTurn } from '../../components/RefreshIcon'
import { FailureNotice } from '../../components/Notices'
import { describeReadError, meaningfulTitle } from '../../lib/format'
import { useSettingsOpener } from '../../lib/settingsOpener'
import { useRovingFocus } from '../../lib/useRovingFocus'
import { ThreadRow } from '../feed/ThreadRow'
import { useImageScope } from '../image/useImageLoad'
import { useListImageViewer } from '../image/useListImageViewer'
import { ListFilterPanel, ListFilterToggle, useListFilter } from '../search/FilterFields'
import { contentFilterCount, filterList, headMeta } from '../search/listFilters'
import { NO_CONTENT_FILTERS } from '../search/searchState'
import { ContentRegistryContext, useRegisterContent } from '../tabs/contentRegistry'
import { useOpenThreadInTab } from '../tabs/openThreadInTab'
import { UnsettledLine, unsettledEntryOf, unsettledText, WriteStatus } from './SubscriptionActivity'
import { previewBlocker, plansNeedingAttention, ReconcileHistoryDialog, ReconcileResult, ReconcileView } from './SubscriptionReconcile'
import { taskMode, type ReconcileMode } from './reconcileState'
import { SubscriptionRowMenu } from './SubscriptionRowMenu'
import { useSubscriptionOffline } from './SubscriptionOffline'
import {
  decideChange,
  displayedObservation,
  initialSubscriptionListState,
  isReconcilable,
  selectionKey,
  sourceObjectRef,
  subscriptionListReducer,
  type SubscriptionListState
} from './subscriptionListState'
import { SOURCE_NAME, SOURCE_SHORT, failureText, sourceBlocker, threadLabel } from './subscriptionText'
import { useSubscriptionsContext, type WriteNotice } from './useSubscriptions'
import { useThreadRules } from '../reminders/useReminders'
import '../feed/feed.css'
import '../identity/identity.css'
import './subscriptions.css'

const THREAD_ID = /^\d{1,20}$/

/** Fired after any page of a subscription list was read, so other views can re-read the stored observation. */
export const SUBSCRIPTION_OBSERVED_EVENT = 'xidao:subscription-observed'

/** An unsettled write shown under 加入: the thread, and the collection when it is not the one shown. */
function elsewhereText(operation: SubscriptionOperation, overview: SubscriptionOverview, objectRef: string | null): string {
  const other =
    operation.source !== overview.source
      ? SOURCE_NAME[operation.source]
      : sourceObjectRef(operation.context, operation.source) !== objectRef
        ? operation.source === 'app'
          ? '之前的 App UUID'
          : '之前的网页同步对象'
        : null
  return `${unsettledText(operation)}：${other === null ? '' : `${other} · `}No.${operation.threadId}`
}

/**
 * Remote subscription list of the currently selected source (App / 网页), in the tab's list slot.
 * Reads when the user navigates here or switches source here: page after page up to the end
 * candidate, silently, stopping at the first error or refusal and never retrying by itself. Old
 * observations stay on screen when a read fails, is cancelled or is partial; results arriving for a
 * previous source or identity combination are dropped.
 */
export function SubscriptionPane({
  entryKey,
  pageDisplayed,
  forumNames,
  selectedThreadId,
  onOpenThread
}: {
  entryKey: number
  pageDisplayed: boolean
  forumNames: ReadonlyMap<ForumId, string>
  selectedThreadId: string | null
  onOpenThread: (thread: ThreadSummary) => void
}) {
  const subscriptions = useSubscriptionsContext()
  const { overview, overviewFailed, refreshOverview, applyOverview, operations, active, change, busy, task, plans, startPreview, dismissTask, revealSeq, claimReveal } =
    subscriptions
  const openSettings = useSettingsOpener()
  const openInTab = useOpenThreadInTab()
  const registry = useContext(ContentRegistryContext)
  const [remembered] = useState(() => {
    const memory = registry?.listMemory.get(entryKey)
    return memory?.kind === 'subscriptions' ? memory : null
  })
  const [saved] = useState(() => remembered === null ? registry?.savedLists.get(entryKey) : undefined)
  /**
   * 同步与合并 replaces the list in this pane; the list stays mounted (hidden) with its scroll position.
   * Previews live in this process only: a restored pane without one shows its list.
   */
  const [view, setView] = useState<'list' | 'reconcile'>(() =>
    (remembered?.view ?? saved?.subscriptionView) === 'reconcile' && task !== null ? 'reconcile' : 'list'
  )
  const paneRef = useRef<HTMLElement>(null)
  const reconcileHeadingRef = useRef<HTMLHeadingElement>(null)
  const reconcileButtonRef = useRef<HTMLButtonElement>(null)
  const viewFocus = useRef(false)
  useLayoutEffect(() => {
    if (!viewFocus.current) return
    viewFocus.current = false
    if (view === 'reconcile') reconcileHeadingRef.current?.focus()
    else reconcileButtonRef.current?.focus()
  }, [view])
  /** `focus`: move focus to the new view (an explicit switch, or focus was in the view going away). */
  const showView = (next: 'list' | 'reconcile', focus = true) => {
    viewFocus.current = focus
    setView(next)
  }

  /** 同步与合并: a running preview or plan is shown as it is; otherwise a fresh sync preview starts at once. */
  const openReconcile = () => {
    if (task?.phase !== 'previewing' && task?.phase !== 'executing') {
      dismissTask()
      if (overview !== null && previewBlocker(overview, 'sync') === null) void startPreview('sync', null)
    }
    showView('reconcile')
  }
  const restartPreview = (mode: ReconcileMode, mergeSource: SubscriptionMergeSource | null) => {
    if (overview === null || busy || previewBlocker(overview, mode) !== null) return
    void startPreview(mode, mergeSource)
  }
  /** 返回列表: an unexecuted preview is dropped (its reads stop); a running plan goes on. */
  const leaveReconcile = () => {
    dismissTask()
    showView('list')
  }

  // An entry elsewhere (设置 › 订阅 › 从旧 UUID 合并…) started a preview: the first visible pane shows it.
  useLayoutEffect(() => {
    if (revealSeq === 0 || paneRef.current === null || paneRef.current.offsetParent === null) return
    if (claimReveal(revealSeq)) showView('reconcile')
  }, [revealSeq, claimReveal])

  // A plan that finished returns this pane to its list, where the one-line result shows. The plan
  // may have changed both collections, so the list it returns to is read again.
  const phase = task?.phase ?? null
  const lastPhase = useRef(phase)
  const refreshRef = useRef<() => void>(() => undefined)
  useLayoutEffect(() => {
    const previous = lastPhase.current
    lastPhase.current = phase
    if (previous !== 'executing' || phase !== 'finished' || view !== 'reconcile') return
    const focused = document.activeElement
    const focusWasHere = focused === null || focused === document.body || paneRef.current?.contains(focused) === true
    showView('list', focusWasHere)
    if (task?.phase === 'finished' && task.outcome.type === 'plan') refreshRef.current()
  }, [phase, view])

  /** 同步记录 (更多 menu, or 查看 on a result): the plan to open in it, or null for the list only. */
  const [history, setHistory] = useState<{ planId: string | null } | null>(null)
  const [moreAt, setMoreAt] = useState<ContextMenuPoint | null>(null)
  const moreRef = useRef<HTMLButtonElement>(null)
  const [state, dispatch] = useReducer(
    subscriptionListReducer,
    remembered?.state ?? initialSubscriptionListState,
    (start: SubscriptionListState): SubscriptionListState => ({ ...start, activity: 'idle', stopRequested: false })
  )
  /** This view's filters; kept across source switches, never resetting the thread being read. */
  const [filters, setFilters] = useState<ContentFilters>(() => remembered?.filters ?? NO_CONTENT_FILTERS)
  const filtersRef = useRef(filters)
  const filter = useListFilter(filters, setFilters)

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
  const autoRead = useRef(remembered === null && saved === undefined)

  /** One page; resolves to the observation it produced, or null when refused, failed or stale. */
  const read = useCallback(async (observationId: string | null): Promise<SubscriptionObservation | null> => {
    const current = overviewRef.current
    if (current === null || reading.current !== null) return null
    const token = { operationId: crypto.randomUUID(), selection: selectionKey(current) }
    reading.current = token
    dispatch({ type: 'start', activity: observationId === null ? 'first' : 'next' })
    let result: SubscriptionResult<SubscriptionObservation>
    try {
      result = await window.xidao.subscriptions.read({ source: current.source, observationId, operationId: token.operationId })
    } catch {
      if (reading.current !== token) return null
      reading.current = null
      dispatch({ type: 'internal', where: 'read' })
      return null
    }
    if (reading.current !== token) return null
    reading.current = null
    if (selectionRef.current !== token.selection) return null
    if (!result.ok) {
      dispatch({ type: 'refused', reason: result.reason })
      return null
    }
    dispatch({ type: 'observed', observation: result.value })
    window.dispatchEvent(new Event(SUBSCRIPTION_OBSERVED_EVENT))
    return result.value
  }, [])

  /**
   * Reads from `observationId` (null: a new observation from page 1), page after page until the
   * end candidate; stops at the first error (rate limit and verification included), refusal,
   * cancellation or source change. Nothing is retried automatically.
   */
  const readOn = useCallback(
    async (observationId: string | null) => {
      let next = observationId
      for (;;) {
        const observation = await read(next)
        if (observation === null) return
        if (observation.error !== null || observation.cancelled || observation.nextPage === null) return
        next = observation.id
      }
    },
    [read]
  )

  /** Abandons the running read: it is cancelled and its late result discarded. */
  const abandonRead = useCallback(() => {
    const token = reading.current
    if (token === null) return
    reading.current = null
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
        void readOn(null)
      })
    return () => {
      alive = false
    }
  }, [selection, abandonRead, readOn])

  const refresh = useCallback(() => {
    abandonRead()
    void readOn(null)
  }, [abandonRead, readOn])
  refreshRef.current = () => {
    const latest = overviewRef.current
    if (latest !== null && sourceBlocker(latest, latest.source) === null) refresh()
  }
  // Ctrl/Cmd+R in 同步与合并 reads a fresh preview (never while a preview is read or a plan runs).
  useRegisterContent('lists', entryKey, {
    refresh: view === 'reconcile' ? () => restartPreview(task === null ? 'sync' : taskMode(task), task?.mergeSource ?? null) : refresh
  })

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
      setSwitchError('切换失败，未切换')
    } finally {
      setSwitching(null)
    }
  }

  // ---------- Scroll memory (same approach as the forum list) ----------
  const scrollRef = useRef<HTMLDivElement>(null)
  const { images, open: viewerOpen, viewer } = useListImageViewer(useImageScope(scrollRef), scrollRef)
  const scrollTop = useRef(remembered?.scrollTop ?? saved?.scrollTop ?? 0)
  useLayoutEffect(() => {
    filtersRef.current = filters
    registry?.listMemory.set(entryKey, { kind: 'subscriptions', state, scrollTop: scrollTop.current, view, filters })
    if (state.activity === 'idle' && state.selection !== null) registry?.savedLists.delete(entryKey)
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
    registry?.listMemory.set(entryKey, {
      kind: 'subscriptions',
      state: stateRef.current,
      scrollTop: scrollTop.current,
      view,
      filters: filtersRef.current
    })
  }

  // ---------- Displayed list ----------
  const displayed = displayedObservation(state)
  const threads = useMemo(() => {
    const seen = new Map<string, ThreadSummary>()
    for (const page of displayed?.pages ?? []) for (const thread of page.threads) if (!seen.has(thread.head.id)) seen.set(thread.head.id, thread)
    return [...seen.values()]
  }, [displayed])
  const filtered = useMemo(() => filterList(threads, (thread) => headMeta(thread.head), filters), [threads, filters])
  const filtering = contentFilterCount(filters) > 0
  const uncertainById = useMemo(() => new Map(filtered.shown.map(({ item, uncertain }) => [item.head.id, uncertain])), [filtered])
  const ids = useMemo(() => filtered.shown.map(({ item }) => item.head.id), [filtered])
  const roving = useRovingFocus(ids, selectedThreadId)
  const rules = useThreadRules(ids)

  // ---------- Explicit writes ----------
  /** A press of 加入／取消订阅 writes at once: no confirmation, never retried, reminders untouched. */
  const decide = (action: SubscriptionAction, threadId: ThreadId, label: string) =>
    decideChange({ overview, operations, busy, action, threadId, label, unresolved: '这个串的上次操作待核对' })
  /** Sends the write; returns why the press could not start, or null once sent. */
  const writeNow = (action: SubscriptionAction, threadId: ThreadId, label: string): string | null => {
    const decision = decide(action, threadId, label)
    if (decision.kind === 'blocked') return decision.reason
    void change(decision.request)
    return null
  }

  /**
   * Unsettled writes, each shown once where it belongs: in its row when the thread is listed, else
   * under 加入 (also writes to another source or an earlier UUID / binding). Newest per thread and
   * collection; its 核对订阅 only reads.
   */
  const objectRef = overview === null ? null : sourceObjectRef(overview.context, overview.source)
  const unsettled = useMemo(() => {
    const rows = new Map<ThreadId, SubscriptionOperation>()
    const elsewhere: SubscriptionOperation[] = []
    const seen = new Set<string>()
    const listed = new Set(ids)
    for (const operation of operations ?? []) {
      if (!isReconcilable(operation, active)) continue
      const ref = sourceObjectRef(operation.context, operation.source)
      const key = `${operation.source}|${ref ?? '-'}|${operation.threadId}`
      if (seen.has(key)) continue
      seen.add(key)
      const viewed = overview !== null && operation.source === overview.source && ref === objectRef
      if (viewed && listed.has(operation.threadId)) rows.set(operation.threadId, operation)
      else elsewhere.push(operation)
    }
    return { rows, elsewhere }
  }, [operations, active, overview, objectRef, ids])
  /** A finished write whose unsettled entry is already shown in place is not repeated above. */
  const placed = (notice: WriteNotice) => {
    const entry = unsettledEntryOf(notice, operations, active)
    return entry !== null && (unsettled.rows.get(entry.threadId)?.id === entry.id || unsettled.elsewhere.some((item) => item.id === entry.id))
  }

  const blocker = overview === null ? null : sourceBlocker(overview, overview.source)
  const writeBlocked = overview === null || blocker !== null || !overview.writable || busy
  const writeHint = busy
    ? '另一项订阅操作正在进行'
    : overview !== null && !overview.writable
      ? '本地存储不可写'
      : blocker
  const taskHint = task?.phase === 'previewing' ? '预览读取中' : task?.phase === 'executing' ? '同步执行中' : null
  const attention = plansNeedingAttention(plans)

  const labelOf = (threadId: ThreadId) => {
    const thread = threads.find((item) => item.head.id === threadId)
    return thread === undefined ? `No.${threadId}` : threadLabel(thread)
  }

  // ---------- Row context menu ----------
  /** The row whose context menu is open, where it opened and the row control focus returns to. */
  const [rowMenu, setRowMenu] = useState<{ threadId: ThreadId; point: ContextMenuPoint; row: HTMLElement; selection: ContextMenuItem | null } | null>(null)
  const openRowMenu = (threadId: ThreadId, event: ReactMouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    const row = event.currentTarget.querySelector<HTMLElement>('[data-roving-item]')
    if (row === null) return
    event.preventDefault()
    const selection = selectionCopyItem(undefined, event.currentTarget)
    // No scrolling into view: a scroll closes the menu that is about to open.
    row.focus({ preventScroll: true })
    setRowMenu({ threadId, point: contextMenuPoint(event, row), row, selection })
  }
  const closeRowMenu = (returnFocus: boolean) => {
    const row = rowMenu?.row
    setRowMenu(null)
    if (returnFocus && row?.isConnected === true) row.focus()
  }
  /** Whether a row event comes from its unsettled line (核对订阅), which is not part of the row's menu or link. */
  const fromInline = (event: { target: EventTarget }) => event.target instanceof Element && event.target.closest('.sub-inline') !== null
  const menuThread = rowMenu === null ? undefined : threads.find((thread) => thread.head.id === rowMenu.threadId)
  const offline = useSubscriptionOffline(pageDisplayed && view === 'list')
  const readInFlight = state.activity === 'first' || state.activity === 'next'
  // Before the early return below: hooks run in the same order on every render.
  const refreshTurn = useRefreshTurn(readInFlight)

  // ---------- Render ----------
  if (overview === null) {
    return (
      <section ref={paneRef} className="list-pane" aria-label="订阅" aria-busy={!overviewFailed || undefined}>
        <div className="pane-empty">
          {overviewFailed && <FailureNotice title="订阅设置读取失败" failure={{ type: 'internal' }} onRetry={() => void refreshOverview()} />}
        </div>
      </section>
    )
  }

  const source = overview.source
  const shown = state.shown
  const endPage = displayed?.pages.find((page) => page.endCandidate)?.page ?? null
  const nextPage = shown !== null && shown.error === null && !readInFlight && blocker === null ? shown.nextPage : null

  return (
    <section ref={paneRef} className="list-pane sub-pane" aria-label={`订阅：${SOURCE_NAME[source]}`}>
      <div
        className="list-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        tabIndex={-1}
        data-pane-focus={view === 'list' ? '' : undefined}
        hidden={view !== 'list'}
        inert={viewerOpen}
      >
        <header className="list-header">
          <div className="list-title-row">
            <h2 className="list-title">
              <span className="list-name">订阅</span>
            </h2>
            <div className="sub-header-tools">
              <button
                type="button"
                className="btn btn-small btn-quiet sub-recon-open"
                ref={reconcileButtonRef}
                onClick={openReconcile}
                title={taskHint ?? undefined}
              >
                同步与合并
                {taskHint !== null && (
                  <>
                    <span className="sub-recon-mark" aria-hidden="true" />
                    <span className="visually-hidden">（{taskHint}）</span>
                  </>
                )}
              </button>
              <div className="segmented sub-source" role="group" aria-label="订阅来源">
                {(['app', 'web'] as const).map((item) => (
                  <button
                    key={item}
                    type="button"
                    className="segmented-item"
                    aria-pressed={source === item}
                    aria-busy={switching === item ? true : undefined}
                    aria-label={SOURCE_NAME[item]}
                    disabled={!overview.writable}
                    onClick={() => void switchSource(item)}
                  >
                    {SOURCE_SHORT[item]}
                  </button>
                ))}
              </div>
              {threads.length > 0 && <ListFilterToggle filter={filter} />}
              <button
                type="button"
                className="icon-btn"
                onClick={() => {
                  if (!refreshTurn.turning) refresh()
                }}
                disabled={blocker !== null}
                aria-label="刷新订阅"
                title="刷新订阅"
                aria-busy={refreshTurn.turning || undefined}
              >
                <RefreshIcon turn={refreshTurn} />
              </button>
              <button
                type="button"
                ref={moreRef}
                className="icon-btn sub-more"
                aria-haspopup="menu"
                aria-expanded={moreAt !== null}
                aria-label={attention > 0 ? '更多（有需要查看的同步记录）' : '更多'}
                title={attention > 0 ? '更多（有需要查看的同步记录）' : '更多'}
                onClick={(event) => {
                  // A press outside the open menu (this one included) has already closed it.
                  const box = event.currentTarget.getBoundingClientRect()
                  setMoreAt({ x: box.right, y: box.bottom + 4, end: true })
                }}
              >
                <Icon name={attention > 0 ? 'alert' : 'more'} />
              </button>
            </div>
          </div>
          {switchError !== null && (
            <p className="form-message is-error" role="status">
              <Icon name="alert" size={14} />
              <span>{switchError}</span>
            </p>
          )}
        </header>

        {threads.length > 0 && (
          <ListFilterPanel
            filter={filter}
            forums={forumNames}
            noun="串"
            total={threads.length}
            result={filtered}
            metadata={null}
            coverage="已读取的订阅页"
          />
        )}

        <div className="sub-tools">
          {blocker !== null && (
            <div className="notice notice-cached is-compact" role="status">
              <Icon name="alert" className="notice-icon" />
              <p className="notice-text">{blocker}</p>
              {openSettings !== null && (
                <button type="button" className="btn btn-small btn-page" onClick={() => openSettings('subscriptions')}>
                  打开设置
                </button>
              )}
            </div>
          )}

          <ReconcileResult displayed={pageDisplayed && view === 'list'} onView={(planId) => setHistory({ planId })} />
          <WriteStatus displayed={pageDisplayed && view === 'list'} placed={placed} />

          <AddForm
            disabled={writeBlocked}
            hint={writeHint}
            currentThreadId={selectedThreadId}
            onAdd={(threadId) => writeNow('add', threadId, labelOf(threadId))}
          />

          {unsettled.elsewhere.length > 0 && (
            <ul className="sub-unsettled" aria-label="待核对的订阅操作">
              {unsettled.elsewhere.map((operation) => (
                <li key={operation.id}>
                  <UnsettledLine operation={operation} text={elsewhereText(operation, overview, objectRef)} />
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Reading is silent (no progress, no coverage); only a failure shows, as one line. */}
        <div className="list-status" aria-busy={readInFlight || state.activity === 'stored' ? true : undefined}>
          {offline.notice}
          {state.internalError !== null && (
            <FailureNotice
              title={state.internalError === 'stored' ? '本机保存的列表读取失败' : '订阅读取失败'}
              failure={{ type: 'internal' }}
              onRetry={
                state.internalError === 'read' && blocker === null
                  ? () => void readOn(shown !== null && shown.nextPage !== null ? shown.id : null)
                  : undefined
              }
              compact
            />
          )}
          {state.refusal !== null && (
            <div className="notice notice-error is-compact" role="alert">
              <Icon name="alert" className="notice-icon" />
              <p className="notice-text">
                读取未执行：{failureText(state.refusal)}
                <KaomojiDecor state="failure" />
              </p>
            </div>
          )}
          {shown !== null && shown.error !== null && (
            <p className="sub-stopped" role="alert">
              <Icon name="alert" size={14} />
              <span>
                第 {shown.error.page} 页读取失败：{describeReadError(shown.error.detail)}
              </span>
              {blocker === null && !readInFlight && (
                <button type="button" className="btn btn-small btn-page" onClick={() => void readOn(shown.id)}>
                  重试
                </button>
              )}
            </p>
          )}
        </div>

        {displayed === null && state.activity === 'idle' && blocker === null && (
          <div className="list-empty">
            <p className="list-empty-title">
              <KaomojiDecor state="subscriptionUnread" above />
              {shown !== null || state.refusal !== null || state.internalError !== null ? '还没有取得列表' : '还没有读取这份订阅'}
            </p>
            <button type="button" className="btn btn-page sub-empty-action" onClick={refresh}>
              读取
            </button>
          </div>
        )}

        {displayed !== null && threads.length === 0 && endPage === 1 && (
          <div className="list-empty" role="status">
            <p className="list-empty-title">
              <KaomojiDecor state="subscriptionsEmpty" above />
              没有订阅
            </p>
          </div>
        )}

        {threads.length > 0 && (
          <ul className="thread-list sub-thread-list" aria-label={filtering ? '订阅（已筛选）' : '订阅'} onKeyDown={roving.onKeyDown}>
            {filtered.shown.map(({ item: thread }) => {
              const itemProps = roving.itemProps(thread.head.id)
              const entry = unsettled.rows.get(thread.head.id)
              // 在新标签页打开, 提醒 and 取消订阅 live in the row's context menu (right-click,
              // ContextMenu, Shift+F10); middle-click or Ctrl/Cmd+click opens a new tab, as in a forum
              // list. The unsettled line under the row keeps its own clicks and keys.
              return (
                <li
                  key={thread.head.id}
                  className={rowMenu?.threadId === thread.head.id ? 'sub-row is-menu-open' : 'sub-row'}
                  onContextMenu={(event) => {
                    if (!fromInline(event)) openRowMenu(thread.head.id, event)
                  }}
                  onKeyDown={(event) => {
                    if (isContextMenuKey(event) && !fromInline(event)) openRowMenu(thread.head.id, event)
                  }}
                  onClickCapture={(event) => {
                    if (openInTab === null || (!event.ctrlKey && !event.metaKey) || fromInline(event)) return
                    event.preventDefault()
                    event.stopPropagation()
                    openInTab(thread.head.id, thread.head)
                  }}
                  // Middle press: no autoscroll; the release opens the tab.
                  onMouseDown={(event) => {
                    if (openInTab !== null && event.button === 1 && !fromInline(event)) event.preventDefault()
                  }}
                  onAuxClick={(event) => {
                    if (openInTab === null || event.button !== 1 || fromInline(event)) return
                    event.preventDefault()
                    openInTab(thread.head.id, thread.head)
                  }}
                >
                  <ThreadRow
                    thread={thread}
                    forumName={thread.head.forumId !== null ? (forumNames.get(thread.head.forumId) ?? null) : null}
                    selected={thread.head.id === selectedThreadId}
                    uncertain={uncertainById.get(thread.head.id) === true}
                    images={images}
                    onOpen={() => onOpenThread(thread)}
                    itemProps={itemProps}
                  />
                  {entry !== undefined && <UnsettledLine operation={entry} tabIndex={itemProps.tabIndex} />}
                </li>
              )
            })}
          </ul>
        )}
        {filtering && threads.length > 0 && filtered.shown.length === 0 && (
          <p className="list-filters-empty" role="status">
            已读取的订阅都不符合筛选。
            <KaomojiDecor state="filteredOut" />
          </p>
        )}

        <div className="list-footer">
          {shown !== null && nextPage !== null && (
            <button type="button" className="btn btn-quiet" onClick={() => void readOn(shown.id)}>
              继续读取（第 {nextPage} 页起）
            </button>
          )}
        </div>
      </div>
      {viewer}
      {view === 'reconcile' && (
        <ReconcileView
          displayed={pageDisplayed}
          headingRef={reconcileHeadingRef}
          forumNames={forumNames}
          selectedThreadId={selectedThreadId}
          onOpenThread={onOpenThread}
          onRestart={restartPreview}
          onBack={leaveReconcile}
        />
      )}
      {moreAt !== null && (
        <ContextMenu
          point={moreAt}
          label="更多"
          items={[
            {
              type: 'action',
              key: 'history',
              label: attention > 0 ? `同步记录（${attention} 份需要查看）` : '同步记录',
              onSelect: () => setHistory({ planId: null })
            }
          ]}
          onClose={(returnFocus) => {
            setMoreAt(null)
            if (returnFocus) moreRef.current?.focus()
          }}
        />
      )}
      {history !== null && (
        <ReconcileHistoryDialog focusPlanId={history.planId} onClose={() => setHistory(null)} fallbackFocus={() => moreRef.current} />
      )}
      {rowMenu !== null && menuThread !== undefined && (
        <SubscriptionRowMenu
          key={rowMenu.threadId}
          point={rowMenu.point}
          row={rowMenu.row}
          threadId={rowMenu.threadId}
          head={menuThread.head}
          selection={rowMenu.selection}
          label={threadLabel(menuThread)}
          rules={rules.rulesOf(rowMenu.threadId)}
          failure={rules.failure}
          onRetry={rules.reload}
          onUpdated={rules.updated}
          removeBlocked={(() => {
            const decision = decide('remove', rowMenu.threadId, threadLabel(menuThread))
            return decision.kind === 'blocked' ? decision.reason : null
          })()}
          onRemove={() => void writeNow('remove', rowMenu.threadId, threadLabel(menuThread))}
          onOfflineSave={() =>
            offline.open({
              threadId: rowMenu.threadId,
              label: meaningfulTitle(menuThread.head.title) ?? `No.${rowMenu.threadId}`,
              row: rowMenu.row
            })
          }
          onClose={closeRowMenu}
        />
      )}
      {offline.dialogs}
    </section>
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
  /** Starts the write; returns why it could not start, if it could not. */
  onAdd: (threadId: ThreadId) => string | null
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
    const blocked = onAdd(threadId)
    if (blocked !== null) {
      setError(blocked)
      return
    }
    setError(null)
    setValue('')
  }

  const describedBy = [hint !== null ? hintId : null, error !== null ? errorId : null].filter(Boolean).join(' ') || undefined

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
        {/* Unavailable stays focusable (focus is kept while the write runs); `submit` refuses it, so a
            click, Enter or Space on it and Enter in the field all do nothing then. */}
        <button type="submit" className="btn btn-small btn-page" aria-disabled={disabled || undefined} aria-describedby={hint !== null ? hintId : undefined}>
          加入
        </button>
        {currentThreadId !== null && (
          <button
            type="button"
            className="btn btn-small btn-page"
            aria-disabled={disabled || undefined}
            aria-describedby={hint !== null ? hintId : undefined}
            onClick={() => {
              if (disabled) return
              const blocked = onAdd(currentThreadId)
              setError(blocked)
            }}
          >
            加入当前串 No.{currentThreadId}
          </button>
        )}
      </div>
      {hint !== null && (
        <p className="field-hint" id={hintId}>
          {hint}
        </p>
      )}
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
