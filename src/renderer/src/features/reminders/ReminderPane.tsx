// 提醒 as a list page of a tab: the thread lists' row for every thread with an enabled kind, in the
// order the overview gives (counted threads first). The meta line ends with the thread's counts
// (全串:3 PO:2 引用:1) and, when its latest check left something unknown, a warning icon whose
// accessible name and tip give the reasons. Refreshed by `reminders.onChanged` only (no polling).

import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { ForumId, ThreadId } from '../../../../shared/forum'
import type { ReminderThreadRow } from '../../../../shared/reminders'
import { contextMenuPoint, isContextMenuKey, type ContextMenuPoint } from '../../components/ContextMenu'
import { Icon, Spinner } from '../../components/Icon'
import { meaningfulTitle } from '../../lib/format'
import { formatClockTime } from '../../lib/time'
import { SettingsContext } from '../../lib/settingsContext'
import { useRovingFocus } from '../../lib/useRovingFocus'
import { ThreadRow } from '../feed/ThreadRow'
import { useImageScope } from '../image/useImageLoad'
import { ContentRegistryContext, useRegisterContent } from '../tabs/contentRegistry'
import { useOpenThreadInTab } from '../tabs/openThreadInTab'
import type { ThreadOpen } from '../tabs/tabsState'
import { savedStart } from '../thread/readingStart'
import { useListOpener } from './openList'
import { ReminderRowMenu } from './ReminderRowMenu'
import { countsText, hasCounts, issuesText, RATE_LIMIT_TEXT, rateLimitRetry, refusalText, secondsText } from './reminderText'
import { failureText, useRemindersContext } from './useReminders'
import '../feed/feed.css'
import './reminders.css'

const TITLE = '提醒'

/**
 * Coverage issues at the end of the row's meta line: an icon whose accessible name is the reasons
 * (so the row's name ends with them), repeated as a tip on hover or keyboard focus of the row.
 */
function IssueStatus({ text }: { text: string }) {
  return (
    <span className="row-status is-warning">
      <span className="row-status-icon" role="img" aria-label={text}>
        <Icon name="alert" size={14} />
      </span>
      <span className="row-status-tip" aria-hidden="true">
        {text}
      </span>
    </span>
  )
}

