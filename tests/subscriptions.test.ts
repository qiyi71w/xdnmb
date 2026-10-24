import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubscriptionResult, SubscriptionSource } from '../src/shared/subscriptions'
import type { SecretProtector } from '../src/main/identity/protection'
import type { AppStore } from '../src/main/storage/contract'
import { openReadingDatabase } from '../src/main/storage/database'
import type { ReadingDatabase } from '../src/main/storage/database'
import { MIGRATIONS } from '../src/main/storage/migrations'
import { openReadingStore } from '../src/main/storage/store'
import { createForumTransport } from '../src/main/forum/transport'
import { createRequestScheduler } from '../src/main/reading/scheduler'
import { createSubscriptionService } from '../src/main/subscriptions/service'
import type { SubscriptionService } from '../src/main/subscriptions/service'
import { parseAppList } from '../src/main/subscriptions/protocol'
import { asStore } from './helpers/store'

const UUID_A = '00000000-0000-4000-8000-000000000001'
const UUID_B = '00000000-0000-4000-8000-000000000002'
const COOKIE_A = 'SyntheticSubscriptionA'
const COOKIE_B = 'SyntheticSubscriptionB'
const signal = () => new AbortController().signal
const folders: string[] = []
const databases = new Set<ReadingDatabase>()
const servers: Server[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const db of databases) db.close()
  databases.clear()
  for (const server of servers.splice(0)) {
    const { promise, resolve } = Promise.withResolvers<void>()
    server.close(() => resolve())
    server.closeAllConnections()
    await promise
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

class Protector implements SecretProtector {
  available = true
  decryptFails = false
  async isAvailable() { return this.available }
  async encrypt(value: string) {
    if (!this.available) throw new Error('locked')
    return Uint8Array.from(Buffer.from(value).map((byte) => byte ^ 0xa5))
  }
  async decrypt(value: Uint8Array) {
    if (!this.available || this.decryptFails) throw new Error('locked')
    return Buffer.from(value.map((byte) => byte ^ 0xa5)).toString()
  }
}

function path() {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-subscriptions-'))
  folders.push(folder)
  return join(folder, 'app.sqlite')
}

function open(file: string) {
  const db = openReadingDatabase(file)
  databases.add(db)
  return db
}

function unwrap<T>(result: SubscriptionResult<T>): T {
  if (!result.ok) throw new Error(`Unexpected failure: ${result.reason}`)
  return result.value
}

interface RequestRecord { path: string; cookie: string | undefined; uuid: string | null; page: number }
async function fixture() {
  const app = new Map<string, Set<string>>([[UUID_A, new Set(['1001', '1002'])], [UUID_B, new Set(['2001'])]])
  const web = new Map<string, Set<string>>([[COOKIE_A, new Set(['3001'])], [COOKIE_B, new Set(['4001'])]])
  const requests: RequestRecord[] = []
  const behavior = { dropNextWrite: false, failPage: 0, ignoreWrites: false, writeFailure: null as 'rate-limit' | 'captcha' | null, onWrite: null as null | (() => Promise<void>) }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    const isWeb = url.pathname.startsWith('/Forum/') || url.pathname.startsWith('/Home/')
    const page = isWeb ? Number(/\/page\/(\d+)/.exec(url.pathname)?.[1] ?? 0) : Number(url.searchParams.get('page') ?? 0)
    requests.push({ path: url.pathname, cookie: request.headers.cookie, uuid: url.searchParams.get('uuid'), page })
    const secret = isWeb ? (request.headers.cookie ?? '').replace(/^userhash=/, '') : url.searchParams.get('uuid') ?? ''
    const collection = (isWeb ? web : app).get(secret)
    const write = /(?:addFeed|delFeed)/.test(url.pathname)
    response.setHeader('Content-Type', isWeb ? 'text/html; charset=utf-8' : 'application/json')
    if (!collection) { response.end(isWeb ? '<p class="error">请确认饼干是否应用正确？</p>' : JSON.stringify('权限不足')); return }
    if (write) {
      if (behavior.writeFailure === 'rate-limit') { response.statusCode = 429; response.end('limited'); return }
      if (behavior.writeFailure === 'captcha') {
        response.end(isWeb ? '<p class="error">需要验证码</p>' : JSON.stringify('需要验证码'))
        return
      }
      const tid = isWeb ? /\/tid\/(\d+)/.exec(url.pathname)?.[1] : url.searchParams.get('tid')
      if (tid && !behavior.ignoreWrites) { if (url.pathname.includes('addFeed')) collection.add(tid); else collection.delete(tid) }
      if (behavior.onWrite) await behavior.onWrite()
      if (behavior.dropNextWrite) { behavior.dropNextWrite = false; request.socket.destroy(); return }
      const message = url.pathname.includes('addFeed') ? '订阅大成功→_→' : '取消订阅成功!'
      response.end(isWeb ? `<p class="success">${message}</p>` : JSON.stringify(message))
      return
    }
    if (page === behavior.failPage) { response.statusCode = 503; response.end('temporary'); return }
    // Deliberately tiny non-final pages prove that short pages cannot end the read.
    const ids = [...collection].slice(page - 1, page)
    response.end(isWeb ? `<html><head><title>网页订阅</title></head><body><div class="h-threads-list">${ids.map((id) => `<div class="h-threads-item-main" data-threads-id="${id}"><a class="h-threads-info-id" href="/t/${id}">No.${id}</a><div class="h-threads-content">正文 验证码 饼干 请登录</div></div>`).join('')}</div></body></html>`
      : JSON.stringify(ids.map((id) => ({ id, fid: '4', content: '正文', title: `串${id}` }))))
  })
  servers.push(server)
  const { promise, resolve } = Promise.withResolvers<void>()
  server.listen(0, '127.0.0.1', () => resolve())
  await promise
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture address')
  return { origin: `http://127.0.0.1:${address.port}`, app, web, requests, behavior }
}

