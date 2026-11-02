import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReadingMode } from '../src/shared/forum'
import { createForumClient } from '../src/main/forum/client'
import { createForumTransport } from '../src/main/forum/transport'
import { createReadingService } from '../src/main/reading/service'
import { createRequestScheduler } from '../src/main/reading/scheduler'
import { createReminderService } from '../src/main/reminders/service'
import { openReadingDatabase } from '../src/main/storage/database'
import { asStore } from './helpers/store'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

/** Controlled clock shared by the reminder service and the request lane's 1 s background spacing. */
class Clock {
  at = 0
  private next = 0
  private timers = new Map<number, { at: number; run(): void }>()
  now = () => this.at
  wall = () => new Date(Date.UTC(2026, 10, 1) + this.at).toISOString()
  setTimer = (run: () => void, delay: number): (() => void) => {
    const id = ++this.next
    this.timers.set(id, { at: this.at + delay, run })
    return () => { this.timers.delete(id) }
  }
  pending = () => this.timers.size
  advance(ms: number): void {
    this.at += ms
    for (const [id, timer] of [...this.timers].sort(([, a], [, b]) => a.at - b.at)) if (timer.at <= this.at) {
      this.timers.delete(id)
      timer.run()
    }
  }
}

interface Seen { mode: ReadingMode; id: string; page: number; cookie: boolean; at: number }
type Override = (seen: Seen) => { status?: number; html?: boolean; body: string } | undefined

