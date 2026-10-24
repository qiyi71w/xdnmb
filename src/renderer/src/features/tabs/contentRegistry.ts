import { createContext, useContext, useEffect, useRef } from 'react'
import type { FeedState } from '../feed/feedState'
import type { SubscriptionListState } from '../subscriptions/subscriptionListState'
import type { ThreadSnapshot } from './tabsState'

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
 * What a list entry had when its list was last unmounted: its view state and scroll position.
 * An entry's list kind never changes, so `kind` only tells the two list views apart.
 */
export type ListMemory =
  | { kind: 'feed'; state: FeedState; scrollTop: number }
  | { kind: 'subscriptions'; state: SubscriptionListState; scrollTop: number; view: 'list' | 'reconcile' }

/**
 * Mounted readers and lists, keyed by the history entry key that shows them, plus the runtime
 * memory of lists that are not mounted (split toggled, single pane, back/forward). Memory lives
 * only while the app runs; the shell drops it when its entry leaves every tab's history.
 */
export interface ContentRegistry {
  readers: Map<number, { current: ReaderHandle }>
  lists: Map<number, { current: ListHandle }>
  listMemory: Map<number, ListMemory>
}

export function createContentRegistry(): ContentRegistry {
  return { readers: new Map(), lists: new Map(), listMemory: new Map() }
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
