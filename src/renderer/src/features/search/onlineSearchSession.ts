import { DEFAULT_XDS_SEARCH_FILTERS, isXdsSearchFilters, sameXdsSearchFilters, type SearchChannel, type SearchError, type SearchNextState, type SearchOutcome, type SearchPage, type XdsSearchFilters } from '../../../../shared/online-search'

/** A request of the search page: a new query chain (`run`) or a page of the current chain. */
export type OnlineSearchRequest = { kind: 'run'; query: string; filters: XdsSearchFilters | null } | { kind: 'page'; page: number }

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
  filters: XdsSearchFilters | null
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
  filters: XdsSearchFilters
  filtersOpen: boolean
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

const INITIAL: OnlineSearchState = { draft: '', filters: DEFAULT_XDS_SEARCH_FILTERS, filtersOpen: false, results: null, pending: null, notice: null }

const ignore = (): undefined => undefined

/**
 * Runtime memory and request bookkeeping of one channel of one search history entry. Lives while
 * the entry is in some tab's history, also while its page is not mounted (navigated away) or the
 * other channel is shown, so a response arriving meanwhile is applied to this channel only and
 * coming back needs no request. Only the latest request may change the state: every new request,
 * cancellation and disposal advances `seq`, and an older response is dropped.
 *
 * Paging differs by channel. XDS pages are numbered: a next page whose request failed or was
 * cancelled can be asked for again. nmb-search pages follow a one-time token: a next-page request
 * whose result never arrived (failure, cancellation, internal error) spends it for good.
 */
export class OnlineSearchSession {
  readonly sessionId: string
  readonly channel: SearchChannel
  readonly view: OnlineSearchViewMemory = { scrollTop: 0, focus: null }
  private state: OnlineSearchState = { ...INITIAL, filters: { ...DEFAULT_XDS_SEARCH_FILTERS } }
  private seq = 0
  private disposed = false
  private readonly listeners = new Set<() => void>()

