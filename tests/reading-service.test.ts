import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { QuoteLocation, ThreadEndResult } from '../src/shared/api'
import type { Post, ReadingMode, ThreadPage } from '../src/shared/forum'
import { threadTotalPages } from '../src/shared/threadPages'
import { ForumReadError, ReadCancelledError, type ForumClient } from '../src/main/forum/contract'
import { createForumClient } from '../src/main/forum/client'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { asStore } from './helpers/store'
import { createReadingService } from '../src/main/reading/service'
import { createRequestScheduler } from '../src/main/reading/scheduler'

const THREAD = '50000002'

function post(id: string): Post {
  return {
    id,
    forumId: '4',
    createdAt: '2022-06-18(六)12:00:00',
    userHash: 'abc',
    name: '无名氏',
    title: '无标题',
    isAdmin: false,
    isSage: false,
    content: [{ type: 'text', text: `post ${id}` }],
    plainText: `post ${id}`,
    image: null
  }
}

/** Builds a forum where page N holds `sizes[N-1]` replies; pages beyond are valid empty pages. */
function forum(sizes: number[], replyCount: number | null) {
  const requested: number[] = []
  let failWith: ForumReadError | null = null
  let onRequest: ((page: number) => void) | null = null
  const client: ForumClient = {
    getDirectory: () => Promise.reject(new Error('unused')),
    getFeedPage: () => Promise.reject(new Error('unused')),
    getRef: () => Promise.reject(new Error('unused')),
    async getThreadPage(threadId, mode, page, signal): Promise<ThreadPage> {
      requested.push(page)
      onRequest?.(page)
      if (signal.aborted) throw new ReadCancelledError()
      if (failWith) throw failWith
      const size = sizes[page - 1] ?? 0
      const replies = Array.from({ length: size }, (_, i) => post(String(60000000 + page * 100 + i)))
      return { threadId, mode, page, head: post(threadId), replies, replyCount, skippedItems: 0, endCandidate: size === 0 }
    }
  }
  return {
    client,
    requested,
    fail: (error: ForumReadError | null) => (failWith = error),
    onRequest: (hook: (page: number) => void) => (onRequest = hook)
  }
}

