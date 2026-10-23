import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Worker, WorkerOptions } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { StorageStatus } from '../src/shared/api'
import type { BoardDirectory, CoveragePage, FeedPage, Post, ThreadPage } from '../src/shared/forum'
import { StorageWriteRefusedError } from '../src/main/storage/contract'
import { computeCoverage } from '../src/main/storage/coverage'
import { openReadingDatabase } from '../src/main/storage/database'
import type { ReadingDatabase } from '../src/main/storage/database'
import { MIGRATIONS } from '../src/main/storage/migrations'
import { openReadingStore } from '../src/main/storage/store'

const fetchedAt = '2026-10-23T08:00:00.000Z'
const later = '2026-10-23T08:01:00.000Z'
const latest = '2026-10-23T08:02:00.000Z'
const threadId = '900719925474099312345'
const folders: string[] = []
const databases: ReadingDatabase[] = []

function databasePath() {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-storage-'))
  folders.push(folder)
  return join(folder, 'reading.sqlite')
}

function open(path: string) {
  const db = openReadingDatabase(path)
  databases.push(db)
  return db
}

function post(id: string, overrides: Partial<Post> = {}): Post {
  return {
    id,
    forumId: null,
    createdAt: null,
    userHash: null,
    name: null,
    title: null,
    isAdmin: null,
    isSage: false,
    content: [
      { type: 'text', text: '文字 & <literal>' },
      { type: 'lineBreak' },
      { type: 'quoteRef', postId: '50000001', raw: '>>No.50000001' },
      { type: 'emphasis', style: 'bold', children: [{ type: 'text', text: '加粗' }] },
      { type: 'greentext', children: [{ type: 'text', text: '>引用' }] },
      { type: 'link', href: 'https://example.org/', children: [{ type: 'text', text: '链接' }] }
    ],
    plainText: '文字 & <literal>\n>>No.50000001加粗>引用链接',
    image: null,
    ...overrides
  }
}

function threadPage(page: number, replies: Post[], overrides: Partial<ThreadPage> = {}): ThreadPage {
  return {
    threadId,
    mode: 'all',
    page,
    head: post(threadId, { forumId: '4', title: '标题', isAdmin: false, isSage: null }),
    replies,
    replyCount: null,
    skippedItems: 0,
    endCandidate: replies.length === 0,
    ...overrides
  }
}

function coveragePage(page: number, overrides: Partial<CoveragePage> = {}): CoveragePage {
  return { page, fetchedAt, replyIds: [], endCandidate: false, skippedItems: 0, ...overrides }
}

function schema(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    return {
      version: db.pragma('user_version', { simple: true }),
      tables: db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    }
  } finally {
    db.close()
  }
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

