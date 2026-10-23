import { useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import type { Post, ThreadId } from '../../../../shared/forum'
import { Icon } from '../../components/Icon'
import { FailureNotice, Loading, PartialNotice, SourceNotice } from '../../components/Notices'
import { describeReadError, formatPageList, meaningfulTitle } from '../../lib/format'
import { useNearEnd } from '../../lib/useNearEnd'
import { CoverageLine } from './CoverageLine'
import { PostView } from './PostView'
import type { ThreadTask } from './threadState'
import { useThread } from './useThread'
import './thread.css'

function taskText(task: ThreadTask): string {
  switch (task.type) {
    case 'initial':
      return '正在读取第 1 页…'
    case 'append':
      return `正在读取第 ${task.page} 页…`
    case 'prepend':
      return `正在读取上一页（第 ${task.page} 页）…`
    case 'refresh':
      return `正在重新读取第 ${task.page} 页…`
    case 'jump':
      return `正在跳转到第 ${task.page} 页…`
    case 'locate':
      return '正在定位末尾…'
  }
}

function failureTitle(task: ThreadTask): string {
  switch (task.type) {
    case 'initial':
      return '读取第 1 页失败'
    case 'append':
      return `读取第 ${task.page} 页失败`
    case 'prepend':
      return `读取第 ${task.page} 页失败`
    case 'refresh':
      return `重新读取第 ${task.page} 页失败，仍显示之前的内容`
    case 'jump':
      return `跳转到第 ${task.page} 页失败，仍显示之前的内容`
    case 'locate':
      return '定位末尾失败，仍显示之前的内容'
  }
}

export function ThreadPane({
  threadId,
  initialHead,
  forumName
}: {
  threadId: ThreadId
  initialHead: Post | null
  forumName: (forumId: string | null) => string | null
}) {
  const thread = useThread(threadId, initialHead)
  const { state, firstPage, lastPage } = thread
  const scrollRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const prependAnchor = useRef<{ page: number; top: number } | null>(null)
  const [pageInput, setPageInput] = useState('')

  useNearEnd(scrollRef, sentinelRef, thread.canAppend, `${state.pages.length}:${lastPage?.page ?? 0}`, thread.appendNext)

  // A replaced range (jump, 开头, 末尾) starts reading from its top; a pending prepend anchor is void.
  useLayoutEffect(() => {
    if (state.rangeVersion === 0) return
    prependAnchor.current = null
    if (scrollRef.current !== null) scrollRef.current.scrollTop = 0
  }, [state.rangeVersion])

  // Prepending must not move what the reader is looking at. Scroll anchoring does not apply when the
  // scroller sits at offset 0, so restore the old first page's on-screen position explicitly; when
  // the browser has already anchored, the measured delta is zero. The recorded position follows
  // the user's own scrolling while the page loads (see onScroll).
  useLayoutEffect(() => {
    const anchor = prependAnchor.current
    const scroller = scrollRef.current
    if (anchor === null || scroller === null || state.task?.type === 'prepend') return
    prependAnchor.current = null
    const element = scroller.querySelector<HTMLElement>(`[data-page="${anchor.page}"]`)
    if (element === null) return
    const delta = element.getBoundingClientRect().top - anchor.top
    if (delta !== 0) scroller.scrollTop += delta
  }, [state.pages, state.task])

  const firstPageElement = (page: number) => scrollRef.current?.querySelector<HTMLElement>(`[data-page="${page}"]`) ?? null

  const loadPrevious = () => {
    const element = firstPage === undefined ? null : firstPageElement(firstPage.page)
    prependAnchor.current =
      firstPage === undefined || element === null ? null : { page: firstPage.page, top: element.getBoundingClientRect().top }
    thread.prependPrevious()
  }

  const onScroll = () => {
    const anchor = prependAnchor.current
    if (anchor === null || state.task?.type !== 'prepend') return
    const element = firstPageElement(anchor.page)
    if (element !== null) anchor.top = element.getBoundingClientRect().top
  }

  const toStart = () => {
    if (firstPage?.page === 1 && scrollRef.current !== null) scrollRef.current.scrollTop = 0
    else thread.jump(1)
  }

  const parsedPage = /^\d+$/.test(pageInput.trim()) ? Number(pageInput.trim()) : NaN
  const pageValid = Number.isSafeInteger(parsedPage) && parsedPage >= 1
  const onJump = (event: FormEvent) => {
    event.preventDefault()
    if (pageValid) thread.jump(parsedPage)
  }

  const head = state.head
  const title = head === null ? null : meaningfulTitle(head.title)
  const task = state.task
  const error = state.error
  const shownIds = new Set<string>(head === null ? [] : [head.id])
  const loadedRange =
    firstPage === undefined || lastPage === undefined
      ? null
      : firstPage.page === lastPage.page
        ? `第 ${firstPage.page} 页`
        : `第 ${firstPage.page}–${lastPage.page} 页`
  const toolbarError =
    error !== null && error.task.type !== 'append' && error.task.type !== 'prepend' && error.task.type !== 'initial' ? error : null
  // Initial, append and prepend progress is shown where the content will appear.
  const toolbarTask = task !== null && (task.type === 'refresh' || task.type === 'jump' || task.type === 'locate') ? task : null

  return (
    <section className="reader" aria-label={title === null ? `串 No.${threadId}` : `串：${title}`}>
      <div className="reader-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="reader-toolbar">
          <div className="toolbar-row">
            <div className="toolbar-group" role="group" aria-label="页面跳转">
              <button type="button" className="btn" onClick={toStart} title="回到第 1 页的开头">
                <Icon name="toTop" />
                开头
              </button>
              <button type="button" className="btn" onClick={thread.locateEnd} title="有限探测并定位到末尾附近">
                <Icon name="toEnd" />
                末尾
              </button>
              <form className="page-jump" onSubmit={onJump}>
                <label className="page-jump-label" htmlFor={`page-${threadId}`}>
                  页码
                </label>
                <input
                  id={`page-${threadId}`}
                  className="page-input"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={lastPage === undefined ? '1' : String(lastPage.page)}
                  value={pageInput}
                  onChange={(event) => setPageInput(event.target.value)}
                  aria-invalid={pageInput.trim() !== '' && !pageValid ? true : undefined}
                />
                <button type="submit" className="btn" disabled={!pageValid} aria-label="跳转到输入的页码">
                  跳转
                </button>
              </form>
            </div>
            <button type="button" className="btn" onClick={thread.refresh} title="重新读取已加载的最后一页并合并">
              <Icon name="refresh" />
              刷新
            </button>
          </div>

          <div className="toolbar-status">
            <div role="status" className="toolbar-status-text">
              {toolbarTask !== null && <Loading live={false}>{taskText(toolbarTask)}</Loading>}
              {task === null && state.endProbe?.status === 'insufficient' && (
                <span className="toolbar-warning">
                  <Icon name="alert" size={14} />
                  覆盖不足：已探测第 {formatPageList(state.endProbe.probedPages) || '—'} 页，未能确认末尾位置
                </span>
              )}
              {task === null && state.endProbe?.status === 'interrupted' && (
                <span className="toolbar-warning">
                  <Icon name="alert" size={14} />
                  末尾定位中断：第 {state.endProbe.failedPage} 页读取失败（{describeReadError(state.endProbe.error)}
                  {state.endProbe.error.serverMessage !== undefined && `；论坛提示：${state.endProbe.error.serverMessage}`}）；已探测第{' '}
                  {formatPageList(state.endProbe.probedPages) || '—'} 页，未能确认末尾位置。可再次点击“末尾”重试
                </span>
              )}
              {task === null && state.endProbe?.status === 'located' && (
                <span>已定位末尾（探测第 {formatPageList(state.endProbe.probedPages)} 页）</span>
              )}
            </div>
            {task?.type === 'locate' && (
              <button type="button" className="btn btn-small" onClick={thread.cancel}>
                <Icon name="close" size={14} />
                取消定位
              </button>
            )}
          </div>
          {toolbarError !== null && (
            <FailureNotice title={failureTitle(toolbarError.task)} failure={toolbarError.failure} onRetry={thread.retry} compact />
          )}

          <div className="toolbar-coverage">
            {loadedRange !== null && <span className="loaded-range">当前显示{loadedRange}</span>}
            <CoverageLine coverage={state.coverage} />
          </div>
        </div>

        <div className="reader-column">
          <header className="thread-header">
            <p className="thread-crumb">
              {head !== null && forumName(head.forumId) !== null && <span>{forumName(head.forumId)}</span>}
              <span>No.{threadId}</span>
            </p>
            <h1 className="thread-title">{title ?? `No.${threadId}`}</h1>
          </header>

          {head !== null && <PostView post={head} isHead poHash={null} />}

          {firstPage !== undefined && firstPage.page > 1 && (
            <div className="load-previous">
              {task?.type === 'prepend' ? (
                <Loading>{taskText(task)}</Loading>
              ) : (
                <button type="button" className="btn" onClick={loadPrevious}>
                  <Icon name="arrowUp" />
                  加载上一页（第 {firstPage.page - 1} 页）
                </button>
              )}
              {error?.task.type === 'prepend' && (
                <FailureNotice title={failureTitle(error.task)} failure={error.failure} onRetry={thread.retry} compact />
              )}
            </div>
          )}

          {state.pages.map((page) => {
            const replies = page.replies.filter((reply) => {
              if (shownIds.has(reply.id)) return false
              shownIds.add(reply.id)
              return true
            })
            return (
              <section key={page.page} className="page-section" data-page={page.page} aria-label={`第 ${page.page} 页`}>
                <h2 className="page-divider">第 {page.page} 页</h2>
                <SourceNotice source={page.source} subject={`第 ${page.page} 页`} />
                <PartialNotice skipped={page.skippedItems} subject={`第 ${page.page} 页`} />
                {replies.map((reply) => (
                  <PostView key={reply.id} post={reply} isHead={false} poHash={head?.userHash ?? null} />
                ))}
                {page.endCandidate && (
                  <div className="end-candidate" role="status">
                    <p>
                      {page.page === 1 ? '暂无回复：' : ''}已读取到末尾候选：第 {page.page} 页为空
                    </p>
                    <p className="end-candidate-note">空页只说明读取时没有更多回复，不代表串已结束。</p>
                    <button type="button" className="btn" onClick={thread.refresh} disabled={task?.type === 'refresh'}>
                      <Icon name="refresh" />
                      再检查新回复
                    </button>
                  </div>
                )}
              </section>
            )
          })}

          <div className="reader-footer">
            <div ref={sentinelRef} className="scroll-sentinel" aria-hidden="true" />
            {state.pages.length === 0 && task?.type === 'initial' && (
              <div className="reader-placeholder">
                <Loading>{taskText(task)}</Loading>
                <div aria-hidden="true">
                  {Array.from({ length: 3 }, (_, index) => (
                    <div key={index} className="post-skeleton">
                      <span className="skeleton-line is-short" />
                      <span className="skeleton-line" />
                      <span className="skeleton-line is-mid" />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {error?.task.type === 'initial' && (
              <FailureNotice title={failureTitle(error.task)} failure={error.failure} onRetry={thread.retry} />
            )}
            {task?.type === 'append' && <Loading>{taskText(task)}</Loading>}
            {error?.task.type === 'append' && (
              <FailureNotice title={failureTitle(error.task)} failure={error.failure} onRetry={thread.retry} compact />
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
