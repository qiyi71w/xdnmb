// Online search through the single third-party nmb-search service (a 4get / Google CSE proxy).
// The main process owns requests, pagination tokens and normalization; the renderer only sees the
// normalized pages below and never a service URL, query URL or pagination token.

import type { PostId, ThreadId } from './forum'

/** The search website itself, opened only in the system browser by an explicit user action. */
export const SEARCH_SITE_URL = 'https://nmb-search.166666666.xyz/'

/** Longest accepted query, in UTF-16 code units after trimming. */
export const MAX_SEARCH_QUERY_LENGTH = 200

/**
 * Caller-generated ID of one search session (one search page); same format as OperationId. A
 * session holds one query chain at a time and the pages that chain already returned.
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
 */
export type ForumLinkTarget =
  | { kind: 'thread'; threadId: ThreadId; replyId: PostId | null; page: number | null; poHint: boolean }
  | { kind: 'board'; boardName: string }

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
 * - `end`: the last successful response carried no next-page token (not a claim the index is complete);
 * - `expired`: the token was idle for 15 minutes and is not sent;
 * - `lost`: the token was spent on a request whose result never arrived (failure, cancellation);
 *   it is never replayed. A new search starts a new chain.
 */
export type SearchChainEnd = 'end' | 'expired' | 'lost'

/** `available`: a next page can be requested now (it is not fetched until the user asks). */
export type SearchNextState = 'available' | SearchChainEnd

/**
 * Classified service failure. `serviceMessage` is the service's own `status` text from an HTTP 200
 * response (at most 200 characters, untrusted). `hint` is set only when that text itself mentions
 * rate limiting or a captcha/pass/verification; an HTTP status alone (including 429) never sets it.
 */
export type SearchError =
  | { kind: 'network'; detail: 'timeout' | 'connection' }
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

const FORUM_HOSTS: ReadonlySet<string> = new Set(['nmbxd1.com', 'www.nmbxd1.com', 'nmbxd.com', 'www.nmbxd.com'])
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
 * Recognizes a forum thread/board link. Only the verified hosts and path forms above are accepted;
 * any other URL (other hosts, ports, credentials, unknown paths, non-decimal IDs) gives `null`.
 */
export function parseForumLink(raw: string): ForumLinkTarget | null {
  if (!URL.canParse(raw)) return null
  const url = new URL(raw)
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.port) return null
  if (!FORUM_HOSTS.has(url.hostname)) return null
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

  const board = /^(?:\/m)?\/f\/([^/]+)$/.exec(path)
  if (board) {
    const boardName = decodedSegment(board[1] as string)
    return boardName === null ? null : { kind: 'board', boardName }
  }
  return null
}
