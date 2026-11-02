import { describe, expect, it } from 'vitest'
import type { ThreadSummary } from '../../src/shared/forum'
import type { SubscriptionContext, SubscriptionObservation, SubscriptionOperation, SubscriptionOverview } from '../../src/shared/subscriptions'
import {
  blocksNewWrite,
  clearSuccessfulWriteOnLeave,
  collectionDisplay,
  collectionKey,
  collectionReducer,
  decideChange,
  activeFor,
  isReconcilable,
  isRunningChange,
  listedThreads,
  noticeAfterDismiss,
  threadMembership,
  unloadedCollection,
  type CollectionEvent,
  type CollectionState
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
  /** Both sources configured; the list shows App. */
  const both: SubscriptionOverview = { ...overview, context: context(2, '7', '3'), webSelection: { state: 'selected', credentialId: '3' } }
  const press = (overrides: Partial<Parameters<typeof decideChange>[0]> = {}) =>
    decideChange({
      overview,
      source: 'app',
      operations: [],
      busy: false,
      action: 'add',
      threadId: '1003',
      label: 'No.1003',
      unresolved: '待核对',
      ...overrides
    })

  it('is the write itself, for the given source and identity generation', () => {
    expect(press()).toEqual({
      kind: 'write',
      request: { source: 'app', threadId: '1003', action: 'add', expectedGeneration: 2, label: 'No.1003' }
    })
    expect(press({ action: 'remove' })).toEqual({
      kind: 'write',
      request: { source: 'app', threadId: '1003', action: 'remove', expectedGeneration: 2, label: 'No.1003' }
    })
  })

  it('targets the given source, not the one the list shows', () => {
    expect(press({ overview: both, source: 'web' })).toEqual({
      kind: 'write',
      request: { source: 'web', threadId: '1003', action: 'add', expectedGeneration: 2, label: 'No.1003' }
    })
    // Viewing the web list does not redirect an App press, nor does a configured App unblock web.
    expect(press({ overview: { ...both, source: 'web' }, source: 'app' })).toMatchObject({ kind: 'write', request: { source: 'app' } })
    expect(press({ source: 'web' })).toEqual({ kind: 'blocked', reason: '尚未绑定网页同步对象' })
  })

  it('keeps the existing reasons when it cannot write', () => {
    expect(press({ overview: { ...overview, appConfigured: false } })).toEqual({ kind: 'blocked', reason: '尚未设置 App 订阅 UUID' })
    expect(press({ overview: { ...overview, protection: 'unavailable' } })).toEqual({
      kind: 'blocked',
      reason: '系统凭据保护不可用，订阅身份暂时无法使用'
    })
    expect(press({ overview: { ...overview, writable: false } })).toEqual({ kind: 'blocked', reason: '本地存储不可写' })
    expect(press({ busy: true })).toEqual({ kind: 'blocked', reason: '另一项订阅操作正在进行' })
  })

  it('never writes over an unresolved earlier write of the same thread and source; only 核对 may follow', () => {
    expect(press({ operations: [unresolvedAppAdd(context(2, '7', null))] })).toEqual({ kind: 'blocked', reason: '待核对' })
    // Another App collection's unresolved entry does not block this one.
    expect(press({ operations: [unresolvedAppAdd(context(1, '6', null))] }).kind).toBe('write')
    // An unresolved App write does not block the same thread's web write.
    expect(press({ overview: both, source: 'web', operations: [unresolvedAppAdd(context(2, '7', '3'))] }).kind).toBe('write')
  })
})

describe('a dismissed unresolved write', () => {
  const dismissed: SubscriptionOperation = { ...unresolvedAppAdd(context(2, '7', null)), dismissedAt: '2026-10-30T00:00:00.000Z' }

  it('no longer blocks a new explicit write nor offers 核对', () => {
    expect(blocksNewWrite(dismissed, { source: 'app', objectRef: '7', threadId: '1003' })).toBe(false)
    expect(isReconcilable(dismissed, null)).toBe(false)
    expect(isReconcilable({ ...dismissed, state: 'pending', report: 'pending' }, null)).toBe(false)
  })
})

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

