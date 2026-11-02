import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import type { QuoteLocation, ReadError } from '../../../../shared/api'
import type { BoardDirectory, ForumId, Post, PostId, ThreadId, TimelineId } from '../../../../shared/forum'
import { MAX_SEARCH_QUERY_LENGTH, type ForumLinkTarget, type SearchHit } from '../../../../shared/online-search'
import { Icon } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { Loading } from '../../components/Notices'
import { describeReadError } from '../../lib/format'
import { formatRecordTime } from '../../lib/time'
import { useRovingFocus } from '../../lib/useRovingFocus'
import { useRegisterContent } from '../tabs/contentRegistry'
import { useAppCovered } from '../../lib/appCovered'
import { readResumePage } from '../thread/readingStart'
import type { EntryInit } from '../tabs/tabsState'
import { useThreadTabMenu, type ThreadTabMenu } from '../tabs/ThreadTabMenu'
import type { OnlineSearchNotice, OnlineSearchResults, OnlineSearchSession } from './onlineSearchSession'
import { CHANNEL_TEXT, channelHost, searchErrorLines } from './onlineSearchText'
import './online-search.css'

const MAX_SOURCE_LENGTH = 80

type ThreadLink = Extract<ForumLinkTarget, { kind: 'thread' }>
type Located = Extract<QuoteLocation, { status: 'located' }>

/** A reply (or main post) link whose thread is readable but did not show the post on the hinted page. */
interface KnownThread {
  threadId: ThreadId
  head: Post
  replyId: PostId
  /** 回复 No.y, or 主帖 No.x when the link targets the thread's main post. */
  subject: string
}

/** Inline state of the one result row that is being opened or explains why it cannot be. */
type RowStatus =
  | { kind: 'locating'; seq: number; operationId: string; intent: 'open' | 'resolve'; subject: string }
  | { kind: 'located'; location: Located }
  | { kind: 'thread-known'; known: KnownThread }
  /** 打开原串: reading the page the thread resumes at; history changes only once it arrived. */
  | { kind: 'opening'; seq: number; operationId: string; known: KnownThread }
  /** 打开原串 failed: `error` null = the app's own request failed. */
  | { kind: 'open-failed'; known: KnownThread; error: ReadError | null }
  | { kind: 'unknown-thread'; subject: string }
  | { kind: 'failed'; subject: string; error: ReadError }
  | { kind: 'internal'; subject: string }
  | { kind: 'board-missing'; boardName: string; directoryLoaded: boolean }
  | { kind: 'timeline-missing'; timelineId: TimelineId; directoryLoaded: boolean }
  | { kind: 'browser-failed' }

interface RowState {
  page: number
  index: number
  status: RowStatus
}

/** 主帖 No.x when the link's post is the thread itself, else 回复 No.y. */
function postSubject(replyId: PostId, threadId: ThreadId): string {
  return replyId === threadId ? `主帖 No.${replyId}` : `回复 No.${replyId}`
}

/** 串 No.x／主帖 No.x／回复 No.y（串 No.x）／版面 名称／时间线 名称（或编号）／外部链接 */
function targetLabel(target: ForumLinkTarget | null, directory: BoardDirectory | null): string {
  if (target === null) return '外部链接'
  switch (target.kind) {
    case 'board':
      return `版面 ${target.boardName}`
    case 'timeline':
      return `时间线 ${directory?.timelines.find((item) => item.id === target.timelineId)?.displayName ?? target.timelineId}`
    case 'thread':
      if (target.replyId === null) return `串 No.${target.threadId}`
      return target.replyId === target.threadId ? `主帖 No.${target.threadId}` : `回复 No.${target.replyId}（串 No.${target.threadId}）`
  }
}

/**
 * The thread a hit opens, when known without asking: a thread / PO / main-post link, or a reply
 * link once its row located it. Otherwise null (no 在新标签页打开).
 */
function knownThreadOf(target: ForumLinkTarget | null, status: RowStatus | null): { threadId: ThreadId; head: Post | null } | null {
  if (target === null || target.kind !== 'thread') return null
  if (target.replyId === null || target.replyId === target.threadId) return { threadId: target.threadId, head: null }
  if (status === null) return null
  switch (status.kind) {
    case 'located':
      return { threadId: status.location.threadId, head: status.location.head }
    case 'thread-known':
    case 'opening':
    case 'open-failed':
      return { threadId: status.known.threadId, head: status.known.head }
    default:
      return null
  }
}

