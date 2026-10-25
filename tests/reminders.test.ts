import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { Post, ReadingMode, ThreadPage } from '../src/shared/forum'
import type { ReminderKind } from '../src/shared/reminders'
import { ForumReadError, ReadCancelledError } from '../src/main/forum/contract'
import { createReminderService } from '../src/main/reminders/service'
import { createReminderNotifier } from '../src/main/reminders/notifier'
import { createRequestScheduler } from '../src/main/reading/scheduler'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { asStore } from './helpers/store'

const t0 = '2026-10-24T00:00:00.000Z'
const start = '2026-10-24T00:01:00.000Z'
const t2 = '2026-10-24T00:02:00.000Z'
const t3 = '2026-10-24T00:03:00.000Z'
const later = '2026-10-24T00:04:00.000Z'
const folders: string[] = []
const databases: ReadingDatabase[] = []
function post(id: string, quotes: string[] = []): Post {
  return { id, forumId: '4', createdAt: '2026-10-24 08:03', userHash: 'public-not-an-identity', name: null,
    title: null, isAdmin: false, isSage: false, image: null,
    content: [{ type: 'text', text: `正文 ${id}\n\n` }, ...quotes.map((postId) => ({ type: 'quoteRef' as const, postId, raw: `>>No.${postId}` }))],
    plainText: `正文 ${id}\n\n${quotes.map((id) => `>>No.${id}`).join(' ')}` }
}
function page(threadId: string, number: number, replies: Post[], count: number | null = replies.length, mode: ReadingMode = 'all'): ThreadPage {
  return { threadId, page: number, head: { ...post(threadId), title: `串 ${threadId}` }, replies, replyCount: count,
    mode, skippedItems: 0, endCandidate: replies.length === 0 }
}
function proof(db: ReadingDatabase): void {
  db.saveThreadPage(page('1', 1, [post('102')]), t2)
  db.saveThreadPage(page('1', 2, []), t2)
  db.saveThreadPage(page('1', 1, [post('102'), post('103')]), t3)
  expect(db.firstProvenNewPost(start)).toBe('103')
}
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-reminders-'))
  folders.push(folder)
  const path = join(folder, 'app.sqlite')
  const db = openReadingDatabase(path)
  databases.push(db)
  db.saveThreadPage(page('100', 1, [post('101')]), t0)
  let monotonic = 0
  let wall = start
  let read = async (threadId: string, mode: ReadingMode, number: number, _signal: AbortSignal) =>
    page(threadId, number, number === 1 ? [post('101'), post('200')] : [], 2, mode)
  const requests: Array<{ threadId: string; mode: ReadingMode; page: number; lane: string }> = []
  const notifications: Array<{ title: string; body: string }> = []
  let notify = (_message: { title: string; body: string }, settle: (state: 'shown' | 'failed') => void): boolean => { settle('shown'); return true }
  const scheduler = createRequestScheduler()
  const service = createReminderService({ store: asStore(db), now: () => wall, monotonicNow: () => monotonic,
    client: { async getThreadPage(threadId, mode, number, signal) {
      requests.push({ threadId, mode, page: number, lane: 'background' })
      return read(threadId, mode, number, signal)
    } },
    scheduler: { run(lane, signal, work) { expect(lane).toBe('background'); return scheduler.run(lane, signal, work) } },
    notifier: { show(message, settle) { notifications.push(message); return notify(message, settle) } } })
  return { db, path, service, requests, notifications,
    enable(kind: ReminderKind = 'all', threadId = '100') { return service.setRule({ threadId, kind, enabled: true }) },
    next() { monotonic += 60_000; wall = later },
    setClock(value: number, at = later) { monotonic = value; wall = at },
    setRead(value: typeof read) { read = value },
    setNotify(value: typeof notify) { notify = value },
    async run() { const result = await service.check(); expect(result.accepted).toBe(true); await service.whenIdle(); return result },
    raw<T>(sql: string): T[] {
      const connection = new Database(path, { readonly: true })
      try { return connection.prepare(sql).all() as T[] } finally { connection.close() }
    }
  }
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

