import { createContext, useContext, useEffect, useRef } from 'react'
import type { FeedState } from '../feed/feedState'
import type { TabsState, ThreadSnapshot } from './tabsState'
import { MAX_LIST_PAGES, type WorkspaceList } from './workspaceSnapshot'

/** What the shell can ask of the reader mounted for a history entry. */
export interface ReaderHandle {
  /** Mode and anchor to come back to; null before the reader has placed its first position. */
  capture(): ThreadSnapshot | null
  refresh(): void
}

export interface ListHandle {
  refresh(): void
}

/**
 * What a list entry has (kept current while mounted, as it was when unmounted): loaded pages,
 * scroll position and the first visible thread when it was last displayed.
 */
export interface ListMemory {
  state: FeedState
  scrollTop: number
  anchor: WorkspaceList['anchor']
}

/**
 * Mounted readers and lists, keyed by the history entry key that shows them, plus the runtime
 * memory of lists that are not mounted (split toggled, single pane, back/forward). Memory lives
 * only while the app runs; the shell drops it when its entry leaves every tab's history.
 * `savedLists` is list context restored from the last quit for lists not shown again yet: a list
 * consumes its own once it has read its pages again and placed its position, or was refreshed.
 */
export interface ContentRegistry {
  readers: Map<number, { current: ReaderHandle }>
  lists: Map<number, { current: ListHandle }>
  listMemory: Map<number, ListMemory>
  savedLists: Map<number, WorkspaceList>
}

export function createContentRegistry(): ContentRegistry {
  return { readers: new Map(), lists: new Map(), listMemory: new Map(), savedLists: new Map() }
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
      if (memory !== undefined && memory.state.pages.length > 0) {
        lists.push({
          entryKey: entry.key,
          pages: Math.min(memory.state.pages.length, MAX_LIST_PAGES),
          anchor: memory.anchor,
          scrollTop: Math.max(0, memory.scrollTop)
        })
      } else if (saved !== undefined) {
        lists.push(saved)
      }
    }
  }
  return lists
}

export const ContentRegistryContext = createContext<ContentRegistry | null>(null)

/** Registers the latest `handle` under `entryKey` for as long as the component is mounted. */
export function useRegisterContent<K extends 'readers' | 'lists'>(
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
