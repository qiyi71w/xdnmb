import type { QuoteLocation } from '../../../../shared/api'
import type { PostId, ReadingMode, ThreadId } from '../../../../shared/forum'
import type { ContentFilters, SearchBatch, SearchCoverage, SearchFetch, SearchFilters, SearchHit, SearchResult, SearchScope } from '../../../../shared/search'
import type { TabsState } from '../tabs/tabsState'

/** The two searches of a tab: everything retained on this machine, or the thread being read. */
export type SearchView = 'local' | 'thread'

export const NO_CONTENT_FILTERS: ContentFilters = { forumId: null, fromDate: null, toDate: null, image: 'any' }
/** The search page's filters: the list filters plus 发言类型. */
export const NO_SEARCH_FILTERS: SearchFilters = { ...NO_CONTENT_FILTERS, postKind: 'any' }

/** Hits a run collects before it pauses by itself; 继续搜索 asks for this many more. */
export const HITS_PER_STEP = 40

type Refusal = Extract<SearchResult<never>, { ok: false }>['reason']

/** Why a run, fetch or rebuild ended without its value; `internal`: the IPC call itself rejected. */
export type SearchFailure = Exclude<Refusal, 'cancelled'> | 'internal'

/**
 * - `running`: batches are requested one after another until `want` hits or the end.
 * - `paused`: enough hits for now, or the sheet closed; 继续搜索 resumes the same session.
 * - `done`: the session reported its end. `stopped`: the user stopped it (session cancelled).
 * - `failed`: a refusal (`failure`); hits obtained before it stay.
 */
export type RunStatus = 'running' | 'paused' | 'done' | 'stopped' | 'failed'

/** One submitted query: a fixed main-process session (query, scope and filters never change). */
export interface SearchRun {
  operationId: string
  query: string
  scope: SearchScope
  filters: SearchFilters
  hits: SearchHit[]
  coverage: SearchCoverage | null
  status: RunStatus
  failure: SearchFailure | null
  want: number
  /** A start/next call of this session is in flight. */
  waiting: boolean
}

/** What one view shows: the text being typed, the filters being edited and the last run. */
export interface SearchSession {
  input: string
  filters: SearchFilters
  run: SearchRun | null
}

/** Thread searched by the thread view and the mode searched (independent of the reading mode). */
export interface ThreadScope {
  threadId: ThreadId
  mode: ReadingMode
  title: string | null
}

/** Explicit 获取完整串: `status` null until the start call answered. */
export interface FetchState {
  operationId: string
  status: SearchFetch | null
  failure: SearchFailure | null
  cancelling: boolean
}

/**
 * Locating a chosen hit through the quote locate primitive. `result` null while running. A
 * `navigate` locate (choosing the hit) commits the jump only while `entryKey` is still the tab's
 * current entry and this `seq` is current; a `resolve` locate (重试 after a failure) only finds out
 * where the hit is now and never performs the earlier failed jump; choosing the hit again does.
 */
export interface HitLocate {
  seq: number
  view: SearchView
  postId: PostId
  entryKey: number
  intent: 'navigate' | 'resolve' | 'open-thread'
  result: QuoteLocation | null
  /** The IPC call rejected (not a forum read failure). */
  internal: boolean
  /** Set while 打开原串 runs: the `thread-known` result it started from. */
  known?: Extract<QuoteLocation, { status: 'thread-known' }>
}

export interface TabSearch {
  view: SearchView
  local: SearchSession
  thread: SearchSession & { scope: ThreadScope | null; fetch: FetchState | null }
  locate: HitLocate | null
  /** Hit last chosen: focus goes back to it when the results are shown again. */
  lastHit: { view: SearchView; postId: PostId } | null
}

export type RebuildState =
  | { status: 'idle' }
  | { status: 'running'; operationId: string; cancelling: boolean }
  | { status: 'done'; rebuilt: boolean }
  | { status: 'cancelled' }
  | { status: 'failed'; failure: SearchFailure }

