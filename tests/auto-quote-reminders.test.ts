import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { EMPTY_FIELDS, type PostTarget } from '../src/shared/drafts'
import { DEFAULT_SETTINGS } from '../src/shared/settings'
import { createForumClient } from '../src/main/forum/client'
import { createForumTransport } from '../src/main/forum/transport'
import { createReminderService, type ReminderService } from '../src/main/reminders/service'
import { createRequestScheduler } from '../src/main/reading/scheduler'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { asStore } from './helpers/store'

// 发言后提醒引用我: a send from this app, once confirmed, turns on 引用我 for its thread as an
// automatic rule that starts after the sent post. Real SQLite, a controlled local forum and the real
// reminder service; sends go through the publication store as the publication service records them.
// Reply n of thread T has ID T × 100000 + n; the user's own replies are written as `Mine`.

const t0 = Date.parse('2026-11-01T00:00:00.000Z')
const WEEK = 7 * 24 * 60 * 60 * 1000
const resources: Array<{ folder: string; db: ReadingDatabase; server: Server; service: ReminderService }> = []

afterEach(async () => {
  for (const { folder, db, server, service } of resources.splice(0)) {
    await service.stop('quit')
    db.close()
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    await closed.promise
    rmSync(folder, { recursive: true, force: true })
  }
})

interface ForumThread {
  count: number
  /** Reply numbers written by the user. */
  mine: Set<number>
  /** Posts quoted by reply n. */
  quotes: Map<number, string[]>
}

function replyId(threadId: string, n: number): string {
  return String(Number(threadId) * 100000 + n)
}

function forumPost(id: string, content: string, userHash: string) {
  return { id: Number(id), fid: 4, now: '2026-11-01(日)08:00:00', user_hash: userHash, name: '无名氏', title: '无标题',
    content, img: '', ext: '', admin: 0, sage: 0 }
}

