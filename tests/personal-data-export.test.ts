import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { build as viteBuild } from 'vite'
import { createWorkerExportDatabase } from '../src/main/personal-data/worker-database'
import { open, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExportProgress, StorageStatus } from '../src/shared/api'
import type { Post, ThreadPage } from '../src/shared/forum'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { MIGRATIONS } from '../src/main/storage/migrations'
import { readExportEstimate, takeExportSnapshot, trimExportSnapshot } from '../src/main/storage/export-snapshot'
import { createExportService, exportFileName, type ExportDatabase, type ExportService } from '../src/main/personal-data/service'
import {
  CONTAINER_MAGIC, ContainerError, DATABASE_NAME, ENTRY_TYPE, readContainer, type ContainerContents
} from '../src/main/personal-data/container'

const AT = '2026-11-16T08:00:00.000Z'
const COOKIE = 'CIPHERTEXT-COOKIE-MARKER'
const APP_UUID = 'CIPHERTEXT-APP-UUID-MARKER'
const SESSION = 'CIPHERTEXT-SESSION-MARKER'
const ANALYTICS = 'ANALYTICS-INSTANCE-MARKER'
const CACHE_TEXT = 'CACHE-ONLY-TEXT'
const VISITED_TEXT = 'VISITED-HEAD-TEXT'
const DRAFT_IMAGE = `${'d'.repeat(32)}.png`
const ORIGINAL = `${'a'.repeat(32)}.jpg`
const LOST_ORIGINAL = `${'b'.repeat(32)}.jpg`
const THUMB = `${'c'.repeat(32)}.jpg`

const folders: string[] = []
const connections: Array<{ close(): void }> = []

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function folder(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  folders.push(path)
  return path
}

function post(id: string, text: string, image: string | null = null): Post {
  return { id, forumId: '4', createdAt: null, userHash: null, name: null, title: null, isAdmin: null, isSage: null,
    content: [{ type: 'text', text }], plainText: text, image: image === null ? null : { path: `2026-11-16/${image}`, ext: '.jpg' } }
}

function page(threadId: string, head: Post, replies: Post[]): ThreadPage {
  return { threadId, mode: 'all', page: 1, head, replies, replyCount: replies.length, skippedItems: 0, endCandidate: true }
}

function original(db: ReadingDatabase, images: string, name: string, image: string, kind: 'original' | 'thumb' = 'original') {
  writeFileSync(join(images, name), `${kind} bytes of ${image}`)
  db.commitImageResource({ kind, sourceUrl: `https://image.nmb.best/${kind === 'thumb' ? 'thumb' : 'image'}/2026-11-16/${image}.jpg`,
    fileName: name, bytes: statSync(join(images, name)).size, format: 'jpeg', width: 1, height: 1, fetchedAt: AT },
  kind === 'thumb' ? [{ kind: 'reading', id: 'view:one' }] : [])
}

/**
 * A user data directory as the app keeps it: a visited thread (its head is protected), a cached
 * thread nobody holds, two offline copies with originals (one file later lost), a reading thumbnail,
 * a draft with an attachment, a cookie, an App UUID, an account session, the analytics instance and
 * the search index. The database stays open, as in the running app.
 */