export interface SearchState {
  tabs: Readonly<Record<number, TabSearch>>
  /** Tab whose search sheet is shown. */
  openTab: number | null
  /** Where focus goes when the sheet is shown: the query field, or back to the last chosen hit. */
  focus: 'input' | 'hit'
  /** Bumped whenever the sheet is asked to take focus again while already shown. */
  focusSeq: number
  /** Bumped when a history step's search is restored: the open sheet's typed text is replaced. */
  restoreSeq: number
  /** The index is shared by every tab. */
  rebuild: RebuildState
  nextSeq: number
}

export type SearchAction =
  | { type: 'open'; tabId: number; view: 'local' }
  /** `scope` is the thread on screen and the mode it is read in; another thread starts afresh. */
  | { type: 'open'; tabId: number; view: 'thread'; scope: ThreadScope }
  /** Back from a hit: shows the tab's results again, focus on the hit that was chosen. */
  | { type: 'reopen'; tabId: number }
  /**
   * Back to the entry a hit was opened from: the tab's search becomes what it was when that hit was
   * opened (`snapshot`), shown with focus on that hit. Nothing is searched or fetched again.
   */
  | { type: 'restore'; tabId: number; snapshot: TabSearch }
  | { type: 'close' }
  | { type: 'view'; tabId: number; view: SearchView }
  /** `restoreSeq`: text typed before that restore (a late write of a replaced sheet) is ignored. */
  | { type: 'input'; tabId: number; view: SearchView; input: string; restoreSeq?: number }
  | { type: 'filters'; tabId: number; view: SearchView; filters: SearchFilters }
  | { type: 'thread-mode'; tabId: number; mode: ReadingMode }
  | { type: 'run-start'; tabId: number; view: SearchView; operationId: string; query: string; scope: SearchScope; filters: SearchFilters }
  | { type: 'run-next'; tabId: number; view: SearchView; operationId: string }
  | { type: 'run-batch'; tabId: number; view: SearchView; operationId: string; batch: SearchBatch }
  | { type: 'run-refused'; tabId: number; view: SearchView; operationId: string; reason: Refusal | 'internal' }
  | { type: 'run-more'; tabId: number; view: SearchView }
  | { type: 'run-stop'; tabId: number; view: SearchView }
  | { type: 'fetch-start'; tabId: number; operationId: string }
  | { type: 'fetch-status'; tabId: number; operationId: string; status: SearchFetch }
  | { type: 'fetch-refused'; tabId: number; operationId: string; reason: Refusal | 'internal' }
  | { type: 'fetch-cancelling'; tabId: number; operationId: string }
  | { type: 'locate-start'; tabId: number; view: SearchView; postId: PostId; entryKey: number; intent: 'navigate' | 'resolve' }
  | { type: 'open-thread-start'; tabId: number; seq: number }
  | { type: 'locate-done'; tabId: number; seq: number; result: QuoteLocation }
  | { type: 'locate-internal'; tabId: number; seq: number }
  /** Esc / another hit / a committed jump: the running locate is dropped. */
  | { type: 'locate-cancel'; tabId: number }
  | { type: 'rebuild-start'; operationId: string }
  | { type: 'rebuild-cancelling'; operationId: string }
  | { type: 'rebuild-end'; operationId: string; outcome: { rebuilt: boolean } | Refusal | 'internal' }
  /** The tab closed: everything it ran is forgotten. */
  | { type: 'dispose'; tabId: number }

export const initialSearchState: SearchState = {
  tabs: {},
  openTab: null,
  focus: 'input',
  focusSeq: 0,
  restoreSeq: 0,
  rebuild: { status: 'idle' },
  nextSeq: 1
}

const emptySession = (): SearchSession => ({ input: '', filters: NO_SEARCH_FILTERS, run: null })

export function emptyTabSearch(): TabSearch {
  return { view: 'local', local: emptySession(), thread: { ...emptySession(), scope: null, fetch: null }, locate: null, lastHit: null }
}

