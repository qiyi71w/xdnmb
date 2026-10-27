import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { EMPTY_FIELDS, type DraftSaveInput } from '../src/shared/drafts'
import { isUnsettled, type PublicationAttempt, type SendFailureNotice, type SubmitResult } from '../src/shared/publication'
import type { Post } from '../src/shared/forum'
import type { AppStore } from '../src/main/storage/contract'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { createDraftService } from '../src/main/drafts/service'
import { openManagedImageFiles } from '../src/main/images/files'
import { createPublicationService } from '../src/main/publication/service'
import { createFailureNotifier } from '../src/main/publication/failureNotifier'
import { createPublicationAdapter } from '../src/main/publication/adapter'
import { createForumClient } from '../src/main/forum/client'
import { createForumTransport } from '../src/main/forum/transport'
import { createIdentityService } from '../src/main/identity/service'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean() })

function asyncStore(db: ReadingDatabase): AppStore {
  return new Proxy(db, { get(target, key) {
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? (...args: unknown[]) => Promise.resolve(Reflect.apply(value, target, args)) : value
  } }) as unknown as AppStore
}

/** Forum `now` text (Beijing time) of an instant. */
function forumNow(at: number): string {
  const t = new Date(at + 8 * 3_600_000).toISOString()
  return `${t.slice(0, 10)}(一)${t.slice(11, 19)}`
}
const COOKIE_IDS: Record<string, string> = { 'cookie-A': 'IdA', 'cookie-B': 'IdB' }

async function forum() {
  const seen: Array<{ path: string; cookie: string; body: string }> = []
  let mode: 'success' | 'reject' | 'drop' | 'unrelated' | 'empty' | 'hold' | 'hold-lookup' | 'preflight-rate' | 'stale' | 'read-rate' | 'readback-differs' = 'success'
  let release: (() => void) | null = null
  let last: Record<string, string> | null = null
  /** What `reject` answers a POST with. */
  let rejection = { status: 200, body: '<p class="error">发布太频繁</p>' }
  let number = 700
  const posts = new Map<string, Record<string, string>>()
  /** Posts the lists and thread pages do not show yet (as a lagging forum cache would). */
  let lagging = false
  /** Thread pages report this many replies fewer than they have (a count that lags behind). */
  let countLag = 0
  const unseen = new Set<string>()
  const listed = () => [...posts.values()].filter(post => !unseen.has(post.id!))
  const page = (path: string) => Number(new URL(path, 'http://local').searchParams.get('page') ?? '1')
  /** Public read-back of a stored post; `readback-differs` changes one character outside the dice. */
  const readback = (id: string) => mode === 'readback-differs' && posts.has(id) ? { content: `${posts.get(id)!.content}。` } : {}
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString()
    const path = req.url!
    seen.push({ path, cookie: req.headers.cookie ?? '', body })
    const send = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
    if (path.startsWith('/Home/')) {
      const fields: Record<string, string> = {}
      for (const match of body.matchAll(/name="(\w+)"\r\n\r\n([\s\S]*?)\r\n--/g)) fields[match[1]!] = match[2]!
      const id = String(++number)
      const author = COOKIE_IDS[/userhash=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? ''] ?? ''
      // Stored as the forum renders it: line breaks as <br />, dice `[1,5]` as `<b>2</b><small>[1,5]</small>` (No.69687055).
      const content = fields.content!.replace(/\r\n?/g, '\n').replace(/\n/g, '<br />\n').replace(/\[\d+(?:,\d+)?\]/g, dice => `<b>2</b><small>${dice}</small>`)
      last = { id, resto: fields.resto ?? '0', fid: fields.fid ?? '1', content, title: fields.title!, name: fields.name!, img: body.includes('name="image"') ? 'test/image' : '', ext: body.includes('name="image"') ? '.png' : '', user_hash: author, now: forumNow(Date.now()) }
      posts.set(id, last)
      if (lagging) unseen.add(id)
      if (mode === 'stale') last = posts.get('701')!
      if (mode === 'drop') { req.socket.destroy(); return }
      const respond = () => {
        res.setHeader('Set-Cookie', 'PHPSESSID=controlled-session; Path=/')
        res.setHeader('Content-Type', 'text/html')
        if (mode === 'reject') res.statusCode = rejection.status
        res.end(mode === 'reject' ? rejection.body : '<p class="success">成功</p>')
      }
      if (mode === 'hold') release = respond
      else respond()
    } else if (path === '/Api/getLastPost') {
      if (mode === 'hold-lookup') release = () => send(last)
      else if (mode === 'empty') send(null)
      else if (mode === 'unrelated') send({ ...last, content: '别人的内容' })
      else send(last)
    } else if (mode === 'read-rate' && (path.startsWith('/api/thread') || path.startsWith('/api/showf'))) send('请求太频繁')
    else if (path.startsWith('/api/getForumList')) send(mode === 'preflight-rate' ? '请求太频繁' : [{ id: '1', name: '测试', forums: [{ id: '1', name: '测试版', msg: '', interval: 0 }] }])
    else if (path.startsWith('/api/getTimelineList')) send([])
    else if (path.startsWith('/api/thread')) {
      const id = new URL(path, 'http://local').searchParams.get('id')!
      const replies = listed().filter(post => post.resto === id)
      const n = page(path)
      send({ ...(posts.get(id) ?? { id, fid: '1', content: '主帖', title: '', name: '', img: '', ext: '', user_hash: 'Po', now: forumNow(0) }), ...readback(id),
        Replies: replies.slice((n - 1) * 19, n * 19), ReplyCount: replies.length - countLag })
    } else if (path.startsWith('/api/showf')) {
      const threads = listed().filter(post => post.resto === '0').reverse()
      send(page(path) === 1 ? threads.map(thread => ({ ...thread, Replies: [], ReplyCount: 0 })) : [])
    } else if (path.startsWith('/api/ref')) {
      const id = new URL(path, 'http://local').searchParams.get('id')!
      send(posts.has(id) ? { ...posts.get(id), ...readback(id) } : null)
    } else { res.statusCode = 404; res.end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('listen failed')
  return { origin: `http://127.0.0.1:${address.port}`, seen, setMode(value: typeof mode) { mode = value }, release() { release?.() },
    /** Changes a stored post as the forum would then show it. */
    edit(id: string, patch: Record<string, string>) { posts.set(id, { ...posts.get(id)!, ...patch }) },
    /** Adds a post someone else made. */
    add(post: Record<string, string>) { const id = String(++number); posts.set(id, { id, resto: '0', fid: '1', content: '', title: '', name: '', email: '', img: '', ext: '', user_hash: '', now: forumNow(Date.now()), ...post }); return id },
    posts: () => [...posts.values()],
    /** New posts stay out of reads until `catchUp`. */
    lag() { lagging = true },
    catchUp() { lagging = false; unseen.clear() },
    lagCount(by: number) { countLag = by },
    reject(body: string, status = 200) { mode = 'reject'; rejection = { status, body } } }
}

type Checks = { afterSendMs?: number | null; onRecover?: boolean; gapMs?: number }
/** Automatic checks stay off unless a test is about them. */
async function setup(checks: Checks = { afterSendMs: null, onRecover: false }, options: { onRecorded?: (attempt: PublicationAttempt) => void; onChecked?: (attempt: PublicationAttempt) => void } = {}) {
  const remote = await forum()
  const dir = mkdtempSync(join(tmpdir(), 'xidao-publication-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let db = openReadingDatabase(join(dir, 'db.sqlite'))
  cleanups.push(() => db.close())
  // Ciphertext starting with "locked" stands for a credential the OS can no longer decrypt.
  const protector = { isAvailable: async () => true, encrypt: async (s: string) => Buffer.from(s), decrypt: async (b: Uint8Array) => {
    const value = Buffer.from(b).toString()
    if (value.startsWith('locked')) throw new Error('synthetic locked')
    return value
  } }
  const a = db.insertCredential({ name: 'A', cookieId: 'IdA', source: 'raw', importedAt: '2026-01-01', ciphertext: Buffer.from('cookie-A') }).id
  const b = db.insertCredential({ name: 'B', cookieId: 'IdB', source: 'raw', importedAt: '2026-01-01', ciphertext: Buffer.from('cookie-B') }).id
  const files = await openManagedImageFiles(join(dir, 'draft-images'))
  const start = async (store: AppStore = asyncStore(db), active: Checks = checks) => {
    const drafts = createDraftService({ store, files })
    const service = createPublicationService({ store, drafts, files, protector,
      clientFor: userhash => createForumClient({ transport: createForumTransport({ allowedOrigins: [remote.origin], credentialOrigins: [remote.origin] }), baseUrl: remote.origin, browseIdentity: async () => userhash }),
      adapter: createPublicationAdapter({ origin: remote.origin, apiOrigin: remote.origin, publishTimeoutMs: 1500 }), deadlineMs: 1500, checks: { gapMs: 0, ...active },
      onRecorded: options.onRecorded, onChecked: options.onChecked })
    await service.recover(); await drafts.recover()
    return { service, drafts }
  }
  let current = await start()
  return { remote, dir, files, a, b, get db() { return db }, get service() { return current.service }, get drafts() { return current.drafts }, start,
    async restart(active?: Checks) { db.close(); db = openReadingDatabase(join(dir, 'db.sqlite')); current = await start(asyncStore(db), active) } }
}
function payload(credentialId: string, content = '测试正文'): DraftSaveInput {
  return { draftId: null, target: { kind: 'thread', forumId: '1' }, credentialId, fields: { ...EMPTY_FIELDS, content, title: '测试标题' }, attachmentId: null }
}
function attempt(result: SubmitResult): PublicationAttempt {
  if (result.kind !== 'attempt') throw new Error(`Expected attempt: ${JSON.stringify(result)}`)
  return result.attempt
}
/** Stores a thread's main post as reading would, with the given public 饼干 ID. */
function storeHead(db: ReadingDatabase, threadId: string, userHash: string | null) {
  const head: Post = { id: threadId, forumId: '1', createdAt: null, userHash, name: null, title: null, isAdmin: null, isSage: null,
    content: [{ type: 'text', text: '主帖' }], plainText: '主帖', image: null }
  db.savePost(head, '2026-01-01T00:00:00.000Z')
}
async function finished(service: Awaited<ReturnType<typeof setup>>['service'], id: string) {
  let result: PublicationAttempt | null = null
  await expect.poll(async () => {
    const response = await service.getAttempt({ attemptId: id })
    result = response.ok ? response.attempt : null
    return result?.state
  }).not.toBe('sending')
  if (!result) throw new Error('Missing result')
  return result as PublicationAttempt
}

it('freezes one durable request, uses one same-session ID lookup, and records actual identity without replacing explicit thread choice', async () => {
  const s = await setup()
  s.db.setThreadPostIdentity('701', s.b, '2026-01-01')
  s.remote.setMode('hold')
  const input = { requestId: randomUUID(), editorId: 'editor-1', payload: payload(s.a) }
  const first = attempt(await s.service.submit(input))
  input.payload.fields.content = '后来修改'
  input.payload.credentialId = s.b
  expect(attempt(await s.service.submit(input)).id).toBe(first.id)
  expect(await s.service.submit({ requestId: randomUUID(), editorId: 'editor-2', payload: payload(s.a) })).toEqual({ kind: 'refused', reason: 'busy' })
  await expect.poll(() => s.remote.seen.filter(r => r.path.startsWith('/Home/')).length).toBe(1)
  s.remote.release()
  expect(await finished(s.service, first.id)).toMatchObject({ state: 'confirmed', postId: '701', payload: { credentialId: s.a, fields: { content: '测试正文' } } })
  expect(s.db.getThreadPostIdentity('701')).toEqual({ state: 'selected', credentialId: s.b })
  const lookup = s.remote.seen.filter(r => r.path === '/Api/getLastPost')
  expect(lookup).toHaveLength(1)
  expect(lookup[0]!.cookie).toBe('userhash=cookie-A; PHPSESSID=controlled-session')
  expect(s.remote.seen.filter(r => r.path.startsWith('/api/thread') && r.path.includes('701'))[0]!.cookie).toBe('')
})

it('confirms rendered multiline content including a final editor newline without changing the frozen text', async () => {
  const s = await setup()
  const content = '第一行\n第二行\n'
  const sent = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'multiline', payload: payload(s.a, content) }))
  expect(await finished(s.service, sent.id)).toMatchObject({ state: 'confirmed', payload: { fields: { content } } })
})

