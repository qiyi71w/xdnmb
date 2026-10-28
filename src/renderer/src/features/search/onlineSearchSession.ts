import type { SearchError, SearchNextState, SearchOutcome, SearchPage } from '../../../../shared/online-search'

/** A request of the search page: a new query chain (`run`) or a page of the current chain. */
export type OnlineSearchRequest = { kind: 'run'; query: string } | { kind: 'page'; page: number }

/** What the last request left to say; `null` after a success. */
export type OnlineSearchNotice =
  | { kind: 'failed'; request: OnlineSearchRequest; error: SearchError }
  /** The IPC call itself rejected: nothing is known about the service. */
  | { kind: 'internal'; request: OnlineSearchRequest }
  | { kind: 'cancelled'; request: OnlineSearchRequest }
  /** The main process no longer has this page's session (released): pages cannot be turned. */
  | { kind: 'closed' }

/** Pages obtained by one query chain, as shown on the search page. */
export interface OnlineSearchResults {
  query: string
  /** Index = page number − 1; always contiguous from page 1. */
  pages: readonly SearchPage[]
  /** Page number shown. */
  current: number
  /** Chain state after the latest call. */
  next: SearchNextState
  /**
   * `false` once a newer query started (or the session was released): the main process no longer
   * holds this chain, so its obtained pages stay viewable here (switched locally) but no new page
   * can be requested.
   */
  live: boolean
}

export interface OnlineSearchState {
  /** Text in the search box. */
  draft: string
  results: OnlineSearchResults | null
  /** Request whose result is still awaited. */
  pending: OnlineSearchRequest | null
  notice: OnlineSearchNotice | null
}

/** Where the page was left: kept outside the rendered state (no re-render on scroll or focus). */
export interface OnlineSearchViewMemory {
  scrollTop: number
  /** Last focused (or opened) result on the shown page. */
  focus: { page: number; index: number } | null
}

const INITIAL: OnlineSearchState = { draft: '', results: null, pending: null, notice: null }

const ignore = (): undefined => undefined

/**
 * Runtime memory and request bookkeeping of one search history entry (spec I10). Lives while the
 * entry is in some tab's history, also while its page is not mounted (navigated away), so a
 * response arriving meanwhile is still applied and coming back needs no request. Only the latest
 * request may change the state: every new request, cancellation and disposal advances `seq`, and
 * an older response is dropped.
 */
export class OnlineSearchSession {
  readonly sessionId: string
  readonly view: OnlineSearchViewMemory = { scrollTop: 0, focus: null }
  private state: OnlineSearchState = INITIAL
  private seq = 0
  private disposed = false
  private readonly listeners = new Set<() => void>()

