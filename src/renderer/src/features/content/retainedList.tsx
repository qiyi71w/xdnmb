import { useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { OfflineCopy, RetainedEntry } from '../../../../shared/content'
import type { ThreadId } from '../../../../shared/forum'
import type { ContentFilters } from '../../../../shared/search'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { NO_CONTENT_FILTERS } from '../search/searchState'
import { ContentRegistryContext, type HistoryMemory, type ListMemory, type RetainedPage } from '../tabs/contentRegistry'
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
 * The 浏览 list as stored, read on mount, with history deletion (asked in `HistoryConfirm`).
 * Focus: after a row disappears it goes to the first enabled button of the row now at that
 * position in `listRef` (rows carry `data-retained-row`), else of `bodyRef`. History deletion
 * removes visit records only unless the reader's progress is explicitly included. A row's
 * 有离线副本 follows copies saved, cancelled or deleted meanwhile; a read overtaken by such a
 * change is dropped.
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

  // After a row disappears, focus the row now at its position, else the list heading area.
  useLayoutEffect(() => {
    const index = focusAfterRemove.current
    if (index === null || list.status !== 'ready') return
    focusAfterRemove.current = null
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-retained-row]') ?? []
    const row = rows[Math.min(index, rows.length - 1)]
    ;(row?.querySelector<HTMLElement>('button:not(:disabled)') ?? bodyRef.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus()
  }, [list])

  const ask = (threadId: ThreadId | null) => {
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
    failure,
    setFailure,
    done,
    listRef,
    bodyRef,
    ask,
    clearHistory
  }
}

/**
 * 删除…／清空历史… of 浏览: a dialog naming what goes, with 同时清除阅读进度 opt-in and spelled out.
 * Focus starts on 取消; 取消, Esc or a press on the backdrop changes nothing (ignored while the
 * deletion runs). A refusal stays here; a deletion closes it from its owner.
 */
export function HistoryConfirm({
  confirming,
  title,
  busy,
  failure,
  onChange,
  onConfirm,
  onCancel,
  fallbackFocus
}: {
  confirming: Confirming
  /** The thread's heading; unused when clearing all history. */
  title?: string
  busy: boolean
  failure: string | null
  onChange: (next: Confirming) => void
  onConfirm: () => void
  onCancel: () => void
  fallbackFocus?: () => HTMLElement | null
}) {
  const titleId = useId()
  const checkId = useId()
  const impactId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const all = confirming.threadId === null

  // Start on 取消, the choice that changes nothing (Modal focused its first control).
  useLayoutEffect(() => {
    cancelRef.current?.focus()
  }, [])

  const cancel = () => {
    if (!busy) onCancel()
  }

  return (
    <Modal className="history-delete-dialog" labelledBy={titleId} onClose={cancel} closeOnBackdrop fallbackFocus={fallbackFocus}>
      <header className="modal-header">
        <h2 className="modal-title" id={titleId}>
          {all ? '清空全部浏览历史？' : '删除这条访问记录？'}
        </h2>
      </header>
      <div className="modal-body history-delete-body">
        {confirming.threadId !== null && (
          <p className="offline-thread">
            {title}
            <span className="offline-thread-id">No.{confirming.threadId}</span>
          </p>
        )}
        <label className="choice-row" htmlFor={checkId}>
          <input
            id={checkId}
            type="checkbox"
            checked={confirming.clearReading}
            disabled={busy}
            aria-describedby={confirming.clearReading ? impactId : undefined}
            onChange={(event) => onChange({ ...confirming, clearReading: event.target.checked })}
          />
          <span className="choice-title">同时清除{READING}</span>
        </label>
        {confirming.clearReading && (
          <p className="history-delete-impact" id={impactId}>
            {all ? '这些串之后打开会从开头阅读。' : '这个串之后打开会从开头阅读。'}
          </p>
        )}
        {failure !== null && (
          <p className="form-message is-error" role="alert">
            <Icon name="alert" size={14} />
            {failure}
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button ref={cancelRef} type="button" className="btn" aria-disabled={busy || undefined} onClick={cancel}>
          取消
        </button>
        <button type="button" className="btn btn-danger" aria-disabled={busy || undefined} aria-busy={busy || undefined} onClick={onConfirm}>
          {busy ? '正在删除…' : all ? '清空历史' : '删除'}
        </button>
      </div>
    </Modal>
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
    if (registry !== null) rememberRetained(registry.listMemory, entryKey, { scrollTop: scrollTop.current })
  })
  return () => {
    const scroller = bodyRef.current
    if (scroller === null || scroller.clientHeight === 0 || !placed.current) return
    scrollTop.current = scroller.scrollTop
    if (registry !== null) rememberRetained(registry.listMemory, entryKey, { scrollTop: scrollTop.current })
  }
}

type RetainedMemory = Extract<ListMemory, { kind: 'retained' }>

/** Updates part of a 历史／离线 entry's memory, keeping the rest (浏览 scroll, 历史 pages). */
export function rememberRetained(memory: Map<number, ListMemory>, entryKey: number, patch: Partial<Omit<RetainedMemory, 'kind'>>): void {
  const current = memory.get(entryKey)
  const base: RetainedMemory = current?.kind === 'retained' ? current : { kind: 'retained', scrollTop: 0 }
  memory.set(entryKey, { ...base, ...patch })
}

/** 历史's runtime memory of entry `entryKey`, if any. */
export function historyMemory(memory: Map<number, ListMemory>, entryKey: number): HistoryMemory | undefined {
  const current = memory.get(entryKey)
  return current?.kind === 'retained' ? current.history : undefined
}

/** Updates part of 历史's runtime memory (page shown, 新串／回复 scroll), keeping the rest. */
export function rememberHistory(memory: Map<number, ListMemory>, entryKey: number, patch: Partial<HistoryMemory>): void {
  const history = historyMemory(memory, entryKey) ?? { view: 'browsing', sentScroll: { threads: 0, replies: 0 } }
  rememberRetained(memory, entryKey, { history: { ...history, ...patch } })
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