/** A reply goes to `701`, the first post the controlled forum numbers; replies send that head first. */
function postFor(kind: 'thread' | 'reply', credentialId: string, content: string): DraftSaveInput {
  return kind === 'thread' ? payload(credentialId, content) : { ...payload(credentialId, content), target: { kind: 'reply', threadId: '701' } }
}

it.each([['thread', '[3]'], ['thread', '[1,5]'], ['reply', '[3]'], ['reply', '[1,5]']] as const)(
  'confirms a %s whose dice %s the forum stored with its rolled result', async (kind, dice) => {
    const s = await setup()
    if (kind === 'reply') await finished(s.service, attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'head', payload: payload(s.a) })).id)
    const content = `掷 ${dice} 看看\n再来${dice}`
    const sent = attempt(await s.service.submit({ requestId: randomUUID(), editorId: kind, payload: postFor(kind, s.a, content) }))
    expect(await finished(s.service, sent.id)).toMatchObject({ state: 'confirmed', payload: { fields: { content } } })
    expect(s.remote.seen.filter(r => r.path.startsWith(kind === 'thread' ? '/api/thread' : '/api/ref'))).not.toHaveLength(0)
  })

it.each(['thread', 'reply'] as const)('keeps a %s with dice unconfirmed when its public read-back differs elsewhere in the text', async kind => {
  const s = await setup()
  if (kind === 'reply') await finished(s.service, attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'head', payload: payload(s.a) })).id)
  s.remote.setMode('readback-differs')
  const sent = attempt(await s.service.submit({ requestId: randomUUID(), editorId: kind, payload: postFor(kind, s.a, '掷 [1,5] 看看') }))
  expect(await finished(s.service, sent.id)).toMatchObject({ state: 'unconfirmed' })
})

