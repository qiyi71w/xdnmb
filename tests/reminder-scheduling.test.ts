import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createForumClient } from '../src/main/forum/client'
import { createSettingsService } from '../src/main/appearance'
import type { AppSettings } from '../src/shared/settings'
import { createForumTransport } from '../src/main/forum/transport'
import { createReminderService, type ReminderService } from '../src/main/reminders/service'
import { createRequestScheduler } from '../src/main/reading/scheduler'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { asStore } from './helpers/store'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

class Clock {
  at = 0
  private next = 0
  private timers = new Map<number, { at: number; run(): void }>()
  now = () => this.at
  wall = () => new Date(Date.UTC(2026, 9, 26) + this.at).toISOString()
  setTimer = (run: () => void, delay: number): (() => void) => {
    const id = ++this.next
    this.timers.set(id, { at: this.at + delay, run })
    return () => { this.timers.delete(id) }
  }
  advance(ms: number): void {
    this.at += ms
    for (const [id, timer] of [...this.timers]) if (timer.at <= this.at) {
      this.timers.delete(id)
      timer.run()
    }
  }
}

async function harness(random = 0.5, seed = true) {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-schedule-'))
  const path = join(folder, 'app.sqlite')
  let db: ReadingDatabase = openReadingDatabase(path)
  let service: ReminderService
  const clock = new Clock()
  const remote = { requests: 0, count: 0, status: 200, captcha: false, hold: null as Promise<void> | null,
    entered: null as (() => void) | null, seen: [] as Array<{ id: string; mode: string; page: number }> }
  const notices: string[] = []
  const server: Server = createServer(async (req, res) => {
    remote.requests++
    const url = new URL(req.url ?? '/', 'http://local')
    const id = url.searchParams.get('id') ?? '500'
    const page = Number(url.searchParams.get('page') ?? 1)
    remote.seen.push({ id, mode: url.pathname === '/api/po' ? 'po' : 'all', page })
    remote.entered?.()
    await remote.hold
    const post = (postId: number) => ({ id: postId, fid: 4, now: 'now', user_hash: 'PO', name: '', title: '', content: 'thread', img: '', ext: '', admin: 0, sage: 0 })
    const start = (page - 1) * 19
    const replies = Array.from({ length: Math.max(0, Math.min(19, remote.count - start)) }, (_, n) => post(Number(id) * 1000 + start + n + 1))
    res.writeHead(remote.status, { 'Content-Type': remote.captcha ? 'text/html' : 'application/json' })
    res.end(remote.captcha ? '<html>captcha</html>' : JSON.stringify({ ...post(Number(id)), ReplyCount: remote.count, Replies: replies }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address')
  const origin = `http://127.0.0.1:${address.port}`
  let store = asStore(db)
  const create = () => createReminderService({ store,
    client: createForumClient({ baseUrl: origin, transport: createForumTransport({ allowedOrigins: [origin], credentialOrigins: [] }) }),
    scheduler: createRequestScheduler({ backgroundSpacingMs: 0 }), notifier: { show: ({ body }) => { notices.push(body); return true } },
    monotonicNow: clock.now, now: clock.wall, random: () => random, setTimer: clock.setTimer })
  service = create()
  cleanup.push(async () => {
    await service.stop('quit')
    db.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(folder, { recursive: true, force: true })
  })
  if (seed) db.setReminderRule('500', 'all', true, clock.wall())
  return { clock, remote, notices, get service() { return service }, get db() { return db }, get store() { return store },
    async tick(ms: number) { clock.advance(ms); await service.whenIdle() },
    async restart() { await service.stop('quit'); db.close(); db = openReadingDatabase(path); store = asStore(db); service = create(); await service.startScheduling() },
    async settings(patch: Partial<AppSettings>) { return createSettingsService(asStore(db), service.configure).update(patch) },
    async overview() { const result = await service.overview(); if (!result.ok) throw new Error('storage'); return result.overview }
  }
}

it('schedules jittered checks, skips a cooldown tick, and resumes remaining time after sleep', async () => {
  const h = await harness()
  await h.service.startScheduling()
  await h.tick(15 * 60_000 + 89_999)
  expect(h.remote.requests).toBe(0)
  await h.tick(1)
  expect(h.remote.requests).toBe(1)
  await h.tick(60_000)
  h.service.suspend()
  await h.tick(8 * 60 * 60_000)
  expect(h.remote.requests).toBe(1)
  h.service.resume()
  await h.tick(15 * 60_000 + 29_999)
  expect(h.remote.requests).toBe(1)
  await h.tick(1)
  expect(h.remote.requests).toBe(2)
  await h.tick(16 * 60_000)
  expect((await h.service.check()).accepted).toBe(true)
  await h.service.whenIdle()
  expect(h.remote.requests).toBe(3)
  await h.tick(30_000)
  expect(h.remote.requests).toBe(3)
  await h.tick(16 * 60_000 + 30_000)
  expect(h.remote.requests).toBe(4)
})

it.each([0, 1])('uses the jitter endpoints and applies disabled, 30 and 60 minute settings (%s)', async (random) => {
  const h = await harness(random)
  await h.service.startScheduling()
  await h.tick(15 * 60_000 + random * 180_000 - 1)
  expect(h.remote.requests).toBe(0)
  await h.tick(1)
  expect(h.remote.requests).toBe(1)
  expect((await h.settings({ reminderInterval: 0 })).saved).toBe(true)
  await h.tick(24 * 60 * 60_000)
  expect(h.remote.requests).toBe(1)
  for (const interval of [30, 60] as const) {
    const before = h.remote.requests
    await h.settings({ reminderInterval: interval })
    await h.tick(interval * 60_000 + random * 180_000 - 1)
    expect(h.remote.requests).toBe(before)
    await h.tick(1)
    expect(h.remote.requests).toBe(before + 1)
  }
})

it('persists exponential backoff and a single notice across restarts, errors and acknowledgment', async () => {
  const h = await harness(0)
  await h.service.startScheduling()
  h.remote.status = 429
  await h.service.check()
  await h.service.whenIdle()
  const first = (await h.overview()).checker
  expect(Date.parse(first.retryAt!) - Date.parse(h.clock.wall())).toBe(30 * 60_000)
  expect(first.rateLimit?.dismissed).toBe(false)
  expect(h.notices).toHaveLength(1)
  await h.restart()
  expect((await h.overview()).checker.rateLimit).toEqual(first.rateLimit)
  expect(h.notices).toHaveLength(1)
  await h.service.dismissRateLimit({ id: first.rateLimit!.id })
  for (const delay of [60, 120, 120]) {
    h.clock.advance(60_000)
    await h.service.check()
    await h.service.whenIdle()
    expect(Date.parse((await h.overview()).checker.retryAt!) - Date.parse(h.clock.wall())).toBe(delay * 60_000)
    expect((await h.overview()).checker.rateLimit).toEqual({ ...first.rateLimit, dismissed: true })
  }
  expect(h.notices).toHaveLength(1)
  await h.restart()
  expect((await h.overview()).checker.rateLimit?.dismissed).toBe(true)
  h.remote.status = 500
  await h.service.check()
  await h.service.whenIdle()
  expect((await h.overview()).checker.rateLimit?.id).toBe(first.rateLimit!.id)
  h.remote.status = 200
  await h.tick(60_000)
  await h.service.check()
  await h.service.whenIdle()
  expect((await h.overview()).checker.rateLimit).toBeNull()
  const before = h.remote.requests
  await h.tick(15 * 60_000 - 1)
  expect(h.remote.requests).toBe(before)
  await h.tick(1)
  expect(h.remote.requests).toBe(before + 1)
  h.remote.captcha = true
  await h.tick(60_000)
  await h.service.check()
  await h.service.whenIdle()
  const next = (await h.overview()).checker.rateLimit
  expect(next?.id).not.toBe(first.rateLimit!.id)
  expect(h.notices).toHaveLength(2)
  await h.service.dismissRateLimit({ id: first.rateLimit!.id })
  expect((await h.overview()).checker.rateLimit?.dismissed).toBe(false)
})

it('keeps new counts silent when notifications are off, but retains the rate-limit notice', async () => {
  const h = await harness(0)
  await h.settings({ reminderSystemNotifications: false, reminderInterval: 30 })
  await h.restart()
  await h.service.check()
  await h.service.whenIdle()
  h.remote.count = 3
  await h.tick(60_000)
  await h.service.check()
  await h.service.whenIdle()
  expect((await h.overview()).badge).toBe(1)
  expect((await h.overview()).checker.rateLimit).toBeNull()
  expect(h.notices).toEqual([])
  h.remote.captcha = true
  await h.tick(60_000)
  await h.service.check()
  await h.service.whenIdle()
  expect((await h.overview()).checker.rateLimit?.dismissed).toBe(false)
  expect(Date.parse((await h.overview()).checker.retryAt!) - Date.parse(h.clock.wall())).toBe(60 * 60_000)
  expect(h.notices).toEqual([])
  await h.settings({ reminderInterval: 0, reminderSystemNotifications: true })
  expect((await h.overview()).checker.retryAt).toBeNull()
  await h.restart()
  expect(h.db.loadSettings()).toMatchObject({ reminderInterval: 0, reminderSystemNotifications: true })
  expect((await h.overview()).checker.rateLimit?.dismissed).toBe(false)
  expect(h.notices).toEqual([])
})

it('rejects invalid reminder settings without changing the saved choice', async () => {
  const h = await harness()
  const settings = createSettingsService(asStore(h.db), h.service.configure)
  expect((await settings.update({ reminderInterval: 60, reminderSystemNotifications: false })).saved).toBe(true)
  for (const patch of [{ reminderInterval: 1 }, { reminderInterval: '15' }, { reminderInterval: null }, { reminderSystemNotifications: 0 }]) {
    expect((await settings.update(patch)).saved).toBe(false)
    expect(h.db.loadSettings()).toMatchObject({ reminderInterval: 60, reminderSystemNotifications: false })
  }
})

it('does not queue a timer tick that arrives during a running check', async () => {
  const h = await harness(0)
  await h.service.startScheduling()
  const held = Promise.withResolvers<void>()
  h.remote.hold = held.promise
  expect((await h.service.check()).accepted).toBe(true)
  h.clock.advance(15 * 60_000)
  held.resolve()
  await h.service.whenIdle()
  expect(h.remote.requests).toBe(1)
  h.remote.hold = null
  await h.tick(15 * 60_000 - 1)
  expect(h.remote.requests).toBe(1)
  await h.tick(1)
  expect(h.remote.requests).toBe(2)
})

it('keeps failed acknowledgment and recovery writes out of the visible committed state', async () => {
  const h = await harness(0)
  await h.service.startScheduling()
  h.remote.status = 429
  await h.service.check()
  await h.service.whenIdle()
  const episode = (await h.overview()).checker.rateLimit!
  const save = vi.spyOn(h.db, 'saveReminderBackoff')
  save.mockImplementationOnce(() => { throw new Error('disk full') })
  expect(await h.service.dismissRateLimit({ id: episode.id })).toEqual({ ok: false, reason: 'storage' })
  expect((await h.overview()).checker.rateLimit).toEqual(episode)
  h.remote.status = 200
  save.mockImplementationOnce(() => { throw new Error('disk full') })
  await h.tick(60_000)
  await h.service.check()
  await h.service.whenIdle()
  expect((await h.overview()).checker.rateLimit).toEqual(episode)
  await h.restart()
  expect((await h.overview()).checker.rateLimit).toEqual(episode)
})

it('keeps rate-limit throttling conservative when its first state write fails', async () => {
  const h = await harness(0)
  await h.service.startScheduling()
  h.remote.status = 429
  vi.spyOn(h.db, 'saveReminderBackoff').mockImplementationOnce(() => { throw new Error('disk full') })
  await h.service.check()
  await h.service.whenIdle()
  expect(Date.parse((await h.overview()).checker.retryAt!) - Date.parse(h.clock.wall())).toBe(30 * 60_000)
  expect(h.notices).toEqual([])
  await h.tick(60_000)
  await h.service.check()
  await h.service.whenIdle()
  expect(h.notices).toHaveLength(1)
  expect(h.db.loadReminderBackoff()).toMatchObject({ minutes: 60, notified: true })
  await h.restart()
  expect((await h.overview()).checker.rateLimit?.dismissed).toBe(false)
  expect(h.notices).toHaveLength(1)
})

it('durably enables and automatically initializes without a check call or initial notification', async () => {
  const h = await harness(0, false)
  h.remote.count = 3
  expect(await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })).toMatchObject({
    ok: true, thread: { rules: { all: { enabled: true, baseline: 'pending' }, po: { baseline: null } } }
  })
  await h.service.whenIdle()
  expect(h.remote.requests).toBe(1)
  expect(await h.overview()).toMatchObject({ badge: 0, threads: [{ rules: { all: { baseline: 'ready' } }, counts: { all: 0 } }] })
  expect(h.notices).toEqual([])
  expect(await h.service.check()).toMatchObject({ accepted: false, reason: 'cooldown', retryAfterMs: 60_000 })
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  await h.tick(60_000)
  expect(h.remote.requests).toBe(1)
  h.remote.count = 5
  await h.service.check()
  await h.service.whenIdle()
  expect((await h.overview()).threads[0]?.counts.all).toBe(2)
  expect(h.notices).toEqual(['1 个串有新提醒'])
})

it('coalesces cooldown intents, reads only missing kinds, and leaves initialized counts untouched', async () => {
  const h = await harness(0, false)
  h.remote.count = 2
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  await h.service.whenIdle()
  await h.tick(60_000)
  h.remote.count = 4
  await h.service.check()
  await h.service.whenIdle()
  h.remote.count = 40
  await h.service.setRule({ threadId: '500', kind: 'po', enabled: true })
  await h.service.setRule({ threadId: '500', kind: 'quote', enabled: true })
  await h.tick(59_999)
  expect(h.remote.requests).toBe(2)
  await h.tick(1)
  expect(h.remote.seen.slice(2)).toEqual([
    { id: '500', mode: 'all', page: 1 }, { id: '500', mode: 'po', page: 1 }, { id: '500', mode: 'all', page: 3 }
  ])
  expect((await h.overview()).threads[0]).toMatchObject({
    rules: { all: { baseline: 'ready' }, po: { baseline: 'ready' }, quote: { baseline: 'ready' } },
    counts: { all: 2, po: 0, quote: 0 }
  })
  expect(h.db.reminderStates()).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'all', baseline: 4 })]))
  expect(h.notices).toEqual(['1 个串有新提醒'])
  expect(await h.service.check()).toMatchObject({ accepted: false, reason: 'cooldown' })
})

