import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import type { AppPlatform, StorageStatus } from '../../../shared/api'
import type { RetainedList } from '../../../shared/content'
import { sameTarget, type DraftId, type EditorId, type PostTarget, type SavedDraft } from '../../../shared/drafts'
import type { FeedRef, Post, ThreadId } from '../../../shared/forum'
import type { WorkspaceLoadResult } from '../../../shared/lifecycle'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../shared/settings'
import { Icon } from '../components/Icon'
import { feedKey, findFeed, forumNames, type FeedInfo } from '../features/directory/feeds'
import { Navigation, NavMeasure } from '../features/directory/Navigation'
import { useDirectory } from '../features/directory/useDirectory'
import { RetainedDialog } from '../features/content/RetainedDialog'
import { HistoryPageContext, type HistoryPageHost, type HistoryView } from '../features/content/RetainedPane'
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
import { LocalSearchContext, SearchOpenerContext, type LocalSearchHost, type SearchRequest } from '../features/search/SearchContext'
import { SearchSheet } from '../features/search/SearchSheet'
import { tabSearchOf } from '../features/search/searchState'
import { useSearch } from '../features/search/useSearch'
import { captureLists, ContentRegistryContext, createContentRegistry, type SearchPageSide } from '../features/tabs/contentRegistry'
import {
  activeTab,
  currentEntry,
  entryThread,
  initialTabsState,
  isLocalList,
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
import { AppCoveredContext, useCoverageScope } from '../lib/appCovered'
import { meaningfulTitle } from '../lib/format'
import { useAppearance } from '../lib/useAppearance'
import { usePopover } from '../lib/usePopover'
import { SettingsDialog } from './SettingsDialog'
import { isEditableTarget, matchShortcut, shortcutLabel, type ShortcutAction } from './shortcuts'
import { TabView } from './TabView'
import { TopBar } from './TopBar'
import { SettingsOpenerContext, type SettingsSectionId } from '../lib/settingsOpener'
import { ListOpenerContext } from '../features/reminders/openList'
import { ThreadTabOpenerContext, type ThreadTabOpener } from '../features/tabs/openThreadInTab'
import { useSettingsWriter } from './useSettingsWriter'
import './layout.css'
// PROTOTYPE (throwaway): navigation variants, active only with VITE_XIDAO_PROTOTYPE=1.
import { PrototypeSwitcher } from '../components/PrototypeSwitcher'
import { PrototypeNavB } from '../features/directory/prototype/PrototypeNavB'
import { BoardPanelEmptyPage, BoardPanelTitle, PrototypeNavD } from '../features/directory/prototype/PrototypeNavD'
import { BoardChooserPage, BoardStrip, PrototypeNavE } from '../features/directory/prototype/PrototypeNavE'
import { PrototypeNavF } from '../features/directory/prototype/PrototypeNavF'
import type { FeatureHost, PrototypeNavProps } from '../features/directory/prototype/PrototypeNavParts'
import { RAIL_WIDTH } from '../features/directory/prototype/PrototypeRail'
import { readListWidth, saveListWidth } from './ListDivider'
import { PrototypeSettingsPage } from '../features/directory/prototype/PrototypeSettings'
import {
  ListHostContext,
  NAV_VARIANTS,
  closeBoardPanel,
  isShown,
  openBoardPanel,
  PROTOTYPE_ENABLED,
  setBoardPanelHost,
  setNavVariant,
  useBoardColumnCollapsed,
  useBoardColumnWidth,
  useNavVariant,
  type FeatureId,
  type ListHost
} from '../features/directory/prototype/prototypeStore'

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
  if (entry.kind === 'online-search') return 'list'
  return entry.feed !== null && tab.split ? 'split' : 'list'
}

/** Whether the entry's thread is on screen (refresh targets it instead of the list). */
function readerShown(tab: Tab, entry: TabEntry, singlePane: boolean): boolean {
  if (entry.kind !== 'list') return entry.kind === 'thread'
  return entry.thread !== null && entry.feed !== null && tab.split && (!singlePane || entry.pane === 'reader')
}

/**
 * Post targets whose editors the tab shows now, reader first: the shown thread's replies, then
 * new threads of the shown forum list (hidden while the single pane shows the thread).
 */