it('sends new threads and replies without an email field, keeping the other fields and the watermark switch', async () => {
  const s = await setup()
  const thread = { ...postFor('thread', s.a, '新串正文'), fields: { ...EMPTY_FIELDS, content: '新串正文', title: '标题', name: '名称' } }
  await finished(s.service, attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'thread', payload: thread })).id)
  const reply = { ...postFor('reply', s.a, '回复正文'), fields: { ...EMPTY_FIELDS, content: '回复正文', watermark: true } }
  await finished(s.service, attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'reply', payload: reply })).id)
  const sent = s.remote.seen.filter(r => r.path.startsWith('/Home/'))
    .map(r => Object.fromEntries([...r.body.matchAll(/name="(\w+)"\r\n\r\n([\s\S]*?)\r\n--/g)].map(m => [m[1], m[2]])))
  expect(sent).toEqual([
    { fid: '1', content: '新串正文', title: '标题', name: '名称' },
    { resto: '701', content: '回复正文', title: '', name: '', water: 'true' }
  ])
})

it('releases a refused PO choice so an edited retry cannot submit the old frozen prompt', async () => {
  const s = await setup()
  const head = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'head', payload: payload(s.a) }))
  await finished(s.service, head.id)
  storeHead(s.db, '701', 'IdA')
  const input = { requestId: randomUUID(), editorId: 'reply', payload: { ...payload(s.b, '旧内容'), target: { kind: 'reply' as const, threadId: '701' } } }
  const first = await s.service.submit(input)
  if (first.kind !== 'prompt') throw new Error('missing prompt')
  s.remote.setMode('preflight-rate')
  expect(await s.service.resolvePrompt({ token: first.prompt.token, choice: 'current', suppress: true })).toEqual({ kind: 'refused', reason: 'rate-limited' })
  s.remote.setMode('success')
  const next = await s.service.submit({ ...input, requestId: randomUUID(), payload: { ...input.payload, fields: { ...input.payload.fields, content: '修改后的内容' } } })
  if (next.kind !== 'prompt') throw new Error('missing fresh prompt')
  expect(next.prompt.token).not.toBe(first.prompt.token)
  const sent = attempt(await s.service.resolvePrompt({ token: next.prompt.token, choice: 'current', suppress: false }) as SubmitResult)
  expect(await finished(s.service, sent.id)).toMatchObject({ state: 'confirmed', payload: { fields: { content: '修改后的内容' } } })
})

it('keeps committed-but-disconnected content and its image locked across a real database reopen without sending again', async () => {
  const s = await setup()
  const image = Buffer.alloc(64)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).copy(image)
  image.write('IHDR', 12); image.writeUInt32BE(2, 16); image.writeUInt32BE(1, 20)
  const source = join(s.dir, 'source.png'); writeFileSync(source, image)
  const attached = await s.drafts.attachImage('window', 'editor-1', source)
  if (!attached.ok) throw new Error('attach failed')
  const data = { ...payload(s.a), attachmentId: attached.attachment.id }
  const saved = await s.drafts.save(data)
  if (!saved.ok) throw new Error('save failed')
  data.draftId = saved.draft.id
  s.remote.setMode('drop')
  const result = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'editor-1', payload: data }))
  expect(await finished(s.service, result.id)).toMatchObject({ state: 'unknown', problem: 'network' })
  expect(await s.drafts.save({ ...data, fields: { ...data.fields, content: '覆盖' } })).toEqual({ ok: false, reason: 'locked' })
  expect(await s.drafts.delete(data.draftId)).toEqual({ ok: false, reason: 'locked' })
  await s.restart()
  expect((await s.service.getAttempt({ attemptId: result.id }))).toMatchObject({ ok: true, attempt: { state: 'unknown', payload: data } })
  const record = s.db.getDraftAttachment(data.attachmentId)
  expect(record).not.toBeNull()
  expect(existsSync(s.files.pathOf(record!.fileName)!)).toBe(true)
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(1)
  expect(s.remote.seen.filter(r => r.path === '/Api/getLastPost')).toHaveLength(0)
})

it('saves an explicit rejection exactly once and sends again only on a new deliberate request', async () => {
  const s = await setup()
  s.remote.setMode('reject')
  const input = { requestId: randomUUID(), editorId: 'editor-1', payload: payload(s.a) }
  const rejected = attempt(await s.service.submit(input))
  expect(await finished(s.service, rejected.id)).toMatchObject({ state: 'failed', problem: 'rate-limited' })
  const status = await s.service.getAttempt({ attemptId: rejected.id })
  if (!status.ok || !status.draft) throw new Error('missing saved draft')
  expect(status.draft.fields.content).toBe('测试正文')
  expect(attempt(await s.service.submit(input)).id).toBe(rejected.id)
  expect(s.db.listDrafts()).toHaveLength(1)
  s.remote.setMode('success')
  const retry = attempt(await s.service.submit({ ...input, requestId: randomUUID(), payload: { ...input.payload, draftId: status.draft.id } }))
  expect(await finished(s.service, retry.id)).toMatchObject({ state: 'confirmed' })
  expect(s.db.listDrafts()).toEqual([])
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(2)
})

it('notifies only explicit failures with their saved draft, never refusals, unknown results or a quit without a window', async () => {
  const inApp: SendFailureNotice[] = []
  const system: Array<{ title: string; body: string }> = []
  let front = true
  const failures = createFailureNotifier({
    foreground: () => front,
    showInApp: notice => { inApp.push(notice); return true },
    isSupported: () => true,
    create: message => { system.push(message); return { on() {}, show() {} } },
    forumName: async id => (id === '1' ? '测试版' : null),
    async openDraft() {}
  })
  const recorded: Array<Promise<void>> = []
  const s = await setup(undefined, { onRecorded: value => { recorded.push(failures.recorded(value)) } })
  const send = async (editorId: string, content = `正文 ${editorId}`) =>
    finished(s.service, attempt(await s.service.submit({ requestId: randomUUID(), editorId, payload: payload(s.a, content) })).id)

  s.remote.setMode('reject')
  const rejected = await send('front')
  await Promise.all(recorded)
  expect(inApp).toEqual([{ attemptId: rejected.id, editorId: 'front', draftId: rejected.savedDraftId, problem: 'rate-limited', target: { kind: 'thread', forumId: '1' }, forumMessage: '发布太频繁' }])
  expect(s.db.listDrafts().map(draft => draft.id)).toEqual([rejected.savedDraftId])

  front = false
  const behind = await send('behind', '不能出现在通知里')
  await Promise.all(recorded)
  expect(system).toEqual([{ title: '发送失败：论坛限制了发言频率，已停止', body: '在「测试版」发新串，内容已存为草稿' }])
  // The forum's own words stay in the app.
  expect(JSON.stringify(system)).not.toMatch(/不能出现|cookie-A|发布太频繁/)
  expect(behind.savedDraftId).not.toBeNull()

  // Not sent at all (local check), result unknown, and failure reached while finishing a quit: no notice.
  expect(await s.service.submit({ requestId: randomUUID(), editorId: 'empty', payload: payload(s.a, '  ') })).toEqual({ kind: 'refused', reason: 'empty' })
  s.remote.setMode('drop')
  expect(await send('unknown')).toMatchObject({ state: 'unknown' })
  s.remote.setMode('reject')
  s.service.setUnattended(true)
  expect(await send('quitting')).toMatchObject({ state: 'failed' })
  await Promise.all(recorded)
  expect(inApp).toHaveLength(1)
  expect(system).toHaveLength(1)
})