/** Host and path of a result URL, shortened; the raw text when it does not parse. */
function sourceText(url: string): string {
  let text = url
  if (URL.canParse(url)) {
    const parsed = new URL(url)
    text = parsed.pathname === '/' ? parsed.host : `${parsed.host}${parsed.pathname}`
  }
  return text.length > MAX_SOURCE_LENGTH ? `${text.slice(0, MAX_SOURCE_LENGTH - 1)}…` : text
}

function findForum(directory: BoardDirectory, boardName: string): ForumId | null {
  for (const group of directory.groups) {
    const forum = group.forums.find((item) => item.name === boardName || item.displayName === boardName)
    if (forum !== undefined) return forum.id
  }
  return null
}

const CHAIN_END_TEXT = {
  end: '没有更多结果',
  expired: '下一页已过期',
  lost: '下一页已失效'
} as const

function Status({ tone, children }: { tone: 'info' | 'error'; children: ReactNode }) {
  return (
    <div className={`online-search-status-box is-${tone}`}>
      <Icon name={tone === 'error' ? 'alert' : 'info'} size={14} className="online-search-status-icon" />
      <div className="online-search-status-text">{children}</div>
    </div>
  )
}

/**
 * One channel of the 联网 side of the 搜索 page: a search box that requests only on submit, the
 * third-party notice for that channel, plain-text results with paging over the session's chain,
 * and result opening through the existing reader navigation. Its query, pages and view live in the
 * channel's OnlineSearchSession, so leaving, switching channel and coming back restore them without
 * any request. The page mounts one pane per shown channel: switching drops a running locate of the
 * channel left behind, so nothing opens from out of sight.
 */