async function harness() {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-open-po-'))
  const db = openReadingDatabase(join(folder, 'app.sqlite'))
  const clock = new Clock()
  const counts = new Map<string, { all: number; po: number }>()
  const seen: Seen[] = []
  const remote = { override: undefined as Override | undefined, hold: null as Promise<void> | null }
  const post = (id: number, hash = 'PoHash') => ({ id, fid: 4, now: '2026-11-01(日)08:00:00', user_hash: hash, name: '无名氏', title: '无标题',
    content: '正文', img: '', ext: '', admin: 0, sage: 0 })
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://local')
    const entry: Seen = { mode: url.pathname === '/api/po' ? 'po' : 'all', id: url.searchParams.get('id') ?? '',
      page: Number(url.searchParams.get('page') ?? 1), cookie: request.headers.cookie !== undefined, at: clock.at }
    seen.push(entry)
    const hold = remote.hold
    if (hold !== null) await hold
    const custom = remote.override?.(entry)
    if (custom !== undefined) {
      response.writeHead(custom.status ?? 200, { 'Content-Type': custom.html ? 'text/html' : 'application/json' })
      return response.end(custom.body)
    }
    const thread = counts.get(entry.id)
    const count = thread?.[entry.mode] ?? 0
    const base = Number(entry.id) * 1000 + (entry.mode === 'po' ? 500 : 0)
    const replies = Array.from({ length: Math.max(0, Math.min(19, count - (entry.page - 1) * 19)) }, (_, n) => post(base + (entry.page - 1) * 19 + n + 1))
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(thread === undefined ? '该串不存在' : { ...post(Number(entry.id)), ReplyCount: count, Replies: replies }))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no server address')
  const origin = `http://127.0.0.1:${address.port}`
  const transport = createForumTransport({ allowedOrigins: [origin], credentialOrigins: [origin] })
  /** Requests handed to the transport, including ones aborted before reaching the server. */
  const attempts: string[] = []
  const client = createForumClient({ baseUrl: origin,
    transport: { ...transport, get: (url, signal, options) => { attempts.push(url.pathname); return transport.get(url, signal, options) } },
    browseIdentity: async () => db.listCredentials().length > 0 ? 'browse-secret' : null })
  const timers = { setTimeout: (run: () => void, delay: number) => clock.setTimer(run, delay), clearTimeout: (cancel: () => void) => cancel() }
  const scheduler = createRequestScheduler({ backgroundSpacingMs: 1000, monotonicNow: clock.now,
    timers: timers as unknown as Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> })
  const notices: string[] = []
  const store = asStore(db)
  const service = createReminderService({ store, client, scheduler, now: clock.wall, monotonicNow: clock.now, setTimer: clock.setTimer,
    notifier: { show({ body }) { notices.push(body); return true } } })
  const reading = createReadingService({ client, store, scheduler, now: () => new Date(clock.wall()), displayReads: service.displayReads })
  cleanup.push(async () => {
    await service.stop('quit')
    db.close()
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    await closed.promise
    rmSync(folder, { recursive: true, force: true })
  })
  const requests = () => seen.map((entry) => `${entry.mode}:${entry.id}:${entry.page}${entry.cookie ? '+cookie' : ''}`)
  return {
    db, store, clock, seen, attempts, remote, notices, service, reading, requests,
    /** A thread whose PO追更 baseline is established at `po` (and 全串 at `all` when given). */
    thread(threadId: string, value: { all: number; po: number }, rules: { all?: boolean; poReady?: boolean } = {}) {
      counts.set(threadId, { ...value })
      if (rules.all) {
        db.setReminderRule(threadId, 'all', true, clock.wall())
        db.updateReminderState({ threadId, kind: 'all', generation: 1, at: clock.wall(), baseline: value.all })
      }
      db.setReminderRule(threadId, 'po', true, clock.wall())
      if (rules.poReady !== false) db.updateReminderState({ threadId, kind: 'po', generation: 1, at: clock.wall(), baseline: value.po })
      return counts.get(threadId)!
    },
    poBaseline: (threadId: string) => db.reminderStates().find((state) => state.threadId === threadId && state.kind === 'po')?.baseline ?? null,
    async open(threadId: string) { expect((await service.clear({ threadId, source: 'open' })).ok).toBe(true) },
    /** Fires the settle timers; resolves once `n` requests in total were seen and the lane is idle. */
    async sent(n: number) {
      await vi.waitFor(() => expect(seen.length).toBe(n))
      await service.whenIdle()
    },
    /** Lets in-flight work run to where it would send; for asserting nothing more is sent. */
    async quiet() {
      await sleep(40)
      await service.whenIdle()
      await sleep(10)
    },
    /** A manual check once its cooldown has passed, moving the clock past the lane's spacing. */
    async check() {
      clock.advance(60_000)
      expect((await service.check()).accepted).toBe(true)
      let finished = false
      void service.whenIdle().then(() => { finished = true })
      while (!finished) {
        await sleep(10)
        clock.advance(1_000)
      }
    },
    async row(threadId: string) {
      const result = await service.overview()
      if (!result.ok) throw new Error('overview failed')
      return result.overview.threads.find((row) => row.threadId === threadId)!
    }
  }
}

it('reads PO page 1 once in the background after a 全串 open, advancing only the PO baseline without counting', async () => {
  const h = await harness()
  const thread = h.thread('100', { all: 30, po: 10 }, { all: true })
  thread.po = 13
  thread.all = 33
  await h.check()
  expect(h.requests()).toEqual(['all:100:1', 'po:100:1'])
  expect((await h.row('100')).counts).toEqual({ all: 3, po: 3, quote: 0 })
  const lastChecked = (await h.row('100')).lastCheckedAt
  h.notices.length = 0
  h.seen.length = 0

  thread.po = 15
  await h.open('100')
  expect((await h.row('100')).counts).toEqual({ all: 0, po: 0, quote: 0 })
  await h.quiet()
  expect(h.requests()).toEqual([])
  h.clock.advance(1_000)
  await h.sent(1)
  expect(h.requests()).toEqual(['po:100:1'])
  expect(h.poBaseline('100')).toBe(15)
  // Nothing counted, no check started, no notice; the last check time stays.
  expect(await h.row('100')).toMatchObject({ counts: { all: 0, po: 0, quote: 0 }, lastCheckedAt: lastChecked })
  expect(h.notices).toEqual([])
  await h.quiet()
  expect(h.requests()).toEqual(['po:100:1'])

  // PO replies seen by the open are not counted again; 全串 still counts its new replies.
  thread.all = 35
  h.seen.length = 0
  await h.check()
  expect(h.requests()).toEqual(['all:100:1', 'po:100:1'])
  expect((await h.row('100')).counts).toEqual({ all: 2, po: 0, quote: 0 })
  expect(h.notices).toEqual(['1 个串有新提醒'])
})

