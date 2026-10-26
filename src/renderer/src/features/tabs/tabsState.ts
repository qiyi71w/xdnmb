import type { FeedRef, Post, PostId, ReadingMode, ThreadId } from '../../../../shared/forum'
import type { ReadingAnchor } from '../../../../shared/reading'

/**
 * Explicit target inside a thread (a located quote or search hit, a reminder event). It
 * takes priority over every remembered position. When `mode` differs from the thread's saved
 * preference the reader shows the target in `mode` temporarily and leaves the preference unchanged.
 */
export interface ThreadTarget {
  postId: PostId
  /** Page where the target was observed in `mode`. */
  page: number
  mode: ReadingMode
}

/**
 * The quote that started a quote navigation: the `quoteIndex`-th quote reference (document order,
 * from 0) in the body of post `postId`. Focus goes back to it when the entry is shown again.
 */
export interface SourceFocus {
  postId: PostId
  quoteIndex: number
}

/** Where a history entry was left: restored when the reader comes back to this entry. */
export interface ThreadSnapshot {
  mode: ReadingMode
  anchor: ReadingAnchor
  /** Reading-data generation of the reader that captured it; a later history clear voids it. */
  generation: number
  /**
   * The preference a temporary target display stood in for when the entry was left, else `null`.
   * Coming back keeps the display temporary only while the preference still differs from `mode`.
   */
  temporaryOf: ReadingMode | null
  /**
   * Focus to give back on return: the quote the entry was left through. A later leave without a
   * quote (back / forward) keeps it, so walking the history again still returns focus there.
   */
  focus: SourceFocus | null
}

export interface ThreadOpen {
  threadId: ThreadId
  /** Main post already known from the list, shown until page 1 arrives. */
  head: Post | null
  target: ThreadTarget | null
  snapshot: ThreadSnapshot | null
  /**
   * Set when the thread was opened through 打开原串 for a quote that could not be located: the
   * reader opens normally (resume rules) and keeps saying this post was not located.
   */
  unlocatedPostId: PostId | null
}

/**
 * `quote`: the entry was produced by a located quote or by 打开原串, so the back control reads
 * 返回引用处. `local-search`: produced by a located hit of the thread search sheet or of
 * the 搜索 page's 本机 side; back reads 返回搜索结果 and shows that tab's search sheet or page again with the search the source entry had.
 * `online-search`: opened from a result of an `online-search` page; back reads 返回搜索结果 and the
 * page comes back from its session (query, obtained pages, scroll, focused result) without any new
 * request. Choosing another list item in the entry clears the origin; history is kept either way.
 * All three are transient: a saved workspace keeps such steps as plain ones.
 */
export type EntryOrigin = 'quote' | 'local-search' | 'online-search' | null

/**
 * What a list entry shows: a forum/timeline feed, the remote subscription list of whichever
 * source (App / 网页) is currently selected, the local 提醒 list (reminder events by thread), or
 * the local 历史 / 离线 page. Renderer-only; forum reads still take a `FeedRef`.
 */
export type ListRef = FeedRef | { kind: 'subscriptions' } | { kind: 'reminders' } | { kind: 'history' } | { kind: 'offline' }

/** The lists of this app's own records, which have no forum ID. */
export type LocalListRef = Exclude<ListRef, FeedRef>

export function isLocalList(ref: ListRef): ref is LocalListRef {
  return ref.kind !== 'forum' && ref.kind !== 'timeline'
}

export function listKey(ref: ListRef): string {
  return isLocalList(ref) ? ref.kind : `${ref.kind}:${ref.id}`
}

/**
 * One step of a tab's navigation history.
 * - `list`: a forum/timeline/subscription list (`feed` null = a new tab that has not chosen one
 *   yet). In split layout the open thread is shown beside the list; `pane` is what the
 *   single-pane fallback shows.
 * - `thread`: a thread opened as a whole page (split off).
 * - `online-search`: an online search page. Its session (query chain, obtained pages) belongs to
 *   this entry and is released when the entry leaves every tab's history. It is the 搜索 page,
 *   with the tab's local search as its 本机 side and this session as its 联网 side.
 */
export type TabEntry =
  | { kind: 'list'; key: number; feed: ListRef | null; thread: ThreadOpen | null; pane: 'list' | 'reader'; origin: EntryOrigin }
  | { kind: 'thread'; key: number; thread: ThreadOpen; origin: EntryOrigin }
  | { kind: 'online-search'; key: number; origin: EntryOrigin }

export type EntryInit =
  | { kind: 'list'; feed: ListRef | null; thread?: ThreadOpen | null }
  | { kind: 'thread'; thread: ThreadOpen }
  | { kind: 'online-search' }

export interface Tab {
  id: number
  /** This tab's own split preference. Window width never changes it. */
  split: boolean
  entries: TabEntry[]
  index: number
}

export interface TabsState {
  tabs: Tab[]
  activeId: number
  nextId: number
  nextKey: number
}

