// The 新串 and 回复 pages of 历史: sends to that kind of target. Those 待核对 (sending, result
// unknown, number unconfirmed) come first, each ended only by the user's 已发出 or 没发出; then the
// successful sends, newest first, in the thread lists' row. Failed sends are not listed: their
// content lives in 草稿. Everything shown comes from the attempt's own payload and the local
// cookies; nothing is fetched to complete a row, and nothing here sends.

import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import type { Post, PostId, ThreadId } from '../../../../shared/forum'
import { isPending, type PendingChoice, type PublicationAttempt, type ResolvePendingResult } from '../../../../shared/publication'
import { ContextMenu, contextMenuPoint, type ContextMenuPoint } from '../../components/ContextMenu'
import { Icon, Spinner } from '../../components/Icon'
import { meaningfulName, meaningfulTitle } from '../../lib/format'
import { formatRecordTime } from '../../lib/time'
import { useRovingFocus } from '../../lib/useRovingFocus'
import { historyMemory, rememberHistory } from '../content/retainedList'
import { forumLabel } from '../editor/editorText'
import { useEditorWorkspace } from '../editor/workspace'
import { ContentRegistryContext } from '../tabs/contentRegistry'
import { listRowGestures } from '../tabs/ThreadTabMenu'
import type { EntryInit, ThreadOpen } from '../tabs/tabsState'
import { ATTEMPT_PROBLEM_TEXT, PENDING_MARK, resolveFailureText } from './publicationText'
import { parsePostIdInput, recordCookie, recordPlace, type SentKind } from './sentRecords'
import '../feed/feed.css'
import '../identity/identity.css'
import '../content/content.css'
import './publication.css'

export type SentListState = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; attempts: PublicationAttempt[] }

/** How often the list is read again while one of its attempts is still sending (local query). */
const POLL_MS = 1000

const PAGE_TEXT: Record<SentKind, { title: string; empty: string }> = {
  thread: { title: '新串', empty: '还没有发出的新串' },
  reply: { title: '回复', empty: '还没有发出的回复' }
}