it('retains an enable arriving during a running pass and initializes it automatically afterward', async () => {
  const h = await harness(0)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  h.remote.entered = () => entered.resolve()
  h.remote.hold = release.promise
  await h.service.check()
  await entered.promise
  await h.service.setRule({ threadId: '500', kind: 'po', enabled: true })
  expect(await h.service.check()).toMatchObject({ accepted: false, reason: 'running' })
  release.resolve()
  await h.service.whenIdle()
  h.remote.hold = null
  await h.tick(59_999)
  expect(h.remote.requests).toBe(1)
  await h.tick(1)
  expect(h.remote.seen).toEqual([{ id: '500', mode: 'all', page: 1 }, { id: '500', mode: 'po', page: 1 }])
  expect((await h.overview()).threads[0]?.rules.po.baseline).toBe('ready')
})

it('drops queued intents already initialized by a normal check rather than counting newer replies', async () => {
  const h = await harness(0, false)
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  await h.service.whenIdle()
  await h.service.setRule({ threadId: '500', kind: 'po', enabled: true })
  h.service.suspend()
  // Explicit checks remain available while automatic work is paused.
  h.service.resume()
  h.clock.at += 60_000 // Make a manual request before the pending timer callback.
  h.remote.count = 3
  await h.service.check()
  await h.service.whenIdle()
  const before = h.remote.requests
  h.remote.count = 6
  await h.tick(60_000)
  expect(h.remote.requests).toBe(before)
  expect((await h.overview()).threads[0]?.counts.po).toBe(0)
})

