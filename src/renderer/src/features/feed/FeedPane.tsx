import { Fragment, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ForumId, ThreadSummary } from '../../../../shared/forum'
import { Content, contentText } from '../../components/Content'
import { Icon } from '../../components/Icon'
import { FailureNotice, Loading, PartialNotice, SourceNotice } from '../../components/Notices'
import { useNearEnd } from '../../lib/useNearEnd'
import { useRovingFocus } from '../../lib/useRovingFocus'
import type { FeedInfo } from '../directory/feeds'
import { ContentRegistryContext, useRegisterContent } from '../tabs/contentRegistry'
import type { FeedPageRecord } from './feedState'
import { ThreadRow } from './ThreadRow'
import { useFeed } from './useFeed'
import './feed.css'

export function FeedPane({
  entryKey,
  info,
  forumNames,
  selectedThreadId,
  onOpenThread
}: {
  /** History entry showing this list; the shell refreshes it through the content registry. */
  entryKey: number
  info: FeedInfo
  forumNames: ReadonlyMap<ForumId, string>
  selectedThreadId: string | null
  onOpenThread: (thread: ThreadSummary) => void
}) {
  const registry = useContext(ContentRegistryContext)
  // The same entry's list as it was when last unmounted (split toggled, single pane, back/forward).
  const [remembered] = useState(() => {
    const memory = registry?.listMemory.get(entryKey)
    return memory?.kind === 'feed' ? memory : null
  })
  const { state, hasMore, canAppend, loadMore, refresh, retry } = useFeed(info.ref, info.maxPage, remembered?.state ?? null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  useNearEnd(scrollRef, sentinelRef, canAppend, state.pages.length, loadMore)
  useRegisterContent('lists', entryKey, { refresh })

  /** Last scroll position while the list was displayed (a hidden scroller reports 0). */
  const scrollTop = useRef(remembered !== null && remembered.state.pages.length > 0 ? remembered.scrollTop : 0)
  const stateRef = useRef(state)

  // The memory is kept current, not written on unmount: when the split toggles, the list that
  // replaces this one renders (and reads the memory) before this one's cleanup would run.
  useLayoutEffect(() => {
    stateRef.current = state
    registry?.listMemory.set(entryKey, { kind: 'feed', state, scrollTop: scrollTop.current })
  })

  // Put the remembered position back whenever the list becomes displayed: on mount, and after the
  // pane was hidden (single pane, inactive tab), where the browser may drop scrollTop.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scroller === null) return
    let hidden = true
    const observer = new ResizeObserver(() => {
      const shown = scroller.clientHeight > 0
      if (shown && hidden && scroller.scrollTop !== scrollTop.current) scroller.scrollTop = scrollTop.current
      hidden = !shown
    })
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [])

  const onScroll = () => {
    const scroller = scrollRef.current
    if (scroller === null || scroller.clientHeight === 0) return
    scrollTop.current = scroller.scrollTop
    registry?.listMemory.set(entryKey, { kind: 'feed', state: stateRef.current, scrollTop: scrollTop.current })
  }

  const ids = useMemo(() => state.threads.map((thread) => thread.head.id), [state.threads])
  const roving = useRovingFocus(ids, selectedThreadId)

  const isTimeline = info.ref.kind === 'timeline'
  const kindLabel = isTimeline ? '时间线' : '版面'
  const descriptionLabel = isTimeline ? '说明' : '版规'
  const lastPage = state.pages.at(-1)?.page ?? 0
  const firstLoad = state.pages.length === 0
  const error = state.error

  const noticesByIndex = useMemo(() => {
    const map = new Map<number, FeedPageRecord[]>()
    for (const record of state.pages) {
      const list = map.get(record.startIndex) ?? []
      list.push(record)
      map.set(record.startIndex, list)
    }
    return map
  }, [state.pages])

  const renderPageNotices = (index: number) =>
    noticesByIndex.get(index)?.map((record) => (
      <li key={`notice-${record.page}`} className="list-notice">
        <SourceNotice source={record.source} subject={`第 ${record.page} 页`} />
        <PartialNotice skipped={record.skippedItems} subject={`第 ${record.page} 页`} />
      </li>
    ))

  return (
    <section className="list-pane" aria-label={`${kindLabel}：${info.name}`}>
      <div className="list-scroll" ref={scrollRef} onScroll={onScroll} tabIndex={-1} data-pane-focus="">
        <header className="list-header">
          <div className="list-title-row">
            <h2 className="list-title">
              <span className="list-kind">{kindLabel}</span>
              <span className="list-name">{info.name}</span>
            </h2>
            <button type="button" className="icon-btn" onClick={refresh} aria-label="刷新列表（重新读取第 1 页）" title="刷新列表">
              <Icon name="refresh" />
            </button>
          </div>
        </header>

        {info.description.length > 0 && (
          <details className="feed-description">
            <summary>
              <Icon name="chevron" size={14} className="disclosure-icon" />
              <span className="feed-description-label">{descriptionLabel}</span>
              <span className="feed-description-preview">{contentText(info.description).trim()}</span>
            </summary>
            <Content nodes={info.description} className="feed-description-body" />
          </details>
        )}

        <div className="list-status">
          {state.activity === 'refresh' && <Loading>正在刷新第 1 页…</Loading>}
          {error !== null && error.action === 'refresh' && (
            <FailureNotice title="刷新失败，仍显示之前的列表" failure={error.failure} onRetry={retry} compact />
          )}
        </div>

        {firstLoad && state.activity === 'initial' && (
          <div className="list-placeholder">
            <Loading>正在读取第 1 页…</Loading>
            <div aria-hidden="true">
              {Array.from({ length: 6 }, (_, index) => (
                <div key={index} className="row-skeleton">
                  <span className="skeleton-line is-short" />
                  <span className="skeleton-line" />
                  <span className="skeleton-line is-mid" />
                </div>
              ))}
            </div>
          </div>
        )}

        {firstLoad && error !== null && error.action === 'initial' && (
          <div className="list-placeholder">
            <FailureNotice title="读取串列表失败" failure={error.failure} onRetry={retry} />
          </div>
        )}

        {!firstLoad && state.threads.length === 0 && state.reachedEmptyPage === 1 && (
          <div className="list-empty" role="status">
            <p className="list-empty-title">这里还没有串</p>
            <p className="list-empty-text">{kindLabel}第 1 页是空的。</p>
          </div>
        )}

        {!firstLoad && (
          <ul className="thread-list" aria-label="串列表" onKeyDown={roving.onKeyDown}>
            {state.threads.map((thread, index) => (
              <Fragment key={thread.head.id}>
                {renderPageNotices(index)}
                <li>
                  <ThreadRow
                    thread={thread}
                    forumName={isTimeline && thread.head.forumId !== null ? (forumNames.get(thread.head.forumId) ?? null) : null}
                    selected={thread.head.id === selectedThreadId}
                    onOpen={() => onOpenThread(thread)}
                    itemProps={roving.itemProps(thread.head.id)}
                  />
                </li>
              </Fragment>
            ))}
            {renderPageNotices(state.threads.length)}
          </ul>
        )}

        <div className="list-footer">
          <div ref={sentinelRef} className="scroll-sentinel" aria-hidden="true" />
          {state.activity === 'append' && <Loading>正在读取第 {lastPage + 1} 页…</Loading>}
          {error !== null && error.action === 'append' && (
            <FailureNotice title={`读取第 ${error.page} 页失败`} failure={error.failure} onRetry={retry} compact />
          )}
          {!firstLoad && state.reachedEmptyPage !== null && state.reachedEmptyPage > 1 && (
            <p className="list-end">第 {state.reachedEmptyPage} 页没有串，列表到此为止</p>
          )}
          {!firstLoad && state.reachedEmptyPage === null && !hasMore && info.maxPage !== null && (
            <p className="list-end">已到{kindLabel}最后一页（第 {info.maxPage} 页）</p>
          )}
          {canAppend && (
            <button type="button" className="btn btn-quiet" onClick={loadMore}>
              读取第 {lastPage + 1} 页
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
