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
import { DEFAULT_SETTINGS } from '../src/shared/settings'
import { MIGRATIONS as PUBLICATION_MIGRATIONS } from './fixtures/lifecycle-v7'

const fetchedAt = '2026-10-23T08:00:00.000Z'
const later = '2026-10-23T08:01:00.000Z'
const latest = '2026-10-23T08:02:00.000Z'
const threadId = '900719925474099312345'
const folders: string[] = []
const SUPPORTED_VERSION = Math.max(...MIGRATIONS.map((migration) => migration.version))
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
    expect(db.status).toEqual({ state: 'ready', schemaVersion: SUPPORTED_VERSION })
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

  it('replaces page observations and deduplicates retained IDs read out of order instead of accumulating stale replies', () => {
    const db = open(databasePath())
    db.saveThreadPage(threadPage(2, [post('1002'), post('1003')]), fetchedAt)
    db.saveThreadPage(threadPage(1, [post('1001'), post('1002')], { replyCount: 3 }), fetchedAt)
    expect(db.getThreadCoverage(threadId, 'all').obtainedReplyCount).toBe(3)
    const refreshed = threadPage(1, [post('1002')], { replyCount: null })
    db.saveThreadPage(refreshed, later)
    expect(db.getThreadCoverage(threadId, 'all').obtainedReplyCount).toBe(2)
    expect(db.getThreadCoverage(threadId, 'all').reportedReplyCount).toBe(3)
    expect(db.loadThreadPage(threadId, 'all', 1)?.value).toEqual(refreshed)
  })

  it('refuses repeated lower-page content before writing posts, relations or end observations', () => {
    const db = open(databasePath())
    db.saveThreadPage(threadPage(100, [post('1001'), post('1002')], { replyCount: 2194 }), fetchedAt)
    expect(() => db.saveThreadPage(threadPage(116, [post('1001'), post('1002')], { replyCount: 2194 }), later))
      .toThrow('forum read failed: page-cap/shape')
    expect(db.loadThreadPage(threadId, 'all', 116)).toBeNull()
    expect(db.getThreadCoverage(threadId, 'all')).toMatchObject({ obtainedReplyCount: 2, endCandidatePage: null })
    expect(db.findPostThread('1002')?.pages.all).toBe(100)
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
    // Another mode's page: in one mode, a later page repeating page 1's replies is a page cap.
    db.saveThreadPage(threadPage(2, [{ ...reply, name: 'older' }], { mode: 'po' }), later)
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
      { version: SUPPORTED_VERSION + 1, up(connection) { connection.exec('CREATE TABLE migration_three (id TEXT)') } },
      { version: SUPPORTED_VERSION + 2, up(connection) {
        connection.exec('CREATE TABLE migration_four (id TEXT)')
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

  it('rolls back an injected next migration that creates a table before throwing', () => {
    const path = databasePath()
    const db = open(path)
    db.close()
    const before = readFileSync(path)
    const failed = openReadingDatabase(path, [...MIGRATIONS, {
      version: SUPPORTED_VERSION + 1,
      up(connection) {
        connection.exec('CREATE TABLE must_not_survive (id TEXT)')
        throw new Error('injected failure')
      }
    }])
    databases.push(failed)
    expect(failed.status).toEqual({ state: 'unavailable', reason: 'migration-failed' })
    expect(readFileSync(path)).toEqual(before)
    expect(schema(path).version).toBe(SUPPORTED_VERSION)
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
    expect(newer.status).toEqual({ state: 'read-only', reason: 'newer-schema', schemaVersion: 999, supportedVersion: SUPPORTED_VERSION })
    expect(newer.loadThreadPage(threadId, 'all', 1)).toEqual({ value: original, fetchedAt })
    expect(() => newer.saveThreadPage(original, later)).toThrow(StorageWriteRefusedError)
    expect(() => newer.saveDirectory({ groups: [], timelines: [], skippedItems: 0 }, later)).toThrow(StorageWriteRefusedError)
    expect(() => newer.saveFeedPage({ feed: { kind: 'forum', id: '4' }, page: 1, threads: [], skippedItems: 0 }, later))
      .toThrow(StorageWriteRefusedError)
    expect(newer.getReadingState(threadId).unread.map((item) => item.postId)).toEqual(['1001', threadId])
    expect(() => newer.markPostsRead(threadId, ['1001'], later)).toThrow(StorageWriteRefusedError)
    expect(() => newer.setReadingMode(threadId, 'po', later)).toThrow(StorageWriteRefusedError)
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

describe('reading context', () => {
  const anchorA = { postId: '1002', page: 1, offsetRatio: 0.25, viewportOffset: 64 }
  const anchorB = { postId: '1002', page: 1, offsetRatio: 0.5, viewportOffset: 72 }

  function pageOf(thread: string, mode: 'all' | 'po', page: number, replyIds: string[]): ThreadPage {
    return {
      threadId: thread, mode, page, head: post(thread), replies: replyIds.map((id) => post(id)),
      replyCount: null, skippedItems: 0, endCandidate: replyIds.length === 0
    }
  }

  it('keeps the mode preference and each mode’s position independent across a restart', () => {
    const path = databasePath()
    const db = open(path)
    db.saveThreadPage(threadPage(1, [post('1001'), post('1002')]), fetchedAt)
    expect(db.getReadingState(threadId)).toMatchObject({ mode: 'all', positions: { all: null, po: null } })
    db.setReadingMode(threadId, 'po', fetchedAt)
    db.saveReadingPosition(threadId, 'all', anchorA, fetchedAt)
    db.saveReadingPosition(threadId, 'po', anchorB, later)
    db.saveReadingPosition(threadId, 'all', { ...anchorA, offsetRatio: 0.75 }, latest)
    db.setReadingMode('77', 'all', later)
    db.close()

    const state = open(path).getReadingState(threadId)
    expect(state.mode).toBe('po')
    expect(state.positions).toEqual({
      all: { anchor: { ...anchorA, offsetRatio: 0.75 }, savedAt: latest },
      po: { anchor: anchorB, savedAt: later }
    })
  })

  it('lists only observed posts as confirmed unread: a later page read leaves the middle unread and PO reading leaves others', () => {
    const db = open(databasePath())
    db.saveThreadPage(threadPage(1, [post('1001'), post('1002'), post('1003')]), fetchedAt)
    db.saveThreadPage(threadPage(3, [post('3001'), post('3002')]), fetchedAt)
    db.saveThreadPage(threadPage(1, [post('1002')], { mode: 'po' }), fetchedAt)
    expect(db.markPostsRead(threadId, ['3001', '3002'], later)).toEqual(['3001', '3002'])
    expect(db.markPostsRead(threadId, ['1002', '1002', '3001', '424242'], later)).toEqual(['1002'])

    const state = db.getReadingState(threadId)
    expect(state.readPostIds).toEqual(['1002', '3001', '3002'])
    expect(state.unread).toEqual([
      { postId: '1001', pages: { all: 1, po: null } },
      { postId: '1003', pages: { all: 1, po: null } },
      { postId: threadId, pages: { all: 1, po: 1 } }
    ])
    expect(state.coverage.all.gaps).toEqual([2])
    expect(state.coverage.po.pages.map((page) => page.page)).toEqual([1])
  })

  it('ignores posts that were never observed in the thread', () => {
    const db = open(databasePath())
    db.saveThreadPage(threadPage(1, [post('1001')]), fetchedAt)
    db.saveThreadPage(pageOf('88', 'all', 1, ['8801']), fetchedAt)
    expect(db.markPostsRead(threadId, ['8801', '9999'], later)).toEqual([])
    expect(db.getReadingState(threadId).readPostIds).toEqual([])
    expect(db.getReadingState('88').readPostIds).toEqual([])
  })

  it('marking the confirmed set read leaves posts observed afterwards unread', () => {
    const db = open(databasePath())
    db.saveThreadPage(threadPage(1, [post('1001'), post('1002')]), fetchedAt)
    const confirmed = db.getReadingState(threadId).unread.map((item) => item.postId)
    db.saveThreadPage(threadPage(1, [post('1001'), post('1002'), post('1003')]), later)
    db.markPostsRead(threadId, confirmed, latest)
    expect(db.getReadingState(threadId).unread.map((item) => item.postId)).toEqual(['1003'])
  })

  it('keeps the subscription time as the start; replies first seen later are new only once proven', () => {
    const db = open(databasePath())
    const thread = '50000000'
    const t = (minute: number) => `2026-10-23T09:${String(minute).padStart(2, '0')}:00.000Z`
    db.saveThreadPage(pageOf(thread, 'all', 1, ['50000001', '50000002']), t(0))
    expect(db.establishAttention(thread, 'subscription', t(1))).toEqual({
      startedAt: t(1), source: 'subscription', watermarkPostId: '50000002', firstProvenNewPostId: null,
      newUnreadIds: [], uncertainUnreadIds: []
    })
    expect(db.getReadingState(thread).readPostIds).toEqual([])

    // 50000003 may have been posted before attention began: first seen later, but not provably new.
    db.saveThreadPage(pageOf(thread, 'all', 1, ['50000001', '50000002', '50000003']), t(2))
    expect(db.getReadingState(thread).attention).toMatchObject({ newUnreadIds: [], uncertainUnreadIds: ['50000003'] })

    // Page 1 then an empty page 2, both after the start: nothing above 50000003 existed at t(2).
    db.saveThreadPage(pageOf(thread, 'all', 2, []), t(3))
    db.saveThreadPage(pageOf(thread, 'all', 1, ['50000001', '50000002', '50000003', '50000004']), t(4))
    expect(db.establishAttention(thread, 'reminder', t(5))).toEqual({
      startedAt: t(1), source: 'subscription', watermarkPostId: '50000002', firstProvenNewPostId: '50000004',
      newUnreadIds: ['50000004'], uncertainUnreadIds: ['50000003']
    })
    db.markPostsRead(thread, ['50000004'], t(5))
    expect(db.getReadingState(thread).attention).toMatchObject({ newUnreadIds: [], uncertainUnreadIds: ['50000003'] })
    expect(db.getReadingState(thread).unread.map((item) => item.postId)).toEqual([thread, '50000001', '50000002', '50000003'])
  })

  it('does not use end observations made before the start as proof', () => {
    const db = open(databasePath())
    const thread = '50000000'
    db.saveThreadPage(pageOf(thread, 'all', 1, ['50000001']), fetchedAt)
    db.saveThreadPage(pageOf(thread, 'all', 2, []), fetchedAt)
    db.establishAttention(thread, 'favorite', later)
    db.saveThreadPage(pageOf(thread, 'all', 1, ['50000001', '50000002']), latest)
    expect(db.getReadingState(thread).attention).toMatchObject({
      firstProvenNewPostId: null, newUnreadIds: [], uncertainUnreadIds: ['50000002']
    })
  })

  it('confirms new replies from another thread’s evidence before this thread has its own', () => {
    const db = open(databasePath())
    const t = (minute: number) => `2026-10-23T10:${String(minute).padStart(2, '0')}:00.000Z`
    db.saveThreadPage(pageOf('60000000', 'all', 1, ['60000001']), t(0))
    db.establishAttention('60000000', 'subscription', t(1))
    // Another thread's end is seen after the start; a later reply there was posted after the start.
    db.saveThreadPage(pageOf('60000002', 'all', 1, ['60000003']), t(2))
    db.saveThreadPage(pageOf('60000002', 'all', 2, []), t(2))
    db.saveThreadPage(pageOf('60000002', 'all', 1, ['60000003', '60000005']), t(4))
    // This thread's end has never been observed.
    db.saveThreadPage(pageOf('60000000', 'all', 1, ['60000001', '60000004', '60000006']), t(5))
    expect(db.getReadingState('60000000').attention).toMatchObject({
      watermarkPostId: '60000001', firstProvenNewPostId: '60000005',
      newUnreadIds: ['60000006'], uncertainUnreadIds: ['60000004']
    })
  })

  it('does not take a reply that vanished before the end observation as proof of a new one', () => {
    const db = open(databasePath())
    const t = (minute: number) => `2026-10-23T11:${String(minute).padStart(2, '0')}:00.000Z`
    db.saveThreadPage(pageOf('60000000', 'all', 1, ['60000001', '60000003']), t(0))
    db.establishAttention('50000000', 'subscription', t(1))
    // 60000003 was removed from the other thread; its end is then observed without it.
    db.saveThreadPage(pageOf('60000000', 'all', 1, ['60000001']), t(2))
    db.saveThreadPage(pageOf('60000000', 'all', 2, []), t(3))
    // 60000004 existed before the start but is only fetched now.
    db.saveThreadPage(pageOf('50000000', 'all', 1, ['60000004']), t(4))
    expect(db.getReadingState('50000000').attention).toMatchObject({
      watermarkPostId: '60000003', firstProvenNewPostId: null, newUnreadIds: [], uncertainUnreadIds: ['60000004']
    })
    expect(db.getReadingState('50000000').readPostIds).toEqual([])
  })

  it('an import before anything was observed starts from the first local observation', () => {
    const db = open(databasePath())
    const thread = '50000000'
    expect(db.establishAttention(thread, 'import', fetchedAt).watermarkPostId).toBeNull()
    db.saveThreadPage(pageOf(thread, 'all', 1, ['50000001']), later)
    db.saveThreadPage(pageOf(thread, 'all', 2, []), later)
    expect(db.getReadingState(thread).attention).toMatchObject({
      source: 'import', firstProvenNewPostId: null, newUnreadIds: [], uncertainUnreadIds: ['50000001']
    })
    db.saveThreadPage(pageOf(thread, 'all', 1, ['50000001', '50000002']), latest)
    expect(db.getReadingState(thread).attention).toMatchObject({ newUnreadIds: ['50000002'] })
  })

  it('upgrades a version 1 database without losing content and starts with empty reading state', () => {
    const path = databasePath()
    const raw = new Database(path)
    MIGRATIONS[0]!.up(raw)
    for (const value of [post(threadId), post('1001')]) {
      raw.prepare(`INSERT INTO posts(id, forum_id, created_at, user_hash, name, title, is_admin, is_sage,
        content_json, plain_text, image_path, image_ext, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(value.id, value.forumId, value.createdAt, value.userHash, value.name, value.title,
          value.isAdmin === null ? null : Number(value.isAdmin), value.isSage === null ? null : Number(value.isSage),
          JSON.stringify(value.content), value.plainText, null, null, fetchedAt)
      raw.prepare('INSERT INTO post_threads VALUES (?, ?, ?, NULL, NULL, ?, 1, ?)')
        .run(value.id, threadId, value.id === threadId ? 'head' : 'thread-reply', 'all', fetchedAt)
    }
    raw.prepare('INSERT INTO thread_pages VALUES (?, ?, 1, ?, ?, ?, NULL, 0, 0)')
      .run(threadId, 'all', threadId, fetchedAt, JSON.stringify(['1001']))
    raw.pragma('user_version = 1')
    raw.close()
    expect(schema(path).version).toBe(1)
    const upgraded = open(path)
    expect(upgraded.status).toEqual({ state: 'ready', schemaVersion: SUPPORTED_VERSION })
    expect(upgraded.loadThreadPage(threadId, 'all', 1)?.value.replies.map((reply) => reply.id)).toEqual(['1001'])
    expect(upgraded.getReadingState(threadId)).toMatchObject({ mode: 'all', readPostIds: [], attention: null })
    expect(upgraded.markPostsRead(threadId, ['1001'], later)).toEqual(['1001'])
  })

  it('defaults new tabs to split and the close button to asking, and persists both settings', () => {
    const path = databasePath()
    const db = open(path)
    expect(db.loadSettings()).toEqual(DEFAULT_SETTINGS)
    db.saveSettings({ ...DEFAULT_SETTINGS, newTabSplitDefault: false, closeAction: 'background', density: 'compact', colorScheme: 'dark' })
    db.close()
    expect(open(path).loadSettings()).toEqual({ ...DEFAULT_SETTINGS, newTabSplitDefault: false, closeAction: 'background', density: 'compact', colorScheme: 'dark' })
  })
})

describe('window lifecycle storage', () => {
  it('upgrades a version 6 database keeping its sends, without launch notices, and keeps only the latest saved workspace', () => {
    const path = databasePath()
    const v6 = openReadingDatabase(path, PUBLICATION_MIGRATIONS.filter((migration) => migration.version <= 6))
    // Seed the frozen v6 table directly: the current write interface also maintains later columns.
    const seed = new Database(path)
    const credential = { id: String(seed.prepare("INSERT INTO credentials (name, source, imported_at, ciphertext) VALUES ('甲', 'raw', ?, ?)").run(fetchedAt, Buffer.from('synthetic')).lastInsertRowid) }
    seed.close()
    const sent = v6.createPublication({
      requestId: 'request-1', editorId: 'editor-1', forumId: '1', at: fetchedAt,
      payload: { draftId: null, target: { kind: 'thread', forumId: '1' }, credentialId: credential.id,
        fields: { content: '正文', title: '', name: '', email: '', watermark: false }, attachmentId: null }
    })
    v6.close()

    const db = open(path)
    expect(db.status).toEqual({ state: 'ready', schemaVersion: SUPPORTED_VERSION })
    expect(db.listPublications()).toEqual([sent])
    expect(db.listLaunchNotices()).toEqual([])
    expect(db.loadWorkspace()).toBeNull()
    db.saveWorkspace('{"first":true}', later)
    db.saveWorkspace('{"second":true}', latest)
    db.close()
    expect(open(path).loadWorkspace()).toBe('{"second":true}')
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
    expect(await store.loadPost('101')).toBeNull()
    expect(await store.findPostThread('101')).toBeNull()
    await expect(store.savePost(post('101'), fetchedAt)).rejects.toBeInstanceOf(StorageWriteRefusedError)
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
