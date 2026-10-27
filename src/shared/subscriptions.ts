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
export type SubscriptionFailure = 'storage' | 'result-storage' | 'locked' | 'unconfigured' | 'missing' | 'invalid-uuid' | 'stale' | 'busy' | 'not-found' | 'invalid-selection' | 'cancelled'
export type SubscriptionResult<T> = { ok: true; value: T } | { ok: false; reason: SubscriptionFailure }

export interface SubscriptionsApi {
  getOverview(): Promise<SubscriptionOverview>
  /** null generates a UUID; otherwise use the supplied UUID. No secret is returned. */
  configureApp(input: { uuid: string | null }): Promise<SubscriptionResult<SubscriptionOverview>>
  /**
   * The saved App UUID, decrypted for the settings view only (`null`: none saved). It stays
   * encrypted at rest and is never part of the overview, journal or labels.
   */
  revealAppUuid(): Promise<SubscriptionResult<string | null>>
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
  /** Historical local object references only; never decrypted UUIDs. */
  getMergeSources(): Promise<SubscriptionMergeSource[]>
  /** Fresh, bounded background reads. Previews live only in this process and never execute on restart. */
  previewSync(input: { operationId: OperationId }): Promise<SubscriptionResult<SubscriptionPreview>>
  previewMerge(input: { sourceAppCredentialId: string; operationId: OperationId }): Promise<SubscriptionResult<SubscriptionPreview>>
  /**
   * Consumes the preview once. Revalidates both observed ranges before any write, then executes serially.
   * Items without an entry are `skip`; unknown, duplicate or unavailable choices are `invalid-selection`.
   */
  executePlan(input: { previewId: string; choices: SubscriptionItemChoice[]; operationId: OperationId }): Promise<SubscriptionResult<SubscriptionPlan>>
  /** Durable history, including interrupted plans. There is deliberately no resume/replay API. */
  getPlans(): Promise<SubscriptionPlan[]>
  cancel(input: { operationId: OperationId }): Promise<void>
}

export interface SubscriptionMergeSource {
  appCredentialId: string
  /** Human name by recency ("之前的 App UUID 1" is the most recent); never the UUID or a local reference. */
  label: string
}

/** One concrete write of a plan, derived from a difference and its choice. */
export interface SubscriptionCandidate {
  id: string
  threadId: ThreadId
  action: SubscriptionAction
  target: SubscriptionSource
}

/** both: add on the side that lacks it; none: remove from the side that has it; skip: no write. Merge offers both/skip only. */
export type SubscriptionChoice = 'both' | 'none' | 'skip'

/** Why a thread confirmed common at the last sync is now missing on one side. */
export type SubscriptionProvenance =
  /** A successful, verified removal in this app from the missing side, after the last baseline write. */
  | { kind: 'local-removal'; at: string }
  /** No local evidence: it disappeared there after the last sync. */
  | { kind: 'gone' }

/** A thread present on exactly one side. */
export interface SubscriptionDifference {
  id: string
  threadId: ThreadId
  /** Sync: the side that has it. Merge: always 'app', meaning the old App UUID. */
  presentOn: SubscriptionSource
  /** From the observation of the side that has it; web summaries carry no image or reply count. */
  thread: ThreadSummary
  /** Confirmed common at a previous sync. Always false on first sync, merge, or an incomplete read. */
  baseline: boolean
  /** Only for baseline differences. */
  provenance: SubscriptionProvenance | null
  choices: SubscriptionChoice[]
  defaultChoice: SubscriptionChoice
}

export interface SubscriptionItemChoice {
  itemId: string
  choice: SubscriptionChoice
}

/** For sync left=App/right=web; for merge left=old App/right=current App. */
export interface SubscriptionPreview {
  id: string
  mode: 'sync' | 'merge'
  context: SubscriptionContext
  createdAt: string
  left: SubscriptionObservation
  right: SubscriptionObservation
  /** Human names of the two collections, never internal references. */
  leftLabel: string
  rightLabel: string
  firstSync: boolean
  /** In preview order, which is also the execution order. */
  items: SubscriptionDifference[]
}

export interface SubscriptionPlanItem {
  candidate: SubscriptionCandidate
  operationId: string | null
  state: 'pending' | 'confirmed' | 'failed' | 'unknown' | 'skipped'
  failure: SubscriptionFailure | null
}

/**
 * Durable history. `preview` is frozen at execution time and older plans may carry an earlier preview
 * shape: history readers use `items`, `preview.mode` and `preview.context` only.
 */
export interface SubscriptionPlan {
  id: string
  preview: SubscriptionPreview
  createdAt: string
  finishedAt: string | null
  state: 'running' | 'completed' | 'stopped' | 'interrupted'
  stopReason: SubscriptionFailure | 'item-failed' | 'item-unknown' | null
  items: SubscriptionPlanItem[]
}
