import { useContext, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import type { QuotePreview, ReadError, ReadOutcome } from '../../../../shared/api'
import type { PostId } from '../../../../shared/forum'
import { SEARCH_SITE_URLS } from '../../../../shared/online-search'
import { Content } from '../../components/Content'
import { CookieId } from '../../components/CookieId'
import { Icon } from '../../components/Icon'
import { Loading, SourceNotice } from '../../components/Notices'
import { describeReadError, meaningfulName } from '../../lib/format'
import { formatForumTime } from '../../lib/time'
import { QuoteControllerContext } from '../quote/QuoteContext'
import { lookUpThread } from '../quote/threadLookup'
import type { EntryInit } from '../tabs/tabsState'
import { readResumePage } from '../thread/readingStart'
import { canLookUp, initialNumberOpenState, isCurrentStep, isRunning, numberOpenReducer, type KnownThread, type NumberOpenAction, type NumberOpenState, type NumberStatus } from './numberOpenState'
import { searchErrorLines } from './onlineSearchText'

const XDS_HOST = new URL(SEARCH_SITE_URLS.xds).host

type Located = Extract<NonNullable<NumberStatus>, { kind: 'located' }>['location']

/** Preview of the asked post: `outcome` null while loading; `internal` when the call itself rejected. */
interface PreviewState {
  postId: PostId
  seq: number
  outcome: ReadOutcome<QuotePreview> | null
  internal: boolean
}

function Status({ tone, children }: { tone: 'info' | 'error'; children: ReactNode }) {
  return (
    <div className={`online-search-status-box is-${tone}`}>
      <Icon name={tone === 'error' ? 'alert' : 'info'} size={14} className="online-search-status-icon" />
      <div className="online-search-status-text">{children}</div>
    </div>
  )
}

function readReason(error: ReadError): string {
  return `原因：${describeReadError(error)}${error.serverMessage !== undefined ? `；论坛提示：${error.serverMessage}` : ''}`
}

/**
 * 按串号打开 on the 搜索 page, independent of 本机｜联网 and of the online channel: a whole number,
 * `No.`, `>>No.` or a verified forum thread link is located through the existing reader navigation.
 * Only a located target (or 打开原串 once its page arrived) commits a step of this tab, or a new active
 * tab with Ctrl/Cmd; failures, cancellation and results arriving while the page is out of sight leave
 * history and position as they were. An unknown owner offers the explicit, disclosed XDS lookup.
 */
export function NumberOpen({
  entryKey,
  displayed,
  draft,
  onDraft,
  inputRef,
  onOpen
}: {
  entryKey: number
  /** The page is on screen: only then does a located result jump. */
  displayed: boolean
  draft: string
  onDraft: (draft: string) => void
  inputRef: RefObject<HTMLInputElement | null>
  /** Opens a thread from this entry (as a step of its tab, or in a new tab); false when it is no longer current. */
  onOpen: (init: EntryInit, newTab: boolean) => boolean
}) {
  const quotes = useContext(QuoteControllerContext)
  const [state, setState] = useState<NumberOpenState>(initialNumberOpenState)
  const stateRef = useRef(state)
  const displayedRef = useRef(displayed)
  const [preview, setPreview] = useState<PreviewState | null>(null)
  const previewSeq = useRef(0)
  useLayoutEffect(() => {
    displayedRef.current = displayed
  })

  /** Applied synchronously: a second Enter or click before the re-render meets the busy state. */
  const apply = (action: NumberOpenAction): NumberOpenState => {
    const next = numberOpenReducer(stateRef.current, action)
    if (next !== stateRef.current) {
      stateRef.current = next
      setState(next)
    }
    return next
  }

  const operationId = (seq: number) => `number-open-${entryKey}-${seq}`
  const isNewTab = (event: { ctrlKey: boolean; metaKey: boolean }) => quotes?.isNewTab(event) ?? (event.ctrlKey || event.metaKey)

  const cancelPreview = () => {
    previewSeq.current += 1
    if (preview?.outcome === null) window.xidao.reading.cancel({ operationId: `number-preview-${entryKey}-${preview.seq}` }).catch(() => undefined)
    setPreview(null)
  }

  // Leaving the page drops the running step and preview: their results could no longer be followed.
  const cleanup = useRef(() => {})
  useLayoutEffect(() => {
    cleanup.current = () => {
      const status = stateRef.current.status
      if (isRunning(status)) window.xidao.reading.cancel({ operationId: operationId(status.seq) }).catch(() => undefined)
      if (preview?.outcome === null) window.xidao.reading.cancel({ operationId: `number-preview-${entryKey}-${preview.seq}` }).catch(() => undefined)
    }
  })
  useEffect(() => () => cleanup.current(), [])

  const followLocated = (location: Located, newTab: boolean): boolean => {
    const target = { postId: location.target.postId, page: location.target.page, mode: location.target.mode }
    return displayedRef.current && onOpen({ kind: 'thread', thread: { threadId: location.threadId, head: location.head, target, snapshot: null, unlocatedPostId: null } }, newTab)
  }

  const runLocate = (next: NumberOpenState) => {
    const status = next.status
    if (status?.kind !== 'locating') return
    const { seq, target } = status
    window.xidao.quotes.locate({ operationId: operationId(seq), postId: target.postId, ...(target.hint === null ? {} : { hint: target.hint }) }).then(
      (result) => {
        if (!isCurrentStep(stateRef.current, seq)) return
        if (result.status === 'located' && followLocated(result, target.newTab)) {
          apply({ type: 'opened', seq })
          return
        }
        apply({ type: 'locate-done', seq, result })
      },
      () => apply({ type: 'internal', seq })
    )
  }

  const submit = (newTab: boolean) => {
    const before = stateRef.current
    const next = apply({ type: 'submit', raw: draft, newTab })
    if (next.seq === before.seq) return
    cancelPreview()
    runLocate(next)
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    submit(false)
  }

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing || !isNewTab(event)) return
    event.preventDefault()
    submit(true)
  }

  /** A status button is replaced by the step it starts: focus waits in the box meanwhile. */
  const keepFocus = () => inputRef.current?.focus()

  const retry = () => {
    keepFocus()
    const before = stateRef.current
    const next = apply({ type: 'retry' })
    if (next.seq !== before.seq) runLocate(next)
  }

  const lookUp = () => {
    keepFocus()
    const before = stateRef.current
    const next = apply({ type: 'lookup-start' })
    const status = next.status
    if (next.seq === before.seq || status?.kind !== 'looking-up') return
    const { seq, target } = status
    lookUpThread(operationId(seq), target.postId, () => isCurrentStep(stateRef.current, seq)).then(
      (result) => {
        if (!isCurrentStep(stateRef.current, seq)) return
        if (result.status === 'located' && followLocated(result.location, target.newTab)) {
          apply({ type: 'opened', seq })
          return
        }
        apply({ type: 'lookup-done', seq, result })
      },
      () => apply({ type: 'internal', seq })
    )
  }

  const openThread = (newTab: boolean) => {
    keepFocus()
    const before = stateRef.current
    const next = apply({ type: 'open-thread-start' })
    const status = next.status
    if (next.seq === before.seq || status?.kind !== 'opening') return
    const { seq, target, known } = status
    const current = () => isCurrentStep(stateRef.current, seq)
    // Committed only once the page the thread resumes at was obtained; it still says the post was not located.
    readResumePage(known.threadId, operationId(seq), current).then(
      (outcome) => {
        if (outcome === null || !current() || outcome.status === 'cancelled') return
        if (outcome.status === 'failed') {
          apply({ type: 'open-thread-failed', seq, error: outcome.error })
          return
        }
        const thread = { threadId: known.threadId, head: known.head, target: null, snapshot: null, unlocatedPostId: target.postId }
        if (displayedRef.current && onOpen({ kind: 'thread', thread }, newTab)) apply({ type: 'opened', seq })
        else apply({ type: 'cancel' })
      },
      () => {
        if (current()) apply({ type: 'open-thread-failed', seq, error: null })
      }
    )
  }

  const openLocated = (location: Located, newTab: boolean) => {
    if (followLocated(location, newTab)) apply({ type: 'opened', seq: stateRef.current.seq })
  }

  const cancel = (): boolean => {
    const status = stateRef.current.status
    if (!isRunning(status)) return false
    apply({ type: 'cancel' })
    window.xidao.reading.cancel({ operationId: operationId(status.seq) }).catch(() => undefined)
    return true
  }

  const showPreview = (postId: PostId) => {
    keepFocus()
    if (preview !== null && preview.postId === postId && (preview.outcome === null || preview.outcome.status !== 'failed') && !preview.internal) return
    cancelPreview()
    const seq = (previewSeq.current += 1)
    setPreview({ postId, seq, outcome: null, internal: false })
    window.xidao.quotes.preview({ operationId: `number-preview-${entryKey}-${seq}`, postId }).then(
      (outcome) => {
        if (previewSeq.current !== seq || outcome.status === 'cancelled') return
        setPreview({ postId, seq, outcome, internal: false })
      },
      () => {
        if (previewSeq.current === seq) setPreview({ postId, seq, outcome: null, internal: true })
      }
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing) return
    if (cancel()) {
      event.preventDefault()
      keepFocus()
    }
  }

  const status = state.status
  const busy = isRunning(status)
  const id = `number-open-input-${entryKey}`
  return (
    <div className="number-open" onKeyDown={onKeyDown}>
      <form className="number-open-form" onSubmit={onSubmit}>
        <label className="number-open-label" htmlFor={id}>
          按串号打开
        </label>
        <input
          ref={inputRef}
          id={id}
          className="number-open-input"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          maxLength={2048}
          placeholder="No.12345678 或串链接"
          aria-describedby={`number-open-status-${entryKey}`}
          value={draft}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={onInputKeyDown}
        />
        {/* Busy stays focusable: the reducer drops a submit while a step runs. */}
        <button
          type="submit"
          className="btn btn-page number-open-submit"
          aria-disabled={busy || draft.trim() === '' || undefined}
          aria-busy={busy || undefined}
          title="Ctrl/⌘ + Enter 在新标签页打开"
          onClick={(event: MouseEvent<HTMLButtonElement>) => {
            if (!isNewTab(event)) return
            event.preventDefault()
            submit(true)
          }}
        >
          <Icon name="arrowRight" size={14} />
          打开
        </button>
      </form>
      <div className="number-open-status" id={`number-open-status-${entryKey}`} role="status">
        {status !== null && (
          <NumberStatusView
            status={status}
            onCancel={() => {
              cancel()
              keepFocus()
            }}
            onRetry={retry}
            onLookUp={lookUp}
            onOpenThread={(event) => openThread(isNewTab(event))}
            onOpenLocated={(location, event) => openLocated(location, isNewTab(event))}
            onPreview={showPreview}
          />
        )}
        {preview !== null && status !== null && !isRunning(status) && status.kind !== 'invalid' && status.target.postId === preview.postId && (
          <NumberPreview preview={preview} onRetry={() => showPreview(preview.postId)} />
        )}
      </div>
    </div>
  )
}

