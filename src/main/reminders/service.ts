import type { CheckRequestResult, RemindersApi } from '../../shared/reminders'
import type { ForumClient } from '../forum/contract'
import type { RequestScheduler } from '../reading/scheduler'
import type { AppStore } from '../storage/contract'
import type { ReminderNotifier } from './contract'
import { runReminderRound } from './engine'

export interface ReminderService extends Omit<RemindersApi, 'onOpenList'> {
  /** Cold start, explicit reopen and manual checks share one single-flight and the 60 s cooldown. */
  request(): Promise<CheckRequestResult>
  stop(reason: 'quit' | 'user'): Promise<void>
  /** Deterministic completion seam; does not trigger or enqueue a check. */
  whenIdle(): Promise<void>
}

export function createReminderService(deps: {
  store: AppStore
  client: Pick<ForumClient, 'getThreadPage' | 'getRef'>
  scheduler: RequestScheduler
  notifier: ReminderNotifier
  now?: () => string
  monotonicNow?: () => number
  afterBatch?: () => Promise<void>
}): ReminderService {
  const now = deps.now ?? (() => new Date().toISOString())
  const monotonicNow = deps.monotonicNow ?? (() => performance.now())
  let lastStart = -Infinity
  let active: { abort: AbortController; reason: 'quit' | 'user' | null; done: Promise<void>; resolve(): void } | null = null
  const listeners = new Set<() => void>()
  let changePending = false
  function changed(): void {
    if (changePending) return
    changePending = true
    queueMicrotask(() => {
      changePending = false
      for (const listener of listeners) listener()
    })
  }
  const cooldownRemaining = () => Math.max(0, 60_000 - (monotonicNow() - lastStart))
  async function request(): Promise<CheckRequestResult> {
    if (active !== null) return { accepted: false, reason: 'running', retryAfterMs: 0 }
    const remaining = cooldownRemaining()
    if (remaining > 0) return { accepted: false, reason: 'cooldown', retryAfterMs: remaining }
    const completion = Promise.withResolvers<void>()
    const current = { abort: new AbortController(), reason: null as 'quit' | 'user' | null, done: completion.promise, resolve: () => completion.resolve() }
    active = current // Reserve before the first worker await: simultaneous triggers never queue.
    const acceptedAt = monotonicNow()
    let rules
    try {
      rules = await deps.store.reminderRuleSnapshots()
    } catch {
      active = null
      current.resolve()
      return { accepted: false, reason: 'storage', retryAfterMs: 0 }
    }
    lastStart = acceptedAt
    changed()
    void (async () => {
      const increased = new Set<string>()
      try {
        await runReminderRound({ ...deps, now, changed }, { rules, signal: current.abort.signal, increased })
      } catch {
        // Storage refusal is not a forum failure: counts and positions already saved stay.
      }
      try {
        await deps.store.finishReminderCheck(now())
      } catch {
        // The previous 上次检查 time stays.
      }
      // One notification per check with new counts, whether it finished or was interrupted (quit
      // included). A failed or unavailable notification changes nothing in the app.
      if (increased.size > 0) {
        try {
          deps.notifier.show({ title: '汐岛提醒', body: `${increased.size} 个串有新提醒` })
        } catch {
          console.error('[reminders] notification failed')
        }
      }
      if (active === current) active = null
      current.resolve()
      changed()
    })()
    return { accepted: true }
  }
  async function stop(reason: 'quit' | 'user'): Promise<void> {
    const current = active
    if (current === null) return
    current.reason ??= reason
    current.abort.abort()
    await current.done
  }
  async function storage<T extends object>(work: () => Promise<T>): Promise<({ ok: true } & T) | { ok: false; reason: 'storage' }> {
    try { return { ok: true, ...await work() } }
    catch { return { ok: false, reason: 'storage' } }
  }
  return {
    request,
    check: request,
    cancel: () => stop('user'),
    stop,
    whenIdle: () => active?.done ?? Promise.resolve(),
    getRules: ({ threadIds }) => storage(async () => ({ threads: await deps.store.getReminderRules(threadIds) })),
    setRule: ({ threadId, kind, enabled }) => storage(async () => {
      const thread = await deps.store.setReminderRule(threadId, kind, enabled, now())
      changed()
      return { thread }
    }),
    closeForThreads: ({ threadIds, reason }) => storage(async () => {
      const closed = await deps.store.closeReminderThreads(threadIds, reason, now())
      changed()
      return { closed }
    }),
    clear: ({ threadId }) => storage(async () => {
      if (await deps.store.clearReminderCounts(threadId)) changed()
      return {}
    }),
    overview: () => storage(async () => {
      const { lastCheckedAt, ...stored } = await deps.store.reminderOverview()
      return { overview: { ...stored, checker: { running: active !== null, cooldownRemainingMs: cooldownRemaining(), lastCheckedAt } } }
    }),
    onChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
}
