import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { QuoteLocation, ReadError } from '../../../../shared/api'
import type { Post, PostId, ThreadId } from '../../../../shared/forum'
import { formatReminderCount, MAX_EVENTS_PER_GROUP, type ReminderEvent, type ThreadReminderGroup } from '../../../../shared/reminders'
import { Icon } from '../../components/Icon'
import { IdentitySettingsAction, Loading } from '../../components/Notices'
import { describeReadError, formatLocalTime } from '../../lib/format'
import { ContentRegistryContext, useRegisterContent } from '../tabs/contentRegistry'
import type { ThreadOpen } from '../tabs/tabsState'
import { savedStart, startPage } from '../thread/readingStart'
import { ReminderMenu } from './ReminderMenu'
import {
  emptyText,
  enabledKinds,
  hasCoverageProblem,
  ISSUE_TEXT,
  KIND_NAME,
  KIND_SHORT,
  notificationText,
  overviewHasCoverageProblem,
  progressText,
  refusalText,
  roundOutcomeText,
  secondsText,
  STATE_NAME,
  stateDetail
} from './reminderText'
import { failureText, useRemindersContext } from './useReminders'
import { useListOpener } from './openList'
// PROTOTYPE (throwaway): no read/unread surface (#20).
import { PROTOTYPE_ENABLED } from '../directory/prototype/prototypeStore'
import '../feed/feed.css'
import './reminders.css'

/**
 * Opening one event: the post is located with the quote rules (`quotes.locate`) and navigation is
 * committed only once it was located; anything else stays here as an inline state. As with quotes,
 * a 重试 after a failure only resolves: a located result is shown here and the user opens it.
 * 打开原串 (owner known, post not located) commits only after the resume page was obtained.
 */
type LocateIntent = 'navigate' | 'resolve'

interface OpenState {
  postId: PostId
  seq: number
  busy: 'locate' | 'thread' | null
  /** Settled locate result other than `cancelled`; `located` only after a 重试 (resolve). */
  result: Exclude<QuoteLocation, { status: 'cancelled' }> | null
  /** 打开原串 failed to read the page the thread resumes at. */
  threadError: { threadId: ThreadId; head: Post; error: ReadError } | null
  /** The IPC call itself rejected. */
  internal: 'locate' | 'thread' | null
}

function unavailableText(error: ReadError): string | null {
  if (error.kind === 'not-found') return '这条回复当前不可用，服务端返回不存在'
  if (error.kind === 'permission') return '当前身份无法访问这条回复'
  return null
}

function groupTitle(group: ThreadReminderGroup): string {
  return group.title === null || group.title.trim() === '' ? `No.${group.threadId}` : group.title
}

/**
 * 提醒 list: checker status and actions, then reminder events grouped by thread with each thread's
 * rules and coverage state. Refreshed by `reminders.onChanged` only (no polling); nothing here marks
 * a post read, and opening an event never does either.
 */