function NumberStatusView({
  status,
  onCancel,
  onRetry,
  onLookUp,
  onOpenThread,
  onOpenLocated,
  onPreview
}: {
  status: NumberStatus
  onCancel: () => void
  onRetry: () => void
  onLookUp: () => void
  onOpenThread: (event: MouseEvent) => void
  onOpenLocated: (location: Located, event: MouseEvent) => void
  onPreview: (postId: PostId) => void
}) {
  if (status.kind === 'invalid') {
    return (
      <Status tone="error">
        <p className="online-search-status-title">无法识别为串号</p>
        <p className="online-search-status-detail">请输入 1–20 位数字（可带 No. 或 &gt;&gt;No.），或 X 岛串链接</p>
      </Status>
    )
  }
  const no = `No.${status.target.postId}`
  const cancel = (
    <button type="button" className="btn btn-small btn-page" onClick={onCancel}>
      取消
    </button>
  )
  const preview = (
    <button type="button" className="btn btn-small btn-page" onClick={() => onPreview(status.target.postId)}>
      预览 {no}
    </button>
  )
  const openThread = (known: KnownThread) => (
    <button type="button" className="btn btn-small btn-page" onClick={onOpenThread}>
      打开原串 No.{known.threadId}
    </button>
  )
  const lookUp = canLookUp(status) ? (
    <button type="button" className="btn btn-small btn-page" onClick={onLookUp}>
      <Icon name="search" size={14} />
      {status.kind === 'unknown-thread' ? '向 XDS 查询所属串' : '重新向 XDS 查询'}
    </button>
  ) : null
  const disclosure = <p className="online-search-status-detail">查询会把串号 {no} 发给第三方服务 XDS（{XDS_HOST}）</p>

  let body: ReactNode
  let actions: ReactNode = null
  switch (status.kind) {
    case 'locating':
      body = <Loading live={false}>正在定位 {no}…（Esc 取消）</Loading>
      actions = cancel
      break
    case 'looking-up':
      body = <Loading live={false}>正在向 XDS 查询 {no} 所属的串…（Esc 取消）</Loading>
      actions = cancel
      break
    case 'opening':
      body = <Loading live={false}>正在打开原串 No.{status.known.threadId}…（Esc 取消）</Loading>
      actions = cancel
      break
    case 'located':
      body = (
        <Status tone="info">
          <p className="online-search-status-title">
            已定位：串 No.{status.location.threadId}，{status.location.target.mode === 'po' ? '只看 PO ' : ''}第 {status.location.target.page} 页
          </p>
        </Status>
      )
      actions = (
        <button type="button" className="btn btn-small btn-page" onClick={(event) => onOpenLocated(status.location, event)}>
          <Icon name="arrowRight" size={14} />
          打开
        </button>
      )
      break
    case 'thread-known':
      body = (
        <Status tone="info">
          <p className="online-search-status-title">
            {status.known.via === 'xds' ? `XDS 显示 ${no} 属于串 No.${status.known.threadId}，但没有在该串中定位到它` : `已知原串 No.${status.known.threadId}，但没有在该串中定位到 ${no}`}
          </p>
        </Status>
      )
      actions = (
        <>
          {openThread(status.known)}
          {preview}
        </>
      )
      break
    case 'unconfirmed':
      body = (
        <Status tone="info">
          <p className="online-search-status-title">XDS 显示 {no} 属于串 No.{status.known.threadId}，但论坛没有确认</p>
        </Status>
      )
      actions = (
        <>
          {openThread(status.known)}
          {preview}
        </>
      )
      break
    case 'unknown-thread':
      body = (
        <Status tone="info">
          <p className="online-search-status-title">本机记录无法确认 {no} 所属的串</p>
          {disclosure}
        </Status>
      )
      actions = (
        <>
          {lookUp}
          {preview}
        </>
      )
      break
    case 'not-indexed':
      body = (
        <Status tone="info">
          <p className="online-search-status-title">XDS 没有收录 {no}，无法得知它所属的串</p>
        </Status>
      )
      actions = preview
      break
    case 'search-failed': {
      const { reason, details } = searchErrorLines(status.error, 'XDS')
      body = (
        <Status tone="error">
          <p className="online-search-status-title">查询 {no} 所属的串失败：{reason}</p>
          {details.map((line) => (
            <p key={line} className="online-search-status-detail">
              {line}
            </p>
          ))}
          {disclosure}
        </Status>
      )
      actions = (
        <>
          {lookUp}
          {preview}
        </>
      )
      break
    }
    case 'failed': {
      const { error } = status
      const title =
        error.kind === 'not-found'
          ? `${no} 当前不可用，服务端返回不存在`
          : error.kind === 'permission'
            ? `当前身份无法访问 ${no}`
            : status.via === 'xds' && status.threadId !== null
              ? `XDS 显示 ${no} 属于串 No.${status.threadId}，读取该串失败`
              : `定位 ${no} 失败`
      body = (
        <Status tone="error">
          <p className="online-search-status-title">{title}</p>
          {error.kind !== 'not-found' && error.kind !== 'permission' && <p className="online-search-status-detail">{readReason(error)}</p>}
          {status.via === 'xds' && disclosure}
        </Status>
      )
      const retry =
        status.via === 'xds' ? (
          lookUp
        ) : error.kind === 'not-found' || error.kind === 'permission' ? null : (
          <button type="button" className="btn btn-small btn-page" onClick={onRetry}>
            <Icon name="refresh" size={14} />
            重试
          </button>
        )
      actions = (
        <>
          {retry}
          {preview}
        </>
      )
      break
    }
    case 'open-failed':
      body = (
        <Status tone="error">
          <p className="online-search-status-title">{status.error === null ? '打开原串失败' : `原串 No.${status.known.threadId} 读取失败`}</p>
          <p className="online-search-status-detail">{status.error === null ? '原因：应用内部请求失败' : readReason(status.error)}</p>
        </Status>
      )
      actions = (
        <>
          <button type="button" className="btn btn-small btn-page" onClick={onOpenThread}>
            <Icon name="refresh" size={14} />
            重试打开原串
          </button>
          {preview}
        </>
      )
      break
    case 'internal':
      body = (
        <Status tone="error">
          <p className="online-search-status-title">{status.action === 'lookup' ? `查询 ${no} 所属的串失败` : `定位 ${no} 失败`}</p>
          <p className="online-search-status-detail">原因：应用内部请求失败</p>
        </Status>
      )
      actions =
        status.action === 'lookup' ? (
          lookUp
        ) : (
          <button type="button" className="btn btn-small btn-page" onClick={onRetry}>
            <Icon name="refresh" size={14} />
            重试
          </button>
        )
      break
  }
  return (
    <div className="number-open-result">
      {body}
      {actions !== null && <div className="online-search-hit-actions">{actions}</div>}
    </div>
  )
}

