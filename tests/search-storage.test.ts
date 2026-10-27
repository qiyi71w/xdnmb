import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { normalizeSearchText } from '../src/main/storage/search'
import type { SearchFilters, SearchHit, SearchScope } from '../src/shared/search'
import type { Post, ThreadPage } from '../src/shared/forum'
import type { SubscriptionObservation, SubscriptionOperation } from '../src/shared/subscriptions'
import { matchContentFilters } from '../src/shared/search-filters'
import { MIGRATIONS } from '../src/main/storage/migrations'

const at = '2026-10-24T00:00:00.000Z'
const later = '2026-10-24T01:00:00.000Z'
const filters: SearchFilters = { forumId: null, fromDate: null, toDate: null, image: 'any', postKind: 'any' }
const resources: Array<{ folder: string; db: ReadingDatabase }> = []
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-search-'))
  const path = join(folder, 'app.sqlite')
  const db = openReadingDatabase(path)
  resources.push({ folder, db })
  rebuild(db)
  return { db, path }
}
function rebuild(db: ReadingDatabase) {
  db.beginSearchRebuild()
  for (let batch = 0; batch < 1000; batch++) if (db.rebuildSearchBatch()) return
  throw new Error('rebuild did not finish')
}
function post(id: string, body = '正文', extra: Partial<Post> = {}): Post {
  return { id, forumId: '4', createdAt: '2026-10-24(六)12:00:00', userHash: 'public', name: null, title: null,
    isAdmin: null, isSage: null, image: null, imageKnown: true, content: [{ type: 'text', text: body }], plainText: body, ...extra }
}
function page(head: Post, replies: Post[], number = 1): ThreadPage {
  return { threadId: head.id, mode: 'all', page: number, head, replies, replyCount: null, skippedItems: 0, endCandidate: replies.length === 0 }
}
function search(db: ReadingDatabase, query: string, scope: SearchScope = { kind: 'local' }, applied = filters): SearchHit[] {
  const input = { query: normalizeSearchText(query), scope, filters: applied, after: 0, upper: db.searchBoundary() }
  const hits: SearchHit[] = []
  for (let batch = 0; batch < 1000; batch++) {
    const result = db.searchBatch(input)
    hits.push(...result.batch.hits)
    input.after = result.cursor
    if (result.batch.done) return hits
  }
  throw new Error('search did not finish')
}
function clear(db: ReadingDatabase) {
  for (let batch = 0; batch < 1000; batch++) if (!db.evictContentBatch(true).more) return
  throw new Error('eviction did not finish')
}
function observation(head: Post): SubscriptionObservation {
  return { id: 'observed', source: 'app', context: { generation: 0, appCredentialId: null, webCredentialId: null },
    startedAt: at, pages: [{ page: 1, fetchedAt: at, endCandidate: false,
      threads: [{ head, recentReplies: [], replyCount: null, remainReplies: null }] }], ids: [head.id], nextPage: 2, error: null, cancelled: false }
}
afterEach(() => {
  for (const { folder, db } of resources.splice(0)) { db.close(); rmSync(folder, { force: true, recursive: true }) }
})