describe('reminder rules and durable events', () => {
  it('does not store a capped tail as new content or an end observation', async () => {
    const s = fixture()
    s.db.saveThreadPage(page('100', 100, [post('9000'), post('9001')], 2194), t0)
    await s.enable()
    s.setRead(async (threadId, mode, number) => page(threadId, number, [post('9000'), post('9001')], 2194, mode))
    await s.run()
    expect(s.requests.map((request) => request.page)).toEqual([116])
    expect(s.db.loadThreadPage('100', 'all', 116)).toBeNull()
    expect(s.db.getThreadCoverage('100', 'all').endCandidatePage).toBeNull()
    expect(s.db.getReminderCoverage('100', 'all')).toMatchObject({ state: 'failed', lastError: { kind: 'page-cap', highestReadablePage: 100 } })
    expect(s.raw('SELECT * FROM reminder_events')).toEqual([])
    expect(s.notifications).toEqual([])
  })

  it('enables independent starts and generations, re-enables from a new watermark, and never moves a start on failure', async () => {
    const s = fixture()
    await s.enable('all')
    await s.enable('quote')
    expect(s.db.getReadingState('100').attention).toMatchObject({ startedAt: start, source: 'reminder', watermarkPostId: '101' })
    s.setRead(async () => { throw new ForumReadError({ kind: 'network', detail: 'connection' }) })
    await s.run()
    expect(s.db.getReminderRules(['100'])[0]?.rules.all.startedAt).toBe(start)
    await s.service.setRule({ threadId: '100', kind: 'all', enabled: false })
    s.db.saveThreadPage(page('100', 1, [post('250')]), later)
    s.setClock(60_000)
    await s.enable('all')
    expect(s.db.reminderRuleSnapshots()).toEqual(expect.arrayContaining([
      { threadId: '100', kind: 'all', generation: 3, startedAt: later, watermarkPostId: '250' },
      { threadId: '100', kind: 'quote', generation: 1, startedAt: start, watermarkPostId: '101' }
    ]))
    expect(s.db.getReadingState('100').attention?.startedAt).toBe(start)
    expect(s.requests).toHaveLength(1) // Neither toggling a rule nor re-enabling performs a check.
  })

  it('deduplicates all/PO/quote hits and never re-notifies a kind merged into an existing event', async () => {
    const s = fixture()
    for (const kind of ['all', 'po', 'quote'] as const) await s.enable(kind)
    proof(s.db)
    let poVisible = false
    s.setRead(async (threadId, mode, number) => page(threadId, number,
      number === 1 ? mode === 'po' && !poVisible ? [] : [post('200', ['90'])] : [], mode === 'po' && !poVisible ? 0 : 1, mode))
    await s.run()
    expect(s.db.reminderOverview().threads[0]?.events[0]?.kinds).toEqual(['all'])
    poVisible = true
    s.db.addManualOwnPost({ postId: '90', threadId: '80', isThread: false, at: later })
    s.next()
    await s.run()
    const overview = s.db.reminderOverview()
    expect(overview.threads[0]?.eventCount).toBe(1)
    expect(overview.threads[0]?.events[0]).toMatchObject({ postId: '200', kinds: ['all', 'po', 'quote'], quotedOwnIds: ['90'], read: false, excerpt: '正文 200 >>No.90' })
    expect(s.notifications).toHaveLength(1)
    expect(s.raw<{ notification_id: number }>('SELECT notification_id FROM reminder_events')[0]?.notification_id).toBe(1)
  })

  it('drops a kind disabled mid-round in the event transaction while another kind still hits', async () => {
    const s = fixture()
    await s.enable('all')
    await s.enable('quote')
    proof(s.db)
    s.db.addManualOwnPost({ postId: '90', threadId: '80', isThread: false, at: t3 })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    s.setRead(async (threadId, mode, number) => {
      if (number === 1) { entered.resolve(); await release.promise }
      return page(threadId, number, number === 1 ? [post('200', ['90'])] : [], 1, mode)
    })
    expect((await s.service.check()).accepted).toBe(true)
    await entered.promise
    await s.service.setRule({ threadId: '100', kind: 'quote', enabled: false })
    release.resolve()
    await s.service.whenIdle()
    expect(s.db.reminderOverview().threads[0]?.events[0]?.kinds).toEqual(['all'])
    expect(s.notifications).toHaveLength(1)
  })

  it('does not notify a result when all matching rules were closed after a page was requested', async () => {
    const s = fixture()
    await s.enable()
    proof(s.db)
    s.setRead(async (threadId, mode, number) => {
      await s.service.closeForThreads({ threadIds: ['100'], reason: 'unsubscribe' })
      return page(threadId, number, number === 1 ? [post('200')] : [], 1, mode)
    })
    await s.run()
    expect(s.raw('SELECT * FROM reminder_events')).toEqual([])
    expect(s.notifications).toEqual([])
    expect(s.db.getReminderRules(['100'])[0]?.rules.all).toMatchObject({ enabled: false, closedBy: 'unsubscribe' })
  })

  it.each(['shown', 'failed', 'unavailable'] as const)('registers before the notifier and keeps events when notification is %s', async (outcome) => {
    const s = fixture()
    await s.enable()
    proof(s.db)
    s.setNotify((_message, settle) => {
      expect(s.raw<{ state: string }>('SELECT state FROM reminder_notifications')).toEqual([{ state: 'registered' }])
      expect(s.raw<{ notification_id: number }>('SELECT notification_id FROM reminder_events')).toEqual([{ notification_id: 1 }])
      if (outcome === 'failed') throw new Error('desktop service unavailable')
      if (outcome === 'shown') settle('shown') // the system's own show signal
      return outcome === 'shown'
    })
    await s.run()
    await nextTask()
    expect(s.db.reminderOverview().lastNotification?.state).toBe(outcome)
    expect(s.db.reminderOverview().totalUnread).toBe(1)
    expect(s.db.getReadingState('100').readPostIds).toEqual([])
    s.next()
    await s.run()
    expect(s.notifications).toHaveLength(1)
  })

  it('recovers registered notification as unknown and a running round as interrupted without resending', async () => {
    const s = fixture()
    await s.enable()
    proof(s.db)
    s.db.saveThreadPage(page('100', 1, [post('200')]), later)
    const round = s.db.createReminderRound('manual', later, 1)
    s.db.evaluateReminders({ roundId: round.id, threadId: '100', mode: 'all', rules: s.db.reminderRuleSnapshots(), target: '200', at: later })
    s.db.registerReminderNotification(round.id, 'partial', later)
    s.db.close()
    const reopened = openReadingDatabase(s.path)
    databases.push(reopened)
    const notices: unknown[] = []
    const service = createReminderService({ store: asStore(reopened), now: () => later,
      client: { async getThreadPage(threadId, mode, number) { return page(threadId, number, number === 1 ? [post('200')] : [], 1, mode) } },
      scheduler: createRequestScheduler(), notifier: { show(message) { notices.push(message); return true } } })
    await service.recover()
    expect(reopened.reminderOverview().lastRound).toMatchObject({ state: 'interrupted', stopReason: 'crash' })
    expect(reopened.reminderOverview().lastNotification?.state).toBe('unknown')
    await service.check()
    await service.whenIdle()
    expect(notices).toEqual([])
    expect(reopened.reminderOverview().lastNotification?.state).toBe('unknown')
  })

  it('re-evaluates retained replies after manually adding an own ID, excludes pre-start replies and never duplicates', async () => {
    const s = fixture()
    s.db.saveThreadPage(page('100', 1, [post('101', ['90'])], 57), t0)
    await s.enable('quote')
    proof(s.db)
    s.setRead(async (threadId, mode, number) => page(threadId, number,
      number === 1 ? [post('101', ['90'])] : number === 2 ? [post('200', ['90'])] : number === 3 ? [post('201', ['90'])] : [], 57, mode))
    await s.run()
    expect(s.notifications).toEqual([])
    s.db.addManualOwnPost({ postId: '90', threadId: '80', isThread: false, at: later })
    const requestCount = s.requests.length
    expect(s.notifications).toEqual([])
    s.next()
    await s.run()
    expect(s.db.reminderOverview().threads[0]?.events.map((event) => event.postId)).toEqual(['201', '200'])
    expect(s.requests.slice(requestCount).map((request) => request.page)).not.toContain(1) // Page 1 retained content was reused.
    expect(s.notifications).toHaveLength(1)
    s.next()
    await s.run()
    expect(s.db.reminderOverview().threads[0]?.eventCount).toBe(2)
    expect(s.notifications).toHaveLength(1)
  })

  it('fetches only missing retained quote content after the own-ID set changes', async () => {
    const s = fixture()
    s.db.saveThreadPage(page('100', 1, [post('101')], 57), t0)
    await s.enable('quote')
    proof(s.db)
    s.setRead(async (threadId, mode, number) => page(threadId, number, number === 1 ? [post('101'), post('200', ['90'])]
      : number === 2 ? [post('201')] : number === 3 ? [post('202')] : [], 57, mode))
    await s.run()
    const connection = new Database(s.path)
    try { connection.prepare('DELETE FROM posts WHERE id = ?').run('200') } finally { connection.close() }
    s.db.addManualOwnPost({ postId: '90', threadId: '80', isThread: false, at: later })
    const before = s.requests.length
    s.next()
    await s.run()
    expect(s.requests.slice(before).map((request) => request.page)).toEqual([3, 4, 2, 1])
    expect(s.db.reminderOverview().threads[0]?.events.map((event) => event.postId)).toEqual(['200'])
    expect(s.notifications).toHaveLength(1)
  })

  it('closes only enabled kinds of the selected threads and records the local sync-delete decision', async () => {
    const s = fixture()
    await s.enable('all', '100')
    await s.enable('quote', '100')
    await s.enable('all', '200')
    expect(await s.service.closeForThreads({ threadIds: ['100', '100', '300'], reason: 'sync-delete' }))
      .toEqual({ ok: true, closed: ['100'] })
    const rules = s.db.getReminderRules(['100', '200'])
    expect(rules[0]?.rules.all).toMatchObject({ enabled: false, startedAt: start, closedBy: 'sync-delete' })
    expect(rules[0]?.rules.quote).toMatchObject({ enabled: false, startedAt: start, closedBy: 'sync-delete' })
    expect(rules[1]?.rules.all.enabled).toBe(true)
    expect(s.requests).toEqual([])
  })

  it('leaves starts, checkpoints, events and notification records intact when history and read state are cleared', async () => {
    const s = fixture()
    await s.enable()
    proof(s.db)
    await s.run()
    s.db.recordVisit('100', later)
    s.db.markPostsRead('100', ['200'], later)
    const rules = s.db.reminderRuleSnapshots()
    const coverage = s.db.getReminderCoverage('100', 'all')
    const events = s.raw('SELECT * FROM reminder_events')
    const notifications = s.raw('SELECT * FROM reminder_notifications')
    expect(s.db.reminderOverview().totalUnread).toBe(0)
    s.db.clearHistory('100', true)
    expect(s.db.reminderRuleSnapshots()).toEqual(rules)
    expect(s.db.getReminderCoverage('100', 'all')).toEqual(coverage)
    expect(s.raw('SELECT * FROM reminder_events')).toEqual(events)
    expect(s.raw('SELECT * FROM reminder_notifications')).toEqual(notifications)
    expect(s.db.reminderOverview().totalUnread).toBe(1)
    const usage = s.db.getContentUsage()
    expect(usage.personalDataBytes).toBeGreaterThan(0)
    for (let count = 0; count < 100; count++) if (!s.db.evictContentBatch(true).more) break
    expect(s.db.reminderOverview().threads[0]?.events[0]?.excerpt).toBe('正文 200')
    s.next()
    await s.run()
    expect(s.notifications).toHaveLength(1)
  })
})