export function tabSearchOf(state: SearchState, tabId: number): TabSearch {
  return state.tabs[tabId] ?? emptyTabSearch()
}

/** The session-level operation IDs of a tab, for cancelling them. */
export function operationsOf(tab: TabSearch | undefined): string[] {
  if (tab === undefined) return []
  const ids: string[] = []
  for (const run of [tab.local.run, tab.thread.run]) if (run !== null && (run.waiting || run.status === 'running' || run.status === 'paused')) ids.push(run.operationId)
  if (tab.thread.fetch !== null && (tab.thread.fetch.status === null || tab.thread.fetch.status.state === 'running')) ids.push(tab.thread.fetch.operationId)
  return ids
}

/** Whether the driver should request the next batch of this run now. */
export function shouldContinue(run: SearchRun | null): boolean {
  return run !== null && run.status === 'running' && !run.waiting && run.hits.length < run.want
}

/** Whether `operationId` is the run of that view (results of any other session are stale). */
export function isCurrentRun(state: SearchState, tabId: number, view: SearchView, operationId: string): boolean {
  return state.tabs[tabId]?.[view].run?.operationId === operationId
}

export function isCurrentLocate(state: SearchState, tabId: number, seq: number): boolean {
  const locate = state.tabs[tabId]?.locate ?? null
  return locate !== null && locate.seq === seq && locate.result === null
}

/** Whether a located result of this locate performs the jump (a `resolve` retry never does). */
export function commitsJump(locate: HitLocate, result: QuoteLocation): boolean {
  return result.status === 'located' && locate.intent !== 'resolve'
}

/**
 * The tab's search restored from the snapshot taken when a hit was opened from that step. A session
 * still current in the tab keeps its latest state; a session replaced since then was cancelled when
 * it was replaced, so it comes back stopped with the hits it had. A fetch replaced while running
 * comes back cancelled with the pages it had reported. No locate is restored.
 */
export function restoreTabSearch(current: TabSearch, snapshot: TabSearch): TabSearch {
  const run = (before: SearchRun | null, now: SearchRun | null): SearchRun | null => {
    if (before === null) return null
    if (now !== null && now.operationId === before.operationId) return now
    const replacedLive = before.waiting || before.status === 'running' || before.status === 'paused'
    return replacedLive ? { ...before, status: 'stopped', waiting: false } : before
  }
  const nowFetch = current.thread.fetch
  const beforeFetch = snapshot.thread.fetch
  let fetch = beforeFetch
  if (beforeFetch !== null && nowFetch?.operationId === beforeFetch.operationId) fetch = nowFetch
  else if (beforeFetch !== null && beforeFetch.failure === null && (beforeFetch.status === null || beforeFetch.status.state === 'running')) {
    fetch = beforeFetch.status === null ? null : { ...beforeFetch, status: { ...beforeFetch.status, state: 'cancelled' }, cancelling: false }
  }
  return {
    view: snapshot.view,
    local: { ...snapshot.local, run: run(snapshot.local.run, current.local.run) },
    thread: { ...snapshot.thread, run: run(snapshot.thread.run, current.thread.run), fetch },
    locate: null,
    lastHit: snapshot.lastHit
  }
}

/** A tab's search as it was when a hit was opened from history entry `entryKey` of tab `tabId`. */
export interface SearchReturn {
  tabId: number
  search: TabSearch
}

/**
 * Drops returns whose entry is no longer in its own tab's history (forward branch replaced, tab
 * closed). Entry keys are unique across tabs, and the tab is checked too, so no tab restores
 * another's search.
 */
export function pruneReturns(returns: Map<number, SearchReturn>, tabs: TabsState): void {
  for (const [entryKey, saved] of returns) {
    const tab = tabs.tabs.find((item) => item.id === saved.tabId)
    if (tab === undefined || !tab.entries.some((entry) => entry.key === entryKey)) returns.delete(entryKey)
  }
}

