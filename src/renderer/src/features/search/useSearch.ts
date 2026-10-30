import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { QuoteLocation } from '../../../../shared/api'
import type { ReadingMode } from '../../../../shared/forum'
import type { SearchFilters, SearchHit, SearchScope } from '../../../../shared/search'
import type { ContentRegistry } from '../tabs/contentRegistry'
import { currentEntry, type Tab, type TabEntry, type TabsAction, type TabsState, type ThreadOpen } from '../tabs/tabsState'
import { savedStart, startPage } from '../thread/readingStart'
import {
  commitsJump,
  initialSearchState,
  isCurrentLocate,
  operationsOf,
  pruneReturns,
  searchReducer,
  shouldContinue,
  tabSearchOf,
  threadScopeOf,
  type SearchAction,
  type SearchReturn,
  type SearchState,
  type SearchView,
  type RebuildState,
  type ThreadScope
} from './searchState'

/** Status polls of a running full-thread fetch. */
const POLL_MS = 700
/** Upper bound of a query, as the search service accepts it (UTF-16 code units). */
export const MAX_QUERY_LENGTH = 512

const locateOperation = (seq: number) => `search-locate-${seq}`

function cancelSearch(operationId: string): void {
  window.xidao.search.cancel({ operationId }).catch(() => undefined)
}

function cancelRead(operationId: string): void {
  window.xidao.reading.cancel({ operationId }).catch(() => undefined)
}
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  window.setTimeout(resolve, ms)
  return promise
}

/** Dates the service would refuse: a start after the end matches nothing anyway. */
export function filtersSearchable(filters: SearchFilters): boolean {
  return filters.fromDate === null || filters.toDate === null || filters.fromDate <= filters.toDate
}

interface Options {
  tabs: TabsState | null
  getTabs: () => TabsState | null
  dispatch: (action: TabsAction) => void
  registry: ContentRegistry
  /** A hit's thread was pushed onto the tab's history: its reader should take focus. */
  onCommitted: (tabId: number) => void
}

export type SearchOpen = { view: 'local' } | { view: 'thread'; scope: ThreadScope }

/**
 * App-level local / thread search. Each tab has its own sessions, filters and results,
 * kept while the sheet is closed and after a hit was opened, so 返回搜索结果 shows them again.
 * Every async result is checked against the current operation ID or locate `seq` before it is
 * applied; superseded and stopped sessions are cancelled in the main process. Nothing here marks
 * anything read or records a visit: hits are located with the quote locate primitive and opened
 * through the tab history like a located quote.
 */
