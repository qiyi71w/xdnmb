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
 * - `target-kept` tables and setting rows, and `secret` tables, are emptied (the credential ID
 *   sequence stays in `sqlite_sequence` and is reported for the manifest).
 * - Without offline copies, the offline copies and the relations protecting their content are
 *   removed first, so what only they protected is trimmed with the rest of the cache.
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
}

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

/** Rows ordered by the content clock: with the clock back at 0 they restart from 0. */
const CLOCKED_TABLES = ['posts', 'thread_pages', 'feed_pages', 'directory_snapshot', 'image_resources']

/** The offline copy tables, in an order their foreign keys allow deleting. */
const OFFLINE_TABLES = ['offline_images', 'offline_page_posts', 'offline_pages', 'offline_copies']

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
  for (const table of CLOCKED_TABLES) db.exec(`UPDATE "${table}" SET last_used = 0`)
}

/** Upper bound of the 饼干凭据 ID sequence: what AUTOINCREMENT has handed out, or the highest ID. */
export function readCredentialSequence(db: Database.Database): number {
  const sequence = db.prepare<[], { seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'credentials'").get()?.seq ?? 0
  return Math.max(Number(sequence), count(db, 'SELECT coalesce(max(id), 0) AS n FROM credentials'))
}

function removeUnexported(db: Database.Database): void {
  for (const table of [...tablesIn('target-kept'), ...tablesIn('secret')]) db.exec(`DELETE FROM "${table}"`)
  const remove = db.prepare('DELETE FROM settings WHERE key = ?')
  for (const { key } of db.prepare<[], { key: string }>('SELECT key FROM settings').all()) {
    if (settingClass(key) !== 'overwrite') remove.run(key)
  }
}

function recordUnsavedOriginals(db: Database.Database, resourceIds: readonly number[]): void {
  const holders = db.prepare<[number], { thread_id: string; post_id: string }>('SELECT thread_id, post_id FROM offline_images WHERE resource_id = ?')
  const failures = db.prepare<[string], { image_failures_json: string }>('SELECT image_failures_json FROM offline_copies WHERE thread_id = ?')
  const update = db.prepare('UPDATE offline_copies SET image_failures_json = ? WHERE thread_id = ?')
  for (const resourceId of resourceIds) {
    for (const { thread_id: threadId, post_id: postId } of holders.all(resourceId)) {
      const row = failures.get(threadId)
      if (row === undefined) continue
      const list = (JSON.parse(row.image_failures_json) as OfflineCopy['imageFailures']).filter((item) => item.postId !== postId)
      list.push({ postId, error: { reason: 'not-stored' } })
      update.run(JSON.stringify(list), threadId)
    }
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
      removeUnexported(db)
      if (options.includeOffline) recordUnsavedOriginals(db, options.missingOfflineImages)
      else for (const table of OFFLINE_TABLES) db.exec(`DELETE FROM "${table}"`)
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
