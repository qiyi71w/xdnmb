import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { build as viteBuild } from 'vite'
import { createWorkerImportDatabase } from '../src/main/personal-data/worker-database'
import { createLifecycle } from '../src/main/lifecycle/controller'
import { settleQuitSends } from '../src/renderer/src/features/lifecycle/quitSends'
import type { Editor } from '../src/renderer/src/features/editor/editorsState'
import { tmpdir } from 'node:os'
import { open } from 'node:fs/promises'
import { join, relative } from 'node:path'
import Database from 'better-sqlite3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { ExportProgress, ImportInspection } from '../src/shared/api'
import type { Post, ThreadPage } from '../src/shared/forum'
import type { QuitEnd } from '../src/main/lifecycle/controller'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { MIGRATIONS } from '../src/main/storage/migrations'
import { readExportEstimate, readSecretRows, takeExportSnapshot, trimExportSnapshot } from '../src/main/storage/export-snapshot'
import { testProtector } from './helpers/protector'
import { checkStagedImport, readLocalCounts, stageImport } from '../src/main/storage/import-staging'
import { beforeImportDirectory, importStagingDirectory } from '../src/main/storage/import-journal'
import { beginSwap, settleSwap } from '../src/main/storage/swap-journal'
import { preUpgradeBackupDirectory } from '../src/main/storage/backup'
import { createExportService } from '../src/main/personal-data/service'
import { createImportService, type ImportDatabase } from '../src/main/personal-data/import'
import { CONTAINER_MAGIC, CONTAINER_VERSION, DATABASE_NAME, ENTRY_TYPE, readContainer, writeContainer, type ExportManifest } from '../src/main/personal-data/container'
import { newEncryption } from '../src/main/personal-data/encryption'
import type { SecretProtector } from '../src/main/identity/protection'

const AT = '2026-11-16T08:00:00.000Z'
const EARLIER = '2026-11-15T08:00:00.000Z'
const LATER = '2026-11-17T08:00:00.000Z'
const SUPPORTED = Math.max(...MIGRATIONS.map((migration) => migration.version))
const A_DRAFT_IMAGE = `${'d'.repeat(32)}.png`
const A_ORIGINAL = `${'a'.repeat(32)}.jpg`
const A_ORIGINAL_510 = `${'b'.repeat(32)}.jpg`
const B_DRAFT_IMAGE = `${'e'.repeat(32)}.png`
const B_ORIGINAL_500 = `${'c'.repeat(32)}.jpg`
const B_ORIGINAL_510 = `${'1'.repeat(32)}.jpg`
const B_SESSION = 'B-SESSION-CIPHERTEXT'
const B_ANALYTICS = 'B-ANALYTICS-INSTANCE'

const folders: string[] = []
const connections: Array<{ close(): void }> = []

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function folder(prefix: string, keep: string[] = folders): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  keep.push(path)
  return path
}

function post(id: string, text: string, image: string | null = null): Post {
  return { id, forumId: '4', createdAt: null, userHash: null, name: null, title: null, isAdmin: null, isSage: null,
    content: [{ type: 'text', text }], plainText: text, image: image === null ? null : { path: `2026-11-16/${image}`, ext: '.jpg' } }
}

function page(threadId: string, head: Post, replies: Post[]): ThreadPage {
  return { threadId, mode: 'all', page: 1, head, replies, replyCount: replies.length, skippedItems: 0, endCandidate: true }
}

function raw(path: string): Database.Database {
  const db = new Database(path)
  connections.push(db)
  return db
}

/** An offline copy of `threadId` saved at `at`: a page with `reply` and the original of its image, kept as `fileName`. */
function offlineCopy(db: ReadingDatabase, userData: string, threadId: string, at: string, reply: Post, fileName: string, bytes: string): void {
  db.beginOfflineCopy(threadId, true, at)
  db.saveOfflinePage(page(threadId, post(threadId, `${threadId} head`), [reply]), at)
  writeFileSync(join(userData, 'images', fileName), bytes)
  db.commitImageResource({ kind: 'original', sourceUrl: `https://image.nmb.best/image/${reply.image!.path}${reply.image!.ext}`,
    fileName, bytes: Buffer.byteLength(bytes), format: 'jpeg', width: 1, height: 1, fetchedAt: at }, [])
  db.holdOfflineImage(threadId, reply.id)
  db.updateOfflineCopy(threadId, { state: 'stopped', failedPage: null, error: null, imageFailures: [] }, at)
}

function attempt(db: Database.Database, requestId: string, credentialId: number): void {
  db.prepare(`INSERT INTO publication_attempts (request_id, editor_id, payload_json, credential_id, forum_id, state, created_at, updated_at)
    VALUES (?, 'editor', '{}', ?, '4', 'failed', ?, ?)`).run(requestId, credentialId, AT, AT)
}

/**
 * The source machine A: history, a draft with an attachment using cookie 1 (cookie 2 was removed, so
 * the sequence is at 2), offline copies with originals (500 and 510, both saved at `AT`), roles and a
 * thread's cookie choice, a send record, an App UUID, a reminder rule, settings and a workspace.
 */
