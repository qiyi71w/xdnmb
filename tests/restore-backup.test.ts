import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { preUpgradeBackupDirectory } from '../src/main/storage/backup'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { MIGRATIONS, type Migration } from '../src/main/storage/migrations'
import { beforeRestoreDirectory, restoreStagingDirectory, settleRestore } from '../src/main/storage/restore-journal'
import { createSubscriptionService } from '../src/main/subscriptions/service'
import { createRequestScheduler } from '../src/main/reading/scheduler'
import type { SubscriptionOperation, SubscriptionPlan } from '../src/shared/subscriptions'
import { asStore } from './helpers/store'

// Synthetic releases over the real schema: the "old" app is this one, the "new" one adds a migration.
const SUPPORTED = Math.max(...MIGRATIONS.map((migration) => migration.version))
const OLD: readonly Migration[] = MIGRATIONS
const NEW: Migration[] = [...MIGRATIONS, { version: SUPPORTED + 1, up: (db) => db.exec('CREATE TABLE newer_feature (id INTEGER PRIMARY KEY)') }]
const LATER: Migration[] = [...NEW, { version: SUPPORTED + 2, up: (db) => db.exec('CREATE TABLE later_feature (id INTEGER PRIMARY KEY)') }]
/** A newer version that changed a secret table's key column, so this app cannot understand it. */
const NEW_KEYS: Migration[] = [...MIGRATIONS, { version: SUPPORTED + 1, up: (db) => db.exec('ALTER TABLE credentials RENAME COLUMN id TO local_id') }]

const UPGRADED_AT = new Date('2026-11-02T08:00:00.000Z')
const LATER_AT = new Date('2026-11-03T09:30:00.000Z')
const NEW_VERSION = '1.2.0-test'
const OLD_IMAGE = '0123456789abcdef0123456789abcdef.png'
const NEW_IMAGE = 'fedcba9876543210fedcba9876543210.png'
const OLD_PNG = Buffer.from('synthetic-png-before-upgrade')
const NEW_PNG = Buffer.from('synthetic-png-written-after-upgrade')
const BEFORE_UPGRADE = '1001'
const AFTER_UPGRADE = '2002'
const ONLY_IN_WAL = '2003'
const OLD_WRITE = '3003'
const AT = '2026-11-01T00:00:00.000Z'

const folders: string[] = []
const connections: ReadingDatabase[] = []

