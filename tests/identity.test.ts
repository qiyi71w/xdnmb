import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders, Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createForumClient } from '../src/main/forum/client'
import { ForumReadError } from '../src/main/forum/contract'
import { createForumTransport } from '../src/main/forum/transport'
import { parseExportPayload, parseRawUserhash } from '../src/main/identity/parse'
import { ProtectionUnavailableError, type SecretProtector } from '../src/main/identity/protection'
import { createIdentityService, type IdentityService } from '../src/main/identity/service'
import type { IdentityStore } from '../src/main/storage/contract'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { MIGRATIONS } from '../src/main/storage/migrations'
import { openReadingStore } from '../src/main/storage/store'

// Synthetic values only; none of these is a real forum credential.
const SECRET_A = 'SyntheticHashA%2Fx0'
const SECRET_B = 'SyntheticHashB+y1'
const exportPayload = (cookie: string, name?: string) =>
  Buffer.from(JSON.stringify(name === undefined ? { cookie } : { cookie, name }), 'utf8').toString('base64')

const folders: string[] = []
const databases: ReadingDatabase[] = []
const servers: Server[] = []

afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  await Promise.all(servers.splice(0).map((server) => {
    const { promise, resolve } = Promise.withResolvers<void>()
    server.close(() => resolve())
    server.closeAllConnections()
    return promise
  }))
})

/** Reversible stand-in for safeStorage whose availability and decryption can be broken on demand. */
class ControlledProtector implements SecretProtector {
  available = true
  decryptFails = false
  async isAvailable() { return this.available }
  async encrypt(secret: string) {
    if (!this.available) throw new ProtectionUnavailableError()
    return Uint8Array.from(Buffer.from(secret, 'utf8').map((byte) => byte ^ 0x5a))
  }
  async decrypt(ciphertext: Uint8Array) {
    if (!this.available) throw new ProtectionUnavailableError()
    if (this.decryptFails) throw new Error('decrypt failed')
    return Buffer.from(ciphertext.map((byte) => byte ^ 0x5a)).toString('utf8')
  }
}

function asyncStore(db: ReadingDatabase): IdentityStore {
  return {
    listCredentials: async () => db.listCredentials(),
    loadCredentialCiphertexts: async () => db.loadCredentialCiphertexts(),
    loadCredentialCiphertext: async (id) => db.loadCredentialCiphertext(id),
    insertCredential: async (input) => db.insertCredential(input),
    renameCredential: async (id, name) => db.renameCredential(id, name),
    fillCredentialCookieId: async (id, cookieId, at) => db.fillCredentialCookieId(id, cookieId, at),
    setCredentialCookieId: async (id, cookieId, at) => db.setCredentialCookieId(id, cookieId, at),
    deleteCredential: async (id) => db.deleteCredential(id),
    reorderCredentials: async (ids) => db.reorderCredentials(ids),
    loadRoleSelections: async () => db.loadRoleSelections(),
    setRoleSelection: async (role, id) => db.setRoleSelection(role, id)
  }
}

function setup(path = databasePath(), protector = new ControlledProtector()) {
  const db = openReadingDatabase(path)
  databases.push(db)
  const service = createIdentityService({
    store: asyncStore(db), protector, storageState: () => db.status.state
  })
  return { db, service, protector, path }
}

function databasePath() {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-identity-'))
  folders.push(folder)
  return join(folder, 'identity.sqlite')
}

async function imported(service: IdentityService, secret: string, name: string, cookieId = 'SynthId') {
  const result = await service.importRaw(secret, cookieId, name)
  if (!result.ok) throw new Error(`import failed: ${result.failure.reason}`)
  return result.credential
}

