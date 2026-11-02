import { describe, expect, it } from 'vitest'
import { imageRevealsReducer, INITIAL_IMAGE_REVEALS, revealView, revealsOn, type ImageRevealsState } from '../../src/renderer/src/features/image/imageMaskState'
import { activeTab, currentEntry, initialTabsState, tabsReducer, type TabsState, type ThreadOpen } from '../../src/renderer/src/features/tabs/tabsState'

const thread = (threadId: string): ThreadOpen => ({ threadId, head: null, target: null, snapshot: null, unlocatedPostId: null })
function opened() {
  let tabs = initialTabsState(true)
  tabs = tabsReducer(tabs, { type: 'navigate', tabId: tabs.activeId, entry: { kind: 'list', feed: { kind: 'forum', id: '4' } } })
  return tabsReducer(tabs, { type: 'select-thread', tabId: tabs.activeId, thread: thread('100') })
}
function sync(state: ImageRevealsState, tabs: TabsState, singlePane = false) {
  return imageRevealsReducer(state, { type: 'sync', views: new Map(tabs.tabs.map(tab => [tab.id, revealView(tab, tab.id === tabs.activeId, singlePane)])) })
}
function reveal(state: ImageRevealsState, tabs: TabsState, postId = '101') {
  return imageRevealsReducer(state, { type: 'reveal', tabId: tabs.activeId, page: revealView(activeTab(tabs)!, true, false)!.page, postId })
}
function shown(state: ImageRevealsState, tabs: TabsState, singlePane = false) {
  return revealsOn(state.tabs.get(tabs.activeId), revealView(activeTab(tabs)!, true, singlePane)).has('101')
}

describe('image masking page visits', () => {
  it('retains revealed images through reading snapshots and background tab creation, but not a foreground tab round trip', () => {
    let tabs = opened()
    const source = tabs.activeId
    let state = reveal(sync(INITIAL_IMAGE_REVEALS, tabs), tabs)
    tabs = tabsReducer(tabs, { type: 'snapshot', tabId: source, entryKey: currentEntry(activeTab(tabs)!).key, snapshot: {
      mode: 'po', anchor: { postId: '101', page: 2, offsetRatio: 0.4, viewportOffset: 60 }, generation: 2, temporaryOf: null, focus: null
    } })
    state = sync(state, tabs)
    expect(shown(state, tabs)).toBe(true)
    tabs = tabsReducer(tabs, { type: 'open-tab', entry: { kind: 'thread', thread: thread('100') }, split: true, background: true })
    state = sync(state, tabs)
    expect(shown(state, tabs)).toBe(true)
    const other = tabs.tabs.find(tab => tab.id !== source)!.id
    tabs = tabsReducer(tabs, { type: 'activate', tabId: other })
    state = sync(state, tabs)
    expect(shown(state, tabs)).toBe(false)
    state = reveal(state, tabs)
    tabs = tabsReducer(tabs, { type: 'activate', tabId: source })
    state = sync(state, tabs)
    expect(shown(state, tabs)).toBe(false)
    expect(state.tabs.get(other)!.revealed.has('101')).toBe(false)
  })

  it('re-covers images after replacing the split reader or leaving for settings', () => {
    let tabs = opened()
    const source = tabs.activeId
    let state = reveal(sync(INITIAL_IMAGE_REVEALS, tabs), tabs)
    const previousPage = revealView(activeTab(tabs)!, true, false)!.page
    tabs = tabsReducer(tabs, { type: 'select-thread', tabId: source, thread: thread('200') })
    state = sync(state, tabs)
    state = imageRevealsReducer(state, { type: 'reveal', tabId: source, page: previousPage, postId: '101' })
    tabs = tabsReducer(tabs, { type: 'select-thread', tabId: source, thread: thread('100') })
    state = sync(state, tabs)
    expect(shown(state, tabs)).toBe(false)
    state = reveal(state, tabs)
    tabs = tabsReducer(tabs, { type: 'open-settings' })
    state = sync(state, tabs)
    tabs = tabsReducer(tabs, { type: 'activate', tabId: source })
    state = sync(state, tabs)
    expect(shown(state, tabs)).toBe(false)
  })

  it('global re-enable invalidates revealed images and the original viewer visit without changing the page', () => {
    const tabs = opened()
    let state = reveal(sync(INITIAL_IMAGE_REVEALS, tabs), tabs)
    const originalVisit = state.tabs.get(tabs.activeId)!.visit
    state = imageRevealsReducer(state, { type: 'reset' })
    expect(shown(state, tabs)).toBe(false)
    expect(state.tabs.get(tabs.activeId)!.visit).not.toBe(originalVisit)
    expect(state.tabs.get(tabs.activeId)!.page).toBe(revealView(activeTab(tabs)!, true, false)!.page)
  })

  it('covers before paint when a pane leaves, but keeps reveals when widening only adds the list', () => {
    let tabs = opened()
    let state = reveal(sync(INITIAL_IMAGE_REVEALS, tabs, true), tabs)
    expect(shown(state, tabs, true)).toBe(true)
    state = sync(state, tabs, false)
    expect(shown(state, tabs)).toBe(true)
    expect(shown(state, tabs, true)).toBe(false)
    state = reveal(sync(state, tabs, true), tabs)
    tabs = tabsReducer(tabs, { type: 'show-pane', tabId: tabs.activeId, pane: 'list' })
    expect(shown(state, tabs, true)).toBe(false)
    state = sync(state, tabs, true)
    tabs = tabsReducer(tabs, { type: 'show-pane', tabId: tabs.activeId, pane: 'reader' })
    state = sync(state, tabs, true)
    expect(shown(state, tabs, true)).toBe(false)
  })

  it('ends a local subpage visit without clearing other tabs, and ignores departed-page events', () => {
    const views = new Map([
      [1, { page: 'history', list: true, reader: false }],
      [2, { page: 'subscriptions', list: true, reader: true }]
    ])
    let state = imageRevealsReducer(INITIAL_IMAGE_REVEALS, { type: 'sync', views })
    state = imageRevealsReducer(state, { type: 'reveal', tabId: 1, page: 'history', postId: '101' })
    state = imageRevealsReducer(state, { type: 'reveal', tabId: 2, page: 'subscriptions', postId: '101' })
    const originalVisit = state.tabs.get(1)!.visit
    state = imageRevealsReducer(state, { type: 'leave', tabId: 1, page: 'history' })
    expect(state.tabs.get(1)!.revealed.has('101')).toBe(false)
    expect(state.tabs.get(1)!.visit).not.toBe(originalVisit)
    expect(state.tabs.get(2)!.revealed.has('101')).toBe(true)
    state = imageRevealsReducer(state, { type: 'reveal', tabId: 1, page: 'history', postId: '101' })
    state = imageRevealsReducer(state, { type: 'sync', views })
    expect(state.tabs.get(1)!.revealed.has('101')).toBe(true)
    for (const page of [null, 'departed']) {
      state = imageRevealsReducer(state, { type: 'leave', tabId: 1, page })
      expect(state.tabs.get(1)!.revealed.has('101')).toBe(true)
    }
    state = imageRevealsReducer(state, { type: 'leave', tabId: 1, page: 'history' })
    expect(state.tabs.get(1)!.revealed.has('101')).toBe(false)
  })
})
