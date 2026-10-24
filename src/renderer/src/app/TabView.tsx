import { useLayoutEffect, useRef } from 'react'
import type { FeedRef, ForumId, ThreadSummary } from '../../../shared/forum'
import { feedKey, type FeedInfo } from '../features/directory/feeds'
import { SubscriptionPane } from '../features/subscriptions/SubscriptionPane'
import { FeedPane } from '../features/feed/FeedPane'
import type { LayoutResult } from '../features/layout/layout'
import { currentEntry, type Tab } from '../features/tabs/tabsState'
import { ThreadPane } from '../features/thread/ThreadPane'
import { Loading } from '../components/Notices'
import { Icon } from '../components/Icon'

type Region = 'list' | 'reader'

/**
 * Content of one tab: its current history entry. Inactive tabs stay mounted but hidden, keeping
 * their lists, readers and reading positions. In the single-pane fallback both panes stay
 * mounted and the entry's `pane` decides which one is displayed.
 */
export function TabView({
  tab,
  active,
  layout,
  feedInfo,
  forumNames,
  forumName,
  onSelectThread,
  onShowPane,
  onOpenNav
}: {
  tab: Tab
  active: boolean
  layout: LayoutResult
  feedInfo: (ref: FeedRef) => FeedInfo | null
  forumNames: ReadonlyMap<ForumId, string>
  forumName: (forumId: string | null) => string | null
  onSelectThread: (tabId: number, thread: ThreadSummary) => void
  onShowPane: (tabId: number, pane: Region) => void
  /** Opens the navigation overlay; null while the navigation is a column. */
  onOpenNav: (() => void) | null
}) {
  const entry = currentEntry(tab)
  const listRef = useRef<HTMLDivElement>(null)
  const readerRef = useRef<HTMLElement>(null)
  const lastRegion = useRef<Region | null>(null)

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
      (pane === 'list' ? shown.querySelector<HTMLElement>('.thread-row.is-selected') : null) ??
      shown.querySelector<HTMLElement>('[data-pane-focus]') ??
      shown
    target.focus({ preventScroll: pane === 'reader' })
  }, [active, single, pane])

  let body
  if (entry.kind === 'thread') {
    body = (
      <main className="reader-wrap is-page" ref={readerRef} tabIndex={-1}>
        <ThreadPane
          key={`${entry.key}:${entry.thread.threadId}`}
          entryKey={entry.key}
          open={entry.thread}
          displayed={active}
          forumName={forumName}
          onBackToList={null}
        />
      </main>
    )
  } else if (entry.feed === null) {
    body = (
      <div className="pane-empty">
        <p className="pane-empty-title">选择订阅、时间线或版面</p>
        <p className="pane-empty-text">从导航中选择后，串列表会显示在这个标签里。</p>
        {onOpenNav !== null && (
          <button type="button" className="btn pane-empty-action" onClick={onOpenNav}>
            <Icon name="sidebar" />
            打开导航
          </button>
        )}
      </div>
    )
  } else {
    const feed = entry.feed
    const selectedThreadId = tab.split ? (entry.thread?.threadId ?? null) : null
    const info = feed.kind === 'subscriptions' ? null : feedInfo(feed)
    const list =
      feed.kind === 'subscriptions' ? (
        <SubscriptionPane
          key={`${entry.key}:subscriptions`}
          entryKey={entry.key}
          forumNames={forumNames}
          selectedThreadId={selectedThreadId}
          onOpenThread={(summary) => onSelectThread(tab.id, summary)}
        />
      ) : info === null ? (
        <div className="pane-empty">
          <Loading>正在读取版面目录…</Loading>
        </div>
      ) : (
        <FeedPane
          key={`${entry.key}:${feedKey(feed)}`}
          entryKey={entry.key}
          info={info}
          forumNames={forumNames}
          selectedThreadId={selectedThreadId}
          onOpenThread={(summary) => onSelectThread(tab.id, summary)}
        />
      )
    body = splitShown ? (
      <div className={single ? 'split is-single' : 'split'}>
        <div className="list-column" ref={listRef} hidden={!listVisible} onFocus={() => (lastRegion.current = 'list')}>
          {list}
        </div>
        <main
          className="reader-wrap"
          ref={readerRef}
          hidden={!readerVisible}
          tabIndex={-1}
          onFocus={() => (lastRegion.current = 'reader')}
        >
          {entry.thread === null ? (
            <div className="pane-empty">
              <p className="pane-empty-title">选择一个串开始阅读</p>
              <p className="pane-empty-text">主帖与回复会显示在这里，接近底部时自动读取下一页。</p>
            </div>
          ) : (
            <ThreadPane
              key={`${entry.key}:${entry.thread.threadId}`}
              entryKey={entry.key}
              open={entry.thread}
              displayed={active && readerVisible}
              forumName={forumName}
              onBackToList={single ? () => onShowPane(tab.id, 'list') : null}
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
      {body}
    </div>
  )
}
