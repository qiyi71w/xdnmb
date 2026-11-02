import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import type { ThreadReadPurpose } from '../src/shared/api'
import { EMPTY_FIELDS } from '../src/shared/drafts'
import type { ReadingMode } from '../src/shared/forum'
import { createDraftService } from '../src/main/drafts/service'
import { createForumClient } from '../src/main/forum/client'
import { createForumTransport } from '../src/main/forum/transport'
import { openManagedImageFiles } from '../src/main/images/files'
import { createPublicationAdapter } from '../src/main/publication/adapter'
import { createPublicationService } from '../src/main/publication/service'
import { createReadingService } from '../src/main/reading/service'
import { createRequestScheduler } from '../src/main/reading/scheduler'
import { createReminderService } from '../src/main/reminders/service'
import { openReadingDatabase } from '../src/main/storage/database'
import { MIGRATIONS } from '../src/main/storage/migrations'
import { asStore } from './helpers/store'

// A reply sent from this app leaves the 全串／PO reminder count only when two reads place it in
// uncleared counted growth: the largest reply count committed before its send intent, and the
// smallest count of a page seen holding it. Real SQLite, a controlled local forum, and the real
// publication, reading and reminder services. Peers write as `Peer`; the head is the PO's.

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean() })
const t0 = Date.parse('2026-10-30T04:00:00.000Z')
const at = new Date(t0).toISOString()
const NOTICE = '1 个串有新提醒'

interface ForumPost {
  id: string; resto: string; fid: string; user_hash: string; content: string; title: string; name: string
  img: string; ext: string; now: string; admin: number; sage: number
}

function post(id: string, author: string, content = 'reply'): ForumPost {
  return { id, resto: '100', fid: '1', user_hash: author, content, title: '', name: '', img: '', ext: '',
    now: '2026-10-30(五)12:00:00', admin: 0, sage: 0 }
}

type SendWait = 'confirmed' | 'unknown' | 'lookup-held' | 'post-held'

