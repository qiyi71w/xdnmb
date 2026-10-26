import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { Post } from '../src/shared/forum'
import { formatReminderCount, type ReminderKind, type ReminderOverview } from '../src/shared/reminders'
import { createForumClient } from '../src/main/forum/client'
import { createForumTransport } from '../src/main/forum/transport'
import { createReminderNotifier } from '../src/main/reminders/notifier'
import { createReminderService } from '../src/main/reminders/service'
import { createRequestScheduler } from '../src/main/reading/scheduler'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { asStore } from './helpers/store'

const t0 = '2026-10-24T00:00:00.000Z'
const folders: string[] = []
const databases: ReadingDatabase[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  for (const server of servers.splice(0)) {
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    await closed.promise
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** One thread of the controlled forum. Reply n (1-based) has ID thread × 100000 + n. */
interface ForumThread {
  count: number
  /** Reply numbers written by the PO, listed by `/api/po` in order. */
  po: number[]
  /** Posts quoted by reply n. */
  quotes: Map<number, string[]>
  /** `ReplyCount` served instead of the real count; `null` omits it. */
  reported?: number | null
}
/** A post as the forum's JSON API serves it. */
interface ForumPost {
  id: number; fid: number; now: string; user_hash: string; name: string; title: string
  content: string; img: string; ext: string; admin: number; sage: number
}
interface Seen { path: string; id: string; page: number | null; cookie: string | undefined }
interface Reply { status?: number; body: string }
type Override = (seen: Seen) => Promise<Reply | undefined> | Reply | undefined

function replyId(threadId: string, n: number): string {
  return String(Number(threadId) * 100000 + n)
}
function forumPost(id: string, content: string, userHash: string): ForumPost {
  return { id: Number(id), fid: 4, now: '2026-10-24(五)08:03:00', user_hash: userHash, name: '无名氏', title: '无标题',
    content, img: '', ext: '', admin: 0, sage: 0 }
}
function localPost(id: string, userHash: string): Post {
  return { id, forumId: '4', createdAt: null, userHash, name: null, title: null, isAdmin: false, isSage: false,
    image: null, imageKnown: true, content: [{ type: 'text', text: '正文' }], plainText: '正文' }
}

async function harness(options: { cookieIds?: string[] } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-reminders-'))
  folders.push(folder)
  const path = join(folder, 'app.sqlite')
  const db = openReadingDatabase(path)
  databases.push(db)
  for (const cookieId of options.cookieIds ?? []) {
    db.insertCredential({ name: cookieId, cookieId, source: 'raw', importedAt: t0, ciphertext: Uint8Array.of(1) })
  }
  const threads = new Map<string, ForumThread>()
  /** Posts served by `/api/ref`; others are 该串不存在. */
  const refs = new Map<string, ForumPost>()
  const seen: Seen[] = []
  const remote = { override: undefined as Override | undefined }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://local')
    const id = url.searchParams.get('id') ?? ''
    const number = url.searchParams.get('page')
    const entry: Seen = { path: url.pathname, id, page: number === null ? null : Number(number), cookie: request.headers.cookie }
    seen.push(entry)
    const send = (status: number, body: string) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(body)
    }
    const custom = await remote.override?.(entry)
    if (custom) return send(custom.status ?? 200, custom.body)
    if (url.pathname === '/api/ref') return send(200, JSON.stringify(refs.get(id) ?? '该串不存在'))
    const thread = threads.get(id)
    if (!thread) return send(200, JSON.stringify('该串不存在'))
    const po = url.pathname === '/api/po'
    const numbers = po ? thread.po : Array.from({ length: thread.count }, (_, index) => index + 1)
    const page = entry.page ?? 1
    const replies = numbers.slice((page - 1) * 19, page * 19).map((n) => forumPost(replyId(id, n),
      [`回复 ${n}`, ...(thread.quotes.get(n) ?? []).map((quoted) => `>>No.${quoted}`)].join(' '), thread.po.includes(n) ? 'PoHash' : 'Someone'))
    const reported = po ? numbers.length : thread.reported === undefined ? thread.count : thread.reported
    send(200, JSON.stringify({ ...forumPost(id, '主帖', 'PoHash'), ...(reported === null ? {} : { ReplyCount: reported }), Replies: replies }))
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
    browseIdentity: async () => db.listCredentials().length > 0 ? 'browse-secret' : null })
  let monotonic = 0
  let wall = Date.parse(t0)
  const notifications: string[] = []
  const notifier = { show: (_body: string): boolean => true }
  const service = createReminderService({ store: asStore(db), client, scheduler: createRequestScheduler({ backgroundSpacingMs: 0 }),
    notifier: { show(message) { notifications.push(message.body); return notifier.show(message.body) } },
    now: () => new Date(wall).toISOString(), monotonicNow: () => monotonic })
  async function overview(): Promise<ReminderOverview> {
    const result = await service.overview()
    if (!result.ok) throw new Error('overview failed')
    return result.overview
  }
  return {
    db, path, service, refs, remote, notifications, notifier, seen, overview,
    thread(threadId: string, value: Partial<ForumThread> = {}): ForumThread {
      const thread: ForumThread = { count: 0, po: [], quotes: new Map(), ...value }
      threads.set(threadId, thread)
      return thread
    },
    async enable(threadId: string, ...kinds: ReminderKind[]) {
      for (const kind of kinds) {
        wall += 1000
        expect((await service.setRule({ threadId, kind, enabled: true })).ok).toBe(true)
      }
    },
    /** Starts a manual check once the cooldown has passed, without waiting for it. */
    async begin() {
      monotonic += 60_000
      wall += 60_000
      seen.length = 0
      expect((await service.check()).accepted).toBe(true)
    },
    /** Runs one manual check; returns its requests as `thread:100:1`, with `+cookie` when sent with one. */
    async check(): Promise<string[]> {
      await this.begin()
      await service.whenIdle()
      return seen.map((entry) => `${entry.path.slice(5)}:${entry.id}${entry.page === null ? '' : `:${entry.page}`}${entry.cookie === undefined ? '' : '+cookie'}`)
    },
    async row(threadId: string) {
      const row = (await overview()).threads.find((item) => item.threadId === threadId)
      if (!row) throw new Error(`no row for ${threadId}`)
      return row
    },
    /** A publication confirmed as the user's own post `postId` by the read-back check. */
    confirmOwn(postId: string) {
      const raw = new Database(path)
      try {
        raw.prepare(`INSERT INTO publication_attempts(request_id, editor_id, payload_json, credential_id, forum_id, state, created_at, updated_at, post_id, thread_id, confirmed_by)
          VALUES (?, 'editor', '{}', 1, '4', 'confirmed', ?, ?, ?, '500', 'check')`).run(`request-${postId}`, t0, t0, postId)
      } finally { raw.close() }
    },
    /** A reply left 待核对, then ended by the user as 已发出 with `postId` (or without a number). */
    userConfirms(postId: string | null) {
      const payload = { draftId: null, target: { kind: 'reply', threadId: '500' }, credentialId: '1',
        fields: { content: '回复', title: '', name: '', email: '', watermark: false }, attachmentId: null }
      const raw = new Database(path)
      let id: number
      try {
        id = Number(raw.prepare(`INSERT INTO publication_attempts(request_id, editor_id, payload_json, credential_id, forum_id, state, problem, created_at, updated_at)
          VALUES (?, 'editor', ?, 1, '4', 'unknown', 'network', ?, ?)`).run(`request-user-${postId}`, JSON.stringify(payload), t0, t0).lastInsertRowid)
      } finally { raw.close() }
      expect(db.resolvePublication({ id: String(id), choice: 'sent', postId, at: t0 })).toMatchObject({ ok: true, attempt: { confirmedBy: 'user', postId } })
    }
  }
}

