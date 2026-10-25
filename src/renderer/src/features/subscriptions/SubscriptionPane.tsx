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
  type MouseEvent as ReactMouseEvent,
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
import { contextMenuPoint, isContextMenuKey, type ContextMenuPoint } from '../../components/ContextMenu'
import { Icon } from '../../components/Icon'
import { FailureNotice, Loading } from '../../components/Notices'
import { describeReadError, formatLocalTime } from '../../lib/format'
import { useSettingsOpener } from '../../lib/settingsOpener'
import { useRovingFocus } from '../../lib/useRovingFocus'
import { ThreadRow } from '../feed/ThreadRow'
import { useImageScope } from '../image/useImageLoad'
import { ListFilterBar } from '../search/FilterFields'
import { filterList, headMeta, listFilterCount, NO_LIST_FILTERS, type ListFilters } from '../search/listFilters'
import { useThreadMetadata } from '../search/useThreadMetadata'
import { ContentRegistryContext, useRegisterContent } from '../tabs/contentRegistry'
import { OperationJournal, WriteStatus } from './SubscriptionActivity'
import { ReconcileView } from './SubscriptionReconcile'
import { SubscriptionRowMenu } from './SubscriptionRowMenu'
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
import { askedThreads, ReminderChoiceField, useReminderAsk, type ReminderAsk, type ReminderChoice } from '../reminders/ReminderLinkage'
import { ReminderMenu } from '../reminders/ReminderMenu'
import { useThreadRules } from '../reminders/useReminders'
// PROTOTYPE (throwaway): opening the page reads every page (R2-10); no unread filter (#20).
import { PROTOTYPE_ENABLED } from '../directory/prototype/prototypeStore'
import '../feed/feed.css'
import '../identity/identity.css'
import './subscriptions.css'