it('keeps failed initialization pending without retrying a no-op enable, then recovers on a manual check', async () => {
  const h = await harness(0, false)
  h.remote.status = 500
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  await h.service.whenIdle()
  expect((await h.overview()).threads[0]).toMatchObject({ rules: { all: { enabled: true, baseline: 'pending' } }, issues: ['read-failed'], lastError: { kind: 'network', detail: 'http-status' } })
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  await h.tick(10 * 60_000)
  expect(h.remote.requests).toBe(1)
  h.remote.status = 200
  h.remote.count = 9
  await h.service.check()
  await h.service.whenIdle()
  expect((await h.overview()).threads[0]).toMatchObject({ rules: { all: { baseline: 'ready' } }, counts: { all: 0 }, issues: [], lastError: null })
  expect(h.notices).toEqual([])
})

it('rejects a late initialization response from a disabled and re-enabled generation', async () => {
  const h = await harness(0, false)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  h.remote.entered = () => entered.resolve()
  h.remote.hold = release.promise
  h.remote.count = 4
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  await entered.promise
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: false })
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  release.resolve()
  await h.service.whenIdle()
  expect(h.db.reminderStates()).toEqual([])
  expect((await h.overview()).threads[0]?.rules.all.baseline).toBe('pending')
  h.remote.hold = null
  h.remote.count = 7
  await h.tick(60_000)
  expect(h.remote.requests).toBe(2)
  expect(h.db.reminderStates()).toEqual([expect.objectContaining({ baseline: 7 })])
  expect((await h.overview()).threads[0]?.counts.all).toBe(0)
})

