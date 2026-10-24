import { describe, expect, it } from 'vitest'
import type { SubscriptionContext, SubscriptionOperation } from '../../src/shared/subscriptions'
import {
  blocksNewWrite,
  isReconcilable,
  isRunningChange
} from '../../src/renderer/src/features/subscriptions/subscriptionListState'

const context = (generation: number, appCredentialId: string | null, webCredentialId: string | null): SubscriptionContext => ({
  generation,
  appCredentialId,
  webCredentialId
})

const unresolvedAppAdd = (operationContext: SubscriptionContext): SubscriptionOperation => ({
  id: 'op-1',
  source: 'app',
  threadId: '1003',
  action: 'add',
  context: operationContext,
  createdAt: '2026-10-24T00:00:00.000Z',
  objectLabel: 'No.1003',
  state: 'needs-reconciliation',
  report: 'unknown',
  reportError: null,
  before: null,
  after: null,
  verification: 'present'
})

describe('unresolved subscription writes', () => {
  const operation = unresolvedAppAdd(context(2, '7', '3'))

  it('blocks the same thread of the same remote collection, even after an unrelated web rebinding', () => {
    expect(blocksNewWrite(operation, { source: 'app', objectRef: '7', threadId: '1003' })).toBe(true)
  })

  it('does not block the same thread in a different App collection, the other source or a settled entry', () => {
    expect(blocksNewWrite(operation, { source: 'app', objectRef: '8', threadId: '1003' })).toBe(false)
    expect(blocksNewWrite(operation, { source: 'web', objectRef: '3', threadId: '1003' })).toBe(false)
    expect(blocksNewWrite({ ...operation, state: 'settled' }, { source: 'app', objectRef: '7', threadId: '1003' })).toBe(false)
  })
})

describe('pending journal entries', () => {
  const pending: SubscriptionOperation = {
    ...unresolvedAppAdd(context(2, '7', null)),
    state: 'pending',
    report: 'pending',
    verification: 'unknown'
  }
  const ownChange = { kind: 'change' as const, source: 'app' as const, threadId: '1003', action: 'add' as const, generation: 2 }

  it('is running only while its own change is active, and cannot be reconciled then', () => {
    expect(isRunningChange(pending, ownChange)).toBe(true)
    expect(isReconcilable(pending, ownChange)).toBe(false)
  })

  it('becomes a reconcilable orphan once the change call ended, though it is still persisted as pending', () => {
    expect(isRunningChange(pending, null)).toBe(false)
    expect(isReconcilable(pending, null)).toBe(true)
    // Another active task (here a 核对 of the same thread) does not make the orphan running again.
    expect(isRunningChange(pending, { ...ownChange, kind: 'reconcile' })).toBe(false)
    expect(isReconcilable(pending, { ...ownChange, kind: 'reconcile' })).toBe(true)
  })

  it('keeps resolved entries unaffected', () => {
    expect(isReconcilable({ ...pending, state: 'settled', report: 'success', verification: 'present' }, null)).toBe(false)
    expect(isReconcilable({ ...pending, state: 'needs-reconciliation', report: 'unknown' }, null)).toBe(true)
  })
})