async function harness() {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-auto-quote-'))
  const path = join(folder, 'app.sqlite')
  let db = openReadingDatabase(path)
  const credentialId = db.insertCredential({ name: 'Mine', cookieId: 'Mine', source: 'raw', importedAt: new Date(t0).toISOString(), ciphertext: Uint8Array.of(1) }).id
  const threads = new Map<string, ForumThread>()
  /** Thread pages the forum served, as `page` numbers (reply-count and quote reads alike). */
  const pages: number[] = []
  const refs: string[] = []
  /** Thread reads fail: a server error, or a rate limit. */
  const remote: { failing: 'error' | 'limit' | null } = { failing: null }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local')
    const id = url.searchParams.get('id') ?? ''
    response.setHeader('Content-Type', 'application/json')
    if (url.pathname === '/api/thread' && remote.failing !== null) {
      response.statusCode = remote.failing === 'limit' ? 429 : 500
      response.end('{}')
      return
    }
    if (url.pathname === '/api/ref') {
      refs.push(id)
      response.end(JSON.stringify('该串不存在'))
      return
    }
    const thread = threads.get(id)
    if (url.pathname !== '/api/thread' || thread === undefined) {
      response.end(JSON.stringify('该串不存在'))
      return
    }
    const page = Number(url.searchParams.get('page') ?? 1)
    pages.push(page)
    const replies = Array.from({ length: thread.count }, (_, index) => index + 1).slice((page - 1) * 19, page * 19)
      .map((n) => forumPost(replyId(id, n), [`回复 ${n}`, ...(thread.quotes.get(n) ?? []).map((quoted) => `>>No.${quoted}`)].join(' '),
        thread.mine.has(n) ? 'Mine' : 'Someone'))
    response.end(JSON.stringify({ ...forumPost(id, '主帖', 'Someone'), ReplyCount: thread.count, Replies: replies }))
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no server address')
  const origin = `http://127.0.0.1:${address.port}`
  const client = createForumClient({ baseUrl: origin, transport: createForumTransport({ allowedOrigins: [origin], credentialOrigins: [origin] }),
    browseIdentity: async () => 'browse-secret' })
  let wall = t0
  let monotonic = 0
  const now = () => new Date(wall += 1000).toISOString()
  const start = () => createReminderService({ store: asStore(db), client, scheduler: createRequestScheduler({ backgroundSpacingMs: 0 }),
    notifier: { show: () => true }, now, monotonicNow: () => monotonic })
  const resource = { folder, db, server, service: start() }
  resources.push(resource)
  const signal = new AbortController().signal
  /** One SQL statement on a second connection: `get` for a row, otherwise run. */
  function sql<T>(query: string, ...args: unknown[]): T {
    const raw = new Database(path)
    try {
      const statement = raw.prepare(query)
      return (statement.reader ? statement.get(...args) : statement.run(...args)) as T
    } finally { raw.close() }
  }

  return {
    get db() { return db }, pages, refs, remote,
    thread(threadId: string, count: number): ForumThread {
      const thread: ForumThread = { count, mine: new Set(), quotes: new Map() }
      threads.set(threadId, thread)
      return thread
    },
    /** Replies by others; `quotes` maps a reply number among them to the posts it quotes. */
    peers(thread: ForumThread, n: number, quotes: Record<number, string[]> = {}) {
      thread.count += n
      for (const [reply, quoted] of Object.entries(quotes)) thread.quotes.set(Number(reply), quoted)
    },
    /** A reader's read of one 全部 page, saved as the reading service saves it. */
    async read(threadId: string, page: number) {
      db.saveThreadPage(await client.getThreadPage(threadId, 'all', page, signal), now(), 'display')
    },
    /** The send intent, persisted before the request; returns the attempt ID. */
    intent(target: PostTarget): string {
      return db.createPublication({ requestId: `send-${wall}`, editorId: 'editor', forumId: '4', at: now(),
        payload: { draftId: null, target, credentialId, fields: { ...EMPTY_FIELDS, content: 'mine' }, attachmentId: null } }).id
    },
    /** The forum takes the user's reply: the next reply number of the thread; returns its ID. */
    posted(threadId: string): string {
      const thread = threads.get(threadId)!
      thread.mine.add(++thread.count)
      return replyId(threadId, thread.count)
    },
    confirm(id: string, postId: string, threadId: string) {
      db.finishPublication({ id, state: 'confirmed', problem: null, postId, threadId, at: now() })
    },
    /** 论坛报告成功而串号未确认. */
    unconfirmed(id: string) {
      db.finishPublication({ id, state: 'unconfirmed', problem: null, postId: null, threadId: null, at: now() })
    },
    /** A confirmed reply from this app. */
    send(threadId: string): { id: string; postId: string } {
      const id = this.intent({ kind: 'reply', threadId })
      const postId = this.posted(threadId)
      this.confirm(id, postId, threadId)
      return { id, postId }
    },
    advance(ms: number) { wall += ms },
    sql,
    /** Quits and starts again on the same database file, as the app does. */
    async restart() {
      await resource.service.stop('quit')
      db.close()
      resource.db = db = openReadingDatabase(path)
      resource.service = start()
    },
    /** The user opens the thread: its counts are cleared. */
    async open(threadId: string) {
      expect(await resource.service.clear({ threadId, source: 'open' })).toEqual({ ok: true })
    },
    quote(threadId: string) { return db.getReminderRules([threadId])[0]!.rules.quote },
    expiresAt(threadId: string) {
      return sql<{ expires_at: string | null }>("SELECT expires_at FROM reminder_rules WHERE thread_id = ? AND kind = 'quote'", threadId).expires_at
    },
    generation(threadId: string) {
      return sql<{ generation: number }>("SELECT generation FROM reminder_rules WHERE thread_id = ? AND kind = 'quote'", threadId).generation
    },
    position(threadId: string) {
      return sql<{ baseline: number | null; checked_post_id: string | null }>(
        "SELECT baseline, checked_post_id FROM reminder_state WHERE thread_id = ? AND kind = 'quote'", threadId)
    },
    sentAt(id: string) { return db.getPublication(id)!.createdAt },
    async check() {
      monotonic += 60_000
      pages.length = 0
      refs.length = 0
      expect((await resource.service.check()).accepted).toBe(true)
      await resource.service.whenIdle()
    },
    async count(threadId: string) {
      return (await this.row(threadId))?.counts.quote ?? null
    },
    async unverified(threadId: string) {
      return (await this.row(threadId))?.unverifiedQuotes ?? null
    },
    /** The thread's 提醒 page row; null when no kind is on. */
    async row(threadId: string) {
      const result = await resource.service.overview()
      if (!result.ok) throw new Error('overview failed')
      return result.overview.threads.find((row) => row.threadId === threadId) ?? null
    }
  }
}