let dir: string
let db: ReadingDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xidao-reading-'))
  db = openReadingDatabase(join(dir, 'reading.sqlite'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function service(client: ForumClient) {
  return createReadingService({ client, store: asStore(db), scheduler: createRequestScheduler({ backgroundSpacingMs: 0 }) })
}

async function locate(sizes: number[], replyCount: number | null) {
  const f = forum(sizes, replyCount)
  const outcome = await service(f.client).locateThreadEnd(THREAD, 'all', new AbortController().signal)
  if (outcome.status !== 'fresh') throw new Error(`unexpected outcome ${outcome.status}`)
  return { result: outcome.data as ThreadEndResult, requested: f.requested }
}

describe('locateThreadEnd (mode-specific count or bounded unknown-count probe)', () => {
  it.each([[0, 1], [1, 1], [19, 1], [20, 2], [2194, 116]])('targets the count-based page for %i replies', async (count, total) => {
    const sizes = Array.from({ length: total }, () => count === 0 ? 0 : 1)
    const { result, requested } = await locate(sizes, count)
    expect(threadTotalPages(count)).toBe(total)
    expect(result.status).toBe('located')
    if (result.status === 'located') {
      expect(result.lastPage.page.page).toBe(total)
      expect(result.endCandidatePage).toBe(count === 0 ? 1 : null)
      expect(result.lastPage.coverage.countMismatch).toBe(count === 0 ? false : null)
    }
    expect(requested).toEqual(total === 1 ? [1] : [1, total])
  })

  it('uses the PO count rather than a stored all-mode count', async () => {
    const f = forum([7], 7)
    db.saveThreadPage({ threadId: THREAD, mode: 'all', page: 1, head: post(THREAD), replies: [post('60000000')],
      replyCount: 2194, skippedItems: 0, endCandidate: false }, '2026-10-24T00:00:00.000Z')
    const outcome = await service(f.client).locateThreadEnd(THREAD, 'po', new AbortController().signal)
    expect(outcome).toMatchObject({ status: 'fresh', data: { status: 'located', lastPage: { page: { page: 1, mode: 'po', replyCount: 7 } } } })
    expect(f.requested).toEqual([1])
  })

  it('retains observed-end probing when the count is unknown', async () => {
    const { result, requested } = await locate([19, 7], null)
    expect(threadTotalPages(null)).toBeNull()
    expect(result).toMatchObject({ status: 'located', lastPage: { page: { page: 2 } }, endCandidatePage: 3 })
    expect(requested).toEqual([1, 2, 3])
  })

  it('stops after two forward probes without a count or observed end', async () => {
    const { result, requested } = await locate([19, 5, 19, 19, 3], null)
    expect(result.status).toBe('insufficient')
    expect(requested).toEqual([1, 2, 3])
  })

  it('treats an empty first page as the end of a thread without replies', async () => {
    const { result, requested } = await locate([], 0)
    expect(result.status).toBe('located')
    if (result.status === 'located') {
      expect(result.lastPage.page.page).toBe(1)
      expect(result.endCandidatePage).toBe(1)
    }
    expect(requested).toEqual([1])
  })

  it('stops issuing probe requests once cancelled', async () => {
    const f = forum([19, 19, 19, 19], 70)
    const controller = new AbortController()
    f.onRequest((page) => {
      if (page === 4) controller.abort()
    })
    const outcome = await service(f.client).locateThreadEnd(THREAD, 'all', controller.signal)
    expect(outcome.status).toBe('cancelled')
    expect(f.requested).toEqual([1, 4])
  })

  it('reports what was observed and where it stopped when a later probe fails', async () => {
    const f = forum([19, 19, 19, 19], 70)
    f.onRequest((page) => {
      if (page > 1) f.fail(new ForumReadError({ kind: 'rate-limited', detail: 'business', serverMessage: '验证码' }))
    })
    const outcome = await service(f.client).locateThreadEnd(THREAD, 'all', new AbortController().signal)
    expect(outcome.status).toBe('fresh')
    if (outcome.status !== 'fresh') return
    expect(outcome.data).toMatchObject({
      status: 'interrupted',
      probedPages: [1],
      failedPage: 4,
      error: { kind: 'rate-limited', detail: 'business' }
    })
    if (outcome.data.status === 'interrupted') expect(outcome.data.coverage.pages.map((p) => p.page)).toEqual([1])
    expect(f.requested).toEqual([1, 4])
  })
})

describe('readThreadPage', () => {
  it('keeps the real total when a direct tail jump is capped without a stored page 100', async () => {
    const requested: number[] = []
    const client = createForumClient({ transport: { async get(url) {
      const page = Number(url.searchParams.get('page'))
      requested.push(page)
      return { mediaType: 'application/json', text: JSON.stringify({ id: THREAD, content: 'head', ReplyCount: 2194,
        Replies: [{ id: page === 1 ? '60000100' : '60010000', content: 'reply' }] }) }
    } } })
    const reading = service(client)
    const signal = new AbortController().signal
    expect(await reading.readThreadPage(THREAD, 'all', 1, signal)).toMatchObject({ status: 'fresh', data: { coverage: { reportedReplyCount: 2194 } } })
    expect(await reading.locateThreadEnd(THREAD, 'all', signal)).toMatchObject({ status: 'failed', error: {
      kind: 'page-cap', highestReadablePage: 100, readablePage: { data: { page: { page: 100 }, coverage: { reportedReplyCount: 2194 } } }
    } })
    expect(db.loadThreadPage(THREAD, 'all', 100)?.value.replies[0]?.id).toBe('60010000')
    expect(requested).toEqual([1, 116, 100])
    expect(db.getThreadCoverage(THREAD, 'all')).toMatchObject({ pages: [{ page: 1 }, { page: 100 }], reportedReplyCount: 2194, endCandidatePage: null })
    expect(db.loadThreadPage(THREAD, 'all', 116)).toBeNull()
  })

  it('retains a Tips-only successor as observed end evidence after the real last page', async () => {
    const client = createForumClient({ transport: { async get(url) {
      const page = Number(url.searchParams.get('page'))
      return { mediaType: 'application/json', text: JSON.stringify({ id: THREAD, content: 'head', ReplyCount: 20,
        Replies: [{ id: '9999999', user_hash: 'Tips', content: 'tip' }, ...(page <= 2 ? [{ id: String(60000000 + page), content: 'reply' }] : [])] }) }
    } } })
    const reading = service(client)
    const signal = new AbortController().signal
    await reading.readThreadPage(THREAD, 'all', 2, signal)
    expect(await reading.readThreadPage(THREAD, 'all', 3, signal)).toMatchObject({
      status: 'fresh', data: { page: { replies: [], endCandidate: true }, coverage: { endCandidatePage: 3 } }
    })
  })

  it.each([101, 116])('rejects page 100 repeated as page %i before persistence or end evidence', async (requested) => {
    const f = forum(Array.from({ length: 116 }, () => 19), 2194)
    const read = f.client.getThreadPage.bind(f.client)
    f.client.getThreadPage = async (threadId, mode, page, signal) => ({ ...await read(threadId, mode, page > 100 ? 100 : page, signal), page })
    const reading = service(f.client)
    const signal = new AbortController().signal
    await reading.readThreadPage(THREAD, 'all', 100, signal)
    expect(await reading.readThreadPage(THREAD, 'all', requested, signal)).toMatchObject({
      status: 'failed', error: { kind: 'page-cap', highestReadablePage: 100 }
    })
    expect(db.loadThreadPage(THREAD, 'all', requested)).toBeNull()
    expect(db.getThreadCoverage(THREAD, 'all')).toMatchObject({ pages: [{ page: 100 }], endCandidatePage: null, obtainedReplyCount: 19 })
    expect(await reading.locateThreadEnd(THREAD, 'all', signal)).toMatchObject({
      status: 'failed', error: { kind: 'page-cap', highestReadablePage: 100 }
    })
  })

  it('rejects an overlapping predecessor even when the response is not an exact duplicate', async () => {
    const f = forum([19, 19], 38)
    const reading = service(f.client)
    const signal = new AbortController().signal
    await reading.readThreadPage(THREAD, 'all', 1, signal)
    f.client.getThreadPage = async (threadId, mode, page) => ({ threadId, mode, page, head: post(threadId),
      replies: [post('60000118'), post('60000200')], replyCount: 38, skippedItems: 0, endCandidate: false })
    expect(await reading.readThreadPage(THREAD, 'all', 2, signal)).toMatchObject({ status: 'failed', error: { kind: 'page-cap', highestReadablePage: 1 } })
    expect(db.loadThreadPage(THREAD, 'all', 2)).toBeNull()
  })

  it('updates the mode count on append and refresh without turning it into completeness proof', async () => {
    const f = forum([19, 1], 20)
    const read = f.client.getThreadPage.bind(f.client)
    let count = 20
    f.client.getThreadPage = async (...args) => ({ ...await read(...args), replyCount: count })
    const reading = service(f.client)
    const signal = new AbortController().signal
    await reading.readThreadPage(THREAD, 'all', 1, signal)
    count = 2194
    const appended = await reading.readThreadPage(THREAD, 'all', 2, signal)
    expect(appended).toMatchObject({ status: 'fresh', data: { coverage: { reportedReplyCount: 2194, countMismatch: null } } })
    count = 19
    const refreshed = await reading.readThreadPage(THREAD, 'all', 2, signal)
    expect(refreshed).toMatchObject({ status: 'fresh', data: { coverage: { reportedReplyCount: 19, countMismatch: null } } })
  })

  it('serves the stored page with the failure reason when the network read fails, and fails when nothing is stored', async () => {
    const f = forum([19, 3], 22)
    const reading = service(f.client)
    const signal = new AbortController().signal
    const fresh = await reading.readThreadPage(THREAD, 'all', 1, signal)
    expect(fresh.status).toBe('fresh')

    f.fail(new ForumReadError({ kind: 'network', detail: 'timeout' }))
    const cached = await reading.readThreadPage(THREAD, 'all', 1, signal)
    expect(cached.status).toBe('cached')
    if (cached.status === 'cached' && fresh.status === 'fresh') {
      expect(cached.networkError).toEqual({ kind: 'network', detail: 'timeout' })
      expect(cached.fetchedAt).toBe(fresh.fetchedAt)
      expect(cached.data.page.replies.map((r) => r.id)).toEqual(fresh.data.page.replies.map((r) => r.id))
    }

    const missing = await reading.readThreadPage(THREAD, 'all', 2, signal)
    expect(missing).toEqual({ status: 'failed', error: { kind: 'network', detail: 'timeout' } })
  })

  it('falls back only to a stored page of the same mode: a PO page never stands in for an all-mode page', async () => {
    const f = forum([19, 3], 22)
    const reading = service(f.client)
    const signal = new AbortController().signal
    expect((await reading.readThreadPage(THREAD, 'all', 1, signal)).status).toBe('fresh')
    f.fail(new ForumReadError({ kind: 'network', detail: 'connection' }))
    expect(await reading.readThreadPage(THREAD, 'po', 1, signal)).toEqual({
      status: 'failed', error: { kind: 'network', detail: 'connection' }
    })

    f.fail(null)
    const po = await reading.readThreadPage(THREAD, 'po', 2, signal)
    if (po.status !== 'fresh') throw new Error('expected fresh')
    expect(po.data.coverage.mode).toBe('po')
    expect(po.data.coverage.pages.map((page) => page.page)).toEqual([2])
    f.fail(new ForumReadError({ kind: 'network', detail: 'connection' }))
    expect(await reading.readThreadPage(THREAD, 'all', 2, signal)).toMatchObject({ status: 'failed' })
    const cachedPo = await reading.readThreadPage(THREAD, 'po', 2, signal)
    expect(cachedPo).toMatchObject({ status: 'cached', data: { page: { mode: 'po', page: 2 } } })
  })

  it('records coverage gaps and the end candidate across pages read out of order', async () => {
    const f = forum([19, 19, 2], 40)
    const reading = service(f.client)
    const signal = new AbortController().signal
    await reading.readThreadPage(THREAD, 'all', 1, signal)
    const last = await reading.readThreadPage(THREAD, 'all', 4, signal)
    if (last.status !== 'fresh') throw new Error('expected fresh')
    expect(last.data.coverage.gaps).toEqual([2, 3])
    expect(last.data.coverage.endCandidatePage).toBe(4)
    expect(last.data.coverage.countMismatch).toBeNull()
  })
})

/**
 * A forum whose threads are given as `{ [threadId]: { all: [[...page 1 ids], [...page 2 ids]], po: [...] } }`.
 * Any other ID read as a thread is the forum's `该串不存在`. `ref` serves every post that appears.
 */
function quoteForum(threads: Record<string, Partial<Record<ReadingMode, string[][]>>>) {
  const requests: string[] = []
  let failWith: ForumReadError | null = null
  let onRequest: ((request: string) => void) | null = null
  const notFound = () => new ForumReadError({ kind: 'not-found', detail: 'business', serverMessage: '该串不存在' })
  const known = new Set(Object.entries(threads).flatMap(([id, modes]) => [id, ...Object.values(modes).flat(2)]))
  const client: ForumClient = {
    getDirectory: () => Promise.reject(new Error('unused')),
    getFeedPage: () => Promise.reject(new Error('unused')),
    async getThreadPage(threadId, mode, page, signal): Promise<ThreadPage> {
      const request = `${threadId}/${mode}/${page}`
      requests.push(request)
      onRequest?.(request)
      if (signal.aborted) throw new ReadCancelledError()
      if (failWith) throw failWith
      const thread = threads[threadId]
      if (thread === undefined) throw notFound()
      const replies = (thread[mode]?.[page - 1] ?? []).map(post)
      return { threadId, mode, page, head: post(threadId), replies, replyCount: null, skippedItems: 0, endCandidate: replies.length === 0 }
    },
    async getRef(postId, signal): Promise<Post> {
      requests.push(`ref/${postId}`)
      if (signal.aborted) throw new ReadCancelledError()
      if (failWith) throw failWith
      if (!known.has(postId)) throw notFound()
      return post(postId)
    }
  }
  return {
    client,
    requests,
    fail: (error: ForumReadError | null) => (failWith = error),
    onRequest: (hook: (request: string) => void) => (onRequest = hook),
    /** Moves the thread's pages, e.g. after deletions shifted replies. */
    set: (threadId: string, modes: Partial<Record<ReadingMode, string[][]>>) => (threads[threadId] = modes)
  }
}

const signal = () => new AbortController().signal

describe('quote preview', () => {
  it('reads the quoted post, then serves the stored copy with the reason and the recorded owner', async () => {
    const f = quoteForum({ '700': { all: [['701', '702']] } })
    const reading = service(f.client)
    expect(await reading.previewQuote('702', signal())).toMatchObject({ status: 'fresh', data: { post: { id: '702' }, threadId: null } })
    await reading.readThreadPage('700', 'all', 1, signal())

    f.fail(new ForumReadError({ kind: 'network', detail: 'timeout' }))
    expect(await reading.previewQuote('702', signal())).toMatchObject({
      status: 'cached',
      data: { post: { id: '702' }, threadId: '700' },
      networkError: { kind: 'network', detail: 'timeout' }
    })
    expect(await reading.previewQuote('999', signal())).toEqual({ status: 'failed', error: { kind: 'network', detail: 'timeout' } })

    f.fail(null)
    expect(await reading.previewQuote('999', signal())).toMatchObject({ status: 'failed', error: { kind: 'not-found' } })
  })

  it('keeps preview and location fetches separate from actual reading and visit records', async () => {
    const f = quoteForum({ '700': { all: [['701', '702']] } })
    const reading = service(f.client)
    await reading.readThreadPage('700', 'all', 1, signal())
    db.saveReadingPosition('700', 'all', { postId: '701', page: 1, offsetRatio: 0.5, viewportOffset: 0 }, '2026-10-24T00:01:00.000Z')
    const before = db.getReadingState('700')

    await reading.previewQuote('702', signal())
    expect(await reading.locateQuote('702', signal())).toMatchObject({ status: 'located' })
    const after = db.getReadingState('700')
    expect(after.positions).toEqual(before.positions)
    expect(after.mode).toBe(before.mode)
    expect(db.listHistory()).toEqual([])
  })
})

describe('quote location', () => {
  const located = (result: QuoteLocation) => (result.status === 'located' ? { threadId: result.threadId, ...result.target, source: result.source } : result)

  it('verifies a recorded reply on its latest stored page only', async () => {
    const f = quoteForum({ '700': { all: [['701', '702'], ['703', '704']] } })
    const reading = service(f.client)
    await reading.readThreadPage('700', 'all', 2, signal())
    f.requests.length = 0
    expect(located(await reading.locateQuote('704', signal()))).toEqual({ threadId: '700', postId: '704', page: 2, mode: 'all', source: 'fresh' })
    expect(f.requests).toEqual(['700/all/2'])
  })

  it('keeps the thread preference out of it: a reply hidden by 只看 PO is located in all mode', async () => {
    const f = quoteForum({ '700': { all: [['701', '702']], po: [['702']] } })
    const reading = service(f.client)
    await reading.readThreadPage('700', 'all', 1, signal())
    await reading.readThreadPage('700', 'po', 1, signal())
    db.setReadingMode('700', 'po', new Date().toISOString())
    expect(located(await reading.locateQuote('701', signal()))).toMatchObject({ postId: '701', mode: 'all', page: 1 })
    expect(located(await reading.locateQuote('702', signal()))).toMatchObject({ postId: '702', mode: 'po', page: 1 })
    expect(db.getReadingState('700').mode).toBe('po')
  })

  it('reports only the thread when the reply moved off its recorded page, without scanning other pages', async () => {
    const f = quoteForum({ '700': { all: [['701', '702'], ['703', '704']] } })
    const reading = service(f.client)
    await reading.readThreadPage('700', 'all', 2, signal())
    f.set('700', { all: [['701', '702', '703'], ['704']] })
    f.requests.length = 0
    expect(await reading.locateQuote('703', signal())).toMatchObject({ status: 'thread-known', threadId: '700', head: { id: '700' } })
    expect(f.requests).toEqual(['700/all/2'])
  })

  it('knows the thread of a reply seen only in a list: offers it only once the thread itself can be read', async () => {
    const f = quoteForum({ '700': { all: [['701']] } })
    db.saveFeedPage({
      feed: { kind: 'forum', id: '4' },
      page: 1,
      threads: [{ head: post('700'), replyCount: 40, recentReplies: [post('741')], remainReplies: null }],
      skippedItems: 0
    }, new Date().toISOString())
    const reading = service(f.client)
    f.fail(new ForumReadError({ kind: 'network', detail: 'connection' }))
    expect(await reading.locateQuote('741', signal())).toMatchObject({ status: 'failed', threadId: '700', error: { kind: 'network' } })
    f.fail(null)
    expect(await reading.locateQuote('741', signal())).toMatchObject({ status: 'thread-known', threadId: '700', head: { id: '700' } })
    // Only the thread's first page was read; the reply's page is never guessed or scanned for.
    expect(f.requests).toEqual(['700/all/1', '700/all/1'])
  })

  it('without any record, locates only a main post and leaves an unknown reply unknown', async () => {
    const f = quoteForum({ '800': { all: [['801']] } })
    const reading = service(f.client)
    expect(located(await reading.locateQuote('800', signal()))).toEqual({ threadId: '800', postId: '800', page: 1, mode: 'all', source: 'fresh' })
    expect(await reading.locateQuote('900', signal())).toEqual({ status: 'unknown-thread' })
    expect(f.requests).toEqual(['800/all/1', '900/all/1'])
  })

  it('separates network failure from an unknown owner and locates on the stored page when offline', async () => {
    const f = quoteForum({ '700': { all: [['701']] } })
    const reading = service(f.client)
    await reading.readThreadPage('700', 'all', 1, signal())
    f.fail(new ForumReadError({ kind: 'network', detail: 'connection' }))
    expect(await reading.locateQuote('701', signal())).toMatchObject({
      status: 'located', source: 'cached', target: { postId: '701', page: 1, mode: 'all' }, networkError: { kind: 'network' }
    })
    expect(await reading.locateQuote('900', signal())).toEqual({ status: 'failed', threadId: null, error: { kind: 'network', detail: 'connection' } })
  })

  it('locates retained replies after ordinary cache eviction and preserves omitted offline replies', async () => {
    const f = quoteForum({ '700': { all: [[], ['701']] } })
    const reading = service(f.client)
    const at = '2026-10-24T00:00:00.000Z'
    db.beginOfflineCopy('700', false, at)
    db.saveOfflinePage(await f.client.getThreadPage('700', 'all', 2, signal()), at)
    f.set('700', { all: [[], []] })
    await reading.readThreadPage('700', 'all', 2, signal())
    while (db.evictContentBatch(true).more) { /* bounded storage batches */ }
    expect(db.findPostThread('701')?.pages.all).toBe(2)
    f.requests.length = 0
    f.fail(new ForumReadError({ kind: 'network', detail: 'connection' }))

    expect(await reading.previewQuote('701', signal())).toMatchObject({
      status: 'cached', data: { post: { id: '701' }, threadId: '700' }
    })
    expect(await reading.locateQuote('701', signal())).toMatchObject({
      status: 'located', source: 'cached', threadId: '700', target: { postId: '701', page: 2, mode: 'all' }
    })
    expect(f.requests).toEqual(['ref/701', '700/all/2'])
  })

  it('returns cancelled, not a location, when cancelled during the verifying read', async () => {
    const f = quoteForum({ '700': { all: [['701']] } })
    const reading = service(f.client)
    await reading.readThreadPage('700', 'all', 1, signal())
    const controller = new AbortController()
    f.onRequest(() => controller.abort())
    expect(await reading.locateQuote('701', controller.signal)).toEqual({ status: 'cancelled' })
  })

  it('locates a search-link reply without records by reading only the hinted page of the named thread', async () => {
    const f = quoteForum({ '700': { all: [['701', '702'], ['703', '704']] } })
    const reading = service(f.client)
    expect(located(await reading.locateQuote('704', signal(), { threadId: '700', page: 2 })))
      .toEqual({ threadId: '700', postId: '704', page: 2, mode: 'all', source: 'fresh' })
    // Outdated page clue: the thread is readable, the reply is not there, nothing else is scanned.
    f.set('700', { all: [['701', '702', '703'], ['704']] })
    f.requests.length = 0
    expect(await reading.locateQuote('703', signal(), { threadId: '700', page: 2 })).toMatchObject({ status: 'thread-known', threadId: '700', head: { id: '700' } })
    expect(f.requests).toEqual(['700/all/2'])
  })

  it('tries the hinted page after the recorded page misses, and lets records override a link naming another thread', async () => {
    const f = quoteForum({ '700': { all: [['701', '702'], ['703', '704']] }, '800': { all: [['801']] } })
    const reading = service(f.client)
    await reading.readThreadPage('700', 'all', 2, signal())
    f.set('700', { all: [['701', '702', '703'], ['704']] })
    f.requests.length = 0
    expect(located(await reading.locateQuote('703', signal(), { threadId: '700', page: 1 })))
      .toEqual({ threadId: '700', postId: '703', page: 1, mode: 'all', source: 'fresh' })
    expect(f.requests).toEqual(['700/all/2', '700/all/1'])

    f.requests.length = 0
    expect(located(await reading.locateQuote('704', signal(), { threadId: '800', page: 1 }))).toMatchObject({ threadId: '700', postId: '704', page: 2 })
    expect(f.requests).toEqual(['700/all/2'])
  })

  it('locates the main post named by a search link on page 1, whatever page the link points at', async () => {
    const f = quoteForum({ '700': { all: [['701'], ['702']] } })
    const reading = service(f.client)
    expect(located(await reading.locateQuote('700', signal(), { threadId: '700', page: 2 })))
      .toEqual({ threadId: '700', postId: '700', page: 1, mode: 'all', source: 'fresh' })
  })

  it('reports a link to a missing thread as not found, not as an unknown owner', async () => {
    const f = quoteForum({})
    const reading = service(f.client)
    expect(await reading.locateQuote('901', signal(), { threadId: '900', page: null }))
      .toMatchObject({ status: 'failed', threadId: '900', error: { kind: 'not-found' } })
  })
})
