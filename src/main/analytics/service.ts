import {
  EMPTY_ANALYTICS_RECORD, type AnalyticsApi, type AnalyticsAvailability, type AnalyticsChoice, type AnalyticsChoiceResult,
  type AnalyticsDeletionFailure, type AnalyticsDeletionResult, type AnalyticsRecord, type AnalyticsState
} from '../../shared/analytics'
import {
  ANALYTICS_INSTANCE_ID_PATTERN, ANALYTICS_PATHS, ANALYTICS_PROTOCOL_VERSION, ANALYTICS_STAT_DAY_PATTERN, ANALYTICS_TOKEN_PATTERN,
  type AnalyticsPlatform
} from '../../shared/analytics-protocol'
import type { SecretProtector } from '../identity/protection'
import type { AppStore } from '../storage/contract'
import type { AnalyticsResponse, AnalyticsTransport } from './transport'

/**
 * Request pacing of the automatic report. One success per statistics day is all that is needed;
 * everything else bounds what a failing service, a focus storm or a clock change can cause.
 */
export const ANALYTICS_PACING = {
  /** Longest wait between two looks at the day and foreground state while statistics are on. */
  recheckMs: 15 * 60_000,
  /** Least time between two automatic attempts, whatever triggered them. */
  minSpacingMs: 60_000,
  /** Waits after consecutive failures without a usable answer (network, 5xx). */
  backoffMs: [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const,
  /** After `capacity_exhausted`. */
  capacityMs: 2 * 60 * 60_000,
  /** Upper bound of a `Retry-After` honoured. */
  maxRetryAfterMs: 24 * 60 * 60_000,
  /** The service counted a different day than this device's clock says: look again after this. */
  skewRecheckMs: 30 * 60_000,
  /** Automatic HTTP requests (registration and reports) per local statistics day and run. */
  requestsPerDay: 6
} as const

export interface AnalyticsService extends AnalyticsApi {
  start(): Promise<void>
  /** A fact behind the foreground decision changed (focus, show, restore, unlock, resume). */
  poke(): void
  /**
   * Quitting: abandons the running attempt or deletion (never waits for the network) and schedules
   * nothing until `resume`. Settles once their local writes are done, before storage closes.
   */
  stop(): Promise<void>
  resume(): void
}

type Store = Pick<AppStore, 'loadAnalytics' | 'saveAnalytics'>

const DAY_MS = 24 * 60 * 60_000
const BEIJING_OFFSET_MS = 8 * 60 * 60_000

/** Statistics day (Beijing time) of a wall-clock instant. */
export function beijingDay(ms: number): string {
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10)
}

function untilNextBeijingDay(ms: number): number {
  const shifted = ms + BEIJING_OFFSET_MS
  return DAY_MS - (((shifted % DAY_MS) + DAY_MS) % DAY_MS)
}

function errorCode(response: AnalyticsResponse): string | null {
  const body = response.body
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const error = (body as Record<string, unknown>).error
  return typeof error === 'string' ? error : null
}

/**
 * Voluntary usage statistics of this installation. Nothing is sent, and no identity exists, until
 * the user turned statistics on and that choice was stored. While on, one activity report per
 * Beijing statistics day is sent when the window is in the foreground (decided by `isForeground`).
 * Turning off stops at once and cancels the running request; deleting first turns off, then asks
 * the service to remove what is linked to this device, keeping the credentials until it confirmed.
 */
