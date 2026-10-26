import type { DraftId } from '../../../../shared/drafts'
import type { ContentNode, Post } from '../../../../shared/forum'
import type { ReadingAnchor } from '../../../../shared/reading'
import { entryThread, type ListRef, type Tab, type TabEntry, type TabsState, type ThreadOpen, type ThreadSnapshot } from './tabsState'

/**
 * The workspace saved at a real quit and restored at the next start: every tab with its own
 * navigation history, current entry, split preference and single-pane side, where each shown thread
 * was left, how far each list was loaded and where it was scrolled, and which saved drafts each tab
 * was continuing. Unsaved editor content is never part of it (a real quit saves or discards it
 * first) and nothing in it sends anything.
 */
export interface WorkspaceEditor {
  tabId: number
  draftId: DraftId
  expanded: boolean
}

export interface WorkspaceList {
  /** Key of a `list` history entry with a feed, in some tab. */
  entryKey: number
  /** Pages that were loaded (1..10, cap larger counts at 10); read again from page 1 on restore. */
  pages: number
  /** First visible thread and the offset of its row top from the scroller top (px, may be negative). */
  anchor: { threadId: string; offset: number } | null
  /** Fallback position when the anchor thread is not in the restored list (px, >= 0). */
  scrollTop: number
  /** Subscription panes restore their persisted observation, without replaying preview or writes. */
  subscriptionView?: 'list' | 'reconcile'
}

export interface Workspace {
  tabs: TabsState
  editors: WorkspaceEditor[]
  lists: WorkspaceList[]
}

/** Most pages a restored list reads again before placing its position. */
export const MAX_LIST_PAGES = 10

const VERSION = 1
const MAX_TABS = 500
const MAX_ENTRIES = 1_000
const MAX_EDITORS = 1_000
const MAX_CONTENT_DEPTH = 32
const FORUM_ID = /^\d{1,20}$/
const DRAFT_ID = /^[1-9]\d{0,14}$/

/**
 * One-shot targets (quotes, search hits, a reminder's first new page) are dropped: once restarted, the thread
 * opens where it was left (the entry's snapshot) or at its saved reading position. Search sessions (the local search sheet
 * and online search pages) are not kept past the run either: an entry opened from a search result
 * comes back as a plain step (plain 后退), and an online search page comes back empty, without its
 * query or results and without any request.
 */
export function serializeWorkspace(workspace: Workspace): string {
  const tabs: TabsState = {
    ...workspace.tabs,
    tabs: workspace.tabs.tabs.map((tab) => ({
      ...tab,
      entries: tab.entries.map((item) => {
        const entry = item.origin === 'local-search' || item.origin === 'online-search' ? ({ ...item, origin: null } as TabEntry) : item
        const thread = entryThread(entry)
        return thread === null ? entry : ({ ...entry, thread: { ...thread, target: null,
          snapshot: thread.snapshot === null ? null : { ...thread.snapshot, generation: 0 } } } as TabEntry)
      })
    }))
  }
  return JSON.stringify({ version: VERSION, tabs, editors: workspace.editors, lists: workspace.lists })
}

class Invalid extends Error {}

function fail(): never {
  throw new Invalid()
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : fail()
}

function array(value: unknown, max: number): unknown[] {
  return Array.isArray(value) && value.length <= max ? value : fail()
}

function integer(value: unknown, min: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min ? value : fail()
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : fail()
}

function nullableString(value: unknown): string | null {
  return value === null ? null : string(value)
}

function nullableBoolean(value: unknown): boolean | null {
  return value === null || typeof value === 'boolean' ? value : fail()
}

function forumId(value: unknown): string {
  return typeof value === 'string' && FORUM_ID.test(value) ? value : fail()
}

function feedRef(value: unknown): ListRef {
  const input = object(value)
  if (input.kind === 'subscriptions' || input.kind === 'reminders' || input.kind === 'history' || input.kind === 'offline') {
    return { kind: input.kind }
  }
  if (input.kind !== 'forum' && input.kind !== 'timeline') fail()
  return { kind: input.kind, id: forumId(input.id) }
}

