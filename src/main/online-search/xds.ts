import type { SearchError, SearchHit, SearchOutcome, ThreadOfOutcome, XdsSearchFilters } from '../../shared/online-search'
import { parseForumLink } from '../../shared/online-search'
import { ForumReadError, ReadCancelledError, type ForumTransport, type TransportResponse } from '../forum/contract'
import type { SearchAdapter } from './service'

export const XDS_API_ORIGIN = 'https://xds.wol.moe'
const PAGE_SIZE = 20
const MAX_SESSIONS = 32
const ID = /^[1-9]\d{0,19}$/
type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue => typeof value === 'object' && value !== null && !Array.isArray(value)
const id = (value: unknown): string | null => typeof value === 'string' && ID.test(value) ? value : null

/** Only an explicit server deadline creates a cooldown; no guessed interval or quota. */
export function retryDeadline(value: string | undefined, now: number): number | null {
  if (value === undefined) return null
  if (/^\d+$/.test(value.trim())) {
    const seconds = Number(value)
    return Number.isSafeInteger(seconds) && seconds >= 0 && Number.isSafeInteger(now + seconds * 1000) ? now + seconds * 1000 : null
  }
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(now, date) : null
}

function failure(error: unknown, now: number): SearchError {
  if (!(error instanceof ForumReadError)) return { kind: 'network', detail: 'connection' }
  const { detail, httpStatus, retryAfter } = error.error
  if (httpStatus === 429) return { kind: 'rate-limited', retryAt: retryDeadline(retryAfter, now) }
  if (httpStatus === 401 || httpStatus === 403) return { kind: 'verification', httpStatus }
  if (detail === 'http-status') return { kind: 'http-status', httpStatus: httpStatus ?? 0 }
  if (detail === 'redirect' || detail === 'too-large' || detail === 'decode' || detail === 'html' || detail === 'json' || detail === 'shape') return { kind: 'unknown-structure', detail }
  return { kind: 'network', detail: detail === 'timeout' ? 'timeout' : 'connection' }
}

function json(response: TransportResponse): unknown {
  if (response.mediaType === 'text/html' || response.text.trimStart().startsWith('<')) throw new ForumReadError({ kind: 'unknown-structure', detail: 'html' })
  try {
    // The service emits integer IDs. Source text, not an already-rounded JS number, is authoritative.
    return JSON.parse(response.text, (key: string, value: unknown, context?: { source?: string }) =>
      (key === 'id' || key === 'thread_id' || key === 'query_id') && typeof value === 'number' ? context?.source : value) as unknown
  } catch { throw new ForumReadError({ kind: 'unknown-structure', detail: 'json' }) }
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const plain = value.replace(/[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]+/gu, ' ').trim()
  return plain.length === 0 ? null : plain.length > max ? `${plain.slice(0, max - 1)}…` : plain
}

function hit(value: unknown): SearchHit | null {
  if (!record(value)) return null
  const postId = id(value.id)
  const threadId = value.kind === 'thread' ? postId : value.kind === 'reply' ? id(value.thread_id) : null
  if (postId === null || threadId === null) return null
  const url = `https://www.nmbxd1.com/t/${threadId}${value.kind === 'reply' ? `?r=${postId}` : ''}`
  const date = typeof value.post_time === 'string' ? Date.parse(value.post_time) : NaN
  return {
    title: text(value.kind === 'reply' ? value.thread_title : value.title, 300),
    description: text(value.content, 1000),
    url,
    date: Number.isFinite(date) ? new Date(date).toISOString() : null,
    target: parseForumLink(url)
  }
}

interface Chain {
  query: string
  filters: XdsSearchFilters
  pages: Map<number, Extract<SearchOutcome, { status: 'ok' }>['page']>
  next: 'available' | 'end'
  inFlight: { controller: AbortController; page: number; promise: Promise<SearchOutcome> } | null
}

