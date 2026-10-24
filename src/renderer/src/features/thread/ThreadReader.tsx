import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { Post, PostId, ReadingMode, ThreadId } from '../../../../shared/forum'
import type { ReadingAnchor, ThreadReadingState } from '../../../../shared/reading'
import { Icon } from '../../components/Icon'
import { FailureNotice, IdentitySettingsAction, Loading, PartialNotice, SourceNotice } from '../../components/Notices'
import { describeReadError, formatPageList, meaningfulTitle } from '../../lib/format'
import { useNearEnd } from '../../lib/useNearEnd'
import { NearViewport, type ImageView, type ViewerRequest } from '../image/imageView'
import { ImageViewer } from '../image/ImageViewer'
import { QuoteEntryContext } from '../quote/QuoteContext'
import { useRegisterContent } from '../tabs/contentRegistry'
import type { SourceFocus } from '../tabs/tabsState'
import { CoverageLine, pageLabel } from './CoverageLine'
import { PostView } from './PostView'
import { startPage, unreadInMode, type ReaderPosition } from './readingStart'
import type { ThreadTask } from './threadState'
import { useReadingViewport } from './useReadingViewport'
import { useThread } from './useThread'
import { FavoriteButton, OfflineButton } from '../content/ThreadRetention'
import { ReminderMenu } from '../reminders/ReminderMenu'
import { useThreadRules } from '../reminders/useReminders'

const MODE_NAMES: Record<ReadingMode, string> = { all: '全部回复', po: '只看 PO' }
/** How long a quote target stays marked after the jump. */
const HIGHLIGHT_MS = 2400
/** How long a settled reader waits for an automatic next page that may bring the quote to refocus. */
const FOCUS_WAIT_MS = 1500
const NO_POSTS: readonly PostId[] = []

function taskText(task: ThreadTask, mode: ReadingMode): string {
  switch (task.type) {
    case 'initial':
      return `正在读取${pageLabel(mode, task.page ?? 1)}…`
    case 'append':
      return `正在读取${pageLabel(mode, task.page)}…`
    case 'prepend':
      return `正在读取上一页（${pageLabel(mode, task.page)}）…`
    case 'refresh':
      return `正在重新读取${pageLabel(mode, task.page)}…`
    case 'jump':
      return `正在跳转到${pageLabel(mode, task.page)}…`
    case 'locate':
      return '正在定位末尾…'
  }
}

function failureTitle(task: ThreadTask, mode: ReadingMode): string {
  switch (task.type) {
    case 'initial':
      return `读取${pageLabel(mode, task.page ?? 1)}失败`
    case 'append':
    case 'prepend':
      return `读取${pageLabel(mode, task.page)}失败`
    case 'refresh':
      return `重新读取${pageLabel(mode, task.page)}失败，仍显示之前的内容`
    case 'jump':
      return `跳转到${pageLabel(mode, task.page)}失败，仍显示之前的内容`
    case 'locate':
      return '定位末尾失败，仍显示之前的内容'
  }
}

export interface ThreadReaderProps {
  entryKey: number
  threadId: ThreadId
  /** Mode being read; fixed for this reader (the owner remounts it to switch). */
  mode: ReadingMode
  /**
   * Set while an explicit target is shown in a mode other than the saved preference: names that
   * preference. Positions of such a temporary display are never saved.
   */
  temporaryOf: ReadingMode | null
  /** Reading-data generation this reader was created under; stamped on its snapshots. */
  generation: number
  start: ReaderPosition
  initialHead: Post | null
  /** Tab active and reader pane actually shown. */
  displayed: boolean
  /** Latest `readingState.get` result, or null when unavailable. */
  readingState: ThreadReadingState | null
  /** Posts marked read since that result. */
  readNow: ReadonlySet<PostId>
  /** Status of reading-state writes (mode preference, 全部标为已读). */
  notice: string | null
  markAllBusy: boolean
  forumName: (forumId: string | null) => string | null
  onChooseMode: (mode: ReadingMode) => void
  onRead: (postIds: PostId[]) => void
  onSavePosition: (mode: ReadingMode, anchor: ReadingAnchor) => void
  /** A page was observed: reading state (unread, coverage) should be fetched again. */
  onObserved: () => void
  onMarkAllRead: () => void
  /** Single-pane fallback: show the list of this entry again. */
  onBackToList: (() => void) | null
  /** Shown below the scroller (the reply editor); covered with the reader by the image viewer. */
  footer: ReactNode
  /** Opened through 打开原串: this quoted post was not located; the note stays while the entry shows. */
  unlocatedPostId: PostId | null
  /** Coming back through history: the quote that left this entry gets focus once placed. */
  restoreFocus: SourceFocus | null
  /** Quote target of the opening: briefly marked once placed and displayed. */
  highlightPostId: PostId | null
}