it('leaves the check cooldown and round budget alone', async () => {
  const h = await harness()
  h.thread('100', { all: 0, po: 10 })
  await h.check()
  h.seen.length = 0
  // Open at once after the check; its read goes out a second later.
  await h.open('100')
  h.clock.advance(1_000)
  await h.sent(1)
  // The 60 s cooldown counts from the check, not from the open read.
  h.clock.advance(59_000)
  expect((await h.service.check()).accepted).toBe(true)
  await h.service.whenIdle()
  expect(h.requests()).toEqual(['po:100:1', 'po:100:1'])
})

it('drops the queued read when a reader PO page is saved after the open, also while that read is still in flight', async () => {
  const h = await harness()
  const thread = h.thread('100', { all: 0, po: 10 })
  thread.po = 12
  const signal = new AbortController().signal

  // Opened in PO mode: the reader's own display read is saved before the read goes out.
  await h.open('100')
  expect((await h.reading.readThreadPage('100', 'po', 1, signal, 'display')).status).toBe('fresh')
  h.clock.advance(1_000)
  await h.quiet()
  expect(h.requests()).toEqual(['po:100:1'])
  expect(h.poBaseline('100')).toBe(12)

  // The reader's read is still running when the open read's wait ends: it waits, then drops.
  thread.po = 14
  h.seen.length = 0
  const release = Promise.withResolvers<void>()
  h.remote.hold = release.promise
  await h.open('100')
  const reader = h.reading.readThreadPage('100', 'po', 1, signal, 'display')
  await vi.waitFor(() => expect(h.seen).toHaveLength(1))
  h.clock.advance(1_000)
  await h.quiet()
  expect(h.requests()).toEqual(['po:100:1'])
  h.remote.hold = null
  release.resolve()
  expect((await reader).status).toBe('fresh')
  await h.quiet()
  expect(h.requests()).toEqual(['po:100:1'])
  expect(h.poBaseline('100')).toBe(14)
})

it('counts a reader PO save made while the open is still clearing or qualifying; a failed clear or rule lookup reads nothing', async () => {
  const h = await harness()
  const thread = h.thread('100', { all: 0, po: 10 })
  const signal = new AbortController().signal
  const store = h.store as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  for (const method of ['clearReminderCounts', 'getReminderRules']) {
    thread.po += 2
    h.seen.length = 0
    const original = store[method]!
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    store[method] = async (...args) => {
      const result = await original(...args)
      entered.resolve()
      await release.promise
      return result
    }
    const opening = h.open('100')
    await entered.promise
    // Opened in PO mode: the reader's display read is saved before the open's storage work ends.
    expect((await h.reading.readThreadPage('100', 'po', 1, signal, 'display')).status).toBe('fresh')
    release.resolve()
    await opening
    store[method] = original
    h.clock.advance(1_000)
    await h.quiet()
    expect(h.requests()).toEqual(['po:100:1'])
    expect(h.poBaseline('100')).toBe(thread.po)
  }

  const fail = (method: string) => {
    const original = store[method]!
    store[method] = async () => { throw new Error('storage unavailable') }
    return () => { store[method] = original }
  }
  h.seen.length = 0
  let restore = fail('clearReminderCounts')
  expect((await h.service.clear({ threadId: '100', source: 'open' })).ok).toBe(false)
  restore()
  restore = fail('getReminderRules')
  await h.open('100')
  restore()
  h.clock.advance(1_000)
  await h.quiet()
  expect(h.requests()).toEqual([])

  // A failed clear is no open: the reader save after the earlier open still drops its read.
  await h.open('100')
  expect((await h.reading.readThreadPage('100', 'po', 1, signal, 'display')).status).toBe('fresh')
  restore = fail('clearReminderCounts')
  expect((await h.service.clear({ threadId: '100', source: 'open' })).ok).toBe(false)
  restore()
  h.clock.advance(1_000)
  await h.quiet()
  expect(h.requests()).toEqual(['po:100:1'])
})

