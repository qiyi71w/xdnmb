import type { ContentRegistry, ListMemory } from './contentRegistry'
import { currentEntry, entryThread, initialTabsState, newTabEntry, tabsReducer, type EntryInit, type SourceFocus, type Tab, type TabEntry, type TabsAction, type TabsState, type ThreadOpen, type ThreadSnapshot } from './tabsState'

/** A source is bound before an asynchronous locate, not reconstructed from its destination. */
export interface NavigationSource {
  readonly tabId: number
  readonly entryKey: number
  readonly threadId: string | null
  readonly snapshot: ThreadSnapshot | null
}

export type NavigationIntent = (
  | { kind: 'quote'; thread: ThreadOpen; focus?: SourceFocus; newTab?: boolean }
  | { kind: 'search'; thread: ThreadOpen }
  | { kind: 'sent-reply'; thread: ThreadOpen; snapshot: ThreadSnapshot | null }
  | { kind: 'sent-thread'; thread: ThreadOpen }
  | { kind: 'list-target'; thread: ThreadOpen }
  | { kind: 'history'; entry: EntryInit }
) & {
  /** The caller owns its request sequence/cancellation; deferred work must still be authorized. */
  isCurrent?: () => boolean
}

export type NavigationResult =
  | { kind: 'in-place' }
  | { kind: 'history' | 'new-tab' | 'selected'; tabId: number; entryKey: number }
  | { kind: 'rejected'; reason: 'stale' | 'unavailable' }

export interface ReadingNavigation {
  source(request: { tabId: number; entryKey?: number; timing?: 'send-start' }): NavigationSource | null
  open(source: NavigationSource, intent: NavigationIntent): Promise<NavigationResult>
}

type Receipt =
  | { id: number; stage: 'ready' }
  | { id: number; stage: 'done'; result: NavigationResult; seed?: { entryKey: number; memory: ListMemory } }

/** Only tabs is authoritative. Receipts carry transient acceptance and first-render memory. */
export interface NavigationState {
  tabs: TabsState | null
  receipts: readonly Receipt[]
}

export type NavigationAction = TabsAction
  | { type: 'init'; split: boolean }
  | { type: 'restore'; tabs: TabsState }
  | { type: 'navigation-request'; id: number }
  | { type: 'navigation-ack'; ids: readonly number[] }
  | {
      type: 'navigation-commit'; id: number; source: NavigationSource; intent: NavigationIntent
      snapshot: ThreadSnapshot | null; memory: ListMemory | undefined; splitDefault: boolean
    }

export const INITIAL_NAVIGATION_STATE: NavigationState = { tabs: null, receipts: [] }

function shownSource(tabs: TabsState | null, source: NavigationSource, kind: NavigationIntent['kind']): { tab: Tab; entry: TabEntry } | null {
  const tab = tabs?.tabs.find((item) => item.id === source.tabId)
  if (tab === undefined) return null
  const entry = currentEntry(tab)
  if (entry.key !== source.entryKey || (kind === 'quote' && (entryThread(entry)?.threadId ?? null) !== source.threadId)) return null
  if (kind === 'list-target' && entry.kind !== 'list') return null
  return { tab, entry }
}

