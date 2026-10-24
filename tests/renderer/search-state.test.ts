import { describe, expect, it } from 'vitest'
import type { Post } from '../../src/shared/forum'
import type { SearchBatch, SearchFetch, SearchHit } from '../../src/shared/search'
import {
  commitsJump,
  HITS_PER_STEP,
  initialSearchState,
  NO_CONTENT_FILTERS,
  pruneReturns,
  searchReducer,
  shouldContinue,
  tabSearchOf,
  type SearchAction,
  type SearchReturn,
  type SearchState
} from '../../src/renderer/src/features/search/searchState'
import { activeTab, currentEntry, initialTabsState, tabsReducer, type TabsAction, type TabsState } from '../../src/renderer/src/features/tabs/tabsState'

const run = (state: SearchState, ...actions: SearchAction[]) => actions.reduce(searchReducer, state)
const runTabs = (state: TabsState, ...actions: TabsAction[]) => actions.reduce(tabsReducer, state)

function hit(postId: string): SearchHit {
  return {
    retention: 'cache',
    postId,
    threadId: '100',
    threadTitle: null,
    title: null,
    excerpt: `text ${postId}`,
    forumId: '4',
    createdAt: '2026-10-01(三)12:00:00',
    hasImage: null,
    uncertainFilters: false,
    location: { page: 1, mode: 'all', fetchedAt: '2026-10-01T04:00:00Z', source: 'page' }
  }
}

function batch(ids: string[], done = false): SearchBatch {
  return { hits: ids.map(hit), done, coverage: { retainedPosts: 10, retainedThreads: 2, thread: null } }
}

const start = (operationId: string, query = 'abc'): SearchAction => ({
  type: 'run-start',
  tabId: 1,
  view: 'local',
  operationId,
  query,
  scope: { kind: 'local' },
  filters: NO_CONTENT_FILTERS
})

const localRun = (state: SearchState) => state.tabs[1]?.local.run ?? null

