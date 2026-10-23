import type { DirectoryStrategy, ReadError, ReadOutcome, ThreadEndResult, ThreadPageResult } from '../../shared/api'
import type { BoardDirectory, CoveragePage, FeedPage, FeedRef, ReadingMode, ThreadCoverage, ThreadId, ThreadPage } from '../../shared/forum'
import { ForumReadError, ReadCancelledError, type ForumClient } from '../forum/contract'
import type { ReadingStore, Stored } from '../storage/contract'
import { computeCoverage } from '../storage/coverage'
import type { Lane, RequestScheduler } from './scheduler'

/** Replies per normal thread page observed on the forum; used only to estimate a tail probe start. */
const REPLIES_PER_PAGE = 19
/** Bounded tail verification: at most this many pages forward and backward from the estimate. */
const MAX_PROBE_STEPS = 2

export interface ReadingService {
  loadDirectory(strategy: DirectoryStrategy, signal: AbortSignal): Promise<ReadOutcome<BoardDirectory>>
  readFeedPage(feed: FeedRef, page: number, signal: AbortSignal): Promise<ReadOutcome<FeedPage>>
  readThreadPage(threadId: ThreadId, mode: ReadingMode, page: number, signal: AbortSignal): Promise<ReadOutcome<ThreadPageResult>>
  locateThreadEnd(threadId: ThreadId, mode: ReadingMode, signal: AbortSignal): Promise<ReadOutcome<ThreadEndResult>>
}

interface ReadingServiceDeps {
  client: ForumClient
  store: ReadingStore
  scheduler: RequestScheduler
  now?: () => Date
}

type Fetched<T> = { ok: true; value: T; fetchedAt: string } | { ok: false; outcome: { status: 'cancelled' } | { status: 'failed'; error: ReadError } }