/**
 * Every attempt of this machine, newest first, for the 新串／回复 pages: read once `enabled` (one of
 * them was shown), again on each publication change of this window and each `refreshRevision`, and
 * every second while one is still sending. A failed re-read keeps the list (`readFailed`).
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

  const sending = list.status === 'ready' && list.attempts.some((attempt) => attempt.state === 'sending')
  useEffect(() => {
    if (!sending) return
    const timer = window.setInterval(() => void load(true), POLL_MS)
    return () => window.clearInterval(timer)
  }, [sending, load])

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
  openInTab
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
}) {
  const registry = useContext(ContentRegistryContext)
  const view = kind === 'thread' ? 'threads' : 'replies'
  const text = PAGE_TEXT[kind]
  const pendingHeadingId = useId()
  const bodyRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const attempts = useMemo(() => (list.status === 'ready' ? list.attempts.filter((attempt) => attempt.payload.target.kind === kind) : []), [list, kind])
  const pending = useMemo(() => attempts.filter(isPending), [attempts])
  const records = useMemo(() => attempts.filter((attempt) => attempt.state === 'confirmed'), [attempts])
  const recordIds = useMemo(() => records.map((attempt) => attempt.id), [records])
  const roving = useRovingFocus(recordIds, null)
  /** What the last 已发出／没发出 here did, or why it did nothing because the list was stale. */
  const [outcome, setOutcome] = useState<{ tone: 'done' | 'warning'; text: string } | null>(null)

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
    setOutcome(null)
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

  // ---------- Row context menu: 在新标签页打开 ----------
  const [rowMenu, setRowMenu] = useState<{ attemptId: string; point: ContextMenuPoint; row: HTMLElement } | null>(null)
  const openRowMenu = (attemptId: string, event: ReactMouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    const row = event.currentTarget.querySelector<HTMLElement>('[data-roving-item]')
    if (row === null || openInTab === null) return
    event.preventDefault()
    // No scrolling into view: a scroll closes the menu that is about to open.
    row.focus({ preventScroll: true })
    setRowMenu({ attemptId, point: contextMenuPoint(event, row), row })
  }
  const closeRowMenu = (returnFocus: boolean) => {
    const row = rowMenu?.row
    setRowMenu(null)
    if (returnFocus && row?.isConnected === true) row.focus()
  }
  const menuAttempt = rowMenu === null ? undefined : records.find((attempt) => attempt.id === rowMenu.attemptId)

  // ---------- Ending 待核对 ----------
  /** After an ended item leaves the list: focus the item now at its place, else the first record. */
  const focusAfter = useRef<{ id: string; index: number } | null>(null)
  useLayoutEffect(() => {
    const after = focusAfter.current
    if (after === null || pending.some((attempt) => attempt.id === after.id)) return
    focusAfter.current = null
    const active = document.activeElement
    if (active !== null && active !== document.body && bodyRef.current?.contains(active) !== true) return
    const items = bodyRef.current?.querySelectorAll<HTMLElement>('[data-pending-first]') ?? []
    const next = items[Math.min(after.index, items.length - 1)] ?? listRef.current?.querySelector<HTMLElement>('[data-roving-item][tabindex="0"]') ?? bodyRef.current
    next?.focus()
  }, [pending])

  return (
    <section className="list-pane retained-page sent-page" aria-label={text.title} aria-busy={list.status === 'loading' || undefined}>
      <div className="list-scroll" ref={bodyRef} onScroll={onScroll} tabIndex={-1}>
        <div className="list-status">
          {outcome !== null && (
            <p className={outcome.tone === 'done' ? 'notice-inline' : 'notice-inline is-warning'} role="status">
              <Icon name={outcome.tone === 'done' ? 'check' : 'alert'} size={14} />
              {outcome.text}
            </p>
          )}
          {(list.status === 'failed' || readFailed) && (
            <div className="notice notice-error is-compact" role="alert">
              <Icon name="alert" className="notice-icon" />
              <p className="notice-text">发送记录读取失败：本地存储不可用</p>
              <button type="button" className="btn btn-small" onClick={() => onReload(list.status === 'ready')}>
                重试
              </button>
            </div>
          )}
        </div>

        {pending.length > 0 && (
          <section className="pending-group" aria-labelledby={pendingHeadingId}>
            <h3 className="pending-heading" id={pendingHeadingId}>
              待核对
              <span className="pending-count">{pending.length}</span>
            </h3>
            <ul className="pending-list">
              {pending.map((attempt, index) => (
                <PendingItem
                  key={attempt.id}
                  attempt={attempt}
                  kind={kind}
                  onResolved={(choice) => {
                    focusAfter.current = { id: attempt.id, index }
                    setOutcome({ tone: 'done', text: choice === 'sent' ? '已标为已发出' : '已转入草稿，可在草稿中继续编辑' })
                  }}
                  onStale={() => {
                    setOutcome({ tone: 'warning', text: resolveFailureText('not-pending', kind) })
                    onReload(true)
                  }}
                />
              ))}
            </ul>
          </section>
        )}

        {list.status === 'ready' && pending.length === 0 && records.length === 0 && (
          <div className="list-empty" role="status">
            <p className="list-empty-title">{text.empty}</p>
          </div>
        )}

        {records.length > 0 && (
          <ul className="thread-list" ref={listRef} aria-label={`${text.title}发送记录`} onKeyDown={roving.onKeyDown}>
            {records.map((attempt) => (
              <li
                key={attempt.id}
                className={rowMenu?.attemptId === attempt.id ? 'history-row is-menu-open' : 'history-row'}
                {...listRowGestures((event) => openRowMenu(attempt.id, event), openInTab === null ? null : () => open(attempt, true))}
              >
                <button
                  type="button"
                  className="thread-row"
                  aria-busy={locating === attempt.id || undefined}
                  onClick={() => open(attempt, false)}
                  {...roving.itemProps(attempt.id)}
                >
                  <RecordSummary
                    attempt={attempt}
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
              </li>
            ))}
          </ul>
        )}
        <div className="list-footer" />
      </div>
      {rowMenu !== null && menuAttempt !== undefined && openInTab !== null && (
        <ContextMenu
          key={`menu:${rowMenu.attemptId}`}
          point={rowMenu.point}
          label={`发送记录操作：${recordLabel(menuAttempt)}`}
          items={[{ type: 'action', key: 'open-tab', label: '在新标签页打开', onSelect: () => open(menuAttempt, true) }]}
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
 * and time, bold title and name when given, the content with its line breaks, then the target (forum
 * or 回复 No.x) and whether it had an image.
 */
function RecordSummary({ attempt, metaEnd }: { attempt: PublicationAttempt; metaEnd?: ReactNode }) {
  const { identities, forumName } = useEditorWorkspace()
  const { payload } = attempt
  const cookie = recordCookie(attempt, identities.overview)
  const title = meaningfulTitle(payload.fields.title)
  const name = meaningfulName(payload.fields.name)
  const content = payload.fields.content.trim()
  const target = payload.target
  return (
    <span className="row-text">
      <span className="row-byline">
        <span className="row-author">
          {cookie?.kind === 'id' && <span className="user-hash">{cookie.text}</span>}
          {cookie?.kind === 'fallback' && <span className="row-cookie-fallback">{cookie.text}</span>}
        </span>
        <span className="row-time">{formatRecordTime(attempt.createdAt)}</span>
      </span>
      {title !== null && <span className="row-title">{title}</span>}
      {name !== null && <span className="row-name">{name}</span>}
      {content !== '' && <span className="row-excerpt is-plain">{content}</span>}
      <span className="row-meta">
        <span className="row-forum">{target.kind === 'thread' ? forumLabel(target.forumId, forumName) : `回复 No.${target.threadId}`}</span>
        {payload.attachmentId !== null && (
          <span className="row-image">
            <Icon name="image" size={13} />
            附图
          </span>
        )}
        {metaEnd}
      </span>
    </span>
  )
}

/**
 * One 待核对 send: its summary, its state in words and the two answers. 已发出 asks for the number
 * (optional, digits only); 没发出 says the content goes to 草稿. Both only change local records.
 * While it is still sending neither can be chosen.
 */
function PendingItem({
  attempt,
  kind,
  onResolved,
  onStale
}: {
  attempt: PublicationAttempt
  kind: SentKind
  onResolved: (choice: PendingChoice) => void
  /** It is no longer 待核对 (ended elsewhere): the list is read again. */
  onStale: () => void
}) {
  const { store, forumName } = useEditorWorkspace()
  const ids = useId()
  const state = attempt.state === 'sending' || attempt.state === 'unknown' || attempt.state === 'unconfirmed' ? attempt.state : 'unknown'
  const sending = state === 'sending'
  const [choice, setChoice] = useState<PendingChoice | null>(null)
  const [value, setValue] = useState('')
  const [inputError, setInputError] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const blocked = sending || submitting
  const alive = useRef(true)
  const sentRef = useRef<HTMLButtonElement>(null)
  const notSentRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // The chosen answer's first control takes focus.
  useLayoutEffect(() => {
    if (choice === 'sent') inputRef.current?.focus()
    else if (choice === 'not-sent') confirmRef.current?.focus()
  }, [choice])

  const choose = (next: PendingChoice) => {
    if (blocked) return
    setFailure(null)
    setInputError(false)
    setChoice((current) => (current === next ? null : next))
  }

  const cancel = () => {
    if (submitting) return
    const opener = choice === 'not-sent' ? notSentRef : sentRef
    setChoice(null)
    setFailure(null)
    setInputError(false)
    opener.current?.focus()
  }

  const resolve = async (next: PendingChoice, postId: PostId | null) => {
    if (blocked) return
    setSubmitting(true)
    setFailure(null)
    let result: ResolvePendingResult | null = null
    try {
      result = await window.xidao.publication.resolvePending({ attemptId: attempt.id, choice: next, postId })
    } catch {
      result = null
    }
    if (!alive.current) return
    if (result?.ok === true) {
      // Stays busy until the list read again drops this item.
      onResolved(next)
      void store.adoptResolved(result.attempt)
      return
    }
    setSubmitting(false)
    if (result?.ok === false && result.reason === 'not-pending') {
      onStale()
      return
    }
    setFailure(resolveFailureText(result === null ? 'internal' : result.reason, kind))
  }

  const submitSent = (event: FormEvent) => {
    event.preventDefault()
    const parsed = parsePostIdInput(value)
    if (!parsed.ok) {
      setInputError(true)
      inputRef.current?.focus()
      return
    }
    void resolve('sent', parsed.postId)
  }

  const onFormKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || submitting) return
    event.preventDefault()
    event.stopPropagation()
    cancel()
  }

  const target = attempt.payload.target
  const what = `${target.kind === 'thread' ? `在「${forumLabel(target.forumId, forumName)}」发新串` : `回复 No.${target.threadId}`}，${formatRecordTime(attempt.createdAt)}`
  const describedBy = `${ids}-what ${ids}-state`
  const sendingTip = sending ? '正在发送，结束后才能选择' : undefined

  return (
    <li className={`pending-item is-${state}`}>
      <RecordSummary attempt={attempt} />
      <span className="visually-hidden" id={`${ids}-what`}>
        {what}
      </span>
      <p className={`pending-state is-${state}`} id={`${ids}-state`}>
        {sending ? <Spinner /> : <Icon name="alert" size={14} />}
        <span>
          {PENDING_MARK[state]}
          {!sending && attempt.problem !== null && `：${ATTEMPT_PROBLEM_TEXT[attempt.problem]}`}
        </span>
      </p>
      <div className="pending-actions">
        <button
          ref={sentRef}
          type="button"
          className="btn btn-small"
          data-pending-first=""
          aria-expanded={choice === 'sent'}
          aria-controls={choice === 'sent' ? `${ids}-form` : undefined}
          aria-disabled={blocked || undefined}
          aria-describedby={describedBy}
          title={sendingTip}
          onClick={() => choose('sent')}
        >
          <Icon name="check" size={14} />
          已发出
        </button>
        <button
          ref={notSentRef}
          type="button"
          className="btn btn-small"
          aria-expanded={choice === 'not-sent'}
          aria-controls={choice === 'not-sent' ? `${ids}-form` : undefined}
          aria-disabled={blocked || undefined}
          aria-describedby={describedBy}
          title={sendingTip}
          onClick={() => choose('not-sent')}
        >
          <Icon name="draft" size={14} />
          没发出
        </button>
      </div>
      {choice === 'sent' && (
        <form className="pending-form" id={`${ids}-form`} onSubmit={submitSent} onKeyDown={onFormKeyDown} noValidate>
          <label className="field-label" htmlFor={`${ids}-input`}>
            {kind === 'thread' ? '新串的串号' : '这条回复的串号'}（可不填）
          </label>
          <div className="pending-form-row">
            <input
              ref={inputRef}
              id={`${ids}-input`}
              className="text-input"
              value={value}
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              placeholder="只填数字"
              readOnly={submitting}
              aria-invalid={inputError || undefined}
              aria-describedby={inputError ? `${ids}-hint ${ids}-error` : `${ids}-hint`}
              onChange={(event) => {
                setValue(event.target.value)
                if (inputError) setInputError(false)
              }}
            />
            <button type="submit" className="btn btn-small btn-primary" aria-disabled={submitting || undefined} aria-busy={submitting || undefined}>
              {submitting ? '正在保存…' : '确认已发出'}
            </button>
            <button type="button" className="btn btn-small" aria-disabled={submitting || undefined} onClick={cancel}>
              取消
            </button>
          </div>
          <p className="field-hint" id={`${ids}-hint`}>
            {kind === 'thread' ? '不填时，这条记录只能打开所在版面的列表。' : '不填时，这条记录只能打开所在串，不能定位到这条回复。'}
          </p>
          {inputError && (
            <p className="form-message is-error" id={`${ids}-error`}>
              <Icon name="alert" size={14} />
              串号只能是数字
            </p>
          )}
        </form>
      )}
      {choice === 'not-sent' && (
        <div className="pending-form" id={`${ids}-form`} role="group" aria-labelledby={`${ids}-draft`} onKeyDown={onFormKeyDown}>
          <p className="field-hint" id={`${ids}-draft`}>
            内容会转入草稿（附图保留），这次发送移出待核对。
          </p>
          <div className="pending-form-row">
            <button
              ref={confirmRef}
              type="button"
              className="btn btn-small btn-primary"
              aria-disabled={submitting || undefined}
              aria-busy={submitting || undefined}
              onClick={() => void resolve('not-sent', null)}
            >
              {submitting ? '正在转入…' : '转入草稿'}
            </button>
            <button type="button" className="btn btn-small" aria-disabled={submitting || undefined} onClick={cancel}>
              取消
            </button>
          </div>
        </div>
      )}
      {failure !== null && (
        <p className="form-message is-error" role="alert">
          <Icon name="alert" size={14} />
          {failure}
        </p>
      )}
    </li>
  )
}
