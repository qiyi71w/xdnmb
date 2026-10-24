import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react'
import type { AppPlatform, StorageStatus } from '../../../shared/api'
import type { RetainedList } from '../../../shared/content'
import { sameTarget, type DraftId, type EditorId, type PostTarget, type SavedDraft } from '../../../shared/drafts'
import type { FeedRef, ThreadId, ThreadSummary } from '../../../shared/forum'
import type { WorkspaceLoadResult } from '../../../shared/lifecycle'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../shared/reading'
import { Icon } from '../components/Icon'
import { feedKey, findFeed, forumNames, type FeedInfo } from '../features/directory/feeds'
import { Navigation, NavMeasure } from '../features/directory/Navigation'
import { useDirectory } from '../features/directory/useDirectory'
import { RetainedDialog } from '../features/content/RetainedDialog'
import { DraftLibraryDialog } from '../features/drafts/DraftLibraryDialog'
import { editorFor, editorForDraft, isUnsaved, unsavedInTab } from '../features/editor/editorsState'
import { targetText } from '../features/editor/editorText'
import { UnsavedEditorsDialog } from '../features/editor/UnsavedEditorsDialog'
import { focusKey, useEditorsStore } from '../features/editor/useEditorsStore'
import { EditorWorkspaceContext, type EditorWorkspace } from '../features/editor/workspace'
import { AttemptsDialog } from '../features/publication/AttemptsDialog'
import { OwnPostsDialog } from '../features/publication/OwnPostsDialog'
import { PoPromptDialog } from '../features/publication/PoPromptDialog'
import { usePendingAttempts } from '../features/publication/usePendingAttempts'
import { LaunchNotice } from '../features/lifecycle/LaunchNotice'
import { LifecycleHost } from '../features/lifecycle/LifecycleHost'
import { useIdentities } from '../features/identity/useIdentities'
import { SubscriptionsContext, useSubscriptions } from '../features/subscriptions/useSubscriptions'
import { RemindersContext, useReminderOverview } from '../features/reminders/useReminders'
import { overviewHasCoverageProblem } from '../features/reminders/reminderText'
import { computeLayout, LAYOUT_DEFAULTS, type LayoutView } from '../features/layout/layout'
import { QuoteCard } from '../features/quote/QuoteCard'
import { QuoteActiveContext, QuoteControllerContext } from '../features/quote/QuoteContext'
import { useQuoteNavigation } from '../features/quote/useQuoteNavigation'
import { captureLists, ContentRegistryContext, createContentRegistry } from '../features/tabs/contentRegistry'
import {
  activeTab,
  currentEntry,
  initialTabsState,
  listKey,
  tabsReducer,
  type EntryInit,
  type ListRef,
  type Tab,
  type TabEntry,
  type TabsAction,
  type TabsState,
  type ThreadOpen
} from '../features/tabs/tabsState'
import { parseWorkspace, type Workspace } from '../features/tabs/workspaceSnapshot'
import { meaningfulTitle } from '../lib/format'
import { usePopover } from '../lib/usePopover'
import { isEditableTarget, matchShortcut, type ShortcutAction } from './shortcuts'
import { TabView } from './TabView'
import { TopBar } from './TopBar'
import { SettingsOpenerContext } from '../lib/settingsOpener'
import { SettingsDialog } from './SettingsDialog'
import './layout.css'

function StorageBanner({ storage }: { storage: StorageStatus | null }) {
  if (storage === null || storage.state === 'ready') return null
  const text =
    storage.state === 'read-only' ? '数据库来自更新版本，当前只读，新内容不会保存' : '本地存储不可用，内容不会被保存'
  return (
    <div className="storage-banner" role="status">
      <Icon name="alert" />
      <span>{text}</span>
    </div>
  )
}

/**
 * Tabs exist only once the global split default is known (the first tab takes it), or the
 * workspace saved at the last real quit is restored.
 */
type ShellAction = TabsAction | { type: 'init'; split: boolean } | { type: 'restore'; tabs: TabsState }

function shellReducer(state: TabsState | null, action: ShellAction): TabsState | null {
  if (action.type === 'init') return state ?? initialTabsState(action.split)
  if (action.type === 'restore') return state ?? action.tabs
  return state === null ? null : tabsReducer(state, action)
}

function threadTitle(open: ThreadOpen): string {
  const head = open.head
  if (head === null) return `No.${open.threadId}`
  const excerpt = head.plainText.replace(/\s+/g, ' ').trim()
  return meaningfulTitle(head.title) ?? (excerpt === '' ? `No.${open.threadId}` : excerpt.slice(0, 40))
}

function viewOf(tab: Tab): LayoutView {
  const entry = currentEntry(tab)
  if (entry.kind === 'thread') return 'reader'
  return entry.feed !== null && tab.split ? 'split' : 'list'
}

/** Whether the entry's thread is on screen (refresh targets it instead of the list). */
function readerShown(tab: Tab, entry: TabEntry, singlePane: boolean): boolean {
  if (entry.kind === 'thread') return true
  return entry.thread !== null && entry.feed !== null && tab.split && (!singlePane || entry.pane === 'reader')
}