function sourceMachine(keep: string[]): { userData: string; generation: number } {
  const userData = folder('xidao-import-a-', keep)
  mkdirSync(join(userData, 'images'))
  mkdirSync(join(userData, 'draft-images'))
  const db = openReadingDatabase(join(userData, 'xidao.sqlite'), MIGRATIONS, { appVersion: '1.5.0-a' })
  try {
    db.saveThreadPage(page('100', post('100', 'A visited head'), []), AT)
    db.recordVisit('100', AT)
    db.beginOfflineCopy('500', true, AT)
    db.saveOfflinePage(page('500', post('500', 'A offline head'), [post('501', 'A offline reply', 'kept')]), AT)
    writeFileSync(join(userData, 'images', A_ORIGINAL), 'A original bytes')
    db.commitImageResource({ kind: 'original', sourceUrl: 'https://image.nmb.best/image/2026-11-16/kept.jpg',
      fileName: A_ORIGINAL, bytes: statSync(join(userData, 'images', A_ORIGINAL)).size, format: 'jpeg', width: 1, height: 1, fetchedAt: AT }, [])
    db.holdOfflineImage('500', '501')
    db.updateOfflineCopy('500', { state: 'stopped', failedPage: null, error: null, imageFailures: [] }, AT)
    const cookie = db.insertCredential({ name: '甲', cookieId: 'AAAAAAA', source: 'raw', importedAt: AT, ciphertext: Buffer.from('A-COOKIE') }).id
    db.insertCredential({ name: '乙', cookieId: 'BBBBBBB', source: 'raw', importedAt: AT, ciphertext: Buffer.from('A-COOKIE-2') })
    offlineCopy(db, userData, '510', AT, post('511', 'A 510 reply', 'a510'), A_ORIGINAL_510, 'A 510 original')
    db.deleteCredential('2')
    writeFileSync(join(userData, 'draft-images', A_DRAFT_IMAGE), 'A draft image')
    const attachment = db.insertDraftAttachment({ fileName: A_DRAFT_IMAGE, format: 'png', bytes: 13, width: 1, height: 1, originalName: 'a.png', createdAt: AT })
    db.saveDraft({ draftId: null, target: { kind: 'reply', threadId: '700' }, credentialId: cookie,
      fields: { content: 'A 的草稿', title: '', name: '', watermark: false }, attachmentId: attachment.id }, AT)
    db.setRoleSelection('default-post', cookie)
    db.setRoleSelection('web-sync', cookie)
    db.setThreadPostIdentity('700', cookie, AT)
    db.setSubscriptionAppCredential('uuid-a', Buffer.from('A-APP-UUID'))
    db.saveWorkspace('workspace-A', AT)
    db.beginSearchRebuild()
    for (let step = 0; step < 100; step++) if (db.rebuildSearchBatch()) break
  } finally {
    db.close()
  }
  const sql = new Database(join(userData, 'xidao.sqlite'))
  try {
    attempt(sql, 'a-send', 1)
    sql.prepare(`INSERT INTO reminder_rules (thread_id, kind, enabled, generation, enabled_at, closed_by, changed_at, source, expires_at)
      VALUES ('100', 'all', 1, 1, ?, NULL, ?, 'user', NULL)`).run(AT, AT)
    sql.prepare("INSERT INTO settings VALUES ('closeAction', '\"quit\"'), ('density', '\"compact\"') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run()
    const generation = sql.prepare<[], { generation: number }>('SELECT generation FROM subscription_configuration').get()!.generation
    return { userData, generation }
  } finally {
    sql.close()
  }
}

/** Exports `userData` the way the app does (in this process) and returns the file. */
async function exportOf(userData: string, keep: string[], includeOffline = true): Promise<string> {
  const target = folder('xidao-import-file-', keep)
  const { promise, resolve } = Promise.withResolvers<ExportProgress>()
  const service = createExportService({
    databasePath: join(userData, 'xidao.sqlite'),
    draftImagesDirectory: join(userData, 'draft-images'),
    imagesDirectory: join(userData, 'images'),
    appVersion: '1.5.0-a',
    status: () => ({ state: 'ready', schemaVersion: SUPPORTED }),
    sending: () => false,
    database: {
      estimate: async (path) => readExportEstimate(path),
      snapshot: async (path, work) => takeExportSnapshot(path, work),
      secrets: async (path) => readSecretRows(path),
      trim: async (work, options) => trimExportSnapshot(work, options),
      abort: () => undefined
    },
    protector: testProtector(),
    publish(progress) {
      if (progress.status !== 'running') resolve(progress)
    },
    showInFolder: () => undefined,
    freeBytes: async () => 1024 ** 4
  })
  expect(await service.start({ includeOffline, passphrase: null }, async (name) => join(target, name))).toEqual({ status: 'started' })
  const outcome = await promise
  if (outcome.status !== 'done') throw new Error(`export ${outcome.status}`)
  return join(target, outcome.fileName)
}

/**
 * The target machine B, open as in the running app: two cookies (a third was removed), an App UUID,
 * an account session, its own settings of this device, an analytics instance, drafts (one with an
 * attachment named like A's, one using the removed cookie), offline copies (500 older than A's, 510
 * newer than A's, 600 only here, its original named like A's of 510), history, a send record, a
 * pre-upgrade backup and an earlier 导入前数据.
 */
function targetMachine(): { userData: string; db: ReadingDatabase } {
  const userData = folder('xidao-import-b-')
  mkdirSync(join(userData, 'images'))
  mkdirSync(join(userData, 'draft-images'))
  const db = openReadingDatabase(join(userData, 'xidao.sqlite'), MIGRATIONS, { appVersion: '1.5.0-b' })
  connections.push(db)
  const first = db.insertCredential({ name: 'B1', cookieId: 'CCCCCCC', source: 'raw', importedAt: AT, ciphertext: Buffer.from('B-COOKIE-1') }).id
  db.insertCredential({ name: 'B2', cookieId: 'DDDDDDD', source: 'raw', importedAt: AT, ciphertext: Buffer.from('B-COOKIE-2') })
  writeFileSync(join(userData, 'draft-images', B_DRAFT_IMAGE), 'B draft image bytes')
  const attachment = db.insertDraftAttachment({ fileName: B_DRAFT_IMAGE, format: 'png', bytes: 19, width: 1, height: 1, originalName: 'b.png', createdAt: AT })
  db.saveDraft({ draftId: null, target: { kind: 'reply', threadId: '800' }, credentialId: first,
    fields: { content: 'B 的草稿', title: '', name: '', watermark: false }, attachmentId: attachment.id }, AT)
  const second = db.listCredentials()[1]!.id
  const removed = db.insertCredential({ name: 'B3', cookieId: 'FFFFFFF', source: 'raw', importedAt: AT, ciphertext: Buffer.from('B-COOKIE-3') }).id
  db.deleteCredential(removed)
  writeFileSync(join(userData, 'draft-images', A_DRAFT_IMAGE), 'B second draft image')
  const named = db.insertDraftAttachment({ fileName: A_DRAFT_IMAGE, format: 'png', bytes: 20, width: 1, height: 1, originalName: 'b2.png', createdAt: AT })
  db.saveDraft({ draftId: null, target: { kind: 'reply', threadId: '801' }, credentialId: second,
    fields: { content: 'B 的第二份草稿', title: '', name: '', watermark: false }, attachmentId: named.id }, AT)
  db.saveDraft({ draftId: null, target: { kind: 'reply', threadId: '802' }, credentialId: removed,
    fields: { content: 'B 用已移除饼干的草稿', title: '', name: '', watermark: false }, attachmentId: null }, AT)
  offlineCopy(db, userData, '500', EARLIER, post('501', 'B offline reply', 'kept'), B_ORIGINAL_500, 'B 500 original')
  offlineCopy(db, userData, '510', LATER, post('511', 'B 510 reply', 'a510'), B_ORIGINAL_510, 'B 510 original')
  offlineCopy(db, userData, '600', AT, post('601', 'B 600 reply', 'b600'), A_ORIGINAL_510, 'B 600 original')
  db.setSubscriptionAppCredential('uuid-b', Buffer.from('B-APP-UUID'))
  db.saveAccountSession({ ciphertext: Buffer.from(B_SESSION), expiresAt: '2099-01-01T00:00:00.000Z' })
  db.recordVisit('900', AT)
  db.recordVisit('901', AT)
  db.saveWorkspace('workspace-B', AT)
  const sql = raw(join(userData, 'xidao.sqlite'))
  attempt(sql, 'b-send', 1)
  sql.prepare("INSERT INTO settings VALUES ('analytics', ?), ('thirdPartyConsent', '{\"search\":true}'), ('closeAction', '\"background\"') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(JSON.stringify({ instance: B_ANALYTICS }))
  mkdirSync(preUpgradeBackupDirectory(userData), { recursive: true })
  writeFileSync(join(preUpgradeBackupDirectory(userData), 'manifest.json'), '{}')
  mkdirSync(beforeImportDirectory(userData), { recursive: true })
  writeFileSync(join(beforeImportDirectory(userData), 'earlier-import'), 'an earlier import')
  return { userData, db }
}

const inProcess: ImportDatabase = {
  check: async (staging, version) => checkStagedImport(staging, version),
  counts: async (path) => readLocalCounts(path),
  secrets: async (path) => readSecretRows(path),
  stage: async (staging, path, file) => stageImport(staging, path, file),
  abort: () => undefined
}

function importer(userData: string, options: {
  restart?: () => Promise<QuitEnd>
  limits?: { maxTotalBytes?: number; maxManifestBytes?: number }
  protector?: SecretProtector
} = {}) {
  const restarts: number[] = []
  const service = createImportService({
    databasePath: join(userData, 'xidao.sqlite'),
    supportedVersion: SUPPORTED,
    status: () => ({ state: 'ready', schemaVersion: SUPPORTED }),
    database: inProcess,
    protector: options.protector ?? testProtector(),
    restart: async () => {
      restarts.push(1)
      return options.restart === undefined ? 'exiting' : options.restart()
    },
    limits: options.limits
  })
  return { service, restarts }
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Every file under `root` (relative path → content hash), leaving out `skip` (relative). */
function tree(root: string, skip: string[] = []): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      const rel = relative(root, path)
      if (skip.includes(rel)) continue
      if (lstatSync(path).isDirectory()) walk(path)
      else files.set(rel, sha(path))
    }
  }
  if (existsSync(root)) walk(root)
  return files
}