/** XDS has repeatable numeric pages, never an nmb-search token. */
export function createXdsSearchAdapter({ transport, origin = XDS_API_ORIGIN, now = Date.now }: {
  transport: ForumTransport
  origin?: string
  now?: () => number
}): SearchAdapter & { threadOf(postId: string, signal: AbortSignal): Promise<ThreadOfOutcome> } {
  const sessions = new Map<string, Chain>()
  let limitedUntil = 0
  const keyOf = (owner: string, sessionId: string) => `${owner}\u0000${sessionId}`
  const limited = (): SearchError | null => limitedUntil > now() ? { kind: 'rate-limited', retryAt: limitedUntil } : null
  const classify = (error: unknown): SearchError => {
    const result = failure(error, now())
    if (result.kind === 'rate-limited' && result.retryAt !== null) limitedUntil = Math.max(limitedUntil, result.retryAt)
    return result
  }
  const release = (key: string) => { sessions.get(key)?.inFlight?.controller.abort(); sessions.delete(key) }

  const start = (key: string, chain: Chain, pageNumber: number): Promise<SearchOutcome> => {
    const blocked = limited()
    if (blocked !== null) return Promise.resolve({ status: 'failed', error: blocked, next: chain.next })
    const controller = new AbortController()
    const promise = (async (): Promise<SearchOutcome> => {
      try {
        const url = new URL('/api/v1/search', origin)
        url.searchParams.set('q', chain.query)
        const { filters } = chain
        url.searchParams.set('scope', filters.scope)
        url.searchParams.set('sort', filters.sort)
        url.searchParams.set('mode', filters.mode)
        url.searchParams.set('match', filters.match)
        url.searchParams.set('op', filters.op)
        if (filters.fid !== '') url.searchParams.set('fid', filters.fid)
        if (filters.since !== '') url.searchParams.set('since', filters.since)
        if (filters.until !== '') url.searchParams.set('until', filters.until)
        url.searchParams.set('page', String(pageNumber))
        url.searchParams.set('size', String(PAGE_SIZE))
        const body = json(await transport.get(url, controller.signal))
        if (controller.signal.aborted || sessions.get(key) !== chain) return { status: 'cancelled' }
        if (!record(body)) return { status: 'failed', error: { kind: 'unknown-structure', detail: 'shape' }, next: chain.next }
        if (body.degraded === true) return { status: 'failed', error: { kind: 'service', serviceMessage: text(body.message, 200) ?? '查询范围过大', hint: null }, next: chain.next }
        if (body.page !== pageNumber || !Array.isArray(body.results) || !record(body.total) || typeof body.total.combined !== 'number' || !Number.isSafeInteger(body.total.combined) || body.total.combined < 0) {
          return { status: 'failed', error: { kind: 'unknown-structure', detail: 'shape' }, next: chain.next }
        }
        const hits = body.results.map(hit).filter((item): item is SearchHit => item !== null)
        if (hits.length !== body.results.length || hits.length > PAGE_SIZE) return { status: 'failed', error: { kind: 'unknown-structure', detail: 'shape' }, next: chain.next }
        const page = { pageNumber, hits, fetchedAt: new Date(now()).toISOString() }
        chain.pages.set(pageNumber, page)
        chain.next = hits.length > 0 && pageNumber * PAGE_SIZE < body.total.combined ? 'available' : 'end'
        return { status: 'ok', page, cached: false, next: chain.next }
      } catch (error) {
        if (controller.signal.aborted || error instanceof ReadCancelledError || sessions.get(key) !== chain) return { status: 'cancelled' }
        return { status: 'failed', error: classify(error), next: chain.next }
      } finally {
        if (chain.inFlight?.controller === controller) chain.inFlight = null
      }
    })()
    chain.inFlight = { controller, page: pageNumber, promise }
    return promise
  }

  return {
    run(owner, sessionId, query, filters) {
      if (filters === null) throw new Error('invalid request')
      const key = keyOf(owner, sessionId)
      const blocked = limited()
      if (blocked !== null) return Promise.resolve({ status: 'failed', error: blocked, next: 'end' })
      release(key)
      const owned = [...sessions.keys()].filter((item) => item.startsWith(keyOf(owner, '')))
      for (const oldest of owned.slice(0, Math.max(0, owned.length - MAX_SESSIONS + 1))) release(oldest)
      const chain: Chain = { query, filters: { ...filters }, pages: new Map(), next: 'end', inFlight: null }
      sessions.set(key, chain)
      return start(key, chain, 1)
    },
    page(owner, sessionId, pageNumber) {
      const key = keyOf(owner, sessionId)
      const chain = sessions.get(key)
      if (chain === undefined) return Promise.resolve({ status: 'closed' })
      const cached = chain.pages.get(pageNumber)
      if (cached !== undefined) return Promise.resolve({ status: 'ok', page: cached, cached: true, next: chain.next })
      if (chain.inFlight !== null) return chain.inFlight.page === pageNumber ? chain.inFlight.promise : Promise.resolve({ status: 'unavailable', next: 'end' })
      if (pageNumber !== chain.pages.size + 1 || chain.next !== 'available') return Promise.resolve({ status: 'unavailable', next: 'end' })
      return start(key, chain, pageNumber)
    },
    cancel(owner, sessionId) {
      const chain = sessions.get(keyOf(owner, sessionId))
      if (chain === undefined) return
      const request = chain.inFlight
      chain.inFlight = null
      request?.controller.abort()
    },
    close(owner, sessionId) { release(keyOf(owner, sessionId)) },
    closeAll(owner) { for (const key of sessions.keys()) if (key.startsWith(keyOf(owner, ''))) release(key) },
    async threadOf(postId, signal) {
      if (!ID.test(postId)) return { status: 'failed', error: { kind: 'unknown-structure', detail: 'shape' } }
      const blocked = limited()
      if (blocked !== null) return { status: 'failed', error: blocked }
      try {
        const body = json(await transport.get(new URL(`/api/v1/thread-of/${postId}`, origin), signal))
        if (signal.aborted) return { status: 'cancelled' }
        if (!record(body) || id(body.query_id) !== postId || !record(body.thread)) return { status: 'failed', error: { kind: 'unknown-structure', detail: 'shape' } }
        const threadId = id(body.thread_id)
        if (threadId === null || id(body.thread.id) !== threadId ||
            (body.kind !== 'thread' && body.kind !== 'reply') ||
            (body.kind === 'thread' ? threadId !== postId : !record(body.reply) || id(body.reply.id) !== postId || threadId === postId)) {
          return { status: 'failed', error: { kind: 'unknown-structure', detail: 'shape' } }
        }
        return { status: 'found', postId, threadId, kind: body.kind }
      } catch (error) {
        if (signal.aborted || error instanceof ReadCancelledError) return { status: 'cancelled' }
        if (error instanceof ForumReadError && error.error.httpStatus === 404) return { status: 'not-indexed' }
        return { status: 'failed', error: classify(error) }
      }
    }
  }
}