describe('effective triggers and bounded catch-up', () => {
  it('shares single-flight and monotonic 60-second cooldown across launch/reopen/manual with no queued check', async () => {
    const s = fixture()
    await s.enable()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    s.setRead(async (threadId, mode, number) => {
      entered.resolve()
      await release.promise
      return page(threadId, number, [], 0, mode)
    })
    expect((await s.service.request('cold-start')).accepted).toBe(true)
    await entered.promise
    s.setClock(60_000, '2026-10-23T00:00:00.000Z') // Wall clock does not affect the running guard.
    expect(await s.service.request('reopen')).toEqual({ accepted: false, reason: 'running', retryAfterMs: 0 })
    release.resolve()
    await s.service.whenIdle()
    const total = s.raw('SELECT * FROM reminder_rounds').length
    s.setClock(59_999, '2030-01-01T00:00:00.000Z')
    expect(await s.service.check()).toEqual({ accepted: false, reason: 'cooldown', retryAfterMs: 1 })
    expect(s.raw('SELECT * FROM reminder_rounds')).toHaveLength(total)
    s.setClock(60_000)
    expect((await s.service.request('reopen')).accepted).toBe(true)
    await s.service.whenIdle()
    expect(s.raw('SELECT * FROM reminder_rounds')).toHaveLength(total + 1)
  })

  it.each(['forward', 'backward'] as const)('bounds %s probing to two offsets and continues from the saved position next trigger', async (direction) => {
    const s = fixture()
    s.db.saveThreadPage(page('100', 1, [post('101')], 1900), t0)
    await s.enable()
    s.setRead(async (threadId, mode, number) => page(threadId, number, direction === 'forward' ? [post(String(1000 + number))] : [], 1900, mode))
    await s.run()
    expect(s.requests.map((request) => request.page)).toEqual(direction === 'forward' ? [100, 101, 102] : [100, 99, 98])
    const saved = s.db.getReminderCoverage('100', 'all')
    expect(saved.issues).toContain('target-unverified')
    expect(saved.probe).toEqual({ page: direction === 'forward' ? 103 : 97, direction })
    const fetched = s.requests.length
    s.next()
    await s.run()
    expect(s.requests[fetched]?.page).toBe(saved.probe!.page)
    expect(s.requests.length - fetched).toBe(3)
    expect(s.db.reminderOverview().lastRound?.threadsDone).toBe(0)
  })

  it('re-anchors the tail probe on a fresher ReplyCount so a thread that grew is reached in one trigger', async () => {
    const s = fixture()
    await s.enable()
    let total = 30
    s.setRead(async (threadId, mode, number) => {
      const replies = Array.from({ length: total }, (_, index) => post(String(1000 + index)))
      return page(threadId, number, replies.slice((number - 1) * 19, number * 19), total, mode)
    })
    await s.run()
    expect(s.db.getReminderCoverage('100', 'all').checkpoint).toMatchObject({ page: 2, complete: true })
    total = 150
    s.next()
    await s.run()
    const coverage = s.db.getReminderCoverage('100', 'all')
    expect(coverage.issues).not.toContain('target-unverified')
    expect(coverage.checkpoint).toMatchObject({ page: 8, complete: true })
  })

  it('rotates threads after at most five page fetches and automatically continues batches within the same trigger', async () => {
    const s = fixture()
    s.db.saveThreadPage(page('100', 1, [post('101')], 152), t0)
    await s.enable('all', '100')
    await s.enable('all', '200')
    proof(s.db)
    s.setRead(async (threadId, mode, number) => page(threadId, number, number <= 8
      ? Array.from({ length: 19 }, (_, index) => post(String((threadId === '100' ? 1000 : 10000) + number * 19 + index))) : [], 152, mode))
    await s.run()
    const sequence = s.requests.map((request) => request.threadId)
    expect(sequence.length).toBeGreaterThan(10)
    expect(sequence.slice(0, 5)).toEqual(Array(5).fill('100'))
    expect(sequence[5]).toBe('200')
    let consecutive = 0
    let previous = ''
    for (const threadId of sequence) {
      consecutive = threadId === previous ? consecutive + 1 : 1
      previous = threadId
      expect(consecutive).toBeLessThanOrEqual(5)
    }
    expect(s.db.reminderOverview().lastRound).toMatchObject({ state: 'finished', threadsTotal: 2, threadsDone: 2, threadsFailed: 0, newEvents: 304 })
    expect(s.notifications).toHaveLength(1)
    expect(s.notifications[0]?.body).toBe('2 个串有 304 条新提醒')
  })

  it('re-verifies an unchanged checkpoint, falls back to page 1 on a changed sequence, and excludes replies above the frozen target', async () => {
    const s = fixture()
    s.db.saveThreadPage(page('100', 1, [post('101')], 57), t0)
    await s.enable()
    proof(s.db)
    let variant: 'initial' | 'unchanged' | 'shifted' = 'initial'
    let shiftedTailReads = 0
    s.setRead(async (threadId, mode, number) => {
      const values = number === 1 ? [post('101'), post('200')] : number === 2 ? variant === 'shifted' ? [post('250'), post('260')] : [post('201')]
        : number === 3 ? [post('300'), ...(variant === 'shifted' && ++shiftedTailReads > 1 ? [post('999')] : [])] : []
      return page(threadId, number, values, 57, mode)
    })
    await s.run()
    const before = s.requests.length
    variant = 'unchanged'
    s.next()
    await s.run()
    expect(s.requests.slice(before).map((request) => request.page)).not.toContain(1)
    variant = 'shifted'
    const shiftedAt = s.requests.length
    s.next()
    await s.run()
    expect(s.requests.slice(shiftedAt).map((request) => request.page)).toContain(1)
    expect(s.db.getReminderCoverage('100', 'all').issues).toContain('shifted')
    expect(s.db.reminderOverview().threads[0]?.events.map((event) => event.postId)).not.toContain('999')
  })

  it('isolates one thread failure, stops the whole round on rate-limit and preserves checkpoints on cancel', async () => {
    const s = fixture()
    await s.enable('all', '100')
    await s.enable('all', '200')
    proof(s.db)
    s.setRead(async (threadId, mode, number) => {
      if (threadId === '100') throw new ForumReadError({ kind: 'not-found', detail: 'business' })
      return page(threadId, number, number === 1 ? [post('300')] : [], 1, mode)
    })
    await s.run()
    expect(s.db.reminderOverview().lastRound).toMatchObject({ state: 'finished', threadsDone: 1, threadsFailed: 1 })
    expect(s.notifications[0]?.body).toContain('部分串检查失败，数量不是全部新增')
    s.next()
    s.setRead(async () => { throw new ForumReadError({ kind: 'rate-limited', detail: 'http-status', httpStatus: 429 }) })
    const before = s.requests.length
    await s.run()
    expect(s.requests.length - before).toBe(1)
    expect(s.db.reminderOverview().lastRound).toMatchObject({ state: 'interrupted', stopReason: 'rate-limited' })
    s.next()
    const entered = Promise.withResolvers<void>()
    s.setRead(async (_threadId, _mode, _number, signal) => {
      entered.resolve()
      const { promise, reject } = Promise.withResolvers<ThreadPage>()
      signal.addEventListener('abort', () => reject(new ReadCancelledError()), { once: true })
      return promise
    })
    expect((await s.service.check()).accepted).toBe(true)
    await entered.promise
    const checkpoint = s.db.getReminderCoverage('200', 'all').checkpoint
    await s.service.cancel()
    expect(s.db.reminderOverview().lastRound).toMatchObject({ state: 'cancelled', stopReason: 'user' })
    expect(s.db.getReminderCoverage('200', 'all').checkpoint).toEqual(checkpoint)
  })

  it('persists confirmed events and an interrupted round before quit resolves', async () => {
    const s = fixture()
    s.db.saveThreadPage(page('100', 1, [post('101')], 152), t0)
    await s.enable()
    proof(s.db)
    const entered = Promise.withResolvers<void>()
    s.setRead(async (threadId, mode, number, signal) => {
      if (number === 4) {
        entered.resolve()
        const { promise, reject } = Promise.withResolvers<ThreadPage>()
        signal.addEventListener('abort', () => reject(new ReadCancelledError()), { once: true })
        return promise
      }
      return page(threadId, number, number <= 8 ? [post(String(200 + number))] : [], 152, mode)
    })
    expect((await s.service.check()).accepted).toBe(true)
    await entered.promise
    await s.service.stop('quit')
    expect(s.db.reminderOverview().lastRound).toMatchObject({ state: 'interrupted', stopReason: 'quit' })
    expect(s.db.getReminderCoverage('100', 'all')).toMatchObject({ state: 'incomplete', checkpoint: { page: 3, complete: false } })
    expect(s.db.reminderOverview().threads[0]?.eventCount).toBeGreaterThan(0)
    expect(s.notifications).toHaveLength(1)
    expect(s.notifications[0]?.body).toContain('本轮检查未完成，仅含已确认的命中')
  })

  it('keeps unproven boundaries out of events and reports uncertainty separately without marking read', async () => {
    const s = fixture()
    await s.enable('all')
    await s.enable('po')
    await s.run()
    const group = s.db.reminderOverview().threads[0]!
    // The first check observed the thread's end after the start (baseline), but one reply cannot be
    // proven newer than the start: coverage is uncertain, not "waiting for a baseline".
    expect(group).toMatchObject({ state: 'uncertain', eventCount: 0, unreadCount: 0, uncertainCount: 1 })
    expect(group.issues).toContain('boundary-uncertain')
    expect(s.notifications).toEqual([])
    expect(s.db.getReadingState('100').readPostIds).toEqual([])
  })
})

