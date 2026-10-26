import { randomUUID } from 'node:crypto'
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/settings'
import type { CheckRequestResult, RemindersApi } from '../../shared/reminders'
import type { ForumClient } from '../forum/contract'
import type { RequestScheduler } from '../reading/scheduler'
import type { AppStore } from '../storage/contract'
import type { ReminderBackoff, ReminderNotifier } from './contract'
import { runReminderRound } from './engine'

export interface ReminderService extends Omit<RemindersApi, 'onOpenList'> {
  /** Cold start, explicit reopen and manual checks share one single-flight and the 60 s cooldown. */
  request(): Promise<CheckRequestResult>
  startScheduling(): Promise<void>
  configure(settings: AppSettings): void
  suspend(): void
  resume(): void
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
  random?: () => number
  /** Returns a cancellation function; the callback never runs synchronously. */
  setTimer?: (callback: () => void, delayMs: number) => () => void
  afterBatch?: () => Promise<void>
}): ReminderService {
  const now = deps.now ?? (() => new Date().toISOString())
  const monotonicNow = deps.monotonicNow ?? (() => performance.now())
  const random = deps.random ?? Math.random
  const setTimer = deps.setTimer ?? ((callback: () => void, delay: number) => {
    const timer = setTimeout(callback, delay)
    timer.unref()
    return () => clearTimeout(timer)
  })
  let settings: AppSettings | null = null
  let backoff: ReminderBackoff = { minutes: 0, episodeId: null, notified: false, dismissed: false }
  let loading: Promise<void> | null = null
  function loaded(): Promise<void> {
    return loading ??= Promise.all([deps.store.loadSettings(), deps.store.loadReminderBackoff()]).then(([saved, state]) => {
      settings ??= saved
      backoff = state
    }).catch((error: unknown) => { loading = null; throw error })
  }
  let stateQueue: Promise<unknown> = Promise.resolve()
  function saveBackoff(update: (current: ReminderBackoff) => ReminderBackoff): Promise<void> {
    const task = stateQueue.then(async () => {
      await loaded()
      const next = update(backoff)
      try {
        await deps.store.saveReminderBackoff(next)
      } catch (error) {
        // Failed storage cannot acknowledge or clear a notice. A newly observed limit must still
        // slow this process down, but its notification latch stays unset until a durable save.
        if (next.minutes > backoff.minutes) backoff = { ...backoff, minutes: next.minutes, episodeId: next.episodeId }
        throw error
      }
      backoff = next
    })
    stateQueue = task.catch(() => undefined)
    return task
  }
  let scheduling = false
  let cancelTimer: (() => void) | null = null
  let due: number | null = null
  let suspendedAt: number | null = null
  let slept = 0
  const awakeNow = () => (suspendedAt ?? monotonicNow()) - slept
  const remainingTime = () => due === null ? null : Math.max(0, due - awakeNow())
  const retryAt = () => backoff.episodeId === null || due === null ? null : new Date(Date.parse(now()) + remainingTime()!).toISOString()
  function arm(): void {
    cancelTimer?.()
    cancelTimer = null
    if (!scheduling || suspendedAt !== null || due === null) return
    cancelTimer = setTimer(() => {
      cancelTimer = null
      // A late callback is one tick, never a queue of missed checks.
      void request()
      schedule()
    }, remainingTime()!)
  }
  function schedule(): void {
    const interval = settings?.reminderInterval ?? DEFAULT_SETTINGS.reminderInterval
    due = scheduling && interval !== 0 ? awakeNow() + Math.max(interval, backoff.minutes) * 60_000 + random() * 180_000 : null
    arm()
    changed()
  }
  async function startScheduling(): Promise<void> {
    await loaded()
    if (scheduling) return
    scheduling = true
    schedule()
  }
  function configure(value: AppSettings): void {
    const previous = settings?.reminderInterval
    settings = value
    if (previous !== value.reminderInterval) schedule()
  }
  function suspend(): void {
    if (suspendedAt !== null) return
    suspendedAt = monotonicNow()
    cancelTimer?.()
    cancelTimer = null
  }
  function resume(): void {
    if (suspendedAt === null) return
    slept += monotonicNow() - suspendedAt
    suspendedAt = null
    arm()
    changed()
  }
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
  const cooldownRemaining = () => Math.max(0, 60_000 - (awakeNow() - lastStart))
  async function request(): Promise<CheckRequestResult> {
    if (active !== null) return { accepted: false, reason: 'running', retryAfterMs: 0 }
    const remaining = cooldownRemaining()
    if (remaining > 0) return { accepted: false, reason: 'cooldown', retryAfterMs: remaining }
    const completion = Promise.withResolvers<void>()
    const current = { abort: new AbortController(), reason: null as 'quit' | 'user' | null, done: completion.promise, resolve: () => completion.resolve() }
    active = current // Reserve before the first worker await: simultaneous triggers never queue.
    const acceptedAt = awakeNow()
    let rules
    try {
      await loaded()
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
        const result = await runReminderRound({ ...deps, now, changed }, { rules, signal: current.abort.signal, increased })
        if (result.rateLimited) {
          let notify = false
          try {
            await saveBackoff((previous) => {
              notify = !previous.notified
              return { minutes: Math.min(120, Math.max(previous.minutes, settings!.reminderInterval || 15) * 2),
                episodeId: previous.episodeId ?? randomUUID(), notified: true, dismissed: previous.dismissed }
            })
          } finally {
            schedule()
          }
          if (notify && settings!.reminderSystemNotifications) {
            const retry = retryAt()
            const time = retry === null ? null : new Date(retry).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
            notifySystem(`论坛限流，提醒检查已暂停，${time === null ? '自动检查已关闭' : `${time} 后重试`}`)
          }
        } else if (result.complete && !current.abort.signal.aborted && backoff.episodeId !== null) {
          await saveBackoff(() => ({ minutes: 0, episodeId: null, notified: false, dismissed: false }))
          schedule()
        }
      } catch {
        // Storage refusal is not a successful check: preserve counts, positions and backoff.
      }
      try {
        await deps.store.finishReminderCheck(now())
      } catch {
        // The previous 上次检查 time stays.
      }
      // One notification per check with new counts, whether it finished or was interrupted (quit
      // included). A failed or unavailable notification changes nothing in the app.
      if (increased.size > 0 && settings!.reminderSystemNotifications) notifySystem(`${increased.size} 个串有新提醒`)
      if (active === current) active = null
      current.resolve()
      changed()
    })()
    return { accepted: true }
  }
  function notifySystem(body: string): void {
    try { deps.notifier.show({ title: '汐岛提醒', body }) }
    catch { console.error('[reminders] notification failed') }
  }
  async function stop(reason: 'quit' | 'user'): Promise<void> {
    if (reason === 'quit') {
      scheduling = false
      schedule()
    }
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
    startScheduling,
    configure,
    suspend,
    resume,
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
    dismissRateLimit: ({ id }) => storage(async () => {
      await saveBackoff((current) => current.episodeId === id ? { ...current, dismissed: true } : current)
      changed()
      return {}
    }),
    overview: () => storage(async () => {
      await loaded()
      const { lastCheckedAt, ...stored } = await deps.store.reminderOverview()
      return { overview: { ...stored, checker: { running: active !== null, cooldownRemainingMs: cooldownRemaining(), lastCheckedAt,
        retryAt: retryAt(), rateLimit: backoff.episodeId === null ? null : { id: backoff.episodeId, dismissed: backoff.dismissed } } } }
    }),
    onChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
}