describe('全串 and PO reply counts', () => {
  it('establishes baselines first, then counts each mode’s growth, PO included in 全串 and shown separately', async () => {
    const h = await harness()
    const thread = h.thread('100', { count: 3, po: [2] })
    await h.enable('100', 'all', 'po')
    expect(await h.check()).toEqual(['thread:100:1', 'po:100:1'])
    expect((await h.row('100')).counts).toEqual({ all: 0, po: 0, quote: 0 })
    expect(h.notifications).toEqual([])

    Object.assign(thread, { count: 6, po: [2, 4, 6] })
    expect(await h.check()).toEqual(['thread:100:1', 'po:100:1'])
    expect(await h.row('100')).toMatchObject({ counts: { all: 3, po: 2, quote: 0 }, issues: [], firstNew: { mode: 'all', page: 1 } })
    expect((await h.overview()).badge).toBe(1)
    expect(h.notifications).toEqual(['1 个串有新提醒'])

    await h.check()
    expect((await h.row('100')).counts).toEqual({ all: 3, po: 2, quote: 0 })
    expect(h.notifications).toHaveLength(1)
  })

  it('sends only page 1 of the needed mode for a 1000-page thread, first and unchanged checks alike', async () => {
    const h = await harness()
    h.thread('200', { count: 19_000, po: [1, 5] })
    h.thread('300', { count: 19_000, po: [3] })
    await h.enable('200', 'all')
    await h.enable('300', 'po')
    expect(await h.check()).toEqual(['thread:200:1', 'po:300:1'])
    expect(await h.check()).toEqual(['thread:200:1', 'po:300:1'])
  })

  it('opens a PO-only count at the PO page of the first new reply', async () => {
    const h = await harness()
    const thread = h.thread('300', { count: 40, po: Array.from({ length: 19 }, (_, index) => index + 1) })
    await h.enable('300', 'po')
    await h.check()
    thread.po = Array.from({ length: 21 }, (_, index) => index + 1)
    await h.check()
    expect(await h.row('300')).toMatchObject({ counts: { all: 0, po: 2, quote: 0 }, firstNew: { mode: 'po', page: 2 } })
  })

  it('resets on a smaller count, keeps the baseline on a missing one, and keeps rules and counts on failures', async () => {
    const h = await harness()
    const thread = h.thread('100', { count: 10 })
    await h.enable('100', 'all')
    await h.check()
    thread.count = 12
    await h.check()
    thread.count = 11
    await h.check()
    expect(await h.row('100')).toMatchObject({ counts: { all: 2 }, issues: ['count-decreased'] })
    thread.count = 13
    await h.check()
    expect(await h.row('100')).toMatchObject({ counts: { all: 4 }, issues: [] })
    Object.assign(thread, { count: 20, reported: null })
    await h.check()
    expect(await h.row('100')).toMatchObject({ counts: { all: 4 }, issues: ['count-invalid'] })
    delete thread.reported
    await h.check()
    expect(await h.row('100')).toMatchObject({ counts: { all: 11 }, issues: [] })

    h.remote.override = () => ({ body: JSON.stringify('该串不存在') })
    await h.check()
    expect(await h.row('100')).toMatchObject({ counts: { all: 11 }, issues: ['not-found'], lastError: { kind: 'not-found' }, rules: { all: { enabled: true } } })
    h.remote.override = () => ({ status: 500, body: '{}' })
    await h.check()
    expect(await h.row('100')).toMatchObject({ counts: { all: 11 }, issues: ['read-failed'], rules: { all: { enabled: true } } })
    h.remote.override = undefined
    thread.count = 21
    await h.check()
    expect(await h.row('100')).toMatchObject({ counts: { all: 12 }, issues: [], lastError: null })
  })
})

