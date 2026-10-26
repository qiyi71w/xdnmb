import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { createSearchService, type SearchService } from '../src/main/search/service'
import { createForumClient } from '../src/main/forum/client'
import { createForumTransport } from '../src/main/forum/transport'
import { createRequestScheduler } from '../src/main/reading/scheduler'
import { asStore } from './helpers/store'
import type { AppStore } from '../src/main/storage/contract'
import type { SearchApi, SearchFetch } from '../src/shared/search'
import type { Post } from '../src/shared/forum'

const at = '2026-10-24T00:00:00.000Z'
const filters = { forumId: null, fromDate: null, toDate: null, image: 'any' as const }
const resources: Array<{ folder: string; db: ReadingDatabase; service: SearchService; server: Server }> = []
function post(id: string, body = 'searchable'): Post {
  return { id, title: null, forumId: null, createdAt: null, userHash: null, name: null, isAdmin: null, isSage: null,
    image: null, content: [{ type: 'text', text: body }], plainText: body }
}
async function setup(response: (page: number, request: IncomingMessage, reply: ServerResponse) => void = (_page, _request, reply) => {
  reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify({ id: '100', content: 'head', Replies: [] }))
}, override: (store: AppStore) => AppStore = (store) => store) {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-search-service-'))
  const path = join(folder, 'app.sqlite')
  const db = openReadingDatabase(path)
  const requests: number[] = []
  const server = createServer((request, reply) => {
    const page = Number(new URL(request.url!, 'http://localhost').searchParams.get('page'))
    requests.push(page)
    response(page, request, reply)
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing controlled listener')
  const origin = `http://127.0.0.1:${address.port}`
  const client = createForumClient({ baseUrl: origin, transport: createForumTransport({ allowedOrigins: [origin] }) })
  const store = override(asStore(db))
  const service = createSearchService({ store, client, scheduler: createRequestScheduler(), enforceQuota: async () => {
    for (let batch = 0; batch < 1000; batch++) if (!db.evictContentBatch(false).more) return
    throw new Error('quota did not settle')
  } })
  resources.push({ folder, db, service, server })
  await service.recover()
  return { folder, path, db, service, api: service.forOwner('one'), requests }
}
async function settled(api: SearchApi, operationId = 'fetch'): Promise<SearchFetch> {
  for (let count = 0; count < 1000; count++) {
    const result = await api.fetchStatus({ operationId })
    if (result.ok && result.value.state !== 'running') return result.value
    await yieldToLoop()
  }
  throw new Error('fetch did not settle')
}
afterEach(async () => {
  for (const { folder, db, service, server } of resources.splice(0)) {
    await service.stop()
    server.closeAllConnections()
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    await closed.promise
    db.close(); rmSync(folder, { force: true, recursive: true })
  }
})

describe('owned search service over real SQLite and controlled HTTP', () => {
  it('does not supersede an active startup rebuild when the first window resumes', async () => {
    let hold = false
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const { api, service, db, path } = await setup(undefined, (store) => ({ ...store,
      async beginSearchRebuild() {
        await store.beginSearchRebuild()
        if (hold) { reached.resolve(); await release.promise }
      }
    }))
    db.savePost(post('101', 'kept during recovery'), at)
    const raw = new Database(path)
    raw.exec('DROP TABLE search_fts')
    raw.close()
    await service.stop()
    service.resume()
    hold = true
    const initial = service.recover()
    await reached.promise
    service.resume()
    const fromWindow = service.recover()
    expect(fromWindow).toBe(initial)
    release.resolve()
    await Promise.all([initial, fromWindow])
    expect(await api.start({ operationId: 'after-recovery', query: 'recovery', scope: { kind: 'local' }, filters })).toMatchObject({ ok: true, value: { hits: [{ postId: '101' }] } })
  })

  it('stops all search work for exit and permits only fresh sessions after a window reopens', async () => {
    const reached = Promise.withResolvers<void>()
    const { api, service, db, requests } = await setup((page, _request, reply) => {
      if (page === 2) { reached.resolve(); return }
      reply.setHeader('Content-Type', 'application/json')
      reply.end(JSON.stringify({ id: '100', content: 'head', Replies: [{ id: '101', content: 'retained searchable' }] }))
    })
    await api.fetchThread({ operationId: 'fetch', threadId: '100' })
    await reached.promise
    await service.stop()
    expect(requests).toEqual([1, 2])
    expect(db.loadPost('101')?.value.plainText).toBe('retained searchable')
    expect(await api.start({ operationId: 'closed', query: 'searchable', scope: { kind: 'local' }, filters })).toEqual({ ok: false, reason: 'busy' })
    service.resume()
    await service.recover()
    expect(await api.fetchStatus({ operationId: 'fetch' })).toEqual({ ok: false, reason: 'expired' })
    expect(await api.start({ operationId: 'fresh', query: 'searchable', scope: { kind: 'local' }, filters })).toMatchObject({ ok: true, value: { hits: [{ postId: '101' }] } })
    expect(requests).toEqual([1, 2])
  })

  it('keeps scope/filter fixed, rejects concurrent cursor advancement and suppresses cancelled late batches across owners', async () => {
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let delayed = false
    const { api, service, db, requests } = await setup(undefined, (store) => ({ ...store, async searchBatch(input) {
      if (delayed) { reached.resolve(); await release.promise }
      return store.searchBatch(input)
    } }))
    for (let id = 1; id <= 150; id++) db.savePost(post(String(id), '中'), at)
    expect(await api.start({ operationId: 'query', query: '中', scope: { kind: 'local' }, filters })).toMatchObject({ ok: true, value: { done: false } })
    delayed = true
    const advancing = api.next({ operationId: 'query' })
    await reached.promise
    expect(await api.next({ operationId: 'query' })).toEqual({ ok: false, reason: 'busy' })
    await service.forOwner('two').cancel({ operationId: 'query' })
    expect(await service.forOwner('two').next({ operationId: 'query' })).toEqual({ ok: false, reason: 'expired' })
    await api.cancel({ operationId: 'query' })
    release.resolve()
    expect(await advancing).toEqual({ ok: false, reason: 'cancelled' })
    expect(requests).toEqual([])
  })

  it('does not let superseded queries leak old results or renderer ownership survive release', async () => {
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let delay = true
    const { api, service, db } = await setup(undefined, (store) => ({ ...store, async searchBatch(input) {
      if (delay) { delay = false; reached.resolve(); await release.promise }
      return store.searchBatch(input)
    } }))
    db.savePost(post('100', 'old matching'), at)
    db.savePost(post('200', 'new matching'), at)
    const old = api.start({ operationId: 'same', query: 'old', scope: { kind: 'local' }, filters })
    await reached.promise
    expect(await api.start({ operationId: 'same', query: 'new', scope: { kind: 'local' }, filters })).toMatchObject({ ok: true, value: { hits: [{ postId: '200' }] } })
    release.resolve()
    expect(await old).toEqual({ ok: false, reason: 'cancelled' })
    service.releaseOwner('one')
    expect(await api.next({ operationId: 'same' })).toEqual({ ok: false, reason: 'expired' })
  })

  it('fetches sequential background pages only after explicit action and stops at a valid empty candidate', async () => {
    const { api, db, requests } = await setup((page, _request, reply) => {
      reply.setHeader('Content-Type', 'application/json')
      reply.end(JSON.stringify({ id: '100', content: 'head searchable', ReplyCount: 2,
        Replies: page <= 2 ? [{ id: String(100 + page), content: 'searchable fetched' }] : [] }))
    })
    await api.start({ operationId: 'local', query: 'searchable', scope: { kind: 'local' }, filters })
    expect(requests).toEqual([])
    expect(await api.fetchThread({ operationId: 'fetch', threadId: '100' })).toMatchObject({ ok: true, value: { state: 'running' } })
    const final = await settled(api)
    expect(requests).toEqual([1, 2, 3])
    expect(final).toMatchObject({ state: 'stopped', pages: [1, 2, 3], failedPage: null,
      coverage: { endCandidatePage: 3, gaps: [], obtainedReplyCount: 2 } })
    expect(db.getOfflineCopy('100')).toBeNull()
    expect(db.listHistory()).toEqual([])
    expect(await api.start({ operationId: 'after', query: 'searchable', scope: { kind: 'thread', threadId: '100', mode: 'all' }, filters }))
      .toMatchObject({ ok: true, value: { hits: [{ postId: '100' }, { postId: '101' }, { postId: '102' }] } })
  })

  it('cancels in-flight reads and preserves fetched coverage/content without accepting late response content', async () => {
    const reached = Promise.withResolvers<void>()
    const { api, db, requests } = await setup((page, _request, reply) => {
      if (page === 2) { reached.resolve(); return }
      reply.setHeader('Content-Type', 'application/json')
      reply.end(JSON.stringify({ id: '100', content: 'head', Replies: [{ id: '101', content: 'kept searchable' }] }))
    })
    await api.fetchThread({ operationId: 'fetch', threadId: '100' })
    await reached.promise
    await api.cancel({ operationId: 'fetch' })
    expect(await settled(api)).toMatchObject({ state: 'cancelled', pages: [1], coverage: { endCandidatePage: null, obtainedReplyCount: 1 } })
    expect(requests).toEqual([1, 2])
    expect(db.loadPost('101')?.value.plainText).toBe('kept searchable')
  })

  it('stops a repeated lower page without saving it or reporting an end candidate', async () => {
    const { api, requests, db } = await setup((_page, _request, reply) => {
      reply.setHeader('Content-Type', 'application/json')
      reply.end(JSON.stringify({ id: '100', content: 'head', ReplyCount: 2194, Replies: [{ id: '101', content: 'same lower page' }] }))
    })
    await api.fetchThread({ operationId: 'fetch', threadId: '100' })
    expect(await settled(api)).toMatchObject({ state: 'failed', pages: [1], failedPage: 2,
      error: { kind: 'page-cap', highestReadablePage: 1 }, coverage: { endCandidatePage: null, obtainedReplyCount: 1 } })
    expect(requests).toEqual([1, 2])
    expect(db.loadThreadPage('100', 'all', 2)).toBeNull()
  })

  it('stops without retries on rate limits and retains partial pages with the failed page', async () => {
    const { api, requests } = await setup((page, _request, reply) => {
      if (page === 2) { reply.writeHead(429); reply.end(); return }
      reply.setHeader('Content-Type', 'application/json')
      reply.end(JSON.stringify({ id: '100', content: 'head', Replies: [{ id: '101', content: 'partial' }] }))
    })
    await api.fetchThread({ operationId: 'fetch', threadId: '100' })
    expect(await settled(api)).toMatchObject({ state: 'failed', pages: [1], failedPage: 2, error: { kind: 'rate-limited' } })
    expect(requests).toEqual([1, 2])
  })

  it('enforces ordinary quota without deleting active readers and reports fetched rather than retained coverage honestly', async () => {
    const { api, db } = await setup((page, _request, reply) => {
      reply.setHeader('Content-Type', 'application/json')
      reply.end(JSON.stringify({ id: '100', content: 'head', Replies: page === 1 ? [{ id: '101', content: 'fetched content' }] : [] }))
    })
    db.saveThreadPage({ threadId: '900', mode: 'all', page: 1, head: post('900', 'active reader'), replies: [],
      replyCount: 0, skippedItems: 0, endCandidate: true }, at)
    db.holdContentReader('visible', '900')
    db.setCacheLimit(0)
    await api.fetchThread({ operationId: 'fetch', threadId: '100' })
    expect(await settled(api)).toMatchObject({ state: 'stopped', pages: [1, 2], coverage: { obtainedReplyCount: 1, endCandidatePage: 2 } })
    expect(db.loadPost('101')).toBeNull()
    const result = await api.start({ operationId: 'after', query: 'fetched content', scope: { kind: 'local' }, filters })
    expect(result).toMatchObject({ ok: true, value: { hits: [], coverage: { retainedPosts: 1 } } })
    expect(db.loadPost('900')?.value.plainText).toBe('active reader')
  })

  it('returns explicit index-unavailable, supports cancellable rebuild, and completes a fresh rebuild without reading side effects', async () => {
    const { api, db, path } = await setup()
    for (let id = 1; id <= 100; id++) db.savePost(post(String(id)), at)
    const raw = new Database(path)
    raw.exec('DROP TABLE search_fts'); raw.close()
    expect(await api.start({ operationId: 'broken', query: 'searchable', scope: { kind: 'local' }, filters })).toEqual({ ok: false, reason: 'index-unavailable' })
    const rebuilding = api.rebuild({ operationId: 'rebuild' })
    await api.cancel({ operationId: 'rebuild' })
    expect(await rebuilding).toEqual({ ok: false, reason: 'cancelled' })
    expect(await api.start({ operationId: 'partial', query: 'searchable', scope: { kind: 'local' }, filters })).toEqual({ ok: false, reason: 'index-unavailable' })
    expect(await api.rebuild({ operationId: 'complete' })).toEqual({ ok: true, value: { rebuilt: true } })
    expect(await api.start({ operationId: 'working', query: 'searchable', scope: { kind: 'local' }, filters })).toMatchObject({ ok: true })
  })
})