/** Pure acceptance: keys come from tabsReducer, never from a caller's pre-dispatch snapshot. */
export function navigationReducer(state: NavigationState, action: NavigationAction): NavigationState {
  if (action.type === 'init') return state.tabs === null ? { ...state, tabs: initialTabsState(action.split) } : state
  if (action.type === 'restore') return state.tabs === null ? { ...state, tabs: action.tabs } : state
  if (action.type === 'navigation-request') return { ...state, receipts: [...state.receipts, { id: action.id, stage: 'ready' }] }
  if (action.type === 'navigation-ack') return { ...state, receipts: state.receipts.filter((item) => !action.ids.includes(item.id)) }
  if (action.type !== 'navigation-commit') {
    if (state.tabs === null) return state
    const tabs = tabsReducer(state.tabs, action)
    return tabs === state.tabs ? state : { ...state, tabs }
  }
  const { id, source, intent, snapshot, memory } = action
  if (!state.receipts.some((item) => item.id === id && item.stage === 'ready')) return state
  const shown = shownSource(state.tabs, source, intent.kind)
  let tabs = state.tabs
  let result: NavigationResult = { kind: 'rejected', reason: 'stale' }
  let seed: { entryKey: number; memory: ListMemory } | undefined
  if (tabs !== null && shown !== null) {
    const { tab, entry } = shown
    const newTab = intent.kind === 'quote' && intent.newTab === true
    const explicitListStep = intent.kind === 'list-target' && entry.kind === 'list' && tab.split && entry.thread?.threadId === intent.thread.threadId
    const select = intent.kind === 'list-target' && !explicitListStep
    const keepList = entry.kind === 'list' && tab.split && (intent.kind === 'history' || entry.feed !== null)
    if (newTab) {
      tabs = tabsReducer(tabs, { type: 'open-tab', split: action.splitDefault, entry: newTabEntry(entry, action.splitDefault, intent.thread) })
    } else {
      // A split list's ordinary selection replaces its reader, rather than leaving a back step.
      if (snapshot !== null && !(select && tab.split)) {
        tabs = tabsReducer(tabs, { type: 'snapshot', tabId: tab.id, entryKey: entry.key, snapshot })
      }
      if (select) {
        tabs = tabsReducer(tabs, { type: 'select-thread', tabId: tab.id, thread: intent.thread })
      } else {
        const thread = intent.kind === 'history' ? null : intent.kind === 'sent-reply'
          ? { ...intent.thread, readerKey: entryThread(entry)?.readerKey ?? entry.key }
          : intent.thread
        const init: EntryInit = intent.kind === 'history'
          ? intent.entry.kind === 'thread' && keepList && entry.kind === 'list'
            ? { kind: 'list', feed: entry.feed, thread: intent.entry.thread }
            : intent.entry
          : keepList && entry.kind === 'list'
            ? { kind: 'list', feed: entry.feed, thread }
            : { kind: 'thread', thread: thread! }
        tabs = tabsReducer(tabs, {
          type: 'navigate', tabId: tab.id, entry: init,
          origin: intent.kind === 'quote' ? 'quote' : intent.kind === 'search' ? 'local-search' : null
        })
      }
    }
    const destinationId = newTab ? tabs.activeId : tab.id
    const destination = tabs.tabs.find((item) => item.id === destinationId)!
    const next = currentEntry(destination)
    result = { kind: newTab ? 'new-tab' : next.key === entry.key ? 'selected' : 'history', tabId: destination.id, entryKey: next.key }
    if (!newTab && next.key !== entry.key && next.kind === 'list' && memory !== undefined && entry.kind === 'list' && next.feed === entry.feed) {
      seed = { entryKey: next.key, memory }
    }
  }
  return { tabs, receipts: state.receipts.map((item) => item.id === id ? { id, stage: 'done', result, ...(seed === undefined ? {} : { seed }) } : item) }
}

/** Read-only seeds are available during the very render that mounts a new list. */
export function navigationSeeds(state: NavigationState): ReadonlyMap<number, ListMemory> {
  const seeds = new Map<number, ListMemory>()
  for (const receipt of state.receipts) {
    if (receipt.stage === 'done' && receipt.seed !== undefined) seeds.set(receipt.seed.entryKey, receipt.seed.memory)
  }
  return seeds
}

interface Pending {
  source: NavigationSource
  intent: NavigationIntent
  resolve: (result: NavigationResult) => void
  reject: (error: unknown) => void
  started: boolean
}

