import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { OperationId } from '../../../../shared/api'
import type { ThreadId } from '../../../../shared/forum'
import type {
  SubscriptionAction,
  SubscriptionChoice,
  SubscriptionContext,
  SubscriptionFailure,
  SubscriptionMergeSource,
  SubscriptionObservation,
  SubscriptionOperation,
  SubscriptionOverview,
  SubscriptionPlan,
  SubscriptionResult,
  SubscriptionSource
} from '../../../../shared/subscriptions'
import {
  busyTask,
  defaultChoices,
  newestPlansFirst,
  planChoices,
  previewCurrent,
  withChoice,
  type ExecuteOutcome,
  type PreviewNotice,
  type ReconcileMode,
  type ReconcileTask
} from './reconcileState'
import {
  clearSuccessfulWriteOnLeave,
  collectionKey,
  collectionReducer,
  noticeAfterDismiss,
  observationKey,
  unloadedCollection,
  type CollectionEvent,
  type CollectionState
} from './subscriptionListState'

/** Local history is re-read this often while a plan runs in this window; never any remote call. */
const PLAN_POLL_MS = 1000

/**
 * A write (加入／取消) or a read-only 核对 the user started. Its object is frozen when it starts:
 * later source, UUID or binding switches never redirect it.
 */
export interface ActiveWrite {
  kind: 'change' | 'reconcile'
  operationId: OperationId
  source: SubscriptionSource
  threadId: ThreadId
  action: SubscriptionAction
  generation: number
  /** Human-readable object, frozen at start. */
  label: string
  /** 停止回读 was requested; an already issued write is not withdrawn. */
  stopRequested: boolean
}

export type WriteOutcome =
  | { type: 'done'; operation: SubscriptionOperation }
  | { type: 'refused'; reason: SubscriptionFailure }
  /** The IPC call itself rejected: whether a write went out is unknown. */
  | { type: 'failed' }

export interface WriteNotice {
  /** The write as it ended, including whether 停止回读 was requested. */
  write: ActiveWrite
  outcome: WriteOutcome
}

export interface ChangeRequest {
  source: SubscriptionSource
  threadId: ThreadId
  action: SubscriptionAction
  expectedGeneration: number
  label: string
}

/** Why the last 关闭 (×) of a journal entry did not happen; the entry and its protection stay. */
export interface DismissFailure {
  id: string
  reason: SubscriptionFailure | 'internal'
}

export interface SubscriptionsState {
  /** Last overview received; kept while a refresh runs or fails. */
  overview: SubscriptionOverview | null
  overviewFailed: boolean
  refreshOverview: () => Promise<void>
  /** Applies an overview returned by configureApp / selectSource. */
  applyOverview: (overview: SubscriptionOverview) => void
  /** Local journal, newest first; kept while a refresh fails. */
  operations: SubscriptionOperation[] | null
  operationsFailed: boolean
  refreshOperations: () => Promise<void>
  /** At most one write or 核对 at a time, app-wide. */
  active: ActiveWrite | null
  lastWrite: WriteNotice | null
  dismissLastWrite: () => void
  clearSuccessfulWrite: (displayed: WriteNotice | null) => void
  change: (request: ChangeRequest) => Promise<void>
  reconcile: (operation: SubscriptionOperation) => Promise<void>
  /** Cancels the readback / 核对 reads of the active write; the write request itself is not withdrawn. */
  stopReadback: () => void
  /**
   * Durably closes an unresolved journal entry (×): local only, nothing is sent and nothing is
   * retried; its report and evidence stay. Resolves true once saved. Refused while anything runs.
   */
  dismiss: (operation: SubscriptionOperation) => Promise<boolean>
  /** The entry whose 关闭 is being saved. */
  dismissing: string | null
  dismissFailure: DismissFailure | null

  /** Remote collections by `collectionKey`: snapshot, latest evidence and read round, shared by all views. */
  collections: ReadonlyMap<string, CollectionState>
  /** Reads a collection's stored snapshot and latest observation once (again after a failure); local only. */
  loadCollection: (source: SubscriptionSource, context: SubscriptionContext) => void
  /**
   * Starts one read round of a collection, page after page to the end candidate, unless one is
   * running (then it is joined). `resume` continues the latest unfinished observation instead of
   * starting at page 1. Never retried automatically; leaving a view does not cancel it.
   */
  refreshCollection: (source: SubscriptionSource, context: SubscriptionContext, resume?: boolean) => void
  /**
   * 停止读取: cancels the page the collection's round is reading and starts no further page; only
   * this collection's round, whichever view asked. What was read stays. No-op once requested.
   */
  stopCollection: (source: SubscriptionSource, context: SubscriptionContext) => void

