import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ThreadReadPurpose } from '../src/shared/api'
import type { ReadingMode } from '../src/shared/forum'
import type { ReminderKind, ReminderOverview } from '../src/shared/reminders'
import { createForumClient } from '../src/main/forum/client'
import { createForumTransport } from '../src/main/forum/transport'
import { createReadingService } from '../src/main/reading/service'
import { createRequestScheduler } from '../src/main/reading/scheduler'
import { createReminderService, type ReminderService } from '../src/main/reminders/service'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { asStore } from './helpers/store'

// Opening a thread in a reader advances its 全串／PO reminder baselines to the reply count the
// reader actually read, so a later check does not count replies the user has already seen. Real
// SQLite, a controlled local forum, the real reminder and reading services.

const t0 = '2026-11-01T00:00:00.000Z'
const folders: string[] = []
const databases: ReadingDatabase[] = []
const servers: Server[] = []
const services: ReminderService[] = []

afterEach(async () => {
  for (const service of services.splice(0)) await service.stop('quit')
  for (const db of databases.splice(0)) db.close()
  for (const server of servers.splice(0)) {
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    await closed.promise
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

interface ForumThread {
  count: number
  /** Number of PO replies, served by `/api/po`. */
  po: number
  /** `ReplyCount` served instead of the real count. */
  reported?: number
}
interface Seen { path: string; id: string; page: number }
type Override = (seen: Seen) => Promise<{ status: number; body: string } | undefined> | { status: number; body: string } | undefined

function forumPost(id: number, content: string) {
  return { id, fid: 4, now: '2026-11-01(日)08:00:00', user_hash: 'Someone', name: '无名氏', title: '无标题',
    content, img: '', ext: '', admin: 0, sage: 0 }
}

async function harness() {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-open-baseline-'))
  folders.push(folder)
  const db = openReadingDatabase(join(folder, 'app.sqlite'))
  databases.push(db)
  const threads = new Map<string, ForumThread>()
  const seen: Seen[] = []
  const remote = { override: undefined as Override | undefined }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://local')
    const entry: Seen = { path: url.pathname, id: url.searchParams.get('id') ?? '', page: Number(url.searchParams.get('page') ?? '1') }
    seen.push(entry)
    const send = (status: number, body: string) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(body)
    }
    const custom = await remote.override?.(entry)
    if (custom) return send(custom.status, custom.body)
    const thread = threads.get(entry.id)
    if (!thread) return send(200, JSON.stringify('该串不存在'))
    const po = url.pathname === '/api/po'
    const total = po ? thread.po : thread.count
    const numbers = Array.from({ length: total }, (_, index) => index + 1).slice((entry.page - 1) * 19, entry.page * 19)
    const replies = numbers.map((n) => forumPost(Number(entry.id) * 100000 + n, `回复 ${n}`))
    const reported = po ? thread.po : thread.reported ?? thread.count
    send(200, JSON.stringify({ ...forumPost(Number(entry.id), '主帖'), ReplyCount: reported, Replies: replies }))
  })
  servers.push(server)
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no server address')
  const origin = `http://127.0.0.1:${address.port}`
  const client = createForumClient({ baseUrl: origin,
    transport: createForumTransport({ allowedOrigins: [origin], credentialOrigins: [origin] }),
    browseIdentity: async () => null })
  let monotonic = 0
  let wall = Date.parse(t0)
  const notifications: string[] = []
  const store = asStore(db)
  const service = createReminderService({ store, client, scheduler: createRequestScheduler({ backgroundSpacingMs: 0 }),
    notifier: { show(message) { notifications.push(message.body); return true } },
    now: () => new Date(wall).toISOString(), monotonicNow: () => monotonic })
  services.push(service)
  const reading = createReadingService({ client, store, scheduler: createRequestScheduler({ backgroundSpacingMs: 0 }),
    now: () => new Date(wall) })
  const signal = new AbortController().signal
  return {
    db, client, remote, seen, notifications,
    thread(threadId: string, value: ForumThread): ForumThread {
      threads.set(threadId, value)
      return value
    },
    enable(threadId: string, ...kinds: ReminderKind[]) {
      for (const kind of kinds) {
        wall += 1000
        db.setReminderRule(threadId, kind, true, new Date(wall).toISOString())
      }
    },
    /** One manual check, waited for; returns its requests as `thread:100:1`. */
    async check(): Promise<string[]> {
      monotonic += 60_000
      wall += 60_000
      seen.length = 0
      expect((await service.check()).accepted).toBe(true)
      await service.whenIdle()
      return seen.map((entry) => `${entry.path.slice(5)}:${entry.id}:${entry.page}`)
    },
    read(threadId: string, mode: ReadingMode, page: number, purpose: ThreadReadPurpose) {
      wall += 1000
      return reading.readThreadPage(threadId, mode, page, signal, purpose)
    },
    locateEnd(threadId: string, mode: ReadingMode, purpose: ThreadReadPurpose) {
      wall += 1000
      return reading.locateThreadEnd(threadId, mode, signal, purpose)
    },
    async row(threadId: string) {
      const result = await service.overview()
      if (!result.ok) throw new Error('overview failed')
      const row = (result.overview as ReminderOverview).threads.find((item) => item.threadId === threadId)
      if (!row) throw new Error(`no row for ${threadId}`)
      return row
    }
  }
}

