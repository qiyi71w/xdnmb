import { stat } from 'node:fs/promises'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import type { ContentApi, ContentResult, ContentUsage, OfflineCopy, OfflineDeletion, OfflineImageFailure } from '../../shared/content'
import type { ThreadId } from '../../shared/forum'
import { ForumReadError, ReadCancelledError, type ForumClient } from '../forum/contract'
import type { ManagedImageFiles } from '../images/files'
import type { ImageService } from '../images/service'
import type { RequestScheduler } from '../reading/scheduler'
import type { ReadingStore } from '../storage/contract'
import type { ContentStore } from '../storage/content-contract'

export interface ContentService extends Omit<ContentApi, 'holdReader' | 'releaseReader' | 'onOfflineChanged'> {
  holdReader(owner: string, input: { viewId: string; threadId: ThreadId }): Promise<void>
  releaseReader(owner: string, input: { viewId: string }): Promise<void>
  releaseOwner(owner: string): Promise<void>
  enforceQuota(): Promise<void>
  recover(): Promise<void>
  /** Abort background work before draining the database for exit. No later pages are queued. */
  stop(): Promise<void>
  /** A reopened window can start new work after the previous stop has drained. */
  resume(): void
}

interface SaveTask {
  controller: AbortController
  done: Promise<boolean>
  finish: (cleaned: boolean) => void
}