  /** The one sync / merge preview or plan of this window; process-only, never resumed. */
  task: ReconcileTask | null
  /** A write, 核对, 关闭, preview read or plan is running: nothing else may start. */
  busy: boolean
  /** Starts a fresh preview (bounded background reads, no writes). Merge needs an explicit old App reference. */
  startPreview: (mode: ReconcileMode, mergeSource: SubscriptionMergeSource | null) => Promise<void>
  /** Sets the choice of differences of the current preview (only where that choice is offered). */
  setChoice: (ids: readonly string[], choice: SubscriptionChoice) => void
  /**
   * Executes the current preview's choices once; the preview is consumed whatever happens. A `stale`
   * refusal wrote nothing: a fresh preview starts at once and says so.
   */
  execute: () => Promise<void>
  /** Stops later reads / steps of the running preview or plan; an already sent write is not withdrawn. */
  stopTask: () => void
  /** Drops a preview (a running preview read is cancelled), a failed preview or a finished result. A running plan stays. */
  dismissTask: () => void
  clearSuccessfulTask: (displayed: ReconcileTask) => void
  /** Asks a subscription pane to show the 同步与合并 view (an entry outside the pane started a preview). */
  revealSeq: number
  requestReveal: () => void
  /** The first visible pane takes the request; true at most once per request. */
  claimReveal: (seq: number) => boolean
  /** Durable plan history (local), newest first; kept while a refresh fails. */
  plans: SubscriptionPlan[] | null
  plansFailed: boolean
  refreshPlans: () => Promise<void>
  /** Earlier App UUID references that a merge can read from. */
  mergeSources: SubscriptionMergeSource[] | null
  mergeSourcesFailed: boolean
  refreshMergeSources: () => Promise<void>
}

