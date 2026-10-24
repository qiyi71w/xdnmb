import { describe, expect, it } from 'vitest'
import type { QuoteLocation } from '../../src/shared/api'
import type { ThreadReadingState } from '../../src/shared/reading'
import { canLocate, initialQuoteState, isCurrentLocate, quoteReducer, type QuoteAction, type QuoteSource, type QuoteState } from '../../src/renderer/src/features/quote/quoteState'
import {
  activeTab,
  backgroundTabEntry,
  currentEntry,
  entryThread,
  initialTabsState,
  tabsReducer,
  type TabsAction,
  type TabsState,
  type ThreadOpen,
  type ThreadSnapshot
} from '../../src/renderer/src/features/tabs/tabsState'
import { decideView } from '../../src/renderer/src/features/thread/readingStart'

const forum4 = { kind: 'forum', id: '4' } as const
const run = (state: TabsState, ...actions: TabsAction[]) => actions.reduce(tabsReducer, state)
const open = (threadId: string, postId: string | null = null, mode: 'all' | 'po' = 'all'): ThreadOpen => ({
  threadId,
  head: null,
  target: postId === null ? null : { postId, page: 1, mode },
  snapshot: null,
  unlocatedPostId: null
})
const left = (postId: string, quoteIndex = 0, mode: 'all' | 'po' = 'all'): ThreadSnapshot => ({
  mode,
  anchor: { postId, page: 1, offsetRatio: 0.25, viewportOffset: 80 },
  generation: 0,
  temporaryOf: null,
  focus: { postId, quoteIndex }
})

/** Split tab showing thread A beside forum 4. */
function readingA(): TabsState {
  const state = initialTabsState(true)
  return run(
    state,
    { type: 'navigate', tabId: state.activeId, entry: { kind: 'list', feed: forum4 } },
    { type: 'select-thread', tabId: state.activeId, thread: open('100') }
  )
}

function quote(state: TabsState, source: ThreadSnapshot, target: ThreadOpen): TabsState {
  const tab = activeTab(state)
  return run(state, { type: 'quote-navigate', tabId: tab.id, entryKey: currentEntry(tab).key, source, thread: target })
}

