import { describe, expect, it } from 'vitest'
import { composeTargetsOf } from '../../src/renderer/src/app/TabView'
import { activeTab, initialTabsState, tabsReducer, type TabsAction, type TabsState, type ThreadOpen } from '../../src/renderer/src/features/tabs/tabsState'

const thread = (threadId: string): ThreadOpen => ({ threadId, head: null, target: null, snapshot: null, unlocatedPostId: null })
const run = (state: TabsState, ...actions: TabsAction[]) => actions.reduce(tabsReducer, state)
const targets = (state: TabsState) => composeTargetsOf(activeTab(state))

describe('editor panels a tab shows', () => {
  it('keeps both panels of a split forum list whichever pane the single-pane fallback shows', () => {
    const start = initialTabsState(true)
    const id = start.activeId
    const split = run(start, { type: 'navigate', tabId: id, entry: { kind: 'list', feed: { kind: 'forum', id: '4' } } },
      { type: 'select-thread', tabId: id, thread: thread('100') })
    const both = [{ kind: 'thread', forumId: '4' }, { kind: 'reply', threadId: '100' }]
    expect(targets(run(split, { type: 'show-pane', tabId: id, pane: 'reader' }))).toEqual(both)
    expect(targets(run(split, { type: 'show-pane', tabId: id, pane: 'list' }))).toEqual(both)
  })

  it('shows a page thread’s replies, a forum’s new threads without split, and nothing for lists without a target', () => {
    const page = initialTabsState(false)
    const id = page.activeId
    const forum = run(page, { type: 'navigate', tabId: id, entry: { kind: 'list', feed: { kind: 'forum', id: '4' } } })
    expect(targets(forum)).toEqual([{ kind: 'thread', forumId: '4' }])
    expect(targets(run(forum, { type: 'select-thread', tabId: id, thread: thread('100') }))).toEqual([{ kind: 'reply', threadId: '100' }])
    const subscriptions = run(initialTabsState(true), { type: 'navigate', tabId: id, entry: { kind: 'list', feed: { kind: 'subscriptions' } } })
    expect(targets(subscriptions)).toEqual([])
    expect(targets(run(subscriptions, { type: 'select-thread', tabId: id, thread: thread('300') }))).toEqual([{ kind: 'reply', threadId: '300' }])
  })
})
