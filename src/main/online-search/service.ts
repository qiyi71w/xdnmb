import { type SearchChannel, type SearchChainEnd, type SearchError, type SearchHit, type SearchNextState, type SearchOutcome, type SearchPage, type ThreadOfOutcome, parseForumLink } from '../../shared/online-search'
import { ForumReadError, ReadCancelledError, type ForumTransport } from '../forum/contract'
import { createXdsSearchAdapter, retryDeadline, XDS_API_ORIGIN } from './xds'

/** The nmb-search public JSON web-search endpoint. */
export const SEARCH_API_ORIGIN = 'https://nmb-search.166666666.xyz'
const SEARCH_API_PATH = '/api/v1/web'

/** The service documents that a next-page token expires after 15 minutes of inactivity. */
export const SEARCH_TOKEN_IDLE_MS = 15 * 60_000
/** Sessions kept per renderer; the oldest is released beyond this. */
export const MAX_SEARCH_SESSIONS = 32

const MAX_TOKEN_LENGTH = 4096
const MAX_HITS_PER_PAGE = 100
const MAX_URL_LENGTH = 2048
const MAX_TITLE_LENGTH = 300
const MAX_DESCRIPTION_LENGTH = 1000
const MAX_SERVICE_MESSAGE_LENGTH = 200
// Plausible `date` range (seconds): 2000-01-01 .. 2100-01-01. Anything else stays unknown.
const MIN_DATE_SECONDS = 946_684_800
const MAX_DATE_SECONDS = 4_102_444_800

/**
 * Session operations implemented by the two explicit adapters. `owner` scopes work to one
 * renderer, `sessionId` to one search entry. Each adapter owns its distinct cursor and retry rules;
 * obtained pages stay local and neither adapter requests a page until explicitly asked.
 */
export interface SearchAdapter {
  run(owner: string, sessionId: string, query: string): Promise<SearchOutcome>
  page(owner: string, sessionId: string, page: number): Promise<SearchOutcome>
  cancel(owner: string, sessionId: string): void
  close(owner: string, sessionId: string): void
  closeAll(owner: string): void
}

export interface OnlineSearchService {
  run(owner: string, sessionId: string, channel: SearchChannel, query: string): Promise<SearchOutcome>
  page(owner: string, sessionId: string, channel: SearchChannel, page: number): Promise<SearchOutcome>
  cancel(owner: string, sessionId: string, channel: SearchChannel): void
  close(owner: string, sessionId: string, channel: SearchChannel): void
  closeAll(owner: string): void
  threadOf(postId: string, signal: AbortSignal): Promise<ThreadOfOutcome>
}

interface InFlight {
  page: number
  controller: AbortController
  promise: Promise<SearchOutcome>
}

interface Chain {
  pages: SearchPage[]
  token: { value: string; receivedAt: number } | null
  /** Why there is no token; `null` while a token is held. */
  end: SearchChainEnd | null
  inFlight: InFlight | null
}

interface Session {
  chain: Chain | null
}

type Fetched =
  | { ok: true; hits: SearchHit[]; token: string | null }
  | { ok: false; outcome: { status: 'failed'; error: SearchError } | { status: 'cancelled' } }

function plainText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  // No control or bidirectional-override characters: untrusted text must not reorder or hide what it shows.
  const text = value.replace(/[\p{Cc}\u200E\u200F\u202A-\u202E\u2066-\u2069]+/gu, ' ').replace(/\s+/g, ' ').trim()
  if (text.length === 0) return null
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH || !URL.canParse(value)) return null
  const url = new URL(value)
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null
  return url.href.length > MAX_URL_LENGTH ? null : url.href
}

function dateOf(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_DATE_SECONDS || value > MAX_DATE_SECONDS) return null
  return new Date(value * 1000).toISOString()
}

function hitOf(item: unknown): SearchHit | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null
  const record = item as Record<string, unknown>
  const title = plainText(record.title, MAX_TITLE_LENGTH)
  const description = plainText(record.description, MAX_DESCRIPTION_LENGTH)
  const url = safeUrl(record.url)
  if (title === null && description === null && url === null) return null
  return { title, description, url, date: dateOf(record.date), target: url === null ? null : parseForumLink(url) }
}

function hintOf(message: string): 'rate-limited' | 'verification' | null {
  if (/captcha|\bpass\b|verif|challenge|验证/i.test(message)) return 'verification'
  if (/rate.?limit|too many requests|频繁|限流/i.test(message)) return 'rate-limited'
  return null
}

const failed = (error: SearchError): Fetched => ({ ok: false, outcome: { status: 'failed', error } })
const shape = (): Fetched => failed({ kind: 'unknown-structure', detail: 'shape' })

