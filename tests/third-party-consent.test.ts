import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAnalyticsService, type AnalyticsService } from '../src/main/analytics/service'
import type { AnalyticsTransport } from '../src/main/analytics/transport'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { createThirdPartyService, type ThirdPartyService } from '../src/main/third-party/service'
import type { ThirdPartyChoices } from '../src/shared/third-party'
import { asStore } from './helpers/store'

const folders: string[] = []
const databases: ReadingDatabase[] = []
const paths = new WeakMap<ReadingDatabase, string>()
const services: AnalyticsService[] = []
const allOff: ThirdPartyChoices = { updates: false, search: false, analytics: false }
const allOn: ThirdPartyChoices = { updates: true, search: true, analytics: true }

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()))
  for (const db of databases.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function open(path?: string): ReadingDatabase {
  if (!path) {
    const folder = mkdtempSync(join(tmpdir(), 'xidao-consent-'))
    folders.push(folder)
    path = join(folder, 'reading.sqlite')
  }
  const db = openReadingDatabase(path)
  databases.push(db)
  paths.set(db, path)
  return db
}

function fixture(db = open(), config: { platform?: 'windows' | null; configured?: boolean } = {}) {
  const base = asStore(db)
  const control = {
    failAnalytics: false,
    failDisclosure: false,
    protected: true,
    analyticsSave: null as (() => Promise<void>) | null,
    disclosureSave: null as (() => Promise<void>) | null
  }
  const events: string[] = []
  const requests: string[] = []
  const signals: AbortSignal[] = []
  const store = {
    ...base,
    async saveAnalytics(record: Parameters<typeof base.saveAnalytics>[0]) {
      events.push(`analytics:${record.choice}`)
      await control.analyticsSave?.()
      if (control.failAnalytics) throw new Error('disk full')
      await base.saveAnalytics(record)
    },
    async saveThirdPartyConsent(record: Parameters<typeof base.saveThirdPartyConsent>[0]) {
      events.push('disclosure')
      await control.disclosureSave?.()
      if (control.failDisclosure) throw new Error('disk full')
      await base.saveThirdPartyConsent(record)
    }
  }
  const transport: AnalyticsTransport = {
    async post(path, _body, signal) {
      requests.push(path)
      signals.push(signal)
      return path === '/v1/instances'
        ? { status: 201, retryAfterSeconds: null, body: { instanceId: `instance${'1'.repeat(14)}`, token: `token${'1'.repeat(38)}` } }
        : { status: 200, retryAfterSeconds: null, body: { statDay: '2026-11-07', duplicate: false } }
    }
  }
  let consent: ThirdPartyService | null = null
  const analytics = createAnalyticsService({
    store,
    storageReady: () => true,
    protector: {
      async isAvailable() { return control.protected },
      async encrypt(value) { return new Uint8Array(Buffer.from(`sealed:${value}`)) },
      async decrypt(value) { return Buffer.from(value).toString().slice('sealed:'.length) }
    },
    transport: config.configured === false ? null : transport,
    platform: config.platform === undefined ? 'windows' : config.platform,
    version: '1.3.1',
    isForeground: () => true,
    isConsented: () => consent?.isAcknowledged() ?? false,
    now: () => Date.parse('2026-11-07T12:00:00+08:00'),
    monotonic: () => 1_000_000,
    schedule: () => () => undefined
  })
  services.push(analytics)
  const changed = vi.fn()
  consent = createThirdPartyService({ store, analytics, changed })
  return { db, store, control, events, requests, signals, analytics, consent, changed }
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const { promise, resolve } = Promise.withResolvers<void>()
    setImmediate(resolve)
    await promise
  }
}