const EMPHASIS = new Set(['bold', 'italic', 'underline', 'strike', 'small', 'sup', 'sub'])

function contentNodes(value: unknown, depth: number): ContentNode[] {
  if (depth > MAX_CONTENT_DEPTH) fail()
  return array(value, Number.MAX_SAFE_INTEGER).map((item): ContentNode => {
    const node = object(item)
    switch (node.type) {
      case 'text':
        return { type: 'text', text: string(node.text) }
      case 'lineBreak':
        return { type: 'lineBreak' }
      case 'quoteRef':
        return { type: 'quoteRef', postId: forumId(node.postId), raw: string(node.raw) }
      case 'emphasis':
        if (!EMPHASIS.has(node.style as string)) fail()
        return { type: 'emphasis', style: node.style as never, children: contentNodes(node.children, depth + 1) }
      case 'greentext':
        return { type: 'greentext', children: contentNodes(node.children, depth + 1) }
      case 'link': {
        const href = string(node.href)
        if (!URL.canParse(href) || !['http:', 'https:'].includes(new URL(href).protocol)) fail()
        return { type: 'link', href, children: contentNodes(node.children, depth + 1) }
      }
      default:
        return fail()
    }
  })
}

/** The main post kept to title the tab until page 1 arrives; it must be this thread's own. */
function head(value: unknown, threadId: string): Post | null {
  if (value === null) return null
  const input = object(value)
  if (forumId(input.id) !== threadId) fail()
  const image = input.image === null ? null : object(input.image)
  return {
    id: threadId,
    forumId: input.forumId === null ? null : forumId(input.forumId),
    createdAt: nullableString(input.createdAt),
    userHash: nullableString(input.userHash),
    name: nullableString(input.name),
    title: nullableString(input.title),
    isAdmin: nullableBoolean(input.isAdmin),
    isSage: nullableBoolean(input.isSage),
    content: contentNodes(input.content, 0),
    plainText: string(input.plainText),
    image: image === null ? null : { path: string(image.path), ext: string(image.ext) }
  }
}

function anchor(value: unknown): ReadingAnchor {
  const input = object(value)
  const { offsetRatio, viewportOffset } = input
  if (typeof offsetRatio !== 'number' || !Number.isFinite(offsetRatio) || offsetRatio < 0 || offsetRatio > 1) fail()
  if (typeof viewportOffset !== 'number' || !Number.isFinite(viewportOffset) || Math.abs(viewportOffset) > 100_000) fail()
  return { postId: forumId(input.postId), page: integer(input.page, 1), offsetRatio, viewportOffset }
}

function snapshot(value: unknown): ThreadSnapshot | null {
  if (value === null) return null
  const input = object(value)
  if (input.mode !== 'all' && input.mode !== 'po') fail()
  const temporaryOf = input.temporaryOf ?? null
  if (temporaryOf !== null && temporaryOf !== 'all' && temporaryOf !== 'po') fail()
  const focus = input.focus == null ? null : object(input.focus)
  return { mode: input.mode, anchor: anchor(input.anchor), generation: 0, temporaryOf,
    focus: focus === null ? null : { postId: forumId(focus.postId), quoteIndex: integer(focus.quoteIndex, 0) } }
}

function threadOpen(value: unknown): ThreadOpen {
  const input = object(value)
  const threadId = forumId(input.threadId)
  return { threadId, head: head(input.head, threadId), target: null, snapshot: snapshot(input.snapshot),
    unlocatedPostId: input.unlocatedPostId == null ? null : forumId(input.unlocatedPostId) }
}