it('still reads when the reader only saved 全串 pages, a lookup page, a PO page before the open, or a failed PO read', async () => {
  const h = await harness()
  const thread = h.thread('100', { all: 20, po: 10 })
  const signal = new AbortController().signal
  expect((await h.reading.readThreadPage('100', 'po', 1, signal, 'display')).status).toBe('fresh')
  thread.po = 11
  await h.open('100')
  expect((await h.reading.readThreadPage('100', 'all', 1, signal, 'display')).status).toBe('fresh')
  expect((await h.reading.readThreadPage('100', 'po', 1, signal, 'lookup')).status).toBe('fresh')
  h.remote.override = (entry) => entry.mode === 'po' && h.seen.length === 4 ? { status: 500, body: '{}' } : undefined
  expect((await h.reading.readThreadPage('100', 'po', 1, signal, 'display')).status).toBe('cached')
  h.remote.override = undefined
  h.clock.advance(1_000)
  await h.sent(5)
  expect(h.requests()).toEqual(['po:100:1', 'all:100:1', 'po:100:1', 'po:100:1', 'po:100:1'])
  expect(h.poBaseline('100')).toBe(11)
})

it('serializes reads of several opened threads at least 1 s apart, one per thread', async () => {
  const h = await harness()
  for (const id of ['100', '200', '300']) h.thread(id, { all: 0, po: 5 })
  for (const id of ['100', '200', '100', '300', '200']) await h.open(id)
  h.clock.advance(1_000)
  await vi.waitFor(() => expect(h.seen).toHaveLength(1))
  for (const n of [2, 3]) {
    await vi.waitFor(() => expect(h.clock.pending()).toBeGreaterThan(0))
    h.clock.advance(999)
    await sleep(40)
    expect(h.seen).toHaveLength(n - 1)
    h.clock.advance(1)
    await vi.waitFor(() => expect(h.seen).toHaveLength(n))
  }
  await h.service.whenIdle()
  await h.quiet()
  expect(h.requests()).toEqual(['po:100:1', 'po:200:1', 'po:300:1'])
  expect(h.seen.map((entry) => entry.at)).toEqual([1_000, 2_000, 3_000])
  // Opened again after its read went out: a new read of its own.
  await h.open('100')
  h.clock.advance(1_000)
  await h.sent(4)
  expect(h.requests().at(-1)).toBe('po:100:1')
})

it('reads nothing for a pending or disabled PO追更, during a backoff, or after a manual clear', async () => {
  const h = await harness()
  h.thread('100', { all: 0, po: 10 }, { poReady: false })
  h.thread('200', { all: 0, po: 10 })
  h.db.setReminderRule('200', 'po', false, h.clock.wall())
  h.db.setReminderRule('300', 'all', true, h.clock.wall())
  for (const id of ['100', '200', '300']) await h.open(id)
  h.clock.advance(1_000)
  await h.quiet()
  expect(h.requests()).toEqual([])
  expect(h.poBaseline('100')).toBeNull()

  // 清除提醒: counts go to 0, baselines stay, nothing is read.
  const thread = h.thread('400', { all: 10, po: 10 }, { all: true })
  thread.all = 12
  thread.po = 11
  await h.check()
  expect((await h.row('400')).counts).toEqual({ all: 2, po: 1, quote: 0 })
  h.seen.length = 0
  expect((await h.service.clear({ threadId: '400', source: 'manual' })).ok).toBe(true)
  expect((await h.row('400')).counts).toEqual({ all: 0, po: 0, quote: 0 })
  h.clock.advance(1_000)
  await h.quiet()
  expect(h.requests()).toEqual([])
  expect(h.db.reminderStates().filter((state) => state.threadId === '400').map((state) => state.baseline)).toEqual([12, 11])

  const backoff = await harness()
  backoff.thread('100', { all: 0, po: 10 })
  backoff.db.saveReminderBackoff({ minutes: 30, episodeId: 'episode', notified: true, dismissed: false })
  await backoff.open('100')
  backoff.clock.advance(1_000)
  await backoff.quiet()
  expect(backoff.requests()).toEqual([])
})