describe('a reader’s read advances the 全串 baseline (opened replies are not counted again)', () => {
  it('counts nothing after the reader read 203 (before the fix: 3 and a notification)', async () => {
    const h = await harness()
    const thread = h.thread('100', { count: 200, po: 0 })
    h.enable('100', 'all')
    expect(await h.check()).toEqual(['thread:100:1'])
    thread.count = 203
    expect(await h.read('100', 'all', 11, 'display')).toMatchObject({ status: 'fresh', data: { page: { replyCount: 203 } } })
    // The check still reads only page 1.
    expect(await h.check()).toEqual(['thread:100:1'])
    expect((await h.row('100')).counts).toEqual({ all: 0, po: 0, quote: 0 })
    expect(h.notifications).toEqual([])
    // Later replies still count from what the reader saw.
    thread.count = 205
    await h.check()
    expect((await h.row('100')).counts.all).toBe(2)
    expect(h.notifications).toEqual(['1 个串有新提醒'])
  })

  it('advances through the reader’s 末尾 read as well', async () => {
    const h = await harness()
    const thread = h.thread('100', { count: 200, po: 0 })
    h.enable('100', 'all')
    await h.check()
    thread.count = 203
    expect(await h.locateEnd('100', 'all', 'display')).toMatchObject({ status: 'fresh', data: { status: 'located' } })
    await h.check()
    expect((await h.row('100')).counts.all).toBe(0)
    expect(h.notifications).toEqual([])
  })

  it('a lookup read (search, quote card), an offline save and a stored fallback do not advance it: still 3', async () => {
    const lookup = await harness()
    const a = lookup.thread('100', { count: 200, po: 0 })
    lookup.enable('100', 'all')
    await lookup.check()
    a.count = 203
    expect(await lookup.read('100', 'all', 11, 'lookup')).toMatchObject({ status: 'fresh', data: { page: { replyCount: 203 } } })
    expect(await lookup.locateEnd('100', 'all', 'lookup')).toMatchObject({ status: 'fresh' })
    await lookup.check()
    expect((await lookup.row('100')).counts.all).toBe(3)
    expect(lookup.notifications).toEqual(['1 个串有新提醒'])

    const offline = await harness()
    const b = offline.thread('100', { count: 200, po: 0 })
    offline.enable('100', 'all')
    await offline.check()
    b.count = 203
    // The offline save path below its service: a background read stored as an offline page.
    offline.db.beginOfflineCopy('100', false, t0)
    const page = await offline.client.getThreadPage('100', 'all', 1, new AbortController().signal)
    offline.db.saveOfflinePage(page, t0)
    await offline.check()
    expect((await offline.row('100')).counts.all).toBe(3)
    expect(offline.notifications).toEqual(['1 个串有新提醒'])

    const fallback = await harness()
    const c = fallback.thread('100', { count: 200, po: 0 })
    fallback.enable('100', 'all')
    await fallback.check()
    c.count = 203
    // The stored page already says 203; showing it after a network failure is not a new read.
    await fallback.read('100', 'all', 1, 'lookup')
    fallback.remote.override = () => ({ status: 500, body: '{}' })
    expect(await fallback.read('100', 'all', 1, 'display')).toMatchObject({ status: 'cached', data: { page: { replyCount: 203 } } })
    fallback.remote.override = undefined
    await fallback.check()
    expect((await fallback.row('100')).counts.all).toBe(3)
    expect(fallback.notifications).toEqual(['1 个串有新提醒'])
  })

  it('never lowers the baseline on a smaller count, and keeps an earlier count when the reader reads more', async () => {
    const h = await harness()
    const thread = h.thread('100', { count: 200, po: 0 })
    h.enable('100', 'all')
    await h.check()
    thread.reported = 198
    await h.read('100', 'all', 1, 'display')
    delete thread.reported
    thread.count = 203
    await h.check()
    // Counted from 200, not from 198.
    expect((await h.row('100')).counts.all).toBe(3)
    thread.count = 206
    await h.read('100', 'all', 1, 'display')
    await h.check()
    // The count of the earlier check stays until the thread is opened (cleared); 204–206 were read.
    expect((await h.row('100')).counts.all).toBe(3)
  })

  it('a check whose round started before the reader’s read counts only what the reader did not see', async () => {
    const h = await harness()
    const thread = h.thread('100', { count: 200, po: 0 })
    h.enable('100', 'all')
    await h.check()
    thread.count = 203
    let armed = true
    // The reader reads the thread after this round loaded its baselines, before page 1 answers.
    h.remote.override = async (seen) => {
      if (!armed || seen.path !== '/api/thread') return undefined
      armed = false
      await h.read('100', 'all', 1, 'display')
      return undefined
    }
    await h.check()
    expect((await h.row('100')).counts.all).toBe(0)
    expect(h.notifications).toEqual([])
  })
})