const week = (at: string) => new Date(Date.parse(at) + WEEK).toISOString()

it('a confirmed reply or new thread turns on only 引用我, as automatic, expiring seven days after the send', async () => {
  const h = await harness()
  expect(h.db.loadSettings().reminderAutoQuote).toBe(true)
  h.thread('100', 40)
  await h.read('100', 1)
  const reply = h.intent({ kind: 'reply', threadId: '100' })
  const postId = h.posted('100')
  // The intent alone enables nothing.
  expect(h.quote('100').enabled).toBe(false)
  h.confirm(reply, postId, '100')
  expect(h.db.getReminderRules(['100'])[0]!.rules).toMatchObject({
    all: { enabled: false }, po: { enabled: false }, quote: { enabled: true, source: 'auto', closedBy: null, baseline: 'ready' }
  })
  expect(h.expiresAt('100')).toBe(week(h.sentAt(reply)))

  h.thread('500', 0)
  const thread = h.intent({ kind: 'thread', forumId: '4' })
  h.confirm(thread, '500', '500')
  expect(h.quote('500')).toMatchObject({ enabled: true, source: 'auto', baseline: 'ready' })
  expect(h.expiresAt('500')).toBe(week(h.sentAt(thread)))
})

it('enables nothing while the setting is off, after the user closed 引用我, or over the user’s own rule; other closes do not stop it', async () => {
  const h = await harness()
  for (const id of ['100', '200', '300', '400', '600', '700']) h.thread(id, 10)
  const at = new Date(t0).toISOString()
  h.db.setReminderRule('200', 'quote', true, at)
  h.db.setReminderRule('200', 'quote', false, at)
  h.db.setReminderRule('300', 'quote', true, at)
  const userGeneration = h.generation('300')
  h.db.setReminderRule('400', 'quote', true, at)
  h.db.closeReminderThreads(['400'], 'unsubscribe', at)
  h.db.setReminderRule('600', 'quote', true, at)
  h.db.closeReminderThreads(['600'], 'sync-delete', at)
  // A rule the app itself closed (an expiry, or the setting turned off) before this send.
  h.db.setReminderRule('700', 'quote', true, at)
  h.sql("UPDATE reminder_rules SET enabled = 0, generation = generation + 1, closed_by = 'auto' WHERE thread_id = '700'")

  h.db.saveSettings({ ...DEFAULT_SETTINGS, reminderAutoQuote: false })
  h.send('100')
  expect(h.quote('100')).toMatchObject({ enabled: false, closedBy: null })
  h.db.saveSettings({ ...DEFAULT_SETTINGS })
  for (const id of ['200', '300', '400', '600', '700']) h.send(id)
  expect(h.quote('200')).toMatchObject({ enabled: false, closedBy: 'user' })
  expect(h.quote('300')).toMatchObject({ enabled: true, source: 'user' })
  expect(h.expiresAt('300')).toBeNull()
  expect(h.generation('300')).toBe(userGeneration)
  for (const id of ['400', '600', '700']) expect(h.quote(id)).toMatchObject({ enabled: true, source: 'auto', closedBy: null })
})

it('a later send renews an automatic rule: a later expiry, the same generation, count and checked position; not while the setting is off', async () => {
  const h = await harness()
  const thread = h.thread('100', 40)
  await h.read('100', 1)
  const first = h.send('100')
  h.peers(thread, 1, { 42: [first.postId] })
  await h.check()
  expect(await h.count('100')).toBe(1)
  const generation = h.generation('100')
  const position = h.position('100')
  expect(position.checked_post_id).toBe(replyId('100', 42))

  h.advance(2 * 24 * 60 * 60 * 1000)
  const second = h.send('100')
  expect(h.expiresAt('100')).toBe(week(h.sentAt(second.id)))
  expect(Date.parse(h.expiresAt('100')!)).toBeGreaterThan(Date.parse(week(h.sentAt(first.id))))
  expect(h.generation('100')).toBe(generation)
  expect(h.position('100')).toEqual(position)
  expect(await h.count('100')).toBe(1)

  const renewed = h.expiresAt('100')
  h.db.saveSettings({ ...DEFAULT_SETTINGS, reminderAutoQuote: false })
  h.advance(24 * 60 * 60 * 1000)
  h.send('100')
  expect(h.expiresAt('100')).toBe(renewed)
})

