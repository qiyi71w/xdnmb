import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { markUpgradeWithoutBackup } from '../src/main/storage/backup'
import {
  APP_SETTING_CLASSES, APPENDED_FILES, APPENDED_PARTS, DATA_CLASSES, OTHER_SETTING_CLASSES, settingClass, settingKeysIn, TABLES, tablesIn,
  USER_DATA_ENTRIES, userDataEntriesIn
} from '../src/main/storage/classification'
import { openReadingDatabase } from '../src/main/storage/database'
import { MIGRATIONS, type Migration } from '../src/main/storage/migrations'
import { SETTING_KEYS } from '../src/shared/settings'
import { MIGRATIONS as INTEGRATED_V7 } from './fixtures/integrated-v7'
import { MIGRATIONS as LIFECYCLE_V7 } from './fixtures/lifecycle-v7'
import { MIGRATIONS as RECONCILIATION_V6 } from './fixtures/reconciliation-v6'
import { MIGRATIONS as REMINDERS_V9 } from './fixtures/reminders-v9'

const SUPPORTED = Math.max(...MIGRATIONS.map((migration) => migration.version))
const folders: string[] = []

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function userData(): string {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-classification-'))
  folders.push(folder)
  return folder
}

/** Opens and closes as the app does; an existing database is backed up and migrated. */
function openAndClose(folder: string, migrations: readonly Migration[]): void {
  const db = openReadingDatabase(join(folder, 'xidao.sqlite'), migrations, { appVersion: '0.0.0-test' })
  const { status } = db
  db.close()
  expect(status.state).toBe('ready')
}

/**
 * The tables of a database against the classification: tables (virtual ones included) not
 * classified, and classified tables it does not have. An FTS5 shadow table must belong to a
 * classified virtual table; SQLite's own tables go with the rows they describe.
 */
function tableGaps(path: string): { unclassified: string[]; missing: string[] } {
  const db = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const rows = db.prepare<[], { name: string; type: string }>("SELECT name, type FROM pragma_table_list WHERE schema = 'main' AND name NOT LIKE 'sqlite_%'").all()
    const tables = rows.filter((row) => row.type === 'table' || row.type === 'virtual').map((row) => row.name)
    const virtual = rows.filter((row) => row.type === 'virtual').map((row) => row.name)
    const shadows = rows.filter((row) => row.type === 'shadow').map((row) => row.name)
    for (const shadow of shadows) expect(virtual.some((name) => shadow.startsWith(`${name}_`)), shadow).toBe(true)
    return {
      unclassified: tables.filter((name) => !Object.hasOwn(TABLES, name)).sort(),
      missing: Object.keys(TABLES).filter((name) => !tables.includes(name)).sort()
    }
  } finally {
    db.close()
  }
}

function sources(directory: string): { path: string; text: string }[] {
  return readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ path: relative(process.cwd(), join(directory, name)), text: readFileSync(join(directory, name), 'utf8') }))
}

describe('tables', () => {
  it('classifies every table of the current schema, new installs and upgraded ones alike', () => {
    const fresh = userData()
    openAndClose(fresh, MIGRATIONS)
    expect(tableGaps(join(fresh, 'xidao.sqlite'))).toEqual({ unclassified: [], missing: [] })

    for (const earlier of [MIGRATIONS.slice(0, 1), RECONCILIATION_V6, INTEGRATED_V7, LIFECYCLE_V7, REMINDERS_V9]) {
      const folder = userData()
      openAndClose(folder, earlier)
      openAndClose(folder, MIGRATIONS)
      expect(tableGaps(join(folder, 'xidao.sqlite'))).toEqual({ unclassified: [], missing: [] })
    }
  })

  it('fails for a table a migration adds without classifying it', () => {
    const folder = userData()
    openAndClose(folder, [...MIGRATIONS, { version: SUPPORTED + 1, up: (db) => db.exec('CREATE TABLE unclassified_feature (id INTEGER PRIMARY KEY)') }])
    expect(tableGaps(join(folder, 'xidao.sqlite'))).toEqual({ unclassified: ['unclassified_feature'], missing: [] })
  })

  it('answers by class: each table in exactly one, settings by key', () => {
    const listed = DATA_CLASSES.flatMap((dataClass) => tablesIn(dataClass))
    expect(new Set(listed).size).toBe(listed.length)
    expect(listed.sort()).toEqual(Object.keys(TABLES).filter((name) => name !== 'settings').sort())
    expect(tablesIn('secret').sort()).toEqual(['credentials', 'subscription_app_credentials'])
    expect(tablesIn('target-kept')).toEqual(['account_session'])
    expect(tablesIn('not-exported', 'cache').sort()).toEqual(['directory_snapshot', 'feed_pages', 'image_resources', 'posts', 'thread_pages', 'thread_reply_counts'])
    expect([...tablesIn('not-exported', 'cache'), ...tablesIn('not-exported', 'rebuilt')].sort()).toEqual(tablesIn('not-exported').sort())
    expect(APPENDED_PARTS.flatMap((part) => tablesIn('target-appended', part)).sort()).toEqual(tablesIn('target-appended').sort())
    for (const part of APPENDED_PARTS) expect(tablesIn('target-appended', part), part).not.toEqual([])
  })
})