export function useSearch(options: Options) {
  const opts = useRef(options)
  useLayoutEffect(() => {
    opts.current = options
  })

  const [state, setState] = useState<SearchState>(initialSearchState)
  const stateRef = useRef<SearchState>(initialSearchState)
  const apply = useCallback((action: SearchAction): SearchState => {
    const next = searchReducer(stateRef.current, action)
    if (next !== stateRef.current) {
      stateRef.current = next
      setState(next)
    }
    return next
  }, [])

  // ---------- Runs ----------
  /** Requests batches of a run one at a time while it still wants hits; yields between batches. */
  const pump = useCallback(
    async (tabId: number, view: SearchView, operationId: string) => {
      for (;;) {
        const run = stateRef.current.tabs[tabId]?.[view].run ?? null
        if (run === null || run.operationId !== operationId || !shouldContinue(run)) return
        apply({ type: 'run-next', tabId, view, operationId })
        try {
          const result = await window.xidao.search.next({ operationId })
          if (result.ok) apply({ type: 'run-batch', tabId, view, operationId, batch: result.value })
          else apply({ type: 'run-refused', tabId, view, operationId, reason: result.reason })
        } catch {
          apply({ type: 'run-refused', tabId, view, operationId, reason: 'internal' })
          return
        }
        // Let input and rendering run before the next batch.
        await sleep(0)
      }
    },
    [apply]
  )

  /** Starts a new fixed session for the view; any earlier one of that view is cancelled. */
  const submit = useCallback(
    (tabId: number, view: SearchView, queryOverride?: string) => {
      const tab = tabSearchOf(stateRef.current, tabId)
      const session = tab[view]
      const query = (queryOverride ?? session.input).trim()
      if (query === '' || query.length > MAX_QUERY_LENGTH || !filtersSearchable(session.filters)) return
      let scope: SearchScope
      if (view === 'local') scope = { kind: 'local' }
      else if (tab.thread.scope !== null) scope = threadScopeOf(tab.thread.scope)
      else return
      const previous = session.run
      if (previous !== null && (previous.waiting || previous.status === 'running' || previous.status === 'paused')) {
        cancelSearch(previous.operationId)
      }
      const operationId = crypto.randomUUID()
      const filters = session.filters
      apply({ type: 'run-start', tabId, view, operationId, query, scope, filters })
      window.xidao.search.start({ operationId, query, scope, filters }).then(
        (result) => {
          if (result.ok) apply({ type: 'run-batch', tabId, view, operationId, batch: result.value })
          else apply({ type: 'run-refused', tabId, view, operationId, reason: result.reason })
          void pump(tabId, view, operationId)
        },
        () => apply({ type: 'run-refused', tabId, view, operationId, reason: 'internal' })
      )
    },
    [apply, pump]
  )

  /** Reruns the view's last query with the session's current scope and filters. */
  const rerun = useCallback(
    (tabId: number, view: SearchView) => {
      const run = stateRef.current.tabs[tabId]?.[view].run ?? null
      if (run !== null) submit(tabId, view, run.query)
    },
    [submit]
  )

  const more = useCallback(
    (tabId: number, view: SearchView) => {
      const next = apply({ type: 'run-more', tabId, view })
      const run = next.tabs[tabId]?.[view].run ?? null
      if (run !== null) void pump(tabId, view, run.operationId)
    },
    [apply, pump]
  )

  const stop = useCallback(
    (tabId: number, view: SearchView) => {
      const run = stateRef.current.tabs[tabId]?.[view].run ?? null
      if (run === null) return
      if (run.waiting || run.status === 'running' || run.status === 'paused') cancelSearch(run.operationId)
      apply({ type: 'run-stop', tabId, view })
    },
    [apply]
  )

  const setInput = useCallback(
    (tabId: number, view: SearchView, input: string, restoreSeq?: number) => apply({ type: 'input', tabId, view, input, restoreSeq }),
    [apply]
  )

  /** New filters apply to the shown search at once (a new session with the same query). */
  const setFilters = useCallback(
    (tabId: number, view: SearchView, filters: SearchFilters) => {
      apply({ type: 'filters', tabId, view, filters })
      if (filtersSearchable(filters)) rerun(tabId, view)
    },
    [apply, rerun]
  )

  /** 全部回复 / 只看 PO of the thread search only; the reading mode is untouched. */
  const setThreadMode = useCallback(
    (tabId: number, mode: ReadingMode) => {
      const before = stateRef.current
      if (apply({ type: 'thread-mode', tabId, mode }) !== before) rerun(tabId, 'thread')
    },
    [apply, rerun]
  )

  const setView = useCallback((tabId: number, view: SearchView) => apply({ type: 'view', tabId, view }), [apply])

  // ---------- Explicit full-thread fetch ----------
  const fetchEnded = useCallback(
    (tabId: number) => {
      // The fetched pages are now part of the retained corpus: search them with the same query.
      const thread = stateRef.current.tabs[tabId]?.thread
      const fetched = thread?.fetch?.status?.pages.length ?? 0
      if (thread?.run != null && fetched > 0) rerun(tabId, 'thread')
    },
    [rerun]
  )

  const poll = useCallback(
    async (tabId: number, operationId: string) => {
      for (;;) {
        const fetch = stateRef.current.tabs[tabId]?.thread.fetch ?? null
        if (fetch === null || fetch.operationId !== operationId || fetch.failure !== null) return
        if (fetch.status !== null && fetch.status.state !== 'running') {
          fetchEnded(tabId)
          return
        }
        await sleep(POLL_MS)
        const latest = stateRef.current.tabs[tabId]?.thread.fetch ?? null
        if (latest === null || latest.operationId !== operationId) return
        try {
          const result = await window.xidao.search.fetchStatus({ operationId })
          if (result.ok) apply({ type: 'fetch-status', tabId, operationId, status: result.value })
          else apply({ type: 'fetch-refused', tabId, operationId, reason: result.reason })
        } catch {
          apply({ type: 'fetch-refused', tabId, operationId, reason: 'internal' })
          return
        }
      }
    },
    [apply, fetchEnded]
  )

  const fetchThread = useCallback(
    (tabId: number) => {
      const tab = tabSearchOf(stateRef.current, tabId)
      const scope = tab.thread.scope
      const running = tab.thread.fetch
      if (scope === null || (running !== null && running.failure === null && (running.status === null || running.status.state === 'running'))) return
      const operationId = crypto.randomUUID()
      apply({ type: 'fetch-start', tabId, operationId })
      window.xidao.search.fetchThread({ operationId, threadId: scope.threadId }).then(
        (result) => {
          if (result.ok) apply({ type: 'fetch-status', tabId, operationId, status: result.value })
          else apply({ type: 'fetch-refused', tabId, operationId, reason: result.reason })
          void poll(tabId, operationId)
        },
        () => apply({ type: 'fetch-refused', tabId, operationId, reason: 'internal' })
      )
    },
    [apply, poll]
  )

  /** Stops the fetch; what it saved stays, and the final status is still picked up by the poll. */
  const cancelFetch = useCallback(
    (tabId: number) => {
      const fetch = stateRef.current.tabs[tabId]?.thread.fetch ?? null
      if (fetch === null) return
      apply({ type: 'fetch-cancelling', tabId, operationId: fetch.operationId })
      cancelSearch(fetch.operationId)
    },
    [apply]
  )

  // ---------- Index rebuild ----------
  const rebuild = useCallback(() => {
    if (stateRef.current.rebuild.status === 'running') return
    const operationId = crypto.randomUUID()
    apply({ type: 'rebuild-start', operationId })
    window.xidao.search.rebuild({ operationId }).then(
      (result) => {
        apply({ type: 'rebuild-end', operationId, outcome: result.ok ? result.value : result.reason })
        if (!result.ok || !result.value.rebuilt) return
        // Searches refused for the missing index run again on the open sheet.
        const tabId = stateRef.current.openTab
        if (tabId === null) return
        for (const view of ['local', 'thread'] as const) {
          if (stateRef.current.tabs[tabId]?.[view].run?.failure === 'index-unavailable') rerun(tabId, view)
        }
      },
      () => apply({ type: 'rebuild-end', operationId, outcome: 'internal' })
    )
  }, [apply, rerun])

  const cancelRebuild = useCallback(() => {
    const rebuildState = stateRef.current.rebuild
    if (rebuildState.status !== 'running') return
    apply({ type: 'rebuild-cancelling', operationId: rebuildState.operationId })
    cancelSearch(rebuildState.operationId)
  }, [apply])

  // ---------- Hits ----------
  /** Tab and entry while `entryKey` is still the current entry of tab `tabId`. */
  const shownEntry = useCallback((tabId: number, entryKey: number): { tab: Tab; entry: TabEntry } | null => {
    const tab = opts.current.getTabs()?.tabs.find((item) => item.id === tabId)
    if (tab === undefined) return null
    const entry = currentEntry(tab)
    return entry.key === entryKey ? { tab, entry } : null
  }, [])

  /**
   * What the tab's search was when a hit was opened from each history entry (by entry key), so going
   * back to that entry shows its own results again, however many searches were opened since.
   */
  const returns = useRef(new Map<number, SearchReturn>())

  /** Pushes the hit's thread as a `search` step of the tab (after the jump succeeded). */
  const commit = useCallback(
    (shown: { tab: Tab; entry: TabEntry }, thread: ThreadOpen) => {
      const { registry, dispatch, getTabs, onCommitted } = opts.current
      const { tab, entry } = shown
      const source = registry.readers.get(entry.key)?.current.capture() ?? null
      // The split list beside the target keeps its loaded pages, scroll position and filters.
      if (entry.kind === 'list' && entry.feed !== null && tab.split) {
        const memory = registry.listMemory.get(entry.key)
        const nextKey = getTabs()?.nextKey
        if (memory !== undefined && nextKey !== undefined) registry.listMemory.set(nextKey, memory)
      }
      const closed = apply({ type: 'close' })
      returns.current.set(entry.key, { tabId: tab.id, search: tabSearchOf(closed, tab.id) })
      dispatch({ type: 'search-navigate', tabId: tab.id, entryKey: entry.key, source, thread })
      onCommitted(tab.id)
    },
    [apply]
  )

  const onLocated = useCallback(
    (tabId: number, seq: number, result: QuoteLocation) => {
      const current = stateRef.current
      if (!isCurrentLocate(current, tabId, seq) || result.status === 'cancelled') return
      const locate = current.tabs[tabId]?.locate
      if (locate === undefined || locate === null) return
      // Failures, and anything a resolve-only retry found, stay on the hit; only choosing it jumps.
      if (!commitsJump(locate, result)) {
        apply({ type: 'locate-done', tabId, seq, result })
        return
      }
      if (result.status !== 'located') return
      const shown = shownEntry(tabId, locate.entryKey)
      if (shown === null || current.openTab !== tabId) {
        apply({ type: 'locate-cancel', tabId })
        return
      }
      const target = { postId: result.target.postId, page: result.target.page, mode: result.target.mode }
      // Already on screen in the same thread and mode: point at it, no new history step.
      const reader = opts.current.registry.readers.get(shown.entry.key)?.current
      if (reader !== undefined && reader.showInPlace(result.threadId, target)) {
        apply({ type: 'close' })
        return
      }
      commit(shown, { threadId: result.threadId, head: result.head, target, snapshot: null, unlocatedPostId: null })
    },
    [apply, shownEntry, commit]
  )

  /**
   * Locates a hit (owner, page and mode verified by the quote locate primitive). `navigate` (choosing
   * the hit) opens it on success; `resolve` (重试 after a failure) only shows where it is now.
   */
  const chooseHit = useCallback(
    (tabId: number, view: SearchView, hit: SearchHit, intent: 'navigate' | 'resolve') => {
      const tab = opts.current.getTabs()?.tabs.find((item) => item.id === tabId)
      if (tab === undefined) return
      const before = stateRef.current.tabs[tabId]?.locate ?? null
      if (before !== null && before.result === null) cancelRead(locateOperation(before.seq))
      const next = apply({ type: 'locate-start', tabId, view, postId: hit.postId, entryKey: currentEntry(tab).key, intent })
      const locate = next.tabs[tabId]?.locate
      if (locate === undefined || locate === null) return
      const { seq } = locate
      window.xidao.quotes.locate({ operationId: locateOperation(seq), postId: hit.postId }).then(
        (result) => onLocated(tabId, seq, result),
        () => apply({ type: 'locate-internal', tabId, seq })
      )
    },
    [apply, onLocated]
  )

  /**
   * 打开原串 after a `thread-known` result: reads the page the thread would resume at and commits
   * only once it was obtained, saying the hit itself was not located.
   */
  const openHitThread = useCallback(
    (tabId: number) => {
      const before = stateRef.current.tabs[tabId]?.locate ?? null
      if (before === null) return
      const started = apply({ type: 'open-thread-start', tabId, seq: before.seq }).tabs[tabId]?.locate ?? null
      if (started === null || started.intent !== 'open-thread' || started.known === undefined) return
      const { seq, known, postId, entryKey } = started
      const threadId = known.threadId
      const run = async () => {
        const reading = await window.xidao.readingState.get({ threadId }).catch(() => null)
        if (!isCurrentLocate(stateRef.current, tabId, seq)) return
        const start = savedStart(reading, reading?.mode ?? 'all')
        const outcome = await window.xidao.reading.readThreadPage({
          operationId: locateOperation(seq),
          threadId,
          mode: start.mode,
          page: startPage(start.position)
        })
        if (!isCurrentLocate(stateRef.current, tabId, seq) || outcome.status === 'cancelled') return
        if (outcome.status === 'failed') {
          apply({ type: 'locate-done', tabId, seq, result: { status: 'failed', threadId, error: outcome.error } })
          return
        }
        const shown = shownEntry(tabId, entryKey)
        if (shown === null || stateRef.current.openTab !== tabId) {
          apply({ type: 'locate-cancel', tabId })
          return
        }
        commit(shown, { threadId, head: known.head, target: null, snapshot: null, unlocatedPostId: postId })
      }
      run().catch(() => apply({ type: 'locate-internal', tabId, seq }))
    },
    [apply, shownEntry, commit]
  )

  /** Esc while a hit is being located: drops it; returns whether there was one. */
  const cancelLocate = useCallback(
    (tabId: number): boolean => {
      const locate = stateRef.current.tabs[tabId]?.locate ?? null
      if (locate === null || locate.result !== null) return false
      cancelRead(locateOperation(locate.seq))
      apply({ type: 'locate-cancel', tabId })
      return true
    },
    [apply]
  )

  const dismissLocate = useCallback((tabId: number) => apply({ type: 'locate-cancel', tabId }), [apply])

  // ---------- Sheet ----------
  const open = useCallback(
    (tabId: number, request: SearchOpen) => {
      const tab = stateRef.current.tabs[tabId]
      if (request.view === 'thread' && tab !== undefined && tab.thread.scope !== null && tab.thread.scope.threadId !== request.scope.threadId) {
        // Searching another thread: the old thread's session and fetch are abandoned.
        const run = tab.thread.run
        if (run !== null && (run.waiting || run.status === 'running' || run.status === 'paused')) cancelSearch(run.operationId)
        const fetch = tab.thread.fetch
        if (fetch !== null && (fetch.status === null || fetch.status.state === 'running')) cancelSearch(fetch.operationId)
        if (tab.locate?.view === 'thread' && tab.locate.result === null) cancelRead(locateOperation(tab.locate.seq))
      }
      apply(request.view === 'local' ? { type: 'open', tabId, view: 'local' } : { type: 'open', tabId, view: 'thread', scope: request.scope })
    },
    [apply]
  )

  /**
   * Back to history entry `entryKey` from a hit opened there: the search it had is shown again (its
   * query, filters, results and the hit to focus). Sessions it replaces are cancelled; nothing is
   * searched or fetched again.
   */
  const returnTo = useCallback(
    (tabId: number, entryKey: number) => {
      const saved = returns.current.get(entryKey)
      if (saved === undefined || saved.tabId !== tabId) {
        apply({ type: 'reopen', tabId })
        return
      }
      const before = stateRef.current.tabs[tabId]
      if (before?.locate != null && before.locate.result === null) cancelRead(locateOperation(before.locate.seq))
      const after = apply({ type: 'restore', tabId, snapshot: saved.search })
      const kept = new Set(operationsOf(after.tabs[tabId]))
      for (const operationId of operationsOf(before)) if (!kept.has(operationId)) cancelSearch(operationId)
    },
    [apply]
  )

  /** Closing pauses the tab's runs (resumable) and drops a running locate. */
  const close = useCallback(() => {
    const tabId = stateRef.current.openTab
    if (tabId === null) return
    cancelLocate(tabId)
    apply({ type: 'close' })
  }, [apply, cancelLocate])

  // The sheet belongs to the tab it was opened for; a closed tab's searches are cancelled.
  const tabs = options.tabs
  useEffect(() => {
    if (tabs === null) return
    const current = stateRef.current
    if (current.openTab !== null && current.openTab !== tabs.activeId) {
      const locate = current.tabs[current.openTab]?.locate
      if (locate != null && locate.result === null) cancelRead(locateOperation(locate.seq))
      apply({ type: 'close' })
    }
    pruneReturns(returns.current, tabs)
    const live = new Set(tabs.tabs.map((tab) => tab.id))
    for (const key of Object.keys(stateRef.current.tabs)) {
      const tabId = Number(key)
      if (live.has(tabId)) continue
      const tab = stateRef.current.tabs[tabId]
      for (const operationId of operationsOf(tab)) cancelSearch(operationId)
      if (tab?.locate != null && tab.locate.result === null) cancelRead(locateOperation(tab.locate.seq))
      apply({ type: 'dispose', tabId })
    }
  }, [tabs, apply])

  const clearRebuildResult = useCallback((rebuild: RebuildState) => {
    apply({ type: 'leave-rebuild-result', rebuild })
  }, [apply])

  const commands = useMemo<SearchCommands>(
    () => ({
      open,
      returnTo,
      close,
      setView,
      setInput,
      setFilters,
      setThreadMode,
      submit,
      more,
      stop,
      fetchThread,
      cancelFetch,
      rebuild,
      cancelRebuild,
      clearRebuildResult,
      chooseHit,
      openHitThread,
      cancelLocate,
      dismissLocate
    }),
    [open, returnTo, close, setView, setInput, setFilters, setThreadMode, submit, more, stop, fetchThread, cancelFetch, rebuild, cancelRebuild, clearRebuildResult, chooseHit, openHitThread, cancelLocate, dismissLocate]
  )

  return { state, commands }
}