describe('system notification adapter', () => {
  it('handles unsupported systems without creating notifications and lets show failures reach the attempt recorder', () => {
    const unsupported = createReminderNotifier({ isSupported: () => false,
      create() { throw new Error('must not create') }, async openList() { throw new Error('must not open') } })
    expect(unsupported.show({ title: '汐岛提醒', body: '1 个串有 1 条新提醒' }, () => { throw new Error('must not settle') })).toBe(false)
    const broken = createReminderNotifier({ isSupported: () => true,
      create: () => ({ on() {}, show() { throw new Error('desktop failure') } }), async openList() {} })
    expect(() => broken.show({ title: '汐岛提醒', body: '1 个串有 1 条新提醒' }, () => {})).toThrow('desktop failure')
  })

  it('reports only the system show/failed signal, once, and opens the list only on click', async () => {
    const listeners = new Map<string, () => void>()
    let opens = 0
    const settled: string[] = []
    const notifier = createReminderNotifier({ isSupported: () => true,
      create: () => ({ on(event, listener) { listeners.set(event, listener) }, show() {} }),
      async openList() { opens++ } })
    expect(notifier.show({ title: '汐岛提醒', body: '1 个串有 1 条新提醒' }, (state) => settled.push(state))).toBe(true)
    expect(settled).toEqual([])
    listeners.get('show')?.()
    listeners.get('failed')?.()
    expect(settled).toEqual(['shown'])
    expect(opens).toBe(0)
    listeners.get('click')?.()
    await Promise.resolve()
    expect(opens).toBe(1)
  })
})

