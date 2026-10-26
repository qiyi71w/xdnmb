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

async function harness(random = 0.5) {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-schedule-'))
  const path = join(folder, 'app.sqlite')
  let db: ReadingDatabase = openReadingDatabase(path)
  let service: ReminderService
  const clock = new Clock()
  const remote = { requests: 0, count: 0, status: 200, captcha: false, hold: null as Promise<void> | null }
  const notices: string[] = []
  const server: Server = createServer(async (_req, res) => {
    remote.requests++
    await remote.hold
    res.writeHead(remote.status, { 'Content-Type': remote.captcha ? 'text/html' : 'application/json' })
    res.end(remote.captcha ? '<html>captcha</html>' : JSON.stringify({ id: 500, fid: 4, now: 'now', user_hash: 'PO', name: '', title: '', content: 'thread', img: '', ext: '', admin: 0, sage: 0, ReplyCount: remote.count, Replies: [] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server address')
  const origin = `http://127.0.0.1:${address.port}`
  const create = () => createReminderService({ store: asStore(db),
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
  await service.setRule({ threadId: '500', kind: 'all', enabled: true })
  return { clock, remote, notices, get service() { return service }, get db() { return db },
    async tick(ms: number) { clock.advance(ms); await service.whenIdle() },
    async restart() { await service.stop('quit'); db.close(); db = openReadingDatabase(path); service = create(); await service.startScheduling() },
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
