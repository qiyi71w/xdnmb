import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ThreadId } from '../../../../shared/forum'
import type { ReminderKind, ReminderOverview, ReminderRule, ThreadReminders } from '../../../../shared/reminders'

/** A reminders call answered `{ ok: false, reason: 'storage' }`. */
export class ReminderStorageError extends Error {}

export type LoadFailure = 'storage' | 'internal'

export function failureText(failure: LoadFailure): string {
  return failure === 'storage' ? '本地存储不可用' : '应用内部请求失败'
}

/**
 * The user opened the thread, switched to a tab showing it, or jumped to a quote inside it: its
 * reminder counts go to 0. Fire and forget: a failure leaves the counts for the next open; reading
 * data is untouched.
 */
export function clearThreadReminders(threadId: ThreadId): void {
  window.xidao.reminders.clear({ threadId }).catch(() => undefined)
}

/**
 * Local reminder data kept current by `reminders.onChanged`: one read at a time, and changes that
 * arrive while it runs coalesce into a single follow-up read. No timers and no polling; reading
 * never starts a check. A new `key` (another set of threads) starts over and drops older results.
 */
function useLiveReminders<T>(key: string | null, load: () => Promise<T>) {
  const [value, setValue] = useState<{ key: string; data: T } | null>(null)
  const [failure, setFailure] = useState<{ key: string; failure: LoadFailure } | null>(null)
  const loadRef = useRef(load)
  const keyRef = useRef(key)
  useLayoutEffect(() => {
    loadRef.current = load
    keyRef.current = key
  })
  const running = useRef(false)
  const dirty = useRef(false)
  const alive = useRef(true)

  const run = useCallback(async () => {
    if (running.current) {
      dirty.current = true
      return
    }
    running.current = true
    try {
      do {
        dirty.current = false
        const at = keyRef.current
        if (at === null) break
        try {
          const data = await loadRef.current()
          if (!alive.current || keyRef.current !== at) continue
          setValue({ key: at, data })
          setFailure(null)
        } catch (error) {
          if (!alive.current || keyRef.current !== at) continue
          setFailure({ key: at, failure: error instanceof ReminderStorageError ? 'storage' : 'internal' })
        }
      } while (dirty.current && alive.current)
    } finally {
      running.current = false
    }
  }, [])

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (key === null) return
    void run()
  }, [key, run])

  useEffect(() => {
    if (key === null) return
    return window.xidao.reminders.onChanged(() => void run())
  }, [key, run])

  /** Replaces the data with what a successful write returned (until the next read). */
  const replace = useCallback((update: (data: T) => T) => {
    setValue((current) => (current === null || current.key !== keyRef.current ? current : { key: current.key, data: update(current.data) }))
  }, [])

  return {
    data: value !== null && value.key === key ? value.data : null,
    failure: failure !== null && failure.key === key ? failure.failure : null,
    reload: run,
    replace
  }
}

export interface RemindersState {
  overview: ReminderOverview | null
  failure: LoadFailure | null
  reload: () => Promise<void>
  /** A `setRule` call succeeded: show its rules in the overview's row until the next read. */
  updated: (thread: ThreadReminders) => void
}

async function loadOverview(): Promise<ReminderOverview> {
  const result = await window.xidao.reminders.overview()
  if (!result.ok) throw new ReminderStorageError()
  return result.overview
}

/** App-wide reminder overview: the navigation badge and every reminders list share it. */
export function useReminderOverview(): RemindersState {
  const live = useLiveReminders('overview', loadOverview)
  const { replace } = live
  const updated = useCallback(
    (thread: ThreadReminders) =>
      replace((overview) => ({
        ...overview,
        threads: overview.threads.map((row) => (row.threadId === thread.threadId ? { ...row, rules: thread.rules } : row))
      })),
    [replace]
  )
  return useMemo(
    () => ({ overview: live.data, failure: live.failure, reload: live.reload, updated }),
    [live.data, live.failure, live.reload, updated]
  )
}

export const RemindersContext = createContext<RemindersState | null>(null)

export function useRemindersContext(): RemindersState {
  const value = useContext(RemindersContext)
  if (value === null) throw new Error('RemindersContext is not provided')
  return value
}

/** Most thread IDs one `getRules` call accepts. */
const MAX_RULE_THREADS = 500

/** Rules of the given threads, in calls of at most 500 threads. */
export async function loadRules(threadIds: readonly ThreadId[]): Promise<Map<ThreadId, ThreadReminders>> {
  const rules = new Map<ThreadId, ThreadReminders>()
  for (let at = 0; at < threadIds.length; at += MAX_RULE_THREADS) {
    const result = await window.xidao.reminders.getRules({ threadIds: threadIds.slice(at, at + MAX_RULE_THREADS) })
    if (!result.ok) throw new ReminderStorageError()
    for (const thread of result.threads) rules.set(thread.threadId, thread)
  }
  return rules
}

export interface ThreadRulesState {
  /** `undefined` while not known yet for that thread. */
  rulesOf: (threadId: ThreadId) => Record<ReminderKind, ReminderRule> | undefined
  failure: LoadFailure | null
  reload: () => void
  /** A `setRule` call succeeded: show what it returned. */
  updated: (thread: ThreadReminders) => void
}

/** Rules of a set of threads (a list's rows or the open thread), kept current by `onChanged`. */
export function useThreadRules(threadIds: readonly ThreadId[]): ThreadRulesState {
  const unique = useMemo(() => [...new Set(threadIds)], [threadIds])
  const key = unique.length === 0 ? null : unique.join(',')
  const idsRef = useRef(unique)
  useLayoutEffect(() => {
    idsRef.current = unique
  })
  const load = useCallback(() => loadRules(idsRef.current), [])
  const live = useLiveReminders(key, load)
  const { data, replace, reload } = live
  const rulesOf = useCallback((threadId: ThreadId) => data?.get(threadId)?.rules, [data])
  const updated = useCallback(
    (thread: ThreadReminders) =>
      replace((current) => {
        const next = new Map(current)
        next.set(thread.threadId, thread)
        return next
      }),
    [replace]
  )
  return { rulesOf, failure: live.failure, reload: () => void reload(), updated }
}
