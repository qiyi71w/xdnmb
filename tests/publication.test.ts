import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { EMPTY_FIELDS, type DraftSaveInput } from '../src/shared/drafts'
import type { PublicationAttempt, SubmitResult } from '../src/shared/publication'
import type { AppStore } from '../src/main/storage/contract'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { createDraftService } from '../src/main/drafts/service'
import { openManagedImageFiles } from '../src/main/images/files'
import { createPublicationService } from '../src/main/publication/service'
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

async function forum() {
  const seen: Array<{ path: string; cookie: string; body: string }> = []
  let mode: 'success' | 'reject' | 'drop' | 'unrelated' | 'empty' | 'hold' | 'preflight-rate' | 'stale' = 'success'
  let release: (() => void) | null = null
  let last: Record<string, string> | null = null
  let number = 700
  const posts = new Map<string, Record<string, string>>()
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
      last = { id, resto: fields.resto ?? '0', fid: fields.fid ?? '1', content: fields.content!.replace(/\r\n?/g, '\n').replace(/\n/g, '<br />\n'), title: fields.title!, name: fields.name!, email: fields.email!, img: body.includes('name="image"') ? 'test/image' : '', ext: '.png' }
      posts.set(id, last)
      if (mode === 'stale') last = posts.get('701')!
      if (mode === 'drop') { req.socket.destroy(); return }
      const respond = () => {
        res.setHeader('Set-Cookie', 'PHPSESSID=controlled-session; Path=/')
        res.setHeader('Content-Type', 'text/html')
        res.end(mode === 'reject' ? '<p class="error">发布太频繁</p>' : '<p class="success">成功</p>')
      }
      if (mode === 'hold') release = respond
      else respond()
    } else if (path === '/Api/getLastPost') {
      if (mode === 'empty') send(null)
      else if (mode === 'unrelated') send({ ...last, content: '别人的内容' })
      else send(last)
    } else if (path.startsWith('/api/getForumList')) send(mode === 'preflight-rate' ? '请求太频繁' : [{ id: '1', name: '测试', forums: [{ id: '1', name: '测试版', msg: '', interval: 0 }] }])
    else if (path.startsWith('/api/getTimelineList')) send([])
    else if (path.startsWith('/api/thread')) {
      const id = new URL(path, 'http://local').searchParams.get('id')!
      send({ ...(posts.get(id) ?? { id, fid: '1', content: '主帖', title: '', name: '', img: '' }), Replies: [], ReplyCount: 0 })
    } else if (path.startsWith('/api/ref')) send(posts.get(new URL(path, 'http://local').searchParams.get('id')!) ?? null)
    else { res.statusCode = 404; res.end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('listen failed')
  return { origin: `http://127.0.0.1:${address.port}`, seen, setMode(value: typeof mode) { mode = value }, release() { release?.() } }
}