describe('credentials of reminder reads', () => {
  it('reads reply counts without the cookie, retries a refusal once with it, and reads new pages with it', async () => {
    const h = await harness({ cookieIds: ['Mine'] })
    const thread = h.thread('100', { count: 20 })
    await h.enable('100', 'quote')
    expect(await h.check()).toEqual(['thread:100:1', 'thread:100:2+cookie'])
    expect(h.seen[1]?.cookie).toBe('userhash=browse-secret')

    h.remote.override = (entry) => entry.page === 1 && entry.cookie === undefined ? { body: JSON.stringify('本版需要饼干才能浏览') } : undefined
    thread.count = 40
    expect(await h.check()).toEqual(['thread:100:1', 'thread:100:1+cookie', 'thread:100:2+cookie', 'thread:100:3+cookie'])
    expect((await h.row('100')).issues).toEqual([])
  })

  it('sends no credential at all and does not retry when no cookie is imported', async () => {
    const h = await harness()
    h.thread('100', { count: 20 })
    await h.enable('100', 'all', 'quote')
    expect(await h.check()).toEqual(['thread:100:1', 'thread:100:2'])
    h.remote.override = (entry) => entry.page === 1 ? { body: JSON.stringify('本版需要饼干才能浏览') } : undefined
    expect(await h.check()).toEqual(['thread:100:1'])
    expect(await h.row('100')).toMatchObject({ issues: ['read-failed'], lastError: { kind: 'permission' } })
  })
})