export type TabsAction =
  /** `split` is the global “新标签默认开启分栏” value at creation time. */
  | { type: 'open-tab'; entry: EntryInit; split: boolean; background: boolean }
  /** Closing the last tab leaves one new empty tab with `split`. */
  | { type: 'close-tab'; tabId: number; split: boolean }
  | { type: 'activate'; tabId: number }
  | { type: 'cycle'; delta: 1 | -1 }
  | { type: 'set-split'; tabId: number; split: boolean }
  /**
   * New navigation step; drops the forward branch. Ignored when it would repeat the current list or
   * open an online search page from one. `origin` labels the new step (`online-search` for a result).
   */
  | { type: 'navigate'; tabId: number; entry: EntryInit; origin?: EntryOrigin }
  /** Opening a list item: split replaces the shown thread (no back step); otherwise a new step. */
  | { type: 'select-thread'; tabId: number; thread: ThreadOpen }
  /** Single-pane fallback switches between the list and the reader of the same entry. */
  | { type: 'show-pane'; tabId: number; pane: 'list' | 'reader' }
  | { type: 'back'; tabId: number }
  | { type: 'forward'; tabId: number }
  /**
   * Remember where the thread of the current entry was left (and drop its consumed target) before
   * leaving the entry, so coming back restores it.
   */
  | { type: 'snapshot'; tabId: number; entryKey: number; snapshot: ThreadSnapshot }
  /**
   * A quote was located (or 打开原串 succeeded) while entry `entryKey` was current: remembers where
   * that entry was left (`source`, including the triggering quote) and pushes the target as a new
   * `quote` step, dropping the forward branch. A split list entry keeps its list beside the target.
   * Ignored when `entryKey` is no longer current (the reader navigated meanwhile).
   */
  | { type: 'quote-navigate'; tabId: number; entryKey: number; source: ThreadSnapshot | null; thread: ThreadOpen }
  /**
   * The same for a located hit of the local / thread search (or its 打开原串): a `local-search` step,
   * whose back control reads
   * 返回搜索结果. Works from any entry, an empty new tab included.
   */
  | { type: 'search-navigate'; tabId: number; entryKey: number; source: ThreadSnapshot | null; thread: ThreadOpen }

function makeEntry(init: EntryInit, key: number, origin: EntryOrigin = null): TabEntry {
  switch (init.kind) {
    case 'list':
      return { kind: 'list', key, feed: init.feed, thread: init.thread ?? null, pane: init.thread ? 'reader' : 'list', origin }
    case 'thread':
      return { kind: 'thread', key, thread: init.thread, origin }
    case 'online-search':
      return { kind: 'online-search', key, origin }
  }
}

/**
 * First entry of a background tab opened for a located quote. The tab gets the global split default
 * and no copy of the source history: with split on and a list shown in the source, the target opens
 * beside that list (fresh, not the source's loaded pages); otherwise as a whole-page thread.
 */
export function backgroundTabEntry(source: TabEntry, splitDefault: boolean, thread: ThreadOpen): EntryInit {
  return splitDefault && source.kind === 'list' && source.feed !== null
    ? { kind: 'list', feed: source.feed, thread }
    : { kind: 'thread', thread }
}

export function initialTabsState(split: boolean): TabsState {
  return {
    tabs: [{ id: 1, split, entries: [makeEntry({ kind: 'list', feed: null }, 1)], index: 0 }],
    activeId: 1,
    nextId: 2,
    nextKey: 2
  }
}

/** The thread an entry shows (whole page, or beside its list); online search pages show none. */
export function entryThread(entry: TabEntry): ThreadOpen | null {
  return entry.kind === 'online-search' ? null : entry.thread
}

export function currentEntry(tab: Tab): TabEntry {
  return tab.entries[tab.index] as TabEntry
}

export function activeTab(state: TabsState): Tab {
  return state.tabs.find((tab) => tab.id === state.activeId) ?? (state.tabs[0] as Tab)
}

function sameList(a: ListRef | null, b: ListRef | null): boolean {
  return a === null || b === null ? a === b : listKey(a) === listKey(b)
}

function updateTab(state: TabsState, tabId: number, update: (tab: Tab) => Tab): TabsState {
  let changed = false
  const tabs = state.tabs.map((tab) => {
    if (tab.id !== tabId) return tab
    const next = update(tab)
    if (next !== tab) changed = true
    return next
  })
  return changed ? { ...state, tabs } : state
}

function push(state: TabsState, tabId: number, init: EntryInit, origin: EntryOrigin = null): TabsState {
  const key = state.nextKey
  const next = updateTab(state, tabId, (tab) => ({
    ...tab,
    entries: [...tab.entries.slice(0, tab.index + 1), makeEntry(init, key, origin)],
    index: tab.index + 1
  }))
  return next === state ? state : { ...next, nextKey: key + 1 }
}

function replaceCurrent(tab: Tab, entry: TabEntry): Tab {
  const entries = tab.entries.slice()
  entries[tab.index] = entry
  return { ...tab, entries }
}