function completeIn(files: Map<string, string>, places: string[]): boolean {
  return [...files].every(([rel, hash]) => places.some((place) => existsSync(join(place, rel)) && sha(join(place, rel)) === hash))
}

/** The current data a swap moves: the database files and draft attachments. */
function currentData(userData: string): Map<string, string> {
  return new Map([...tree(userData)].filter(([rel]) => rel.startsWith('xidao.sqlite') || rel.startsWith('draft-images')))
}

let shared: { file: string; generation: number } | null = null
const sharedFolders: string[] = []

beforeAll(async () => {
  const source = sourceMachine(sharedFolders)
  shared = { file: await exportOf(source.userData, sharedFolders), generation: source.generation }
})

afterAll(() => {
  for (const path of sharedFolders.splice(0)) rmSync(path, { recursive: true, force: true })
})

function exported(): { file: string; generation: number } {
  if (shared === null) throw new Error('no export')
  return shared
}

/** B has checked and confirmed A's file; its run has ended (the database closed). */
async function prepared(): Promise<{ userData: string; current: Map<string, string>; staged: Map<string, string> }> {
  const { userData, db } = targetMachine()
  const { service } = importer(userData)
  const inspection = await service.inspect(async () => exported().file)
  expect(inspection.status).toBe('ready')
  expect(await service.confirm()).toEqual({ status: 'restarting' })
  db.close()
  connections.splice(0)
  return { userData, current: currentData(userData), staged: tree(importStagingDirectory(userData)) }
}

/** An encrypted export file; only its plain-text header is read before the passphrase. */
async function encryptedFile(): Promise<string> {
  const dir = folder('xidao-import-encrypted-')
  const source = join(dir, 'source.bin')
  writeFileSync(source, 'database bytes')
  const manifest: ExportManifest = {
    containerVersion: CONTAINER_VERSION, schemaVersion: SUPPORTED, appVersion: '1.5.0', exportedAt: AT,
    includes: { offlineCopies: false, secrets: true }, credentialSequence: 0,
    entries: { database: { count: 1, bytes: 14 }, draftImages: { count: 0, bytes: 0 }, offlineImages: { count: 0, bytes: 0 } },
    stats: { history: 0, sendRecords: 0, offlineThreads: 0 }
  }
  const { params, keys } = await newEncryption('导出口令')
  const file = join(dir, 'encrypted.xidao')
  const handle = await open(file, 'wx')
  const input = await open(source, 'r')
  try {
    await writeContainer(handle, { manifest, sources: [{ type: ENTRY_TYPE.database, name: DATABASE_NAME, bytes: 14, handle: input }] }, {
      signal: new AbortController().signal, onProgress: () => undefined, encryption: { params, key: keys.content }
    })
  } finally {
    await handle.close()
    await input.close()
  }
  return file
}

function reopen(userData: string): ReadingDatabase {
  const db = openReadingDatabase(join(userData, 'xidao.sqlite'), MIGRATIONS, { appVersion: '1.5.0-b' })
  connections.push(db)
  expect(db.status).toEqual({ state: 'ready', schemaVersion: SUPPORTED })
  return db
}

function expectImported(userData: string, current: Map<string, string>): void {
  expect(existsSync(join(userData, 'backups', 'restore-journal.json'))).toBe(false)
  expect(existsSync(importStagingDirectory(userData))).toBe(false)
  expect(completeIn(current, [beforeImportDirectory(userData)])).toBe(true)
  expect(existsSync(join(beforeImportDirectory(userData), 'earlier-import'))).toBe(false)
  expect(existsSync(preUpgradeBackupDirectory(userData))).toBe(false)
  expect(readFileSync(join(userData, 'images', A_ORIGINAL), 'utf8')).toBe('A original bytes')
  expect(readFileSync(join(userData, 'draft-images', A_DRAFT_IMAGE), 'utf8')).toBe('A draft image')
  // 导入前数据 holds this machine's attachments as they were.
  expect(readFileSync(join(beforeImportDirectory(userData), 'draft-images', A_DRAFT_IMAGE), 'utf8')).toBe('B second draft image')
  expect(readFileSync(join(beforeImportDirectory(userData), 'draft-images', B_DRAFT_IMAGE), 'utf8')).toBe('B draft image bytes')
  const db = reopen(userData)
  expect(db.loadWorkspace()).toBe('workspace-A')
  expect(db.listCredentials().map((credential) => credential.name)).toEqual(['B1', 'B2'])
  // Opening the imported data takes no new pre-upgrade backup: it is at this version already.
  expect(existsSync(preUpgradeBackupDirectory(userData))).toBe(false)
  // Each copy's originals and each draft's attachment are there once, readable.
  const sql = raw(join(userData, 'xidao.sqlite'))
  const originals = sql.prepare<[], { thread: string; name: string }>(`SELECT o.thread_id AS thread, r.file_name AS name
    FROM offline_images o JOIN image_resources r ON r.id = o.resource_id ORDER BY o.thread_id`).all()
  expect(originals.map((row) => [row.thread, readFileSync(join(userData, 'images', row.name), 'utf8')]))
    .toEqual([['500', 'A original bytes'], ['510', 'B 510 original'], ['600', 'B 600 original']])
  expect(sql.prepare('SELECT count(*) FROM image_resources').pluck().get()).toBe(3)
  const attachments = sql.prepare<[], { content: string; name: string }>(`SELECT d.content, a.file_name AS name
    FROM drafts d JOIN draft_attachments a ON a.id = d.attachment_id ORDER BY d.id`).all()
  expect(attachments.map((row) => [row.content, readFileSync(join(userData, 'draft-images', row.name), 'utf8')]))
    .toEqual([['A 的草稿', 'A draft image'], ['B 的草稿', 'B draft image bytes'], ['B 的第二份草稿', 'B second draft image']])
  expect(readdirSync(join(userData, 'draft-images')).sort()).toEqual(attachments.map((row) => row.name).sort())
  expect(sql.prepare('SELECT count(*) FROM draft_attachments').pluck().get()).toBe(3)
}

