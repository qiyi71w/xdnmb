import Database from 'better-sqlite3'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { isManagedName } from '../images/files'
import { settingKeysIn, tablesIn } from './classification'
import { migrateDatabase } from './database'
import { readCredentialSequence, resetRebuilt } from './export-snapshot'
import { STAGED_DATABASE, STAGED_DRAFT_IMAGES, STAGED_OFFLINE_IMAGES } from './import-journal'
import { MIGRATIONS } from './migrations'

/*
 * The database part of 导入个人数据 (see docs/development.md), run on a worker thread in the app.
 * The export file's content is extracted into the import staging directory (`./import-journal`)
 * and only ever changed there; this machine's database is only read.
 *
 * Checking (before the confirmation): the staged database is the file's own schema version, passes
 * SQLite's integrity check, takes this version's migration chain (an older file is migrated here,
 * in staging), then has exactly the tables, columns and indexes a fresh install has, no dangling
 * reference, and every draft attachment and offline original it names among the extracted files
 * with its recorded size.
 *
 * Merging (after the confirmation), on the checked database, with this machine's database read in
 * one read transaction; the steps (`MERGE_STEPS`) follow the 数据归类 in `./classification`:
 *
 *   1. The file's database is the base (already at this version's schema, see above).
 *   2. 目标机保留: this machine's `target-kept` tables and setting rows replace the file's.
 *   3. 秘密: the file's credentials and App UUIDs go (a file without secrets has none to keep, and
 *      its references must find nothing); this machine's 饼干凭据 are appended with new IDs after
 *      both the file's credential sequence and every ID in the staged database, so no reference in
 *      the file ever resolves to them, and the ID sequence moves past them (`CredentialIdMap`); its
 *      App UUIDs are appended. A subscription configuration whose App UUID is now missing is
 *      未配置 under a new generation; earlier generations' observations, operations and plans stay
 *      history and are never carried on.
 *   4. (Offline copies: the file's replace this machine's.)
 *   5. (Drafts: the file's replace this machine's.)
 *   6. 不导出 derived state goes back to its initial state; the app rebuilds it at the next start.
 *   7. The result passes the foreign key and integrity checks.
 *
 * Nothing secret is decrypted: this machine's ciphertext is carried as it is.
 */

/** What the export file says about itself that merging needs. */
export interface ImportFileFacts {
  /** Upper bound of the file's 饼干凭据 ID sequence (its manifest's). */
  credentialSequence: number
  /** Whether the file carries 饼干凭据 and App UUIDs. */
  secrets: boolean
}

/**
 * 目标机凭据编号映射: this machine's 饼干凭据 ID → its ID in the staged database. Step 3 fills it;
 * later steps that carry this machine's references along rewrite them through it.
 */
export type CredentialIdMap = Map<number, number>

/** The staged database is not one this version can import. */
export class ImportCheckError extends Error {
  override readonly name = 'ImportCheckError'
}

/** What a merge step works with: the staged database (written) and this machine's (read). */
interface MergeContext {
  staged: Database.Database
  local: Database.Database
  file: ImportFileFacts
  credentialIds: CredentialIdMap
}

function count(db: Database.Database, sql: string): number {
  return db.prepare<[], { n: number }>(sql).get()?.n ?? 0
}

function sizeOf(path: string): number | null {
  try {
    const stat = lstatSync(path)
    return stat.isFile() ? stat.size : null
  } catch {
    return null
  }
}

/** Tables, columns and indexes: what every migration path of this version converges to. */
function shapeOf(db: Database.Database): string {
  const objects = db.prepare<[], { type: string; name: string }>(
    "SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
  ).all()
  return JSON.stringify(objects.map((object) => ({
    ...object,
    columns: object.type === 'table' ? db.pragma(`table_info("${object.name}")`) : null,
    indexes: object.type === 'table' ? db.pragma(`index_list("${object.name}")`) : null
  })))
}

let freshShape: string | null = null

