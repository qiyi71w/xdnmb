import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { OperationId } from '../../../../shared/api'
import type { ThreadId } from '../../../../shared/forum'
import type {
  SubscriptionAction,
  SubscriptionFailure,
  SubscriptionOperation,
  SubscriptionOverview,
  SubscriptionSource
} from '../../../../shared/subscriptions'

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
  change: (request: ChangeRequest) => Promise<void>
  reconcile: (operation: SubscriptionOperation) => Promise<void>
  /** Cancels the readback / 核对 reads of the active write; the write request itself is not withdrawn. */
  stopReadback: () => void
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
  const latestOverview = useRef(0)
  const latestOperations = useRef(0)
  const alive = useRef(true)
  // Synchronous guard: two clicks in the same frame must not start two writes.
  const activeRef = useRef<ActiveWrite | null>(null)

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

  useEffect(() => {
    alive.current = true
    void refreshOverview()
    void refreshOperations()
    return () => {
      alive.current = false
    }
  }, [refreshOverview, refreshOperations])

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
      if (activeRef.current !== null) return
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
      if (activeRef.current !== null) return
      const operationId = crypto.randomUUID()
      const write: ActiveWrite = {
        kind: 'reconcile',
        operationId,
        source: operation.source,
        threadId: operation.threadId,
        action: operation.action,
        generation: operation.context.generation,
        label: operation.objectLabel,
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
    change,
    reconcile,
    stopReadback
  }
}

export const SubscriptionsContext = createContext<SubscriptionsState | null>(null)

export function useSubscriptionsContext(): SubscriptionsState {
  const value = useContext(SubscriptionsContext)
  if (value === null) throw new Error('SubscriptionsContext is not provided')
  return value
}
