import { describe, expect, it } from 'vitest'
import type { Post } from '../../src/shared/forum'
import { parseWorkspace, serializeWorkspace, type Workspace } from '../../src/renderer/src/features/tabs/workspaceSnapshot'
import type { TabsState } from '../../src/renderer/src/features/tabs/tabsState'

const head: Post = {
  id: '100', forumId: '4', createdAt: null, userHash: 'abc', name: null, title: '标题', isAdmin: null, isSage: false,
  content: [{ type: 'text', text: '主帖' }, { type: 'lineBreak' }, { type: 'greentext', children: [{ type: 'quoteRef', postId: '99', raw: '>>No.99' }] }],
  plainText: '主帖\n>>No.99', image: { path: '2026-10-24/abc', ext: '.png' }
}

const anchor = { postId: '105', page: 3, offsetRatio: 0.25, viewportOffset: 120 }

function workspace(): Workspace {
  const tabs: TabsState = {
    tabs: [
      {
        id: 1, split: true, index: 1,
        entries: [
          { kind: 'list', key: 1, feed: { kind: 'timeline', id: '1' }, thread: null, pane: 'list', origin: null },
          { kind: 'list', key: 2, feed: { kind: 'forum', id: '4' }, pane: 'reader', origin: 'quote',
            thread: { threadId: '100', head, target: { postId: '105', page: 3, mode: 'po' }, unlocatedPostId: null,
              snapshot: { mode: 'po', anchor, generation: 0, temporaryOf: 'all', focus: { postId: '100', quoteIndex: 0 } } } }
        ]
      },
      { id: 3, split: false, index: 0, entries: [{ kind: 'thread', key: 4, origin: null,
        thread: { threadId: '200', head: null, target: null, snapshot: null, unlocatedPostId: null } }] }
    ],
    activeId: 3,
    nextId: 4,
    nextKey: 5
  }
  return {
    tabs,
    editors: [{ tabId: 1, draftId: '12', expanded: false }],
    lists: [
      { entryKey: 1, pages: 2, anchor: { threadId: '300', offset: -12.5 }, scrollTop: 2484 },
      { entryKey: 2, pages: 10, anchor: null, scrollTop: 0 }
    ]
  }
}

describe('workspace snapshot', () => {
  it('restores tabs, active tab, history position, split, pane, list context and where each thread was left, without one-shot targets', () => {
    const restored = parseWorkspace(serializeWorkspace(workspace()))
    const expected = workspace()
    const entry = expected.tabs.tabs[0]!.entries[1]!
    if (entry.thread !== null) entry.thread.target = null
    expect(restored).toEqual(expected)
  })

  it('restores subscription tabs and quote-return entries with a fresh reading-data generation', () => {
    const value = workspace()
    const list = value.tabs.tabs[0]!.entries[1]!
    if (list.kind !== 'list' || list.thread?.snapshot == null) throw new Error('fixture')
    list.feed = { kind: 'subscriptions' }
    list.thread.snapshot.generation = 5
    const restored = parseWorkspace(serializeWorkspace(value))!
    const entry = restored.tabs.tabs[0]!.entries[1]!
    expect(entry).toMatchObject({ feed: { kind: 'subscriptions' }, origin: 'quote', thread: {
      target: null, snapshot: { generation: 0, temporaryOf: 'all', focus: { postId: '100', quoteIndex: 0 }, anchor }
    } })
  })

  it('starts fresh rather than half-restoring a malformed or inconsistent workspace', () => {
    const variants: Array<(value: ReturnType<typeof JSON.parse>) => void> = [
      (value) => (value.version = 2),
      (value) => (value.tabs.tabs[0].index = 2),
      (value) => (value.tabs.tabs[1].entries[0].key = 1),
      (value) => (value.tabs.tabs[1].id = 1),
      (value) => (value.tabs.activeId = 2),
      (value) => (value.tabs.nextKey = 4),
      (value) => (value.tabs.tabs[0].entries[1].thread.head.id = '101'),
      (value) => (value.tabs.tabs[0].entries[1].thread.head.content[0] = { type: 'html', html: '<b>' }),
      (value) => (value.tabs.tabs[0].entries[1].thread = null),
      (value) => (value.editors[0].tabId = 2),
      (value) => delete value.lists,
      (value) => (value.lists = {}),
      (value) => (value.lists[0].entryKey = 4),
      (value) => (value.lists[0].entryKey = 9),
      (value) => (value.tabs.tabs[0].entries[0].feed = null),
      (value) => (value.lists[1].entryKey = 1),
      (value) => (value.lists[0].pages = 0),
      (value) => (value.lists[1].pages = 11),
      (value) => (value.lists[0].pages = 1.5),
      (value) => (value.lists[0].anchor.threadId = 'abc'),
      (value) => (value.lists[0].anchor.offset = '1'),
      (value) => (value.lists[0].anchor = {}),
      (value) => (value.lists[0].scrollTop = -1),
      (value) => (value.lists[0].scrollTop = null),
      (value) => value.editors.push({ tabId: 3, draftId: '12', expanded: true })
    ]
    for (const change of variants) {
      const value = JSON.parse(serializeWorkspace(workspace()))
      change(value)
      expect(parseWorkspace(JSON.stringify(value))).toBeNull()
    }
    expect(parseWorkspace('{"version":1')).toBeNull()
  })
})
