import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import type { QuoteLocation, ReadError } from '../../../../shared/api'
import type { BoardDirectory, ForumId, Post, PostId, ThreadId } from '../../../../shared/forum'
import { MAX_SEARCH_QUERY_LENGTH, type ForumLinkTarget, type SearchError, type SearchHit } from '../../../../shared/search'
import { Icon } from '../../components/Icon'
import { Loading } from '../../components/Notices'
import { describeReadError, formatLocalTime } from '../../lib/format'
import { useRovingFocus } from '../../lib/useRovingFocus'
import { ContentRegistryContext, useRegisterContent } from '../tabs/contentRegistry'
import { readResumePage } from '../thread/readingStart'
import type { EntryInit } from '../tabs/tabsState'
import type { SearchNotice, SearchResults, SearchSession } from './searchSession'
import './search.css'

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

/** 串 No.x／主帖 No.x／回复 No.y（串 No.x）／版面 名称／外部链接 */
function targetLabel(target: ForumLinkTarget | null): string {
  if (target === null) return '外部链接'
  if (target.kind === 'board') return `版面 ${target.boardName}`
  if (target.replyId === null) return `串 No.${target.threadId}`
  return target.replyId === target.threadId ? `主帖 No.${target.threadId}` : `回复 No.${target.replyId}（串 No.${target.threadId}）`
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

/** Reason lines of a search failure; the service's own message is shown verbatim as text. */
function errorLines(error: SearchError): { reason: string; details: string[] } {
  switch (error.kind) {
    case 'network':
      return { reason: error.detail === 'timeout' ? '搜索服务 20 秒内未响应' : '无法连接搜索服务', details: [] }
    case 'http-status':
      return { reason: `搜索服务返回 HTTP ${error.httpStatus}`, details: [] }
    case 'service': {
      const details = [`服务消息：${error.serviceMessage}`]
      if (error.hint === 'rate-limited') details.push('服务消息提到请求过于频繁')
      if (error.hint === 'verification') details.push('服务消息提到需要人工验证，可打开搜索网站查看；验证结果不会传回汐岛')
      return { reason: '搜索服务返回错误', details }
    }
    case 'unknown-structure':
      return { reason: error.detail === 'redirect' ? '搜索服务要求跳转到其他地址，已拒绝' : '搜索服务返回了无法识别的内容', details: [] }
  }
}

const CHAIN_END_TEXT = {
  end: '没有更多结果页（不代表收录完整）',
  expired: '下一页链接已过期（闲置超过 15 分钟），请重新搜索',
  lost: '下一页链接已失效，请重新搜索'
} as const

function Status({ tone, children }: { tone: 'info' | 'error'; children: ReactNode }) {
  return (
    <div className={`search-status-box is-${tone}`}>
      <Icon name={tone === 'error' ? 'alert' : 'info'} size={14} className="search-status-icon" />
      <div className="search-status-text">{children}</div>
    </div>
  )
}

/**
 * Online search page (spec I10): a search box that requests only on submit, the third-party
 * notice, plain-text results with paging over the session's chain, and result opening through the
 * existing reader navigation. Its query, pages and view live in the entry's SearchSession, so
 * leaving and coming back restores them without any request. Nothing here marks posts read.
 */
export function SearchPane({
  entryKey,
  displayed,
  directory,
  onOpen
}: {
  entryKey: number
  /** The page is on screen (its tab is active). */
  displayed: boolean
  directory: BoardDirectory | null
  /** Opens a result in this entry's tab as a new `search` step; false when the entry is no longer current. */
  onOpen: (entryKey: number, init: EntryInit) => boolean
}) {
  const registry = useContext(ContentRegistryContext)
  const [session] = useState<SearchSession>(() => {
    if (registry === null) throw new Error('SearchPane needs the content registry')
    return registry.searches.session(entryKey)
  })
  const state = useSyncExternalStore(session.subscribe, session.getState)
  const { results, pending, notice } = state

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

  useRegisterContent('searchPanes', entryKey, { focusInput: () => inputRef.current?.focus() })

  const hitButton = (page: number, index: number): HTMLElement | null =>
    listRef.current?.querySelector<HTMLElement>(`[data-hit-key="${page}-${index}"]`) ?? null

  // Entering the page focuses the search box; coming back restores scroll and the last result.
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (scroller !== null) scroller.scrollTop = session.view.scrollTop
    if (!displayedRef.current) return
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
    const operationId = `search-locate-${entryKey}-${seq}`
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
   * 打开原串 after `thread-known`, with the quote rule (spec I6): the page the thread resumes at is
   * read first; only once it arrived (and the page is still on screen) a step is committed, opening
   * the thread normally and still saying the post was not located. A failure or cancellation leaves
   * the search page and history as they were and explains it in the row.
   */
  const openThread = (known: KnownThread, page: number, index: number): void => {
    cancelLocate(false)
    const seq = (locateSeq.current += 1)
    const operationId = `search-locate-${entryKey}-${seq}`
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
  const locating = row?.status.kind === 'locating' || row?.status.kind === 'opening'
  const cancellable = displayed && (locating || pending !== null)
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
  const canSubmit = query !== '' && query.length <= MAX_SEARCH_QUERY_LENGTH
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
    window.xidao.search.openSite().then(
      (result) => setSiteFailed(!result.opened),
      () => setSiteFailed(true)
    )
  }

  const hits = shownPage?.hits ?? []
  const ids = useMemo(() => (shownPage === null ? [] : shownPage.hits.map((_, index) => `${shownPage.pageNumber}-${index}`)), [shownPage])
  const focusedKey = session.view.focus === null ? null : `${session.view.focus.page}-${session.view.focus.index}`
  const roving = useRovingFocus(ids, focusedKey)

  return (
    <section className="search-page" aria-label="联网搜索">
      <div className="search-scroll" ref={scrollRef} onScroll={onScroll}>
        <header className="search-header">
          <h2 className="search-title">联网搜索</h2>
          <form className="search-form" role="search" onSubmit={submit}>
            <label className="visually-hidden" htmlFor={`search-input-${entryKey}`}>
              搜索词
            </label>
            <input
              ref={inputRef}
              id={`search-input-${entryKey}`}
              className="search-input"
              type="text"
              enterKeyHint="search"
              autoComplete="off"
              spellCheck={false}
              maxLength={MAX_SEARCH_QUERY_LENGTH}
              placeholder="输入搜索词，按 Enter 搜索"
              aria-describedby={`search-about-${entryKey}`}
              value={state.draft}
              onChange={(event) => session.setDraft(event.target.value)}
            />
            <button type="submit" className="btn search-submit" disabled={!canSubmit}>
              <Icon name="search" />
              搜索
            </button>
          </form>
          {state.draft.length >= MAX_SEARCH_QUERY_LENGTH - 20 && (
            <p className="search-count">
              {state.draft.length}／{MAX_SEARCH_QUERY_LENGTH} 字
            </p>
          )}
        </header>

        <div className="search-about" id={`search-about-${entryKey}`}>
          <p>
            搜索词会交给第三方服务 nmb-search（4get／Google CSE 代理）及其上游搜索引擎。收录可能不全或过时；结果不代表论坛当前状态，摘要也不是帖子正文。
          </p>
          <div className="search-about-site">
            <button type="button" className="btn btn-small" onClick={openSite}>
              <Icon name="external" size={14} />
              打开搜索网站
            </button>
            <span>在系统浏览器中打开同一服务的网站，不是故障时的备用来源；在浏览器里完成的验证不会传回汐岛。</span>
          </div>
          {siteFailed && (
            <p className="notice-inline is-warning" role="status">
              <Icon name="alert" size={14} />
              无法在系统浏览器中打开搜索网站
            </p>
          )}
        </div>

        <div className="search-status" role="status">
          {pending?.kind === 'run' && (
            <div className="search-loading">
              <Loading>正在搜索「{pending.query}」…（Esc 取消）</Loading>
              <button
                type="button"
                className="btn btn-small"
                onClick={() => {
                  inputRef.current?.focus()
                  session.cancel()
                }}
              >
                取消
              </button>
            </div>
          )}
          {notice !== null && notice.kind !== 'closed' && notice.request.kind === 'run' && <RequestNotice notice={notice} onRetry={rerun} />}
          {results !== null && !results.live && pending?.kind !== 'run' && (
            <p className="notice-inline">
              <Icon name="info" size={14} />
              {notice?.kind === 'closed' ? '搜索会话已释放，' : ''}以下仍是「{results.query}」之前取得的结果，已取得的页面可以前后查看，但无法继续取新页；需要时请重新搜索。
            </p>
          )}
        </div>

        {results === null && pending === null && notice === null && (
          <div className="search-idle">
            <p className="list-empty-title">输入搜索词开始搜索</p>
            <p className="list-empty-text">只有按 Enter 或点击“搜索”时才会联网；输入过程中不发送任何内容。</p>
          </div>
        )}

        {results !== null && shownPage !== null && (
          <>
            <h3 className="search-results-head" ref={headingRef} tabIndex={-1}>
              <span className="search-results-query">「{results.query}」</span>
              <span className="search-results-meta">
                第 {shownPage.pageNumber} 页 · {hits.length} 条 · {formatLocalTime(shownPage.fetchedAt)} 取得
              </span>
            </h3>

            {hits.length === 0 && (
              <div className="list-empty" role="status">
                <p className="list-empty-title">{shownPage.pageNumber === 1 ? '没有找到结果' : '这一页没有结果'}</p>
                <p className="list-empty-text">第三方服务的收录可能不全，没有结果不代表论坛中没有相关内容。</p>
              </div>
            )}

            {hits.length > 0 && (
              <ul className="search-hits" aria-label="搜索结果" ref={listRef} onKeyDown={roving.onKeyDown}>
                {hits.map((hit, index) => {
                  const key = `${shownPage.pageNumber}-${index}`
                  const itemProps = roving.itemProps(key)
                  const url = hit.url
                  return (
                    <li key={key}>
                      <HitRow
                        hit={hit}
                        hitKey={key}
                        status={row !== null && row.page === shownPage.pageNumber && row.index === index ? row.status : null}
                        itemProps={{
                          ...itemProps,
                          onFocus: () => {
                            itemProps.onFocus()
                            session.view.focus = { page: shownPage.pageNumber, index }
                          }
                        }}
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

            <Pager results={results} session={session} pendingPage={pending?.kind === 'page' ? pending.page : null} />
            {notice !== null && notice.kind !== 'closed' && notice.request.kind === 'page' && <RequestNotice notice={notice} onRetry={null} />}
            {results.live && results.current === results.pages.length && results.next !== 'available' && pending === null && (
              <div className="search-chain-end">
                <p className="list-end">{CHAIN_END_TEXT[results.next]}</p>
                {results.next !== 'end' && (
                  <button type="button" className="btn btn-small" onClick={() => rerun(results.query)}>
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
 * Failure or cancellation of a search (`onRetry` = run the same query again) or of a page request
 * (no retry: the token that page needed is gone).
 */
function RequestNotice({ notice, onRetry }: { notice: Exclude<SearchNotice, { kind: 'closed' }>; onRetry: ((query: string) => void) | null }) {
  const request = notice.request
  const subject = request.kind === 'run' ? `搜索「${request.query}」` : `读取第 ${request.page} 页`
  if (notice.kind === 'cancelled') {
    return (
      <p className="notice-inline search-request-notice" role="status">
        <Icon name="info" size={14} />
        已取消{subject}
      </p>
    )
  }
  const { reason, details } = notice.kind === 'failed' ? errorLines(notice.error) : { reason: '应用内部请求失败', details: [] }
  return (
    <div className="notice notice-error search-request-notice" role="alert">
      <Icon name="alert" className="notice-icon" />
      <div className="notice-text">
        <p className="notice-title">
          {subject}失败：{reason}
        </p>
        {details.map((line) => (
          <p key={line} className="notice-detail">
            {line}
          </p>
        ))}
        {request.kind === 'page' && <p className="notice-detail">已取得的页面仍可查看；这一页需要重新搜索后才能再取得。</p>}
      </div>
      {request.kind === 'run' && onRetry !== null && (
        <button type="button" className="btn btn-small" onClick={() => onRetry(request.query)}>
          重试
        </button>
      )}
    </div>
  )
}

function Pager({ results, session, pendingPage }: { results: SearchResults; session: SearchSession; pendingPage: number | null }) {
  const previous = results.current - 1
  const next = results.current + 1
  const canPrevious = session.canShow(previous)
  const canNext = session.canShow(next)
  const fetchingNext = pendingPage !== null && pendingPage > results.pages.length
  return (
    <nav className="search-pager" aria-label="搜索结果页">
      <button type="button" className="btn btn-small" aria-disabled={!canPrevious} onClick={() => canPrevious && session.goToPage(previous)}>
        <Icon name="arrowLeft" size={14} />
        上一页
      </button>
      <span className="search-pager-current" aria-current="page">
        第 {results.current} 页
      </span>
      <button type="button" className="btn btn-small" aria-disabled={!canNext} onClick={() => canNext && session.goToPage(next)}>
        下一页
        <Icon name="arrowRight" size={14} />
      </button>
      {fetchingNext && (
        <div className="search-loading">
          <Loading>正在读取第 {pendingPage} 页…（Esc 取消）</Loading>
          <button type="button" className="btn btn-small" onClick={() => session.cancel()}>
            取消
          </button>
        </div>
      )}
    </nav>
  )
}

function HitRow({
  hit,
  hitKey,
  status,
  itemProps,
  onActivate,
  onBrowser,
  onCancel,
  onRetry,
  onOpenLocated,
  onOpenThread
}: {
  hit: SearchHit
  hitKey: string
  status: RowStatus | null
  itemProps: { 'data-roving-item': string; tabIndex: number; onFocus: () => void }
  onActivate: () => void
  onBrowser: (() => void) | null
  onCancel: () => void
  onRetry: () => void
  onOpenLocated: (location: Located) => void
  onOpenThread: (known: KnownThread) => void
}) {
  const target = hit.target
  const unusable = target === null && hit.url === null
  // The row's own controls are reachable with Tab from the row that holds the list's tab stop.
  const tabIndex = itemProps.tabIndex
  const statusId = `search-hit-status-${hitKey}`
  return (
    <article className="search-hit">
      <button
        type="button"
        className="search-hit-main"
        data-hit-key={hitKey}
        aria-disabled={unusable}
        aria-describedby={status === null ? undefined : statusId}
        onClick={unusable ? undefined : onActivate}
        {...itemProps}
      >
        <span className="search-hit-top">
          <span className={target === null ? 'tag search-hit-kind is-external' : 'tag search-hit-kind'}>
            {target === null && <Icon name="external" size={12} />}
            {targetLabel(target)}
          </span>
          {hit.date !== null && <span className="search-hit-date">{formatLocalTime(hit.date)}</span>}
        </span>
        <span className={hit.title === null ? 'search-hit-title is-missing' : 'search-hit-title'}>{hit.title ?? '（服务未提供标题）'}</span>
        {hit.description !== null && <span className="search-hit-snippet">{hit.description}</span>}
        <span className="search-hit-source">{hit.url === null ? '链接不可用' : sourceText(hit.url)}</span>
      </button>

      {(status !== null || (target !== null && onBrowser !== null)) && (
        <div className="search-hit-extra" id={statusId}>
          {status !== null && (
            <RowStatusView status={status} tabIndex={tabIndex} onBrowser={onBrowser} onCancel={onCancel} onRetry={onRetry} onOpenLocated={onOpenLocated} onOpenThread={onOpenThread} />
          )}
          {status === null && target !== null && onBrowser !== null && (
            <div className="search-hit-actions">
              <button type="button" className="btn btn-small btn-quiet" tabIndex={tabIndex} onClick={onBrowser}>
                <Icon name="external" size={14} />
                在浏览器中打开
              </button>
            </div>
          )}
        </div>
      )}
    </article>
  )
}

function RowStatusView({
  status,
  tabIndex,
  onBrowser,
  onCancel,
  onRetry,
  onOpenLocated,
  onOpenThread
}: {
  status: RowStatus
  tabIndex: number
  onBrowser: (() => void) | null
  onCancel: () => void
  onRetry: () => void
  onOpenLocated: (location: Located) => void
  onOpenThread: (known: KnownThread) => void
}) {
  const browser =
    onBrowser === null ? null : (
      <button type="button" className="btn btn-small btn-quiet" tabIndex={tabIndex} onClick={onBrowser}>
        <Icon name="external" size={14} />
        在浏览器中打开
      </button>
    )
  const retry = (
    <button type="button" className="btn btn-small" tabIndex={tabIndex} onClick={onRetry}>
      <Icon name="refresh" size={14} />
      重试
    </button>
  )
  let body: ReactNode
  let actions: ReactNode = browser
  switch (status.kind) {
    case 'locating':
      body = <Loading live={false}>{status.intent === 'open' ? `正在定位${status.subject}…（Esc 取消）` : `正在重新定位${status.subject}…（Esc 取消）`}</Loading>
      actions = (
        <button type="button" className="btn btn-small" tabIndex={tabIndex} onClick={onCancel}>
          取消
        </button>
      )
      break
    case 'located':
      body = (
        <Status tone="info">
          <p className="search-status-title">
            已定位：串 No.{status.location.threadId}，{status.location.target.mode === 'po' ? '只看 PO ' : ''}第 {status.location.target.page} 页
          </p>
          {status.location.source === 'cached' && status.location.networkError !== null && (
            <p className="search-status-detail">依据本地缓存的页面（{describeReadError(status.location.networkError)}）</p>
          )}
        </Status>
      )
      actions = (
        <>
          <button type="button" className="btn btn-small" tabIndex={tabIndex} onClick={() => onOpenLocated(status.location)}>
            <Icon name="arrowRight" size={14} />
            打开
          </button>
          {browser}
        </>
      )
      break
    case 'thread-known':
      body = (
        <Status tone="info">
          <p className="search-status-title">未在该页找到{status.known.subject}</p>
          <p className="search-status-detail">所属串 No.{status.known.threadId} 可以读取；打开原串会按正常续读位置阅读，不会跳到这条发言。</p>
        </Status>
      )
      actions = (
        <>
          <button type="button" className="btn btn-small" tabIndex={tabIndex} onClick={() => onOpenThread(status.known)}>
            打开原串
          </button>
          {browser}
        </>
      )
      break
    case 'opening':
      body = <Loading live={false}>正在打开原串 No.{status.known.threadId}…（Esc 取消）</Loading>
      actions = (
        <button type="button" className="btn btn-small" tabIndex={tabIndex} onClick={onCancel}>
          取消
        </button>
      )
      break
    case 'open-failed':
      body = (
        <Status tone="error">
          <p className="search-status-title">{status.error === null ? '打开原串失败' : '原串读取失败'}</p>
          <p className="search-status-detail">
            原因：{status.error === null ? '应用内部请求失败' : describeReadError(status.error)}
            {status.error?.serverMessage !== undefined && `；论坛提示：${status.error.serverMessage}`}
          </p>
        </Status>
      )
      actions = (
        <>
          {retry}
          {browser}
        </>
      )
      break
    case 'unknown-thread':
      body = (
        <Status tone="info">
          <p className="search-status-title">无法确认{status.subject}所属的串</p>
          <p className="search-status-detail">没有可靠的所属串记录，不会按摘要猜测；只能在浏览器中查看。</p>
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
          <p className="search-status-title">{title}</p>
          {error.kind !== 'not-found' && error.kind !== 'permission' && (
            <p className="search-status-detail">
              原因：{describeReadError(error)}
              {error.serverMessage !== undefined && `；论坛提示：${error.serverMessage}`}
            </p>
          )}
        </Status>
      )
      actions = (
        <>
          {retry}
          {browser}
        </>
      )
      break
    }
    case 'internal':
      body = (
        <Status tone="error">
          <p className="search-status-title">定位{status.subject}失败</p>
          <p className="search-status-detail">原因：应用内部请求失败</p>
        </Status>
      )
      actions = (
        <>
          {retry}
          {browser}
        </>
      )
      break
    case 'board-missing':
      body = (
        <Status tone="info">
          <p className="search-status-title">
            {status.directoryLoaded ? `版面目录中没有「${status.boardName}」` : `版面目录尚未加载，无法确认版面「${status.boardName}」`}
          </p>
          <p className="search-status-detail">只能在浏览器中查看这个链接。</p>
        </Status>
      )
      break
    case 'browser-failed':
      body = (
        <Status tone="error">
          <p className="search-status-title">无法在系统浏览器中打开这个链接</p>
        </Status>
      )
      actions = null
      break
  }
  return (
    <>
      <div role="status">{body}</div>
      {actions !== null && <div className="search-hit-actions">{actions}</div>}
    </>
  )
}
