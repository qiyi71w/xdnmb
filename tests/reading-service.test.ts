import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ThreadEndResult } from '../src/shared/api'
import type { Post, ThreadPage } from '../src/shared/forum'
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
    async getThreadPage(threadId, page, signal): Promise<ThreadPage> {
      requested.push(page)
      onRequest?.(page)
      if (signal.aborted) throw new ReadCancelledError()
      if (failWith) throw failWith
      const size = sizes[page - 1] ?? 0
      const replies = Array.from({ length: size }, (_, i) => post(String(60000000 + page * 100 + i)))
      return { threadId, mode: 'all', page, head: post(threadId), replies, replyCount, skippedItems: 0, endCandidate: size === 0 }
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
  const outcome = await service(f.client).locateThreadEnd(THREAD, new AbortController().signal)
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
    const outcome = await service(f.client).locateThreadEnd(THREAD, controller.signal)
    expect(outcome.status).toBe('cancelled')
    expect(f.requested).toEqual([1, 4])
  })

  it('reports what was observed and where it stopped when a later probe fails', async () => {
    const f = forum([19, 19, 19, 19], 70)
    f.onRequest((page) => {
      if (page > 1) f.fail(new ForumReadError({ kind: 'rate-limited', detail: 'business', serverMessage: '验证码' }))
    })
    const outcome = await service(f.client).locateThreadEnd(THREAD, new AbortController().signal)
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
    const fresh = await reading.readThreadPage(THREAD, 1, signal)
    expect(fresh.status).toBe('fresh')

    f.fail(new ForumReadError({ kind: 'network', detail: 'timeout' }))
    const cached = await reading.readThreadPage(THREAD, 1, signal)
    expect(cached.status).toBe('cached')
    if (cached.status === 'cached' && fresh.status === 'fresh') {
      expect(cached.networkError).toEqual({ kind: 'network', detail: 'timeout' })
      expect(cached.fetchedAt).toBe(fresh.fetchedAt)
      expect(cached.data.page.replies.map((r) => r.id)).toEqual(fresh.data.page.replies.map((r) => r.id))
    }

    const missing = await reading.readThreadPage(THREAD, 2, signal)
    expect(missing).toEqual({ status: 'failed', error: { kind: 'network', detail: 'timeout' } })
  })

  it('records coverage gaps and the end candidate across pages read out of order', async () => {
    const f = forum([19, 19, 2], 40)
    const reading = service(f.client)
    const signal = new AbortController().signal
    await reading.readThreadPage(THREAD, 1, signal)
    const last = await reading.readThreadPage(THREAD, 4, signal)
    if (last.status !== 'fresh') throw new Error('expected fresh')
    expect(last.data.coverage.gaps).toEqual([2, 3])
    expect(last.data.coverage.endCandidatePage).toBe(4)
    expect(last.data.coverage.countMismatch).toBeNull()
  })
})