describe('search sessions', () => {
  it('drops batches and refusals of a superseded session; a stopped session keeps exactly its hits', () => {
    let state = run(initialSearchState, { type: 'open', tabId: 1, view: 'local' }, start('a'))
    state = run(state, start('b'))
    state = run(state, { type: 'run-batch', tabId: 1, view: 'local', operationId: 'a', batch: batch(['1', '2'], true) })
    state = run(state, { type: 'run-refused', tabId: 1, view: 'local', operationId: 'a', reason: 'index-unavailable' })
    expect(localRun(state)).toMatchObject({ operationId: 'b', hits: [], status: 'running', failure: null })

    state = run(state, { type: 'run-batch', tabId: 1, view: 'local', operationId: 'b', batch: batch(['3']) })
    state = run(state, { type: 'run-stop', tabId: 1, view: 'local' })
    // The batch that was in flight when the user stopped arrives late: not shown.
    state = run(state, { type: 'run-batch', tabId: 1, view: 'local', operationId: 'b', batch: batch(['4']) })
    expect(localRun(state)?.hits.map((item) => item.postId)).toEqual(['3'])
    expect(localRun(state)?.status).toBe('stopped')
    expect(shouldContinue(localRun(state))).toBe(false)
  })

  it('pauses on close and on enough hits, keeps a batch that lands while paused, resumes the same session', () => {
    let state = run(initialSearchState, { type: 'open', tabId: 1, view: 'local' }, start('a'))
    state = run(state, { type: 'close' })
    expect(localRun(state)).toMatchObject({ status: 'paused', waiting: true })
    state = run(state, { type: 'run-batch', tabId: 1, view: 'local', operationId: 'a', batch: batch(['1']) })
    expect(localRun(state)).toMatchObject({ status: 'paused', waiting: false })
    expect(localRun(state)?.hits).toHaveLength(1)
    expect(shouldContinue(localRun(state))).toBe(false)

    state = run(state, { type: 'run-more', tabId: 1, view: 'local' })
    expect(shouldContinue(localRun(state))).toBe(true)
    const many = Array.from({ length: HITS_PER_STEP * 2 }, (_, index) => String(1000 + index))
    state = run(
      state,
      { type: 'run-next', tabId: 1, view: 'local', operationId: 'a' },
      { type: 'run-batch', tabId: 1, view: 'local', operationId: 'a', batch: batch(many) }
    )
    expect(localRun(state)?.status).toBe('paused')
    // Duplicate post IDs from later batches are not shown twice; the end is reported once.
    state = run(state, { type: 'run-more', tabId: 1, view: 'local' }, { type: 'run-batch', tabId: 1, view: 'local', operationId: 'a', batch: batch(['1'], true) })
    expect(localRun(state)?.hits).toHaveLength(1 + many.length)
    expect(localRun(state)?.status).toBe('done')
  })

  it('keeps a thread search for the same thread, and starts afresh for another one without losing text or filters', () => {
    const scope = { threadId: '100', mode: 'po' as const, title: null }
    const filters = { ...NO_CONTENT_FILTERS, image: 'with' as const }
    let state = run(
      initialSearchState,
      { type: 'open', tabId: 1, view: 'thread', scope },
      { type: 'input', tabId: 1, view: 'thread', input: '饼干' },
      { type: 'filters', tabId: 1, view: 'thread', filters },
      { type: 'thread-mode', tabId: 1, mode: 'all' },
      { type: 'run-start', tabId: 1, view: 'thread', operationId: 't1', query: '饼干', scope: { kind: 'thread', threadId: '100', mode: 'all' }, filters },
      { type: 'fetch-start', tabId: 1, operationId: 'f1' },
      { type: 'close' }
    )
    // Ctrl+F on the same thread (now read in PO mode) keeps the results and the mode chosen in the sheet.
    state = run(state, { type: 'open', tabId: 1, view: 'thread', scope })
    expect(state.tabs[1]?.thread).toMatchObject({ scope: { threadId: '100', mode: 'all' }, run: { operationId: 't1' }, fetch: { operationId: 'f1' } })

    state = run(state, { type: 'open', tabId: 1, view: 'thread', scope: { threadId: '200', mode: 'all', title: null } })
    expect(state.tabs[1]?.thread).toMatchObject({ input: '饼干', filters, run: null, fetch: null, scope: { threadId: '200' } })
  })

  it('applies only the current fetch status and never reverts a finished fetch to running', () => {
    const scope = { threadId: '100', mode: 'all' as const, title: null }
    const status = (operationId: string, state: SearchFetch['state'], pages: number[]): SearchFetch => ({
      operationId,
      threadId: '100',
      state,
      pages,
      failedPage: null,
      error: null,
      coverage: { threadId: '100', mode: 'all', pages: [], gaps: [], endCandidatePage: null, reportedReplyCount: null, obtainedReplyCount: 0, countMismatch: null }
    })
    let state = run(initialSearchState, { type: 'open', tabId: 1, view: 'thread', scope }, { type: 'fetch-start', tabId: 1, operationId: 'f1' })
    state = run(state, { type: 'fetch-start', tabId: 1, operationId: 'f2' })
    state = run(state, { type: 'fetch-status', tabId: 1, operationId: 'f1', status: status('f1', 'stopped', [1, 2, 3]) })
    expect(state.tabs[1]?.thread.fetch?.status).toBeNull()
    state = run(
      state,
      { type: 'fetch-status', tabId: 1, operationId: 'f2', status: status('f2', 'cancelled', [1, 2]) },
      { type: 'fetch-status', tabId: 1, operationId: 'f2', status: status('f2', 'running', [1, 2]) }
    )
    expect(state.tabs[1]?.thread.fetch?.status).toMatchObject({ state: 'cancelled', pages: [1, 2] })
  })
})

