import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { OperationId } from '../../../../shared/api'
import type { ThreadId } from '../../../../shared/forum'
import type {
  SubscriptionAction,
  SubscriptionChoice,
  SubscriptionFailure,
  SubscriptionMergeSource,
  SubscriptionOperation,
  SubscriptionOverview,
  SubscriptionPlan,
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
import { clearSuccessfulWriteOnLeave } from './subscriptionListState'

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

  /** The one sync / merge preview or plan of this window; process-only, never resumed. */
  task: ReconcileTask | null
  /** A write, 核对, preview read or plan is running: nothing else may start. */
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
    }
  }, [refreshOverview, refreshOperations, refreshPlans])

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
      if (activeRef.current !== null || busyTask(taskRef.current)) return
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
      if (activeRef.current !== null || busyTask(taskRef.current)) return
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
      if (activeRef.current !== null || busyTask(taskRef.current)) return
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
    task,
    busy: active !== null || busyTask(task),
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