function expectUnchanged(userData: string, current: Map<string, string>): void {
  expect(existsSync(join(userData, 'backups', 'restore-journal.json'))).toBe(false)
  expect(existsSync(importStagingDirectory(userData))).toBe(false)
  expect(completeIn(current, [userData])).toBe(true)
  const db = reopen(userData)
  expect(db.loadWorkspace()).toBe('workspace-B')
}

describe('import inspection and confirmation', () => {
  it('shows the file’s origin and contents and this machine’s counts, and gives the file up on cancel', async () => {
    const { userData } = targetMachine()
    const { service, restarts } = importer(userData)
    const inspection = await service.inspect(async () => exported().file)
    expect(inspection).toEqual({
      status: 'ready',
      summary: { exportedAt: expect.any(String), appVersion: '1.5.0-a', offlineThreads: 2, secrets: false, local: { history: 2, sendRecords: 1 } }
    })
    expect(JSON.stringify(inspection)).not.toContain(exported().file)
    expect(existsSync(importStagingDirectory(userData))).toBe(true)
    await service.cancel()
    expect(existsSync(importStagingDirectory(userData))).toBe(false)
    expect(await service.confirm()).toEqual({ status: 'failed' })
    expect(restarts).toEqual([])
    expect(await service.inspect(async () => null)).toEqual({ status: 'dismissed' })
  })

  it('a 取消 right after the file is chosen ends the check before it reads anything', async () => {
    const { userData } = targetMachine()
    const outside = tree(userData)
    const { service } = importer(userData)
    const chosen = Promise.withResolvers<string | null>()
    const inspection = service.inspect(() => chosen.promise)
    // The file is chosen and 取消 arrives before the check goes on to read its header.
    chosen.resolve(exported().file)
    const cancelled = service.cancel()
    expect(await inspection).toEqual({ status: 'dismissed' })
    await cancelled
    expect(existsSync(importStagingDirectory(userData))).toBe(false)
    expect(tree(userData)).toEqual(outside)
    expect(await service.confirm()).toEqual({ status: 'failed' })
    // The next file is checked as usual.
    expect((await service.inspect(async () => exported().file)).status).toBe('ready')
  })

  it.each([['取消'], ['a quit']] as const)('%s while this machine’s protection is checked for an encrypted file asks for no passphrase', async (how) => {
    const { userData } = targetMachine()
    const file = await encryptedFile()
    const asked = Promise.withResolvers<void>()
    const answer = Promise.withResolvers<boolean>()
    const protector: SecretProtector = {
      ...testProtector(),
      isAvailable() {
        asked.resolve()
        return answer.promise
      }
    }
    const { service } = importer(userData, { protector })
    const inspection = service.inspect(async () => file)
    await asked.promise
    const ended = how === '取消' ? service.cancel() : service.stop()
    answer.resolve(true)
    await ended
    expect(await inspection).toEqual({ status: 'dismissed' })
    expect(existsSync(importStagingDirectory(userData))).toBe(false)
    // Nothing waits for a passphrase.
    expect(await service.submitPassphrase('anything')).toEqual({ status: 'failed', failure: { reason: 'busy' } })
  })

  it('merges: this machine’s cookies after the file’s sequence, file references never resolve to them, target-kept items stay', async () => {
    const { userData, db } = targetMachine()
    const { service } = importer(userData)
    expect((await service.inspect(async () => exported().file)).status).toBe('ready')
    // Repeated presses while it runs: one preparation, one restart.
    const [first, second] = await Promise.all([service.confirm(), service.confirm()])
    expect(first).toEqual({ status: 'restarting' })
    expect(second).toEqual({ status: 'restarting' })
    db.close()
    connections.splice(0)
    // The current data as the next start finds it (closing checkpointed its log).
    const before = currentData(userData)
    expect(settleSwap(join(userData, 'xidao.sqlite'))).toEqual({ kind: 'import', outcome: 'completed' })
    expectImported(userData, before)

    const after = reopen(userData)
    // A's sequence reached 2: B's cookies follow it, in their order.
    expect(after.listCredentials().map((credential) => [credential.id, credential.name])).toEqual([['3', 'B1'], ['4', 'B2']])
    expect(Buffer.from(after.loadCredentialCiphertext('3')!).toString()).toBe('B-COOKIE-1')
    // The file's references (cookie 1) find nothing: 已移除, never one of B's.
    expect(after.loadRoleSelections()).toEqual({ 'default-post': { state: 'missing', credentialId: '1' }, 'web-sync': { state: 'missing', credentialId: '1' } })
    expect(after.getThreadPostIdentity('700')).toEqual({ state: 'missing', credentialId: '1' })
    // Every draft is here: A's with its reference to A's cookie 1 (已移除), B's on B's cookies under
    // their new IDs, and B's draft whose cookie B had removed on an ID no credential has.
    expect(after.listDrafts().map((draft) => [draft.fields.content, draft.credentialId, draft.attachment?.fileName === undefined]))
      .toEqual([['B 用已移除饼干的草稿', '5', true], ['B 的第二份草稿', '4', false], ['B 的草稿', '3', false], ['A 的草稿', '1', false]])
    expect(after.listDrafts().find((draft) => draft.fields.content === 'B 的第二份草稿')!.attachment!.fileName).not.toBe(A_DRAFT_IMAGE)
    expect(after.insertCredential({ name: '新', cookieId: 'EEEEEEE', source: 'raw', importedAt: AT, ciphertext: Buffer.from('new') }).id).toBe('6')

    const sql = raw(join(userData, 'xidao.sqlite'))
    expect(sql.prepare('SELECT request_id, credential_id FROM publication_attempts').all()).toEqual([{ request_id: 'a-send', credential_id: 1 }])
    // The App UUID the file's configuration used is not here: 未配置 under a new generation.
    expect(sql.prepare('SELECT id FROM subscription_app_credentials').pluck().all()).toEqual(['uuid-b'])
    expect(sql.prepare('SELECT generation, app_credential_id FROM subscription_configuration').get())
      .toEqual({ generation: exported().generation + 1, app_credential_id: null })
    expect(Buffer.from(sql.prepare('SELECT ciphertext FROM account_session').pluck().get() as Buffer).toString()).toBe(B_SESSION)
    const setting = (key: string) => sql.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(key)
    expect(setting('analytics')).toBe(JSON.stringify({ instance: B_ANALYTICS }))
    expect(setting('thirdPartyConsent')).toBe('{"search":true}')
    expect(setting('closeAction')).toBe('"background"')
    expect(setting('density')).toBe('"compact"')
    expect(sql.prepare('SELECT thread_id FROM thread_visits').pluck().all()).toEqual(['100'])
    expect(sql.prepare('SELECT thread_id, kind FROM reminder_rules').all()).toEqual([{ thread_id: '100', kind: 'all' }])
    expect(sql.prepare('SELECT count(*) FROM reminder_checker').pluck().get()).toBe(0)
    expect(sql.prepare('SELECT ready FROM search_state').pluck().get()).toBe(0)
    expect(sql.prepare('SELECT count(*) FROM search_documents').pluck().get()).toBe(0)
    // Offline copies: 500 is A's (later), 510 B's (later), 600 only B's; each as a whole.
    expect(sql.prepare('SELECT thread_id FROM offline_copies ORDER BY thread_id').pluck().all()).toEqual(['500', '510', '600'])
    expect(sql.prepare("SELECT id, plain_text FROM posts WHERE id IN ('501', '511', '601') ORDER BY id").all())
      .toEqual([{ id: '501', plain_text: 'A offline reply' }, { id: '511', plain_text: 'B 510 reply' }, { id: '601', plain_text: 'B 600 reply' }])
    expect(sql.prepare('SELECT updated_at FROM offline_copies ORDER BY thread_id').pluck().all()).toEqual([AT, LATER, AT])
    expect(sql.prepare("SELECT count(*) FROM offline_copies WHERE image_failures_json <> '[]'").pluck().get()).toBe(0)
    for (const thread of ['500', '510', '600']) {
      const copy = after.getOfflineCopy(thread)!
      expect(copy, thread).toMatchObject({ savedImages: 1, pages: [1] })
      expect(after.loadThreadPage(thread, 'all', 1)?.value.replies.map((reply) => reply.id), thread).toEqual([`${Number(thread) + 1}`])
    }
  })

  it('records the credential ID map from this machine’s IDs to the staged ones', () => {
    const { userData, db } = targetMachine()
    const staging = folder('xidao-import-staging-')
    const file = new Database(join(staging, 'xidao.sqlite'))
    // An imported database whose sequence went further than its rows (cookie 7 was removed).
    file.close()
    const fresh = openReadingDatabase(join(staging, 'xidao.sqlite'))
    fresh.insertCredential({ name: 'x', cookieId: 'XXXXXXX', source: 'raw', importedAt: AT, ciphertext: Buffer.from('x') })
    fresh.close()
    const sql = new Database(join(staging, 'xidao.sqlite'))
    sql.pragma('journal_mode = DELETE')
    sql.prepare("UPDATE sqlite_sequence SET seq = 7 WHERE name = 'credentials'").run()
    sql.close()
    const { credentialIds } = stageImport(staging, join(userData, 'xidao.sqlite'), { credentialSequence: 5, secrets: null })
    expect([...credentialIds]).toEqual([[1, 8], [2, 9]])
    db.close()
  })
})

