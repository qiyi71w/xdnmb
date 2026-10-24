import { randomUUID } from 'node:crypto'
import type { ReadError } from '../../shared/api'
import type { SubscriptionContext, SubscriptionFailure, SubscriptionObservation, SubscriptionOperation, SubscriptionOverview, SubscriptionResult, SubscriptionSource, SubscriptionsApi } from '../../shared/subscriptions'
import type { SecretProtector } from '../identity/protection'
import type { RequestScheduler } from '../reading/scheduler'
import type { AppStore } from '../storage/contract'
import { ForumReadError, ReadCancelledError } from '../forum/contract'
import type { ForumTransport } from '../forum/contract'
import { parseAppList, parseWebList, parseWriteReport } from './protocol'

export interface SubscriptionService extends Omit<SubscriptionsApi, 'cancel' | 'read' | 'change' | 'reconcile'> {
  read(input: Parameters<SubscriptionsApi['read']>[0], signal: AbortSignal): Promise<SubscriptionResult<SubscriptionObservation>>
  change(input: Parameters<SubscriptionsApi['change']>[0], signal: AbortSignal): Promise<SubscriptionResult<SubscriptionOperation>>
  reconcile(input: Parameters<SubscriptionsApi['reconcile']>[0], signal: AbortSignal): Promise<SubscriptionResult<SubscriptionOperation>>
  /** Local journal repair only. Never sends a request. */
  recover(): Promise<void>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function sameContext(left: SubscriptionContext, right: SubscriptionContext): boolean {
  return left.generation === right.generation && left.appCredentialId === right.appCredentialId && left.webCredentialId === right.webCredentialId
}
function sufficient(observation: SubscriptionObservation | null): boolean {
  return observation !== null && !observation.error && !observation.cancelled && observation.nextPage === null &&
    observation.pages.length > 0 && observation.pages.every((page, index) => page.page === index + 1 &&
      page.endCandidate === (index === observation.pages.length - 1))
}
function safeError(error: unknown): ReadError {
  if (error instanceof ForumReadError) {
    const { kind, detail, httpStatus } = error.error
    return { kind, detail, ...(httpStatus === undefined ? {} : { httpStatus }) }
  }
  return { kind: 'network', detail: 'connection' }
}
class UnavailableIdentity extends Error {
  constructor(readonly reason: SubscriptionFailure) { super('subscription identity unavailable') }
}

export function createSubscriptionService(deps: {
  store: AppStore
  protector: SecretProtector
  scheduler: RequestScheduler
  transport: ForumTransport
  appOrigin: string
  webOrigin: string
  now?: () => Date
}): SubscriptionService {
  const { store, protector, scheduler, transport } = deps
  const now = deps.now ?? (() => new Date())
  const appOrigin = new URL(deps.appOrigin).origin
  const webOrigin = new URL(deps.webOrigin).origin
  let changing = false
  let configuring = false
  const reading = new Set<string>()

  async function overview(): Promise<SubscriptionOverview> {
    const [configuration, credentials, available] = await Promise.all([
      store.loadSubscriptionConfiguration(), store.listCredentials(), protector.isAvailable()
    ])
    const webId = configuration.context.webCredentialId
    const webSelection: SubscriptionOverview['webSelection'] = webId === null ? { state: 'none' }
      : { state: credentials.some((entry) => entry.id === webId) ? 'selected' : 'missing', credentialId: webId }
    return { ...configuration, appConfigured: configuration.context.appCredentialId !== null,
      webSelection, webName: webSelection.state === 'none' ? null : credentials.find((entry) => entry.id === webSelection.credentialId)?.name ?? null,
      protection: available ? 'available' : 'unavailable', writable: store.status.state === 'ready' }
  }

  async function identity(source: SubscriptionSource, context: SubscriptionContext): Promise<string> {
    if (store.status.state === 'unavailable') throw new UnavailableIdentity('storage')
    const id = source === 'app' ? context.appCredentialId : context.webCredentialId
    if (id === null) throw new UnavailableIdentity('unconfigured')
    const ciphertext = source === 'app' ? await store.loadSubscriptionAppCiphertext(id) : await store.loadCredentialCiphertext(id)
    if (ciphertext === null) throw new UnavailableIdentity('missing')
    try {
      if (!(await protector.isAvailable())) throw new Error('locked')
      const secret = await protector.decrypt(ciphertext)
      if (source === 'app' && !UUID.test(secret)) throw new Error('invalid protected UUID')
      return secret
    } catch { throw new UnavailableIdentity('locked') }
  }

  function observation(source: SubscriptionSource, context: SubscriptionContext): SubscriptionObservation {
    return { id: randomUUID(), source, context, startedAt: now().toISOString(), pages: [], ids: [], nextPage: 1, error: null, cancelled: false }
  }

  async function fetchPage(value: SubscriptionObservation, secret: string, signal: AbortSignal): Promise<void> {
    const page = value.nextPage
    if (page === null) return
    try {
      const threads = await scheduler.run('background', signal, async (requestSignal) => {
        const url = new URL(value.source === 'app' ? '/Api/feed' : `/Forum/feed/page/${page}.html`, value.source === 'app' ? appOrigin : webOrigin)
        if (value.source === 'app') { url.searchParams.set('uuid', secret); url.searchParams.set('page', String(page)) }
        const response = await transport.get(url, requestSignal, value.source === 'web' ? { userhash: secret } : undefined)
        return value.source === 'app' ? parseAppList(response) : parseWebList(response)
      })
      if (signal.aborted) throw new ReadCancelledError()
      value.pages.push({ page, threads, fetchedAt: now().toISOString(), endCandidate: threads.length === 0 })
      value.ids = [...new Set([...value.ids, ...threads.map((thread) => thread.head.id)])]
      value.nextPage = threads.length === 0 ? null : page + 1
      value.error = null
      value.cancelled = false
    } catch (error) {
      if (signal.aborted && signal.reason?.name === 'TimeoutError') value.error = { page, detail: { kind: 'network', detail: 'timeout' } }
      else if (error instanceof ReadCancelledError || signal.aborted) value.cancelled = true
      else value.error = { page, detail: safeError(error) }
    }
  }

  async function readback(operation: SubscriptionOperation, signal: AbortSignal): Promise<SubscriptionObservation> {
    const result = observation(operation.source, operation.context)
    let secret: string
    try { secret = await identity(operation.source, operation.context) }
    catch (error) {
      const reason = error instanceof UnavailableIdentity ? error.reason : 'storage'
      result.error = { page: 1, detail: { kind: 'identity', detail: reason === 'missing' ? 'identity-missing' : reason === 'locked' ? 'identity-locked' : 'identity-unknown' } }
      return result
    }
    // One deadline includes queue time and all pages of this read-only verification task.
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
    while (result.nextPage !== null && !result.error && !result.cancelled) {
      await fetchPage(result, secret, bounded)
      if (operation.action === 'add' && result.ids.includes(operation.threadId)) {
        await store.establishAttention(operation.threadId, 'subscription', result.pages.at(-1)!.fetchedAt)
      }
      await store.saveSubscriptionObservation(result, 'import')
      // Presence is directly observable; absence requires the entire contiguous readback.
      if (result.ids.includes(operation.threadId)) break
    }
    return result
  }

  async function finish(operation: SubscriptionOperation, signal: AbortSignal, explicitReconciliation: boolean): Promise<SubscriptionOperation> {
    operation.after = await readback(operation, signal)
    const after = operation.after
    if (after.ids.includes(operation.threadId)) operation.verification = operation.action === 'add' ? 'present' : 'mismatch'
    else if (sufficient(after)) {
      const before = operation.before
      const originalValid = before !== null && sameContext(before.context, operation.context) && before.source === operation.source &&
        before.pages.length > 0 && before.pages.every((page, index) => page.page === index + 1) && !before.error && !before.cancelled
      operation.verification = operation.action === 'remove'
        ? operation.report === 'success' && originalValid ? 'absent-supported' : 'absent-unproven'
        : 'mismatch'
    } else operation.verification = 'unknown'
    const confirmed = operation.verification === 'present' || operation.verification === 'absent-supported'
    operation.state = confirmed && (operation.report === 'success' || explicitReconciliation) ? 'settled' : 'needs-reconciliation'
    if (operation.report === 'rejected' && operation.verification !== 'unknown') operation.state = 'settled'
    await store.saveSubscriptionOperation(operation)
    return operation
  }

  return {
    getOverview: overview,
    async configureApp({ uuid }) {
      if (configuring) return { ok: false, reason: 'busy' }
      configuring = true
      try {
        if (store.status.state !== 'ready') return { ok: false, reason: 'storage' }
        const secret = uuid === null ? randomUUID() : uuid.trim().toLowerCase()
        if (!UUID.test(secret)) return { ok: false, reason: 'invalid-uuid' }
        if (!(await protector.isAvailable())) return { ok: false, reason: 'locked' }
        const configuration = await store.loadSubscriptionConfiguration()
        if (configuration.context.appCredentialId !== null) {
          try {
            if ((await identity('app', configuration.context)).toLowerCase() === secret) return { ok: true, value: await overview() }
          } catch (error) { if (error instanceof UnavailableIdentity && error.reason === 'locked') return { ok: false, reason: 'locked' } }
        }
        let ciphertext: Uint8Array
        try { ciphertext = await protector.encrypt(secret) } catch { return { ok: false, reason: 'locked' } }
        await store.setSubscriptionAppCredential(randomUUID(), ciphertext)
        return { ok: true, value: await overview() }
      } catch { return { ok: false, reason: 'storage' } }
      finally { configuring = false }
    },
    async selectSource({ source }) {
      try {
        await store.setSubscriptionSource(source)
        return { ok: true, value: await overview() }
      } catch { return { ok: false, reason: 'storage' } }
    },
    async getObservation({ source }) {
      const configuration = await store.loadSubscriptionConfiguration()
      return store.loadSubscriptionObservation(source, configuration.context)
    },
    async read(input, signal): Promise<SubscriptionResult<SubscriptionObservation>> {
      const key = input.observationId ?? input.source
      if (reading.has(key)) return { ok: false, reason: 'busy' }
      reading.add(key)
      try {
        if (store.status.state !== 'ready') return { ok: false, reason: 'storage' }
        const configuration = await store.loadSubscriptionConfiguration()
        const value = input.observationId === null ? observation(input.source, configuration.context) : await store.loadSubscriptionObservationById(input.observationId)
        if (!value || value.source !== input.source) return { ok: false, reason: 'not-found' }
        if (!sameContext(value.context, configuration.context)) return { ok: false, reason: 'stale' }
        if (value.nextPage === null) return { ok: true, value }
        const secret = await identity(input.source, value.context)
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        await fetchPage(value, secret, bounded)
        await store.saveSubscriptionObservation(value, 'import')
        return { ok: true, value }
      } catch (error) { return { ok: false, reason: error instanceof UnavailableIdentity ? error.reason : 'storage' } }
      finally { reading.delete(key) }
    },
    getOperations: () => store.loadSubscriptionOperations(),
    async change(input, signal): Promise<SubscriptionResult<SubscriptionOperation>> {
      if (changing) return { ok: false, reason: 'busy' }
      changing = true
      let dispatched = false
      try {
        if (store.status.state !== 'ready') return { ok: false, reason: 'storage' }
        const { context } = await store.loadSubscriptionConfiguration()
        if (context.generation !== input.expectedGeneration) return { ok: false, reason: 'stale' }
        const outstanding = await store.loadSubscriptionOperations()
        const secret = await identity(input.source, context)
        for (const entry of outstanding) {
          if (entry.state === 'settled' || entry.source !== input.source || entry.threadId !== input.threadId) continue
          if (input.source === 'web') {
            if (entry.context.webCredentialId === context.webCredentialId) return { ok: false, reason: 'busy' }
          } else {
            if (entry.context.appCredentialId === context.appCredentialId ||
                (await identity('app', entry.context)).toLowerCase() === secret.toLowerCase()) return { ok: false, reason: 'busy' }
          }
        }
        const webName = input.source === 'web' ? (await store.listCredentials()).find((entry) => entry.id === context.webCredentialId)?.name : null
        const operation: SubscriptionOperation = { id: randomUUID(), source: input.source, threadId: input.threadId, action: input.action, context,
          createdAt: now().toISOString(), objectLabel: input.source === 'app' ? 'App 订阅对象' : webName ?? '网页订阅对象',
          state: 'pending', report: 'pending', reportError: null, before: await store.loadSubscriptionObservation(input.source, context, true), after: null, verification: 'unknown' }
        // No request can leave this process until this intent has been durably accepted by the worker.
        await store.saveSubscriptionOperation(operation)
        const url = new URL(input.source === 'app' ? `/Api/${input.action === 'add' ? 'addFeed' : 'delFeed'}`
          : `/Home/Forum/${input.action === 'add' ? 'addFeed' : 'delFeed'}/tid/${input.threadId}.html`, input.source === 'app' ? appOrigin : webOrigin)
        if (input.source === 'app') { url.searchParams.set('uuid', secret); url.searchParams.set('tid', input.threadId) }
        try {
          // Explicit mutation: neither the read scheduler nor the UI cancellation signal owns it.
          dispatched = true
          const response = await transport.get(url, AbortSignal.timeout(20_000), input.source === 'web' ? { userhash: secret } : undefined)
          operation.report = parseWriteReport(input.source, input.action, response)
        } catch (error) {
          operation.reportError = safeError(error)
          operation.report = error instanceof ForumReadError && error.error.detail === 'business' && error.error.kind !== 'unknown-structure' ? 'rejected' : 'unknown'
        }
        if (operation.report !== 'success') operation.state = 'needs-reconciliation'
        // A result-save interruption leaves the original durable pending intent. Never read or replay a write as fallback.
        await store.saveSubscriptionOperation(operation)
        // A rate limit or captcha stops this task; only an explicit later reconciliation may read again.
        if (operation.reportError?.kind === 'rate-limited') return { ok: true, value: operation }
        return { ok: true, value: await finish(operation, signal, false) }
      } catch (error) { return { ok: false, reason: dispatched ? 'result-storage' : error instanceof UnavailableIdentity ? error.reason : 'storage' } }
      finally { changing = false }
    },
    async reconcile({ id }, signal): Promise<SubscriptionResult<SubscriptionOperation>> {
      if (changing) return { ok: false, reason: 'busy' }
      changing = true
      try {
        if (store.status.state !== 'ready') return { ok: false, reason: 'storage' }
        const operation = (await store.loadSubscriptionOperations()).find((entry) => entry.id === id)
        if (!operation) return { ok: false, reason: 'not-found' }
        if (operation.report === 'pending') operation.report = 'unknown'
        return { ok: true, value: await finish(operation, signal, true) }
      } catch { return { ok: false, reason: 'storage' } }
      finally { changing = false }
    },
    async recover() {
      if (store.status.state === 'ready') await store.recoverSubscriptionOperations()
    }
  }
}
