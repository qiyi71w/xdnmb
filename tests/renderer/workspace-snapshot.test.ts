import { describe, expect, it } from 'vitest'
import type { Post } from '../../src/shared/forum'
import { parseWorkspace, serializeWorkspace, type Workspace } from '../../src/renderer/src/features/tabs/workspaceSnapshot'
import { initialTabsState, tabsReducer, type TabsState } from '../../src/renderer/src/features/tabs/tabsState'
import { MAX_WORKSPACE_LENGTH } from '../../src/shared/lifecycle'

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
    settings: null,
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

/** The same workspace with 设置 open between the two content tabs, active, returning to tab 1. */
function withSettings(): Workspace {
  const value = workspace()
  value.tabs = { ...value.tabs, settings: { kind: 'settings', id: 4, at: 1, returnTo: 1 }, activeId: 4, nextId: 5 }
  return value
}

describe('workspace snapshot', () => {
  it('restores long navigation history and other tabs within the shared storage limit', () => {
    let tabs = initialTabsState(true)
    const tabId = tabs.activeId
    for (let index = 0; index < 1000; index++) {
      tabs = tabsReducer(tabs, { type: 'navigate', tabId, entry: { kind: 'list', feed: { kind: 'forum', id: index % 2 ? '4' : '5' } } })
    }
    tabs = tabsReducer(tabs, { type: 'open-tab', entry: { kind: 'list', feed: null }, split: true })
    const value = { tabs, editors: [], lists: [] }
    const serialized = serializeWorkspace(value)
    expect(serialized.length).toBeLessThan(MAX_WORKSPACE_LENGTH)
    const restored = parseWorkspace(serialized)
    expect(restored).not.toBeNull()
    expect(restored).toEqual(value)
    expect(parseWorkspace(serialized.padEnd(MAX_WORKSPACE_LENGTH + 1))).toBeNull()
  })

  it('restores every open tab and saved editor without parser-only count limits', () => {
    let tabs = initialTabsState(true)
    for (let index = 0; index < 1000; index++) {
      tabs = tabsReducer(tabs, { type: 'open-tab', entry: { kind: 'list', feed: null }, split: true })
    }
    const value = { tabs, editors: tabs.tabs.map(({ id }) => ({ tabId: id, draftId: String(id), expanded: false })), lists: [] }
    const serialized = serializeWorkspace(value)
    expect(serialized.length).toBeLessThan(MAX_WORKSPACE_LENGTH)
    const restored = parseWorkspace(serialized)
    expect(restored).not.toBeNull()
    expect(restored).toEqual(value)
  })

  it('restores an online page empty and persists search-origin reader steps as ordinary history', () => {
    const value = workspace()
    value.tabs.tabs[0]!.entries.push({ kind: 'online-search', key: 5, origin: null })
    value.tabs.nextKey = 6
    value.tabs.tabs[1]!.entries[0]!.origin = 'local-search'
    value.tabs.tabs[0]!.entries[1]!.origin = 'online-search'
    const restored = parseWorkspace(serializeWorkspace(value))
    expect(restored?.tabs.tabs[0]!.entries[2]).toEqual({ kind: 'online-search', key: 5, origin: null })
    expect(restored?.tabs.tabs[0]!.entries[1]?.origin).toBeNull()
    expect(restored?.tabs.tabs[1]!.entries[0]?.origin).toBeNull()
    expect(restored?.tabs.activeId).toBe(3)
  })

  it('restores tabs, active tab, history position, split, pane, list context and where each thread was left, without one-shot targets', () => {
    const restored = parseWorkspace(serializeWorkspace(workspace()))
    const expected = workspace()
    const entry = expected.tabs.tabs[0]!.entries[1]!
    if (entry.kind !== 'online-search' && entry.thread !== null) entry.thread.target = null
    expect(restored).toEqual(expected)
  })

  it('keeps No. reading candidates and link clues of a saved main post, and rejects malformed ones', () => {
    const value = workspace()
    const entry = value.tabs.tabs[0]!.entries[1]!
    const saved = entry.kind === 'online-search' ? null : entry.thread?.head
    if (saved == null) throw new Error('fixture')
    saved.content = [
      { type: 'quoteRef', postId: '12345678901234567890', raw: 'No.12345678901234567890', readingOnly: true },
      { type: 'quoteRef', postId: '68810699', raw: 'https://www.nmbxd1.com/t/68810621?r=68810699', hint: { threadId: '68810621', page: null } },
      { type: 'quoteRef', postId: '68810621', raw: 'https://www.nmbxd1.com/t/68810621?page=3', hint: { threadId: '68810621', page: 3 } }
    ]
    const restored = parseWorkspace(serializeWorkspace(value))!.tabs.tabs[0]!.entries[1]!
    expect(restored.kind === 'online-search' ? null : restored.thread?.head?.content).toEqual(saved.content)

    const variants: Array<(node: Record<string, unknown>) => void> = [
      (node) => (node.readingOnly = false),
      (node) => (node.hint = { threadId: '68810621', page: 0 }),
      (node) => (node.hint = { threadId: 'x', page: null }),
      (node) => (node.hint = null)
    ]
    for (const change of variants) {
      const raw = JSON.parse(serializeWorkspace(value))
      change(raw.tabs.tabs[0].entries[1].thread.head.content[0])
      expect(parseWorkspace(JSON.stringify(raw))).toBeNull()
    }
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

  it('restores a workspace saved before the 设置 tab existed, with no 设置 tab', () => {
    const value = JSON.parse(serializeWorkspace(workspace()))
    delete value.tabs.settings
    const restored = parseWorkspace(JSON.stringify(value))
    expect(restored?.tabs.settings).toBeNull()
    expect(restored?.tabs.tabs.map((tab) => tab.id)).toEqual([1, 3])
    expect(restored?.editors).toEqual([{ tabId: 1, draftId: '12', expanded: false }])
  })

  it('restores the one 设置 tab with its place, active state and return target; a closed return target falls back', () => {
    expect(parseWorkspace(serializeWorkspace(withSettings()))).toEqual((() => {
      const expected = withSettings()
      const entry = expected.tabs.tabs[0]!.entries[1]!
      if (entry.kind !== 'online-search' && entry.thread !== null) entry.thread.target = null
      return expected
    })())
    const value = JSON.parse(serializeWorkspace(withSettings()))
    value.tabs.settings.returnTo = 2
    expect(parseWorkspace(JSON.stringify(value))?.tabs.settings).toEqual({ kind: 'settings', id: 4, at: 1, returnTo: null })
  })

  it('starts fresh rather than restoring a duplicated, embedded or editor-owning 设置 tab', () => {
    const variants: Array<(value: ReturnType<typeof JSON.parse>) => void> = [
      // A second 设置 among the content tabs, or 设置 shaped like a content tab.
      (value) => value.tabs.tabs.push({ kind: 'settings', id: 6, at: 0, returnTo: null }),
      (value) => value.tabs.tabs.push({ ...value.tabs.tabs[1], kind: 'settings', id: 6 }),
      (value) => (value.tabs.settings.entries = value.tabs.tabs[1].entries),
      (value) => (value.tabs.settings.split = true),
      (value) => (value.tabs.settings.kind = 'list'),
      (value) => (value.tabs.settings.id = 3),
      (value) => (value.tabs.settings.at = 3),
      (value) => (value.tabs.settings.returnTo = '1'),
      (value) => (value.tabs.nextId = 4),
      (value) => (value.editors[0].tabId = 4),
      (value) => (value.tabs.tabs = [])
    ]
    for (const change of variants) {
      const value = JSON.parse(serializeWorkspace(withSettings()))
      change(value)
      expect(parseWorkspace(JSON.stringify(value))).toBeNull()
    }
  })
})