describe('this machine’s offline copies and drafts', () => {
  /** Imports `file` into `userData` (B, `db` its open database) through to the next start. */
  async function imported(userData: string, db: ReadingDatabase, file: string): Promise<{ after: ReadingDatabase; sql: Database.Database }> {
    const { service } = importer(userData)
    expect((await service.inspect(async () => file)).status).toBe('ready')
    expect(await service.confirm()).toEqual({ status: 'restarting' })
    db.close()
    connections.splice(0)
    expect(settleSwap(join(userData, 'xidao.sqlite'))).toEqual({ kind: 'import', outcome: 'completed' })
    return { after: reopen(userData), sql: raw(join(userData, 'xidao.sqlite')) }
  }

  it('keeps every copy of this machine when the file has none', async () => {
    const keep: string[] = []
    try {
      const source = sourceMachine(keep)
      const file = await exportOf(source.userData, keep, false)
      const { userData, db } = targetMachine()
      const { after, sql } = await imported(userData, db, file)
      expect(sql.prepare('SELECT thread_id, updated_at FROM offline_copies ORDER BY thread_id').all())
        .toEqual([{ thread_id: '500', updated_at: EARLIER }, { thread_id: '510', updated_at: LATER }, { thread_id: '600', updated_at: AT }])
      expect(sql.prepare("SELECT plain_text FROM posts WHERE id = '501'").pluck().get()).toBe('B offline reply')
      const originals = sql.prepare<[], { thread: string; name: string }>(`SELECT o.thread_id AS thread, r.file_name AS name
        FROM offline_images o JOIN image_resources r ON r.id = o.resource_id ORDER BY o.thread_id`).all()
      expect(originals.map((row) => [row.thread, readFileSync(join(userData, 'images', row.name), 'utf8')]))
        .toEqual([['500', 'B 500 original'], ['510', 'B 510 original'], ['600', 'B 600 original']])
      expect(after.getOfflineCopy('500')).toMatchObject({ savedImages: 1, imageFailures: [] })
    } finally {
      for (const path of keep) rmSync(path, { recursive: true, force: true })
    }
  })

  it('records an original or attachment whose file is gone from this machine as not kept', async () => {
    const { userData, db } = targetMachine()
    const sql = raw(join(userData, 'xidao.sqlite'))
    const name = sql.prepare<[], string>("SELECT r.file_name FROM offline_images o JOIN image_resources r ON r.id = o.resource_id WHERE o.thread_id = '600'").pluck().get()!
    rmSync(join(userData, 'images', name))
    rmSync(join(userData, 'draft-images', B_DRAFT_IMAGE))
    connections.splice(connections.indexOf(sql), 1)
    sql.close()
    const { after } = await imported(userData, db, exported().file)
    expect(after.getOfflineCopy('600')).toMatchObject({ savedImages: 0, imageFailures: [{ postId: '601', error: { reason: 'not-stored' } }] })
    expect(after.listDrafts().find((draft) => draft.fields.content === 'B 的草稿')).toMatchObject({ credentialId: '3', attachment: null })
  })
})

