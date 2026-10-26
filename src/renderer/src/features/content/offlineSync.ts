// What every view showing offline copies shares in this window: the copy changes made here, the
// main process's invalidation after a deletion, one deletion per thread at a time, and the
// generation that tells a late read, save or update result from a current one.

import { useSyncExternalStore } from 'react'
import type { OfflineCopy } from '../../../../shared/content'
import type { ThreadId } from '../../../../shared/forum'
import { attempt, contentFailureText } from './contentText'

export type OfflineChange =
  /** A save was started or cancelled in this window: show this copy where the thread is listed. */
  | { kind: 'copy'; copy: OfflineCopy }
  /** What storage holds for the thread changed (a deletion): read it again, keep nothing older. */
  | { kind: 'stale'; threadId: ThreadId }

export type DeletionOutcome =
  /** The copy is gone; `cacheCleanup` is the cache limit check that followed. */
  | { kind: 'deleted'; cacheCleanup: 'complete' | 'failed' }
  /** Deletion was not confirmed: the copy stays as storage reports it. */
  | { kind: 'failed'; text: string }

/** The result of a deletion asked for in a thread's 更多 menu, shown under that thread's toolbar. */
export interface DeletionNote {
  threadId: ThreadId
  cacheCleanup: 'complete' | 'failed'
}

let epoch = 0
const generations = new Map<ThreadId, number>()
const listeners = new Set<(change: OfflineChange) => void>()
let stopMain: (() => void) | null = null
const running = new Map<ThreadId, Promise<DeletionOutcome>>()
let note: DeletionNote | null = null
let version = 0
const storeListeners = new Set<() => void>()

/** Changes whenever a result read for `threadId` before it may no longer be current. */
export function offlineGeneration(threadId: ThreadId): number {
  return generations.get(threadId) ?? 0
}

/** Changes whenever any thread's generation does (lists of every copy). */
export function offlineEpoch(): number {
  return epoch
}

function advance(threadId: ThreadId) {
  generations.set(threadId, offlineGeneration(threadId) + 1)
  epoch += 1
}

function notifyStore() {
  version += 1
  for (const listener of [...storeListeners]) listener()
}

function emit(change: OfflineChange) {
  for (const listener of [...listeners]) listener(change)
}

/** Storage changed for `threadId`: older results are dropped and every view reads it again. */
export function markOfflineStale(threadId: ThreadId) {
  advance(threadId)
  emit({ kind: 'stale', threadId })
}

/**
 * Listens to copy changes of this window and to the main process's invalidation (subscribed while
 * anything listens).
 */
export function subscribeOffline(listener: (change: OfflineChange) => void): () => void {
  listeners.add(listener)
  if (stopMain === null) stopMain = window.xidao.content.onOfflineChanged(markOfflineStale)
  return () => {
    listeners.delete(listener)
    if (listeners.size > 0 || stopMain === null) return
    stopMain()
    stopMain = null
  }
}

/** A save started or cancelled here: other views patch their row; a later save is a new copy. */
export function announceOfflineCopy(copy: OfflineCopy) {
  if (note?.threadId === copy.threadId) {
    note = null
    notifyStore()
  }
  emit({ kind: 'copy', copy })
}

/**
 * Deletes the thread's copy once: asking again while it runs gets the same outcome. Results read
 * before or during it are dropped, and every view reads the thread again when it ends, whatever
 * the outcome (a refusal does not prove the copy is unchanged).
 */
export function deleteOfflineCopy(threadId: ThreadId): Promise<DeletionOutcome> {
  const current = running.get(threadId)
  if (current !== undefined) return current
  advance(threadId)
  const deletion = (async (): Promise<DeletionOutcome> => {
    const result = await attempt(() => window.xidao.content.deleteOffline({ threadId }))
    if (result?.ok === true) return { kind: 'deleted', cacheCleanup: result.value.cacheCleanup }
    return { kind: 'failed', text: `删除没有完成：${contentFailureText(result?.ok === false ? result : null)}` }
  })().finally(() => {
    running.delete(threadId)
    markOfflineStale(threadId)
    notifyStore()
  })
  running.set(threadId, deletion)
  notifyStore()
  return deletion
}

export function isDeletingOffline(threadId: ThreadId): boolean {
  return running.has(threadId)
}

export function showDeletionNote(next: DeletionNote | null) {
  note = next
  notifyStore()
}

/** The note shown under the toolbars of its thread, if any. */
export function deletionNote(): DeletionNote | null {
  return note
}

function subscribeStore(listener: () => void) {
  storeListeners.add(listener)
  return () => {
    storeListeners.delete(listener)
  }
}

/** Re-renders when a deletion starts or ends, or the note changes. */
export function useOfflineDeletions() {
  useSyncExternalStore(subscribeStore, () => version)
  return { isDeleting: isDeletingOffline, note: deletionNote() }
}

/** What storage says now about a copy a snapshot (search results) recorded. */
export type CopyPresence = 'present' | 'deleted' | 'unknown'

export interface OfflinePresence {
  /** Checks these threads now (each once) and keeps them current; others are forgotten. */
  track(threadIds: readonly ThreadId[]): void
  /** Undefined while not read yet. `unknown`: the read failed, nothing is assumed. */
  get(threadId: ThreadId): CopyPresence | undefined
  dispose(): void
}

/**
 * Current presence of the copies of tracked threads, one read per thread, read again when the
 * thread goes stale; a read overtaken by a change is read again, a copy announced here is present.
 */
export function watchOfflinePresence(onChange: () => void): OfflinePresence {
  const known = new Map<ThreadId, CopyPresence>()
  /** The read in flight per thread; an older one's result is dropped. */
  const reading = new Map<ThreadId, number>()
  let tracked = new Set<ThreadId>()
  let seq = 0
  let live = true

  const read = (threadId: ThreadId) => {
    const at = ++seq
    reading.set(threadId, at)
    const generation = offlineGeneration(threadId)
    void attempt(() => window.xidao.content.offlineStatus({ threadId })).then((result) => {
      if (!live || reading.get(threadId) !== at) return
      if (generation !== offlineGeneration(threadId)) return read(threadId)
      reading.delete(threadId)
      known.set(threadId, result?.ok !== true ? 'unknown' : result.value === null ? 'deleted' : 'present')
      onChange()
    })
  }

  const stop = subscribeOffline((change) => {
    const threadId = change.kind === 'stale' ? change.threadId : change.copy.threadId
    if (!tracked.has(threadId)) return
    if (change.kind === 'stale') return read(threadId)
    reading.delete(threadId)
    known.set(threadId, 'present')
    onChange()
  })

  return {
    track(threadIds) {
      tracked = new Set(threadIds)
      // An untracked thread missed its changes: it is read again if tracked later.
      for (const threadId of [...known.keys(), ...reading.keys()]) {
        if (tracked.has(threadId)) continue
        known.delete(threadId)
        reading.delete(threadId)
      }
      for (const threadId of tracked) if (!known.has(threadId) && !reading.has(threadId)) read(threadId)
    },
    get: (threadId) => known.get(threadId),
    dispose() {
      live = false
      stop()
    }
  }
}