export function threadScopeOf(scope: ThreadScope): SearchScope {
  return { kind: 'thread', threadId: scope.threadId, mode: scope.mode }
}

function withTab(state: SearchState, tabId: number, update: (tab: TabSearch) => TabSearch): SearchState {
  const before = tabSearchOf(state, tabId)
  const after = update(before)
  return after === before && state.tabs[tabId] !== undefined ? state : { ...state, tabs: { ...state.tabs, [tabId]: after } }
}

function withSession(tab: TabSearch, view: SearchView, update: (session: SearchSession) => SearchSession): TabSearch {
  if (view === 'local') {
    const next = update(tab.local)
    return next === tab.local ? tab : { ...tab, local: next }
  }
  const next = update(tab.thread)
  return next === tab.thread ? tab : { ...tab, thread: { ...tab.thread, ...next } }
}

function withRun(state: SearchState, tabId: number, view: SearchView, operationId: string | null, update: (run: SearchRun) => SearchRun): SearchState {
  const run = state.tabs[tabId]?.[view].run ?? null
  if (run === null || (operationId !== null && run.operationId !== operationId)) return state
  const next = update(run)
  return next === run ? state : withTab(state, tabId, (tab) => withSession(tab, view, (session) => ({ ...session, run: next })))
}

function appendHits(previous: SearchHit[], batch: SearchHit[]): SearchHit[] {
  if (batch.length === 0) return previous
  const seen = new Set(previous.map((hit) => hit.postId))
  const added = batch.filter((hit) => {
    if (seen.has(hit.postId)) return false
    seen.add(hit.postId)
    return true
  })
  return added.length === 0 ? previous : [...previous, ...added]
}

/** Pauses the runs a closing sheet leaves behind; a batch still in flight is kept when it lands. */
function pauseRuns(tab: TabSearch): TabSearch {
  const pause = (session: SearchSession): SearchSession =>
    session.run?.status === 'running' ? { ...session, run: { ...session.run, status: 'paused' } } : session
  return withSession(withSession(tab, 'local', pause), 'thread', pause)
}