describe('paste entries', () => {
  it('accepts the export payload as Base64 (standard, URL-safe, wrapped) or as its JSON', () => {
    const json = JSON.stringify({ cookie: SECRET_B, name: '饼干甲' })
    const standard = Buffer.from(json).toString('base64')
    const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    const wrapped = `  ${standard.slice(0, 10)}\n${standard.slice(10)}\n`
    for (const input of [standard, urlSafe, wrapped, json]) {
      expect(parseExportPayload(input)).toEqual({ ok: true, userhash: SECRET_B, cookieId: '饼干甲' })
    }
  })

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['不是Base64!!', 'not-base64'],
    [Buffer.from('plain text').toString('base64'), 'not-json'],
    [Buffer.from([0xff, 0xfe, 0xfd]).toString('base64'), 'not-json'],
    [Buffer.from('["array"]').toString('base64'), 'not-json'],
    [exportPayload(''), 'missing-cookie'],
    [Buffer.from(JSON.stringify({ name: 'x' })).toString('base64'), 'missing-cookie'],
    [exportPayload('has space'), 'invalid-cookie'],
    [exportPayload('semi;colon'), 'invalid-cookie'],
    ['A'.repeat(9000), 'too-long'],
    [exportPayload(SECRET_A), 'missing-cookie-id'],
    [exportPayload(SECRET_A, '  '), 'missing-cookie-id'],
    [exportPayload(SECRET_A, 'two words'), 'missing-cookie-id'],
    [exportPayload(SECRET_A, 'x'.repeat(33)), 'missing-cookie-id']
  ])('classifies a bad export payload (%#) as %s', (input, error) => {
    expect(parseExportPayload(input)).toEqual({ ok: false, error })
  })

  it('accepts a raw userhash with or without the cookie name prefix and refuses header-breaking values', () => {
    expect(parseRawUserhash(`  userhash=${SECRET_A} `)).toEqual({ ok: true, userhash: SECRET_A, cookieId: null })
    expect(parseRawUserhash(SECRET_A)).toEqual({ ok: true, userhash: SECRET_A, cookieId: null })
    expect(parseRawUserhash('userhash=')).toEqual({ ok: false, error: 'empty' })
    expect(parseRawUserhash(`${SECRET_A}\r\nX-Injected: 1`)).toEqual({ ok: false, error: 'invalid-cookie' })
    expect(parseRawUserhash('引号"')).toEqual({ ok: false, error: 'invalid-cookie' })
  })
})

