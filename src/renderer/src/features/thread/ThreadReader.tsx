import { Component, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import type { Post, PostId, ReadingMode, ThreadId } from '../../../../shared/forum'
import { threadTotalPages } from '../../../../shared/threadPages'
import type { ReadingAnchor } from '../../../../shared/reading'
import { Icon, Spinner } from '../../components/Icon'
import { FailureNotice, IdentitySettingsAction, Loading, PartialNotice, SourceNotice } from '../../components/Notices'
import { describeReadError, meaningfulTitle } from '../../lib/format'
import { useNearEnd } from '../../lib/useNearEnd'
import { NearViewport, type ImageView, type ViewerRequest } from '../image/imageView'
import { ImageViewer } from '../image/ImageViewer'
import { QuoteEntryContext } from '../quote/QuoteContext'
import { useSearchOpener } from '../search/SearchContext'
import { useRegisterContent } from '../tabs/contentRegistry'
import type { SourceFocus } from '../tabs/tabsState'
import { PostView } from './PostView'
import { startPage, type ReaderPosition } from './readingStart'
import { showsHead, type ThreadTask } from './threadState'
import { useReadingViewport } from './useReadingViewport'
import { useThread } from './useThread'
import type { ComposeEntry } from '../editor/ComposePanel'
import { usePopover } from '../../lib/usePopover'
import { ThreadMoreMenu } from './ThreadMoreMenu'
import { useThreadRules } from '../reminders/useReminders'
import { SubscribeButton, SubscribeNote } from './SubscribeButton'
import { isPostBlocked } from '../../../../shared/blocks'
import { useBlocks } from './useBlocks'
import { usePostActions } from './usePostActions'
import { JumpPillButton, useJumpPills } from './JumpPills'
import type { JumpPill, PillEnds } from './jumpPills'

const MODE_NAMES: Record<ReadingMode, string> = { all: '全部回复', po: '只看 PO' }
/** How long a quote target stays marked after the jump. */
const HIGHLIGHT_MS = 2400
/** How long a settled reader waits for an automatic next page that may bring the quote to refocus. */
const FOCUS_WAIT_MS = 1500
/** Posts in reading order, blocked placeholders included. */
const SHOWN_POSTS = '[data-post-id], [data-blocked-post-id]'

/** “第 3 页” or “只看 PO 第 3 页”: PO page numbers are not the pages of 全部. */
function pageLabel(mode: ReadingMode, pages: string | number): string {
  return mode === 'po' ? `只看 PO 第 ${pages} 页` : `第 ${pages} 页`
}

function failureTitle(task: ThreadTask, mode: ReadingMode): string {
  switch (task.type) {
    case 'initial':
      return `读取${pageLabel(mode, task.page ?? 1)}失败`
    case 'append':
    case 'prepend':
      return `读取${pageLabel(mode, task.page)}失败`
    case 'refresh':
      return '刷新失败'
    case 'jump':
      return `跳转到${pageLabel(mode, task.page)}失败`
    case 'locate':
      return '定位末尾失败'
  }
}

/** A page number typed by the user: whole digits only, 1 or more. */
function parsePage(input: string, max: number | null): { page: number; valid: boolean; invalid: boolean } {
  const trimmed = input.trim()
  const page = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN
  const valid = Number.isSafeInteger(page) && page >= 1 && (max === null || page <= max)
  return { page, valid, invalid: trimmed !== '' && !valid }
}

/**
 * The `当前页/总页数` button of the toolbar (`?` while the total is unknown). Opens a small panel with the page
 * input; a valid jump closes it and focus returns to the button.
 */
function PagePopover({
  inputId,
  mode,
  label,
  name,
  placeholder,
  max,
  onJump
}: {
  inputId: string
  mode: ReadingMode
  /** Visible text, e.g. `1/5`. */
  label: string
  /** Accessible name, e.g. `第 1 页，共 5 页`. */
  name: string
  placeholder: string
  max: number | null
  onJump: (page: number) => void
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const popover = usePopover(triggerRef, panelRef)
  const panelId = useId()
  const [input, setInput] = useState('')
  const { page, valid, invalid } = parsePage(input, max)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!valid) return
    popover.close()
    setInput('')
    onJump(page)
  }

  return (
    <span
      className="position-page"
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (popover.open && next !== null && !event.currentTarget.contains(next)) popover.close(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="btn tb-btn position-page-trigger"
        aria-expanded={popover.open}
        aria-controls={popover.open ? panelId : undefined}
        aria-label={name}
        title={name}
        onClick={popover.toggle}
      >
        {label}
        <Icon name="chevron" size={12} className="position-page-chevron" />
      </button>
      {popover.open && (
        <div ref={panelRef} id={panelId} className="position-page-panel" role="group" aria-label="跳转页码">
          <form className="page-jump" onSubmit={submit}>
            <label className="page-jump-label" htmlFor={inputId}>
              {mode === 'po' ? 'PO 页码' : '页码'}
            </label>
            <input
              id={inputId}
              className="page-input"
              inputMode="numeric"
              min={1}
              max={max ?? undefined}
              autoComplete="off"
              data-autofocus=""
              placeholder={placeholder}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              aria-invalid={invalid ? true : undefined}
              aria-describedby={invalid ? `${inputId}-error` : undefined}
            />
            <button type="submit" className="btn btn-small" disabled={!valid} aria-label="跳转到输入的页码">
              跳转
            </button>
            {invalid && (
              <span className="page-jump-error" id={`${inputId}-error`}>
                <Icon name="alert" size={13} />
                {max === null ? '页码须为 1 以上的整数' : `页码须为 1–${max} 的整数`}
              </span>
            )}
          </form>
        </div>
      )}
    </span>
  )
}

interface PrependAnchorProps {
  /** Number of the first loaded page. */
  first: number | undefined
  /** `rangeVersion`: a replaced range is positioned by its action instead. */
  range: number
  snapshot: () => ReadingAnchor | null
  keep: (anchor: ReadingAnchor) => void
}

/**
 * Keeps the view still when the page before the range is inserted above it. `getSnapshotBeforeUpdate`
 * is the one point that runs before React mutates the DOM of a commit, so the post on screen is read
 * there and put back at the same spot right after layout, before anything is painted.
 */
class PrependAnchor extends Component<PrependAnchorProps> {
  override getSnapshotBeforeUpdate(previous: Readonly<PrependAnchorProps>): ReadingAnchor | null {
    const { first, range, snapshot } = this.props
    const prepended = range === previous.range && first !== undefined && previous.first !== undefined && first < previous.first
    return prepended ? snapshot() : null
  }

  override componentDidUpdate(_previous: Readonly<PrependAnchorProps>, _state: unknown, anchor: ReadingAnchor | null): void {
    if (anchor !== null) this.props.keep(anchor)
  }

  override render(): null {
    return null
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
  /** Status of reading-state writes (mode preference, reset). */
  notice: string | null
  forumName: (forumId: string | null) => string | null
  onChooseMode: (mode: ReadingMode) => void
  onSavePosition: (mode: ReadingMode, anchor: ReadingAnchor) => void
  /** A page was observed: reading state should be fetched again. */
  onObserved: () => void
  /** Single-pane fallback: show the list of this entry again. */
  onBackToList: (() => void) | null
  /** Opened through 打开原串: this quoted post was not located; the note stays while the entry shows. */
  unlocatedPostId: PostId | null
  /** Coming back through history: the quote that left this entry gets focus once placed. */
  restoreFocus: SourceFocus | null
  /** Quote target of the opening: briefly marked once placed and displayed. */
  highlightPostId: PostId | null
  /** The 回复 entry placed in the toolbar and its sent note; `null` where no editor workspace is available. */
  compose: ComposeEntry | null
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
  notice,
  forumName,
  onChooseMode,
  onSavePosition,
  onObserved,
  onBackToList,
  unlocatedPostId,
  restoreFocus,
  highlightPostId,
  compose
}: ThreadReaderProps) {
  const startRef = useRef(start)
  const blocks = useBlocks()
  const postActions = usePostActions(compose?.tabId ?? null, threadId)
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set())
  useLayoutEffect(() => { setRevealed(new Set()) }, [blocks.blocks])
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
  /** Near the top, scrolling up loads the page before the range. */
  const topSentinelRef = useRef<HTMLDivElement>(null)
  /** Where the reading line goes when the next replaced range arrives. */
  const nextPosition = useRef<ReaderPosition | null>(startRef.current)
  const [nearby, setNearby] = useState<'anchor' | 'post' | null>(null)
  const temporary = temporaryOf !== null
  /**
   * The user moved up (wheel, key or scroll) since the range was placed. Placing a range never
   * loads the page before it by itself.
   */
  const [prependArmed, setPrependArmed] = useState(false)
  /** The corner 开头 / 末尾 buttons, fed only by scrolls that follow the user's own input. */
  const { shown: pillShown, scrolled: pillScrolled, gesture: pillGesture, pressed: pillPressed, hide: hidePills, hold: holdPill } =
    useJumpPills()

  const [near] = useState(() => new NearViewport(() => scrollRef.current))
  const [viewer, setViewer] = useState<ViewerRequest | null>(null)
  const imageView = useMemo<ImageView>(() => ({ viewId, near, openViewer: setViewer }), [viewId, near])
  const closeViewer = useCallback(() => setViewer(null), [])
  const ruleThreads = useMemo(() => [threadId], [threadId])
  const rules = useThreadRules(ruleThreads)
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

  const { position, onScroll, currentAnchor, hasPost, isVisible, exactAnchor, keepAnchor } = useReadingViewport({
    scrollRef,
    contentRef,
    toolbarRef,
    displayed,
    canSave: !temporary,
    onSave: (anchor) => onSavePosition(mode, anchor),
    onNearby: setNearby,
    onUserScroll: (delta) => {
      if (delta < 0) setPrependArmed(true)
      const scroller = scrollRef.current
      if (scroller !== null) pillScrolled(delta, scroller.clientHeight, pillEnds(scroller))
    }
  })

  useNearEnd(scrollRef, sentinelRef, thread.canAppend, `${state.pages.length}:${lastPage?.page ?? 0}`, thread.appendNext)

  // Within about one viewport of the top, the page before the range follows the reader up. A failed
  // read stops here until 重试 (`canPrepend` stays false while its failure is shown).
  useNearEnd(
    scrollRef,
    topSentinelRef,
    prependArmed && thread.canPrepend,
    firstPage?.page ?? 0,
    thread.prependAuto,
    '100% 0px 0px 0px'
  )

  // A replaced range (first load, jump, 开头, 末尾) gets the position its action asked for.
  useLayoutEffect(() => {
    if (state.rangeVersion === 0) return
    setPrependArmed(false)
    hidePills()
    const target: ReaderPosition = nextPosition.current ?? { kind: 'top' }
    nextPosition.current = null
    // A capped tail still goes to the readable page's end; a capped page jump goes to its top.
    position(state.pageCap !== null && target.kind !== 'last' ? { kind: 'top' } : target)
  }, [state.rangeVersion, position, hidePills])

  // Every observed page can change the reading state and coverage.
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
    },
    shown: () => ({ threadId, mode, title: state.head === null ? null : meaningfulTitle(state.head.title) })
  })
  const openSearch = useSearchOpener()

  /** Explicit entry: place directly when the range already holds it, otherwise load and place. */
  const goTo = (position: ReaderPosition, load: () => void) => {
    setNearby(null)
    hidePills()
    nextPosition.current = position
    load()
  }

  /** Explicit entry already in the range; like a new range, it waits for the user to move up again. */
  const placeHere = (target: ReaderPosition) => {
    setNearby(null)
    setPrependArmed(false)
    hidePills()
    position(target)
  }

  const toStart = () => {
    if (firstPage?.page === 1) placeHere({ kind: 'top' })
    else goTo({ kind: 'top' }, () => thread.jump(1))
  }

  const toEnd = () => goTo({ kind: 'last' }, thread.locateEnd)

  /**
   * Keys on the reading content. Home and Ctrl/⌘+Home go to the start of page 1 like 开头 (the top
   * of a range opened further in is not the start of the thread); Ctrl/⌘+End is 末尾, while a plain
   * End keeps the browser's move to the bottom of what is loaded. Moving up lets the page before
   * follow.
   */
  const onReaderKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Any key may scroll the reader (arrows, space, Tab to a post below); the corner buttons may follow it.
    pillGesture()
    if (event.defaultPrevented || event.altKey) return
    const target = event.target as HTMLElement
    if (toolbarRef.current?.contains(target) || target.isContentEditable || target.closest('input, textarea, select') !== null) return
    const modified = event.ctrlKey || event.metaKey
    if (event.key === 'Home' && !event.shiftKey) {
      event.preventDefault()
      toStart()
    } else if (event.key === 'End' && modified && !event.shiftKey) {
      event.preventDefault()
      toEnd()
    } else if (!modified && (event.key === 'ArrowUp' || event.key === 'PageUp' || (event.key === ' ' && event.shiftKey))) {
      setPrependArmed(true)
    }
  }

  /** Which ends of the thread are on screen, for the corner buttons. */
  const pillEnds = (scroller: HTMLElement): PillEnds => {
    const near = scroller.clientHeight / 2
    const realEnd = lastPage !== undefined && (lastPage.endCandidate || (totalPages !== null && lastPage.page >= totalPages))
    return {
      atStart: firstPage?.page === 1 && scroller.scrollTop < near,
      atEnd: realEnd && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < near
    }
  }
  const pillFocusBack = useCallback(() => scrollRef.current?.focus({ preventScroll: true }), [])
  const onPill = (pill: JumpPill) => {
    // The pill hides as it acts: focus it had goes back to the content, never elsewhere.
    if (document.activeElement instanceof HTMLElement && document.activeElement.classList.contains('jump-pill')) pillFocusBack()
    if (pill === 'start') toStart()
    else toEnd()
  }

  const totalPages = threadTotalPages(state.coverage?.reportedReplyCount ?? null)

  /** Page of the post at the reading line, for the toolbar's `当前页/总页数`. */
  const [readingPage, setReadingPage] = useState<number | null>(null)
  useEffect(() => {
    setReadingPage(currentAnchor()?.page ?? null)
  }, [state.rangeVersion, state.pages, currentAnchor])
  const onReaderScroll = () => {
    onScroll()
    setReadingPage(currentAnchor()?.page ?? null)
  }
  const shownPage = readingPage ?? firstPage?.page ?? 1

  const head = state.head
  const title = head === null ? null : meaningfulTitle(head.title)
  const task = state.task
  const error = state.error
  const shownIds = new Set<string>(head === null ? [] : [head.id])
  // The main post comes with page 1; until then a hidden h1 keeps the reader's single h1.
  const headShown = showsHead(state)
  // Failures of 刷新, jumps, 末尾 and the automatic previous page are reported at the top, with 重试.
  const toolbarError = error !== null && error.task.type !== 'append' && error.task.type !== 'initial' ? error : null
  // Loads stay quiet until they fail; only the cancellable 定位末尾 is shown.
  const locating = task?.type === 'locate'

  // The toolbar's borderless buttons; their labels give way to icons (with the name kept for
  // assistive technology and the tooltip) when the row gets narrow.
  const barButton = 'btn tb-btn'

  const backButton = onBackToList !== null && (
    <button type="button" className={barButton} onClick={onBackToList} title="返回串列表">
      <Icon name="arrowLeft" />
      <span className="btn-label">返回串列表</span>
    </button>
  )

  const modeSwitch = (
    <div className="segmented" role="group" aria-label="阅读模式">
      {(['all', 'po'] as const).map((item) => (
        <button key={item} type="button" className="segmented-item" aria-pressed={mode === item} onClick={() => onChooseMode(item)}>
          {item === 'all' ? '全部' : '只看 PO'}
        </button>
      ))}
    </div>
  )

  const searchButton = openSearch !== null && (
    <button
      type="button"
      className={barButton}
      aria-haspopup="dialog"
      title="串内搜索"
      onClick={() => openSearch({ view: 'thread', entryKey, threadId, mode, title })}
    >
      <Icon name="search" />
      <span className="btn-label">串内搜索</span>
    </button>
  )

  const refreshButton = (
    <button type="button" className={barButton} onClick={thread.refresh} title="刷新" aria-busy={task?.type === 'refresh' || undefined}>
      <Icon name="refresh" />
      <span className="btn-label">刷新</span>
    </button>
  )

  // The end of a fully read thread is only a quiet 刷新. It stays focusable while it works
  // (aria-disabled); if new replies replace it, focus moves to the first new reply.
  const endRefreshRef = useRef<HTMLButtonElement>(null)
  /** Posts shown when the focused end 刷新 was pressed; null when it was not the focus. */
  const endRefreshFrom = useRef<number | null>(null)
  const endRefreshing = task?.type === 'refresh'
  const refreshAtEnd = () => {
    if (endRefreshing) return
    endRefreshFrom.current =
      document.activeElement === endRefreshRef.current ? (contentRef.current?.querySelectorAll(SHOWN_POSTS).length ?? 0) : null
    thread.refresh()
  }
  useEffect(() => {
    const shown = endRefreshFrom.current
    if (shown === null || state.task?.type === 'refresh') return
    endRefreshFrom.current = null
    if (endRefreshRef.current !== null) return
    const posts = contentRef.current?.querySelectorAll<HTMLElement>(SHOWN_POSTS)
    const next = posts?.[shown] ?? posts?.[posts.length - 1]
    next?.focus()
  }, [state.task, state.pages])

  const notes = (
    <>
      {unlocatedPostId !== null && (
        <div className="toolbar-note" role="status">
          <Icon name="info" size={14} />
          <span>没有找到 No.{unlocatedPostId}，已从上次阅读的位置打开</span>
        </div>
      )}

      {temporaryOf !== null && (
        <div className="toolbar-note" role="status">
          <Icon name="info" size={14} />
          <span>正在临时显示{MODE_NAMES[mode]}</span>
          <button type="button" className="btn btn-small" onClick={() => onChooseMode(temporaryOf)}>
            回到{MODE_NAMES[temporaryOf]}
          </button>
        </div>
      )}
    </>
  )

  // Only what applies now.
  const status = (
    <div className="toolbar-status">
      <div role="status" className="toolbar-status-text">
        {locating && <Loading live={false}>正在定位末尾…</Loading>}
        {task === null && state.pageCap !== null && <span>论坛只返回到第 {state.pageCap} 页</span>}
        {nearby === 'anchor' && task === null && <span>原位置已变化，已返回附近</span>}
        {nearby === 'post' && task === null && <span>原位置不在已读取的页面中，已显示附近</span>}
        {notice !== null && <span className="toolbar-warning">{notice}</span>}
        {blocks.failure !== null && (
          <span role="alert" className="toolbar-warning">
            {blocks.failure}
            <button type="button" className="btn btn-small" onClick={() => void blocks.retry()}>重试</button>
          </span>
        )}
        {task === null && state.endProbe?.status === 'insufficient' && (
          <span className="toolbar-warning">
            <Icon name="alert" size={14} />
            未能确认末尾
          </span>
        )}
        {task === null && state.endProbe?.status === 'interrupted' && (
          <span className="toolbar-warning">
            <Icon name="alert" size={14} />
            {pageLabel(mode, state.endProbe.failedPage)}读取失败（{describeReadError(state.endProbe.error)}
            {state.endProbe.error.serverMessage !== undefined && `；论坛提示：${state.endProbe.error.serverMessage}`}），未能定位末尾
          </span>
        )}
        {compose?.note}
        <SubscribeNote threadId={threadId} />
      </div>
      {task === null && state.endProbe?.status === 'interrupted' && <IdentitySettingsAction error={state.endProbe.error} />}
      {locating && (
        <button type="button" className="btn btn-small" onClick={thread.cancel}>
          <Icon name="close" size={14} />
          取消定位
        </button>
      )}
    </div>
  )

  const failure = toolbarError !== null && (
    <FailureNotice title={failureTitle(toolbarError.task, mode)} failure={toolbarError.failure} onRetry={thread.retry} compact />
  )

  return (
    <section className="reader" aria-label={title === null ? `串 No.${threadId}` : `串：${title}`}>
      <div
        className="reader-scroll has-jump-buttons"
        ref={scrollRef}
        onScroll={onReaderScroll}
        onWheel={(event) => {
          pillGesture()
          if (event.deltaY < 0) setPrependArmed(true)
        }}
        onTouchMove={pillGesture}
        onPointerDown={pillPressed}
        onKeyDown={onReaderKeyDown}
        tabIndex={-1}
        data-pane-focus=""
        inert={viewer !== null}
      >
        <div className="reader-toolbar" ref={toolbarRef}>
          <div className="reader-toolbar-inner">
            {/* One row: reading mode and page on the left, actions on the right. */}
            <div className="thread-bar">
              <div className="thread-bar-lead">
                {backButton}
                {modeSwitch}
                <PagePopover
                  inputId={`page-${entryKey}-${threadId}`}
                  mode={mode}
                  label={`${shownPage}/${totalPages ?? '?'}`}
                  name={`${pageLabel(mode, shownPage)}，${totalPages === null ? '总页数未知' : `共 ${totalPages} 页`}`}
                  placeholder={String(totalPages ?? lastPage?.page ?? 1)}
                  max={totalPages}
                  onJump={(page) => goTo({ kind: 'page', page }, () => thread.jump(page))}
                />
              </div>
              <div className="thread-bar-actions">
                {compose?.entry}
                <SubscribeButton threadId={threadId} label={title ?? `No.${threadId}`} />
                {searchButton}
                {refreshButton}
                <ThreadMoreMenu
                  threadId={threadId}
                  mode={mode}
                  label={title ?? `No.${threadId}`}
                  rules={rules.rulesOf(threadId)}
                  failure={rules.failure}
                  onRetry={rules.reload}
                  onUpdated={rules.updated}
                  onReport={head === null || postActions.isOwn(head) ? undefined : (opener) => postActions.report(head.id, opener)}
                  onToStart={toStart}
                  onToEnd={toEnd}
                />
              </div>
            </div>

            {status}
            {notes}
            {failure}
          </div>
          {/* The page before the range loads quietly: a thin bar under the toolbar, no text. */}
          {task?.type === 'prepend' && <div className="prepend-progress" aria-hidden="true" />}
          {/* After moving up a while, 开头 floats at the top-right, just under the toolbar. */}
          <JumpPillButton
            pill="start"
            shown={pillShown === 'start' && viewer === null}
            onActivate={() => onPill('start')}
            onHold={holdPill}
            onFocusLost={pillFocusBack}
          />
        </div>

        <QuoteEntryContext.Provider value={entryKey}>
        <div className="reader-column" ref={contentRef} aria-busy={task?.type === 'prepend' || undefined}>
          <div ref={topSentinelRef} className="scroll-sentinel" aria-hidden="true" />
          <PrependAnchor first={firstPage?.page} range={state.rangeVersion} snapshot={exactAnchor} keep={keepAnchor} />
          <header className="thread-header">
            <p className="thread-crumb">
              {head !== null && forumName(head.forumId) !== null && <span>{forumName(head.forumId)}</span>}
              <span>No.{threadId}</span>
              {mode === 'po' && <span className="tag tag-po">只看 PO</span>}
            </p>
            {(head === null || !headShown) && <h1 className="visually-hidden">{title ?? `No.${threadId}`}</h1>}
          </header>

          {head !== null && headShown && (
            <PostView
              post={head}
              isHead
              poHash={null}
              images={imageView}
              highlighted={highlighted === head.id}
              actions={{ own: postActions.isOwn(head), reply: (opener) => postActions.reply(head.id, opener), report: (opener) => postActions.report(head.id, opener) }}
            />
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
                {!page.endCandidate && <h2 className="page-divider">{label}</h2>}
                <SourceNotice source={page.source} subject={label} />
                <PartialNotice skipped={page.skippedItems} subject={label} />
                {replies.map((reply) => isPostBlocked(reply, blocks.blocks) && !revealed.has(reply.id) ? (
                  <div className="blocked-post" data-blocked-post-id={reply.id} tabIndex={-1} key={reply.id}>已屏蔽 No.{reply.id} <button type="button" className="btn btn-small btn-quiet" onClick={() => { setRevealed((previous) => new Set(previous).add(reply.id)); requestAnimationFrame(() => contentRef.current?.querySelector<HTMLElement>(`[data-post-id="${CSS.escape(reply.id)}"]`)?.focus({ preventScroll: true })) }}>显示</button></div>
                ) : (
                  <PostView
                    key={reply.id}
                    post={reply}
                    isHead={false}
                    poHash={head?.userHash ?? null}
                    images={imageView}
                    highlighted={highlighted === reply.id}
                    actions={{ own: postActions.isOwn(reply), reply: (opener) => postActions.reply(reply.id, opener), report: (opener) => postActions.report(reply.id, opener) }}
                  />
                ))}
                {page.endCandidate && (
                  <div className="thread-end">
                    <button
                      ref={endRefreshRef}
                      type="button"
                      className="btn btn-quiet"
                      aria-busy={endRefreshing || undefined}
                      aria-disabled={endRefreshing || undefined}
                      onClick={refreshAtEnd}
                    >
                      {endRefreshing ? <Spinner /> : <Icon name="refresh" />}
                      刷新
                    </button>
                  </div>
                )}
              </section>
            )
          })}

          <div className="reader-footer">
            <div ref={sentinelRef} className="scroll-sentinel" aria-hidden="true" />
            {state.pages.length === 0 && task?.type === 'initial' && (
              <div className="reader-placeholder" aria-busy="true">
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
            {error?.task.type === 'append' && (
              <FailureNotice title={failureTitle(error.task, mode)} failure={error.failure} onRetry={thread.retry} compact />
            )}
          </div>
        </div>
        </QuoteEntryContext.Provider>
        {/* After moving down a while, 末尾 floats at the bottom-right of the scroll viewport (a
            zero-height sticky dock after the content, so it measures against the viewport). */}
        <div className="jump-end-dock">
          <JumpPillButton
            pill="end"
            shown={pillShown === 'end' && viewer === null}
            onActivate={() => onPill('end')}
            onHold={holdPill}
            onFocusLost={pillFocusBack}
          />
        </div>
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