describe('real SQLite retained search', () => {
  it('retains PO proof from subscription content after eviction and restart without retaining public identities in indexed text', () => {
    const { db, path } = fixture()
    const evidence = observation(post('100', 'head needle', { userHash: 'po-id' }))
    evidence.pages[0]!.threads[0]!.recentReplies = [post('101', 'reply needle', { userHash: 'po-id' }), post('102', 'other needle', { userHash: 'other-id' })]
    db.saveSubscriptionObservation(evidence)
    clear(db)
    expect(search(db, 'needle', { kind: 'thread', threadId: '100', mode: 'po' }).map((hit) => hit.postId)).toEqual(['100', '101'])
    db.close()
    const reopened = openReadingDatabase(path)
    try {
      rebuild(reopened)
      expect(search(reopened, 'needle', { kind: 'thread', threadId: '100', mode: 'po' }).map((hit) => hit.postId)).toEqual(['100', '101'])
      expect(search(reopened, 'po-id')).toEqual([])
      expect(reopened.loadPost('101')).toBeNull()
    } finally { reopened.close() }
  })

  it.each(['中', '中文', '中文长子串', 'CAFÉ', 'cafe\u0301', '😀😃😄', '"', '%', '_*', '" OR *', 'a.b[c]'])('matches normalized literal %j through the selected driver', (query) => {
    const { db } = fixture()
    db.savePost(post('100', `前缀 中文长子串 Cafe\u0301 😀😃😄 引号" 百分号% 通配_* " OR * a.b[c] 后缀`), at)
    db.savePost(post('200', 'unrelated'), at)
    expect(search(db, query).map((hit) => hit.postId)).toEqual(['100'])
  })

  it('keeps title and body separate, bounds excerpts, and never indexes drafts or public identity fields', () => {
    const { db } = fixture()
    db.savePost(post('100', 'cdef', { title: 'ab', userHash: 'identity-only', name: 'name-only' }), at)
    db.savePost(post('101', '开头'.repeat(1000) + 'needle' + '结尾'.repeat(1000)), at)
    db.saveDraft({ draftId: null, target: { kind: 'reply', threadId: '100' }, credentialId: null,
      fields: { content: 'draft-only', title: 'draft-title', name: '', watermark: false }, attachmentId: null }, at)
    expect(search(db, 'bc')).toEqual([])
    expect(search(db, 'identity-only')).toEqual([])
    expect(search(db, 'name-only')).toEqual([])
    expect(search(db, 'draft-only')).toEqual([])
    expect(search(db, 'needle')[0]?.excerpt).toContain('needle')
    expect(search(db, 'needle')[0]!.excerpt.length).toBeLessThanOrEqual(240)
    expect(search(db, 'ab')[0]?.threadId).toBeNull()
  })

  it('closes a 防剧透 segment the excerpt window cuts, as the full text pairs it', () => {
    const { db } = fixture()
    const secret = '秘'.repeat(300)
    const bodies: Array<[string, string]> = [
      // Starts inside a segment: the excerpt opens it again.
      ['100', `前文[h]${'秘'.repeat(100)}needle${'秘'.repeat(10)}[/h]后文`],
      // Ends inside a segment: the excerpt closes it.
      ['101', `needle[h]${secret}[/h]`],
      // Ends inside an opening marker: the half marker is left out.
      ['102', `needle${'y'.repeat(233)}[h]秘密[/h]`],
      // Starts inside a closing marker: the half marker is left out.
      ['103', `[h]${'秘'.repeat(10)}[/h]${'z'.repeat(58)}needle`],
      // Never closed in the full text: stays as typed, as the reader shows it.
      ['104', `needle[h]${secret}`]
    ]
    for (const [id, body] of bodies) db.savePost(post(id, body), at)
    const excerpts = new Map(search(db, 'needle').map((hit) => [hit.postId, hit.excerpt]))
    expect(excerpts.get('100')).toBe(`[h]${'秘'.repeat(60)}needle${'秘'.repeat(10)}[/h]后文`)
    expect(excerpts.get('101')).toBe(`needle[h]${secret.slice(0, 231)}[/h]`)
    expect(excerpts.get('102')).toBe(`needle${'y'.repeat(233)}`)
    expect(excerpts.get('103')).toBe(`${'z'.repeat(58)}needle`)
    expect(excerpts.get('104')).toBe(`needle[h]${secret.slice(0, 231)}`)
  })

  it('pairs 防剧透 markers of an excerpt in their original case, as the reader does, for cached and subscription-only posts', () => {
    const { db } = fixture()
    // The reader hides `hidden-one[/H]hidden-two` (an uppercase marker is text) and shows `[H]visible[/H]`.
    const mixed = '[h]Hidden-One[/H]hidden-two[/h] Needle [H]visible[/H]'
    db.savePost(post('100', mixed), at)
    const evidence = observation(post('200', mixed, { userHash: 'po-id' }))
    db.saveSubscriptionObservation(evidence)
    db.savePost(post('300', 'evicted'), at)
    expect(search(db, 'needle').find((hit) => hit.postId === '100')?.excerpt).toBe(mixed)
    clear(db)
    // Only the subscription evidence holds post 200 now.
    expect(db.loadPost('200')).toBeNull()
    expect(search(db, 'needle').find((hit) => hit.postId === '200')?.excerpt).toBe(mixed)
  })

  it('leaves out a cut part of a 防剧透 segment that holds only blanks, instead of showing its markers', () => {
    const { db } = fixture()
    db.savePost(post('100', `[h]秘密${' '.repeat(300)}[/h]needle`), at)
    db.savePost(post('101', `needle[h]${' '.repeat(300)}秘密[/h]`), at)
    const excerpts = new Map(search(db, 'needle').map((hit) => [hit.postId, hit.excerpt]))
    expect(excerpts.get('100')).toBe('needle')
    expect(excerpts.get('101')).toBe('needle')
  })

  it('uses a fixed upper cursor and bounded batches without repeats, including empty short-query batches', () => {
    const { db } = fixture()
    for (let index = 1; index <= 150; index++) db.savePost(post(String(index), index < 70 ? '无' : '中'), at)
    const input = { query: '中', scope: { kind: 'local' as const }, filters, after: 0, upper: db.searchBoundary() }
    const first = db.searchBatch(input)
    expect(first.batch.hits).toEqual([])
    expect(first.batch.done).toBe(false)
    input.after = first.cursor
    db.savePost(post('999', '中'), at)
    const ids: string[] = []
    for (;;) {
      const result = db.searchBatch(input)
      expect(result.batch.hits.length).toBeLessThanOrEqual(64)
      ids.push(...result.batch.hits.map((hit) => hit.postId))
      input.after = result.cursor
      if (result.batch.done) break
    }
    expect(ids).toHaveLength(81)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain('999')
  })

  it('filters each matching post, preserves unknown evidence and follows PO scope without changing reading preference', () => {
    const { db } = fixture()
    const head = post('100', 'matching', { forumId: '1', userHash: 'po', title: 'head' })
    db.saveThreadPage(page(head, [post('101', 'matching', { forumId: '2', userHash: 'other', createdAt: null, imageKnown: undefined }),
      post('102', 'matching', { forumId: '2', userHash: 'po', image: { path: 'img', ext: '.png' } })]), at)
    expect(search(db, 'matching', { kind: 'thread', threadId: '100', mode: 'po' }).map((hit) => hit.postId)).toEqual(['100', '102'])
    const hits = search(db, 'matching', { kind: 'local' }, { forumId: '2', fromDate: '2026-10-24', toDate: '2026-10-24', image: 'with', postKind: 'any' })
    expect(hits.map((hit) => [hit.postId, hit.uncertainFilters])).toEqual([['101', true], ['102', false]])
    expect(db.getReadingState('100').mode).toBe('all')
    expect(db.searchMetadata(['100', '999'])).toEqual([{ threadId: '100', forumId: '1', createdAt: expect.anything(), hasImage: false },
      { threadId: '999', forumId: null, createdAt: null, hasImage: null }])
  })

  it('filters by 发言类型, keeping posts of an unknown thread marked, combined with board, date and image', () => {
    const { db } = fixture()
    db.saveThreadPage(page(post('100', 'kind', { forumId: '1', image: { path: 'a', ext: '.png' } }), [
      post('101', 'kind', { forumId: '1' }),
      post('102', 'kind', { forumId: '2', image: { path: 'b', ext: '.png' } })
    ]), at)
    db.saveThreadPage(page(post('200', 'kind', { forumId: '2', createdAt: '2026-10-25(日)12:00:00' }), []), at)
    db.savePost(post('300', 'kind', { forumId: '1' }), at)
    const ids = (applied: Partial<SearchFilters>) =>
      search(db, 'kind', { kind: 'local' }, { ...filters, ...applied }).map((hit) => [hit.postId, hit.threadId, hit.uncertainFilters])
    expect(ids({})).toEqual([['100', '100', false], ['101', '100', false], ['102', '100', false], ['200', '200', false], ['300', null, false]])
    expect(ids({ postKind: 'head' })).toEqual([['100', '100', false], ['200', '200', false], ['300', null, true]])
    expect(ids({ postKind: 'reply' })).toEqual([['101', '100', false], ['102', '100', false], ['300', null, true]])
    expect(ids({ postKind: 'head', forumId: '2' })).toEqual([['200', '200', false]])
    expect(ids({ postKind: 'head', image: 'with' })).toEqual([['100', '100', false]])
    expect(ids({ postKind: 'reply', image: 'with', fromDate: '2026-10-24', toDate: '2026-10-24' })).toEqual([['102', '100', false]])
  })

  it('updates transactionally, refuses stale observations, and removes cache-only hits but preserves offline and journal ownership', () => {
    const { db, path } = fixture()
    db.saveThreadPage(page(post('100', 'cache-only'), []), at)
    db.beginOfflineCopy('200', false, at)
    db.saveOfflinePage(page(post('200', 'offline-needle'), []), at)
    db.saveSubscriptionObservation(observation(post('300', 'journal-needle')))
    const operation: SubscriptionOperation = { id: 'op', source: 'app', threadId: '400', action: 'add',
      context: { generation: 0, appCredentialId: null, webCredentialId: null }, createdAt: at, objectLabel: 'not-searched-label',
      state: 'settled', report: 'success', reportError: null, before: observation(post('400', 'operation-needle')), after: null, verification: 'present' }
    db.saveSubscriptionOperation(operation)
    db.savePost(post('500', 'new-needle'), later)
    db.savePost(post('500', 'stale-needle'), at)
    expect(search(db, 'stale-needle')).toEqual([])
    const raw = new Database(path)
    try {
      raw.exec("CREATE TRIGGER fail_projection BEFORE UPDATE ON search_sources BEGIN SELECT RAISE(ABORT,'injected'); END")
      expect(() => db.savePost(post('500', 'failed-needle'), later)).toThrow()
      expect(db.loadPost('500')?.value.plainText).toBe('new-needle')
      expect(search(db, 'failed-needle')).toEqual([])
      raw.exec('DROP TRIGGER fail_projection')
    } finally { raw.close() }
    clear(db)
    expect(search(db, 'cache-only')).toEqual([])
    expect(search(db, 'offline-needle')[0]?.retention).toBe('offline')
    expect(search(db, 'journal-needle')[0]?.retention).toBe('subscription')
    expect(search(db, 'operation-needle')[0]).toMatchObject({ retention: 'subscription', threadId: '400' })
    expect(search(db, 'not-searched-label')).toEqual([])
    expect(db.loadPost('300')).toBeNull()
    expect(db.getContentUsage()).toMatchObject({ cacheTextBytes: 0 })
    expect(db.getContentUsage().protectedTextBytes).toBeGreaterThan(0)
    rebuild(db)
    expect(search(db, 'journal-needle')[0]?.retention).toBe('subscription')
    expect(search(db, 'operation-needle')[0]?.retention).toBe('subscription')
    expect(db.loadPost('300')).toBeNull()
  })

  it.each([false, true])('keeps deleted offline union hits as ordinary cache across rebuild and reopen, with prior cache eviction: %s', (evicted) => {
    const { db, path } = fixture()
    db.beginOfflineCopy('100', false, at)
    const head = post('100', 'head needle')
    db.saveOfflinePage(page(head, [post('101', 'old needle'), post('102', 'current needle')]), at)
    db.saveOfflinePage(page(head, [post('102', 'current needle'), post('103', 'new needle')]), later)
    if (evicted) clear(db)
    expect(search(db, 'old needle')[0]).toMatchObject({ postId: '101', retention: 'offline' })
    db.deleteOfflineCopy('100')
    const hits = search(db, 'needle')
    expect(hits.map((hit) => hit.postId)).toEqual(['100', '101', '102', '103'])
    expect(hits.every((hit) => hit.retention === 'cache' && hit.location?.source === 'page')).toBe(true)
    expect(db.getThreadCoverage('100', 'all')).toMatchObject({ endCandidatePage: null,
      pages: [{ page: 1, replyIds: ['101', '102', '103'], skippedItems: 1, endCandidate: false }] })
    expect(db.getContentUsage().protectedTextBytes).toBe(0)
    expect(db.getContentUsage().cacheTextBytes).toBeGreaterThan(0)
    db.close()
    const reopened = openReadingDatabase(path)
    try {
      reopened.recoverContent()
      rebuild(reopened)
      expect(reopened.getOfflineCopy('100')).toBeNull()
      expect(search(reopened, 'needle').map((hit) => [hit.postId, hit.retention, hit.location?.source])).toEqual([
        ['100', 'cache', 'page'], ['101', 'cache', 'page'], ['102', 'cache', 'page'], ['103', 'cache', 'page']])
      reopened.setCacheLimit(0)
      expect(reopened.evictContentBatch(false).more).toBe(false)
      expect(search(reopened, 'needle')).toEqual([])
      rebuild(reopened)
      expect(search(reopened, 'needle')).toEqual([])
      expect(reopened.getThreadCoverage('100', 'all').pages).toEqual([])
    } finally { reopened.close() }
  })

  it('keeps reader-protected deleted-copy hits as cache while independent offline and subscription sources remain protected', () => {
    const { db } = fixture()
    for (const id of ['100', '200']) {
      db.beginOfflineCopy(id, false, at)
      db.saveOfflinePage(page(post(id, `${id} needle`), []), at)
    }
    db.saveSubscriptionObservation(observation(post('300', 'journal needle')))
    db.holdContentReader('window:search', '100')
    db.deleteOfflineCopy('100')
    db.setCacheLimit(0)
    expect(db.evictContentBatch(false).more).toBe(false)
    expect(search(db, 'needle').map((hit) => [hit.postId, hit.retention])).toEqual([
      ['100', 'cache'], ['200', 'offline'], ['300', 'subscription']])
    expect(db.getContentUsage().cacheTextBytes).toBe(0)
    expect(db.getContentUsage().protectedTextBytes).toBeGreaterThan(0)
    db.releaseContentReaders('window:')
    db.evictContentBatch(false)
    expect(search(db, 'needle').map((hit) => [hit.postId, hit.retention])).toEqual([
      ['200', 'offline'], ['300', 'subscription']])
    expect(db.getOfflineCopy('200')).not.toBeNull()
    rebuild(db)
    expect(search(db, 'needle').map((hit) => [hit.postId, hit.retention])).toEqual([
      ['200', 'offline'], ['300', 'subscription']])
  })

  it('keeps offline search ownership on failed deletion and changes it only after the transaction commits', () => {
    const { db, path } = fixture()
    db.beginOfflineCopy('100', false, at)
    db.saveOfflinePage(page(post('100', 'rollback needle'), []), at)
    clear(db)
    const before = search(db, 'needle')
    const raw = new Database(path)
    try {
      raw.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON offline_copies BEGIN SELECT RAISE(ABORT, 'injected'); END")
      expect(() => db.deleteOfflineCopy('100')).toThrow()
      expect(search(db, 'needle')).toEqual(before)
      expect(before[0]).toMatchObject({ retention: 'offline', location: { source: 'offline' } })
      raw.exec('DROP TRIGGER fail_delete')
      db.deleteOfflineCopy('100')
      expect(search(db, 'needle')[0]).toMatchObject({ postId: '100', retention: 'cache', location: { source: 'page' } })
    } finally { raw.close() }
  })

  it('replaces an observation projection while retaining its separately saved valid evidence', () => {
    const { db } = fixture()
    db.saveSubscriptionObservation(observation(post('100', 'old-retained')))
    db.saveSubscriptionObservation({ ...observation(post('200', 'new-retained')), error: { page: 2, detail: { kind: 'network', detail: 'connection' } } })
    clear(db)
    expect(search(db, 'old-retained')[0]?.postId).toBe('100')
    expect(search(db, 'new-retained')[0]?.postId).toBe('200')
    db.saveSubscriptionObservation(observation(post('300', 'replacement')))
    clear(db)
    expect(search(db, 'old-retained')).toEqual([])
    expect(search(db, 'new-retained')).toEqual([])
    expect(search(db, 'replacement')[0]?.postId).toBe('300')
  })

  it('reports an unavailable index instead of empty results and rebuilds retained legacy text in bounded batches', () => {
    const folder = mkdtempSync(join(tmpdir(), 'xidao-search-v7-'))
    const path = join(folder, 'app.sqlite')
    const old = new Database(path)
    for (const migration of MIGRATIONS.filter((item) => item.version <= 7)) migration.up(old)
    for (let index = 1; index <= 70; index++) old.prepare('INSERT INTO posts(id,title,content_json,plain_text,fetched_at) VALUES(?,?,?,?,?)')
      .run(String(index), null, '[]', 'legacy-needle', at)
    old.pragma('user_version=7'); old.close()
    const db = openReadingDatabase(path)
    resources.push({ folder, db })
    expect(() => db.searchBoundary()).toThrow()
    db.beginSearchRebuild()
    expect(db.rebuildSearchBatch()).toBe(false)
    expect(() => db.searchBoundary()).toThrow()
    for (let batch = 0; batch < 100; batch++) if (db.rebuildSearchBatch()) break
    expect(search(db, 'legacy-needle')).toHaveLength(70)
    expect(db.searchMetadata(['1'])[0]?.hasImage).toBeNull()
    const raw = new Database(path)
    raw.exec('DROP TABLE search_fts'); raw.close()
    expect(() => db.searchBoundary()).toThrow()
    rebuild(db)
    expect(search(db, 'legacy-needle')).toHaveLength(70)
  })
})

describe('shared evidence-aware content filters', () => {
  it('compares real server calendar dates without inventing a timezone or treating unknown fields as negatives', () => {
    expect(matchContentFilters({ forumId: null, createdAt: '2026-02-30', hasImage: null },
      { forumId: '4', fromDate: '2026-01-01', toDate: '2026-12-31', image: 'without' })).toEqual({ matches: true, uncertain: true })
    expect(matchContentFilters({ forumId: '5', createdAt: null, hasImage: null }, { ...filters, forumId: '4' })).toEqual({ matches: false, uncertain: false })
    expect(matchContentFilters({ forumId: null, createdAt: '2026-10-24(六)23:59:00', hasImage: false },
      { ...filters, fromDate: '2026-10-24', toDate: '2026-10-24', image: 'without' })).toEqual({ matches: true, uncertain: false })
  })
})
