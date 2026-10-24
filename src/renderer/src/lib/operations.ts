import type { OperationId, ReadError, ReadOutcome } from '../../../shared/api'

/** A failure the UI can explain: a classified forum read error, or the IPC call itself rejecting. */
export type Failure = { type: 'read'; error: ReadError } | { type: 'internal' }

/** Where the shown data came from. */
export type Source =
  | { status: 'fresh'; fetchedAt: string; saved: boolean }
  | { status: 'cached'; fetchedAt: string; networkError: ReadError | null }

export type Settled<T> =
  /** Superseded or abandoned by this scope: the caller must not apply anything. */
  | { type: 'stale' }
  /** The operation was still current but reported cancellation: return to idle silently. */
  | { type: 'cancelled' }
  | { type: 'failed'; failure: Failure }
  | { type: 'ok'; data: T; source: Source }

/**
 * Tracks the read operations one view started. Every result is checked against the set of
 * still-active operation IDs, so anything cancelled or superseded is discarded on arrival.
 */
export class OperationScope {
  private readonly active = new Set<OperationId>()

  get busy(): boolean {
    return this.active.size > 0
  }

  /** Whether the operation is still current (not finished, cancelled or superseded). */
  isActive(operationId: OperationId): boolean {
    return this.active.has(operationId)
  }

  async run<T>(call: (operationId: OperationId) => Promise<ReadOutcome<T>>): Promise<Settled<T>> {
    const operationId = crypto.randomUUID()
    this.active.add(operationId)
    let outcome: ReadOutcome<T>
    try {
      outcome = await call(operationId)
    } catch {
      if (!this.active.delete(operationId)) return { type: 'stale' }
      return { type: 'failed', failure: { type: 'internal' } }
    }
    if (!this.active.delete(operationId)) return { type: 'stale' }
    switch (outcome.status) {
      case 'cancelled':
        return { type: 'cancelled' }
      case 'failed':
        return { type: 'failed', failure: { type: 'read', error: outcome.error } }
      case 'fresh':
        return { type: 'ok', data: outcome.data, source: { status: 'fresh', fetchedAt: outcome.fetchedAt, saved: outcome.saved } }
      case 'cached':
        return {
          type: 'ok',
          data: outcome.data,
          source: { status: 'cached', fetchedAt: outcome.fetchedAt, networkError: outcome.networkError }
        }
    }
  }

  /** Cancels every operation of this scope; their late results become stale. */
  cancelAll(): void {
    for (const operationId of this.active) {
      window.xidao.reading.cancel({ operationId }).catch(() => undefined)
    }
    this.active.clear()
  }
}
