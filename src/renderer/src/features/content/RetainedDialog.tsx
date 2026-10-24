import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { RetainedEntry, RetainedList } from '../../../../shared/content'
import type { ThreadId } from '../../../../shared/forum'
import { Icon, type IconName } from '../../components/Icon'
import { Modal, ModalHeader } from '../../components/Modal'
import { Loading } from '../../components/Notices'
import { formatLocalTime, meaningfulTitle } from '../../lib/format'
import { attempt, contentFailureText, type Refused } from './contentText'
import type { FavoriteWrites } from './favoriteWrites'
import type { ReadingResets } from './readingResets'
import { OfflineSummary } from './ThreadRetention'
import { ReminderMenu } from '../reminders/ReminderMenu'
import { useThreadRules } from '../reminders/useReminders'
import './content.css'

const LISTS: { kind: RetainedList; label: string; icon: IconName; at: string; empty: string; emptyHelp: string }[] = [
  {
    kind: 'favorites',
    label: '收藏',
    icon: 'star',
    at: '收藏于',
    empty: '还没有收藏',
    emptyHelp: '在串的工具栏点“收藏”。收藏只保存入口，不下载整串。'
  },
  {
    kind: 'history',
    label: '历史',
    icon: 'history',
    at: '最近访问',
    empty: '没有浏览历史',
    emptyHelp: '打开过的串会记在这里，保留到你手动删除。'
  },
  {
    kind: 'offline',
    label: '离线',
    icon: 'download',
    at: '最近更新',
    empty: '还没有离线副本',
    emptyHelp: '在串的工具栏点“离线保存”，可保存文字和原图或仅文字。'
  }
]

type ListState = { status: 'loading' } | { status: 'failed'; refused: Refused } | { status: 'ready'; entries: RetainedEntry[] }

/** What a history deletion is about to remove: one thread, or all history (null). */
type Confirming = { threadId: ThreadId | null; clearReading: boolean }

function entryTitle(entry: RetainedEntry): string {
  return meaningfulTitle(entry.title) ?? `No.${entry.threadId}`
}

/**
 * 收藏 / 历史 / 离线 lists. 打开 hands the thread to the shell, which shows it in the actual reader
 * of the active tab. History deletion removes visit records only unless the reader's progress and
 * read records are explicitly included; it never clears favorites, offline copies, drafts,
 * reminders or sync records.
 */