describe('identity service with real SQLite', () => {
  it('stores only ciphertext and never returns the secret in overview or failures', async () => {
    const { service, db, path } = setup()
    const first = await service.importExport(exportPayload(SECRET_A, '导出名'), null)
    expect(first).toMatchObject({ ok: true, credential: { name: '导出名', cookieId: '导出名', source: 'export' } })
    const failure = await service.importExport(exportPayload(`${SECRET_A} broken`), null)
    expect(failure).toEqual({ ok: false, failure: { reason: 'format', detail: 'invalid-cookie' } })
    const overview = await service.getOverview()
    db.close()
    const bytes = readFileSync(path)
    for (const visible of [JSON.stringify(overview), JSON.stringify(failure), bytes.toString('latin1')]) {
      expect(visible).not.toContain(SECRET_A)
    }
  })

  it('stores the payload name as 饼干 ID and requires one for a raw userhash; renaming never changes it', async () => {
    const { service } = setup()
    const fromExport = await service.importExport(exportPayload(SECRET_A, 'Abc1234'), '我的显示名')
    expect(fromExport).toMatchObject({ ok: true, credential: { name: '我的显示名', cookieId: 'Abc1234' } })
    expect(await service.importRaw(SECRET_B, '  ', '名称')).toEqual({ ok: false, failure: { reason: 'cookie-id', detail: 'empty' } })
    expect(await service.importRaw(SECRET_B, 'two words', '名称')).toEqual({ ok: false, failure: { reason: 'cookie-id', detail: 'invalid' } })
    expect(await service.importRaw(SECRET_B, 'x'.repeat(33), '名称')).toEqual({ ok: false, failure: { reason: 'cookie-id', detail: 'too-long' } })
    // Without a display name the 饼干 ID is used as one, still stored separately.
    const raw = await service.importRaw(`userhash=${SECRET_B}`, ' Def5678 ', null)
    expect(raw).toMatchObject({ ok: true, credential: { name: 'Def5678', cookieId: 'Def5678', source: 'raw' } })
    if (!fromExport.ok || !raw.ok) throw new Error('import failed')
    expect(await service.rename(fromExport.credential.id, '改了名字')).toEqual({ ok: true })
    expect(await service.rename(raw.credential.id, 'Other99')).toEqual({ ok: true })
    expect((await service.getOverview()).credentials.map(({ name, cookieId }) => ({ name, cookieId }))).toEqual([
      { name: '改了名字', cookieId: 'Abc1234' }, { name: 'Other99', cookieId: 'Def5678' }
    ])
  })

  it('re-importing a stored userhash only fills a missing 饼干 ID, keeps a different one and changes nothing else', async () => {
    const { service, path } = setup()
    const a = await imported(service, SECRET_A, '原名', 'OldA')
    const b = await imported(service, SECRET_B, '另一块', 'IdB')
    await service.select('default-post', a.id)
    await service.select('web-sync', b.id)
    expect(await service.reorder([b.id, a.id])).toEqual({ ok: true })
    // As after the upgrade: the entry kept from before has no 饼干 ID.
    const raw = new Database(path)
    try { raw.prepare('UPDATE credentials SET cookie_id = NULL WHERE id = ?').run(a.id) } finally { raw.close() }
    const before = await service.getOverview()
    expect(before.credentials.find((item) => item.id === a.id)?.cookieId).toBeNull()

    const filled = await service.importExport(exportPayload(SECRET_A, 'Real7Id'), '覆盖名')
    expect(filled).toEqual({ ok: false, failure: { reason: 'duplicate', cookieId: 'filled', existing: { ...a, cookieId: 'Real7Id' } } })
    const expected = { ...before, credentials: before.credentials.map((item) => item.id === a.id ? { ...item, cookieId: 'Real7Id' } : item) }
    expect(await service.getOverview()).toEqual(expected)

    expect(await service.importExport(exportPayload(SECRET_A, 'Changed1'), null)).toEqual({
      ok: false, failure: { reason: 'duplicate', cookieId: 'conflict', existing: { ...a, cookieId: 'Real7Id' } }
    })
    expect(await service.importRaw(`userhash=${SECRET_B}`, 'IdB', '再来')).toEqual({
      ok: false, failure: { reason: 'duplicate', cookieId: 'same', existing: b }
    })
    expect(await service.getOverview()).toEqual(expected)
  })

  it('fills in or changes a 饼干 ID from settings, validating it', async () => {
    const { service } = setup()
    const a = await imported(service, SECRET_A, 'A', 'First1')
    expect(await service.setCookieId(a.id, ' Second2 ')).toEqual({ ok: true })
    expect((await service.getOverview()).credentials[0]).toEqual({ ...a, cookieId: 'Second2' })
    expect(await service.setCookieId(a.id, '')).toEqual({ ok: false, reason: 'cookie-id', cookieIdError: 'empty' })
    expect(await service.setCookieId(a.id, 'a\tb')).toEqual({ ok: false, reason: 'cookie-id', cookieIdError: 'invalid' })
    expect(await service.setCookieId('999', 'Third3')).toEqual({ ok: false, reason: 'not-found' })
    expect((await service.getOverview()).credentials[0]?.cookieId).toBe('Second2')
  })

  it('keeps default-post and web-sync selections independent of the order', async () => {
    const { service } = setup()
    const a = await imported(service, SECRET_A, 'A')
    const b = await imported(service, SECRET_B, 'B')
    await service.select('default-post', b.id)
    await service.select('web-sync', a.id)
    expect(await service.reorder([b.id, a.id])).toEqual({ ok: true })
    expect((await service.getOverview()).roles).toEqual({
      'default-post': { state: 'selected', credentialId: b.id },
      'web-sync': { state: 'selected', credentialId: a.id }
    })
    expect(await service.select('web-sync', '999')).toEqual({ ok: false, reason: 'not-found' })
    expect((await service.getOverview()).roles['web-sync']).toEqual({ state: 'selected', credentialId: a.id })
  })

  it('browses with the first credential of the stored order, none only when the list is empty', async () => {
    const path = databasePath()
    const first = setup(path)
    expect(await first.service.browseUserhash()).toBeNull()
    const a = await imported(first.service, SECRET_A, 'A')
    const b = await imported(first.service, SECRET_B, 'B')
    expect(await first.service.browseUserhash()).toBe(SECRET_A)
    expect(await first.service.reorder([b.id, a.id])).toEqual({ ok: true })
    expect(await first.service.browseUserhash()).toBe(SECRET_B)
    // Only a complete permutation of the stored IDs is accepted.
    expect(await first.service.reorder([a.id])).toEqual({ ok: false, reason: 'not-found' })
    expect(await first.service.reorder([a.id, a.id])).toEqual({ ok: false, reason: 'not-found' })
    expect(await first.service.reorder([a.id, '999'])).toEqual({ ok: false, reason: 'not-found' })
    first.db.close()

    const reopened = setup(path)
    expect((await reopened.service.getOverview()).credentials.map((item) => item.id)).toEqual([b.id, a.id])
    expect(await reopened.service.browseUserhash()).toBe(SECRET_B)
    // A new import goes to the end; removing the first hands browsing to the next one.
    const c = await imported(reopened.service, 'SyntheticHashC', 'C')
    expect((await reopened.service.getOverview()).credentials.map((item) => item.id)).toEqual([b.id, a.id, c.id])
    expect(await reopened.service.remove(b.id)).toEqual({ ok: true })
    expect(await reopened.service.browseUserhash()).toBe(SECRET_A)
  })

  it('migrates the former browse choice to the front of the order and drops the browse role', () => {
    const path = databasePath()
    const old = new Database(path)
    for (const migration of MIGRATIONS.filter((migration) => migration.version <= 10)) migration.up(old)
    old.pragma('user_version = 10')
    const insert = old.prepare("INSERT INTO credentials (name, source, imported_at, ciphertext) VALUES (?, 'raw', '2026-10-23T08:00:00.000Z', x'00')")
    for (const name of ['甲', '乙', '丙']) insert.run(name)
    old.prepare("INSERT INTO identity_roles VALUES ('browse', 2), ('web-sync', 3)").run()
    old.close()

    const { db } = setup(path)
    expect(db.listCredentials().map((item) => item.name)).toEqual(['乙', '甲', '丙'])
    expect(db.loadRoleSelections()).toEqual({ 'default-post': { state: 'none' }, 'web-sync': { state: 'selected', credentialId: '3' } })
    db.close()
    const raw = new Database(path, { readonly: true })
    expect(raw.prepare("SELECT COUNT(*) AS n FROM identity_roles WHERE role = 'browse'").get()).toEqual({ n: 0 })
    raw.close()
  })

  it('keeps a removed credential referenced as missing, never substituting another, across restart', async () => {
    const path = databasePath()
    const first = setup(path)
    const a = await imported(first.service, SECRET_A, 'A')
    const b = await imported(first.service, SECRET_B, 'B')
    await first.service.select('web-sync', a.id)
    await first.service.select('default-post', b.id)
    expect(await first.service.browseUserhash()).toBe(SECRET_A)
    expect(await first.service.remove(a.id)).toEqual({ ok: true })
    expect(await first.service.browseUserhash()).toBe(SECRET_B)
    first.db.close()

    const reopened = setup(path)
    // A new import never reuses the removed ID, so the missing reference cannot silently resolve.
    const c = await imported(reopened.service, SECRET_A, 'A 重新导入')
    expect(c.id).not.toBe(a.id)
    expect((await reopened.service.getOverview()).roles).toEqual({
      'default-post': { state: 'selected', credentialId: b.id },
      'web-sync': { state: 'missing', credentialId: a.id }
    })
    expect((await reopened.service.getOverview()).roles['web-sync'].state).toBe('missing')
  })

  it('refuses imports without OS protection but still allows removal; stored secrets stay blocked', async () => {
    const { service, protector } = setup()
    const a = await imported(service, SECRET_A, 'A')
    protector.available = false
    expect(await service.importRaw(SECRET_B, 'IdB', 'B')).toEqual({ ok: false, failure: { reason: 'protection-unavailable' } })
    expect((await service.getOverview())).toMatchObject({ protection: 'unavailable', credentials: [a] })
    await expect(service.browseUserhash()).rejects.toMatchObject({ error: { kind: 'identity', detail: 'identity-locked' } })
    expect(await service.remove(a.id)).toEqual({ ok: true })
    expect((await service.getOverview()).credentials).toEqual([])
  })

  it('blocks duplicate checks and browse reads when a stored credential cannot be decrypted, keeping it', async () => {
    const { service, protector } = setup()
    const a = await imported(service, SECRET_A, 'A')
    protector.decryptFails = true
    expect(await service.importRaw(SECRET_B, 'IdB', 'B')).toEqual({ ok: false, failure: { reason: 'decrypt-failed' } })
    await expect(service.browseUserhash()).rejects.toMatchObject({ error: { kind: 'identity', detail: 'identity-locked' } })
    expect((await service.getOverview()).credentials).toEqual([a])
  })

  it('serializes concurrent imports of the same value into one credential', async () => {
    const { service } = setup()
    const results = await Promise.all([service.importRaw(SECRET_A, 'IdA', 'one'), service.importRaw(SECRET_A, 'IdA', 'two')])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.find((result) => !result.ok)).toMatchObject({ failure: { reason: 'duplicate' } })
  })

  it('stops using a cached browse secret once OS protection becomes unavailable, keeping it stored', async () => {
    const { service, protector } = setup()
    const a = await imported(service, SECRET_A, 'A')
    expect(await service.browseUserhash()).toBe(SECRET_A)
    protector.available = false
    await expect(service.browseUserhash()).rejects.toMatchObject({ error: { kind: 'identity', detail: 'identity-locked' } })
    expect((await service.getOverview()).credentials).toEqual([a])
    protector.available = true
    expect(await service.browseUserhash()).toBe(SECRET_A)
  })

  it('treats unreadable storage as an unknown browse identity instead of reading without one', async () => {
    const store = await openReadingStore({
      databasePath: databasePath(),
      createWorker() { throw new Error('worker startup failed') }
    })
    const service = createIdentityService({
      store, protector: new ControlledProtector(), storageState: () => store.status.state
    })
    await expect(service.browseUserhash()).rejects.toMatchObject({ error: { kind: 'identity', detail: 'identity-unknown' } })
    await expect(service.getOverview()).rejects.toThrow()
  })

  it('upgrades a schema-1 database with content and adds empty identity tables', () => {
    const path = databasePath()
    const v1 = new Database(path)
    for (const migration of MIGRATIONS.filter((migration) => migration.version === 1)) migration.up(v1)
    v1.pragma('user_version = 1')
    v1.prepare('INSERT INTO directory_snapshot VALUES (1, ?, ?)')
      .run(JSON.stringify({ groups: [], timelines: [], skippedItems: 0 }), '2026-10-23T08:00:00.000Z')
    v1.close()
    const { db } = setup(path)
    expect(db.loadDirectory()?.fetchedAt).toBe('2026-10-23T08:00:00.000Z')
    expect(db.listCredentials()).toEqual([])
    const raw = new Database(path, { readonly: true })
    expect(raw.pragma('user_version', { simple: true })).toBe(Math.max(...MIGRATIONS.map((migration) => migration.version)))
    raw.close()
  })
})

