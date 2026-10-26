import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { MIGRATIONS } from '../src/main/storage/migrations'
import { StorageWriteRefusedError } from '../src/main/storage/contract'

const folders: string[] = []
const connections: ReadingDatabase[] = []
const at = '2026-10-25T00:00:00.000Z'
const later = '2026-10-25T00:01:00.000Z'
function path() {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-blocks-'))
  folders.push(folder)
  return join(folder, 'reading.sqlite')
}
function open(file: string) {
  const db = openReadingDatabase(file)
  connections.push(db)
  return db
}
afterEach(() => {
  for (const db of connections.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

describe('local blocks migration and storage', () => {
  it('upgrades v12 without changing settings and starts with an empty block list', () => {
    const file = path()
    const old = new Database(file)
    try {
      for (const migration of MIGRATIONS.filter((item) => item.version <= 12)) migration.up(old)
      old.pragma('user_version = 12')
      old.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run('newTabSplitDefault', 'false')
    } finally { old.close() }
    const db = open(file)
    expect(db.status).toEqual({ state: 'ready', schemaVersion: Math.max(...MIGRATIONS.map((item) => item.version)) })
    expect(db.loadSettings().newTabSplitDefault).toBe(false)
    expect(db.listBlocks()).toEqual([])
  })

  it('adds, deduplicates, lists and removes numbers and public cookies independently', () => {
    const db = open(path())
    db.setBlock('post', '12345678901234567890', true, at)
    db.setBlock('cookie', 'synthetic-public-id', true, later)
    db.setBlock('post', '12345678901234567890', true, later)
    expect(db.listBlocks()).toEqual([
      { kind: 'cookie', value: 'synthetic-public-id', createdAt: later },
      { kind: 'post', value: '12345678901234567890', createdAt: at }
    ])
    db.setBlock('post', '12345678901234567890', false, later)
    db.setBlock('post', '12345678901234567890', false, later)
    expect(db.listBlocks()).toEqual([{ kind: 'cookie', value: 'synthetic-public-id', createdAt: later }])
    db.setBlock('cookie', 'synthetic-public-id', false, later)
    expect(db.listBlocks()).toEqual([])
  })

  it('persists across fresh connections and refuses changes to a newer-schema database', () => {
    const file = path()
    const db = openReadingDatabase(file)
    db.setBlock('post', '123', true, at)
    db.close()
    const raw = new Database(file)
    raw.pragma(`user_version = ${Math.max(...MIGRATIONS.map((item) => item.version)) + 1}`)
    raw.close()
    const readonly = open(file)
    expect(readonly.status.state).toBe('read-only')
    expect(readonly.listBlocks()).toEqual([{ kind: 'post', value: '123', createdAt: at }])
    expect(() => readonly.setBlock('post', '123', false, later)).toThrow(StorageWriteRefusedError)
    expect(readonly.listBlocks()).toHaveLength(1)
  })
})