export function ReminderPane({
  entryKey,
  forumNames,
  selectedThreadId,
  onOpenThread,
  onOpenTarget
}: {
  entryKey: number
  forumNames: ReadonlyMap<ForumId, string>
  /** The thread shown beside the list (split), highlighted. */
  selectedThreadId: ThreadId | null
  /** Opens a row by the usual resume rules; `head` when held here, shown until page 1 arrives. */
  onOpenThread: (threadId: ThreadId, head: ReminderThreadRow['head']) => void
  /** Opens a row at an explicit target; false when this list's entry is no longer current. */
  onOpenTarget: (thread: ThreadOpen) => boolean
}) {
  const { overview, failure, reload, updated } = useRemindersContext()
  const openList = useListOpener()
  const openInTab = useOpenThreadInTab()
  const registry = useContext(ContentRegistryContext)
  const headingId = useId()
  const checkReasonId = useId()
  useRegisterContent('lists', entryKey, { refresh: () => void reload() })

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // ---------- Scroll memory (runtime and restored after a quit) ----------
  const scrollRef = useRef<HTMLDivElement>(null)
  const images = useImageScope(scrollRef)
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

  // ---------- 手动检查 ----------
  const [requesting, setRequesting] = useState(false)
  const [message, setMessage] = useState<{ text: string; tone: 'warn' | 'error' } | null>(null)
  /** End of the cooldown on the monotonic clock, for display only: nothing is retried when it ends. */
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null)
  const [now, setNow] = useState(() => performance.now())
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
  const running = overview?.checker.running === true
  const blockedReason = running ? '正在检查' : cooldownLeft > 0 ? `${secondsText(cooldownLeft)}后可再次检查` : null
  const blocked = overview === null || requesting || blockedReason !== null
  // A refusal said why the click did nothing; once a check can start again it no longer applies.
  useEffect(() => {
    if (blockedReason === null) setMessage((current) => (current?.tone === 'warn' ? null : current))
  }, [blockedReason])

  const startCheck = async () => {
    if (blocked) return
    setRequesting(true)
    setMessage(null)
    try {
      const result = await window.xidao.reminders.check()
      if (!alive.current) return
      if (!result.accepted) {
        setMessage({ text: refusalText(result), tone: result.reason === 'storage' ? 'error' : 'warn' })
        if (result.reason === 'cooldown' && result.retryAfterMs > 0) {
          const at = performance.now()
          setNow(at)
          setCooldownUntil(at + result.retryAfterMs)
        }
      }
    } catch {
      if (alive.current) setMessage({ text: '检查请求失败', tone: 'error' })
    } finally {
      if (alive.current) setRequesting(false)
    }
    void reload()
  }

  // ---------- Rows ----------
  const rows = useMemo(() => overview?.threads ?? [], [overview])
  const rowIds = useMemo(() => rows.map((row) => row.threadId), [rows])
  const roving = useRovingFocus(rowIds, selectedThreadId)

  /**
   * Opens a row by the usual resume rules. A thread without a saved reading position opens at the
   * page of its first new reply instead (in that reply's mode, shown temporarily). Only the latest
   * click counts.
   */
  const openSeq = useRef(0)
  const openRow = (row: ReminderThreadRow) => {
    const at = ++openSeq.current
    const firstNew = row.firstNew
    if (firstNew === null) {
      onOpenThread(row.threadId, row.head)
      return
    }
    void window.xidao.readingState
      .get({ threadId: row.threadId })
      .catch(() => null)
      .then((reading) => {
        if (!alive.current || at !== openSeq.current) return
        if (savedStart(reading, reading?.mode ?? 'all').position.kind !== 'top') {
          onOpenThread(row.threadId, row.head)
          return
        }
        onOpenTarget({
          threadId: row.threadId,
          head: row.head,
          target: { postId: null, page: firstNew.page, mode: firstNew.mode },
          snapshot: null,
          unlocatedPostId: null
        })
      })
  }

  // ---------- Row context menu and 清除提醒 ----------
  /** The row whose context menu is open, where it opened and the row control focus returns to. */
  const [rowMenu, setRowMenu] = useState<{ threadId: ThreadId; point: ContextMenuPoint; row: HTMLElement } | null>(null)
  /** 清除提醒 that did not apply, by thread. */
  const [clearFailures, setClearFailures] = useState<ReadonlyMap<ThreadId, string>>(() => new Map())
  const openRowMenu = (threadId: ThreadId, event: ReactMouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    const row = event.currentTarget.querySelector<HTMLElement>('[data-roving-item]')
    if (row === null) return
    event.preventDefault()
    // No scrolling into view: a scroll closes the menu that is about to open.
    row.focus({ preventScroll: true })
    setRowMenu({ threadId, point: contextMenuPoint(event, row), row })
  }
  const closeRowMenu = (returnFocus: boolean) => {
    const row = rowMenu?.row
    setRowMenu(null)
    if (returnFocus && row?.isConnected === true) row.focus()
  }
  const menuRow = rowMenu === null ? undefined : rows.find((row) => row.threadId === rowMenu.threadId)
  // Its last kind turned off, the row left the list: the menu goes with it, focus to the list.
  useEffect(() => {
    if (rowMenu === null || menuRow !== undefined || overview === null) return
    setRowMenu(null)
    scrollRef.current?.focus({ preventScroll: true })
  }, [rowMenu, menuRow, overview])

  const setClearFailure = (threadId: ThreadId, text: string | null) =>
    setClearFailures((current) => {
      if (text === null && !current.has(threadId)) return current
      const next = new Map(current)
      if (text === null) next.delete(threadId)
      else next.set(threadId, text)
      return next
    })
  const clearRow = (threadId: ThreadId) => {
    setClearFailure(threadId, null)
    window.xidao.reminders.clear({ threadId }).then(
      (result) => {
        if (alive.current && !result.ok) setClearFailure(threadId, `清除提醒失败：${failureText('storage')}`)
      },
      () => {
        if (alive.current) setClearFailure(threadId, `清除提醒失败：${failureText('internal')}`)
      }
    )
  }

  const lastChecked = overview?.checker.lastCheckedAt ?? null
  const autoOff = useContext(SettingsContext)?.settings.reminderInterval === 0
  // Stays while the episode lasts, also after its bottom notice was acknowledged. Not a live region:
  // the bottom notice announces the episode.
  const retryText = rateLimitRetry(overview?.checker.retryAt ?? null, autoOff)
  const rateLimitLine =
    overview?.checker.rateLimit == null ? null : retryText === null ? RATE_LIMIT_TEXT : `${RATE_LIMIT_TEXT}，${retryText}`

  return (
    <section className="list-pane reminder-pane" aria-labelledby={headingId}>
      <div className="list-scroll" ref={scrollRef} onScroll={onScroll} tabIndex={-1} data-pane-focus="">
        <header className="list-header">
          <div className="list-title-row">
            <h2 className="list-title" id={headingId}>
              <span className="list-name">{TITLE}</span>
            </h2>
            <div className="reminder-header-tools">
              {lastChecked !== null && <span className="reminder-last-checked">上次检查 {formatClockTime(lastChecked)}</span>}
              <button
                type="button"
                className="btn btn-small btn-quiet reminder-check"
                aria-disabled={blocked || undefined}
                aria-busy={running || requesting || undefined}
                aria-describedby={blockedReason !== null ? checkReasonId : undefined}
                title={blockedReason ?? undefined}
                onClick={() => void startCheck()}
              >
                {running ? <Spinner /> : <Icon name="refresh" size={14} />}
                手动检查
              </button>
              {/* Counts down every second: deliberately outside any live region. */}
              <span id={checkReasonId} className="visually-hidden">
                {blockedReason}
              </span>
            </div>
          </div>
          {rateLimitLine !== null && (
            <p className="notice-inline is-warning reminder-check-message">
              <Icon name="alert" size={14} />
              <span>{rateLimitLine}</span>
            </p>
          )}
          {message !== null && (
            <p
              className={message.tone === 'error' ? 'form-message is-error reminder-check-message' : 'notice-inline is-warning reminder-check-message'}
              role={message.tone === 'error' ? 'alert' : 'status'}
            >
              <Icon name="alert" size={14} />
              <span>{message.text}</span>
            </p>
          )}
        </header>

        {/* The first read is quiet; only a failure says anything. */}
        <div className="list-status" aria-busy={overview === null && failure === null ? true : undefined}>
          {failure !== null && (
            <div className="notice notice-error is-compact" role="alert">
              <Icon name="alert" className="notice-icon" />
              <p className="notice-text">
                {overview === null ? '提醒读取失败' : '提醒更新失败'}：{failureText(failure)}
              </p>
              <button type="button" className="btn btn-small" onClick={() => void reload()}>
                重试
              </button>
            </div>
          )}
        </div>

        {overview !== null && rows.length === 0 && (
          <div className="list-empty" role="status">
            <p className="list-empty-title">还没有开启提醒的串</p>
            {openList !== null && (
              <button type="button" className="btn reminder-empty-action" onClick={() => openList({ kind: 'subscriptions' })}>
                去订阅的串
              </button>
            )}
          </div>
        )}

        {rows.length > 0 && (
          <ul className="thread-list" aria-label={TITLE} onKeyDown={roving.onKeyDown}>
            {rows.map((row) => {
              const counts = countsText(row)
              const issues = issuesText(row)
              const clearFailure = clearFailures.get(row.threadId)
              // 在新标签页打开, the three kinds and 清除提醒 live in the row's context menu (right-click,
              // ContextMenu, Shift+F10); middle-click or Ctrl/Cmd+click opens a new tab, as in 订阅.
              return (
                <li
                  key={row.threadId}
                  className={rowMenu?.threadId === row.threadId ? 'reminder-row is-menu-open' : 'reminder-row'}
                  onContextMenu={(event) => openRowMenu(row.threadId, event)}
                  onKeyDown={(event) => {
                    if (isContextMenuKey(event)) openRowMenu(row.threadId, event)
                  }}
                  onClickCapture={(event) => {
                    if (openInTab === null || (!event.ctrlKey && !event.metaKey)) return
                    event.preventDefault()
                    event.stopPropagation()
                    openInTab(row.threadId, row.head)
                  }}
                  // Middle press: no autoscroll; the release opens the tab.
                  onMouseDown={(event) => {
                    if (openInTab !== null && event.button === 1) event.preventDefault()
                  }}
                  onAuxClick={(event) => {
                    if (openInTab === null || event.button !== 1) return
                    event.preventDefault()
                    openInTab(row.threadId, row.head)
                  }}
                >
                  <ThreadRow
                    thread={
                      row.head === null
                        ? { head: null, id: row.threadId, title: row.title, replyCount: row.replyCount }
                        : { head: row.head, replyCount: row.replyCount }
                    }
                    forumName={row.head !== null && row.head.forumId !== null ? (forumNames.get(row.head.forumId) ?? null) : null}
                    selected={row.threadId === selectedThreadId}
                    images={images}
                    onOpen={() => openRow(row)}
                    itemProps={roving.itemProps(row.threadId)}
                    metaEnd={
                      (counts !== null || issues !== null) && (
                        <>
                          {counts !== null && <span className="reminder-counts">{counts}</span>}
                          {issues !== null && <IssueStatus text={issues} />}
                        </>
                      )
                    }
                  />
                  {clearFailure !== undefined && (
                    <p className="notice-inline is-warning" role="alert">
                      <Icon name="alert" size={14} />
                      {clearFailure}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <div className="list-footer" />
      </div>
      {rowMenu !== null && menuRow !== undefined && (
        <ReminderRowMenu
          key={rowMenu.threadId}
          point={rowMenu.point}
          threadId={rowMenu.threadId}
          head={menuRow.head}
          // Thread title or `No.x`, as the thread's own menus name it.
          label={meaningfulTitle(menuRow.head === null ? menuRow.title : menuRow.head.title) ?? `No.${menuRow.threadId}`}
          rules={menuRow.rules}
          clearable={hasCounts(menuRow)}
          onUpdated={updated}
          onClear={() => clearRow(menuRow.threadId)}
          onClose={closeRowMenu}
        />
      )}
    </section>
  )
}