describe('quote navigation in the tab history', () => {
  it('walks A→B→C (same and other thread) back and forward through one history, restoring each source', () => {
    let state = readingA()
    const id = state.activeId
    state = quote(state, left('101', 1), open('100', '150'))
    state = quote(state, left('150', 0), open('200', '250'))
    const tab = activeTab(state)
    expect(tab.entries.map((entry) => [entry.kind, entryThread(entry)?.threadId, entry.origin])).toEqual([
      ['list', undefined, null],
      ['list', '100', null],
      ['list', '100', 'quote'],
      ['list', '200', 'quote']
    ])
    expect(currentEntry(tab)).toMatchObject({ feed: forum4, pane: 'reader', thread: { target: { postId: '250' } } })

    state = run(state, { type: 'back', tabId: id })
    expect(currentEntry(activeTab(state))).toMatchObject({ origin: 'quote', thread: { threadId: '100', target: null, snapshot: left('150', 0) } })
    state = run(state, { type: 'back', tabId: id })
    expect(currentEntry(activeTab(state))).toMatchObject({ origin: null, thread: { threadId: '100', target: null, snapshot: left('101', 1) } })
    // Leaving A again by back/forward (no quote) keeps the quote focus to return to.
    const aKey = currentEntry(activeTab(state)).key
    const kept = run(state, { type: 'snapshot', tabId: id, entryKey: aKey, snapshot: { ...left('105'), focus: null } })
    expect(entryThread(currentEntry(activeTab(kept)))?.snapshot).toMatchObject({ anchor: { postId: '105' }, focus: { postId: '101', quoteIndex: 1 } })
    state = run(state, { type: 'forward', tabId: id }, { type: 'forward', tabId: id })
    expect(entryThread(currentEntry(activeTab(state)))?.threadId).toBe('200')

    // Back to B, then quote D: the forward branch (C) is replaced.
    state = run(state, { type: 'back', tabId: id })
    state = quote(state, left('150', 2), open('300', '350'))
    expect(activeTab(state).entries.map((entry) => entryThread(entry)?.threadId)).toEqual([undefined, '100', '100', '300'])
    expect(run(state, { type: 'forward', tabId: id })).toBe(state)
  })

  it('opens a whole-page thread entry when the source is not a split list', () => {
    const state = initialTabsState(false)
    const id = state.activeId
    const after = run(
      state,
      { type: 'navigate', tabId: id, entry: { kind: 'list', feed: forum4 } },
      { type: 'select-thread', tabId: id, thread: open('100') }
    )
    expect(currentEntry(activeTab(quote(after, left('101'), open('200', '201'))))).toMatchObject({
      kind: 'thread', origin: 'quote', thread: { threadId: '200' }
    })
  })

  it('ignores a late result once the source entry is no longer current', () => {
    let state = readingA()
    const id = state.activeId
    const sourceKey = currentEntry(activeTab(state)).key
    state = run(state, { type: 'navigate', tabId: id, entry: { kind: 'list', feed: { kind: 'forum', id: '5' } } })
    expect(run(state, { type: 'quote-navigate', tabId: id, entryKey: sourceKey, source: left('101'), thread: open('200', '201') })).toBe(state)
  })

  it('choosing another list item ends the quote step without dropping history', () => {
    let state = quote(readingA(), left('101'), open('200', '201'))
    const id = state.activeId
    const before = activeTab(state)
    state = run(state, { type: 'select-thread', tabId: id, thread: open('300') })
    const tab = activeTab(state)
    expect(tab.entries).toHaveLength(before.entries.length)
    expect(tab.index).toBe(before.index)
    expect(currentEntry(tab)).toMatchObject({ origin: null, thread: { threadId: '300' } })
    expect(currentEntry(activeTab(run(state, { type: 'back', tabId: id })))).toMatchObject({ thread: { threadId: '100', snapshot: left('101') } })
  })

  it('opens a background tab with the global split default and no copy of the source history', () => {
    const state = quote(readingA(), left('101'), open('200', '201'))
    const source = activeTab(state)
    for (const splitDefault of [true, false]) {
      const after = run(state, {
        type: 'open-tab',
        entry: backgroundTabEntry(currentEntry(source), splitDefault, open('300', '301')),
        split: splitDefault,
        background: true
      })
      expect(after.activeId).toBe(source.id)
      expect(activeTab(after)).toBe(source)
      const opened = after.tabs.find((tab) => tab.id !== source.id)!
      expect(opened).toMatchObject({ split: splitDefault, index: 0 })
      expect(opened.entries).toHaveLength(1)
      expect(currentEntry(opened)).toMatchObject(
        splitDefault
          ? { kind: 'list', feed: forum4, origin: null, thread: { threadId: '300', target: { postId: '301' } } }
          : { kind: 'thread', origin: null, thread: { threadId: '300' } }
      )
    }
  })

  it('walks subscriptions → reader → quote → back → a retained (offline) open through one history', () => {
    const subscriptions = { kind: 'subscriptions' } as const
    let state = initialTabsState(true)
    const id = state.activeId
    state = run(
      state,
      { type: 'navigate', tabId: id, entry: { kind: 'list', feed: subscriptions } },
      { type: 'select-thread', tabId: id, thread: open('100') }
    )
    state = quote(state, left('101', 1), open('200', '250'))
    // The subscription list stays beside the located target, as any split list does.
    expect(currentEntry(activeTab(state))).toMatchObject({ kind: 'list', feed: subscriptions, origin: 'quote', pane: 'reader', thread: { threadId: '200' } })

    state = run(state, { type: 'back', tabId: id })
    expect(currentEntry(activeTab(state))).toMatchObject({
      kind: 'list', feed: subscriptions, origin: null, thread: { threadId: '100', target: null, snapshot: left('101', 1) }
    })

    // 打开 from 离线 is a new step that replaces the forward (quote) branch.
    state = run(state, { type: 'navigate', tabId: id, entry: { kind: 'thread', thread: open('300') } })
    const tab = activeTab(state)
    expect(tab.entries.map((entry) => [entry.kind, entryThread(entry)?.threadId, entry.origin])).toEqual([
      ['list', undefined, null],
      ['list', '100', null],
      ['thread', '300', null]
    ])
    expect(currentEntry(activeTab(run(state, { type: 'back', tabId: id })))).toMatchObject({ feed: subscriptions, thread: { threadId: '100' } })
  })
})

describe('temporary display of a target hidden by 只看 PO', () => {
  const state = (mode: 'all' | 'po') => ({ mode, positions: { all: null, po: null } }) as unknown as ThreadReadingState

  it('shows the target in its own mode temporarily and keeps that state when coming back to the entry', () => {
    expect(decideView(open('100', '150', 'all'), state('po'), 0)).toMatchObject({ start: { mode: 'all' }, temporaryOf: 'po' })
    expect(decideView(open('100', '150', 'po'), state('po'), 0).temporaryOf).toBeNull()

    const leftTemporary = { ...open('100'), snapshot: { ...left('150'), temporaryOf: 'po' as const } }
    expect(decideView(leftTemporary, state('po'), 0)).toMatchObject({ start: { mode: 'all', position: { kind: 'anchor' } }, temporaryOf: 'po' })
    // Another tab adopted `all` meanwhile: nothing left to stand in for.
    expect(decideView(leftTemporary, state('all'), 0).temporaryOf).toBeNull()
    // A plain snapshot in a mode other than the preference is not a temporary display.
    expect(decideView({ ...open('100'), snapshot: left('150') }, state('po'), 0).temporaryOf).toBeNull()
    // A history clear since the entry was left voids its snapshot: the saved preference opens normally.
    expect(decideView(leftTemporary, state('po'), 1)).toEqual({ start: { mode: 'po', position: { kind: 'top' } }, temporaryOf: null })
  })
})

