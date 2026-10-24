import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ReadError } from '../../../../shared/api'
import { Content } from '../../components/Content'
import { Icon } from '../../components/Icon'
import { Loading, SourceNotice } from '../../components/Notices'
import { describeReadError, meaningfulName } from '../../lib/format'
import { canLocate } from './quoteState'
import type { QuoteCardProps } from './useQuoteNavigation'
import './quote.css'

const EDGE = 8
const GAP = 6

/** Server said the post (or what was needed) is missing, or this identity may not see it. */
function unavailableText(error: ReadError): string | null {
  if (error.kind === 'not-found') return '该引用当前不可用，服务端返回不存在'
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

function Status({ tone, children }: { tone: 'info' | 'error'; children: ReactNode }) {
  return (
    <div className={`quote-card-status is-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={tone === 'error' ? 'alert' : 'info'} size={14} className="quote-card-status-icon" />
      <div className="quote-card-status-text">{children}</div>
    </div>
  )
}

/**
 * Floating card of one quote. Lives outside every reader's content (no post IDs on its nodes), so
 * showing it never counts as reading. Number, 复制编号 and 关闭 are available in every state.
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
  onLocate,
  onRetry,
  onOpenThread,
  onClose
}: QuoteCardProps) {
  const postId = card.source.postId
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null)
  const copyTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])

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

  const copy = () => {
    window.clearTimeout(copyTimer.current)
    navigator.clipboard.writeText(`No.${postId}`).then(
      () => setCopied('done'),
      () => setCopied('failed')
    )
    copyTimer.current = window.setTimeout(() => setCopied(null), 1600)
  }

  const outcome = card.preview.outcome
  const locate = card.locate
  const result = locate?.result ?? null
  const locating = locate !== null && result === null
  const openingThread = locate?.intent === 'open-thread'
  const locatable = canLocate(card)

  let preview: ReactNode
  if (outcome === null) {
    preview =
      internal.previewSeq === card.preview.seq ? (
        <Status tone="error">
          <p className="quote-card-title">引用内容加载失败</p>
          <p className="quote-card-detail">原因：应用内部请求失败</p>
        </Status>
      ) : (
        <Loading>正在读取引用内容…</Loading>
      )
  } else if (outcome.status === 'failed') {
    const unavailable = unavailableText(outcome.error)
    preview = (
      <Status tone="error">
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
          {post.userHash !== null && <span className="user-hash">{post.userHash}</span>}
          {name !== null && <span className="post-name">{name}</span>}
          {post.isAdmin === true && <span className="tag tag-admin">管理员</span>}
          {post.createdAt !== null && <span>{post.createdAt}</span>}
          {post.image !== null && (
            <span className="tag tag-image">
              <Icon name="image" size={12} />
              附图
            </span>
          )}
          {outcome.data.threadId !== null && result === null && <span>所属串 No.{outcome.data.threadId}</span>}
        </div>
        {outcome.data.threadId === null && locate === null && (
          <Status tone="info">
            <p className="quote-card-detail">本机还没有这条发言的所属串记录；跳转时只核对它是否为某串主帖，不会猜测回复所在的串。</p>
          </Status>
        )}
        <div className="quote-card-content">
          <Content nodes={post.content} />
        </div>
      </>
    )
  }

  let located: ReactNode = null
  if (locating) {
    located = <Loading>{openingThread ? '正在打开原串…（Esc 取消）' : '正在定位…（Esc 取消）'}</Loading>
  } else if (result !== null) {
    switch (result.status) {
      case 'unknown-thread':
        located = (
          <Status tone="info">
            <p className="quote-card-title">暂时无法确定这条回复属于哪个串</p>
            <p className="quote-card-detail">没有可靠的所属串记录，因此不能跳转；可以复制编号。</p>
          </Status>
        )
        break
      case 'thread-known':
        located = (
          <Status tone="info">
            <p className="quote-card-title">已知原串 No.{result.threadId}，暂未定位到这条回复</p>
            <p className="quote-card-detail">可以打开原串，按正常续读位置阅读；不会跳到这条回复。</p>
          </Status>
        )
        break
      case 'failed': {
        // 打开原串 failing to read the resume page is about the thread, not the quoted post.
        const unavailable = openingThread ? null : unavailableText(result.error)
        located = (
          <Status tone="error">
            <p className="quote-card-title">{openingThread ? '原串读取失败' : (unavailable ?? '引用内容加载失败')}</p>
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

  const internalLocate =
    internal.locate !== null && !locating ? (
      <Status tone="error">
        <p className="quote-card-title">{internal.locate === 'open-thread' ? '打开原串失败' : '定位失败'}</p>
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
      aria-label={`引用 No.${postId}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onBlur()
      }}
      onKeyDown={onKeyDown}
    >
      <header className="quote-card-head">
        <span className="quote-card-no">No.{postId}</span>
        <button type="button" className="btn btn-small btn-quiet" onClick={copy}>
          {copied === 'done' ? '已复制' : copied === 'failed' ? '复制失败' : '复制编号'}
        </button>
        <button type="button" className="icon-btn quote-card-close" aria-label="关闭" title="关闭（Esc）" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </header>
      <div className="quote-card-scroll">{preview}</div>
      {(located !== null || internalLocate !== null) && (
        <div className="quote-card-result">
          {internalLocate}
          {located}
        </div>
      )}
      <footer className="quote-card-actions">
        <button type="button" className="btn btn-small" disabled={!locatable} onClick={() => onLocate(false)}>
          <Icon name="arrowRight" size={14} />
          跳转
        </button>
        <button type="button" className="btn btn-small" disabled={!locatable} onClick={() => onLocate(true)}>
          <Icon name="external" size={14} />
          在新标签打开
        </button>
        {result?.status === 'thread-known' && (
          <button type="button" className="btn btn-small" onClick={onOpenThread}>
            打开原串
          </button>
        )}
        {canRetry && (
          <button type="button" className="btn btn-small" onClick={onRetry}>
            <Icon name="refresh" size={14} />
            重试
          </button>
        )}
      </footer>
    </div>
  )
}
