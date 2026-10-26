import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { Post, ThreadPage } from '../src/shared/forum'
import { StorageWriteRefusedError } from '../src/main/storage/contract'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { MIGRATIONS } from '../src/main/storage/migrations'
import { DEFAULT_SETTINGS } from '../src/shared/settings'

const t0 = '2026-10-24T00:00:00.000Z'
const t1 = '2026-10-24T00:01:00.000Z'
const t2 = '2026-10-24T00:02:00.000Z'
const folders: string[] = []
const connections: Array<{ close(): void }> = []

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-retained-'))
  folders.push(folder)
  const path = join(folder, 'reading.sqlite')
  const db = openReadingDatabase(path)
  connections.push(db)
  return { folder, path, db }
}

function post(id: string, image = false, text = '中文 😀'): Post {
  return { id, forumId: null, createdAt: null, userHash: null, name: null, title: `标题${id}`,
    isAdmin: null, isSage: null, content: [{ type: 'text', text }], plainText: text,
    image: image ? { path: '2026-10-24/shared', ext: '.jpg' } : null }
}

function page(threadId = '100', replies: Post[] = [post('101')], number = 1): ThreadPage {
  return { threadId, mode: 'all', page: number, head: post(threadId), replies,
    replyCount: null, skippedItems: 0, endCandidate: replies.length === 0 }
}

function raw(path: string): Database.Database {
  const db = new Database(path)
  connections.push({ close() { if (db.open) db.close() } })
  return db
}

function clear(db: ReadingDatabase): string[] {
  const files: string[] = []
  for (let batch = 0; batch < 100; batch++) {
    const result = db.evictContentBatch(true)
    files.push(...result.fileNames)
    if (!result.more) return files
  }
  throw new Error('eviction failed to finish bounded batches')
}

function image(db: ReadingDatabase, folder: string, name: string, kind: 'thumb' | 'original' = 'original', held = false) {
  const bytes = Buffer.from('actual managed image bytes')
  writeFileSync(join(folder, name), bytes)
  return db.commitImageResource({ kind, sourceUrl: `https://images.example/${kind === 'thumb' ? 'thumb' : 'image'}/2026-10-24/shared.jpg`,
    fileName: name, bytes: statSync(join(folder, name)).size, format: 'jpeg', width: 1, height: 1, fetchedAt: t0 },
  held ? [{ kind: 'reading', id: 'view:one' }] : []).resource
}

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