function currentShape(): string {
  if (freshShape === null) {
    const fresh = new Database(':memory:')
    try {
      migrateDatabase(fresh, MIGRATIONS)
      freshShape = shapeOf(fresh)
    } finally {
      fresh.close()
    }
  }
  return freshShape
}

function openStaged(stagingDirectory: string): Database.Database {
  const db = new Database(join(stagingDirectory, STAGED_DATABASE), { fileMustExist: true })
  try {
    // One file: nothing beside it is moved into place.
    db.pragma('journal_mode = DELETE')
    db.pragma('foreign_keys = ON')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

function verified(db: Database.Database): boolean {
  return db.pragma('integrity_check', { simple: true }) === 'ok' && (db.pragma('foreign_key_check') as unknown[]).length === 0
}

/** Every file a row names is among the extracted ones, with the size the row records. */
function filesComplete(db: Database.Database, directory: string, sql: string): boolean {
  for (const { name, bytes } of db.prepare<[], { name: string; bytes: number }>(sql).iterate()) {
    if (!isManagedName(name) || sizeOf(join(directory, name)) !== bytes) return false
  }
  return true
}

/**
 * Checks the extracted database at `schemaVersion` (the manifest's) and migrates it to this
 * version in staging. Throws `ImportCheckError` when it cannot be imported.
 */
export function checkStagedImport(stagingDirectory: string, schemaVersion: number): void {
  let db: Database.Database
  try {
    db = openStaged(stagingDirectory)
  } catch {
    throw new ImportCheckError('staged database does not open')
  }
  try {
    if (Number(db.pragma('user_version', { simple: true })) !== schemaVersion) throw new ImportCheckError('schema version differs from the manifest')
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new ImportCheckError('integrity check failed')
    migrateDatabase(db, MIGRATIONS)
    if (shapeOf(db) !== currentShape()) throw new ImportCheckError('unexpected schema')
    if (!verified(db)) throw new ImportCheckError('migrated database failed verification')
    const complete = filesComplete(db, join(stagingDirectory, STAGED_DRAFT_IMAGES), 'SELECT file_name AS name, bytes FROM draft_attachments')
      && filesComplete(db, join(stagingDirectory, STAGED_OFFLINE_IMAGES), `SELECT r.file_name AS name, r.bytes FROM image_resources r
        WHERE EXISTS(SELECT 1 FROM offline_images o WHERE o.resource_id = r.id)`)
    if (!complete) throw new ImportCheckError('files missing')
  } catch (error) {
    throw error instanceof ImportCheckError ? error : new ImportCheckError('staged database not importable', { cause: error })
  } finally {
    db.close()
  }
}

/** What the confirmation says this machine loses: its 浏览历史 and 发送记录 counts. */
export function readLocalCounts(databasePath: string): { history: number; sendRecords: number } {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 5000 })
  try {
    return db.transaction(() => ({
      history: count(db, 'SELECT count(*) AS n FROM thread_visits'),
      sendRecords: count(db, 'SELECT count(*) AS n FROM publication_attempts')
    }))()
  } finally {
    db.close()
  }
}

