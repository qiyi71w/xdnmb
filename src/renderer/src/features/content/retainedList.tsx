import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { OfflineCopy, RetainedEntry } from '../../../../shared/content'
import type { ThreadId } from '../../../../shared/forum'
import type { ContentFilters } from '../../../../shared/search'
import { Icon } from '../../components/Icon'
import { NO_CONTENT_FILTERS } from '../search/searchState'
import { ContentRegistryContext, type RetainedPage } from '../tabs/contentRegistry'
import { attempt, contentFailureText, type Refused } from './contentText'
import { offlineEpoch, offlineGeneration, subscribeOffline } from './offlineSync'
import type { ReadingResets } from './readingResets'

const READING = '阅读进度'

export type RetainedListState =
  | { status: 'loading' }
  | { status: 'failed'; refused: Refused }
  | { status: 'ready'; entries: RetainedEntry[] }

/** What a history deletion is about to remove: one thread, or all history (null). */
export type Confirming = { threadId: ThreadId | null; clearReading: boolean }

/**
 * The 浏览记录 list as stored, read on mount, with history deletion.
 * Focus: a confirmation takes it, leaving one returns it to the control that asked; after a row
 * disappears it goes to the first enabled button of the row now at that position in `listRef`
 * (rows carry `data-retained-row`), else of `bodyRef`. History deletion removes visit records only
 * unless the reader's progress is explicitly included. A row's 有离线副本 follows copies saved,
 * cancelled or deleted meanwhile; a read overtaken by such a change is dropped.
 */
export function useRetainedList(resets: ReadingResets) {
  const [list, setList] = useState<RetainedListState>({ status: 'loading' })
  const [confirming, setConfirming] = useState<Confirming | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<{ threadId: ThreadId | null; text: string } | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const alive = useRef(true)
  const seq = useRef(0)
  /** Newest offline read of each thread after it went stale. */
  const offlineSeq = useRef(new Map<ThreadId, number>())
  const listRef = useRef<HTMLUListElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const focusAfterRemove = useRef<number | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const at = ++seq.current
    const epoch = offlineEpoch()
    setList({ status: 'loading' })
    const result = await attempt(() => window.xidao.content.listHistory())
    if (!alive.current || at !== seq.current) return
    if (epoch !== offlineEpoch()) return load()
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
    void load()
  }, [load])

  useEffect(() => {
    const showOffline = (threadId: ThreadId, offline: OfflineCopy | null) =>
      setList((current) =>
        current.status !== 'ready' || !current.entries.some((entry) => entry.threadId === threadId)
          ? current
          : { status: 'ready', entries: current.entries.map((entry) => (entry.threadId === threadId ? { ...entry, offline } : entry)) }
      )
    return subscribeOffline((change) => {
      if (change.kind === 'copy') {
        showOffline(change.copy.threadId, change.copy)
        return
      }
      const { threadId } = change
      const at = (offlineSeq.current.get(threadId) ?? 0) + 1
      offlineSeq.current.set(threadId, at)
      const generation = offlineGeneration(threadId)
      void attempt(() => window.xidao.content.offlineStatus({ threadId })).then((read) => {
        if (!alive.current || offlineSeq.current.get(threadId) !== at || generation !== offlineGeneration(threadId)) return
        // Unknown: the next read of the list (refresh, or opening the page again) says.
        if (read?.ok === true) showOffline(threadId, read.value)
      })
    })
  }, [])

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
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-retained-row]') ?? []
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
      setFailure({ threadId, text: `删除未完成：${contentFailureText(result?.ok === false ? result : null)}` })
      return
    }
    askedBy.current = null
    setConfirming(null)
    setDone(
      threadId === null
        ? clearReading
          ? `已清空浏览历史和其中 ${result.value.length} 个串的${READING}`
          : '已清空浏览历史'
        : clearReading
          ? `已删除这条访问记录和它的${READING}`
          : '已删除这条访问记录'
    )
    removeRows(threadId)
  }

  return {
    list,
    entries: list.status === 'ready' ? list.entries : [],
    load,
    confirming,
    setConfirming,
    busy,
    setBusy,
    failure,
    setFailure,
    done,
    setDone,
    alive,
    listRef,
    bodyRef,
    confirmRef,
    ask,
    removeRows,
    clearHistory
  }
}

/** Confirmation of a history deletion; clearing reading data is opt-in and spelled out. */
export function HistoryConfirm({
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
          aria-describedby={confirming.clearReading ? impactId : undefined}
          onChange={(event) => onChange({ ...confirming, clearReading: event.target.checked })}
        />
        <span className="choice-title">同时清除{all ? '这些串' : '这个串'}的{READING}</span>
      </label>
      {confirming.clearReading && (
        <p className="history-confirm-impact" id={impactId}>
          之后打开会从开头阅读。
        </p>
      )}
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

/**
 * Scroll memory of a 历史／离线 list in `bodyRef` (runtime, and restored after a quit): placed once
 * the list is first ready while displayed, recorded on every scroll while shown. Returns the
 * scroller's `onScroll`.
 */
export function useRetainedScroll(entryKey: number, bodyRef: RefObject<HTMLDivElement | null>, ready: boolean, displayed: boolean) {
  const registry = useContext(ContentRegistryContext)
  const [initialScroll] = useState(() => {
    const memory = registry?.listMemory.get(entryKey)
    if (memory?.kind === 'retained') return memory.scrollTop
    return registry?.savedLists.get(entryKey)?.scrollTop ?? 0
  })
  const scrollTop = useRef(initialScroll)
  const placed = useRef(false)
  useLayoutEffect(() => {
    const scroller = bodyRef.current
    if (!ready || !displayed || placed.current || scroller === null) return
    placed.current = true
    scroller.scrollTop = scrollTop.current
    registry?.savedLists.delete(entryKey)
  }, [ready, displayed, registry, entryKey, bodyRef])
  useLayoutEffect(() => {
    registry?.listMemory.set(entryKey, { kind: 'retained', scrollTop: scrollTop.current })
  })
  return () => {
    const scroller = bodyRef.current
    if (scroller === null || scroller.clientHeight === 0 || !placed.current) return
    scrollTop.current = scroller.scrollTop
    registry?.listMemory.set(entryKey, { kind: 'retained', scrollTop: scrollTop.current })
  }
}

/** Filters of a 历史／离线 list: kept per page while the app runs (outside the shell, per pane). */
export function useRetainedFilters(page: RetainedPage): [ContentFilters, (next: ContentFilters) => void] {
  const registry = useContext(ContentRegistryContext)
  const [ownFilters] = useState(() => new Map<RetainedPage, ContentFilters>())
  const memory = registry?.retainedFilters ?? ownFilters
  const [, setVersion] = useState(0)
  const change = (next: ContentFilters) => {
    memory.set(page, next)
    setVersion((version) => version + 1)
  }
  return [memory.get(page) ?? NO_CONTENT_FILTERS, change]
}