export function RetainedDialog({
  initial,
  resets,
  favorites,
  onOpenThread,
  onClose,
  fallbackFocus
}: {
  initial: RetainedList
  /** Shell's reading-reset store: readers of a thread whose reading data is cleared start again. */
  resets: ReadingResets
  /** Shell's favorite store: 收藏 buttons of open readers follow what this list writes. */
  favorites: FavoriteWrites
  onOpenThread: (threadId: ThreadId) => void
  onClose: () => void
  fallbackFocus?: () => HTMLElement | null
}) {
  const titleId = useId()
  const [kind, setKind] = useState<RetainedList>(initial)
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [confirming, setConfirming] = useState<Confirming | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ threadId: ThreadId | null; text: string } | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const alive = useRef(true)
  const seq = useRef(0)
  const listRef = useRef<HTMLUListElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const focusAfterRemove = useRef<number | null>(null)
  const info = LISTS.find((item) => item.kind === kind) ?? (LISTS[0] as (typeof LISTS)[number])

  const load = useCallback(async (which: RetainedList) => {
    const at = ++seq.current
    setList({ status: 'loading' })
    const result = await attempt(() => window.xidao.content.list({ kind: which }))
    if (!alive.current || at !== seq.current) return
    setList(result?.ok === true ? { status: 'ready', entries: result.value } : { status: 'failed', refused: result?.ok === false ? result : null })
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    setConfirming(null)
    setFailure(null)
    setDone(null)
    void load(kind)
  }, [kind, load])

  // Confirmation takes focus; leaving it returns focus to the control that asked.
  const confirmRef = useRef<HTMLButtonElement>(null)
  const askedBy = useRef<HTMLElement | null>(null)
  const confirmKey = confirming === null ? null : (confirming.threadId ?? '*')
  useLayoutEffect(() => {
    if (confirmKey !== null) {
      confirmRef.current?.focus()
      return
    }
    const opener = askedBy.current
    askedBy.current = null
    if (opener?.isConnected) opener.focus()
  }, [confirmKey])

  // After a row disappears, focus the row now at its position, else the list heading area.
  useLayoutEffect(() => {
    const index = focusAfterRemove.current
    if (index === null || list.status !== 'ready') return
    focusAfterRemove.current = null
    const rows = listRef.current?.querySelectorAll<HTMLElement>('.retained-item') ?? []
    const row = rows[Math.min(index, rows.length - 1)]
    ;(row?.querySelector<HTMLElement>('button:not(:disabled)') ?? bodyRef.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus()
  }, [list])

  const ask = (threadId: ThreadId | null, opener: HTMLElement) => {
    askedBy.current = opener
    setFailure(null)
    setDone(null)
    setConfirming({ threadId, clearReading: false })
  }

  const removeRows = (threadId: ThreadId | null) => {
    setList((current) => {
      if (current.status !== 'ready') return current
      const index = threadId === null ? 0 : current.entries.findIndex((entry) => entry.threadId === threadId)
      focusAfterRemove.current = Math.max(index, 0)
      return { status: 'ready', entries: threadId === null ? [] : current.entries.filter((entry) => entry.threadId !== threadId) }
    })
  }

  const clearHistory = async ({ threadId, clearReading }: Confirming) => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    // Open readers must not write the progress back while, or after, it is cleared. The actual scope
    // is known only from storage: only the threads it reports cleared start again.
    const release = clearReading ? resets.block(threadId) : null
    const result = await attempt(() => window.xidao.content.clearHistory({ threadId, clearReading }))
    if (result?.ok === true) resets.reset(result.value)
    release?.()
    if (!alive.current) return
    setBusy(false)
    if (result?.ok !== true) {
      setFailure({ threadId, text: `删除未完成：${contentFailureText(result?.ok === false ? result : null)}，记录仍保留` })
      return
    }
    askedBy.current = null
    setConfirming(null)
    setDone(
      threadId === null
        ? clearReading
          ? `已清空浏览历史，并清除了其中 ${result.value.length} 个串的阅读进度与已读记录`
          : '已清空浏览历史'
        : clearReading
          ? '已删除这条访问记录，并清除了它的阅读进度与已读记录'
          : '已删除这条访问记录'
    )
    removeRows(threadId)
  }

  const unfavorite = async (entry: RetainedEntry) => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    setDone(null)
    const result = await attempt(() => window.xidao.content.favorite({ threadId: entry.threadId, favorite: false }))
    if (result?.ok === true) favorites.written(entry.threadId, result.value)
    if (!alive.current) return
    setBusy(false)
    if (result?.ok === true && !result.value) {
      setDone(`已取消收藏「${entryTitle(entry)}」`)
      removeRows(entry.threadId)
    } else {
      setFailure({ threadId: entry.threadId, text: `取消收藏未完成：${contentFailureText(result?.ok === false ? result : null)}` })
    }
  }

  const entries = list.status === 'ready' ? list.entries : []
  // 收藏 rows carry each thread's 提醒 control; favorites and reminders stay independent records.
  const favoriteIds = useMemo(
    () => (kind === 'favorites' && list.status === 'ready' ? list.entries.map((entry) => entry.threadId) : []),
    [kind, list]
  )
  const rules = useThreadRules(favoriteIds)
  const confirmingAll = confirming !== null && confirming.threadId === null

  return (
    <Modal className="retained-dialog" labelledBy={titleId} onClose={busy ? () => undefined : onClose} fallbackFocus={fallbackFocus}>
      <ModalHeader title={info.label === '离线' ? '离线副本' : info.label} titleId={titleId} closeLabel="关闭" onClose={onClose} closeDisabled={busy} />
      <div className="modal-body retained-body" ref={bodyRef}>
        <div className="retained-head">
          <div className="segmented" role="group" aria-label="列表">
            {LISTS.map((item) => (
              <button
                key={item.kind}
                type="button"
                className="segmented-item"
                aria-pressed={kind === item.kind}
                disabled={busy}
                onClick={() => setKind(item.kind)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {kind === 'history' && entries.length > 0 && !confirmingAll && (
            <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={(event) => ask(null, event.currentTarget)}>
              <Icon name="trash" size={14} />
              清空历史…
            </button>
          )}
        </div>

        {kind === 'history' && (
          <p className="retained-note">删除历史默认只删访问记录，不影响收藏、离线副本、草稿、提醒和同步记录，也不是完整的隐私清除。</p>
        )}
        {kind === 'offline' && (
          <p className="retained-note">离线副本不随普通缓存清理。更新和取消在串的工具栏“离线”中进行。</p>
        )}

        {confirmingAll && confirming !== null && (
          <HistoryConfirm
            confirming={confirming}
            busy={busy}
            confirmRef={confirmRef}
            failure={failure?.threadId === null ? failure.text : null}
            onChange={setConfirming}
            onConfirm={() => void clearHistory(confirming)}
            onCancel={() => setConfirming(null)}
          />
        )}

        {done !== null && (
          <p className="notice-inline" role="status">
            <Icon name="check" size={14} />
            {done}
          </p>
        )}

        {list.status === 'loading' && <Loading>正在读取{info.label}…</Loading>}
        {list.status === 'failed' && (
          <div className="notice notice-error" role="alert">
            <Icon name="alert" className="notice-icon" />
            <div className="notice-text">
              <p className="notice-title">
                {info.label}读取失败：{contentFailureText(list.refused)}
              </p>
            </div>
            <button type="button" className="btn btn-small" onClick={() => void load(kind)}>
              重试
            </button>
          </div>
        )}
        {list.status === 'ready' && entries.length === 0 && (
          <div className="retained-empty" role="status">
            <p className="retained-empty-title">{info.empty}</p>
            <p className="retained-empty-text">{info.emptyHelp}</p>
          </div>
        )}
        {entries.length > 0 && (
          <ul className="retained-list" ref={listRef} aria-label={`${info.label}，共 ${entries.length} 项`}>
            {entries.map((entry) => {
              const rowId = `retained-${kind}-${entry.threadId}`
              const title = entryTitle(entry)
              const rowConfirming = confirming !== null && confirming.threadId === entry.threadId
              return (
                <li key={entry.threadId} className="retained-item" aria-labelledby={`${rowId}-title`}>
                  <div className="retained-text">
                    <p className="retained-title" id={`${rowId}-title`}>
                      {title}
                    </p>
                    <p className="retained-meta">
                      <span>No.{entry.threadId}</span>
                      <span>
                        {info.at} {formatLocalTime(entry.at)}
                      </span>
                      {kind !== 'offline' && entry.offline !== null && (
                        <span className="retained-tag">
                          <Icon name="download" size={13} />
                          有离线副本
                        </span>
                      )}
                    </p>
                    {kind === 'offline' && entry.offline !== null && <OfflineSummary copy={entry.offline} compact />}
                    {failure !== null && failure.threadId === entry.threadId && !rowConfirming && (
                      <p className="notice-inline is-warning" role="alert">
                        <Icon name="alert" size={14} />
                        {failure.text}
                      </p>
                    )}
                  </div>
                  {!rowConfirming && (
                    <div className="retained-actions">
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-describedby={`${rowId}-title`}
                        disabled={busy}
                        onClick={() => onOpenThread(entry.threadId)}
                      >
                        <Icon name="chevron" size={14} />
                        打开
                      </button>
                      {kind === 'favorites' && (
                        <ReminderMenu
                          threadId={entry.threadId}
                          label={title}
                          rules={rules.rulesOf(entry.threadId)}
                          failure={rules.failure}
                          onRetry={rules.reload}
                          onUpdated={rules.updated}
                          small
                        />
                      )}
                      {kind === 'favorites' && (
                        <button
                          type="button"
                          className="btn btn-small"
                          aria-describedby={`${rowId}-title`}
                          disabled={busy}
                          onClick={() => void unfavorite(entry)}
                        >
                          <Icon name="star" size={14} />
                          取消收藏
                        </button>
                      )}
                      {kind === 'history' && (
                        <button
                          type="button"
                          className="btn btn-small btn-danger"
                          aria-describedby={`${rowId}-title`}
                          disabled={busy || confirmingAll}
                          onClick={(event) => ask(entry.threadId, event.currentTarget)}
                        >
                          <Icon name="trash" size={14} />
                          删除…
                        </button>
                      )}
                    </div>
                  )}
                  {rowConfirming && confirming !== null && (
                    <HistoryConfirm
                      confirming={confirming}
                      title={title}
                      busy={busy}
                      confirmRef={confirmRef}
                      failure={failure?.threadId === entry.threadId ? failure.text : null}
                      onChange={setConfirming}
                      onConfirm={() => void clearHistory(confirming)}
                      onCancel={() => setConfirming(null)}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}

/** Confirmation of a history deletion; clearing reading data is opt-in and spelled out. */
function HistoryConfirm({
  confirming,
  title,
  busy,
  confirmRef,
  failure,
  onChange,
  onConfirm,
  onCancel
}: {
  confirming: Confirming
  title?: string
  busy: boolean
  confirmRef: RefObject<HTMLButtonElement | null>
  failure: string | null
  onChange: (next: Confirming) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const checkId = useId()
  const impactId = useId()
  const all = confirming.threadId === null
  return (
    <div className="history-confirm" role="group" aria-label={all ? '确认清空浏览历史' : `确认删除访问记录：${title ?? ''}`}>
      <p className="history-confirm-title">{all ? '清空全部浏览历史？' : '删除这条访问记录？'}</p>
      <label className="choice-row" htmlFor={checkId}>
        <input
          id={checkId}
          type="checkbox"
          checked={confirming.clearReading}
          disabled={busy}
          aria-describedby={impactId}
          onChange={(event) => onChange({ ...confirming, clearReading: event.target.checked })}
        />
        <span className="choice-title">同时清除{all ? '历史中各串' : '这个串'}的阅读进度与已读记录</span>
      </label>
      <p className="history-confirm-impact" id={impactId}>
        {confirming.clearReading
          ? `将删除${all ? '全部' : '这条'}访问记录，以及${all ? '这些串' : '这个串'}保存的阅读位置和已读记录：之后打开会从开头阅读，已读标记不再保留；正在打开的阅读器会回到开头。${all ? '不在历史中的串不受影响。' : ''}`
          : `只删除${all ? '全部' : '这条'}访问记录；阅读位置和已读记录保留。`}
        {' '}收藏、离线副本、草稿、提醒起点与已发送的通知、同步记录都不受影响。
      </p>
      {failure !== null && (
        <p className="form-message is-error" role="alert">
          <Icon name="alert" size={14} />
          {failure}
        </p>
      )}
      <div className="history-confirm-actions">
        <button ref={confirmRef} type="button" className="btn btn-small btn-danger" aria-busy={busy || undefined} onClick={onConfirm}>
          {busy ? '正在删除…' : all ? '确认清空' : '确认删除'}
        </button>
        <button type="button" className="btn btn-small" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}