export function ThreadReader({
  entryKey,
  threadId,
  mode,
  temporaryOf,
  generation,
  start,
  initialHead,
  displayed,
  readingState,
  readNow,
  notice,
  markAllBusy,
  forumName,
  onChooseMode,
  onRead,
  onSavePosition,
  onObserved,
  onMarkAllRead,
  onBackToList,
  footer,
  unlocatedPostId,
  restoreFocus,
  highlightPostId
}: ThreadReaderProps) {
  const startRef = useRef(start)
  // One view ID per mounted reader: it protects the images it loaded and, through the content
  // hold, its thread from cache eviction. Both are released on unmount.
  const [viewId] = useState(() => crypto.randomUUID())
  const held = useRef<Promise<void> | null>(null)
  const hold = useCallback(() => {
    // A failed hold leaves reading possible; storage then treats the thread like other cache.
    held.current ??= window.xidao.content.holdReader({ viewId, threadId }).catch(() => undefined)
    return held.current
  }, [viewId, threadId])
  const thread = useThread(threadId, mode, initialHead, startPage(startRef.current), hold)
  const { state, firstPage, lastPage } = thread
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  /** Where the reading line goes when the next replaced range arrives. */
  const nextPosition = useRef<ReaderPosition | null>(startRef.current)
  const [pageInput, setPageInput] = useState('')
  const [nearby, setNearby] = useState<'anchor' | 'post' | null>(null)
  const temporary = temporaryOf !== null

  const [near] = useState(() => new NearViewport(() => scrollRef.current))
  const [viewer, setViewer] = useState<ViewerRequest | null>(null)
  const imageView = useMemo<ImageView>(() => ({ viewId, near, openViewer: setViewer }), [viewId, near])
  const closeViewer = useCallback(() => setViewer(null), [])
  const ruleThreads = useMemo(() => [threadId], [threadId])
  const rules = useThreadRules(ruleThreads)
  /** The 提醒 panel floats over the top of the content: nothing is judged read while it is open. */
  const [reminderPanelOpen, setReminderPanelOpen] = useState(false)
  useEffect(
    () => () => {
      near.disconnect()
      window.xidao.images.releaseView({ viewId }).catch(() => undefined)
      held.current = null
      window.xidao.content.releaseReader({ viewId }).catch(() => undefined)
    },
    [near, viewId]
  )

  // Closing the viewer returns focus to the thumbnail that opened it, without moving the reader
  // (the body is no longer inert by then).
  const viewerTrigger = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (viewer !== null) {
      viewerTrigger.current = viewer.trigger
      return
    }
    const trigger = viewerTrigger.current
    if (trigger === null) return
    viewerTrigger.current = null
    if (trigger.isConnected) trigger.focus({ preventScroll: true })
    else scrollRef.current?.focus({ preventScroll: true })
  }, [viewer])

  const { position, onScroll, currentAnchor, hasPost, isVisible } = useReadingViewport({
    scrollRef,
    contentRef,
    toolbarRef,
    displayed,
    covered: viewer !== null || reminderPanelOpen,
    canSave: !temporary,
    knownRead: readingState?.readPostIds ?? NO_POSTS,
    onRead,
    onSave: (anchor) => onSavePosition(mode, anchor),
    onNearby: setNearby
  })

  useNearEnd(scrollRef, sentinelRef, thread.canAppend, `${state.pages.length}:${lastPage?.page ?? 0}`, thread.appendNext)

  // A replaced range (first load, jump, 开头, 末尾, 首条未读) gets the position its action asked for.
  useLayoutEffect(() => {
    if (state.rangeVersion === 0) return
    const target: ReaderPosition = nextPosition.current ?? { kind: 'top' }
    nextPosition.current = null
    position(target)
  }, [state.rangeVersion, position])

  // Every observed page can change unread posts and coverage.
  useEffect(() => {
    if (state.coverage !== null) onObserved()
  }, [state.coverage, onObserved])

  const [highlighted, setHighlighted] = useState<PostId | null>(null)
  const highlightTimer = useRef<number | undefined>(undefined)
  const highlight = useCallback((postId: PostId) => {
    window.clearTimeout(highlightTimer.current)
    setHighlighted(postId)
    highlightTimer.current = window.setTimeout(() => setHighlighted(null), HIGHLIGHT_MS)
  }, [])
  useEffect(() => () => window.clearTimeout(highlightTimer.current), [])

  /** Quote target of the opening: marked once the first position is placed on screen. */
  const pendingHighlight = useRef(highlightPostId)
  useLayoutEffect(() => {
    const postId = pendingHighlight.current
    if (postId === null || !displayed || state.rangeVersion === 0 || currentAnchor() === null) return
    pendingHighlight.current = null
    if (hasPost(postId)) highlight(postId)
  }, [displayed, state.rangeVersion, currentAnchor, hasPost, highlight])

  /**
   * Quote to give focus back to. Kept until it is rendered in this reader (a page appended after the
   * restore may bring it), and dropped when the user scrolls the reader, clicks, types or moves focus
   * anywhere, when the reader is hidden, or when it has settled without it. Never scrolls and never
   * loads anything by itself.
   */
  const pendingFocus = useRef(restoreFocus)
  const focusWait = useRef<number | undefined>(undefined)
  const dropFocus = useCallback(() => {
    pendingFocus.current = null
    window.clearTimeout(focusWait.current)
  }, [])
  useLayoutEffect(() => {
    const focus = pendingFocus.current
    if (focus === null || state.rangeVersion === 0 || currentAnchor() === null) return
    if (!displayed) {
      dropFocus()
      return
    }
    window.clearTimeout(focusWait.current)
    const element = contentRef.current?.querySelector<HTMLElement>(
      `[data-quote-host="${CSS.escape(focus.postId)}"][data-quote-index="${focus.quoteIndex}"]`
    )
    if (element != null) {
      dropFocus()
      element.focus({ preventScroll: true })
      return
    }
    // Placed and nothing loading: give an automatic next-page read a moment to start, then give up.
    if (state.task === null) focusWait.current = window.setTimeout(dropFocus, FOCUS_WAIT_MS)
  }, [displayed, state.rangeVersion, state.pages, state.task, currentAnchor, dropFocus])
  useEffect(() => {
    const scroller = scrollRef.current
    if (scroller === null) return
    const inReader = ['wheel', 'touchstart'] as const
    const anywhere = ['pointerdown', 'keydown', 'focusin'] as const
    for (const type of inReader) scroller.addEventListener(type, dropFocus, { passive: true })
    for (const type of anywhere) document.addEventListener(type, dropFocus, true)
    return () => {
      for (const type of inReader) scroller.removeEventListener(type, dropFocus)
      for (const type of anywhere) document.removeEventListener(type, dropFocus, true)
      window.clearTimeout(focusWait.current)
    }
  }, [dropFocus])

  useRegisterContent('readers', entryKey, {
    capture: () => {
      const anchor = currentAnchor()
      return anchor === null ? null : { mode, anchor, generation, temporaryOf, focus: null }
    },
    refresh: thread.refresh,
    showInPlace: (targetThread, target) => {
      if (targetThread !== threadId || target.mode !== mode || !isVisible(target.postId)) return false
      highlight(target.postId)
      return true
    }
  })

  /** Explicit entry: place directly when the range already holds it, otherwise load and place. */
  const goTo = (position: ReaderPosition, load: () => void) => {
    setNearby(null)
    nextPosition.current = position
    load()
  }

  const toStart = () => {
    if (firstPage?.page === 1) {
      setNearby(null)
      position({ kind: 'top' })
    } else goTo({ kind: 'top' }, () => thread.jump(1))
  }

  const unreadHere = useMemo(() => unreadInMode(readingState, mode, readNow), [readingState, mode, readNow])
  const firstUnread = unreadHere[0]
  const toFirstUnread = () => {
    if (firstUnread === undefined) return
    const page = firstUnread.pages[mode] ?? 1
    const target: ReaderPosition = { kind: 'post', postId: firstUnread.postId, page }
    if (hasPost(firstUnread.postId)) {
      setNearby(null)
      position(target)
    } else goTo(target, () => thread.jump(page))
  }

  const parsedPage = /^\d+$/.test(pageInput.trim()) ? Number(pageInput.trim()) : NaN
  const pageValid = Number.isSafeInteger(parsedPage) && parsedPage >= 1
  const onJump = (event: FormEvent) => {
    event.preventDefault()
    if (pageValid) goTo({ kind: 'page', page: parsedPage }, () => thread.jump(parsedPage))
  }

  const unreadIds = useMemo(() => {
    const ids = new Set<PostId>()
    for (const post of readingState?.unread ?? []) if (!readNow.has(post.postId)) ids.add(post.postId)
    return ids
  }, [readingState, readNow])
  const confirmedUnread = readingState?.unread.length ?? 0

  const head = state.head
  const title = head === null ? null : meaningfulTitle(head.title)
  const task = state.task
  const error = state.error
  const shownIds = new Set<string>(head === null ? [] : [head.id])
  const loadedRange =
    firstPage === undefined || lastPage === undefined
      ? null
      : firstPage.page === lastPage.page
        ? pageLabel(mode, firstPage.page)
        : pageLabel(mode, `${firstPage.page}–${lastPage.page}`)
  const toolbarError =
    error !== null && error.task.type !== 'append' && error.task.type !== 'prepend' && error.task.type !== 'initial' ? error : null
  // Initial, append and prepend progress is shown where the content will appear.
  const toolbarTask = task !== null && (task.type === 'refresh' || task.type === 'jump' || task.type === 'locate') ? task : null

  return (
    <section className="reader" aria-label={title === null ? `串 No.${threadId}` : `串：${title}`}>
      <div
        className="reader-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        tabIndex={-1}
        data-pane-focus=""
        inert={viewer !== null}
      >
        <div className="reader-toolbar" ref={toolbarRef}>
          <div className="reader-toolbar-inner">
            <div className="toolbar-row">
              <div className="toolbar-group">
                {onBackToList !== null && (
                  <button type="button" className="btn" onClick={onBackToList}>
                    <Icon name="arrowLeft" />
                    返回串列表
                  </button>
                )}
                <div className="segmented" role="group" aria-label="阅读模式">
                  {(['all', 'po'] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="segmented-item"
                      aria-pressed={mode === item}
                      onClick={() => onChooseMode(item)}
                    >
                      {item === 'all' ? '全部' : '只看 PO'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="toolbar-group">
                <FavoriteButton threadId={threadId} />
                <ReminderMenu
                  threadId={threadId}
                  label={title ?? `No.${threadId}`}
                  rules={rules.rulesOf(threadId)}
                  failure={rules.failure}
                  onRetry={rules.reload}
                  onUpdated={rules.updated}
                  onOpenChange={setReminderPanelOpen}
                />
                <OfflineButton threadId={threadId} title={title ?? `No.${threadId}`} />
                <button type="button" className="btn" onClick={thread.refresh} title="重新读取已加载的最后一页并合并">
                  <Icon name="refresh" />
                  刷新
                </button>
              </div>
            </div>

            <div className="toolbar-row">
              <div className="toolbar-group" role="group" aria-label="阅读位置">
                <button type="button" className="btn" onClick={toStart} title="回到第 1 页的开头">
                  <Icon name="toTop" />
                  开头
                </button>
                <button type="button" className="btn" onClick={() => goTo({ kind: 'last' }, thread.locateEnd)} title="有限探测并定位到末尾附近">
                  <Icon name="toEnd" />
                  末尾
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={toFirstUnread}
                  disabled={firstUnread === undefined}
                  title={`跳到${MODE_NAMES[mode]}中已获取的第一条未读发言`}
                >
                  首条未读
                  <span className="btn-count">{unreadHere.length}</span>
                </button>
                <form className="page-jump" onSubmit={onJump}>
                  <label className="page-jump-label" htmlFor={`page-${entryKey}-${threadId}`}>
                    {mode === 'po' ? 'PO 页码' : '页码'}
                  </label>
                  <input
                    id={`page-${entryKey}-${threadId}`}
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
              <button
                type="button"
                className="btn btn-quiet"
                onClick={onMarkAllRead}
                disabled={confirmedUnread === 0 || markAllBusy}
                title="只处理已经获取并确认未读的发言，不包括未获取的页面和以后的新回复"
              >
                <Icon name="check" />
                全部标为已读（已获取的 {confirmedUnread} 条）
              </button>
            </div>

            {unlocatedPostId !== null && (
              <div className="toolbar-note" role="status">
                <Icon name="info" size={14} />
                <span>未定位到引用的 No.{unlocatedPostId}：已按正常续读位置打开原串，没有跳到这条回复</span>
              </div>
            )}

            {temporaryOf !== null && (
              <div className="toolbar-note" role="status">
                <Icon name="info" size={14} />
                <span>
                  临时显示{MODE_NAMES[mode]}以定位目标，{MODE_NAMES[temporaryOf]}偏好未改变
                </span>
                <button type="button" className="btn btn-small" onClick={() => onChooseMode(temporaryOf)}>
                  回到{MODE_NAMES[temporaryOf]}
                </button>
              </div>
            )}

            <div className="toolbar-status">
              <div role="status" className="toolbar-status-text">
                {toolbarTask !== null && <Loading live={false}>{taskText(toolbarTask, mode)}</Loading>}
                {nearby === 'anchor' && task === null && <span>原位置已变化，已返回附近</span>}
                {nearby === 'post' && task === null && <span>原位置的发言不在读取到的页面中，已显示附近位置</span>}
                {notice !== null && <span className="toolbar-warning">{notice}</span>}
                {task === null && state.endProbe?.status === 'insufficient' && (
                  <span className="toolbar-warning">
                    <Icon name="alert" size={14} />
                    覆盖不足：已探测{pageLabel(mode, formatPageList(state.endProbe.probedPages) || '—')}，未能确认末尾位置
                  </span>
                )}
                {task === null && state.endProbe?.status === 'interrupted' && (
                  <span className="toolbar-warning">
                    <Icon name="alert" size={14} />
                    末尾定位中断：{pageLabel(mode, state.endProbe.failedPage)}读取失败（{describeReadError(state.endProbe.error)}
                    {state.endProbe.error.serverMessage !== undefined && `；论坛提示：${state.endProbe.error.serverMessage}`}）；已探测
                    {pageLabel(mode, formatPageList(state.endProbe.probedPages) || '—')}，未能确认末尾位置。可再次点击“末尾”重试
                  </span>
                )}
                {task === null && state.endProbe?.status === 'located' && (
                  <span>已定位末尾（探测{pageLabel(mode, formatPageList(state.endProbe.probedPages))}）</span>
                )}
              </div>
              {task === null && state.endProbe?.status === 'interrupted' && (
                <IdentitySettingsAction error={state.endProbe.error} />
              )}
              {task?.type === 'locate' && (
                <button type="button" className="btn btn-small" onClick={thread.cancel}>
                  <Icon name="close" size={14} />
                  取消定位
                </button>
              )}
            </div>
            {toolbarError !== null && (
              <FailureNotice title={failureTitle(toolbarError.task, mode)} failure={toolbarError.failure} onRetry={thread.retry} compact />
            )}

            <div className="toolbar-coverage">
              {loadedRange !== null && <span className="loaded-range">当前显示{loadedRange}</span>}
              <CoverageLine coverage={state.coverage} mode={mode} />
            </div>
          </div>
        </div>

        <QuoteEntryContext.Provider value={entryKey}>
        <div className="reader-column" ref={contentRef}>
          <header className="thread-header">
            <p className="thread-crumb">
              {head !== null && forumName(head.forumId) !== null && <span>{forumName(head.forumId)}</span>}
              <span>No.{threadId}</span>
              {mode === 'po' && <span className="tag tag-po">只看 PO</span>}
            </p>
            <h1 className="thread-title">{title ?? `No.${threadId}`}</h1>
          </header>

          {head !== null && (
            <PostView
              post={head}
              isHead
              poHash={null}
              unread={unreadIds.has(head.id)}
              images={imageView}
              highlighted={highlighted === head.id}
            />
          )}

          {firstPage !== undefined && firstPage.page > 1 && (
            <div className="load-previous">
              {task?.type === 'prepend' ? (
                <Loading>{taskText(task, mode)}</Loading>
              ) : (
                <button type="button" className="btn" onClick={thread.prependPrevious}>
                  <Icon name="arrowUp" />
                  加载上一页（{pageLabel(mode, firstPage.page - 1)}）
                </button>
              )}
              {error?.task.type === 'prepend' && (
                <FailureNotice title={failureTitle(error.task, mode)} failure={error.failure} onRetry={thread.retry} compact />
              )}
            </div>
          )}

          {state.pages.map((page) => {
            const replies = page.replies.filter((reply) => {
              if (shownIds.has(reply.id)) return false
              shownIds.add(reply.id)
              return true
            })
            const label = pageLabel(mode, page.page)
            return (
              <section key={page.page} className="page-section" data-page={page.page} aria-label={label}>
                <h2 className="page-divider">{label}</h2>
                <SourceNotice source={page.source} subject={label} />
                <PartialNotice skipped={page.skippedItems} subject={label} />
                {replies.map((reply) => (
                  <PostView
                    key={reply.id}
                    post={reply}
                    isHead={false}
                    poHash={head?.userHash ?? null}
                    unread={unreadIds.has(reply.id)}
                    images={imageView}
                    highlighted={highlighted === reply.id}
                  />
                ))}
                {page.endCandidate && (
                  <div className="end-candidate" role="status">
                    <p>
                      {page.page === 1 ? '暂无回复：' : ''}已读取到末尾候选：{label}为空
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
                <Loading>{taskText(task, mode)}</Loading>
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
              <FailureNotice title={failureTitle(error.task, mode)} failure={error.failure} onRetry={thread.retry} />
            )}
            {task?.type === 'append' && <Loading>{taskText(task, mode)}</Loading>}
            {error?.task.type === 'append' && (
              <FailureNotice title={failureTitle(error.task, mode)} failure={error.failure} onRetry={thread.retry} compact />
            )}
          </div>
        </div>
        </QuoteEntryContext.Provider>
      </div>
      <div className="reader-dock" inert={viewer !== null}>
        {footer}
      </div>
      {viewer !== null && (
        <ImageViewer
          key={viewer.postId}
          viewId={viewId}
          postId={viewer.postId}
          initialThumb={viewer.thumb}
          displayed={displayed}
          onClose={closeViewer}
        />
      )}
    </section>
  )
}
