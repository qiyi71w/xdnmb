import { useLayoutEffect, useRef, type ReactNode } from 'react'
import type { ReadError } from '../../../../shared/api'
import { SEARCH_SITE_URLS } from '../../../../shared/online-search'
import { Content } from '../../components/Content'
import { CookieId } from '../../components/CookieId'
import { Icon } from '../../components/Icon'
import { Loading, SourceNotice } from '../../components/Notices'
import { describeReadError, meaningfulName } from '../../lib/format'
import { formatForumTime } from '../../lib/time'
import { QuoteEntryContext } from './QuoteContext'
import { QuoteRef } from './QuoteRef'
import { useNumberSelectionMenu } from './NumberSelectionMenu'
import type { QuoteCardProps } from './useQuoteNavigation'
import './quote.css'
import { searchErrorLines } from '../search/onlineSearchText'

const XDS_HOST = new URL(SEARCH_SITE_URLS.xds).host
const EDGE = 8
const GAP = 6

/** Server said the post (or what was needed) is missing, or this identity may not see it. */
function unavailableText(error: ReadError): string | null {
  if (error.kind === 'not-found') return '该引用不存在'
  if (error.kind === 'permission') return '当前身份无法访问'
  return null
}

function Reason({ error }: { error: ReadError }) {
  return (
    <p className="quote-card-detail">
      原因：{describeReadError(error)}
      {error.serverMessage !== undefined && `；论坛提示：${error.serverMessage}`}
    </p>
  )
}

