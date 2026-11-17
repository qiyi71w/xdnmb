import Database from 'better-sqlite3'
import type { OfflineCopy } from '../../shared/content'
import { isManagedName } from '../images/files'
import { settingClass, tablesIn } from './classification'
import { RetainedContentDatabase } from './retained'

/*
 * The database part of 导出个人数据 (see docs/development.md). A consistent snapshot of the app's
 * database is taken on a read-only connection, the same way as the pre-upgrade backup (`VACUUM
 * INTO`, committed WAL content included), and trimmed by the 数据归类 in `./classification`:
 *
 * - `not-exported` derived state (`rebuilt`) goes back to its initial state: search index, image
 *   holders, readers and content clock, the reminder checker.
 * - `target-kept` tables and setting rows are emptied. `secret` tables are emptied too (the
 *   credential ID sequence stays in `sqlite_sequence` and is reported for the manifest), unless
 *   the export carries secrets: then every 饼干凭据 and App UUID keeps its row, its ciphertext
 *   replaced by the value sealed for the file (`SecretRows`; sealed in the main process, so the
 *   copy never holds a secret in plain text nor this machine's ciphertext).
 * - Without offline copies, the offline copies' tables (`target-appended` part `offline-copies`) are
 *   emptied first, so what only they protected is trimmed with the rest of the cache.
 * - The ordinary cache (`not-exported` `cache`) is then trimmed by the rules of 清理普通缓存
 *   (`RetainedContentDatabase.evictContentBatch`): what personal records protect stays.
 *
 * Only the copy is written; every function here runs on a worker thread in the app.
 */

/** A managed file a snapshot row names: a draft attachment copy or an offline copy's original. */
export interface SnapshotFile {
  /** `draft_attachments.id` or `image_resources.id`. */
  id: number
  name: string
}

export interface SnapshotFiles {
  draftImages: SnapshotFile[]
  /** Originals held by offline copies. */
  offlineImages: SnapshotFile[]
}

export interface ExportEstimateCounts {
  offlineThreads: number
  /** Originals the offline copies hold and the text of their posts. */
  offlineBytes: number
  draftImageBytes: number
}

export interface TrimOptions {
  includeOffline: boolean
  /** Offline originals (`image_resources.id`) whose files could not be read: 图片未保存 in their copies. */
  missingOfflineImages: readonly number[]
  /** Draft attachments whose files could not be read: their drafts and send records keep no attachment. */
  missingDraftImages: readonly number[]
  /** The secrets sealed for the file, one for every secret row of the snapshot; null: none exported. */
  secrets: SecretRows | null
}

/**
 * The secret tables' rows by key, with what their ciphertext column holds: this machine's protector
 * ciphertext in its database, a value sealed under the export's secret key in an export file, or the
 * importing machine's ciphertext once re-encrypted.
 */
export interface SecretRows {
  credentials: { id: number; value: Uint8Array }[]
  appCredentials: { id: string; value: Uint8Array }[]
}

/** The `secret` tables whose rows travel with an export carrying secrets; any other is emptied. */
export const CARRIED_SECRET_TABLES: readonly string[] = ['credentials', 'subscription_app_credentials']

/**
 * Bounds on the carried secret tables, checked with SQL before any ciphertext is read. A real value
 * (a protected or sealed userhash or App UUID) is well under a kilobyte, and a machine has a few
 * dozen at most; a database beyond these is not one the app wrote.
 */
export const SECRET_LIMITS = { maxRows: 10_000, maxValueBytes: 64 * 1024, maxTotalBytes: 4 * 1024 * 1024 } as const

export interface TrimResult extends SnapshotFiles {
  schemaVersion: number
  /** Upper bound of the 饼干凭据 ID sequence, recorded even though the credentials are not exported. */
  credentialSequence: number
  stats: { history: number; sendRecords: number; offlineThreads: number }
}

/** Initial state of the `rebuilt` tables that keep a row; every other one starts empty. */
const INITIAL_STATE: Readonly<Record<string, string>> = {
  search_state: 'UPDATE search_state SET ready = 0',
  content_clock: 'UPDATE content_clock SET tick = 0'
}

