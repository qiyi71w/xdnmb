import { randomUUID } from 'node:crypto'
import type { ReadError } from '../../shared/api'
import type { SubscriptionCandidate, SubscriptionChoice, SubscriptionContext, SubscriptionDifference, SubscriptionFailure, SubscriptionObservation, SubscriptionOperation, SubscriptionOverview, SubscriptionPlan, SubscriptionPreview, SubscriptionProvenance, SubscriptionResult, SubscriptionSource, SubscriptionsApi } from '../../shared/subscriptions'
import { completeSubscriptionObservation } from '../../shared/subscriptions'
import type { SecretProtector } from '../identity/protection'
import type { RequestScheduler } from '../reading/scheduler'
import type { AppStore, SubscriptionBaseline } from '../storage/contract'
import { ForumReadError, ReadCancelledError } from '../forum/contract'
import type { ForumTransport } from '../forum/contract'
import { parseAppList, parseWebList, parseWriteReport } from './protocol'

export interface SubscriptionService extends Omit<SubscriptionsApi, 'cancel' | 'read' | 'change' | 'reconcile' | 'previewSync' | 'previewMerge' | 'executePlan'> {
  read(input: Parameters<SubscriptionsApi['read']>[0], signal: AbortSignal): Promise<SubscriptionResult<SubscriptionObservation>>
  change(input: Parameters<SubscriptionsApi['change']>[0], signal: AbortSignal): Promise<SubscriptionResult<SubscriptionOperation>>
  reconcile(input: Parameters<SubscriptionsApi['reconcile']>[0], signal: AbortSignal): Promise<SubscriptionResult<SubscriptionOperation>>
  previewSync(input: Parameters<SubscriptionsApi['previewSync']>[0], signal: AbortSignal): Promise<SubscriptionResult<SubscriptionPreview>>
  previewMerge(input: Parameters<SubscriptionsApi['previewMerge']>[0], signal: AbortSignal): Promise<SubscriptionResult<SubscriptionPreview>>
  executePlan(input: Parameters<SubscriptionsApi['executePlan']>[0], signal: AbortSignal): Promise<SubscriptionResult<SubscriptionPlan>>
  /** Local journal repair only. Never sends a request. */
  recover(): Promise<void>
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
function sameContext(left: SubscriptionContext, right: SubscriptionContext): boolean {
  return left.generation === right.generation && left.appCredentialId === right.appCredentialId && left.webCredentialId === right.webCredentialId
}
const sufficient = completeSubscriptionObservation
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
  const reading = new Map<string, Promise<SubscriptionResult<SubscriptionObservation>>>()
  const previews = new Map<string, SubscriptionPreview>()

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
      await store.saveSubscriptionObservation(result)
      // Presence is directly observable; absence requires the entire contiguous readback.
      if (result.ids.includes(operation.threadId)) break
    }
    return result
  }

  async function finish(operation: SubscriptionOperation, signal: AbortSignal, explicitReconciliation: boolean,
    persist: (operation: SubscriptionOperation) => Promise<void> = (value) => store.saveSubscriptionOperation(value)): Promise<SubscriptionOperation> {
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
    await persist(operation)
    return operation
  }

  async function mutate(input: Pick<SubscriptionOperation, 'source' | 'threadId' | 'action'>, context: SubscriptionContext, signal: AbortSignal,
    hooks?: { intent(operation: SubscriptionOperation): Promise<void>; finish(operation: SubscriptionOperation): Promise<void> }): Promise<SubscriptionResult<SubscriptionOperation>> {
    let dispatched = false
    try {
      if (store.status.state !== 'ready') return { ok: false, reason: 'storage' }
      if (hooks && signal.aborted) return { ok: false, reason: 'cancelled' }
      if (!sameContext(context, (await store.loadSubscriptionConfiguration()).context)) return { ok: false, reason: 'stale' }
      const outstanding = await store.loadSubscriptionOperations()
      const secret = await identity(input.source, context)
      for (const entry of outstanding) {
        if (entry.dismissedAt !== undefined || entry.state === 'settled' || entry.source !== input.source || entry.threadId !== input.threadId) continue
        if (input.source === 'web') {
          if (entry.context.webCredentialId === context.webCredentialId) return { ok: false, reason: 'busy' }
        } else if (entry.context.appCredentialId === context.appCredentialId ||
          (await identity('app', entry.context)).toLowerCase() === secret.toLowerCase()) return { ok: false, reason: 'busy' }
      }
      const webName = input.source === 'web' ? (await store.listCredentials()).find((entry) => entry.id === context.webCredentialId)?.name : null
      const operation: SubscriptionOperation = { id: randomUUID(), source: input.source, threadId: input.threadId, action: input.action, context,
        createdAt: now().toISOString(), objectLabel: input.source === 'app' ? 'App 订阅' : webName ?? '网页订阅',
        state: 'pending', report: 'pending', reportError: null, before: await store.loadSubscriptionObservation(input.source, context, true), after: null, verification: 'unknown' }
      // Plan correlation and intent are durable together before dispatch.
      if (hooks) await hooks.intent(operation)
      else await store.saveSubscriptionOperation(operation)
      if (hooks && signal.aborted) return { ok: false, reason: 'cancelled' }
      if (!sameContext(context, (await store.loadSubscriptionConfiguration()).context)) return { ok: false, reason: 'stale' }
      const url = new URL(input.source === 'app' ? `/Api/${input.action === 'add' ? 'addFeed' : 'delFeed'}`
        : `/Home/Forum/${input.action === 'add' ? 'addFeed' : 'delFeed'}/tid/${input.threadId}.html`, input.source === 'app' ? appOrigin : webOrigin)
      if (input.source === 'app') { url.searchParams.set('uuid', secret); url.searchParams.set('tid', input.threadId) }
      try {
        dispatched = true
        const response = await transport.get(url, AbortSignal.timeout(20_000), input.source === 'web' ? { userhash: secret } : undefined)
        operation.report = parseWriteReport(input.source, input.action, response)
      } catch (error) {
        operation.reportError = safeError(error)
        operation.report = error instanceof ForumReadError && error.error.detail === 'business' && error.error.kind !== 'unknown-structure' ? 'rejected' : 'unknown'
      }
      if (operation.report !== 'success') operation.state = 'needs-reconciliation'
      await store.saveSubscriptionOperation(operation)
      if (operation.reportError?.kind === 'rate-limited') {
        if (hooks) await hooks.finish(operation)
        return { ok: true, value: operation }
      }
      return { ok: true, value: await finish(operation, signal, false, hooks?.finish) }
    } catch (error) { return { ok: false, reason: dispatched ? 'result-storage' : error instanceof UnavailableIdentity ? error.reason : 'storage' } }
  }

  async function collect(source: SubscriptionSource, context: SubscriptionContext, signal: AbortSignal,
    range?: SubscriptionObservation): Promise<SubscriptionObservation> {
    const value = observation(source, context)
    const secret = await identity(source, context)
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
    const pageLimit = range ? range.pages.length + (range.error || range.cancelled ? 1 : 0) : Infinity
    while (value.nextPage !== null && !value.error && !value.cancelled && value.pages.length < pageLimit) {
      await fetchPage(value, secret, bounded)
      await store.saveSubscriptionObservation(value)
    }
    return value
  }

  function signature(value: SubscriptionObservation): string {
    return JSON.stringify({ ids: [...value.ids].sort(), nextPage: value.nextPage, error: value.error, cancelled: value.cancelled,
      pages: value.pages.map((page) => ({ page: page.page, endCandidate: page.endCandidate, ids: page.threads.map((thread) => thread.head.id).sort() })) })
  }

  async function preview(mode: 'sync' | 'merge', sourceId: string | null, signal: AbortSignal): Promise<SubscriptionResult<SubscriptionPreview>> {
    try {
      if (store.status.state !== 'ready') return { ok: false, reason: 'storage' }
      if (signal.aborted) return { ok: false, reason: 'cancelled' }
      const { context } = await store.loadSubscriptionConfiguration()
      const leftContext = mode === 'merge' ? { ...context, appCredentialId: sourceId } : context
      if (mode === 'merge') {
        if (!sourceId || !(await store.listSubscriptionAppCredentials()).includes(sourceId)) return { ok: false, reason: 'not-found' }
        if ((await identity('app', leftContext)).toLowerCase() === (await identity('app', context)).toLowerCase()) return { ok: false, reason: 'invalid-selection' }
      }
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      const left = await collect('app', leftContext, bounded)
      const rightSource = mode === 'merge' ? 'app' : 'web'
      // Captcha/rate-limit ends this task; an untouched observation explicitly has no coverage.
      const right = left.error?.detail.kind === 'rate-limited' ? observation(rightSource, context) : await collect(rightSource, context, bounded)
      if (signal.aborted || left.cancelled || right.cancelled) return { ok: false, reason: 'cancelled' }
      if (!sameContext(context, (await store.loadSubscriptionConfiguration()).context)) return { ok: false, reason: 'stale' }
      const baseline = mode === 'sync' ? await store.loadSubscriptionBaseline(context) : null
      const firstSync = baseline === null
      // Absence from a confirmed baseline is only judged with both sides fully read; otherwise everything is new.
      const judged = mode === 'sync' && baseline !== null && sufficient(left) && sufficient(right)
      const common = new Set(judged ? baseline.ids : [])
      // When each thread was last written into the baseline. Plans are its only writers: a thread enters when it
      // is common at a plan's recheck (the frozen preview observations) or when a plan confirms adding it.
      const confirmedAt = new Map<string, string>()
      const confirm = (threadId: string, at: string) => { if (at > (confirmedAt.get(threadId) ?? '')) confirmedAt.set(threadId, at) }
      const removals: SubscriptionOperation[] = []
      if (judged) {
        for (const plan of await store.loadSubscriptionPlans()) {
          if (plan.preview.mode !== 'sync' || !sameContext(plan.preview.context, context)) continue
          const planRight = new Set(plan.preview.right.ids)
          for (const id of plan.preview.left.ids) if (planRight.has(id)) confirm(id, plan.createdAt)
          for (const item of plan.items) {
            if (item.state === 'confirmed' && item.candidate.action === 'add') confirm(item.candidate.threadId, plan.finishedAt ?? plan.createdAt)
          }
        }
        for (const entry of await store.loadSubscriptionOperations()) {
          if (entry.action === 'remove' && entry.report === 'success' && entry.verification === 'absent-supported' && sameContext(entry.context, context)) removals.push(entry)
        }
      }
      const provenance = (threadId: string, missing: SubscriptionSource): SubscriptionProvenance => {
        const after = confirmedAt.get(threadId) ?? ''
        let at: string | null = null
        for (const entry of removals) {
          if (entry.source === missing && entry.threadId === threadId && entry.createdAt > after && (at === null || entry.createdAt > at)) at = entry.createdAt
        }
        return at === null ? { kind: 'gone' } : { kind: 'local-removal', at }
      }
      const choices: SubscriptionChoice[] = judged ? ['both', 'none', 'skip'] : ['both', 'skip']
      const rightIds = new Set(right.ids)
      const leftIds = new Set(left.ids)
      const items: SubscriptionDifference[] = []
      const differ = (present: SubscriptionObservation, presentOn: SubscriptionSource, missing: SubscriptionSource, others: Set<string>) => {
        const threads = new Map(present.pages.flatMap((page) => page.threads.map((thread) => [thread.head.id, thread] as const)))
        for (const threadId of present.ids) {
          const thread = threads.get(threadId)
          if (others.has(threadId) || thread === undefined) continue
          const inBaseline = common.has(threadId)
          items.push({ id: randomUUID(), threadId, presentOn, thread, baseline: inBaseline, provenance: inBaseline ? provenance(threadId, missing) : null,
            choices: [...choices], defaultChoice: inBaseline ? 'skip' : 'both' })
        }
      }
      differ(left, 'app', mode === 'merge' ? 'app' : 'web', rightIds)
      if (mode === 'sync') differ(right, 'web', 'app', leftIds)
      const webName = (await store.listCredentials()).find((entry) => entry.id === context.webCredentialId)?.name
      const value: SubscriptionPreview = { id: randomUUID(), mode, context, createdAt: now().toISOString(), left, right,
        leftLabel: mode === 'merge' ? '之前的 App UUID' : 'App 订阅',
        rightLabel: mode === 'merge' ? '当前 App UUID' : webName ? `网页订阅（${webName}）` : '网页订阅',
        firstSync, items }
      previews.set(value.id, structuredClone(value))
      return { ok: true, value }
    } catch (error) { return { ok: false, reason: error instanceof UnavailableIdentity ? error.reason : 'storage' } }
  }

  async function execute(input: Parameters<SubscriptionsApi['executePlan']>[0], signal: AbortSignal): Promise<SubscriptionResult<SubscriptionPlan>> {
    const value = previews.get(input.previewId)
    previews.delete(input.previewId)
    if (!value) return { ok: false, reason: 'stale' }
    if (changing) return { ok: false, reason: 'busy' }
    const differences = new Map(value.items.map((item) => [item.id, item]))
    const chosen = new Map<string, SubscriptionChoice>()
    for (const { itemId, choice } of input.choices) {
      const item = differences.get(itemId)
      if (item === undefined || chosen.has(itemId) || !item.choices.includes(choice)) return { ok: false, reason: 'invalid-selection' }
      chosen.set(itemId, choice)
    }
    changing = true
    let plan: SubscriptionPlan | null = null
    let durable = false
    try {
      if (signal.aborted) return { ok: false, reason: 'cancelled' }
      if (!sameContext(value.context, (await store.loadSubscriptionConfiguration()).context)) return { ok: false, reason: 'stale' }
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      const left = await collect(value.left.source, value.left.context, bounded, value.left)
      if (left.error?.detail.kind === 'rate-limited') return { ok: false, reason: 'stale' }
      const right = await collect(value.right.source, value.right.context, bounded, value.right)
      if (right.error?.detail.kind === 'rate-limited') return { ok: false, reason: 'stale' }
      if (signal.aborted || left.cancelled || right.cancelled) return { ok: false, reason: 'cancelled' }
      if (!sameContext(value.context, (await store.loadSubscriptionConfiguration()).context) ||
        signature(left) !== signature(value.left) || signature(right) !== signature(value.right)) return { ok: false, reason: 'stale' }
      const previous = value.mode === 'sync' ? await store.loadSubscriptionBaseline(value.context) : null
      const rightIds = new Set(right.ids)
      const baseline: SubscriptionBaseline | undefined = value.mode === 'sync' ? { context: value.context,
        ids: [...new Set([...(previous?.ids ?? []), ...left.ids.filter((id) => rightIds.has(id))])] } : undefined
      const writes: SubscriptionCandidate[] = []
      for (const item of value.items) {
        const choice = chosen.get(item.id) ?? 'skip'
        if (choice === 'skip') continue
        // Merge adds the old UUID's thread to the current App; sync adds to the side that lacks it or removes from the one that has it.
        const target: SubscriptionSource = choice === 'none' || value.mode === 'merge' ? item.presentOn : item.presentOn === 'app' ? 'web' : 'app'
        writes.push({ id: item.id, threadId: item.threadId, action: choice === 'none' ? 'remove' : 'add', target })
      }
      plan = { id: randomUUID(), preview: value, createdAt: now().toISOString(), finishedAt: null, state: 'running', stopReason: null,
        items: writes.map((candidate) => ({ candidate, operationId: null, state: 'pending', failure: null })) }
      await store.saveSubscriptionPlan(plan, undefined, baseline)
      durable = true
      for (const item of plan.items) {
        const currentPlan = plan
        const candidate = item.candidate
        const result = await mutate({ source: candidate.target, threadId: candidate.threadId, action: candidate.action }, value.context, signal, {
          async intent(operation) {
            item.operationId = operation.id
            try { await store.saveSubscriptionPlan(currentPlan, operation) }
            catch (error) { item.operationId = null; throw error }
          },
          async finish(operation) {
            const confirmed = operation.report === 'success' && (operation.verification === 'present' || operation.verification === 'absent-supported')
            item.state = confirmed ? 'confirmed' : operation.report === 'rejected' ? 'failed'
              : operation.report !== 'success' ? 'unknown' : operation.verification === 'mismatch' ? 'failed' : 'unknown'
            const next = baseline && confirmed ? { ...baseline, ids: candidate.action === 'add'
              ? [...new Set([...baseline.ids, candidate.threadId])] : baseline.ids.filter((id) => id !== candidate.threadId) } : undefined
            await store.saveSubscriptionPlan(currentPlan, operation, next)
            if (baseline && next) baseline.ids = next.ids
          }
        })
        if (!result.ok) {
          item.state = result.reason === 'result-storage' ? 'unknown' : 'failed'
          item.failure = result.reason
          plan.stopReason = result.reason
        } else if (item.state !== 'confirmed') plan.stopReason = item.state === 'failed' ? 'item-failed' : 'item-unknown'
        if (plan.stopReason !== null) break
      }
      plan.state = plan.stopReason === null ? 'completed' : 'stopped'
      plan.finishedAt = now().toISOString()
      for (const item of plan.items) if (item.state === 'pending') item.state = 'skipped'
      await store.saveSubscriptionPlan(plan)
      return { ok: true, value: plan }
    } catch (error) {
      if (plan && durable) {
        plan.state = 'stopped'
        plan.stopReason = 'result-storage'
        plan.finishedAt = now().toISOString()
        for (const item of plan.items) if (item.state === 'pending') item.state = item.operationId ? 'unknown' : 'skipped'
        // If storage is unavailable, startup marks the durable running plan interrupted.
        try { await store.saveSubscriptionPlan(plan) } catch { /* Keep the original durable evidence. */ }
        return { ok: true, value: plan }
      }
      return { ok: false, reason: error instanceof UnavailableIdentity ? error.reason : 'storage' }
    } finally { changing = false }
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
    async revealAppUuid() {
      try {
        const configuration = await store.loadSubscriptionConfiguration()
        if (configuration.context.appCredentialId === null) return { ok: true, value: null }
        return { ok: true, value: await identity('app', configuration.context) }
      } catch (error) { return { ok: false, reason: error instanceof UnavailableIdentity ? error.reason : 'storage' } }
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
    async getSnapshot({ source }) {
      const configuration = await store.loadSubscriptionConfiguration()
      return store.loadSubscriptionObservation(source, configuration.context, 'complete')
    },
    async read(input, signal): Promise<SubscriptionResult<SubscriptionObservation>> {
      try {
        if (store.status.state !== 'ready') return { ok: false, reason: 'storage' }
        const configuration = await store.loadSubscriptionConfiguration()
        const key = JSON.stringify([input.source, configuration.context, input.observationId])
        const running = reading.get(key)
        if (running !== undefined) return await running
        const task = (async (): Promise<SubscriptionResult<SubscriptionObservation>> => {
          try {
            const value = input.observationId === null ? observation(input.source, configuration.context) : await store.loadSubscriptionObservationById(input.observationId)
            if (!value || value.source !== input.source) return { ok: false, reason: 'not-found' }
            if (!sameContext(value.context, configuration.context)) return { ok: false, reason: 'stale' }
            if (value.nextPage === null) return { ok: true, value }
            const secret = await identity(input.source, value.context)
            const bounded = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
            await fetchPage(value, secret, bounded)
            await store.saveSubscriptionObservation(value)
            return { ok: true, value }
          } catch (error) { return { ok: false, reason: error instanceof UnavailableIdentity ? error.reason : 'storage' } }
        })()
        reading.set(key, task)
        try { return await task } finally { if (reading.get(key) === task) reading.delete(key) }
      } catch { return { ok: false, reason: 'storage' } }
    },
    getOperations: () => store.loadSubscriptionOperations(),
    getPlans: () => store.loadSubscriptionPlans(),
    async getMergeSources() {
      const { context } = await store.loadSubscriptionConfiguration()
      const current = context.appCredentialId === null ? null : (await identity('app', context)).toLowerCase()
      const sources = []
      for (const id of await store.listSubscriptionAppCredentials()) {
        if (id === context.appCredentialId) continue
        if (current !== null && (await identity('app', { ...context, appCredentialId: id })).toLowerCase() === current) continue
        sources.push({ appCredentialId: id, label: `之前的 App UUID ${sources.length + 1}` })
      }
      return sources
    },
    previewSync: (_input, signal) => preview('sync', null, signal),
    previewMerge: (input, signal) => preview('merge', input.sourceAppCredentialId, signal),
    executePlan: execute,
    async change(input, signal): Promise<SubscriptionResult<SubscriptionOperation>> {
      if (changing) return { ok: false, reason: 'busy' }
      changing = true
      try {
        const { context } = await store.loadSubscriptionConfiguration()
        if (context.generation !== input.expectedGeneration) return { ok: false, reason: 'stale' }
        return await mutate(input, context, signal)
      } catch { return { ok: false, reason: 'storage' } }
      finally { changing = false }
    },
    async reconcile({ id }, signal): Promise<SubscriptionResult<SubscriptionOperation>> {
      if (changing) return { ok: false, reason: 'busy' }
      changing = true
      try {
        if (store.status.state !== 'ready') return { ok: false, reason: 'storage' }
        const operation = (await store.loadSubscriptionOperations()).find((entry) => entry.id === id)
        if (!operation) return { ok: false, reason: 'not-found' }
        if (operation.dismissedAt !== undefined) return { ok: false, reason: 'invalid-selection' }
        if (operation.report === 'pending') operation.report = 'unknown'
        return { ok: true, value: await finish(operation, signal, true) }
      } catch { return { ok: false, reason: 'storage' } }
      finally { changing = false }
    },
    async dismiss({ id }): Promise<SubscriptionResult<SubscriptionOperation>> {
      if (changing) return { ok: false, reason: 'busy' }
      changing = true
      try {
        if (store.status.state !== 'ready') return { ok: false, reason: 'storage' }
        const operation = (await store.loadSubscriptionOperations()).find((entry) => entry.id === id)
        if (!operation) return { ok: false, reason: 'not-found' }
        if (operation.dismissedAt === undefined) {
          operation.dismissedAt = now().toISOString()
          await store.saveSubscriptionOperation(operation)
        }
        return { ok: true, value: operation }
      } catch { return { ok: false, reason: 'storage' } }
      finally { changing = false }
    },
    async recover() {
      previews.clear()
      if (store.status.state === 'ready') {
        await store.recoverSubscriptionOperations()
        await store.recoverSubscriptionPlans(now().toISOString())
      }
    }
  }
}