function shownTargets(tab: Tab, singlePane: boolean): PostTarget[] {
  const entry = currentEntry(tab)
  const targets: PostTarget[] = []
  const thread = entryThread(entry)
  if (thread !== null && readerShown(tab, entry, singlePane)) targets.push({ kind: 'reply', threadId: thread.threadId })
  const listHidden = thread !== null && tab.split && singlePane && entry.kind === 'list' && entry.pane === 'reader'
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
  useAppearance(settings)
  const settingsWriter = useSettingsWriter(settings, setSettings)
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
  /** The app's coverage scope: every modal dialog (`Modal`) covers it while open. */
  const coverage = useCoverageScope()
  const [draftsOpen, setDraftsOpen] = useState(false)
  const closeDrafts = useCallback(() => setDraftsOpen(false), [])
  const [retained, setRetained] = useState<RetainedList | null>(null)
  const closeRetained = useCallback(() => setRetained(null), [])
  const [attemptsOpen, setAttemptsOpen] = useState(false)
  const closeAttempts = useCallback(() => setAttemptsOpen(false), [])
  const [historyRequest, setHistoryRequest] = useState<HistoryPageHost['request']>(null)
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
  /** PROTOTYPE: list width chosen with the split divider; the default outside the prototype. */
  const [listPreference, setListPreference] = useState(() => (PROTOTYPE_ENABLED ? readListWidth() : LAYOUT_DEFAULTS.listWidth))
  const resizeList = useCallback((next: number, done: boolean) => {
    setListPreference(next)
    if (done) saveListWidth(next)
  }, [])

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
  /** PROTOTYPE: the active tab shows a 搜索 page (its `online-search` entry); it holds the tab's local search open. */
  const searchPageTab = PROTOTYPE_ENABLED && current !== null && currentEntry(current).kind === 'online-search' ? current.id : null
  /** PROTOTYPE: the navigation variant; `null` (the regular navigation and settings dialog) unless built in. */
  const navVariant = useNavVariant()
  const protoColumnCollapsed = useBoardColumnCollapsed()
  const protoColumnWidth = useBoardColumnWidth()
  /**
   * PROTOTYPE: navigation column width. B: the regular column plus the rail (narrowing as usual);
   * D, E: the rail alone; F: the rail plus the board column at its content width, unless collapsed.
   * The 8 px is the navigation's outer margin.
   */
  const protoNavFull =
    navVariant === null || navVariant === 'B'
      ? null
      : 8 + RAIL_WIDTH + (navVariant === 'F' && !protoColumnCollapsed ? protoColumnWidth : 0)
  const navFull = protoNavFull ?? LAYOUT_DEFAULTS.navFull + (navVariant === 'B' ? RAIL_WIDTH : 0)
  const layout = computeLayout({
    width,
    view: current === null ? 'list' : viewOf(current),
    navFull,
    navCompactMin: protoNavFull ?? navCompactMin + (navVariant === 'B' ? RAIL_WIDTH : 0),
    // Up to the default the list width is reserved like before; a wider one is granted from the reader.
    listWidth: Math.min(listPreference, LAYOUT_DEFAULTS.listWidth),
    listGrow: Math.max(0, listPreference - LAYOUT_DEFAULTS.listWidth),
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
  const stateRef = useRef({ tabs, settings, singlePane: layout.singlePane, closing, covered: coverage.covered, searchOpen: false })
  useLayoutEffect(() => {
    // `search` is created below (it reads this ref); this runs after the render that created it.
    // A 搜索 page holding the local search open is no dialog.
    const searchOpen = tabs !== null && search.state.openTab === tabs.activeId && searchPageTab === null
    stateRef.current = { tabs, settings, singlePane: layout.singlePane, closing, covered: coverage.covered, searchOpen }
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

  // ---------- Settings dialog ----------
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** Focus target when whatever opened the dialog (button, navigation, Ctrl/Cmd+, from anywhere) is gone. */
  const settingsButtonRef = useRef<HTMLButtonElement>(null)
  const { clearStatus: clearSettingsStatus } = settingsWriter

  /** PROTOTYPE: the settings page is shown in place of the tabs. */
  const [protoSettingsOpen, setProtoSettingsOpen] = useState(false)
  const protoSettingsShown = navVariant !== null && protoSettingsOpen
  /**
   * PROTOTYPE: where focus goes back when the settings page is left (Esc, 返回): the control that
   * opened it, read before anything closes, and whether that was the top bar's 设置 (remounted with
   * the top bar). Leaving it for other content (a list chosen) hands focus to that content instead.
   */
  const settingsReturn = useRef<{ opener: HTMLElement | null; fromTopBar: boolean; pending: boolean } | null>(null)
  /**
   * PROTOTYPE: where the settings page lands — the section an entry is about, or the top. A new
   * request (`seq`) moves the page even while it is already shown.
   */
  const [settingsTarget, setSettingsTarget] = useState<{ section: SettingsSectionId | null; seq: number }>({ section: null, seq: 0 })

  const openSettings = useCallback((section?: SettingsSectionId) => {
    if (PROTOTYPE_ENABLED && settingsReturn.current === null) {
      const active = document.activeElement
      const opener = active instanceof HTMLElement && active !== document.body ? active : null
      settingsReturn.current = { opener, fromTopBar: opener !== null && opener === settingsButtonRef.current, pending: false }
    }
    // The dialog becomes the only layer: an open navigation overlay closes first.
    closeNav(false)
    clearSettingsStatus()
    setSettingsTarget((previous) => ({ section: section ?? null, seq: previous.seq + 1 }))
    if (PROTOTYPE_ENABLED) setProtoSettingsOpen(true)
    else setSettingsOpen(true)
  }, [closeNav, clearSettingsStatus])
  /** Settings at the top: Ctrl/Cmd+, and the general 设置 buttons. */
  const openSettingsTop = useCallback(() => openSettings(), [openSettings])
  /** Settings at 饼干: the navigation's browse-cookie footer. */
  const openCookieSettings = useCallback(() => openSettings('cookies'), [openSettings])

  /** Leaves settings; `returnFocus` (Esc, 返回, the dialog closed) sends focus back where it came from. */
  const endSettings = useCallback(
    (returnFocus: boolean) => {
      setSettingsOpen(false)
      setProtoSettingsOpen(false)
      if (settingsReturn.current !== null) {
        if (returnFocus) settingsReturn.current.pending = true
        else settingsReturn.current = null
      }
      // UUID, binding or source may have changed inside settings.
      void refreshSubscriptions()
      void refreshSubscriptionJournal()
    },
    [refreshSubscriptions, refreshSubscriptionJournal]
  )
  const closeSettings = useCallback(() => endSettings(true), [endSettings])

  // PROTOTYPE: back from the settings page, once the content it covered is back (the top bar returns
  // in the same commit, so the page's own cleanup would run before its buttons exist). The opener if
  // still shown; else the stable entry: the top bar's 设置 it came from, 打开导航, or the rail's 设置.
  useLayoutEffect(() => {
    const back = settingsReturn.current
    if (protoSettingsShown || back === null || !back.pending) return
    settingsReturn.current = null
    const target = isShown(back.opener)
      ? back.opener
      : back.fromTopBar
        ? settingsButtonRef.current
        : navOverlay
          ? navTriggerRef.current
          : (inlineNavRef.current?.querySelector<HTMLElement>('[data-proto-settings]') ?? null)
    target?.focus()
  }, [protoSettingsShown, navOverlay])

  // ---------- Local / thread search ----------
  /** Tab whose reader takes focus after a search hit was opened in it. */
  const pendingReaderFocus = useRef<number | null>(null)
  const search = useSearch({
    tabs,
    getTabs: () => stateRef.current.tabs,
    dispatch,
    registry,
    onCommitted: (tabId) => {
      pendingReaderFocus.current = tabId
    }
  })
  const { commands: searchCommands } = search

  // PROTOTYPE: a hit chosen on a 搜索 page's 本机 side opens only while the tab's local search is
  // open, as from the sheet. The page holds it open while shown and lets go when left (a hit
  // opened from the page has already closed it).
  const openSearchTab = search.state.openTab
  const heldSearch = useRef<number | null>(null)
  useLayoutEffect(() => {
    const held = heldSearch.current
    heldSearch.current = searchPageTab
    if (searchPageTab !== null) {
      if (openSearchTab !== searchPageTab) searchCommands.open(searchPageTab, { view: 'local' })
    } else if (held !== null && openSearchTab === held) {
      searchCommands.close()
    }
  }, [searchPageTab, openSearchTab, searchCommands])
  const localSearchHost = useMemo<LocalSearchHost | null>(
    () => (PROTOTYPE_ENABLED ? { state: search.state, commands: searchCommands, forums: names } : null),
    [search.state, searchCommands, names]
  )

  /** Before leaving an entry that shows a thread, remember its mode and anchor in the entry. */
  const leave = useCallback(
    (tab: Tab) => {
      const entry = currentEntry(tab)
      if (entryThread(entry) === null) return
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
      if (entryThread(entry) === null) continue
      const snapshot = registry.readers.get(entry.key)?.current.capture() ?? null
      if (snapshot !== null) state = tabsReducer(state, { type: 'snapshot', tabId: tab.id, entryKey: entry.key, snapshot })
    }
    // Runtime reset generations do not survive a restart. Drop every stale history position
    // before serialization resets the remaining generations for the next process.
    state = { ...state, tabs: state.tabs.map((tab) => ({ ...tab, entries: tab.entries.map((entry) => {
      const thread = entryThread(entry)
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

  /**
   * Shows `ref` in the active tab. Focus: `nav` — an open navigation overlay closes back to 打开导航
   * (an inline navigation keeps it); `list` — the active tab's list takes it, for openers that are
   * going away (the PROTOTYPE 全部功能 panel).
   */
  const selectFeed = useCallback(
    (ref: ListRef, focus: 'nav' | 'list' = 'nav') => {
      closeNav(focus === 'nav')
      withActive((tab) => {
        const entry = currentEntry(tab)
        if (entry.kind === 'list' && entry.feed !== null && listKey(entry.feed) === listKey(ref)) return
        leave(tab)
        dispatch({ type: 'navigate', tabId: tab.id, entry: { kind: 'list', feed: ref } })
      })
      if (focus === 'list') {
        // The list replaces the shown one in this commit; it exists from the next frame.
        requestAnimationFrame(() => {
          document.querySelector<HTMLElement>(`#tabpanel-${stateRef.current.tabs?.activeId} [data-pane-focus]`)?.focus()
        })
      }
    },
    [closeNav, withActive, leave]
  )

  /**
   * 联网搜索: an online search page as a new step of the current tab; on such a page already, focus
   * its search box. No shortcut (spec I11 names none).
   */
  const openOnlineSearch = useCallback(() => {
    closeNav()
    withActive((tab) => {
      const entry = currentEntry(tab)
      if (entry.kind === 'online-search') {
        registry.onlineSearchPanes.get(entry.key)?.current.focusInput()
        return
      }
      leave(tab)
      dispatch({ type: 'navigate', tabId: tab.id, entry: { kind: 'online-search' } })
    })
  }, [closeNav, withActive, leave, registry])

  /**
   * An online search result opens as a new `online-search` step of the tab still showing that page
   * (back reads 返回搜索结果 and the page comes back from its session without a new request).
   */
  const openFromOnlineSearch = useCallback((entryKey: number, init: EntryInit): boolean => {
    const tab = stateRef.current.tabs?.tabs.find((item) => currentEntry(item).key === entryKey)
    if (tab === undefined) return false
    dispatch({ type: 'navigate', tabId: tab.id, entry: init, origin: 'online-search' })
    return true
  }, [])

  const selectThread = useCallback(
    (tabId: number, threadId: ThreadId, head: Post | null) => {
      const tab = stateRef.current.tabs?.tabs.find((item) => item.id === tabId)
      if (tab === undefined) return
      const entry = currentEntry(tab)
      if (!(entry.kind === 'list' && tab.split)) leave(tab)
      const thread: ThreadOpen = { threadId, head, target: null, snapshot: null, unlocatedPostId: null }
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
        const fromSearch = currentEntry(tab).origin === 'local-search'
        const sourceKey = (tab.entries[tab.index - 1] as TabEntry).key
        leave(tab)
        dispatch({ type: 'back', tabId: tab.id })
        // 返回搜索结果 (local / thread search): the source entry comes back with the search sheet it
        // had when the hit was opened. An online search page restores itself from its session.
        if (fromSearch) searchCommands.returnTo(tab.id, sourceKey)
      }),
    [withActive, leave, searchCommands]
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
        if (entryThread(entry)?.threadId === threadId && readerShown(tab, entry, stateRef.current.singlePane)) return
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
  const openHistoryView = useCallback((view: HistoryView) => {
    const state = stateRef.current.tabs
    if (state === null) return
    endSettings(false)
    selectFeed({ kind: 'history' }, 'list')
    dispatch({ type: 'show-pane', tabId: state.activeId, pane: 'list' })
    setHistoryRequest((current) => ({ tabId: state.activeId, view, seq: (current?.seq ?? 0) + 1 }))
  }, [endSettings, selectFeed])

  /** Every prototype sender entry opens the history page's sending view; production keeps its modal. */
  const openAttempts = useCallback(() => {
    closeNav(false)
    setDraftsOpen(false)
    if (PROTOTYPE_ENABLED) {
      const tabId = stateRef.current.tabs?.activeId
      for (const editor of currentEditors().editors) {
        if (editor.tabId === tabId && editor.expanded) dispatchEditors({ type: 'set-expanded', editorId: editor.id, expanded: false })
      }
      openHistoryView('attempts')
    } else setAttemptsOpen(true)
  }, [closeNav, currentEditors, dispatchEditors, openHistoryView])

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
    setProtoSettingsOpen(false)
    settingsReturn.current = null
    setDraftsOpen(false)
    setAttemptsOpen(false)
    setOwnPostsOpen(false)
    setClosing(null)
    setRetained(null)
    searchCommands.close()
    quote.cardProps?.onClose()
  }, [closeNav, searchCommands, quote.cardProps])

  /** Opens a target from 发送记录 / 我的发言 in a new tab (global split default), to read or check it. */
  const openTargetInTab = useCallback((target: PostTarget) => {
    setAttemptsOpen(false)
    setOwnPostsOpen(false)
    dispatch({ type: 'open-tab', entry: entryFor(target), split: stateRef.current.settings.newTabSplitDefault, background: false })
  }, [])

  /** Opens a thread from a list row / thread menu in a new active tab (global split default). */
  const openThreadInTab = useCallback<ThreadTabOpener>((threadId, head = null, fromStartIn) => {
    // From the start: the main post (page 1 in either mode) as an explicit target, over any saved position.
    const target = fromStartIn === undefined ? null : { postId: threadId, page: 1, mode: fromStartIn }
    dispatch({
      type: 'open-tab',
      entry: { kind: 'thread', thread: { threadId, head, target, snapshot: null, unlocatedPostId: null } },
      split: stateRef.current.settings.newTabSplitDefault,
      background: false
    })
  }, [])

  /**
   * Ctrl/Cmd+S: the editor holding focus, else the expanded editor the active tab shows (reader
   * before list). Nothing while the active tab's image viewer is open (the dispatcher already skips
   * every shortcut behind a modal dialog).
   */
  const saveCurrent = useCallback(() => {
    const state = stateRef.current.tabs
    if (state === null) return
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

  // List memory, restored list context, online search sessions and PROTOTYPE 搜索 page memory live
  // only as long as their entry is in some tab's history (forward branch replaced, tab closed →
  // dropped; a dropped online search session is closed).
  useEffect(() => {
    if (tabs === null) return
    const live = new Set<number>()
    for (const tab of tabs.tabs) for (const item of tab.entries) live.add(item.key)
    for (const key of registry.listMemory.keys()) if (!live.has(key)) registry.listMemory.delete(key)
    for (const key of registry.savedLists.keys()) if (!live.has(key)) registry.savedLists.delete(key)
    for (const key of registry.searchPageMemory.keys()) if (!live.has(key)) registry.searchPageMemory.delete(key)
    registry.onlineSearches.retain(live)
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

  // An opened search hit: its new reader takes focus (the sheet that had it is gone).
  useLayoutEffect(() => {
    const tabId = pendingReaderFocus.current
    if (tabId === null) return
    pendingReaderFocus.current = null
    document.getElementById(`tabpanel-${tabId}`)?.querySelector<HTMLElement>('main.reader-wrap:not([hidden])')?.focus({ preventScroll: true })
  }, [tabs])

  /**
   * PROTOTYPE: the 搜索 page as a new step of the active tab, on 本机 and focused there. On such a
   * page already: `local` shows 本机, `shown` keeps the side; that side's search box takes focus.
   */
  const openSearchPage = useCallback(
    (side: 'local' | 'shown') => {
      closeNav(false)
      if (protoSettingsShown) endSettings(false)
      withActive((tab) => {
        const entry = currentEntry(tab)
        if (entry.kind === 'online-search') {
          const shown: SearchPageSide = side === 'local' ? 'local' : (registry.searchPageMemory.get(entry.key)?.side ?? 'local')
          registry.searchPages.get(entry.key)?.current.show(shown)
          return
        }
        leave(tab)
        // The page takes the tab's local search, with focus on its query (also over an open sheet).
        searchCommands.open(tab.id, { view: 'local' })
        dispatch({ type: 'navigate', tabId: tab.id, entry: { kind: 'online-search' } })
      })
    },
    [closeNav, protoSettingsShown, endSettings, withActive, registry, leave, searchCommands]
  )

  /**
   * Search of the active tab. `thread` searches the thread its reader shows, starting in the mode
   * it is shown in; `local` everything retained (PROTOTYPE: the 搜索 page). Its entry points are
   * inert or skipped (shortcuts) while another modal dialog covers the app; with the sheet itself
   * open it switches its view.
   */
  const openSearch = useCallback(
    (request: SearchRequest) => {
      if (PROTOTYPE_ENABLED && request.view === 'local') {
        openSearchPage('local')
        return
      }
      closeNav(false)
      withActive((tab) => {
        if (request.view === 'local') {
          searchCommands.open(tab.id, { view: 'local' })
          return
        }
        if (currentEntry(tab).key !== request.entryKey) return
        searchCommands.open(tab.id, { view: 'thread', scope: { threadId: request.threadId, mode: request.mode, title: request.title } })
      })
    },
    [openSearchPage, closeNav, withActive, searchCommands]
  )

  const openLocalSearch = useCallback(() => openSearch({ view: 'local' }), [openSearch])

  /** Ctrl/Cmd+F: the thread on screen, else everything retained. */
  const searchShownThread = useCallback(
    () =>
      withActive((tab) => {
        const entry = currentEntry(tab)
        const shown =
          entryThread(entry) !== null && readerShown(tab, entry, stateRef.current.singlePane)
            ? (registry.readers.get(entry.key)?.current.shown() ?? null)
            : null
        openSearch(shown === null ? { view: 'local' } : { view: 'thread', entryKey: entry.key, ...shown })
      }),
    [withActive, registry, openSearch]
  )

  // ---------- Keyboard (spec I11): one app-level dispatcher ----------
  const actions = useRef<Record<ShortcutAction, () => void> | null>(null)
  useLayoutEffect(() => {
    actions.current = {
      'new-tab': newTab,
      'close-tab': () => withActive((tab) => closeTab(tab.id)),
      'next-tab': () => dispatch({ type: 'cycle', delta: 1 }),
      'previous-tab': () => dispatch({ type: 'cycle', delta: -1 }),
      refresh,
      save: saveCurrent,
      back: goBack,
      forward: goForward,
      'open-settings': openSettingsTop,
      'search-thread': searchShownThread,
      'search-local': openLocalSearch
    }
  })

  useEffect(() => {
    if (platform === null) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const action = matchShortcut(event, platform)
      if (action === null) return
      // Text fields keep their editing keys (history keys); Ctrl/Cmd+, is not one and works there too.
      if ((action === 'back' || action === 'forward') && isEditableTarget(event.target)) return
      event.preventDefault()
      // A modal dialog over the app is the only layer: shortcuts never act on the tabs behind it.
      // Ctrl/Cmd+F and Ctrl/Cmd+Shift+F still reach the search sheet when it is that dialog.
      const searchAction = action === 'search-thread' || action === 'search-local'
      if (stateRef.current.covered && !(searchAction && stateRef.current.searchOpen)) return
      if (event.repeat && action !== 'next-tab' && action !== 'previous-tab' && action !== 'back' && action !== 'forward') return
      actions.current?.[action]()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [platform])

  // ---------- Render ----------
  // Re-render when an online search page's submitted query (its tab title) changes.
  useSyncExternalStore(registry.onlineSearches.subscribe, registry.onlineSearches.getVersion)
  const titleOf = useCallback(
    (tab: Tab) => {
      const entry = currentEntry(tab)
      if (entry.kind === 'thread') return threadTitle(entry.thread)
      if (entry.kind === 'online-search') return PROTOTYPE_ENABLED ? '搜索' : registry.onlineSearches.title(entry.key)
      if (entry.feed === null) return '新标签'
      const feed = entry.feed
      const name =
        feed.kind === 'subscriptions'
          ? '订阅'
          : feed.kind === 'reminders'
            ? '提醒'
            : feed.kind === 'history'
              ? '历史'
              : feed.kind === 'offline'
                ? '离线'
                : (feedInfo(feed)?.name ?? (feed.kind === 'timeline' ? '时间线' : '版面'))
      return entry.thread !== null && tab.split ? `${name} › ${threadTitle(entry.thread)}` : name
    },
    [feedInfo, registry]
  )

  const entry = current === null ? null : currentEntry(current)
  const selectedFeed = entry?.kind === 'list' ? entry.feed : null
  const onlineSearchCurrent = entry?.kind === 'online-search'

  const workspaceStyle = {
    '--nav-width': `${layout.navWidth}px`,
    '--nav-full': `${navFull}px`,
    // Hidden split tabs keep the chosen width while the active entry shows no list beside a reader.
    '--list-width': `${layout.listWidth > 0 ? layout.listWidth : Math.min(listPreference, LAYOUT_DEFAULTS.listWidth)}px`
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

  // ---------- PROTOTYPE: navigation variants (unused unless built in) ----------
  /** Choosing content leaves the settings page; the content, not the page's opener, gets focus. */
  const protoSelect = useCallback(
    (ref: ListRef, focus: 'nav' | 'list' = 'nav') => {
      if (protoSettingsShown) endSettings(false)
      selectFeed(ref, focus)
    },
    [protoSettingsShown, endSettings, selectFeed]
  )
  /** Lists opened from inside content (e.g. the reminders empty state): focus goes to the list. */
  const openList = useCallback((ref: ListRef) => protoSelect(ref, 'list'), [protoSelect])
  /** Lists of the tab (订阅的串, 提醒, 历史, 离线) and 搜索 are pages; the rest open dialogs. */
  const openProtoFeature = useCallback(
    (id: FeatureId, focusTarget = false) => {
      if (id === 'history') openHistoryView('browsing')
      else if (id === 'subscriptions' || id === 'reminders' || id === 'offline') {
        protoSelect({ kind: id }, focusTarget ? 'list' : 'nav')
      } else if (id === 'search') {
        // The page focuses its search box itself.
        openSearchPage('shown')
      } else if (id === 'drafts') openDrafts()
    },
    [protoSelect, openSearchPage, openDrafts, openHistoryView]
  )
  const protoFeatures = useMemo<FeatureHost>(
    () => ({
      open: openProtoFeature,
      current: protoSettingsShown
        ? null
        : onlineSearchCurrent
          ? 'search'
          : selectedFeed !== null && isLocalList(selectedFeed)
            ? selectedFeed.kind
            : null,
      reminderBadge,
      pendingAttempts,
      searchShortcut: shortcutLabel('search-local', platform)
    }),
    [openProtoFeature, protoSettingsShown, onlineSearchCurrent, selectedFeed, reminderBadge, pendingAttempts, platform]
  )

  /**
   * D: the board panel lives in the navigation. Opened from the tab content in the overlay layout,
   * the overlay opens first to hold it; the panel opens once the overlay is on the layer stack, so
   * it is the top layer and Esc closes it first (spec I11).
   */
  const { open: navOverlayOpen, toggle: toggleNavOverlay } = navPopover
  /** Waiting for the overlay opened to hold the panel. */
  const boardsPendingOpener = useRef<HTMLElement | null>(null)
  /** The overlay was opened only to hold the panel: the panel's end ends it too (see `closed`). */
  const boardsCarrier = useRef(false)
  // The panel closes with what holds it (overlay closed, column → overlay, variant switch).
  useEffect(() => {
    if (navVariant !== 'D' || (navOverlay && !navOverlayOpen)) {
      boardsPendingOpener.current = null
      closeBoardPanel('dismiss')
      boardsCarrier.current = false
    }
  }, [navVariant, navOverlay, navOverlayOpen])
  // Declared after `usePopover`, whose effect puts the overlay on the layer stack in the same flush.
  useEffect(() => {
    const opener = boardsPendingOpener.current
    if (opener === null || !navOverlayOpen) return
    boardsPendingOpener.current = null
    boardsCarrier.current = true
    openBoardPanel(opener)
  }, [navOverlayOpen])
  const openProtoBoards = useCallback(
    (button: HTMLButtonElement) => {
      if (navOverlay && !navOverlayOpen) {
        boardsPendingOpener.current = button
        toggleNavOverlay()
      } else {
        openBoardPanel(button)
      }
    },
    [navOverlay, navOverlayOpen, toggleNavOverlay]
  )
  // The panel decides focus when it closes (prototypeStore); the app keeps the overlay in step
  // without moving focus, so nothing else competes for it.
  useLayoutEffect(() => {
    if (navVariant !== 'D') return
    setBoardPanelHost({
      home: () =>
        navOverlay ? navTriggerRef.current : (inlineNavRef.current?.querySelector<HTMLElement>('[data-proto-boards-trigger]') ?? null),
      closed: (end, at) => {
        const carrier = boardsCarrier.current
        boardsCarrier.current = false
        const outsideOverlay = at === null || navPanelRef.current?.contains(at) !== true
        // A board chosen: the overlay ends too (the new list's board name takes focus, not 打开导航).
        // Cancelled while the overlay only held the panel: back to before both opened, unless the
        // press landed on the overlay's own controls. Focus left for what the overlay covers: it
        // ends so that focus is not hidden under it.
        if (end === 'select' || (end === 'cancel' && carrier && outsideOverlay) || (end === 'leave' && outsideOverlay)) {
          closeNav(false)
        }
      }
    })
    return () => setBoardPanelHost(null)
  }, [navVariant, navOverlay, closeNav])
  const protoListHost = useMemo<ListHost | null>(() => {
    if (navVariant === 'D') {
      return {
        boardTitle: (name) => <BoardPanelTitle name={name} onOpen={openProtoBoards} />,
        listTop: null,
        emptyPage: () => <BoardPanelEmptyPage onOpen={openProtoBoards} />
      }
    }
    if (navVariant === 'E') {
      return {
        boardTitle: null,
        listTop: (feed) => <BoardStrip current={feed} directory={dirData} onSelect={protoSelect} />,
        emptyPage: () => <BoardChooserPage directory={dirData} onSelect={protoSelect} />
      }
    }
    return null
  }, [navVariant, openProtoBoards, dirData, protoSelect])

  const protoNav = (placement: 'inline' | 'overlay') => {
    if (navVariant === null) return null
    const common = {
      state: directory.state,
      selected: protoSettingsShown ? null : selectedFeed,
      onSelect: protoSelect,
      onRetry: directory.retry,
      features: protoFeatures,
      settingsCurrent: protoSettingsShown,
      onOpenSettings: openSettingsTop
    }
    const props: PrototypeNavProps =
      placement === 'inline'
        ? { ...common, variant: 'inline', progress: layout.navProgress, panelRef: inlineNavRef }
        : { ...common, variant: 'overlay', progress: 0, panelRef: navPanelRef, id: 'nav-overlay' }
    if (navVariant === 'B') return <PrototypeNavB {...props} />
    if (navVariant === 'D') return <PrototypeNavD {...props} />
    if (navVariant === 'E') return <PrototypeNavE {...props} />
    return <PrototypeNavF {...props} />
  }

  const protoSettingsPage =
    navVariant === null ? null : (
      <PrototypeSettingsPage
        identities={identities}
        subscriptions={subscriptions}
        settings={settings}
        platform={platform}
        status={settingsWriter.status}
        write={settingsWriter.write}
        adopt={settingsWriter.adopt}
        directory={dirData}
        target={settingsTarget}
        onClose={closeSettings}
      />
    )

  return (
    <AppCoveredContext value={coverage}>
    <SettingsOpenerContext value={openSettings}>
      <EditorWorkspaceContext value={editorWorkspace}>
      <SubscriptionsContext value={subscriptions}>
      <RemindersContext value={reminders}>
      <ListOpenerContext value={openList}>
      <ThreadTabOpenerContext value={PROTOTYPE_ENABLED ? openThreadInTab : null}>
      <HistoryPageContext value={PROTOTYPE_ENABLED ? { request: historyRequest, tabTitle, onContinue: continueDraft, onOpenTarget: openTargetInTab } : null}>
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
            <SearchOpenerContext value={openSearch}>
            <LocalSearchContext value={localSearchHost}>
            <ListHostContext value={protoListHost}>
            <div className={navOverlay ? 'workspace is-nav-overlay' : 'workspace'} style={workspaceStyle}>
              {!navOverlay && (
                <div
                  className="nav-column"
                  onFocus={() => (navHadFocus.current = true)}
                  onBlur={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) navHadFocus.current = false
                  }}
                >
                  {navVariant !== null ? protoNav('inline') : <Navigation
                    state={directory.state}
                    selected={selectedFeed}
                    onSelect={selectFeed}
                    onlineSearchCurrent={onlineSearchCurrent}
                    onOpenOnlineSearch={openOnlineSearch}
                    onRetry={directory.retry}
                    variant="inline"
                    progress={layout.navProgress}
                    panelRef={inlineNavRef}
                    identities={identities}
                    onOpenSettings={openCookieSettings}
                    onOpenDrafts={openDrafts}
                    onOpenRetained={openRetained}
                    onOpenAttempts={openAttempts}
                    onOpenOwnPosts={openOwnPosts}
                    pendingAttempts={pendingAttempts}
                    reminderBadge={reminderBadge}
                    onOpenLocalSearch={openLocalSearch}
                    localSearchShortcut={shortcutLabel('search-local', platform)}
                  />}
                </div>
              )}

              <div className="main-column">
                {tabs !== null && current !== null && entry !== null && (
                  <>
                    {!protoSettingsShown && <TopBar
                      tabs={tabs.tabs}
                      activeId={tabs.activeId}
                      titleOf={titleOf}
                      platform={platform}
                      canBack={current.index > 0 && !protoSettingsShown}
                      backLabel={
                        current.index === 0 || protoSettingsShown
                          ? null
                          : entry.origin === 'quote'
                            ? '返回引用处'
                            : entry.origin === 'local-search' || entry.origin === 'online-search'
                              ? '返回搜索结果'
                              : null
                      }
                      canForward={current.index < current.entries.length - 1 && !protoSettingsShown}
                      splitToggle={entry.kind === 'list' && !protoSettingsShown ? { pressed: current.split, onToggle: toggleSplit } : null}
                      navTrigger={navOverlay ? { ref: navTriggerRef, expanded: navPopover.open, onToggle: navPopover.toggle } : null}
                      onBack={goBack}
                      onForward={goForward}
                      onActivate={activate}
                      onClose={closeTab}
                      onNewTab={newTab}
                      settingsTrigger={
                        navVariant !== null && !navOverlay
                          ? null
                          : { ref: settingsButtonRef, expanded: settingsOpen || protoSettingsShown, onOpen: openSettingsTop }
                      }
                    />}
                    <div className="tab-host" hidden={protoSettingsShown ? true : undefined}>
                      {tabs.tabs.map((tab) => (
                        <TabView
                          key={tab.id}
                          tab={tab}
                          active={tab.id === tabs.activeId}
                          composeHidden={protoSettingsShown}
                          onResizeList={PROTOTYPE_ENABLED ? resizeList : null}
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
                          onOpenFromOnlineSearch={openFromOnlineSearch}
                        />
                      ))}
                    </div>
                    {protoSettingsShown && protoSettingsPage}
                  </>
                )}
              </div>

              {navOverlay && navPopover.open && (
                <>
                  <div className="nav-overlay-layer" aria-hidden="true" />
                  {navVariant !== null ? protoNav('overlay') : <Navigation
                    state={directory.state}
                    selected={selectedFeed}
                    onSelect={selectFeed}
                    onlineSearchCurrent={onlineSearchCurrent}
                    onOpenOnlineSearch={openOnlineSearch}
                    onRetry={directory.retry}
                    variant="overlay"
                    progress={0}
                    panelRef={navPanelRef}
                    id="nav-overlay"
                    identities={identities}
                    onOpenSettings={openCookieSettings}
                    onOpenDrafts={openDrafts}
                    onOpenRetained={openRetained}
                    onOpenAttempts={openAttempts}
                    onOpenOwnPosts={openOwnPosts}
                    pendingAttempts={pendingAttempts}
                    reminderBadge={reminderBadge}
                    onOpenLocalSearch={openLocalSearch}
                    localSearchShortcut={shortcutLabel('search-local', platform)}
                  />}
                </>
              )}
            </div>
            </ListHostContext>
            </LocalSearchContext>
            </SearchOpenerContext>
            </QuoteActiveContext.Provider>
            </QuoteControllerContext.Provider>
          </ContentRegistryContext.Provider>
          {/* Outside every reader's content: showing a quote card never counts as reading. */}
          {quote.cardProps !== null && <QuoteCard {...quote.cardProps} />}
          {/* Modal: readers below judge nothing read while it is open, and hits shown here never count as reading.
              PROTOTYPE: not while a 搜索 page holds the local search open; the page shows it. */}
          {tabs !== null && search.state.openTab === tabs.activeId && searchPageTab === null && (
            <SearchSheet
              key={`${tabs.activeId}:${search.state.restoreSeq}`}
              tabId={tabs.activeId}
              tab={tabSearchOf(search.state, tabs.activeId)}
              rebuild={search.state.rebuild}
              focus={search.state.focus}
              focusSeq={search.state.focusSeq}
              restoreSeq={search.state.restoreSeq}
              commands={searchCommands}
              forums={names}
              platform={platform}
              fallbackFocus={() => document.querySelector<HTMLElement>(`#tabpanel-${tabs.activeId} [data-pane-focus]`)}
            />
          )}
          {settingsOpen && (
            <SettingsDialog
              identities={identities}
              subscriptions={subscriptions}
              settings={settings}
              platform={platform}
              status={settingsWriter.status}
              write={settingsWriter.write}
              adopt={settingsWriter.adopt}
              onClose={closeSettings}
              fallbackFocus={() => settingsButtonRef.current}
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
              filters={registry.retainedFilters}
              forumNames={names}
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
          {navVariant !== null && (
            <PrototypeSwitcher variants={NAV_VARIANTS} current={navVariant} onChange={setNavVariant} />
          )}
          <LifecycleHost
            platform={platform}
            onSettingsChange={setSettings}
            closeModals={closeForQuit}
            buildWorkspace={buildWorkspace}
            whenRestored={whenRestored}
          />
        </div>
      </HistoryPageContext>
      </ThreadTabOpenerContext>
      </ListOpenerContext>
      </RemindersContext>
      </SubscriptionsContext>
      </EditorWorkspaceContext>
    </SettingsOpenerContext>
    </AppCoveredContext>
  )
}
