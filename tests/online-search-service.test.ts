import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createForumTransport } from '../src/main/forum/transport'
import { createOnlineSearchService, SEARCH_TOKEN_IDLE_MS } from '../src/main/online-search/service'
import { parseForumLink, type SearchOutcome } from '../src/shared/online-search'

// Synthetic responses shaped like the one recorded public query (status, web items with
// title/description/url, null date, opaque npt). No real service output is stored here.
const item = (n: number, url = `https://www.nmbxd1.com/t/5000000${n}?r=6000000${n}&page=2`) => ({
  title: `结果 ${n}`, description: `摘要 ${n}`, url, date: null, thumb: { url: null, ratio: null }, sublink: []
})
const ok = (items: unknown[], npt: string | null) => JSON.stringify({ status: 'ok', spelling: { type: 'no_correction' }, npt, answer: [], web: items, image: [] })

interface Seen { path: string; params: Record<string, string>; headers: IncomingMessage['headers'] }

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => {
    const { promise, resolve } = Promise.withResolvers<void>()
    server.close(() => resolve())
    server.closeAllConnections()
    return promise
  }))
})

/** Local stand-in for the search service. `respond` answers each request (or never, to stay in flight). */
async function service(respond: (seen: Seen, response: ServerResponse) => void, options: { timeoutMs?: number } = {}) {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local')
    const entry = { path: url.pathname, params: Object.fromEntries(url.searchParams), headers: request.headers }
    seen.push(entry)
    respond(entry, response)
  })
  servers.push(server)
  const { promise, resolve } = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => resolve())
  await promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener')
  const origin = `http://127.0.0.1:${address.port}`
  let clock = 1_800_000_000_000
  const search = createOnlineSearchService({
    transport: createForumTransport({ allowedOrigins: [origin], timeoutMs: options.timeoutMs }),
    origin,
    xdsTransport: createForumTransport({ allowedOrigins: [origin], timeoutMs: options.timeoutMs, userAgent: 'Xidao/1.0.0' }),
    xdsOrigin: origin,
    now: () => clock
  })
  return { search, seen, origin, advance: (ms: number) => { clock += ms } }
}

const json = (body: string, status = 200) => (_seen: Seen, response: ServerResponse) => {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(body)
}

/** Answers by token: first query → page 1 with `t1`; `t1` → page 2 with `t2`; `t2` → page 3 without a token. */
const chain = (seen: Seen, response: ServerResponse) => {
  const next: Record<string, [number, string | null]> = { t1: [2, 't2'], t2: [3, null] }
  const [n, npt] = seen.params.npt === undefined ? [1, 't1'] : next[seen.params.npt] ?? [0, null]
  json(ok([item(n)], npt))(seen, response)
}

const status = (outcome: SearchOutcome) => ({ status: outcome.status, next: 'next' in outcome ? outcome.next : undefined })