describe('import versions', () => {
  /** An export file of a database at `version` (built by the truncated migration chain). */
  async function oldFile(version: number, manifestVersion = version): Promise<{ file: string; databaseBytes: number }> {
    const work = folder('xidao-import-old-')
    const db = openReadingDatabase(join(work, 'live.sqlite'), MIGRATIONS.filter((migration) => migration.version <= version))
    expect(db.status).toEqual({ state: 'ready', schemaVersion: version })
    db.recordVisit('42', AT)
    db.close()
    const live = new Database(join(work, 'live.sqlite'))
    live.prepare('VACUUM INTO ?').run(join(work, 'xidao.sqlite'))
    live.close()
    const database = readFileSync(join(work, 'xidao.sqlite'))
    const file = join(work, 'old.xidao')
    writeFileSync(file, container([{ type: ENTRY_TYPE.database, name: 'xidao.sqlite', bytes: database }], { schemaVersion: manifestVersion, appVersion: '1.4.0' }))
    return { file, databaseBytes: database.length }
  }

  it('migrates an older file in staging and imports it; the pre-upgrade backup goes and none is taken after', async () => {
    const { file } = await oldFile(SUPPORTED - 2)
    const { userData, db } = targetMachine()
    const { service } = importer(userData)
    expect(await service.inspect(async () => file)).toMatchObject({ status: 'ready', summary: { appVersion: '1.4.0' } })
    expect(await service.confirm()).toEqual({ status: 'restarting' })
    db.close()
    connections.splice(0)
    const current = currentData(userData)
    expect(settleSwap(join(userData, 'xidao.sqlite'))).toEqual({ kind: 'import', outcome: 'completed' })
    expect(existsSync(preUpgradeBackupDirectory(userData))).toBe(false)
    expect(completeIn(current, [beforeImportDirectory(userData)])).toBe(true)
    const after = reopen(userData)
    expect(after.listCredentials().map((credential) => credential.id)).toEqual(['1', '2'])
    expect(existsSync(preUpgradeBackupDirectory(userData))).toBe(false)
    const sql = raw(join(userData, 'xidao.sqlite'))
    expect(sql.prepare('SELECT thread_id FROM thread_visits').pluck().all()).toEqual(['42'])
  })

  it('refuses a file from a newer version, naming it, before extracting anything', async () => {
    const { file } = await oldFile(SUPPORTED - 1, SUPPORTED + 1)
    const { userData } = targetMachine()
    const outside = tree(userData, ['backups/import-staging'])
    const { service } = importer(userData)
    expect(await service.inspect(async () => file)).toEqual({ status: 'rejected', rejection: { reason: 'newer', appVersion: '1.4.0' } })
    expect(existsSync(importStagingDirectory(userData))).toBe(false)
    expect(tree(userData)).toEqual(outside)
  })

  it('refuses a database whose version differs from its manifest', async () => {
    const { file } = await oldFile(SUPPORTED - 1, SUPPORTED)
    const { userData } = targetMachine()
    const { service } = importer(userData)
    expect(await service.inspect(async () => file)).toEqual({ status: 'rejected', rejection: { reason: 'corrupt' } })
    expect(existsSync(importStagingDirectory(userData))).toBe(false)
  })
})

interface CraftedEntry {
  type: number
  name: string
  bytes: Buffer
  /** Declared length when it differs from the bytes. */
  declared?: number
}

function entry(type: number, name: string, length: number): Buffer {
  const nameBytes = Buffer.from(name, 'utf8')
  const buffer = Buffer.alloc(11 + nameBytes.length)
  buffer.writeUInt8(type, 0)
  buffer.writeUInt16BE(nameBytes.length, 1)
  nameBytes.copy(buffer, 3)
  buffer.writeBigUInt64BE(BigInt(length), 3 + nameBytes.length)
  return buffer
}

/** A container built by hand: the manifest's totals match the entries unless overridden. */
function container(entries: CraftedEntry[], manifest: Partial<ExportManifest> = {}, manifestPadding = 0): Buffer {
  const totals = (type: number) => {
    const of = entries.filter((item) => item.type === type)
    return { count: of.length, bytes: of.reduce((sum, item) => sum + (item.declared ?? item.bytes.length), 0) }
  }
  const full: ExportManifest & { padding?: string } = {
    containerVersion: CONTAINER_VERSION,
    schemaVersion: SUPPORTED,
    appVersion: '1.5.0-x',
    exportedAt: AT,
    includes: { offlineCopies: true, secrets: false },
    credentialSequence: 0,
    entries: { database: totals(ENTRY_TYPE.database), draftImages: totals(ENTRY_TYPE.draftImage), offlineImages: totals(ENTRY_TYPE.offlineImage) },
    stats: { history: 0, sendRecords: 0, offlineThreads: 0 },
    ...manifest
  }
  if (manifestPadding > 0) full.padding = 'x'.repeat(manifestPadding)
  const header = Buffer.from(JSON.stringify({ encryption: null }))
  const fixed = Buffer.alloc(14)
  CONTAINER_MAGIC.copy(fixed, 0)
  fixed.writeUInt16BE(CONTAINER_VERSION, 8)
  fixed.writeUInt32BE(header.length, 10)
  const manifestBytes = Buffer.from(JSON.stringify(full))
  const parts = [fixed, header, entry(ENTRY_TYPE.manifest, 'manifest.json', manifestBytes.length), manifestBytes]
  for (const item of entries) parts.push(entry(item.type, item.name, item.declared ?? item.bytes.length), item.bytes)
  if (!entries.some((item) => item.declared !== undefined && item.declared > item.bytes.length)) parts.push(entry(ENTRY_TYPE.end, '', 0))
  return Buffer.concat(parts)
}

