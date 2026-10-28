import { describe, expect, it } from 'vitest'
import type { SubscriptionContext, SubscriptionOperation, SubscriptionOverview } from '../../src/shared/subscriptions'
import {
  blocksNewWrite,
  clearSuccessfulWriteOnLeave,
  decideChange,
  isReconcilable,
  isRunningChange
} from '../../src/renderer/src/features/subscriptions/subscriptionListState'
import type { WriteNotice } from '../../src/renderer/src/features/subscriptions/useSubscriptions'

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

describe('a press of 订阅／取消订阅 (prototype: no confirmation)', () => {
  const overview: SubscriptionOverview = {
    context: context(2, '7', null),
    source: 'app',
    appConfigured: true,
    webSelection: { state: 'none' },
    webName: null,
    protection: 'available',
    writable: true
  }
  const press = (overrides: Partial<Parameters<typeof decideChange>[0]> = {}) =>
    decideChange({
      overview,
      operations: [],
      busy: false,
      action: 'add',
      threadId: '1003',
      label: 'No.1003',
      unresolved: '待核对',
      ...overrides
    })

  it('is the write itself, for the shown source and identity generation', () => {
    expect(press()).toEqual({
      kind: 'write',
      request: { source: 'app', threadId: '1003', action: 'add', expectedGeneration: 2, label: 'No.1003' }
    })
    expect(press({ action: 'remove' })).toEqual({
      kind: 'write',
      request: { source: 'app', threadId: '1003', action: 'remove', expectedGeneration: 2, label: 'No.1003' }
    })
  })

  it('keeps the existing reasons when it cannot write', () => {
    expect(press({ overview: null })).toEqual({ kind: 'blocked', reason: '订阅设置尚未读取' })
    expect(press({ overview: { ...overview, appConfigured: false } })).toEqual({ kind: 'blocked', reason: '尚未设置 App 订阅 UUID' })
    expect(press({ overview: { ...overview, protection: 'unavailable' } })).toEqual({
      kind: 'blocked',
      reason: '系统凭据保护不可用，订阅身份暂时无法使用'
    })
    expect(press({ overview: { ...overview, writable: false } })).toEqual({ kind: 'blocked', reason: '本地存储不可写' })
    expect(press({ busy: true })).toEqual({ kind: 'blocked', reason: '另一项订阅操作正在进行' })
  })

  it('never writes over an unresolved earlier write of the same thread; only 核对 may follow', () => {
    expect(press({ operations: [unresolvedAppAdd(context(2, '7', null))] })).toEqual({ kind: 'blocked', reason: '待核对' })
    // Another App collection's unresolved entry does not block this one.
    expect(press({ operations: [unresolvedAppAdd(context(1, '6', null))] }).kind).toBe('write')
  })
})

describe('leaving a subscription result page', () => {
  it('clears the displayed success, keeps unsettled and failed results, and never clears a newer notice', () => {
    const operation = unresolvedAppAdd(context(2, '7', '3'))
    const notice = (outcome: WriteNotice['outcome']): WriteNotice => ({
      write: { kind: 'change', operationId: 'write-1', source: 'app', threadId: '1003', action: 'remove', generation: 2, label: '', stopRequested: false },
      outcome
    })
    const success = notice({ type: 'done', operation: { ...operation, state: 'settled', report: 'success', verification: 'absent-supported' } })
    expect(clearSuccessfulWriteOnLeave(success, success)).toBeNull()
    for (const kept of [
      notice({ type: 'done', operation }),
      notice({ type: 'done', operation: { ...operation, state: 'settled', report: 'success', reportError: { kind: 'rate-limited', detail: 'http-status' } } }),
      notice({ type: 'refused', reason: 'result-storage' }),
      notice({ type: 'refused', reason: 'locked' }),
      notice({ type: 'failed' })
    ]) {
      expect(clearSuccessfulWriteOnLeave(kept, kept)).toBe(kept)
    }
    const newer = notice(success.outcome)
    expect(clearSuccessfulWriteOnLeave(newer, success)).toBe(newer)
    expect(clearSuccessfulWriteOnLeave(success, null)).toBe(success)
  })
})