describe('引用我的发言', () => {
  it('reads only new pages and matches confirmed sends, stored and quoted 饼干 IDs, never treating unknown as a non-match', async () => {
    const h = await harness({ cookieIds: ['Mine'] })
    const thread = h.thread('100', { count: 50 })
    h.confirmOwn('90')
    h.db.savePost(localPost('91', 'Mine'), t0)
    h.db.savePost(localPost('94', 'Other'), t0)
    h.refs.set('92', forumPost('92', '别处', 'Mine'))
    await h.enable('100', 'quote')
    // The initial checked reply comes from the current last page; nothing is counted.
    expect(await h.check()).toEqual(['thread:100:1', 'thread:100:3+cookie'])
    expect((await h.row('100')).counts.quote).toBe(0)

    thread.count = 60
    thread.quotes = new Map([[52, ['90']], [53, ['94']], [55, ['91']], [58, ['92']], [59, ['93']], [60, ['90', '91']]])
    expect(await h.check()).toEqual(['thread:100:1', 'thread:100:3+cookie', 'thread:100:4+cookie', 'ref:92+cookie', 'ref:93+cookie'])
    expect(await h.row('100')).toMatchObject({ counts: { all: 0, po: 0, quote: 4 }, unverifiedQuotes: 1,
      issues: ['quote-unverified'], firstNew: { mode: 'all', page: 3 } })
    expect(h.db.loadPost('92')?.value.userHash).toBe('Mine')
  })

  it('never reads /api/ref without any 饼干 ID, while confirmed sends still match', async () => {
    const h = await harness()
    const thread = h.thread('100', { count: 19 })
    h.confirmOwn('90')
    h.refs.set('92', forumPost('92', '别处', 'Mine'))
    await h.enable('100', 'quote')
    expect(await h.check()).toEqual(['thread:100:1'])
    Object.assign(thread, { count: 21, quotes: new Map([[20, ['92']], [21, ['90']]]) })
    expect(await h.check()).toEqual(['thread:100:1', 'thread:100:2'])
    expect(await h.row('100')).toMatchObject({ counts: { quote: 1 }, unverifiedQuotes: 0, issues: [] })
  })

  it('matches a send the user confirmed with its number, never one confirmed without a number', async () => {
    const h = await harness()
    const thread = h.thread('100', { count: 19 })
    await h.enable('100', 'quote')
    expect(await h.check()).toEqual(['thread:100:1'])
    h.userConfirms('90')
    h.userConfirms(null)
    Object.assign(thread, { count: 22, quotes: new Map([[20, ['90']], [21, ['91']], [22, ['500']]]) })
    expect(await h.check()).toEqual(['thread:100:1', 'thread:100:2'])
    expect(await h.row('100')).toMatchObject({ counts: { quote: 1 }, unverifiedQuotes: 0, issues: [] })
  })

  it('yields after five reads per thread and continues the same check in later batches', async () => {
    const h = await harness({ cookieIds: ['Mine'] })
    const long = h.thread('100', { count: 19 })
    const short = h.thread('200', { count: 1 })
    await h.enable('100', 'quote')
    await h.enable('200', 'all')
    expect(await h.check()).toEqual(['thread:100:1', 'thread:200:1'])
    long.count = 19 * 9
    short.count = 2
    expect(await h.check()).toEqual([
      'thread:100:1', 'thread:100:2+cookie', 'thread:100:3+cookie', 'thread:100:4+cookie', 'thread:100:5+cookie',
      'thread:200:1',
      'thread:100:6+cookie', 'thread:100:7+cookie', 'thread:100:8+cookie', 'thread:100:9+cookie'
    ])
    expect((await h.row('100')).issues).toEqual([])
  })

  it('stops at a failed page as 尚未补完 and resumes there next check, never from page 1', async () => {
    const h = await harness({ cookieIds: ['Mine'] })
    h.db.savePost(localPost('91', 'Mine'), t0)
    const thread = h.thread('100', { count: 19 })
    await h.enable('100', 'quote')
    await h.check()
    Object.assign(thread, { count: 19 * 9, quotes: new Map([[30, ['91']], [70, ['91']]]) })
    h.remote.override = (entry) => entry.page === 4 ? { status: 500, body: '{}' } : undefined
    expect(await h.check()).toEqual(['thread:100:1', 'thread:100:2+cookie', 'thread:100:3+cookie', 'thread:100:4+cookie'])
    expect(await h.row('100')).toMatchObject({ counts: { quote: 1 }, issues: expect.arrayContaining(['incomplete', 'read-failed']) })
    h.remote.override = undefined
    expect(await h.check()).toEqual(['thread:100:1', 'thread:100:4+cookie', 'thread:100:5+cookie', 'thread:100:6+cookie',
      'thread:100:7+cookie', 'thread:100:8+cookie', 'thread:100:9+cookie'])
    expect(await h.row('100')).toMatchObject({ counts: { quote: 2 }, issues: [] })
  })

  it('counts the page-100 check behind every page past 100 against the five reads of a batch', async () => {
    const h = await harness({ cookieIds: ['Mine'] })
    const long = h.thread('100', { count: 1900 })
    const short = h.thread('200', { count: 1 })
    await h.enable('100', 'quote')
    await h.enable('200', 'all')
    expect(await h.check()).toEqual(['thread:100:1', 'thread:100:100+cookie', 'thread:200:1'])
    long.count = 19 * 104
    short.count = 2
    expect(await h.check()).toEqual([
      'thread:100:1', 'thread:100:101+cookie', 'thread:100:100+cookie', 'thread:100:102+cookie', 'thread:100:100+cookie',
      'thread:200:1',
      'thread:100:103+cookie', 'thread:100:100+cookie', 'thread:100:104+cookie', 'thread:100:100+cookie'
    ])
  })

  it('treats an empty last page of the new range as 尚未补完 and reads it again next check', async () => {
    const h = await harness({ cookieIds: ['Mine'] })
    h.db.savePost(localPost('91', 'Mine'), t0)
    const thread = h.thread('100', { count: 19 })
    await h.enable('100', 'quote')
    await h.check()
    Object.assign(thread, { count: 20, quotes: new Map([[20, ['91']]]) })
    h.remote.override = (entry) => entry.page === 2
      ? { body: JSON.stringify({ ...forumPost('100', '主帖', 'PoHash'), ReplyCount: 20, Replies: [] }) } : undefined
    expect(await h.check()).toEqual(['thread:100:1', 'thread:100:2+cookie'])
    expect(await h.row('100')).toMatchObject({ counts: { quote: 0 }, issues: ['incomplete'] })
    h.remote.override = undefined
    expect(await h.check()).toEqual(['thread:100:1', 'thread:100:2+cookie'])
    expect(await h.row('100')).toMatchObject({ counts: { quote: 1 }, issues: [] })
  })

  it('opens a quote-only count at the first new reply after the baseline, not at the first match', async () => {
    const h = await harness({ cookieIds: ['Mine'] })
    h.db.savePost(localPost('91', 'Mine'), t0)
    const thread = h.thread('100', { count: 19 })
    await h.enable('100', 'quote')
    await h.check()
    Object.assign(thread, { count: 57, quotes: new Map([[50, ['91']]]) })
    await h.check()
    expect(await h.row('100')).toMatchObject({ counts: { quote: 1 }, firstNew: { mode: 'all', page: 2 } })
  })
})

