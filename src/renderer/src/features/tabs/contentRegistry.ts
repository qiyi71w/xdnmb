import { createContext, useContext, useEffect, useRef } from 'react'
import type { ReadingMode, ThreadId } from '../../../../shared/forum'
import type { ContentFilters } from '../../../../shared/search'
import { createReadingResets, type ReadingResets } from '../content/readingResets'
import type { FeedState } from '../feed/feedState'
import { OnlineSearchSessions } from '../search/onlineSearchSession'
import type { SubscriptionListState } from '../subscriptions/subscriptionListState'
import type { TabsState, ThreadSnapshot, ThreadTarget } from './tabsState'
import { MAX_LIST_PAGES, type WorkspaceList } from './workspaceSnapshot'

/** The two lists of this app's retained content: 历史 (its 浏览 page) and 离线. */
export type RetainedPage = 'history' | 'offline'

/** The three pages of 历史: 浏览, then the sent records of 新串 and of 回复. */
export type HistoryView = 'browsing' | 'threads' | 'replies'

/** 历史 while mounted or in navigation history: the page shown and where 新串／回复 were scrolled. */
export interface HistoryMemory {
  view: HistoryView
  sentScroll: Record<'threads' | 'replies', number>
}

/** What the shell can ask of the reader mounted for a history entry. */
export interface ReaderHandle {
  /** Mode and anchor to come back to; null before the reader has placed its first position. */
  capture(): ThreadSnapshot | null
  refresh(): void
  /**
   * A located quote target: when this reader shows the same thread in the same mode and the target
   * post is visible in its viewport, highlights it and returns true (no navigation needed). A
   * page-only target is never shown in place.
   */
  showInPlace(threadId: ThreadId, target: ThreadTarget): boolean
  /** Thread and mode on screen now (a temporary target mode included), for 串内搜索. */
  shown(): { threadId: ThreadId; mode: ReadingMode; title: string | null }
}

export interface ListHandle {
  refresh(): void
}

/** What the shell can ask of a mounted online search page. */
export interface OnlineSearchPaneHandle {
  /** Moves keyboard focus to the search box (choosing 联网搜索 while already on the page). */
  focusInput(): void
}

/** 搜索 page: which search it shows. */
export type SearchPageSide = 'local' | 'online'

/** What the shell can ask of a mounted 搜索 page. */
export interface SearchPageHandle {
  /** Shows that side and focuses its search box (搜索 chosen while already on the page). */
  show(side: SearchPageSide): void
}

/** 搜索 page while mounted or in navigation history: the side shown, where 本机 was scrolled. */
export interface SearchPageMemory {
  side: SearchPageSide
  localScrollTop: number
}

/**
 * What a list entry has while mounted or in navigation history, discriminated by its source, with
 * the filters of the feed and subscription lists.
 */
export type ListMemory =
  | { kind: 'feed'; state: FeedState; scrollTop: number; anchor: WorkspaceList['anchor']; filters: ContentFilters }
  | {
      kind: 'subscriptions'
      state: SubscriptionListState
      scrollTop: number
      view: 'list' | 'reconcile'
      filters: ContentFilters
    }
  /** The 提醒 list reads its overview again on mount; only where it was scrolled is kept. */
  | { kind: 'reminders'; scrollTop: number }
  /**
   * 历史 / 离线 pages: read again on mount, likewise only the scroll position is kept (历史: of its
   * 浏览 page, plus its runtime `history` memory).
   */
  | { kind: 'retained'; scrollTop: number; history?: HistoryMemory }

/**
 * Mounted readers, lists, online search pages and 搜索 pages, keyed by the history entry
 * key that shows them, plus the runtime memory of lists that are not mounted (split toggled, single
 * pane, back/forward), the sessions of online search entries (query, obtained pages, view) and the
 * side and 本机 scroll of 搜索 pages. Memory lives only while the app runs; the shell drops it when
 * its entry leaves every tab's history.
 * `readingResets` tells open readers that their thread's reading data was cleared;
 * `retainedFilters` keeps the filters of each 历史／离线 list while the app runs.
 * `savedLists` is list context restored from the last quit for lists not shown again yet: a list
 * consumes its own once it has read its pages again and placed its position, or was refreshed.
 */
export interface ContentRegistry {
  readers: Map<number, { current: ReaderHandle }>
  lists: Map<number, { current: ListHandle }>
  onlineSearchPanes: Map<number, { current: OnlineSearchPaneHandle }>
  searchPages: Map<number, { current: SearchPageHandle }>
  searchPageMemory: Map<number, SearchPageMemory>
  listMemory: Map<number, ListMemory>
  readingResets: ReadingResets
  savedLists: Map<number, WorkspaceList>
  retainedFilters: Map<RetainedPage, ContentFilters>
  onlineSearches: OnlineSearchSessions
}

export function createContentRegistry(): ContentRegistry {
  return {
    readers: new Map(),
    lists: new Map(),
    onlineSearchPanes: new Map(),
    searchPages: new Map(),
    searchPageMemory: new Map(),
    listMemory: new Map(),
    readingResets: createReadingResets(),
    savedLists: new Map(),
    retainedFilters: new Map(),
    onlineSearches: new OnlineSearchSessions()
  }
}

/**
 * List context to save at a quit for every list entry with a feed: this run's memory when the list
 * has loaded pages, otherwise context restored from the last quit that no list has consumed yet.
 */
export function captureLists(tabs: TabsState, registry: ContentRegistry): WorkspaceList[] {
  const lists: WorkspaceList[] = []
  for (const tab of tabs.tabs) {
    for (const entry of tab.entries) {
      if (entry.kind !== 'list' || entry.feed === null) continue
      const memory = registry.listMemory.get(entry.key)
      const saved = registry.savedLists.get(entry.key)
      if (memory?.kind === 'feed' && memory.state.pages.length > 0) {
        lists.push({
          entryKey: entry.key,
          pages: Math.min(memory.state.pages.length, MAX_LIST_PAGES),
          anchor: memory.anchor,
          scrollTop: Math.max(0, memory.scrollTop)
        })
      } else if (memory?.kind === 'subscriptions') {
        lists.push({ entryKey: entry.key, pages: 1, anchor: null, scrollTop: Math.max(0, memory.scrollTop), subscriptionView: memory.view })
      } else if (memory?.kind === 'reminders' || memory?.kind === 'retained') {
        lists.push({ entryKey: entry.key, pages: 1, anchor: null, scrollTop: Math.max(0, memory.scrollTop) })
      } else if (saved !== undefined) {
        lists.push(saved)
      }
    }
  }
  return lists
}

export const ContentRegistryContext = createContext<ContentRegistry | null>(null)

/** Registers the latest `handle` under `entryKey` for as long as the component is mounted. */
export function useRegisterContent<K extends 'readers' | 'lists' | 'onlineSearchPanes' | 'searchPages'>(
  kind: K,
  entryKey: number,
  handle: ContentRegistry[K] extends Map<number, { current: infer H }> ? H : never
): void {
  const registry = useContext(ContentRegistryContext)
  const ref = useRef(handle)
  useEffect(() => {
    ref.current = handle
  })
  useEffect(() => {
    if (registry === null) return
    const map = registry[kind] as Map<number, { current: typeof handle }>
    map.set(entryKey, ref)
    return () => {
      if (map.get(entryKey) === ref) map.delete(entryKey)
    }
  }, [registry, kind, entryKey])
}