/** The column names of `table`, in order. */
export function columnsOf(db: Database.Database, table: string): string[] {
  return (db.pragma(`table_info("${table}")`) as { name: string }[]).map((column) => column.name)
}

/** `tables` in an order deleting their rows allows: each before those of them it references. */
export function referencingFirst(db: Database.Database, tables: readonly string[]): string[] {
  const references = new Map(tables.map((table) => [table, (db.pragma(`foreign_key_list("${table}")`) as { table: string }[])
    .map((key) => key.table).filter((other) => other !== table && tables.includes(other))]))
  const ordered: string[] = []
  while (ordered.length < tables.length) {
    const next = tables.find((table) => !ordered.includes(table)
      && tables.every((other) => other === table || ordered.includes(other) || !references.get(other)!.includes(table)))
    if (next === undefined) throw new Error('tables reference each other in a cycle')
    ordered.push(next)
  }
  return ordered
}

function openReadOnly(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true, timeout: 5000 })
}

function count(db: Database.Database, sql: string): number {
  return db.prepare<[], { n: number }>(sql).get()?.n ?? 0
}

function listFiles(db: Database.Database): SnapshotFiles {
  const managed = (rows: { id: number; name: string }[]) => rows.filter((row) => isManagedName(row.name))
  return {
    draftImages: managed(db.prepare<[], SnapshotFile>('SELECT id, file_name AS name FROM draft_attachments ORDER BY file_name').all()),
    offlineImages: managed(db.prepare<[], SnapshotFile>(`SELECT r.id, r.file_name AS name FROM image_resources r
      WHERE EXISTS(SELECT 1 FROM offline_images o WHERE o.resource_id = r.id) ORDER BY r.file_name`).all())
  }
}

/** Sizes for the export dialog, read on a read-only connection. */
export function readExportEstimate(databasePath: string): ExportEstimateCounts {
  const db = openReadOnly(databasePath)
  try {
    return db.transaction(() => ({
      offlineThreads: count(db, 'SELECT count(*) AS n FROM offline_copies'),
      offlineBytes: count(db, `SELECT coalesce(sum(bytes), 0) AS n FROM image_resources r
          WHERE EXISTS(SELECT 1 FROM offline_images o WHERE o.resource_id = r.id)`)
        + count(db, `SELECT coalesce(sum(bytes), 0) AS n FROM content_post_bytes
          WHERE id IN (SELECT head_id FROM offline_pages UNION SELECT post_id FROM offline_page_posts)`),
      draftImageBytes: count(db, 'SELECT coalesce(sum(bytes), 0) AS n FROM draft_attachments')
    }))()
  } finally {
    db.close()
  }
}

/**
 * Writes a consistent snapshot of the database at `databasePath` to the new file `workPath` and
 * lists the managed files it names. Writes made after this are not in the snapshot.
 */
export function takeExportSnapshot(databasePath: string, workPath: string): SnapshotFiles {
  const source = openReadOnly(databasePath)
  try {
    source.prepare('VACUUM INTO ?').run(workPath)
  } finally {
    source.close()
  }
  const copy = openReadOnly(workPath)
  try {
    return listFiles(copy)
  } finally {
    copy.close()
  }
}

/**
 * Puts the `not-exported` derived state (`rebuilt`) back to its initial state; the app rebuilds it
 * as it does for a new install (search index backfill, image holders, reminder checker).
 */
export function resetRebuilt(db: Database.Database): void {
  // Table order matters for the search index: removing sources removes their documents and text index rows.
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = ? AND type = 'table'")
  for (const table of tablesIn('not-exported', 'rebuilt')) {
    // The text index is absent where SQLite could not create it.
    if (exists.get(table) === undefined) continue
    db.exec(INITIAL_STATE[table] ?? `DELETE FROM "${table}"`)
  }
  // Rows ordered by the content clock (ordinary cache with `last_used`): with it back at 0 they restart from 0.
  for (const table of tablesIn('not-exported', 'cache')) {
    if (columnsOf(db, table).includes('last_used')) db.exec(`UPDATE "${table}" SET last_used = 0`)
  }
}