describe('counts, clearing and rule generations', () => {
  it('clears every count of a thread, deletes a disabled kind’s count and re-baselines it when enabled again', async () => {
    const h = await harness()
    const thread = h.thread('100', { count: 1, po: [1] })
    await h.enable('100', 'all', 'po')
    await h.check()
    Object.assign(thread, { count: 3, po: [1, 3] })
    await h.check()
    expect((await h.row('100')).counts).toEqual({ all: 2, po: 1, quote: 0 })
    expect((await h.service.clear({ threadId: '100' })).ok).toBe(true)
    expect(await h.row('100')).toMatchObject({ counts: { all: 0, po: 0, quote: 0 }, firstNew: null, lastIncreasedAt: null })
    expect((await h.overview()).badge).toBe(0)

    thread.count = 5
    await h.check()
    expect((await h.row('100')).counts.all).toBe(2)
    await h.service.setRule({ threadId: '100', kind: 'all', enabled: false })
    expect((await h.row('100')).counts.all).toBe(0)
    await h.enable('100', 'all')
    thread.count = 7
    await h.check()
    expect((await h.row('100')).counts.all).toBe(0) // Re-enabled: the first check only sets the baseline.
  })

  it('drops a late result when the kind was turned off and on again while its page was being read', async () => {
    const h = await harness()
    const thread = h.thread('100', { count: 1 })
    await h.enable('100', 'all')
    await h.check()
    thread.count = 4
    h.remote.override = async () => {
      await h.service.setRule({ threadId: '100', kind: 'all', enabled: false })
      await h.service.setRule({ threadId: '100', kind: 'all', enabled: true })
      return undefined
    }
    await h.check()
    expect((await h.row('100')).counts.all).toBe(0)
    expect(h.notifications).toEqual([])
    h.remote.override = undefined
    thread.count = 6
    await h.check()
    expect((await h.row('100')).counts.all).toBe(0) // Still a fresh baseline: the late page set none.
    thread.count = 7
    await h.check()
    expect((await h.row('100')).counts.all).toBe(1)
  })

  it('lists counted threads by latest increase, then the rest by latest enable; the bell counts counted threads', async () => {
    const h = await harness()
    const threads = Object.fromEntries(['100', '200', '300', '400'].map((id) => [id, h.thread(id, { count: 1 })]))
    await h.enable('300', 'all')
    await h.enable('100', 'all')
    await h.enable('200', 'all')
    await h.check()
    await h.enable('400', 'all')
    threads['200']!.count = 2
    await h.check()
    threads['100']!.count = 2
    await h.check()
    let overview = await h.overview()
    expect(overview.threads.map((row) => row.threadId)).toEqual(['100', '200', '400', '300'])
    expect(overview.badge).toBe(2)
    await h.service.clear({ threadId: '100' })
    overview = await h.overview()
    expect(overview.threads.map((row) => row.threadId)).toEqual(['200', '400', '100', '300'])
    expect(overview.badge).toBe(1)
    expect([formatReminderCount(99), formatReminderCount(100)]).toEqual(['99', '99+'])
  })
})

