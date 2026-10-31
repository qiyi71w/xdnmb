// The main process owns third-party requests, pagination and normalization. The renderer only sees
// normalized pages, never pagination tokens or arbitrary service endpoints.

import type { PostId, ThreadId, TimelineId } from './forum'
import { serverCalendarDate } from './search-filters'

export const SEARCH_CHANNELS = ['xds', 'nmb-search'] as const
export type SearchChannel = (typeof SEARCH_CHANNELS)[number]

export interface XdsSearchFilters {
  fid: string
  since: string
  until: string
  scope: 'all' | 'threads' | 'replies'
  sort: 'rank' | 'time_desc' | 'time_asc' | 'replies_desc' | 'replies_asc'
  mode: 'terms' | 'exact'
  match: 'thread' | 'aggregate'
  op: 'and' | 'or' | 'auto'
}

export const DEFAULT_XDS_SEARCH_FILTERS: Readonly<XdsSearchFilters> = Object.freeze({
  fid: '', since: '', until: '', scope: 'all', sort: 'rank', mode: 'terms', match: 'thread', op: 'and'
})

const FILTER_KEYS = ['fid', 'since', 'until', 'scope', 'sort', 'mode', 'match', 'op'] as const
const filterDate = (value: unknown): value is string => typeof value === 'string' &&
  (value === '' || (/^\d{4}-\d{2}-\d{2}$/.test(value) && serverCalendarDate(value) === value))

/** Only the supported XDS fields cross IPC; calendar dates are never normalized or guessed. */
export function isXdsSearchFilters(value: unknown): value is XdsSearchFilters {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const filters = value as Record<string, unknown>
  if (Object.keys(filters).length !== FILTER_KEYS.length || FILTER_KEYS.some((key) => !Object.hasOwn(filters, key))) return false
  return typeof filters.fid === 'string' && (filters.fid === '' || /^[1-9]\d{0,19}$/.test(filters.fid)) &&
    filterDate(filters.since) && filterDate(filters.until) &&
    (filters.since === '' || filters.until === '' || filters.since <= filters.until) &&
    (filters.scope === 'all' || filters.scope === 'threads' || filters.scope === 'replies') &&
    (filters.sort === 'rank' || filters.sort === 'time_desc' || filters.sort === 'time_asc' || filters.sort === 'replies_desc' || filters.sort === 'replies_asc') &&
    (filters.mode === 'terms' || filters.mode === 'exact') &&
    (filters.match === 'thread' || filters.match === 'aggregate') &&
    (filters.op === 'and' || filters.op === 'or' || filters.op === 'auto')
}

export function sameXdsSearchFilters(a: XdsSearchFilters, b: XdsSearchFilters): boolean {
  return a.fid === b.fid && a.since === b.since && a.until === b.until && a.scope === b.scope &&
    a.sort === b.sort && a.mode === b.mode && a.match === b.match && a.op === b.op
}

/** Fixed websites opened only by an explicit user action. */
export const SEARCH_SITE_URLS: Readonly<Record<SearchChannel, string>> = {
  xds: 'https://xds.wol.moe/',
  'nmb-search': 'https://nmb-search.166666666.xyz/'
}

/** Longest accepted query, in UTF-16 code units after trimming. */
export const MAX_SEARCH_QUERY_LENGTH = 200

/**
 * Caller-generated ID of one search page; same format as OperationId. Each channel holds its own
 * current query chain and returned pages under this ID.
 */
export type SearchSessionId = string

/**
 * A result URL recognized on a verified forum host (`nmbxd1.com`, `nmbxd.com`, with or without
 * `www.`). Everything here is a clue for the existing reader navigation to verify, not a location:
 * - `thread`: `/t/<串号>` with optional `r=<发言号>` and `page=<页码>`, or `/Forum/po/id/<串号>.html`
 *   (`poHint`; it never changes the thread's saved reading mode). `replyId` is the explicit target
 *   post; it equals `threadId` when the link names the main post. `page` is where the search index
 *   saw the target in the full (`all`) listing, possibly outdated.
 * - `board`: `/f/<版面名>` or `/m/f/<版面名>`; the name still has to match the board directory.
 * - `timeline`: `/Home/Forum/timeline/id/<编号>.html` or `/Forum/timeline/id/<编号>.html`; the
 *   number still has to exist in the local timeline directory.
 */
export type ForumLinkTarget =
  | { kind: 'thread'; threadId: ThreadId; replyId: PostId | null; page: number | null; poHint: boolean }
  | { kind: 'board'; boardName: string }
  | { kind: 'timeline'; timelineId: TimelineId }

/** One search hit. All text is untrusted plain text from the service and must be shown as text. */
export interface SearchHit {
  /** `null` when the service gave none. */
  title: string | null
  /** Service snippet; not the post body and never indexed or treated as content. */
  description: string | null
  /** Absolute http(s) URL without credentials (at most 2048 characters); `null` when missing/unsafe. */
  url: string | null
  /** ISO time from the service's `date`; `null` = unknown (never "no date"). */
  date: string | null
  /** `null`: not a recognized forum link (only openable in the system browser when `url` is set). */
  target: ForumLinkTarget | null
}

export interface SearchPage {
  /** 1-based position in the current query chain. */
  pageNumber: number
  hits: SearchHit[]
  /** When the main process received this page. */
  fetchedAt: string
}

/**
 * Why no further page can be requested in this chain:
 * - `end`: no further page was announced (not a claim the index is complete);
 * - `expired`: an nmb-search token was idle for 15 minutes and is not sent;
 * - `lost`: an nmb-search token was spent on a request whose result never arrived (failure,
 *   cancellation); it is never replayed. XDS numeric pages do not expire or become spent tokens.
 */
