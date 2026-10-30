import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { EMPTY_FIELDS } from '../src/shared/drafts'
import { createDraftService } from '../src/main/drafts/service'
import { createForumClient } from '../src/main/forum/client'
import { createForumTransport } from '../src/main/forum/transport'
import { openManagedImageFiles } from '../src/main/images/files'
import { createPublicationAdapter } from '../src/main/publication/adapter'
import { createPublicationService } from '../src/main/publication/service'
import { createRequestScheduler } from '../src/main/reading/scheduler'
import { createReminderService } from '../src/main/reminders/service'
import { openReadingDatabase } from '../src/main/storage/database'
import { MIGRATIONS } from '../src/main/storage/migrations'
import { asStore } from './helpers/store'

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean() })
const at = '2026-10-30T04:00:00.000Z'

interface ForumPost {
  id: string; resto: string; fid: string; user_hash: string; content: string; title: string; name: string
  img: string; ext: string; now: string; admin: number; sage: number
}

function post(id: string, content = 'old', author = 'Po'): ForumPost {
  return { id, resto: '100', fid: '1', user_hash: author, content, title: '', name: '', img: '', ext: '',
    now: '2026-10-30(五)12:00:00', admin: 0, sage: 0 }
}

async function harness(options: { nonPo?: boolean; initialCount?: number } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-own-reminders-'))
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }))
  const path = join(folder, 'app.sqlite')
  let db = openReadingDatabase(path)
  cleanups.push(() => db.close())
  const author = options.nonPo ? 'Other' : 'Po'
  const credential = db.insertCredential({ name: 'synthetic', cookieId: author, source: 'raw', importedAt: at, ciphertext: Buffer.from(author) }).id
  const files = await openManagedImageFiles(join(folder, 'draft-images'))
  const replies = Array.from({ length: options.initialCount ?? 10 }, (_, index) => post(String(1000 + index)))
  const hidden = new Set<string>()
  let next = 3000
  let last: ForumPost | null = null
  let holdLookup = false
  let loseResponse = false
  const hooks: { afterBatch?: () => Promise<void> } = {}
  let lookupRelease: (() => void) | null = null
  let holdSnapshot = false
  let snapshotRelease: (() => void) | null = null
  let snapshotCaptured = Promise.withResolvers<void>()
  const requests: Array<{ path: string; cookie: string }> = []
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://local')
    requests.push({ path: `${url.pathname}${url.search}`, cookie: request.headers.cookie ?? '' })
    const send = (value: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
    if (url.pathname === '/api/getForumList') { send([{ id: '1', name: 'test', forums: [{ id: '1', name: 'test', msg: '', interval: 0 }] }]); return }
    if (url.pathname === '/api/getTimelineList') { send([]); return }
    if (url.pathname === '/api/thread' || url.pathname === '/api/po') {
      const items = url.pathname === '/api/po' ? replies.filter((reply) => reply.user_hash === 'Po') : replies
      const page = Number(url.searchParams.get('page'))
      const value = { ...post('100', 'head'), resto: '0', ReplyCount: items.length,
        Replies: items.slice((page - 1) * 19, page * 19).filter((reply) => !hidden.has(reply.id)) }
      if (holdSnapshot && !request.headers.cookie && url.pathname === '/api/thread') {
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
      last = post(String(++next), content, author)
      replies.push(last)
      if (loseResponse) { loseResponse = false; request.socket.destroy(); return }
      response.setHeader('Content-Type', 'text/html')
      response.end('<p class="success">成功</p>')
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
  const clientFor = (userhash: string | null) => createForumClient({ baseUrl: origin, browseIdentity: async () => userhash,
    transport: createForumTransport({ allowedOrigins: [origin], credentialOrigins: [origin] }) })
  const protector = { isAvailable: async () => true, encrypt: async (value: string) => Buffer.from(value), decrypt: async (value: Uint8Array) => Buffer.from(value).toString() }
  const start = async (onRecover = false) => {
    const store = asStore(db)
    const reminders = createReminderService({ store, client: clientFor(null), scheduler: createRequestScheduler({ backgroundSpacingMs: 0 }),
      afterBatch: async () => { await hooks.afterBatch?.() },
      now: () => at, monotonicNow: () => monotonic, notifier: { show(message) { notifications.push(message.body); return true } } })
    const drafts = createDraftService({ store, files })
    const publication = createPublicationService({ store, drafts, files, protector, clientFor: (hash) => clientFor(hash),
      adapter: createPublicationAdapter({ origin, apiOrigin: origin }), now: () => new Date(at), checks: { afterSendMs: null, onRecover, gapMs: 0 },
      onRecorded: () => reminders.publicationConfirmed(), onChecked: () => reminders.publicationConfirmed() })
    await drafts.recover()
    await publication.recover()
    return { reminders, publication }
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
    get db() { return db }, get publication() { return current.publication }, get reminders() { return current.reminders },
    path, requests, replies, hidden, notifications, row, check, hooks,
    peer(po = true) { const value = post(String(++next), 'peer reply', po ? 'Po' : 'Other'); replies.push(value); return value.id },
    holdConfirmation() { holdLookup = true },
    releaseConfirmation() { holdLookup = false; lookupRelease?.() },
    loseNextResponse() { loseResponse = true },
    async send(content = 'own reply', wait: boolean | 'unknown' = true) {
      const result = await current.publication.submit({ requestId: randomUUID(), editorId: 'editor',
        payload: { draftId: null, target: { kind: 'reply', threadId: '100' }, credentialId: credential,
          fields: { ...EMPTY_FIELDS, content }, attachmentId: null } })
      if (result.kind !== 'attempt') throw new Error(`submission refused: ${JSON.stringify(result)}`)
      if (wait) await expect.poll(() => db.getPublication(result.attempt.id)?.state).toBe(wait === 'unknown' ? 'unknown' : 'confirmed')
      else await expect.poll(() => lookupRelease !== null).toBe(true)
      return result.attempt.id
    },
    holdNextSnapshot() { holdSnapshot = true; snapshotCaptured = Promise.withResolvers<void>(); return snapshotCaptured.promise },
    releaseSnapshot() { snapshotRelease?.() },
    beginCheck() { monotonic += 60_000; return current.reminders.check() },
    async restart(onRecover = false) { await current.reminders.stop('quit'); db.close(); db = openReadingDatabase(path); current = await start(onRecover) },
    sql<T>(run: (connection: Database.Database) => T): T { const connection = new Database(path); try { return run(connection) } finally { connection.close() } }
  }
}

it('excludes proven own PO increments through actual publication confirmation and both engine modes, retaining peers', async () => {
  const h = await harness()
  await h.send()
  await h.check()
  expect((await h.row()).counts).toEqual({ all: 0, po: 0, quote: 0 })
  expect(h.notifications).toEqual([])
  expect(h.requests.map((request) => request.path)).toEqual(['/api/thread?id=100&page=1', '/api/po?id=100&page=1'])
  h.peer()
  await h.send('second own reply')
  await h.check()
  expect((await h.row()).counts).toEqual({ all: 1, po: 1, quote: 0 })
  expect(h.notifications).toEqual(['1 个串有新提醒'])
})

it('does not deduct a non-PO local reply from PO growth', async () => {
  const h = await harness({ nonPo: true })
  await h.send()
  h.peer()
  await h.check()
  expect((await h.row()).counts).toEqual({ all: 1, po: 1, quote: 0 })
  expect(h.notifications).toEqual(['1 个串有新提醒'])
})

it('does not move a confirmed reply into an older in-flight snapshot interval', async () => {
  const h = await harness()
  h.peer()
  const captured = h.holdNextSnapshot()
  await h.beginCheck()
  await captured
  await h.send()
  h.releaseSnapshot()
  await h.reminders.whenIdle()
  expect((await h.row()).counts).toEqual({ all: 1, po: 1, quote: 0 })
  await h.check()
  expect((await h.row()).counts).toEqual({ all: 1, po: 1, quote: 0 })
  expect(h.notifications).toEqual(['1 个串有新提醒'])
})

it('corrects a late confirmation once, persists it across restart, and cannot retract the earlier notification', async () => {
  const h = await harness()
  h.holdConfirmation()
  const id = await h.send('late reply', false)
  await h.check()
  expect((await h.row()).counts).toEqual({ all: 1, po: 1, quote: 0 })
  h.releaseConfirmation()
  await expect.poll(() => h.db.getPublication(id)?.state).toBe('confirmed')
  expect((await h.row()).counts).toEqual({ all: 0, po: 0, quote: 0 })
  const attempt = h.db.getPublication(id)!
  h.db.finishPublication({ id, state: 'confirmed', problem: null, postId: attempt.postId, threadId: '100', at })
  await h.restart()
  h.peer()
  await h.check()
  expect((await h.row()).counts).toEqual({ all: 1, po: 1, quote: 0 })
  expect(h.notifications).toEqual(['1 个串有新提醒', '1 个串有新提醒'])
})

it('marks late evidence from a cleared interval without deducting later peers', async () => {
  const h = await harness()
  h.holdConfirmation()
  const id = await h.send('clear before confirmation', false)
  await h.check()
  await h.reminders.clear({ threadId: '100' })
  h.peer()
  await h.check()
  h.releaseConfirmation()
  await expect.poll(() => h.db.getPublication(id)?.state).toBe('confirmed')
  expect((await h.row()).counts).toEqual({ all: 1, po: 1, quote: 0 })
  expect(h.sql((connection) => connection.prepare("SELECT status FROM reminder_local_replies WHERE publication_id = ? ORDER BY kind").all(id)))
    .toEqual([{ status: 'cleared' }, { status: 'cleared' }])
})

it('does not reuse an old generation deduction after rules are disabled and re-enabled', async () => {
  const h = await harness()
  h.holdConfirmation()
  const id = await h.send('old generation', false)
  await h.check()
  for (const kind of ['all', 'po'] as const) { h.db.setReminderRule('100', kind, false, at); h.db.setReminderRule('100', kind, true, at) }
  await h.check()
  h.releaseConfirmation()
  await expect.poll(() => h.db.getPublication(id)?.state).toBe('confirmed')
  h.peer()
  await h.check()
  expect((await h.row()).counts).toEqual({ all: 1, po: 1, quote: 0 })
})

it.each(['long', 'deleted'] as const)('keeps normal counts and notification when %s evidence cannot prove a local ordinal', async (kind) => {
  const h = await harness({ initialCount: kind === 'long' ? 200 : 10 })
  const id = await h.send()
  if (kind === 'deleted') h.hidden.add(h.replies[0]!.id)
  await h.check()
  expect((await h.row()).counts).toEqual({ all: 1, po: 1, quote: 0 })
  expect(h.notifications).toEqual(['1 个串有新提醒'])
  expect(h.sql((connection) => connection.prepare('SELECT status FROM reminder_local_replies WHERE publication_id = ? ORDER BY kind').all(id)))
    .toEqual([{ status: 'pending' }, { status: 'pending' }])
  expect(h.requests).toHaveLength(2)
})

it.each(['marker', 'count'] as const)('rolls back %s failure together with interval consumption and retries safely after reopening SQLite', async (failure) => {
  const h = await harness()
  const id = await h.send()
  h.sql((connection) => connection.exec(failure === 'marker'
    ? "CREATE TRIGGER fail_reminder BEFORE UPDATE OF status ON reminder_local_replies WHEN NEW.status = 'excluded' BEGIN SELECT RAISE(ABORT, 'marker failure'); END;"
    : "CREATE TRIGGER fail_reminder BEFORE UPDATE OF count ON reminder_state WHEN NEW.count < OLD.count BEGIN SELECT RAISE(ABORT, 'count failure'); END;"))
  await h.check()
  expect((await h.row()).counts).toEqual({ all: 0, po: 0, quote: 0 })
  expect(h.notifications).toEqual([])
  await h.restart()
  expect(h.db.reminderStates().map((state) => state.baseline)).toEqual([10, 10])
  expect(h.sql((connection) => connection.prepare('SELECT status FROM reminder_local_replies WHERE publication_id = ? ORDER BY kind').all(id)))
    .toEqual([{ status: 'pending' }, { status: 'pending' }])
  h.sql((connection) => connection.exec('DROP TRIGGER fail_reminder'))
  await h.check()
  expect((await h.row()).counts).toEqual({ all: 0, po: 0, quote: 0 })
  h.peer()
  await h.check()
  expect((await h.row()).counts).toEqual({ all: 1, po: 1, quote: 0 })
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

it('suppresses only-own notification when late confirmation commits before the final decision', async () => {
  const h = await harness()
  h.holdConfirmation()
  const id = await h.send('confirm before notification', false)
  h.hooks.afterBatch = async () => {
    h.releaseConfirmation()
    await expect.poll(() => h.db.getPublication(id)?.state).toBe('confirmed')
  }
  await h.check()
  expect((await h.row()).counts).toEqual({ all: 0, po: 0, quote: 0 })
  expect(h.notifications).toEqual([])
})

it('consumes reliable positions when the actual startup publication check confirms an unknown send', async () => {
  const h = await harness()
  h.loseNextResponse()
  const id = await h.send('startup checked reply', 'unknown')
  await h.check()
  expect((await h.row()).counts).toEqual({ all: 1, po: 1, quote: 0 })
  await h.restart(true)
  await expect.poll(() => h.db.getPublication(id)?.state).toBe('confirmed')
  expect((await h.row()).counts).toEqual({ all: 0, po: 0, quote: 0 })
  h.peer()
  await h.check()
  expect((await h.row()).counts).toEqual({ all: 1, po: 1, quote: 0 })
})

it.each(['head', 'duplicate', 'reversed'] as const)('does not trust a %s reply sequence as ordinal evidence', async (kind) => {
  const h = await harness()
  await h.send()
  const original = h.replies[0]!
  if (kind === 'head') h.replies[0] = { ...original, id: '100' }
  else if (kind === 'duplicate') h.replies[0] = { ...original, id: h.replies[1]!.id }
  else [h.replies[0], h.replies[1]] = [h.replies[1]!, original]
  await h.check()
  expect((await h.row()).counts).toEqual({ all: 1, po: 1, quote: 0 })
  expect(h.notifications).toEqual(['1 个串有新提醒'])
  h.replies[0] = original
})

it('rolls back an interrupted v22 upgrade without altering the v21 database', () => {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-reminder-migrate-fail-'))
  cleanups.push(() => rmSync(folder, { recursive: true, force: true }))
  const path = join(folder, 'app.sqlite')
  const old = new Database(path)
  for (const migration of MIGRATIONS.filter((migration) => migration.version <= 21)) migration.up(old)
  old.pragma('user_version = 21')
  old.close()
  const before = readFileSync(path)
  const failed = openReadingDatabase(path, [...MIGRATIONS.filter((migration) => migration.version <= 21), {
    version: 22,
    up(connection) {
      MIGRATIONS.find((migration) => migration.version === 22)!.up(connection)
      throw new Error('interrupted reminder provenance migration')
    }
  }])
  expect(failed.status).toEqual({ state: 'unavailable', reason: 'migration-failed' })
  failed.close()
  expect(readFileSync(path)).toEqual(before)
  const recovered = openReadingDatabase(path)
  expect(recovered.status.state).toBe('ready')
  recovered.close()
})