/** The asked post as the forum gives it now (or its stored copy): static text, never a located target. */
function NumberPreview({ preview, onRetry }: { preview: PreviewState; onRetry: () => void }) {
  const outcome = preview.outcome
  if (outcome === null) {
    if (!preview.internal) return <Loading live={false}>正在读取 No.{preview.postId}…</Loading>
    return (
      <div className="number-open-result">
        <Status tone="error">
          <p className="online-search-status-title">No.{preview.postId} 的内容读取失败</p>
          <p className="online-search-status-detail">原因：应用内部请求失败</p>
        </Status>
        <div className="online-search-hit-actions">
          <button type="button" className="btn btn-small btn-page" onClick={onRetry}>
            重试
          </button>
        </div>
      </div>
    )
  }
  if (outcome.status === 'cancelled') return null
  if (outcome.status === 'failed') {
    const missing = outcome.error.kind === 'not-found' ? '服务端返回不存在' : outcome.error.kind === 'permission' ? '当前身份无法访问' : null
    return (
      <div className="number-open-result">
        <Status tone="error">
          <p className="online-search-status-title">No.{preview.postId} 的内容读取失败{missing === null ? '' : `：${missing}`}</p>
          {missing === null && <p className="online-search-status-detail">{readReason(outcome.error)}</p>}
        </Status>
        {missing === null && (
          <div className="online-search-hit-actions">
            <button type="button" className="btn btn-small btn-page" onClick={onRetry}>
              重试
            </button>
          </div>
        )}
      </div>
    )
  }
  const post = outcome.data.post
  const name = meaningfulName(post.name)
  return (
    <section className="number-open-preview" aria-label={`No.${post.id} 预览`}>
      {outcome.status === 'cached' && (
        <SourceNotice source={{ status: 'cached', fetchedAt: outcome.fetchedAt, networkError: outcome.networkError }} subject="发言内容" />
      )}
      <div className="quote-card-meta-text">
        {post.userHash !== null && <CookieId cookieId={post.userHash} admin={post.isAdmin === true} />}
        {name !== null && <span className="post-name">{name}</span>}
        {post.createdAt !== null && <span>{formatForumTime(post.createdAt)}</span>}
        <span>No.{post.id}</span>
      </div>
      <Content nodes={post.content} className="number-open-preview-body" />
    </section>
  )
}