describe('retained content storage', () => {
  it('returns only locally retained head metadata for list rows and keeps missing heads unknown', () => {
    const { db } = fixture()
    db.recordVisit('200', t0)
    expect(db.listHistory()[0]).toMatchObject({ threadId: '200', head: null, excerpt: null })
    const head: Post = { ...post('100', true, '保留正文'), userHash: 'AdminID', name: '名字',
      createdAt: '2026-10-24 08:00', isAdmin: true, isSage: true, forumId: '4' }
    db.saveThreadPage({ ...page(), head }, t0)
    db.recordVisit('100', t1)
    expect(db.listHistory()[0]).toMatchObject({
      threadId: '100', excerpt: '保留正文', head: { forumId: '4', createdAt: '2026-10-24 08:00',
        userHash: 'AdminID', name: '名字', title: '标题100', isAdmin: true, isSage: true,
        image: { path: '2026-10-24/shared', ext: '.jpg' } }
    })
    clear(db)
    expect(db.listHistory()[0]).toMatchObject({ threadId: '100', title: '标题100', head: null, excerpt: null })
  })

  it('lists offline copies by first save from local content only, and updating a copy keeps its place', () => {
    const { db } = fixture()
    db.beginOfflineCopy('100', false, t0)
    db.saveOfflinePage({ ...page('100'), replyCount: 7 }, t0)
    db.updateOfflineCopy('100', { state: 'stopped', failedPage: null, error: null, imageFailures: [] }, t0)
    // Started but no page saved yet: nothing about the thread is held, so it stays unknown.
    db.beginOfflineCopy('200', false, t1)
    expect(db.listOffline().map((entry) => entry.threadId)).toEqual(['200', '100'])

    db.beginOfflineCopy('100', false, t2)
    db.saveOfflinePage({ ...page('100'), replyCount: 9 }, t2)
    clear(db)
    const entries = db.listOffline()
    expect(entries.map((entry) => entry.threadId)).toEqual(['200', '100'])
    expect(entries[1]).toMatchObject({ head: post('100'), title: '标题100', replyCount: 9,
      copy: { createdAt: t0, updatedAt: t2, state: 'saving', pages: [1] } })
    expect(entries[0]).toMatchObject({ head: null, title: null, replyCount: null, copy: { createdAt: t1, pages: [] } })
  })

  it('retains entry titles and reminder observation evidence after clearing all cache', () => {
    const { db, path } = fixture()
    db.saveThreadPage(page(), t0)
    db.recordVisit('100', t1)
    clear(db)
    expect(db.loadThreadPage('100', 'all', 1)).toBeNull()
    expect(db.listHistory()[0]?.title).toBe('标题100')
    expect(db.getThreadCoverage('100', 'all').pages).toEqual([])
    expect(raw(path).prepare('SELECT count(*) AS n FROM reading_observations').get()).toEqual({ n: 1 })
  })

  it('clears visits alone by default and only the selected visit scope reading positions when requested', () => {
    const { db, path } = fixture()
    for (const id of ['100', '200', '300']) {
      db.saveThreadPage(page(id, [post(`${id}1`)]), t0)
      db.saveReadingPosition(id, 'all', { postId: id, page: 1, offsetRatio: 0.5, viewportOffset: 10 }, t0)
    }
    db.recordVisit('100', t0)
    db.recordVisit('200', t0)
    db.setReminderRule('100', 'all', true, t0)
    expect(db.updateReminderState({ threadId: '100', kind: 'all', generation: 1, at: t1, baseline: 3, add: 2, firstPage: 1 })).toBe(true)
    expect(db.clearHistory('100', false)).toEqual([])
    expect(db.getReadingState('100').positions.all).not.toBeNull()
    expect(db.listHistory().map((entry) => entry.threadId)).toEqual(['200'])
    db.recordVisit('100', t1)
    expect(db.clearHistory('100', true)).toEqual(['100'])
    expect(db.getReadingState('100').positions.all).toBeNull()
    expect(db.getReadingState('200').positions.all).not.toBeNull()
    expect(db.clearHistory('300', true)).toEqual([])
    expect(db.getReadingState('300').positions.all).not.toBeNull()
    expect(db.clearHistory(null, true)).toEqual(['200'])
    expect(db.getReadingState('200').positions.all).toBeNull()
    expect(db.getReadingState('300').positions.all).not.toBeNull()
    expect(db.reminderOverview().threads[0]).toMatchObject({ threadId: '100', counts: { all: 2 } })
  })

  it('counts UTF-8 payload once and keeps the quota independent from reading settings', () => {
    const { db } = fixture()
    const observed = { ...page('100', [post('101', false, 'a')]), head: post('100', false, 'a') }
    db.saveThreadPage(observed, t0)
    const asciiBytes = db.getContentUsage().cacheTextBytes
    db.saveThreadPage({ ...observed, head: post('100', false, '中'), replies: [post('101', false, '中')] }, t0)
    // Two source fields plus normalized source, projection and indexed logical representation.
    expect(db.getContentUsage().cacheTextBytes).toBe(asciiBytes + 20)
    db.saveThreadPage({ ...observed, head: post('100', false, '中'), replies: [post('101', false, '中')] }, t0)
    expect(db.getContentUsage().cacheTextBytes).toBe(asciiBytes + 20)
    db.setCacheLimit(250)
    db.saveSettings({ ...DEFAULT_SETTINGS, newTabSplitDefault: false })
    expect(db.getContentUsage().limitBytes).toBe(250)
    expect(db.loadSettings()).toEqual({ ...DEFAULT_SETTINGS, newTabSplitDefault: false })
  })

  it('evicts the least recently loaded thread and counts shared feed/thread text only once', () => {
    const { db } = fixture()
    db.saveThreadPage(page('100'), t0)
    db.saveThreadPage(page('200', [post('201')]), t0)
    db.loadThreadPage('100', 'all', 1)
    const total = db.getContentUsage().cacheTextBytes
    db.setCacheLimit(total - 1)
    db.evictContentBatch(false)
    expect(db.loadThreadPage('100', 'all', 1)).not.toBeNull()
    expect(db.loadThreadPage('200', 'all', 1)).toBeNull()
    db.saveFeedPage({ feed: { kind: 'forum', id: '4' }, page: 1, skippedItems: 0,
      threads: [{ head: post('100'), recentReplies: [post('101')], replyCount: null, remainReplies: null }] }, t1)
    clear(db)
    expect(db.loadFeedPage({ kind: 'forum', id: '4' }, 1)).toBeNull()
    expect(db.getContentUsage().cacheTextBytes).toBe(0)
  })

  it('accounts for standalone quote previews, refreshes their LRU use and clears them without inventing ownership', () => {
    const { db } = fixture()
    db.savePost(post('101'), t0)
    const onePostBytes = db.getContentUsage().cacheTextBytes
    expect(onePostBytes).toBeGreaterThan(0)
    db.savePost(post('102'), t0)
    expect(db.getContentUsage().cacheTextBytes).toBe(onePostBytes * 2)
    expect(db.findPostThread('101')).toBeNull()
    expect(db.loadPost('101')?.value).toEqual(post('101'))
    db.setCacheLimit(onePostBytes)
    expect(db.evictContentBatch(false).more).toBe(false)
    expect(db.loadPost('102')).toBeNull()
    expect(db.loadPost('101')?.value).toEqual(post('101'))
    clear(db)
    expect(db.loadPost('101')).toBeNull()
    expect(db.getContentUsage().cacheTextBytes).toBe(0)
  })

  it('updates quoted content through offline ownership without losing original image metadata', () => {
    const { db, folder } = fixture()
    db.beginOfflineCopy('100', true, t0)
    db.saveOfflinePage(page('100', [post('101', true)]), t0)
    const original = image(db, folder, 'quote-original.jpg')
    db.holdOfflineImage('100', '101')
    db.savePost(post('101', false, 'new quoted text'), t1)
    db.savePost(post('999'), t1)
    clear(db)

    expect(db.loadPost('999')).toBeNull()
    expect(db.loadPost('101')?.value).toEqual({ ...post('101', false, 'new quoted text'), image: post('101', true).image })
    expect(db.findPostThread('101')).toMatchObject({ threadId: '100', pages: { all: 1, po: null } })
    expect(db.getOfflineCopy('100')).toMatchObject({ postCount: 2, imageCount: 1, savedImages: 1 })
    expect(db.getContentUsage().protectedImageBytes).toBe(original.bytes)
    expect(readFileSync(join(folder, original.fileName)).byteLength).toBe(original.bytes)
  })

  it('treats a cache image find as recent use and returns only managed unheld filenames', () => {
    const { db, folder } = fixture()
    const first = image(db, folder, 'first.jpg')
    writeFileSync(join(folder, 'user-original.jpg'), 'untouched original')
    writeFileSync(join(folder, 'second.jpg'), 'actual managed image bytes')
    const second = db.commitImageResource({ ...first, sourceUrl: 'https://images.example/image/second.jpg', fileName: 'second.jpg' }, []).resource
    db.findImageResource('original', first.sourceUrl, null)
    db.setCacheLimit(db.getContentUsage().cacheTextBytes + first.bytes)
    const removed = db.evictContentBatch(false)
    expect(removed.fileNames).toEqual([second.fileName])
    for (const name of removed.fileNames) unlinkSync(join(folder, name))
    expect(readFileSync(join(folder, first.fileName)).byteLength).toBe(first.bytes)
    expect(readFileSync(join(folder, 'user-original.jpg'), 'utf8')).toBe('untouched original')
  })

  it('protects current reader text and draft targets/attachments without altering drafts', () => {
    const { db, folder } = fixture()
    db.saveThreadPage(page('100'), t0)
    db.saveThreadPage(page('200', [post('201')]), t0)
    db.holdContentReader('window:view', '100')
    writeFileSync(join(folder, 'draft.jpg'), 'draft actual bytes')
    const attachment = db.insertDraftAttachment({ fileName: 'draft.jpg', bytes: statSync(join(folder, 'draft.jpg')).size,
      format: 'jpeg', width: 1, height: 1, originalName: 'user.jpg', createdAt: t0 })
    const saved = db.saveDraft({ draftId: null, target: { kind: 'reply', threadId: '200' }, credentialId: null,
      fields: { content: 'private draft', title: '', name: '', watermark: false }, attachmentId: attachment.id }, t0)
    expect(saved.ok).toBe(true)
    const old = db.listDrafts()
    db.setCacheLimit(0)
    expect(clear(db)).toEqual([])
    expect(db.loadThreadPage('100', 'all', 1)).not.toBeNull()
    expect(db.loadThreadPage('200', 'all', 1)).not.toBeNull()
    expect(db.listDrafts()).toEqual(old)
    expect(db.getContentUsage()).toMatchObject({ cacheTextBytes: 0, protectedOverLimit: true })
    expect(readFileSync(join(folder, 'draft.jpg'), 'utf8')).toBe('draft actual bytes')
    db.releaseContentReaders('window:')
    clear(db)
    expect(db.loadThreadPage('100', 'all', 1)).toBeNull()
  })

  it('retains the offline union after omissions, update attempts, cancellation and cache clearing', () => {
    const { db, path } = fixture()
    db.beginOfflineCopy('100', true, t0)
    db.saveOfflinePage(page('100', [post('101', true), post('102', true)]), t0)
    db.saveOfflinePage(page('100', [], 2), t0)
    db.updateOfflineCopy('100', { state: 'cancelled', failedPage: 3, error: 'storage', imageFailures: [{ postId: '101', error: { reason: 'network' } }] }, t1)
    const update = db.beginOfflineCopy('100', false, t2)
    expect(update).toMatchObject({ createdAt: t0, pages: [1, 2], postCount: 3, state: 'saving', failedPage: null, error: null, imageFailures: [], endCandidatePage: null })
    db.saveOfflinePage(page('100', [post('102', true), post('103')]), t2)
    clear(db)
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies.map((reply) => reply.id)).toEqual(['101', '102', '103'])
    expect(db.getThreadCoverage('100', 'all').pages.map((entry) => entry.page)).toEqual([1, 2])
    expect(db.listOfflineImagePosts('100', null, 1)).toEqual(['101'])
    expect(db.listOfflineImagePosts('100', '101', 1)).toEqual(['102'])
    db.close()
    const reopened = openReadingDatabase(path)
    connections.push(reopened)
    reopened.recoverContent()
    expect(reopened.getOfflineCopy('100')).toMatchObject({ state: 'interrupted', postCount: 4, pages: [1, 2] })
  })

  it('deletes retention durably while preserving cached offline-only pages, union text and reading positions', () => {
    const { db, path } = fixture()
    db.beginOfflineCopy('100', false, t0)
    db.saveOfflinePage(page('100', [post('101'), post('102')]), t0)
    db.saveOfflinePage(page('100', [post('102'), post('103')]), t1)
    db.saveOfflinePage(page('100', [], 3), t1)
    db.recordVisit('100', t0)
    for (const mode of ['all', 'po'] as const) {
      db.saveReadingPosition('100', mode, { postId: '102', page: 1, offsetRatio: 0.5, viewportOffset: 12 }, t1)
    }
    db.setReadingMode('100', 'po', t1)
    const reading = db.getReadingState('100')
    const history = db.listHistory()
    clear(db) // Ordinary page rows are gone; only the offline union can serve these pages.
    expect(db.getContentUsage().cacheTextBytes).toBe(0)
    db.deleteOfflineCopy('100')
    expect(db.getOfflineCopy('100')).toBeNull()
    expect(db.listOffline()).toEqual([])
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies.map((reply) => reply.id)).toEqual(['101', '102', '103'])
    expect(db.loadThreadPage('100', 'all', 3)?.value.replies).toEqual([])
    expect(db.getThreadCoverage('100', 'all')).toMatchObject({ gaps: [2], endCandidatePage: 3,
      pages: [{ page: 1, replyIds: ['101', '102', '103'], endCandidate: false, skippedItems: 1 },
        { page: 3, replyIds: [], endCandidate: true, skippedItems: 0 }] })
    expect(db.getContentUsage().cacheTextBytes).toBeGreaterThan(0)
    expect(db.getContentUsage().protectedTextBytes).toBe(0)
    expect(db.getReadingState('100')).toMatchObject({ mode: reading.mode, positions: reading.positions })
    expect(db.listHistory()).toEqual(history.map((entry) => ({ ...entry, offline: null })))
    db.close()
    const reopened = openReadingDatabase(path)
    connections.push(reopened)
    reopened.recoverContent()
    expect(reopened.getOfflineCopy('100')).toBeNull()
    expect(reopened.loadThreadPage('100', 'all', 1)?.value.replies.map((reply) => reply.id)).toEqual(['101', '102', '103'])
    expect(reopened.getReadingState('100')).toMatchObject({ mode: reading.mode, positions: reading.positions })
    reopened.beginOfflineCopy('200', false, t1)
    expect(reopened.beginOfflineCopy('100', false, t2)).toMatchObject({ createdAt: t2, pages: [], postCount: 0 })
    expect(reopened.listOffline().map((entry) => entry.threadId)).toEqual(['100', '200'])
  })

  it('turns a completed copy and original image into readable cache without deleting its resource', () => {
    const { db, folder } = fixture()
    db.beginOfflineCopy('100', true, t0)
    db.saveOfflinePage(page('100', [post('101', true)]), t0)
    const original = image(db, folder, 'released-original.jpg')
    db.holdOfflineImage('100', '101')
    db.updateOfflineCopy('100', { state: 'stopped', failedPage: null, error: null, imageFailures: [] }, t1)
    db.deleteOfflineCopy('100')
    expect(db.getOfflineCopy('100')).toBeNull()
    expect(db.findImageResource('original', original.sourceUrl, null)).toEqual(original)
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies[0]).toEqual(post('101', true))
    expect(db.getContentUsage()).toMatchObject({ protectedTextBytes: 0, protectedImageBytes: 0, cacheImageBytes: original.bytes })
    expect(db.evictContentBatch(false)).toEqual({ fileNames: [], more: false })
    expect(readFileSync(join(folder, original.fileName)).byteLength).toBe(original.bytes)
  })

  it.each(['stopped', 'cancelled', 'interrupted'] as const)('deletes empty and partial %s copies idempotently without changing other copies', (state) => {
    const { db } = fixture()
    db.beginOfflineCopy('100', false, t0)
    db.beginOfflineCopy('200', true, t0)
    db.saveOfflinePage(page('200'), t0)
    db.updateOfflineCopy('200', { state, failedPage: 2, error: 'storage', imageFailures: [] }, t1)
    db.beginOfflineCopy('300', false, t1)
    db.saveOfflinePage(page('300', [post('301')]), t1)
    const other = db.getOfflineCopy('300')
    for (const id of ['100', '200', 'missing']) {
      db.deleteOfflineCopy(id)
      db.deleteOfflineCopy(id)
      expect(db.getOfflineCopy(id)).toBeNull()
    }
    expect(db.listOffline().map((entry) => entry.threadId)).toEqual(['300'])
    expect(db.getOfflineCopy('300')).toEqual(other)
    expect(db.loadThreadPage('200', 'all', 1)?.value.replies.map((reply) => reply.id)).toEqual(['101'])
  })

  it('releases only the target offline image holder while other copies and reading holders protect a shared original', () => {
    const { db, folder } = fixture()
    for (const id of ['100', '200']) {
      db.beginOfflineCopy(id, true, t0)
      db.saveOfflinePage(page(id, [post(`${id}1`, true)]), t0)
    }
    const original = image(db, folder, 'delete-shared.jpg', 'original', true)
    db.holdOfflineImage('100', '1001')
    db.holdOfflineImage('200', '2001')
    const other = db.getOfflineCopy('200')
    db.deleteOfflineCopy('100')
    db.setCacheLimit(0)
    expect(clear(db)).toEqual([])
    expect(db.getOfflineCopy('200')).toEqual(other)
    expect(db.loadThreadPage('100', 'all', 1)).toBeNull()
    expect(db.getContentUsage().protectedImageBytes).toBe(original.bytes)
    db.deleteOfflineCopy('200')
    expect(clear(db)).toEqual([])
    expect(db.deleteUnheldImages([original.id])).toEqual([])
    db.releaseImageHolders('reading', '')
    expect(clear(db)).toEqual([original.fileName])
    expect(db.listImageFileNames()).toEqual([])
  })

  it('keeps deleted-copy text protected by readers and drafts at quota zero while preserving personal records', () => {
    const { db, folder } = fixture()
    for (const id of ['100', '200', '300']) {
      db.beginOfflineCopy(id, false, t0)
      db.saveOfflinePage(page(id, [post(`${id}1`)]), t0)
    }
    db.recordVisit('100', t1)
    db.saveReadingPosition('100', 'all', { postId: '1001', page: 1, offsetRatio: 0.5, viewportOffset: 10 }, t1)
    db.saveReadingPosition('100', 'po', { postId: '100', page: 1, offsetRatio: 0.2, viewportOffset: 20 }, t1)
    db.setReminderRule('100', 'all', true, t1)
    db.holdContentReader('window:delete', '100')
    writeFileSync(join(folder, 'delete-draft.jpg'), 'draft actual bytes')
    const attachment = db.insertDraftAttachment({ fileName: 'delete-draft.jpg', bytes: statSync(join(folder, 'delete-draft.jpg')).size,
      format: 'jpeg', width: 1, height: 1, originalName: 'user.jpg', createdAt: t0 })
    const saved = db.saveDraft({ draftId: null, target: { kind: 'reply', threadId: '200' }, credentialId: null,
      fields: { content: 'private draft', title: '', name: '', watermark: false }, attachmentId: attachment.id }, t1)
    expect(saved.ok).toBe(true)
    const drafts = db.listDrafts()
    const reading = db.getReadingState('100')
    const history = db.listHistory()
    const reminders = db.getReminderRules(['100'])
    for (const id of ['100', '200', '300']) db.deleteOfflineCopy(id)
    db.setCacheLimit(0)
    expect(db.evictContentBatch(false).more).toBe(false)
    expect(db.loadThreadPage('100', 'all', 1)).not.toBeNull()
    expect(db.loadThreadPage('200', 'all', 1)).not.toBeNull()
    expect(db.loadThreadPage('300', 'all', 1)).toBeNull()
    expect(db.getContentUsage()).toMatchObject({ cacheTextBytes: 0, protectedOverLimit: true })
    expect(db.getReadingState('100')).toMatchObject({ mode: reading.mode, positions: reading.positions })
    expect(db.listHistory()).toEqual(history.map((entry) => ({ ...entry, offline: null })))
    expect(db.getReminderRules(['100'])).toEqual(reminders)
    expect(db.listDrafts()).toEqual(drafts)
    expect(readFileSync(join(folder, 'delete-draft.jpg'), 'utf8')).toBe('draft actual bytes')
    db.releaseContentReaders('window:')
    db.evictContentBatch(false)
    expect(db.loadThreadPage('100', 'all', 1)).toBeNull()
    expect(db.loadThreadPage('200', 'all', 1)).not.toBeNull()
    expect(db.getReadingState('100')).toMatchObject({ mode: reading.mode, positions: reading.positions })
    expect(db.getReminderRules(['100'])).toEqual(reminders)
    expect(db.listDrafts()).toEqual(drafts)
    expect(db.deleteDraft(drafts[0]!.id)).toBe(true)
    db.evictContentBatch(false)
    expect(db.loadThreadPage('200', 'all', 1)).toBeNull()
  })

  it.each([false, true])('does not make deletion recent use when ordinary pages were previously evicted: %s', (evicted) => {
    const { db } = fixture()
    db.beginOfflineCopy('100', false, t0)
    db.saveOfflinePage(page(), t0)
    if (evicted) clear(db)
    db.saveThreadPage(page('200', [post('201')]), t1)
    db.deleteOfflineCopy('100')
    db.setCacheLimit(db.getContentUsage().cacheTextBytes - 1)
    expect(db.evictContentBatch(false).more).toBe(false)
    expect(db.loadThreadPage('100', 'all', 1)).toBeNull()
    expect(db.loadThreadPage('200', 'all', 1)).not.toBeNull()
  })

  it('rolls back page promotion and every released holder when offline deletion fails, including after reopen', () => {
    const { db, folder, path } = fixture()
    db.beginOfflineCopy('100', true, t0)
    db.saveOfflinePage(page('100', [post('101', true)]), t0)
    const original = image(db, folder, 'rollback-original.jpg')
    db.holdOfflineImage('100', '101')
    clear(db)
    const before = db.getOfflineCopy('100')
    const usage = db.getContentUsage()
    raw(path).exec("CREATE TRIGGER fail_delete BEFORE DELETE ON offline_copies BEGIN SELECT RAISE(ABORT, 'disk full'); END")
    expect(() => db.deleteOfflineCopy('100')).toThrow()
    expect(db.getOfflineCopy('100')).toEqual(before)
    expect(db.getContentUsage()).toMatchObject({ cacheTextBytes: usage.cacheTextBytes,
      cacheImageBytes: usage.cacheImageBytes, protectedTextBytes: usage.protectedTextBytes, protectedImageBytes: usage.protectedImageBytes })
    expect(db.deleteUnheldImages([original.id])).toEqual([])
    db.close()
    const reopened = openReadingDatabase(path)
    connections.push(reopened)
    expect(reopened.getOfflineCopy('100')).toEqual(before)
    expect(reopened.loadThreadPage('100', 'all', 1)?.value.replies.map((reply) => reply.id)).toEqual(['101'])
    expect(clear(reopened)).toEqual([])
    expect(reopened.getContentUsage().cacheTextBytes).toBe(0)
    raw(path).exec('DROP TRIGGER fail_delete')
    reopened.deleteOfflineCopy('100')
    expect(reopened.getOfflineCopy('100')).toBeNull()
    expect(reopened.getContentUsage().cacheImageBytes).toBe(original.bytes)
    expect(reopened.getContentUsage().protectedImageBytes).toBe(0)
  })

  it('requires originals and shares one protected image across offline copies and reading holders', () => {
    const { db, folder } = fixture()
    for (const id of ['100', '200']) {
      db.beginOfflineCopy(id, true, t0)
      db.saveOfflinePage(page(id, [post(`${id}1`, true)]), t0)
    }
    const thumb = image(db, folder, 'thumb.jpg', 'thumb')
    expect(() => db.holdOfflineImage('100', '1001')).toThrow()
    expect(db.getOfflineCopy('100')?.savedImages).toBe(0)
    const original = image(db, folder, 'original.jpg', 'original', true)
    db.holdOfflineImage('100', '1001')
    db.holdOfflineImage('200', '2001')
    db.releaseImageHolders('reading', '')
    expect(db.getOfflineCopy('100')?.savedImages).toBe(1)
    expect(db.getOfflineCopy('200')?.savedImages).toBe(1)
    expect(db.getContentUsage().protectedImageBytes).toBe(original.bytes)
    expect(db.getContentUsage().cacheImageBytes).toBe(thumb.bytes)
    expect(clear(db)).toEqual(['thumb.jpg'])
    expect(db.deleteUnheldImages([original.id])).toEqual([])
    expect(readFileSync(join(folder, original.fileName)).byteLength).toBe(original.bytes)
  })

  it('clears only transient holds on recovery and preserves durable original references', () => {
    const { db, folder } = fixture()
    db.beginOfflineCopy('100', true, t0)
    db.saveOfflinePage(page('100', [post('101', true)]), t0)
    db.holdContentReader('dead-window', '200')
    const resource = image(db, folder, 'original.jpg', 'original', true)
    db.holdOfflineImage('100', '101')
    db.recoverContent()
    expect(db.getOfflineCopy('100')?.state).toBe('interrupted')
    expect(db.deleteUnheldImages([resource.id])).toEqual([])
    db.saveThreadPage(page('200', [post('201')]), t0)
    clear(db)
    expect(db.loadThreadPage('200', 'all', 1)).toBeNull()
  })

  it('rolls back an offline page transaction and preserves the previous recoverable version', () => {
    const { db, path } = fixture()
    db.beginOfflineCopy('100', false, t0)
    db.saveOfflinePage(page(), t0)
    const before = db.getOfflineCopy('100')
    raw(path).exec("CREATE TRIGGER fail_offline BEFORE INSERT ON offline_page_posts WHEN NEW.post_id = '102' BEGIN SELECT RAISE(ABORT, 'disk full'); END")
    expect(() => db.saveOfflinePage(page('100', [post('102')]), t1)).toThrow()
    expect(db.getOfflineCopy('100')).toEqual(before)
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies.map((reply) => reply.id)).toEqual(['101'])
    db.close()
    const reopened = openReadingDatabase(path)
    connections.push(reopened)
    expect(reopened.loadThreadPage('100', 'all', 1)?.value.replies.map((reply) => reply.id)).toEqual(['101'])
  })

  it('yields after 50 candidates and reports more only when actual work remains', () => {
    const { db, folder } = fixture()
    for (let index = 0; index < 51; index++) {
      db.commitImageResource({ kind: 'original', sourceUrl: `https://images.example/image/${index}.jpg`, fileName: `${index}.jpg`, bytes: 1, width: 1, height: 1, format: 'jpeg', fetchedAt: t0 }, [])
      writeFileSync(join(folder, `${index}.jpg`), 'x')
    }
    expect(db.evictContentBatch(true)).toMatchObject({ more: true, fileNames: expect.any(Array) })
    expect(db.listImageFileNames()).toHaveLength(1)
    expect(db.evictContentBatch(true)).toMatchObject({ more: false, fileNames: expect.any(Array) })
    expect(db.evictContentBatch(true)).toEqual({ fileNames: [], more: false })
  })

  it('upgrades genuine v5 databases atomically and preserves old schema on migration failure', () => {
    const { db, path } = fixture()
    db.close()
    rmSync(path)
    const old = raw(path)
    for (const migration of MIGRATIONS.filter((migration) => migration.version <= 5)) migration.up(old)
    old.pragma('user_version = 5')
    old.prepare('INSERT INTO thread_visits VALUES (?, ?, ?, 1)').run('100', t0, t0)
    old.close()
    const failed = openReadingDatabase(path, [...MIGRATIONS, { version: Math.max(...MIGRATIONS.map((migration) => migration.version)) + 1, up() { throw new Error('injected migration failure') } }])
    connections.push(failed)
    expect(failed.status).toEqual({ state: 'unavailable', reason: 'migration-failed' })
    const preserved = raw(path)
    expect(preserved.pragma('user_version', { simple: true })).toBe(5)
    expect(preserved.prepare("SELECT 1 FROM sqlite_master WHERE name = 'offline_copies'").get()).toBeUndefined()
    preserved.close()
    const upgraded = openReadingDatabase(path)
    connections.push(upgraded)
    expect(upgraded.status).toEqual({ state: 'ready', schemaVersion: Math.max(...MIGRATIONS.map((migration) => migration.version)) })
    expect(upgraded.listHistory().map((entry) => entry.threadId)).toEqual(['100'])
  })

  it('reports unavailable and newer-schema content operations explicitly rather than empty success', () => {
    const { db, path, folder } = fixture()
    db.close()
    raw(path).pragma('user_version = 999')
    const newer = openReadingDatabase(path)
    const absent = openReadingDatabase(join(folder, 'missing', 'reading.sqlite'))
    connections.push(newer, absent)
    for (const store of [newer, absent]) {
      expect(() => store.listHistory()).toThrow(StorageWriteRefusedError)
      expect(() => store.listOffline()).toThrow(StorageWriteRefusedError)
      expect(() => store.getContentUsage()).toThrow(StorageWriteRefusedError)
      expect(() => store.beginOfflineCopy('100', true, t0)).toThrow(StorageWriteRefusedError)
      expect(() => store.deleteOfflineCopy('100')).toThrow(StorageWriteRefusedError)
      expect(() => store.evictContentBatch(true)).toThrow(StorageWriteRefusedError)
    }
  })
})