describe('饼干标色 for imported cookies', () => {
  const colors = (db: ReadingDatabase) => Object.fromEntries(db.listCookieColors().map(({ cookieId, color }) => [cookieId, color]))

  it('colors a cookie once on import, on filling in its 饼干 ID and on changing it, never over an existing color', async () => {
    const { db, service, path } = setup()
    db.setCookieColor('Mine2', 'violet', '2026-10-26T00:00:00.000Z')
    const a = await imported(service, SECRET_A, 'A', 'Mine1')
    expect(colors(db)).toEqual({ Mine1: 'blue', Mine2: 'violet' })
    // Changing the ID colors the new one (unless it has a color) and leaves the old one's color.
    expect(await service.setCookieId(a.id, 'Mine2')).toEqual({ ok: true })
    expect(await service.setCookieId(a.id, 'Mine3')).toEqual({ ok: true })
    expect(colors(db)).toEqual({ Mine1: 'blue', Mine2: 'violet', Mine3: 'blue' })

    // A cookie from before 饼干 IDs were kept gets its ID (and color) when re-imported as an export.
    const b = await imported(service, SECRET_B, 'B', 'Temp')
    const raw = new Database(path)
    try { raw.prepare('UPDATE credentials SET cookie_id = NULL WHERE id = ?').run(b.id) } finally { raw.close() }
    expect(await service.importExport(exportPayload(SECRET_B, 'Filled'), null)).toMatchObject({ ok: false, failure: { reason: 'duplicate', cookieId: 'filled' } })
    expect(colors(db)).toMatchObject({ Filled: 'blue' })
  })

  it('never gives back a cleared or changed automatic color, and keeps colors of removed cookies', async () => {
    const { db, service } = setup()
    const a = await imported(service, SECRET_A, 'A', 'Mine1')
    const b = await imported(service, SECRET_B, 'B', 'Mine2')
    db.setCookieColor('Mine1', null, '2026-10-26T00:00:00.000Z')
    db.setCookieColor('Mine2', 'amber', '2026-10-26T00:00:00.000Z')
    expect(await service.remove(a.id)).toEqual({ ok: true })
    await imported(service, SECRET_A, 'A again', 'Mine1')
    expect(await service.setCookieId(b.id, 'Mine2')).toEqual({ ok: true })
    expect(colors(db)).toEqual({ Mine2: 'amber' })
    expect(await service.remove(b.id)).toEqual({ ok: true })
    expect(colors(db)).toEqual({ Mine2: 'amber' })
  })
})