describe('checks and notifications', () => {
  it('stops the whole check at a rate limit and marks every unfinished thread', async () => {
    const h = await harness()
    h.thread('100', { count: 1 })
    h.thread('200', { count: 1 })
    await h.enable('100', 'all')
    await h.enable('200', 'all')
    await h.check()
    h.remote.override = () => ({ body: JSON.stringify('验证码错误') })
    expect(await h.check()).toEqual(['thread:100:1'])
    for (const id of ['100', '200']) expect(await h.row(id)).toMatchObject({ issues: ['rate-limited'], lastError: { kind: 'rate-limited' } })
  })

  it('still notifies the counts a check already saved when quitting interrupts it', async () => {
    const h = await harness()
    const a = h.thread('100', { count: 1 })
    h.thread('200', { count: 1 })
    await h.enable('100', 'all')
    await h.enable('200', 'all')
    await h.check()
    a.count = 2
    const entered = Promise.withResolvers<void>()
    h.remote.override = async (entry) => {
      if (entry.id !== '200') return undefined
      entered.resolve()
      await Promise.withResolvers<never>().promise // Never answers: only the quit ends this read.
    }
    await h.begin()
    await entered.promise
    await h.service.stop('quit')
    expect((await h.row('100')).counts.all).toBe(1)
    expect(h.notifications).toEqual(['1 个串有新提醒'])
  })

  it('sends one notification per check with new counts, and a failed notification changes nothing else', async () => {
    const h = await harness()
    const a = h.thread('100', { count: 1 })
    const b = h.thread('200', { count: 1 })
    await h.enable('100', 'all')
    await h.enable('200', 'all')
    await h.check()
    a.count = 2
    b.count = 3
    await h.check()
    expect(h.notifications).toEqual(['2 个串有新提醒'])
    h.notifier.show = () => { throw new Error('desktop failure') }
    a.count = 3
    await h.check()
    expect(h.notifications).toHaveLength(2)
    expect((await h.row('100')).counts.all).toBe(2)
    expect((await h.overview()).checker).toMatchObject({ running: false, lastCheckedAt: expect.any(String) })
  })

  it('shares one single-flight and a monotonic 60-second cooldown across triggers, without queueing', async () => {
    const h = await harness()
    h.thread('100', { count: 1 })
    await h.enable('100', 'all')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    h.remote.override = async () => { entered.resolve(); await release.promise; return undefined }
    expect((await h.service.request()).accepted).toBe(true)
    await entered.promise
    expect(await h.service.check()).toEqual({ accepted: false, reason: 'running', retryAfterMs: 0 })
    expect((await h.overview()).checker.running).toBe(true)
    release.resolve()
    await h.service.whenIdle()
    expect(await h.service.check()).toMatchObject({ accepted: false, reason: 'cooldown' })
    h.remote.override = undefined
    expect(await h.check()).toEqual(['thread:100:1'])
  })

  it('keeps reminders readable when a newer app version owns the database, while refusing writes', async () => {
    const h = await harness()
    await h.enable('100', 'all')
    h.db.close()
    databases.splice(databases.indexOf(h.db), 1)
    const raw = new Database(h.path)
    raw.pragma(`user_version = ${Number(raw.pragma('user_version', { simple: true })) + 1}`)
    raw.close()
    const newer = openReadingDatabase(h.path)
    databases.push(newer)
    expect(newer.status.state).toBe('read-only')
    expect(newer.getReminderRules(['100'])[0]?.rules.all.enabled).toBe(true)
    expect(newer.reminderOverview().threads.map((row) => row.threadId)).toEqual(['100'])
    expect(() => newer.setReminderRule('100', 'po', true, t0)).toThrow()
  })
})

describe('system notification adapter', () => {
  it('creates nothing where notifications are unsupported and lets a show failure reach the caller', () => {
    const unsupported = createReminderNotifier({ isSupported: () => false,
      create() { throw new Error('must not create') }, async openList() { throw new Error('must not open') } })
    expect(unsupported.show({ title: '汐岛提醒', body: '1 个串有新提醒' })).toBe(false)
    const broken = createReminderNotifier({ isSupported: () => true,
      create: () => ({ on() {}, show() { throw new Error('desktop failure') } }), async openList() {} })
    expect(() => broken.show({ title: '汐岛提醒', body: '1 个串有新提醒' })).toThrow('desktop failure')
  })

  it('opens the reminders list only on click', async () => {
    const listeners = new Map<string, () => void>()
    let opens = 0
    const notifier = createReminderNotifier({ isSupported: () => true,
      create: () => ({ on(event, listener) { listeners.set(event, listener) }, show() {} }),
      async openList() { opens++ } })
    expect(notifier.show({ title: '汐岛提醒', body: '1 个串有新提醒' })).toBe(true)
    expect(opens).toBe(0)
    listeners.get('click')?.()
    await Promise.resolve()
    expect(opens).toBe(1)
  })
})