/** A notice of the card; `trailing` (the card's ×) ends its first line when it leads the card. */
function Status({ tone, trailing, children }: { tone: 'info' | 'error'; trailing?: ReactNode; children: ReactNode }) {
  return (
    <div className={`quote-card-status is-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={tone === 'error' ? 'alert' : 'info'} size={14} className="quote-card-status-icon" />
      <div className="quote-card-status-text">{children}</div>
      {trailing}
    </div>
  )
}

/**
 * Floating card of one quote. Lives outside every reader's content (no post IDs on its nodes), so
 * it never takes part in a reader's position. Its >>No. sits right above it, so the card repeats no
 * number; 关闭 ends its first line in every state (the meta line, else the first notice).
 */
export function QuoteCard({
  card,
  internal,
  cardRef,
  anchor,
  onPointerEnter,
  onPointerLeave,
  onBlur,
  onKeyDown,
  onRetry,
  onOpenThread,
  onLookUp,
  onClose
}: QuoteCardProps) {
  const postId = card.source.postId
  /** The lookup button, and whether it holds focus (removing a focused element fires no blur). */
  const lookupRef = useRef<HTMLButtonElement>(null)
  const lookupFocused = useRef(false)
  // The card's post has no post menu: a selected whole number in it gets 预览／打开 (replacing this card).
  const bodyNumbers = useNumberSelectionMenu(card.source.entryKey, `${card.id}:${postId}`)

  // Placed below the quote (above when there is no room), kept inside the window, following the
  // quote while the reader scrolls. Fixed positioning: the reading content never moves for it.
  useLayoutEffect(() => {
    const element = cardRef.current
    if (element === null) return
    let frame: number | null = null
    const place = () => {
      frame = null
      const trigger = anchor()
      if (trigger === null) return
      const rect = trigger.getBoundingClientRect()
      const width = element.offsetWidth
      const height = element.offsetHeight
      const left = Math.min(Math.max(EDGE, rect.left), Math.max(EDGE, window.innerWidth - width - EDGE))
      const below = rect.bottom + GAP
      const top = below + height <= window.innerHeight - EDGE || rect.top - GAP - height < EDGE ? below : rect.top - GAP - height
      element.style.left = `${left}px`
      element.style.top = `${Math.max(EDGE, Math.min(top, window.innerHeight - EDGE - height))}px`
    }
    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(place)
    }
    place()
    const observer = new ResizeObserver(schedule)
    observer.observe(element)
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      if (frame !== null) cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [card.source, anchor, cardRef])

  const close = (
    <button type="button" className="icon-btn quote-card-close" aria-label="关闭" title="关闭（Esc）" onClick={onClose}>
      <Icon name="close" size={14} />
    </button>
  )

  const outcome = card.preview.outcome
  const locate = card.locate
  const result = locate?.result ?? null
  const locating = locate !== null && result === null
  const openingThread = locate?.intent === 'open-thread'

  // The quoted post loads on its own: a text-free skeleton until it arrives; only a failure is put into words.
  const previewLoading = outcome === null && internal.previewSeq !== card.preview.seq
  let preview: ReactNode
  if (outcome === null) {
    preview = previewLoading ? (
      <div className="quote-card-lead">
        <div className="quote-card-skeleton" aria-hidden="true">
          <span className="skeleton-line is-short" />
          <span className="skeleton-line" />
          <span className="skeleton-line is-mid" />
        </div>
        {close}
      </div>
    ) : (
      <Status tone="error" trailing={close}>
        <p className="quote-card-title">引用内容加载失败</p>
        <p className="quote-card-detail">原因：应用内部请求失败</p>
      </Status>
    )
  } else if (outcome.status === 'failed') {
    const unavailable = unavailableText(outcome.error)
    preview = (
      <Status tone="error" trailing={close}>
        <p className="quote-card-title">{unavailable ?? '引用内容加载失败'}</p>
        {unavailable === null && <Reason error={outcome.error} />}
      </Status>
    )
  } else if (outcome.status !== 'cancelled') {
    const post = outcome.data.post
    const name = meaningfulName(post.name)
    const unavailable = outcome.status === 'cached' && outcome.networkError !== null ? unavailableText(outcome.networkError) : null
    preview = (
      <>
        {outcome.status === 'cached' && (
          <SourceNotice source={{ status: 'cached', fetchedAt: outcome.fetchedAt, networkError: outcome.networkError }} subject="引用内容" />
        )}
        {unavailable !== null && (
          <Status tone="error">
            <p className="quote-card-title">{unavailable}</p>
          </Status>
        )}
        <div className="quote-card-meta">
          <div className="quote-card-meta-text">
            {post.userHash !== null && <CookieId cookieId={post.userHash} admin={post.isAdmin === true} />}
            {name !== null && <span className="post-name">{name}</span>}
            {post.createdAt !== null && <span>{formatForumTime(post.createdAt)}</span>}
            {post.image !== null && (
              <span className="tag tag-image">
                <Icon name="image" size={12} />
                附图
              </span>
            )}
            {card.source.selection !== undefined && <span>No.{postId}</span>}
            {result === null && <span>{outcome.data.threadId !== null ? `所属串 No.${outcome.data.threadId}` : '所属串未知'}</span>}
          </div>
          {close}
        </div>
        <div className="quote-card-content number-selection-area" {...bodyNumbers.areaProps}>
          <QuoteEntryContext.Provider value={card.source.entryKey}>
            <Content
              nodes={post.content}
              renderQuote={(node, quoteIndex) => (
                <QuoteRef host={{ previewId: `${card.id}:${post.id}` }} origin={card.source.focus} quoteIndex={quoteIndex} postId={node.postId} raw={node.raw} hint={node.hint} />
              )}
            />
          </QuoteEntryContext.Provider>
        </div>
        {bodyNumbers.menu}
      </>
    )
  } else {
    // Cancelled: nothing to show but the way out.
    preview = <div className="quote-card-lead is-bare">{close}</div>
  }

  const viaLookup = locate?.viaLookup === true
  const note = card.lookup ?? null
  let located: ReactNode = null
  if (locating) {
    located = <Loading>{openingThread ? '正在打开原串…（Esc 取消）' : viaLookup ? '正在向 XDS 查询所属串…（Esc 取消）' : '正在定位…（Esc 取消）'}</Loading>
  } else if (result !== null) {
    switch (result.status) {
      case 'unknown-thread': {
        const lookupReason = note?.status === 'search-failed' ? searchErrorLines(note.error, 'XDS') : null
        located = (
          <Status tone={lookupReason !== null ? 'error' : 'info'}>
            <p className="quote-card-title">
              {note === null
                ? '无法确定这条发言所属的串'
                : note.status === 'not-indexed'
                  ? 'XDS 没有收录这条发言，无法得知它所属的串'
                  : note.status === 'unconfirmed'
                    ? `XDS 显示它属于串 No.${note.threadId}，但论坛没有确认`
                    : `向 XDS 查询所属串失败：${lookupReason?.reason ?? ''}`}
            </p>
            {lookupReason?.details.map((line) => (
              <p key={line} className="quote-card-detail">
                {line}
              </p>
            ))}
            {(note === null || note.status === 'search-failed') && (
              <p className="quote-card-detail">查询会把串号 No.{postId} 发给第三方服务 XDS（{XDS_HOST}）</p>
            )}
          </Status>
        )
        break
      }
      case 'thread-known':
        located = (
          <Status tone="info">
            <p className="quote-card-title">
              {viaLookup ? `XDS 显示它属于串 No.${result.threadId}，但没有在该串中定位到它` : `已知原串 No.${result.threadId}，未定位到这条回复`}
            </p>
          </Status>
        )
        break
      case 'failed': {
        // 打开原串 failing to read the resume page is about the thread, not the quoted post.
        const unavailable = openingThread ? null : unavailableText(result.error)
        located = (
          <Status tone="error">
            <p className="quote-card-title">
              {openingThread ? '原串读取失败' : viaLookup && result.threadId !== null ? `XDS 显示它属于串 No.${result.threadId}，读取该串失败` : (unavailable ?? '引用内容加载失败')}
            </p>
            {unavailable === null && <Reason error={result.error} />}
          </Status>
        )
        break
      }
      case 'located':
        located = (
          <Status tone="info">
            <p className="quote-card-title">
              已定位：串 No.{result.threadId}，{result.target.mode === 'po' ? '只看 PO ' : ''}第 {result.target.page} 页
            </p>
            {result.source === 'cached' && result.networkError !== null && (
              <p className="quote-card-detail">依据本地缓存的页面（{describeReadError(result.networkError)}）</p>
            )}
          </Status>
        )
        break
      case 'cancelled':
        break
    }
  }

  // Offered (again) only for an unknown owner whose lookup did not already answer for good.
  const canLookUp = !locating && result?.status === 'unknown-thread' && (note === null || note.status === 'search-failed' || internal.lookup === true)
  // While the lookup runs its button stays where it was, busy: focus is not dropped and a second
  // activation does nothing (the reducer also refuses a lookup while one runs).
  const lookingUp = locating && viaLookup

  // The lookup ended and its button was replaced (打开原串, 重试, or nothing more to ask): if it still
  // held focus, focus moves to the card's first action, else to 关闭. Focus the user moved elsewhere stays.
  useLayoutEffect(() => {
    if (!lookupFocused.current || lookupRef.current !== null) return
    lookupFocused.current = false
    const focused = document.activeElement
    if (focused !== null && focused !== document.body && focused.isConnected) return
    const card = cardRef.current
    const next = card?.querySelector<HTMLElement>('.quote-card-actions button') ?? card?.querySelector<HTMLElement>('.quote-card-close') ?? null
    next?.focus({ preventScroll: true })
  })

  const internalLocate =
    (internal.locate !== null || internal.lookup === true) && !locating ? (
      <Status tone="error">
        <p className="quote-card-title">{internal.lookup === true ? '向 XDS 查询所属串失败' : internal.locate === 'open-thread' ? '打开原串失败' : '定位失败'}</p>
        <p className="quote-card-detail">原因：应用内部请求失败</p>
      </Status>
    ) : null

  // Missing / no permission would only repeat; network, rate limit and unreadable replies may recover.
  const canRetry =
    !locating &&
    ((outcome === null && internal.previewSeq === card.preview.seq) ||
      (outcome?.status === 'failed' && unavailableText(outcome.error) === null) ||
      (result?.status === 'failed' && (openingThread || unavailableText(result.error) === null)))

  return (
    <div
      ref={cardRef}
      className="quote-card"
      role="dialog"
      aria-label={card.source.selection !== undefined ? `No.${postId}` : `引用 No.${postId}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onBlur()
      }}
      onKeyDown={onKeyDown}
    >
      <div className="quote-card-scroll" aria-busy={previewLoading || undefined}>
        {preview}
      </div>
      {(located !== null || internalLocate !== null) && (
        <div className="quote-card-result">
          {internalLocate}
          {located}
        </div>
      )}
      {(result?.status === 'thread-known' || canRetry || canLookUp || lookingUp) && (
        <footer className="quote-card-actions">
          {result?.status === 'thread-known' && (
            <button type="button" className="btn btn-small" onClick={onOpenThread}>
              打开原串
            </button>
          )}
          {(canLookUp || lookingUp) && (
            <button
              ref={lookupRef}
              type="button"
              className="btn btn-small"
              aria-disabled={lookingUp || undefined}
              aria-busy={lookingUp || undefined}
              onFocus={() => (lookupFocused.current = true)}
              onBlur={() => (lookupFocused.current = false)}
              onClick={() => {
                if (!lookingUp) onLookUp()
              }}
            >
              <Icon name="search" size={14} />
              {note === null && internal.lookup !== true ? '向 XDS 查询所属串' : '重新向 XDS 查询'}
            </button>
          )}
          {canRetry && (
            <button type="button" className="btn btn-small" onClick={onRetry}>
              <Icon name="refresh" size={14} />
              重试
            </button>
          )}
        </footer>
      )}
    </div>
  )
}