async function setup() {
  const remote = await forum()
  const dir = mkdtempSync(join(tmpdir(), 'xidao-publication-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  let db = openReadingDatabase(join(dir, 'db.sqlite'))
  cleanups.push(() => db.close())
  const protector = { isAvailable: async () => true, encrypt: async (s: string) => Buffer.from(s), decrypt: async (b: Uint8Array) => Buffer.from(b).toString() }
  const a = db.insertCredential({ name: 'A', source: 'raw', importedAt: '2026-01-01', ciphertext: Buffer.from('cookie-A') }).id
  const b = db.insertCredential({ name: 'B', source: 'raw', importedAt: '2026-01-01', ciphertext: Buffer.from('cookie-B') }).id
  const files = await openManagedImageFiles(join(dir, 'draft-images'))
  const start = async (store: AppStore = asyncStore(db)) => {
    const drafts = createDraftService({ store, files })
    const service = createPublicationService({ store, drafts, files, protector,
      clientFor: userhash => createForumClient({ transport: createForumTransport({ allowedOrigins: [remote.origin], credentialOrigins: [remote.origin] }), baseUrl: remote.origin, browseIdentity: async () => userhash }),
      adapter: createPublicationAdapter({ origin: remote.origin, apiOrigin: remote.origin, publishTimeoutMs: 1500 }) })
    await service.recover(); await drafts.recover()
    return { service, drafts }
  }
  let current = await start()
  return { remote, dir, files, a, b, get db() { return db }, get service() { return current.service }, get drafts() { return current.drafts }, start,
    async restart() { db.close(); db = openReadingDatabase(join(dir, 'db.sqlite')); current = await start() } }
}
function payload(credentialId: string, content = '测试正文'): DraftSaveInput {
  return { draftId: null, target: { kind: 'thread', forumId: '1' }, credentialId, fields: { ...EMPTY_FIELDS, content, title: '测试标题' }, attachmentId: null }
}
function attempt(result: SubmitResult): PublicationAttempt {
  if (result.kind !== 'attempt') throw new Error(`Expected attempt: ${JSON.stringify(result)}`)
  return result.attempt
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
  expect(s.db.listOwnPosts()).toEqual([{ postId: '701', threadId: '701', isThread: true, credentialId: s.a, evidence: 'submission-readback', confirmedAt: expect.any(String) }])
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

it('releases a refused PO choice so an edited retry cannot submit the old frozen prompt', async () => {
  const s = await setup()
  const head = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'head', payload: payload(s.a) }))
  await finished(s.service, head.id)
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
  expect(s.db.listOwnPosts()).toEqual([])
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

it.each(['empty', 'unrelated'] as const)('does not claim a %s latest-post response or retry a successful submission', async mode => {
  const s = await setup()
  s.remote.setMode(mode)
  const input = { requestId: randomUUID(), editorId: 'editor-1', payload: payload(s.a) }
  const sent = attempt(await s.service.submit(input))
  expect(await finished(s.service, sent.id)).toMatchObject({ state: 'unconfirmed', postId: null })
  expect(attempt(await s.service.submit({ ...input, requestId: randomUUID() })).id).toBe(sent.id)
  await s.restart()
  expect(s.db.listPublications()[0]!.state).toBe('unconfirmed')
  expect(s.db.listOwnPosts()).toEqual([])
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
  expect(s.db.listOwnPosts()).toEqual([])
  expect(s.remote.seen.filter(r => r.path.startsWith('/Home/'))).toHaveLength(1)
})

it('PO cancel changes nothing; switch remembers the actual identity; suppression is runtime-scoped and re-enable clears it', async () => {
  const s = await setup()
  const head = attempt(await s.service.submit({ requestId: randomUUID(), editorId: 'head', payload: payload(s.a) }))
  await finished(s.service, head.id)
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
  s.db.deleteCredential(s.a)
  const missing = await s.service.submit(reply())
  if (missing.kind !== 'prompt') throw new Error('known removed PO should still prompt')
  expect(missing.prompt.canSwitch).toBe(false)
  expect(await s.service.resolvePrompt({ token: missing.prompt.token, choice: 'switch', suppress: false })).toEqual({ kind: 'refused', reason: 'identity' })
})

it('manual old IDs retain human evidence and never acquire a credential from the current selection', async () => {
  const s = await setup()
  s.db.setThreadPostIdentity('800', s.a, '2026-01-01')
  expect(await s.service.addOwnPost({ postId: '800', threadId: '800', isThread: true })).toEqual({ ok: true })
  const result = await s.service.listOwnPosts()
  expect(result).toMatchObject({ ok: true, posts: [{ postId: '800', credentialId: null, evidence: 'manual' }] })
  const sent = await s.service.submit({ requestId: randomUUID(), editorId: 'new', payload: { ...payload(s.b), target: { kind: 'reply', threadId: '800' } } })
  expect(sent.kind).toBe('attempt')
  await finished(s.service, attempt(sent).id)
  expect(await s.service.addOwnPost({ postId: '800', threadId: '900', isThread: false })).toEqual({ ok: false, reason: 'storage' })
  expect(s.db.listOwnPosts().find(post => post.postId === '800')!.credentialId).toBeNull()
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
  expect(s.db.listOwnPosts().map(post => post.postId)).toEqual(['701'])
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
  const imported = await identities.importRaw('cookie-A', 'A reimported')
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