export function createAnalyticsService(options: {
  store: Store
  /** `ready` unless the database is read-only or failed to open. */
  storageReady: () => boolean
  protector: SecretProtector
  /** `null`: this build has no receiving service. */
  transport: AnalyticsTransport | null
  /** Host name of the receiving service, shown in the disclosure. */
  receiver: string | null
  /** `null`: this platform is not part of the statistics. */
  platform: AnalyticsPlatform | null
  version: string
  isForeground: () => boolean
  /** Wall clock (ms): decides the local statistics day. */
  now?: () => number
  /** Monotonic clock (ms): spacing and back-off, immune to clock changes. */
  monotonic?: () => number
  /** Runs `callback` after `ms`; returns its cancellation. */
  schedule?: (callback: () => void, ms: number) => () => void
}): AnalyticsService {
  const now = options.now ?? Date.now
  const monotonic = options.monotonic ?? (() => performance.now())
  const schedule = options.schedule ?? ((callback, ms) => {
    const timer = setTimeout(callback, ms)
    timer.unref()
    return () => clearTimeout(timer)
  })
  const transport = options.transport
  const platform = options.platform

  let record: AnalyticsRecord = EMPTY_ANALYTICS_RECORD
  let availability: AnalyticsAvailability = 'available'
  /** This run's effective choice; differs from `record.choice` only after a failed save. */
  let choice: AnalyticsChoice = 'unset'
  let initial: Promise<void> | null = null
  let started = false
  let paused = false

  /** Bumped whenever the running statistics stop: late results of an older run change nothing. */
  let generation = 0
  let attempt: Promise<void> | null = null
  let attemptController: AbortController | null = null
  let deletionController: AbortController | null = null
  let cancelTimer: (() => void) | null = null
  /** Decrypted token of `record.identity`, kept in the main process for this run only. */
  let token: string | null = null
  /**
   * A deletion was requested but even its intent could not be stored: it stays unresolved for this
   * run (statistics off, turning on refused) although the stored record does not say so.
   */
  let unresolvedDeletion = false

  let notBefore = -Infinity
  let lastAttemptAt = -Infinity
  let failures = 0
  let budget = { day: '', used: 0 }
  /** The service refused the request itself (protocol mismatch): no automatic retry this run. */
  let halted = false

  let writes: Promise<unknown> = Promise.resolve()
  let operations: Promise<unknown> = Promise.resolve()
  let deleting: Promise<AnalyticsDeletionResult> | null = null

  function queue<T>(tail: 'writes' | 'operations', work: () => Promise<T>): Promise<T> {
    const previous = tail === 'writes' ? writes : operations
    const run = previous.then(work, work)
    if (tail === 'writes') writes = run.catch(() => undefined)
    else operations = run.catch(() => undefined)
    return run
  }

  /**
   * Stores `change(record)` and adopts it; serialized, so concurrent changes never lose each
   * other. `change` returning `null` skips (e.g. a result of a stopped run). Resolves whether stored.
   */
  function update(change: (current: AnalyticsRecord) => AnalyticsRecord | null): Promise<boolean> {
    return queue('writes', async () => {
      const next = change(record)
      if (next === null) return false
      try {
        await options.store.saveAnalytics(next)
      } catch {
        return false
      }
      record = next
      return true
    })
  }

  function state(): AnalyticsState {
    return {
      availability,
      choice,
      saved: record.choice,
      hasIdentity: record.identity !== null,
      deletionPending: record.deletionPending || unresolvedDeletion,
      receiver: options.receiver
    }
  }

  function clearTimer(): void {
    cancelTimer?.()
    cancelTimer = null
  }

  function wake(ms: number): void {
    clearTimer()
    cancelTimer = schedule(() => {
      cancelTimer = null
      evaluate()
    }, Math.max(0, ms))
  }

  /** Stops the running statistics: nothing queued stays, the request in flight is aborted. */
  function stopRun(): void {
    generation++
    clearTimer()
    attemptController?.abort()
  }

  function running(): boolean {
    return started && !paused && availability === 'available' && choice === 'on' && !record.deletionPending && !unresolvedDeletion && !halted
  }

  /** Looks whether a report is due now; otherwise when to look again. Never more than one in flight. */
  function evaluate(): void {
    if (!running() || attempt !== null) return
    const wallNow = now()
    const today = beijingDay(wallNow)
    const nextDay = untilNextBeijingDay(wallNow) + 1000
    if (record.reportedDay === today) {
      wake(Math.min(ANALYTICS_PACING.recheckMs, nextDay))
      return
    }
    if (budget.day !== today) budget = { day: today, used: 0 }
    if (budget.used >= ANALYTICS_PACING.requestsPerDay) {
      wake(Math.min(ANALYTICS_PACING.recheckMs, nextDay))
      return
    }
    const monoNow = monotonic()
    const gate = Math.max(notBefore, lastAttemptAt + ANALYTICS_PACING.minSpacingMs)
    if (monoNow < gate) {
      wake(Math.min(gate - monoNow, ANALYTICS_PACING.recheckMs, nextDay))
      return
    }
    if (!options.isForeground()) {
      // A focus, restore or unlock pokes sooner; this only catches a missed event.
      wake(Math.min(ANALYTICS_PACING.recheckMs, nextDay))
      return
    }
    clearTimer()
    lastAttemptAt = monoNow
    const current = generation
    const controller = new AbortController()
    attemptController = controller
    attempt = report(current, controller.signal)
      // No usable answer; a stopped run's (aborted) attempt leaves the pacing of the next alone.
      .catch(() => { if (current === generation) backOff() })
      .finally(() => {
        attempt = null
        if (attemptController === controller) attemptController = null
        evaluate()
      })
  }

  function backOff(): void {
    failures++
    const steps = ANALYTICS_PACING.backoffMs
    notBefore = monotonic() + steps[Math.min(failures, steps.length) - 1]!
  }

  /** A response that is not the expected success. */
  function refused(response: AnalyticsResponse): void {
    const code = errorCode(response)
    if (response.status === 429) {
      const wait = Math.min((response.retryAfterSeconds ?? 60) * 1000, ANALYTICS_PACING.maxRetryAfterMs)
      notBefore = monotonic() + Math.max(wait, ANALYTICS_PACING.minSpacingMs)
    } else if (response.status === 503 && code === 'capacity_exhausted') {
      notBefore = monotonic() + ANALYTICS_PACING.capacityMs
    } else if (response.status >= 400 && response.status < 500) {
      // The request itself is wrong for this service; repeating it changes nothing.
      halted = true
    } else {
      backOff()
    }
  }

  async function send(path: (typeof ANALYTICS_PATHS)[keyof typeof ANALYTICS_PATHS], body: object, signal: AbortSignal): Promise<AnalyticsResponse> {
    if (transport === null) throw new Error('Analytics not configured')
    budget.used++
    return transport.post(path, body, signal)
  }

  async function report(current: number, signal: AbortSignal): Promise<void> {
    if (platform === null) return
    if (record.identity === null) {
      if (!(await options.protector.isAvailable())) {
        // Never a plain-text credential: wait for OS protection to come back.
        notBefore = monotonic() + ANALYTICS_PACING.recheckMs
        return
      }
      const response = await send(ANALYTICS_PATHS.register, { protocol: ANALYTICS_PROTOCOL_VERSION }, signal)
      if (current !== generation) return
      const body = response.body as Record<string, unknown> | null
      if (response.status !== 201 || typeof body !== 'object' || body === null ||
          typeof body.instanceId !== 'string' || !ANALYTICS_INSTANCE_ID_PATTERN.test(body.instanceId) ||
          typeof body.token !== 'string' || !ANALYTICS_TOKEN_PATTERN.test(body.token)) {
        refused(response)
        return
      }
      const instanceId = body.instanceId
      const received = body.token
      const ciphertext = Buffer.from(await options.protector.encrypt(received)).toString('base64')
      // Stored before the first report, so deletion stays possible for whatever gets counted.
      const stored = await update((latest) =>
        current !== generation || latest.choice !== 'on' || latest.deletionPending || latest.identity !== null
          ? null
          : { ...latest, identity: { instanceId, protectedToken: ciphertext }, reportedDay: null })
      if (!stored) {
        // A registration never reported is never counted; the service drops it after 31 days.
        if (current === generation) backOff()
        return
      }
      token = received
    }
    const identity = record.identity
    if (identity === null || current !== generation) return
    // A registration can outlast the moment that started it: report only foreground use, and only
    // within today's budget (a registration may have spent its last request).
    if (!options.isForeground() || budget.used >= ANALYTICS_PACING.requestsPerDay) return
    token ??= await options.protector.decrypt(Buffer.from(identity.protectedToken, 'base64'))
    if (current !== generation) return
    const response = await send(ANALYTICS_PATHS.activity, {
      protocol: ANALYTICS_PROTOCOL_VERSION,
      instanceId: identity.instanceId,
      token,
      version: options.version,
      platform
    }, signal)
    if (current !== generation) return
    const body = response.body as Record<string, unknown> | null
    if (response.status === 200 && typeof body === 'object' && body !== null &&
        typeof body.statDay === 'string' && ANALYTICS_STAT_DAY_PATTERN.test(body.statDay)) {
      const statDay = body.statDay
      failures = 0
      // The service's day decides; a differing local clock looks again later, within the budget.
      if (statDay !== beijingDay(now())) notBefore = monotonic() + ANALYTICS_PACING.skewRecheckMs
      // Not stored (disk failure): still known for this run, so no second report today.
      const stored = await update((latest) => (current !== generation || latest.identity?.instanceId !== identity.instanceId ? null : { ...latest, reportedDay: statDay }))
      if (!stored && current === generation) record = { ...record, reportedDay: statDay }
      return
    }
    if (response.status === 403 && errorCode(response) === 'invalid_credentials') {
      // The service no longer knows this identity (deleted elsewhere or expired after 31 idle
      // days). Only while still on and with no deletion pending may a new one be registered.
      token = null
      const dropped = await update((latest) =>
        current !== generation || latest.choice !== 'on' || latest.deletionPending || latest.identity?.instanceId !== identity.instanceId
          ? null
          : { ...latest, identity: null, reportedDay: null })
      if (!dropped) backOff()
      return
    }
    refused(response)
  }

  async function load(): Promise<void> {
    if (platform === null) availability = 'unsupported-platform'
    else if (transport === null) availability = 'not-configured'
    else if (!options.storageReady()) availability = 'storage-unavailable'
    try {
      record = await options.store.loadAnalytics()
    } catch {
      record = EMPTY_ANALYTICS_RECORD
      if (availability === 'available') availability = 'storage-unavailable'
    }
    choice = availability === 'available' ? record.choice : record.choice === 'on' ? 'off' : record.choice
    started = true
    evaluate()
  }

  function start(): Promise<void> {
    initial ??= load()
    return initial
  }

  async function setChoice(requested: 'on' | 'off'): Promise<AnalyticsChoiceResult> {
    await start()
    return queue('operations', async (): Promise<AnalyticsChoiceResult> => {
      if (availability !== 'available') return { result: 'refused', reason: 'unavailable', state: state() }
      if (requested === 'off') {
        // Stops this run first, whatever the save does: off never waits for storage.
        stopRun()
        choice = 'off'
        const saved = await update((latest) => ({ ...latest, choice: 'off' }))
        return { result: saved ? 'saved' : 'not-saved', state: state() }
      }
      if (record.deletionPending || unresolvedDeletion) return { result: 'refused', reason: 'deletion-pending', state: state() }
      if (!(await options.protector.isAvailable())) return { result: 'refused', reason: 'protection-unavailable', state: state() }
      const saved = await update((latest) => (latest.deletionPending ? null : { ...latest, choice: 'on' }))
      if (!saved) return { result: 'not-saved', state: state() }
      stopRun()
      choice = 'on'
      halted = false
      failures = 0
      notBefore = -Infinity
      evaluate()
      return { result: 'saved', state: state() }
    })
  }

  async function runDeletion(): Promise<AnalyticsDeletionResult> {
    stopRun()
    choice = 'off'
    // The aborted attempt settles first, so a registration it stored is deleted too.
    await attempt
    const failed = (reason: AnalyticsDeletionFailure): AnalyticsDeletionResult => ({ result: 'failed', reason, state: state() })
    if (record.identity === null) {
      // Nothing on this device links to the service: nothing to ask for.
      const stored = await update((latest) => (latest.identity !== null ? null : { ...latest, choice: 'off', deletionPending: false, reportedDay: null }))
      unresolvedDeletion = false
      return stored || record.choice === 'off' ? { result: 'deleted', state: state() } : failed('storage')
    }
    if (transport === null) return failed('service')
    const recorded = await update((latest) => ({ ...latest, choice: 'off', deletionPending: latest.identity !== null }))
    if (!recorded) {
      unresolvedDeletion = true
      return failed('storage')
    }
    const identity = record.identity
    if (identity === null) return { result: 'deleted', state: state() }
    let secret: string
    try {
      secret = token ?? await options.protector.decrypt(Buffer.from(identity.protectedToken, 'base64'))
    } catch {
      return failed('protection-unavailable')
    }
    // Quitting meanwhile: the deletion stays pending for the next run.
    if (paused) return failed('network')
    const controller = new AbortController()
    deletionController = controller
    let response: AnalyticsResponse
    try {
      response = await transport.post(ANALYTICS_PATHS.deletion, {
        protocol: ANALYTICS_PROTOCOL_VERSION, instanceId: identity.instanceId, token: secret
      }, controller.signal)
    } catch {
      // No answer (offline, timeout, quitting): nothing is known to be deleted.
      return failed('network')
    } finally {
      if (deletionController === controller) deletionController = null
    }
    if (response.status === 200) {
      // Confirmed: only now are the identity and its credentials removed from this device.
      const cleared = await update((latest) => (latest.identity?.instanceId !== identity.instanceId ? latest
        : { ...latest, choice: 'off', identity: null, deletionPending: false, reportedDay: null }))
      if (!cleared) return failed('storage')
      unresolvedDeletion = false
      token = null
      return { result: 'deleted', state: state() }
    }
    return failed(response.status === 403 ? 'rejected' : 'service')
  }

  return {
    start,
    async getState() {
      await start()
      return state()
    },
    setChoice,
    async deleteData() {
      await start()
      // Repeated presses join the running deletion.
      deleting ??= queue('operations', runDeletion).finally(() => { deleting = null })
      return deleting
    },
    poke() {
      evaluate()
    },
    async stop() {
      paused = true
      stopRun()
      deletionController?.abort()
      await attempt
      await deleting?.catch(() => undefined)
      await writes
    },
    resume() {
      if (!paused) return
      paused = false
      evaluate()
    }
  }
}