  constructor(entryKey: number) {
    this.sessionId = `search-${entryKey}`
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState = (): OnlineSearchState => this.state

  private set(next: OnlineSearchState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  setDraft(draft: string): void {
    if (!this.disposed && draft !== this.state.draft) this.set({ ...this.state, draft })
  }

  /**
   * Starts a new query chain (explicit submit, retry or 重新搜索). `query` is already trimmed. The
   * same query while its own run is still awaited does nothing (no second request, nothing changes):
   * `pending` is set synchronously, so repeated Enter or clicks before a re-render are dropped too.
   * A different query replaces the awaited one, as before.
   */
  run(query: string): void {
    const { pending } = this.state
    if (this.disposed || query === '' || (pending?.kind === 'run' && pending.query === query)) return
    const seq = ++this.seq
    const request: OnlineSearchRequest = { kind: 'run', query }
    const { results } = this.state
    // The new chain replaces the old one in the main process: old pages stay shown, not turnable.
    this.set({
      ...this.state,
      pending: request,
      notice: null,
      results: results === null || !results.live ? results : { ...results, live: false }
    })
    window.xidao.onlineSearch.run({ sessionId: this.sessionId, query }).then(
      (outcome) => this.settle(seq, request, outcome),
      () => this.reject(seq, request)
    )
  }

  /**
   * Whether `page` can be shown now: an obtained page, or the next one while the chain has a token.
   * Superseded results (`live: false`) only move between their obtained pages, locally.
   */
  canShow(page: number): boolean {
    const { results, pending } = this.state
    if (results === null || page < 1 || page === results.current) return false
    if (!results.live) return page <= results.pages.length
    if (pending !== null) return false
    return page <= results.pages.length || (page === results.pages.length + 1 && results.next === 'available')
  }

  /**
   * Shows an obtained page (from the session cache, no request) or requests the next one. Pages of
   * superseded results are switched here without any IPC: the main process no longer holds that chain,
   * and its token is never restored or replayed. The awaited request and its notice are untouched.
   */
  goToPage(page: number): void {
    if (this.disposed || !this.canShow(page)) return
    const results = this.state.results
    if (results !== null && !results.live) {
      this.view.scrollTop = 0
      this.view.focus = null
      this.set({ ...this.state, results: { ...results, current: page } })
      return
    }
    const seq = ++this.seq
    const request: OnlineSearchRequest = { kind: 'page', page }
    this.set({ ...this.state, pending: request, notice: null })
    window.xidao.onlineSearch.page({ sessionId: this.sessionId, page }).then(
      (outcome) => this.settle(seq, request, outcome),
      () => this.reject(seq, request)
    )
  }

  /** Cancels the awaited request; returns whether there was one. A cancelled next page spends its token. */
  cancel(): boolean {
    const { pending, results } = this.state
    if (this.disposed || pending === null) return false
    ++this.seq
    const spent = pending.kind === 'page' && results !== null && pending.page > results.pages.length
    const cached = pending.kind === 'page' && !spent
    this.set({
      ...this.state,
      pending: null,
      notice: cached ? null : { kind: 'cancelled', request: pending },
      results: spent && results !== null ? { ...results, next: 'lost' } : results
    })
    if (!cached) window.xidao.onlineSearch.cancel({ sessionId: this.sessionId }).catch(ignore)
    return true
  }

  /** The entry left every tab's history: drop late responses and release the main-process session. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ++this.seq
    this.listeners.clear()
    window.xidao.onlineSearch.close({ sessionId: this.sessionId }).catch(ignore)
  }

  private settle(seq: number, request: OnlineSearchRequest, outcome: SearchOutcome): void {
    if (this.disposed || seq !== this.seq) return
    const state = this.state
    const results = state.results
    const base: OnlineSearchState = { ...state, pending: null }
    switch (outcome.status) {
      case 'ok': {
        this.view.scrollTop = 0
        this.view.focus = null
        if (request.kind === 'run') {
          this.set({ ...base, notice: null, results: { query: request.query, pages: [outcome.page], current: 1, next: outcome.next, live: true } })
          return
        }
        if (results === null) {
          this.set(base)
          return
        }
        const number = outcome.page.pageNumber
        const pages = number <= results.pages.length ? results.pages : [...results.pages, outcome.page]
        this.set({ ...base, notice: null, results: { ...results, pages, current: Math.min(number, pages.length), next: outcome.next } })
        return
      }
      case 'failed':
        this.set({
          ...base,
          notice: { kind: 'failed', request, error: outcome.error },
          results: request.kind === 'page' && results !== null ? { ...results, next: outcome.next } : results
        })
        return
      case 'unavailable':
        this.set({ ...base, notice: null, results: results === null ? null : { ...results, next: outcome.next } })
        return
      case 'cancelled': {
        const spent = request.kind === 'page' && results !== null && request.page > results.pages.length
        this.set({ ...base, notice: { kind: 'cancelled', request }, results: spent && results !== null ? { ...results, next: 'lost' } : results })
        return
      }
      case 'closed':
        this.set({ ...base, notice: { kind: 'closed' }, results: results === null ? null : { ...results, live: false } })
        return
    }
  }

  private reject(seq: number, request: OnlineSearchRequest): void {
    if (this.disposed || seq !== this.seq) return
    const { results } = this.state
    // Whether a next-page token was spent is unknown: it is never offered again.
    const spent = request.kind === 'page' && results !== null && request.page > results.pages.length
    this.set({
      ...this.state,
      pending: null,
      notice: { kind: 'internal', request },
      results: spent && results !== null ? { ...results, next: 'lost' } : results
    })
  }
}

/**
 * Search sessions of all search history entries, keyed by entry key. The shell releases a session
 * when its entry leaves every tab's history; nothing is persisted.
 */
export class OnlineSearchSessions {
  private readonly sessions = new Map<number, OnlineSearchSession>()

  /** The entry's session, created on first use. */
  session(entryKey: number): OnlineSearchSession {
    let session = this.sessions.get(entryKey)
    if (session === undefined) {
      session = new OnlineSearchSession(entryKey)
      this.sessions.set(entryKey, session)
    }
    return session
  }

  /** Releases every session whose entry is not in `live`. */
  retain(live: ReadonlySet<number>): void {
    for (const [key, session] of this.sessions) {
      if (live.has(key)) continue
      session.dispose()
      this.sessions.delete(key)
    }
  }
}
