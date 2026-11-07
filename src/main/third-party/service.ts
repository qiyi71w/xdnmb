import type { AnalyticsChoiceResult } from '../../shared/analytics'
import type {
  ThirdPartyChoices, ThirdPartyRecord, ThirdPartyResult, ThirdPartyService as ServiceName, ThirdPartyState
} from '../../shared/third-party'
import type { AnalyticsService } from '../analytics/service'
import type { AppStore } from '../storage/contract'

export interface ThirdPartyService {
  start(): Promise<void>
  getState(): Promise<ThirdPartyState>
  complete(choices: ThirdPartyChoices): Promise<ThirdPartyResult>
  setChoice(service: ServiceName, allowed: boolean): Promise<ThirdPartyResult>
  isAcknowledged(): boolean
  allows(service: 'updates' | 'search'): boolean
}

/** The disclosure is the commit marker: statistics are saved first, with every gate still closed. */
export function createThirdPartyService(options: {
  store: Pick<AppStore, 'loadThirdPartyConsent' | 'saveThirdPartyConsent'>
  analytics: AnalyticsService
  changed: () => void
}): ThirdPartyService {
  let initial: Promise<void> | null = null
  let operations: Promise<unknown> = Promise.resolve()
  let acknowledged = false
  let persisted = false
  let permissions = { updates: false, search: false }
  const revocations = { updates: 0, search: 0, analytics: 0 }

  function notify(): void {
    options.changed()
    options.analytics.poke()
  }

  function start(): Promise<void> {
    initial ??= (async () => {
      // Analytics only queries the synchronous acknowledgement getter, never this promise.
      const [record] = await Promise.all([
        options.store.loadThirdPartyConsent().catch(() => null),
        options.analytics.start()
      ])
      if (record !== null) {
        if (revocations.analytics > 0) await options.analytics.setChoice('off')
        permissions = { updates: record.updates && revocations.updates === 0, search: record.search && revocations.search === 0 }
        persisted = true
        acknowledged = true
      }
      notify()
    })()
    return initial
  }

  async function getState(): Promise<ThirdPartyState> {
    await start()
    const analytics = await options.analytics.getState()
    return {
      acknowledged,
      updates: acknowledged && permissions.updates,
      search: acknowledged && permissions.search,
      analytics: acknowledged ? analytics : { ...analytics, choice: 'unset', saved: 'unset' }
    }
  }

  function queue(work: () => Promise<ThirdPartyResult>): Promise<ThirdPartyResult> {
    const run = operations.then(async () => { await start(); return work() })
    operations = run.catch(() => undefined)
    return run
  }

  async function result(value: 'saved' | 'not-saved'): Promise<ThirdPartyResult> {
    return { result: value, state: await getState() }
  }

  async function analyticsFailure(answer: AnalyticsChoiceResult): Promise<ThirdPartyResult> {
    return answer.result === 'refused'
      ? { result: 'refused', reason: answer.reason, state: await getState() }
      : result('not-saved')
  }

  async function save(record: ThirdPartyRecord): Promise<boolean> {
    try {
      await options.store.saveThirdPartyConsent(record)
      persisted = true
      return true
    } catch {
      return false
    }
  }

  return {
    start,
    getState,
    isAcknowledged: () => acknowledged,
    allows: (service) => acknowledged && permissions[service],
    complete(choices) {
      const requested = { ...choices }
      const before = { ...revocations }
      return queue(async () => {
        if (acknowledged) return { result: 'refused', reason: 'disclosure-required', state: await getState() }
        const allOff = !requested.updates && !requested.search && !requested.analytics
        let analytics = await options.analytics.setChoice(requested.analytics ? 'on' : 'off')
        if (revocations.analytics !== before.analytics) analytics = await options.analytics.setChoice('off')
        if (analytics.result !== 'saved') {
          // Never put a disclosure marker next to an old saved analytics grant.
          if (allOff) {
            acknowledged = true
            notify()
            return result('not-saved')
          }
          return analyticsFailure(analytics)
        }
        const stored = await save({ version: 1, updates: requested.updates, search: requested.search })
        if (!stored && !allOff) return result('not-saved')
        // A later revocation wins even when it arrived during a slow first save.
        if (revocations.analytics !== before.analytics) await options.analytics.setChoice('off')
        permissions = {
          updates: requested.updates && revocations.updates === before.updates,
          search: requested.search && revocations.search === before.search
        }
        acknowledged = true
        notify()
        return result(stored ? 'saved' : 'not-saved')
      })
    },
    setChoice(service, allowed) {
      const revision = revocations[service]
      let revokedAnalytics: Promise<AnalyticsChoiceResult> | null = null
      if (!allowed) {
        revocations[service]++
        // Effective revocation is synchronous, including while another save is in flight.
        if (service === 'analytics') {
          if (acknowledged) revokedAnalytics = options.analytics.setChoice('off')
        } else {
          permissions[service] = false
        }
        if (acknowledged) notify()
      }
      return queue(async () => {
        if (!acknowledged) return { result: 'refused', reason: 'disclosure-required', state: await getState() }
        if (service === 'analytics') {
          // A session-only rejection may still have an old analytics grant on disk. Commit
          // the off answer and marker before attempting to turn statistics on.
          if (!persisted) {
            const off = await options.analytics.setChoice('off')
            if (off.result !== 'saved') return analyticsFailure(off)
            if (!(await save({ version: 1, ...permissions }))) return result('not-saved')
          }
          const enable = allowed && revocations.analytics === revision
          const answer = await (revokedAnalytics ?? options.analytics.setChoice(enable ? 'on' : 'off'))
          if (allowed && revocations.analytics !== revision) await options.analytics.setChoice('off')
          notify()
          if (answer.result !== 'saved') return analyticsFailure(answer)
          return result('saved')
        }
        if (!persisted) {
          const analytics = await options.analytics.setChoice('off')
          if (analytics.result !== 'saved') return analyticsFailure(analytics)
        }
        const next = { version: 1 as const, ...permissions, [service]: allowed }
        if (!(await save(next))) return result('not-saved')
        permissions[service] = allowed && revocations[service] === revision
        notify()
        return result('saved')
      })
    }
  }
}