it('keeps the forum’s own error text of a rejection, cut to 120 characters, across a restart', async () => {
  const s = await setup()
  const send = async () => finished(s.service, attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'editor-1', payload: payload(s.a, `正文 ${randomUUID()}`) })).id)

  // Only the first error element's text, whitespace collapsed; tags inside are not kept as markup.
  s.remote.reject('<html><head><title>出错了</title></head><body><h1>提示</h1>\n<p class="error">\n  该串已被\n  <b>锁定</b>，<br />无法回复  </p><p class="error">第二条</p><p>返回</p></body></html>')
  const first = await send()
  expect(first).toMatchObject({ state: 'failed', problem: 'rejected', forumMessage: '该串已被 锁定， 无法回复' })

  // Characters, not UTF-16 units: 120 kept whole, 121 cut to 119 and an ellipsis.
  s.remote.reject(`<p class="error">${'𠮷'.repeat(120)}</p>`)
  const exact = await send()
  expect(exact.forumMessage).toBe('𠮷'.repeat(120))
  s.remote.reject(`<p class="error">${'𠮷'.repeat(121)}</p>`)
  const long = await send()
  expect(long.forumMessage).toBe(`${'𠮷'.repeat(119)}…`)
  expect([...long.forumMessage!]).toHaveLength(120)

  // No error element, or one without text: a failure without forum text.
  s.remote.reject('请求太频繁', 429)
  const bare = await send()
  expect(bare).toMatchObject({ state: 'failed', problem: 'rate-limited' })
  expect(bare).not.toHaveProperty('forumMessage')
  s.remote.reject('<p class="error">  <br /> </p>')
  const blank = await send()
  expect(blank).toMatchObject({ state: 'failed', problem: 'rejected' })
  expect(blank).not.toHaveProperty('forumMessage')

  await s.restart()
  const listed = await s.service.listAttempts()
  if (!listed.ok) throw new Error('attempts unavailable')
  const kept = new Map(listed.attempts.map(item => [item.id, item.forumMessage]))
  expect(kept.get(first.id)).toBe('该串已被 锁定， 无法回复')
  expect(kept.get(exact.id)).toBe('𠮷'.repeat(120))
  expect(kept.get(long.id)).toBe(`${'𠮷'.repeat(119)}…`)
  expect(kept.get(bare.id)).toBeUndefined()
  expect(kept.get(blank.id)).toBeUndefined()
})

it.each(['empty', 'unrelated'] as const)('records a send the forum reported successful as sent even when a %s latest post leaves its number unknown', async mode => {
  const s = await setup()
  s.remote.setMode(mode)
  const source = await s.drafts.save(payload(s.a))
  if (!source.ok) throw new Error('save failed')
  const sent = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'editor-1', payload: { ...payload(s.a), draftId: source.draft.id } }))
  expect(await finished(s.service, sent.id)).toMatchObject({ state: 'unconfirmed', postId: null })
  // Sent: its source draft is gone and nothing locks the editor or sends it again.
  expect(s.db.listDrafts()).toEqual([])
  await s.restart()
  expect(s.db.listPublications()[0]!.state).toBe('unconfirmed')
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(1)
  expect(s.remote.seen.filter(r => r.path === '/Api/getLastPost')).toHaveLength(1)
})

it('recovers an intent after result persistence fails without manufacturing a retryable failure', async () => {
  const s = await setup()
  const store = asyncStore(s.db)
  const failing = { ...store, finishPublication: async () => { throw new Error('disk full') } }
  // Proxy methods are on the prototype, so override through a proxy rather than copying the store.
  const wrapped = new Proxy(store, { get(target, key) { return key === 'finishPublication' ? failing.finishPublication : Reflect.get(target, key) } })
  const { service } = await s.start(wrapped)
  const sent = attempt(await service.submit({ requestId: randomUUID(), editorId: 'editor-1', payload: payload(s.a) }))
  expect(await finished(service, sent.id)).toMatchObject({ state: 'unknown', problem: 'storage' })
  expect(s.db.getPublication(sent.id)!.state).toBe('sending')
  await s.restart()
  expect(s.db.getPublication(sent.id)!.state).toBe('unknown')
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(1)
})

it('keeps a result storage could not take and writes it once storage is back, without sending again', async () => {
  const s = await setup()
  const store = asyncStore(s.db)
  let down = true
  const finishPublication: typeof store.finishPublication = async input => {
    if (down) throw new Error('disk full')
    return store.finishPublication(input)
  }
  const wrapped = new Proxy(store, { get(target, key) { return key === 'finishPublication' ? finishPublication : Reflect.get(target, key) } })
  const { service } = await s.start(wrapped)
  const sent = attempt(await service.submit({ requestId: randomUUID(), editorId: 'editor-1', payload: payload(s.a) }))
  expect(await finished(service, sent.id)).toMatchObject({ state: 'unknown', problem: 'storage' })
  expect(service.unstoredResults()).toMatchObject([{ id: sent.id, state: 'confirmed', postId: '701' }])
  expect(await service.retryUnstored()).toBe(false)
  expect(s.db.getPublication(sent.id)!.state).toBe('sending')
  down = false
  expect(await service.retryUnstored()).toBe(true)
  expect(service.unstoredResults()).toEqual([])
  expect(s.db.getPublication(sent.id)).toMatchObject({ state: 'confirmed', postId: '701' })
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(1)
})

it('records a result the store refuses (not a storage failure) as unknown, so it never holds up a quit', async () => {
  const s = await setup()
  const store = asyncStore(s.db)
  const finishPublication: typeof store.finishPublication = async input => {
    if (input.state === 'confirmed') throw new Error('publication confirmation target mismatch')
    return store.finishPublication(input)
  }
  const wrapped = new Proxy(store, { get(target, key) { return key === 'finishPublication' ? finishPublication : Reflect.get(target, key) } })
  const { service } = await s.start(wrapped)
  const sent = attempt(await service.submit({ requestId: randomUUID(), editorId: 'editor-1', payload: payload(s.a) }))
  expect(await finished(service, sent.id)).toMatchObject({ state: 'unknown', problem: 'storage' })
  expect(s.db.getPublication(sent.id)).toMatchObject({ state: 'unknown', problem: 'storage' })
  expect(service.unstoredResults()).toEqual([])
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(1)
})