function source() {
  const userData = folder('xidao-export-source-')
  const images = join(userData, 'images')
  mkdirSync(images)
  mkdirSync(join(userData, 'draft-images'))
  const db = openReadingDatabase(join(userData, 'xidao.sqlite'), MIGRATIONS, { appVersion: '1.5.0-test' })
  connections.push(db)
  expect(db.status.state).toBe('ready')

  db.saveThreadPage(page('100', post('100', VISITED_TEXT), [post('101', `${CACHE_TEXT} visited reply`)]), AT)
  db.recordVisit('100', AT)
  db.saveThreadPage(page('300', post('300', `${CACHE_TEXT} head`), [post('301', CACHE_TEXT)]), AT)
  original(db, images, THUMB, 'thumb', 'thumb')

  db.beginOfflineCopy('500', true, AT)
  db.saveOfflinePage(page('500', post('500', 'offline head'), [post('501', 'offline reply', 'kept')]), AT)
  original(db, images, ORIGINAL, 'kept')
  db.holdOfflineImage('500', '501')
  db.updateOfflineCopy('500', { state: 'stopped', failedPage: null, error: null, imageFailures: [] }, AT)
  db.beginOfflineCopy('600', true, AT)
  db.saveOfflinePage(page('600', post('600', 'second offline head'), [post('601', 'second offline reply', 'lost')]), AT)
  original(db, images, LOST_ORIGINAL, 'lost')
  db.holdOfflineImage('600', '601')
  db.updateOfflineCopy('600', { state: 'stopped', failedPage: null, error: null, imageFailures: [] }, AT)

  writeFileSync(join(userData, 'draft-images', DRAFT_IMAGE), 'draft image bytes')
  const credentialId = db.insertCredential({ name: '甲', cookieId: 'AAAAAAA', source: 'raw', importedAt: AT, ciphertext: Buffer.from(COOKIE) }).id
  db.insertCredential({ name: '乙', cookieId: 'BBBBBBB', source: 'raw', importedAt: AT, ciphertext: Buffer.from(COOKIE) })
  db.deleteCredential('2')
  const attachment = db.insertDraftAttachment({ fileName: DRAFT_IMAGE, format: 'png', bytes: 17, width: 1, height: 1, originalName: 'a.png', createdAt: AT })
  db.saveDraft({ draftId: null, target: { kind: 'reply', threadId: '700' }, credentialId,
    fields: { content: '草稿正文', title: '', name: '', watermark: false }, attachmentId: attachment.id }, AT)
  db.setSubscriptionAppCredential('uuid-a', Buffer.from(APP_UUID))
  db.saveAccountSession({ ciphertext: Buffer.from(SESSION), expiresAt: '2099-01-01T00:00:00.000Z' })
  db.setBlock('post', '999', true, AT)
  db.holdContentReader('window:view', '300')
  db.beginSearchRebuild()
  for (let step = 0; step < 100; step++) if (db.rebuildSearchBatch()) break

  const raw = new Database(join(userData, 'xidao.sqlite'))
  connections.push(raw)
  raw.prepare("INSERT INTO settings VALUES ('analytics', ?), ('cacheLimitBytes', '0'), ('announcements', '{}')").run(JSON.stringify({ instance: ANALYTICS }))
  raw.prepare("INSERT INTO settings VALUES ('closeAction', '\"quit\"'), ('density', '\"compact\"') ON CONFLICT(key) DO NOTHING").run()
  return { userData, db, raw }
}

/** The snapshot work in this process; `afterSnapshot` runs once the snapshot is taken. */
function inProcess(afterSnapshot?: () => void): ExportDatabase & { aborted: number } {
  return {
    aborted: 0,
    estimate: async (path) => readExportEstimate(path),
    snapshot: async (path, work) => {
      const files = takeExportSnapshot(path, work)
      afterSnapshot?.()
      return files
    },
    trim: async (work, options) => trimExportSnapshot(work, options),
    abort() { this.aborted++ }
  }
}

function harness(userData: string, options: {
  status?: () => StorageStatus
  sending?: () => boolean
  database?: ExportDatabase
  freeBytes?: (directory: string) => Promise<number>
  createFile?: (path: string) => Promise<FileHandle>
  onProgress?: (progress: ExportProgress, service: ExportService) => void
} = {}) {
  const events: ExportProgress[] = []
  let finish: (progress: ExportProgress) => void = () => undefined
  const shown: string[] = []
  const service = createExportService({
    databasePath: join(userData, 'xidao.sqlite'),
    draftImagesDirectory: join(userData, 'draft-images'),
    imagesDirectory: join(userData, 'images'),
    appVersion: '1.5.0-test',
    status: options.status ?? (() => ({ state: 'ready', schemaVersion: 29 })),
    sending: options.sending ?? (() => false),
    database: options.database ?? inProcess(),
    publish(progress) {
      events.push(progress)
      options.onProgress?.(progress, service)
      if (progress.status !== 'running') finish(progress)
    },
    showInFolder: (path) => shown.push(path),
    freeBytes: options.freeBytes ?? (async () => 1024 ** 4),
    createFile: options.createFile,
    now: () => new Date(2026, 10, 16, 9, 30)
  })
  const target = folder('xidao-export-target-')
  const run = async (includeOffline: boolean) => {
    const { promise, resolve } = Promise.withResolvers<ExportProgress>()
    finish = resolve
    const started = await service.start({ includeOffline }, async (name) => join(target, name))
    return { started, outcome: started.status === 'started' ? await promise : null }
  }
  return { service, events, target, run, shown }
}