it('deletes queued intent on disable and bulk close, with no requests when the cooldown expires', async () => {
  const h = await harness(0, false)
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  await h.service.whenIdle()
  await h.service.setRule({ threadId: '500', kind: 'po', enabled: true })
  await h.service.setRule({ threadId: '500', kind: 'po', enabled: false })
  await h.service.setRule({ threadId: '600', kind: 'all', enabled: true })
  await h.service.closeForThreads({ threadIds: ['600'], reason: 'unsubscribe' })
  await h.tick(60_000)
  expect(h.remote.requests).toBe(1)
  const rules = await h.service.getRules({ threadIds: ['500', '600'] })
  expect(rules).toMatchObject({ ok: true, threads: [{ rules: { po: { enabled: false, baseline: null } } }, { rules: { all: { enabled: false, baseline: null } } }] })
})

it('pauses pending initialization over suspend and resumes the remaining shared cooldown', async () => {
  const h = await harness(0, false)
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  await h.service.whenIdle()
  await h.service.setRule({ threadId: '500', kind: 'po', enabled: true })
  await h.tick(30_000)
  h.service.suspend()
  await h.tick(8 * 60 * 60_000)
  expect(h.remote.requests).toBe(1)
  h.service.resume()
  await h.tick(29_999)
  expect(h.remote.requests).toBe(1)
  await h.tick(1)
  expect(h.remote.requests).toBe(2)
})