export function createReadingService({ client, store, scheduler, now = () => new Date() }: ReadingServiceDeps): ReadingService {
  /** One forum request through the scheduler; no retries. Cancellation and failures become outcomes. */
  async function fetchOnce<T>(lane: Lane, signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<Fetched<T>> {
    try {
      const value = await scheduler.run(lane, signal, work)
      return { ok: true, value, fetchedAt: now().toISOString() }
    } catch (error) {
      if (error instanceof ReadCancelledError || signal.aborted) return { ok: false, outcome: { status: 'cancelled' } }
      if (error instanceof ForumReadError) return { ok: false, outcome: { status: 'failed', error: error.error } }
      // A defect while normalizing a response must not surface as success or crash the IPC call.
      console.error('[reading] unexpected read failure', error instanceof Error ? error.name : typeof error)
      return { ok: false, outcome: { status: 'failed', error: { kind: 'unknown-structure', detail: 'shape' } } }
    }
  }

  async function tryLoad<T>(load: () => Promise<Stored<T> | null>): Promise<Stored<T> | null> {
    try {
      return await load()
    } catch {
      return null
    }
  }

  async function trySave(save: () => Promise<unknown>): Promise<boolean> {
    try {
      await save()
      return true
    } catch {
      return false
    }
  }

  /** Network first; on failure show stored content with the reason instead of an empty/normal page. */
  async function readWithFallback<T, R = T>(
    lane: Lane,
    signal: AbortSignal,
    fetch: (signal: AbortSignal) => Promise<T>,
    persist: (value: T, fetchedAt: string) => Promise<{ saved: boolean; result: R }>,
    loadCached: () => Promise<Stored<R> | null>
  ): Promise<ReadOutcome<R>> {
    const fetched = await fetchOnce(lane, signal, fetch)
    if (fetched.ok) {
      const { saved, result } = await persist(fetched.value, fetched.fetchedAt)
      return { status: 'fresh', data: result, fetchedAt: fetched.fetchedAt, saved }
    }
    if (fetched.outcome.status === 'cancelled') return fetched.outcome
    const cached = await tryLoad(loadCached)
    if (cached) return { status: 'cached', data: cached.value, fetchedAt: cached.fetchedAt, networkError: fetched.outcome.error }
    return fetched.outcome
  }

  /** Saves the page and returns coverage; if storage refuses, coverage still reflects this observation. */
  async function persistThreadPage(page: ThreadPage, fetchedAt: string): Promise<{ saved: boolean; result: ThreadPageResult }> {
    try {
      return { saved: true, result: { page, coverage: await store.saveThreadPage(page, fetchedAt) } }
    } catch {
      const stored = await store.getThreadCoverage(page.threadId, page.mode).catch(() => null)
      const observation: CoveragePage = {
        page: page.page,
        fetchedAt,
        replyIds: page.replies.map((reply) => reply.id),
        endCandidate: page.endCandidate,
        skippedItems: page.skippedItems
      }
      const pages = [...(stored?.pages.filter((p) => p.page !== page.page) ?? []), observation].sort((a, b) => a.page - b.page)
      const reported = page.replyCount ?? stored?.reportedReplyCount ?? null
      return { saved: false, result: { page, coverage: computeCoverage(page.threadId, page.mode, pages, reported) } }
    }
  }

  async function loadStoredThreadPage(threadId: ThreadId, mode: ReadingMode, page: number): Promise<Stored<ThreadPageResult> | null> {
    const stored = await store.loadThreadPage(threadId, mode, page)
    if (!stored) return null
    const coverage: ThreadCoverage = await store.getThreadCoverage(threadId, mode)
    return { value: { page: stored.value, coverage }, fetchedAt: stored.fetchedAt }
  }

  return {
    async loadDirectory(strategy, signal) {
      if (strategy === 'cache-first') {
        const cached = await tryLoad(() => store.loadDirectory())
        if (cached) return { status: 'cached', data: cached.value, fetchedAt: cached.fetchedAt, networkError: null }
      }
      return readWithFallback(
        strategy === 'background-refresh' ? 'background' : 'foreground',
        signal,
        (s) => client.getDirectory(s),
        async (directory, fetchedAt) => ({ saved: await trySave(() => store.saveDirectory(directory, fetchedAt)), result: directory }),
        () => store.loadDirectory()
      )
    },

    readFeedPage(feed, page, signal) {
      return readWithFallback(
        'foreground',
        signal,
        (s) => client.getFeedPage(feed, page, s),
        async (feedPage, fetchedAt) => ({ saved: await trySave(() => store.saveFeedPage(feedPage, fetchedAt)), result: feedPage }),
        () => store.loadFeedPage(feed, page)
      )
    },

    readThreadPage(threadId, mode, page, signal) {
      return readWithFallback(
        'foreground',
        signal,
        (s) => client.getThreadPage(threadId, mode, page, s),
        persistThreadPage,
        () => loadStoredThreadPage(threadId, mode, page)
      )
    },

    async locateThreadEnd(threadId, mode, signal) {
      const stored = await store.getThreadCoverage(threadId, mode).catch(() => null)
      let coverage = stored ?? computeCoverage(threadId, mode, [], null)
      const probedPages: number[] = []
      const probed = new Map<number, ThreadPageResult>()
      let fetchedAt = ''
      let saved = true

      const done = (data: ThreadEndResult): ReadOutcome<ThreadEndResult> => ({ status: 'fresh', data, fetchedAt, saved })
      // Coverage is reported as of the last probe, so it includes the end-candidate page that proved `lastPage`.
      const located = (lastPage: ThreadPageResult, endCandidatePage: number): ReadOutcome<ThreadEndResult> =>
        done({ status: 'located', lastPage: { page: lastPage.page, coverage }, endCandidatePage, probedPages })
      const insufficient = (): ReadOutcome<ThreadEndResult> => done({ status: 'insufficient', probedPages, coverage })

      /** A failure after earlier probes succeeded still reports what was observed and where it stopped. */
      const probe = async (
        page: number
      ): Promise<{ ok: true; value: ThreadPageResult } | { ok: false; outcome: ReadOutcome<ThreadEndResult> }> => {
        const known = probed.get(page)
        if (known) return { ok: true, value: known }
        const fetched = await fetchOnce('foreground', signal, (s) => client.getThreadPage(threadId, mode, page, s))
        if (!fetched.ok) {
          const { outcome } = fetched
          if (outcome.status === 'failed' && probedPages.length > 0) {
            return { ok: false, outcome: done({ status: 'interrupted', probedPages, coverage, failedPage: page, error: outcome.error }) }
          }
          return { ok: false, outcome }
        }
        const persisted = await persistThreadPage(fetched.value, fetched.fetchedAt)
        probed.set(page, persisted.result)
        probedPages.push(page)
        fetchedAt = fetched.fetchedAt
        saved &&= persisted.saved
        coverage = persisted.result.coverage
        return { ok: true, value: persisted.result }
      }

      let reported = stored?.reportedReplyCount ?? null
      if (reported === null) {
        const first = await probe(1)
        if (!first.ok) return first.outcome
        reported = first.value.page.replyCount
      }

      // ReplyCount only picks where to start looking; the end must be verified by actual pages:
      // a page with replies followed by an observed end-candidate page (or an empty page 1).
      const estimate = Math.max(1, Math.ceil((reported ?? 0) / REPLIES_PER_PAGE))
      const start = await probe(estimate)
      if (!start.ok) return start.outcome

      if (start.value.page.replies.length > 0) {
        let lastWithReplies = start.value
        for (let step = 1; step <= MAX_PROBE_STEPS; step++) {
          const next = await probe(estimate + step)
          if (!next.ok) return next.outcome
          if (next.value.page.endCandidate) return located(lastWithReplies, estimate + step)
          if (next.value.page.replies.length === 0) return insufficient()
          lastWithReplies = next.value
        }
        return insufficient()
      }

      if (!start.value.page.endCandidate) return insufficient()
      if (estimate === 1) return located(start.value, 1)
      for (let step = 1; step <= MAX_PROBE_STEPS && estimate - step >= 1; step++) {
        const previous = await probe(estimate - step)
        if (!previous.ok) return previous.outcome
        if (previous.value.page.replies.length > 0) return located(previous.value, estimate - step + 1)
        if (!previous.value.page.endCandidate) return insufficient()
        if (estimate - step === 1) return located(previous.value, 1)
      }
      return insufficient()
    }
  }
}