describe('reading database', () => {
  it('reads both thread pages unchanged after a restart, preserving string IDs, nulls and content', () => {
    const path = databasePath()
    const first = threadPage(1, [post('900719925474099312346', {
      isAdmin: true,
      image: { path: '2026-10-23/image', ext: '.jpg' }
    })], { replyCount: 2 })
    const second = threadPage(2, [post('900719925474099312347')], { replyCount: null })
    const db = open(path)
    expect(db.status).toEqual({ state: 'ready', schemaVersion: 1 })
    db.saveThreadPage(first, fetchedAt)
    db.saveThreadPage(second, later)
    db.close()

    const reopened = open(path)
    expect(reopened.loadThreadPage(threadId, 'all', 1)).toEqual({ value: first, fetchedAt })
    expect(reopened.loadThreadPage(threadId, 'all', 2)).toEqual({ value: second, fetchedAt: later })
    expect(reopened.getThreadCoverage(threadId, 'all').reportedReplyCount).toBe(2)
    const raw = new Database(path, { readonly: true })
    try {
      expect(raw.pragma('journal_mode', { simple: true })).toBe('wal')
    } finally {
      raw.close()
    }
  })

  it('keeps gaps, count mismatches and skipped observations explicit', () => {
    const db = open(databasePath())
    const first = threadPage(1, Array.from({ length: 18 }, (_, i) => post(String(1000 + i))), { replyCount: 29 })
    const second = threadPage(2, Array.from({ length: 10 }, (_, i) => post(String(2000 + i))), { replyCount: 29 })
    const end = threadPage(3, [], { replyCount: 29, endCandidate: true })
    db.saveThreadPage(first, fetchedAt)
    const incomplete = db.saveThreadPage(end, latest)
    expect(incomplete.gaps).toEqual([2])
    expect(incomplete.endCandidatePage).toBe(3)
    expect(incomplete.countMismatch).toBeNull()
    const complete = db.saveThreadPage(second, later)
    expect(complete.gaps).toEqual([])
    expect(complete.obtainedReplyCount).toBe(28)
    expect(complete.reportedReplyCount).toBe(29)
    expect(complete.countMismatch).toBe(true)
    expect(db.saveThreadPage({ ...second, skippedItems: 1 }, latest).countMismatch).toBeNull()
  })

  it('replaces page observations and deduplicates IDs across pages instead of accumulating stale replies', () => {
    const db = open(databasePath())
    db.saveThreadPage(threadPage(1, [post('1001'), post('1002')], { replyCount: 3 }), fetchedAt)
    db.saveThreadPage(threadPage(2, [post('1002'), post('1003')]), fetchedAt)
    expect(db.getThreadCoverage(threadId, 'all').obtainedReplyCount).toBe(3)
    const refreshed = threadPage(1, [post('1002')], { replyCount: null })
    db.saveThreadPage(refreshed, later)
    expect(db.getThreadCoverage(threadId, 'all').obtainedReplyCount).toBe(2)
    expect(db.getThreadCoverage(threadId, 'all').reportedReplyCount).toBe(3)
    expect(db.loadThreadPage(threadId, 'all', 1)?.value).toEqual(refreshed)
  })

  it('selects the latest fetched non-null count, including zero, not the highest page or save order', () => {
    const db = open(databasePath())
    db.saveThreadPage(threadPage(1, [], { replyCount: 0 }), latest)
    db.saveThreadPage(threadPage(9, [], { replyCount: 29 }), fetchedAt)
    db.saveThreadPage(threadPage(1, [], { replyCount: null }), later)
    expect(db.getThreadCoverage(threadId, 'all').reportedReplyCount).toBe(0)
  })

  it('keeps PO observations separate from all-mode coverage and page content', () => {
    const db = open(databasePath())
    const po = threadPage(3, [post('1001')], { mode: 'po', replyCount: 1 })
    db.saveThreadPage(po, fetchedAt)
    expect(db.getThreadCoverage(threadId, 'all')).toEqual(computeCoverage(threadId, 'all', [], null))
    expect(db.loadThreadPage(threadId, 'all', 3)).toBeNull()
    expect(db.loadThreadPage(threadId, 'po', 3)).toEqual({ value: po, fetchedAt })
    db.saveThreadPage(threadPage(1, [post('1002')], { replyCount: 20 }), later)
    expect(db.getThreadCoverage(threadId, 'all').pages.map((page) => page.page)).toEqual([1])
    expect(db.getThreadCoverage(threadId, 'po').reportedReplyCount).toBe(1)
  })

  it('round-trips feed summaries, null counts, recent replies and separate forum/timeline keys', () => {
    const db = open(databasePath())
    const page: FeedPage = {
      feed: { kind: 'forum', id: '4' },
      page: 2,
      skippedItems: 1,
      threads: [
        { head: post(threadId), replyCount: null, recentReplies: [post('1001'), post('1002')], remainReplies: null },
        { head: post('2000'), replyCount: 0, recentReplies: [], remainReplies: 0 }
      ]
    }
    db.saveFeedPage(page, fetchedAt)
    expect(db.loadFeedPage(page.feed, page.page)).toEqual({ value: page, fetchedAt })
    expect(db.getThreadCoverage(threadId, 'all').pages).toEqual([])
    expect(db.loadFeedPage({ kind: 'timeline', id: '4' }, 2)).toBeNull()
    const timeline: FeedPage = { ...page, feed: { kind: 'timeline', id: '4' }, threads: [] }
    db.saveFeedPage(timeline, later)
    expect(db.loadFeedPage(timeline.feed, 2)).toEqual({ value: timeline, fetchedAt: later })
    expect(db.loadFeedPage(page.feed, 2)?.value).toEqual(page)
    const replacement: FeedPage = { ...page, threads: [page.threads[1]!], skippedItems: 0 }
    db.saveFeedPage(replacement, latest)
    expect(db.loadFeedPage(page.feed, 2)?.value).toEqual(replacement)
  })

  it('atomically replaces the directory snapshot with rules, notice and unknown fields intact', () => {
    const db = open(databasePath())
    expect(db.loadDirectory()).toBeNull()
    const directory: BoardDirectory = {
      groups: [{ id: 'g1', name: '分组', forums: [{
        id: '4', groupId: 'g1', groupName: '分组', name: '综合版', displayName: '综合版 1',
        rules: post('1').content, postIntervalSeconds: null
      }] }],
      timelines: [{ id: '1', name: '时间线', displayName: '综合时间线', notice: post('2').content, maxPage: null }],
      skippedItems: 1
    }
    db.saveDirectory(directory, fetchedAt)
    expect(db.loadDirectory()).toEqual({ value: directory, fetchedAt })
    db.saveDirectory({ groups: [], timelines: [], skippedItems: 0 }, later)
    expect(db.loadDirectory()).toEqual({ value: { groups: [], timelines: [], skippedItems: 0 }, fetchedAt: later })
  })

  it('uses latest post observations while retaining the first post-to-thread relation and its evidence', () => {
    const path = databasePath()
    const db = open(path)
    const reply = post('1001', { name: 'original' })
    db.saveFeedPage({
      feed: { kind: 'forum', id: '4' }, page: 2, skippedItems: 0,
      threads: [{ head: post(threadId), replyCount: null, recentReplies: [reply], remainReplies: null }]
    }, fetchedAt)
    db.saveThreadPage(threadPage(1, [{ ...reply, name: 'new', isAdmin: false }]), latest)
    db.saveThreadPage(threadPage(2, [{ ...reply, name: 'older' }]), later)
    const other = threadPage(1, [reply], { threadId: '3000', head: post('3000') })
    db.saveThreadPage(other, fetchedAt)
    expect(db.loadThreadPage(threadId, 'all', 1)?.value.replies[0]?.name).toBe('new')
    expect(db.loadFeedPage({ kind: 'forum', id: '4' }, 2)?.value.threads[0]?.recentReplies[0]?.isAdmin).toBe(false)
    const raw = new Database(path, { readonly: true })
    try {
      expect(raw.prepare('SELECT thread_id, observed_as, feed_kind, feed_id, mode, page FROM post_threads WHERE post_id = ?')
        .get(reply.id)).toEqual({
          thread_id: threadId, observed_as: 'feed-recent-reply', feed_kind: 'forum', feed_id: '4', mode: null, page: 2
        })
    } finally {
      raw.close()
    }
  })

  it('rolls back all content and relations when a page save fails', () => {
    const db = open(databasePath())
    const original = threadPage(1, [post('1001')])
    db.saveThreadPage(original, fetchedAt)
    expect(() => db.saveThreadPage(threadPage(0, [post('1002')], {
      head: { ...original.head, title: 'must roll back' }
    }), later)).toThrow()
    expect(db.loadThreadPage(threadId, 'all', 1)?.value).toEqual(original)
    expect(db.getThreadCoverage(threadId, 'all').pages.map((page) => page.page)).toEqual([1])
  })

  it('rolls back all pending migrations together and keeps the original database readable', () => {
    const path = databasePath()
    const original = threadPage(1, [post('1001')])
    const db = open(path)
    db.saveThreadPage(original, fetchedAt)
    db.close()
    const before = readFileSync(path)
    const beforeSchema = schema(path)
    const failed = openReadingDatabase(path, [
      ...MIGRATIONS,
      { version: 2, up(connection) { connection.exec('CREATE TABLE migration_two (id TEXT)') } },
      { version: 3, up(connection) {
        connection.exec('CREATE TABLE migration_three (id TEXT)')
        throw new Error('injected migration failure')
      } }
    ])
    databases.push(failed)
    expect(failed.status).toEqual({ state: 'unavailable', reason: 'migration-failed' })
    expect(failed.loadThreadPage(threadId, 'all', 1)).toBeNull()
    expect(failed.getThreadCoverage(threadId, 'all').pages).toEqual([])
    expect(() => failed.saveThreadPage(original, later)).toThrow(StorageWriteRefusedError)
    expect(readFileSync(path)).toEqual(before)
    expect(schema(path)).toEqual(beforeSchema)
    expect(open(path).loadThreadPage(threadId, 'all', 1)).toEqual({ value: original, fetchedAt })
  })

  it('rolls back an injected v2 migration that creates a table before throwing', () => {
    const path = databasePath()
    const db = open(path)
    db.close()
    const before = readFileSync(path)
    const failed = openReadingDatabase(path, [...MIGRATIONS, {
      version: 2,
      up(connection) {
        connection.exec('CREATE TABLE must_not_survive (id TEXT)')
        throw new Error('injected failure')
      }
    }])
    databases.push(failed)
    expect(failed.status).toEqual({ state: 'unavailable', reason: 'migration-failed' })
    expect(readFileSync(path)).toEqual(before)
    expect(schema(path).version).toBe(1)
  })

  it('opens newer schemas read-only, permits compatible loads, refuses every save and leaves bytes untouched', () => {
    const path = databasePath()
    const original = threadPage(1, [post('1001')])
    const db = open(path)
    db.saveThreadPage(original, fetchedAt)
    db.close()
    const raw = new Database(path)
    raw.pragma('user_version = 999')
    raw.close()
    const before = readFileSync(path)
    const newer = open(path)
    expect(newer.status).toEqual({ state: 'read-only', reason: 'newer-schema', schemaVersion: 999, supportedVersion: 1 })
    expect(newer.loadThreadPage(threadId, 'all', 1)).toEqual({ value: original, fetchedAt })
    expect(() => newer.saveThreadPage(original, later)).toThrow(StorageWriteRefusedError)
    expect(() => newer.saveDirectory({ groups: [], timelines: [], skippedItems: 0 }, later)).toThrow(StorageWriteRefusedError)
    expect(() => newer.saveFeedPage({ feed: { kind: 'forum', id: '4' }, page: 1, threads: [], skippedItems: 0 }, later))
      .toThrow(StorageWriteRefusedError)
    newer.close()
    expect(readFileSync(path)).toEqual(before)
    expect(schema(path).version).toBe(999)
  })

  it('reports non-database input as unavailable without modifying or repairing the file', () => {
    const path = databasePath()
    const bytes = Buffer.from('this is not SQLite\nunchanged\u0000bytes')
    writeFileSync(path, bytes)
    const db = open(path)
    expect(db.status).toEqual({ state: 'unavailable', reason: 'open-failed' })
    expect(db.loadDirectory()).toBeNull()
    expect(db.loadFeedPage({ kind: 'forum', id: '4' }, 1)).toBeNull()
    expect(db.loadThreadPage(threadId, 'all', 1)).toBeNull()
    expect(db.getThreadCoverage(threadId, 'po')).toEqual(computeCoverage(threadId, 'po', [], null))
    expect(() => db.saveDirectory({ groups: [], timelines: [], skippedItems: 0 }, fetchedAt)).toThrow(StorageWriteRefusedError)
    expect(readFileSync(path)).toEqual(bytes)
  })
})