it('a new thread starts at page 1: the first check reuses its page 1 and counts quotes of the head', async () => {
  const h = await harness()
  const thread = h.thread('500', 0)
  h.confirm(h.intent({ kind: 'thread', forumId: '4' }), '500', '500')
  h.peers(thread, 5, { 3: ['500'] })
  await h.check()
  expect(await h.count('500')).toBe(1)
  expect(h.pages).toEqual([1])
})

it('starts from the reply count saved with the intent, not a later one: quotes after the reply on its page count', async () => {
  const h = await harness()
  // No rule of any kind is on; page 1 shows 40 replies before the send.
  const thread = h.thread('100', 40)
  await h.read('100', 1)
  const id = h.intent({ kind: 'reply', threadId: '100' })
  const postId = h.posted('100')
  // Others reply before the confirmation; one quotes an earlier post (not counted). A read of
  // page 1 meanwhile sees 60 replies but not the sent one.
  h.peers(thread, 19, { 45: [postId], 50: [replyId('100', 5)], 58: [postId] })
  await h.read('100', 1)
  h.confirm(id, postId, '100')
  expect(h.position('100')).toEqual({ baseline: 40, checked_post_id: postId })
  await h.check()
  // Reply 41 is on page 3 and the last page is 4: page 1 for the count, then pages 3 and 4.
  expect(await h.count('100')).toBe(2)
  expect(h.pages).toEqual([1, 3, 4])
  expect(h.refs).toEqual([])
})

it('starts at a page known to hold the sent reply, read before or after the confirmation, over an older pre-send count', async () => {
  const h = await harness()
  const threads = ['100', '200'].map((id) => h.thread(id, 5))
  for (const [index, id] of ['100', '200'].entries()) {
    // The pre-send count is 5 (page 1), but 35 more replies arrive unread before the send.
    await h.read(id, 1)
    h.peers(threads[index]!, 35)
  }
  const early = h.intent({ kind: 'reply', threadId: '100' })
  const earlyPost = h.posted('100')
  await h.read('100', 3)
  h.confirm(early, earlyPost, '100')
  const late = h.send('200')
  expect(h.position('200')).toEqual({ baseline: 5, checked_post_id: late.postId })
  await h.read('200', 3)
  for (const [index, [id, postId]] of ([['100', earlyPost], ['200', late.postId]] as const).entries()) {
    expect(h.position(id)).toEqual({ baseline: 38, checked_post_id: postId })
    h.peers(threads[index]!, 1, { 42: [postId] })
  }
  await h.check()
  expect(await h.count('100')).toBe(1)
  expect(await h.count('200')).toBe(1)
  // Each thread: page 1, then page 3 only.
  expect(h.pages).toEqual([1, 3, 1, 3])
})

it('without any count before the send, a page holding the reply saved before the first check still sets its start; with neither, the first check sets it', async () => {
  const h = await harness()
  // Neither thread was read before its send: no pre-send count, no saved page.
  const known = h.thread('100', 40)
  const unknown = h.thread('200', 40)
  const first = h.send('100')
  const second = h.send('200')
  // The read after sending finds the reply in thread 100 only.
  await h.read('100', 3)
  h.peers(known, 1, { 42: [first.postId] })
  h.peers(unknown, 1, { 42: [second.postId] })
  await h.check()
  expect(await h.count('100')).toBe(1)
  // Thread 200 starts like a rule the user enabled: its first check reads the last page and counts nothing.
  expect(await h.count('200')).toBe(0)
  expect(h.position('200').checked_post_id).toBe(replyId('200', 42))
  expect(h.pages).toEqual([1, 3, 1, 3])
})

it('a send reported successful without its number turns nothing on; confirmed later, the rule starts at that reply', async () => {
  const h = await harness()
  const thread = h.thread('100', 40)
  await h.read('100', 1)
  const id = h.intent({ kind: 'reply', threadId: '100' })
  const postId = h.posted('100')
  h.unconfirmed(id)
  expect(h.quote('100').enabled).toBe(false)
  h.peers(thread, 1, { 42: [postId] })
  h.confirm(id, postId, '100')
  expect(h.quote('100')).toMatchObject({ enabled: true, source: 'auto' })
  expect(h.expiresAt('100')).toBe(week(h.sentAt(id)))
  await h.check()
  expect(await h.count('100')).toBe(1)
  expect(h.pages).toEqual([1, 3])
})