/** Only `status=ok` with a `web` array is consumed; HTTP 200 or parseable JSON alone is not success. */
function parse(mediaType: string | null, text: string): Fetched {
  if (mediaType === 'text/html' || text.trimStart().startsWith('<')) return failed({ kind: 'unknown-structure', detail: 'html' })
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return failed({ kind: 'unknown-structure', detail: 'json' })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return shape()
  const body = value as Record<string, unknown>
  if (typeof body.status !== 'string') return shape()
  if (body.status !== 'ok') {
    const serviceMessage = plainText(body.status, MAX_SERVICE_MESSAGE_LENGTH)
    return serviceMessage === null ? shape() : failed({ kind: 'service', serviceMessage, hint: hintOf(serviceMessage) })
  }
  if (!Array.isArray(body.web)) return shape()
  const npt = body.npt
  if (npt !== undefined && npt !== null && (typeof npt !== 'string' || npt.length > MAX_TOKEN_LENGTH)) return shape()
  const hits: SearchHit[] = []
  for (const item of body.web) {
    const hit = hitOf(item)
    if (hit !== null) hits.push(hit)
    if (hits.length === MAX_HITS_PER_PAGE) break
  }
  // Entries were returned but none is usable: unknown structure, not "no results".
  if (hits.length === 0 && body.web.length > 0) return shape()
  return { ok: true, hits, token: typeof npt === 'string' && npt.length > 0 ? npt : null }
}

function transportFailure(error: unknown, now: number): Fetched {
  if (error instanceof ReadCancelledError) return { ok: false, outcome: { status: 'cancelled' } }
  if (!(error instanceof ForumReadError)) return failed({ kind: 'network', detail: 'connection' })
  const { detail, httpStatus } = error.error
  if (httpStatus === 429) return failed({ kind: 'rate-limited', retryAt: retryDeadline(error.error.retryAfter, now) })
  if (httpStatus === 401 || httpStatus === 403) return failed({ kind: 'verification', httpStatus })
  switch (detail) {
    case 'timeout':
      return failed({ kind: 'network', detail: 'timeout' })
    case 'http-status':
      return failed({ kind: 'http-status', httpStatus: httpStatus ?? 0 })
    case 'redirect':
    case 'too-large':
    case 'decode':
      return failed({ kind: 'unknown-structure', detail })
    default:
      return failed({ kind: 'network', detail: 'connection' })
  }
}