describe('computeCoverage', () => {
  it('sorts without mutating input, finds every gap and the lowest end candidate, and counts distinct replies', () => {
    const pages = [
      coveragePage(5, { endCandidate: true }),
      coveragePage(3, { replyIds: ['1001', '1002'], endCandidate: true }),
      coveragePage(1, { replyIds: ['1001'] })
    ]
    const result = computeCoverage(threadId, 'all', pages, 2)
    expect(pages.map((page) => page.page)).toEqual([5, 3, 1])
    expect(result.pages.map((page) => page.page)).toEqual([1, 3, 5])
    expect(result.gaps).toEqual([2, 4])
    expect(result.endCandidatePage).toBe(3)
    expect(result.obtainedReplyCount).toBe(2)
    expect(result.countMismatch).toBeNull()
  })

  it('does not infer completeness from a count or short page, and handles an observed empty thread', () => {
    expect(computeCoverage(threadId, 'all', [coveragePage(1, { replyIds: ['1001'] })], 1).countMismatch).toBeNull()
    expect(computeCoverage(threadId, 'all', [coveragePage(1, { endCandidate: true })], 0).countMismatch).toBe(false)
    expect(computeCoverage(threadId, 'all', [coveragePage(1, { endCandidate: true })], null).countMismatch).toBeNull()
    expect(computeCoverage(threadId, 'all', [coveragePage(1, { endCandidate: true, skippedItems: 1 })], 0)
      .countMismatch).toBeNull()
    expect(computeCoverage(threadId, 'all', [], null).gaps).toEqual([])
  })
})