// Expiry and closing. Each thread below has 40 replies read before the send, so the sent reply is
// 41 on page 3 and a check reads pages 1 and 3.

it('past its expiry, the next check reads the thread first, then closes the rule as automatic; a later send enables it again', async () => {
  const h = await harness()
  const thread = h.thread('100', 40)
  await h.read('100', 1)
  h.send('100')
  await h.check()
  h.advance(WEEK)
  // Expired, but nothing closes before a check.
  expect(h.quote('100')).toMatchObject({ enabled: true, source: 'auto' })
  h.peers(thread, 1)
  await h.check()
  expect(h.pages).toEqual([1, 3])
  expect(h.quote('100')).toMatchObject({ enabled: false, closedBy: 'auto' })
  expect(await h.count('100')).toBeNull()
  const generation = h.generation('100')
  const again = h.send('100')
  expect(h.quote('100')).toMatchObject({ enabled: true, source: 'auto', closedBy: null })
  expect(h.expiresAt('100')).toBe(week(h.sentAt(again.id)))
  expect(h.generation('100')).toBe(generation + 1)
})

it('a final check that fails or is rate limited keeps the rule; the next one that completes closes it', async () => {
  const h = await harness()
  h.thread('100', 40)
  await h.read('100', 1)
  h.send('100')
  h.advance(WEEK)
  for (const failing of ['error', 'limit'] as const) {
    h.remote.failing = failing
    await h.check()
    expect(h.quote('100')).toMatchObject({ enabled: true, source: 'auto' })
  }
  h.remote.failing = null
  await h.check()
  expect(h.pages).toEqual([1, 3])
  expect(h.quote('100')).toMatchObject({ enabled: false, closedBy: 'auto' })
})

it('a count at expiry keeps the rule checked as usual until the thread is opened; an open before the final check closes nothing', async () => {
  const h = await harness()
  const threads = ['100', '200'].map((id) => h.thread(id, 40))
  for (const id of ['100', '200']) await h.read(id, 1)
  const [first, second] = ['100', '200'].map((id) => h.send(id))
  h.peers(threads[1]!, 1, { 42: [second!.postId] })
  await h.check()
  expect(await h.count('200')).toBe(1)
  h.advance(WEEK)
  h.peers(threads[0]!, 1, { 42: [first!.postId] })
  // Thread 200 is opened past its expiry, before its final check: cleared, still on.
  await h.open('200')
  expect(h.quote('200')).toMatchObject({ enabled: true, source: 'auto' })
  await h.check()
  // The final checks: thread 100 counts the quote and stays; thread 200 has nothing new and closes.
  expect(await h.count('100')).toBe(1)
  expect(h.quote('100')).toMatchObject({ enabled: true, source: 'auto' })
  expect(h.quote('200')).toMatchObject({ enabled: false, closedBy: 'auto' })
  h.peers(threads[0]!, 1, { 43: [first!.postId] })
  await h.check()
  expect(h.pages).toEqual([1, 3])
  expect(await h.count('100')).toBe(2)
  expect(h.quote('100').enabled).toBe(true)
  await h.open('100')
  expect(h.quote('100')).toMatchObject({ enabled: false, closedBy: 'auto' })
})

it('started again more than seven days after quitting, an expired rule is checked once before it closes', async () => {
  const h = await harness()
  const thread = h.thread('100', 40)
  await h.read('100', 1)
  h.send('100')
  await h.check()
  await h.restart()
  h.advance(8 * 24 * 60 * 60 * 1000)
  expect(h.quote('100')).toMatchObject({ enabled: true, source: 'auto' })
  h.peers(thread, 1)
  await h.check()
  expect(h.pages).toEqual([1, 3])
  expect(h.quote('100')).toMatchObject({ enabled: false, closedBy: 'auto' })
})

