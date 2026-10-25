import type { DirectoryStrategy, LocateHint, QuoteLocation, QuotePreview, ReadError, ReadOutcome, ThreadEndResult, ThreadPageResult } from '../../shared/api'
import type { BoardDirectory, CoveragePage, FeedPage, FeedRef, Post, PostId, ReadingMode, ThreadCoverage, ThreadId, ThreadPage } from '../../shared/forum'
import { threadTotalPages } from '../../shared/threadPages'
import { ForumReadError, ReadCancelledError, type ForumClient } from '../forum/contract'
import type { ReadingStore, Stored } from '../storage/contract'
import { assertReadablePage, computeCoverage } from '../storage/coverage'
import type { Lane, RequestScheduler } from './scheduler'

/** With no ReplyCount, look at at most two more pages from page 1. */
const MAX_PROBE_STEPS = 2

export interface ReadingService {
  loadDirectory(strategy: DirectoryStrategy, signal: AbortSignal): Promise<ReadOutcome<BoardDirectory>>
  readFeedPage(feed: FeedRef, page: number, signal: AbortSignal): Promise<ReadOutcome<FeedPage>>
  readThreadPage(threadId: ThreadId, mode: ReadingMode, page: number, signal: AbortSignal): Promise<ReadOutcome<ThreadPageResult>>
  locateThreadEnd(threadId: ThreadId, mode: ReadingMode, signal: AbortSignal): Promise<ReadOutcome<ThreadEndResult>>
  previewQuote(postId: PostId, signal: AbortSignal): Promise<ReadOutcome<QuotePreview>>
  /** `hint`: a search result link's thread and page, read once only when local records do not locate the post. */
  locateQuote(postId: PostId, signal: AbortSignal, hint?: LocateHint | null): Promise<QuoteLocation>
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
      if (error instanceof ForumReadError) {
        let problem = error.error
        if (problem.kind === 'page-cap' && error.readablePage !== undefined) {
          const fetchedAt = now().toISOString()
          try {
            const persisted = await persistThreadPage(error.readablePage, fetchedAt)
            problem = { ...problem, readablePage: { data: persisted.result, fetchedAt, saved: persisted.saved } }
          } catch (lowerError) {
            if (lowerError instanceof ForumReadError) problem = lowerError.error
            else throw lowerError
          }
        }
        return { ok: false, outcome: { status: 'failed', error: problem } }
      }
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
      try {
        const { saved, result } = await persist(fetched.value, fetched.fetchedAt)
        return { status: 'fresh', data: result, fetchedAt: fetched.fetchedAt, saved }
      } catch (error) {
        if (error instanceof ForumReadError) return { status: 'failed', error: error.error }
        throw error
      }
    }
    if (fetched.outcome.status === 'cancelled') return fetched.outcome
    if (fetched.outcome.error.kind === 'page-cap') return fetched.outcome
    const cached = await tryLoad(loadCached)
    if (cached) return { status: 'cached', data: cached.value, fetchedAt: cached.fetchedAt, networkError: fetched.outcome.error }
    return fetched.outcome
  }

  async function fetchThreadPage(threadId: ThreadId, mode: ReadingMode, page: number, signal: AbortSignal): Promise<ThreadPage> {
    const value = await client.getThreadPage(threadId, mode, page, signal)
    const coverage = await store.getThreadCoverage(threadId, mode).catch(() => computeCoverage(threadId, mode, [], null))
    assertReadablePage(value, coverage)
    return value
  }

  /** Saves the page and returns coverage; if storage refuses, coverage still reflects this observation. */
  async function persistThreadPage(page: ThreadPage, fetchedAt: string): Promise<{ saved: boolean; result: ThreadPageResult }> {
    try {
      return { saved: true, result: { page, coverage: await store.saveThreadPage(page, fetchedAt) } }
    } catch {
      const stored = await store.getThreadCoverage(page.threadId, page.mode).catch(() => null)
      if (stored !== null) assertReadablePage(page, stored)
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
    assertReadablePage(stored.value, coverage)
    return { value: { page: stored.value, coverage }, fetchedAt: stored.fetchedAt }
  }

  function readThreadPage(threadId: ThreadId, mode: ReadingMode, page: number, signal: AbortSignal): Promise<ReadOutcome<ThreadPageResult>> {
    return readWithFallback(
      'foreground',
      signal,
      (s) => fetchThreadPage(threadId, mode, page, s),
      persistThreadPage,
      () => loadStoredThreadPage(threadId, mode, page)
    )
  }

  /** Owner from local records only; a lookup failure counts as no record. */
  async function ownerOf(postId: PostId): Promise<ThreadId | null> {
    return (await store.findPostThread(postId).catch(() => null))?.threadId ?? null
  }

  /**
   * Reads the one page a search link points at (full listing) and checks the post is on it. A readable
   * thread without the post is reported as `readable` with its head; nothing else is read.
   */
  async function readHinted(
    postId: PostId,
    hint: LocateHint,
    signal: AbortSignal
  ): Promise<{ kind: 'outcome'; outcome: QuoteLocation } | { kind: 'readable'; head: Post }> {
    const page = hint.page ?? 1
    const outcome = await readThreadPage(hint.threadId, 'all', page, signal)
    if (outcome.status === 'cancelled') return { kind: 'outcome', outcome }
    if (outcome.status === 'failed') return { kind: 'outcome', outcome: { status: 'failed', threadId: hint.threadId, error: outcome.error } }
    const shown = outcome.data.page
    if (shown.head.id !== postId && !shown.replies.some((reply) => reply.id === postId)) return { kind: 'readable', head: shown.head }
    return {
      kind: 'outcome',
      outcome: {
        status: 'located',
        threadId: hint.threadId,
        head: shown.head,
        target: { postId, page: shown.head.id === postId ? 1 : page, mode: 'all' },
        source: outcome.status,
        networkError: outcome.status === 'cached' ? outcome.networkError : null
      }
    }
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

    readThreadPage,

    async previewQuote(postId, signal) {
      const outcome = await readWithFallback(
        'foreground',
        signal,
        (s) => client.getRef(postId, s),
        async (post, fetchedAt) => ({ saved: await trySave(() => store.savePost(post, fetchedAt)), result: post }),
        () => store.loadPost(postId)
      )
      if (outcome.status === 'failed' || outcome.status === 'cancelled') return outcome
      return { ...outcome, data: { post: outcome.data, threadId: await ownerOf(postId) } }
    },

    async locateQuote(postId, signal, hint = null) {
      const relation = await store.findPostThread(postId).catch(() => null)
      // Local records win over a link that names another thread.
      const usableHint = hint !== null && (relation === null || relation.threadId === hint.threadId) ? hint : null
      if (relation === null) {
        if (usableHint !== null) {
          const hinted = await readHinted(postId, usableHint, signal)
          return hinted.kind === 'outcome' ? hinted.outcome : { status: 'thread-known', threadId: usableHint.threadId, head: hinted.head }
        }
        // Without any local record the only verifiable owner is the post itself as a main post:
        // its own thread's first page must come back with it as the head.
        const outcome = await readThreadPage(postId, 'all', 1, signal)
        if (outcome.status === 'cancelled') return outcome
        if (outcome.status === 'failed') {
          return outcome.error.kind === 'not-found' ? { status: 'unknown-thread' } : { status: 'failed', threadId: null, error: outcome.error }
        }
        return {
          status: 'located',
          threadId: postId,
          head: outcome.data.page.head,
          target: { postId, page: 1, mode: 'all' },
          source: outcome.status,
          networkError: outcome.status === 'cached' ? outcome.networkError : null
        }
      }

      const { threadId, preferredMode } = relation
      const otherMode: ReadingMode = preferredMode === 'all' ? 'po' : 'all'
      // The main post is on page 1 of either mode; a reply is checked only on the latest stored page
      // that contained it, preferred mode first. Nothing else is read: no scanning for a moved reply.
      const candidates: { mode: ReadingMode; page: number }[] = relation.isHead
        ? [{ mode: preferredMode, page: 1 }]
        : [preferredMode, otherMode].flatMap((mode) => {
            const page = relation.pages[mode]
            return page === null ? [] : [{ mode, page }]
          })
      let failure: ReadError | null = null
      let reached: Post | null = null
      for (const { mode, page } of candidates) {
        const outcome = await readThreadPage(threadId, mode, page, signal)
        if (outcome.status === 'cancelled') return outcome
        if (outcome.status === 'failed') {
          failure ??= outcome.error
          continue
        }
        const shown = outcome.data.page
        reached = shown.head
        if (relation.isHead || shown.replies.some((reply) => reply.id === postId)) {
          return {
            status: 'located',
            threadId,
            head: shown.head,
            target: { postId, page, mode },
            source: outcome.status,
            networkError: outcome.status === 'cached' ? outcome.networkError : null
          }
        }
      }
      const hintPage = usableHint?.page ?? 1
      if (usableHint !== null && !candidates.some((candidate) => candidate.mode === 'all' && candidate.page === hintPage)) {
        const hinted = await readHinted(postId, usableHint, signal)
        if (hinted.kind === 'readable') reached = hinted.head
        else if (hinted.outcome.status === 'failed') failure ??= hinted.outcome.error
        else return hinted.outcome
      }
      if (failure !== null) return { status: 'failed', threadId, error: failure }
      if (reached === null) {
        // Owner known only from a list: 打开原串 is offered only for a thread that can be read now.
        const outcome = await readThreadPage(threadId, preferredMode, 1, signal)
        if (outcome.status === 'cancelled') return outcome
        if (outcome.status === 'failed') return { status: 'failed', threadId, error: outcome.error }
        reached = outcome.data.page.head
      }
      return { status: 'thread-known', threadId, head: reached }
    },

    async locateThreadEnd(threadId, mode, signal) {
      const stored = await store.getThreadCoverage(threadId, mode).catch(() => null)
      let coverage = stored ?? computeCoverage(threadId, mode, [], null)
      const probedPages: number[] = []
      const probed = new Map<number, ThreadPageResult>()
      let fetchedAt = ''
      let saved = true

      const done = (data: ThreadEndResult): ReadOutcome<ThreadEndResult> => ({ status: 'fresh', data, fetchedAt, saved })
      // Count-based navigation does not manufacture an empty-page/completeness observation.
      const located = (lastPage: ThreadPageResult, endCandidatePage: number | null): ReadOutcome<ThreadEndResult> =>
        done({ status: 'located', lastPage: { page: lastPage.page, coverage }, endCandidatePage, probedPages })
      const insufficient = (): ReadOutcome<ThreadEndResult> => done({ status: 'insufficient', probedPages, coverage })

      /** A failure after earlier probes succeeded still reports what was observed and where it stopped. */
      const probe = async (
        page: number
      ): Promise<{ ok: true; value: ThreadPageResult } | { ok: false; outcome: ReadOutcome<ThreadEndResult> }> => {
        const known = probed.get(page)
        if (known) return { ok: true, value: known }
        const fetched = await fetchOnce('foreground', signal, (s) => fetchThreadPage(threadId, mode, page, s))
        if (!fetched.ok) {
          const { outcome } = fetched
          if (outcome.status === 'failed' && outcome.error.kind === 'page-cap') return { ok: false, outcome }
          if (outcome.status === 'failed' && probedPages.length > 0) {
            return { ok: false, outcome: done({ status: 'interrupted', probedPages, coverage, failedPage: page, error: outcome.error }) }
          }
          return { ok: false, outcome }
        }
        try {
          const persisted = await persistThreadPage(fetched.value, fetched.fetchedAt)
          probed.set(page, persisted.result)
          probedPages.push(page)
          fetchedAt = fetched.fetchedAt
          saved &&= persisted.saved
          coverage = persisted.result.coverage
          return { ok: true, value: persisted.result }
        } catch (error) {
          if (error instanceof ForumReadError) return { ok: false, outcome: { status: 'failed', error: error.error } }
          throw error
        }
      }

      let reported = stored?.reportedReplyCount ?? null
      if (reported === null) {
        const first = await probe(1)
        if (!first.ok) return first.outcome
        reported = first.value.page.replyCount
      }

      const total = threadTotalPages(reported)
      if (total !== null) {
        let target = total
        while (true) {
          const last = await probe(target)
          if (!last.ok) return last.outcome
          const freshTarget = threadTotalPages(last.value.page.replyCount) ?? target
          if (freshTarget === target) return located(last.value, last.value.page.endCandidate ? target : null)
          if (probed.has(freshTarget)) return insufficient()
          target = freshTarget
        }
      }

      // Without ReplyCount retain the bounded observed-end search, starting at page 1.
      const estimate = 1
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
      return located(start.value, 1)
    }
  }
}