it('PO cancel changes nothing; switch remembers the actual identity; suppression is runtime-scoped and re-enable clears it', async () => {
  const s = await setup()
  const head = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'head', payload: payload(s.a) }))
  await finished(s.service, head.id)
  storeHead(s.db, '701', 'IdA')
  const reply = () => ({ requestId: randomUUID(), editorId: randomUUID(), payload: { ...payload(s.b, '回复内容'), target: { kind: 'reply' as const, threadId: '701' } } })
  const first = await s.service.submit(reply())
  if (first.kind !== 'prompt') throw new Error('missing PO prompt')
  expect(first.prompt).toMatchObject({ currentName: 'B', poName: 'A', canSwitch: true })
  expect(await s.service.resolvePrompt({ token: first.prompt.token, choice: 'cancel', suppress: true })).toEqual({ kind: 'cancelled' })
  expect(s.db.getThreadPostIdentity('701')).toEqual({ state: 'selected', credentialId: s.a })
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(1)
  const next = await s.service.submit(reply())
  if (next.kind !== 'prompt') throw new Error('cancel incorrectly suppressed prompt')
  const switched = attempt(await s.service.resolvePrompt({ token: next.prompt.token, choice: 'switch', suppress: true }) as SubmitResult)
  expect(switched.payload.credentialId).toBe(s.a)
  await finished(s.service, switched.id)
  s.service.releasePrompts()
  const suppressed = attempt(await s.service.submit(reply()))
  expect(suppressed.payload.credentialId).toBe(s.b)
  await finished(s.service, suppressed.id)
  await s.service.setPoWarning({ enabled: true })
  const restored = await s.service.submit(reply())
  expect(restored.kind).toBe('prompt')
  s.service.releasePrompts()
  await s.service.setPoWarning({ enabled: false })
  await s.restart()
  expect(await s.service.getPoWarning()).toEqual({ enabled: false })
  await s.service.setPoWarning({ enabled: true })
  // A matching cookie that can no longer be decrypted is still named, but cannot be switched to.
  const raw = new Database(join(s.dir, 'db.sqlite'))
  try { raw.prepare("UPDATE credentials SET ciphertext = CAST('locked' AS BLOB) WHERE id = ?").run(s.a) } finally { raw.close() }
  const locked = await s.service.submit(reply())
  if (locked.kind !== 'prompt') throw new Error('an unusable PO cookie should still prompt')
  expect(locked.prompt).toMatchObject({ poName: 'A', canSwitch: false })
  expect(await s.service.resolvePrompt({ token: locked.prompt.token, choice: 'switch', suppress: false })).toEqual({ kind: 'refused', reason: 'identity' })
})

it('asks about the PO cookie only when the stored main post 饼干 ID matches another imported cookie', async () => {
  const s = await setup()
  const reply = (credentialId: string, threadId: string) => ({ requestId: randomUUID(), editorId: randomUUID(),
    payload: { ...payload(credentialId, `回复 ${threadId}`), target: { kind: 'reply' as const, threadId } } })
  const sent = async (result: SubmitResult) => { await finished(s.service, attempt(result).id) }
  storeHead(s.db, '900', 'IdA')
  storeHead(s.db, '901', 'Stranger')
  storeHead(s.db, '903', null)
  const asked = await s.service.submit(reply(s.b, '900'))
  expect(asked).toMatchObject({ kind: 'prompt', prompt: { poName: 'A', poCredentialId: s.a, currentName: 'B', canSwitch: true } })
  s.service.releasePrompts()
  // The current cookie is the PO cookie; no imported cookie has the ID; main post unknown or without an ID.
  await sent(await s.service.submit(reply(s.a, '900')))
  await sent(await s.service.submit(reply(s.b, '901')))
  await sent(await s.service.submit(reply(s.b, '902')))
  await sent(await s.service.submit(reply(s.b, '903')))
  // An ID filled in or changed in settings applies to the next send; an unknown ID matches nothing.
  s.db.setCredentialCookieId(s.a, 'Stranger', new Date().toISOString())
  expect(await s.service.submit(reply(s.b, '901'))).toMatchObject({ kind: 'prompt', prompt: { poName: 'A' } })
  s.service.releasePrompts()
  const raw = new Database(join(s.dir, 'db.sqlite'))
  try { raw.prepare('UPDATE credentials SET cookie_id = NULL WHERE id = ?').run(s.a) } finally { raw.close() }
  await sent(await s.service.submit(reply(s.b, '901')))
  await sent(await s.service.submit(reply(s.b, '900')))
})

it('a failed result transaction leaves intent and original draft intact for conservative restart recovery', async () => {
  const s = await setup()
  const draft = await s.drafts.save(payload(s.a, '旧版本'))
  if (!draft.ok) throw new Error('save failed')
  const data = { ...payload(s.a, '实际发送版本'), draftId: draft.draft.id }
  const intent = s.db.createPublication({ requestId: randomUUID(), editorId: 'draft-editor', payload: data, forumId: '1', at: '2026-01-01' })
  const raw = new Database(join(s.dir, 'db.sqlite'))
  raw.exec("CREATE TRIGGER fail_draft BEFORE UPDATE ON drafts BEGIN SELECT RAISE(ABORT, 'controlled write failure'); END")
  raw.close()
  expect(() => s.db.finishPublication({ id: intent.id, state: 'failed', problem: 'rejected', postId: null, threadId: null, at: '2026-01-02' })).toThrow()
  expect(s.db.getPublication(intent.id)!.state).toBe('sending')
  expect(s.db.listDrafts()[0]!.fields.content).toBe('旧版本')
  await s.restart()
  expect(s.db.getPublication(intent.id)).toMatchObject({ state: 'unknown', payload: { fields: { content: '实际发送版本' } } })
  expect(await s.drafts.delete(draft.draft.id)).toEqual({ ok: false, reason: 'locked' })
  expect(s.remote.seen).toEqual([])
})

it('total publication deadline stops a hanging response without replay and leaves the result unknown', async () => {
  const remote = await forum()
  remote.setMode('hold')
  const adapter = createPublicationAdapter({ origin: remote.origin, apiOrigin: remote.origin, publishTimeoutMs: 40 })
  expect(await adapter.publish({ payload: payload('1'), userhash: 'cookie-A', attachment: null })).toEqual({ state: 'unknown', problem: 'network' })
  expect(remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(1)
  expect(remote.seen.filter(r => r.path === '/Api/getLastPost')).toHaveLength(0)
})

it('sends an exported userhash with `+` written as `%20` on the post and its same-session lookup', async () => {
  const remote = await forum()
  const adapter = createPublicationAdapter({ origin: remote.origin, apiOrigin: remote.origin, publishTimeoutMs: 1500 })
  // Synthetic value in the export form: a space as `+`, a tilde as `%7E`.
  expect(await adapter.publish({ payload: payload('1'), userhash: 'Synth+etic%7EHash/+=', attachment: null })).toMatchObject({ state: 'confirmed' })
  const post = remote.seen.filter(r => r.path.startsWith('/Home/'))
  const lookup = remote.seen.filter(r => r.path === '/Api/getLastPost')
  expect(post.map(r => r.cookie)).toEqual(['userhash=Synth%20etic%7EHash/%20='])
  expect(lookup.map(r => r.cookie)).toEqual(['userhash=Synth%20etic%7EHash/%20=; PHPSESSID=controlled-session'])
})

it('reports preflight throttling as throttling and does not create or send an intent', async () => {
  const s = await setup()
  s.remote.setMode('preflight-rate')
  expect(await s.service.submit({ requestId: randomUUID(), editorId: 'limited', payload: payload(s.a) })).toEqual({ kind: 'refused', reason: 'rate-limited' })
  expect(s.db.listPublications()).toEqual([])
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toEqual([])
})

it('does not commit a PO identity switch when persisting the send intent fails', async () => {
  const s = await setup()
  const head = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'head', payload: payload(s.a) }))
  await finished(s.service, head.id)
  s.db.setThreadPostIdentity('701', s.b, '2026-01-01')
  storeHead(s.db, '701', 'IdA')
  const question = await s.service.submit({ requestId: randomUUID(), editorId: 'reply', payload: { ...payload(s.b), target: { kind: 'reply', threadId: '701' } } })
  if (question.kind !== 'prompt') throw new Error('missing prompt')
  const raw = new Database(join(s.dir, 'db.sqlite'))
  raw.exec("CREATE TRIGGER fail_intent BEFORE INSERT ON publication_attempts BEGIN SELECT RAISE(ABORT, 'controlled write failure'); END")
  raw.close()
  expect(await s.service.resolvePrompt({ token: question.prompt.token, choice: 'switch', suppress: true })).toEqual({ kind: 'refused', reason: 'storage' })
  expect(s.db.getThreadPostIdentity('701')).toEqual({ state: 'selected', credentialId: s.b })
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(1)
})

