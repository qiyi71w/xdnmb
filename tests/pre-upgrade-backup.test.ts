import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { markUpgradeWithoutBackup, preUpgradeBackupDirectory, readPreUpgradeBackup, verifyPreUpgradeBackup } from '../src/main/storage/backup'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import type { Migration } from '../src/main/storage/migrations'

// Synthetic releases: the "old" app knows migrations 1..1, the "new" one 1..2, a later one 1..3.
const OLD: Migration[] = [{ version: 1, up: (db) => db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)') }]
const NEW: Migration[] = [...OLD, { version: 2, up: (db) => db.exec('ALTER TABLE notes ADD COLUMN extra TEXT') }]
const LATER: Migration[] = [...NEW, { version: 3, up: (db) => db.exec('CREATE TABLE later (id INTEGER PRIMARY KEY)') }]
const FAILING: Migration[] = [...OLD, { version: 2, up: (db) => {
  db.exec('ALTER TABLE notes ADD COLUMN extra TEXT')
  throw new Error('injected migration failure')
} }]

const NOW = new Date('2026-11-02T08:00:00.000Z')
const PNG = Buffer.from('89504e470d0a1a0a-synthetic-png', 'utf8')
const GIF = Buffer.from('GIF89a-synthetic-gif-longer', 'utf8')
const IMAGE_A = '0123456789abcdef0123456789abcdef.png'
const IMAGE_B = 'fedcba9876543210fedcba9876543210.gif'

const folders: string[] = []
const connections: ReadingDatabase[] = []

afterEach(() => {
  for (const db of connections.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function userData(): string {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-pre-upgrade-'))
  folders.push(folder)
  return folder
}

/** Opens as the app does, with a fixed app version and clock. */
function open(folder: string, migrations: readonly Migration[], appVersion = '2.0.0-test'): ReadingDatabase {
  const db = openReadingDatabase(join(folder, 'xidao.sqlite'), migrations, { appVersion, now: () => NOW })
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

function notes(path: string): string[] {
  return raw(path, (db) => db.prepare<[], { body: string }>('SELECT body FROM notes ORDER BY id').all().map((row) => row.body))
}

function columns(path: string): string[] {
  return raw(path, (db) => db.prepare<[], { name: string }>('PRAGMA table_info(notes)').all().map((row) => row.name))
}

function userVersion(path: string): number {
  return raw(path, (db) => Number(db.pragma('user_version', { simple: true })))
}

/** An old-version database with draft attachment copies, closed cleanly. */
function oldInstall(rows: string[] = ['first']): string {
  const folder = userData()
  close(open(folder, OLD, '1.0.0-test'))
  const db = new Database(join(folder, 'xidao.sqlite'))
  for (const body of rows) db.prepare('INSERT INTO notes (body) VALUES (?)').run(body)
  db.close()
  const images = join(folder, 'draft-images')
  mkdirSync(images)
  writeFileSync(join(images, IMAGE_A), PNG)
  writeFileSync(join(images, IMAGE_B), GIF)
  // Not managed copies: an interrupted write, a foreign name and a link are never backed up.
  writeFileSync(join(images, '0123456789abcdef0123456789abcdef.part'), 'partial')
  writeFileSync(join(images, 'notes.txt'), 'foreign')
  symlinkSync(join(images, IMAGE_A), join(images, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png'))
  return folder
}

/**
 * The same old install as a crash left it: a committed write is still only in the WAL (the copy is
 * taken while the writer is open, so nothing was checkpointed).
 */
function crashedOldInstall(): { folder: string; original: Buffer; wal: Buffer } {
  const source = oldInstall()
  const writer = new Database(join(source, 'xidao.sqlite'))
  writer.pragma('wal_autocheckpoint = 0')
  writer.prepare('INSERT INTO notes (body) VALUES (?)').run('only in the WAL')
  const folder = userData()
  for (const suffix of ['', '-wal', '-shm']) copyFileSync(join(source, `xidao.sqlite${suffix}`), join(folder, `xidao.sqlite${suffix}`))
  writer.close()
  copyDirectory(join(source, 'draft-images'), join(folder, 'draft-images'))
  const wal = readFileSync(join(folder, 'xidao.sqlite-wal'))
  expect(wal.length).toBeGreaterThan(0)
  return { folder, original: readFileSync(join(folder, 'xidao.sqlite')), wal }
}

function copyDirectory(from: string, to: string): void {
  mkdirSync(to)
  for (const name of readdirSync(from)) {
    if (name.startsWith('aaaa')) continue
    copyFileSync(join(from, name), join(to, name))
  }
}

/** Makes every backup write fail: `backups` is a file, so no backup directory can be created. */
function breakBackups(folder: string): void {
  writeFileSync(join(folder, 'backups'), 'not a directory')
}

describe('pre-upgrade backup content', () => {
  it('saves the database with its committed WAL content, every draft attachment copy and the manifest before migrating', () => {
    const { folder } = crashedOldInstall()
    const db = open(folder, NEW)
    expect(db.status).toEqual({ state: 'ready', schemaVersion: 2 })

    const backup = preUpgradeBackupDirectory(folder)
    expect(JSON.parse(readFileSync(join(backup, 'manifest.json'), 'utf8'))).toEqual({
      format: 1,
      schemaVersion: 1,
      appVersion: '2.0.0-test',
      completedAt: '2026-11-02T08:00:00.000Z',
      draftImages: [{ name: IMAGE_A, size: PNG.length }, { name: IMAGE_B, size: GIF.length }]
    })
    const database = join(backup, 'xidao.sqlite')
    expect(notes(database)).toEqual(['first', 'only in the WAL'])
    expect(userVersion(database)).toBe(1)
    expect(columns(database)).not.toContain('extra')
    expect(readdirSync(join(backup, 'draft-images')).sort()).toEqual([IMAGE_A, IMAGE_B])
    expect(readFileSync(join(backup, 'draft-images', IMAGE_A))).toEqual(PNG)
    expect(readFileSync(join(backup, 'draft-images', IMAGE_B))).toEqual(GIF)
    expect(readdirSync(backup).sort()).toEqual(['draft-images', 'manifest.json', 'xidao.sqlite'])
    expect(readdirSync(join(folder, 'backups'))).toEqual(['pre-upgrade'])
    expect(readPreUpgradeBackup(folder)).toMatchObject({ schemaVersion: 1, appVersion: '2.0.0-test' })

    // The upgraded database itself.
    close(db)
    expect(columns(join(folder, 'xidao.sqlite'))).toContain('extra')
    expect(notes(join(folder, 'xidao.sqlite'))).toEqual(['first', 'only in the WAL'])
  })

  it('backs up a read-only draft attachment copy, leaving the original as it was', () => {
    // Its own setup (no symbolic link, so it also runs where links cannot be made).
    const folder = userData()
    close(open(folder, OLD, '1.0.0-test'))
    mkdirSync(join(folder, 'draft-images'))
    const original = join(folder, 'draft-images', IMAGE_A)
    writeFileSync(original, PNG)
    chmodSync(original, 0o444)
    const mode = statSync(original).mode & 0o777
    try {
      expect(open(folder, NEW).status).toEqual({ state: 'ready', schemaVersion: 2 })
      expect(readFileSync(join(preUpgradeBackupDirectory(folder), 'draft-images', IMAGE_A))).toEqual(PNG)
      expect(statSync(original).mode & 0o777).toBe(mode)
      expect(readFileSync(original)).toEqual(PNG)
    } finally {
      // Windows does not delete a read-only file.
      chmodSync(original, 0o644)
    }
  })

  it('takes no backup on a new install or when nothing needs migrating', () => {
    const fresh = userData()
    expect(open(fresh, NEW).status).toEqual({ state: 'ready', schemaVersion: 2 })
    expect(existsSync(join(fresh, 'backups'))).toBe(false)

    const current = oldInstall()
    expect(open(current, OLD).status).toEqual({ state: 'ready', schemaVersion: 1 })
    expect(existsSync(join(current, 'backups'))).toBe(false)
  })

  it('keeps the previous backup whole when a later backup fails partway', () => {
    const folder = oldInstall(['before the first upgrade'])
    close(open(folder, NEW))
    const before = readPreUpgradeBackup(folder)
    expect(before).toMatchObject({ schemaVersion: 1 })
    const backupDatabase = join(preUpgradeBackupDirectory(folder), 'xidao.sqlite')
    const previousBytes = readFileSync(backupDatabase)

    // The next upgrade's snapshot is written, then reading the draft attachments fails.
    rmSync(join(folder, 'draft-images'), { recursive: true })
    writeFileSync(join(folder, 'draft-images'), 'not a directory')
    const original = readFileSync(join(folder, 'xidao.sqlite'))
    const failed = open(folder, LATER)
    expect(failed.status).toEqual({ state: 'unavailable', reason: 'backup-failed', schemaVersion: 2, supportedVersion: 3 })
    close(failed)

    expect(readFileSync(join(folder, 'xidao.sqlite'))).toEqual(original)
    expect(readPreUpgradeBackup(folder)).toEqual(before)
    expect(readFileSync(backupDatabase)).toEqual(previousBytes)
    expect(notes(backupDatabase)).toEqual(['before the first upgrade'])
    expect(readdirSync(join(folder, 'backups'))).toEqual(['pre-upgrade'])

    // Once the failure is gone the next upgrade replaces it with the newer backup.
    rmSync(join(folder, 'draft-images'))
    expect(open(folder, LATER).status).toEqual({ state: 'ready', schemaVersion: 3 })
    expect(readPreUpgradeBackup(folder)).toMatchObject({ schemaVersion: 2, draftImages: [] })
    expect(columns(backupDatabase)).toContain('extra')
  })

  it('does not count a backup with a missing attachment copy or a damaged manifest as valid', () => {
    const folder = oldInstall()
    close(open(folder, NEW))
    const backup = preUpgradeBackupDirectory(folder)
    expect(verifyPreUpgradeBackup(backup)).not.toBeNull()
    rmSync(join(backup, 'draft-images', IMAGE_B))
    expect(verifyPreUpgradeBackup(backup)).toBeNull()
    writeFileSync(join(backup, 'manifest.json'), '{"format":1')
    expect(readPreUpgradeBackup(folder)).toBeNull()
  })
})

describe('failed pre-upgrade backup', () => {
  it('leaves the database byte for byte unchanged and unmigrated, then upgrades once the fault is gone', () => {
    const { folder, original, wal } = crashedOldInstall()
    breakBackups(folder)
    const failed = open(folder, NEW)
    expect(failed.status).toEqual({ state: 'unavailable', reason: 'backup-failed', schemaVersion: 1, supportedVersion: 2 })
    close(failed)
    expect(readFileSync(join(folder, 'xidao.sqlite'))).toEqual(original)
    expect(readFileSync(join(folder, 'xidao.sqlite-wal'))).toEqual(wal)
    expect(userVersion(join(folder, 'xidao.sqlite'))).toBe(1)
    expect(columns(join(folder, 'xidao.sqlite'))).not.toContain('extra')

    // 重新启动重试 after the fault was removed.
    rmSync(join(folder, 'backups'))
    expect(open(folder, NEW).status).toEqual({ state: 'ready', schemaVersion: 2 })
    expect(readPreUpgradeBackup(folder)).toMatchObject({ schemaVersion: 1 })
    expect(notes(join(preUpgradeBackupDirectory(folder), 'xidao.sqlite'))).toEqual(['first', 'only in the WAL'])
  })

  it('upgrades without a backup exactly once after 不备份升级, for that schema version only', async () => {
    const folder = oldInstall()
    breakBackups(folder)
    close(open(folder, NEW))
    await markUpgradeWithoutBackup(folder, 1)
    const upgraded = open(folder, NEW)
    expect(upgraded.status).toEqual({ state: 'ready', schemaVersion: 2 })
    close(upgraded)
    expect(columns(join(folder, 'xidao.sqlite'))).toContain('extra')
    expect(readFileSync(join(folder, 'backups'), 'utf8')).toBe('not a directory')
    expect(existsSync(join(folder, 'upgrade-without-backup.json'))).toBe(false)

    // The next upgrade backs up again (and fails again here): the choice was used up.
    expect(open(folder, LATER).status).toMatchObject({ state: 'unavailable', reason: 'backup-failed', schemaVersion: 2 })

    // A choice made for another schema version is dropped, not applied.
    await markUpgradeWithoutBackup(folder, 1)
    expect(open(folder, LATER).status).toMatchObject({ state: 'unavailable', reason: 'backup-failed', schemaVersion: 2 })
    expect(existsSync(join(folder, 'upgrade-without-backup.json'))).toBe(false)
  })

  it('drops 不备份升级 when the migration fails, keeping the original database', async () => {
    const folder = oldInstall()
    breakBackups(folder)
    const original = readFileSync(join(folder, 'xidao.sqlite'))
    await markUpgradeWithoutBackup(folder, 1)
    const failed = open(folder, FAILING)
    expect(failed.status).toEqual({ state: 'unavailable', reason: 'migration-failed' })
    close(failed)
    expect(readFileSync(join(folder, 'xidao.sqlite'))).toEqual(original)
    expect(existsSync(join(folder, 'upgrade-without-backup.json'))).toBe(false)
    expect(open(folder, NEW).status).toMatchObject({ state: 'unavailable', reason: 'backup-failed' })
  })
})