describe('third-party disclosure persistence', () => {
  it.each([null, 'not json', '{}', '{"version":2,"updates":true,"search":true}', '{"version":1,"updates":true}'])(
    'fails closed for missing or unreadable record %s without changing the legacy preference', async (value) => {
      const db = open()
      db.saveAnalytics({ choice: 'on', identity: null, reportedDay: null })
      if (value !== null) {
        const raw = new Database(paths.get(db)!)
        raw.prepare("INSERT INTO settings (key, value_json) VALUES ('thirdPartyConsent', ?)").run(value)
        raw.close()
      }
      const { consent, analytics, requests } = fixture(db)
      expect(consent.isAcknowledged()).toBe(false)
      expect(consent.allows('updates')).toBe(false)
      expect(consent.allows('search')).toBe(false)
      await analytics.start()
      expect(await consent.getState()).toMatchObject({
        acknowledged: false, updates: false, search: false, analytics: { choice: 'unset', saved: 'unset' }
      })
      analytics.poke()
      await settle()
      expect(requests).toEqual([])
      expect(db.loadAnalytics().choice).toBe('on')
    }
  )

  it('starts a new installation fully unchecked and retains a mixed explicit answer after reopening', async () => {
    const first = fixture()
    expect(await first.consent.getState()).toMatchObject({ acknowledged: false, updates: false, search: false, analytics: { choice: 'unset' } })
    expect(await first.consent.complete({ updates: true, search: false, analytics: false })).toMatchObject({ result: 'saved', state: { acknowledged: true, updates: true, search: false, analytics: { choice: 'off', saved: 'off' } } })
    expect(first.db.loadThirdPartyConsent()).toEqual({ version: 1, updates: true, search: false })
    const raw = new Database(paths.get(first.db)!, { readonly: true })
    const row = raw.prepare<[], { value_json: string }>("SELECT value_json FROM settings WHERE key = 'thirdPartyConsent'").get()!
    expect(JSON.parse(row.value_json)).toEqual({ version: 1, updates: true, search: false })
    raw.close()
    await first.analytics.stop()
    const path = paths.get(first.db)!
    first.db.close()
    databases.splice(databases.indexOf(first.db), 1)
    const second = fixture(open(path))
    expect(second.consent.isAcknowledged()).toBe(false)
    expect(await second.consent.getState()).toMatchObject({ acknowledged: true, updates: true, search: false, analytics: { choice: 'off' } })
    expect(await second.consent.complete(allOn)).toMatchObject({ result: 'refused' })
    expect(second.db.loadThirdPartyConsent()).toEqual({ version: 1, updates: true, search: false })
    await settle()
    expect(second.requests).toEqual([])
  })

  it.each(['unset', 'off', 'on'] as const)('replaces legacy %s with explicit rejection before saving the disclosure', async (choice) => {
    const db = open()
    db.saveAnalytics({ choice, identity: null, reportedDay: null })
    const f = fixture(db)
    expect(await f.consent.complete(allOff)).toMatchObject({ result: 'saved', state: { acknowledged: true, analytics: { choice: 'off', saved: 'off' } } })
    expect(f.events).toEqual(['analytics:off', 'disclosure'])
    expect(f.requests).toEqual([])
    expect(db.loadAnalytics().choice).toBe('off')
  })

  it('keeps all gates closed until both first-choice writes finish, then starts permitted statistics', async () => {
    const f = fixture()
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    f.control.disclosureSave = () => { entered.resolve(); return held.promise }
    const completion = f.consent.complete(allOn)
    await entered.promise
    expect(f.events).toEqual(['analytics:on', 'disclosure'])
    expect(f.db.loadAnalytics().choice).toBe('on')
    expect(f.consent.isAcknowledged()).toBe(false)
    expect(f.consent.allows('updates')).toBe(false)
    expect(f.consent.allows('search')).toBe(false)
    expect(f.requests).toEqual([])
    held.resolve()
    expect(await completion).toMatchObject({ result: 'saved', state: { acknowledged: true, updates: true, search: true } })
    await settle()
    expect(f.requests).toEqual(['/v1/instances', '/v1/activity'])
  })

  it.each(['analytics', 'disclosure'] as const)('blocks every new grant when the first %s write fails, including on restart', async (failure) => {
    const f = fixture()
    f.control.failAnalytics = failure === 'analytics'
    f.control.failDisclosure = failure === 'disclosure'
    expect(await f.consent.complete(allOn)).toMatchObject({ result: 'not-saved', state: { acknowledged: false, updates: false, search: false, analytics: { choice: 'unset', saved: 'unset' } } })
    expect(f.db.loadThirdPartyConsent()).toBeNull()
    await settle()
    expect(f.requests).toEqual([])
    const restarted = fixture(f.db)
    expect(await restarted.consent.getState()).toMatchObject({ acknowledged: false, updates: false, search: false })
    await settle()
    expect(restarted.requests).toEqual([])
  })

  it.each(['analytics', 'disclosure'] as const)('allows session-only full rejection after failed %s persistence without storing an unsafe marker', async (failure) => {
    const db = open()
    db.saveAnalytics({ choice: 'on', identity: null, reportedDay: null })
    const f = fixture(db)
    f.control.failAnalytics = failure === 'analytics'
    f.control.failDisclosure = failure === 'disclosure'
    expect(await f.consent.complete(allOff)).toMatchObject({ result: 'not-saved', state: { acknowledged: true, updates: false, search: false, analytics: { choice: 'off' } } })
    expect(db.loadThirdPartyConsent()).toBeNull()
    await settle()
    expect(f.requests).toEqual([])
    const restarted = fixture(db)
    expect(await restarted.consent.getState()).toMatchObject({ acknowledged: false, analytics: { choice: 'unset' } })
  })

  it.each([{ platform: null }, { configured: false }])('persists an explicit off answer even when statistics are unavailable: %j', async (config) => {
    const db = open()
    db.saveAnalytics({ choice: 'on', identity: null, reportedDay: null })
    const f = fixture(db, config)
    expect(await f.consent.complete(allOff)).toMatchObject({ result: 'saved' })
    expect(db.loadAnalytics().choice).toBe('off')
    expect(f.requests).toEqual([])
  })

  it('refuses an analytics grant without protection and keeps other requested grants closed', async () => {
    const f = fixture()
    f.control.protected = false
    expect(await f.consent.complete(allOn)).toMatchObject({ result: 'refused', reason: 'protection-unavailable', state: { acknowledged: false, updates: false, search: false } })
    expect(f.db.loadThirdPartyConsent()).toBeNull()
    expect(f.requests).toEqual([])
  })
})