export function createContentService(deps: {
  store: ContentStore & Pick<ReadingStore, 'status'>
  client: ForumClient
  scheduler: RequestScheduler
  images: ImageService
  files: ManagedImageFiles
  databasePath: string
  now?: () => Date
}): ContentService {
  const { store, client, scheduler, images, files } = deps
  const now = () => (deps.now?.() ?? new Date()).toISOString()
  const tasks = new Map<ThreadId, SaveTask>()
  const deletions = new Map<ThreadId, Promise<void>>()
  const unsavedFailures = new Map<ThreadId, Pick<OfflineCopy, 'state' | 'failedPage' | 'error' | 'imageFailures'>>()
  const visibleCopy = (copy: OfflineCopy | null): OfflineCopy | null => copy === null ? null : { ...copy, ...unsavedFailures.get(copy.threadId) }
  let closing = false
  let maintenance: Promise<void> | null = null
  let clearRequested = false
  let maintenanceRequested = false

  async function result<T>(work: () => Promise<T>): Promise<ContentResult<T>> {
    try {
      if (store.status.state === 'unavailable') return { ok: false, reason: 'storage' }
      return { ok: true, value: await work() }
    } catch {
      return { ok: false, reason: 'storage' }
    }
  }

  async function usage(): Promise<ContentUsage> {
    const value = await store.getContentUsage()
    const sizes = await Promise.all(['', '-wal', '-shm'].map(async (suffix) => {
      try { return (await stat(`${deps.databasePath}${suffix}`)).size } catch { return 0 }
    }))
    return { ...value, databaseBytes: sizes.reduce((sum, bytes) => sum + bytes, 0) }
  }

  function enforce(clear: boolean): Promise<void> {
    if (closing) return Promise.resolve()
    clearRequested ||= clear
    maintenanceRequested = true
    if (maintenance) return maintenance
    maintenance = (async () => {
      while (maintenanceRequested && !closing) {
        maintenanceRequested = false
        const clearAll = clearRequested
        clearRequested = false
        let more = true
        while (more && !closing) {
          // Each transaction is bounded. A pending exit or foreground persistence gets a turn.
          await yieldToLoop()
          if (closing) break
          const batch = await store.evictContentBatch(clearAll)
          for (const name of batch.fileNames) await files.remove(name)
          more = batch.more
        }
      }
    })().finally(() => { maintenance = null })
    return maintenance
  }

  async function runSave(threadId: ThreadId, includeImages: boolean, task: SaveTask): Promise<void> {
    const { signal } = task.controller
    const imageFailures: OfflineImageFailure[] = []
    let failedPage: number | null = null
    let error: OfflineCopy['error'] = null
    let state: OfflineCopy['state'] = 'stopped'
    let readingPage = false
    const owner = `offline-${threadId}`
    const viewId = 'download'
    try {
      for (let page = 1; page <= 100_000; page++) {
        if (signal.aborted) throw new ReadCancelledError()
        failedPage = page
        readingPage = true
        const observed = await scheduler.run('background', signal, (s) => client.getThreadPage(threadId, 'all', page, s))
        readingPage = false
        if (signal.aborted) throw new ReadCancelledError()
        await store.saveOfflinePage(observed, now())
        if (observed.skippedItems > 0) throw new ForumReadError({ kind: 'unknown-structure', detail: 'shape' })
        failedPage = null
        await yieldToLoop()
        if (observed.endCandidate) break
        if (page === 100_000) { error = 'page-limit'; state = 'interrupted' }
      }
      if (includeImages) {
        let after: string | null = null
        while (!signal.aborted) {
          const ids = await store.listOfflineImagePosts(threadId, after, 50)
          if (ids.length === 0) break
          for (const postId of ids) {
            if (signal.aborted) throw new ReadCancelledError()
            const loaded = await images.load(owner, { viewId, postId, kind: 'original', refresh: false, waitForCleanup: true }, signal)
            if (signal.aborted || loaded.status === 'cancelled') throw new ReadCancelledError()
            if (loaded.status === 'ready') await store.holdOfflineImage(threadId, postId)
            else imageFailures.push({ postId, error: loaded.error })
            await store.updateOfflineCopy(threadId, { state: 'saving', failedPage, error, imageFailures }, now())
            await images.releaseView(owner, viewId)
            if (loaded.status === 'failed' && loaded.error.reason === 'storage') {
              error = 'storage'
              state = 'interrupted'
              break
            }
            await yieldToLoop()
          }
          if (error === 'storage') break
          after = ids[ids.length - 1] ?? null
        }
      }
      if (signal.aborted) throw new ReadCancelledError()
    } catch (failure) {
      if (signal.aborted || failure instanceof ReadCancelledError) {
        state = closing ? 'interrupted' : 'cancelled'
      } else {
        state = 'interrupted'
        error = failure instanceof ForumReadError ? failure.error : readingPage ? { kind: 'network', detail: 'connection' } : 'storage'
      }
    } finally {
      // If even the terminal status cannot be written, report that failure in this run as well.
      // The last committed page remains recoverable; startup marks unfinished saves interrupted.
      await store.updateOfflineCopy(threadId, { state, failedPage, error, imageFailures }, now()).catch(() => {
        unsavedFailures.set(threadId, { state: 'interrupted', failedPage, error: 'storage', imageFailures })
      })
      let cleaned = true
      try {
        await images.releaseOwner(owner)
      } catch {
        cleaned = false
        unsavedFailures.set(threadId, { state: 'interrupted', failedPage, error: 'storage', imageFailures })
      } finally {
        tasks.delete(threadId)
        task.finish(cleaned)
      }
    }
  }

  return {
    listHistory: () => result(async () => (await store.listHistory()).map((entry) => ({ ...entry, offline: visibleCopy(entry.offline) }))),
    listOffline: () => result(async () => (await store.listOffline()).map((entry) => ({ ...entry, copy: visibleCopy(entry.copy)! }))),
    clearHistory: ({ threadId, clearReading }) => result(() => store.clearHistory(threadId, clearReading)),
    usage: () => result(usage),
    setCacheLimit: ({ bytes }) => result(async () => {
      await store.setCacheLimit(bytes)
      await enforce(false)
      return usage()
    }),
    clearCache: () => result(async () => { await enforce(true); return usage() }),
    offlineStatus: ({ threadId }) => result(async () => visibleCopy(await store.getOfflineCopy(threadId))),
    async saveOffline({ threadId, includeImages }) {
      if (closing || tasks.has(threadId) || deletions.has(threadId)) return { ok: false, reason: 'busy' }
      const completion = Promise.withResolvers<boolean>()
      const task: SaveTask = { controller: new AbortController(), done: completion.promise, finish: completion.resolve }
      tasks.set(threadId, task)
      try {
        const initial = await store.beginOfflineCopy(threadId, includeImages, now())
        unsavedFailures.delete(threadId)
        void runSave(threadId, includeImages, task)
        return { ok: true, value: initial }
      } catch {
        tasks.delete(threadId)
        task.finish(true)
        return { ok: false, reason: 'storage' }
      }
    },
    async cancelOffline({ threadId }) {
      if (deletions.has(threadId)) return { ok: false, reason: 'busy' }
      const task = tasks.get(threadId)
      task?.controller.abort()
      if (task && !await task.done) return { ok: false, reason: 'storage' }
      return result(async () => visibleCopy(await store.getOfflineCopy(threadId)))
    },
    async deleteOffline({ threadId }): Promise<ContentResult<OfflineDeletion>> {
      if (closing || deletions.has(threadId)) return { ok: false, reason: 'busy' }
      const completion = Promise.withResolvers<void>()
      deletions.set(threadId, completion.promise)
      try {
        const task = tasks.get(threadId)
        task?.controller.abort()
        if (task) {
          if (!await task.done) return { ok: false, reason: 'storage' }
        } else {
          // Also clears any transient owner left by an earlier failed cancellation.
          await images.releaseOwner(`offline-${threadId}`)
        }
        await store.deleteOfflineCopy(threadId)
        unsavedFailures.delete(threadId)
        try {
          await enforce(false)
          return { ok: true, value: { cacheCleanup: closing ? 'failed' : 'complete' } }
        } catch {
          return { ok: true, value: { cacheCleanup: 'failed' } }
        }
      } catch {
        return { ok: false, reason: 'storage' }
      } finally {
        deletions.delete(threadId)
        completion.resolve()
      }
    },
    holdReader: (owner, { viewId, threadId }) => store.holdContentReader(`${owner}:${viewId}:`, threadId),
    async releaseReader(owner, { viewId }) {
      await store.releaseContentReaders(`${owner}:${viewId}:`)
      await enforce(false)
    },
    async releaseOwner(owner) {
      await store.releaseContentReaders(`${owner}:`)
      await enforce(false)
    },
    enforceQuota: () => enforce(false),
    recover: () => store.recoverContent(),
    resume() { closing = false },
    async stop() {
      closing = true
      for (const task of tasks.values()) task.controller.abort()
      await Promise.all([...tasks.values()].map((task) => task.done))
      await Promise.all(deletions.values())
      await maintenance?.catch(() => undefined)
    }
  }
}