it('turning the setting off closes automatic rules without a count at once, those with a count once opened; the user’s rules and other kinds stay', async () => {
  const h = await harness()
  const threads = ['100', '200', '300'].map((id) => h.thread(id, 40))
  for (const id of ['100', '200', '300']) await h.read(id, 1)
  const at = new Date(t0).toISOString()
  h.db.setReminderRule('100', 'all', true, at)
  h.db.setReminderRule('300', 'quote', true, at)
  const [, second] = ['100', '200'].map((id) => h.send(id))
  h.peers(threads[1]!, 1, { 42: [second!.postId] })
  await h.check()
  expect(await h.count('200')).toBe(1)

  h.db.saveSettings({ ...DEFAULT_SETTINGS, reminderAutoQuote: false })
  expect(h.db.getReminderRules(['100'])[0]!.rules).toMatchObject({ all: { enabled: true }, quote: { enabled: false, closedBy: 'auto' } })
  expect(h.quote('200')).toMatchObject({ enabled: true, source: 'auto' })
  expect(h.quote('300')).toMatchObject({ enabled: true, source: 'user' })
  await h.open('300')
  expect(h.quote('300')).toMatchObject({ enabled: true, source: 'user' })
  await h.open('200')
  expect(h.quote('200')).toMatchObject({ enabled: false, closedBy: 'auto' })

  // Closed by the app, not by the user: back on, the next send enables it again.
  h.db.saveSettings({ ...DEFAULT_SETTINGS })
  h.send('100')
  expect(h.quote('100')).toMatchObject({ enabled: true, source: 'auto' })
})

// Reply 42 below quotes post 999, unknown here; the forum cannot return it, so the quote stays unverified.

it('a final check whose quoted post cannot be read is not complete: opening the thread before the next check closes nothing', async () => {
  const h = await harness()
  const thread = h.thread('100', 40)
  await h.read('100', 1)
  h.send('100')
  h.advance(WEEK)
  h.peers(thread, 1, { 42: ['999'] })
  await h.check()
  expect(h.refs).toEqual(['999'])
  expect(await h.unverified('100')).toBe(1)
  expect(h.quote('100')).toMatchObject({ enabled: true, source: 'auto' })
  await h.open('100')
  expect(h.quote('100')).toMatchObject({ enabled: true, source: 'auto' })
  await h.check()
  expect(h.quote('100')).toMatchObject({ enabled: false, closedBy: 'auto' })
})

it('an unverified quote is not a count: turning the setting off closes the rule at once', async () => {
  const h = await harness()
  const thread = h.thread('100', 40)
  await h.read('100', 1)
  h.send('100')
  h.peers(thread, 1, { 42: ['999'] })
  await h.check()
  expect(await h.count('100')).toBe(0)
  expect(await h.unverified('100')).toBe(1)
  h.db.saveSettings({ ...DEFAULT_SETTINGS, reminderAutoQuote: false })
  expect(h.quote('100')).toMatchObject({ enabled: false, closedBy: 'auto' })
})

it('the whole cycle: a send turns 引用我 on as automatic, only others’ quotes count, opening clears, the final check after expiry closes it, a new send turns it on again', async () => {
  const h = await harness()
  const thread = h.thread('100', 40)
  await h.read('100', 1)
  const first = h.send('100')
  expect((await h.row('100'))?.rules.quote).toMatchObject({ enabled: true, source: 'auto' })

  // 42: someone else quotes the sent reply. 43: the user, from the web under an imported cookie,
  // quotes it. 44: the user's next reply from this app quotes it (and renews the rule).
  h.peers(thread, 1, { 42: [first.postId] })
  thread.mine.add(++thread.count)
  thread.quotes.set(43, [first.postId])
  thread.quotes.set(44, [first.postId])
  const second = h.send('100')
  expect(second.postId).toBe(replyId('100', 44))
  expect(h.expiresAt('100')).toBe(week(h.sentAt(second.id)))
  await h.check()
  expect(await h.count('100')).toBe(1)
  expect(await h.unverified('100')).toBe(0)
  expect(h.pages).toEqual([1, 3])
  expect(h.refs).toEqual([])

  // Opened before the final check: cleared, still on and listed as automatic.
  await h.open('100')
  expect((await h.row('100'))?.counts.quote).toBe(0)
  expect((await h.row('100'))?.rules.quote).toMatchObject({ enabled: true, source: 'auto' })

  h.advance(WEEK)
  h.peers(thread, 1)
  await h.check()
  expect(h.pages).toEqual([1, 3])
  expect(h.quote('100')).toMatchObject({ enabled: false, closedBy: 'auto' })
  expect(await h.row('100')).toBeNull()

  const again = h.send('100')
  expect((await h.row('100'))?.rules.quote).toMatchObject({ enabled: true, source: 'auto' })
  expect(h.expiresAt('100')).toBe(week(h.sentAt(again.id)))
})
