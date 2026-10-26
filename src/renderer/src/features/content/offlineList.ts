import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { OfflineCopy, OfflineEntry } from '../../../../shared/content'
import type { ThreadId } from '../../../../shared/forum'
import { attempt, contentFailureText, type Refused } from './contentText'
import { announceOfflineCopy, isDeletingOffline, offlineEpoch, offlineGeneration, subscribeOffline } from './offlineSync'
import { POLL_MS } from './ThreadRetention'

export type OfflineListState =
  | { status: 'loading' }
  | { status: 'failed'; refused: Refused }
  | { status: 'ready'; entries: OfflineEntry[] }

function without<V>(map: ReadonlyMap<ThreadId, V>, threadId: ThreadId): ReadonlyMap<ThreadId, V> {
  if (!map.has(threadId)) return map
  const next = new Map(map)
  next.delete(threadId)
  return next
}

/**
 * The 离线 list as stored (most recently first saved first), read on mount and on `load()`.
 * Rows keep their place: a copy that is saving is re-read about every second and patched into its
 * row (no loading state, nothing else re-read) until no listed copy is saving; a copy whose save was
 * started or cancelled elsewhere in this window is patched likewise, and a copy not listed yet makes
 * the list read again quietly. `update` starts the same save as the 离线副本 dialog's update
 * (originals included); why it did not start is kept per row until the next attempt or reload.
 * After a deletion (any view, or the main process's notice) the thread is read again and its row
 * follows what storage holds; reads and updates started before it are dropped, so a late result
 * never brings a deleted row back, and a copy saved again later is listed as usual.
 */