describe('PO and rule state', () => {
  it('a PO-mode read advances only the PO baseline; a 全串 read only the 全串 one', async () => {
    const h = await harness()
    const thread = h.thread('100', { count: 200, po: 10 })
    h.enable('100', 'all', 'po')
    expect(await h.check()).toEqual(['thread:100:1', 'po:100:1'])
    Object.assign(thread, { count: 205, po: 13 })
    await h.read('100', 'po', 1, 'display')
    await h.check()
    expect((await h.row('100')).counts).toEqual({ all: 5, po: 0, quote: 0 })

    Object.assign(thread, { count: 208, po: 15 })
    await h.read('100', 'all', 1, 'display')
    await h.check()
    expect((await h.row('100')).counts).toEqual({ all: 5, po: 2, quote: 0 })
  })

  it('does not set up a waiting baseline, and leaves disabled rules alone', async () => {
    const h = await harness()
    const thread = h.thread('100', { count: 200, po: 10 })
    h.thread('300', { count: 50, po: 1 })
    h.enable('100', 'all')
    await h.read('100', 'all', 1, 'display')
    await h.read('300', 'all', 1, 'display')
    expect(h.db.getReminderRules(['100', '300']).map((item) => item.rules.all)).toEqual([
      { kind: 'all', enabled: true, closedBy: null, baseline: 'pending' },
      { kind: 'all', enabled: false, closedBy: null, baseline: null }
    ])
    // The first check sets the baseline (nothing counted); the reader's read did not.
    thread.count = 204
    await h.check()
    expect((await h.row('100')).counts.all).toBe(0)
    thread.count = 206
    await h.check()
    expect((await h.row('100')).counts.all).toBe(2)
  })
})