async function setup() {
  const file = path()
  const db = open(file)
  const protector = new Protector()
  const remote = await fixture()
  const store = asStore(db)
  const scheduler = createRequestScheduler()
  const transport = createForumTransport({ allowedOrigins: [remote.origin], credentialOrigins: [remote.origin] })
  let clock = new Date('2026-10-23T12:00:00.000Z')
  const create = (selectedStore: AppStore = store) => createSubscriptionService({
    store: selectedStore, protector, scheduler, transport, appOrigin: remote.origin, webOrigin: remote.origin, now: () => clock
  })
  const service = create()
  const a = db.insertCredential({ name: '固定对象甲', source: 'raw', importedAt: clock.toISOString(), ciphertext: await protector.encrypt(COOKIE_A) })
  const b = db.insertCredential({ name: '固定对象乙', source: 'raw', importedAt: clock.toISOString(), ciphertext: await protector.encrypt(COOKIE_B) })
  db.setRoleSelection('web-sync', a.id)
  db.setRoleSelection('browse', b.id)
  db.setRoleSelection('default-post', b.id)
  return { file, db, protector, remote, store, create, service, a, b, setTime(value: string) { clock = new Date(value) } }
}

async function scan(service: SubscriptionService, source: SubscriptionSource) {
  let value = unwrap(await service.read({ source, observationId: null, operationId: 'read' }, signal()))
  while (value.nextPage !== null && !value.error && !value.cancelled) value = unwrap(await service.read({ source, observationId: value.id, operationId: 'read' }, signal()))
  return value
}
async function change(service: SubscriptionService, source: SubscriptionSource, threadId: string, action: 'add' | 'remove', abortSignal = signal()) {
  const overview = await service.getOverview()
  return service.change({ source, threadId, action, expectedGeneration: overview.context.generation, operationId: 'change' }, abortSignal)
}