export function searchReducer(state: SearchState, action: SearchAction): SearchState {
  switch (action.type) {
    case 'open': {
      const next = withTab(state, action.tabId, (tab) => {
        if (action.view === 'local') return tab.view === 'local' ? tab : { ...tab, view: 'local' }
        const previous = tab.thread.scope
        if (previous !== null && previous.threadId === action.scope.threadId) {
          // Same thread: its results, fetch and the mode chosen in the sheet stay.
          const scope = previous.title === null && action.scope.title !== null ? { ...previous, title: action.scope.title } : previous
          return { ...tab, view: 'thread', thread: scope === previous ? tab.thread : { ...tab.thread, scope } }
        }
        // Another thread: what was searched before belongs to the old one. Text and filters stay.
        const locate = tab.locate?.view === 'thread' ? null : tab.locate
        const lastHit = tab.lastHit?.view === 'thread' ? null : tab.lastHit
        return { ...tab, view: 'thread', thread: { ...tab.thread, run: null, scope: action.scope, fetch: null }, locate, lastHit }
      })
      return { ...next, openTab: action.tabId, focus: 'input', focusSeq: state.focusSeq + 1 }
    }
    case 'reopen': {
      const tab = state.tabs[action.tabId]
      if (tab === undefined) return state
      const view = tab.lastHit?.view ?? tab.view
      const tabs = view === tab.view ? state.tabs : { ...state.tabs, [action.tabId]: { ...tab, view } }
      return { ...state, tabs, openTab: action.tabId, focus: tab.lastHit !== null ? 'hit' : 'input', focusSeq: state.focusSeq + 1 }
    }
    case 'restore': {
      const restored = restoreTabSearch(tabSearchOf(state, action.tabId), action.snapshot)
      return {
        ...state,
        tabs: { ...state.tabs, [action.tabId]: restored },
        openTab: action.tabId,
        focus: restored.lastHit !== null ? 'hit' : 'input',
        focusSeq: state.focusSeq + 1,
        restoreSeq: state.restoreSeq + 1
      }
    }
    case 'close': {
      if (state.openTab === null) return state
      const closed = withTab(state, state.openTab, (tab) => ({ ...pauseRuns(tab), locate: null }))
      return { ...closed, openTab: null }
    }
    case 'view':
      return withTab(state, action.tabId, (tab) => {
        if (tab.view === action.view || (action.view === 'thread' && tab.thread.scope === null)) return tab
        return { ...tab, view: action.view }
      })
    case 'input':
      if (action.restoreSeq !== undefined && action.restoreSeq !== state.restoreSeq) return state
      return withTab(state, action.tabId, (tab) =>
        withSession(tab, action.view, (session) => (session.input === action.input ? session : { ...session, input: action.input }))
      )
    case 'filters':
      return withTab(state, action.tabId, (tab) => withSession(tab, action.view, (session) => ({ ...session, filters: action.filters })))
    case 'thread-mode':
      return withTab(state, action.tabId, (tab) => {
        const scope = tab.thread.scope
        if (scope === null || scope.mode === action.mode) return tab
        return { ...tab, thread: { ...tab.thread, scope: { ...scope, mode: action.mode } } }
      })
    case 'run-start':
      return withTab(state, action.tabId, (tab) =>
        withSession(tab, action.view, (session) => ({
          ...session,
          run: {
            operationId: action.operationId,
            query: action.query,
            scope: action.scope,
            filters: action.filters,
            hits: [],
            coverage: null,
            status: 'running',
            failure: null,
            want: HITS_PER_STEP,
            waiting: true
          }
        }))
      )
    case 'run-next':
      return withRun(state, action.tabId, action.view, action.operationId, (run) =>
        run.status === 'running' && !run.waiting ? { ...run, waiting: true } : run
      )
    case 'run-batch':
      return withRun(state, action.tabId, action.view, action.operationId, (run) => {
        // A stopped session's late batch is not shown: stopping keeps exactly what was on screen.
        if (run.status === 'stopped' || run.status === 'done' || run.status === 'failed') return run
        const hits = appendHits(run.hits, action.batch.hits)
        const status: RunStatus = action.batch.done ? 'done' : run.status === 'running' && hits.length >= run.want ? 'paused' : run.status
        return { ...run, hits, coverage: action.batch.coverage, status, waiting: false }
      })
    case 'run-refused':
      return withRun(state, action.tabId, action.view, action.operationId, (run) => {
        if (run.status === 'stopped' || run.status === 'done') return { ...run, waiting: false }
        if (action.reason === 'cancelled') return { ...run, status: 'stopped', waiting: false }
        return { ...run, status: 'failed', failure: action.reason, waiting: false }
      })
    case 'run-more':
      return withRun(state, action.tabId, action.view, null, (run) => {
        if (run.status !== 'paused' && run.status !== 'running') return run
        return { ...run, status: 'running', want: Math.max(run.want, run.hits.length) + HITS_PER_STEP }
      })
    case 'run-stop':
      return withRun(state, action.tabId, action.view, null, (run) =>
        run.status === 'running' || run.status === 'paused' ? { ...run, status: 'stopped', waiting: false } : run
      )
    case 'fetch-start':
      return withTab(state, action.tabId, (tab) =>
        tab.thread.scope === null
          ? tab
          : { ...tab, thread: { ...tab.thread, fetch: { operationId: action.operationId, status: null, failure: null, cancelling: false } } }
      )
    case 'fetch-status':
      return withTab(state, action.tabId, (tab) => {
        const fetch = tab.thread.fetch
        if (fetch === null || fetch.operationId !== action.operationId || action.status.operationId !== action.operationId) return tab
        if (fetch.status !== null && fetch.status.state !== 'running') return tab
        return { ...tab, thread: { ...tab.thread, fetch: { ...fetch, status: action.status } } }
      })
    case 'fetch-refused':
      return withTab(state, action.tabId, (tab) => {
        const fetch = tab.thread.fetch
        if (fetch === null || fetch.operationId !== action.operationId) return tab
        if (fetch.status !== null && fetch.status.state !== 'running') return tab
        const failure = action.reason === 'cancelled' ? null : action.reason
        // A refused status poll keeps the last progress it showed.
        return { ...tab, thread: { ...tab.thread, fetch: { ...fetch, failure, cancelling: false } } }
      })
    case 'fetch-cancelling':
      return withTab(state, action.tabId, (tab) => {
        const fetch = tab.thread.fetch
        if (fetch === null || fetch.operationId !== action.operationId) return tab
        return { ...tab, thread: { ...tab.thread, fetch: { ...fetch, cancelling: true } } }
      })
    case 'locate-start': {
      const seq = state.nextSeq
      const next = withTab(state, action.tabId, (tab) => ({
        ...tab,
        locate: { seq, view: action.view, postId: action.postId, entryKey: action.entryKey, intent: action.intent, result: null, internal: false },
        lastHit: { view: action.view, postId: action.postId }
      }))
      return { ...next, nextSeq: seq + 1 }
    }
    case 'open-thread-start': {
      const locate = state.tabs[action.tabId]?.locate ?? null
      const known = locate?.result
      if (locate === null || locate.seq !== action.seq || known?.status !== 'thread-known') return state
      const seq = state.nextSeq
      const next = withTab(state, action.tabId, (tab) => ({ ...tab, locate: { ...locate, seq, intent: 'open-thread', result: null, internal: false, known } }))
      return { ...next, nextSeq: seq + 1 }
    }
    case 'locate-done':
      if (!isCurrentLocate(state, action.tabId, action.seq) || action.result.status === 'cancelled') return state
      return withTab(state, action.tabId, (tab) => ({ ...tab, locate: { ...(tab.locate as HitLocate), result: action.result } }))
    case 'locate-internal':
      if (!isCurrentLocate(state, action.tabId, action.seq)) return state
      return withTab(state, action.tabId, (tab) => {
        const locate = tab.locate as HitLocate
        // A rejected 打开原串 goes back to what was known before it.
        if (locate.known !== undefined) return { ...tab, locate: { ...locate, intent: 'navigate', result: locate.known, internal: true, known: undefined } }
        return { ...tab, locate: { ...locate, internal: true } }
      })
    case 'locate-cancel':
      return withTab(state, action.tabId, (tab) => {
        const locate = tab.locate
        if (locate === null) return tab
        // Cancelling 打开原串 goes back to the thread-known result, so it can be chosen again.
        if (locate.result === null && locate.known !== undefined) return { ...tab, locate: { ...locate, intent: 'navigate', result: locate.known, known: undefined } }
        return { ...tab, locate: null }
      })
    case 'rebuild-start':
      return state.rebuild.status === 'running' ? state : { ...state, rebuild: { status: 'running', operationId: action.operationId, cancelling: false } }
    case 'rebuild-cancelling':
      return state.rebuild.status === 'running' && state.rebuild.operationId === action.operationId
        ? { ...state, rebuild: { ...state.rebuild, cancelling: true } }
        : state
    case 'rebuild-end': {
      if (state.rebuild.status !== 'running' || state.rebuild.operationId !== action.operationId) return state
      const outcome = action.outcome
      const rebuild: RebuildState =
        typeof outcome === 'object'
          ? { status: 'done', rebuilt: outcome.rebuilt }
          : outcome === 'cancelled'
            ? { status: 'cancelled' }
            : { status: 'failed', failure: outcome }
      return { ...state, rebuild }
    }
    case 'dispose': {
      if (state.tabs[action.tabId] === undefined && state.openTab !== action.tabId) return state
      const tabs = { ...state.tabs }
      delete tabs[action.tabId]
      return { ...state, tabs, openTab: state.openTab === action.tabId ? null : state.openTab }
    }
  }
}