/** React and controlled tests drive this same adapter; neither predicts a destination key. */
export function createReadingNavigation(options: {
  getTabs: () => TabsState | null
  dispatch: (action: NavigationAction) => void
  registry: Pick<ContentRegistry, 'readers' | 'listMemory'>
  getSplitDefault: () => boolean
}) {
  let nextId = 1
  let available = true
  const pending = new Map<number, Pending>()
  const navigation: ReadingNavigation = {
    source({ tabId, entryKey, timing }) {
      const tab = options.getTabs()?.tabs.find((item) => item.id === tabId)
      if (tab === undefined) return null
      const entry = currentEntry(tab)
      if (entryKey !== undefined && entry.key !== entryKey) return null
      return {
        tabId, entryKey: entry.key, threadId: entryThread(entry)?.threadId ?? null,
        snapshot: timing === 'send-start' ? options.registry.readers.get(entry.key)?.current.capture() ?? null : null
      }
    },
    open(source, intent) {
      if (!available) return Promise.resolve({ kind: 'rejected', reason: 'unavailable' })
      const id = nextId++
      const { promise, resolve, reject } = Promise.withResolvers<NavigationResult>()
      pending.set(id, { source, intent, resolve, reject, started: false })
      options.dispatch({ type: 'navigation-request', id })
      return promise
    }
  }
  return {
    navigation,
    /** Run only after a React commit, with the final state of the whole dispatch batch. */
    committed(state: NavigationState) {
      const acknowledged: number[] = []
      for (const receipt of state.receipts) {
        const request = pending.get(receipt.id)
        if (request === undefined) { acknowledged.push(receipt.id); continue }
        if (receipt.stage === 'done') {
          const { result, seed } = receipt
          const retained = seed !== undefined && state.tabs?.tabs.some((tab) => tab.entries.some((entry) => entry.key === seed.entryKey))
          if (retained && !options.registry.listMemory.has(seed.entryKey)) options.registry.listMemory.set(seed.entryKey, seed.memory)
          pending.delete(receipt.id)
          acknowledged.push(receipt.id)
          request.resolve(result)
          continue
        }
        if (request.started) break
        request.started = true
        const { source, intent } = request
        const shown = shownSource(state.tabs, source, intent.kind)
        if (shown === null || intent.isCurrent?.() === false) {
          pending.delete(receipt.id)
          acknowledged.push(receipt.id)
          request.resolve({ kind: 'rejected', reason: 'stale' })
          continue
        }
        try {
          const reader = options.registry.readers.get(source.entryKey)?.current
          if ((intent.kind === 'quote' && !intent.newTab || intent.kind === 'search') && intent.thread.target !== null && reader?.showInPlace(intent.thread.threadId, intent.thread.target)) {
            pending.delete(receipt.id)
            acknowledged.push(receipt.id)
            request.resolve({ kind: 'in-place' })
            continue
          }
          const newTab = intent.kind === 'quote' && intent.newTab
          let snapshot = newTab ? null : intent.kind === 'sent-reply' ? intent.snapshot ?? reader?.capture() ?? null : reader?.capture() ?? null
          if (intent.kind === 'quote' && intent.focus !== undefined && snapshot !== null) snapshot = { ...snapshot, focus: intent.focus }
          options.dispatch({
            type: 'navigation-commit', id: receipt.id, source, intent, snapshot,
            memory: options.registry.listMemory.get(source.entryKey), splitDefault: options.getSplitDefault()
          })
          // A following intent must see this commit's authoritative state before touching a reader.
          break
        } catch (error) {
          pending.delete(receipt.id)
          acknowledged.push(receipt.id)
          request.reject(error)
        }
      }
      if (acknowledged.length > 0) options.dispatch({ type: 'navigation-ack', ids: acknowledged })
    },
    mount() { available = true },
    dispose() {
      available = false
      for (const request of pending.values()) request.resolve({ kind: 'rejected', reason: 'unavailable' })
      pending.clear()
    }
  }
}