function columnsOf(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info("${table}")`) as { name: string }[]).map((column) => column.name)
}

/** Copies this machine's rows of `table` (both databases have this version's schema) into staging. */
function copyLocalRows(context: MergeContext, table: string, where = '', params: unknown[] = []): void {
  const columns = columnsOf(context.staged, table)
  const list = columns.map((column) => `"${column}"`).join(', ')
  const insert = context.staged.prepare(`INSERT INTO "${table}" (${list}) VALUES (${columns.map(() => '?').join(', ')})`)
  for (const row of context.local.prepare(`SELECT ${list} FROM "${table}" ${where}`).raw().iterate(...params)) insert.run(row)
}

/** Step 2: 目标机保留 — this machine's tables and setting rows of that class replace the file's. */
function keepTargetItems(context: MergeContext): void {
  for (const table of tablesIn('target-kept')) {
    context.staged.exec(`DELETE FROM "${table}"`)
    copyLocalRows(context, table)
  }
  const keys = JSON.stringify(settingKeysIn('target-kept'))
  context.staged.prepare('DELETE FROM settings WHERE key IN (SELECT value FROM json_each(?))').run(keys)
  copyLocalRows(context, 'settings', 'WHERE key IN (SELECT value FROM json_each(?))', [keys])
}

/**
 * Step 3, the file's secrets. A file without secrets carries none; anything in its secret tables
 * is dropped, so that none of its references finds a credential.
 */
function dropFileSecrets(context: MergeContext): void {
  if (context.file.secrets) throw new Error('secrets in the export file are not supported')
  for (const table of tablesIn('secret')) context.staged.exec(`DELETE FROM "${table}"`)
}

/**
 * Step 3, this machine's 饼干凭据: appended in their order with IDs after the file's credential
 * sequence and every staged ID, recorded in `credentialIds`; the ID sequence moves past them.
 */
function appendLocalCredentials(context: MergeContext): void {
  const { staged, local, credentialIds } = context
  const columns = columnsOf(staged, 'credentials').filter((column) => column !== 'id')
  const list = columns.map((column) => `"${column}"`).join(', ')
  const insert = staged.prepare(`INSERT INTO credentials (id, ${list}) VALUES (?, ${columns.map(() => '?').join(', ')})`)
  let next = Math.max(context.file.credentialSequence, readCredentialSequence(staged))
  for (const [id, ...values] of local.prepare(`SELECT id, ${list} FROM credentials ORDER BY id`).raw().iterate() as Iterable<[number, ...unknown[]]>) {
    next++
    insert.run(next, ...values)
    credentialIds.set(id, next)
  }
  if (staged.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'credentials'").run(next).changes === 0) {
    staged.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('credentials', ?)").run(next)
  }
}

/** Step 3, this machine's App UUIDs (local IDs are random UUIDs). */
function appendLocalAppCredentials(context: MergeContext): void {
  copyLocalRows(context, 'subscription_app_credentials')
}

/**
 * Step 3, the file's subscription configuration: without its App UUID it is 未配置 under a new
 * generation (as for a restored pre-upgrade backup), so earlier observations, operations and plans
 * stay history and are never carried on.
 */
function settleSubscriptionConfiguration(context: MergeContext): void {
  context.staged.exec(`UPDATE subscription_configuration SET app_credential_id = NULL, generation = generation + 1
    WHERE app_credential_id IS NOT NULL AND app_credential_id NOT IN (SELECT id FROM subscription_app_credentials)`)
}

/** Step 6: 不导出 derived state starts afresh. */
function resetDerivedState(context: MergeContext): void {
  resetRebuilt(context.staged)
}

/** The merge, in order (see the top of this file); every step runs in one transaction. */
const MERGE_STEPS: readonly ((context: MergeContext) => void)[] = [
  keepTargetItems,
  dropFileSecrets,
  appendLocalCredentials,
  appendLocalAppCredentials,
  settleSubscriptionConfiguration,
  resetDerivedState
]

/**
 * Builds the import result in staging from the checked file database and this machine's database
 * at `localDatabasePath` (only read). Throws, the staged database unchanged, when a step fails or
 * the result does not pass its checks.
 */
export function stageImport(stagingDirectory: string, localDatabasePath: string, file: ImportFileFacts): { credentialIds: CredentialIdMap } {
  const staged = openStaged(stagingDirectory)
  let local: Database.Database | null = null
  try {
    const supported = MIGRATIONS.reduce((highest, migration) => Math.max(highest, migration.version), 0)
    if (Number(staged.pragma('user_version', { simple: true })) !== supported) throw new Error('staged database not checked')
    local = new Database(localDatabasePath, { readonly: true, fileMustExist: true, timeout: 5000 })
    const context: MergeContext = { staged, local, file, credentialIds: new Map() }
    // One read transaction: this machine's rows are from one moment.
    local.transaction(() => {
      staged.transaction(() => {
        for (const step of MERGE_STEPS) step(context)
      }).immediate()
    })()
    if (!verified(staged)) throw new Error('staged import failed verification')
    return { credentialIds: context.credentialIds }
  } finally {
    local?.close()
    staged.close()
  }
}