describe('online search session', () => {
  it('queries the fixed API path once per user action, then pages with only the opaque token and serves obtained pages without requests', async () => {
    const { search, seen } = await service(chain)
    const first = await search.run('w1', 's1', 'nmb-search', '游戏 a&b')
    expect(first).toMatchObject({ status: 'ok', cached: false, next: 'available', page: { pageNumber: 1 } })
    expect(seen[0]).toMatchObject({ path: '/api/v1/web', params: { s: '游戏 a&b' } })
    // No forum identity or credentials travel with search requests.
    expect(seen[0]?.headers.cookie).toBeUndefined()
    expect(seen[0]?.headers.authorization).toBeUndefined()

    expect(await search.page('w1', 's1', 'nmb-search', 2)).toMatchObject({ status: 'ok', cached: false, next: 'available', page: { pageNumber: 2 } })
    expect(seen[1]?.params).toEqual({ npt: 't1' })
    expect(await search.page('w1', 's1', 'nmb-search', 3)).toMatchObject({ status: 'ok', next: 'end', page: { pageNumber: 3 } })

    // Going back and forth over obtained pages is local; past the last page there is nothing to ask for.
    expect(await search.page('w1', 's1', 'nmb-search', 1)).toMatchObject({ status: 'ok', cached: true, next: 'end', page: { pageNumber: 1 } })
    expect(await search.page('w1', 's1', 'nmb-search', 4)).toEqual({ status: 'unavailable', next: 'end' })
    expect(seen).toHaveLength(3)
  })

  it('spends a token once: repeated next-page calls share one request', async () => {
    const pending: ServerResponse[] = []
    const { search, seen } = await service((entry, response) => {
      if (entry.params.npt === undefined) chain(entry, response)
      else pending.push(response)
    })
    await search.run('w1', 's1', 'nmb-search', 'q')
    const a = search.page('w1', 's1', 'nmb-search', 2)
    const b = search.page('w1', 's1', 'nmb-search', 2)
    await expect.poll(() => pending.length).toBe(1)
    pending[0]?.writeHead(200, { 'Content-Type': 'application/json' }).end(ok([item(2)], null))
    expect(status(await a)).toEqual({ status: 'ok', next: 'end' })
    expect(await b).toEqual(await a)
    expect(seen.filter((entry) => entry.params.npt === 't1')).toHaveLength(1)
  })

  it('does not send a token idle for 15 minutes, keeping the obtained pages', async () => {
    const { search, seen, advance } = await service(chain)
    await search.run('w1', 's1', 'nmb-search', 'q')
    advance(SEARCH_TOKEN_IDLE_MS - 1)
    expect(await search.page('w1', 's1', 'nmb-search', 1)).toMatchObject({ status: 'ok', cached: true, next: 'available' })
    advance(1)
    expect(await search.page('w1', 's1', 'nmb-search', 2)).toEqual({ status: 'unavailable', next: 'expired' })
    expect(await search.page('w1', 's1', 'nmb-search', 1)).toMatchObject({ status: 'ok', cached: true, next: 'expired' })
    expect(seen).toHaveLength(1)
  })

  it('never replays a token whose response was lost or cancelled; earlier pages stay', async () => {
    let fail = true
    const { search, seen } = await service((entry, response) => {
      if (entry.params.npt !== undefined && fail) response.destroy()
      else chain(entry, response)
    })
    await search.run('w1', 's1', 'nmb-search', 'q')
    expect(await search.page('w1', 's1', 'nmb-search', 2)).toEqual({ status: 'failed', error: { kind: 'network', detail: 'connection' }, next: 'lost' })
    fail = false
    expect(await search.page('w1', 's1', 'nmb-search', 2)).toEqual({ status: 'unavailable', next: 'lost' })
    expect(await search.page('w1', 's1', 'nmb-search', 1)).toMatchObject({ status: 'ok', cached: true, next: 'lost' })
    expect(seen.filter((entry) => entry.params.npt === 't1')).toHaveLength(1)

    // Cancelling an in-flight next page spends its token too.
    const held: ServerResponse[] = []
    const second = await service((entry, response) => (entry.params.npt === undefined ? chain(entry, response) : held.push(response)))
    await second.search.run('w2', 's1', 'nmb-search', 'q')
    const pending = second.search.page('w2', 's1', 'nmb-search', 2)
    await expect.poll(() => held.length).toBe(1)
    second.search.cancel('w2', 's1', 'nmb-search')
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(await second.search.page('w2', 's1', 'nmb-search', 2)).toEqual({ status: 'unavailable', next: 'lost' })
    expect(second.seen).toHaveLength(2)
  })

  it('lets a new query supersede the in-flight one: the late answer never replaces the new results', async () => {
    const held: ServerResponse[] = []
    const { search } = await service((entry, response) => {
      if (entry.params.s === 'old') held.push(response)
      else json(ok([item(9)], null))(entry, response)
    })
    const old = search.run('w1', 's1', 'nmb-search', 'old')
    await expect.poll(() => held.length).toBe(1)
    const fresh = await search.run('w1', 's1', 'nmb-search', 'new')
    held[0]?.writeHead(200, { 'Content-Type': 'application/json' }).end(ok([item(1)], 'stale'))
    expect(await old).toEqual({ status: 'cancelled' })
    expect(fresh).toMatchObject({ status: 'ok', next: 'end', page: { hits: [{ title: '结果 9' }] } })
    expect(await search.page('w1', 's1', 'nmb-search', 1)).toMatchObject({ cached: true, page: { hits: [{ title: '结果 9' }] } })
    expect(await search.page('w1', 's1', 'nmb-search', 2)).toEqual({ status: 'unavailable', next: 'end' })
  })

  it('scopes sessions to their page and releases them on close', async () => {
    const { search, seen } = await service(chain)
    await search.run('w1', 's1', 'nmb-search', 'q')
    expect(await search.page('w2', 's1', 'nmb-search', 1)).toEqual({ status: 'closed' })
    search.closeAll('w1')
    expect(await search.page('w1', 's1', 'nmb-search', 1)).toEqual({ status: 'closed' })
    expect(seen).toHaveLength(1)
  })
})

