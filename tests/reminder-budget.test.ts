import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createForumClient } from '../src/main/forum/client'
import { createForumTransport } from '../src/main/forum/transport'
import { runReminderRound } from '../src/main/reminders/engine'
import { createRequestScheduler } from '../src/main/reading/scheduler'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { asStore } from './helpers/store'

const at = '2026-10-26T00:00:00.000Z'
const resources: Array<{ folder: string; db: ReadingDatabase; server: Server }> = []

afterEach(async () => {
  for (const { folder, db, server } of resources.splice(0)) {
    db.close()
    const closed = Promise.withResolvers<void>()
    server.close(() => closed.resolve())
    await closed.promise
    rmSync(folder, { recursive: true, force: true })
  }
})

function post(id: string, content = '', userHash = 'Someone') {
  return { id: Number(id), fid: 4, now: '', user_hash: userHash, name: '', title: '', content,
    img: '', ext: '', admin: 0, sage: 0 }
}

async function harness() {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-reminder-budget-'))
  const db = openReadingDatabase(join(folder, 'app.sqlite'))
  db.insertCredential({ name: 'Mine', cookieId: 'Mine', source: 'raw', importedAt: at, ciphertext: Uint8Array.of(1) })
  const store = asStore(db)
  const threads = new Map<string, { count: number; refsPerReply: number }>()
  const seen: Array<{ id: string; path: string; page: number }> = []
  const remote = { rateLimitPage: 0, captcha: false }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://local')
    const id = url.searchParams.get('id') ?? ''
    const page = Number(url.searchParams.get('page') ?? 0)
    seen.push({ id, path: url.pathname, page })
    response.setHeader('Content-Type', 'application/json')
    if (page === remote.rateLimitPage && page > 0) {
      if (remote.captcha) response.end(JSON.stringify('饼干需要验证码'))
      else { response.statusCode = 429; response.end('{}') }
      return
    }
    if (url.pathname === '/api/ref') {
      response.end(JSON.stringify(post(id, '', 'Mine')))
      return
    }
    const thread = threads.get(id)
    if (!thread) { response.end(JSON.stringify('该串不存在')); return }
    const replies = []
    for (let n = (page - 1) * 19 + 1; n <= Math.min(page * 19, thread.count); n++) {
      const refs = Array.from({ length: thread.refsPerReply }, (_, index) => `>>No.${Number(id) * 1000000 + n * 10 + index}`)
      replies.push(post(String(Number(id) * 10000 + n), refs.join(' ')))
    }
    response.end(JSON.stringify({ ...post(id), ReplyCount: thread.count, Replies: replies }))
  })
  resources.push({ folder, db, server })
  const listening = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => listening.resolve())
  await listening.promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no server address')
  const origin = `http://127.0.0.1:${address.port}`
  const client = createForumClient({ baseUrl: origin, browseIdentity: async () => 'browse-secret',
    transport: createForumTransport({ allowedOrigins: [origin], credentialOrigins: [origin] }) })
  const scheduler = createRequestScheduler({ backgroundSpacingMs: 0 })
  let round = 0
  return {
    store, threads, seen, remote,
    async enable(id: string, ...kinds: Array<'all' | 'quote' | 'po'>) {
      for (const kind of kinds) await store.setReminderRule(id, kind, true, at)
    },
    async round() {
      seen.length = 0
      const checkedAt = new Date(Date.parse(at) + ++round * 60_000).toISOString()
      return runReminderRound({ store, client, scheduler, now: () => checkedAt, changed() {} }, {
        rules: await store.reminderRuleSnapshots(), signal: new AbortController().signal, increased: new Set()
      })
    }
  }
}