const writes = (requests: RequestRecord[]) => requests.filter((request) => /addFeed|delFeed/.test(request.path))

describe('protected subscription configuration and observations', () => {
  it('has no implicit UUID; replaces immutable refs only for a real change and isolates roles', async () => {
    const { service, db, protector, a, b, file } = await setup()
    const initial = await service.getOverview()
    expect(initial.appConfigured).toBe(false)
    expect(await service.read({ source: 'app', observationId: null, operationId: 'read' }, signal())).toEqual({ ok: false, reason: 'unconfigured' })
    const configured = unwrap(await service.configureApp({ uuid: UUID_A }))
    const same = unwrap(await service.configureApp({ uuid: UUID_A.toUpperCase() }))
    expect(same.context).toEqual(configured.context)
    await service.selectSource({ source: 'web' })
    expect((await service.getOverview()).context).toEqual(configured.context)
    db.setRoleSelection('browse', a.id)
    db.setRoleSelection('default-post', a.id)
    expect((await service.getOverview()).context).toEqual(configured.context)
    db.setRoleSelection('web-sync', b.id)
    const rebound = await service.getOverview()
    expect(rebound.context.generation).toBe(configured.context.generation + 1)
    db.setRoleSelection('web-sync', b.id)
    expect((await service.getOverview()).context).toEqual(rebound.context)
    const replaced = unwrap(await service.configureApp({ uuid: UUID_B }))
    expect(replaced.context.generation).toBe(rebound.context.generation + 1)
    expect(replaced.context.appCredentialId).not.toBe(configured.context.appCredentialId)
    expect(await protector.decrypt(db.loadSubscriptionAppCiphertext(configured.context.appCredentialId!)!)).toBe(UUID_A)
    expect(db.loadRoleSelections().browse).toEqual({ state: 'selected', credentialId: a.id })
    const raw = new Database(file, { readonly: true })
    expect(raw.prepare('SELECT id FROM subscription_app_credentials').all()).toHaveLength(2)
    raw.close()
    expect(readFileSync(file).includes(Buffer.from(UUID_A))).toBe(false)
    expect(JSON.stringify(await service.getOverview())).not.toContain(UUID_B)
  })

  it('allows explicit generated UUID only and refuses invalid, locked or missing identities without requests', async () => {
    const { service, protector, remote, db, a } = await setup()
    expect(await service.configureApp({ uuid: 'not-a-uuid' })).toEqual({ ok: false, reason: 'invalid-uuid' })
    expect(unwrap(await service.configureApp({ uuid: null })).appConfigured).toBe(true)
    protector.available = false
    expect(await service.configureApp({ uuid: UUID_A })).toEqual({ ok: false, reason: 'locked' })
    expect(await change(service, 'web', '3001', 'remove')).toEqual({ ok: false, reason: 'locked' })
    protector.available = true
    db.deleteCredential(a.id)
    expect((await service.getOverview()).webSelection).toEqual({ state: 'missing', credentialId: a.id })
    expect(await service.read({ source: 'web', observationId: null, operationId: 'read' }, signal())).toEqual({ ok: false, reason: 'missing' })
    expect(remote.requests).toEqual([])
  })

  it('reads App/web separately through short pages, records fixed contexts, and establishes attention without clearing reads', async () => {
    const { service, db, remote, a, b, setTime } = await setup()
    await service.configureApp({ uuid: UUID_A })
    db.establishAttention('1001', 'favorite', '2026-10-22T00:00:00.000Z')
    const head = parseAppList({ mediaType: 'application/json', text: JSON.stringify([{ id: '1001', content: '已有正文' }]) })[0]!.head
    db.saveThreadPage({ threadId: '1001', mode: 'all', page: 1, head, replies: [], replyCount: null,
      skippedItems: 0, endCandidate: true }, '2026-10-22T00:30:00.000Z')
    db.markPostsRead('1001', ['1001'], '2026-10-22T01:00:00.000Z')
    const app = await scan(service, 'app')
    expect(app.ids).toEqual(['1001', '1002'])
    expect(app.pages.map((page) => page.endCandidate)).toEqual([false, false, true])
    expect(app.pages[0]?.threads[0]?.replyCount).toBeNull()
    expect(app.context.webCredentialId).toBe(a.id)
    expect(remote.requests.filter((request) => request.path === '/Api/feed').every((request) => request.cookie === undefined)).toBe(true)
    setTime('2026-10-23T13:00:00.000Z')
    const web = await scan(service, 'web')
    expect(web.ids).toEqual(['3001'])
    expect(remote.requests.filter((request) => request.path.startsWith('/Forum/')).every((request) => request.cookie === `userhash=${COOKIE_A}`)).toBe(true)
    const state = db.getReadingState('1001')
    expect(state.attention?.startedAt).toBe('2026-10-22T00:00:00.000Z')
    expect(state.readPostIds).toContain('1001')
    expect(db.getReadingState('1002').attention).toMatchObject({ source: 'import', startedAt: '2026-10-23T12:00:00.000Z' })
    expect(db.loadRoleSelections().browse).toEqual({ state: 'selected', credentialId: b.id })
    await service.configureApp({ uuid: UUID_B })
    expect(await service.read({ source: 'app', observationId: app.id, operationId: 'read' }, signal())).toEqual({ ok: false, reason: 'stale' })
    expect(db.loadSubscriptionObservationById(app.id)?.ids).toEqual(app.ids)
  })

  it('keeps a valid original checkpoint after continuation/new-observation errors and cancelled pages', async () => {
    const { service, db, remote } = await setup()
    await service.configureApp({ uuid: UUID_A })
    const first = unwrap(await service.read({ source: 'app', observationId: null, operationId: 'read' }, signal()))
    remote.behavior.failPage = 2
    const failed = unwrap(await service.read({ source: 'app', observationId: first.id, operationId: 'read' }, signal()))
    expect(failed.ids).toEqual(['1001'])
    expect(failed.error?.page).toBe(2)
    remote.behavior.failPage = 1
    const emptyFailure = unwrap(await service.read({ source: 'app', observationId: null, operationId: 'read' }, signal()))
    expect(emptyFailure.pages).toEqual([])
    const context = (await service.getOverview()).context
    expect(db.loadSubscriptionObservation('app', context, true)?.id).toBe(first.id)
    const controller = new AbortController()
    controller.abort()
    const cancelled = unwrap(await service.read({ source: 'app', observationId: first.id, operationId: 'cancel' }, controller.signal))
    expect(cancelled.cancelled).toBe(true)
    expect(cancelled.ids).toEqual(['1001'])
    expect(db.loadSubscriptionObservation('app', context, true)?.error).toBeNull()
  })

  it('uses the shared background lane while foreground work proceeds and queued cancellation sends nothing', async () => {
    const { store, protector, remote } = await setup()
    const scheduler = createRequestScheduler()
    const release = Promise.withResolvers<void>()
    const held = scheduler.run('background', signal(), () => release.promise)
    const service = createSubscriptionService({ store, protector, scheduler,
      transport: createForumTransport({ allowedOrigins: [remote.origin], credentialOrigins: [remote.origin] }),
      appOrigin: remote.origin, webOrigin: remote.origin })
    await service.configureApp({ uuid: UUID_A })
    const controller = new AbortController()
    const pending = service.read({ source: 'app', observationId: null, operationId: 'queued' }, controller.signal)
    await scheduler.run('foreground', signal(), async () => {
      expect(remote.requests).toHaveLength(0)
      controller.abort()
    })
    const cancelled = unwrap(await pending)
    expect(cancelled.cancelled).toBe(true)
    expect(remote.requests).toHaveLength(0)
    release.resolve()
    await held
  })

  it('classifies the 20-second total task deadline as timeout without retrying', async () => {
    const { store, protector, remote } = await setup()
    const entered = Promise.withResolvers<void>()
    const deadline = new AbortController()
    const timeouts = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
    let sent = 0
    const service = createSubscriptionService({ store, protector, scheduler: createRequestScheduler(),
      transport: { async get(_url, requestSignal) {
        sent++
        const { promise, reject } = Promise.withResolvers<never>()
        requestSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        entered.resolve()
        return promise
      } }, appOrigin: remote.origin, webOrigin: remote.origin })
    await service.configureApp({ uuid: UUID_A })
    const pending = service.read({ source: 'app', observationId: null, operationId: 'timeout' }, signal())
    await entered.promise
    deadline.abort(new DOMException('Timed out', 'TimeoutError'))
    const result = unwrap(await pending)
    expect(result).toMatchObject({ error: { page: 1, detail: { kind: 'network', detail: 'timeout' } }, cancelled: false })
    expect(timeouts).toHaveBeenCalledWith(20_000)
    expect(sent).toBe(1)
  })

  it('migrates v4 without changing fixed role references or reading records, and keeps unavailable fallback read-only', async () => {
    const file = path()
    const old = openReadingDatabase(file, MIGRATIONS.filter((migration) => migration.version <= 4))
    const protector = new Protector()
    const cookie = old.insertCredential({ name: '原对象', source: 'raw', importedAt: '2026-10-23', ciphertext: await protector.encrypt(COOKIE_A) })
    // The v4 runtime predates subscription generation tracking; seed its existing role as migration input.
    old.close()
    const raw = new Database(file)
    raw.prepare('INSERT INTO identity_roles (role, credential_id) VALUES (?, ?)').run('web-sync', cookie.id)
    raw.close()
    const db = open(file)
    expect(db.status).toEqual({ state: 'ready', schemaVersion: Math.max(...MIGRATIONS.map((migration) => migration.version)) })
    expect(db.loadSubscriptionConfiguration().context).toEqual({ generation: 0, appCredentialId: null, webCredentialId: cookie.id })
    expect(db.loadRoleSelections()['web-sync']).toEqual({ state: 'selected', credentialId: cookie.id })
    const unavailable = await openReadingStore({ databasePath: file, createWorker() { throw new Error('unavailable') } })
    expect(await unavailable.loadSubscriptionOperations()).toEqual([])
    expect(await unavailable.loadSubscriptionConfiguration()).toMatchObject({ context: { appCredentialId: null } })
    await expect(unavailable.setSubscriptionSource('web')).rejects.toThrow()
  })
})