async function extract(file: string): Promise<{ contents: ContainerContents; db: Database.Database; out: string }> {
  const out = folder('xidao-export-extract-')
  const contents = await readContainer(file, { extractTo: out })
  const db = new Database(join(out, DATABASE_NAME), { readonly: true })
  connections.push(db)
  return { contents, db, out }
}

const rows = (db: Database.Database, sql: string) => db.prepare(sql).all()
const count = (db: Database.Database, table: string) => db.prepare<[], { n: number }>(`SELECT count(*) AS n FROM ${table}`).get()!.n

describe('personal data export', () => {
  it('writes personal records without cache, search index, analytics, account session or secrets', async () => {
    const { userData, raw } = source()
    const sourceThreads = count(raw, 'post_threads')
    const { started, outcome, target, events } = await (async () => {
      const h = harness(userData)
      return { ...(await h.run(false)), target: h.target, events: h.events }
    })()
    expect(started).toEqual({ status: 'started' })
    const name = exportFileName(new Date(2026, 10, 16, 9, 30))
    expect(name).toBe('汐岛个人数据-2026-11-16.xidao')
    expect(outcome).toEqual({ status: 'done', fileName: name })
    expect(readdirSync(target)).toEqual([name])
    const running = events.filter((event) => event.status === 'running')
    const last = running.at(-1)
    expect(last).toMatchObject({ status: 'running' })
    if (last?.status === 'running') expect(last.writtenBytes).toBe(last.totalBytes)
    expect(statSync(join(target, name)).size).toBe(last?.status === 'running' ? last.totalBytes : -1)

    const bytes = readFileSync(join(target, name))
    expect(bytes.subarray(0, 8).equals(CONTAINER_MAGIC)).toBe(true)
    for (const marker of [COOKIE, APP_UUID, SESSION, ANALYTICS, CACHE_TEXT]) expect(bytes.includes(marker)).toBe(false)

    const { contents, db } = await extract(join(target, name))
    expect(contents.manifest).toMatchObject({
      containerVersion: 1, schemaVersion: 29, appVersion: '1.5.0-test',
      includes: { offlineCopies: false, secrets: false },
      credentialSequence: 2,
      entries: { database: { count: 1 }, draftImages: { count: 1, bytes: 17 }, offlineImages: { count: 0, bytes: 0 } },
      stats: { history: 1, sendRecords: 0, offlineThreads: 0 }
    })
    expect(contents.entries.map((entry) => [entry.type, entry.name])).toEqual([[ENTRY_TYPE.database, DATABASE_NAME], [ENTRY_TYPE.draftImage, DRAFT_IMAGE]])

    for (const table of ['credentials', 'subscription_app_credentials', 'account_session', 'offline_copies', 'offline_pages',
      'offline_images', 'image_resources', 'image_holders', 'content_readers', 'search_sources', 'search_documents', 'search_backfill', 'feed_pages']) {
      expect(count(db, table), table).toBe(0)
    }
    expect(rows(db, 'SELECT ready FROM search_state')).toEqual([{ ready: 0 }])
    expect(rows(db, 'SELECT key FROM settings ORDER BY key')).toEqual([{ key: 'announcements' }, { key: 'density' }])
    // The visited thread's head text stays with its visit record; the rest of the cache is gone.
    expect(rows(db, 'SELECT id, plain_text FROM posts ORDER BY id')).toEqual([{ id: '100', plain_text: VISITED_TEXT }])
    expect(count(db, 'thread_visits')).toBe(1)
    expect(rows(db, 'SELECT attachment_id IS NOT NULL AS attached FROM drafts')).toEqual([{ attached: 1 }])
    expect(count(db, 'local_blocks')).toBe(1)
    // Relations cache clearing keeps stay: the trimmed database is referentially whole.
    expect(count(db, 'post_threads')).toBe(sourceThreads)
    expect(db.pragma('foreign_key_check')).toEqual([])
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')

    // The file opens in this app at its schema version without changes.
    const out = folder('xidao-export-open-')
    writeFileSync(join(out, 'xidao.sqlite'), readFileSync(db.name))
    const reopened = openReadingDatabase(join(out, 'xidao.sqlite'))
    connections.push(reopened)
    expect(reopened.status).toEqual({ state: 'ready', schemaVersion: 29 })
    expect(reopened.listDrafts()).toMatchObject([{ fields: { content: '草稿正文' } }])
  })

  it('takes offline copies with their originals, no thumbnails, and records a lost original as not saved', async () => {
    const { userData } = source()
    const h = harness(userData, { database: inProcess(() => unlinkSync(join(userData, 'images', LOST_ORIGINAL))) })
    const { outcome } = await h.run(true)
    expect(outcome?.status).toBe('done')
    const name = readdirSync(h.target)[0]!
    const { contents, db, out } = await extract(join(h.target, name))
    expect(contents.manifest).toMatchObject({ includes: { offlineCopies: true }, stats: { offlineThreads: 2 },
      entries: { offlineImages: { count: 1 } } })
    expect(contents.entries.filter((entry) => entry.type === ENTRY_TYPE.offlineImage).map((entry) => entry.name)).toEqual([ORIGINAL])
    expect(readFileSync(join(out, 'images', ORIGINAL), 'utf8')).toBe('original bytes of kept')
    expect(rows(db, 'SELECT kind, file_name FROM image_resources')).toEqual([{ kind: 'original', file_name: ORIGINAL }])
    expect(rows(db, 'SELECT thread_id, image_failures_json FROM offline_copies ORDER BY thread_id')).toEqual([
      { thread_id: '500', image_failures_json: '[]' },
      { thread_id: '600', image_failures_json: JSON.stringify([{ postId: '601', error: { reason: 'not-stored' } }]) }
    ])
    expect(rows(db, "SELECT id FROM posts WHERE id IN ('500', '501', '600', '601') ORDER BY id")).toHaveLength(4)
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
  })

  it('leaves out what is written after the snapshot', async () => {
    const { userData, db, raw } = source()
    const h = harness(userData, { database: inProcess(() => db.setBlock('post', '888', true, AT)) })
    expect((await h.run(false)).outcome?.status).toBe('done')
    expect(rows(raw, 'SELECT value FROM local_blocks ORDER BY value')).toEqual([{ value: '888' }, { value: '999' }])
    const { db: exported } = await extract(join(h.target, readdirSync(h.target)[0]!))
    expect(rows(exported, 'SELECT value FROM local_blocks')).toEqual([{ value: '999' }])
  })

  it('reports the estimate and refuses unless storage is writable or while a post is sending', async () => {
    const { userData } = source()
    const estimate = await harness(userData).service.estimate()
    expect(estimate).toMatchObject({ available: true, running: null, contents: { offline: { threads: 2 } } })
    if (estimate.available && estimate.contents !== null) {
      expect(estimate.contents.offline!.bytes).toBeGreaterThan(0)
      expect(estimate.contents.totalBytes).toBeGreaterThan(estimate.contents.offline!.bytes)
    }
    const readOnly = harness(userData, { status: () => ({ state: 'read-only', reason: 'newer-schema', schemaVersion: 30, supportedVersion: 29 }) })
    expect(await readOnly.service.estimate()).toEqual({ available: false, reason: 'read-only' })
    expect(await readOnly.run(true)).toEqual({ started: { status: 'failed', failure: { reason: 'storage' } }, outcome: null })
    const unavailable = harness(userData, { status: () => ({ state: 'unavailable', reason: 'open-failed' }) })
    expect(await unavailable.service.estimate()).toEqual({ available: false, reason: 'unavailable' })

    let sending = true
    const busy = harness(userData, { sending: () => sending })
    expect(await busy.run(true)).toEqual({ started: { status: 'failed', failure: { reason: 'sending' } }, outcome: null })
    expect(readdirSync(busy.target)).toEqual([])
    sending = false
    expect((await busy.run(true)).outcome?.status).toBe('done')
    expect(await busy.service.reveal()).toBe(true)
    expect(busy.shown).toEqual([join(busy.target, readdirSync(busy.target)[0]!)])
  })

  it('does not start without enough disk space, and leaves nothing behind', async () => {
    const { userData } = source()
    const h = harness(userData, { freeBytes: async () => 100 })
    const { started } = await h.run(true)
    expect(started).toMatchObject({ status: 'failed', failure: { reason: 'space' } })
    if (started.status === 'failed' && started.failure.reason === 'space') expect(started.failure.shortBytes).toBeGreaterThan(0)
    expect(readdirSync(h.target)).toEqual([])
    expect(await h.service.reveal()).toBe(false)
  })

  it.each([
    ['a write failure', 'EIO', { reason: 'write' }],
    ['a full disk', 'ENOSPC', { reason: 'space' }]
  ] as const)('removes the partial file after %s', async (_label, code, failure) => {
    const { userData } = source()
    const h = harness(userData, {
      async createFile(path) {
        const handle = await open(path, 'wx')
        let writes = 0
        const write = handle.write.bind(handle) as (...args: unknown[]) => Promise<{ bytesWritten: number }>
        Object.assign(handle, {
          write: async (...args: unknown[]) => {
            if (++writes > 3) throw Object.assign(new Error('injected'), { code })
            return write(...args)
          }
        })
        return handle
      }
    })
    const { outcome } = await h.run(true)
    expect(outcome).toMatchObject({ status: 'failed', failure })
    expect(readdirSync(h.target)).toEqual([])
  })

  it('cancels while writing and on quit, removing the temporary files', async () => {
    const { userData } = source()
    let cancelled = false
    const h = harness(userData, {
      onProgress(progress, service) {
        if (!cancelled && progress.status === 'running' && progress.writtenBytes > 0) {
          cancelled = true
          service.cancel()
        }
      }
    })
    expect((await h.run(true)).outcome).toEqual({ status: 'cancelled' })
    expect(readdirSync(h.target)).toEqual([])

    // Quitting during the snapshot: stop waits for the cleanup.
    const gate = Promise.withResolvers<void>()
    const slow: ExportDatabase = { ...inProcess(), snapshot: async (path, work) => { const files = takeExportSnapshot(path, work); await gate.promise; return files } }
    const quitting = harness(userData, { database: slow })
    const run = quitting.run(true)
    await expect.poll(() => quitting.events.length).toBeGreaterThan(0)
    expect(readdirSync(quitting.target).length).toBeGreaterThan(0)
    const stopped = quitting.service.stop()
    gate.resolve()
    await stopped
    expect((await run).outcome).toEqual({ status: 'cancelled' })
    expect(readdirSync(quitting.target)).toEqual([])
    expect(await quitting.service.start({ includeOffline: true }, async () => join(quitting.target, 'x.xidao'))).toEqual({ status: 'failed', failure: { reason: 'busy' } })
  })

  it('refuses a second export while one runs', async () => {
    const { userData } = source()
    const gate = Promise.withResolvers<void>()
    const slow: ExportDatabase = { ...inProcess(), snapshot: async (path, work) => { await gate.promise; return takeExportSnapshot(path, work) } }
    const h = harness(userData, { database: slow })
    const first = h.run(false)
    await expect.poll(() => h.events.length).toBeGreaterThan(0)
    expect(await h.service.estimate()).toMatchObject({ available: true, running: { status: 'running', writtenBytes: 0 } })
    expect(await h.service.start({ includeOffline: false }, async () => join(h.target, 'x.xidao'))).toEqual({ status: 'failed', failure: { reason: 'busy' } })
    gate.resolve()
    expect((await first).outcome?.status).toBe('done')
  })

  it('runs the snapshot on the production worker entry and stops it on cancel', async () => {
    const { userData } = source()
    const build = folder('xidao-export-worker-')
    const require = createRequire(import.meta.url)
    // Bundle the actual worker entry, as the app's `?nodeWorker` import does.
    await viteBuild({
      configFile: false, logLevel: 'silent',
      build: {
        outDir: build, emptyOutDir: false, target: 'node24',
        lib: { entry: fileURLToPath(new URL('../src/main/storage/export-worker.ts', import.meta.url)), formats: ['es'], fileName: () => 'export.mjs' },
        rollupOptions: {
          external: (id) => id === 'better-sqlite3' || id.startsWith('node:'),
          output: { paths: { 'better-sqlite3': pathToFileURL(require.resolve('better-sqlite3')).href } }
        }
      }
    })
    const workers = createWorkerExportDatabase((options) => new Worker(pathToFileURL(join(build, 'export.mjs')), options))
    const h = harness(userData, { database: workers })
    expect(await h.service.estimate()).toMatchObject({ available: true, contents: { offline: { threads: 2 } } })
    const { outcome } = await h.run(true)
    expect(outcome?.status).toBe('done')
    const { contents } = await extract(join(h.target, readdirSync(h.target)[0]!))
    expect(contents.manifest.entries.offlineImages.count).toBe(2)

    const work = join(build, 'work.sqlite')
    const pending = workers.snapshot(join(userData, 'xidao.sqlite'), work)
    workers.abort()
    await expect(pending).rejects.toThrow()
  }, 30_000)
})

