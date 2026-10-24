import { useSyncExternalStore } from 'react'
import type { ThreadId } from '../../../../shared/forum'

/**
 * Favorite state written successfully during this run, shared by every mounted 收藏 entry point
 * (toolbar buttons of all tabs, the 收藏 list). Storage is the only writer behind these calls, so a
 * written value is never older than a query answered before or during the write: it wins over it.
 * The shell keeps one instance in the content registry.
 */
export interface FavoriteWrites {
  subscribe(listener: () => void): () => void
  /** Last successfully written state, or undefined when this run has not written the thread. */
  get(threadId: ThreadId): boolean | undefined
  written(threadId: ThreadId, favorite: boolean): void
}

export function createFavoriteWrites(): FavoriteWrites {
  const listeners = new Set<() => void>()
  const states = new Map<ThreadId, boolean>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get: (threadId) => states.get(threadId),
    written(threadId, favorite) {
      if (states.get(threadId) === favorite) return
      states.set(threadId, favorite)
      for (const listener of listeners) listener()
    }
  }
}

/** The thread's last written favorite state, re-rendering when any entry point writes it. */
export function useWrittenFavorite(writes: FavoriteWrites, threadId: ThreadId): boolean | undefined {
  return useSyncExternalStore(writes.subscribe, () => writes.get(threadId))
}
