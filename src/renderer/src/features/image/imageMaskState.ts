import type { PostId } from '../../../../shared/forum'
import { currentEntry, entryThread, type Tab } from '../tabs/tabsState'

/**
 * 图片遮罩 reveals: which masked thumbnails the user uncovered during the current visit of each
 * tab's page. Renderer memory only, never saved. A tab's reveals are cleared whenever that visit
 * ends — its page changes, a side it showed (list or reader) leaves the screen, or it stops being the
 * active tab — and when masking is turned on again (enabled, or its blur strength raised from 0%).
 */

/** What a tab shows now: its page and which of its sides are on screen. */
export interface RevealView {
  /**
   * A history step and the thread it holds (whole page, or beside its split list): another thread,
   * back / forward and new steps change it; scrolling, loading more pages, refreshing and 只看 PO
   * keep the entry and thread, so they keep it too. A step carrying the reader's mount identity
   * (`readerKey`: the in-place step after a confirmed send) keeps the page of the reader it
   * continues, like the reader itself (TabView keys the reader the same way).
   */
  page: string
  /** The list side is on screen (a list entry, unless the single pane shows its reader). */
  list: boolean
  /** The reader side is on screen with a thread (a whole-page thread, or beside its list). */
  reader: boolean
}

export interface PageReveals {
  /** The page of the visit (`RevealView.page`); null while the tab is not active. */
  page: string | null
  /** Sides on screen during the visit; one leaving the screen ends it, one appearing does not. */
  list: boolean
  reader: boolean
  /** Changes on every clear: a viewer opened during an earlier visit closes on it (`ImageViewer`). */
  visit: number
  /** Posts whose image is revealed; one post's image is the same in a list row, reader or quote card. */
  revealed: ReadonlySet<PostId>
}

export interface ImageRevealsState {
  /** Last `visit` number handed out. */
  visits: number
  tabs: ReadonlyMap<number, PageReveals>
}

export type ImageRevealsAction =
  /** What every content tab shows now (`revealView`); a tab whose visit ended starts a new one. */
  | { type: 'sync'; views: ReadonlyMap<number, RevealView | null> }
  /** Revealed on `page`; ignored once the tab shows another page. */
  | { type: 'reveal'; tabId: number; page: string | null; postId: PostId }
  /**
   * The page switched between its own local pages (历史 浏览／新串／回复, 订阅 list／同步与合并):
   * the visit on `page` ends; ignored once the tab shows another page or is not active.
   */
  | { type: 'leave'; tabId: number; page: string | null }
  /** Masking turned on: every tab starts a new visit. */
  | { type: 'reset' }

const NONE: ReadonlySet<PostId> = new Set()

export const INITIAL_IMAGE_REVEALS: ImageRevealsState = { visits: 0, tabs: new Map() }

/**
 * What tab `tab` shows for reveals; null while it is not the active tab, so leaving it ends the
 * visit. `singlePane`: the layout's single-pane fallback (computed for the active tab), where a split
 * entry shows either its list or its reader (`pane`), as TabView does.
 */
export function revealView(tab: Tab, active: boolean, singlePane: boolean): RevealView | null {
  if (!active) return null
  const entry = currentEntry(tab)
  const thread = entryThread(entry)
  const page = thread === null ? `${entry.key}` : `${thread.readerKey ?? entry.key}:${thread.threadId}`
  if (entry.kind !== 'list') return { page, list: entry.kind === 'online-search', reader: entry.kind === 'thread' }
  const split = entry.feed !== null && tab.split
  const single = split && singlePane
  const pane = entry.thread !== null ? entry.pane : 'list'
  return { page, list: !single || pane === 'list', reader: split && entry.thread !== null && (!single || pane === 'reader') }
}

/** The reveals that apply to `view` now: none before `sync` has carried the tab's visit over to it. */
export function revealsOn(reveals: PageReveals | undefined, view: RevealView | null): ReadonlySet<PostId> {
  return reveals !== undefined && view !== null && continues(reveals, view) ? reveals.revealed : NONE
}

/** Whether showing `view` continues the visit of `reveals`: same page, no side left the screen. */
function continues(reveals: PageReveals, view: RevealView | null): boolean {
  if (view === null) return reveals.page === null
  return reveals.page === view.page && (view.list || !reveals.list) && (view.reader || !reveals.reader)
}

export function imageRevealsReducer(state: ImageRevealsState, action: ImageRevealsAction): ImageRevealsState {
  switch (action.type) {
    case 'sync': {
      let visits = state.visits
      let changed = state.tabs.size !== action.views.size
      const tabs = new Map<number, PageReveals>()
      for (const [tabId, view] of action.views) {
        const current = state.tabs.get(tabId)
        const list = view?.list ?? false
        const reader = view?.reader ?? false
        if (current !== undefined && continues(current, view)) {
          // A side appearing (split turned on, a wider window) keeps the visit.
          const next = current.list === list && current.reader === reader ? current : { ...current, list, reader }
          if (next !== current) changed = true
          tabs.set(tabId, next)
          continue
        }
        changed = true
        tabs.set(tabId, { page: view?.page ?? null, list, reader, visit: ++visits, revealed: NONE })
      }
      return changed ? { visits, tabs } : state
    }
    case 'reveal': {
      const current = state.tabs.get(action.tabId)
      if (current === undefined || action.page === null || current.page !== action.page || current.revealed.has(action.postId)) return state
      const tabs = new Map(state.tabs)
      tabs.set(action.tabId, { ...current, revealed: new Set([...current.revealed, action.postId]) })
      return { ...state, tabs }
    }
    case 'leave': {
      const current = state.tabs.get(action.tabId)
      if (current === undefined || action.page === null || current.page !== action.page) return state
      const visits = state.visits + 1
      const tabs = new Map(state.tabs)
      tabs.set(action.tabId, { ...current, visit: visits, revealed: NONE })
      return { visits, tabs }
    }
    case 'reset': {
      if (state.tabs.size === 0) return state
      let visits = state.visits
      const tabs = new Map<number, PageReveals>()
      for (const [tabId, current] of state.tabs) tabs.set(tabId, { ...current, visit: ++visits, revealed: NONE })
      return { visits, tabs }
    }
  }
}