it.each(['user', 'quit'] as const)('cancels active initialization and queued intent on %s stop', async (reason) => {
  const h = await harness(0, false)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  h.remote.entered = () => entered.resolve()
  h.remote.hold = release.promise
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  await entered.promise
  await h.service.setRule({ threadId: '500', kind: 'po', enabled: true })
  await h.service.stop(reason)
  release.resolve()
  h.remote.hold = null
  await h.tick(60_000)
  expect(h.remote.requests).toBe(1)
  expect((await h.overview()).threads[0]).toMatchObject({ rules: { all: { baseline: 'pending' }, po: { baseline: 'pending' } }, counts: { all: 0, po: 0 } })
})

it('does not bypass a rate-limit episode through toggles when periodic checks are disabled', async () => {
  const h = await harness(0, false)
  await h.settings({ reminderInterval: 0 })
  h.remote.status = 429
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  await h.service.whenIdle()
  const episode = (await h.overview()).checker.rateLimit
  expect(episode).not.toBeNull()
  h.remote.status = 200
  await h.tick(60_000)
  await h.service.setRule({ threadId: '500', kind: 'po', enabled: true })
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: false })
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  await h.tick(120 * 60_000)
  expect(h.remote.requests).toBe(1)
  expect((await h.overview()).checker.rateLimit).toEqual(episode)
  await h.service.check()
  await h.service.whenIdle()
  expect(h.remote.requests).toBe(3)
  expect((await h.overview()).checker.rateLimit).toBeNull()
  expect((await h.overview()).threads[0]?.rules).toMatchObject({ all: { baseline: 'ready' }, po: { baseline: 'ready' } })
})