describe('individual third-party permissions', () => {
  it.each(['updates', 'search', 'analytics'] as const)('requires the first disclosure before changing %s', async (service) => {
    const f = fixture()
    expect(await f.consent.setChoice(service, true)).toMatchObject({ result: 'refused', reason: 'disclosure-required' })
    expect(f.events).toEqual([])
  })

  it.each(['updates', 'search', 'analytics'] as const)('grants and revokes only %s', async (service) => {
    const f = fixture()
    await f.consent.complete(allOff)
    expect(await f.consent.setChoice(service, true)).toMatchObject({ result: 'saved' })
    const state = await f.consent.getState()
    expect(state.updates).toBe(service === 'updates')
    expect(state.search).toBe(service === 'search')
    expect(state.analytics.choice).toBe(service === 'analytics' ? 'on' : 'off')
    await settle()
    expect(await f.consent.setChoice(service, false)).toMatchObject({ result: 'saved' })
    expect(await f.consent.getState()).toMatchObject({ updates: false, search: false, analytics: { choice: 'off' } })
  })

  it.each(['updates', 'search', 'analytics'] as const)('fails closed on an unsaved %s grant', async (service) => {
    const f = fixture()
    await f.consent.complete(allOff)
    f.control.failAnalytics = service === 'analytics'
    f.control.failDisclosure = service !== 'analytics'
    expect(await f.consent.setChoice(service, true)).toMatchObject({ result: 'not-saved', state: { updates: false, search: false, analytics: { choice: 'off' } } })
    expect(f.requests).toEqual([])
  })

  it.each(['updates', 'search', 'analytics'] as const)('revokes %s in memory before a failed save, while restart retains the old grant', async (service) => {
    const f = fixture()
    await f.consent.complete(allOn)
    await settle()
    f.control.failAnalytics = service === 'analytics'
    f.control.failDisclosure = service !== 'analytics'
    const pending = f.consent.setChoice(service, false)
    if (service !== 'analytics') expect(f.consent.allows(service)).toBe(false)
    const answer = await pending
    expect(answer.result).toBe('not-saved')
    expect(await f.consent.getState()).toMatchObject(service === 'analytics'
      ? { updates: true, search: true, analytics: { choice: 'off', saved: 'on' } }
      : { [service]: false, analytics: { choice: 'on' } })
    await f.analytics.stop()
    const restarted = fixture(f.db)
    expect(await restarted.consent.getState()).toMatchObject({ updates: true, search: true, analytics: { choice: 'on' } })
  })

  it.each(['updates', 'search', 'analytics'] as const)('does not let a slow %s grant overwrite a later revocation', async (service) => {
    const f = fixture()
    await f.consent.complete(allOff)
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const block = () => { entered.resolve(); return held.promise }
    if (service === 'analytics') f.control.analyticsSave = block
    else f.control.disclosureSave = block
    const grant = f.consent.setChoice(service, true)
    await entered.promise
    const revoke = f.consent.setChoice(service, false)
    if (service !== 'analytics') expect(f.consent.allows(service)).toBe(false)
    held.resolve()
    await Promise.all([grant, revoke])
    await settle()
    expect(await f.consent.getState()).toMatchObject({ updates: false, search: false, analytics: { choice: 'off', saved: 'off' } })
    expect(f.requests).toEqual([])
  })

  it.each(['updates', 'search', 'analytics'] as const)('honors a %s revocation arriving during the first disclosure save', async (service) => {
    const f = fixture()
    const held = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    f.control.disclosureSave = () => { entered.resolve(); return held.promise }
    const first = f.consent.complete({ ...allOff, [service]: true })
    await entered.promise
    const revoke = f.consent.setChoice(service, false)
    held.resolve()
    await Promise.all([first, revoke])
    await settle()
    expect(await f.consent.getState()).toMatchObject({ acknowledged: true, updates: false, search: false, analytics: { choice: 'off', saved: 'off' } })
    expect(f.requests).toEqual([])
    expect(f.db.loadThirdPartyConsent()).toEqual({ version: 1, updates: false, search: false })
  })

  it('preserves both independent choices when two grants are queued together', async () => {
    const f = fixture()
    await f.consent.complete(allOff)
    const answers = await Promise.all([f.consent.setChoice('updates', true), f.consent.setChoice('search', true)])
    expect(answers.map((answer) => answer.result)).toEqual(['saved', 'saved'])
    expect(f.db.loadThirdPartyConsent()).toEqual({ version: 1, updates: true, search: true })
    expect(await f.consent.getState()).toMatchObject({ updates: true, search: true, analytics: { choice: 'off' } })
    expect(f.requests).toEqual([])
  })

  it('does not briefly report a stored analytics grant when it is revoked before loading finishes', async () => {
    const db = open()
    db.saveThirdPartyConsent({ version: 1, updates: false, search: false })
    db.saveAnalytics({ choice: 'on', identity: null, reportedDay: null })
    const f = fixture(db)
    const revoked = f.consent.setChoice('analytics', false)
    expect(await revoked).toMatchObject({ result: 'saved', state: { acknowledged: true, analytics: { choice: 'off', saved: 'off' } } })
    await settle()
    expect(f.requests).toEqual([])
  })

  it('serializes competing first completions and refuses to overwrite the first explicit answer', async () => {
    const f = fixture()
    const [first, second] = await Promise.all([f.consent.complete(allOff), f.consent.complete(allOn)])
    expect(first.result).toBe('saved')
    expect(second.result).toBe('refused')
    expect(f.events).toEqual(['analytics:off', 'disclosure'])
    expect(f.requests).toEqual([])
  })

  it('does not revive legacy analytics when granting search after a session-only rejection', async () => {
    const db = open()
    db.saveAnalytics({ choice: 'on', identity: null, reportedDay: null })
    const f = fixture(db)
    f.control.failAnalytics = true
    await f.consent.complete(allOff)
    expect(await f.consent.setChoice('search', true)).toMatchObject({ result: 'not-saved', state: { search: false } })
    expect(db.loadThirdPartyConsent()).toBeNull()
    f.control.failAnalytics = false
    expect(await f.consent.setChoice('search', true)).toMatchObject({ result: 'saved', state: { search: true, analytics: { choice: 'off', saved: 'off' } } })
    expect(db.loadAnalytics().choice).toBe('off')
    expect(db.loadThirdPartyConsent()).toEqual({ version: 1, updates: false, search: true })
    expect(f.requests).toEqual([])
  })

  it('does not send an analytics grant if the session-only disclosure marker still cannot be saved', async () => {
    const f = fixture()
    f.control.failDisclosure = true
    await f.consent.complete(allOff)
    expect(await f.consent.setChoice('analytics', true)).toMatchObject({ result: 'not-saved', state: { analytics: { choice: 'off' } } })
    await settle()
    expect(f.requests).toEqual([])
    expect(f.db.loadThirdPartyConsent()).toBeNull()
  })
})