export function tabsReducer(state: TabsState, action: TabsAction): TabsState {
  switch (action.type) {
    case 'open-tab': {
      const tab: Tab = { id: state.nextId, split: action.split, entries: [makeEntry(action.entry, state.nextKey)], index: 0 }
      const at = state.tabs.findIndex((item) => item.id === state.activeId)
      const tabs = [...state.tabs.slice(0, at + 1), tab, ...state.tabs.slice(at + 1)]
      return {
        tabs,
        activeId: action.background ? state.activeId : tab.id,
        nextId: state.nextId + 1,
        nextKey: state.nextKey + 1
      }
    }
    case 'close-tab': {
      const at = state.tabs.findIndex((tab) => tab.id === action.tabId)
      if (at < 0) return state
      const tabs = state.tabs.filter((tab) => tab.id !== action.tabId)
      if (tabs.length === 0) {
        const fresh: Tab = { id: state.nextId, split: action.split, entries: [makeEntry({ kind: 'list', feed: null }, state.nextKey)], index: 0 }
        return { tabs: [fresh], activeId: fresh.id, nextId: state.nextId + 1, nextKey: state.nextKey + 1 }
      }
      const activeId = action.tabId === state.activeId ? (tabs[Math.min(at, tabs.length - 1)] as Tab).id : state.activeId
      return { ...state, tabs, activeId }
    }
    case 'activate':
      return state.tabs.some((tab) => tab.id === action.tabId) && state.activeId !== action.tabId
        ? { ...state, activeId: action.tabId }
        : state
    case 'cycle': {
      if (state.tabs.length < 2) return state
      const at = state.tabs.findIndex((tab) => tab.id === state.activeId)
      const next = state.tabs[(at + action.delta + state.tabs.length) % state.tabs.length] as Tab
      return { ...state, activeId: next.id }
    }
    case 'set-split':
      return updateTab(state, action.tabId, (tab) => (tab.split === action.split ? tab : { ...tab, split: action.split }))
    case 'navigate': {
      const tab = state.tabs.find((item) => item.id === action.tabId)
      if (tab === undefined) return state
      const current = currentEntry(tab)
      if (
        action.entry.kind === 'list' &&
        current.kind === 'list' &&
        !action.entry.thread &&
        sameList(current.feed, action.entry.feed)
      ) {
        return state
      }
      if (action.entry.kind === 'online-search' && current.kind === 'online-search') return state
      return push(state, action.tabId, action.entry, action.origin ?? null)
    }
    case 'select-thread': {
      const tab = state.tabs.find((item) => item.id === action.tabId)
      if (tab === undefined) return state
      const current = currentEntry(tab)
      if (current.kind === 'list' && tab.split) {
        if (current.thread?.threadId === action.thread.threadId && current.pane === 'reader') return state
        if (current.thread?.threadId === action.thread.threadId) {
          return updateTab(state, action.tabId, (item) => replaceCurrent(item, { ...current, pane: 'reader' }))
        }
        // Choosing another item ends this entry's quote step: the back control reads 后退 again.
        return updateTab(state, action.tabId, (item) =>
          replaceCurrent(item, { ...current, thread: action.thread, pane: 'reader', origin: null })
        )
      }
      return push(state, action.tabId, { kind: 'thread', thread: action.thread })
    }
    case 'show-pane':
      return updateTab(state, action.tabId, (tab) => {
        const current = currentEntry(tab)
        if (current.kind !== 'list' || current.pane === action.pane) return tab
        if (action.pane === 'reader' && current.thread === null) return tab
        return replaceCurrent(tab, { ...current, pane: action.pane })
      })
    case 'back':
      return updateTab(state, action.tabId, (tab) => (tab.index > 0 ? { ...tab, index: tab.index - 1 } : tab))
    case 'forward':
      return updateTab(state, action.tabId, (tab) => (tab.index < tab.entries.length - 1 ? { ...tab, index: tab.index + 1 } : tab))
    case 'snapshot':
      return updateTab(state, action.tabId, (tab) => {
        const current = currentEntry(tab)
        if (current.key !== action.entryKey || current.kind === 'online-search' || current.thread === null) return tab
        const focus = action.snapshot.focus ?? current.thread.snapshot?.focus ?? null
        const thread: ThreadOpen = { ...current.thread, target: null, snapshot: { ...action.snapshot, focus } }
        return replaceCurrent(tab, { ...current, thread } as TabEntry)
      })
    case 'quote-navigate':
    case 'search-navigate': {
      const tab = state.tabs.find((item) => item.id === action.tabId)
      if (tab === undefined) return state
      const current = currentEntry(tab)
      if (current.key !== action.entryKey) return state
      const left = action.source === null ? state : tabsReducer(state, { type: 'snapshot', tabId: action.tabId, entryKey: action.entryKey, snapshot: action.source })
      const init: EntryInit =
        current.kind === 'list' && current.feed !== null && tab.split
          ? { kind: 'list', feed: current.feed, thread: action.thread }
          : { kind: 'thread', thread: action.thread }
      return push(left, action.tabId, init, action.type === 'quote-navigate' ? 'quote' : 'local-search')
    }
  }
}