it('leaves queued initialization to the allowed scheduled recovery check during backoff', async () => {
  const h = await harness(0)
  await h.service.startScheduling()
  h.remote.status = 429
  await h.service.check()
  await h.service.whenIdle()
  h.remote.status = 200
  await h.service.setRule({ threadId: '500', kind: 'po', enabled: true })
  await h.tick(30 * 60_000 - 1)
  expect(h.remote.requests).toBe(1)
  await h.tick(1)
  expect(h.remote.requests).toBe(3)
  expect((await h.overview()).checker.rateLimit).toBeNull()
  await h.tick(60_000)
  expect(h.remote.requests).toBe(3)
})

it('recovers persisted missing baselines on the next cold-start check without a persistent queue', async () => {
  const h = await harness(0, false)
  h.remote.status = 500
  await h.service.setRule({ threadId: '500', kind: 'quote', enabled: true })
  await h.service.whenIdle()
  await h.restart()
  h.remote.status = 200
  h.remote.count = 40
  await h.service.request()
  await h.service.whenIdle()
  expect(h.remote.seen.slice(1)).toEqual([{ id: '500', mode: 'all', page: 1 }, { id: '500', mode: 'all', page: 3 }])
  expect((await h.overview()).threads[0]).toMatchObject({ rules: { quote: { baseline: 'ready' } }, counts: { quote: 0 } })
})

it('preserves a new enable intent arriving while the previous initialization loads its snapshots', async () => {
  const h = await harness(0, false)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const snapshots = h.store.reminderRuleSnapshots.bind(h.store)
  vi.spyOn(h.store, 'reminderRuleSnapshots').mockImplementationOnce(async () => {
    const rules = await snapshots()
    entered.resolve()
    await release.promise
    return rules
  })
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  await entered.promise
  await h.service.setRule({ threadId: '500', kind: 'po', enabled: true })
  h.clock.advance(60_000)
  release.resolve()
  await h.service.whenIdle()
  expect(h.remote.seen).toEqual([{ id: '500', mode: 'all', page: 1 }, { id: '500', mode: 'po', page: 1 }])
  expect((await h.overview()).threads[0]?.rules).toMatchObject({ all: { baseline: 'ready' }, po: { baseline: 'ready' } })
})

