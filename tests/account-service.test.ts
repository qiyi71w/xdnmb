import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { MIGRATIONS } from '../src/main/storage/migrations'
import { createAccountService } from '../src/main/account/service'
import { createIdentityService } from '../src/main/identity/service'
import { AccountError } from '../src/main/account/protocol'
import type { SecretProtector } from '../src/main/identity/protection'
import { asStore } from './helpers/store'

const folders: string[] = []
const databases: ReadingDatabase[] = []
afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
function setup() {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-account-'))
  folders.push(folder)
  const path = join(folder, 'app.sqlite')
  const db = openReadingDatabase(path)
  databases.push(db)
  const store = asStore(db)
  const secrets = new Map<number, string>()
  let counter = 0
  let available = true
  let time = Date.parse('2026-10-25T00:00:00.000Z')
  const protector: SecretProtector = {
    async isAvailable() { return available },
    async encrypt(secret) { const id = ++counter; secrets.set(id, secret); return Uint8Array.of(0x81, id, 0xfe) },
    async decrypt(bytes) { const secret = secrets.get(bytes[1]!); if (!secret) throw new Error('synthetic locked'); return secret }
  }
  const identities = createIdentityService({ store, protector, storageState: () => db.status.state })
  const cookie = { id: '101', publicId: 'synthetic-public', validUntil: '2099-01-01', claimedAt: '2026-01-01' }
  const client = {
    list: vi.fn(async () => [cookie]),
    exportCookie: vi.fn(async () => Buffer.from(JSON.stringify({ cookie: 'synthetic-userhash', name: '合成饼干' })).toString('base64'))
  }
  const openLogin = vi.fn(async () => ({ secret: 'synthetic-account-session', expiresAt: '2026-11-24T00:00:00.000Z' }))
  const deps = { store, protector, identities, client, openLogin, storageState: () => db.status.state, now: () => time }
  return { service: createAccountService(deps), recreate: () => createAccountService(deps), db, path, client, openLogin, identities,
    unavailable() { available = false }, expire() { time = Date.parse('2026-12-01T00:00:00.000Z') } }
}
describe('encrypted local account lifecycle', () => {
  it('upgrades a v11 database and preserves existing credentials', () => {
    const folder = mkdtempSync(join(tmpdir(), 'xidao-account-v11-'))
    folders.push(folder)
    const path = join(folder, 'app.sqlite')
    const previous = new Database(path)
    try {
      previous.pragma('foreign_keys = ON')
      for (const migration of MIGRATIONS.filter((item) => item.version <= 11)) migration.up(previous)
      previous.pragma('user_version = 11')
      previous.prepare("INSERT INTO credentials(name,source,imported_at,ciphertext,position) VALUES ('合成旧饼干','raw','2026-01-01',?,1)").run(Buffer.from([0x91, 0x82]))
    } finally { previous.close() }
    const db = openReadingDatabase(path)
    databases.push(db)
    expect(db.status).toMatchObject({ state: 'ready', schemaVersion: 13 })
    expect(db.listCredentials().map((item) => item.name)).toEqual(['合成旧饼干'])
    expect(db.loadAccountSession()).toBeNull()
    db.saveAccountSession({ ciphertext: Uint8Array.of(0x81, 0x92), expiresAt: '2099-01-01T00:00:00Z' })
    expect(db.loadAccountSession()).toEqual({ ciphertext: Uint8Array.of(0x81, 0x92), expiresAt: '2099-01-01T00:00:00Z' })
    db.clearAccountSession()
    expect(db.loadAccountSession()).toBeNull()
  })
  it('stores ciphertext only, reopens without login, and forgets locally', async () => {
    const env = setup()
    expect(await env.service.login()).toMatchObject({ ok: true, value: [{ id: '101' }] })
    const raw = new Database(env.path, { readonly: true })
    try {
      const row = raw.prepare('SELECT ciphertext, expires_at, typeof(ciphertext) AS kind FROM account_session').get() as { ciphertext: Buffer; expires_at: string; kind: string }
      expect(row.kind).toBe('blob')
      expect(row.ciphertext.toString()).not.toContain('synthetic-account-session')
      expect(row.expires_at).toBe('2026-11-24T00:00:00.000Z')
    } finally { raw.close() }
    const reopened = env.recreate()
    expect(await reopened.getOverview()).toMatchObject({ available: true, loggedIn: true })
    expect(await reopened.list()).toMatchObject({ ok: true })
    expect(env.openLogin).toHaveBeenCalledTimes(1)
    const calls = env.client.list.mock.calls.length
    expect(await reopened.forget()).toEqual({ ok: true, value: null })
    expect(env.db.loadAccountSession()).toBeNull()
    expect(env.client.list).toHaveBeenCalledTimes(calls)
  })
  it('blocks login when system protection is unavailable', async () => {
    const env = setup(); env.unavailable()
    expect(await env.service.getOverview()).toMatchObject({ available: false, blocker: 'protection-unavailable' })
    expect(await env.service.login()).toEqual({ ok: false, reason: 'protection-unavailable' })
    expect(env.openLogin).not.toHaveBeenCalled()
    expect(env.db.loadAccountSession()).toBeNull()
  })
  it('drops locally expired and server-rejected sessions', async () => {
    const env = setup()
    await env.service.login()
    env.client.list.mockRejectedValueOnce(new AccountError('expired'))
    expect(await env.service.list()).toEqual({ ok: false, reason: 'expired' })
    expect(env.db.loadAccountSession()).toBeNull()
    await env.service.login()
    env.expire()
    expect(await env.service.getOverview()).toMatchObject({ loggedIn: false })
    expect(env.db.loadAccountSession()).toBeNull()
  })
  it('reuses export import, appends, and reports duplicates without replacing', async () => {
    const env = setup()
    await env.identities.importRaw('synthetic-original', '原有饼干')
    await env.service.login()
    expect(await env.service.importSelected({ ids: ['101'] })).toMatchObject({ ok: true, value: [{ result: { ok: true, credential: { name: '合成饼干', source: 'export' } } }] })
    expect(env.db.listCredentials().map((row) => row.name)).toEqual(['原有饼干', '合成饼干'])
    expect(await env.service.importSelected({ ids: ['101'] })).toMatchObject({ ok: true, value: [{ result: { ok: false, failure: { reason: 'duplicate' } } }] })
    expect(env.db.listCredentials()).toHaveLength(2)
    expect(await env.service.importSelected({ ids: ['999'] })).toEqual({ ok: false, reason: 'blocked' })
  })
})
