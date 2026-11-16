import Database from 'better-sqlite3'
import { randomBytes, randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { isManagedName } from '../images/files'
import { APPENDED_PARTS, settingKeysIn, tablesIn, type AppendedPart } from './classification'
import { migrateDatabase } from './database'
import { copyFileDurably, present, syncDirectory } from './durable'
import {
  checkSecretSizes, columnsOf, readCredentialSequence, readExportEstimate, recordUnsavedImage, referencingFirst, replaceSecretValues,
  resetRebuilt, type SecretRows
} from './export-snapshot'
import { DRAFT_IMAGES, IMAGES, STAGED_DATABASE } from './import-journal'
import { MIGRATIONS } from './migrations'

/*
 * The database part of 导入个人数据 (see docs/development.md), run on a worker thread in the app.
 * The export file's content is extracted into the import staging directory (`./import-journal`)
 * and only ever changed there; this machine's database is only read.
 *
 * Checking (before the confirmation): the staged database is the file's own schema version and
 * every schema object in it (type, name, table and SQL) is exactly what a new install has at that
 * version, compared before SQLite runs anything of the file's (integrity check, migrations and every
 * query could run a CHECK, trigger, view, default or generated column it defines); then it passes
 * SQLite's integrity check, takes this version's migration chain (an older file is migrated here,
 * in staging), then has exactly this version's schema objects, no dangling reference, secret
 * values within `SECRET_LIMITS`, and every draft attachment and offline original it names among
 * the extracted files with its recorded size. Staging has the user data directory's layout.
 *
 * Merging (after the confirmation), on the checked database, with this machine's database read in
 * one read transaction; the steps (`MERGE_STEPS`) follow the 数据归类 in `./classification`:
 *
 *   1. The file's database is the base (already at this version's schema, see above).
 *   2. 目标机保留: this machine's `target-kept` tables and setting rows replace the file's.
 *   3. 秘密: a file without secrets keeps none (anything in its secret tables goes, so none of its
 *      references finds a credential). A file with secrets keeps its 饼干凭据 under their IDs and
 *      its App UUIDs under their local IDs, their ciphertext replaced by this machine's protector's
 *      (`ImportSecrets`, re-encrypted in the main process). This machine's 饼干凭据 are appended
 *      with new IDs after both the file's credential sequence and every ID in the staged
 *      database, so no reference in the file ever resolves to them, and the ID sequence moves past
 *      them (`CredentialIdMap`); one identical to a file credential is not appended but maps to
 *      the file's ID, so its references land on the file's copy. Its App UUIDs are appended, except
 *      one identical to a file App UUID (one whose local ID the file already uses gets a new one:
 *      nothing in the result refers to it). A subscription configuration whose App UUID is now
 *      missing is 未配置 under a new generation; earlier generations' observations, operations and
 *      plans stay history and are never carried on.
 *   4. 目标机保留并追加, one merge for each part (`APPENDED_MERGES`), the tables of a part being
 *      those the classification puts in it:
 *      离线副本: this machine's offline copies are appended. A thread both have keeps the copy
 *      updated later (the file's on a tie) as a whole: its rows in every offline copy table, its
 *      posts and originals. Originals no copy holds any more go with their staged files. This
 *      machine's originals are copied into staging under new image record IDs (a free managed name
 *      when theirs is taken); an original the file already has for the same address is shared. One
 *      whose file is gone from this machine is 图片未保存 in its copy, as an export records it.
 *      草稿: this machine's drafts and their attachments are appended under new IDs, attachments
 *      copied into staging (a free managed name when theirs is taken; one whose file is gone leaves
 *      its draft without it). Their 饼干 references go through `CredentialIdMap`, so they keep this
 *      machine's cookies; a reference to a cookie already removed here stays 已移除 (an ID no
 *      credential has or will get). The file's drafts are as they were.
 *   5. 不导出 derived state goes back to its initial state; the app rebuilds it at the next start.
 *   6. The result passes the foreign key and integrity checks, and every draft attachment and
 *      offline original it names is in staging with its recorded size.
 *
 * Nothing secret is decrypted here: this machine's ciphertext is carried as it is.
 */

/**
 * A file's secrets made this machine's (in the main process, which alone decrypts): the file's
 * re-encrypted by this machine's protector, and this machine's that are identical to one of them.
 */
export interface ImportSecrets {
  /** Every file 饼干凭据 and App UUID by its ID, with this machine's ciphertext of its secret. */
  file: SecretRows
  /** This machine's 饼干凭据 identical to a file one: its ID and stored ciphertext, and the file's ID. */
  sameCredentials: { localId: number; ciphertext: Uint8Array; fileId: number }[]
  /** This machine's App UUIDs identical to a file one: local ID and stored ciphertext. */
  sameAppCredentials: { localId: string; ciphertext: Uint8Array }[]
}

/** What the export file says about itself that merging needs. */
export interface ImportFileFacts {
  /** Upper bound of the file's 饼干凭据 ID sequence (its manifest's). */
  credentialSequence: number
  /** The file's 饼干凭据 and App UUIDs made this machine's; null: the file carries none. */
  secrets: ImportSecrets | null
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
  /** Draft attachments and offline originals: this machine's directories (read) and staging's. */
  files: { local: ImageDirectories; staged: ImageDirectories }
  /** Staged files the result no longer names, removed once it is in place in staging. */
  unnamed: string[]
}

interface ImageDirectories {
  draftImages: string
  images: string
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

/** Every schema object as SQLite keeps it: type, name, table and the SQL that defines it. */
function schemaOf(db: Database.Database): string {
  const objects = db.prepare<[], { type: string; name: string; tbl_name: string; sql: string | null }>(
    'SELECT type, name, tbl_name, sql FROM sqlite_master'
  ).all()
  return JSON.stringify(objects.map((object) => [object.type, object.name, object.tbl_name, object.sql]).sort())
}

const newInstallSchemas = new Map<number, string | null>()

/**
 * The schema objects a new install has at `version` (this version's migrations up to it), which an
 * install upgraded from any earlier version has too; null when no migration reaches exactly it.
 */
function newInstallSchema(version: number): string | null {
  let schema = newInstallSchemas.get(version)
  if (schema === undefined) {
    const fresh = new Database(':memory:')
    try {
      const reached = migrateDatabase(fresh, MIGRATIONS.filter((migration) => migration.version <= version))
      schema = reached === version ? schemaOf(fresh) : null
    } finally {
      fresh.close()
    }
    newInstallSchemas.set(version, schema)
  }
  return schema
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

/** Every draft attachment and offline original the staged database names is in staging. */
function stagedFilesComplete(db: Database.Database, stagingDirectory: string): boolean {
  return filesComplete(db, join(stagingDirectory, DRAFT_IMAGES), 'SELECT file_name AS name, bytes FROM draft_attachments')
    && filesComplete(db, join(stagingDirectory, IMAGES), `SELECT r.file_name AS name, r.bytes FROM image_resources r
      WHERE EXISTS(SELECT 1 FROM offline_images o WHERE o.resource_id = r.id)`)
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
    // Before anything that could run SQL of the file's own (see the top of this file).
    if (schemaOf(db) !== newInstallSchema(schemaVersion)) throw new ImportCheckError('unexpected schema')
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new ImportCheckError('integrity check failed')
    const version = migrateDatabase(db, MIGRATIONS)
    if (schemaOf(db) !== newInstallSchema(version)) throw new ImportCheckError('unexpected schema after migration')
    if (!verified(db)) throw new ImportCheckError('migrated database failed verification')
    checkSecretSizes(db)
    if (!stagedFilesComplete(db, stagingDirectory)) throw new ImportCheckError('files missing')
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

/** Bytes this machine's 目标机保留并追加 data adds to staging at most: its draft attachments and offline copies. */
export function readLocalAppendedBytes(databasePath: string): number {
  const { offlineBytes, draftImageBytes } = readExportEstimate(databasePath)
  return offlineBytes + draftImageBytes
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
 * Step 3, the file's secrets: kept, re-encrypted for this machine, when it carries them; otherwise
 * anything in its secret tables is dropped, so that none of its references finds a credential.
 */
function protectFileSecrets(context: MergeContext): void {
  if (context.file.secrets === null) {
    for (const table of tablesIn('secret')) context.staged.exec(`DELETE FROM "${table}"`)
  } else replaceSecretValues(context.staged, context.file.secrets.file)
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b))
}

/**
 * Step 3, this machine's 饼干凭据: appended in their order, after the file's in the list, with IDs
 * after the file's credential sequence and every staged ID, recorded in `credentialIds`; the ID
 * sequence moves past them. One identical to a file credential (unchanged since the main process
 * compared it) is not appended: `credentialIds` maps it to the file's ID.
 */
function appendLocalCredentials(context: MergeContext): void {
  const { staged, local, credentialIds } = context
  const same = new Map((context.file.secrets?.sameCredentials ?? []).map((entry) => [entry.localId, entry]))
  const columns = columnsOf(staged, 'credentials').filter((column) => column !== 'id')
  const list = columns.map((column) => `"${column}"`).join(', ')
  const insert = staged.prepare(`INSERT INTO credentials (id, ${list}) VALUES (?, ${columns.map(() => '?').join(', ')})`)
  const positionAt = columns.indexOf('position')
  let position = count(staged, 'SELECT coalesce(max(position), 0) AS n FROM credentials')
  let next = Math.max(context.file.credentialSequence, readCredentialSequence(staged))
  const rows = local.prepare(`SELECT id, ciphertext, ${list} FROM credentials ORDER BY position, id`).raw().iterate() as Iterable<[number, Uint8Array, ...unknown[]]>
  for (const [id, ciphertext, ...values] of rows) {
    const twin = same.get(id)
    if (twin !== undefined && sameBytes(twin.ciphertext, ciphertext)) {
      credentialIds.set(id, twin.fileId)
      continue
    }
    next++
    values[positionAt] = ++position
    insert.run(next, ...values)
    credentialIds.set(id, next)
  }
  if (staged.prepare("UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = 'credentials'").run(next).changes === 0) {
    staged.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('credentials', ?)").run(next)
  }
}

/**
 * Step 3, this machine's App UUIDs (local IDs are random UUIDs): appended, except one identical to
 * a file App UUID. One whose local ID the file already uses gets a new one; nothing refers to it.
 */
function appendLocalAppCredentials(context: MergeContext): void {
  const { staged, local } = context
  const same = new Map((context.file.secrets?.sameAppCredentials ?? []).map((entry) => [entry.localId, entry.ciphertext]))
  const taken = staged.prepare('SELECT 1 FROM subscription_app_credentials WHERE id = ?')
  const insert = staged.prepare('INSERT INTO subscription_app_credentials (id, ciphertext) VALUES (?, ?)')
  const rows = local.prepare<[], { id: string; ciphertext: Uint8Array }>('SELECT id, ciphertext FROM subscription_app_credentials ORDER BY id').all()
  for (const { id, ciphertext } of rows) {
    const twin = same.get(id)
    if (twin !== undefined && sameBytes(twin, ciphertext)) continue
    insert.run(taken.get(id) === undefined ? id : randomUUID(), ciphertext)
  }
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

function quoted(columns: string[]): string {
  return columns.map((column) => `"${column}"`).join(', ')
}

function marks(columns: unknown[]): string {
  return columns.map(() => '?').join(', ')
}

/** The highest ID `table` (AUTOINCREMENT) has handed out or holds. */
function sequenceOf(db: Database.Database, table: string): number {
  const sequence = db.prepare<[string], { seq: number }>('SELECT seq FROM sqlite_sequence WHERE name = ?').get(table)?.seq ?? 0
  return Math.max(Number(sequence), count(db, `SELECT coalesce(max(id), 0) AS n FROM "${table}"`))
}

/** Moves `table`'s ID sequence to at least `value`, so AUTOINCREMENT never hands out an ID up to it. */
function advanceSequence(db: Database.Database, table: string, value: number): void {
  if (db.prepare('UPDATE sqlite_sequence SET seq = max(seq, ?) WHERE name = ?').run(value, table).changes === 0) {
    db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)').run(table, value)
  }
}

/**
 * A managed name for a copy of `name` in the staging `directory`: `name` itself unless a file there
 * or a row of `table` has it, otherwise a new one with its extension.
 */
function freeName(db: Database.Database, table: string, directory: string, name: string): string {
  const taken = db.prepare(`SELECT 1 FROM "${table}" WHERE file_name = ?`)
  let candidate = name
  while (taken.get(candidate) !== undefined || present(join(directory, candidate))) candidate = `${randomBytes(16).toString('hex')}${extname(name)}`
  return candidate
}

interface ResourceRow {
  id: number
  kind: string
  source_url: string
  file_name: string
  bytes: number
  [column: string]: unknown
}

/** Step 4, 离线副本: one of this machine's offline copies the staged database does not have (any more). */
function appendLocalOfflineCopy(context: MergeContext, threadId: string): void {
  const { staged, local, files } = context
  // Its posts, as this machine has them; their search-derived size starts afresh with the index.
  const postColumns = columnsOf(staged, 'posts')
  const derived = postColumns.indexOf('derived_bytes')
  const upsertPost = staged.prepare(`INSERT INTO posts (${quoted(postColumns)}) VALUES (${marks(postColumns)})
    ON CONFLICT(id) DO UPDATE SET ${postColumns.filter((column) => column !== 'id').map((column) => `"${column}" = excluded."${column}"`).join(', ')}`)
  const posts = local.prepare(`SELECT ${quoted(postColumns)} FROM posts WHERE id IN (SELECT head_id FROM offline_pages WHERE thread_id = @thread
    UNION SELECT post_id FROM offline_page_posts WHERE thread_id = @thread UNION SELECT post_id FROM offline_images WHERE thread_id = @thread)`)
  for (const row of posts.raw().iterate({ thread: threadId }) as Iterable<unknown[]>) {
    row[derived] = 0
    upsertPost.run(row)
  }
  // Its rows in every offline copy table, parents first; its originals' with their image records below.
  for (const table of referencingFirst(staged, tablesIn('target-appended', 'offline-copies')).reverse()) {
    if (table !== 'offline_images') copyLocalRows(context, table, 'WHERE thread_id = ?', [threadId])
  }

  const resourceColumns = columnsOf(staged, 'image_resources').filter((column) => column !== 'id')
  const insertResource = staged.prepare(`INSERT INTO image_resources (${quoted(resourceColumns)}) VALUES (${marks(resourceColumns)})`)
  const sameSource = staged.prepare<[string, string], { id: number }>('SELECT id FROM image_resources WHERE kind = ? AND source_url = ?')
  const resourceIds = new Map<number, number>()
  const resources = local.prepare<[string], ResourceRow>(`SELECT id, ${quoted(resourceColumns)} FROM image_resources
    WHERE id IN (SELECT resource_id FROM offline_images WHERE thread_id = ?) ORDER BY id`).all(threadId)
  for (const resource of resources) {
    const shared = sameSource.get(resource.kind, resource.source_url)
    if (shared !== undefined) {
      resourceIds.set(resource.id, shared.id)
      continue
    }
    // Gone from this machine (or not the size its row records): 图片未保存 below.
    if (!isManagedName(resource.file_name) || sizeOf(join(files.local.images, resource.file_name)) !== resource.bytes) continue
    const name = freeName(staged, 'image_resources', files.staged.images, resource.file_name)
    copyFileDurably(join(files.local.images, resource.file_name), join(files.staged.images, name))
    const values = resourceColumns.map((column) => (column === 'file_name' ? name : resource[column]))
    resourceIds.set(resource.id, Number(insertResource.run(values).lastInsertRowid))
  }

  const insertImage = staged.prepare('INSERT INTO offline_images (thread_id, post_id, resource_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
  const images = local.prepare<[string], { post_id: string; resource_id: number }>('SELECT post_id, resource_id FROM offline_images WHERE thread_id = ?').all(threadId)
  for (const image of images) {
    const id = resourceIds.get(image.resource_id)
    if (id === undefined) recordUnsavedImage(staged, threadId, image.post_id)
    else insertImage.run(threadId, image.post_id, id)
  }
}

/** Step 4, 离线副本 (see the top of this file). */
function retainLocalOfflineCopies(context: MergeContext): void {
  const { staged, local } = context
  const stagedCopy = staged.prepare<[string], { updated_at: string }>('SELECT updated_at FROM offline_copies WHERE thread_id = ?')
  const later = staged.prepare<[string, string], { later: number | null }>('SELECT julianday(?) > julianday(?) AS later')
  const kept: string[] = []
  for (const copy of local.prepare<[], { thread_id: string; updated_at: string }>('SELECT thread_id, updated_at FROM offline_copies ORDER BY thread_id').all()) {
    const theirs = stagedCopy.get(copy.thread_id)
    if (theirs !== undefined) {
      if (later.get(copy.updated_at, theirs.updated_at)?.later !== 1) continue
      for (const table of referencingFirst(staged, tablesIn('target-appended', 'offline-copies'))) {
        staged.prepare(`DELETE FROM "${table}" WHERE thread_id = ?`).run(copy.thread_id)
      }
    }
    kept.push(copy.thread_id)
  }
  // Originals no copy holds any more (those of a copy replaced above) go, with their staged files.
  const unheld = staged.prepare<[], string>(`DELETE FROM image_resources
    WHERE NOT EXISTS(SELECT 1 FROM offline_images o WHERE o.resource_id = image_resources.id) RETURNING file_name`).pluck().all()
  for (const name of unheld) if (isManagedName(name)) context.unnamed.push(join(context.files.staged.images, name))
  for (const threadId of kept) appendLocalOfflineCopy(context, threadId)
}

interface AttachmentRow {
  id: number
  file_name: string
  bytes: number
  [column: string]: unknown
}

/** Step 4, 草稿 (see the top of this file). */
function retainLocalDrafts(context: MergeContext): void {
  const { staged, local, files, credentialIds } = context
  const attachmentColumns = columnsOf(staged, 'draft_attachments').filter((column) => column !== 'id')
  const insertAttachment = staged.prepare(`INSERT INTO draft_attachments (id, ${quoted(attachmentColumns)}) VALUES (?, ${marks(attachmentColumns)})`)
  const attachmentIds = new Map<number, number>()
  let attachmentId = sequenceOf(staged, 'draft_attachments')
  const attachments = local.prepare<[], AttachmentRow>(`SELECT id, ${quoted(attachmentColumns)} FROM draft_attachments
    WHERE id IN (SELECT attachment_id FROM drafts) ORDER BY id`).all()
  for (const attachment of attachments) {
    // Gone from this machine: its draft keeps no attachment.
    if (!isManagedName(attachment.file_name) || sizeOf(join(files.local.draftImages, attachment.file_name)) !== attachment.bytes) continue
    const name = freeName(staged, 'draft_attachments', files.staged.draftImages, attachment.file_name)
    copyFileDurably(join(files.local.draftImages, attachment.file_name), join(files.staged.draftImages, name))
    insertAttachment.run(++attachmentId, ...attachmentColumns.map((column) => (column === 'file_name' ? name : attachment[column])))
    attachmentIds.set(attachment.id, attachmentId)
  }
  advanceSequence(staged, 'draft_attachments', attachmentId)

  let removedCredential: number | null = null
  const credentialOf = (id: number | null): number | null => {
    if (id === null) return null
    const mapped = credentialIds.get(id)
    if (mapped !== undefined) return mapped
    if (removedCredential === null) {
      removedCredential = readCredentialSequence(staged) + 1
      advanceSequence(staged, 'credentials', removedCredential)
    }
    return removedCredential
  }
  const draftColumns = columnsOf(staged, 'drafts').filter((column) => column !== 'id')
  const insertDraft = staged.prepare(`INSERT INTO drafts (id, ${quoted(draftColumns)}) VALUES (?, ${marks(draftColumns)})`)
  let draftId = sequenceOf(staged, 'drafts')
  for (const draft of local.prepare<[], Record<string, unknown>>(`SELECT ${quoted(draftColumns)} FROM drafts ORDER BY id`).all()) {
    insertDraft.run(++draftId, ...draftColumns.map((column) => {
      if (column === 'credential_id') return credentialOf(draft.credential_id as number | null)
      if (column === 'attachment_id') return draft.attachment_id === null ? null : attachmentIds.get(draft.attachment_id as number) ?? null
      return draft[column]
    }))
  }
  advanceSequence(staged, 'drafts', draftId)
}

/** Step 5: 不导出 derived state starts afresh. */
function resetDerivedState(context: MergeContext): void {
  resetRebuilt(context.staged)
}

/** Step 4: the merge of each `target-appended` part, covering the tables the classification puts in it. */
const APPENDED_MERGES: { readonly [P in AppendedPart]: (context: MergeContext) => void } = {
  'offline-copies': retainLocalOfflineCopies,
  drafts: retainLocalDrafts
}

/** The merge, in order (see the top of this file); every step runs in one transaction. */
const MERGE_STEPS: readonly ((context: MergeContext) => void)[] = [
  keepTargetItems,
  protectFileSecrets,
  appendLocalCredentials,
  appendLocalAppCredentials,
  settleSubscriptionConfiguration,
  ...APPENDED_PARTS.map((part) => APPENDED_MERGES[part]),
  resetDerivedState
]

/**
 * Builds the import result in staging from the checked file database and this machine's database
 * at `localDatabasePath` (only read), with its draft attachments and offline originals copied from
 * beside it. Throws when a step fails or the result does not pass its checks; the staging is then
 * the caller's to remove.
 */
export function stageImport(stagingDirectory: string, localDatabasePath: string, file: ImportFileFacts): { credentialIds: CredentialIdMap } {
  const staged = openStaged(stagingDirectory)
  let local: Database.Database | null = null
  try {
    const supported = MIGRATIONS.reduce((highest, migration) => Math.max(highest, migration.version), 0)
    if (Number(staged.pragma('user_version', { simple: true })) !== supported) throw new Error('staged database not checked')
    local = new Database(localDatabasePath, { readonly: true, fileMustExist: true, timeout: 5000 })
    const userData = dirname(localDatabasePath)
    const files = {
      local: { draftImages: join(userData, DRAFT_IMAGES), images: join(userData, IMAGES) },
      staged: { draftImages: join(stagingDirectory, DRAFT_IMAGES), images: join(stagingDirectory, IMAGES) }
    }
    mkdirSync(files.staged.draftImages, { recursive: true })
    mkdirSync(files.staged.images, { recursive: true })
    const context: MergeContext = { staged, local, file, credentialIds: new Map(), files, unnamed: [] }
    // One read transaction: this machine's rows are from one moment.
    local.transaction(() => {
      staged.transaction(() => {
        for (const step of MERGE_STEPS) step(context)
      }).immediate()
    })()
    if (!verified(staged) || !stagedFilesComplete(staged, stagingDirectory)) throw new Error('staged import failed verification')
    for (const path of context.unnamed) rmSync(path, { force: true })
    syncDirectory(files.staged.draftImages)
    syncDirectory(files.staged.images)
    return { credentialIds: context.credentialIds }
  } finally {
    local?.close()
    staged.close()
  }
}