describe('untrusted files', () => {
  const database = Buffer.from('not looked at: the entries are refused first')
  const image = Buffer.from('image bytes')
  const cases: Array<[string, Buffer, { maxTotalBytes?: number; maxManifestBytes?: number }?]> = [
    ['an entry name with a path', container([{ type: ENTRY_TYPE.database, name: 'xidao.sqlite', bytes: database },
      { type: ENTRY_TYPE.draftImage, name: `../../${'f'.repeat(32)}.png`, bytes: image }])],
    ['a nested entry name', container([{ type: ENTRY_TYPE.database, name: 'xidao.sqlite', bytes: database },
      { type: ENTRY_TYPE.offlineImage, name: `images/${'f'.repeat(32)}.jpg`, bytes: image }])],
    ['an entry name that is not managed', container([{ type: ENTRY_TYPE.database, name: 'xidao.sqlite', bytes: database },
      { type: ENTRY_TYPE.draftImage, name: 'evil.png', bytes: image }])],
    ['a database entry under another name', container([{ type: ENTRY_TYPE.database, name: '../xidao.sqlite', bytes: database }])],
    ['a declared length beyond the file', container([{ type: ENTRY_TYPE.database, name: 'xidao.sqlite', bytes: database },
      { type: ENTRY_TYPE.draftImage, name: `${'f'.repeat(32)}.png`, bytes: image, declared: 1024 * 1024 }])],
    ['totals that do not match the manifest', container([{ type: ENTRY_TYPE.database, name: 'xidao.sqlite', bytes: database }],
      { entries: { database: { count: 1, bytes: 1 }, draftImages: { count: 0, bytes: 0 }, offlineImages: { count: 0, bytes: 0 } } })],
    ['a manifest over its limit', container([{ type: ENTRY_TYPE.database, name: 'xidao.sqlite', bytes: database }], {}, 4096), { maxManifestBytes: 1024 }],
    ['entries over the total limit', container([{ type: ENTRY_TYPE.database, name: 'xidao.sqlite', bytes: database },
      { type: ENTRY_TYPE.draftImage, name: `${'f'.repeat(32)}.png`, bytes: image }]), { maxTotalBytes: database.length + 1 }],
    ['secrets in a plain file', container([{ type: ENTRY_TYPE.database, name: 'xidao.sqlite', bytes: database }], { includes: { offlineCopies: true, secrets: true } })]
  ]

  it.each(cases)('refuses %s before writing anything outside staging', async (_name, bytes, limits) => {
    const { userData } = targetMachine()
    const file = join(folder('xidao-import-crafted-'), 'crafted.xidao')
    writeFileSync(file, bytes)
    const outside = tree(userData)
    const { service } = importer(userData, { limits })
    expect(await service.inspect(async () => file)).toEqual({ status: 'rejected', rejection: { reason: 'corrupt' } })
    expect(tree(userData)).toEqual(outside)
    expect(existsSync(join(userData, 'backups', `${'f'.repeat(32)}.png`))).toBe(false)
    expect(readFileSync(file)).toEqual(bytes)
  })

  it('refuses what is not an export file, and a database that does not pass its checks', async () => {
    const { userData } = targetMachine()
    const dir = folder('xidao-import-crafted-')
    const outside = tree(userData)
    const { service } = importer(userData)
    writeFileSync(join(dir, 'theme.xidao'), '{"theme":true}')
    expect(await service.inspect(async () => join(dir, 'theme.xidao'))).toEqual({ status: 'rejected', rejection: { reason: 'not-export' } })
    writeFileSync(join(dir, 'garbage.xidao'), container([{ type: ENTRY_TYPE.database, name: 'xidao.sqlite', bytes: database }]))
    expect(await service.inspect(async () => join(dir, 'garbage.xidao'))).toEqual({ status: 'rejected', rejection: { reason: 'corrupt' } })
    expect(tree(userData)).toEqual(outside)
  })

  it('refuses a file whose database names a draft image or original that is missing', async () => {
    // A's export without its draft image entry: the database still names it.
    const { userData } = targetMachine()
    const work = folder('xidao-import-missing-')
    const staging = join(work, 'staging')
    const contents = await readContainer(exported().file, { extractTo: staging })
    const db = readFileSync(join(staging, 'xidao.sqlite'))
    const originals = contents.entries.filter((item) => item.type === ENTRY_TYPE.offlineImage)
      .map((item) => ({ type: item.type, name: item.name, bytes: readFileSync(join(staging, 'images', item.name)) }))
    const file = join(work, 'missing.xidao')
    writeFileSync(file, container([{ type: ENTRY_TYPE.database, name: 'xidao.sqlite', bytes: db }, ...originals], { schemaVersion: SUPPORTED, credentialSequence: 2 }))
    const { service } = importer(userData)
    expect(await service.inspect(async () => file)).toEqual({ status: 'rejected', rejection: { reason: 'corrupt' } })
    expect(existsSync(importStagingDirectory(userData))).toBe(false)
  })
})

describe('quit called off and pending swaps', () => {
  it('removes staging and journal when the quit is called off; the data is unchanged', async () => {
    const { userData, db } = targetMachine()
    const images = tree(join(userData, 'draft-images'))
    const { service, restarts } = importer(userData, { restart: async () => 'unchecked' })
    expect((await service.inspect(async () => exported().file)).status).toBe('ready')
    expect(await service.confirm()).toEqual({ status: 'blocked', reason: 'unchecked' })
    expect(restarts).toHaveLength(1)
    expect(existsSync(join(userData, 'backups', 'restore-journal.json'))).toBe(false)
    expect(existsSync(importStagingDirectory(userData))).toBe(false)
    // Nothing staged any more: confirming again does nothing.
    expect(await service.confirm()).toEqual({ status: 'failed' })
    db.close()
    connections.splice(0)
    const current = currentData(userData)
    expect(tree(join(userData, 'draft-images'))).toEqual(images)
    expect(settleSwap(join(userData, 'xidao.sqlite'))).toBeNull()
    expectUnchanged(userData, current)
  })

  it.each([['reopened'], ['unstored'], ['not-started']] as const)('treats a quit that ended as %s as called off', async (end) => {
    const { userData } = targetMachine()
    const { service } = importer(userData, { restart: async () => end })
    expect((await service.inspect(async () => exported().file)).status).toBe('ready')
    expect(await service.confirm()).toEqual({ status: 'blocked', reason: 'other' })
    expect(existsSync(join(userData, 'backups', 'restore-journal.json'))).toBe(false)
  })

  it('refuses to import while a restore is pending, leaving it as it is', async () => {
    const { userData } = targetMachine()
    const { service, restarts } = importer(userData)
    expect((await service.inspect(async () => exported().file)).status).toBe('ready')
    beginSwap(userData, { kind: 'restore', phase: 'prepared', databaseSize: 1, draftImages: [] })
    const journal = readFileSync(join(userData, 'backups', 'restore-journal.json'))
    expect(await service.confirm()).toEqual({ status: 'failed' })
    expect(readFileSync(join(userData, 'backups', 'restore-journal.json'))).toEqual(journal)
    expect(existsSync(importStagingDirectory(userData))).toBe(false)
    expect(restarts).toEqual([])
    expect(await service.inspect(async () => exported().file)).toEqual({ status: 'failed', failure: { reason: 'busy' } })
  })

  it('a quit while the file is checked or confirmed but not restarting removes the staging', async () => {
    const { userData } = targetMachine()
    const { service } = importer(userData)
    expect((await service.inspect(async () => exported().file)).status).toBe('ready')
    await service.stop()
    expect(existsSync(importStagingDirectory(userData))).toBe(false)
  })
})

