import { setImmediate as yieldToLoop } from 'node:timers/promises'
import type { SearchApi, SearchBatch, SearchFetch, SearchResult } from '../../shared/search'
import type { AppStore } from '../storage/contract'
import type { SearchScan } from '../storage/search-contract'
import { normalizeSearchText } from '../storage/search'
import { ForumReadError, ReadCancelledError, type ForumClient } from '../forum/contract'
import type { RequestScheduler } from '../reading/scheduler'
import { assertReadablePage, computeCoverage } from '../storage/coverage'
import type { CoveragePage } from '../../shared/forum'

interface Task {
  controller: AbortController
  busy: boolean
  scan?: SearchScan
  fetch?: SearchFetch
  done: Promise<void>
  finish: () => void
}
export interface SearchService {
  forOwner(owner: string): SearchApi
  releaseOwner(owner: string): void
  /** Initial migration backfill only; unavailable search does not prevent reading startup. */
  recover(): Promise<void>
  stop(): Promise<void>
  /** A new window after cancelled exit may create fresh sessions and rebuild an interrupted index. */
  resume(): void
}

export function createSearchService(deps: {
  store: AppStore
  client: ForumClient
  scheduler: RequestScheduler
  enforceQuota: () => Promise<void>
  now?: () => Date
}): SearchService {
  const { store, client, scheduler } = deps
  const tasks = new Map<string, Task>()
  const active = new Set<Task>()
  let closing = false
  let rebuilding = false
  let recovery: Promise<void> | null = null
  const now = () => (deps.now?.() ?? new Date()).toISOString()
  const key = (owner: string, operationId: string) => `${owner}:${operationId}`
  const failure = <T>(reason: 'storage' | 'index-unavailable' | 'cancelled' | 'busy' | 'expired'): SearchResult<T> => ({ ok: false, reason })
  const storageFailure = <T>(): SearchResult<T> => failure(store.status.state === 'ready' ? 'index-unavailable' : 'storage')
  function startTask(id: string): Task | null {
    if (closing) return null
    tasks.get(id)?.controller.abort()
    // Completed sessions retain cursors/status until replaced or the owner closes; cap memory.
    if (!tasks.has(id) && tasks.size >= 128) {
      const retired = [...tasks].find(([, task]) => !task.busy && task.fetch?.state !== 'running')
      if (retired) tasks.delete(retired[0])
      else return null
    }
    const { promise, resolve } = Promise.withResolvers<void>()
    const task: Task = { controller: new AbortController(), busy: true, done: promise, finish() { active.delete(task); resolve() } }
    active.add(task)
    tasks.set(id, task)
    return task
  }
  const live = (id: string, task: Task) => !closing && !task.controller.signal.aborted && tasks.get(id) === task

  async function advance(id: string, task: Task): Promise<SearchResult<SearchBatch>> {
    try {
      if (!task.scan) return failure('expired')
      const result = await store.searchBatch(task.scan)
      if (!live(id, task)) return failure('cancelled')
      task.scan.after = result.cursor
      return { ok: true, value: result.batch }
    } catch { return live(id, task) ? storageFailure() : failure('cancelled') }
    finally { task.busy = false; task.finish() }
  }

  async function rebuild(task: Task, id: string): Promise<SearchResult<{ rebuilt: boolean }>> {
    if (rebuilding) { task.busy = false; task.finish(); return failure('busy') }
    rebuilding = true
    for (const other of tasks.values()) if (other !== task && other.scan) other.controller.abort()
    try {
      await store.beginSearchRebuild()
      while (live(id, task)) {
        const done = await store.rebuildSearchBatch()
        if (!live(id, task)) return failure('cancelled')
        if (done) {
          await deps.enforceQuota()
          return live(id, task) ? { ok: true, value: { rebuilt: true } } : failure('cancelled')
        }
        await yieldToLoop()
      }
      return failure('cancelled')
    } catch { return storageFailure() }
    finally { rebuilding = false; task.busy = false; task.finish() }
  }

  async function fetchPages(id: string, task: Task): Promise<void> {
    const fetch = task.fetch!
    const observed: CoveragePage[] = []
    let count: number | null = null
    let page = 1
    try {
      for (; page <= 100_000 && live(id, task); page++) {
        const result = await scheduler.run('background', task.controller.signal,
          (signal) => client.getThreadPage(fetch.threadId, 'all', page, signal))
        if (!live(id, task)) break
        assertReadablePage(result, fetch.coverage)
        assertReadablePage(result, await store.getThreadCoverage(result.threadId, result.mode))
        const fetchedAt = now()
        await store.saveThreadPage(result, fetchedAt)
        observed.push({ page, fetchedAt, replyIds: result.replies.map((post) => post.id), endCandidate: result.endCandidate, skippedItems: result.skippedItems })
        fetch.pages.push(page)
        count = result.replyCount ?? count
        fetch.coverage = computeCoverage(fetch.threadId, 'all', observed, count)
        await deps.enforceQuota()
        if (result.endCandidate) { fetch.state = 'stopped'; break }
        await yieldToLoop()
      }
      if (page > 100_000) { fetch.state = 'failed'; fetch.failedPage = page; fetch.error = 'page-limit' }
      if (!live(id, task)) fetch.state = 'cancelled'
    } catch (error) {
      if (task.controller.signal.aborted || error instanceof ReadCancelledError || closing) fetch.state = 'cancelled'
      else {
        fetch.state = 'failed'; fetch.failedPage = page
        fetch.error = error instanceof ForumReadError ? error.error : 'storage'
      }
    } finally { task.busy = false; task.finish() }
  }

  function forOwner(owner: string): SearchApi {
    return {
      async start(input) {
        const query = normalizeSearchText(input.query)
        if (query.length === 0 || query.length > 512 || query.includes('\0')) throw new Error('invalid search query')
        const id = key(owner, input.operationId)
        const task = startTask(id)
        if (!task) return failure('busy')
        try {
          const upper = await store.searchBoundary()
          if (!live(id, task)) return failure('cancelled')
          task.scan = { query, scope: structuredClone(input.scope), filters: { ...input.filters }, after: 0, upper }
          return await advance(id, task)
        } catch { return storageFailure() }
        finally { task.busy = false; task.finish() }
      },
      async next(input) {
        const id = key(owner, input.operationId)
        const task = tasks.get(id)
        if (!task?.scan) return failure('expired')
        if (!live(id, task)) return failure('cancelled')
        if (task.busy) return failure('busy')
        task.busy = true
        const pending = Promise.withResolvers<void>()
        task.done = pending.promise
        task.finish = () => { active.delete(task); pending.resolve() }
        active.add(task)
        return advance(id, task)
      },
      async cancel(input) { tasks.get(key(owner, input.operationId))?.controller.abort() },
      async fetchThread(input) {
        const id = key(owner, input.operationId)
        if ([...tasks.values()].some((task) => task.fetch?.state === 'running' && task.fetch.threadId === input.threadId)) return failure('busy')
        if (store.status.state !== 'ready') return failure('storage')
        const task = startTask(id)
        if (!task) return failure('busy')
        task.fetch = { operationId: input.operationId, threadId: input.threadId, state: 'running', pages: [], failedPage: null, error: null,
          coverage: computeCoverage(input.threadId, 'all', [], null) }
        void fetchPages(id, task)
        return { ok: true, value: structuredClone(task.fetch) }
      },
      async fetchStatus(input) {
        const task = tasks.get(key(owner, input.operationId))
        return task?.fetch ? { ok: true, value: structuredClone(task.fetch) } : failure('expired')
      },
      async rebuild(input) {
        if (rebuilding) return failure('busy')
        const id = key(owner, input.operationId)
        const task = startTask(id)
        return task ? rebuild(task, id) : failure('busy')
      },
      async threadMetadata(input) {
        if (input.threadIds.length > 200) throw new Error('invalid metadata batch')
        try { return { ok: true, value: await store.searchMetadata(input.threadIds) } } catch { return failure('storage') }
      }
    }
  }

  return {
    forOwner,
    releaseOwner(owner) {
      for (const [id, task] of tasks) if (id.startsWith(`${owner}:`)) { task.controller.abort(); tasks.delete(id) }
    },
    recover() {
      if (!recovery) recovery = (async () => {
        if (store.status.state !== 'ready') return
        try { await store.searchBoundary(); return } catch { /* migration or interrupted rebuild */ }
        const id = key('startup', 'backfill')
        const task = startTask(id)
        if (task) await rebuild(task, id)
        tasks.delete(id)
      })()
      return recovery
    },
    resume() {
      if (!closing) return
      closing = false
      recovery = null
    },
    async stop() {
      closing = true
      const pending = [...active]
      for (const task of pending) task.controller.abort()
      await Promise.allSettled(pending.map((task) => task.done))
      tasks.clear()
    }
  }
}
