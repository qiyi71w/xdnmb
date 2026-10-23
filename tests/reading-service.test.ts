import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { QuoteLocation, ThreadEndResult } from '../src/shared/api'
import type { Post, ReadingMode, ThreadPage } from '../src/shared/forum'
import { ForumReadError, ReadCancelledError, type ForumClient } from '../src/main/forum/contract'
import type { ReadingStore } from '../src/main/storage/contract'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
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

function asStore(db: ReadingDatabase): ReadingStore {
  return {
    get status() {
      return db.status
    },
    saveDirectory: async (...args) => db.saveDirectory(...args),
    loadDirectory: async () => db.loadDirectory(),
    saveFeedPage: async (...args) => db.saveFeedPage(...args),
    loadFeedPage: async (...args) => db.loadFeedPage(...args),
    saveThreadPage: async (...args) => db.saveThreadPage(...args),
    loadThreadPage: async (...args) => db.loadThreadPage(...args),
    getThreadCoverage: async (...args) => db.getThreadCoverage(...args),
    savePost: async (...args) => db.savePost(...args),
    loadPost: async (...args) => db.loadPost(...args),
    findPostThread: async (...args) => db.findPostThread(...args),
    getReadingState: async (...args) => db.getReadingState(...args),
    setReadingMode: async (...args) => db.setReadingMode(...args),
    saveReadingPosition: async (...args) => db.saveReadingPosition(...args),
    markPostsRead: async (...args) => db.markPostsRead(...args),
    recordVisit: async (...args) => db.recordVisit(...args),
    establishAttention: async (...args) => db.establishAttention(...args),
    loadSettings: async () => db.loadSettings(),
    saveSettings: async (...args) => db.saveSettings(...args),
    close: async () => db.close()
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
  return createReadingService({ client, store: asStore(db), scheduler: createRequestScheduler() })
}

async function locate(sizes: number[], replyCount: number | null) {
  const f = forum(sizes, replyCount)
  const outcome = await service(f.client).locateThreadEnd(THREAD, 'all', new AbortController().signal)
  if (outcome.status !== 'fresh') throw new Error(`unexpected outcome ${outcome.status}`)
  return { result: outcome.data as ThreadEndResult, requested: f.requested }
}

describe('locateThreadEnd (bounded tail probe)', () => {
  it('verifies the estimated last page by observing the following empty page', async () => {
    const { result, requested } = await locate([19, 19, 7], 45)
    expect(result.status).toBe('located')
    if (result.status === 'located') {
      expect(result.lastPage.page.page).toBe(3)
      expect(result.endCandidatePage).toBe(4)
      expect(result.lastPage.coverage.endCandidatePage).toBe(4)
      expect(result.lastPage.coverage.gaps).toEqual([2])
    }
    expect(requested).toEqual([1, 3, 4])
  })

  it('does not trust a short page or an under-reported ReplyCount and stops after two forward probes', async () => {
    const { result, requested } = await locate([19, 5, 19, 19, 3], 10)
    expect(result.status).toBe('insufficient')
    expect(requested).toEqual([1, 2, 3])
  })

  it('walks back from an over-reported estimate to the last page with replies', async () => {
    const { result, requested } = await locate([19, 19, 19, 4], 100)
    expect(result.status).toBe('located')
    if (result.status === 'located') {
      expect(result.lastPage.page.page).toBe(4)
      expect(result.endCandidatePage).toBe(5)
    }
    expect(requested).toEqual([1, 6, 5, 4])
  })

  it('reports insufficient coverage when the backward bound is exhausted', async () => {
    const { result } = await locate([19, 19], 200)
    expect(result.status).toBe('insufficient')
    if (result.status === 'insufficient') expect(result.probedPages).toEqual([1, 11, 10, 9])
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

  it('returns cancelled, not a location, when cancelled during the verifying read', async () => {
    const f = quoteForum({ '700': { all: [['701']] } })
    const reading = service(f.client)
    await reading.readThreadPage('700', 'all', 1, signal())
    const controller = new AbortController()
    f.onRequest(() => controller.abort())
    expect(await reading.locateQuote('701', controller.signal)).toEqual({ status: 'cancelled' })
  })
})
