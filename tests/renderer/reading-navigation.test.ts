import { describe, expect, it, vi } from 'vitest'
import { navigationHarness } from './helpers/readingNavigation'
import { navigationSeeds } from '../../src/renderer/src/features/tabs/readingNavigation'
import { currentEntry, initialTabsState, tabsReducer, type ThreadOpen, type ThreadSnapshot } from '../../src/renderer/src/features/tabs/tabsState'

const thread = (threadId: string, postId: string | null = null): ThreadOpen => ({ threadId, head: null, target: postId === null ? null : { postId, page: 2, mode: 'all' }, snapshot: null, unlocatedPostId: null })
const snapshot = (postId: string): ThreadSnapshot => ({ mode: 'po', anchor: { postId, page: 1, offsetRatio: 0.3, viewportOffset: 70 }, generation: 2, temporaryOf: null, focus: null })
function reading() {
  let tabs = tabsReducer(initialTabsState(true), { type: 'navigate', tabId: 1, entry: { kind: 'list', feed: { kind: 'history' } } })
  tabs = tabsReducer(tabs, { type: 'select-thread', tabId: 1, thread: thread('100') })
  return tabs
}

describe('reading navigation through its consumer interface', () => {
  it('accepts one of two jumps from the same source before touching the second reader target', async () => {
    const showInPlace = vi.fn(() => false)
    const host = navigationHarness(reading(), { showInPlace })
    const from = host.navigation.source({ tabId: 1 })!
    const a = host.navigation.open(from, { kind: 'quote', thread: thread('200', '201') })
    const b = host.navigation.open(from, { kind: 'quote', thread: thread('300', '301') })
    host.flush()
    expect(await a).toEqual({ kind: 'history', tabId: 1, entryKey: 3 })
    expect(await b).toEqual({ kind: 'rejected', reason: 'stale' })
    expect(showInPlace.mock.calls).toEqual([['200', { postId: '201', page: 2, mode: 'all' }]])
    expect(currentEntry(host.tabs.tabs[0]!)).toMatchObject({ origin: 'quote', thread: { threadId: '200' } })
  })

  it('makes a complete list seed available at the first render and preserves newer child memory', async () => {
    const inherited = { kind: 'retained', scrollTop: 317, history: { view: 'replies', sentScroll: { threads: 19, replies: 263 } } } as const
    const rendered: unknown[] = []
    const host = navigationHarness(reading(), { beforeCommit(state) {
      for (const [key, seed] of navigationSeeds(state)) {
        rendered.push({ key, seed, alreadyStored: host.registry.listMemory.has(key) })
        host.registry.listMemory.set(key, { ...inherited, scrollTop: 401 })
      }
    } })
    const from = host.navigation.source({ tabId: 1 })!
    host.registry.listMemory.set(from.entryKey, inherited)
    const result = host.navigation.open(from, { kind: 'history', entry: { kind: 'thread', thread: thread('200') } })
    host.flush()
    expect(await result).toMatchObject({ kind: 'history', entryKey: 3 })
    expect(rendered).toEqual([{ key: 3, seed: inherited, alreadyStored: false }])
    expect(host.registry.listMemory.get(3)).toEqual({ ...inherited, scrollTop: 401 })
  })

  it('rejects a quote after the split reader changes without changing the entry key', async () => {
    const showInPlace = vi.fn(() => true)
    const host = navigationHarness(reading(), { showInPlace })
    const from = host.navigation.source({ tabId: 1 })!
    const result = host.navigation.open(from, { kind: 'quote', thread: thread('200', '201') })
    host.dispatch({ type: 'select-thread', tabId: 1, thread: thread('900') })
    host.flush()
    expect(await result).toEqual({ kind: 'rejected', reason: 'stale' })
    expect(showInPlace).not.toHaveBeenCalled()
    expect(currentEntry(host.tabs.tabs[0]!)).toMatchObject({ key: from.entryKey, thread: { threadId: '900' } })
    expect([...host.registry.listMemory]).toEqual([])
  })

  it('rechecks cancellation after enqueue and does not highlight or capture a withdrawn jump', async () => {
    let current = true
    const capture = vi.fn(() => snapshot('101'))
    const showInPlace = vi.fn(() => true)
    const host = navigationHarness(reading(), { capture, showInPlace })
    const before = host.tabs
    const result = host.navigation.open(host.navigation.source({ tabId: 1 })!, { kind: 'search', thread: thread('100', '101'), isCurrent: () => current })
    current = false
    host.flush()
    expect(await result).toEqual({ kind: 'rejected', reason: 'stale' })
    expect(host.tabs).toBe(before)
    expect(capture).not.toHaveBeenCalled()
    expect(showInPlace).not.toHaveBeenCalled()
  })

  it('highlights visible quote/search targets without history, capture or replayed effects', async () => {
    for (const kind of ['quote', 'search'] as const) {
      const capture = vi.fn(() => snapshot('101'))
      const showInPlace = vi.fn(() => true)
      const host = navigationHarness(reading(), { capture, showInPlace })
      const before = host.tabs
      const result = host.navigation.open(host.navigation.source({ tabId: 1 })!, { kind, thread: thread('100', '101') })
      host.batch()
      host.replay()
      host.flush()
      expect(await result).toEqual({ kind: 'in-place' })
      expect(host.tabs).toBe(before)
      expect(showInPlace).toHaveBeenCalledTimes(1)
      expect(capture).not.toHaveBeenCalled()
    }
  })

  it('opens a fresh new tab without inheriting source list memory or changing its history', async () => {
    const capture = vi.fn(() => snapshot('101'))
    const host = navigationHarness(reading(), { capture, showInPlace: () => true })
    const before = host.tabs.tabs[0]
    const from = host.navigation.source({ tabId: 1 })!
    host.registry.listMemory.set(from.entryKey, { kind: 'retained', scrollTop: 317 })
    const result = host.navigation.open(from, { kind: 'quote', thread: thread('200', '201'), newTab: true })
    host.flush()
    expect(await result).toEqual({ kind: 'new-tab', tabId: 2, entryKey: 3 })
    expect(host.tabs.tabs[0]).toBe(before)
    expect(host.tabs.tabs[1]).toMatchObject({ split: true, index: 0, entries: [{ kind: 'list', feed: { kind: 'history' }, origin: null }] })
    expect(host.registry.listMemory.has(3)).toBe(false)
    expect(capture).not.toHaveBeenCalled()
  })

  it('returns from a sent reply to the send-start snapshot and keeps the reader mount identity', async () => {
    let position = snapshot('101')
    const host = navigationHarness(reading(), { capture: () => position, showInPlace: () => true })
    const origin = host.navigation.source({ tabId: 1, timing: 'send-start' })!
    position = snapshot('150')
    const result = host.navigation.open(host.navigation.source({ tabId: 1 })!, { kind: 'sent-reply', thread: thread('100', '180'), snapshot: origin.snapshot })
    host.flush()
    expect(await result).toMatchObject({ kind: 'history' })
    expect(currentEntry(host.tabs.tabs[0]!)).toMatchObject({ origin: null, thread: { readerKey: origin.entryKey, target: { postId: '180' } } })
    host.dispatch({ type: 'back', tabId: 1 })
    host.flush()
    expect(currentEntry(host.tabs.tabs[0]!)).toMatchObject({ thread: { snapshot: snapshot('101') } })
  })

  it('uses the current snapshot when the send-start snapshot was unavailable', async () => {
    const host = navigationHarness(reading(), { capture: () => snapshot('150') })
    const result = host.navigation.open(host.navigation.source({ tabId: 1 })!, { kind: 'sent-reply', thread: thread('100', '180'), snapshot: null })
    host.flush()
    await result
    host.dispatch({ type: 'back', tabId: 1 })
    host.flush()
    expect(currentEntry(host.tabs.tabs[0]!)).toMatchObject({ thread: { snapshot: snapshot('150') } })
  })

  it('retains ordinary split selection but creates a step for an explicit target in the shown thread', async () => {
    const host = navigationHarness(reading())
    const sourceKey = currentEntry(host.tabs.tabs[0]!).key
    const selected = host.navigation.open(host.navigation.source({ tabId: 1 })!, { kind: 'list-target', thread: thread('200', '201') })
    host.flush()
    expect(await selected).toEqual({ kind: 'selected', tabId: 1, entryKey: sourceKey })
    const jump = host.navigation.open(host.navigation.source({ tabId: 1 })!, { kind: 'list-target', thread: thread('200', '250') })
    host.flush()
    expect(await jump).toEqual({ kind: 'history', tabId: 1, entryKey: 3 })
    host.dispatch({ type: 'back', tabId: 1 })
    host.flush()
    expect(currentEntry(host.tabs.tabs[0]!)).toMatchObject({ thread: { target: { postId: '201' } } })
  })

  it('settles pending navigation on unmount without committing it', async () => {
    const host = navigationHarness(reading())
    const before = host.tabs
    const result = host.navigation.open(host.navigation.source({ tabId: 1 })!, { kind: 'search', thread: thread('200') })
    host.dispose()
    host.flush()
    expect(await result).toEqual({ kind: 'rejected', reason: 'unavailable' })
    expect(host.tabs).toBe(before)
  })
})