/** A write the user asked for, frozen with the source and identity combination shown when asked. */
export interface ChangeDraft {
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

/** Fired after any page of a subscription list was read, so other views can re-read the stored observation. */
export const SUBSCRIPTION_OBSERVED_EVENT = 'xidao:subscription-observed'

/** The identity a write to the viewed source uses. Never a secret. */
function identityLine(overview: SubscriptionOverview): string {
  return overview.source === 'app' ? 'App UUID' : `网页同步对象：${webObjectText(overview)}`
}

/** A confirmation draft for one write to the viewed source; null while the overview is unknown. */
export function changeDraft(overview: SubscriptionOverview | null, action: SubscriptionAction, threadId: ThreadId, label: string): ChangeDraft | null {
  if (overview === null) return null
  return {
    action,
    threadId,
    label,
    source: overview.source,
    generation: overview.context.generation,
    selection: selectionKey(overview),
    objectRef: sourceObjectRef(overview.context, overview.source),
    identity: identityLine(overview)
  }
}

/**
 * Remote subscription list of the currently selected source (App / 网页), in the tab's list slot.
 * Reads when the user navigates here or switches source here: page 1 only, or (prototype) page
 * after page up to the end candidate, silently, stopping at the first error or refusal and never
 * retrying by itself. Old observations stay on screen when a read fails, is cancelled or is
 * partial; results arriving for a previous source or identity combination are dropped.
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
  const [saved] = useState(() => remembered === null ? registry?.savedLists.get(entryKey) : undefined)
  /** 同步与合并 replaces the list in this pane; the list stays mounted (hidden) with its scroll position. */
  const [view, setView] = useState<'list' | 'reconcile'>(remembered?.view ?? saved?.subscriptionView ?? 'list')
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
  /** This view's filters; kept across source switches, never resetting the thread being read. */
  const [filters, setFilters] = useState<ListFilters>(() => remembered?.filters ?? NO_LIST_FILTERS)
  const filtersRef = useRef(filters)

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
   * Reads from `observationId` (null: a new observation from page 1). The prototype goes on page
   * after page until the end candidate and stops at the first error (rate limit and verification
   * included), refusal, cancellation or source change; nothing is retried automatically.
   */
  const readOn = useCallback(
    async (observationId: string | null) => {
      let next = observationId
      for (;;) {
        const observation = await read(next)
        if (!PROTOTYPE_ENABLED || observation === null) return
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

  /** 取消 (outside the prototype, whose reading is silent): cancels the page being read; the observation it ends with is still shown. */
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
  const images = useImageScope(scrollRef)
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
  const allIds = useMemo(() => threads.map((thread) => thread.head.id), [threads])
  // Unread counts are local records; read again when another thread was chosen (it may have been read).
  const metadata = useThreadMetadata(allIds, filters.unreadOnly, selectedThreadId)
  const filtered = useMemo(() => {
    const byId = metadata.status === 'ready' ? metadata.byId : null
    return filterList(
      threads,
      (thread) => {
        const local = byId?.get(thread.head.id)
        return { ...headMeta(thread.head), unreadCount: local?.unreadCount ?? null, coverageUnknown: local?.coverageUnknown ?? false }
      },
      filters
    )
  }, [threads, metadata, filters])
  const filtering = listFilterCount(filters) > 0
  const uncertainById = useMemo(() => new Map(filtered.shown.map(({ item, uncertain }) => [item.head.id, uncertain])), [filtered])
  const ids = useMemo(() => filtered.shown.map(({ item }) => item.head.id), [filtered])
  const roving = useRovingFocus(ids, selectedThreadId)
  const rules = useThreadRules(ids)

  // ---------- Explicit writes ----------
  const [draft, setDraft] = useState<ChangeDraft | null>(null)
  /** 保留 / 关闭 for the reminders of a thread being unsubscribed; 保留 unless changed. */
  const [reminderChoice, setReminderChoice] = useState<ReminderChoice>('keep')
  const removeIds = useMemo(() => (draft?.action === 'remove' ? [draft.threadId] : null), [draft])
  const reminderAsk = useReminderAsk(removeIds)
  const draftOpener = useRef<HTMLElement | null>(null)
  const confirmCancelRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (draft !== null) confirmCancelRef.current?.focus()
  }, [draft])

  const openDraft = (action: SubscriptionAction, threadId: ThreadId, label: string) => {
    const next = changeDraft(overview, action, threadId, label)
    if (next === null) return
    draftOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setReminderChoice('keep')
    setDraft(next)
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
    const asked = request.action === 'remove' ? askedThreads(reminderAsk, [request.threadId]) : []
    if (asked === null) return
    closeDraft()
    void change({
      source: request.source,
      threadId: request.threadId,
      action: request.action,
      expectedGeneration: request.generation,
      label: request.label,
      reminders: asked.length === 0 ? null : { threadIds: asked, choice: reminderChoice, result: null }
    })
  }

  const blocker = overview === null ? null : sourceBlocker(overview, overview.source)
  const writeBlocked = overview === null || blocker !== null || !overview.writable || busy
  const writeHint = busy
    ? '另一项订阅操作正在进行'
    : overview !== null && !overview.writable
      ? '本地存储不可写'
      : blocker
  const taskHint =
    task === null || task.phase === 'preview-failed'
      ? null
      : task.phase === 'previewing'
        ? '预览读取中'
        : task.phase === 'preview'
          ? '有一份未执行的预览'
          : task.phase === 'executing'
            ? '计划执行中'
            : '计划已结束'

  const labelOf = (threadId: ThreadId) => {
    const thread = threads.find((item) => item.head.id === threadId)
    return thread === undefined ? `No.${threadId}` : threadLabel(thread)
  }

  // ---------- Row context menu (prototype) ----------
  /** The row whose context menu is open, where it opened and the row control focus returns to. */
  const [rowMenu, setRowMenu] = useState<{ threadId: ThreadId; point: ContextMenuPoint; row: HTMLElement } | null>(null)
  const openRowMenu = (threadId: ThreadId, event: ReactMouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    const row = event.currentTarget.querySelector<HTMLElement>('[data-roving-item]')
    if (row === null) return
    event.preventDefault()
    // No scrolling into view: a scroll closes the menu that is about to open.
    row.focus({ preventScroll: true })
    setRowMenu({ threadId, point: contextMenuPoint(event, row), row })
  }
  const closeRowMenu = (returnFocus: boolean) => {
    const row = rowMenu?.row
    setRowMenu(null)
    if (returnFocus && row?.isConnected === true) row.focus()
  }
  const menuThread = rowMenu === null ? undefined : threads.find((thread) => thread.head.id === rowMenu.threadId)

  // ---------- Render ----------
  if (overview === null) {
    return (
      <section className="list-pane" aria-label="订阅" aria-busy={PROTOTYPE_ENABLED && !overviewFailed ? true : undefined}>
        <div className="pane-empty">
          {overviewFailed ? (
            <FailureNotice title="订阅设置读取失败" failure={{ type: 'internal' }} onRetry={() => void refreshOverview()} />
          ) : (
            !PROTOTYPE_ENABLED && <Loading>正在读取订阅设置…</Loading>
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
  /** Page being read now. */
  const readingPage = state.activity === 'first' ? 1 : state.activity === 'next' ? (shown?.nextPage ?? null) : null
  const readingLine = (
    <div className="sub-reading">
      <Loading>正在读取第 {readingPage ?? ''} 页…</Loading>
      <button type="button" className="btn btn-small" onClick={stopRead} disabled={state.stopRequested}>
        {state.stopRequested ? '正在取消…' : '取消'}
      </button>
    </div>
  )

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
              <span className="list-name">订阅</span>
            </h2>
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
            <button
              type="button"
              className="icon-btn"
              onClick={refresh}
              disabled={blocker !== null}
              aria-label="刷新订阅（从第 1 页重新读取）"
              title="刷新订阅"
            >
              <Icon name="refresh" />
            </button>
          </div>
          {switchError !== null && (
            <p className="form-message is-error" role="status">
              <Icon name="alert" size={14} />
              <span>{switchError}</span>
            </p>
          )}
        </header>

        <div className="sub-tools">
          {blocker !== null &&
            (PROTOTYPE_ENABLED ? (
              <div className="notice notice-cached is-compact" role="status">
                <Icon name="alert" className="notice-icon" />
                <p className="notice-text">
                  {SOURCE_NAME[source]}暂时不可用：{blocker}
                </p>
                {openSettings !== null && (
                  <button type="button" className="btn btn-small" onClick={() => openSettings('subscriptions')}>
                    打开设置
                  </button>
                )}
              </div>
            ) : (
              <div className="notice notice-cached" role="status">
                <Icon name="alert" className="notice-icon" />
                <div className="notice-text">
                  <p className="notice-title">{SOURCE_NAME[source]}暂时不可用</p>
                  <p>{blocker}</p>
                </div>
                {openSettings !== null && (
                  <button type="button" className="btn btn-small" onClick={() => openSettings('subscriptions')}>
                    打开设置
                  </button>
                )}
              </div>
            ))}

          <WriteStatus />

          <div className="sub-recon-entry">
            <button type="button" className="btn btn-small" ref={reconcileButtonRef} onClick={() => showView('reconcile')}>
              同步与合并…
            </button>
            {taskHint !== null && <span className="field-hint">{taskHint}</span>}
          </div>

          {draft !== null && (
            <ChangeConfirm
              draft={draft}
              stale={draft.selection !== selection}
              blockedReason={
                busy
                  ? '另一项订阅操作正在进行'
                  : operations?.some((item) =>
                        blocksNewWrite(item, { source: draft.source, objectRef: draft.objectRef, threadId: draft.threadId })
                      )
                    ? '这个串有待核对的操作，请先在操作记录中核对'
                    : null
              }
              cancelRef={confirmCancelRef}
              onConfirm={confirmDraft}
              reminderAsk={draft.action === 'remove' ? reminderAsk : null}
              reminderChoice={reminderChoice}
              onReminderChoice={setReminderChoice}
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

        {/* Prototype: reading is silent (no progress, no coverage); only a failure shows, as one line. */}
        <div className="list-status" aria-busy={PROTOTYPE_ENABLED && (readInFlight || state.activity === 'stored') ? true : undefined}>
          {!PROTOTYPE_ENABLED && state.activity === 'stored' && <Loading>正在读取本机保存的列表…</Loading>}
          {!PROTOTYPE_ENABLED && state.activity === 'first' && readingLine}
          {state.internalError !== null && (
            <FailureNotice
              title={state.internalError === 'stored' ? '本机保存的列表读取失败' : '订阅读取请求失败，仍显示之前的列表'}
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
              <p className="notice-text">读取未执行：{failureText(state.refusal)}</p>
            </div>
          )}
          {PROTOTYPE_ENABLED && shown !== null && shown.error !== null && (
            <p className="sub-stopped" role="alert">
              <Icon name="alert" size={14} />
              <span>
                第 {shown.error.page} 页读取失败：{describeReadError(shown.error.detail)}
              </span>
              {blocker === null && !readInFlight && (
                <button type="button" className="btn btn-small" onClick={() => void readOn(shown.id)}>
                  重试
                </button>
              )}
            </p>
          )}
          {!PROTOTYPE_ENABLED && shown !== null && shown.error !== null && (
            <FailureNotice
              title={`读取第 ${shown.error.page} 页失败${displayed !== null ? '，已取得的内容保留' : ''}`}
              failure={{ type: 'read', error: shown.error.detail }}
              onRetry={blocker === null && !readInFlight ? () => void read(shown.id) : undefined}
              retryLabel={`重试第 ${shown.error.page} 页`}
              compact
            />
          )}
          {!PROTOTYPE_ENABLED && displayed !== null && displayed !== shown && (
            <div className="notice notice-cached is-compact" role="status">
              <Icon name="archive" className="notice-icon" />
              <p className="notice-text">
                本次没有取得新的列表，下面是 {formatLocalTime(displayed.startedAt)} 的较早列表（{coverageText(displayed)}）。
              </p>
            </div>
          )}
          {!PROTOTYPE_ENABLED && displayed !== null && displayed === shown && state.shownStored && (
            <p className="notice-inline" role="status">
              <Icon name="archive" size={14} />
              本机保存的列表，{formatLocalTime(displayed.startedAt)}
            </p>
          )}
          {!PROTOTYPE_ENABLED && displayed !== null && (
            <p className={displayed.nextPage !== null ? 'sub-coverage is-partial' : 'sub-coverage'}>
              <Icon name={displayed.nextPage !== null ? 'alert' : 'info'} size={14} />
              <span>{coverageText(displayed)}</span>
            </p>
          )}
        </div>

        {displayed === null && state.activity === 'idle' && blocker === null && (
          <div className="list-empty">
            <p className="list-empty-title">{shown !== null || state.refusal !== null || state.internalError !== null ? '还没有取得列表' : '还没有读取这份订阅'}</p>
            {!PROTOTYPE_ENABLED && <p className="list-empty-text">读取只会请求第 1 页；后续页需要再点读取。</p>}
            <button type="button" className="btn sub-empty-action" onClick={refresh}>
              {PROTOTYPE_ENABLED ? '读取' : '读取第 1 页'}
            </button>
          </div>
        )}

        {displayed !== null && threads.length === 0 && endPage === 1 && (
          <div className="list-empty" role="status">
            <p className="list-empty-title">没有订阅</p>
          </div>
        )}

        {threads.length > 0 && (
          <ListFilterBar
            filters={filters}
            onChange={setFilters}
            forums={forumNames}
            unreadOffered={!PROTOTYPE_ENABLED}
            noun="订阅的串"
            total={threads.length}
            result={filtered}
            metadata={filters.unreadOnly ? metadata : null}
            coverage={PROTOTYPE_ENABLED || displayed === null ? '已读取的订阅页' : `已读取的订阅页（${coverageText(displayed)}）`}
          />
        )}

        {threads.length > 0 && (
          <ul className="thread-list sub-thread-list" aria-label={filtering ? '订阅的串（已筛选）' : '订阅的串'} onKeyDown={roving.onKeyDown}>
            {filtered.shown.map(({ item: thread }) => {
              const itemProps = roving.itemProps(thread.head.id)
              const row = (
                <ThreadRow
                  thread={thread}
                  forumName={thread.head.forumId !== null ? (forumNames.get(thread.head.forumId) ?? null) : null}
                  selected={thread.head.id === selectedThreadId}
                  uncertain={uncertainById.get(thread.head.id) === true}
                  images={images}
                  onOpen={() => onOpenThread(thread)}
                  itemProps={itemProps}
                />
              )
              // Prototype: 提醒 and 取消订阅 live in the row's context menu (right-click, ContextMenu, Shift+F10).
              if (PROTOTYPE_ENABLED) {
                return (
                  <li
                    key={thread.head.id}
                    className={rowMenu?.threadId === thread.head.id ? 'sub-row is-menu-open' : 'sub-row'}
                    onContextMenu={(event) => openRowMenu(thread.head.id, event)}
                    onKeyDown={(event) => {
                      if (isContextMenuKey(event)) openRowMenu(thread.head.id, event)
                    }}
                  >
                    {row}
                  </li>
                )
              }
              return (
                <li key={thread.head.id} className="sub-row">
                  {row}
                  <div className="sub-row-actions">
                    <ReminderMenu
                      threadId={thread.head.id}
                      label={threadLabel(thread)}
                      rules={rules.rulesOf(thread.head.id)}
                      failure={rules.failure}
                      onRetry={rules.reload}
                      onUpdated={rules.updated}
                      small
                      tabIndex={itemProps.tabIndex}
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
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        {filtering && threads.length > 0 && filtered.shown.length === 0 && (
          <p className="list-filters-empty" role="status">
            已读取的订阅都不符合筛选。
          </p>
        )}

        <div className="list-footer">
          {!PROTOTYPE_ENABLED && state.activity === 'next' && readingLine}
          {!PROTOTYPE_ENABLED && shown !== null && shown.cancelled && !readInFlight && (
            <p className="list-end">已停止，第 {shown.nextPage ?? ''} 页起没有读取</p>
          )}
          {!PROTOTYPE_ENABLED && endPage !== null && endPage > 1 && <p className="list-end">第 {endPage} 页为空，已读完</p>}
          {shown !== null && nextPage !== null && (
            <button type="button" className="btn btn-quiet" onClick={() => void readOn(shown.id)}>
              {PROTOTYPE_ENABLED ? `继续读取（第 ${nextPage} 页起）` : `${shown.cancelled ? '继续读取' : '读取'}第 ${nextPage} 页`}
            </button>
          )}
        </div>
      </div>
      {view === 'reconcile' && (
        <div className="list-scroll" tabIndex={-1} data-pane-focus="">
          <ReconcileView headingRef={reconcileHeadingRef} onBack={() => showView('list')} />
        </div>
      )}
      {rowMenu !== null && menuThread !== undefined && (
        <SubscriptionRowMenu
          key={rowMenu.threadId}
          point={rowMenu.point}
          threadId={rowMenu.threadId}
          label={threadLabel(menuThread)}
          rules={rules.rulesOf(rowMenu.threadId)}
          failure={rules.failure}
          onRetry={rules.reload}
          onUpdated={rules.updated}
          removeBlocked={writeHint ?? (draft !== null ? '请先完成或返回当前的确认' : null)}
          onRemove={() => openDraft('remove', rowMenu.threadId, threadLabel(menuThread))}
          onClose={closeRowMenu}
        />
      )}
    </section>
  )
}

/** Confirmation of one write (加入／取消订阅); Esc cancels. Shared by the list and the thread toolbar. */
export function ChangeConfirm({
  draft,
  stale,
  blockedReason,
  cancelRef,
  onConfirm,
  onCancel,
  reminderAsk,
  reminderChoice,
  onReminderChoice
}: {
  draft: ChangeDraft
  stale: boolean
  blockedReason: string | null
  cancelRef: RefObject<HTMLButtonElement | null>
  onConfirm: () => void
  onCancel: () => void
  /** Rules of the thread being unsubscribed; `null` for 加入. */
  reminderAsk: ReminderAsk | null
  reminderChoice: ReminderChoice
  onReminderChoice: (choice: ReminderChoice) => void
}) {
  const titleId = useId()
  const textId = useId()
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onCancel()
  }
  const reason = stale ? '订阅来源或身份已变化，请重新发起' : blockedReason
  const label = draft.label === `No.${draft.threadId}` ? '' : `「${draft.label}」`
  return (
    <div className={draft.action === 'remove' ? 'sub-confirm is-remove' : 'sub-confirm'} role="group" aria-labelledby={titleId} aria-describedby={textId} onKeyDown={onKeyDown}>
      <p className="sub-confirm-title" id={titleId}>
        {ACTION_NAME[draft.action]}：No.{draft.threadId}
        {label}
      </p>
      <div className="sub-confirm-text" id={textId}>
        <p>
          向{SOURCE_NAME[draft.source]}发出一次请求（{draft.identity}），不会自动重试。
        </p>
      </div>
      <ReminderChoiceField
        ask={reminderAsk}
        all={[draft.threadId]}
        choice={reminderChoice}
        onChoice={onReminderChoice}
        labelOf={(threadId) => `No.${threadId}`}
        single
      />
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
          disabled={reason !== null || reminderAsk?.status === 'loading'}
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
        <button type="submit" className="btn btn-small" disabled={disabled}>
          加入…
        </button>
        {currentThreadId !== null && (
          <button type="button" className="btn btn-small" disabled={disabled} onClick={() => onAdd(currentThreadId)}>
            加入当前串 No.{currentThreadId}…
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
