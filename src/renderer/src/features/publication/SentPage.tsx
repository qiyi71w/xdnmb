// The 新串 and 回复 pages of 历史: the successful sends to that kind of target, newest first, in the
// thread lists' row; those without a number included. Failed sends are not listed: their content
// lives in 草稿. Everything shown comes from the attempt's own payload, the local cookies and, for
// its excerpt and thumbnail, the sent post when it is held on this machine; nothing is fetched to
// complete a row, and nothing here sends.

import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import type { Post, PostId, ThreadId } from '../../../../shared/forum'
import { isSent, isUnsettled, type PublicationAttempt } from '../../../../shared/publication'
import { ContextMenu, contextMenuPoint, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { CookieId } from '../../components/CookieId'
import { copyNumberItem, selectionCopyItem, withSelectionCopy } from '../../components/copyMenuItems'
import { TextExcerpt } from '../../components/Content'
import { Icon, Spinner } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { meaningfulName, meaningfulTitle } from '../../lib/format'
import { formatRecordTime } from '../../lib/time'
import { useRovingFocus } from '../../lib/useRovingFocus'
import { historyMemory, rememberHistory } from '../content/retainedList'
import { forumLabel } from '../../../../shared/drafts'
import { useEditorWorkspace } from '../editor/workspace'
import { cookieColorItems } from '../cookieColors/CookieColorPicker'
import { ContentRegistryContext } from '../tabs/contentRegistry'
import { RowExcerpt } from '../feed/ThreadRow'
import { RowThumbnail } from '../image/RowThumbnail'
import { useImageScope } from '../image/useImageLoad'
import { useListImageViewer } from '../image/useListImageViewer'
import { listRowGestures } from '../tabs/ThreadTabMenu'
import type { EntryInit, ThreadOpen } from '../tabs/tabsState'
import { recordCookie, recordPlace, type SentKind } from './sentRecords'
import '../feed/feed.css'
import '../identity/identity.css'
import '../content/content.css'
import './publication.css'

export type SentListState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; attempts: PublicationAttempt[] }

/** How often the list is read again while one of its attempts is still sending or being checked (local query). */
const POLL_MS = 1000

const PAGE_TEXT: Record<SentKind, { title: string; empty: string }> = {
  thread: { title: '新串', empty: '还没有发出的新串' },
  reply: { title: '回复', empty: '还没有发出的回复' }
}

/**
 * Every attempt of this machine, newest first, for the 新串／回复 pages: read once `enabled` (one of
 * them was shown), again on each publication change (a send of this window, or the automatic check
 * naming or settling a stored send) and each `refreshRevision`, and every second while one is still
 * sending or its result is being checked. A failed re-read keeps the list (`readFailed`).
 */
