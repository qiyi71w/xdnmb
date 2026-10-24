import { useLayoutEffect, useRef } from 'react'
import { EditorDock } from '../features/editor/EditorDock'
import type { FeedRef, ForumId, ThreadSummary } from '../../../shared/forum'
import { feedKey, type FeedInfo } from '../features/directory/feeds'
import { useSearchOpener } from '../features/search/SearchContext'
import { SubscriptionPane } from '../features/subscriptions/SubscriptionPane'
import { ReminderPane } from '../features/reminders/ReminderPane'
import type { DirectoryState } from '../features/directory/useDirectory'
import { forumLabel } from '../features/editor/editorText'
import { FeedPane } from '../features/feed/FeedPane'
import type { LayoutResult } from '../features/layout/layout'
import { currentEntry, type Tab, type ThreadOpen } from '../features/tabs/tabsState'
import { ThreadPane } from '../features/thread/ThreadPane'
import { FailureNotice, Loading } from '../components/Notices'
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
  directory,
  onRetryDirectory,
  feedInfo,
  forumNames,
  forumName,
  onSelectThread,
  onShowPane,
  onOpenTarget,
  onOpenNav
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
  onSelectThread: (tabId: number, thread: ThreadSummary) => void
  onShowPane: (tabId: number, pane: Region) => void
  /**
   * A list item resolved to an explicit target (a located reminder event): shows it from the list
   * entry `entryKey`. False when that entry is no longer the tab's current one.
   */
  onOpenTarget: (tabId: number, entryKey: number, thread: ThreadOpen) => boolean
  /** Opens the navigation overlay; null while the navigation is a column. */
  onOpenNav: (() => void) | null
}) {
  const entry = currentEntry(tab)
  const listRef = useRef<HTMLDivElement>(null)
  const readerRef = useRef<HTMLElement>(null)
  const lastRegion = useRef<Region | null>(null)
  const openSearch = useSearchOpener()

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
      // A list pane may hide its list behind another view (订阅 › 同步与合并).
      (pane === 'list' ? shown.querySelector<HTMLElement>('.list-scroll:not([hidden]) .thread-row.is-selected') : null) ??
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
          footer={<EditorDock tabId={tab.id} target={{ kind: 'reply', threadId: entry.thread.threadId }} displayed={active} />}
        />
      </main>
    )
  } else if (entry.feed === null) {
    body = (
      <div className="pane-empty">
        <p className="pane-empty-title">选择订阅、时间线或版面</p>
        <p className="pane-empty-text">从导航中选择后，串列表会显示在这个标签里；也可以搜索本机保有的内容。</p>
        {onOpenNav !== null && (
          <button type="button" className="btn pane-empty-action" onClick={onOpenNav}>
            <Icon name="sidebar" />
            打开导航
          </button>
        )}
        {openSearch !== null && (
          <button type="button" className="btn pane-empty-action" aria-haspopup="dialog" onClick={() => openSearch({ view: 'local' })}>
            <Icon name="search" />
            搜索本机内容
          </button>
        )}
      </div>
    )
  } else {
    const feed = entry.feed
    const selectedThreadId = tab.split ? (entry.thread?.threadId ?? null) : null
    const info = feed.kind === 'subscriptions' || feed.kind === 'reminders' ? null : feedInfo(feed)
    // New threads go to forums only; timelines and subscriptions have no post target.
    const listDock =
      feed.kind === 'forum' ? (
        <EditorDock tabId={tab.id} target={{ kind: 'thread', forumId: feed.id }} displayed={active && listVisible} />
      ) : null
    let list
    if (feed.kind === 'reminders') {
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
          onOpenThread={(summary) => onSelectThread(tab.id, summary)}
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
          onOpenThread={(summary) => onSelectThread(tab.id, summary)}
          footer={listDock}
        />
      )
    } else {
      // A feed without details is pending only until the directory settles; then the tab stays
      // on it as missing (or unreadable) instead of moving elsewhere. The forum's editor remains.
      const target = feed.kind === 'forum' ? `「${forumLabel(feed.id, forumName)}」` : `「时间线 ${feed.id}」`
      let state
      if (directory.directory === null && directory.failure !== null) {
        state = (
          <>
            <FailureNotice title="版面目录读取失败" failure={directory.failure} onRetry={onRetryDirectory} compact />
            <p className="pane-empty-text">读取目录后才能显示{target}，标签会停留在这里。</p>
          </>
        )
      } else if (directory.directory === null) {
        state = <Loading>正在读取版面目录…</Loading>
      } else {
        state = (
          <>
            <p className="pane-empty-title">{feed.kind === 'forum' ? '这个版面已不在目录中' : '这条时间线已不在目录中'}</p>
            <p className="pane-empty-text">
              {target}没有出现在当前版面目录里。标签会停留在这里，可以从导航中选择其他版面或时间线。
            </p>
            {onOpenNav !== null && (
              <button type="button" className="btn pane-empty-action" onClick={onOpenNav}>
                <Icon name="sidebar" />
                打开导航
              </button>
            )}
          </>
        )
      }
      list = (
        <div className="list-pane">
          <div className="pane-empty list-pending">{state}</div>
          {listDock}
        </div>
      )
    }
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
              footer={
                <EditorDock
                  tabId={tab.id}
                  target={{ kind: 'reply', threadId: entry.thread.threadId }}
                  displayed={active && readerVisible}
                />
              }
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