describe('subscription intent, reports, readback and read-only recovery', () => {
  it('confirms presence, repeat success and supported absence without claiming counts or touching unrelated data', async () => {
    const { service, db, remote } = await setup()
    await service.configureApp({ uuid: UUID_A })
    await scan(service, 'app')
    const added = unwrap(await change(service, 'app', '1003', 'add'))
    expect(added).toMatchObject({ report: 'success', verification: 'present', state: 'settled' })
    expect(db.getReadingState('1003').attention?.source).toBe('subscription')
    const repeated = unwrap(await change(service, 'app', '1003', 'add'))
    expect(repeated).toMatchObject({ report: 'success', verification: 'present' })
    expect(remote.app.get(UUID_A)?.size).toBe(3)
    const removed = unwrap(await change(service, 'app', '1003', 'remove'))
    expect(removed).toMatchObject({ report: 'success', verification: 'absent-supported', state: 'settled' })
    expect(removed.before?.ids).toContain('1003')
    expect(removed.after?.pages.map((page) => page.page)).toEqual([1, 2, 3])
    expect(db.getReadingState('1003').attention?.source).toBe('subscription')
    expect(writes(remote.requests)).toHaveLength(3)
  })

  it('does not infer cancellation from an absent item without an original valid observation', async () => {
    const { service } = await setup()
    await service.configureApp({ uuid: UUID_A })
    const result = unwrap(await change(service, 'app', '9999', 'remove'))
    expect(result).toMatchObject({ report: 'success', before: null, verification: 'absent-unproven', state: 'needs-reconciliation' })
  })

  it('preserves original valid evidence when a later list refresh fails; missing readback pages never prove removal', async () => {
    const { service, remote } = await setup()
    await service.configureApp({ uuid: UUID_A })
    const original = await scan(service, 'app')
    remote.behavior.failPage = 1
    await service.read({ source: 'app', observationId: null, operationId: 'failed-refresh' }, signal())
    remote.behavior.failPage = 2
    const removed = unwrap(await change(service, 'app', '1002', 'remove'))
    expect(removed.before?.id).toBe(original.id)
    expect(removed.after?.error?.page).toBe(2)
    expect(removed.verification).toBe('unknown')
    expect(removed.state).toBe('needs-reconciliation')
    remote.behavior.failPage = 0
    const checked = unwrap(await service.reconcile({ id: removed.id, operationId: 'check' }, signal()))
    expect(checked).toMatchObject({ report: 'success', verification: 'absent-supported', state: 'settled' })
  })

  it('records report/list mismatch and blocks overlapping writes until read-only reconciliation', async () => {
    const { service, remote } = await setup()
    await service.configureApp({ uuid: UUID_A })
    remote.behavior.ignoreWrites = true
    const result = unwrap(await change(service, 'app', '1009', 'add'))
    expect(result).toMatchObject({ report: 'success', verification: 'mismatch', state: 'needs-reconciliation' })
    expect(await change(service, 'app', '1009', 'add')).toEqual({ ok: false, reason: 'busy' })
    await service.configureApp({ uuid: UUID_B })
    await service.configureApp({ uuid: UUID_A })
    expect(await change(service, 'app', '1009', 'add')).toEqual({ ok: false, reason: 'busy' })
    expect(writes(remote.requests)).toHaveLength(1)
  })

  it('fixes in-flight web identity/generation even when binding, source and UI cancellation change', async () => {
    const { service, db, remote, a, b } = await setup()
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    remote.behavior.onWrite = async () => { entered.resolve(); await release.promise }
    const controller = new AbortController()
    const pending = change(service, 'web', '3002', 'add', controller.signal)
    await entered.promise
    expect(await change(service, 'web', '3003', 'add')).toEqual({ ok: false, reason: 'busy' })
    db.setRoleSelection('web-sync', b.id)
    await service.selectSource({ source: 'app' })
    controller.abort()
    release.resolve()
    const result = unwrap(await pending)
    expect(result.context.webCredentialId).toBe(a.id)
    expect(result.objectLabel).toBe('固定对象甲')
    expect(result.report).toBe('success')
    expect(result.after?.cancelled).toBe(true)
    remote.behavior.onWrite = null
    const checked = unwrap(await service.reconcile({ id: result.id, operationId: 'check' }, signal()))
    expect(checked.verification).toBe('present')
    expect(remote.requests.filter((request) => request.path.startsWith('/Home/') || request.path.startsWith('/Forum/')).every((request) => request.cookie === `userhash=${COOKIE_A}`)).toBe(true)
  })

  it('does not send without durable intent; successful report-save interruption survives restart and UUID replacement', async () => {
    const { service, db, file, store, create, remote } = await setup()
    await service.configureApp({ uuid: UUID_A })
    let saves = 0
    const interrupted: AppStore = { ...store, async saveSubscriptionOperation(operation) {
      saves++
      if (saves === 1) throw new Error('intent disk failure')
      await store.saveSubscriptionOperation(operation)
    } }
    expect(await change(create(interrupted), 'app', '1010', 'add')).toEqual({ ok: false, reason: 'storage' })
    expect(writes(remote.requests)).toHaveLength(0)
    saves = 0
    interrupted.saveSubscriptionOperation = async (operation) => {
      saves++
      if (saves === 2) throw new Error('report disk failure')
      await store.saveSubscriptionOperation(operation)
    }
    expect(await change(create(interrupted), 'app', '1010', 'add')).toEqual({ ok: false, reason: 'result-storage' })
    expect(remote.app.get(UUID_A)?.has('1010')).toBe(true)
    const durable = db.loadSubscriptionOperations()[0]!
    expect(durable).toMatchObject({ state: 'pending', report: 'pending', after: null })
    await service.configureApp({ uuid: UUID_B })
    db.close(); databases.delete(db)
    const restarted = create(asStore(open(file)))
    const before = remote.requests.length
    await restarted.recover()
    expect(remote.requests).toHaveLength(before)
    expect((await restarted.getOperations())[0]).toMatchObject({ state: 'needs-reconciliation', report: 'unknown' })
    const checked = unwrap(await restarted.reconcile({ id: durable.id, operationId: 'check' }, signal()))
    expect(checked).toMatchObject({ verification: 'present', report: 'unknown', state: 'settled' })
    expect(remote.requests.slice(before).every((request) => request.uuid === UUID_A)).toBe(true)
    expect(writes(remote.requests)).toHaveLength(1)
  })

  it.each(['report', 'observation', 'final result'] as const)('allows current-session read-only recovery after %s storage fails using the original UUID', async (failure) => {
    const { store, create, remote } = await setup()
    let saves = 0
    let failed = false
    const interrupted: AppStore = { ...store,
      async saveSubscriptionOperation(operation) {
        saves++
        if ((failure === 'report' && saves === 2) || (failure === 'final result' && saves === 3)) {
          failed = true
          throw new Error('result disk failure')
        }
        await store.saveSubscriptionOperation(operation)
      },
      async saveSubscriptionObservation(...args) {
        if (failure === 'observation' && !failed) {
          failed = true
          throw new Error('observation disk failure')
        }
        await store.saveSubscriptionObservation(...args)
      }
    }
    const service = create(interrupted)
    const original = unwrap(await service.configureApp({ uuid: UUID_A }))
    expect(await change(service, 'app', '1010', 'add')).toEqual({ ok: false, reason: 'result-storage' })
    expect(remote.app.get(UUID_A)?.has('1010')).toBe(true)
    const operation = (await service.getOperations())[0]!
    expect(operation).toMatchObject({ state: 'pending', report: failure === 'report' ? 'pending' : 'success',
      reportError: null, context: original.context, after: null, verification: 'unknown' })
    expect(await change(service, 'app', '1010', 'add')).toEqual({ ok: false, reason: 'busy' })
    unwrap(await service.configureApp({ uuid: UUID_B }))
    const before = remote.requests.length
    const checked = unwrap(await service.reconcile({ id: operation.id, operationId: 'manual-check' }, signal()))
    expect(checked).toMatchObject({ state: 'settled', report: failure === 'report' ? 'unknown' : 'success',
      reportError: null, verification: 'present', context: original.context })
    expect(checked.after?.context).toEqual(original.context)
    expect(remote.requests.slice(before).length).toBeGreaterThan(0)
    expect(remote.requests.slice(before).every((request) => request.uuid === UUID_A)).toBe(true)
    expect(writes(remote.requests)).toHaveLength(1)
    expect((await service.getOperations())[0]).toEqual(checked)
  })

  it.each([
    { source: 'app', failure: 'rate-limit' },
    { source: 'app', failure: 'captcha' },
    { source: 'web', failure: 'rate-limit' },
    { source: 'web', failure: 'captcha' }
  ] as const)('stops $source writes on $failure without automatic lists and permits only later read-only reconciliation', async ({ source, failure }) => {
    const { service, remote, db, a, b } = await setup()
    const original = unwrap(await service.configureApp({ uuid: UUID_A }))
    const threadId = source === 'app' ? '1001' : '3001'
    remote.behavior.writeFailure = failure
    const operation = unwrap(await change(service, source, threadId, 'add'))
    expect(operation).toMatchObject({ state: 'needs-reconciliation', report: failure === 'captcha' ? 'rejected' : 'unknown',
      reportError: failure === 'captcha' ? { kind: 'rate-limited', detail: 'business' } : { kind: 'rate-limited', detail: 'http-status', httpStatus: 429 },
      after: null, verification: 'unknown', context: original.context })
    expect(remote.requests).toHaveLength(1)
    expect(writes(remote.requests)).toHaveLength(1)
    expect(await service.getOperations()).toEqual([operation])
    expect(await change(service, source, threadId, 'add')).toEqual({ ok: false, reason: 'busy' })
    expect(remote.requests).toHaveLength(1)
    remote.behavior.writeFailure = null
    unwrap(await service.configureApp({ uuid: UUID_B }))
    db.setRoleSelection('web-sync', b.id)
    const checked = unwrap(await service.reconcile({ id: operation.id, operationId: 'manual-check' }, signal()))
    expect(checked).toMatchObject({ report: operation.report, reportError: operation.reportError,
      state: 'settled', verification: 'present', context: original.context })
    expect(checked.context.webCredentialId).toBe(a.id)
    const reads = remote.requests.slice(1)
    expect(reads.length).toBeGreaterThan(0)
    expect(reads.every((request) => source === 'app' ? request.uuid === UUID_A : request.cookie === `userhash=${COOKIE_A}`)).toBe(true)
    expect(writes(remote.requests)).toHaveLength(1)
    expect((await service.getOperations())[0]).toEqual(checked)
  })

  it('keeps changed-then-dropped removal unknown across restart and never replays or compensates', async () => {
    const { service, db, file, create, remote } = await setup()
    await service.configureApp({ uuid: UUID_A })
    await scan(service, 'app')
    remote.behavior.dropNextWrite = true
    const result = unwrap(await change(service, 'app', '1002', 'remove'))
    expect(result).toMatchObject({ report: 'unknown', verification: 'absent-unproven', state: 'needs-reconciliation' })
    expect(remote.app.get(UUID_A)?.has('1002')).toBe(false)
    db.close(); databases.delete(db)
    const restarted = create(asStore(open(file)))
    const count = remote.requests.length
    await restarted.recover()
    expect(remote.requests).toHaveLength(count)
    const checked = unwrap(await restarted.reconcile({ id: result.id, operationId: 'check' }, signal()))
    expect(checked).toMatchObject({ report: 'unknown', verification: 'absent-unproven' })
    expect(writes(remote.requests)).toHaveLength(1)
    expect(await change(restarted, 'app', '1002', 'remove')).toEqual({ ok: false, reason: 'busy' })
  })

  it('retains successful durable report if after-evidence save fails; restart only reads fixed missing cookie', async () => {
    const { db, file, store, create, remote, a, b } = await setup()
    const interrupted: AppStore = { ...store, async saveSubscriptionObservation() { throw new Error('observation disk failure') } }
    expect(await change(create(interrupted), 'web', '3002', 'add')).toEqual({ ok: false, reason: 'result-storage' })
    const operation = db.loadSubscriptionOperations()[0]!
    expect(operation).toMatchObject({ report: 'success', state: 'pending' })
    db.setRoleSelection('web-sync', b.id)
    db.deleteCredential(a.id)
    db.close(); databases.delete(db)
    const restarted = create(asStore(open(file)))
    const count = remote.requests.length
    await restarted.recover()
    const result = unwrap(await restarted.reconcile({ id: operation.id, operationId: 'check' }, signal()))
    expect(result.after?.error?.detail).toMatchObject({ kind: 'identity', detail: 'identity-missing' })
    expect(result.verification).toBe('unknown')
    expect(remote.requests).toHaveLength(count)
    expect(writes(remote.requests)).toHaveLength(1)
  })
})