describe('import journal', () => {
  /** Settles the journal, ending the process after the `stop`th durable change. */
  function interrupted(userData: string, stop: number): boolean {
    let steps = 0
    try {
      settleSwap(join(userData, 'xidao.sqlite'), { step: () => { if (++steps === stop) throw new Error('terminated') } })
      return false
    } catch (error) {
      if ((error as Error).message !== 'terminated') throw error
      return true
    }
  }

  const places = (userData: string) => ({
    current: [userData, join(userData, 'backups', 'before-import.partial'), beforeImportDirectory(userData)],
    imported: [importStagingDirectory(userData), userData]
  })

  it('after an interruption at any step, the next start completes it; both copies stay whole meanwhile', async () => {
    let stop = 1
    for (;;) {
      const { userData, current, staged } = await prepared()
      if (!interrupted(userData, stop)) {
        expectImported(userData, current)
        break
      }
      const where = places(userData)
      expect(completeIn(current, where.current), `current data after step ${stop}`).toBe(true)
      expect(completeIn(staged, where.imported), `import result after step ${stop}`).toBe(true)
      const pending = existsSync(join(userData, 'backups', 'restore-journal.json'))
      expect(settleSwap(join(userData, 'xidao.sqlite'))).toEqual(pending ? { kind: 'import', outcome: 'completed' } : null)
      expectImported(userData, current)
      for (const connection of connections.splice(0)) connection.close()
      stop++
    }
    expect(stop).toBeGreaterThan(10)
  })

  it('abandons an import whose staged data went missing before it was placed, and opens the current data as it was', async () => {
    let abandoned = 0
    for (let stop = 0; ; stop++) {
      const { userData, current } = await prepared()
      if (stop > 0 && !interrupted(userData, stop)) break
      const stagedDatabase = join(importStagingDirectory(userData), 'xidao.sqlite')
      // Once placed, the import result is no longer staging's to lose.
      if (!existsSync(stagedDatabase)) continue
      writeFileSync(stagedDatabase, readFileSync(stagedDatabase).subarray(0, 1024))
      expect(settleSwap(join(userData, 'xidao.sqlite'))).toEqual({ kind: 'import', outcome: 'abandoned' })
      expectUnchanged(userData, current)
      for (const connection of connections.splice(0)) connection.close()
      abandoned++
    }
    expect(abandoned).toBeGreaterThan(2)
  })

  it('abandons when a staged original is missing before anything moved', async () => {
    const { userData, current } = await prepared()
    rmSync(join(importStagingDirectory(userData), 'images', A_ORIGINAL))
    expect(settleSwap(join(userData, 'xidao.sqlite'))).toEqual({ kind: 'import', outcome: 'abandoned' })
    expectUnchanged(userData, current)
  })

  it('removes a staged import no journal names', async () => {
    const { userData, current } = await prepared()
    rmSync(join(userData, 'backups', 'restore-journal.json'))
    expect(settleSwap(join(userData, 'xidao.sqlite'))).toBeNull()
    expectUnchanged(userData, current)
  })

  it('is written in a format released versions refuse rather than open mid-swap', async () => {
    const { userData } = await prepared()
    const journal = JSON.parse(readFileSync(join(userData, 'backups', 'restore-journal.json'), 'utf8')) as { format: number; kind: string }
    expect(journal).toMatchObject({ format: 2, kind: 'import', phase: 'prepared' })
  })
})

describe('inspection results the renderer sees', () => {
  it('carries no path', async () => {
    const { userData } = targetMachine()
    const { service } = importer(userData)
    const results: ImportInspection[] = [await service.inspect(async () => exported().file)]
    for (const result of results) {
      expect(JSON.stringify(result)).not.toContain(userData)
      expect(JSON.stringify(result)).not.toContain(tmpdir())
    }
  })
})

describe('import on the production worker entry', () => {
  it('checks, stages and is carried out like the in-process work', async () => {
    const build = folder('xidao-import-worker-')
    const require = createRequire(import.meta.url)
    // Bundle the actual worker entry, as the app's `?nodeWorker` import does.
    await viteBuild({
      configFile: false, logLevel: 'silent',
      build: {
        outDir: build, emptyOutDir: false, target: 'node24',
        lib: { entry: fileURLToPath(new URL('../src/main/storage/import-worker.ts', import.meta.url)), formats: ['es'], fileName: () => 'import.mjs' },
        rollupOptions: {
          external: (id) => id === 'better-sqlite3' || id.startsWith('node:'),
          output: { paths: { 'better-sqlite3': pathToFileURL(require.resolve('better-sqlite3')).href } }
        }
      }
    })
    const { userData, db } = targetMachine()
    const service = createImportService({
      databasePath: join(userData, 'xidao.sqlite'),
      supportedVersion: SUPPORTED,
      status: () => ({ state: 'ready', schemaVersion: SUPPORTED }),
      database: createWorkerImportDatabase((options) => new Worker(pathToFileURL(join(build, 'import.mjs')), options)),
      protector: testProtector(),
      restart: async () => 'exiting'
    })
    expect(await service.inspect(async () => exported().file)).toMatchObject({ status: 'ready', summary: { local: { history: 2, sendRecords: 1 } } })
    expect(await service.confirm()).toEqual({ status: 'restarting' })
    db.close()
    connections.splice(0)
    const current = currentData(userData)
    expect(settleSwap(join(userData, 'xidao.sqlite'))).toEqual({ kind: 'import', outcome: 'completed' })
    expectImported(userData, current)
  }, 30_000)
})

describe('a quit stopped by a send whose state cannot be checked', () => {
  it('goes through the renderer’s quit check and the lifecycle; the import does not happen', async () => {
    const { userData, db } = targetMachine()
    // An editor whose send request failed inside the app and whose one more lookup still fails.
    let editors = [{ id: 'editor-1', publication: { phase: 'uncertain', requestId: 'request-1', checking: false } }] as unknown as Editor[]
    const rechecks: string[] = []
    const lifecycle = createLifecycle({
      window: {
        state: () => 'shown',
        open: async () => undefined,
        reveal: () => undefined,
        hide: () => undefined,
        destroy: () => undefined,
        send(request) {
          if (request.kind !== 'quit') return
          // What LifecycleHost's quit does first: settle the sends, and stop with 'unchecked' when one stays uncertain.
          void settleQuitSends({
            current: () => editors,
            cancelPrompt: async () => undefined,
            recheck: async (editorId) => {
              rechecks.push(editorId)
              editors = editors.map((editor) => ({ ...editor, publication: { phase: 'uncertain', requestId: 'request-1', checking: false } })) as Editor[]
            },
            flush: async () => undefined,
            nextChange: async () => undefined
          }).then((settled) => {
            if (!settled) lifecycle.cancelQuit('unchecked')
            else lifecycle.completeQuit(true)
          })
        }
      },
      closeAction: async () => 'ask',
      publication: { inFlight: () => [], setUnattended: () => undefined, abandon: async () => null, unstoredResults: () => [], retryUnstored: async () => true },
      stopBackgroundWork: () => undefined,
      notify: () => undefined,
      exit: () => { throw new Error('must not exit') },
      now: () => Date.now(),
      sleep: async () => undefined,
      onTrigger: () => undefined
    })
    await lifecycle.start()
    const service = createImportService({
      databasePath: join(userData, 'xidao.sqlite'),
      supportedVersion: SUPPORTED,
      status: () => ({ state: 'ready', schemaVersion: SUPPORTED }),
      database: inProcess,
      protector: testProtector(),
      restart: () => lifecycle.requestQuit('restart')
    })
    expect((await service.inspect(async () => exported().file)).status).toBe('ready')
    expect(await service.confirm()).toEqual({ status: 'blocked', reason: 'unchecked' })
    expect(rechecks).toEqual(['editor-1'])
    expect(lifecycle.phase).toBe('running')
    expect(existsSync(join(userData, 'backups', 'restore-journal.json'))).toBe(false)
    expect(existsSync(importStagingDirectory(userData))).toBe(false)
    db.close()
    connections.splice(0)
    const current = currentData(userData)
    expect(settleSwap(join(userData, 'xidao.sqlite'))).toBeNull()
    expectUnchanged(userData, current)
  })
})