function createNmbSearchAdapter({
  transport,
  origin = SEARCH_API_ORIGIN,
  now = () => Date.now()
}: {
  /** Must allow only `origin`; it sends no cookies or credentials and follows no redirects. */
  transport: ForumTransport
  origin?: string
  now?: () => number
}): SearchAdapter {
  const sessions = new Map<string, Session>()
  const keyOf = (owner: string, sessionId: string): string => `${owner}\u0000${sessionId}`
  let limitedUntil = 0

  async function request(params: { s: string } | { npt: string }, signal: AbortSignal): Promise<Fetched> {
    if (limitedUntil > now()) return failed({ kind: 'rate-limited', retryAt: limitedUntil })
    const url = new URL(SEARCH_API_PATH, origin)
    if ('s' in params) url.searchParams.set('s', params.s)
    else url.searchParams.set('npt', params.npt)
    try {
      const response = await transport.get(url, signal)
      return parse(response.mediaType, response.text)
    } catch (error) {
      const fetched = transportFailure(error, now())
      if (!fetched.ok && fetched.outcome.status === 'failed' && fetched.outcome.error.kind === 'rate-limited' && fetched.outcome.error.retryAt !== null) {
        limitedUntil = Math.max(limitedUntil, fetched.outcome.error.retryAt)
      }
      return fetched
    }
  }

  function nextOf(chain: Chain): SearchNextState {
    if (chain.token === null) return chain.end ?? 'end'
    if (now() - chain.token.receivedAt >= SEARCH_TOKEN_IDLE_MS) {
      chain.token = null
      chain.end = 'expired'
      return 'expired'
    }
    return 'available'
  }

  /** Runs one request for `pageNumber` of `chain`; the result is applied only while the chain is current. */
  function start(session: Session, chain: Chain, pageNumber: number, params: { s: string } | { npt: string }): Promise<SearchOutcome> {
    const controller = new AbortController()
    const promise = (async (): Promise<SearchOutcome> => {
      const fetched = await request(params, controller.signal)
      if (chain.inFlight?.controller === controller) chain.inFlight = null
      if (session.chain !== chain || controller.signal.aborted) return { status: 'cancelled' }
      if (!fetched.ok) {
        if (fetched.outcome.status === 'cancelled') return fetched.outcome
        return { ...fetched.outcome, next: nextOf(chain) }
      }
      const page: SearchPage = { pageNumber, hits: fetched.hits, fetchedAt: new Date(now()).toISOString() }
      chain.pages.push(page)
      if (fetched.token === null) chain.end = 'end'
      else {
        chain.token = { value: fetched.token, receivedAt: now() }
        chain.end = null
      }
      return { status: 'ok', page, cached: false, next: nextOf(chain) }
    })()
    chain.inFlight = { page: pageNumber, controller, promise }
    return promise
  }

  function release(key: string): void {
    const session = sessions.get(key)
    if (session === undefined) return
    sessions.delete(key)
    session.chain?.inFlight?.controller.abort()
  }

  function ownedKeys(owner: string): string[] {
    const prefix = keyOf(owner, '')
    return [...sessions.keys()].filter((key) => key.startsWith(prefix))
  }

  return {
    run(owner, sessionId, query) {
      const key = keyOf(owner, sessionId)
      let session = sessions.get(key)
      if (session === undefined) {
        const owned = ownedKeys(owner)
        for (const oldest of owned.slice(0, Math.max(0, owned.length - MAX_SEARCH_SESSIONS + 1))) release(oldest)
        session = { chain: null }
        sessions.set(key, session)
      }
      session.chain?.inFlight?.controller.abort()
      // No page and no token yet: a failed first page leaves nothing to continue; retrying is a new run.
      const chain: Chain = { pages: [], token: null, end: 'end', inFlight: null }
      session.chain = chain
      return start(session, chain, 1, { s: query })
    },

    async page(owner, sessionId, pageNumber) {
      const session = sessions.get(keyOf(owner, sessionId))
      if (session === undefined) return { status: 'closed' }
      const chain = session.chain
      if (chain === null) return { status: 'unavailable', next: 'end' }
      const obtained = chain.pages[pageNumber - 1]
      if (obtained !== undefined) return { status: 'ok', page: obtained, cached: true, next: nextOf(chain) }
      if (chain.inFlight !== null) {
        if (chain.inFlight.page === pageNumber) return chain.inFlight.promise
        return { status: 'unavailable', next: chain.end ?? 'end' }
      }
      const next = nextOf(chain)
      if (next !== 'available' || chain.token === null || pageNumber !== chain.pages.length + 1) {
        return { status: 'unavailable', next: next === 'available' ? 'end' : next }
      }
      if (limitedUntil > now()) return { status: 'failed', error: { kind: 'rate-limited', retryAt: limitedUntil }, next }
      // Spent now: if this request's result never arrives, the token is not sent again.
      const token = chain.token.value
      chain.token = null
      chain.end = 'lost'
      return start(session, chain, pageNumber, { npt: token })
    },

    cancel(owner, sessionId) {
      sessions.get(keyOf(owner, sessionId))?.chain?.inFlight?.controller.abort()
    },

    close(owner, sessionId) {
      release(keyOf(owner, sessionId))
    },

    closeAll(owner) {
      for (const key of ownedKeys(owner)) release(key)
    }
  }
}

/** Two explicit adapters share only ownership and channel-level Retry-After gates. */
export function createOnlineSearchService(options: {
  transport: ForumTransport
  origin?: string
  xdsTransport: ForumTransport
  xdsOrigin?: string
  now?: () => number
}): OnlineSearchService {
  const now = options.now ?? Date.now
  const nmb = createNmbSearchAdapter(options)
  const xds = createXdsSearchAdapter({ transport: options.xdsTransport, origin: options.xdsOrigin ?? XDS_API_ORIGIN, now })
  const adapters = { xds, 'nmb-search': nmb }
  const limits = new Map<SearchChannel, number>()
  const gate = (channel: SearchChannel): SearchError | null => {
    const until = limits.get(channel)
    return until !== undefined && until > now() ? { kind: 'rate-limited', retryAt: until } : null
  }
  const remember = <T extends SearchOutcome | ThreadOfOutcome>(channel: SearchChannel, outcome: T): T => {
    if (outcome.status === 'failed' && outcome.error.kind === 'rate-limited' && outcome.error.retryAt !== null) {
      limits.set(channel, Math.max(limits.get(channel) ?? 0, outcome.error.retryAt))
    }
    return outcome
  }
  return {
    async run(owner, sessionId, channel, query) {
      const error = gate(channel)
      if (error !== null) return { status: 'failed', error, next: 'end' }
      return remember(channel, await adapters[channel].run(owner, sessionId, query))
    },
    async page(owner, sessionId, channel, page) {
      // Obtained pages are still readable during a service cooldown; the adapter gates new reads.
      return remember(channel, await adapters[channel].page(owner, sessionId, page))
    },
    cancel(owner, sessionId, channel) { adapters[channel].cancel(owner, sessionId) },
    close(owner, sessionId, channel) { adapters[channel].close(owner, sessionId) },
    closeAll(owner) { nmb.closeAll(owner); xds.closeAll(owner) },
    async threadOf(postId, signal) {
      const error = gate('xds')
      if (error !== null) return { status: 'failed', error }
      return remember('xds', await xds.threadOf(postId, signal))
    }
  }
}