export type SearchChainEnd = 'end' | 'expired' | 'lost'

/** `available`: a next page can be requested now (it is not fetched until the user asks). */
export type SearchNextState = 'available' | SearchChainEnd

/**
 * Classified failure. `serviceMessage` is bounded, untrusted HTTP-200 status/degraded-query text;
 * `hint` comes only from that text. HTTP rate/verification statuses have separate cases.
 * A `retryAt` deadline is epoch milliseconds from Retry-After, or null when the service gave none.
 */
export type SearchError =
  | { kind: 'network'; detail: 'timeout' | 'connection' }
  | { kind: 'rate-limited'; retryAt: number | null }
  | { kind: 'verification'; httpStatus: number }
  | { kind: 'http-status'; httpStatus: number }
  | { kind: 'service'; serviceMessage: string; hint: 'rate-limited' | 'verification' | null }
  | { kind: 'unknown-structure'; detail: 'redirect' | 'too-large' | 'decode' | 'html' | 'json' | 'shape' }

/**
 * Result of a search request or a page request. `next` is the chain state after this call.
 * - `ok`: `cached` is true when the page came from this session without a request.
 * - `failed`: nothing new; pages already obtained in the session stay available.
 * - `unavailable`: the requested page is not obtained and cannot be requested (see `next`).
 * - `cancelled`: superseded by a newer search in the session, cancelled, or the session was closed.
 * - `closed`: the session does not exist (never started or already closed).
 */
export type SearchOutcome =
  | { status: 'ok'; page: SearchPage; cached: boolean; next: SearchNextState }
  | { status: 'failed'; error: SearchError; next: SearchNextState }
  | { status: 'unavailable'; next: SearchChainEnd }
  | { status: 'cancelled' }
  | { status: 'closed' }

/** Third-party ownership is only a clue; the reader must verify any target before navigating. */
export type ThreadOfOutcome =
  | { status: 'found'; postId: PostId; threadId: ThreadId; kind: 'thread' | 'reply' }
  | { status: 'not-indexed' }
  | { status: 'failed'; error: SearchError }
  | { status: 'cancelled' }

const FORUM_HOSTS: Readonly<Record<string, true>> = { 'nmbxd1.com': true, 'www.nmbxd1.com': true, 'nmbxd.com': true, 'www.nmbxd.com': true }
const DECIMAL_ID = /^[1-9]\d{0,19}$/
const MAX_LINK_PAGE = 100_000

function positivePage(value: string | null): number | null {
  if (value === null || !/^[1-9]\d{0,5}$/.test(value)) return null
  const page = Number(value)
  return page <= MAX_LINK_PAGE ? page : null
}

function decodedSegment(value: string): string | null {
  try {
    const name = decodeURIComponent(value).trim()
    return name.length > 0 && name.length <= 100 && !/[/\\\p{Cc}]/u.test(name) ? name : null
  } catch {
    return null
  }
}

/**
 * Recognizes a forum thread/board/timeline link. Only the verified hosts and path forms above are
 * accepted; any other URL (other hosts, ports, credentials, unknown paths, non-decimal IDs) gives `null`.
 */
export function parseForumLink(raw: string): ForumLinkTarget | null {
  if (!URL.canParse(raw)) return null
  const url = new URL(raw)
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.port) return null
  if (!Object.hasOwn(FORUM_HOSTS, url.hostname)) return null
  const path = url.pathname.replace(/\/+$/, '')

  const thread = /^\/t\/(\d+)$/.exec(path)
  if (thread) {
    const threadId = thread[1] as string
    if (!DECIMAL_ID.test(threadId)) return null
    const reply = url.searchParams.get('r')
    const replyId = reply !== null && DECIMAL_ID.test(reply) ? reply : null
    return { kind: 'thread', threadId, replyId, page: positivePage(url.searchParams.get('page')), poHint: false }
  }

  const po = /^\/forum\/po\/id\/(\d+)\.html$/i.exec(path)
  if (po) {
    const threadId = po[1] as string
    return DECIMAL_ID.test(threadId) ? { kind: 'thread', threadId, replyId: null, page: null, poHint: true } : null
  }

  const timeline = /^(?:\/home)?\/forum\/timeline\/id\/(\d+)\.html$/i.exec(path)
  if (timeline) {
    const timelineId = timeline[1] as string
    return DECIMAL_ID.test(timelineId) ? { kind: 'timeline', timelineId } : null
  }

  const board = /^(?:\/m)?\/f\/([^/]+)$/.exec(path)
  if (board) {
    const boardName = decodedSegment(board[1] as string)
    return boardName === null ? null : { kind: 'board', boardName }
  }
  return null
}

/** A whole explicit number input. IDs stay strings, including values beyond JS integer precision. */
export function parseNumberTarget(raw: string): { postId: PostId; hint: { threadId: ThreadId; page: number | null } | null } | null {
  const text = raw.trim()
  if (text.length > 2048) return null
  const number = /^(?:>>)?(?:No\.)?([1-9]\d{0,19})$/.exec(text)
  if (number !== null) return { postId: number[1]!, hint: null }
  const link = parseForumLink(text)
  if (link?.kind === 'thread') {
    const url = new URL(text)
    if (url.hash || [...url.searchParams.keys()].some((key) => key !== 'r' && key !== 'page') ||
        url.searchParams.getAll('r').length > 1 || url.searchParams.getAll('page').length > 1 ||
        (url.searchParams.has('r') && link.replyId === null) ||
        (url.searchParams.has('page') && link.page === null)) return null
  }
  return link?.kind === 'thread'
    ? { postId: link.replyId ?? link.threadId, hint: { threadId: link.threadId, page: link.page } }
    : null
}