function newestFirst(operations: SubscriptionOperation[]): SubscriptionOperation[] {
  return [...operations].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

/** Subscription overview, journal and the single active write, shared by settings and every subscription list. */
export function useSubscriptions(): SubscriptionsState {
  const [overview, setOverview] = useState<SubscriptionOverview | null>(null)
  const [overviewFailed, setOverviewFailed] = useState(false)
  const [operations, setOperations] = useState<SubscriptionOperation[] | null>(null)
  const [operationsFailed, setOperationsFailed] = useState(false)
  const [active, setActive] = useState<ActiveWrite | null>(null)
  const [lastWrite, setLastWrite] = useState<WriteNotice | null>(null)
  const clearSuccessfulWrite = useCallback((displayed: WriteNotice | null) => {
    setLastWrite((current) => clearSuccessfulWriteOnLeave(current, displayed))
  }, [])
  const latestOverview = useRef(0)
  const latestOperations = useRef(0)
  const alive = useRef(true)
  // Synchronous guard: two clicks in the same frame must not start two writes.
  const activeRef = useRef<ActiveWrite | null>(null)
  const [task, setTaskState] = useState<ReconcileTask | null>(null)
  // Same synchronous guard for previews and plans; shares the single-write rule with activeRef.
  const taskRef = useRef<ReconcileTask | null>(null)
  const [plans, setPlans] = useState<SubscriptionPlan[] | null>(null)
  const [plansFailed, setPlansFailed] = useState(false)
  const [mergeSources, setMergeSources] = useState<SubscriptionMergeSource[] | null>(null)
  const [mergeSourcesFailed, setMergeSourcesFailed] = useState(false)
  const latestPlans = useRef(0)
  const latestMergeSources = useRef(0)
  const [dismissing, setDismissing] = useState<string | null>(null)
  const [dismissFailure, setDismissFailure] = useState<DismissFailure | null>(null)
  // Synchronous guard, as for writes: a second × in the same frame does nothing.
  const dismissingRef = useRef<string | null>(null)
  const [collections, setCollections] = useState<ReadonlyMap<string, CollectionState>>(() => new Map())
  const collectionsRef = useRef<Map<string, CollectionState>>(new Map())
  /** The read round of each collection in flight, with the operation of the page it is reading. */
  const rounds = useRef(new Map<string, { operationId: string; stopRequested: boolean }>())
  /** Collections whose stored observations are being read. */
  const loads = useRef(new Set<string>())
  const overviewRef = useRef<SubscriptionOverview | null>(null)
  useEffect(() => {
    overviewRef.current = overview
  })

  const setTask = useCallback((next: ReconcileTask | null) => {
    taskRef.current = next
    setTaskState(next)
  }, [])

  const refreshOverview = useCallback(async () => {
    const request = ++latestOverview.current
    try {
      const next = await window.xidao.subscriptions.getOverview()
      if (!alive.current || request !== latestOverview.current) return
      setOverview(next)
      setOverviewFailed(false)
    } catch {
      if (!alive.current || request !== latestOverview.current) return
      setOverviewFailed(true)
    }
  }, [])

  const applyOverview = useCallback((next: SubscriptionOverview) => {
    // Supersedes any overview read still in flight.
    latestOverview.current++
    setOverview(next)
    setOverviewFailed(false)
  }, [])

  const refreshOperations = useCallback(async () => {
    const request = ++latestOperations.current
    try {
      const next = await window.xidao.subscriptions.getOperations()
      if (!alive.current || request !== latestOperations.current) return
      setOperations(newestFirst(next))
      setOperationsFailed(false)
    } catch {
      if (!alive.current || request !== latestOperations.current) return
      setOperationsFailed(true)
    }
  }, [])

  const refreshPlans = useCallback(async () => {
    const request = ++latestPlans.current
    try {
      const next = await window.xidao.subscriptions.getPlans()
      if (!alive.current || request !== latestPlans.current) return
      setPlans(newestPlansFirst(next))
      setPlansFailed(false)
    } catch {
      if (!alive.current || request !== latestPlans.current) return
      setPlansFailed(true)
    }
  }, [])

  const refreshMergeSources = useCallback(async () => {
    const request = ++latestMergeSources.current
    try {
      const next = await window.xidao.subscriptions.getMergeSources()
      if (!alive.current || request !== latestMergeSources.current) return
      setMergeSources(next)
      setMergeSourcesFailed(false)
    } catch {
      if (!alive.current || request !== latestMergeSources.current) return
      setMergeSourcesFailed(true)
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void refreshOverview()
    void refreshOperations()
    // Local history only: an interrupted plan is shown, never continued.
    void refreshPlans()
    return () => {
      alive.current = false
      for (const round of rounds.current.values()) window.xidao.subscriptions.cancel({ operationId: round.operationId }).catch(() => undefined)
    }
  }, [refreshOverview, refreshOperations, refreshPlans])

  const updateCollection = useCallback((key: string, event: CollectionEvent) => {
    const next = new Map(collectionsRef.current)
    next.set(key, collectionReducer(next.get(key) ?? unloadedCollection, event))
    collectionsRef.current = next
    if (alive.current) setCollections(next)
  }, [])

  // Every readback / 核对 read in the journal (dismissed entries included: closing erases no evidence)
  // is evidence of its own collection, taken only where it is newer than what that collection has.
  useEffect(() => {
    const current = collectionsRef.current
    let next: Map<string, CollectionState> | null = null
    for (const operation of operations ?? []) {
      const after = operation.after
      if (after === null) continue
      const key = observationKey(after)
      const before = (next ?? current).get(key) ?? unloadedCollection
      const merged = collectionReducer(before, { type: 'evidence', observation: after })
      if (merged === before) continue
      next ??= new Map(current)
      next.set(key, merged)
    }
    if (next === null) return
    collectionsRef.current = next
    if (alive.current) setCollections(next)
  }, [operations])

  const loadCollection = useCallback(
    (source: SubscriptionSource, context: SubscriptionContext) => {
      const key = collectionKey(source, context)
      const local = collectionsRef.current.get(key)?.local ?? 'idle'
      // An entry made from journal evidence alone (`idle`) still reads what storage holds.
      if (loads.current.has(key) || local === 'loading' || local === 'loaded') return
      loads.current.add(key)
      updateCollection(key, { type: 'load' })
      // Stored for the identity the main process has now; anything of another collection is no evidence here.
      const own = (observation: SubscriptionObservation | null) => (observation !== null && observationKey(observation) === key ? observation : null)
      Promise.all([window.xidao.subscriptions.getSnapshot({ source }), window.xidao.subscriptions.getObservation({ source })])
        .then(
          ([snapshot, latest]) => updateCollection(key, { type: 'local', snapshot: own(snapshot), latest: own(latest) }),
          () => updateCollection(key, { type: 'local-failed' })
        )
        .finally(() => loads.current.delete(key))
    },
    [updateCollection]
  )

  /** One round: page after page until the end candidate, the first error, refusal, cancellation or identity change. */
  const runRound = useCallback(
    async (key: string, source: SubscriptionSource, from: string | null) => {
      const round = { operationId: '', stopRequested: false }
      rounds.current.set(key, round)
      updateCollection(key, { type: 'start' })
      let observationId = from
      try {
        for (;;) {
          // Requested between two pages: the next one never starts.
          if (round.stopRequested) return
          round.operationId = crypto.randomUUID()
          let result: SubscriptionResult<SubscriptionObservation>
          try {
            result = await window.xidao.subscriptions.read({ source, observationId, operationId: round.operationId })
          } catch {
            updateCollection(key, { type: 'internal' })
            return
          }
          if (!result.ok) {
            updateCollection(key, { type: 'refused', reason: result.reason })
            return
          }
          const observation = result.value
          // The main process reads for its current identity: a result of another collection stays out of this one.
          if (observationKey(observation) !== key) return
          updateCollection(key, { type: 'observed', observation })
          if (observation.error !== null || observation.cancelled || observation.nextPage === null) return
          observationId = observation.id
        }
      } finally {
        rounds.current.delete(key)
        updateCollection(key, { type: 'end' })
      }
    },
    [updateCollection]
  )

  const refreshCollection = useCallback(
    (source: SubscriptionSource, context: SubscriptionContext, resume = false) => {
      const key = collectionKey(source, context)
      loadCollection(source, context)
      if (rounds.current.has(key)) return
      const latest = collectionsRef.current.get(key)?.latest ?? null
      const from = resume && latest !== null && latest.nextPage !== null ? latest.id : null
      void runRound(key, source, from)
    },
    [loadCollection, runRound]
  )

  const stopCollection = useCallback(
    (source: SubscriptionSource, context: SubscriptionContext) => {
      const key = collectionKey(source, context)
      const round = rounds.current.get(key)
      // Synchronous guard: a second press, or a press after the round ended, does nothing.
      if (round === undefined || round.stopRequested) return
      round.stopRequested = true
      updateCollection(key, { type: 'stop-requested' })
      window.xidao.subscriptions.cancel({ operationId: round.operationId }).catch(() => undefined)
    },
    [updateCollection]
  )

  // A new App UUID turns the previous one into a merge source.
  const appRef = overview?.context.appCredentialId
  useEffect(() => {
    if (appRef !== undefined) void refreshMergeSources()
  }, [appRef, refreshMergeSources])

  // Progress of a plan running in this window: poll local history and journal only.
  const executing = task?.phase === 'executing'
  useEffect(() => {
    if (!executing) return
    const timer = window.setInterval(() => {
      void refreshPlans()
      void refreshOperations()
    }, PLAN_POLL_MS)
    return () => window.clearInterval(timer)
  }, [executing, refreshPlans, refreshOperations])

  const runWrite = useCallback(
    async (write: ActiveWrite, call: () => Promise<{ ok: true; value: SubscriptionOperation } | { ok: false; reason: SubscriptionFailure }>) => {
      activeRef.current = write
      setActive(write)
      setLastWrite(null)
      let outcome: WriteOutcome
      try {
        const result = await call()
        outcome = result.ok ? { type: 'done', operation: result.value } : { type: 'refused', reason: result.reason }
      } catch {
        outcome = { type: 'failed' }
      }
      const ended = activeRef.current ?? write
      activeRef.current = null
      if (!alive.current) return
      setActive(null)
      setLastWrite({ write: ended, outcome })
      // The journal is the durable record; re-read it whatever happened, including IPC failures.
      void refreshOperations()
    },
    [refreshOperations]
  )

  const change = useCallback(
    async (request: ChangeRequest) => {
      if (activeRef.current !== null || dismissingRef.current !== null || busyTask(taskRef.current)) return
      const operationId = crypto.randomUUID()
      const write: ActiveWrite = {
        kind: 'change',
        operationId,
        source: request.source,
        threadId: request.threadId,
        action: request.action,
        generation: request.expectedGeneration,
        label: request.label,
        stopRequested: false
      }
      await runWrite(write, () =>
        window.xidao.subscriptions.change({
          source: request.source,
          threadId: request.threadId,
          action: request.action,
          expectedGeneration: request.expectedGeneration,
          operationId
        })
      )
    },
    [runWrite]
  )

  const reconcile = useCallback(
    async (operation: SubscriptionOperation) => {
      if (activeRef.current !== null || dismissingRef.current !== null || busyTask(taskRef.current)) return
      const operationId = crypto.randomUUID()
      const write: ActiveWrite = {
        kind: 'reconcile',
        operationId,
        source: operation.source,
        threadId: operation.threadId,
        action: operation.action,
        generation: operation.context.generation,
        // The record's object label names the collection by local reference; the line names the thread.
        label: '',
        stopRequested: false
      }
      await runWrite(write, () => window.xidao.subscriptions.reconcile({ id: operation.id, operationId }))
    },
    [runWrite]
  )

  const stopReadback = useCallback(() => {
    const write = activeRef.current
    if (write === null || write.stopRequested) return
    const stopped = { ...write, stopRequested: true }
    activeRef.current = stopped
    setActive(stopped)
    window.xidao.subscriptions.cancel({ operationId: write.operationId }).catch(() => undefined)
  }, [])

  const dismissLastWrite = useCallback(() => setLastWrite(null), [])

  const dismiss = useCallback(
    async (operation: SubscriptionOperation): Promise<boolean> => {
      if (activeRef.current !== null || dismissingRef.current !== null || busyTask(taskRef.current)) return false
      dismissingRef.current = operation.id
      setDismissing(operation.id)
      setDismissFailure(null)
      let saved = false
      try {
        const result = await window.xidao.subscriptions.dismiss({ id: operation.id })
        if (!alive.current) return result.ok
        if (result.ok) {
          saved = true
          const closed = result.value
          setOperations((current) => current?.map((item) => (item.id === closed.id ? closed : item)) ?? current)
          // The finished write's line is the same reminder: it goes with it, and nothing else does.
          setLastWrite((current) => noticeAfterDismiss(current, closed))
        } else setDismissFailure({ id: operation.id, reason: result.reason })
      } catch {
        if (alive.current) setDismissFailure({ id: operation.id, reason: 'internal' })
      } finally {
        dismissingRef.current = null
        if (alive.current) setDismissing(null)
      }
      // The journal is the durable record: whatever happened, show what it holds.
      void refreshOperations()
      return saved
    },
    [refreshOperations]
  )

  /** Reads a fresh preview; callers have checked that nothing else runs. */
  const runPreview = useCallback(
    async (mode: ReconcileMode, mergeSource: SubscriptionMergeSource | null, notice: PreviewNotice) => {
      const operationId = crypto.randomUUID()
      setTask({ phase: 'previewing', mode, mergeSource, operationId, stopRequested: false, notice })
      let next: ReconcileTask
      try {
        const result =
          mode === 'sync' || mergeSource === null
            ? await window.xidao.subscriptions.previewSync({ operationId })
            : await window.xidao.subscriptions.previewMerge({ sourceAppCredentialId: mergeSource.appCredentialId, operationId })
        next = result.ok
          ? { phase: 'preview', preview: result.value, mergeSource, choices: defaultChoices(result.value), notice }
          : { phase: 'preview-failed', mode, mergeSource, reason: result.reason }
      } catch {
        next = { phase: 'preview-failed', mode, mergeSource, reason: 'internal' }
      }
      if (!alive.current) return
      const current = taskRef.current
      if (current?.phase !== 'previewing' || current.operationId !== operationId) return
      setTask(next)
    },
    [setTask]
  )

  const startPreview = useCallback(
    async (mode: ReconcileMode, mergeSource: SubscriptionMergeSource | null) => {
      if (activeRef.current !== null || dismissingRef.current !== null || busyTask(taskRef.current)) return
      if (mode === 'merge' && mergeSource === null) return
      await runPreview(mode, mergeSource, null)
    },
    [runPreview]
  )

  const setChoice = useCallback(
    (ids: readonly string[], choice: SubscriptionChoice) => {
      const current = taskRef.current
      if (current?.phase !== 'preview') return
      setTask({ ...current, choices: withChoice(current.preview, current.choices, ids, choice) })
    },
    [setTask]
  )

  const execute = useCallback(async () => {
    const current = taskRef.current
    if (current?.phase !== 'preview' || activeRef.current !== null) return
    // A preview made for another UUID / binding is never sent; the backend would refuse it as stale too.
    if (!previewCurrent(current.preview, overviewRef.current?.context ?? null)) return
    const { preview, mergeSource, choices } = current
    const chosen = planChoices(preview, choices)
    if (chosen.length === 0) return
    const operationId = crypto.randomUUID()
    setTask({ phase: 'executing', preview, mergeSource, choices, operationId, stopRequested: false })
    let outcome: ExecuteOutcome
    try {
      const result = await window.xidao.subscriptions.executePlan({ previewId: preview.id, choices: chosen, operationId })
      outcome = result.ok ? { type: 'plan', plan: result.value } : { type: 'refused', reason: result.reason }
    } catch {
      outcome = { type: 'failed' }
    }
    if (!alive.current) return
    const ended = taskRef.current
    const stillOurs = ended?.phase === 'executing' && ended.operationId === operationId
    // Something changed after the preview and nothing was written: show the differences as they are now.
    if (outcome.type === 'refused' && outcome.reason === 'stale' && stillOurs) {
      void runPreview(preview.mode, mergeSource, 'stale')
      return
    }
    setTask({ phase: 'finished', preview, mergeSource, choices, stopRequested: stillOurs ? ended.stopRequested : false, outcome })
    // History and journal are the durable record; re-read them whatever happened.
    void refreshPlans()
    void refreshOperations()
  }, [setTask, runPreview, refreshPlans, refreshOperations])

  const stopTask = useCallback(() => {
    const current = taskRef.current
    if (current === null || (current.phase !== 'previewing' && current.phase !== 'executing') || current.stopRequested) return
    setTask({ ...current, stopRequested: true })
    window.xidao.subscriptions.cancel({ operationId: current.operationId }).catch(() => undefined)
  }, [setTask])

  const dismissTask = useCallback(() => {
    const current = taskRef.current
    if (current?.phase === 'executing') return
    // Its late result is dropped: the task no longer matches it.
    if (current?.phase === 'previewing') window.xidao.subscriptions.cancel({ operationId: current.operationId }).catch(() => undefined)
    setTask(null)
  }, [setTask])

  const clearSuccessfulTask = useCallback((displayed: ReconcileTask) => {
    if (taskRef.current === displayed) setTask(null)
  }, [setTask])

  const [revealSeq, setRevealSeq] = useState(0)
  const claimedReveal = useRef(0)
  const requestReveal = useCallback(() => setRevealSeq((seq) => seq + 1), [])
  const claimReveal = useCallback((seq: number) => {
    if (seq <= claimedReveal.current) return false
    claimedReveal.current = seq
    return true
  }, [])

  return {
    overview,
    overviewFailed,
    refreshOverview,
    applyOverview,
    operations,
    operationsFailed,
    refreshOperations,
    active,
    lastWrite,
    dismissLastWrite,
    clearSuccessfulWrite,
    change,
    reconcile,
    stopReadback,
    dismiss,
    dismissing,
    dismissFailure,
    collections,
    loadCollection,
    refreshCollection,
    stopCollection,
    task,
    busy: active !== null || dismissing !== null || busyTask(task),
    startPreview,
    setChoice,
    execute,
    stopTask,
    dismissTask,
    clearSuccessfulTask,
    revealSeq,
    requestReveal,
    claimReveal,
    plans,
    plansFailed,
    refreshPlans,
    mergeSources,
    mergeSourcesFailed,
    refreshMergeSources
  }
}

export const SubscriptionsContext = createContext<SubscriptionsState | null>(null)

export function useSubscriptionsContext(): SubscriptionsState {
  const value = useContext(SubscriptionsContext)
  if (value === null) throw new Error('SubscriptionsContext is not provided')
  return value
}

/**
 * The remote collection `source` writes to under the identity shown, with its stored snapshot read
 * once when first needed. Rendering never reads from the forum; only `refreshCollection` does.
 */
export function useCollection(source: SubscriptionSource): { key: string | null; state: CollectionState | null } {
  const { overview, collections, loadCollection } = useSubscriptionsContext()
  const context = overview?.context ?? null
  const key = context === null ? null : collectionKey(source, context)
  useEffect(() => {
    if (context !== null) loadCollection(source, context)
    // The key names the source and every part of the context.
  }, [key, loadCollection])
  return { key, state: key === null ? null : (collections.get(key) ?? unloadedCollection) }
}