describe('search response classification', () => {
  it.each([
    ['service error with HTTP 200', json(JSON.stringify({ status: 'Upstream returned an error' })), { kind: 'service', serviceMessage: 'Upstream returned an error', hint: null }],
    ['service message naming a captcha', json(JSON.stringify({ status: 'Please solve the captcha' })), { kind: 'service', serviceMessage: 'Please solve the captcha', hint: 'verification' }],
    ['service message naming a rate limit', json(JSON.stringify({ status: 'Rate limited by upstream' })), { kind: 'service', serviceMessage: 'Rate limited by upstream', hint: 'rate-limited' }],
    ['HTTP 429 alone', json(JSON.stringify({ status: 'x' }), 429), { kind: 'rate-limited', retryAt: null }],
    ['HTTP 502', json('', 502), { kind: 'http-status', httpStatus: 502 }],
    ['HTML page', (_seen: Seen, response: ServerResponse) => response.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>hi</html>'), { kind: 'unknown-structure', detail: 'html' }],
    ['non-JSON body', json('{bad'), { kind: 'unknown-structure', detail: 'json' }],
    ['ok without a web array', json(JSON.stringify({ status: 'ok', npt: null })), { kind: 'unknown-structure', detail: 'shape' }],
    ['non-string token', json(JSON.stringify({ status: 'ok', npt: 5, web: [] })), { kind: 'unknown-structure', detail: 'shape' }],
    ['web array of only unusable entries', json(JSON.stringify({ status: 'ok', npt: null, web: [42, { title: 42, description: [], url: {} }] })), { kind: 'unknown-structure', detail: 'shape' }]
  ])('classifies a %s', async (_name, respond, error) => {
    const { search } = await service(respond)
    // A status alone supplies no retry deadline and no guessed interval.
    expect(await search.run('w1', 's1', 'nmb-search', 'q')).toEqual({ status: 'failed', error, next: 'end' })
  })

  it('treats an empty web array as a normal empty result, distinct from failures', async () => {
    const { search } = await service(json(ok([], null)))
    expect(await search.run('w1', 's1', 'nmb-search', 'q')).toMatchObject({ status: 'ok', next: 'end', page: { pageNumber: 1, hits: [] } })
  })

  it('times out at the client limit and does not follow a redirect to another origin', async () => {
    const slow = await service(() => undefined, { timeoutMs: 50 })
    expect(await slow.search.run('w1', 's1', 'nmb-search', 'q')).toMatchObject({ status: 'failed', error: { kind: 'network', detail: 'timeout' } })

    const elsewhere = await service(chain)
    const redirecting = await service((_seen, response) => response.writeHead(302, { Location: `${elsewhere.origin}/api/v1/web?s=q` }).end())
    expect(await redirecting.search.run('w1', 's1', 'nmb-search', 'q')).toMatchObject({ status: 'failed', error: { kind: 'unknown-structure', detail: 'redirect' } })
    expect(elsewhere.seen).toHaveLength(0)
  })

  it('keeps hostile text inert and only safe links openable', async () => {
    const { search } = await service(json(ok([
      { title: '<img src=x onerror=alert(1)>\u202Egnp.exe', description: 'a\u0000b\n\tc', url: 'javascript:alert(1)', date: 1_700_000_000 },
      { title: null, description: null, url: 'https://user:pw@www.nmbxd1.com/t/1', date: 'yesterday' },
      { title: 'evil host', description: null, url: 'https://www.nmbxd1.com.evil.example/t/50000001', date: -5 },
      'not an object'
    ], null)))
    const outcome = await search.run('w1', 's1', 'nmb-search', 'q')
    if (outcome.status !== 'ok') throw new Error(outcome.status)
    expect(outcome.page.hits).toEqual([
      { title: '<img src=x onerror=alert(1)> gnp.exe', description: 'a b c', url: null, date: '2023-11-14T22:13:20.000Z', target: null },
      { title: 'evil host', description: null, url: 'https://www.nmbxd1.com.evil.example/t/50000001', date: null, target: null }
    ])
  })
})

describe('forum link recognition', () => {
  it.each([
    ['https://www.nmbxd1.com/t/50000001?r=60000001&page=3', { kind: 'thread', threadId: '50000001', replyId: '60000001', page: 3, poHint: false }],
    ['https://www.nmbxd1.com/t/50000001?page=2', { kind: 'thread', threadId: '50000001', replyId: null, page: 2, poHint: false }],
    ['http://nmbxd.com/t/50000001/', { kind: 'thread', threadId: '50000001', replyId: null, page: null, poHint: false }],
    ['https://www.nmbxd1.com/t/50000001?r=50000001', { kind: 'thread', threadId: '50000001', replyId: '50000001', page: null, poHint: false }],
    ['https://www.nmbxd1.com/Forum/po/id/50000001.html', { kind: 'thread', threadId: '50000001', replyId: null, page: null, poHint: true }],
    ['https://www.nmbxd1.com/f/%E7%BB%BC%E5%90%88%E7%89%881', { kind: 'board', boardName: '综合版1' }],
    ['https://www.nmbxd.com/m/f/%E6%B8%B8%E6%88%8F', { kind: 'board', boardName: '游戏' }],
    ['https://www.nmbxd1.com/Home/Forum/timeline/id/1.html', { kind: 'timeline', timelineId: '1' }],
    ['https://nmbxd.com/Forum/timeline/id/2.html', { kind: 'timeline', timelineId: '2' }],
    ['https://www.nmbxd1.com/home/forum/TIMELINE/ID/3.HTML', { kind: 'timeline', timelineId: '3' }]
  ])('recognizes %s', (url, target) => {
    expect(parseForumLink(url)).toEqual(target)
  })

  it.each([
    'https://www.nmbxd1.com.evil.example/t/1',
    'https://evil.example/t/1?host=www.nmbxd1.com',
    'https://www.nmbxd1.com:8443/t/1',
    'https://u:p@www.nmbxd1.com/t/1',
    'ftp://www.nmbxd1.com/t/1',
    'https://www.nmbxd1.com/t/0123',
    'https://www.nmbxd1.com/t/abc',
    'https://www.nmbxd1.com/Home/Forum/ref?id=1',
    'https://www.nmbxd1.com/f/',
    'https://www.nmbxd1.com/f/%E0%A4%A',
    'https://www.nmbxd1.com/Home/Forum/timeline/id/abc.html',
    'https://www.nmbxd1.com/Home/Forum/timeline/id/0.html',
    'https://www.nmbxd1.com/Home/Forum/timeline/id/1.html/extra',
    'https://www.nmbxd1.com/Home/Forum/timeline/id/1/2.html',
    'https://www.nmbxd1.com/x/Forum/timeline/id/1.html',
    'https://www.nmbxd1.com:8080/Home/Forum/timeline/id/1.html'
  ])('does not recognize %s', (url) => {
    expect(parseForumLink(url)).toBeNull()
  })

  it('ignores a malformed reply or page clue instead of guessing', () => {
    expect(parseForumLink('https://www.nmbxd1.com/t/50000001?r=abc&page=-1')).toEqual({
      kind: 'thread', threadId: '50000001', replyId: null, page: null, poHint: false
    })
  })
})

it('retains nmb Retry-After across sessions without spending an untouched token during the cooldown', async () => {
  const { search, seen, advance } = await service((entry, response) => {
    if (entry.params.s === 'limited') return response.writeHead(429, { 'Retry-After': '5' }).end()
    chain(entry, response)
  })
  await search.run('w', 'kept', 'nmb-search', 'q')
  expect(await search.run('w', 'other', 'nmb-search', 'limited')).toMatchObject({ status: 'failed', error: { kind: 'rate-limited', retryAt: 1_800_000_005_000 } })
  expect(await search.page('w', 'kept', 'nmb-search', 1)).toMatchObject({ status: 'ok', cached: true })
  expect(await search.page('w', 'kept', 'nmb-search', 2)).toMatchObject({ status: 'failed', next: 'available', error: { kind: 'rate-limited' } })
  expect(seen).toHaveLength(2)
  advance(5_000)
  expect(await search.page('w', 'kept', 'nmb-search', 2)).toMatchObject({ status: 'ok', page: { pageNumber: 2 } })
  expect(seen.filter((entry) => entry.params.npt === 't1')).toHaveLength(1)
})
