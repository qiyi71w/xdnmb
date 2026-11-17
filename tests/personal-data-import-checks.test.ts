import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateDatabase } from '../src/main/storage/database'
import { readSecretRows, SECRET_LIMITS } from '../src/main/storage/export-snapshot'
import { checkStagedImport, ImportCheckError } from '../src/main/storage/import-staging'
import { MIGRATIONS, type Migration } from '../src/main/storage/migrations'
import { MIGRATIONS as INTEGRATED_V7 } from './fixtures/integrated-v7'
import { MIGRATIONS as LIFECYCLE_V7 } from './fixtures/lifecycle-v7'
import { MIGRATIONS as RECONCILIATION_V6 } from './fixtures/reconciliation-v6'
import { MIGRATIONS as REMINDERS_V9 } from './fixtures/reminders-v9'

const SUPPORTED = Math.max(...MIGRATIONS.map((migration) => migration.version))
const folders: string[] = []

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/**
 * A staging directory whose database is `build`'s, written the way an export writes it (`VACUUM
 * INTO`, so only what the database holds is there).
 */
function staged(build: (db: Database.Database) => void): string {
  const staging = mkdtempSync(join(tmpdir(), 'xidao-import-checks-'))
  folders.push(staging)
  const live = new Database(':memory:')
  try {
    build(live)
    live.prepare('VACUUM INTO ?').run(join(staging, 'xidao.sqlite'))
  } finally {
    live.close()
  }
  return staging
}

function checkError(staging: string, version = SUPPORTED): ImportCheckError | null {
  try {
    checkStagedImport(staging, version)
    return null
  } catch (error) {
    return error as ImportCheckError
  }
}

describe('the staged database’s schema, before anything of the file runs', () => {
  // Expressions SQLite would evaluate for the file: a CHECK, a trigger, a view, an expression index,
  // a default and a generated column. `json('{')` fails when evaluated, so a refusal for any other
  // reason than the schema itself shows it ran.
  const changes: Array<[string, string]> = [
    ['a new table with a CHECK', "CREATE TABLE extra (a INTEGER CHECK (json('{') IS NOT NULL)); INSERT INTO extra VALUES (1)"],
    ['a trigger', "CREATE TRIGGER extra AFTER INSERT ON thread_visits BEGIN SELECT json('{'); END"],
    ['a view', "CREATE VIEW extra AS SELECT json('{') AS a"],
    ['an index on an expression', 'CREATE INDEX extra ON thread_visits (length(thread_id))'],
    ['a column with a default expression', "CREATE TABLE extra (a TEXT DEFAULT (json('{')))"],
    ['a generated column', 'ALTER TABLE thread_visits ADD COLUMN extra INTEGER GENERATED ALWAYS AS (length(thread_id)) VIRTUAL']
  ]

  it.each(changes)('refuses %s by comparing the schema, without running it', (_name, change) => {
    const error = checkError(staged((db) => {
      migrateDatabase(db, MIGRATIONS)
      db.pragma('ignore_check_constraints = ON')
      db.exec(change)
    }))
    expect(error).toBeInstanceOf(ImportCheckError)
    expect(error?.message).toBe('unexpected schema')
  })

  it('refuses a table of this version with an added CHECK whose columns and indexes are unchanged', () => {
    // The CHECK holds: only its SQL tells the table apart from this version's.
    const error = checkError(staged((db) => {
      migrateDatabase(db, MIGRATIONS)
      const sql = db.prepare<[], string>("SELECT sql FROM sqlite_master WHERE name = 'thread_visits'").pluck().get()!
      db.unsafeMode(true)
      db.pragma('writable_schema = ON')
      db.prepare("UPDATE sqlite_master SET sql = ? WHERE name = 'thread_visits'").run(sql.replace(/\)\s*$/, ', CHECK (length(randomblob(16)) = 16))'))
      db.pragma('writable_schema = RESET')
    }))
    expect(error?.message).toBe('unexpected schema')
  })

  it('takes the database of an install at this version, new or upgraded from any earlier one', () => {
    const earlier: readonly (readonly Migration[])[] = [
      ...MIGRATIONS.map((migration) => MIGRATIONS.filter((other) => other.version <= migration.version)),
      RECONCILIATION_V6, INTEGRATED_V7, LIFECYCLE_V7, REMINDERS_V9
    ]
    for (const chain of earlier) {
      const staging = staged((db) => {
        migrateDatabase(db, chain)
        migrateDatabase(db, MIGRATIONS)
      })
      expect(checkError(staging), `upgraded from version ${Math.max(...chain.map((migration) => migration.version))}`).toBeNull()
    }
  })

  it('takes an older version’s database at its own version and migrates it', () => {
    for (const version of MIGRATIONS.map((migration) => migration.version)) {
      const staging = staged((db) => migrateDatabase(db, MIGRATIONS.filter((migration) => migration.version <= version)))
      expect(checkError(staging, version), `version ${version}`).toBeNull()
    }
  })
})

describe('secret value sizes', () => {
  function withCredentials(values: Buffer[]): string {
    return staged((db) => {
      migrateDatabase(db, MIGRATIONS)
      const insert = db.prepare(`INSERT INTO credentials (name, cookie_id, source, imported_at, ciphertext, position)
        VALUES ('x', 'XXXXXXX', 'raw', 'x', ?, ?)`)
      values.forEach((value, index) => insert.run(value, index + 1))
    })
  }

  it('reads values within the limits', () => {
    const staging = withCredentials([Buffer.alloc(SECRET_LIMITS.maxValueBytes, 1), Buffer.alloc(100, 2)])
    expect(checkError(staging)).toBeNull()
    expect(readSecretRows(join(staging, 'xidao.sqlite')).credentials.map((row) => row.value.length)).toEqual([SECRET_LIMITS.maxValueBytes, 100])
  })

  it.each([
    ['one value over its limit', [Buffer.alloc(SECRET_LIMITS.maxValueBytes + 1, 1)]],
    ['values over their total', Array.from({ length: SECRET_LIMITS.maxTotalBytes / SECRET_LIMITS.maxValueBytes + 1 }, () => Buffer.alloc(SECRET_LIMITS.maxValueBytes, 1))]
  ])('refuses %s before reading any value', (_name, values) => {
    const staging = withCredentials(values)
    expect(checkError(staging)).toBeInstanceOf(ImportCheckError)
    expect(() => readSecretRows(join(staging, 'xidao.sqlite'))).toThrow()
  })
})