describe('reminder HTTP budgets', () => {
  it('caps a round at 100 actual requests and resumes partial quote refs without duplicate counts', async () => {
    const h = await harness()
    const thread = { count: 19, refsPerReply: 0 }
    h.threads.set('100', thread)
    await h.enable('100', 'all', 'quote')
    expect(await h.round()).toEqual({ rateLimited: false, complete: true })
    Object.assign(thread, { count: 76, refsPerReply: 4 })
    const fetchedRefs: string[] = []
    const pages: number[][] = []
    for (let round = 0; round < 3; round++) {
      const result = await h.round()
      expect(h.seen.length).toBeLessThanOrEqual(100)
      if (round < 2) {
        expect(h.seen).toHaveLength(100)
        expect(result.complete).toBe(false)
      } else expect(result.complete).toBe(true)
      fetchedRefs.push(...h.seen.filter((read) => read.path === '/api/ref').map((read) => read.id))
      pages.push(h.seen.filter((read) => read.path === '/api/thread').map((read) => read.page))
    }
    expect(new Set(fetchedRefs).size).toBe(57 * 4)
    expect(fetchedRefs).toHaveLength(57 * 4)
    expect(pages[1]).not.toContain(2)
    expect(pages[2]).not.toContain(2)
    expect((await h.store.reminderOverview()).threads[0]?.counts).toEqual({ all: 57, po: 0, quote: 57 })
    expect(await h.round()).toEqual({ rateLimited: false, complete: true })
    expect((await h.store.reminderOverview()).threads[0]?.counts.quote).toBe(57)
  })

  it('turns to the next thread after at most five page/ref HTTP requests', async () => {
    const h = await harness()
    for (const id of ['100', '200']) {
      h.threads.set(id, { count: 0, refsPerReply: 0 })
      await h.enable(id, 'quote')
    }
    await h.round()
    for (const thread of h.threads.values()) Object.assign(thread, { count: 1, refsPerReply: 8 })
    expect((await h.round()).complete).toBe(true)
    const owners = h.seen.map((read) => read.path === '/api/ref' ? String(Math.floor(Number(read.id) / 1000000)) : read.id)
    let streak = 0
    let previous = ''
    for (const owner of owners) {
      streak = owner === previous ? streak + 1 : 1
      expect(streak).toBeLessThanOrEqual(5)
      previous = owner
    }
    expect((await h.store.reminderOverview()).threads.map((row) => row.counts.quote)).toEqual([1, 1])
  })

  it('accounts nested page-100 probes within both budgets', async () => {
    const h = await harness()
    const thread = { count: 19 * 100, refsPerReply: 0 }
    h.threads.set('100', thread)
    await h.enable('100', 'quote')
    await h.round()
    thread.count = 19 * 160
    const first = await h.round()
    expect(first).toEqual({ rateLimited: false, complete: false })
    expect(h.seen).toHaveLength(99)
    expect(h.seen.filter((read) => read.page === 100)).toHaveLength(49)
    const completedPages = h.seen.filter((read) => read.page > 100).map((read) => read.page)
    expect(completedPages.at(-1)).toBe(149)
    expect((await h.round()).complete).toBe(true)
    expect(h.seen.filter((read) => read.page > 100)[0]?.page).toBe(150)
  })

  it.each([false, true])('stops immediately on a nested probe rate limit/captcha (captcha=%s)', async (captcha) => {
    const h = await harness()
    h.threads.set('100', { count: 19 * 101, refsPerReply: 0 })
    h.threads.set('200', { count: 1, refsPerReply: 0 })
    await h.enable('100', 'quote')
    await h.enable('200', 'all')
    Object.assign(h.remote, { rateLimitPage: 100, captcha })
    expect(await h.round()).toEqual({ rateLimited: true, complete: false })
    expect(h.seen.map((read) => `${read.id}:${read.page}`)).toEqual(['100:1', '100:101', '100:100'])
  })

  it('checks threads missed by the request cap before already checked threads next round', async () => {
    const h = await harness()
    for (let n = 100; n < 205; n++) {
      const id = String(n)
      h.threads.set(id, { count: 0, refsPerReply: 0 })
      await h.enable(id, 'all')
    }
    expect((await h.round()).complete).toBe(false)
    expect(h.seen.map((read) => read.id)).toEqual(Array.from({ length: 100 }, (_, n) => String(100 + n)))
    await h.round()
    expect(h.seen.slice(0, 5).map((read) => read.id)).toEqual(['200', '201', '202', '203', '204'])
    expect(h.seen).toHaveLength(100)
  })

  it('gives unvisited threads priority over persistent failures without treating errors as success', async () => {
    const h = await harness()
    for (let n = 100; n < 205; n++) {
      const id = String(n)
      if (n >= 200) h.threads.set(id, { count: 0, refsPerReply: 0 })
      await h.enable(id, 'all')
    }
    expect(await h.round()).toEqual({ rateLimited: false, complete: false })
    expect(h.seen).toHaveLength(100)
    expect(await h.round()).toEqual({ rateLimited: false, complete: false })
    expect(h.seen.slice(0, 5).map((read) => read.id)).toEqual(['200', '201', '202', '203', '204'])
    expect(h.seen).toHaveLength(100)
    expect((await h.store.reminderOverview()).threads.find((row) => row.threadId === '100')?.issues).toContain('not-found')
  })

  it('rotates partially checked quote threads behind threads not reached by the round budget', async () => {
    const h = await harness()
    for (let n = 100; n < 121; n++) {
      h.threads.set(String(n), { count: 0, refsPerReply: 0 })
      await h.enable(String(n), 'quote')
    }
    await h.round()
    for (const thread of h.threads.values()) Object.assign(thread, { count: 1, refsPerReply: 8 })
    expect((await h.round()).complete).toBe(false)
    expect(h.seen).toHaveLength(100)
    expect(h.seen.some((read) => read.id === '120')).toBe(false)
    await h.round()
    expect(h.seen[0]?.id).toBe('120')
    expect(h.seen.length).toBeLessThanOrEqual(100)
  })
})