describe('settings', () => {
  it('classifies every AppSettings key, keeping this device’s own', () => {
    expect(Object.keys(APP_SETTING_CLASSES).sort()).toEqual([...SETTING_KEYS].sort())
    expect(settingKeysIn('target-kept').sort()).toEqual([
      'analytics', 'bossKey', 'bossKeyEnabled', 'cacheLimitBytes', 'closeAction', 'listWidth', 'loginLaunchResident',
      'thirdPartyConsent', 'updateAutoDownload', 'updateAutoInstall', 'updateNetwork'
    ])
    expect(settingClass('announcements')).toBe('overwrite')
    expect(settingClass('colorScheme')).toBe('overwrite')
    expect(settingClass('unclassified')).toBeNull()
  })

  it('classifies every other row the app writes to the settings table', () => {
    const keys = new Set<string>()
    for (const { text } of sources('src/main')) {
      for (const match of text.matchAll(/\bsettings\b[^'"`;]*?(?:key\s*=\s*|VALUES\s*\(\s*)'([^']+)'/g)) keys.add(match[1]!)
    }
    expect([...keys].sort()).toEqual(Object.keys(OTHER_SETTING_CLASSES).sort())
  })
})

describe('user data', () => {
  it('classifies every entry the app creates in the user data directory', async () => {
    // Named where the app is assembled: `join(app.getPath('userData'), '<entry>')`.
    const named = new Set<string>()
    for (const { path, text } of sources('src/main')) {
      for (const match of text.matchAll(/app\.getPath\('userData'\)(?:, '([^']+)')?/g)) {
        if (match[1] !== undefined) named.add(match[1])
        // The directory itself goes only to storage, whose entries are created below.
        else expect(text.slice(Math.max(0, match.index - 30), match.index), path).toMatch(/markUpgradeWithoutBackup\($/)
      }
    }

    // Created by storage: the database and its companions, the pre-upgrade backup and the swap
    // journal under `backups/`, and 不备份升级.
    const folder = userData()
    openAndClose(folder, MIGRATIONS.slice(0, -1))
    openAndClose(folder, MIGRATIONS)
    await markUpgradeWithoutBackup(folder, SUPPORTED)
    const created = readdirSync(folder).map((name) => name.replace(/-(?:wal|shm|journal)$/, ''))
    expect(created).toContain('backups')

    expect([...new Set([...named, ...created])].sort()).toEqual(Object.keys(USER_DATA_ENTRIES).sort())
  })

  it('answers by class, the database by its tables', () => {
    const listed = DATA_CLASSES.flatMap((dataClass) => userDataEntriesIn(dataClass))
    expect(new Set(listed).size).toBe(listed.length)
    expect(listed.sort()).toEqual(Object.keys(USER_DATA_ENTRIES).filter((name) => name !== 'xidao.sqlite').sort())
  })

  it('keeps each target-appended part’s files where export, import staging and the swap look for them', () => {
    // Every part's files are in an entry of the user data directory; an entry of the class itself
    // is a part's own (the swap moves it with the database), so no such entry goes unhandled.
    for (const part of APPENDED_PARTS) expect(Object.keys(USER_DATA_ENTRIES), part).toContain(APPENDED_FILES[part])
    expect(userDataEntriesIn('target-appended').sort())
      .toEqual(APPENDED_PARTS.filter((part) => USER_DATA_ENTRIES[APPENDED_FILES[part]]?.class === 'target-appended').map((part) => APPENDED_FILES[part]).sort())
  })
})
