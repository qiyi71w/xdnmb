import { describe, expect, it } from 'vitest'
import type { ThreadSummary } from '../../src/shared/forum'
import type {
  SubscriptionChoice,
  SubscriptionContext,
  SubscriptionDifference,
  SubscriptionObservation,
  SubscriptionPlan,
  SubscriptionPreview,
  SubscriptionSource
} from '../../src/shared/subscriptions'
import {
  defaultChoices,
  planChoices,
  planCounts,
  withChoice,
  writeCounts
} from '../../src/renderer/src/features/subscriptions/reconcileState'

const context: SubscriptionContext = { generation: 1, appCredentialId: '7', webCredentialId: '3' }

const thread = (id: string): ThreadSummary => ({
  head: {
    id,
    forumId: null,
    createdAt: null,
    userHash: null,
    name: null,
    title: null,
    isAdmin: null,
    isSage: null,
    content: [],
    plainText: '',
    image: null
  },
  replyCount: null,
  recentReplies: [],
  remainReplies: null
})

const ALL: SubscriptionChoice[] = ['both', 'none', 'skip']

const difference = (
  id: string,
  presentOn: SubscriptionSource,
  defaultChoice: SubscriptionChoice,
  choices: SubscriptionChoice[] = ALL
): SubscriptionDifference => ({
  id,
  threadId: id,
  presentOn,
  thread: thread(id),
  baseline: defaultChoice === 'skip',
  provenance: defaultChoice === 'skip' ? { kind: 'gone' } : null,
  choices,
  defaultChoice
})

const observation = (source: SubscriptionSource): SubscriptionObservation => ({
  id: `obs-${source}`,
  source,
  context,
  startedAt: '2026-10-27T00:00:00.000Z',
  pages: [],
  ids: [],
  nextPage: null,
  error: null,
  cancelled: false
})

const preview = (items: SubscriptionDifference[]): SubscriptionPreview => ({
  id: 'preview-1',
  mode: 'sync',
  context,
  createdAt: '2026-10-27T00:00:00.000Z',
  left: observation('app'),
  right: { ...observation('web'), source: 'web' },
  leftLabel: 'App 订阅',
  rightLabel: '网页订阅（饼干）',
  firstSync: false,
  items
})

describe('difference choices', () => {
  it('start at each difference’s default, and an all-default preview executes only the non-skip ones', () => {
    const value = preview([difference('1', 'web', 'both'), difference('2', 'web', 'skip'), difference('3', 'app', 'both')])
    const choices = defaultChoices(value)
    expect([...choices]).toEqual([
      ['1', 'both'],
      ['2', 'skip'],
      ['3', 'both']
    ])
    expect(planChoices(value, choices)).toEqual([
      { itemId: '1', choice: 'both' },
      { itemId: '3', choice: 'both' }
    ])
    expect(writeCounts(value, choices)).toEqual({ add: 2, remove: 0 })
  })

  it('send every writing choice in the preview’s order, whatever order they were set in', () => {
    const value = preview([difference('1', 'app', 'skip'), difference('2', 'web', 'skip'), difference('3', 'app', 'skip')])
    let choices = defaultChoices(value)
    choices = withChoice(value, choices, ['3'], 'none')
    choices = withChoice(value, choices, ['1'], 'both')
    choices = withChoice(value, choices, ['2'], 'both')
    expect(planChoices(value, choices)).toEqual([
      { itemId: '1', choice: 'both' },
      { itemId: '2', choice: 'both' },
      { itemId: '3', choice: 'none' }
    ])
    expect(writeCounts(value, choices)).toEqual({ add: 2, remove: 1 })
  })

  it('never set a choice a difference does not offer (no 两端都取消 on a first or incomplete sync)', () => {
    const value = preview([difference('1', 'web', 'both', ['both', 'skip']), difference('2', 'app', 'skip')])
    const choices = withChoice(value, defaultChoices(value), ['1', '2'], 'none')
    expect(choices.get('1')).toBe('both')
    expect(choices.get('2')).toBe('none')
    expect(planChoices(value, choices)).toEqual([
      { itemId: '1', choice: 'both' },
      { itemId: '2', choice: 'none' }
    ])
  })

  it('send nothing when every difference is left alone', () => {
    const value = preview([difference('1', 'web', 'both'), difference('2', 'app', 'both')])
    const choices = withChoice(value, defaultChoices(value), ['1', '2'], 'skip')
    expect(planChoices(value, choices)).toEqual([])
    expect(writeCounts(value, choices)).toEqual({ add: 0, remove: 0 })
  })
})

describe('plan counts', () => {
  it('count confirmed writes by action and everything that did not complete', () => {
    const plan: SubscriptionPlan = {
      id: 'plan-1',
      preview: preview([]),
      createdAt: '2026-10-27T00:00:00.000Z',
      finishedAt: '2026-10-27T00:01:00.000Z',
      state: 'stopped',
      stopReason: 'item-failed',
      items: [
        { candidate: { id: '1', threadId: '1', action: 'add', target: 'app' }, operationId: 'op-1', state: 'confirmed', failure: null },
        { candidate: { id: '2', threadId: '2', action: 'remove', target: 'web' }, operationId: 'op-2', state: 'confirmed', failure: null },
        { candidate: { id: '3', threadId: '3', action: 'add', target: 'web' }, operationId: 'op-3', state: 'failed', failure: 'storage' },
        { candidate: { id: '4', threadId: '4', action: 'add', target: 'web' }, operationId: null, state: 'skipped', failure: null },
        { candidate: { id: '5', threadId: '5', action: 'add', target: 'web' }, operationId: null, state: 'pending', failure: null }
      ]
    }
    expect(planCounts(plan)).toEqual({ added: 1, removed: 1, failed: 1, unknown: 0, notRun: 2 })
  })
})