function entry(value: unknown): TabEntry {
  const input = object(value)
  const key = integer(input.key, 1)
  const origin = input.origin ?? null
  if (origin !== null && origin !== 'quote') fail()
  if (input.kind === 'thread') return { kind: 'thread', key, thread: threadOpen(input.thread), origin }
  if (input.kind === 'online-search') return { kind: 'online-search', key, origin }
  if (input.kind !== 'list') fail()
  const thread = input.thread === null ? null : threadOpen(input.thread)
  if (input.pane !== 'list' && input.pane !== 'reader') fail()
  if (input.pane === 'reader' && thread === null) fail()
  return { kind: 'list', key, feed: input.feed === null ? null : feedRef(input.feed), thread, pane: input.pane, origin }
}

function tab(value: unknown): Tab {
  const input = object(value)
  if (typeof input.split !== 'boolean') fail()
  const entries = array(input.entries, MAX_ENTRIES).map(entry)
  const index = integer(input.index, 0)
  if (entries.length === 0 || index >= entries.length) fail()
  return { id: integer(input.id, 1), split: input.split, entries, index }
}

function listAnchor(value: unknown): WorkspaceList['anchor'] {
  if (value === null) return null
  const input = object(value)
  if (typeof input.offset !== 'number' || !Number.isFinite(input.offset)) fail()
  return { threadId: forumId(input.threadId), offset: input.offset }
}

/**
 * Reads a workspace written by `serializeWorkspace`. Anything malformed or inconsistent (unknown
 * version, duplicate tab IDs or entry keys, counters not past every ID, an editor of an unknown tab
 * or a draft continued twice, list context for anything but a list entry with a feed or twice for
 * one) gives `null`: the app then starts with a new workspace rather than a partly restored one.
 */
export function parseWorkspace(text: string): Workspace | null {
  try {
    const input = object(JSON.parse(text))
    if (input.version !== VERSION) fail()
    const state = object(input.tabs)
    const tabs = array(state.tabs, MAX_TABS).map(tab)
    if (tabs.length === 0) fail()
    const ids = new Set(tabs.map((item) => item.id))
    const keys = new Set(tabs.flatMap((item) => item.entries.map((step) => step.key)))
    if (ids.size !== tabs.length || keys.size !== tabs.reduce((count, item) => count + item.entries.length, 0)) fail()
    const activeId = integer(state.activeId, 1)
    const nextId = integer(state.nextId, 1)
    const nextKey = integer(state.nextKey, 1)
    if (!ids.has(activeId) || nextId <= Math.max(...ids) || nextKey <= Math.max(...keys)) fail()

    const drafts = new Set<string>()
    const editors = array(input.editors, MAX_EDITORS).map((item): WorkspaceEditor => {
      const editor = object(item)
      const tabId = integer(editor.tabId, 1)
      const draftId = string(editor.draftId)
      if (!ids.has(tabId) || !DRAFT_ID.test(draftId) || drafts.has(draftId) || typeof editor.expanded !== 'boolean') fail()
      drafts.add(draftId)
      return { tabId, draftId, expanded: editor.expanded }
    })

    const feedEntries = new Set(
      tabs.flatMap((item) => item.entries.flatMap((step) => (step.kind === 'list' && step.feed !== null ? [step.key] : [])))
    )
    const listed = new Set<number>()
    const lists = array(input.lists, feedEntries.size).map((item): WorkspaceList => {
      const list = object(item)
      const entryKey = integer(list.entryKey, 1)
      if (!feedEntries.has(entryKey) || listed.has(entryKey)) fail()
      listed.add(entryKey)
      const pages = integer(list.pages, 1)
      const { scrollTop } = list
      if (pages > MAX_LIST_PAGES || typeof scrollTop !== 'number' || !Number.isFinite(scrollTop) || scrollTop < 0) fail()
      if (list.subscriptionView !== undefined && list.subscriptionView !== 'list' && list.subscriptionView !== 'reconcile') fail()
      return { entryKey, pages, anchor: listAnchor(list.anchor), scrollTop,
        ...(list.subscriptionView === undefined ? {} : { subscriptionView: list.subscriptionView }) }
    })
    return { tabs: { tabs, activeId, nextId, nextKey }, editors, lists }
  } catch {
    return null
  }
}
