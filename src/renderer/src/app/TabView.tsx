import { useContext, useLayoutEffect, useRef } from 'react'
import type { FeedRef, ForumId, Post, ThreadId } from '../../../shared/forum'
import type { PostTarget } from '../../../shared/drafts'
import { FailureNotice } from '../components/Notices'
import { RetainedPane } from '../features/content/RetainedPane'
import { ListHostContext } from '../features/directory/navStore'
import { feedKey, type FeedInfo } from '../features/directory/feeds'
import type { DirectoryState } from '../features/directory/useDirectory'
import { ComposeButton, ComposeFrame, ComposeSentNote, type ComposeTarget } from '../features/editor/ComposePanel'
import { FeedPane } from '../features/feed/FeedPane'
import type { LayoutResult } from '../features/layout/layout'
import { ReminderPane } from '../features/reminders/ReminderPane'
import { SearchPage } from '../features/search/SearchPage'
import { SubscriptionPane } from '../features/subscriptions/SubscriptionPane'
import { currentEntry, isLocalList, type EntryInit, type Tab, type ThreadOpen } from '../features/tabs/tabsState'
import { ThreadPane } from '../features/thread/ThreadPane'
import { ListDivider } from './ListDivider'

type Region = 'list' | 'reader'

/** A target's entry (回复 / 发新串) and its confirmed-send note, placed by the pane. */
function composeEntry(tabId: number, target: PostTarget, className?: string) {
  return {
    tabId,
    entry: <ComposeButton tabId={tabId} target={target} className={className} />,
    note: <ComposeSentNote tabId={tabId} target={target} />
  }
}

/** 回复 in the thread toolbar is its one emphasised action (thread.css `.tb-btn.is-primary`). */
const READER_ENTRY = 'btn tb-btn is-primary'

/**
 * Content of one tab: its current history entry. Inactive tabs stay mounted but hidden, keeping
 * their lists, readers and reading positions. In the single-pane fallback both panes stay
 * mounted and the entry's `pane` decides which one is displayed. The editors of the targets it
 * shows float over it (centred compose panel).
 */