/** Lets queued storage writes started by a notification signal settle. */
function nextTask(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  return promise
}

describe('review regressions', () => {
  it('records a notification as failed when the system reports failure after show() returned, and shown only on the show signal', async () => {
    const s = fixture()
    await s.enable('all')
    proof(s.db)
    s.setRead(async (threadId, mode, number) => page(threadId, number, number === 1 ? [post('101'), post('200')] : [], 2, mode))
    let signal: ((state: 'shown' | 'failed') => void) | undefined
    s.setNotify((_message, settle) => { signal = settle; return true })
    await s.run()
    expect(s.db.reminderOverview().lastNotification?.state).toBe('registered')
    signal?.('failed')
    await nextTask()
    expect(s.db.reminderOverview().lastNotification?.state).toBe('failed')
    signal?.('shown')
    await nextTask()
    expect(s.db.reminderOverview().lastNotification?.state).toBe('failed')
    expect(s.db.reminderOverview().threads[0]?.eventCount).toBe(1)
  })

  it('continues from the saved probe position even when ReplyCount now estimates farther', async () => {
    const s = fixture()
    s.db.saveThreadPage(page('100', 1, [post('101')], 1900), t0)
    await s.enable()
    s.setRead(async (threadId, mode, number) => page(threadId, number, [post(String(1000 + number))], 1900, mode))
    await s.run()
    expect(s.db.getReminderCoverage('100', 'all').probe).toEqual({ page: 103, direction: 'forward' })
    const fetched = s.requests.length
    s.setRead(async (threadId, mode, number) => page(threadId, number, [post(String(1000 + number))], 5700, mode))
    s.db.saveThreadPage(page('100', 1, [post('101')], 5700), t2)
    s.next()
    await s.run()
    expect(s.requests.slice(fetched).map((request) => request.page)).toEqual([103, 104, 105])
  })

  it('keeps reminders readable when a newer app version owns the database, while refusing writes', async () => {
    const s = fixture()
    await s.enable('all')
    s.db.close()
    databases.splice(databases.indexOf(s.db), 1)
    const raw = new Database(s.path)
    raw.pragma(`user_version = ${Number(raw.pragma('user_version', { simple: true })) + 1}`)
    raw.close()
    const newer = openReadingDatabase(s.path)
    databases.push(newer)
    expect(newer.status.state).toBe('read-only')
    expect(newer.getReminderRules(['100'])[0]?.rules.all.enabled).toBe(true)
    expect(newer.reminderOverview().threads.map((group) => group.threadId)).toEqual(['100'])
    expect(() => newer.setReminderRule('100', 'po', true, later)).toThrow()
  })
})