describe('locating search hits', () => {
  const head = { id: '100' } as Post

  it('ignores a result of an earlier choice and returns to the view and hit last chosen', () => {
    let state = run(
      initialSearchState,
      { type: 'open', tabId: 1, view: 'local' },
      { type: 'locate-start', tabId: 1, view: 'local', postId: '101', entryKey: 1, intent: 'navigate' }
    )
    const first = state.tabs[1]!.locate!.seq
    state = run(state, { type: 'locate-start', tabId: 1, view: 'local', postId: '102', entryKey: 1, intent: 'navigate' })
    state = run(state, { type: 'locate-done', tabId: 1, seq: first, result: { status: 'unknown-thread' } })
    expect(state.tabs[1]?.locate).toMatchObject({ postId: '102', result: null })

    state = run(state, { type: 'view', tabId: 1, view: 'thread' }, { type: 'close' })
    expect(state.tabs[1]?.locate).toBeNull()
    state = run(state, { type: 'reopen', tabId: 1 })
    expect(state).toMatchObject({ openTab: 1, focus: 'hit', tabs: { 1: { view: 'local', lastHit: { view: 'local', postId: '102' } } } })
  })

  it('cancelling 打开原串 goes back to the thread-known result; its late result is dropped', () => {
    let state = run(
      initialSearchState,
      { type: 'open', tabId: 1, view: 'local' },
      { type: 'locate-start', tabId: 1, view: 'local', postId: '150', entryKey: 1, intent: 'navigate' }
    )
    const seq = state.tabs[1]!.locate!.seq
    const known = { status: 'thread-known' as const, threadId: '100', head }
    state = run(state, { type: 'locate-done', tabId: 1, seq, result: known }, { type: 'open-thread-start', tabId: 1, seq })
    const opening = state.tabs[1]!.locate!.seq
    state = run(state, { type: 'locate-cancel', tabId: 1 })
    expect(state.tabs[1]?.locate).toMatchObject({ intent: 'navigate', result: known })
    state = run(state, { type: 'locate-done', tabId: 1, seq: opening, result: { status: 'failed', threadId: '100', error: { kind: 'network', detail: 'timeout' } } })
    expect(state.tabs[1]?.locate?.result).toEqual(known)
  })

  it('opens a hit as a search step from an empty new tab, and back restores the source entry', () => {
    let tabs = initialTabsState(true)
    const tab = activeTab(tabs)
    const source = currentEntry(tab)
    const thread = { threadId: '100', head: null, target: { postId: '150', page: 3, mode: 'all' as const }, snapshot: null, unlocatedPostId: null }
    tabs = runTabs(tabs, { type: 'search-navigate', tabId: tab.id, entryKey: source.key, source: null, thread })
    expect(currentEntry(activeTab(tabs))).toMatchObject({ kind: 'thread', origin: 'local-search', thread: { target: { postId: '150', page: 3 } } })
    // A stale commit (entry changed meanwhile) is ignored.
    expect(runTabs(tabs, { type: 'search-navigate', tabId: tab.id, entryKey: source.key, source: null, thread })).toBe(tabs)
    tabs = runTabs(tabs, { type: 'back', tabId: tab.id })
    expect(currentEntry(activeTab(tabs))).toMatchObject({ key: source.key, kind: 'list', feed: null, origin: null })
  })

  it('a retry after a failed jump only resolves: its success is shown, not jumped to; choosing the hit jumps', () => {
    const located = {
      status: 'located' as const,
      threadId: '100',
      head,
      target: { postId: '500', page: 2, mode: 'all' as const },
      source: 'fresh' as const,
      networkError: null
    }
    let state = run(
      initialSearchState,
      { type: 'open', tabId: 1, view: 'local' },
      { type: 'locate-start', tabId: 1, view: 'local', postId: '500', entryKey: 1, intent: 'navigate' }
    )
    const failedSeq = state.tabs[1]!.locate!.seq
    state = run(state, {
      type: 'locate-done',
      tabId: 1,
      seq: failedSeq,
      result: { status: 'failed', threadId: '100', error: { kind: 'network', detail: 'http-status', httpStatus: 503 } }
    })

    state = run(state, { type: 'locate-start', tabId: 1, view: 'local', postId: '500', entryKey: 1, intent: 'resolve' })
    const retry = state.tabs[1]!.locate!
    expect(commitsJump(retry, located)).toBe(false)
    state = run(state, { type: 'locate-done', tabId: 1, seq: retry.seq, result: located })
    expect(state).toMatchObject({ openTab: 1, tabs: { 1: { locate: { intent: 'resolve', result: located } } } })

    // Choosing the hit afterwards is a new, fresh locate that does jump on success.
    state = run(state, { type: 'locate-start', tabId: 1, view: 'local', postId: '500', entryKey: 1, intent: 'navigate' })
    const chosen = state.tabs[1]!.locate!
    expect(chosen).toMatchObject({ intent: 'navigate', result: null })
    expect(chosen.seq).not.toBe(retry.seq)
    expect(commitsJump(chosen, located)).toBe(true)
    expect(commitsJump(chosen, { status: 'unknown-thread' })).toBe(false)
  })
})

