import type { OperationId, ReadError } from './api'
import type { ThreadId, ThreadSummary } from './forum'
import type { CredentialId, ProtectionState, RoleSelection } from './identity'

export type SubscriptionSource = 'app' | 'web'
export type SubscriptionAction = 'add' | 'remove'

/** References only. A generation changes when UUID or fixed web binding changes, not on view switches. */
export interface SubscriptionContext {
  generation: number
  appCredentialId: string | null
  webCredentialId: CredentialId | null
}

export interface SubscriptionOverview {
  context: SubscriptionContext
  source: SubscriptionSource
  appConfigured: boolean
  webSelection: RoleSelection
  webName: string | null
  protection: ProtectionState
  writable: boolean
}

export interface SubscriptionPage {
  page: number
  threads: ThreadSummary[]
  fetchedAt: string
  /** A valid empty page, never a short page; not an atomic snapshot guarantee. */
  endCandidate: boolean
}

export interface SubscriptionObservation {
  id: string
  source: SubscriptionSource
  context: SubscriptionContext
  startedAt: string
  pages: SubscriptionPage[]
  ids: ThreadId[]
  /** Next page to request; null only after a valid empty end candidate. */
  nextPage: number | null
  error: { page: number; detail: ReadError } | null
  cancelled: boolean
}

export interface SubscriptionOperation {
  id: string
  source: SubscriptionSource
  threadId: ThreadId
  action: SubscriptionAction
  context: SubscriptionContext
  createdAt: string
  /** Frozen human-readable object label; never UUID or userhash. */
  objectLabel: string
  state: 'pending' | 'settled' | 'needs-reconciliation'
  report: 'pending' | 'success' | 'rejected' | 'unknown'
  reportError: ReadError | null
  before: SubscriptionObservation | null
  after: SubscriptionObservation | null
  /** Facts, not change counts. Absence needs successful report + valid original context + sufficient readback. */
  verification: 'present' | 'absent-supported' | 'absent-unproven' | 'mismatch' | 'unknown'
}

/** result-storage means an explicit write may have reached the server; only read-only reconciliation is safe. */
export type SubscriptionFailure = 'storage' | 'result-storage' | 'locked' | 'unconfigured' | 'missing' | 'invalid-uuid' | 'stale' | 'busy' | 'not-found'
export type SubscriptionResult<T> = { ok: true; value: T } | { ok: false; reason: SubscriptionFailure }

export interface SubscriptionsApi {
  getOverview(): Promise<SubscriptionOverview>
  /** null generates a UUID; otherwise use the supplied UUID. No secret is returned. */
  configureApp(input: { uuid: string | null }): Promise<SubscriptionResult<SubscriptionOverview>>
  selectSource(input: { source: SubscriptionSource }): Promise<SubscriptionResult<SubscriptionOverview>>
  /** Local only, for the current identity combination. Failed reads never erase old observations. */
  getObservation(input: { source: SubscriptionSource }): Promise<SubscriptionObservation | null>
  /** One background page. null starts a new observation; an ID continues that fixed observation. */
  read(input: { source: SubscriptionSource; observationId: string | null; operationId: OperationId }): Promise<SubscriptionResult<SubscriptionObservation>>
  /** Explicit write, intent durable before request. Signal cancellation affects readback only. */
  change(input: { source: SubscriptionSource; threadId: ThreadId; action: SubscriptionAction; expectedGeneration: number; operationId: OperationId }): Promise<SubscriptionResult<SubscriptionOperation>>
  /** Local journal including previous objects; startup never replays any write. */
  getOperations(): Promise<SubscriptionOperation[]>
  /** Read-only check using the attempt's fixed references, never the currently selected ones. */
  reconcile(input: { id: string; operationId: OperationId }): Promise<SubscriptionResult<SubscriptionOperation>>
  cancel(input: { operationId: OperationId }): Promise<void>
}