const web = context(2, '7', '3')
const webKey = collectionKey('web', web)

/** An observation of the web collection: `pages` lists the ids of each page read, in order; `end` adds the valid empty end page. */
const observation = (
  id: string,
  startedAt: string,
  pages: string[][],
  { end = false, error = null, cancelled = false }: { end?: boolean; error?: SubscriptionObservation['error']; cancelled?: boolean } = {}
): SubscriptionObservation => {
  const read = [...pages, ...(end ? [[]] : [])].map((ids, index) => ({
    page: index + 1,
    threads: ids.map(thread),
    fetchedAt: startedAt,
    endCandidate: ids.length === 0
  }))
  return {
    id,
    source: 'web',
    context: web,
    startedAt,
    pages: read,
    ids: [...new Set(pages.flat())],
    nextPage: end ? null : read.length + 1,
    error,
    cancelled
  }
}
const failedRead = { page: 1, detail: { kind: 'network' as const, detail: 'http-status' as const, httpStatus: 503 } }
const run = (...events: CollectionEvent[]) => events.reduce(collectionReducer, unloadedCollection)
const shownIds = (state: CollectionState) => collectionDisplay(state).observation?.ids ?? null

describe('a subscription collection list', () => {
  const old = observation('old', '2026-10-29T10:00:00.000Z', [['11'], ['22']], { end: true })

  it('keeps the whole earlier complete list while a new round has read only its first page', () => {
    const firstPage = observation('new', '2026-10-29T11:00:00.000Z', [['11']])
    const state = run({ type: 'local', snapshot: old, latest: old }, { type: 'start' }, { type: 'observed', observation: firstPage })
    expect(shownIds(state)).toEqual(['11', '22'])
    expect(collectionDisplay(state).complete).toBe(true)
    // The round reads to the end once: only then is the list replaced, including a removal elsewhere.
    const done = observation('new', '2026-10-29T11:00:00.000Z', [['11']], { end: true })
    const after = [{ type: 'observed', observation: done } as const, { type: 'end' } as const].reduce(collectionReducer, state)
    expect(shownIds(after)).toEqual(['11'])
  })

  it('keeps the complete list when the new round fails or stops, with the failed read as the latest', () => {
    const failed = observation('new', '2026-10-29T11:00:00.000Z', [['11']], { error: { ...failedRead, page: 2 } })
    const state = run({ type: 'local', snapshot: old, latest: old }, { type: 'start' }, { type: 'observed', observation: failed }, { type: 'end' })
    expect(shownIds(state)).toEqual(['11', '22'])
    expect(state.latest?.error?.page).toBe(2)
    const stopped = run({ type: 'local', snapshot: old, latest: old }, { type: 'observed', observation: { ...failed, error: null, cancelled: true } })
    expect(shownIds(stopped)).toEqual(['11', '22'])
  })

  it('shows the pages read so far, as not complete, when there is no complete list', () => {
    const state = run({ type: 'local', snapshot: null, latest: null }, { type: 'start' }, { type: 'observed', observation: observation('a', '2026-10-29T11:00:00.000Z', [['11']]) })
    expect(collectionDisplay(state)).toMatchObject({ complete: false, observation: { ids: ['11'] } })
    // A next read that failed before any page keeps what was shown.
    const failed = collectionReducer(state, { type: 'observed', observation: observation('b', '2026-10-29T11:05:00.000Z', [], { error: failedRead }) })
    expect(collectionDisplay(failed)).toMatchObject({ complete: false, observation: { ids: ['11'] } })
  })

  it('never takes a stored observation without a valid end page as a complete list', () => {
    // A historical "valid" record: no error, pages read, but never reached the end candidate.
    const partial = observation('p', '2026-10-29T10:00:00.000Z', [['11'], ['22']])
    const state = run({ type: 'local', snapshot: partial, latest: partial })
    expect(state.snapshot).toBeNull()
    expect(collectionDisplay(state).complete).toBe(false)
    // An empty observation without pages proves nothing either.
    expect(run({ type: 'local', snapshot: { ...partial, pages: [], ids: [], nextPage: null }, latest: null }).snapshot).toBeNull()
  })

  it('ends a stopped round as stopped, keeping what it read, apart from a failure or timeout', () => {
    const page = observation('new', '2026-10-29T11:00:00.000Z', [['11']])
    const stopped = run(
      { type: 'local', snapshot: null, latest: null },
      { type: 'start' },
      { type: 'observed', observation: page },
      { type: 'stop-requested' },
      { type: 'observed', observation: { ...page, cancelled: true } },
      { type: 'end' }
    )
    expect(stopped).toMatchObject({ reading: false, stopped: true, stopRequested: false, refusal: null })
    expect(collectionDisplay(stopped).observation?.ids).toEqual(['11'])
    // A timeout is a read error of its page, not a stop.
    const timeout = { page: 2, detail: { kind: 'network' as const, detail: 'timeout' as const } }
    const timedOut = run({ type: 'start' }, { type: 'observed', observation: { ...page, error: timeout } }, { type: 'end' })
    expect(timedOut).toMatchObject({ stopped: false, latest: { error: timeout } })
    // A stop asked when nothing reads changes nothing.
    expect(collectionReducer(unloadedCollection, { type: 'stop-requested' })).toBe(unloadedCollection)
  })

  it('never lets a late stored or journal copy of the running observation undo its progress or its stop', () => {
    const page1 = observation('x', '2026-10-29T11:00:00.000Z', [['11']])
    const page2 = observation('x', '2026-10-29T11:00:00.000Z', [['11'], ['22']])
    const progressed = run({ type: 'start' }, { type: 'observed', observation: page1 }, { type: 'observed', observation: page2 })
    // A delayed local read or journal copy of the same observation with fewer pages changes nothing.
    expect(collectionReducer(progressed, { type: 'local', snapshot: null, latest: page1 }).latest).toBe(page2)
    expect(collectionReducer(progressed, { type: 'evidence', observation: page1 })).toBe(progressed)
    // The running read was stopped or failed on page 3: a copy with as many pages read cleanly does not clear that.
    const cancelled = { ...page2, cancelled: true }
    const failed = { ...page2, error: { ...failedRead, page: 3 } }
    for (const ended of [cancelled, failed]) {
      const state = collectionReducer(progressed, { type: 'observed', observation: ended })
      expect(state.latest).toBe(ended)
      expect(collectionReducer(state, { type: 'local', snapshot: null, latest: page2 }).latest).toBe(ended)
      expect(collectionReducer(state, { type: 'evidence', observation: page2 }).latest).toBe(ended)
      // Retrying in this window at the same page count applies.
      expect(collectionReducer(state, { type: 'observed', observation: page2 }).latest).toBe(page2)
    }
    // A different observation started later still replaces it.
    const later = observation('y', '2026-10-29T12:00:00.000Z', [['33']])
    expect(collectionReducer(progressed, { type: 'evidence', observation: later }).latest).toBe(later)
  })

  it('keeps a round already observed over a slower local read', () => {
    const fresh = observation('new', '2026-10-29T11:00:00.000Z', [['11']], { end: true })
    const state = [
      { type: 'observed', observation: fresh } as const,
      { type: 'local', snapshot: old, latest: old } as const
    ].reduce(collectionReducer, unloadedCollection)
    expect(state.latest).toBe(fresh)
    expect(shownIds(state)).toEqual(['11'])
  })

  it('applies confirmed writes made after the list was read, from their own readback only', () => {
    const added: SubscriptionOperation = {
      ...unresolvedAppAdd(web),
      id: 'add',
      source: 'web',
      threadId: '33',
      createdAt: '2026-10-29T12:00:00.000Z',
      state: 'settled',
      report: 'success',
      verification: 'present',
      after: observation('rb', '2026-10-29T12:00:01.000Z', [['33', '11']])
    }
    const removed: SubscriptionOperation = { ...added, id: 'remove', threadId: '22', action: 'remove', verification: 'absent-supported', after: null }
    expect(listedThreads(old, [added, removed], webKey).map((item) => item.head.id)).toEqual(['33', '11'])
    // Writes older than the list, of another collection, or unresolved change nothing.
    expect(listedThreads(old, [{ ...added, createdAt: '2026-10-29T09:00:00.000Z' }], webKey).map((item) => item.head.id)).toEqual(['11', '22'])
    expect(listedThreads(old, [added], collectionKey('web', context(3, '7', '3'))).map((item) => item.head.id)).toEqual(['11', '22'])
    expect(listedThreads(old, [{ ...added, state: 'needs-reconciliation' }], webKey).map((item) => item.head.id)).toEqual(['11', '22'])
  })
})

