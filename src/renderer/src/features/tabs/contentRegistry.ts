import { createContext, useContext, useEffect, useRef } from 'react'
import type { ThreadId } from '../../../../shared/forum'
import { createFavoriteWrites, type FavoriteWrites } from '../content/favoriteWrites'
import { createReadingResets, type ReadingResets } from '../content/readingResets'
import type { FeedState } from '../feed/feedState'
import type { ThreadSnapshot, ThreadTarget } from './tabsState'

/** What the shell can ask of the reader mounted for a history entry. */
export interface ReaderHandle {
  /** Mode and anchor to come back to; null before the reader has placed its first position. */
  capture(): ThreadSnapshot | null
  refresh(): void
  /**
   * A located quote target: when this reader shows the same thread in the same mode and the target
   * post is visible in its viewport, highlights it and returns true (no navigation needed).
   */
  showInPlace(threadId: ThreadId, target: ThreadTarget): boolean
}

export interface ListHandle {
  refresh(): void
}

/** What a list entry had when its list was last unmounted: loaded pages and scroll position. */
export interface ListMemory {
  state: FeedState
  scrollTop: number
}

/**
 * Mounted readers and lists, keyed by the history entry key that shows them, plus the runtime
 * memory of lists that are not mounted (split toggled, single pane, back/forward). Memory lives
 * only while the app runs; the shell drops it when its entry leaves every tab's history.
 * `readingResets` tells open readers that their thread's reading data was cleared; `favorites`
 * keeps every mounted 收藏 entry point on the last successfully written state.
 */
export interface ContentRegistry {
  readers: Map<number, { current: ReaderHandle }>
  lists: Map<number, { current: ListHandle }>
  listMemory: Map<number, ListMemory>
  readingResets: ReadingResets
  favorites: FavoriteWrites
}

export function createContentRegistry(): ContentRegistry {
  return { readers: new Map(), lists: new Map(), listMemory: new Map(), readingResets: createReadingResets(), favorites: createFavoriteWrites() }
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
