import { randomUUID } from 'node:crypto'
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/settings'
import type { ThreadId } from '../../shared/forum'
import type { CheckRequestResult, RemindersApi } from '../../shared/reminders'
import { ForumReadError, ReadCancelledError, type ForumClient } from '../forum/contract'
import type { RequestScheduler } from '../reading/scheduler'
import type { DisplayReadObserver } from '../reading/service'
import type { AppStore } from '../storage/contract'
import type { ReminderBackoff, ReminderNotifier } from './contract'
import { readOpenedPoPage, runReminderRound } from './engine'

/** How long a queued open read waits for the reader's own read, started by the same open, to begin. */
const OPEN_READ_SETTLE_MS = 1_000

export interface ReminderService extends Omit<RemindersApi, 'onOpenList'> {
  /** Cold start, explicit reopen and manual checks share one single-flight and the 60 s cooldown. */
  request(): Promise<CheckRequestResult>
  startScheduling(): Promise<void>
  configure(settings: AppSettings): void
  suspend(): void
  resume(): void
  stop(reason: 'quit' | 'user'): Promise<void>
  /**
   * Deterministic completion seam: the running check and open reads already handed to the request
   * lane. Does not trigger or enqueue anything.
   */
  whenIdle(): Promise<void>
  /** Reading service seam: a reader's PO page saved after an open makes its queued PO read redundant. */
  displayReads: DisplayReadObserver
  /** A publication transaction may have corrected existing counts; emits change without checking. */
  publicationConfirmed(): void
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
    quitting = false
    if (scheduling) return
    scheduling = true
    schedule()
  }
  function configure(value: AppSettings): void {
    const previous = settings?.reminderInterval
    settings = value
    if (previous !== value.reminderInterval) schedule()
    armInitialization()
  }
  function suspend(): void {
    if (suspendedAt !== null) return
    suspendedAt = monotonicNow()
    cancelTimer?.()
    cancelTimer = null
    cancelInitialization?.()
    cancelInitialization = null
  }
  function resume(): void {
    if (suspendedAt === null) return
    slept += monotonicNow() - suspendedAt
    suspendedAt = null
    arm()
    armInitialization()
    changed()
  }
  let lastStart = -Infinity
  let active: { abort: AbortController; reason: 'quit' | 'user' | null; done: Promise<void>; resolve(): void } | null = null
  let quitting = false
  let intentEpoch = 0
  let ruleQueue: Promise<unknown> = Promise.resolve()
  // Only enable transitions queue work. Missing durable baselines survive failed attempts/restarts;
  // consuming an intent before its pass prevents failures from creating an automatic retry loop.
  const initializations = new Map<string, symbol>()
  let cancelInitialization: (() => void) | null = null
  const ruleKey = (rule: { threadId: string; kind: string }) => `${rule.threadId}:${rule.kind}`
  function mutateRules<T>(work: () => Promise<T>): Promise<T> {
    const task = ruleQueue.then(work)
    ruleQueue = task.catch(() => undefined)
    return task
  }
  function armInitialization(): void {
    cancelInitialization?.()
    cancelInitialization = null
    if (initializations.size === 0 || active !== null || suspendedAt !== null || quitting || backoff.episodeId !== null) return
    const remaining = cooldownRemaining()
    if (remaining === 0) void request(true)
    else cancelInitialization = setTimer(() => {
      cancelInitialization = null
      armInitialization()
    }, remaining)
  }
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
  async function request(initialization = false): Promise<CheckRequestResult> {
    if (active !== null) return { accepted: false, reason: 'running', retryAfterMs: 0 }
    const remaining = cooldownRemaining()
    if (remaining > 0) return { accepted: false, reason: 'cooldown', retryAfterMs: remaining }
    const completion = Promise.withResolvers<void>()
    const current = { abort: new AbortController(), reason: null as 'quit' | 'user' | null, done: completion.promise, resolve: () => completion.resolve() }
    active = current // Reserve before the first worker await: simultaneous triggers never queue.
    cancelInitialization?.()
    cancelInitialization = null
    // Tokens distinguish an enable arriving during an await (including disable/re-enable) from
    // the intent this pass owns, so completion cannot discard a newer generation's work.
    const intents = new Map(initializations)
    const consumeIntents = () => {
      for (const [key, token] of intents) if (initializations.get(key) === token) initializations.delete(key)
    }
    const release = () => {
      if (active === current) active = null
      current.resolve()
      armInitialization()
      changed()
    }
    const acceptedAt = awakeNow()
    let rules
    try {
      await loaded()
      if (initialization && backoff.episodeId !== null) {
        release()
        return { accepted: true }
      }
      rules = await deps.store.reminderRuleSnapshots()
      if (initialization) {
        const states = new Map((await deps.store.reminderStates()).map((state) => [ruleKey(state), state]))
        rules = rules.filter((rule) => {
          const key = ruleKey(rule)
          if (!intents.has(key) || initializations.get(key) !== intents.get(key)) return false
          const state = states.get(key)
          return state?.baseline === null || state?.baseline === undefined || (rule.kind === 'quote' && state.checkedPostId === null)
        })
      }
      consumeIntents()
    } catch {
      consumeIntents()
      release()
      return { accepted: false, reason: 'storage', retryAfterMs: 0 }
    }
    if (current.abort.signal.aborted || (initialization && rules.length === 0)) {
      release()
      return { accepted: true }
    }
    lastStart = acceptedAt
    changed()
    void (async () => {
      const increased = new Set<string>()
      const roundId = randomUUID()
      try {
        let limit: Promise<void> | null = null
        const result = await runReminderRound({ ...deps, now, changed },
          { rules, signal: current.abort.signal, increased, roundId, limited: () => { limit ??= limited() } })
        if (result.rateLimited) await (limit ?? limited())
        else if (!initialization && result.complete && !current.abort.signal.aborted && backoff.episodeId !== null) {
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
      try {
        // Confirmation and clearing can commit after the engine finishes. This read is the
        // notification decision; a later confirmation cannot retract an already chosen notice.
        const current = await deps.store.reminderIncreasedThreads(roundId)
        increased.clear()
        for (const threadId of current) increased.add(threadId)
      } catch {
        // Keep the engine's last successfully observed decision when storage becomes unavailable.
      }
      // One notification per check with new counts, whether it finished or was interrupted (quit
      // included). A failed or unavailable notification changes nothing in the app.
      if (increased.size > 0 && settings!.reminderSystemNotifications) notifySystem(`${increased.size} 个串有新提醒`)
      release()
    })()
    return { accepted: true }
  }
  /** A rate limit or captcha from a check or an open read: the same backoff, at most one notice per episode. */
  async function rateLimited(): Promise<void> {
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
  }
  /** Backoffs being saved for rate limits seen inside a lane slot; while any is pending, no open read goes out. */
  const limits = new Set<Promise<void>>()
  /**
   * Called synchronously in the rate-limited request's lane slot, so the lane cannot admit a queued
   * open read before the backoff applies. A failed save still slows this process down (`saveBackoff`).
   */
  function limited(): Promise<void> {
    const saving = rateLimited().catch(() => undefined)
    limits.add(saving)
    void saving.finally(() => limits.delete(saving))
    return saving
  }

  // ---- PO page 1 read after an open ----
  /** `opens` counts opens still clearing or qualifying a read not yet started. */
  interface OpenRead { readerSaved: boolean; abort: AbortController; started: boolean; opens: number }
  /** At most one registered (qualifying or queued, not yet sent) read per thread. */
  const openReads = new Map<ThreadId, OpenRead>()
  /** Every open read not settled yet, sent or not; quitting aborts them. */
  const openAborts = new Set<AbortController>()
  /** Open reads handed to the request lane (queued there or running). */
  const openTasks = new Set<Promise<void>>()
  /** A reader's display reads of PO pages in flight per thread, and the waits for them to end. */
  const readerReads = new Map<ThreadId, { count: number; idle: (() => void)[] }>()
  const displayReads: DisplayReadObserver = {
    begin(threadId, mode) {
      if (mode !== 'po') return () => undefined
      const entry = readerReads.get(threadId) ?? { count: 0, idle: [] }
      readerReads.set(threadId, entry)
      entry.count++
      let ended = false
      return () => {
        if (ended) return
        ended = true
        if (--entry.count > 0) return
        if (readerReads.get(threadId) === entry) readerReads.delete(threadId)
        for (const wake of entry.idle.splice(0)) wake()
      }
    },
    saved(threadId, mode) {
      const queued = openReads.get(threadId)
      if (mode === 'po' && queued !== undefined) queued.readerSaved = true
      // The saved page may have proven a confirmed local reply and corrected a count.
      changed()
    }
  }
  /** Resolves when `arm` calls its `done`; an abort disarms it and rejects. */
  function cancellable(signal: AbortSignal, arm: (done: () => void) => () => void): Promise<void> {
    if (signal.aborted) return Promise.reject(new ReadCancelledError())
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const abort = () => { disarm(); reject(new ReadCancelledError()) }
    const disarm = arm(() => { signal.removeEventListener('abort', abort); resolve() })
    signal.addEventListener('abort', abort, { once: true })
    return promise
  }
  function dropOpenRead(threadId: ThreadId, read: OpenRead): void {
    if (openReads.get(threadId) === read) openReads.delete(threadId)
    openAborts.delete(read.abort)
  }
  /**
   * An open registers its thread's PO page 1 read synchronously, before clearing and qualifying
   * await anything, so a reader PO page saved meanwhile still makes it redundant; a save before the
   * open does not. A thread already registered keeps its one read; the newest open decides whether
   * it is still needed. `qualify` starts the read only for an established PO追更 baseline, outside a
   * rate-limit backoff and quit; `cancel` withdraws an open whose clear failed.
   */
  function registerOpen(threadId: ThreadId): { cancel(): void; qualify(): Promise<void> } | null {
    if (quitting) return null
    const existing = openReads.get(threadId)
    const savedBefore = existing?.readerSaved === true
    const read = existing ?? { readerSaved: false, abort: new AbortController(), started: false, opens: 0 }
    if (existing === undefined) {
      openReads.set(threadId, read)
      openAborts.add(read.abort)
    }
    read.readerSaved = false
    read.opens++
    const settle = (send: boolean) => {
      read.opens--
      if (read.started) return
      if (send) {
        read.started = true
        void runOpenRead(threadId, read)
      } else if (read.opens === 0) dropOpenRead(threadId, read)
    }
    return {
      cancel() {
        // Not an open: a save it would have reset still counts for the earlier open.
        if (savedBefore) read.readerSaved = true
        settle(false)
      },
      async qualify() {
        let ready = false
        try {
          if (!read.started) {
            await loaded()
            ready = (await deps.store.getReminderRules([threadId]))[0]?.rules.po?.baseline === 'ready'
          }
        } catch {
          // A failed rule lookup only skips the read.
        }
        settle(ready && !quitting && !read.abort.signal.aborted && backoff.episodeId === null && limits.size === 0)
      }
    }
  }
  async function runOpenRead(threadId: ThreadId, read: OpenRead): Promise<void> {
    const { signal } = read.abort
    // Sent only while still useful: no reader PO page saved since the open, no backoff, no quit.
    const proceed = () => !signal.aborted && !quitting && backoff.episodeId === null && limits.size === 0 && !read.readerSaved
    try {
      // The reader's own PO read for this open starts just after the clear; let it go first.
      await cancellable(signal, (done) => setTimer(done, OPEN_READ_SETTLE_MS))
      for (let reader = readerReads.get(threadId); reader !== undefined; reader = readerReads.get(threadId)) {
        const { idle } = reader
        await cancellable(signal, (done) => {
          idle.push(done)
          return () => { idle.splice(idle.indexOf(done), 1) }
        })
      }
      if (!proceed()) return
      const sending = sendOpenRead(threadId, read, proceed)
      openTasks.add(sending)
      try { await sending } finally { openTasks.delete(sending) }
    } catch {
      // Cancelled while waiting.
    } finally {
      dropOpenRead(threadId, read)
    }
  }
  async function sendOpenRead(threadId: ThreadId, read: OpenRead, proceed: () => boolean): Promise<void> {
    let limit: Promise<void> | null = null
    try {
      await readOpenedPoPage({ ...deps, now }, threadId, read.abort.signal, () => {
        // Leaving the queue: a later open registers a read of its own.
        if (openReads.get(threadId) === read) openReads.delete(threadId)
        return proceed()
      }, () => {
        // Still inside this read's lane slot, so no check request is in flight: a check accepted
        // meanwhile sends nothing more and, interrupted, cannot clear the backoff this limit starts.
        active?.abort.abort()
        limit ??= limited()
      })
      // Its saved PO page may have proven a confirmed local reply and corrected the PO count.
      changed()
    } catch (error) {
      // A failed read leaves the PO baseline as it was. Rate limits and captchas back off like a check.
      if (error instanceof ForumReadError && error.error.kind === 'rate-limited') await (limit ?? limited())
    }
  }

  function notifySystem(body: string): void {
    try { deps.notifier.show({ title: '汐岛', body }) }
    catch { console.error('[reminders] notification failed') }
  }
  async function stop(reason: 'quit' | 'user'): Promise<void> {
    intentEpoch++
    initializations.clear()
    cancelInitialization?.()
    cancelInitialization = null
    if (reason === 'quit') {
      quitting = true
      scheduling = false
      schedule()
      openReads.clear()
      for (const abort of openAborts) abort.abort()
    }
    const current = active
    if (current !== null) {
      current.reason ??= reason
      current.abort.abort()
    }
    await Promise.all([current?.done, ...(reason === 'quit' ? openTasks : [])])
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
    whenIdle: async () => { while (active !== null || openTasks.size > 0) await Promise.all([active?.done, ...openTasks]) },
    displayReads,
    publicationConfirmed: changed,
    getRules: ({ threadIds }) => storage(async () => ({ threads: await deps.store.getReminderRules(threadIds) })),
    setRule: ({ threadId, kind, enabled }) => {
      const epoch = intentEpoch
      return storage(() => mutateRules(async () => {
        const before = (await deps.store.getReminderRules([threadId]))[0]!.rules[kind]
        const thread = await deps.store.setReminderRule(threadId, kind, enabled, now())
        const key = ruleKey({ threadId, kind })
        if (!enabled) initializations.delete(key)
        else if (!before.enabled && epoch === intentEpoch && !quitting) initializations.set(key, Symbol(key))
        changed()
        armInitialization()
        return { thread }
      }))
    },
    closeForThreads: ({ threadIds, reason }) => storage(() => mutateRules(async () => {
      const closed = await deps.store.closeReminderThreads(threadIds, reason, now())
      for (const key of initializations.keys()) if (threadIds.some((id) => key.startsWith(`${id}:`))) initializations.delete(key)
      changed()
      armInitialization()
      return { closed }
    })),
    clear: ({ threadId, source }) => storage(async () => {
      const open = source === 'open' ? registerOpen(threadId) : null
      try {
        if (await deps.store.clearReminderCounts(threadId)) changed()
      } catch (error) {
        open?.cancel()
        throw error
      }
      await open?.qualify()
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