async function harness(options: { own?: 'Po' | 'Other'; initialCount?: number; afterSendMs?: number | null } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-own-reminders-'))
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }))
  const path = join(folder, 'app.sqlite')
  let db = openReadingDatabase(path)
  cleanups.push(() => db.close())
  const author = options.own ?? 'Po'
  const credential = db.insertCredential({ name: 'synthetic', cookieId: author, source: 'raw', importedAt: at, ciphertext: Buffer.from(author) }).id
  const files = await openManagedImageFiles(join(folder, 'draft-images'))
  const replies = Array.from({ length: options.initialCount ?? 10 }, (_, index) => post(String(1000 + index), 'Peer'))
  let next = 3000
  let last: ForumPost | null = null
  /** Subtracted from the 全串 ReplyCount: the forum's count falls. */
  let drop = 0
  let holdLookup = false
  let lookupRelease: (() => void) | null = null
  let holdPost = false
  let postRelease: (() => void) | null = null
  let loseResponse = false
  let holdSnapshot = false
  let snapshotRelease: (() => void) | null = null
  let snapshotCaptured = Promise.withResolvers<void>()
  /** Replies the forum leaves off its pages; the reply count still includes them. */
  const hidden = new Set<string>()
  /** The next read of this page fails with an HTTP error. */
  let failing: string | null = null
  const hooks: { afterBatch?: () => Promise<void> } = {}
  const requests: string[] = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://local')
    requests.push(`${url.pathname}${url.search}`)
    const send = (value: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
    if (url.pathname === '/api/getForumList') { send([{ id: '1', name: 'test', forums: [{ id: '1', name: 'test', msg: '', interval: 0 }] }]); return }
    if (url.pathname === '/api/getTimelineList') { send([]); return }
    if (url.pathname === '/api/thread' || url.pathname === '/api/po') {
      const po = url.pathname === '/api/po'
      const items = po ? replies.filter((reply) => reply.user_hash === 'Po') : replies
      const page = Number(url.searchParams.get('page'))
      if (failing === `${url.pathname}?page=${page}`) {
        failing = null
        response.statusCode = 500
        response.end()
        return
      }
      const value = { ...post('100', 'Po', 'head'), resto: '0', ReplyCount: items.length - (po ? 0 : drop),
        Replies: items.slice((page - 1) * 19, page * 19).filter((reply) => !hidden.has(reply.id)) }
      if (holdSnapshot && !po) {
        holdSnapshot = false
        snapshotRelease = () => send(value)
        snapshotCaptured.resolve()
      } else send(value)
      return
    }
    if (url.pathname === '/Home/Forum/doReplyThread.html') {
      let body = ''
      for await (const chunk of request) body += String(chunk)
      const content = /name="content"\r\n\r\n([\s\S]*?)\r\n--/.exec(body)?.[1]
      if (content === undefined) throw new Error('missing multipart content')
      const accept = () => {
        last = post(String(++next), author, content)
        replies.push(last)
        if (loseResponse) { loseResponse = false; request.socket.destroy(); return }
        response.setHeader('Content-Type', 'text/html')
        response.end('<p class="success">成功</p>')
      }
      if (holdPost) { holdPost = false; postRelease = accept } else accept()
      return
    }
    if (url.pathname === '/Api/getLastPost') {
      if (holdLookup) { lookupRelease = () => send(last); return }
      send(last); return
    }
    if (url.pathname === '/api/ref') { send(replies.find((reply) => reply.id === url.searchParams.get('id')) ?? null); return }
    response.statusCode = 404
    response.end()
  })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', listening.resolve)
  await listening.promise
  cleanups.push(async () => {
    server.closeAllConnections()
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    await closed.promise
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('listen failed')
  const origin = `http://127.0.0.1:${address.port}`
  const notifications: string[] = []
  let monotonic = 0
  let wall = t0
  /** One clock for every service: each reading is a second later than the one before. */
  const tick = () => new Date(wall += 1000)
  const clientFor = (userhash: string | null) => createForumClient({ baseUrl: origin, browseIdentity: async () => userhash,
    transport: createForumTransport({ allowedOrigins: [origin], credentialOrigins: [origin] }) })
  const protector = { isAvailable: async () => true, encrypt: async (value: string) => Buffer.from(value), decrypt: async (value: Uint8Array) => Buffer.from(value).toString() }
  const signal = new AbortController().signal
  const start = async (onRecover = false) => {
    const store = asStore(db)
    const reminders = createReminderService({ store, client: clientFor(null), scheduler: createRequestScheduler({ backgroundSpacingMs: 0 }),
      afterBatch: async () => { await hooks.afterBatch?.() },
      now: () => tick().toISOString(), monotonicNow: () => monotonic, notifier: { show(message) { notifications.push(message.body); return true } } })
    const reading = createReadingService({ client: clientFor(null), store, scheduler: createRequestScheduler({ backgroundSpacingMs: 0 }),
      now: tick, displayReads: reminders.displayReads })
    const drafts = createDraftService({ store, files })
    const publication = createPublicationService({ store, drafts, files, protector, clientFor: (hash) => clientFor(hash),
      adapter: createPublicationAdapter({ origin, apiOrigin: origin }), now: tick,
      checks: { afterSendMs: options.afterSendMs ?? null, onRecover, gapMs: 0 },
      onRecorded: () => reminders.publicationConfirmed(), onChecked: () => reminders.publicationConfirmed() })
    await drafts.recover()
    await publication.recover()
    return { reminders, reading, publication }
  }
  let current = await start()
  cleanups.push(() => current.reminders.stop('quit'))
  db.setReminderRule('100', 'all', true, at)
  db.setReminderRule('100', 'po', true, at)
  async function check() {
    monotonic += 60_000
    requests.length = 0
    expect((await current.reminders.check()).accepted).toBe(true)
    await current.reminders.whenIdle()
  }
  async function row() {
    const result = await current.reminders.overview()
    if (!result.ok) throw new Error('overview failed')
    return result.overview.threads.find((thread) => thread.threadId === '100')!
  }
  await check()
  return {
    get db() { return db }, get reminders() { return current.reminders },
    path, requests, notifications, row, check, hooks,
    counts: async () => (await row()).counts,
    peer(by = 'Peer') { const value = post(String(++next), by, 'peer reply'); replies.push(value); return value.id },
    setDrop(value: number) { drop = value },
    /** The forum loses its `n` oldest replies: every later count is `n` lower. */
    remove(n: number) { replies.splice(0, n) },
    /** The forum's pages stop (`hide`) or resume (`show`) showing this reply. */
    hide(id: string) { hidden.add(id) },
    show(id: string) { hidden.delete(id) },
    /** The next read of `/api/thread` or `/api/po` page `page` fails. */
    failNext(path: '/api/thread' | '/api/po', page: number) { failing = `${path}?page=${page}` },
    postId(id: string) { return db.getPublication(id)!.postId! },
    /** Moves the shared clock: later reads carry fetch times out of their commit order. */
    shiftClock(ms: number) { wall += ms },
    holdConfirmation() { holdLookup = true },
    releaseConfirmation() { holdLookup = false; lookupRelease?.() },
    holdPost() { holdPost = true },
    releasePost() { postRelease?.() },
    loseNextResponse() { loseResponse = true },
    async send(content = 'own reply', wait: SendWait = 'confirmed') {
      const result = await current.publication.submit({ requestId: randomUUID(), editorId: 'editor',
        payload: { draftId: null, target: { kind: 'reply', threadId: '100' }, credentialId: credential,
          fields: { ...EMPTY_FIELDS, content }, attachmentId: null } })
      if (result.kind !== 'attempt') throw new Error(`submission refused: ${JSON.stringify(result)}`)
      if (wait === 'confirmed' || wait === 'unknown') await expect.poll(() => db.getPublication(result.attempt.id)?.state).toBe(wait)
      else if (wait === 'lookup-held') await expect.poll(() => lookupRelease !== null).toBe(true)
      else await expect.poll(() => postRelease !== null).toBe(true)
      return result.attempt.id
    },
    async confirmed(id: string) { await expect.poll(() => db.getPublication(id)?.state).toBe('confirmed') },
    async read(mode: ReadingMode, page: number, purpose: ThreadReadPurpose) {
      expect(await current.reading.readThreadPage('100', mode, page, signal, purpose)).toMatchObject({ status: 'fresh' })
    },
    async locateEnd(mode: ReadingMode, purpose: ThreadReadPurpose) {
      expect(await current.reading.locateThreadEnd('100', mode, signal, purpose)).toMatchObject({ status: 'fresh' })
    },
    holdNextSnapshot() { holdSnapshot = true; snapshotCaptured = Promise.withResolvers<void>(); return snapshotCaptured.promise },
    releaseSnapshot() { snapshotRelease?.() },
    beginCheck() { monotonic += 60_000; return current.reminders.check() },
    async restart(onRecover = false) { await current.reminders.stop('quit'); db.close(); db = openReadingDatabase(path); current = await start(onRecover) },
    sql<T>(run: (connection: Database.Database) => T): T { const connection = new Database(path); try { return run(connection) } finally { connection.close() } }
  }
}

it('long thread, only my reply: the post-send read proves it and the next check counts 0, reading only page 1', async () => {
  const h = await harness({ initialCount: 200 })
  await h.read('all', 11, 'display')
  await h.send()
  // Sending then locating the reply reads the last page, 201 replies, with the reply on it.
  await h.locateEnd('all', 'display')
  await h.check()
  expect(await h.counts()).toEqual({ all: 0, po: 0, quote: 0 })
  expect(h.notifications).toEqual([])
  expect(h.requests).toEqual(['/api/thread?id=100&page=1', '/api/po?id=100&page=1'])
})

it('sent and left at once while peers replied: one follow-up page finds the reply, the peers still count and notify', async () => {
  const h = await harness({ initialCount: 200 })
  await h.send()
  h.peer(); h.peer()
  await h.check()
  // Page 1 reads 203; the page holding reply 201 shows mine, so this check counts to its 203.
  expect(await h.counts()).toEqual({ all: 2, po: 0, quote: 0 })
  expect(h.notifications).toEqual([NOTICE])
  expect(h.requests).toEqual(['/api/thread?id=100&page=1', '/api/thread?id=100&page=11', '/api/po?id=100&page=1'])
  h.peer()
  await h.check()
  expect(await h.counts()).toEqual({ all: 3, po: 0, quote: 0 })
  expect(h.requests).toEqual(['/api/thread?id=100&page=1', '/api/po?id=100&page=1'])
})

it('peers on both sides of my reply after an open: the follow-up page leaves exactly the peers', async () => {
  const h = await harness({ initialCount: 199 })
  h.peer()
  // The reader's read absorbs 199→200; the check growth after it holds two peers and my reply.
  await h.read('all', 11, 'display')
  h.peer()
  await h.send()
  h.peer()
  await h.check()
  // PO page 1 already shows my PO-cookie reply: its PO growth is mine alone, with no extra PO read.
  expect(await h.counts()).toEqual({ all: 2, po: 0, quote: 0 })
  expect(h.notifications).toEqual([NOTICE])
  expect(h.requests).toEqual(['/api/thread?id=100&page=1', '/api/thread?id=100&page=11', '/api/po?id=100&page=1'])
})

it('a follow-up page without my reply counts it as usual, once: no later check reads for it, no later page deducts it', async () => {
  const h = await harness({ initialCount: 200 })
  const id = await h.send()
  h.hide(h.postId(id))
  h.peer()
  await h.check()
  // PO page 1 is the follow-up page of the PO count and does not show it either.
  expect(await h.counts()).toEqual({ all: 2, po: 1, quote: 0 })
  expect(h.notifications).toEqual([NOTICE])
  expect(h.requests).toEqual(['/api/thread?id=100&page=1', '/api/thread?id=100&page=11', '/api/po?id=100&page=1'])
  await h.check()
  expect(h.requests).toEqual(['/api/thread?id=100&page=1', '/api/po?id=100&page=1'])
  h.show(h.postId(id))
  await h.read('all', 11, 'lookup')
  expect(await h.counts()).toEqual({ all: 2, po: 1, quote: 0 })
})

it('a failed follow-up read uses the reply’s chance: page 1 still counts, and only other evidence can settle it', async () => {
  const h = await harness({ initialCount: 200 })
  await h.send()
  h.peer()
  h.failNext('/api/thread', 11)
  await h.check()
  expect(await h.counts()).toEqual({ all: 2, po: 0, quote: 0 })
  expect(h.notifications).toEqual([NOTICE])
  expect(h.requests).toEqual(['/api/thread?id=100&page=1', '/api/thread?id=100&page=11', '/api/po?id=100&page=1'])
  await h.check()
  expect(h.requests).toEqual(['/api/thread?id=100&page=1', '/api/po?id=100&page=1'])
  // Still pending: a later page showing it inside the counted growth (200, 202] deducts it.
  await h.read('all', 11, 'lookup')
  expect(await h.counts()).toEqual({ all: 1, po: 0, quote: 0 })
})

it('a PO-cookie reply gets a follow-up PO page too; a non-PO reply never causes a PO page read', async () => {
  for (const own of ['Po', 'Other'] as const) {
    const h = await harness({ own, initialCount: 200 })
    for (let n = 0; n < 20; n++) h.peer('Po')
    await h.check()
    await h.reminders.clear({ threadId: '100', source: 'manual' })
    await h.send()
    h.peer()
    h.peer('Po')
    await h.check()
    if (own === 'Po') {
      // 全串 220→223 and PO 20→22 each hold my reply once: the follow-up pages are 12 and PO page 2.
      expect(await h.counts()).toEqual({ all: 2, po: 1, quote: 0 })
      expect(h.requests).toEqual(['/api/thread?id=100&page=1', '/api/thread?id=100&page=12', '/api/po?id=100&page=1', '/api/po?id=100&page=2'])
    } else {
      expect(await h.counts()).toEqual({ all: 2, po: 1, quote: 0 })
      expect(h.requests).toEqual(['/api/thread?id=100&page=1', '/api/thread?id=100&page=12', '/api/po?id=100&page=1'])
    }
  }
})

it('without pending local replies a check reads page 1 of each mode only', async () => {
  const h = await harness({ initialCount: 200 })
  h.peer(); h.peer('Po')
  await h.check()
  expect(await h.counts()).toEqual({ all: 2, po: 1, quote: 0 })
  expect(h.requests).toEqual(['/api/thread?id=100&page=1', '/api/po?id=100&page=1'])
})

it('no follow-up page when an open already absorbed part of the interval: finding the reply could not deduct it', async () => {
  const h = await harness({ initialCount: 200 })
  const id = await h.send()
  h.hide(h.postId(id))
  h.peer()
  // The reader absorbs 200→202 without seeing my reply.
  await h.read('all', 1, 'display')
  h.show(h.postId(id))
  h.peer()
  await h.check()
  expect(await h.counts()).toEqual({ all: 1, po: 0, quote: 0 })
  expect(h.requests).toEqual(['/api/thread?id=100&page=1', '/api/po?id=100&page=1'])
})

it('a reply with a non-PO cookie never touches the PO count; a peer PO reply still counts', async () => {
  const h = await harness({ own: 'Other' })
  await h.send()
  h.peer('Po')
  await h.check()
  expect(await h.counts()).toEqual({ all: 1, po: 1, quote: 0 })
  expect(h.notifications).toEqual([NOTICE])
})

it('an unknown sending 饼干 ID is not related to PO: only the 全串 count drops the reply', async () => {
  const h = await harness()
  h.sql((connection) => connection.exec('UPDATE credentials SET cookie_id = NULL'))
  await h.send()
  await h.check()
  expect(await h.counts()).toEqual({ all: 0, po: 1, quote: 0 })
  expect(h.notifications).toEqual([NOTICE])
})

it('a check reading page 1 while the send is unconfirmed is corrected once the reply confirms, from that saved page', async () => {
  const h = await harness()
  h.holdConfirmation()
  const id = await h.send('in flight', 'lookup-held')
  await h.check()
  // Unconfirmed replies take no part.
  expect(await h.counts()).toEqual({ all: 1, po: 1, quote: 0 })
  expect(h.notifications).toEqual([NOTICE])
  h.releaseConfirmation()
  await h.confirmed(id)
  expect(await h.counts()).toEqual({ all: 0, po: 0, quote: 0 })
  h.peer()
  await h.check()
  expect(await h.counts()).toEqual({ all: 1, po: 0, quote: 0 })
})

it('growth cleared before the proof is never negative and never taken from later growth', async () => {
  const h = await harness()
  h.holdConfirmation()
  const id = await h.send('clear before confirmation', 'lookup-held')
  await h.check()
  await h.reminders.clear({ threadId: '100', source: 'manual' })
  h.releaseConfirmation()
  await h.confirmed(id)
  expect(await h.counts()).toEqual({ all: 0, po: 0, quote: 0 })
  h.peer()
  h.peer('Po')
  await h.check()
  expect(await h.counts()).toEqual({ all: 2, po: 1, quote: 0 })
})

it('a reader’s absorption inside the interval leaves an ordinary count, never taking a peer', async () => {
  const h = await harness({ initialCount: 30 })
  h.holdPost()
  const id = await h.send('sent while a peer replied', 'post-held')
  h.peer()
  await h.read('all', 2, 'display')
  h.releasePost()
  await h.confirmed(id)
  h.peer()
  await h.check()
  // (30, 33] mixes the reader's absorption 30→31 with counted growth 31→33: unprovable.
  await h.read('all', 2, 'display')
  expect(await h.counts()).toEqual({ all: 2, po: 0, quote: 0 })
})

it('spanning two check rounds deducts once and keeps the earlier peer in the count', async () => {
  const h = await harness()
  h.peer()
  const captured = h.holdNextSnapshot()
  await h.beginCheck()
  await captured
  await h.send()
  h.releaseSnapshot()
  await h.reminders.whenIdle()
  expect(await h.counts()).toEqual({ all: 1, po: 0, quote: 0 })
  await h.check()
  expect(await h.counts()).toEqual({ all: 1, po: 0, quote: 0 })
  // Which round holds my reply is unknown, so the later round still decides its notification.
  expect(h.notifications).toEqual([NOTICE, NOTICE])
})

it('a pending reply survives a restart, a duplicate confirmation deducts nothing more', async () => {
  const h = await harness({ initialCount: 30 })
  const id = await h.send()
  // The check's follow-up read of page 2 fails: the reply stays pending, its chance used.
  h.failNext('/api/thread', 2)
  await h.check()
  expect(await h.counts()).toEqual({ all: 1, po: 0, quote: 0 })
  await h.restart()
  await h.read('all', 2, 'lookup')
  expect(await h.counts()).toEqual({ all: 0, po: 0, quote: 0 })
  const attempt = h.db.getPublication(id)!
  h.db.finishPublication({ id, state: 'confirmed', problem: null, postId: attempt.postId, threadId: '100', at })
  await h.restart()
  await h.read('all', 2, 'lookup')
  h.peer()
  await h.check()
  expect(await h.counts()).toEqual({ all: 1, po: 0, quote: 0 })
  expect(h.notifications).toEqual([NOTICE, NOTICE])
})

it('a reply whose intent came before the rule generation is not deducted in it', async () => {
  const h = await harness({ initialCount: 30 })
  h.holdPost()
  const id = await h.send('old generation', 'post-held')
  for (const kind of ['all', 'po'] as const) { h.db.setReminderRule('100', kind, false, at); h.db.setReminderRule('100', kind, true, at) }
  await h.check()
  h.releasePost()
  await h.confirmed(id)
  await h.check()
  await h.read('all', 2, 'display')
  expect(await h.counts()).toEqual({ all: 1, po: 1, quote: 0 })
})

it('a falling reply count voids pending evidence, including a page saved before confirmation', async () => {
  const h = await harness({ initialCount: 30 })
  h.holdConfirmation()
  const id = await h.send('before the count fell', 'lookup-held')
  await h.check()
  // Page 2 (31 replies) holding the reply is saved while it is still unconfirmed.
  await h.read('all', 2, 'lookup')
  h.setDrop(2)
  await h.check()
  h.setDrop(0)
  h.releaseConfirmation()
  await h.confirmed(id)
  await h.check()
  // 全串: 1 before the fall, then 29→31 not taken from; the PO count never fell and drops my reply.
  expect(await h.counts()).toEqual({ all: 3, po: 0, quote: 0 })
})

it('a fall still above the baseline voids pending evidence; an older, larger page cannot prove across it', async () => {
  const h = await harness({ initialCount: 30 })
  h.peer(); h.peer(); h.peer()
  await h.read('all', 2, 'lookup')
  h.holdConfirmation()
  const id = await h.send('before the fall', 'lookup-held')
  // Page 2 (34 replies) holds the reply while it is unconfirmed; then page 1 reads 32, above the baseline 30.
  await h.read('all', 2, 'lookup')
  h.remove(2)
  await h.read('all', 1, 'lookup')
  h.releaseConfirmation()
  await h.confirmed(id)
  h.peer(); h.peer()
  await h.check()
  expect(await h.counts()).toEqual({ all: 4, po: 0, quote: 0 })
  await h.restart()
  await h.read('all', 2, 'lookup')
  expect(await h.counts()).toEqual({ all: 4, po: 0, quote: 0 })
})

it('a lower count committed later is a fall even when it was fetched earlier', async () => {
  const h = await harness({ initialCount: 30 })
  h.holdConfirmation()
  const id = await h.send('fetched out of order', 'lookup-held')
  await h.read('all', 2, 'lookup')
  h.remove(1)
  h.shiftClock(-3_600_000)
  await h.read('all', 1, 'lookup')
  h.shiftClock(7_200_000)
  h.releaseConfirmation()
  await h.confirmed(id)
  h.peer()
  await h.check()
  expect(await h.counts()).toEqual({ all: 1, po: 0, quote: 0 })
})

it('the pre-send count follows commit order: a later-fetched larger page committed before a fall is not used', async () => {
  const h = await harness({ initialCount: 30 })
  h.peer(); h.peer(); h.peer(); h.peer()
  h.shiftClock(3_600_000)
  await h.read('all', 2, 'lookup')
  // Fetched earlier, committed later: 32 is a fall from 34, and the observation the next send reads.
  h.shiftClock(-7_200_000)
  h.remove(2)
  await h.read('all', 1, 'lookup')
  h.shiftClock(7_200_000)
  await h.send()
  await h.check()
  // (32, 33] is counted growth alone: the follow-up page 2 shows the reply and it leaves the count.
  expect(await h.counts()).toEqual({ all: 2, po: 0, quote: 0 })
  expect(h.requests).toEqual(['/api/thread?id=100&page=1', '/api/thread?id=100&page=2', '/api/po?id=100&page=1'])
})

it('after a fall a new send is provable again, also across reopening the database', async () => {
  const h = await harness({ initialCount: 30 })
  h.peer(); h.peer(); h.peer()
  await h.read('all', 2, 'lookup')
  h.remove(2)
  await h.read('all', 1, 'lookup')
  await h.restart()
  await h.send()
  // The check's follow-up read fails; a lookup after reopening proves the reply instead.
  h.failNext('/api/thread', 2)
  await h.check()
  // 30→32: the peer seen in the lookups and my reply.
  expect(await h.counts()).toEqual({ all: 2, po: 0, quote: 0 })
  await h.restart()
  await h.read('all', 2, 'lookup')
  expect(await h.counts()).toEqual({ all: 1, po: 0, quote: 0 })
})

it.each(['marker', 'count', 'segment'] as const)('a failed %s write rolls back the whole deduction and is applied once after reopening', async (failure) => {
  const h = await harness()
  await h.send()
  const triggers = {
    marker: "CREATE TRIGGER fail_reminder BEFORE UPDATE OF status ON reminder_local_replies WHEN NEW.status = 'excluded' BEGIN SELECT RAISE(ABORT, 'marker failure'); END;",
    count: 'CREATE TRIGGER fail_reminder BEFORE UPDATE OF count ON reminder_state WHEN NEW.count < OLD.count BEGIN SELECT RAISE(ABORT, \'count failure\'); END;',
    segment: 'CREATE TRIGGER fail_reminder BEFORE UPDATE OF excluded ON reminder_baseline_segments BEGIN SELECT RAISE(ABORT, \'segment failure\'); END;'
  }
  h.sql((connection) => connection.exec(triggers[failure]))
  await h.check()
  expect(await h.counts()).toEqual({ all: 0, po: 0, quote: 0 })
  expect(h.notifications).toEqual([])
  await h.restart()
  expect(h.db.reminderStates().map((state) => state.baseline)).toEqual([10, 0])
  h.sql((connection) => connection.exec('DROP TRIGGER fail_reminder'))
  await h.check()
  expect(await h.counts()).toEqual({ all: 0, po: 0, quote: 0 })
  expect(h.notifications).toEqual([])
  h.peer()
  await h.check()
  expect(await h.counts()).toEqual({ all: 1, po: 0, quote: 0 })
})

it('a confirmation committed before the final decision suppresses an only-own notification', async () => {
  const h = await harness()
  h.holdConfirmation()
  const id = await h.send('confirm before notification', 'lookup-held')
  h.hooks.afterBatch = async () => {
    h.releaseConfirmation()
    await h.confirmed(id)
  }
  await h.check()
  expect(await h.counts()).toEqual({ all: 0, po: 0, quote: 0 })
  expect(h.notifications).toEqual([])
})

it('the startup publication check confirming an unknown send deducts it', async () => {
  const h = await harness()
  h.loseNextResponse()
  const id = await h.send('startup checked reply', 'unknown')
  await h.check()
  expect(await h.counts()).toEqual({ all: 1, po: 1, quote: 0 })
  await h.restart(true)
  await h.confirmed(id)
  expect(await h.counts()).toEqual({ all: 0, po: 0, quote: 0 })
  h.peer()
  await h.check()
  expect(await h.counts()).toEqual({ all: 1, po: 0, quote: 0 })
})

it('the background check after a lost response confirms the send and deducts it', async () => {
  const h = await harness({ afterSendMs: 300 })
  h.loseNextResponse()
  const id = await h.send('background checked reply', 'unknown')
  // The automatic check's read of page 1 waits until the reminder check has counted the reply.
  const captured = h.holdNextSnapshot()
  await captured
  await h.check()
  expect(await h.counts()).toEqual({ all: 1, po: 1, quote: 0 })
  h.releaseSnapshot()
  await h.confirmed(id)
  expect(await h.counts()).toEqual({ all: 0, po: 0, quote: 0 })
})

it('upgrades v21 without resetting generations, existing counts, confirmations or credentials', () => {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-reminder-migrate-'))
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }))
  const path = join(folder, 'app.sqlite')
  const old = new Database(path)
  for (const migration of MIGRATIONS.filter((migration) => migration.version <= 21)) migration.up(old)
  old.exec(`PRAGMA user_version = 21;
    INSERT INTO reminder_rules VALUES ('100', 'all', 1, 7, '${at}', NULL, '${at}');
    INSERT INTO reminder_state(thread_id, kind, baseline, count) VALUES ('100', 'all', 10, 4);`)
  old.prepare(`INSERT INTO credentials(id, name, source, imported_at, ciphertext, cookie_id) VALUES (1, 'old', 'raw', ?, ?, 'Po')`).run(at, Buffer.from('synthetic'))
  old.prepare(`INSERT INTO publication_attempts(request_id, editor_id, payload_json, credential_id, forum_id, state, created_at, updated_at, post_id, thread_id)
    VALUES ('old', 'old', ?, 1, '1', 'confirmed', ?, ?, '1009', '100')`).run(JSON.stringify({ target: { kind: 'reply', threadId: '100' } }), at, at)
  old.close()
  const db = openReadingDatabase(path)
  try {
    expect(db.status.state).toBe('ready')
    expect(db.reminderRuleSnapshots()).toEqual([{ threadId: '100', kind: 'all', generation: 7 }])
    expect(db.reminderOverview().threads[0]!.counts.all).toBe(4)
    expect(db.reminderStates()[0]!.baseline).toBe(10)
    expect(db.listPublications()[0]!.postId).toBe('1009')
    expect(db.listCredentials()[0]!.cookieId).toBe('Po')
    expect(Buffer.from(db.loadCredentialCiphertext('1')!)).toEqual(Buffer.from('synthetic'))
  } finally { db.close() }
})