export function ReminderPane({
  entryKey,
  selectedThreadId,
  onOpenTarget
}: {
  entryKey: number
  selectedThreadId: ThreadId | null
  /** Commits navigation to a thread; false when this list's entry is no longer current. */
  onOpenTarget: (thread: ThreadOpen) => boolean
}) {
  const { overview, failure, reload } = useRemindersContext()
  const openList = useListOpener()
  const registry = useContext(ContentRegistryContext)
  const headingId = useId()
  useRegisterContent('lists', entryKey, { refresh: () => void reload() })

  // ---------- Scroll memory (runtime and restored after a quit) ----------
  const scrollRef = useRef<HTMLDivElement>(null)
  const [initialScroll] = useState(() => {
    const memory = registry?.listMemory.get(entryKey)
    if (memory?.kind === 'reminders') return memory.scrollTop
    return registry?.savedLists.get(entryKey)?.scrollTop ?? 0
  })
  const scrollTop = useRef(initialScroll)
  const placed = useRef(false)
  const known = overview !== null
  useLayoutEffect(() => {
    const scroller = scrollRef.current
    if (!known || placed.current || scroller === null) return
    placed.current = true
    scroller.scrollTop = scrollTop.current
    registry?.savedLists.delete(entryKey)
  }, [known, registry, entryKey])
  useLayoutEffect(() => {
    registry?.listMemory.set(entryKey, { kind: 'reminders', scrollTop: scrollTop.current })
  })
  const onScroll = () => {
    const scroller = scrollRef.current
    if (scroller === null || scroller.clientHeight === 0 || !placed.current) return
    scrollTop.current = scroller.scrollTop
    registry?.listMemory.set(entryKey, { kind: 'reminders', scrollTop: scrollTop.current })
  }

  // ---------- Check / cancel ----------
  const [request, setRequest] = useState<'check' | 'cancel' | null>(null)
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'warn' | 'error' } | null>(null)
  /** End of the cooldown on the monotonic clock, for display only: nothing is retried when it ends. */
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null)
  const [now, setNow] = useState(() => performance.now())
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (overview === null) return
    const at = performance.now()
    setNow(at)
    setCooldownUntil(overview.checker.cooldownRemainingMs > 0 ? at + overview.checker.cooldownRemainingMs : null)
  }, [overview])
  // Counts the shown seconds down; it never reads anything and never starts a check.
  useEffect(() => {
    if (cooldownUntil === null) return
    const timer = window.setInterval(() => {
      const at = performance.now()
      setNow(at)
      if (at >= cooldownUntil) window.clearInterval(timer)
    }, 1000)
    return () => window.clearInterval(timer)
  }, [cooldownUntil])
  const cooldownLeft = cooldownUntil === null ? 0 : Math.max(0, cooldownUntil - now)

  const startCheck = async () => {
    if (request !== null) return
    setRequest('check')
    setMessage(null)
    try {
      const result = await window.xidao.reminders.check()
      if (!alive.current) return
      if (result.accepted) {
        // The running check shows its own progress, then its outcome: no separate “started” line.
        setMessage(null)
      } else {
        setMessage({ text: refusalText(result), tone: result.reason === 'storage' ? 'error' : 'warn' })
        if (result.reason === 'cooldown' && result.retryAfterMs > 0) {
          const at = performance.now()
          setNow(at)
          setCooldownUntil(at + result.retryAfterMs)
        }
      }
    } catch {
      if (alive.current) setMessage({ text: '检查请求失败：应用内部请求失败，没有开始检查', tone: 'error' })
    } finally {
      if (alive.current) setRequest(null)
    }
    void reload()
  }

  const cancelCheck = async () => {
    if (request !== null) return
    setRequest('cancel')
    setMessage(null)
    try {
      await window.xidao.reminders.cancel()
      if (alive.current) setMessage({ text: '已请求取消：已确认的结果和缺口会保留', tone: 'info' })
    } catch {
      if (alive.current) setMessage({ text: '取消请求失败：应用内部请求失败，检查可能仍在进行', tone: 'error' })
    } finally {
      if (alive.current) setRequest(null)
    }
    void reload()
  }

  // ---------- Opening events ----------
  const [open, setOpen] = useState<OpenState | null>(null)
  const openRef = useRef<OpenState | null>(null)
  const seq = useRef(0)
  const update = useCallback((next: OpenState | null) => {
    openRef.current = next
    setOpen(next)
  }, [])
  const operationId = (at: number) => `reminder-open-${entryKey}-${at}`
  const isCurrent = (at: number) => openRef.current?.seq === at && alive.current

  /** Cancels a running locate / 打开原串; its late result is ignored. */
  const cancelOpen = useCallback(() => {
    const current = openRef.current
    if (current === null || current.busy === null) return
    window.xidao.reading.cancel({ operationId: `reminder-open-${entryKey}-${current.seq}` }).catch(() => undefined)
    update(null)
  }, [entryKey, update])
  useEffect(() => cancelOpen, [cancelOpen])

  /** Commits the navigation of a located result (the same step a first successful click takes). */
  const commitLocated = (result: Extract<QuoteLocation, { status: 'located' }>) => {
    const target = { postId: result.target.postId, page: result.target.page, mode: result.target.mode }
    onOpenTarget({ threadId: result.threadId, head: result.head, target, snapshot: null, unlocatedPostId: null })
  }

  const locate = (postId: PostId, intent: LocateIntent) => {
    cancelOpen()
    const at = ++seq.current
    update({ postId, seq: at, busy: 'locate', result: null, threadError: null, internal: null })
    window.xidao.quotes.locate({ operationId: operationId(at), postId }).then(
      (result) => {
        if (!isCurrent(at) || result.status === 'cancelled') return
        if (result.status !== 'located' || intent === 'resolve') {
          update({ postId, seq: at, busy: null, result, threadError: null, internal: null })
          return
        }
        update(null)
        commitLocated(result)
      },
      () => {
        if (isCurrent(at)) update({ postId, seq: at, busy: null, result: null, threadError: null, internal: 'locate' })
      }
    )
  }

  /** 打开 on a result located by a 重试: commits now, as a first successful click would. */
  const openLocated = (postId: PostId) => {
    const current = openRef.current
    if (current === null || current.postId !== postId || current.busy !== null || current.result?.status !== 'located') return
    const result = current.result
    update(null)
    commitLocated(result)
  }

  /** 打开原串 for a post whose thread is known: commits once the resume page was obtained. */
  const openThread = (postId: PostId, threadId: ThreadId, head: Post) => {
    cancelOpen()
    const at = ++seq.current
    update({ postId, seq: at, busy: 'thread', result: null, threadError: null, internal: null })
    const run = async () => {
      const reading = await window.xidao.readingState.get({ threadId }).catch(() => null)
      if (!isCurrent(at)) return
      const start = savedStart(reading, reading?.mode ?? 'all')
      const outcome = await window.xidao.reading.readThreadPage({ operationId: operationId(at), threadId, mode: start.mode, page: startPage(start.position) })
      if (!isCurrent(at) || outcome.status === 'cancelled') return
      if (outcome.status === 'failed') {
        update({ postId, seq: at, busy: null, result: null, threadError: { threadId, head, error: outcome.error }, internal: null })
        return
      }
      update(null)
      onOpenTarget({ threadId, head, target: null, snapshot: null, unlocatedPostId: postId })
    }
    run().catch(() => {
      if (isCurrent(at)) update({ postId, seq: at, busy: null, result: { status: 'thread-known', threadId, head }, threadError: null, internal: 'thread' })
    })
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || openRef.current?.busy == null) return
    event.preventDefault()
    event.stopPropagation()
    cancelOpen()
  }

  // ---------- Render ----------
  const running = overview?.checker.running === true
  const round = overview?.currentRound ?? null
  const coverageProblem = overview !== null && overviewHasCoverageProblem(overview)
  const empty = overview !== null && overview.threads.length === 0
  const notification = overview?.lastNotification != null ? notificationText(overview.lastNotification) : null
  /** After a check: one line only — the click's own refusal, else a failed notification, else the round's outcome. */
  const result: { text: string; tone: 'info' | 'warn' | 'error' } | null = running
    ? null
    : message !== null
      ? message
      : notification?.warn === true
        ? { text: notification.text, tone: 'warn' }
        : overview?.lastRound != null
          ? { text: roundOutcomeText(overview.lastRound), tone: 'info' }
          : null

  return (
    <section className="list-pane reminder-pane" aria-labelledby={headingId}>
      <div className="list-scroll" ref={scrollRef} onScroll={onScroll} onKeyDown={onKeyDown} tabIndex={-1} data-pane-focus="">
        <header className="list-header">
          <div className="list-title-row">
            <h2 className="list-title" id={headingId}>
              <span className="list-name">提醒</span>
            </h2>
            {overview !== null && (!PROTOTYPE_ENABLED || coverageProblem) && (
              <p className="reminder-total">
                {!PROTOTYPE_ENABLED && (overview.totalUnread > 0 ? `${formatReminderCount(overview.totalUnread)} 条未读提醒` : '没有未读提醒')}
                {coverageProblem && (
                  <span className="reminder-total-note">
                    <Icon name="alert" size={13} />
                    部分串覆盖不完整
                  </span>
                )}
              </p>
            )}
          </div>
        </header>

        <div className="reminder-checker">
          <div className="reminder-checker-row">
            {running ? (
              <button type="button" className="btn btn-small" aria-busy={request === 'cancel' || undefined} onClick={() => void cancelCheck()}>
                <Icon name="close" size={14} />
                {request === 'cancel' ? '正在取消…' : '取消检查'}
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-small btn-quiet"
                aria-busy={request === 'check' || undefined}
                disabled={overview === null}
                onClick={() => void startCheck()}
              >
                <Icon name="refresh" size={14} />
                {request === 'check' ? '正在开始…' : '检查更新'}
              </button>
            )}
            <div className="reminder-checker-status" role="status">
              {running && round !== null && <Loading live={false}>{progressText(round)}</Loading>}
              {running && round === null && <Loading live={false}>正在检查…</Loading>}
            </div>
            {/* Counts down every second: deliberately outside any live region. */}
            {!running && cooldownLeft > 0 && <p className="reminder-checker-line">{secondsText(cooldownLeft)}后可再次检查</p>}
          </div>
          {result !== null && (
            <p className={`reminder-checker-message is-${result.tone}`} role={result.tone === 'error' ? 'alert' : 'status'}>
              {result.tone !== 'info' && <Icon name="alert" size={14} />}
              <span>{result.text}</span>
            </p>
          )}
        </div>

        {/* Prototype: the first read is quiet; only a failure says anything. */}
        <div className="list-status" aria-busy={PROTOTYPE_ENABLED && overview === null && failure === null ? true : undefined}>
          {!PROTOTYPE_ENABLED && overview === null && failure === null && <Loading>正在读取提醒…</Loading>}
          {failure !== null && (
            <div className="notice notice-error is-compact" role="alert">
              <Icon name="alert" className="notice-icon" />
              <p className="notice-text">
                {overview === null ? '提醒读取失败' : '提醒更新失败，仍显示之前的内容'}：{failureText(failure)}
              </p>
              <button type="button" className="btn btn-small" onClick={() => void reload()}>
                重试
              </button>
            </div>
          )}
        </div>

        {empty && (
          <div className="list-empty" role="status">
            <p className="list-empty-title">还没有开启提醒的串</p>
            {openList !== null && (
              <button type="button" className="btn reminder-empty-action" onClick={() => openList({ kind: 'subscriptions' })}>
                去订阅的串
              </button>
            )}
          </div>
        )}

        {overview !== null && overview.threads.length > 0 && (
          <div className="reminder-groups">
            {overview.threads.map((group) => (
              <ReminderGroup
                key={group.threadId}
                group={group}
                selected={group.threadId === selectedThreadId}
                open={open !== null && group.events.some((event) => event.postId === open.postId) ? open : null}
                onLocate={locate}
                onOpenLocated={openLocated}
                onOpenThread={openThread}
                onCancelOpen={cancelOpen}
                onDismissOpen={() => update(null)}
                onRulesUpdated={() => void reload()}
              />
            ))}
          </div>
        )}
        <div className="list-footer" />
      </div>
    </section>
  )
}