it('keeps the PO baseline when the read fails, and reads once more with the browse cookie when refused', async () => {
  const h = await harness()
  const thread = h.thread('100', { all: 0, po: 10 })
  thread.po = 12
  h.remote.override = () => ({ status: 500, body: '{}' })
  await h.open('100')
  h.clock.advance(1_000)
  await h.sent(1)
  expect(h.poBaseline('100')).toBe(10)
  expect(h.db.loadReminderBackoff().episodeId).toBeNull()

  h.db.insertCredential({ name: 'c', cookieId: 'Mine', source: 'raw', importedAt: h.clock.wall(), ciphertext: Uint8Array.of(1) })
  h.remote.override = (entry) => entry.cookie ? undefined : { body: JSON.stringify('本版需要饼干才能浏览') }
  h.seen.length = 0
  await h.open('100')
  h.clock.advance(1_000)
  await vi.waitFor(() => expect(h.seen).toHaveLength(1))
  await vi.waitFor(() => expect(h.clock.pending()).toBeGreaterThan(0))
  h.clock.advance(1_000)
  await h.sent(2)
  expect(h.requests()).toEqual(['po:100:1', 'po:100:1+cookie'])
  expect(h.poBaseline('100')).toBe(12)
})

it.each([
  ['429', { status: 429, body: '{}' }],
  ['captcha', { html: true, body: '<html>captcha</html>' }]
])('enters the shared backoff on %s, cancels queued reads and notifies only once per episode', async (_name, refusal) => {
  const h = await harness()
  for (const id of ['100', '200']) h.thread(id, { all: 0, po: 10 })
  h.remote.override = () => refusal
  await h.open('100')
  await h.open('200')
  h.clock.advance(1_000)
  await vi.waitFor(() => expect(h.seen).toHaveLength(1))
  await vi.waitFor(() => expect(h.db.loadReminderBackoff().episodeId).not.toBeNull())
  // The queued read of 200 is dropped at its turn.
  h.clock.advance(1_000)
  await h.quiet()
  expect(h.requests()).toEqual(['po:100:1'])
  expect(h.poBaseline('100')).toBe(10)
  expect(h.db.loadReminderBackoff()).toMatchObject({ minutes: 30, notified: true })
  expect(h.notices).toHaveLength(1)
  // No open read during the backoff.
  await h.open('100')
  h.clock.advance(1_000)
  await h.quiet()
  expect(h.requests()).toEqual(['po:100:1'])
  // A check rate-limited in the same episode extends it without a second notice.
  await h.check()
  expect(h.db.loadReminderBackoff()).toMatchObject({ minutes: 60, notified: true })
  expect(h.notices).toHaveLength(1)
})