describe('a thread toolbar source state', () => {
  const webAdd = (patch: Partial<SubscriptionOperation>): SubscriptionOperation => ({
    ...unresolvedAppAdd(web),
    source: 'web',
    createdAt: '2026-10-29T10:00:00.000Z',
    ...patch
  })
  const loaded = (latest: SubscriptionObservation | null, snapshot: SubscriptionObservation | null = null) =>
    run({ type: 'local', snapshot, latest })
  const complete = (startedAt: string, ids: string[]) => observation('c', startedAt, ids.length === 0 ? [] : [ids], { end: true })

  it('keeps an unresolved write on 核对 whatever was read later', () => {
    const unsettled = webAdd({ state: 'needs-reconciliation', report: 'unknown', verification: 'unknown' })
    expect(threadMembership('1003', loaded(observation('f', '2026-10-29T10:00:01.000Z', [], { error: failedRead })), [unsettled], null)).toEqual({
      kind: 'unknown',
      operation: unsettled
    })
    // A later complete read does not settle it either: only the read-only 核对 does.
    expect(threadMembership('1003', loaded(complete('2026-10-29T10:00:02.000Z', [])), [unsettled], null).kind).toBe('unknown')
  })

  it('takes the newest evidence of a confirmed write and a list read', () => {
    const added = webAdd({ state: 'settled', report: 'success', verification: 'present' })
    expect(threadMembership('1003', loaded(observation('f', '2026-10-29T10:00:01.000Z', [], { error: failedRead })), [added], null)).toMatchObject({ kind: 'in' })
    expect(threadMembership('1003', loaded(complete('2026-10-29T10:00:01.000Z', [])), [added], null)).toMatchObject({ kind: 'out' })
    // A newer confirmed write ends an older unresolved one.
    const older = webAdd({ createdAt: '2026-10-29T09:00:00.000Z', state: 'settled', verification: 'unknown' })
    expect(threadMembership('1003', loaded(null), [added, older], null)).toMatchObject({ kind: 'in' })
  })

  it('gives a dismissed entry no say either way', () => {
    const dismissed = webAdd({ state: 'needs-reconciliation', report: 'unknown', verification: 'unknown', dismissedAt: '2026-10-30T00:00:00.000Z' })
    expect(threadMembership('1003', loaded(null), [dismissed], null)).toEqual({ kind: 'unread', failed: false })
    expect(threadMembership('1003', loaded(complete('2026-10-29T10:00:01.000Z', ['1003'])), [dismissed], null)).toMatchObject({ kind: 'in' })
  })

  it('is unknown, never not subscribed, without a complete read or a read that listed the thread', () => {
    // No list at all, a read stopped or failed before reaching the thread, or a partial read without it.
    expect(threadMembership('1003', loaded(null), [], null)).toEqual({ kind: 'unread', failed: false })
    expect(threadMembership('1003', loaded(observation('s', '2026-10-29T10:00:01.000Z', [], { cancelled: true })), [], null)).toEqual({
      kind: 'unread',
      failed: false
    })
    expect(threadMembership('1003', loaded(observation('f', '2026-10-29T10:00:01.000Z', [], { error: failedRead })), [], null)).toEqual({
      kind: 'unread',
      failed: true
    })
    expect(threadMembership('1003', loaded(observation('p', '2026-10-29T10:00:01.000Z', [['1']])), [], null).kind).toBe('unread')
    // A page that was read still shows the thread; a complete read without it is the only "not subscribed".
    expect(threadMembership('1003', loaded(observation('p', '2026-10-29T10:00:01.000Z', [['1003']], { cancelled: true })), [], null)).toMatchObject({ kind: 'in' })
    expect(threadMembership('1003', loaded(complete('2026-10-29T10:00:01.000Z', ['1'])), [], null)).toEqual({
      kind: 'out',
      at: '2026-10-29T10:00:01.000Z'
    })
    // Still loading or reading with no evidence yet.
    expect(threadMembership('1003', null, [], null).kind).toBe('loading')
    expect(threadMembership('1003', run({ type: 'local', snapshot: null, latest: null }, { type: 'start' }), [], null).kind).toBe('loading')
  })

  it('keeps a thread an earlier partial read listed when a newer read stopped or failed before any page', () => {
    const partial = observation('p', '2026-10-29T09:00:00.000Z', [['1003']])
    const stopped = observation('s', '2026-10-29T10:00:00.000Z', [], { cancelled: true })
    const failed = observation('f', '2026-10-29T10:00:00.000Z', [], { error: failedRead })
    for (const newer of [stopped, failed]) {
      const state = run({ type: 'local', snapshot: null, latest: partial }, { type: 'start' }, { type: 'observed', observation: newer }, { type: 'end' })
      expect(threadMembership('1003', state, [], null)).toEqual({ kind: 'in', at: '2026-10-29T09:00:00.000Z' })
    }
  })

  it('keeps a write readback as evidence of its collection after the entry is dismissed, whatever its report', () => {
    const snapshot = complete('2026-10-29T09:00:00.000Z', ['1003'])
    // An add whose report is unknown and whose complete readback did not find the thread (mismatch).
    const absent = complete('2026-10-29T10:00:00.000Z', ['1'])
    const mismatch = webAdd({ state: 'needs-reconciliation', report: 'unknown', verification: 'mismatch', after: absent })
    const dismissed = { ...mismatch, dismissedAt: '2026-10-30T00:00:00.000Z' }
    const withReadback = collectionReducer(loaded(snapshot, snapshot), { type: 'evidence', observation: absent })
    expect(threadMembership('1003', withReadback, [mismatch], null).kind).toBe('unknown')
    expect(threadMembership('1003', withReadback, [dismissed], null)).toEqual({ kind: 'out', at: '2026-10-29T10:00:00.000Z' })
    // A readback that stopped once it saw the thread is presence, newer than an older list without it.
    const present = observation('rb', '2026-10-29T10:00:00.000Z', [['1003']])
    const withPresence = collectionReducer(loaded(complete('2026-10-29T09:00:00.000Z', ['1'])), { type: 'evidence', observation: present })
    expect(threadMembership('1003', withPresence, [{ ...dismissed, after: present }], null)).toEqual({ kind: 'in', at: '2026-10-29T10:00:00.000Z' })
    // Dismissal alone proves nothing: without any read the thread stays unknown.
    expect(threadMembership('1003', loaded(null), [dismissed], null)).toEqual({ kind: 'unread', failed: false })
  })

  it('never lets an older readback replace a newer list read, and still loads storage for a collection known only from the journal', () => {
    const newer = complete('2026-10-29T11:00:00.000Z', ['1003'])
    const state = collectionReducer(loaded(newer, newer), { type: 'evidence', observation: complete('2026-10-29T10:00:00.000Z', ['1']) })
    expect(state.latest).toBe(newer)
    expect(state.snapshot).toBe(newer)
    // Journal evidence first: the collection is not loaded yet, and the stored list read later still lands.
    const fromJournal = collectionReducer(unloadedCollection, { type: 'evidence', observation: observation('rb', '2026-10-29T10:00:00.000Z', [['1003']]) })
    expect(fromJournal.local).toBe('idle')
    const stored = collectionReducer(fromJournal, { type: 'local', snapshot: newer, latest: newer })
    expect(stored).toMatchObject({ local: 'loaded', snapshot: newer, latest: newer })
  })

  it('keeps an earlier complete list as dated evidence when a newer read was cancelled', () => {
    const snapshot = complete('2026-10-29T09:00:00.000Z', ['1003'])
    const cancelled = observation('s', '2026-10-29T10:00:00.000Z', [], { cancelled: true })
    expect(threadMembership('1003', loaded(cancelled, snapshot), [], null)).toEqual({ kind: 'in', at: '2026-10-29T09:00:00.000Z' })
  })
})