export function OnlineSearchPane({
  entryKey,
  session,
  displayed,
  takeFocus,
  directory,
  onOpen
}: {
  entryKey: number
  session: OnlineSearchSession
  /** The page is on screen (its tab is active, and in a 搜索 page the 联网 side is shown). */
  displayed: boolean
  /** Mounting moves focus into the pane (not after a channel switch: focus stays on the switch). */
  takeFocus: boolean
  directory: BoardDirectory | null
  /** Opens a result in this entry's tab as a new `online-search` step; false when the entry is no longer current. */
  onOpen: (entryKey: number, init: EntryInit) => boolean
}) {
  const state = useSyncExternalStore(session.subscribe, session.getState)
  const { results, pending, notice } = state
  const service = CHANNEL_TEXT[session.channel]

  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const displayedRef = useRef(displayed)
  const [row, setRow] = useState<RowState | null>(null)
  const rowRef = useRef<RowState | null>(null)
  const locateSeq = useRef(0)
  const [siteFailed, setSiteFailed] = useState(false)

  useLayoutEffect(() => {
    displayedRef.current = displayed
    rowRef.current = row
  })

  useRegisterContent('onlineSearchPanes', entryKey, { focusInput: () => inputRef.current?.focus() })

  const hitButton = (page: number, index: number): HTMLElement | null =>
    listRef.current?.querySelector<HTMLElement>(`[data-hit-key="${page}-${index}"]`) ?? null

  // Entering the page focuses the search box; coming back restores scroll and the last result.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scroller !== null) scroller.scrollTop = session.view.scrollTop
    if (!displayedRef.current || !takeFocus) return
    const focus = session.view.focus
    const shown = session.getState().results
    const target = focus !== null && shown !== null && focus.page === shown.current ? hitButton(focus.page, focus.index) : null
    if (target !== null) target.focus({ preventScroll: true })
    else inputRef.current?.focus()
    // Mount only: later focus belongs to the user.
  }, [])

  // A hidden scroller (inactive tab) may drop its position: put it back when shown again.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scroller === null) return
    let hidden = scroller.clientHeight === 0
    const observer = new ResizeObserver(() => {
      const shown = scroller.clientHeight > 0
      if (shown && hidden && scroller.scrollTop !== session.view.scrollTop) scroller.scrollTop = session.view.scrollTop
      hidden = !shown
    })
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [session])

  const onScroll = () => {
    const scroller = scrollRef.current
    if (scroller !== null && scroller.clientHeight > 0) session.view.scrollTop = scroller.scrollTop
  }

  // ---------- Opening results ----------
  /**
   * Cancels the row's running locate or 打开原串 read; returns whether there was one. Cancelling
   * 打开原串 goes back to what was known before it, so it can be chosen again (as on quote cards).
   */
  const cancelLocate = (returnFocus: boolean): boolean => {
    const current = rowRef.current
    if (current === null || (current.status.kind !== 'locating' && current.status.kind !== 'opening')) return false
    locateSeq.current += 1
    window.xidao.reading.cancel({ operationId: current.status.operationId }).catch(() => undefined)
    setRow(current.status.kind === 'opening' ? { ...current, status: { kind: 'thread-known', known: current.status.known } } : null)
    if (returnFocus) hitButton(current.page, current.index)?.focus()
    return true
  }

  // Leaving the page drops a running locate or read: its result could no longer be shown or followed.
  useEffect(
    () => () => {
      const status = rowRef.current?.status
      locateSeq.current += 1
      if (status?.kind === 'locating' || status?.kind === 'opening') window.xidao.reading.cancel({ operationId: status.operationId }).catch(() => undefined)
    },
    []
  )

  const open = (init: EntryInit, page: number, index: number): boolean => {
    session.view.focus = { page, index }
    return onOpen(entryKey, init)
  }

  const openLocated = (location: Located, page: number, index: number): boolean => {
    const target = { postId: location.target.postId, page: location.target.page, mode: location.target.mode }
    return open({ kind: 'thread', thread: { threadId: location.threadId, head: location.head, target, snapshot: null, unlocatedPostId: null } }, page, index)
  }

  const openInBrowser = (url: string, page: number, index: number): void => {
    window.xidao.links.openExternal({ url }).then(
      (result) => {
        if (!result.opened) setRow({ page, index, status: { kind: 'browser-failed' } })
      },
      () => setRow({ page, index, status: { kind: 'browser-failed' } })
    )
  }

  /** Resolves a reply link; `open` follows a located result at once, `resolve` (重试) only reports it. */
  const locate = (target: ThreadLink & { replyId: PostId }, page: number, index: number, intent: 'open' | 'resolve'): void => {
    cancelLocate(false)
    const seq = (locateSeq.current += 1)
    const operationId = `online-search-locate-${entryKey}-${seq}`
    const replyId = target.replyId
    const subject = postSubject(replyId, target.threadId)
    setRow({ page, index, status: { kind: 'locating', seq, operationId, intent, subject } })
    const settle = (status: RowStatus | null) => {
      if (locateSeq.current === seq) setRow(status === null ? null : { page, index, status })
    }
    window.xidao.quotes.locate({ operationId, postId: replyId, hint: { threadId: target.threadId, page: target.page } }).then(
      (result) => {
        if (locateSeq.current !== seq) return
        switch (result.status) {
          case 'cancelled':
            settle(null)
            return
          case 'located':
            // Followed only for the first attempt and while the page is on screen.
            if (intent === 'open' && displayedRef.current && openLocated(result, page, index)) return
            settle({ kind: 'located', location: result })
            return
          case 'thread-known':
            settle({ kind: 'thread-known', known: { threadId: result.threadId, head: result.head, replyId, subject } })
            return
          case 'unknown-thread':
            settle({ kind: 'unknown-thread', subject })
            return
          case 'failed':
            settle({ kind: 'failed', subject, error: result.error })
            return
        }
      },
      () => settle({ kind: 'internal', subject })
    )
  }

  /**
   * 打开原串 after `thread-known`, with the quote rule: the page the thread resumes at is
   * read first; only once it arrived (and the page is still on screen) a step is committed, opening
   * the thread normally and still saying the post was not located. A failure or cancellation leaves
   * the search page and history as they were and explains it in the row.
   */
  const openThread = (known: KnownThread, page: number, index: number): void => {
    cancelLocate(false)
    const seq = (locateSeq.current += 1)
    const operationId = `online-search-locate-${entryKey}-${seq}`
    const isCurrent = () => locateSeq.current === seq
    const settle = (status: RowStatus) => {
      if (isCurrent()) setRow({ page, index, status })
    }
    setRow({ page, index, status: { kind: 'opening', seq, operationId, known } })
    readResumePage(known.threadId, operationId, isCurrent).then(
      (outcome) => {
        if (outcome === null || !isCurrent()) return
        if (outcome.status === 'cancelled') {
          settle({ kind: 'thread-known', known })
          return
        }
        if (outcome.status === 'failed') {
          settle({ kind: 'open-failed', known, error: outcome.error })
          return
        }
        const thread = { threadId: known.threadId, head: known.head, target: null, snapshot: null, unlocatedPostId: known.replyId }
        if (displayedRef.current && open({ kind: 'thread', thread }, page, index)) {
          locateSeq.current += 1
          return
        }
        settle({ kind: 'thread-known', known })
      },
      () => settle({ kind: 'open-failed', known, error: null })
    )
  }

  const activate = (hit: SearchHit, page: number, index: number): void => {
    session.view.focus = { page, index }
    const target = hit.target
    if (target === null) {
      if (hit.url !== null) openInBrowser(hit.url, page, index)
      return
    }
    if (target.kind === 'board') {
      const forumId = directory === null ? null : findForum(directory, target.boardName)
      if (forumId === null) {
        cancelLocate(false)
        setRow({ page, index, status: { kind: 'board-missing', boardName: target.boardName, directoryLoaded: directory !== null } })
        return
      }
      open({ kind: 'list', feed: { kind: 'forum', id: forumId } }, page, index)
      return
    }
    if (target.kind === 'timeline') {
      const timeline = directory?.timelines.find((item) => item.id === target.timelineId)
      if (timeline === undefined) {
        cancelLocate(false)
        setRow({ page, index, status: { kind: 'timeline-missing', timelineId: target.timelineId, directoryLoaded: directory !== null } })
        return
      }
      open({ kind: 'list', feed: { kind: 'timeline', id: timeline.id } }, page, index)
      return
    }
    if (target.replyId === null) {
      // PO links and page clues open the thread normally: no reading mode or position is changed.
      open({ kind: 'thread', thread: { threadId: target.threadId, head: null, target: null, snapshot: null, unlocatedPostId: null } }, page, index)
      return
    }
    const current = rowRef.current
    if (current !== null && current.page === page && current.index === index && current.status.kind === 'located') {
      openLocated(current.status.location, page, index)
      return
    }
    locate({ ...target, replyId: target.replyId }, page, index, 'open')
  }

  // ---------- Keyboard: Esc cancels the running locate, else the running search request ----------
  // Not while a modal dialog covers the app: Esc then belongs to that dialog.
  const covered = useAppCovered()
  const locating = row?.status.kind === 'locating' || row?.status.kind === 'opening'
  const cancellable = displayed && !covered && (locating || pending !== null)
  const escape = useRef<() => boolean>(() => false)
  useLayoutEffect(() => {
    escape.current = () => {
      if (cancelLocate(true)) return true
      return session.cancel()
    }
  })
  useEffect(() => {
    if (!cancellable) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
      if (escape.current()) event.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [cancellable])

  // ---------- Page changes ----------
  const shownPage = results === null ? null : (results.pages[results.current - 1] ?? null)
  const mountedPage = useRef(shownPage)
  useLayoutEffect(() => {
    if (mountedPage.current === shownPage) return
    mountedPage.current = shownPage
    cancelLocate(false)
    setRow(null)
    const scroller = scrollRef.current
    if (scroller !== null) scroller.scrollTop = session.view.scrollTop
    if (!displayedRef.current) return
    const focused = document.activeElement
    if (focused === null || focused === document.body || !focused.isConnected) headingRef.current?.focus({ preventScroll: true })
    // Runs only when the shown page changes.
  }, [shownPage])

  // ---------- Search box ----------
  const query = state.draft.trim()
  /** This exact query's run is still awaited: searching it again would only repeat the request. */
  const samePending = state.pending?.kind === 'run' && state.pending.query === query
  const canSubmit = query !== '' && query.length <= MAX_SEARCH_QUERY_LENGTH && !samePending
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (canSubmit) session.run(query)
  }

  const rerun = (text: string) => {
    inputRef.current?.focus()
    session.run(text)
  }

  const openSite = () => {
    setSiteFailed(false)
    window.xidao.onlineSearch.openSite({ channel: session.channel }).then(
      (result) => setSiteFailed(!result.opened),
      () => setSiteFailed(true)
    )
  }

  const runQuery = notice !== null && notice.kind !== 'closed' && notice.request.kind === 'run' ? notice.request.query : null
  const noticePage = notice !== null && notice.kind !== 'closed' && notice.request.kind === 'page' ? notice.request.page : null

  const hits = shownPage?.hits ?? []
  const ids = useMemo(() => (shownPage === null ? [] : shownPage.hits.map((_, index) => `${shownPage.pageNumber}-${index}`)), [shownPage])
  const focusedKey = session.view.focus === null ? null : `${session.view.focus.page}-${session.view.focus.index}`
  const roving = useRovingFocus(ids, focusedKey)
  const inTab = useThreadTabMenu()

  return (
    <section className="online-search-page" aria-label={`联网搜索：${service}`}>
      <div className="online-search-scroll" ref={scrollRef} onScroll={onScroll}>
        <header className="online-search-header">
          <form className="online-search-form" role="search" onSubmit={submit}>
            <label className="visually-hidden" htmlFor={`online-search-input-${entryKey}`}>
              搜索词
            </label>
            <input
              ref={inputRef}
              id={`online-search-input-${entryKey}`}
              className="online-search-input"
              type="text"
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
              maxLength={MAX_SEARCH_QUERY_LENGTH}
              placeholder="搜索词"
              aria-describedby={`online-search-about-${entryKey}`}
              value={state.draft}
              onChange={(event) => session.setDraft(event.target.value)}
            />
            {/* Unavailable stays focusable; `submit` refuses it from any input, and the session itself
                drops a repeat of the query it is still running (before this re-renders). */}
            <button type="submit" className="btn btn-page online-search-submit" aria-disabled={!canSubmit || undefined} aria-busy={samePending || undefined}>
              <Icon name="search" />
              搜索
            </button>
          </form>
          {state.draft.length >= MAX_SEARCH_QUERY_LENGTH - 20 && (
            <p className="online-search-count">
              {state.draft.length}／{MAX_SEARCH_QUERY_LENGTH} 字
            </p>
          )}
        </header>

        <div className="online-search-about" id={`online-search-about-${entryKey}`}>
          <p className="online-search-about-site">
            <span>
              搜索词会发给第三方服务 {service}（{channelHost(session.channel)}），收录可能不全或过时
            </span>
            <button type="button" className="btn btn-small btn-quiet" onClick={openSite}>
              <Icon name="external" size={14} />
              打开 {service} 网站
            </button>
          </p>
          {siteFailed && (
            <p className="notice-inline is-warning" role="status">
              <Icon name="alert" size={14} />
              无法在系统浏览器中打开 {service} 网站
              <KaomojiDecor state="failure" />
            </p>
          )}
        </div>

        <div className="online-search-status" role="status">
          {pending?.kind === 'run' && (
            <div className="online-search-loading">
              <Loading>正在搜索「{pending.query}」…（Esc 取消）</Loading>
              <button
                type="button"
                className="btn btn-small btn-page"
                onClick={() => {
                  inputRef.current?.focus()
                  session.cancel()
                }}
              >
                取消
              </button>
            </div>
          )}
          {notice !== null && notice.kind !== 'closed' && runQuery !== null && (
            <RequestNotice notice={notice} service={service} onRetry={() => rerun(runQuery)} />
          )}
          {results !== null && !results.live && pending?.kind !== 'run' && (
            <div className="online-search-chain-end">
              <p className="notice-inline">
                <Icon name="info" size={14} />
                「{results.query}」不能再取新页
              </p>
              <button type="button" className="btn btn-small btn-page" onClick={() => rerun(results.query)}>
                <Icon name="refresh" size={14} />
                重新搜索
              </button>
            </div>
          )}
        </div>

        {results !== null && shownPage !== null && (
          <>
            <h3 className="online-search-results-head" ref={headingRef} tabIndex={-1}>
              <span className="online-search-results-query">「{results.query}」</span>
              <span className="online-search-results-meta">
                {service} · 第 {shownPage.pageNumber} 页 · {hits.length} 条 · {formatRecordTime(shownPage.fetchedAt)} 取得
              </span>
            </h3>

            {hits.length === 0 && (
              <div className="list-empty" role="status">
                <p className="list-empty-title">
                  <KaomojiDecor state="searchEmpty" above />
                  {shownPage.pageNumber === 1 ? '没有找到结果' : '这一页没有结果'}
                </p>
              </div>
            )}

            {hits.length > 0 && (
              <ul className="online-search-hits" aria-label="搜索结果" ref={listRef} onKeyDown={roving.onKeyDown}>
                {hits.map((hit, index) => {
                  const key = `${shownPage.pageNumber}-${index}`
                  const itemProps = roving.itemProps(key)
                  const url = hit.url
                  return (
                    <li key={key}>
                      <HitRow
                        hit={hit}
                        label={targetLabel(hit.target, directory)}
                        hitKey={key}
                        status={row !== null && row.page === shownPage.pageNumber && row.index === index ? row.status : null}
                        itemProps={{
                          ...itemProps,
                          onFocus: () => {
                            itemProps.onFocus()
                            session.view.focus = { page: shownPage.pageNumber, index }
                          }
                        }}
                        inTab={inTab}
                        onActivate={() => activate(hit, shownPage.pageNumber, index)}
                        onBrowser={url === null ? null : () => openInBrowser(url, shownPage.pageNumber, index)}
                        onCancel={() => cancelLocate(true)}
                        onRetry={() => {
                          if (hit.target?.kind === 'thread' && hit.target.replyId !== null) {
                            locate({ ...hit.target, replyId: hit.target.replyId }, shownPage.pageNumber, index, 'resolve')
                          }
                        }}
                        onOpenLocated={(location) => openLocated(location, shownPage.pageNumber, index)}
                        onOpenThread={(known) => openThread(known, shownPage.pageNumber, index)}
                      />
                    </li>
                  )
                })}
              </ul>
            )}
            {inTab.menu}

            <Pager results={results} session={session} pendingPage={pending?.kind === 'page' ? pending.page : null} />
            {notice !== null && notice.kind !== 'closed' && noticePage !== null && (
              // XDS pages are numbered, so a failed or cancelled one can be asked for again; an
              // nmb-search page's one-time token is gone.
              <RequestNotice
                notice={notice}
                service={service}
                onRetry={session.channel === 'xds' && session.canShow(noticePage) ? () => session.goToPage(noticePage) : null}
              />
            )}
            {results.live && results.current === results.pages.length && results.next !== 'available' && pending === null && (
              <div className="online-search-chain-end">
                <p className="list-end">{CHAIN_END_TEXT[results.next]}</p>
                {results.next !== 'end' && (
                  <button type="button" className="btn btn-small btn-page" onClick={() => rerun(results.query)}>
                    <Icon name="refresh" size={14} />
                    重新搜索「{results.query}」
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  )
}

/**
 * Failure or cancellation of a search (`onRetry` runs the same query again) or of a page request
 * (`onRetry` asks for that XDS page again; null for nmb-search, whose token that page needed is gone).
 */
function RequestNotice({
  notice,
  service,
  onRetry
}: {
  notice: Exclude<OnlineSearchNotice, { kind: 'closed' }>
  service: string
  onRetry: (() => void) | null
}) {
  const request = notice.request
  const subject = request.kind === 'run' ? `搜索「${request.query}」` : `读取第 ${request.page} 页`
  if (notice.kind === 'cancelled') {
    return (
      <div className="online-search-chain-end online-search-request-notice">
        <p className="notice-inline" role="status">
          <Icon name="info" size={14} />
          已取消{subject}
        </p>
        {request.kind === 'page' && onRetry !== null && (
          <button type="button" className="btn btn-small btn-page" onClick={onRetry}>
            <Icon name="refresh" size={14} />
            重新读取第 {request.page} 页
          </button>
        )}
      </div>
    )
  }
  const { reason, details } = notice.kind === 'failed' ? searchErrorLines(notice.error, service) : { reason: '应用内部请求失败', details: [] }
  return (
    <div className="notice notice-error online-search-request-notice" role="alert">
      <Icon name="alert" className="notice-icon" />
      <div className="notice-text">
        <p className="notice-title">
          {subject}失败：{reason}
          <KaomojiDecor state="failure" />
        </p>
        {details.map((line) => (
          <p key={line} className="notice-detail">
            {line}
          </p>
        ))}
      </div>
      {onRetry !== null && (
        <button type="button" className="btn btn-small btn-page" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  )
}

function Pager({ results, session, pendingPage }: { results: OnlineSearchResults; session: OnlineSearchSession; pendingPage: number | null }) {
  const previous = results.current - 1
  const next = results.current + 1
  const canPrevious = session.canShow(previous)
  const canNext = session.canShow(next)
  const fetchingNext = pendingPage !== null && pendingPage > results.pages.length
  return (
    <nav className="online-search-pager" aria-label="搜索结果页">
      <button type="button" className="btn btn-small btn-page" aria-disabled={!canPrevious} onClick={() => canPrevious && session.goToPage(previous)}>
        <Icon name="arrowLeft" size={14} />
        上一页
      </button>
      <span className="online-search-pager-current" aria-current="page">
        第 {results.current} 页
      </span>
      <button type="button" className="btn btn-small btn-page" aria-disabled={!canNext} onClick={() => canNext && session.goToPage(next)}>
        下一页
        <Icon name="arrowRight" size={14} />
      </button>
      {fetchingNext && (
        <div className="online-search-loading">
          <Loading>正在读取第 {pendingPage} 页…（Esc 取消）</Loading>
          <button type="button" className="btn btn-small btn-page" onClick={() => session.cancel()}>
            取消
          </button>
        </div>
      )}
    </nav>
  )
}

function HitRow({
  hit,
  label,
  hitKey,
  status,
  itemProps,
  inTab,
  onActivate,
  onBrowser,
  onCancel,
  onRetry,
  onOpenLocated,
  onOpenThread
}: {
  hit: SearchHit
  /** What the link was recognized as (串、回复、版面、时间线), or 外部链接. */
  label: string
  hitKey: string
  status: RowStatus | null
  itemProps: { 'data-roving-item': string; tabIndex: number; onFocus: () => void }
  inTab: ThreadTabMenu
  onActivate: () => void
  onBrowser: (() => void) | null
  onCancel: () => void
  onRetry: () => void
  onOpenLocated: (location: Located) => void
  onOpenThread: (known: KnownThread) => void
}) {
  const target = hit.target
  const unusable = target === null && hit.url === null
  const tabThread = knownThreadOf(target, status)
  // A reply link names its thread before being located: 复制串号 copies that number; opening waits for the location.
  const linkThreadId = target?.kind === 'thread' ? target.threadId : null
  // A recognized link opens in Xidao; its web page stays one icon away at the row's end. An
  // unrecognized one opens in the browser from the card itself and gets no extra button.
  const browser = target !== null ? onBrowser : null
  // The row's own controls are reachable with Tab from the row that holds the list's tab stop.
  const tabIndex = itemProps.tabIndex
  const statusId = `online-search-hit-status-${hitKey}`
  return (
    <article className={browser !== null ? 'online-search-hit has-browser' : 'online-search-hit'}>
      <button
        type="button"
        className="online-search-hit-main"
        data-hit-key={hitKey}
        aria-disabled={unusable}
        aria-describedby={status === null ? undefined : statusId}
        onClick={(event) => {
          if (unusable || inTab.openFromClick(event, tabThread?.threadId ?? null, tabThread?.head)) return
          onActivate()
        }}
        {...inTab.rowProps(tabThread?.threadId ?? linkThreadId, tabThread?.head, tabThread !== null)}
        {...itemProps}
      >
        <span className="online-search-hit-top">
          <span className={target === null ? 'tag online-search-hit-kind is-external' : 'tag online-search-hit-kind'}>
            {target === null && <Icon name="external" size={12} />}
            {label}
          </span>
          {hit.date !== null && <span className="online-search-hit-date">{formatRecordTime(hit.date)}</span>}
        </span>
        <span className={hit.title === null ? 'online-search-hit-title is-missing' : 'online-search-hit-title'}>{hit.title ?? '（服务未提供标题）'}</span>
        {hit.description !== null && <span className="online-search-hit-snippet">{hit.description}</span>}
        <span className="online-search-hit-source">{hit.url === null ? '链接不可用' : sourceText(hit.url)}</span>
      </button>
      {browser !== null && (
        <button
          type="button"
          className="icon-btn online-search-hit-browser"
          tabIndex={tabIndex}
          aria-label="在浏览器中打开"
          title="在浏览器中打开"
          onClick={browser}
        >
          <Icon name="external" size={16} />
        </button>
      )}

      {status !== null && (
        <div className="online-search-hit-extra" id={statusId}>
          <RowStatusView status={status} tabIndex={tabIndex} onCancel={onCancel} onRetry={onRetry} onOpenLocated={onOpenLocated} onOpenThread={onOpenThread} />
        </div>
      )}
    </article>
  )
}

function RowStatusView({
  status,
  tabIndex,
  onCancel,
  onRetry,
  onOpenLocated,
  onOpenThread
}: {
  status: RowStatus
  tabIndex: number
  onCancel: () => void
  onRetry: () => void
  onOpenLocated: (location: Located) => void
  onOpenThread: (known: KnownThread) => void
}) {
  const retry = (
    <button type="button" className="btn btn-small btn-page" tabIndex={tabIndex} onClick={onRetry}>
      <Icon name="refresh" size={14} />
      重试
    </button>
  )
  let body: ReactNode
  let actions: ReactNode = null
  switch (status.kind) {
    case 'locating':
      body = <Loading live={false}>{status.intent === 'open' ? `正在定位${status.subject}…（Esc 取消）` : `正在重新定位${status.subject}…（Esc 取消）`}</Loading>
      actions = (
        <button type="button" className="btn btn-small btn-page" tabIndex={tabIndex} onClick={onCancel}>
          取消
        </button>
      )
      break
    case 'located':
      body = (
        <Status tone="info">
          <p className="online-search-status-title">
            已定位：串 No.{status.location.threadId}，{status.location.target.mode === 'po' ? '只看 PO ' : ''}第 {status.location.target.page} 页
          </p>
          {status.location.source === 'cached' && status.location.networkError !== null && (
            <p className="online-search-status-detail">依据本地缓存的页面（{describeReadError(status.location.networkError)}）</p>
          )}
        </Status>
      )
      actions = (
        <button type="button" className="btn btn-small btn-page" tabIndex={tabIndex} onClick={() => onOpenLocated(status.location)}>
          <Icon name="arrowRight" size={14} />
          打开
        </button>
      )
      break
    case 'thread-known':
      body = (
        <Status tone="info">
          <p className="online-search-status-title">未在该页找到{status.known.subject}</p>
        </Status>
      )
      actions = (
        <button type="button" className="btn btn-small btn-page" tabIndex={tabIndex} onClick={() => onOpenThread(status.known)}>
          打开原串
        </button>
      )
      break
    case 'opening':
      body = <Loading live={false}>正在打开原串 No.{status.known.threadId}…（Esc 取消）</Loading>
      actions = (
        <button type="button" className="btn btn-small btn-page" tabIndex={tabIndex} onClick={onCancel}>
          取消
        </button>
      )
      break
    case 'open-failed':
      body = (
        <Status tone="error">
          <p className="online-search-status-title">{status.error === null ? '打开原串失败' : '原串读取失败'}</p>
          <p className="online-search-status-detail">
            原因：{status.error === null ? '应用内部请求失败' : describeReadError(status.error)}
            {status.error?.serverMessage !== undefined && `；论坛提示：${status.error.serverMessage}`}
          </p>
        </Status>
      )
      actions = retry
      break
    case 'unknown-thread':
      body = (
        <Status tone="info">
          <p className="online-search-status-title">无法确认{status.subject}所属的串</p>
        </Status>
      )
      break
    case 'failed': {
      const { error } = status
      const title =
        error.kind === 'not-found'
          ? `${status.subject} 当前不可用，服务端返回不存在`
          : error.kind === 'permission'
            ? `当前身份无法访问${status.subject}`
            : `定位${status.subject}失败`
      body = (
        <Status tone="error">
          <p className="online-search-status-title">{title}</p>
          {error.kind !== 'not-found' && error.kind !== 'permission' && (
            <p className="online-search-status-detail">
              原因：{describeReadError(error)}
              {error.serverMessage !== undefined && `；论坛提示：${error.serverMessage}`}
            </p>
          )}
        </Status>
      )
      actions = retry
      break
    }
    case 'internal':
      body = (
        <Status tone="error">
          <p className="online-search-status-title">定位{status.subject}失败</p>
          <p className="online-search-status-detail">原因：应用内部请求失败</p>
        </Status>
      )
      actions = retry
      break
    case 'board-missing':
      body = (
        <Status tone="info">
          <p className="online-search-status-title">
            {status.directoryLoaded ? `版面目录中没有「${status.boardName}」` : `版面目录尚未加载，无法确认版面「${status.boardName}」`}
          </p>
        </Status>
      )
      break
    case 'timeline-missing':
      body = (
        <Status tone="info">
          <p className="online-search-status-title">
            {status.directoryLoaded ? `版面目录中没有时间线 ${status.timelineId}` : `版面目录尚未加载，无法确认时间线 ${status.timelineId}`}
          </p>
        </Status>
      )
      break
    case 'browser-failed':
      body = (
        <Status tone="error">
          <p className="online-search-status-title">无法在系统浏览器中打开这个链接</p>
        </Status>
      )
      break
  }
  return (
    <>
      <div role="status">{body}</div>
      {actions !== null && <div className="online-search-hit-actions">{actions}</div>}
    </>
  )
}