it.each([
  ['429', { status: 429, body: '{}' }, false],
  ['captcha', { html: true, body: '<html>captcha</html>' }, false],
  ['slow 429', { status: 429, body: '{}' }, true],
  ['slow captcha', { html: true, body: '<html>captcha</html>' }, true]
])('an open read %s stops the check accepted meanwhile and keeps its backoff until a later manual check succeeds', async (_name, refusal, slow) => {
  const h = await harness()
  h.thread('100', { all: 0, po: 10 }).po = 12
  const release = Promise.withResolvers<void>()
  h.remote.hold = release.promise
  let refused = false
  h.remote.override = () => {
    if (refused) return undefined
    refused = true
    return refusal
  }
  await h.open('100')
  h.clock.advance(1_000)
  await vi.waitFor(() => expect(h.seen).toHaveLength(1))
  // Accepted while the open read is in flight: its PO read waits behind it in the lane.
  expect((await h.service.check()).accepted).toBe(true)
  await sleep(40)
  // A response slower than the lane spacing: the lane would admit the check's read immediately.
  if (slow) h.clock.advance(1_000)
  h.remote.hold = null
  release.resolve()
  await sleep(40)
  for (let n = 0; n < 5; n++) {
    h.clock.advance(1_000)
    await sleep(20)
  }
  await h.service.whenIdle()
  // Not even handed to the transport: the check stopped before the lane admitted its read.
  expect(h.attempts).toEqual(['/api/po'])
  expect(h.requests()).toEqual(['po:100:1'])
  expect(h.db.loadReminderBackoff()).toMatchObject({ minutes: 30, notified: true, episodeId: expect.any(String) })
  expect((await h.service.overview())).toMatchObject({ ok: true, overview: { checker: { running: false, rateLimit: { dismissed: false } } } })
  expect(h.notices).toHaveLength(1)
  expect(h.poBaseline('100')).toBe(10)

  // An explicit later check still runs; its success ends the episode.
  await h.check()
  expect(h.requests()).toEqual(['po:100:1', 'po:100:1'])
  expect(h.db.loadReminderBackoff().episodeId).toBeNull()
  expect((await h.service.overview())).toMatchObject({ ok: true, overview: { checker: { rateLimit: null } } })
  expect((await h.row('100')).counts.po).toBe(2)
})

it.each([
  ['429', { status: 429, body: '{}' }, false],
  ['captcha', { html: true, body: '<html>captcha</html>' }, false],
  ['slow 429', { status: 429, body: '{}' }, true],
  ['slow captcha', { html: true, body: '<html>captcha</html>' }, true]
])('a check %s drops the open read queued behind it before the lane admits it', async (_name, refusal, slow) => {
  const h = await harness()
  h.thread('100', { all: 0, po: 10 }).po = 12
  h.thread('200', { all: 0, po: 10 }).po = 12
  const release = Promise.withResolvers<void>()
  h.remote.hold = release.promise
  let refused = false
  h.remote.override = () => {
    if (refused) return undefined
    refused = true
    return refusal
  }
  h.clock.advance(60_000)
  expect((await h.service.check()).accepted).toBe(true)
  await vi.waitFor(() => expect(h.seen).toHaveLength(1))
  // Opened while the check's read is in flight: its read waits behind it in the lane.
  await h.open('200')
  h.clock.advance(1_000)
  // A response slower than the lane spacing: the lane would admit the open read immediately.
  if (slow) h.clock.advance(1_000)
  await sleep(20)
  h.remote.hold = null
  release.resolve()
  for (let n = 0; n < 5; n++) {
    await sleep(20)
    h.clock.advance(1_000)
  }
  await h.service.whenIdle()
  expect(h.attempts).toEqual(['/api/po'])
  expect(h.requests()).toEqual(['po:100:1'])
  expect(h.db.loadReminderBackoff()).toMatchObject({ minutes: 30, notified: true, episodeId: expect.any(String) })
  expect(h.notices).toHaveLength(1)
  expect(h.poBaseline('200')).toBe(10)
})

it('cancels queued and in-flight open reads on quit', async () => {
  const h = await harness()
  h.thread('100', { all: 0, po: 10 }).po = 12
  h.thread('200', { all: 0, po: 10 }).po = 12
  await h.open('200')
  const release = Promise.withResolvers<void>()
  h.remote.hold = release.promise
  await h.open('100')
  h.clock.advance(1_000)
  await vi.waitFor(() => expect(h.seen).toHaveLength(1))
  // Resolves only once the aborted in-flight read and the dropped queued one have settled.
  await h.service.stop('quit')
  h.remote.hold = null
  release.resolve()
  h.clock.advance(5_000)
  await sleep(50)
  expect(h.seen).toHaveLength(1)
  expect(h.poBaseline('100')).toBe(10)
  expect(h.poBaseline('200')).toBe(10)
  await h.open('100')
  h.clock.advance(1_000)
  await sleep(50)
  expect(h.seen).toHaveLength(1)
})
