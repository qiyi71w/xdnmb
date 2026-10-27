import { describe, expect, it } from 'vitest'
import {
  activeTab,
  currentEntry,
  entryThread,
  initialTabsState,
  listKey,
  tabsReducer,
  type TabsAction,
  type TabsState,
  type ThreadOpen
} from '../../src/renderer/src/features/tabs/tabsState'

const forum4 = { kind: 'forum', id: '4' } as const
const forum5 = { kind: 'forum', id: '5' } as const
const thread = (threadId: string): ThreadOpen => ({ threadId, head: null, target: null, snapshot: null, unlocatedPostId: null })
const run = (state: TabsState, ...actions: TabsAction[]) => actions.reduce(tabsReducer, state)

describe('tabs and per-tab history', () => {
  it('keeps online sessions and local-search return steps distinct in one history', () => {
    let state = initialTabsState(true)
    const tabId = state.activeId
    state = run(state, { type: 'navigate', tabId, entry: { kind: 'online-search' } })
    const online = currentEntry(activeTab(state))
    expect(entryThread(online)).toBeNull()
    state = run(state, { type: 'navigate', tabId, entry: { kind: 'online-search' } })
    expect(currentEntry(activeTab(state)).key).toBe(online.key)
    state = run(state, { type: 'navigate', tabId, entry: { kind: 'thread', thread: thread('200') }, origin: 'online-search' })
    expect(currentEntry(activeTab(state))).toMatchObject({ kind: 'thread', origin: 'online-search' })
    const source = currentEntry(activeTab(state))
    state = run(state, { type: 'search-navigate', tabId, entryKey: source.key, source: null, thread: thread('300') })
    expect(currentEntry(activeTab(state))).toMatchObject({ kind: 'thread', origin: 'local-search' })
    state = run(state, { type: 'back', tabId })
    expect(currentEntry(activeTab(state))).toMatchObject({ key: source.key, origin: 'online-search' })
    state = run(state, { type: 'back', tabId })
    expect(currentEntry(activeTab(state))).toMatchObject({ key: online.key, kind: 'online-search' })
    state = run(state, { type: 'forward', tabId }, { type: 'navigate', tabId, entry: { kind: 'list', feed: forum4 } })
    expect(activeTab(state).entries.some((entry) => entryThread(entry)?.threadId === '300')).toBe(false)
  })

  it('gives each new tab the global default at creation time only', () => {
    let state = initialTabsState(true)
    state = run(state, { type: 'open-tab', entry: { kind: 'list', feed: null }, split: false })
    expect(state.tabs.map((tab) => tab.split)).toEqual([true, false])
    state = run(state, { type: 'set-split', tabId: state.tabs[0]!.id, split: false })
    expect(state.tabs.map((tab) => tab.split)).toEqual([false, false])
  })

  it('keeps the split preference when switching boards; a split list click replaces the reader without a back step', () => {
    const state = initialTabsState(true)
    const id = state.activeId
    const after = run(
      state,
      { type: 'navigate', tabId: id, entry: { kind: 'list', feed: forum4 } },
      { type: 'select-thread', tabId: id, thread: thread('100') },
      { type: 'select-thread', tabId: id, thread: thread('200') },
      { type: 'navigate', tabId: id, entry: { kind: 'list', feed: forum5 } },
      { type: 'navigate', tabId: id, entry: { kind: 'list', feed: forum5 } }
    )
    const tab = activeTab(after)
    expect(tab.split).toBe(true)
    expect(tab.entries.map((entry) => (entry.kind === 'list' ? (entry.feed === null ? null : listKey(entry.feed)) : entryThread(entry)?.threadId))).toEqual([
      null,
      'forum:4',
      'forum:5'
    ])
    const back = currentEntry(activeTab(run(after, { type: 'back', tabId: id })))
    expect(back).toMatchObject({ kind: 'list', feed: forum4, thread: { threadId: '200' }, pane: 'reader' })
  })

  it('opens a whole-page thread step when split is off, and a new step after back drops the forward branch', () => {
    const state = initialTabsState(false)
    const id = state.activeId
    let after = run(
      state,
      { type: 'navigate', tabId: id, entry: { kind: 'list', feed: forum4 } },
      { type: 'select-thread', tabId: id, thread: thread('100') },
      { type: 'back', tabId: id }
    )
    expect(activeTab(after).entries).toHaveLength(3)
    after = run(after, { type: 'select-thread', tabId: id, thread: thread('300') })
    const tab = activeTab(after)
    expect(tab.entries.map((entry) => entry.kind)).toEqual(['list', 'list', 'thread'])
    expect(currentEntry(tab)).toMatchObject({ kind: 'thread', thread: { threadId: '300' } })
    expect(run(after, { type: 'forward', tabId: id })).toBe(after)
  })

  it('keeps history independent per tab and restores the snapshot taken when an entry was left', () => {
    let state = initialTabsState(true)
    const first = state.activeId
    state = run(
      state,
      { type: 'navigate', tabId: first, entry: { kind: 'list', feed: forum4 } },
      { type: 'select-thread', tabId: first, thread: { ...thread('100'), target: { postId: '150', page: 2, mode: 'all' } } }
    )
    const left = currentEntry(activeTab(state))
    const snapshot = {
      mode: 'po' as const,
      anchor: { postId: '160', page: 1, offsetRatio: 0.4, viewportOffset: 60 },
      generation: 0,
      temporaryOf: null,
      focus: null
    }
    state = run(
      state,
      { type: 'snapshot', tabId: first, entryKey: left.key, snapshot },
      { type: 'navigate', tabId: first, entry: { kind: 'list', feed: forum5 } },
      { type: 'open-tab', entry: { kind: 'list', feed: forum4 }, split: false }
    )
    const second = state.activeId
    state = run(state, { type: 'back', tabId: second }, { type: 'back', tabId: first })
    expect(activeTab(state).index).toBe(0)
    const restored = currentEntry(state.tabs.find((tab) => tab.id === first)!)
    expect(restored).toMatchObject({ thread: { threadId: '100', target: null, snapshot } })
  })

  it('cycles tabs, closes to a neighbour and replaces the last closed tab with a new empty one', () => {
    let state = initialTabsState(true)
    state = run(
      state,
      { type: 'open-tab', entry: { kind: 'list', feed: forum4 }, split: true },
      { type: 'open-tab', entry: { kind: 'list', feed: forum5 }, split: true }
    )
    const [a, b, c] = state.tabs.map((tab) => tab.id)
    expect(state.tabs.map((tab) => tab.id)).toEqual([a, b, c])
    expect(state.activeId).toBe(c)
    state = run(state, { type: 'cycle', delta: 1 })
    expect(state.activeId).toBe(a)
    state = run(state, { type: 'cycle', delta: 1 })
    expect(state.activeId).toBe(b)
    state = run(state, { type: 'close-tab', tabId: a!, split: true })
    expect(state.activeId).toBe(b)
    state = run(state, { type: 'close-tab', tabId: b!, split: true }, { type: 'close-tab', tabId: c!, split: false })
    expect(state.tabs).toHaveLength(1)
    expect(activeTab(state)).toMatchObject({ split: false, index: 0 })
    expect(currentEntry(activeTab(state))).toMatchObject({ kind: 'list', feed: null })
  })

  it('treats the subscription list as one list step whose split reader behaves like any feed', () => {
    const state = initialTabsState(true)
    const id = state.activeId
    const after = run(
      state,
      { type: 'navigate', tabId: id, entry: { kind: 'list', feed: forum4 } },
      { type: 'navigate', tabId: id, entry: { kind: 'list', feed: { kind: 'subscriptions' } } },
      { type: 'navigate', tabId: id, entry: { kind: 'list', feed: { kind: 'subscriptions' } } },
      { type: 'select-thread', tabId: id, thread: thread('300') }
    )
    const tab = activeTab(after)
    expect(tab.entries).toHaveLength(3)
    expect(currentEntry(tab)).toMatchObject({ kind: 'list', feed: { kind: 'subscriptions' }, thread: { threadId: '300' }, pane: 'reader' })
    expect(currentEntry(activeTab(run(after, { type: 'back', tabId: id })))).toMatchObject({ kind: 'list', feed: forum4 })
  })
})