describe('export container reader', () => {
  async function exported() {
    const { userData } = source()
    const h = harness(userData)
    await h.run(true)
    return join(h.target, readdirSync(h.target)[0]!)
  }

  async function refused(bytes: Buffer, limits?: Parameters<typeof readContainer>[1]): Promise<string> {
    const path = join(folder('xidao-export-bad-'), 'bad.xidao')
    writeFileSync(path, bytes)
    const extractTo = folder('xidao-export-bad-out-')
    try {
      await readContainer(path, { ...limits, extractTo })
      return 'accepted'
    } catch (error) {
      expect(error).toBeInstanceOf(ContainerError)
      return error instanceof ContainerError ? error.kind : String(error)
    }
  }

  it('refuses foreign, truncated, altered and oversized files', async () => {
    const good = readFileSync(await exported())
    expect(await refused(Buffer.from('PK\u0003\u0004 not ours'))).toBe('not-container')
    expect(await refused(good.subarray(0, good.length - 1))).toBe('corrupt')
    expect(await refused(Buffer.concat([good, Buffer.from([0])]))).toBe('corrupt')
    const newer = Buffer.from(good)
    newer.writeUInt16BE(2, 8)
    expect(await refused(newer)).toBe('unsupported')
    // A draft image entry name (after the database, which also holds it) turned into a path.
    const traversal = Buffer.from(good)
    const at = traversal.lastIndexOf(DRAFT_IMAGE)
    traversal.write('../', at, 'ascii')
    expect(await refused(traversal)).toBe('corrupt')
    // A declared length that disagrees with the manifest.
    const lengthAt = good.lastIndexOf(DRAFT_IMAGE) + DRAFT_IMAGE.length
    const longer = Buffer.from(good)
    longer.writeBigUInt64BE(longer.readBigUInt64BE(lengthAt) + 1n, lengthAt)
    expect(await refused(longer)).toBe('corrupt')
    expect(await refused(good, { limits: { maxManifestBytes: 10 } })).toBe('too-large')
    expect(await refused(good, { limits: { maxTotalBytes: 10 } })).toBe('too-large')
    expect(await refused(good, { limits: { maxEntries: 1 } })).toBe('too-large')
    expect(await refused(good)).toBe('accepted')
  })
})