/** Upper bound of the 饼干凭据 ID sequence: what AUTOINCREMENT has handed out, or the highest ID. */
export function readCredentialSequence(db: Database.Database): number {
  const sequence = db.prepare<[], { seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'credentials'").get()?.seq ?? 0
  return Math.max(Number(sequence), count(db, 'SELECT coalesce(max(id), 0) AS n FROM credentials'))
}

/**
 * Throws when the carried secret tables of `db` are beyond `SECRET_LIMITS` or hold a value that is
 * not a BLOB. Only counts, types and lengths are read: no value is loaded.
 */
export function checkSecretSizes(db: Database.Database): void {
  let rows = 0
  let total = 0
  for (const table of CARRIED_SECRET_TABLES) {
    // typeof() and length() of a BLOB column read the record header, not the value.
    const size = db.prepare<[], { rows: number; other: number }>(`SELECT count(*) AS rows,
      count(*) FILTER (WHERE typeof(ciphertext) <> 'blob') AS other FROM "${table}"`).get()!
    if (size.other > 0) throw new Error('secret value of another type')
    const lengths = db.prepare<[], { largest: number; total: number }>(`SELECT coalesce(max(length(ciphertext)), 0) AS largest,
      coalesce(sum(length(ciphertext)), 0) AS total FROM "${table}"`).get()!
    rows += size.rows
    total += lengths.total
    if (lengths.largest > SECRET_LIMITS.maxValueBytes) throw new Error('secret value too large')
  }
  if (rows > SECRET_LIMITS.maxRows || total > SECRET_LIMITS.maxTotalBytes) throw new Error('secret values too large')
}

/** Reads every secret row of the database at `databasePath` (read-only); throws beyond `SECRET_LIMITS`. */
export function readSecretRows(databasePath: string): SecretRows {
  const db = openReadOnly(databasePath)
  try {
    return db.transaction(() => {
      checkSecretSizes(db)
      return {
        credentials: db.prepare<[], { id: number; value: Uint8Array }>('SELECT id, ciphertext AS value FROM credentials ORDER BY id').all(),
        appCredentials: db.prepare<[], { id: string; value: Uint8Array }>('SELECT id, ciphertext AS value FROM subscription_app_credentials ORDER BY id').all()
      }
    })()
  } finally {
    db.close()
  }
}

/**
 * Replaces the ciphertext of every secret row with `rows` (one for each row, by key) and empties
 * the other `secret` tables. Throws when `rows` and the tables do not match one to one.
 */
export function replaceSecretValues(db: Database.Database, rows: SecretRows): void {
  for (const table of tablesIn('secret')) {
    if (!CARRIED_SECRET_TABLES.includes(table)) db.exec(`DELETE FROM "${table}"`)
  }
  const credential = db.prepare('UPDATE credentials SET ciphertext = ? WHERE id = ?')
  for (const row of rows.credentials) {
    if (credential.run(Buffer.from(row.value), row.id).changes !== 1) throw new Error('secret rows do not match')
  }
  const appCredential = db.prepare('UPDATE subscription_app_credentials SET ciphertext = ? WHERE id = ?')
  for (const row of rows.appCredentials) {
    if (appCredential.run(Buffer.from(row.value), row.id).changes !== 1) throw new Error('secret rows do not match')
  }
  if (count(db, 'SELECT count(*) AS n FROM credentials') !== new Set(rows.credentials.map((row) => row.id)).size
    || count(db, 'SELECT count(*) AS n FROM subscription_app_credentials') !== new Set(rows.appCredentials.map((row) => row.id)).size) {
    throw new Error('secret rows do not match')
  }
}

function removeUnexported(db: Database.Database, secrets: SecretRows | null): void {
  for (const table of tablesIn('target-kept')) db.exec(`DELETE FROM "${table}"`)
  if (secrets === null) for (const table of tablesIn('secret')) db.exec(`DELETE FROM "${table}"`)
  else replaceSecretValues(db, secrets)
  const remove = db.prepare('DELETE FROM settings WHERE key = ?')
  for (const { key } of db.prepare<[], { key: string }>('SELECT key FROM settings').all()) {
    if (settingClass(key) !== 'overwrite') remove.run(key)
  }
}

/** Records 图片未保存 for the image of `postId` in the offline copy of `threadId` (none: nothing). */
export function recordUnsavedImage(db: Database.Database, threadId: string, postId: string): void {
  const row = db.prepare<[string], { image_failures_json: string }>('SELECT image_failures_json FROM offline_copies WHERE thread_id = ?').get(threadId)
  if (row === undefined) return
  const list = (JSON.parse(row.image_failures_json) as OfflineCopy['imageFailures']).filter((item) => item.postId !== postId)
  list.push({ postId, error: { reason: 'not-stored' } })
  db.prepare('UPDATE offline_copies SET image_failures_json = ? WHERE thread_id = ?').run(JSON.stringify(list), threadId)
}

function recordUnsavedOriginals(db: Database.Database, resourceIds: readonly number[]): void {
  const holders = db.prepare<[number], { thread_id: string; post_id: string }>('SELECT thread_id, post_id FROM offline_images WHERE resource_id = ?')
  for (const resourceId of resourceIds) {
    for (const { thread_id: threadId, post_id: postId } of holders.all(resourceId)) recordUnsavedImage(db, threadId, postId)
    db.prepare('DELETE FROM offline_images WHERE resource_id = ?').run(resourceId)
  }
}

function dropDraftImages(db: Database.Database, attachmentIds: readonly number[]): void {
  for (const id of attachmentIds) {
    db.prepare('UPDATE drafts SET attachment_id = NULL WHERE attachment_id = ?').run(id)
    db.prepare('UPDATE publication_attempts SET attachment_id = NULL WHERE attachment_id = ?').run(id)
    db.prepare('DELETE FROM draft_attachments WHERE id = ?').run(id)
  }
}

/**
 * Trims the snapshot at `workPath` for export (see the top of this file), compacts it so nothing
 * removed is left in free pages, and checks it: foreign keys and SQLite's integrity check. Throws
 * when the trimmed copy does not pass.
 */
export function trimExportSnapshot(workPath: string, options: TrimOptions): TrimResult {
  const db = new Database(workPath, { fileMustExist: true })
  try {
    db.pragma('foreign_keys = ON')
    const schemaVersion = Number(db.pragma('user_version', { simple: true }))
    const credentialSequence = db.transaction(() => {
      resetRebuilt(db)
      const sequence = readCredentialSequence(db)
      removeUnexported(db, options.secrets)
      if (options.includeOffline) recordUnsavedOriginals(db, options.missingOfflineImages)
      else for (const table of referencingFirst(db, tablesIn('target-appended', 'offline-copies'))) db.exec(`DELETE FROM "${table}"`)
      dropDraftImages(db, options.missingDraftImages)
      return sequence
    }).immediate()

    const content = new RetainedContentDatabase(
      () => db,
      () => { throw new Error('not used for trimming') },
      () => { throw new Error('not used for trimming') }
    )
    while (content.evictContentBatch(true).more) { /* bounded batches until no candidate is left */ }

    if ((db.pragma('foreign_key_check') as unknown[]).length > 0) throw new Error('trimmed snapshot has dangling references')
    db.exec('VACUUM')
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('trimmed snapshot failed integrity check')
    return {
      schemaVersion,
      credentialSequence,
      stats: {
        history: count(db, 'SELECT count(*) AS n FROM thread_visits'),
        sendRecords: count(db, 'SELECT count(*) AS n FROM publication_attempts'),
        offlineThreads: count(db, 'SELECT count(*) AS n FROM offline_copies')
      },
      ...listFiles(db)
    }
  } finally {
    db.close()
  }
}