describe('quote card requests', () => {
  const source = (postId: string, quoteIndex = 0): QuoteSource => ({ tabId: 1, entryKey: 2, postId, focus: { postId: '101', quoteIndex } })
  const apply = (state: QuoteState, ...actions: QuoteAction[]) => actions.reduce(quoteReducer, state)
  const located: QuoteLocation = {
    status: 'located',
    threadId: '100',
    head: { id: '100' } as never,
    target: { postId: '150', page: 1, mode: 'all' },
    source: 'fresh',
    networkError: null
  }
  const network = { kind: 'network', detail: 'timeout' } as const

  it('drops preview and locate results of a card replaced by choosing another quote', () => {
    let state = apply(initialQuoteState, { type: 'open', source: source('150'), trigger: 'activate' })
    const first = state.card!
    state = apply(state, { type: 'locate-start', cardId: first.id, intent: 'navigate' })
    const seq = state.card!.locate!.seq
    state = apply(state, { type: 'open', source: source('160', 1), trigger: 'activate' })
    expect(isCurrentLocate(state, first.id, seq)).toBe(false)
    const late = apply(
      state,
      { type: 'preview-done', cardId: first.id, seq: first.preview.seq, outcome: { status: 'failed', error: network } },
      { type: 'locate-done', cardId: first.id, seq, result: located }
    )
    expect(late).toBe(state)
    expect(late.card).toMatchObject({ source: { postId: '160' }, locate: null, preview: { outcome: null } })
  })

  it('cancelling a running locate keeps the card and drops the late result', () => {
    let state = apply(initialQuoteState, { type: 'open', source: source('150'), trigger: 'hover' })
    const id = state.card!.id
    state = apply(state, { type: 'locate-start', cardId: id, intent: 'navigate' })
    expect(state.card!.pinned).toBe(true)
    const seq = state.card!.locate!.seq
    state = apply(state, { type: 'cancel-locate', cardId: id })
    expect(isCurrentLocate(state, id, seq)).toBe(false)
    expect(apply(state, { type: 'locate-done', cardId: id, seq, result: located })).toBe(state)
    expect(state.card).toMatchObject({ id, locate: null })
  })

  it('keeps a pinned (activated or failed) card when the pointer leaves or another quote is only hovered', () => {
    let state = apply(initialQuoteState, { type: 'open', source: source('150'), trigger: 'hover' })
    expect(apply(state, { type: 'leave', cardId: state.card!.id }).card).toBeNull()
    state = apply(state, { type: 'open', source: source('150'), trigger: 'activate' })
    const id = state.card!.id
    state = apply(state, { type: 'leave', cardId: id }, { type: 'open', source: source('160', 1), trigger: 'hover' })
    expect(state.card).toMatchObject({ id, pinned: true })
    // Space on another quote is an explicit choice: it replaces the pinned card with an unpinned preview.
    const spaced = apply(state, { type: 'open', source: source('160', 1), trigger: 'preview' })
    expect(spaced.card).toMatchObject({ source: { postId: '160' }, pinned: false })
    expect(spaced.card!.id).not.toBe(id)
    expect(apply(state, { type: 'close', cardId: id }).card).toBeNull()
  })

  it('opens the original thread only from a thread-known result; cancelling returns to it, a late result is dropped', () => {
    let state = apply(initialQuoteState, { type: 'open', source: source('150'), trigger: 'activate' })
    const id = state.card!.id
    expect(apply(state, { type: 'open-thread-start', cardId: id })).toBe(state)
    state = apply(state, { type: 'locate-start', cardId: id, intent: 'navigate' })
    const known = { status: 'thread-known', threadId: '100', head: { id: '100' } as never } as const
    state = apply(state, { type: 'locate-done', cardId: id, seq: state.card!.locate!.seq, result: known })
    state = apply(state, { type: 'open-thread-start', cardId: id })
    const seq = state.card!.locate!.seq
    expect(state.card!.locate).toMatchObject({ intent: 'open-thread', result: null })
    state = apply(state, { type: 'cancel-locate', cardId: id })
    expect(state.card!.locate).toMatchObject({ result: known })
    expect(apply(state, { type: 'locate-done', cardId: id, seq, result: { status: 'failed', threadId: '100', error: network } })).toBe(state)
  })

  it('retries a failed locate as resolve-only and never locates again once the owner proved unknown', () => {
    let state = apply(initialQuoteState, { type: 'open', source: source('150'), trigger: 'activate' })
    const id = state.card!.id
    state = apply(state, { type: 'locate-start', cardId: id, intent: 'navigate' })
    state = apply(state, { type: 'locate-done', cardId: id, seq: state.card!.locate!.seq, result: { status: 'failed', threadId: null, error: network } })
    state = apply(state, { type: 'retry', cardId: id })
    expect(state.card!.locate).toMatchObject({ intent: 'resolve', result: null })
    expect(state.card!.preview.outcome).toBeNull()

    state = apply(state, { type: 'locate-done', cardId: id, seq: state.card!.locate!.seq, result: { status: 'unknown-thread' } })
    expect(canLocate(state.card!)).toBe(false)
    expect(apply(state, { type: 'locate-start', cardId: id, intent: 'navigate' })).toBe(state)
  })
})
