import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react'
import type { AppPlatform, StorageStatus } from '../../../shared/api'
import { sameTarget, type EditorId, type PostTarget, type SavedDraft } from '../../../shared/drafts'
import type { FeedRef, ThreadSummary } from '../../../shared/forum'
import { DEFAULT_SETTINGS, type AppSettings } from '../../../shared/reading'
import { Icon } from '../components/Icon'
import { feedKey, findFeed, forumNames, type FeedInfo } from '../features/directory/feeds'
import { Navigation, NavMeasure } from '../features/directory/Navigation'
import { useDirectory } from '../features/directory/useDirectory'
import { DraftLibraryDialog } from '../features/drafts/DraftLibraryDialog'
import { editorFor, editorForDraft, isUnsaved, unsavedInTab } from '../features/editor/editorsState'
import { UnsavedEditorsDialog } from '../features/editor/UnsavedEditorsDialog'
import { focusKey, useEditorsStore } from '../features/editor/useEditorsStore'
import { EditorWorkspaceContext, type EditorWorkspace } from '../features/editor/workspace'
import { useIdentities } from '../features/identity/useIdentities'
import { computeLayout, LAYOUT_DEFAULTS, type LayoutView } from '../features/layout/layout'
import { ContentRegistryContext, createContentRegistry } from '../features/tabs/contentRegistry'
import {
  activeTab,
  currentEntry,
  initialTabsState,
  tabsReducer,
  type EntryInit,
  type Tab,
  type TabEntry,
  type TabsAction,
  type TabsState,
  type ThreadOpen
} from '../features/tabs/tabsState'
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

/** Tabs exist only once the global split default is known (the first tab takes it). */
type ShellAction = TabsAction | { type: 'init'; split: boolean }

function shellReducer(state: TabsState | null, action: ShellAction): TabsState | null {
  if (action.type === 'init') return state ?? initialTabsState(action.split)
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
    ? { kind: 'thread', thread: { threadId: target.threadId, head: null, target: null, snapshot: null } }
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
  const { current: currentEditors, dispatch: dispatchEditors, requestFocus, save: saveEditor } = editors
  const [settingsOpen, setSettingsOpen] = useState(false)
  const openSettings = useCallback(() => setSettingsOpen(true), [])
  const closeSettings = useCallback(() => setSettingsOpen(false), [])
  const [draftsOpen, setDraftsOpen] = useState(false)
  const closeDrafts = useCallback(() => setDraftsOpen(false), [])
  /** Tab whose close waits for its unsaved editors to be handled. */
  const [closing, setClosing] = useState<{ tabId: number; editorIds: EditorId[] } | null>(null)

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

  useEffect(() => {
    let alive = true
    window.xidao.settings
      .get()
      .catch(() => DEFAULT_SETTINGS)
      .then((loaded) => {
        if (!alive) return
        setSettings(loaded)
        dispatch({ type: 'init', split: loaded.newTabSplitDefault })
      })
    return () => {
      alive = false
    }
  }, [])

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

  const withActive = useCallback((run: (tab: Tab) => void) => {
    const state = stateRef.current.tabs
    if (state !== null) run(activeTab(state))
  }, [])

  const selectFeed = useCallback(
    (ref: FeedRef) => {
      closeNav()
      withActive((tab) => {
        const entry = currentEntry(tab)
        if (entry.kind === 'list' && entry.feed !== null && feedKey(entry.feed) === feedKey(ref)) return
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
      const thread: ThreadOpen = { threadId: summary.head.id, head: summary.head, target: null, snapshot: null }
      dispatch({ type: 'select-thread', tabId, thread })
    },
    [leave]
  )

  const showPane = useCallback((tabId: number, pane: 'list' | 'reader') => dispatch({ type: 'show-pane', tabId, pane }), [])

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

  // List memory lives only as long as its entry is in some tab's history (forward branch replaced,
  // tab closed → dropped).
  useEffect(() => {
    if (tabs === null) return
    const live = new Set<number>()
    for (const tab of tabs.tabs) for (const item of tab.entries) live.add(item.key)
    for (const key of registry.listMemory.keys()) if (!live.has(key)) registry.listMemory.delete(key)
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
      'close-tab': () => withActive((tab) => closeTab(tab.id)),
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
      const name = feedInfo(entry.feed)?.name ?? (entry.feed.kind === 'timeline' ? '时间线' : '版面')
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
    () => ({ store: editors, identities, platform, directory: dirData, forumName, retarget }),
    [editors, identities, platform, dirData, forumName, retarget]
  )

  const tabTitle = (tabId: number) => {
    const tab = tabs?.tabs.find((item) => item.id === tabId)
    return tab === undefined ? '已关闭的标签' : titleOf(tab)
  }

  return (
    <SettingsOpenerContext value={openSettings}>
      <EditorWorkspaceContext value={editorWorkspace}>
        <div className="app" ref={appRef}>
          <StorageBanner storage={storage} />
          <div className="measure-reading" ref={readingMeasureRef} aria-hidden="true" />
          <div className="measure-scrollbar" ref={scrollbarMeasureRef} aria-hidden="true" />
          <NavMeasure directory={dirData} onMeasure={setNavCompactMin} />
          <ContentRegistryContext.Provider value={registry}>
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
                          feedInfo={feedInfo}
                          forumNames={names}
                          forumName={forumName}
                          onSelectThread={selectThread}
                          onShowPane={showPane}
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
                  />
                </>
              )}
            </div>
          </ContentRegistryContext.Provider>
          {settingsOpen && (
            <SettingsDialog
              identities={identities}
              settings={settings}
              onSettingsChange={setSettings}
              onClose={closeSettings}
            />
          )}
          {draftsOpen && (
            <DraftLibraryDialog
              tabTitle={tabTitle}
              onContinue={continueDraft}
              onClose={closeDrafts}
              fallbackFocus={() => navTriggerRef.current}
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
        </div>
      </EditorWorkspaceContext>
    </SettingsOpenerContext>
  )
}