function ReminderGroup({
  group,
  selected,
  open,
  onLocate,
  onOpenLocated,
  onOpenThread,
  onCancelOpen,
  onDismissOpen,
  onRulesUpdated
}: {
  group: ThreadReminderGroup
  selected: boolean
  open: OpenState | null
  onLocate: (postId: PostId, intent: LocateIntent) => void
  onOpenLocated: (postId: PostId) => void
  onOpenThread: (postId: PostId, threadId: ThreadId, head: Post) => void
  onCancelOpen: () => void
  onDismissOpen: () => void
  onRulesUpdated: () => void
}) {
  const titleId = useId()
  const title = groupTitle(group)
  const on = enabledKinds(group.rules)
  const problem = hasCoverageProblem(group)
  const tone = group.state === 'failed' ? 'is-error' : problem || group.state === 'baseline-pending' ? 'is-warning' : ''
  return (
    <section className={selected ? 'reminder-group is-selected' : 'reminder-group'} aria-labelledby={titleId}>
      <div className="reminder-group-head">
        <div className="reminder-group-text">
          <h3 className="reminder-group-title" id={titleId}>
            {title}
          </h3>
          <p className="reminder-group-meta">
            <span>No.{group.threadId}</span>
            {group.lastCheckedAt !== null && <span>最近检查 {formatLocalTime(group.lastCheckedAt)}</span>}
          </p>
        </div>
        <ReminderMenu
          threadId={group.threadId}
          label={title}
          rules={group.rules}
          failure={null}
          onRetry={onRulesUpdated}
          onUpdated={onRulesUpdated}
          small
        />
      </div>

      {on.length > 0 ? (
        <ul className="reminder-chips" aria-label="已开启的提醒">
          {on.map((kind) => (
            <li key={kind} className="reminder-chip">
              {KIND_SHORT[kind]}
              {group.rules[kind].startedAt !== null && <span className="reminder-chip-start">起点 {formatLocalTime(group.rules[kind].startedAt as string)}</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="reminder-group-line">提醒已全部关闭；下面保留之前的结果，不会再检查。</p>
      )}

      <div className={`reminder-state ${tone}`}>
        <p className="reminder-state-name">
          {group.state === 'checking' ? <Loading live={false}>{STATE_NAME.checking}</Loading> : <span className="tag">{STATE_NAME[group.state]}</span>}
          <span className="reminder-state-detail">{stateDetail(group)}</span>
        </p>
        {group.issues.length > 0 && (
          <ul className="reminder-issues" aria-label="覆盖问题">
            {group.issues.map((issue) => (
              <li key={issue}>
                <Icon name="alert" size={13} />
                {ISSUE_TEXT[issue]}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="reminder-counts">
        {PROTOTYPE_ENABLED ? (
          <span>{group.eventCount > 0 ? `${formatReminderCount(group.eventCount)} 条提醒` : emptyText(group)}</span>
        ) : group.unreadCount > 0 ? (
          <span className="reminder-unread">{formatReminderCount(group.unreadCount)} 条未读</span>
        ) : group.eventCount > 0 ? (
          <span>没有未读提醒</span>
        ) : (
          <span>{emptyText(group)}</span>
        )}
        {group.uncertainCount > 0 && (
          <span className="reminder-uncertain">
            <Icon name="alert" size={13} />
            另有 {group.uncertainCount} 条无法确认是否在提醒起点之后
          </span>
        )}
      </p>

      {group.events.length > 0 && (
        <ul className="reminder-events" aria-label={`${title} 的提醒，共 ${group.eventCount} 条`}>
          {group.events.map((event) => (
            <li key={event.postId}>
              <EventRow
                event={event}
                open={open?.postId === event.postId ? open : null}
                onLocate={onLocate}
                onOpenLocated={onOpenLocated}
                onOpenThread={onOpenThread}
                onCancelOpen={onCancelOpen}
                onDismissOpen={onDismissOpen}
              />
            </li>
          ))}
        </ul>
      )}
      {group.eventCount > group.events.length && (
        <p className="reminder-group-line">
          只列出最新的 {Math.min(group.events.length, MAX_EVENTS_PER_GROUP)} 条，共 {group.eventCount} 条
        </p>
      )}
    </section>
  )
}

function EventRow({
  event,
  open,
  onLocate,
  onOpenLocated,
  onOpenThread,
  onCancelOpen,
  onDismissOpen
}: {
  event: ReminderEvent
  open: OpenState | null
  onLocate: (postId: PostId, intent: LocateIntent) => void
  onOpenLocated: (postId: PostId) => void
  onOpenThread: (postId: PostId, threadId: ThreadId, head: Post) => void
  onCancelOpen: () => void
  onDismissOpen: () => void
}) {
  const statusId = useId()
  const busy = open?.busy ?? null
  return (
    <>
      <button
        type="button"
        className={event.read || PROTOTYPE_ENABLED ? 'reminder-event' : 'reminder-event is-unread'}
        aria-describedby={open !== null ? statusId : undefined}
        aria-busy={busy !== null || undefined}
        onClick={() => onLocate(event.postId, 'navigate')}
      >
        <span className="reminder-event-top">
          {!PROTOTYPE_ENABLED && <span className={event.read ? 'tag' : 'tag tag-po'}>{event.read ? '已读' : '未读'}</span>}
          {event.kinds.map((kind) => (
            <span key={kind} className="reminder-event-kind">
              {KIND_NAME[kind]}
            </span>
          ))}
          <span className="reminder-event-time">{event.createdAt ?? '时间未知'}</span>
        </span>
        <span className="reminder-event-excerpt">{event.excerpt.trim() === '' ? '（没有文字内容）' : event.excerpt}</span>
        <span className="reminder-event-meta">
          <span>No.{event.postId}</span>
          <span>
            {event.mode === 'po' ? '只看 PO ' : ''}第 {event.page} 页
          </span>
          {event.quotedOwnIds.length > 0 && <span>引用了你的 {event.quotedOwnIds.map((id) => `No.${id}`).join('、')}</span>}
        </span>
      </button>
      {open !== null && (
        <div className="reminder-open" id={statusId} role="status">
          <OpenStatus
            open={open}
            onLocate={onLocate}
            onOpenLocated={onOpenLocated}
            onOpenThread={onOpenThread}
            onCancel={onCancelOpen}
            onDismiss={onDismissOpen}
          />
        </div>
      )}
    </>
  )
}

function OpenStatus({
  open,
  onLocate,
  onOpenLocated,
  onOpenThread,
  onCancel,
  onDismiss
}: {
  open: OpenState
  onLocate: (postId: PostId, intent: LocateIntent) => void
  onOpenLocated: (postId: PostId) => void
  onOpenThread: (postId: PostId, threadId: ThreadId, head: Post) => void
  onCancel: () => void
  onDismiss: () => void
}) {
  const { postId } = open
  if (open.busy !== null) {
    return (
      <div className="reminder-open-row">
        <Loading live={false}>{open.busy === 'locate' ? '正在定位这条回复…（Esc 取消）' : '正在打开原串…（Esc 取消）'}</Loading>
        <button type="button" className="btn btn-small" onClick={onCancel}>
          取消
        </button>
      </div>
    )
  }
  const dismiss = (
    <button type="button" className="btn btn-small btn-quiet" onClick={onDismiss}>
      关闭
    </button>
  )
  if (open.internal !== null) {
    return (
      <div className="reminder-open-row is-error">
        <p className="reminder-open-text">
          <Icon name="alert" size={14} />
          {open.internal === 'thread' ? '打开原串失败' : '定位失败'}：应用内部请求失败，没有跳转
        </p>
        <button
          type="button"
          className="btn btn-small"
          // A 重试 only resolves (spec I6): a located result is shown, opening it stays the user's choice.
          onClick={() => (open.internal === 'thread' && open.result?.status === 'thread-known' ? onOpenThread(postId, open.result.threadId, open.result.head) : onLocate(postId, 'resolve'))}
        >
          重试
        </button>
        {dismiss}
      </div>
    )
  }
  if (open.threadError !== null) {
    const { threadId, head, error } = open.threadError
    return (
      <div className="reminder-open-row is-error">
        <p className="reminder-open-text">
          <Icon name="alert" size={14} />
          原串读取失败：{describeReadError(error)}
          {error.serverMessage !== undefined && `；论坛提示：${error.serverMessage}`}，没有跳转
        </p>
        <IdentitySettingsAction error={error} />
        <button type="button" className="btn btn-small" onClick={() => onOpenThread(postId, threadId, head)}>
          重试
        </button>
        {dismiss}
      </div>
    )
  }
  const result = open.result
  if (result === null) return null
  switch (result.status) {
    case 'located':
      return (
        <div className="reminder-open-row">
          <p className="reminder-open-text">
            <Icon name="check" size={14} />
            已定位：串 No.{result.threadId}，{result.target.mode === 'po' ? '只看 PO ' : ''}第 {result.target.page} 页
            {result.source === 'cached' && result.networkError !== null && `（依据本地缓存的页面：${describeReadError(result.networkError)}）`}
          </p>
          <button type="button" className="btn btn-small" onClick={() => onOpenLocated(postId)}>
            <Icon name="arrowRight" size={14} />
            打开
          </button>
          {dismiss}
        </div>
      )
    case 'unknown-thread':
      return (
        <div className="reminder-open-row">
          <p className="reminder-open-text">
            <Icon name="info" size={14} />
            暂时无法确定这条回复属于哪个串，没有跳转
          </p>
          {dismiss}
        </div>
      )
    case 'thread-known':
      return (
        <div className="reminder-open-row">
          <p className="reminder-open-text">
            <Icon name="info" size={14} />
            已知原串 No.{result.threadId}，暂未定位到这条回复；可以按正常续读位置打开原串
          </p>
          <button type="button" className="btn btn-small" onClick={() => onOpenThread(postId, result.threadId, result.head)}>
            打开原串
          </button>
          {dismiss}
        </div>
      )
    case 'failed': {
      const unavailable = unavailableText(result.error)
      return (
        <div className="reminder-open-row is-error">
          <p className="reminder-open-text">
            <Icon name="alert" size={14} />
            {unavailable ?? `定位失败：${describeReadError(result.error)}${result.error.serverMessage !== undefined ? `；论坛提示：${result.error.serverMessage}` : ''}`}
            ，没有跳转
          </p>
          <IdentitySettingsAction error={result.error} />
          {unavailable === null && (
            <button type="button" className="btn btn-small" onClick={() => onLocate(postId, 'resolve')}>
              重试
            </button>
          )}
          {dismiss}
        </div>
      )
    }
  }
}
