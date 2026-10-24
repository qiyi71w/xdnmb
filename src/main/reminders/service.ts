import type {
  CheckRequestResult, CheckTrigger, RemindersApi, RoundStopReason, NotificationCoverage
} from '../../shared/reminders'
import type { ForumClient } from '../forum/contract'
import type { RequestScheduler } from '../reading/scheduler'
import type { AppStore } from '../storage/contract'
import type { ReminderNotifier } from './contract'
import { runReminderRound } from './engine'

export interface ReminderService extends Omit<RemindersApi, 'onOpenList'> {
  request(trigger: CheckTrigger): Promise<CheckRequestResult>
  recover(): Promise<void>
  stop(reason: 'quit' | 'user'): Promise<void>
  /** Deterministic completion seam; does not trigger or enqueue a check. */
  whenIdle(): Promise<void>
}

export function createReminderService(deps: {
  store: AppStore
  client: Pick<ForumClient, 'getThreadPage'>
  scheduler: RequestScheduler
  notifier: ReminderNotifier
  now?: () => string
  monotonicNow?: () => number
  afterBatch?: () => Promise<void>
}): ReminderService {
  const now = deps.now ?? (() => new Date().toISOString())
  const monotonicNow = deps.monotonicNow ?? (() => performance.now())
  let lastStart = -Infinity
  let active: { abort: AbortController; reason: RoundStopReason | null; done: Promise<void>; resolve(): void } | null = null
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
  async function request(trigger: CheckTrigger): Promise<CheckRequestResult> {
    if (active !== null) return { accepted: false, reason: 'running', retryAfterMs: 0 }
    const remaining = Math.max(0, 60_000 - (monotonicNow() - lastStart))
    if (remaining > 0) return { accepted: false, reason: 'cooldown', retryAfterMs: remaining }
    const completion = Promise.withResolvers<void>()
    const current = { abort: new AbortController(), reason: null as RoundStopReason | null, done: completion.promise, resolve: () => completion.resolve() }
    active = current // Reserve before the first worker await: simultaneous triggers never queue.
    const acceptedAt = monotonicNow()
    try {
      const rules = await deps.store.reminderRuleSnapshots()
      const round = await deps.store.createReminderRound(trigger, now(), new Set(rules.map((rule) => rule.threadId)).size)
      lastStart = acceptedAt
      changed()
      void (async () => {
        try {
          const result = await runReminderRound({ ...deps, now, changed }, {
            round, rules, signal: current.abort.signal, stopReason: () => current.reason
          })
          const scope: NotificationCoverage = round.state !== 'finished' ? 'interrupted' : round.threadsFailed > 0 ? 'failed-some'
            : result.partial ? 'partial' : 'complete'
          // Registration also atomically revalidates each event kind's live generation. It is the
          // irreversible notification attempt boundary, even on unsupported systems or a crash.
          const record = await deps.store.registerReminderNotification(round.id, scope, now())
          if (record !== null) {
            const suffix = scope === 'failed-some' ? '；部分串检查失败，数量不是全部新增'
              : scope !== 'complete' ? '；本轮检查未完成，仅含已确认的命中' : ''
            const settle = (state: 'shown' | 'failed' | 'unavailable') => {
              void deps.store.settleReminderNotification(record.id, state).then(changed, () => undefined)
            }
            try {
              if (!deps.notifier.show({ title: '汐岛提醒', body: `${record.threadCount} 个串有 ${record.eventCount} 条新提醒${suffix}` }, settle)) settle('unavailable')
            } catch {
              settle('failed')
            }
          }
        } catch {
          // Storage refusal is not a forum failure. Keep all existing personal records; if this
          // write is also unavailable startup recovery still marks the unfinished round.
          round.state = 'interrupted'
          round.finishedAt = now()
          round.stopReason = current.reason
          await deps.store.saveReminderRound(round).catch(() => undefined)
        } finally {
          if (active === current) active = null
          current.resolve()
          changed()
        }
      })()
      return { accepted: true, roundId: round.id }
    } catch {
      if (active === current) active = null
      current.resolve()
      return { accepted: false, reason: 'storage', retryAfterMs: 0 }
    }
  }
  async function stop(reason: 'quit' | 'user'): Promise<void> {
    const current = active
    if (current === null) return
    current.reason ??= reason
    current.abort.abort()
    await current.done
  }
  return {
    request,
    check: () => request('manual'),
    cancel: () => stop('user'),
    stop,
    whenIdle: () => active?.done ?? Promise.resolve(),
    async recover() { await deps.store.recoverReminders(now()); changed() },
    async getRules({ threadIds }) {
      try { return { ok: true, threads: await deps.store.getReminderRules(threadIds) } }
      catch { return { ok: false, reason: 'storage' } }
    },
    async setRule({ threadId, kind, enabled }) {
      try {
        const thread = await deps.store.setReminderRule(threadId, kind, enabled, now())
        changed()
        return { ok: true, thread }
      } catch { return { ok: false, reason: 'storage' } }
    },
    async closeForThreads({ threadIds, reason }) {
      try {
        const closed = await deps.store.closeReminderThreads(threadIds, reason, now())
        changed()
        return { ok: true, closed }
      } catch { return { ok: false, reason: 'storage' } }
    },
    async overview() {
      try {
        return { ok: true, overview: { ...await deps.store.reminderOverview(), checker: {
          running: active !== null, cooldownRemainingMs: Math.max(0, 60_000 - (monotonicNow() - lastStart))
        } } }
      } catch { return { ok: false, reason: 'storage' } }
    },
    onChanged(listener) { listeners.add(listener); return () => { listeners.delete(listener) } }
  }
}