  constructor(entryKey: number, channel: SearchChannel) {
    this.sessionId = `search-${entryKey}`
    this.channel = channel
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

  setFilters(filters: XdsSearchFilters): void {
    if (!this.disposed && !sameXdsSearchFilters(filters, this.state.filters)) this.set({ ...this.state, filters: { ...filters } })
  }

  setFiltersOpen(filtersOpen: boolean): void {
    if (!this.disposed && filtersOpen !== this.state.filtersOpen) this.set({ ...this.state, filtersOpen })
  }

  private matchesPending(query: string, filters: XdsSearchFilters | null): boolean {
    const { pending } = this.state
    return pending?.kind === 'run' && pending.query === query &&
      (pending.filters === null ? filters === null : filters !== null && sameXdsSearchFilters(pending.filters, filters))
  }

  hasPending(query: string): boolean {
    return this.matchesPending(query, this.channel === 'xds' ? this.state.filters : null)
  }

  /**
   * Starts a new query chain (explicit submit, retry or 重新搜索). `query` is already trimmed. The
   * same query and filters while their own run is still awaited do nothing (no second request):
   * `pending` is set synchronously, so repeated Enter or clicks before a re-render are dropped too.
   * A different query or filter snapshot replaces the awaited one.
   */
  run(query: string, filters: XdsSearchFilters = this.state.filters): void {
    if (this.disposed || query === '' || (this.channel === 'xds' && !isXdsSearchFilters(filters))) return
    const effectiveFilters = this.channel === 'xds' ? filters : null
    if (this.matchesPending(query, effectiveFilters)) return
    const seq = ++this.seq
    const snapshot = effectiveFilters === null ? null : Object.freeze({ ...effectiveFilters })
    const request: OnlineSearchRequest = { kind: 'run', query, filters: snapshot }
    const { results } = this.state
    // The new chain replaces the old one in the main process: old pages stay shown, not turnable.
    this.set({
      ...this.state,
      pending: request,
      notice: null,
      results: results === null || !results.live ? results : { ...results, live: false }
    })
    window.xidao.onlineSearch.run({ sessionId: this.sessionId, channel: this.channel, query, filters: snapshot }).then(
      (outcome) => this.settle(seq, request, outcome),
      () => this.reject(seq, request)
    )
  }

  /** A request for a page this chain has not obtained yet (not one served from the session). */
  private fetchesNew(request: OnlineSearchRequest): boolean {
    const { results } = this.state
    return request.kind === 'page' && results !== null && request.page > results.pages.length
  }

  /** Results after `request` ended without its page: an nmb-search next-page token is gone. */
  private afterLostRequest(request: OnlineSearchRequest): OnlineSearchResults | null {
    const { results } = this.state
    return this.channel === 'nmb-search' && this.fetchesNew(request) && results !== null ? { ...results, next: 'lost' } : results
  }

  /**
   * Whether `page` can be shown now: an obtained page, or the next one while the chain can give it.
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
   * Also the explicit 重试 of an XDS page whose request failed or was cancelled (`next` stays
   * `available` there); nmb-search offers no such retry.
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
    window.xidao.onlineSearch.page({ sessionId: this.sessionId, channel: this.channel, page }).then(
      (outcome) => this.settle(seq, request, outcome),
      () => this.reject(seq, request)
    )
  }

  /**
   * Cancels the awaited request; returns whether there was one. A cancelled nmb-search next page
   * spends its token; a cancelled XDS page can be asked for again.
   */
  cancel(): boolean {
    const { pending } = this.state
    if (this.disposed || pending === null) return false
    ++this.seq
    const cached = pending.kind === 'page' && !this.fetchesNew(pending)
    this.set({
      ...this.state,
      pending: null,
      notice: cached ? null : { kind: 'cancelled', request: pending },
      results: this.afterLostRequest(pending)
    })
    if (!cached) window.xidao.onlineSearch.cancel({ sessionId: this.sessionId, channel: this.channel }).catch(ignore)
    return true
  }

  /** The entry left every tab's history: drop late responses and release the main-process session. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ++this.seq
    this.listeners.clear()
    window.xidao.onlineSearch.close({ sessionId: this.sessionId, channel: this.channel }).catch(ignore)
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
          this.set({ ...base, notice: null, results: { query: request.query, filters: request.filters, pages: [outcome.page], current: 1, next: outcome.next, live: true } })
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
        // Obtained pages stay; the service says what the chain can still give.
        this.set({
          ...base,
          notice: { kind: 'failed', request, error: outcome.error },
          results: request.kind === 'page' && results !== null ? { ...results, next: outcome.next } : results
        })
        return
      case 'unavailable':
        this.set({ ...base, notice: null, results: results === null ? null : { ...results, next: outcome.next } })
        return
      case 'cancelled':
        this.set({ ...base, notice: { kind: 'cancelled', request }, results: this.afterLostRequest(request) })
        return
      case 'closed':
        this.set({ ...base, notice: { kind: 'closed' }, results: results === null ? null : { ...results, live: false } })
        return
    }
  }

  private reject(seq: number, request: OnlineSearchRequest): void {
    if (this.disposed || seq !== this.seq) return
    // Whether an nmb-search next-page token was spent is unknown: it is never offered again.
    this.set({ ...this.state, pending: null, notice: { kind: 'internal', request }, results: this.afterLostRequest(request) })
  }
}

/**
 * The online side of one search history entry: the channel it shows and one independent session
 * per channel (query, pages, pending request, view). Choosing a channel sends nothing and never
 * touches the other channel's session; its late responses keep landing there.
 */
export class OnlineSearchEntry {
  private shown: SearchChannel
  private readonly sessions = new Map<SearchChannel, OnlineSearchSession>()
  private readonly listeners = new Set<() => void>()
  private disposed = false

  constructor(
    private readonly entryKey: number,
    channel: SearchChannel
  ) {
    this.shown = channel
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getChannel = (): SearchChannel => this.shown

  /** Shows `channel`; returns whether it changed. No request is sent. */
  setChannel(channel: SearchChannel): boolean {
    if (this.disposed || channel === this.shown) return false
    this.shown = channel
    for (const listener of this.listeners) listener()
    return true
  }

  /** The channel's session, created on first use. */
  session(channel: SearchChannel): OnlineSearchSession {
    let session = this.sessions.get(channel)
    if (session === undefined) {
      session = new OnlineSearchSession(this.entryKey, channel)
      this.sessions.set(channel, session)
      if (this.disposed) session.dispose()
    }
    return session
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    for (const session of this.sessions.values()) session.dispose()
  }
}

/**
 * Online search state of all search history entries, keyed by entry key. The shell releases an
 * entry when it leaves every tab's history; nothing is persisted (the channel preference itself is
 * a setting).
 */
export class OnlineSearchSessions {
  private readonly entries = new Map<number, OnlineSearchEntry>()

  /** The entry's online side, created on first use showing `channel`. */
  entry(entryKey: number, channel: SearchChannel): OnlineSearchEntry {
    let entry = this.entries.get(entryKey)
    if (entry === undefined) {
      entry = new OnlineSearchEntry(entryKey, channel)
      this.entries.set(entryKey, entry)
    }
    return entry
  }

  /** Releases every entry not in `live`. */
  retain(live: ReadonlySet<number>): void {
    for (const [key, entry] of this.entries) {
      if (live.has(key)) continue
      entry.dispose()
      this.entries.delete(key)
    }
  }
}