it('does not associate a second submission with an already confirmed old ID even when its content matches', async () => {
  const s = await setup()
  const first = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'first', payload: payload(s.a) }))
  await finished(s.service, first.id)
  s.remote.setMode('stale')
  const second = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'second', payload: payload(s.a) }))
  expect(await finished(s.service, second.id)).toMatchObject({ state: 'unconfirmed', postId: null })
  expect(s.db.listPublications().filter(item => item.postId === '701').map(item => item.id)).toEqual([first.id])
})

it('serializes the actual cookie across removal and reimport while other cookies remain independent', async () => {
  const s = await setup()
  const identities = createIdentityService({ store: asyncStore(s.db), storageState: () => 'ready', protector: {
    isAvailable: async () => true, encrypt: async text => Buffer.from(text), decrypt: async bytes => Buffer.from(bytes).toString()
  } })
  s.remote.setMode('hold')
  const first = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'first', payload: payload(s.a) }))
  await expect.poll(() => s.remote.seen.filter(r => r.path.startsWith('/Home/')).length).toBe(1)
  expect(await identities.remove(s.a)).toEqual({ ok: true })
  const imported = await identities.importRaw('cookie-A', 'IdA', 'A reimported')
  if (!imported.ok) throw new Error('reimport failed')
  expect(imported.credential.id).not.toBe(s.a)
  expect(await s.service.submit({ requestId: randomUUID(), editorId: 'second', payload: payload(imported.credential.id) })).toEqual({ kind: 'refused', reason: 'busy' })
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(1)
  s.remote.setMode('success')
  const independent = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'other-cookie', payload: payload(s.b, '另一身份') }))
  expect(await finished(s.service, independent.id)).toMatchObject({ state: 'confirmed' })
  s.remote.release()
  await finished(s.service, first.id)
  const deliberate = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'second', payload: payload(imported.credential.id, '完成后显式发送') }))
  expect(await finished(s.service, deliberate.id)).toMatchObject({ state: 'confirmed' })
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(3)
})

it.each([
  ['export form, then browser form', 'Synthetic+Hold', 'Synthetic%20Hold'],
  ['browser form, then export form', 'Synthetic%20Hold', 'Synthetic+Hold']
])('serializes one actual cookie across its two written forms (%s), on reimport and when both are stored', async (_name, stored, other) => {
  const s = await setup()
  const identities = createIdentityService({ store: asyncStore(s.db), storageState: () => 'ready', protector: {
    isAvailable: async () => true, encrypt: async text => Buffer.from(text), decrypt: async bytes => Buffer.from(bytes).toString()
  } })
  const original = s.db.insertCredential({ name: 'H', cookieId: 'IdH', source: 'export', importedAt: '2026-01-01', ciphertext: Buffer.from(stored) }).id
  // Both forms stored side by side, as imports from before the forms were treated as one cookie may be.
  const coexisting = s.db.insertCredential({ name: 'H2', cookieId: 'IdH', source: 'raw', importedAt: '2026-01-01', ciphertext: Buffer.from(other) }).id
  s.remote.setMode('hold')
  const first = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'first', payload: payload(original) }))
  await expect.poll(() => s.remote.seen.filter(r => r.path.startsWith('/Home/')).length).toBe(1)
  expect(await s.service.submit({ requestId: randomUUID(), editorId: 'coexisting', payload: payload(coexisting) })).toEqual({ kind: 'refused', reason: 'busy' })
  expect(await identities.remove(original)).toEqual({ ok: true })
  expect(await identities.remove(coexisting)).toEqual({ ok: true })
  const imported = await identities.importRaw(`userhash=${other}`, 'IdH', null)
  if (!imported.ok) throw new Error('reimport failed')
  expect(await s.service.submit({ requestId: randomUUID(), editorId: 'second', payload: payload(imported.credential.id) })).toEqual({ kind: 'refused', reason: 'busy' })
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(1)
  s.remote.setMode('success')
  s.remote.release()
  await finished(s.service, first.id)
  const deliberate = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'second', payload: payload(imported.credential.id, '完成后显式发送') }))
  expect(await finished(s.service, deliberate.id)).toMatchObject({ state: 'confirmed' })
})

it('keeps a launch notice only for failures reached without a window, until dismissed', async () => {
  const s = await setup()
  s.remote.setMode('reject')
  const attended = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'shown', payload: payload(s.a, '窗口还在') }))
  expect(await finished(s.service, attended.id)).toMatchObject({ state: 'failed' })
  expect(s.db.listLaunchNotices()).toEqual([])

  s.service.setUnattended(true)
  const unattended = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'gone', payload: payload(s.a, '退出收尾中') }))
  expect(s.service.inFlight().map(run => run.attempt.id)).toEqual([unattended.id])
  expect(await s.service.inFlight()[0]!.done).toMatchObject({ id: unattended.id, state: 'failed', savedDraftId: expect.any(String) })
  expect(s.db.listLaunchNotices()).toMatchObject([{ id: unattended.id, state: 'failed' }])
  s.db.dismissLaunchNotices([unattended.id])
  expect(s.db.listLaunchNotices()).toEqual([])
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(2)
})

it('records a send still running at its original deadline as unknown, never resends it, and lets later evidence update only the record', async () => {
  const s = await setup()
  s.remote.setMode('hold')
  const sent = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'editor-1', payload: payload(s.a) }))
  const [run] = s.service.inFlight()
  expect(run!.deadline).toBe(Date.parse(sent.createdAt) + 1500)
  await expect.poll(() => s.remote.seen.filter(r => r.path.startsWith('/Home/')).length).toBe(1)

  s.service.setUnattended(true)
  expect(await s.service.abandon(sent.id)).toMatchObject({ state: 'unknown', problem: 'network' })
  expect(await s.service.abandon(sent.id)).toBeNull()
  expect(s.db.listLaunchNotices()).toMatchObject([{ id: sent.id, state: 'unknown' }])

  // The app was reopened before exiting: the request's own completion is positive evidence.
  s.service.setUnattended(false)
  s.remote.release()
  expect(await run!.done).toMatchObject({ state: 'confirmed', postId: '701' })
  expect(s.db.listLaunchNotices()).toEqual([])
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(1)
})

it('records a send the forum already accepted as sent with the ID unconfirmed when its deadline passes during confirmation', async () => {
  const s = await setup()
  s.remote.setMode('hold-lookup')
  const sent = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'editor-1', payload: payload(s.a) }))
  await expect.poll(() => s.remote.seen.filter(r => r.path === '/Api/getLastPost').length).toBe(1)
  s.service.setUnattended(true)
  expect(await s.service.abandon(sent.id)).toMatchObject({ state: 'unconfirmed' })
  expect(s.db.listLaunchNotices()).toEqual([])
  s.remote.release()
  await s.service.inFlight()[0]?.done
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(1)
})