describe('credentialed forum requests', () => {
  async function serve(record: IncomingHttpHeaders[], respond: (url: string) => { status: number; location?: string }) {
    const server = createServer((request, response) => {
      record.push(request.headers)
      const { status, location } = respond(request.url ?? '')
      response.writeHead(status, { 'Content-Type': 'application/json', ...(location ? { Location: location } : {}) })
      response.end('[]')
    })
    servers.push(server)
    const { promise, resolve } = Promise.withResolvers<void>()
    server.listen(0, '127.0.0.1', () => resolve())
    await promise
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected a TCP listener')
    return `http://127.0.0.1:${address.port}`
  }

  it('sends the browse userhash only to the credential origin and never through a redirect', async () => {
    const forumHeaders: IncomingHttpHeaders[] = []
    const otherHeaders: IncomingHttpHeaders[] = []
    const other = await serve(otherHeaders, () => ({ status: 200 }))
    const forum = await serve(forumHeaders, (url) =>
      url.startsWith('/redirect') ? { status: 302, location: `${other}/steal` } : { status: 200 })
    const transport = createForumTransport({ allowedOrigins: [forum, other], credentialOrigins: [forum] })
    const signal = new AbortController().signal

    await transport.get(new URL('/api/showf', forum), signal, { userhash: SECRET_A })
    expect(forumHeaders.at(-1)?.cookie).toBe(`userhash=${SECRET_A}`)
    await expect(transport.get(new URL('/redirect', forum), signal, { userhash: SECRET_A }))
      .rejects.toMatchObject({ error: { detail: 'redirect' } })
    await expect(transport.get(new URL('/api/showf', other), signal, { userhash: SECRET_A }))
      .rejects.toThrow('not allowed')
    await transport.get(new URL('/api/showf', other), signal)
    expect(otherHeaders).toHaveLength(1)
    expect(otherHeaders[0]?.cookie).toBeUndefined()
  })

  it('does not send a read when the selected browse identity is unusable', async () => {
    let sent = 0
    const client = createForumClient({
      transport: { async get() { sent++; return { mediaType: 'application/json', text: '[]' } } },
      browseIdentity: async () => { throw new ForumReadError({ kind: 'identity', detail: 'identity-missing' }) }
    })
    await expect(client.getFeedPage({ kind: 'forum', id: '4' }, 1, new AbortController().signal))
      .rejects.toMatchObject({ error: { kind: 'identity', detail: 'identity-missing' } })
    expect(sent).toBe(0)
  })
})
