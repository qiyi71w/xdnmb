import { createServer, type ServerResponse, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createForumTransport } from '../src/main/forum/transport'
import { createOnlineSearchService } from '../src/main/online-search/service'
import { parseNumberTarget } from '../src/shared/online-search'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => {
    const { promise, resolve } = Promise.withResolvers<void>()
    server.closeAllConnections()
    server.close(() => resolve())
    return promise
  }))
})
interface Seen { path: string; params: Record<string, string>; headers: Record<string, unknown> }
async function fixture(respond: (entry: Seen, response: ServerResponse) => void, timeoutMs = 1000) {
  const seen: Seen[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local')
    const entry = { path: url.pathname, params: Object.fromEntries(url.searchParams), headers: request.headers }
    seen.push(entry)
    respond(entry, response)
  })
  servers.push(server)
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('TCP listener required')
  const origin = `http://127.0.0.1:${address.port}`
  let clock = 1_800_000_000_000
  const transport = createForumTransport({ allowedOrigins: [origin], timeoutMs, userAgent: 'Xidao/1.0.0' })
  const search = createOnlineSearchService({ transport, xdsTransport: transport, origin, xdsOrigin: origin, now: () => clock })
  return { search, seen, advance(ms: number) { clock += ms } }
}
function answer(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
}
const hit = (id: string, threadId?: string) => ({ id, kind: threadId === undefined ? 'thread' : 'reply',
  ...(threadId === undefined ? {} : { thread_id: threadId }), title: '结果', thread_title: '原串', content: '正文', post_time: '2026-10-30T12:00:00+00:00' })
const page = (number: number, results: unknown[] = [hit('70000001')], total = 21) => ({ page: number, size: 20, results, total: { combined: total } })

