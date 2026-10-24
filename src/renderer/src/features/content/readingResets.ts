import { useSyncExternalStore } from 'react'
import type { ThreadId } from '../../../../shared/forum'

/**
 * Clearing reading progress from history must not be undone by readers that are still open: they
 * would save their position or mark posts read again. While a clear runs the threads it may affect
 * are blocked (`null`: every thread, until storage reports the actual scope); once it succeeded the
 * generation of exactly the cleared threads advances, and every reader, pending write and
 * navigation snapshot made under an older generation is dropped. Other threads keep theirs.
 * The shell keeps one instance in the content registry.
 */
export interface ReadingResets {
  subscribe(listener: () => void): () => void
  generation(threadId: ThreadId): number
  /** Whether reading writes for the thread may be sent now by a reader of `generation`. */
  writable(threadId: ThreadId, generation: number): boolean
  /** Blocks writes until the returned release is called. */
  block(threadId: ThreadId | null): () => void
  /** These threads' reading data was cleared: stale readers and snapshots must start again. */
  reset(threadIds: readonly ThreadId[]): void
}

export function createReadingResets(): ReadingResets {
  const listeners = new Set<() => void>()
  const perThread = new Map<ThreadId, number>()
  const blocks: (ThreadId | null)[] = []

  const generation = (threadId: ThreadId) => perThread.get(threadId) ?? 0
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    generation,
    writable(threadId, at) {
      return generation(threadId) === at && !blocks.some((blocked) => blocked === null || blocked === threadId)
    },
    block(threadId) {
      blocks.push(threadId)
      let released = false
      return () => {
        if (released) return
        released = true
        blocks.splice(blocks.indexOf(threadId), 1)
      }
    },
    reset(threadIds) {
      if (threadIds.length === 0) return
      for (const threadId of threadIds) perThread.set(threadId, generation(threadId) + 1)
      for (const listener of listeners) listener()
    }
  }
}

/** Current generation of the thread's reading data. */
export function useReadingGeneration(resets: ReadingResets, threadId: ThreadId): number {
  return useSyncExternalStore(resets.subscribe, () => resets.generation(threadId))
}