it('leaves a launch notice for a send the last run left unfinished', async () => {
  const s = await setup()
  s.remote.setMode('hold')
  const sent = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'editor-1', payload: payload(s.a) }))
  await expect.poll(() => s.remote.seen.filter(r => r.path.startsWith('/Home/')).length).toBe(1)
  await s.restart()
  expect(s.db.listLaunchNotices()).toMatchObject([{ id: sent.id, state: 'unknown' }])
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(1)
})

it('fails an unknown send the check cannot find as possibly sent, keeps its image in its draft and frees the editor', async () => {
  const s = await setup({ afterSendMs: 0, onRecover: false })
  const image = Buffer.alloc(64)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]).copy(image)
  image.write('IHDR', 12); image.writeUInt32BE(2, 16); image.writeUInt32BE(1, 20)
  const file = join(s.dir, 'source.png'); writeFileSync(file, image)
  const attached = await s.drafts.attachImage('window', 'editor-1', file)
  if (!attached.ok) throw new Error('attach failed')
  const data = { ...payload(s.a), attachmentId: attached.attachment.id }
  const saved = await s.drafts.save(data)
  if (!saved.ok) throw new Error('save failed')
  data.draftId = saved.draft.id
  // The forum took the POST, but does not show it yet when the check reads.
  s.remote.lag()
  s.remote.setMode('drop')
  const lost = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'editor-1', payload: data }))
  await expect.poll(() => s.db.getPublication(lost.id)?.state).toBe('failed')
  expect(s.db.getPublication(lost.id)).toMatchObject({ problem: 'unverified', savedDraftId: data.draftId })
  expect(s.db.listDrafts()).toMatchObject([{ id: data.draftId, fields: { content: '测试正文' }, attachment: { id: data.attachmentId } }])
  expect(existsSync(s.files.pathOf(s.db.getDraftAttachment(data.attachmentId)!.fileName)!)).toBe(true)

  s.remote.catchUp()
  s.remote.setMode('success')
  const again = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'editor-1', payload: { ...data, fields: { ...data.fields, content: '改过再发' } } }))
  expect(again.id).not.toBe(lost.id)
  expect(await finished(s.service, again.id)).toMatchObject({ state: 'confirmed' })
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(2)
})

it('keeps the 饼干 ID a send was made with after that cookie’s ID changes or the cookie is removed', async () => {
  const s = await setup()
  const sent = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'editor-1', payload: payload(s.a) }))
  expect(await finished(s.service, sent.id)).toMatchObject({ state: 'confirmed', cookieId: 'IdA' })
  s.db.setCredentialCookieId(s.a, 'Changed', new Date().toISOString())
  expect(s.db.getPublication(sent.id)).toMatchObject({ cookieId: 'IdA' })
  s.db.deleteCredential(s.a)
  await s.restart()
  expect(s.db.getPublication(sent.id)).toMatchObject({ cookieId: 'IdA' })
})

/** A send whose POST reached the forum but whose connection then dropped: 结果不明 (checks off). */
async function lose(s: Awaited<ReturnType<typeof setup>>, data: DraftSaveInput, editorId = randomUUID()) {
  s.remote.setMode('drop')
  const lost = attempt(await s.service.submit({ requestId: randomUUID(), editorId, payload: data }))
  expect(await finished(s.service, lost.id)).toMatchObject({ state: 'unknown' })
  s.remote.setMode('success')
  return lost
}
function postOf(s: Awaited<ReturnType<typeof setup>>, content: string): string {
  return s.remote.posts().filter(post => post.content === content).at(-1)!.id!
}
const posts = (s: Awaited<ReturnType<typeof setup>>) => s.remote.seen.filter(r => r.path.startsWith('/Home/')).length
/** Restarts with the startup check on and waits until it has ended this send's unknown result. */
async function checkedAtStart(s: Awaited<ReturnType<typeof setup>>, id: string) {
  await s.restart({ afterSendMs: null, onRecover: true })
  await expect.poll(() => s.db.getPublication(id)?.state).not.toBe('unknown')
  return s.db.getPublication(id)!
}

it('fails a send whose connection was never established: nothing reached the forum', async () => {
  const closed = createServer()
  await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
  const address = closed.address()
  if (!address || typeof address === 'string') throw new Error('listen failed')
  await new Promise<void>(resolve => closed.close(() => resolve()))
  const origin = `http://127.0.0.1:${address.port}`
  const adapter = createPublicationAdapter({ origin, apiOrigin: origin, publishTimeoutMs: 1000 })
  expect(await adapter.publish({ payload: payload('1'), userhash: 'cookie-A', attachment: null })).toEqual({ state: 'failed', problem: 'network' })
  // An attachment that cannot be read is not sent either.
  expect(await adapter.publish({ payload: payload('1'), userhash: 'cookie-A', attachment: { path: join(tmpdir(), `missing-${randomUUID()}.png`), format: 'png' } }))
    .toEqual({ state: 'failed', problem: 'attachment' })
})

it('confirms a lost new thread and a lost reply by reading the forum after the send, without sending again', async () => {
  const s = await setup({ afterSendMs: 0, onRecover: false })
  const source = await s.drafts.save(payload(s.a, '断开的新串'))
  if (!source.ok) throw new Error('save failed')
  // The POST's connection drops after the forum took it: only the check can confirm it.
  s.remote.setMode('drop')
  const thread = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'thread', payload: { ...payload(s.a, '断开的新串'), draftId: source.draft.id } }))
  const reply = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'reply', payload: { ...payload(s.b, '断开的回复\n第二行'), target: { kind: 'reply', threadId: '500' } } }))
  const read = async (id: string) => { const result = await s.service.getAttempt({ attemptId: id }); return result.ok ? result.attempt : null }
  await expect.poll(async () => (await read(thread.id))?.state).toBe('confirmed')
  await expect.poll(async () => (await read(reply.id))?.state).toBe('confirmed')
  const threadId = postOf(s, '断开的新串')
  expect(await read(thread.id)).toMatchObject({ postId: threadId, threadId })
  expect(await read(reply.id)).toMatchObject({ postId: postOf(s, '断开的回复<br />\n第二行'), threadId: '500' })
  // As for any confirmed send: its source draft goes, and nothing is left in progress.
  expect(s.db.listDrafts()).toEqual([])
  expect(s.db.listPublications().filter(isUnsettled)).toEqual([])
  expect(posts(s)).toBe(2)
})