it('cancels initialization during snapshot loading without starting a read afterward', async () => {
  const h = await harness(0, false)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const snapshots = h.store.reminderRuleSnapshots.bind(h.store)
  vi.spyOn(h.store, 'reminderRuleSnapshots').mockImplementationOnce(async () => {
    entered.resolve()
    await release.promise
    return snapshots()
  })
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  await entered.promise
  const stopped = h.service.cancel()
  release.resolve()
  await stopped
  await h.tick(60_000)
  expect(h.remote.requests).toBe(0)
  expect((await h.overview()).threads[0]?.rules.all.baseline).toBe('pending')
})

it('does not retry initialization in a loop when snapshot storage is unavailable', async () => {
  const h = await harness(0, false)
  const snapshots = vi.spyOn(h.store, 'reminderRuleSnapshots').mockRejectedValueOnce(new Error('disk unavailable'))
  expect((await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })).ok).toBe(true)
  await h.service.whenIdle()
  await h.tick(60_000)
  expect(snapshots).toHaveBeenCalledTimes(1)
  expect(h.remote.requests).toBe(0)
  expect((await h.overview()).threads[0]?.rules.all.baseline).toBe('pending')
  await h.service.check()
  await h.service.whenIdle()
  expect((await h.overview()).threads[0]?.rules.all.baseline).toBe('ready')
})

it('defers a first enable while suspended and starts it on resume without a manual check', async () => {
  const h = await harness(0, false)
  h.service.suspend()
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  await h.tick(8 * 60 * 60_000)
  expect(h.remote.requests).toBe(0)
  h.service.resume()
  await h.service.whenIdle()
  expect(h.remote.requests).toBe(1)
  expect((await h.overview()).threads[0]?.rules.all.baseline).toBe('ready')
})

it('does not resurrect canceled initialization when an earlier enable finishes its durable write', async () => {
  const h = await harness(0, false)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const setRule = h.store.setReminderRule.bind(h.store)
  vi.spyOn(h.store, 'setReminderRule').mockImplementationOnce(async (...args) => {
    entered.resolve()
    await release.promise
    return setRule(...args)
  })
  const enable = h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  await entered.promise
  await h.service.cancel()
  release.resolve()
  expect(await enable).toMatchObject({ ok: true, thread: { rules: { all: { enabled: true, baseline: 'pending' } } } })
  await h.tick(60_000)
  expect(h.remote.requests).toBe(0)
  await h.service.check()
  await h.service.whenIdle()
  expect((await h.overview()).threads[0]?.rules.all.baseline).toBe('ready')
})

it('coalesces simultaneous writes of the same enable transition into one initialization', async () => {
  const h = await harness(0, false)
  await Promise.all([
    h.service.setRule({ threadId: '500', kind: 'all', enabled: true }),
    h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  ])
  await h.service.whenIdle()
  await h.tick(60_000)
  expect(h.remote.requests).toBe(1)
  expect(h.db.reminderRuleSnapshots()).toEqual([{ threadId: '500', kind: 'all', generation: 1 }])
})

it('restores automatic initialization after a canceled quit without reviving old intents', async () => {
  const h = await harness(0, false)
  await h.settings({ reminderInterval: 0 })
  await h.service.startScheduling()
  h.remote.count = 2
  await h.service.setRule({ threadId: '500', kind: 'all', enabled: true })
  await h.service.whenIdle()
  await h.service.setRule({ threadId: '500', kind: 'po', enabled: true })
  await h.service.stop('quit')
  await h.service.startScheduling()
  await h.tick(60_000)
  expect(h.remote.requests).toBe(1)
  await h.service.setRule({ threadId: '500', kind: 'quote', enabled: true })
  await h.service.whenIdle()
  expect(h.remote.requests).toBe(2)
  expect((await h.overview()).threads[0]).toMatchObject({
    rules: { all: { baseline: 'ready' }, po: { baseline: 'pending' }, quote: { baseline: 'ready' } },
    counts: { all: 0, po: 0, quote: 0 }
  })
  expect(h.notices).toEqual([])
})