/**
 * Post targets whose editors the tab shows now, reader first: the shown thread's replies, then
 * new threads of the shown forum list (hidden while the single pane shows the thread).
 */
function shownTargets(tab: Tab, singlePane: boolean): PostTarget[] {
  const entry = currentEntry(tab)
  const targets: PostTarget[] = []
  if (entry.thread !== null && readerShown(tab, entry, singlePane)) targets.push({ kind: 'reply', threadId: entry.thread.threadId })
  const listHidden = entry.thread !== null && tab.split && singlePane && entry.kind === 'list' && entry.pane === 'reader'
  if (entry.kind === 'list' && entry.feed?.kind === 'forum' && !listHidden) targets.push({ kind: 'thread', forumId: entry.feed.id })
  return targets
}

/** History entry that shows a target's editor: the thread as a page, or the forum list. */
function entryFor(target: PostTarget): EntryInit {
  return target.kind === 'reply'
    ? { kind: 'thread', thread: { threadId: target.threadId, head: null, target: null, snapshot: null, unlocatedPostId: null } }
    : { kind: 'list', feed: { kind: 'forum', id: target.forumId } }
}

export function App() {
  const [storage, setStorage] = useState<StorageStatus | null>(null)
  const [platform, setPlatform] = useState<AppPlatform | null>(null)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [tabs, dispatch] = useReducer(shellReducer, null)
  const registry = useMemo(createContentRegistry, [])
  const directory = useDirectory()
  const { start: startDirectory } = directory
  const identities = useIdentities()
  const editors = useEditorsStore()
  const { current: currentEditors, dispatch: dispatchEditors, requestFocus, save: saveEditor, resolvePrompt } = editors
  const subscriptions = useSubscriptions()
  const { refreshOverview: refreshSubscriptions, refreshOperations: refreshSubscriptionJournal } = subscriptions
  const pendingAttempts = usePendingAttempts(editors.publicationRevision)
  const reminders = useReminderOverview()
  const { overview: reminderOverview, reload: reloadReminders } = reminders
  const reminderBadge = useMemo(
    () =>
      reminderOverview === null
        ? null
        : { unread: reminderOverview.totalUnread, coverageProblem: overviewHasCoverageProblem(reminderOverview) },
    [reminderOverview]
  )
  const [settingsOpen, setSettingsOpen] = useState(false)
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const closeSettings = useCallback(() => {
    setSettingsOpen(false)
    // UUID, binding or source may have changed inside settings.
    void refreshSubscriptions()
    void refreshSubscriptionJournal()
  }, [refreshSubscriptions, refreshSubscriptionJournal])
  const [draftsOpen, setDraftsOpen] = useState(false)
  const closeDrafts = useCallback(() => setDraftsOpen(false), [])
  const [retained, setRetained] = useState<RetainedList | null>(null)
  const closeRetained = useCallback(() => setRetained(null), [])
  const [attemptsOpen, setAttemptsOpen] = useState(false)
  const closeAttempts = useCallback(() => setAttemptsOpen(false), [])
  const [ownPostsOpen, setOwnPostsOpen] = useState(false)
  const closeOwnPosts = useCallback(() => setOwnPostsOpen(false), [])
  /** Tab whose close waits for its unsaved editors to be handled. */
  const [closing, setClosing] = useState<{ tabId: number; editorIds: EditorId[] } | null>(null)

  // A web-sync selection (or a removed/renamed credential) changes the subscription overview too.
  const identityOverview = identities.overview
  useEffect(() => {
    if (identityOverview !== null) void refreshSubscriptions()
  }, [identityOverview, refreshSubscriptions])

  useEffect(() => {
    let alive = true
    window.xidao.app
      .getStatus()
      .then((status) => {
        if (!alive) return
        setStorage(status.storage)
        setPlatform(status.platform)
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) startDirectory()
      })
    return () => {
      alive = false
    }
  }, [startDirectory])

  // Feed details come from the directory; a feed that disappeared keeps its last known details.
  const dirData = directory.state.directory
  const knownFeeds = useRef(new Map<string, FeedInfo>())
  const feedInfo = useCallback(
    (ref: FeedRef): FeedInfo | null => {
      const key = feedKey(ref)
      const found = dirData === null ? null : findFeed(dirData, ref)
      if (found !== null) knownFeeds.current.set(key, found)
      return found ?? knownFeeds.current.get(key) ?? null
    },
    [dirData]
  )

  const names = useMemo(() => forumNames(dirData), [dirData])
  const forumName = useCallback((forumId: string | null) => (forumId === null ? null : (names.get(forumId) ?? null)), [names])

  // ---------- Measured layout ----------
  const appRef = useRef<HTMLDivElement>(null)
  const readingMeasureRef = useRef<HTMLDivElement>(null)
  const scrollbarMeasureRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [readingWidth, setReadingWidth] = useState(0)
  /** Width the reader scroller's vertical scrollbar takes from its content (0 for overlay scrollbars). */
  const [scrollbarWidth, setScrollbarWidth] = useState(0)
  const [navCompactMin, setNavCompactMin] = useState<number>(LAYOUT_DEFAULTS.navCompactReference)

  useLayoutEffect(() => {
    const app = appRef.current
    const reading = readingMeasureRef.current
    const scrollbar = scrollbarMeasureRef.current
    if (app === null || reading === null || scrollbar === null) return
    const measure = () => {
      setWidth(app.getBoundingClientRect().width)
      setReadingWidth(reading.getBoundingClientRect().width)
      setScrollbarWidth(scrollbar.offsetWidth - scrollbar.clientWidth)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(app)
    observer.observe(reading)
    return () => observer.disconnect()
  }, [])

  const current = tabs === null ? null : activeTab(tabs)
  const layout = computeLayout({
    width,
    view: current === null ? 'list' : viewOf(current),
    navFull: LAYOUT_DEFAULTS.navFull,
    navCompactMin,
    listWidth: LAYOUT_DEFAULTS.listWidth,
    readingWidth,
    minGutter: LAYOUT_DEFAULTS.minGutter,
    minSplitText: LAYOUT_DEFAULTS.minSplitText,
    gap: LAYOUT_DEFAULTS.gap + scrollbarWidth
  })
  const navOverlay = layout.nav === 'overlay'

  // ---------- Navigation overlay ----------
  const navTriggerRef = useRef<HTMLButtonElement>(null)
  const navPanelRef = useRef<HTMLElement>(null)
  const navPopover = usePopover(navTriggerRef, navPanelRef)
  const { close: closeNav } = navPopover
  const inlineNavRef = useRef<HTMLElement>(null)
  const navHadFocus = useRef(false)

  // Crossing the overlay threshold keeps keyboard focus near where it was.
  useLayoutEffect(() => {
    if (navOverlay) {
      if (navHadFocus.current) navTriggerRef.current?.focus()
      navHadFocus.current = false
    } else {
      const overlayFocused = navPanelRef.current?.contains(document.activeElement) ?? false
      closeNav(false)
      if (overlayFocused) inlineNavRef.current?.querySelector<HTMLElement>('[data-roving-item][tabindex="0"]')?.focus()
    }
  }, [navOverlay, closeNav])

  // ---------- Navigation actions ----------
  const stateRef = useRef({ tabs, settings, singlePane: layout.singlePane, closing })
  useLayoutEffect(() => {
    stateRef.current = { tabs, settings, singlePane: layout.singlePane, closing }
  })
  const pendingTabFocus = useRef(false)

  // ---------- Quote cards (preview, locate, quote navigation) ----------
  const quote = useQuoteNavigation({
    tabs,
    getTabs: () => stateRef.current.tabs,
    getSettings: () => stateRef.current.settings,
    dispatch,
    registry,
    platform
  })
  // ---------- Workspace restore (spec I2) ----------
  /** Settles once the startup restore is done: tabs exist and saved drafts were reopened. */
  const [restored] = useState(() => Promise.withResolvers<void>())
  const whenRestored = useCallback(() => restored.promise, [restored])
  /** Drafts reopened collapsed: collapsed in the commit that adds their editors, before painting. */
  const collapseOnOpen = useRef(new Set<DraftId>())

  useLayoutEffect(() => {
    if (collapseOnOpen.current.size === 0) return
    for (const draftId of collapseOnOpen.current) {
      const editor = editorForDraft(editors.state, draftId)
      if (editor !== null) dispatchEditors({ type: 'set-expanded', editorId: editor.id, expanded: false })
    }
    collapseOnOpen.current.clear()
  }, [editors.state, dispatchEditors])

  /**
   * Reopens the drafts the workspace's tabs were continuing. A draft that no longer exists, or that
   * an unresolved send holds (or when that cannot be read), stays in the library; nothing is sent.
   */
  const reopenDrafts = useCallback(
    async (workspace: Workspace, alive: () => boolean) => {
      if (workspace.editors.length === 0) return
      const [drafts, attempts] = await Promise.allSettled([window.xidao.drafts.list(), window.xidao.publication.listAttempts()])
      if (!alive()) return
      if (drafts.status !== 'fulfilled' || !drafts.value.ok || attempts.status !== 'fulfilled' || !attempts.value.ok) return
      const locked = new Set(
        attempts.value.attempts.flatMap((attempt) =>
          (attempt.state === 'sending' || attempt.state === 'unknown' || attempt.state === 'unconfirmed') && attempt.draftId !== null
            ? [attempt.draftId]
            : []
        )
      )
      const byId = new Map(drafts.value.drafts.map((draft) => [draft.id, draft]))
      // A tab closed meanwhile takes its drafts' editors with it.
      const tabIds = new Set((stateRef.current.tabs ?? workspace.tabs).tabs.map((tab) => tab.id))
      for (const item of workspace.editors) {
        const draft = byId.get(item.draftId)
        if (draft === undefined || locked.has(draft.id) || !tabIds.has(item.tabId)) continue
        dispatchEditors({ type: 'open-draft', tabId: item.tabId, draft })
        if (!item.expanded) collapseOnOpen.current.add(draft.id)
      }
    },
    [dispatchEditors]
  )

  // Settings and the saved workspace load together; without a readable workspace the shell starts fresh.
  useEffect(() => {
    let alive = true
    void (async () => {
      const [loaded, saved] = await Promise.all([
        window.xidao.settings.get().catch(() => DEFAULT_SETTINGS),
        window.xidao.lifecycle.loadWorkspace().catch((): WorkspaceLoadResult => ({ ok: false }))
      ])
      if (!alive) return
      setSettings(loaded)
      const workspace = saved.ok && saved.workspace !== null ? parseWorkspace(saved.workspace) : null
      if (workspace === null) {
        dispatch({ type: 'init', split: loaded.newTabSplitDefault })
        restored.resolve()
        return
      }
      // Lists take their saved context when first shown: read their pages again, then their position.
      for (const list of workspace.lists) registry.savedLists.set(list.entryKey, list)
      dispatch({ type: 'restore', tabs: workspace.tabs })
      try {
        await reopenDrafts(workspace, () => alive)
      } finally {
        if (alive) restored.resolve()
      }
    })()
    return () => {
      alive = false
    }
  }, [restored, reopenDrafts, registry])

  /** Before leaving an entry that shows a thread, remember its mode and anchor in the entry. */
  const leave = useCallback(
    (tab: Tab) => {
      const entry = currentEntry(tab)
      if (entry.thread === null) return
      const snapshot = registry.readers.get(entry.key)?.current.capture() ?? null
      if (snapshot !== null) dispatch({ type: 'snapshot', tabId: tab.id, entryKey: entry.key, snapshot })
    },
    [registry]
  )

  /**
   * The workspace to save at a real quit: every tab's shown thread captured where it is (as `leave`
   * does), each list's loaded pages and position (also lists restored but not shown again this run),
   * and the saved drafts that unlocked editors continue. Unsaved content was handled before.
   */
  const buildWorkspace = useCallback((): Workspace | null => {
    let state = stateRef.current.tabs
    if (state === null) return null
    for (const tab of state.tabs) {
      const entry = currentEntry(tab)
      if (entry.thread === null) continue
      const snapshot = registry.readers.get(entry.key)?.current.capture() ?? null
      if (snapshot !== null) state = tabsReducer(state, { type: 'snapshot', tabId: tab.id, entryKey: entry.key, snapshot })
    }
    // Runtime reset generations do not survive a restart. Drop every stale history position
    // before serialization resets the remaining generations for the next process.
    state = { ...state, tabs: state.tabs.map((tab) => ({ ...tab, entries: tab.entries.map((entry) => {
      const thread = entry.thread
      if (thread?.snapshot == null || registry.readingResets.writable(thread.threadId, thread.snapshot.generation)) return entry
      return { ...entry, thread: { ...thread, snapshot: null, target: null } } as TabEntry
    }) })) }
    const editorsList = currentEditors().editors.flatMap((editor) =>
      editor.draft !== null && editor.publication === null
        ? [{ tabId: editor.tabId, draftId: editor.draft.id, expanded: editor.expanded }]
        : []
    )
    return { tabs: state, editors: editorsList, lists: captureLists(state, registry) }
  }, [registry, currentEditors])

  const withActive = useCallback((run: (tab: Tab) => void) => {
    const state = stateRef.current.tabs
    if (state !== null) run(activeTab(state))
  }, [])

  const selectFeed = useCallback(
    (ref: ListRef) => {
      closeNav()
      withActive((tab) => {
        const entry = currentEntry(tab)
        if (entry.kind === 'list' && entry.feed !== null && listKey(entry.feed) === listKey(ref)) return
        leave(tab)
        dispatch({ type: 'navigate', tabId: tab.id, entry: { kind: 'list', feed: ref } })
      })
    },
    [closeNav, withActive, leave]
  )

  const selectThread = useCallback(
    (tabId: number, summary: ThreadSummary) => {
      const tab = stateRef.current.tabs?.tabs.find((item) => item.id === tabId)
      if (tab === undefined) return
      const entry = currentEntry(tab)
      if (!(entry.kind === 'list' && tab.split)) leave(tab)
      const thread: ThreadOpen = { threadId: summary.head.id, head: summary.head, target: null, snapshot: null, unlocatedPostId: null }
      dispatch({ type: 'select-thread', tabId, thread })
    },
    [leave]
  )

  const showPane = useCallback((tabId: number, pane: 'list' | 'reader') => dispatch({ type: 'show-pane', tabId, pane }), [])

  /**
   * A list item resolved to an explicit target (a located reminder event) while list entry
   * `entryKey` was current. Split shows it beside the list (no back step), otherwise a new step.
   * The same thread already beside the list is pointed at in place when the target is visible;
   * otherwise it opens again as a new step (the list keeps its memory) so the target applies.
   */
  const openListTarget = useCallback(
    (tabId: number, entryKey: number, thread: ThreadOpen): boolean => {
      const state = stateRef.current.tabs
      const tab = state?.tabs.find((item) => item.id === tabId)
      if (state == null || tab === undefined) return false
      const entry = currentEntry(tab)
      if (entry.key !== entryKey || entry.kind !== 'list') return false
      if (tab.split && entry.thread?.threadId === thread.threadId) {
        const readerVisible = !stateRef.current.singlePane || entry.pane === 'reader'
        const reader = registry.readers.get(entry.key)?.current
        if (readerVisible && thread.target !== null && reader?.showInPlace(thread.threadId, thread.target) === true) return true
        leave(tab)
        const memory = registry.listMemory.get(entry.key)
        if (memory !== undefined) registry.listMemory.set(state.nextKey, memory)
        dispatch({ type: 'navigate', tabId, entry: { kind: 'list', feed: entry.feed, thread } })
        return true
      }
      if (!tab.split) leave(tab)
      dispatch({ type: 'select-thread', tabId, thread })
      return true
    },
    [leave, registry]
  )

  const goBack = useCallback(
    () =>
      withActive((tab) => {
        if (tab.index === 0) return
        leave(tab)
        dispatch({ type: 'back', tabId: tab.id })
      }),
    [withActive, leave]
  )

  const goForward = useCallback(
    () =>
      withActive((tab) => {
        if (tab.index >= tab.entries.length - 1) return
        leave(tab)
        dispatch({ type: 'forward', tabId: tab.id })
      }),
    [withActive, leave]
  )

  const toggleSplit = useCallback(
    () =>
      withActive((tab) => {
        if (tab.split) leave(tab)
        dispatch({ type: 'set-split', tabId: tab.id, split: !tab.split })
      }),
    [withActive, leave]
  )

  const newTab = useCallback(() => {
    dispatch({
      type: 'open-tab',
      entry: { kind: 'list', feed: null },
      split: stateRef.current.settings.newTabSplitDefault,
      background: false
    })
  }, [])

  /** Closes the tab and drops its editors; their unsaved content has been handled. */
  const finishCloseTab = useCallback(
    (tabId: number) => {
      pendingTabFocus.current = true
      dispatch({ type: 'close-tab', tabId, split: stateRef.current.settings.newTabSplitDefault })
      dispatchEditors({ type: 'close-tab', tabId })
    },
    [dispatchEditors]
  )

  /** Closes at once when the tab has nothing unsaved; otherwise asks about all its unsaved editors. */
  const closeTab = useCallback(
    (tabId: number) => {
      if (stateRef.current.closing !== null) return
      const unsaved = unsavedInTab(currentEditors(), tabId)
      if (unsaved.length === 0) finishCloseTab(tabId)
      else setClosing({ tabId, editorIds: unsaved.map((editor) => editor.id) })
    },
    [currentEditors, finishCloseTab]
  )

  /** Activates the tab and makes it show `target` where its editor lives. */
  const showTarget = useCallback(
    (tabId: number, target: PostTarget) => {
      const tab = stateRef.current.tabs?.tabs.find((item) => item.id === tabId)
      if (tab === undefined) return
      dispatch({ type: 'activate', tabId })
      if (shownTargets(tab, stateRef.current.singlePane).some((shown) => sameTarget(shown, target))) return
      const entry = currentEntry(tab)
      if (entry.kind === 'list' && tab.split) {
        // Same entry, other pane of the single-pane fallback.
        if (target.kind === 'reply' && entry.thread?.threadId === target.threadId) {
          dispatch({ type: 'show-pane', tabId, pane: 'reader' })
          return
        }
        if (target.kind === 'thread' && entry.feed?.kind === 'forum' && entry.feed.id === target.forumId) {
          dispatch({ type: 'show-pane', tabId, pane: 'list' })
          return
        }
      }
      leave(tab)
      dispatch({ type: 'navigate', tabId, entry: entryFor(target) })
    },
    [leave]
  )

  const activate = useCallback((tabId: number) => dispatch({ type: 'activate', tabId }), [])

  /** Explicit 更改目标: identity untouched; the editor's tab then shows the new target. */
  const retarget = useCallback(
    (editorId: EditorId, target: PostTarget): 'done' | 'occupied' => {
      const state = currentEditors()
      const editor = state.editors.find((item) => item.id === editorId)
      if (editor === undefined) return 'done'
      if (editorFor(state, editor.tabId, target) !== null) return 'occupied'
      dispatchEditors({ type: 'retarget', editorId, target })
      showTarget(editor.tabId, target)
      requestFocus(focusKey(editor.tabId, target))
      return 'done'
    },
    [currentEditors, dispatchEditors, showTarget, requestFocus]
  )

  /**
   * 继续 from the library: a draft already being edited is shown in its tab; otherwise a new tab
   * (global split default) opens its target and continues it there.
   */
  const continueDraft = useCallback(
    (draft: SavedDraft) => {
      setAttemptsOpen(false)
      setDraftsOpen(false)
      const existing = editorForDraft(currentEditors(), draft.id)
      if (existing !== null) {
        showTarget(existing.tabId, existing.target)
        dispatchEditors({ type: 'set-expanded', editorId: existing.id, expanded: true })
        requestFocus(focusKey(existing.tabId, existing.target))
        return
      }
      const state = stateRef.current.tabs
      if (state === null) return
      // The new tab takes the next tab ID.
      const tabId = state.nextId
      dispatch({ type: 'open-tab', entry: entryFor(draft.target), split: stateRef.current.settings.newTabSplitDefault, background: false })
      dispatchEditors({ type: 'open-draft', tabId, draft })
      requestFocus(focusKey(tabId, draft.target))
    },
    [currentEditors, showTarget, dispatchEditors, requestFocus]
  )

  const openDrafts = useCallback(() => {
    // The overlay navigation would take Esc and outside presses from the dialog: close it first.
    closeNav(false)
    setDraftsOpen(true)
  }, [closeNav])

  const openRetained = useCallback(
    (kind: RetainedList) => {
      closeNav(false)
      setRetained(kind)
    },
    [closeNav]
  )

  /** 打开 from 收藏 / 历史 / 离线: the active tab shows the thread in its reader (a new history step). */
  const openThread = useCallback(
    (threadId: ThreadId) => {
      setRetained(null)
      withActive((tab) => {
        const entry = currentEntry(tab)
        if (entry.thread?.threadId === threadId && readerShown(tab, entry, stateRef.current.singlePane)) return
        leave(tab)
        dispatch({
          type: 'navigate',
          tabId: tab.id,
          entry: { kind: 'thread', thread: { threadId, head: null, target: null, snapshot: null, unlocatedPostId: null } }
        })
      })
    },
    [withActive, leave]
  )
  /** 发送记录, also reachable from an editor and from a locked draft in the library. */
  const openAttempts = useCallback(() => {
    closeNav(false)
    setDraftsOpen(false)
    setAttemptsOpen(true)
  }, [closeNav])

  const openOwnPosts = useCallback(() => {
    closeNav(false)
    setOwnPostsOpen(true)
  }, [closeNav])

  /**
   * A reminder notification was clicked (the main process already revealed the window without a
   * check trigger): show a 提醒 list, the active tab's or another tab's if one shows it, else a new tab.
   */
  const openRemindersList = useCallback(() => {
    const state = stateRef.current.tabs
    if (state === null) return
    closeNav(false)
    void reloadReminders()
    const shows = (tab: Tab) => {
      const entry = currentEntry(tab)
      return entry.kind === 'list' && entry.feed?.kind === 'reminders'
    }
    const active = activeTab(state)
    const existing = shows(active) ? active : state.tabs.find(shows)
    if (existing !== undefined) {
      dispatch({ type: 'activate', tabId: existing.id })
      if (existing.split && stateRef.current.singlePane) dispatch({ type: 'show-pane', tabId: existing.id, pane: 'list' })
      return
    }
    dispatch({
      type: 'open-tab',
      entry: { kind: 'list', feed: { kind: 'reminders' } },
      split: stateRef.current.settings.newTabSplitDefault,
      background: false
    })
  }, [closeNav, reloadReminders])

  useEffect(
    () => window.xidao.reminders.onOpenList(() => void whenRestored().then(openRemindersList)),
    [whenRestored, openRemindersList]
  )

  /** A real quit closes every dialog that would compete with its questions. */
  const closeForQuit = useCallback(() => {
    closeNav(false)
    setSettingsOpen(false)
    setDraftsOpen(false)
    setAttemptsOpen(false)
    setOwnPostsOpen(false)
    setClosing(null)
    setRetained(null)
    quote.cardProps?.onClose()
  }, [closeNav, quote.cardProps])

  /** Opens a target from 发送记录 / 我的发言 in a new tab (global split default), to read or check it. */
  const openTargetInTab = useCallback((target: PostTarget) => {
    setAttemptsOpen(false)
    setOwnPostsOpen(false)
    dispatch({ type: 'open-tab', entry: entryFor(target), split: stateRef.current.settings.newTabSplitDefault, background: false })
  }, [])

  /**
   * Ctrl/Cmd+S: the editor holding focus, else the expanded editor the active tab shows (reader
   * before list). Nothing while a modal dialog or the active tab's image viewer is open.
   */
  const saveCurrent = useCallback(() => {
    const state = stateRef.current.tabs
    if (state === null || document.querySelector('dialog[open]') !== null) return
    const tab = activeTab(state)
    if (document.getElementById(`tabpanel-${tab.id}`)?.querySelector('.image-viewer') != null) return
    const editorsState = currentEditors()
    const focused = document.activeElement?.closest<HTMLElement>('[data-editor-id]')?.dataset.editorId
    const editor =
      editorsState.editors.find((item) => item.id === focused) ??
      shownTargets(tab, stateRef.current.singlePane)
        .map((target) => editorFor(editorsState, tab.id, target))
        .find((item) => item !== null && item.expanded)
    if (editor !== undefined && editor !== null && isUnsaved(editor)) void saveEditor(editor.id)
  }, [currentEditors, saveEditor])

  /** Refreshes only the current content: the shown thread, otherwise the list. Never the app. */
  const refresh = useCallback(
    () =>
      withActive((tab) => {
        const entry = currentEntry(tab)
        const reader = readerShown(tab, entry, stateRef.current.singlePane) ? registry.readers.get(entry.key) : undefined
        if (reader !== undefined) reader.current.refresh()
        else registry.lists.get(entry.key)?.current.refresh()
      }),
    [withActive, registry]
  )

  // List memory and restored list context live only as long as their entry is in some tab's
  // history (forward branch replaced, tab closed → dropped).
  useEffect(() => {
    if (tabs === null) return
    const live = new Set<number>()
    for (const tab of tabs.tabs) for (const item of tab.entries) live.add(item.key)
    for (const key of registry.listMemory.keys()) if (!live.has(key)) registry.listMemory.delete(key)
    for (const key of registry.savedLists.keys()) if (!live.has(key)) registry.savedLists.delete(key)
  }, [tabs, registry])

  // A closed tab takes its focused controls with it: hand focus to the newly active tab.
  const activeId = tabs?.activeId ?? null
  useLayoutEffect(() => {
    if (!pendingTabFocus.current) return
    pendingTabFocus.current = false
    const focused = document.activeElement
    if (focused === null || focused === document.body || !focused.isConnected) {
      document.getElementById(`tab-${activeId}`)?.focus()
    }
  }, [activeId, tabs])

  // ---------- Keyboard (spec I11): one app-level dispatcher ----------
  const actions = useRef<Record<ShortcutAction, () => void> | null>(null)
  useLayoutEffect(() => {
    actions.current = {
      'new-tab': newTab,
      // Not behind a modal dialog (e.g. the PO identity question holding a send).
      'close-tab': () => {
        if (document.querySelector('dialog[open]') === null) withActive((tab) => closeTab(tab.id))
      },
      'next-tab': () => dispatch({ type: 'cycle', delta: 1 }),
      'previous-tab': () => dispatch({ type: 'cycle', delta: -1 }),
      refresh,
      save: saveCurrent,
      back: goBack,
      forward: goForward
    }
  })

  useEffect(() => {
    if (platform === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const action = matchShortcut(event, platform)
      if (action === null) return
      if ((action === 'back' || action === 'forward') && isEditableTarget(event.target)) return
      event.preventDefault()
      if (event.repeat && action !== 'next-tab' && action !== 'previous-tab' && action !== 'back' && action !== 'forward') return
      actions.current?.[action]()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [platform])

  // ---------- Render ----------
  const titleOf = useCallback(
    (tab: Tab) => {
      const entry = currentEntry(tab)
      if (entry.kind === 'thread') return threadTitle(entry.thread)
      if (entry.feed === null) return '新标签'
      const name =
        entry.feed.kind === 'subscriptions'
          ? '订阅'
          : entry.feed.kind === 'reminders'
            ? '提醒'
            : (feedInfo(entry.feed)?.name ?? (entry.feed.kind === 'timeline' ? '时间线' : '版面'))
      return entry.thread !== null && tab.split ? `${name} › ${threadTitle(entry.thread)}` : name
    },
    [feedInfo]
  )

  const entry = current === null ? null : currentEntry(current)
  const selectedFeed = entry?.kind === 'list' ? entry.feed : null

  const workspaceStyle = {
    '--nav-width': `${layout.navWidth}px`,
    '--nav-full': `${LAYOUT_DEFAULTS.navFull}px`,
    '--list-width': `${LAYOUT_DEFAULTS.listWidth}px`
  } as CSSProperties

  const editorWorkspace = useMemo<EditorWorkspace>(
    () => ({ store: editors, identities, platform, directory: dirData, forumName, retarget, openAttempts }),
    [editors, identities, platform, dirData, forumName, retarget, openAttempts]
  )

  const tabTitle = (tabId: number) => {
    const tab = tabs?.tabs.find((item) => item.id === tabId)
    return tab === undefined ? '已关闭的标签' : titleOf(tab)
  }

  /** A send waiting for the PO identity answer (one at a time: the dialog is modal). */
  const promptEditor = editors.state.editors.find((editor) => editor.publication?.phase === 'prompt')

  return (
    <SettingsOpenerContext value={openSettings}>
      <EditorWorkspaceContext value={editorWorkspace}>
      <SubscriptionsContext value={subscriptions}>
      <RemindersContext value={reminders}>
        <div className="app" ref={appRef}>
          <StorageBanner storage={storage} />
          <LaunchNotice
            onOpenAttempts={openAttempts}
            fallbackFocus={() => document.getElementById(`tab-${stateRef.current.tabs?.activeId}`)}
          />
          <div className="measure-reading" ref={readingMeasureRef} aria-hidden="true" />
          <div className="measure-scrollbar" ref={scrollbarMeasureRef} aria-hidden="true" />
          <NavMeasure directory={dirData} onMeasure={setNavCompactMin} />
          <ContentRegistryContext.Provider value={registry}>
            <QuoteControllerContext.Provider value={quote.controller}>
            <QuoteActiveContext.Provider value={quote.activeKey}>
            <div className={navOverlay ? 'workspace is-nav-overlay' : 'workspace'} style={workspaceStyle}>
              {!navOverlay && (
                <div
                  className="nav-column"
                  onFocus={() => (navHadFocus.current = true)}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) navHadFocus.current = false
                  }}
                >
                  <Navigation
                    state={directory.state}
                    selected={selectedFeed}
                    onSelect={selectFeed}
                    onRetry={directory.retry}
                    variant="inline"
                    progress={layout.navProgress}
                    panelRef={inlineNavRef}
                    identities={identities}
                    onOpenSettings={openSettings}
                    onOpenDrafts={openDrafts}
                    onOpenRetained={openRetained}
                    onOpenAttempts={openAttempts}
                    onOpenOwnPosts={openOwnPosts}
                    pendingAttempts={pendingAttempts}
                    reminderBadge={reminderBadge}
                  />
                </div>
              )}

              <div className="main-column">
                {tabs !== null && current !== null && entry !== null && (
                  <>
                    <TopBar
                      tabs={tabs.tabs}
                      activeId={tabs.activeId}
                      titleOf={titleOf}
                      platform={platform}
                      canBack={current.index > 0}
                      backToQuote={entry.origin === 'quote' && current.index > 0}
                      canForward={current.index < current.entries.length - 1}
                      splitToggle={entry.kind === 'list' ? { pressed: current.split, onToggle: toggleSplit } : null}
                      navTrigger={navOverlay ? { ref: navTriggerRef, expanded: navPopover.open, onToggle: navPopover.toggle } : null}
                      onBack={goBack}
                      onForward={goForward}
                      onActivate={activate}
                      onClose={closeTab}
                      onNewTab={newTab}
                      onOpenSettings={openSettings}
                    />
                    <div className="tab-host">
                      {tabs.tabs.map((tab) => (
                        <TabView
                          key={tab.id}
                          tab={tab}
                          active={tab.id === tabs.activeId}
                          layout={layout}
                          directory={directory.state}
                          onRetryDirectory={directory.retry}
                          feedInfo={feedInfo}
                          forumNames={names}
                          forumName={forumName}
                          onSelectThread={selectThread}
                          onShowPane={showPane}
                          onOpenTarget={openListTarget}
                          onOpenNav={navOverlay ? navPopover.toggle : null}
                        />
                      ))}
                    </div>
                  </>
                )}
              </div>

              {navOverlay && navPopover.open && (
                <>
                  <div className="nav-overlay-layer" aria-hidden="true" />
                  <Navigation
                    state={directory.state}
                    selected={selectedFeed}
                    onSelect={selectFeed}
                    onRetry={directory.retry}
                    variant="overlay"
                    progress={0}
                    panelRef={navPanelRef}
                    id="nav-overlay"
                    identities={identities}
                    onOpenSettings={openSettings}
                    onOpenDrafts={openDrafts}
                    onOpenRetained={openRetained}
                    onOpenAttempts={openAttempts}
                    onOpenOwnPosts={openOwnPosts}
                    pendingAttempts={pendingAttempts}
                    reminderBadge={reminderBadge}
                  />
                </>
              )}
            </div>
            </QuoteActiveContext.Provider>
            </QuoteControllerContext.Provider>
          </ContentRegistryContext.Provider>
          {/* Outside every reader's content: showing a quote card never counts as reading. */}
          {quote.cardProps !== null && <QuoteCard {...quote.cardProps} />}
          {settingsOpen && (
            <SettingsDialog
              identities={identities}
              subscriptions={subscriptions}
              settings={settings}
              onSettingsChange={setSettings}
              onClose={closeSettings}
            />
          )}
          {draftsOpen && (
            <DraftLibraryDialog
              tabTitle={tabTitle}
              onContinue={continueDraft}
              onOpenAttempts={openAttempts}
              onClose={closeDrafts}
              fallbackFocus={() => navTriggerRef.current}
            />
          )}
          {retained !== null && (
            <RetainedDialog
              initial={retained}
              resets={registry.readingResets}
              favorites={registry.favorites}
              onOpenThread={openThread}
              onClose={closeRetained}
              fallbackFocus={() => navTriggerRef.current}
            />
          )}
          {attemptsOpen && (
            <AttemptsDialog
              tabTitle={tabTitle}
              onContinue={continueDraft}
              onOpenTarget={openTargetInTab}
              onClose={closeAttempts}
              fallbackFocus={() => navTriggerRef.current}
            />
          )}
          {ownPostsOpen && (
            <OwnPostsDialog
              onOpenThread={(threadId) => openTargetInTab({ kind: 'reply', threadId })}
              onClose={closeOwnPosts}
              fallbackFocus={() => navTriggerRef.current}
            />
          )}
          {promptEditor !== undefined && promptEditor.publication?.phase === 'prompt' && (
            <PoPromptDialog
              key={promptEditor.publication.prompt.token}
              prompt={promptEditor.publication.prompt}
              target={targetText(promptEditor.target, forumName)}
              resolving={promptEditor.publication.resolving}
              onChoose={(choice, suppress) => void resolvePrompt(promptEditor.id, choice, suppress)}
            />
          )}
          {closing !== null && (
            <UnsavedEditorsDialog
              label="关闭标签"
              intro={`「${tabTitle(closing.tabId)}」中有未保存的编辑（包括已收起的）。关闭前保存为草稿，还是放弃？`}
              verb="关闭"
              editorIds={closing.editorIds}
              onFinish={() => {
                setClosing(null)
                finishCloseTab(closing.tabId)
              }}
              onCancel={() => setClosing(null)}
            />
          )}
          <LifecycleHost
            platform={platform}
            onSettingsChange={setSettings}
            closeModals={closeForQuit}
            buildWorkspace={buildWorkspace}
            whenRestored={whenRestored}
          />
        </div>
      </RemindersContext>
      </SubscriptionsContext>
      </EditorWorkspaceContext>
    </SettingsOpenerContext>
  )
}