it('names the post of a send whose number was unconfirmed when the later check finds it, and leaves it sent when not', async () => {
  const checked: PublicationAttempt[] = []
  const s = await setup({ afterSendMs: 0, onRecover: false }, { onChecked: value => { checked.push(value) } })
  s.remote.setMode('empty')
  const found = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'found', payload: payload(s.a, '没拿到串号') }))
  await expect.poll(() => s.db.getPublication(found.id)?.state).toBe('confirmed')
  expect(s.db.getPublication(found.id)).toMatchObject({ postId: postOf(s, '没拿到串号') })
  // Windows are told, so an open 发送记录 shows the number without being read again by hand.
  expect(checked).toEqual([expect.objectContaining({ id: found.id, state: 'confirmed', postId: postOf(s, '没拿到串号') })])

  s.remote.lag()
  const hidden = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'hidden', payload: payload(s.b, '论坛还没显示') }))
  await expect.poll(() => s.remote.seen.filter(r => r.path.startsWith('/api/showf')).length).toBe(4)
  expect(s.db.getPublication(hidden.id)).toMatchObject({ state: 'unconfirmed', postId: null })
  expect(posts(s)).toBe(2)
  // Nothing changed: no notice, and nothing reads it again.
  expect(checked.map(item => item.id)).toEqual([found.id])
})

it.each([
  ['another cookie’s 饼干 ID', { user_hash: 'IdB' }],
  ['other text', { content: '别的内容' }],
  ['another title', { title: '别的标题' }],
  ['an image the send did not have', { img: 'test/other', ext: '.jpg' }],
  ['a time before the send', { now: forumNow(Date.now() - 10 * 60_000) }]
])('fails a lost send as unverified when the only candidate post has %s', async (_case, patch) => {
  const s = await setup()
  const lost = await lose(s, payload(s.a, '断开的新串'))
  s.remote.edit(postOf(s, '断开的新串'), patch)
  expect(await checkedAtStart(s, lost.id)).toMatchObject({ state: 'failed', problem: 'unverified', savedDraftId: expect.any(String) })
  expect(posts(s)).toBe(1)
})

it('never takes a post another send already holds, and does not choose between two equal candidates', async () => {
  const s = await setup()
  const first = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'first', payload: payload(s.a, '同样的内容') }))
  expect(await finished(s.service, first.id)).toMatchObject({ state: 'confirmed' })
  const lost = await lose(s, payload(s.a, '同样的内容'))
  // The earlier post is the first send's; only the later one can be this send's.
  expect(await checkedAtStart(s, lost.id)).toMatchObject({ state: 'confirmed', postId: postOf(s, '同样的内容') })
  const again = await lose(s, payload(s.b, '又一条'))
  s.remote.add({ content: '又一条', title: '测试标题', user_hash: 'IdB' })
  expect(await checkedAtStart(s, again.id)).toMatchObject({ state: 'failed', problem: 'unverified' })
})

it('fails without reading the forum a lost send whose 饼干 ID was not known', async () => {
  const s = await setup()
  // A cookie imported before 饼干 IDs were kept.
  const unknownId = s.db.insertCredential({ name: 'C', cookieId: 'IdC', source: 'raw', importedAt: '2026-01-01', ciphertext: Buffer.from('cookie-C') }).id
  const raw = new Database(join(s.dir, 'db.sqlite'))
  try { raw.prepare('UPDATE credentials SET cookie_id = NULL WHERE id = ?').run(unknownId) } finally { raw.close() }
  const anonymous = await lose(s, payload(unknownId, '不知道饼干 ID'))
  const reads = s.remote.seen.length
  expect(await checkedAtStart(s, anonymous.id)).toMatchObject({ state: 'failed', problem: 'unverified' })
  expect(s.remote.seen).toHaveLength(reads)
})

it('checks sends an earlier run left without a result once at start; a throttled read fails them with their launch notice kept', async () => {
  const s = await setup()
  const left = await lose(s, payload(s.a, '上次断开'))
  expect(await checkedAtStart(s, left.id)).toMatchObject({ state: 'confirmed', postId: postOf(s, '上次断开') })

  s.remote.setMode('hold')
  const unfinished = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'unfinished', payload: payload(s.b, '退出时还在发') }))
  await expect.poll(() => posts(s)).toBe(2)
  s.remote.setMode('read-rate')
  // Left `sending`: recovered as unknown with a launch notice, then checked.
  expect(await checkedAtStart(s, unfinished.id)).toMatchObject({ state: 'failed', problem: 'unverified' })
  expect(s.db.listLaunchNotices()).toMatchObject([{ id: unfinished.id, state: 'failed', problem: 'unverified' }])
  expect(posts(s)).toBe(2)
})

it('finds a lost send with dice by the same comparison as the read-back, for a new thread and a reply', async () => {
  const s = await setup()
  const thread = await lose(s, payload(s.a, '掷骰[1,5]'))
  const reply = await lose(s, { ...payload(s.b, '再掷[3]'), target: { kind: 'reply', threadId: '500' } })
  await s.restart({ afterSendMs: null, onRecover: true })
  await expect.poll(() => [thread.id, reply.id].map(id => s.db.getPublication(id)?.state)).toEqual(['confirmed', 'confirmed'])
  expect(s.db.getPublication(thread.id)!.postId).toBe(postOf(s, '掷骰<b>2</b><small>[1,5]</small>'))
  expect(s.db.getPublication(reply.id)!.postId).toBe(postOf(s, '再掷<b>2</b><small>[3]</small>'))
})

it('reads at most three trailing pages of a reply’s thread, counting a page the reply count does not show yet', async () => {
  const s = await setup()
  for (let i = 0; i < 75; i++) s.remote.add({ resto: '500', content: `别人的回复${i}`, user_hash: 'Other' })
  const lost = await lose(s, { ...payload(s.a, '最后一条'), target: { kind: 'reply', threadId: '500' } })
  // 76 replies, counted as 75: page 4 looks last and full, page 5 holds the lost reply.
  s.remote.lagCount(1)
  const before = s.remote.seen.length
  expect(await checkedAtStart(s, lost.id)).toMatchObject({ state: 'confirmed', postId: postOf(s, '最后一条') })
  const pages = s.remote.seen.slice(before).filter(r => r.path.startsWith('/api/thread')).map(r => Number(new URL(r.path, 'http://local').searchParams.get('page') ?? '1'))
  expect(pages.filter(page => page !== 1)).toEqual([4, 5, 3])
})

it('checks a lost send once its result could be stored after all, without sending again', async () => {
  const s = await setup({ afterSendMs: 0, onRecover: false })
  let broken = true
  const base = asyncStore(s.db)
  const store = new Proxy(base, { get(target, key) {
    const value = Reflect.get(target, key)
    return key === 'finishPublication' ? (...args: unknown[]) => broken ? Promise.reject(new Error('controlled write failure')) : Reflect.apply(value, target, args) : value
  } }) as AppStore
  const { service } = await s.start(store, { afterSendMs: 0, onRecover: false })
  s.remote.lag()
  s.remote.setMode('drop')
  const lost = attempt(await service.submit({ requestId: randomUUID(), editorId: 'editor-1', payload: payload(s.a, '先没存上') }))
  await expect.poll(() => service.unstoredResults().map(item => item.id)).toEqual([lost.id])
  broken = false
  expect(await service.retryUnstored()).toBe(true)
  // Stored as unknown, then the one check runs: the forum does not show it, so it goes to a draft.
  await expect.poll(() => s.db.getPublication(lost.id)?.state).toBe('failed')
  expect(s.db.getPublication(lost.id)).toMatchObject({ problem: 'unverified' })
  const read = await service.getAttempt({ attemptId: lost.id })
  expect(read.ok && read.attempt?.state).toBe('failed')
  expect(posts(s)).toBe(1)
})