class ControlledWorker extends EventEmitter {
  readonly requests: { id: number; method: string; args: unknown[] }[] = []

  postMessage(message: { id: number; method: string; args: unknown[] }) {
    this.requests.push(message)
  }

  ready(status: StorageStatus = { state: 'ready', schemaVersion: 1 }) {
    this.emit('message', { type: 'ready', status })
  }

  respond(value: unknown) {
    const request = this.requests.at(-1)
    if (!request) throw new Error('no storage request is pending')
    this.emit('message', { id: request.id, ok: true, value })
  }
}

function controlledStore(worker: ControlledWorker) {
  return openReadingStore({
    databasePath: '/unused/controlled.sqlite',
    createWorker(_options: WorkerOptions) {
      queueMicrotask(() => worker.ready())
      return worker as unknown as Worker
    }
  })
}

describe('reading store worker lifecycle', () => {
  it('rejects in-flight work after a worker crash and degrades subsequent calls without hanging', async () => {
    const worker = new ControlledWorker()
    const store = await controlledStore(worker)
    const loading = store.loadDirectory()
    const saving = store.saveThreadPage(threadPage(1, []), fetchedAt)
    const rejected = Promise.all([
      expect(loading).rejects.toThrow('database worker stopped'),
      expect(saving).rejects.toThrow('database worker stopped')
    ])
    worker.emit('error', new Error('controlled crash'))
    await rejected
    expect(store.status).toEqual({ state: 'unavailable', reason: 'open-failed' })
    expect(await store.loadDirectory()).toBeNull()
    expect(await store.loadFeedPage({ kind: 'forum', id: '4' }, 1)).toBeNull()
    expect(await store.loadThreadPage(threadId, 'all', 1)).toBeNull()
    expect(await store.getThreadCoverage(threadId, 'all')).toEqual(computeCoverage(threadId, 'all', [], null))
    await expect(store.saveDirectory({ groups: [], timelines: [], skippedItems: 0 }, fetchedAt)).rejects.toBeInstanceOf(StorageWriteRefusedError)
    await store.close()
  })

  it('round-trips write refusal errors and closes idempotently through the worker', async () => {
    const worker = new ControlledWorker()
    const store = await controlledStore(worker)
    const saving = store.saveThreadPage(threadPage(1, []), fetchedAt)
    const status: StorageStatus = { state: 'read-only', reason: 'newer-schema', schemaVersion: 999, supportedVersion: 1 }
    const pending = worker.requests.at(-1)!
    worker.emit('message', {
      id: pending.id, ok: false, error: { name: 'StorageWriteRefusedError', message: 'storage write refused', status }
    })
    await expect(saving).rejects.toMatchObject({ name: 'StorageWriteRefusedError', status })
    await expect(saving).rejects.toBeInstanceOf(StorageWriteRefusedError)
    const closing = store.close()
    worker.respond(undefined)
    await closing
    await store.close()
    expect(await store.loadDirectory()).toBeNull()
  })

  it('rejects pending calls on an unexpected clean exit, not only an error event', async () => {
    const worker = new ControlledWorker()
    const store = await controlledStore(worker)
    const loading = store.loadDirectory()
    const rejected = expect(loading).rejects.toThrow('database worker stopped')
    worker.emit('exit', 0)
    await rejected
    expect(store.status).toEqual({ state: 'unavailable', reason: 'open-failed' })
    await store.close()
  })

  it('returns an unavailable store if the worker cannot start', async () => {
    const store = await openReadingStore({
      databasePath: '/unused/controlled.sqlite',
      createWorker() { throw new Error('worker startup failed') }
    })
    expect(store.status).toEqual({ state: 'unavailable', reason: 'open-failed' })
    expect(await store.loadDirectory()).toBeNull()
    await store.close()
  })
})