describe('returning to search results through history', () => {
  const head = { id: '1' } as Post
  const thread = (threadId: string, postId: string) => ({
    threadId,
    head,
    target: { postId, page: 1, mode: 'all' as const },
    snapshot: null,
    unlocatedPostId: null
  })

  /** What the shell does when a located hit is opened: close, remember the step's search, push the hit. */
  function openHit(search: SearchState, tabs: TabsState, returns: Map<number, SearchReturn>, postId: string, threadId: string) {
    const tab = activeTab(tabs)
    const entryKey = currentEntry(tab).key
    let next = run(search, { type: 'locate-start', tabId: tab.id, view: 'local', postId, entryKey, intent: 'navigate' })
    next = run(next, { type: 'close' })
    returns.set(entryKey, { tabId: tab.id, search: tabSearchOf(next, tab.id) })
    return { search: next, tabs: runTabs(tabs, { type: 'search-navigate', tabId: tab.id, entryKey, source: null, thread: thread(threadId, postId) }) }
  }

  /** Back from a search step: the previous entry gets the search it had when the hit was opened. */
  function back(search: SearchState, tabs: TabsState, returns: Map<number, SearchReturn>) {
    const tab = activeTab(tabs)
    const sourceKey = tab.entries[tab.index - 1]!.key
    const saved = returns.get(sourceKey)!
    expect(saved.tabId).toBe(tab.id)
    return { search: run(search, { type: 'restore', tabId: tab.id, snapshot: saved.search }), tabs: runTabs(tabs, { type: 'back', tabId: tab.id }) }
  }

  it('each back step shows the search of its own step, focused on the hit opened from it', () => {
    const returns = new Map<number, SearchReturn>()
    let tabs = initialTabsState(true)
    const tabId = activeTab(tabs).id
    let search = run(
      initialSearchState,
      { type: 'open', tabId, view: 'local' },
      start('a', '松果'),
      { type: 'run-batch', tabId, view: 'local', operationId: 'a', batch: batch(['500']) }
    )
    ;({ search, tabs } = openHit(search, tabs, returns, '500', '100'))
    search = run(
      search,
      { type: 'open', tabId, view: 'local' },
      start('b', '离线持有'),
      { type: 'run-batch', tabId, view: 'local', operationId: 'b', batch: batch(['200'], true) }
    )
    ;({ search, tabs } = openHit(search, tabs, returns, '200', '300'))

    ;({ search, tabs } = back(search, tabs, returns))
    expect(search).toMatchObject({ openTab: tabId, focus: 'hit', tabs: { [tabId]: { lastHit: { postId: '200' }, local: { run: { query: '离线持有', status: 'done' } } } } })
    search = run(search, { type: 'close' })

    ;({ search, tabs } = back(search, tabs, returns))
    expect(currentEntry(activeTab(tabs))).toMatchObject({ kind: 'list', feed: null })
    // 松果 was replaced (and cancelled) by the later search: back with its hits, stopped, not re-run.
    expect(search).toMatchObject({
      openTab: tabId,
      focus: 'hit',
      tabs: { [tabId]: { lastHit: { postId: '500' }, locate: null, local: { run: { query: '松果', operationId: 'a', status: 'stopped', waiting: false } } } }
    })
    expect(search.tabs[tabId]?.local.run?.hits.map((item) => item.postId)).toEqual(['500'])

    // Forward to the second step and back again restores the first step's own search again.
    tabs = runTabs(tabs, { type: 'forward', tabId })
    ;({ search, tabs } = back(search, tabs, returns))
    expect(search.tabs[tabId]?.local.run?.query).toBe('松果')
  })

  it('a session still current is kept as it is now; text from a sheet replaced by a restore is dropped', () => {
    const returns = new Map<number, SearchReturn>()
    let tabs = initialTabsState(false)
    const tabId = activeTab(tabs).id
    let search = run(
      initialSearchState,
      { type: 'open', tabId, view: 'local' },
      start('a', 'x'),
      { type: 'run-batch', tabId, view: 'local', operationId: 'a', batch: batch(['1']) }
    )
    ;({ search, tabs } = openHit(search, tabs, returns, '1', '100'))
    // The paused session got another batch after the hit was opened (it is still the tab's session).
    search = run(search, { type: 'run-batch', tabId, view: 'local', operationId: 'a', batch: batch(['2']) })
    ;({ search, tabs } = back(search, tabs, returns))
    expect(search.tabs[tabId]?.local.run).toMatchObject({ operationId: 'a', status: 'paused' })
    expect(search.tabs[tabId]?.local.run?.hits.map((item) => item.postId)).toEqual(['1', '2'])

    const stale = run(search, { type: 'input', tabId, view: 'local', input: 'typed before', restoreSeq: search.restoreSeq - 1 })
    expect(stale).toBe(search)
  })

  it('a step leaving the history or its tab closing forgets its search; other tabs never use it', () => {
    const returns = new Map<number, SearchReturn>()
    let tabs = initialTabsState(true)
    const tabId = activeTab(tabs).id
    const firstKey = currentEntry(activeTab(tabs)).key
    let search = run(initialSearchState, { type: 'open', tabId, view: 'local' }, start('a', 'x'))
    ;({ search, tabs } = openHit(search, tabs, returns, '1', '100'))
    const secondKey = currentEntry(activeTab(tabs)).key
    ;({ search, tabs } = openHit(run(search, { type: 'open', tabId, view: 'local' }), tabs, returns, '2', '200'))

    tabs = runTabs(tabs, { type: 'open-tab', entry: { kind: 'list', feed: null }, split: true, background: false })
    pruneReturns(returns, tabs)
    expect([...returns.keys()].sort()).toEqual([firstKey, secondKey].sort())
    expect(activeTab(tabs).entries.some((entry) => returns.has(entry.key))).toBe(false)

    // Back to the first step, then a new navigation replaces the forward branch.
    tabs = runTabs(tabs, { type: 'activate', tabId }, { type: 'back', tabId }, { type: 'back', tabId })
    tabs = runTabs(tabs, { type: 'navigate', tabId, entry: { kind: 'list', feed: { kind: 'forum', id: '4' } } })
    pruneReturns(returns, tabs)
    expect([...returns.keys()]).toEqual([firstKey])

    tabs = runTabs(tabs, { type: 'close-tab', tabId, split: true })
    pruneReturns(returns, tabs)
    expect(returns.size).toBe(0)
  })
})