export function TabView({
  tab,
  active,
  layout,
  directory,
  onRetryDirectory,
  feedInfo,
  forumNames,
  forumName,
  onSelectThread,
  onShowPane,
  onOpenTarget,
  onOpenFromOnlineSearch,
  composeHidden,
  onResizeList
}: {
  tab: Tab
  active: boolean
  layout: LayoutResult
  /** Directory status; decides whether a feed without details is still loading or gone. */
  directory: DirectoryState
  onRetryDirectory: () => void
  feedInfo: (ref: FeedRef) => FeedInfo | null
  forumNames: ReadonlyMap<ForumId, string>
  forumName: (forumId: string | null) => string | null
  /** Opens a list item: beside the list when split, else as a new step; `head` when the list has it. */
  onSelectThread: (tabId: number, threadId: ThreadId, head: Post | null) => void
  onShowPane: (tabId: number, pane: Region) => void
  /**
   * A list item resolved to an explicit target (a located reminder event): shows it from the list
   * entry `entryKey`. False when that entry is no longer the tab's current one.
   */
  onOpenTarget: (tabId: number, entryKey: number, thread: ThreadOpen) => boolean
  /**
   * An online search result opened from entry `entryKey` as a new `online-search` step; false when
   * that entry is no longer current.
   */
  onOpenFromOnlineSearch: (entryKey: number, init: EntryInit) => boolean
  /** Something covers the tab content (the settings page): its compose panels stay closed. */
  composeHidden: boolean
  /** The list width divider of the split view changed the width (`done` at the end of a change). */
  onResizeList: (width: number, done: boolean) => void
}) {
  const entry = currentEntry(tab)
  const listRef = useRef<HTMLDivElement>(null)
  const readerRef = useRef<HTMLElement>(null)
  const lastRegion = useRef<Region | null>(null)
  const listHost = useContext(ListHostContext)

  const splitShown = entry.kind === 'list' && entry.feed !== null && tab.split
  const single = splitShown && layout.singlePane
  const pane: Region = entry.kind === 'list' && entry.thread !== null ? entry.pane : 'list'
  const listVisible = !single || pane === 'list'
  const readerVisible = !single || pane === 'reader'

  // Switching the single pane (or entering it) must not strand keyboard focus in the hidden pane.
  useLayoutEffect(() => {
    if (!active || !single) return
    const hidden = pane === 'list' ? readerRef.current : listRef.current
    const shown = pane === 'list' ? listRef.current : readerRef.current
    if (hidden === null || shown === null) return
    const focused = document.activeElement
    const hiddenRegion: Region = pane === 'list' ? 'reader' : 'list'
    const stranded =
      (focused !== null && hidden.contains(focused)) ||
      ((focused === null || focused === document.body) && lastRegion.current === hiddenRegion)
    if (!stranded) return
    const target =
      // A list pane may hide its list behind another view (订阅 › 同步与合并); 历史 / 离线 rows.
      (pane === 'list'
        ? shown.querySelector<HTMLElement>(
            '.list-scroll:not([hidden]) .thread-row.is-selected, .list-scroll:not([hidden]) .retained-row.is-selected > .retained-open'
          )
        : null) ??
      shown.querySelector<HTMLElement>('[data-pane-focus]') ??
      shown
    target.focus({ preventScroll: pane === 'reader' })
  }, [active, single, pane])

  /** Targets whose floating panel this tab can show. */
  const composeTargets: ComposeTarget[] = []

  let body
  if (entry.kind === 'thread') {
    const target: PostTarget = { kind: 'reply', threadId: entry.thread.threadId }
    composeTargets.push({ target, displayed: active && !composeHidden })
    body = (
      <main className="reader-wrap is-page" ref={readerRef} tabIndex={-1}>
        <ThreadPane
          key={`${entry.key}:${entry.thread.threadId}`}
          entryKey={entry.key}
          open={entry.thread}
          displayed={active}
          forumName={forumName}
          onBackToList={null}
          compose={composeEntry(tab.id, target, READER_ENTRY)}
        />
      </main>
    )
  } else if (entry.kind === 'online-search') {
    // The 搜索 page; the board directory recognizes board results of its 联网 side.
    body = (
      <SearchPage
        key={entry.key}
        tabId={tab.id}
        entryKey={entry.key}
        displayed={active}
        directory={directory.directory}
        onOpen={onOpenFromOnlineSearch}
      />
    )
  } else if (entry.feed === null) {
    body = listHost?.emptyPage() ?? null
  } else {
    const feed = entry.feed
    const selectedThreadId = tab.split ? (entry.thread?.threadId ?? null) : null
    const info = isLocalList(feed) ? null : feedInfo(feed)
    // New threads go to forums only; timelines and subscriptions have no post target. The panel
    // floats over the tab, so it stays shown whichever pane the single-pane fallback shows.
    const forumTarget: PostTarget | null = feed.kind === 'forum' ? { kind: 'thread', forumId: feed.id } : null
    if (forumTarget !== null) composeTargets.push({ target: forumTarget, displayed: active && !composeHidden })
    let list
    if (feed.kind === 'history' || feed.kind === 'offline') {
      list = (
        <RetainedPane
          key={`${entry.key}:${feed.kind}`}
          tabId={tab.id}
          entryKey={entry.key}
          kind={feed.kind}
          forumNames={forumNames}
          selectedThreadId={selectedThreadId}
          onOpenThread={(threadId) => onSelectThread(tab.id, threadId, null)}
        />
      )
    } else if (feed.kind === 'reminders') {
      list = (
        <ReminderPane
          key={`${entry.key}:reminders`}
          entryKey={entry.key}
          selectedThreadId={selectedThreadId}
          onOpenTarget={(thread) => onOpenTarget(tab.id, entry.key, thread)}
        />
      )
    } else if (feed.kind === 'subscriptions') {
      list = (
        <SubscriptionPane
          key={`${entry.key}:subscriptions`}
          entryKey={entry.key}
          forumNames={forumNames}
          selectedThreadId={selectedThreadId}
          onOpenThread={(summary) => onSelectThread(tab.id, summary.head.id, summary.head)}
        />
      )
    } else if (info !== null) {
      list = (
        <FeedPane
          key={`${entry.key}:${feedKey(feed)}`}
          entryKey={entry.key}
          info={info}
          forumNames={forumNames}
          selectedThreadId={selectedThreadId}
          onOpenThread={(summary) => onSelectThread(tab.id, summary.head.id, summary.head)}
          compose={forumTarget !== null ? composeEntry(tab.id, forumTarget, 'btn btn-small') : null}
        />
      )
    } else {
      // A feed without details is pending only until the directory settles; then the tab stays
      // on it as missing (or unreadable) instead of moving elsewhere. The forum's editor remains.
      let state
      if (directory.directory === null && directory.failure !== null) {
        state = <FailureNotice title="版面目录读取失败" failure={directory.failure} onRetry={onRetryDirectory} compact />
      } else if (directory.directory === null) {
        state = <div className="list-placeholder" aria-busy="true" />
      } else {
        state = listHost?.emptyPage(feed.kind === 'forum' ? '这个版面已不在目录中' : '这条时间线已不在目录中') ?? null
      }
      list = (
        <div className="list-pane">
          <div className="pane-empty list-pending">{state}</div>
        </div>
      )
    }
    if (splitShown && entry.thread !== null) {
      composeTargets.push({ target: { kind: 'reply', threadId: entry.thread.threadId }, displayed: active && !composeHidden })
    }
    body = splitShown ? (
      <div className={single ? 'split is-single' : 'split'}>
        <div className="list-column" ref={listRef} hidden={!listVisible} onFocus={() => (lastRegion.current = 'list')}>
          {list}
        </div>
        {active && !single && layout.listWidth > 0 && <ListDivider width={layout.listWidth} max={layout.listWidthMax} onResize={onResizeList} />}
        <main
          className="reader-wrap"
          ref={readerRef}
          hidden={!readerVisible}
          tabIndex={-1}
          onFocus={() => (lastRegion.current = 'reader')}
        >
          {entry.thread === null ? (
            <div className="pane-empty">
              <p className="pane-empty-title">选择一个串</p>
            </div>
          ) : (
            <ThreadPane
              key={`${entry.key}:${entry.thread.threadId}`}
              entryKey={entry.key}
              open={entry.thread}
              displayed={active && readerVisible}
              forumName={forumName}
              onBackToList={single ? () => onShowPane(tab.id, 'list') : null}
              compose={composeEntry(tab.id, { kind: 'reply', threadId: entry.thread.threadId }, READER_ENTRY)}
            />
          )}
        </main>
      </div>
    ) : (
      <div className="list-only">{list}</div>
    )
  }

  return (
    <div className="tab-panel" role="tabpanel" id={`tabpanel-${tab.id}`} aria-labelledby={`tab-${tab.id}`} hidden={!active}>
      <ComposeFrame tabId={tab.id} targets={composeTargets}>
        {body}
      </ComposeFrame>
    </div>
  )
}