describe('explicit XDS adapter', () => {
  it('isolates channel chains and maps numeric pages without tokens, identity fields or third-party target URLs', async () => {
    const { search, seen } = await fixture((entry, response) => {
      if (entry.path === '/api/v1/web') return answer(response, { status: 'ok', web: [], npt: entry.params.npt ? null : 'once' })
      answer(response, page(Number(entry.params.page), [hit(entry.params.page === '1' ? '90071992547409931234' : '70000002', '70000000')]))
    })
    await search.run('w', 'same', 'nmb-search', 'nmb query')
    expect(await search.run('w', 'same', 'xds', 'xds & query')).toMatchObject({ status: 'ok', next: 'available', page: { hits: [{ target: { threadId: '70000000', replyId: '90071992547409931234', page: null } }] } })
    expect(seen[1]).toMatchObject({ path: '/api/v1/search', params: { q: 'xds & query', scope: 'all', page: '1', size: '20' }, headers: { 'user-agent': 'Xidao/1.0.0' } })
    for (const field of ['cookie', 'authorization', 'x-userhash', 'uuid']) expect(seen[1]?.headers[field]).toBeUndefined()
    await search.page('w', 'same', 'xds', 2)
    await search.page('w', 'same', 'nmb-search', 2)
    expect(seen[2]?.params).toEqual({ q: 'xds & query', scope: 'all', page: '2', size: '20' })
    expect(seen[3]?.params).toEqual({ npt: 'once' })
    expect(await search.page('w', 'same', 'xds', 1)).toMatchObject({ status: 'ok', cached: true })
    expect(seen).toHaveLength(4)
  })

  it('retries a numeric page only on explicit action after failure and preserves obtained pages', async () => {
    let fails = true
    const { search, seen } = await fixture((entry, response) => {
      if (entry.params.page === '2' && fails) return answer(response, {}, 503)
      answer(response, page(Number(entry.params.page)))
    })
    await search.run('w', 's', 'xds', 'q')
    expect(await search.page('w', 's', 'xds', 2)).toMatchObject({ status: 'failed', error: { kind: 'http-status', httpStatus: 503 }, next: 'available' })
    expect(seen).toHaveLength(2)
    expect(await search.page('w', 's', 'xds', 1)).toMatchObject({ status: 'ok', cached: true })
    fails = false
    expect(await search.page('w', 's', 'xds', 2)).toMatchObject({ status: 'ok', cached: false })
    expect(seen).toHaveLength(3)
  })

  it('retains Retry-After across sessions and lookup but allows another channel and cached pages', async () => {
    const { search, seen, advance } = await fixture((entry, response) => {
      if (entry.path === '/api/v1/web') return answer(response, { status: 'ok', web: [], npt: null })
      if (entry.params.page === '2') return response.writeHead(429, { 'Retry-After': '30' }).end()
      answer(response, page(1))
    })
    await search.run('w', 's', 'xds', 'q')
    expect(await search.page('w', 's', 'xds', 2)).toMatchObject({ status: 'failed', error: { kind: 'rate-limited', retryAt: 1_800_000_030_000 } })
    expect(await search.run('w', 'other', 'xds', 'q')).toMatchObject({ status: 'failed', error: { kind: 'rate-limited' } })
    expect(await search.threadOf('70000002', new AbortController().signal)).toMatchObject({ status: 'failed', error: { kind: 'rate-limited' } })
    expect(await search.page('w', 's', 'xds', 1)).toMatchObject({ status: 'ok', cached: true })
    expect(seen).toHaveLength(2)
    await search.run('w', 's', 'nmb-search', 'q')
    expect(seen).toHaveLength(3)
    advance(30_000)
    expect(await search.run('w', 'other', 'xds', 'q')).toMatchObject({ status: 'ok' })
  })

  it('ignores superseded numeric responses', async () => {
    const held: ServerResponse[] = []
    const { search } = await fixture((entry, response) => {
      if (entry.params.q === 'old') held.push(response)
      else answer(response, page(1, [hit('70000009')], 1))
    })
    const old = search.run('w', 's', 'xds', 'old')
    await expect.poll(() => held.length).toBe(1)
    const fresh = await search.run('w', 's', 'xds', 'new')
    held[0]?.end(JSON.stringify(page(1)))
    expect(await old).toEqual({ status: 'cancelled' })
    expect(fresh).toMatchObject({ status: 'ok', page: { hits: [{ target: { threadId: '70000009' } }] } })
    expect(await search.page('w', 's', 'xds', 1)).toMatchObject({ cached: true, page: { hits: [{ target: { threadId: '70000009' } }] } })
  })

  it.each([
    ['degraded', { degraded: true, results: [], message: '查询范围过大' }, 200, { kind: 'service', serviceMessage: '查询范围过大' }],
    ['verification', {}, 403, { kind: 'verification', httpStatus: 403 }],
    ['unsafe ID', page(1, [hit('javascript:alert(1)')]), 200, { kind: 'unknown-structure', detail: 'shape' }]
  ])('does not mistake %s for no results', async (_name, body, status, error) => {
    const { search } = await fixture((_entry, response) => answer(response, body, status))
    expect(await search.run('w', 's', 'xds', 'q')).toMatchObject({ status: 'failed', error })
  })

  it('distinguishes normal no-results and inert hostile text with synthesized verified links', async () => {
    const empty = await fixture((_entry, response) => answer(response, page(1, [], 0)))
    expect(await empty.search.run('w', 's', 'xds', 'q')).toMatchObject({ status: 'ok', next: 'end', page: { hits: [] } })
    const hostile = { ...hit('70000001'), content: '<script>alert(1)</script>\u202E', url: 'javascript:alert(1)', user_hash: 'not-rendered' }
    const { search } = await fixture((_entry, response) => answer(response, page(1, [hostile], 1)))
    const outcome = await search.run('w', 's', 'xds', 'q')
    expect(outcome).toMatchObject({ status: 'ok', page: { hits: [{ description: '<script>alert(1)</script>', url: 'https://www.nmbxd1.com/t/70000001' }] } })
    expect(JSON.stringify(outcome)).not.toContain('not-rendered')
  })

  it('preserves numeric JSON IDs exactly and returns only ownership, not a fabricated page', async () => {
    const { search, seen } = await fixture((_entry, response) => response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"query_id":99999999999999999999,"kind":"reply","thread_id":9007199254740993,"thread":{"id":9007199254740993},"reply":{"id":99999999999999999999}}'))
    expect(seen).toHaveLength(0)
    expect(await search.threadOf('99999999999999999999', new AbortController().signal)).toEqual({ status: 'found', postId: '99999999999999999999', threadId: '9007199254740993', kind: 'reply' })
    expect(seen[0]).toMatchObject({ path: '/api/v1/thread-of/99999999999999999999', params: {} })
  })

  it.each([
    [404, {}, { status: 'not-indexed' }],
    [429, {}, { status: 'failed', error: { kind: 'rate-limited', retryAt: null } }],
    [503, {}, { status: 'failed', error: { kind: 'http-status', httpStatus: 503 } }],
    [200, { query_id: '7', kind: 'reply', thread_id: 'javascript:x', thread: { id: 'javascript:x' }, reply: { id: '7' } }, { status: 'failed', error: { kind: 'unknown-structure', detail: 'shape' } }],
    [200, { query_id: '8', kind: 'thread', thread_id: '7', thread: { id: '7' } }, { status: 'failed', error: { kind: 'unknown-structure', detail: 'shape' } }]
  ])('classifies lookup HTTP %s and inconsistent targets (%#)', async (status, body, outcome) => {
    const { search } = await fixture((_entry, response) => answer(response, body, status))
    expect(await search.threadOf('7', new AbortController().signal)).toEqual(outcome)
  })

  it('cancels an explicit lookup and rejects redirects and timeouts with no replay', async () => {
    const held = await fixture(() => undefined, 50)
    expect(await held.search.run('w', 's', 'xds', 'q')).toMatchObject({ status: 'failed', error: { kind: 'network', detail: 'timeout' } })
    const controller = new AbortController()
    const request = held.search.threadOf('7', controller.signal)
    controller.abort()
    expect(await request).toEqual({ status: 'cancelled' })
    const redirect = await fixture((_entry, response) => response.writeHead(302, { Location: 'https://example.com/' }).end())
    expect(await redirect.search.threadOf('7', new AbortController().signal)).toMatchObject({ status: 'failed', error: { kind: 'unknown-structure', detail: 'redirect' } })
    expect(redirect.seen).toHaveLength(1)
  })
})

describe('explicit number inputs', () => {
  it.each(['1', '1234567', '12345678', '123456789', '99999999999999999999'])('keeps %s exact', (value) => {
    for (const prefix of ['', 'No.', '>>No.']) expect(parseNumberTarget(` ${prefix}${value} `)).toEqual({ postId: value, hint: null })
  })
  it.each(['0', '012', '-1', '1.1', '1e3', '123456789012345678901', '2026-10-30', '$12345', 'text 12345', 'No.1 extra', 'https://evil.example/t/12'])('rejects whole invalid input %s', (value) => {
    expect(parseNumberTarget(value)).toBeNull()
  })
  it('keeps verified reply and page hints', () => {
    expect(parseNumberTarget('https://www.nmbxd1.com/t/1234567?page=9&r=99999999999999999999')).toEqual({ postId: '99999999999999999999', hint: { threadId: '1234567', page: 9 } })
  })
  it.each(['?r=abc', '?r=0', '?page=-1', '?page=0', '?page=1&r=2&r=3', '?page=1&callback=evil', '#other'])('rejects malformed or ambiguous explicit link %s instead of opening its parent', (suffix) => {
    expect(parseNumberTarget(`https://www.nmbxd1.com/t/1234567${suffix}`)).toBeNull()
  })
})