export interface SearchCommands {
  open(tabId: number, request: SearchOpen): void
  /**
   * Back to history entry `entryKey` from a hit opened there: shows the search that entry had when
   * the hit was opened, focused on that hit.
   */
  returnTo(tabId: number, entryKey: number): void
  close(): void
  setView(tabId: number, view: SearchView): void
  /** `restoreSeq`: the text belongs to the search shown before that restore, else it is dropped. */
  setInput(tabId: number, view: SearchView, input: string, restoreSeq?: number): void
  setFilters(tabId: number, view: SearchView, filters: SearchFilters): void
  setThreadMode(tabId: number, mode: ReadingMode): void
  /** New session with the view's text, or with `query` (re-running a shown search). */
  submit(tabId: number, view: SearchView, query?: string): void
  more(tabId: number, view: SearchView): void
  stop(tabId: number, view: SearchView): void
  fetchThread(tabId: number): void
  cancelFetch(tabId: number): void
  rebuild(): void
  cancelRebuild(): void
  clearRebuildResult(rebuild: RebuildState): void
  /** `navigate`: choosing the hit opens it once located. `resolve`: 重试 only shows where it is. */
  chooseHit(tabId: number, view: SearchView, hit: SearchHit, intent: 'navigate' | 'resolve'): void
  openHitThread(tabId: number): void
  /** Esc while a hit is being located: drops it; returns whether there was one. */
  cancelLocate(tabId: number): boolean
  dismissLocate(tabId: number): void
}
