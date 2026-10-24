import { Fragment, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ForumId, ThreadSummary } from '../../../../shared/forum'
import { Content, contentText } from '../../components/Content'
import { Icon } from '../../components/Icon'
import { FailureNotice, Loading, PartialNotice, SourceNotice } from '../../components/Notices'
import { useNearEnd } from '../../lib/useNearEnd'
import { useRovingFocus } from '../../lib/useRovingFocus'
import type { FeedInfo } from '../directory/feeds'
import { ContentRegistryContext, useRegisterContent, type ListMemory } from '../tabs/contentRegistry'
import type { WorkspaceList } from '../tabs/workspaceSnapshot'
import type { FeedPageRecord } from './feedState'
import { ThreadRow } from './ThreadRow'
import { useFeed } from './useFeed'
import './feed.css'

/** The first thread row reaching below the scroller top, and its row top's offset from that top. */
function firstVisible(scroller: HTMLElement): ListMemory['anchor'] {
  const rows = scroller.querySelectorAll<HTMLElement>('li[data-thread-id]')
  const top = scroller.getBoundingClientRect().top
  let low = 0
  let high = rows.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (rows.item(middle).getBoundingClientRect().bottom > top) high = middle
    else low = middle + 1
  }
  const threadId = rows[low]?.dataset.threadId
  return threadId === undefined ? null : { threadId, offset: rows.item(low).getBoundingClientRect().top - top }
}

/** Puts the saved first visible thread back at its offset, else the saved scrollTop (clamped). */
function placeSaved(scroller: HTMLElement, saved: WorkspaceList): void {
  const { anchor } = saved
  const row = anchor === null ? null : scroller.querySelector<HTMLElement>(`li[data-thread-id="${anchor.threadId}"]`)
  if (anchor !== null && row !== null) {
    scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset
  } else {
    scroller.scrollTop = Math.min(saved.scrollTop, Math.max(0, scroller.scrollHeight - scroller.clientHeight))
  }
}

export function FeedPane({
  entryKey,
  info,
  forumNames,
  selectedThreadId,
  onOpenThread,
  footer
}: {
  /** History entry showing this list; the shell refreshes it through the content registry. */
  entryKey: number
  info: FeedInfo
  forumNames: ReadonlyMap<ForumId, string>
  selectedThreadId: string | null
  onOpenThread: (thread: ThreadSummary) => void
  /** Shown below the scroller (the new-thread editor of a forum). */
  footer: ReactNode
}) {
  const registry = useContext(ContentRegistryContext)
  // The same entry's list as it was when last unmounted (split toggled, single pane, back/forward).
  const [remembered] = useState(() => {
    const memory = registry?.listMemory.get(entryKey) ?? null
    return memory !== null && memory.state.pages.length > 0 ? memory : null
  })
  // Otherwise the list as it was at the last quit: its pages are read again and its position placed.
  const [saved] = useState(() => (remembered === null ? (registry?.savedLists.get(entryKey) ?? null) : null))
  const restorePages = saved === null ? null : Math.min(saved.pages, info.maxPage ?? saved.pages)
  const { state, hasMore, canAppend, loadMore, refresh, retry } = useFeed(info.ref, info.maxPage, remembered?.state ?? null, restorePages)
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  useNearEnd(scrollRef, sentinelRef, canAppend, state.pages.length, loadMore)

  /** Last scroll position while the list was displayed (a hidden scroller reports 0). */
  const scrollTop = useRef(remembered?.scrollTop ?? 0)
  /** First visible thread at that position. */
  const anchor = useRef(remembered?.anchor ?? null)
  const stateRef = useRef(state)
  /** Saved position still to place; until then this list keeps no memory and the saved one is kept. */
  const pendingRestore = useRef(saved)

  const remember = useCallback(() => {
    registry?.listMemory.set(entryKey, { state: stateRef.current, scrollTop: scrollTop.current, anchor: anchor.current })
  }, [registry, entryKey])

  /** Places the saved position once the restored pages are shown and the scroller can be measured. */
  const settleRestore = useCallback(
    (scroller: HTMLElement) => {
      const target = pendingRestore.current
      const current = stateRef.current
      if (target === null || current.pages.length === 0 || current.activity !== 'idle' || scroller.clientHeight === 0) return false
      placeSaved(scroller, target)
      pendingRestore.current = null
      registry?.savedLists.delete(entryKey)
      scrollTop.current = scroller.scrollTop
      anchor.current = firstVisible(scroller)
      remember()
      return true
    },
    [registry, entryKey, remember]
  )

  /** A refresh replaces the list as today: the saved position no longer applies. */
  const refreshList = useCallback(() => {
    pendingRestore.current = null
    registry?.savedLists.delete(entryKey)
    refresh()
  }, [registry, entryKey, refresh])
  useRegisterContent('lists', entryKey, { refresh: refreshList })

  // The memory is kept current, not written on unmount: when the split toggles, the list that
  // replaces this one renders (and reads the memory) before this one's cleanup would run. A restored
  // list is placed in the commit that shows its pages, before it paints.
  useLayoutEffect(() => {
    stateRef.current = state
    const scroller = scrollRef.current
    if (scroller !== null && settleRestore(scroller)) return
    if (pendingRestore.current === null) remember()
  })

  // Put the remembered position back whenever the list becomes displayed: on mount, and after the
  // pane was hidden (single pane, inactive tab), where the browser may drop scrollTop. A restored
  // list that was hidden when its pages arrived is placed when it is first displayed.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scroller === null) return
    let hidden = true
    const observer = new ResizeObserver(() => {
      const shown = scroller.clientHeight > 0
      if (shown && hidden && !settleRestore(scroller) && scroller.scrollTop !== scrollTop.current) scroller.scrollTop = scrollTop.current
      hidden = !shown
    })
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [settleRestore])

  const onScroll = () => {
    const scroller = scrollRef.current
    if (scroller === null || scroller.clientHeight === 0 || pendingRestore.current !== null) return
    scrollTop.current = scroller.scrollTop
    anchor.current = firstVisible(scroller)
    remember()
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
            <button type="button" className="icon-btn" onClick={refreshList} aria-label="刷新列表（重新读取第 1 页）" title="刷新列表">
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
            <Loading>{restorePages !== null && restorePages > 1 ? `正在读取第 1–${restorePages} 页…` : '正在读取第 1 页…'}</Loading>
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
                <li data-thread-id={thread.head.id}>
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
      {footer}
    </section>
  )
}