export function useOfflineList() {
  const [list, setList] = useState<OfflineListState>({ status: 'loading' })
  /** Rows whose update request is in flight. */
  const [starting, setStarting] = useState<ReadonlySet<ThreadId>>(new Set())
  const [startFailures, setStartFailures] = useState<ReadonlyMap<ThreadId, string>>(new Map())
  /** Progress reads that failed while saving; the row keeps its last known copy. */
  const [pollFailures, setPollFailures] = useState<ReadonlyMap<ThreadId, string>>(new Map())
  /** Completed progress rounds; every one schedules the next while something is saving. */
  const [polls, setPolls] = useState(0)
  const alive = useRef(true)
  const seq = useRef(0)
  /** Newest read of each thread after it went stale. */
  const threadSeq = useRef(new Map<ThreadId, number>())
  const startingNow = useRef(new Set<ThreadId>())
  const listNow = useRef(list)
  useLayoutEffect(() => {
    listNow.current = list
  })

  /**
   * A quiet read replaces the rows only when it succeeds and never shows loading. A read that a
   * change of any copy overtook is read again in the same way.
   */
  const load = useCallback(async (quiet = false): Promise<void> => {
    const at = ++seq.current
    const epoch = offlineEpoch()
    if (!quiet) {
      setList({ status: 'loading' })
      setStartFailures(new Map())
      setPollFailures(new Map())
    }
    const result = await attempt(() => window.xidao.content.listOffline())
    if (!alive.current || at !== seq.current) return
    if (epoch !== offlineEpoch()) return load(quiet)
    if (result?.ok === true) setList({ status: 'ready', entries: result.value })
    else if (!quiet) setList({ status: 'failed', refused: result?.ok === false ? result : null })
  }, [])

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
    }
  }, [load])

  /** Shows `copy` in its row, where the row is. */
  const patch = useCallback((copy: OfflineCopy) => {
    setList((current) =>
      current.status !== 'ready'
        ? current
        : { status: 'ready', entries: current.entries.map((entry) => (entry.threadId === copy.threadId ? { ...entry, copy } : entry)) }
    )
  }, [])

  /** Takes the thread's row out (its copy is no longer stored); nothing else changes. */
  const remove = useCallback((threadId: ThreadId) => {
    setList((current) =>
      current.status !== 'ready' || !current.entries.some((entry) => entry.threadId === threadId)
        ? current
        : { status: 'ready', entries: current.entries.filter((entry) => entry.threadId !== threadId) }
    )
    setStartFailures((current) => without(current, threadId))
    setPollFailures((current) => without(current, threadId))
  }, [])

  /** The thread went stale: its row follows what storage now holds for it. */
  const reconcile = useCallback(
    async (threadId: ThreadId) => {
      const current = listNow.current
      // A list being read (or failed) reads every copy anyway; `load` drops an overtaken read.
      if (current.status !== 'ready') return
      const at = (threadSeq.current.get(threadId) ?? 0) + 1
      threadSeq.current.set(threadId, at)
      const generation = offlineGeneration(threadId)
      const read = await attempt(() => window.xidao.content.offlineStatus({ threadId }))
      if (!alive.current || threadSeq.current.get(threadId) !== at || generation !== offlineGeneration(threadId)) return
      if (read?.ok !== true) return void load(true)
      if (read.value === null) remove(threadId)
      else if (listNow.current.status === 'ready' && listNow.current.entries.some((entry) => entry.threadId === threadId)) patch(read.value)
      else void load(true)
    },
    [load, patch, remove]
  )

  useEffect(
    () =>
      subscribeOffline((change) => {
        if (change.kind === 'stale') {
          void reconcile(change.threadId)
          return
        }
        const current = listNow.current
        if (current.status !== 'ready') return
        if (current.entries.some((entry) => entry.threadId === change.copy.threadId)) patch(change.copy)
        else void load(true)
      }),
    [patch, load, reconcile]
  )

  const savingKey =
    list.status === 'ready'
      ? list.entries
          .filter((entry) => entry.copy.state === 'saving')
          .map((entry) => entry.threadId)
          .join(',')
      : ''
  useEffect(() => {
    if (savingKey === '') return
    const at = seq.current
    let stale = false
    const timer = window.setTimeout(async () => {
      // A copy being deleted is read again once the deletion ends.
      const ids = savingKey.split(',').filter((threadId) => !isDeletingOffline(threadId))
      const generations = ids.map((threadId) => offlineGeneration(threadId))
      const reads = await Promise.all(ids.map((threadId) => attempt(() => window.xidao.content.offlineStatus({ threadId }))))
      if (stale || !alive.current || at !== seq.current) return
      const copies = new Map<ThreadId, OfflineCopy | null>()
      const failures = new Map<ThreadId, string>()
      ids.forEach((threadId, index) => {
        // Overtaken by a deletion or change: that thread's own read follows.
        if (generations[index] !== offlineGeneration(threadId)) return
        const read = reads[index]
        if (read?.ok === true) copies.set(threadId, read.value)
        else failures.set(threadId, `进度读取失败：${contentFailureText(read?.ok === false ? read : null)}，稍后自动再试`)
      })
      setPollFailures((current) => {
        const next = new Map(current)
        for (const threadId of ids) {
          const failure = failures.get(threadId)
          if (failure === undefined) next.delete(threadId)
          else next.set(threadId, failure)
        }
        return next
      })
      // A copy no longer stored leaves the list.
      setList((current) =>
        current.status !== 'ready'
          ? current
          : {
              status: 'ready',
              entries: current.entries.flatMap((entry) => {
                const copy = copies.get(entry.threadId)
                if (copy === undefined) return [entry]
                return copy === null ? [] : [{ ...entry, copy }]
              })
            }
      )
      setPolls((count) => count + 1)
    }, POLL_MS)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [savingKey, polls])

  const update = useCallback(
    async (threadId: ThreadId) => {
      if (startingNow.current.has(threadId) || isDeletingOffline(threadId)) return
      startingNow.current.add(threadId)
      setStarting(new Set(startingNow.current))
      setStartFailures((current) => without(current, threadId))
      const generation = offlineGeneration(threadId)
      const result = await attempt(() => window.xidao.content.saveOffline({ threadId, includeImages: true }))
      startingNow.current.delete(threadId)
      if (!alive.current) return
      setStarting(new Set(startingNow.current))
      if (result?.ok !== true) {
        const text = `更新没有开始：${contentFailureText(result?.ok === false ? result : null)}`
        setStartFailures((current) => new Map(current).set(threadId, text))
      } else if (generation === offlineGeneration(threadId)) {
        patch(result.value)
        announceOfflineCopy(result.value)
      }
    },
    [patch]
  )

  return {
    list,
    entries: list.status === 'ready' ? list.entries : [],
    load,
    remove,
    update,
    starting,
    startFailures,
    pollFailures
  }
}