describe('the running write or 核对 shown for a thread', () => {
  const write = { kind: 'change' as const, source: 'app' as const, threadId: '1003', action: 'add' as const, generation: 2 }

  it('belongs only to the same source, thread and identity generation', () => {
    expect(activeFor(write, { source: 'app', threadId: '1003', generation: 2 })).toBe(true)
    expect(activeFor({ ...write, kind: 'reconcile' }, { source: 'app', threadId: '1003', generation: 2 })).toBe(true)
    // After a UUID or binding change the frozen write is another collection's; App and 网页 never share one.
    expect(activeFor(write, { source: 'app', threadId: '1003', generation: 3 })).toBe(false)
    expect(activeFor(write, { source: 'web', threadId: '1003', generation: 2 })).toBe(false)
    expect(activeFor(write, { source: 'app', threadId: '1004', generation: 2 })).toBe(false)
    expect(activeFor(null, { source: 'app', threadId: '1003', generation: 2 })).toBe(false)
  })
})

describe('the last result line after a dismissal', () => {
  const closed: SubscriptionOperation = { ...unresolvedAppAdd(context(1, '6', null)), id: 'old' }
  const write = { kind: 'change' as const, operationId: 'w', source: 'app' as const, threadId: '1003', action: 'add' as const, generation: 1, label: '', stopRequested: false }

  it('goes only with the dismissed entry itself or its own orphan intent', () => {
    const own: WriteNotice = { write, outcome: { type: 'done', operation: closed } }
    expect(noticeAfterDismiss(own, closed)).toBeNull()
    expect(noticeAfterDismiss({ write, outcome: { type: 'failed' } }, closed)).toBeNull()
    expect(noticeAfterDismiss({ write, outcome: { type: 'refused', reason: 'result-storage' } }, closed)).toBeNull()
  })

  it('keeps a newer result of the same thread for another object or entry', () => {
    // A 核对 of the current UUID's entry for the same thread, after an older UUID's entry was closed.
    const current = { ...unresolvedAppAdd(context(2, '7', null)), id: 'new' }
    const reconciled: WriteNotice = { write: { ...write, kind: 'reconcile', generation: 2 }, outcome: { type: 'done', operation: current } }
    expect(noticeAfterDismiss(reconciled, closed)).toBe(reconciled)
    const otherGeneration: WriteNotice = { write: { ...write, generation: 2 }, outcome: { type: 'failed' } }
    expect(noticeAfterDismiss(otherGeneration, closed)).toBe(otherGeneration)
    const refused: WriteNotice = { write, outcome: { type: 'refused', reason: 'busy' } }
    expect(noticeAfterDismiss(refused, closed)).toBe(refused)
  })
})