afterEach(() => {
  for (const db of connections.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function userData(): string {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-restore-'))
  folders.push(folder)
  return folder
}

const databaseOf = (folder: string) => join(folder, 'xidao.sqlite')

/** Opens as the app does: the app's own database, with a version and clock. */
function open(folder: string, migrations: readonly Migration[], appVersion = NEW_VERSION, now = UPGRADED_AT): ReadingDatabase {
  const db = openReadingDatabase(databaseOf(folder), migrations, { appVersion, now: () => now })
  connections.push(db)
  return db
}

function close(db: ReadingDatabase): void {
  connections.splice(connections.indexOf(db), 1)
  db.close()
}

function raw<T>(path: string, run: (db: Database.Database) => T): T {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    return run(db)
  } finally {
    db.close()
  }
}

function blocks(path: string): string[] {
  return raw(path, (db) => db.prepare('SELECT value FROM local_blocks ORDER BY value').pluck().all() as string[])
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function observation(id: string, context: { generation: number; appCredentialId: string | null; webCredentialId: string | null }) {
  return { id, source: 'app' as const, context, startedAt: AT, pages: [], ids: [], nextPage: 1, error: null, cancelled: false }
}

/**
 * This app's data before the upgrade: cookies 1 and 2 (2 is the draft's and the default 发言饼干),
 * an account session, App UUID `uuid-a` in use, a subscription observation, operation and plan
 * under that configuration, a draft with an attachment copy, and a marker.
 */
function oldInstall(): string {
  const folder = userData()
  const db = open(folder, OLD, '1.1.0-test')
  expect(db.status).toEqual({ state: 'ready', schemaVersion: SUPPORTED })
  db.insertCredential({ name: '甲', cookieId: 'AAAAAAA', source: 'raw', importedAt: AT, ciphertext: new Uint8Array([1, 1, 1]) })
  db.insertCredential({ name: '乙', cookieId: 'BBBBBBB', source: 'raw', importedAt: AT, ciphertext: new Uint8Array([2, 2, 2]) })
  db.setRoleSelection('default-post', '2')
  db.saveAccountSession({ ciphertext: new Uint8Array([9, 9]), expiresAt: '2027-01-01T00:00:00.000Z' })
  db.setSubscriptionAppCredential('uuid-a', new Uint8Array([7, 7, 7]))
  const { context } = db.loadSubscriptionConfiguration()
  db.saveSubscriptionObservation(observation('observation-a', context))
  const operation: SubscriptionOperation = {
    id: 'operation-a', source: 'app', threadId: '500', action: 'add', context, createdAt: AT, objectLabel: 'App 订阅',
    state: 'needs-reconciliation', report: 'unknown', reportError: null, before: null, after: null, verification: 'unknown'
  }
  db.saveSubscriptionOperation(operation)
  db.saveSubscriptionPlan({
    id: 'plan-a', createdAt: AT, finishedAt: AT, state: 'interrupted', stopReason: 'result-storage',
    preview: { id: 'preview-a', mode: 'sync', context, createdAt: AT, left: observation('l', context), right: observation('r', context),
      leftLabel: 'App 订阅', rightLabel: '网页订阅', firstSync: true, items: [] },
    items: [{ candidate: { id: 'c', threadId: '500', action: 'add', target: 'web' }, operationId: 'operation-a', state: 'unknown', failure: null }]
  } satisfies SubscriptionPlan)
  mkdirSync(join(folder, 'draft-images'))
  writeFileSync(join(folder, 'draft-images', OLD_IMAGE), OLD_PNG, { flag: 'wx' })
  const attachment = db.insertDraftAttachment({
    fileName: OLD_IMAGE, format: 'png', bytes: OLD_PNG.length, width: 1, height: 1, originalName: 'a.png', createdAt: AT
  })
  db.saveDraft({ draftId: null, target: { kind: 'reply', threadId: '600' }, credentialId: '2',
    fields: { content: '升级前的草稿', title: '', name: '', watermark: false }, attachmentId: attachment.id }, AT)
  db.setBlock('post', BEFORE_UPGRADE, true, AT)
  close(db)
  return folder
}

/**
 * The new version upgrades (taking the pre-upgrade backup), then: removes cookie 2, imports cookie 3
 * and App UUID `uuid-b`, writes a draft with a new attachment and a marker, optionally signs out.
 */
function upgrade(folder: string, options: { signOut?: boolean } = {}): void {
  const db = open(folder, NEW)
  expect(db.status).toEqual({ state: 'ready', schemaVersion: SUPPORTED + 1 })
  expect(db.deleteCredential('2')).toBe(true)
  db.insertCredential({ name: '丙', cookieId: 'CCCCCCC', source: 'raw', importedAt: AT, ciphertext: new Uint8Array([3, 3, 3]) })
  db.setSubscriptionAppCredential('uuid-b', new Uint8Array([8, 8, 8]))
  if (options.signOut === true) db.clearAccountSession()
  writeFileSync(join(folder, 'draft-images', NEW_IMAGE), NEW_PNG, { flag: 'wx' })
  const attachment = db.insertDraftAttachment({
    fileName: NEW_IMAGE, format: 'png', bytes: NEW_PNG.length, width: 1, height: 1, originalName: 'b.png', createdAt: AT
  })
  db.saveDraft({ draftId: null, target: { kind: 'reply', threadId: '700' }, credentialId: '3',
    fields: { content: '升级后的草稿', title: '', name: '', watermark: false }, attachmentId: attachment.id }, AT)
  db.setBlock('post', AFTER_UPGRADE, true, AT)
  close(db)
}

/**
 * The same folder as a crash of the new version left it: one more committed write is only in the
 * WAL (copied while its writer is open).
 */
function crashedNewer(source: string): string {
  const writer = new Database(databaseOf(source))
  writer.pragma('wal_autocheckpoint = 0')
  writer.prepare("INSERT INTO local_blocks (kind, value, created_at) VALUES ('post', ?, ?)").run(ONLY_IN_WAL, AT)
  const folder = userData()
  cpSync(source, folder, { recursive: true })
  writer.close()
  expect(statSync(`${databaseOf(folder)}-wal`).size).toBeGreaterThan(0)
  return folder
}

/** The old version opens the newer data read-only and prepares the restore. */
function prepare(folder: string): void {
  const db = open(folder, OLD)
  expect(db.status).toEqual({ state: 'read-only', reason: 'newer-schema', schemaVersion: SUPPORTED + 1, supportedVersion: SUPPORTED })
  expect(db.prepareRestore()).toBe('prepared')
  close(db)
}

/**
 * Every file of the newer data, by path relative to its folder, with its digest. Not `-shm`: SQLite
 * rebuilds that shared-memory index for any reader, and it holds no data.
 */
function newerFiles(folder: string): Map<string, string> {
  const files = new Map<string, string>()
  for (const suffix of ['', '-wal']) {
    const path = `${databaseOf(folder)}${suffix}`
    if (existsSync(path)) files.set(`xidao.sqlite${suffix}`, sha(path))
  }
  for (const name of readdirSync(join(folder, 'draft-images'))) files.set(`draft-images/${name}`, sha(join(folder, 'draft-images', name)))
  return files
}

function stagedFiles(folder: string): Map<string, string> {
  const staging = restoreStagingDirectory(folder)
  const files = new Map<string, string>([['xidao.sqlite', sha(join(staging, 'xidao.sqlite'))]])
  for (const name of readdirSync(join(staging, 'draft-images'))) files.set(`draft-images/${name}`, sha(join(staging, 'draft-images', name)))
  return files
}

/** Whether every file is present, unchanged, in one of `places`. */
function completeIn(files: Map<string, string>, places: string[]): boolean {
  return [...files].every(([name, digest]) => places.some((place) => existsSync(join(place, name)) && sha(join(place, name)) === digest))
}

function expectRestored(folder: string, newer: Map<string, string>): void {
  const before = beforeRestoreDirectory(folder)
  expect(completeIn(newer, [before])).toBe(true)
  expect(readdirSync(before).sort()).toEqual(['draft-images', 'xidao.sqlite', 'xidao.sqlite-shm', 'xidao.sqlite-wal'])
  expect(blocks(join(before, 'xidao.sqlite'))).toEqual([BEFORE_UPGRADE, AFTER_UPGRADE, ONLY_IN_WAL])
  expect(readdirSync(join(folder, 'backups')).sort()).toEqual(['before-restore', 'pre-upgrade'])
  expect(readdirSync(join(folder, 'draft-images'))).toEqual([OLD_IMAGE])
  const db = open(folder, OLD)
  expect(db.status).toEqual({ state: 'ready', schemaVersion: SUPPORTED })
  close(db)
  expect(blocks(databaseOf(folder))).toEqual([BEFORE_UPGRADE])
}

function expectAbandoned(folder: string, newer: Map<string, string>): void {
  expect(completeIn(newer, [folder])).toBe(true)
  expect(existsSync(restoreStagingDirectory(folder))).toBe(false)
  expect(existsSync(join(folder, 'backups', 'restore-journal.json'))).toBe(false)
  expect(existsSync(join(folder, 'backups', 'before-restore.partial'))).toBe(false)
  const db = open(folder, OLD)
  expect(db.status).toMatchObject({ state: 'read-only', schemaVersion: SUPPORTED + 1 })
  close(db)
  expect(blocks(databaseOf(folder))).toEqual([BEFORE_UPGRADE, AFTER_UPGRADE, ONLY_IN_WAL])
}

describe('restore entry', () => {
  it('offers a valid backup this version can open, with its time and source version', () => {
    const folder = oldInstall()
    upgrade(folder)
    const db = open(folder, OLD)
    const info = db.restoreInfo()
    expect(info).toEqual({ restorable: true, backupCompletedAt: UPGRADED_AT.toISOString(), sourceVersion: NEW_VERSION, secretsReadable: true })
    expect(JSON.stringify(info)).not.toContain(folder)
  })

  it('offers nothing for a backup newer than this version, a corrupt manifest, a failed integrity check or a missing attachment', () => {
    const newer = oldInstall()
    upgrade(newer)
    close(open(newer, LATER, '1.3.0-test', LATER_AT))
    expect(open(newer, OLD).restoreInfo()).toEqual({ restorable: false })

    const broken = (damage: (backup: string) => void) => {
      const folder = oldInstall()
      upgrade(folder)
      damage(preUpgradeBackupDirectory(folder))
      expect(open(folder, OLD).restoreInfo()).toEqual({ restorable: false })
    }
    broken((backup) => writeFileSync(join(backup, 'manifest.json'), '{"format":1,'))
    broken((backup) => {
      const path = join(backup, 'xidao.sqlite')
      const bytes = readFileSync(path)
      const pageSize = bytes.readUInt16BE(16)
      bytes.fill(0xa5, pageSize * 2, pageSize * 6)
      writeFileSync(path, bytes)
    })
    broken((backup) => rmSync(join(backup, 'draft-images', OLD_IMAGE)))
  })

  it('offers nothing while the data is this version’s own', () => {
    const folder = oldInstall()
    upgrade(folder)
    const restored = userData()
    cpSync(folder, restored, { recursive: true })
    prepare(restored)
    expect(settleRestore(databaseOf(restored))).toBe('restored')
    const db = open(restored, OLD)
    expect(db.status.state).toBe('ready')
    expect(db.restoreInfo()).toEqual({ restorable: false })
    expect(db.prepareRestore()).toBe('not-applicable')
    expect(existsSync(join(restored, 'backups', 'restore-journal.json'))).toBe(false)
  })
})

describe('secrets in the restored data', () => {
  it('keeps only the secrets the newer data still has; references to removed cookies stay', () => {
    const folder = oldInstall()
    upgrade(folder)
    prepare(folder)
    expect(settleRestore(databaseOf(folder))).toBe('restored')
    const db = open(folder, OLD)
    expect(db.listCredentials().map((credential) => credential.id)).toEqual(['1'])
    expect(db.loadRoleSelections()['default-post']).toEqual({ state: 'missing', credentialId: '2' })
    expect(db.listDrafts().map((draft) => [draft.fields.content, draft.credentialId])).toEqual([['升级前的草稿', '2']])
    expect(db.listSubscriptionAppCredentials()).toEqual(['uuid-a'])
    expect(db.loadSubscriptionConfiguration().context.appCredentialId).toBe('uuid-a')
    expect(db.loadAccountSession()).not.toBeNull()
  })

  it('does not bring back an account session signed out after the upgrade', () => {
    const folder = oldInstall()
    upgrade(folder, { signOut: true })
    prepare(folder)
    expect(settleRestore(databaseOf(folder))).toBe('restored')
    expect(open(folder, OLD).loadAccountSession()).toBeNull()
  })

  it('removes every secret when the newer secret tables are not understood, leaving nothing configured without its secret', async () => {
    const folder = oldInstall()
    const current = open(folder, OLD)
    const before = current.loadSubscriptionConfiguration().context
    close(current)
    const db = open(folder, NEW_KEYS)
    expect(db.status.state).toBe('ready')
    close(db)

    const readOnly = open(folder, OLD)
    expect(readOnly.restoreInfo()).toMatchObject({ restorable: true, secretsReadable: false })
    expect(readOnly.prepareRestore()).toBe('prepared')
    close(readOnly)
    expect(settleRestore(databaseOf(folder))).toBe('restored')

    const restored = open(folder, OLD)
    expect(restored.listCredentials()).toEqual([])
    expect(restored.listSubscriptionAppCredentials()).toEqual([])
    expect(restored.loadAccountSession()).toBeNull()
    expect(restored.loadRoleSelections()['default-post']).toEqual({ state: 'missing', credentialId: '2' })
    expect(restored.listDrafts()[0]?.credentialId).toBe('2')
    const { context } = restored.loadSubscriptionConfiguration()
    expect(context).toEqual({ ...before, generation: before.generation + 1, appCredentialId: null })
    // History stays, under the old generation, and nothing of it applies to the new one.
    expect(restored.loadSubscriptionOperations().map((operation) => [operation.id, operation.state])).toEqual([['operation-a', 'needs-reconciliation']])
    expect(restored.loadSubscriptionPlans().map((plan) => [plan.id, plan.state])).toEqual([['plan-a', 'interrupted']])
    expect(restored.loadSubscriptionObservationById('observation-a')).not.toBeNull()
    expect(restored.loadSubscriptionObservation('app', context)).toBeNull()

    let requests = 0
    const service = createSubscriptionService({
      store: asStore(restored),
      protector: {
        isAvailable: async () => true,
        encrypt: async () => new Uint8Array([1]),
        decrypt: async () => { throw new Error('nothing is decrypted') }
      },
      scheduler: createRequestScheduler(),
      transport: { async get() { requests++; throw new Error('no request') } } as never,
      appOrigin: 'https://app.invalid', webOrigin: 'https://web.invalid'
    })
    await service.recover()
    const overview = await service.getOverview()
    expect(overview.appConfigured).toBe(false)
    expect(overview.context.generation).toBe(before.generation + 1)
    expect(await service.read({ source: 'app', observationId: null, operationId: 'read' }, new AbortController().signal))
      .toEqual({ ok: false, reason: 'unconfigured' })
    expect((await service.getOperations()).map((operation) => operation.state)).toEqual(['needs-reconciliation'])
    expect((await service.getPlans()).map((plan) => plan.state)).toEqual(['interrupted'])
    expect(requests).toBe(0)
  })
})

describe('restore journal', () => {
  /** The newer data read-only in the old version, a restore prepared, and what each copy holds. */
  function prepared(): { folder: string; newer: Map<string, string>; staged: Map<string, string> } {
    const source = oldInstall()
    upgrade(source)
    const folder = crashedNewer(source)
    const newer = newerFiles(folder)
    prepare(folder)
    expect(newerFiles(folder)).toEqual(newer)
    return { folder, newer, staged: stagedFiles(folder) }
  }

  /** Settles the journal, ending the process after the `stop`th durable change. */
  function interrupted(folder: string, stop: number): boolean {
    let steps = 0
    try {
      settleRestore(databaseOf(folder), { step: () => { if (++steps === stop) throw new Error('terminated') } })
      return false
    } catch (error) {
      if ((error as Error).message !== 'terminated') throw error
      return true
    }
  }

  const places = (folder: string) => {
    const backups = join(folder, 'backups')
    return {
      newer: [folder, join(backups, 'before-restore.partial'), join(backups, 'before-restore')],
      restore: [restoreStagingDirectory(folder), folder]
    }
  }

  it('completes the restore, keeping the replaced data as 降级前数据 in place of the previous one', () => {
    const { folder, newer } = prepared()
    const previous = beforeRestoreDirectory(folder)
    cpSync(join(folder, 'draft-images'), join(previous, 'draft-images'), { recursive: true })
    writeFileSync(join(previous, 'previous'), 'an earlier restore')
    expect(settleRestore(databaseOf(folder))).toBe('restored')
    expect(existsSync(join(beforeRestoreDirectory(folder), 'previous'))).toBe(false)
    expectRestored(folder, newer)
    expect(settleRestore(databaseOf(folder))).toBe('none')
  })

  it('restores from a backup whose draft attachment copy is read-only', () => {
    const folder = oldInstall()
    upgrade(folder)
    const backupImage = join(preUpgradeBackupDirectory(folder), 'draft-images', OLD_IMAGE)
    chmodSync(backupImage, 0o444)
    try {
      prepare(folder)
      expect(settleRestore(databaseOf(folder))).toBe('restored')
      expect(readFileSync(join(folder, 'draft-images', OLD_IMAGE))).toEqual(OLD_PNG)
      expect(readFileSync(backupImage)).toEqual(OLD_PNG)
      const db = open(folder, OLD)
      expect(db.listDrafts().map((draft) => draft.attachment?.fileName)).toEqual([OLD_IMAGE])
    } finally {
      // Windows does not delete a read-only file.
      chmodSync(backupImage, 0o644)
    }
  })

  it('after an interruption at any step, the next start completes it; both copies stay whole meanwhile', () => {
    let stop = 1
    for (;;) {
      const { folder, newer, staged } = prepared()
      if (!interrupted(folder, stop)) {
        expectRestored(folder, newer)
        break
      }
      const { newer: newerPlaces, restore: restorePlaces } = places(folder)
      expect(completeIn(newer, newerPlaces), `newer data after step ${stop}`).toBe(true)
      expect(completeIn(staged, restorePlaces), `restore data after step ${stop}`).toBe(true)
      // Interrupted after the journal was cleared, the restore was already done.
      const pending = existsSync(join(folder, 'backups', 'restore-journal.json'))
      expect(settleRestore(databaseOf(folder))).toBe(pending ? 'restored' : 'none')
      expectRestored(folder, newer)
      stop++
    }
    expect(stop).toBeGreaterThan(8)
  })

  it('after an interruption, abandons a restore whose staged data went missing and opens the newer data as it was', () => {
    let abandoned = 0
    for (let stop = 0; ; stop++) {
      const { folder, newer } = prepared()
      if (stop > 0 && !interrupted(folder, stop)) break
      const stagedDatabase = join(restoreStagingDirectory(folder), 'xidao.sqlite')
      // Once placed, the restore data is no longer staging's to lose.
      if (!existsSync(stagedDatabase)) continue
      writeFileSync(stagedDatabase, readFileSync(stagedDatabase).subarray(0, 1024))
      expect(settleRestore(databaseOf(folder))).toBe('abandoned')
      expectAbandoned(folder, newer)
      abandoned++
    }
    expect(abandoned).toBeGreaterThan(3)
  })

  it('abandons when the staged attachment copies are incomplete after the database was placed', () => {
    // The interruption that leaves the database placed and the attachment copies still staged.
    let state: { folder: string; newer: Map<string, string> } | null = null
    for (let stop = 1; state === null; stop++) {
      const { folder, newer } = prepared()
      if (!interrupted(folder, stop)) throw new Error('no step between placing the database and the attachments')
      const staging = restoreStagingDirectory(folder)
      if (!existsSync(join(staging, 'xidao.sqlite')) && existsSync(join(staging, 'draft-images'))) state = { folder, newer }
    }
    const { folder, newer } = state
    rmSync(join(restoreStagingDirectory(folder), 'draft-images', OLD_IMAGE))
    expect(settleRestore(databaseOf(folder))).toBe('abandoned')
    expectAbandoned(folder, newer)
  })

  it('removes a staged copy no journal names, and never opens data an unreadable journal may have moved', () => {
    const { folder, newer } = prepared()
    rmSync(join(folder, 'backups', 'restore-journal.json'))
    expect(settleRestore(databaseOf(folder))).toBe('none')
    expect(existsSync(restoreStagingDirectory(folder))).toBe(false)
    expect(completeIn(newer, [folder])).toBe(true)

    writeFileSync(join(folder, 'backups', 'restore-journal.json'), '{"format":1,"phase":')
    expect(() => settleRestore(databaseOf(folder))).toThrow()
    expect(completeIn(newer, [folder])).toBe(true)
  })

  // Every interruption point runs a full restore with durable writes; fsync makes this slow on macOS.
  it('abandons from any interrupted step of carrying out or abandoning, never taking an earlier 降级前数据 for the current data', () => {
    const PREVIOUS_DATABASE = Buffer.from('an earlier restore’s 降级前数据')
    const PREVIOUS_IMAGE = Buffer.from('an earlier restore’s draft image')
    let chains = 0
    for (let restoreStop = 0; ; restoreStop++) {
      const { folder, newer } = prepared()
      const previous = beforeRestoreDirectory(folder)
      mkdirSync(join(previous, 'draft-images'), { recursive: true })
      writeFileSync(join(previous, 'xidao.sqlite'), PREVIOUS_DATABASE)
      writeFileSync(join(previous, 'draft-images', OLD_IMAGE), PREVIOUS_IMAGE)
      if (restoreStop > 0 && !interrupted(folder, restoreStop)) break
      // Make the restore data incomplete wherever it still is in staging, so the next start abandons.
      const staging = restoreStagingDirectory(folder)
      if (existsSync(join(staging, 'xidao.sqlite'))) {
        writeFileSync(join(staging, 'xidao.sqlite'), readFileSync(join(staging, 'xidao.sqlite')).subarray(0, 1024))
      } else if (existsSync(join(staging, 'draft-images', OLD_IMAGE))) {
        rmSync(join(staging, 'draft-images', OLD_IMAGE))
      } else continue
      for (let abandonStop = 1; ; abandonStop++) {
        const copy = userData()
        cpSync(folder, copy, { recursive: true })
        const stopped = interrupted(copy, abandonStop)
        if (stopped) {
          const pending = existsSync(join(copy, 'backups', 'restore-journal.json'))
          expect(settleRestore(databaseOf(copy)), `restore step ${restoreStop}, abandon step ${abandonStop}`).toBe(pending ? 'abandoned' : 'none')
        }
        expect(completeIn(newer, [copy]), `restore step ${restoreStop}, abandon step ${abandonStop}`).toBe(true)
        expect(readdirSync(join(copy, 'draft-images')).sort()).toEqual([NEW_IMAGE, OLD_IMAGE].sort())
        expect(readFileSync(join(copy, 'draft-images', OLD_IMAGE))).not.toEqual(PREVIOUS_IMAGE)
        expect(readFileSync(databaseOf(copy))).not.toEqual(PREVIOUS_DATABASE)
        for (const leftover of ['restore-journal.json', 'restore-staging', 'before-restore.partial']) {
          expect(existsSync(join(copy, 'backups', leftover))).toBe(false)
        }
        chains++
        if (!stopped) break
      }
    }
    expect(chains).toBeGreaterThan(20)
  }, 30_000)

  it('finds no restore when backups is not a directory, so the pre-upgrade backup failure shows', () => {
    const folder = crashedNewer(oldInstall())
    writeFileSync(join(folder, 'backups'), 'not a directory')
    const database = sha(databaseOf(folder))
    const wal = sha(`${databaseOf(folder)}-wal`)
    expect(settleRestore(databaseOf(folder))).toBe('none')
    // What the worker then opens: the upgrade needs a backup, which cannot be written.
    const db = open(folder, NEW)
    expect(db.status).toEqual({ state: 'unavailable', reason: 'backup-failed', schemaVersion: SUPPORTED, supportedVersion: SUPPORTED + 1 })
    close(db)
    expect(sha(databaseOf(folder))).toBe(database)
    expect(sha(`${databaseOf(folder)}-wal`)).toBe(wal)
  })

  // Windows: chmod cannot take away a directory's read access, so this input cannot be made there.
  it.skipIf(process.platform === 'win32')('does not open when it cannot tell whether a journal exists', () => {
    const { folder, newer } = prepared()
    chmodSync(join(folder, 'backups'), 0o000)
    try {
      expect(() => settleRestore(databaseOf(folder))).toThrow()
    } finally {
      chmodSync(join(folder, 'backups'), 0o755)
    }
    expect(completeIn(newer, [folder])).toBe(true)
  })
})

describe('switching versions', () => {
  it('leaves the newer data byte for byte while read-only, and the newer version opens it directly', () => {
    const source = oldInstall()
    upgrade(source)
    const folder = crashedNewer(source)
    const files = newerFiles(folder)
    const manifest = readFileSync(join(preUpgradeBackupDirectory(folder), 'manifest.json'), 'utf8')
    const readOnly = open(folder, OLD)
    expect(readOnly.restoreInfo()).toMatchObject({ restorable: true })
    close(readOnly)
    expect(newerFiles(folder)).toEqual(files)

    const db = open(folder, NEW, NEW_VERSION, LATER_AT)
    expect(db.status).toEqual({ state: 'ready', schemaVersion: SUPPORTED + 1 })
    close(db)
    expect(readFileSync(join(preUpgradeBackupDirectory(folder), 'manifest.json'), 'utf8')).toBe(manifest)
    expect(blocks(databaseOf(folder))).toEqual([BEFORE_UPGRADE, AFTER_UPGRADE, ONLY_IN_WAL])
  })

  it('after a restore the old version writes, and the newer version backs that up before migrating again', () => {
    const folder = oldInstall()
    upgrade(folder)
    prepare(folder)
    expect(settleRestore(databaseOf(folder))).toBe('restored')
    const old = open(folder, OLD)
    old.setBlock('post', OLD_WRITE, true, AT)
    close(old)

    const db = open(folder, NEW, NEW_VERSION, LATER_AT)
    expect(db.status).toEqual({ state: 'ready', schemaVersion: SUPPORTED + 1 })
    close(db)
    const backup = preUpgradeBackupDirectory(folder)
    expect(JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8'))).toMatchObject({
      schemaVersion: SUPPORTED, appVersion: NEW_VERSION, completedAt: LATER_AT.toISOString()
    })
    expect(blocks(join(backup, 'xidao.sqlite'))).toEqual([BEFORE_UPGRADE, OLD_WRITE])
    expect(blocks(databaseOf(folder))).toEqual([BEFORE_UPGRADE, OLD_WRITE])
  })
})
