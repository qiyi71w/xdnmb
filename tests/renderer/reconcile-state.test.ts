import { describe, expect, it } from 'vitest'
import type {
  SubscriptionAction,
  SubscriptionCandidate,
  SubscriptionContext,
  SubscriptionObservation,
  SubscriptionPreview,
  SubscriptionSource
} from '../../src/shared/subscriptions'
import { defaultSelection, groupCandidates, selectedInOrder } from '../../src/renderer/src/features/subscriptions/reconcileState'

const context: SubscriptionContext = { generation: 1, appCredentialId: '7', webCredentialId: '3' }

const candidate = (id: string, action: SubscriptionAction, target: SubscriptionSource): SubscriptionCandidate => ({
  id,
  threadId: id,
  action,
  target
})

const appObservation: SubscriptionObservation = {
  id: 'obs-app',
  source: 'app',
  context,
  startedAt: '2026-10-24T00:00:00.000Z',
  pages: [],
  ids: [],
  nextPage: null,
  error: null,
  cancelled: false
}

const shape = (items: readonly SubscriptionCandidate[]) =>
  groupCandidates(items).map((group) => [group.action, group.target, group.items.map((item) => item.threadId)])

describe('candidate groups', () => {
  it('keep the preview order instead of moving additions first', () => {
    const items = [candidate('10101', 'remove', 'app'), candidate('10201', 'add', 'app')]
    expect(shape(items)).toEqual([
      ['remove', 'app', ['10101']],
      ['add', 'app', ['10201']]
    ])
  })

  it('repeat an effect for each separate run, with unique keys, reading in execution order', () => {
    const items = [
      candidate('1', 'add', 'web'),
      candidate('2', 'add', 'web'),
      candidate('3', 'remove', 'app'),
      candidate('4', 'add', 'web'),
      candidate('5', 'add', 'app'),
      candidate('6', 'remove', 'web')
    ]
    const groups = groupCandidates(items)
    expect(shape(items)).toEqual([
      ['add', 'web', ['1', '2']],
      ['remove', 'app', ['3']],
      ['add', 'web', ['4']],
      ['add', 'app', ['5']],
      ['remove', 'web', ['6']]
    ])
    expect(new Set(groups.map((group) => group.key)).size).toBe(groups.length)
    expect(groups.flatMap((group) => group.items)).toEqual(items)
  })

  it('summarise only the selected candidates, in the order the plan executes them', () => {
    const items = [
      candidate('1', 'add', 'web'),
      candidate('2', 'remove', 'app'),
      candidate('3', 'add', 'web'),
      candidate('4', 'remove', 'web'),
      candidate('5', 'add', 'app')
    ]
    const value: SubscriptionPreview = {
      id: 'preview-1',
      mode: 'sync',
      context,
      createdAt: '2026-10-24T00:00:00.000Z',
      left: appObservation,
      right: { ...appObservation, id: 'obs-web', source: 'web' },
      leftLabel: 'App 对象 7',
      rightLabel: '网页 · 本地引用 3',
      firstSync: false,
      deletionsAllowed: true,
      items
    }
    const selected = defaultSelection(value)
    expect(selectedInOrder(value, selected)).toEqual(['1', '3', '5'])

    const chosen = items.filter((item) => selected.has(item.id))
    expect(shape(chosen)).toEqual([
      ['add', 'web', ['1', '3']],
      ['add', 'app', ['5']]
    ])
    expect(groupCandidates(chosen).flatMap((group) => group.items.map((item) => item.id))).toEqual(selectedInOrder(value, selected))
  })
})