export function useSentAttempts(enabled: boolean, refreshRevision: number) {
  const { store } = useEditorWorkspace()
  const [list, setList] = useState<SentListState>({ status: 'loading' })
  const [readFailed, setReadFailed] = useState(false)
  const alive = useRef(true)
  const loaded = useRef(false)

  const load = useCallback(async (quiet: boolean) => {
    if (!quiet) setList({ status: 'loading' })
    let attempts: PublicationAttempt[] | null = null
    try {
      const result = await window.xidao.publication.listAttempts()
      if (result.ok) attempts = result.attempts
    } catch {
      attempts = null
    }
    if (!alive.current) return
    if (attempts !== null) {
      setList({ status: 'ready', attempts: [...attempts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) })
      setReadFailed(false)
    } else if (quiet) {
      setReadFailed(true)
    } else {
      setList({ status: 'failed' })
    }
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const revision = store.publicationRevision
  useEffect(() => {
    if (!enabled) return
    const quiet = loaded.current
    loaded.current = true
    void load(quiet)
  }, [enabled, load, revision, refreshRevision])

  const watching = list.status === 'ready' && list.attempts.some(isUnsettled)
  useEffect(() => {
    if (!watching) return
    const timer = window.setInterval(() => void load(true), POLL_MS)
    return () => window.clearInterval(timer)
  }, [watching, load])

  return { list, readFailed, load }
}

function plainOpen(threadId: ThreadId, head: Post | null = null, unlocatedPostId: PostId | null = null): ThreadOpen {
  return { threadId, head, target: null, snapshot: null, unlocatedPostId }
}

export function SentPage({
  kind,
  entryKey,
  displayed,
  list,
  readFailed,
  onReload,
  onOpenThread,
  openStep,
  openInTab,
  onViewerOpenChange
}: {
  kind: SentKind
  entryKey: number
  displayed: boolean
  list: SentListState
  readFailed: boolean
  /** `quiet`: keep the list shown while reading it again. */
  onReload: (quiet: boolean) => void
  /** Opens a thread the way list rows do (beside the list when split, else a new step). */
  onOpenThread: (threadId: ThreadId, head: Post | null) => void
  /** Opens a place as a new step of this tab; false when its 历史 entry is no longer current. */
  openStep: (init: EntryInit) => boolean
  /** Opens a place in a new tab; null outside the app shell. */
  openInTab: ((init: EntryInit) => void) | null
  /** Told when the image viewer opens or closes, so the 历史 page header can be made inert. */
  onViewerOpenChange?: (open: boolean) => void
}) {
  const registry = useContext(ContentRegistryContext)
  const { identities } = useEditorWorkspace()
  const view = kind === 'thread' ? 'threads' : 'replies'
  const text = PAGE_TEXT[kind]
  const bodyRef = useRef<HTMLDivElement>(null)
  const { images, open: viewerOpen, viewer } = useListImageViewer(useImageScope(bodyRef), bodyRef)
  useLayoutEffect(() => onViewerOpenChange?.(viewerOpen), [onViewerOpenChange, viewerOpen])
  const attempts = useMemo(() => (list.status === 'ready' ? list.attempts.filter((attempt) => attempt.payload.target.kind === kind) : []), [list, kind])
  const records = useMemo(() => attempts.filter(isSent), [attempts])
  const recordIds = useMemo(() => records.map((attempt) => attempt.id), [records])
  const roving = useRovingFocus(recordIds, null)

  // ---------- Scroll memory (runtime, kept while the entry is in navigation history) ----------
  const ready = list.status === 'ready'
  const scrollTop = useRef(registry === null ? 0 : (historyMemory(registry.listMemory, entryKey)?.sentScroll[view] ?? 0))
  const placed = useRef(false)
  useLayoutEffect(() => {
    const scroller = bodyRef.current
    if (!ready || !displayed || placed.current || scroller === null) return
    placed.current = true
    scroller.scrollTop = scrollTop.current
  }, [ready, displayed])
  const onScroll = () => {
    const scroller = bodyRef.current
    if (scroller === null || scroller.clientHeight === 0 || !placed.current || registry === null) return
    scrollTop.current = scroller.scrollTop
    const sentScroll = historyMemory(registry.listMemory, entryKey)?.sentScroll ?? { threads: 0, replies: 0 }
    rememberHistory(registry.listMemory, entryKey, { sentScroll: { ...sentScroll, [view]: scrollTop.current } })
  }

  // ---------- Opening a record ----------
  /** The reply being located before its thread opens; one at a time. */
  const [locating, setLocating] = useState<string | null>(null)
  const locateSeq = useRef(0)
  const operation = useRef<string | null>(null)
  const cancelLocate = useCallback(() => {
    locateSeq.current += 1
    const operationId = operation.current
    operation.current = null
    if (operationId !== null) window.xidao.reading.cancel({ operationId }).catch(() => undefined)
    setLocating(null)
  }, [])
  // Leaving the page drops a running locate: its result could no longer be followed from here.
  useEffect(() => cancelLocate, [cancelLocate])
  useEffect(() => {
    if (!displayed) cancelLocate()
  }, [displayed, cancelLocate])

  /**
   * A reply with its number is located like a quote jump: found, its thread opens at it; otherwise
   * the thread opens as usual and says the post was not found. A reply without a number opens its
   * thread; a new thread opens itself, or its forum list when it has no number (no thread guessed).
   * `inTab`: the same place in a new tab; otherwise the thread opens like a list row, and a located
   * reply or a forum list as a new step (后退 comes back here).
   */
  const open = (attempt: PublicationAttempt, inTab: boolean) => {
    if (inTab && openInTab === null) return
    const go = (init: EntryInit) => {
      if (inTab) openInTab?.(init)
      else openStep(init)
    }
    cancelLocate()
    const place = recordPlace(attempt)
    if (place.kind === 'forum') {
      go({ kind: 'list', feed: { kind: 'forum', id: place.forumId } })
      return
    }
    if (place.kind === 'thread') {
      if (inTab) go({ kind: 'thread', thread: plainOpen(place.threadId) })
      else onOpenThread(place.threadId, null)
      return
    }
    const seq = (locateSeq.current += 1)
    const operationId = `history-sent-locate-${entryKey}-${seq}`
    operation.current = operationId
    setLocating(attempt.id)
    const settle = (thread: ThreadOpen | null) => {
      if (locateSeq.current !== seq) return
      operation.current = null
      setLocating(null)
      if (thread !== null) go({ kind: 'thread', thread })
    }
    // The record knows its thread: local records still win; otherwise only that thread's first page is checked.
    window.xidao.quotes.locate({ operationId, postId: place.postId, hint: { threadId: place.threadId, page: null } }).then(
      (result) => {
        if (result.status === 'cancelled') {
          settle(null)
        } else if (result.status === 'located') {
          const target = { postId: result.target.postId, page: result.target.page, mode: result.target.mode }
          settle({ threadId: result.threadId, head: result.head, target, snapshot: null, unlocatedPostId: null })
        } else {
          const head = result.status === 'thread-known' && result.threadId === place.threadId ? result.head : null
          settle(plainOpen(place.threadId, head, place.postId))
        }
      },
      () => settle(plainOpen(place.threadId, null, place.postId))
    )
  }

  // ---------- Row context menu: 在新标签页打开, 复制串号, 饼干颜色… ----------
  /**
   * The record's own items: 复制串号 copies the number of the post it created (a reply's own, a new
   * thread's), only when that number is known; nothing is guessed or fetched. 饼干颜色… only on a
   * new thread's record, whose 饼干 ID is its 串主's (a reply's is only the sender's).
   */
  const recordItems = (attempt: PublicationAttempt, point: ContextMenuPoint, row: HTMLElement): ContextMenuItem[] => {
    const cookie = attempt.payload.target.kind === 'thread' ? recordCookie(attempt, identities.overview) : null
    return [
      ...(openInTab === null ? [] : [{ type: 'action', key: 'open-tab', label: '在新标签页打开', onSelect: () => open(attempt, true) } satisfies ContextMenuItem]),
      ...(attempt.postId === null ? [] : [copyNumberItem(attempt.postId)]),
      ...cookieColorItems(cookie?.kind === 'id' ? { userHash: cookie.text } : null, point, row)
    ]
  }
  const [rowMenu, setRowMenu] = useState<{ attemptId: string; point: ContextMenuPoint; row: HTMLElement; selection: ContextMenuItem | null } | null>(null)
  const openRowMenu = (attempt: PublicationAttempt, event: ReactMouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    const row = event.currentTarget.querySelector<HTMLElement>('[data-roving-item]')
    if (row === null) return
    const selection = selectionCopyItem(undefined, event.currentTarget)
    const point = contextMenuPoint(event, row)
    if (selection === null && recordItems(attempt, point, row).length === 0) return
    event.preventDefault()
    // No scrolling into view: a scroll closes the menu that is about to open.
    row.focus({ preventScroll: true })
    setRowMenu({ attemptId: attempt.id, point, row, selection })
  }
  const closeRowMenu = (returnFocus: boolean) => {
    const row = rowMenu?.row
    setRowMenu(null)
    if (returnFocus && row?.isConnected === true) row.focus()
  }
  const menuAttempt = rowMenu === null ? undefined : records.find((attempt) => attempt.id === rowMenu.attemptId)

  return (
    <section className="list-pane retained-page sent-page" aria-label={text.title} aria-busy={list.status === 'loading' || undefined}>
      <div className="list-scroll" ref={bodyRef} onScroll={onScroll} tabIndex={-1} inert={viewerOpen}>
        <div className="list-status">
          {(list.status === 'failed' || readFailed) && (
            <div className="notice notice-error is-compact" role="alert">
              <Icon name="alert" className="notice-icon" />
              <p className="notice-text">
                发送记录读取失败：本地存储不可用
                <KaomojiDecor state="failure" />
              </p>
              <button type="button" className="btn btn-small btn-page" onClick={() => onReload(list.status === 'ready')}>
                重试
              </button>
            </div>
          )}
        </div>

        {list.status === 'ready' && records.length === 0 && (
          <div className="list-empty" role="status">
            <p className="list-empty-title">
              <KaomojiDecor state="sentEmpty" above />
              {text.empty}
            </p>
          </div>
        )}

        {records.length > 0 && (
          <ul className="thread-list" aria-label={`${text.title}发送记录`} onKeyDown={roving.onKeyDown}>
            {records.map((attempt) => {
              const itemProps = roving.itemProps(attempt.id)
              // The held sent post's image; a send whose image is no longer held shows no thumbnail.
              const thumbPost = attempt.preview?.image != null ? attempt.preview.id : null
              return (
                <li
                  key={attempt.id}
                  className={rowMenu?.attemptId === attempt.id ? 'history-row is-menu-open' : 'history-row'}
                  {...listRowGestures((event) => openRowMenu(attempt, event), openInTab === null ? null : () => open(attempt, true))}
                >
                  {/* The row button and the thumbnail's 查看原图 button side by side, as in ThreadRow. */}
                  <div className={thumbPost !== null ? 'thread-row has-thumb' : 'thread-row'}>
                    <button
                      type="button"
                      className="row-open"
                      aria-busy={locating === attempt.id || undefined}
                      onClick={() => open(attempt, false)}
                      {...itemProps}
                    >
                      <RecordSummary
                        attempt={attempt}
                        hasThumb={thumbPost !== null}
                        metaEnd={
                          locating === attempt.id && (
                            <span className="sent-locating">
                              <Spinner />
                              正在定位…
                            </span>
                          )
                        }
                      />
                    </button>
                    {thumbPost !== null && <RowThumbnail postId={thumbPost} images={images} tabIndex={itemProps.tabIndex} />}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
        <div className="list-footer" />
      </div>
      {viewer}
      {rowMenu !== null && menuAttempt !== undefined && (
        <ContextMenu
          key={`menu:${rowMenu.attemptId}`}
          point={rowMenu.point}
          label={`发送记录操作：${recordLabel(menuAttempt)}`}
          items={withSelectionCopy(rowMenu.selection, recordItems(menuAttempt, rowMenu.point, rowMenu.row))}
          onClose={closeRowMenu}
        />
      )}
    </section>
  )
}

/** A record's title, else its target (as the meta line names it). */
function recordLabel(attempt: PublicationAttempt): string {
  const target = attempt.payload.target
  return meaningfulTitle(attempt.payload.fields.title) ?? (target.kind === 'reply' ? `回复 No.${target.threadId}` : `新串 ${formatRecordTime(attempt.createdAt)}`)
}

/**
 * The thread lists' row text for an attempt: its 饼干 ID (from the local cookie it was sent with)
 * and time, bold title and name when given, the excerpt, then the target (forum or 回复 No.x) and
 * whether it had an image. The excerpt is the sent post as held on this machine (`preview`, the same
 * post the attempt created) when there is one, else the sent text with its line breaks, never as
 * markup. Everything else comes from the attempt itself, never from the thread's main post.
 */
function RecordSummary({ attempt, metaEnd, hasThumb }: { attempt: PublicationAttempt; metaEnd?: ReactNode; hasThumb: boolean }) {
  const { identities, forumName } = useEditorWorkspace()
  const { payload, preview } = attempt
  const cookie = recordCookie(attempt, identities.overview)
  const title = meaningfulTitle(payload.fields.title)
  const name = meaningfulName(payload.fields.name)
  const content = payload.fields.content.trim()
  const target = payload.target
  return (
    <span className="row-text">
      <span className="row-byline">
        <span className="row-author">
          {cookie?.kind === 'id' && <CookieId cookieId={cookie.text} />}
          {cookie?.kind === 'fallback' && <span className="row-cookie-fallback">{cookie.text}</span>}
        </span>
        <span className="row-time">{formatRecordTime(attempt.createdAt)}</span>
      </span>
      {title !== null && <span className="row-title">{title}</span>}
      {name !== null && <span className="row-name">{name}</span>}
      {/* The sent post as held here (same content, its formatting); else the sent text, literally. */}
      {preview !== undefined && preview.content.length > 0 ? (
        <RowExcerpt post={preview} />
      ) : (
        content !== '' && <TextExcerpt text={content} className="row-excerpt" />
      )}
      <span className="row-meta">
        <span className="row-forum">{target.kind === 'thread' ? forumLabel(target.forumId, forumName) : `回复 No.${target.threadId}`}</span>
        {hasThumb ? (
          // Arrow keys move between row buttons only: this tells them the record has an image.
          <span className="visually-hidden">附图</span>
        ) : (
          payload.attachmentId !== null && (
            <span className="row-image">
              <Icon name="image" size={13} />
              附图
            </span>
          )
        )}
        {metaEnd}
      </span>
    </span>
  )
}
