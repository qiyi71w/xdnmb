import { randomBytes } from 'node:crypto'
import { lstat, open, rename, rm, stat, statfs, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  ExportEstimate, ExportFailure, ExportOptions, ExportProgress, ExportRunning, ExportStartResult, StorageStatus
} from '../../shared/api'
import type { SecretProtector } from '../identity/protection'
import type { ExportEstimateCounts, SecretRows, SnapshotFile, SnapshotFiles, TrimOptions, TrimResult } from '../storage/export-snapshot'
import { syncDirectory } from '../storage/durable'
import {
  containerBytes, CONTAINER_VERSION, DATABASE_NAME, ENTRY_TYPE, SourceReadError, writeContainer, type ContainerSource, type ExportManifest
} from './container'
import { newEncryption, sealedBytes, wipeKeys, type EncryptionParams, type ExportKeys } from './encryption'
import { sealForExport, SecretsUnreadableError } from './secrets'

/*
 * 导出个人数据: save dialog, disk space check, a consistent snapshot trimmed for export (on a worker,
 * see `../storage/export-snapshot`), then the container written to a temporary file beside the
 * target and renamed into place once complete. A cancel, a failure or quitting the app removes the
 * temporary files, so no partial export file is ever left. The renderer gets file names only.
 *
 * With 饼干与 App UUID, the 导出口令 derives the file's keys (`./encryption`) and is dropped; the
 * snapshot's secrets are decrypted here, sealed for the file (`./secrets`) before the trimmed copy
 * is written, and the whole file is encrypted. The passphrase and keys stay in this process's
 * memory, never on disk or in a log.
 */

/** The snapshot work, off the main thread in the app. `abort` ends whatever runs; its promise rejects. */
export interface ExportDatabase {
  estimate(databasePath: string): Promise<ExportEstimateCounts>
  snapshot(databasePath: string, workPath: string): Promise<SnapshotFiles>
  /** Every secret row of the database at `databasePath` (read-only). */
  secrets(databasePath: string): Promise<SecretRows>
  trim(workPath: string, options: TrimOptions): Promise<TrimResult>
  abort(): void
}

export interface ExportService {
  estimate(): Promise<ExportEstimate>
  /** `chooseTarget` shows the save dialog with the default file name; null when dismissed. */
  start(input: ExportOptions, chooseTarget: (defaultName: string) => Promise<string | null>): Promise<ExportStartResult>
  cancel(): void
  /** Shows the last exported file in its folder; false when there is none any more. */
  reveal(): Promise<boolean>
  /** Quitting: cancels a running export and waits until its temporary files are removed. */
  stop(): Promise<void>
  /** A window opened again after a quit was called off. */
  resume(): void
}

/** Progress events at most this often while writing; the first and the outcome always go out. */
const PROGRESS_INTERVAL_MS = 100

class Cancelled extends Error {
  override readonly name = 'Cancelled'
}

/** Default file name: `汐岛个人数据-<YYYY-MM-DD>.xidao`, by the local date. */
export function exportFileName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `汐岛个人数据-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.xidao`
}

function failed(failure: ExportFailure): ExportStartResult {
  return { status: 'failed', failure }
}

export function createExportService(deps: {
  databasePath: string
  draftImagesDirectory: string
  imagesDirectory: string
  appVersion: string
  status: () => StorageStatus
  /** A post is being sent now (a send whose result is unknown is not). */
  sending: () => boolean
  database: ExportDatabase
  /** This machine's secret protection (decrypts the secrets an export carries). */
  protector: SecretProtector
  publish: (progress: ExportProgress) => void
  showInFolder: (path: string) => void
  /** Bytes available to this user on the volume holding `directory`. */
  freeBytes?: (directory: string) => Promise<number>
  /** Creates the new temporary export file. */
  createFile?: (path: string) => Promise<FileHandle>
  now?: () => Date
}): ExportService {
  const now = deps.now ?? (() => new Date())
  const freeBytes = deps.freeBytes ?? (async (directory: string) => {
    const info = await statfs(directory)
    return info.bavail * info.bsize
  })
  const createFile = deps.createFile ?? ((path: string) => open(path, 'wx'))
  let starting = false
  let stopped = false
  let job: { controller: AbortController; done: Promise<void>; running: ExportRunning } | null = null
  let lastExport: string | null = null

  const refusal = (): ExportFailure | null => {
    if (stopped || job !== null) return { reason: 'busy' }
    if (deps.status().state !== 'ready') return { reason: 'storage' }
    return deps.sending() ? { reason: 'sending' } : null
  }

  async function databaseBytes(): Promise<number> {
    let total = 0
    for (const suffix of ['', '-wal']) {
      try { total += (await stat(`${deps.databasePath}${suffix}`)).size } catch { /* absent */ }
    }
    return total
  }

  /**
   * Opens the files a snapshot names, adding each handle to `handles` (closed by the caller). Files
   * that are gone, or are not regular files (never followed through a link), are reported missing.
   * An open handle keeps the file readable even if it is deleted meanwhile.
   */
  async function openAll(directory: string, files: readonly SnapshotFile[], handles: FileHandle[]) {
    const opened = new Map<number, { handle: FileHandle; bytes: number }>()
    const missing: number[] = []
    for (const file of files) {
      const path = join(directory, file.name)
      let handle: FileHandle
      try {
        if (!(await lstat(path)).isFile()) {
          missing.push(file.id)
          continue
        }
        handle = await open(path, 'r')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        missing.push(file.id)
        continue
      }
      handles.push(handle)
      opened.set(file.id, { handle, bytes: (await handle.stat()).size })
    }
    return { opened, missing }
  }

  async function run(target: string, input: ExportOptions, controller: AbortController, running: ExportRunning): Promise<ExportProgress> {
    const { signal } = controller
    const { includeOffline } = input
    const stem = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}`)
    const workPath = `${stem}.db.part`
    const partPath = `${stem}.part`
    const handles: FileHandle[] = []
    let encryption: { params: EncryptionParams; keys: ExportKeys } | null = null
    let writing = false
    let lastSent = 0
    const send = (progress: ExportRunning, force: boolean) => {
      running.writtenBytes = progress.writtenBytes
      running.totalBytes = progress.totalBytes
      const at = Date.now()
      if (!force && at - lastSent < PROGRESS_INTERVAL_MS) return
      lastSent = at
      deps.publish({ ...running })
    }
    const check = () => {
      if (signal.aborted) throw new Cancelled()
    }
    let outcome: ExportProgress
    try {
      send({ status: 'running', writtenBytes: 0, totalBytes: running.totalBytes }, true)
      if (input.passphrase !== null) encryption = await newEncryption(input.passphrase)
      check()
      const files = await deps.database.snapshot(deps.databasePath, workPath)
      check()
      const drafts = await openAll(deps.draftImagesDirectory, files.draftImages, handles)
      const originals = includeOffline ? await openAll(deps.imagesDirectory, files.offlineImages, handles) : { opened: new Map(), missing: [] }
      check()
      // Sealed here, before the trimmed copy is written: it never holds a secret in plain text.
      const secrets = encryption === null ? null : await sealForExport(await deps.database.secrets(workPath), deps.protector, encryption.keys.secrets)
      check()
      const trimmed = await deps.database.trim(workPath, { includeOffline, missingOfflineImages: originals.missing, missingDraftImages: drafts.missing, secrets })
      check()
      const database = await open(workPath, 'r')
      handles.push(database)
      const sources: ContainerSource[] = [{ type: ENTRY_TYPE.database, name: DATABASE_NAME, bytes: (await database.stat()).size, handle: database }]
      const add = (type: ContainerSource['type'], kept: readonly SnapshotFile[], opened: typeof drafts.opened) => {
        for (const file of kept) {
          const entry = opened.get(file.id)
          if (entry === undefined) throw new Error('trimmed snapshot names an unopened file')
          sources.push({ type, name: file.name, bytes: entry.bytes, handle: entry.handle })
        }
      }
      add(ENTRY_TYPE.draftImage, trimmed.draftImages, drafts.opened)
      if (includeOffline) add(ENTRY_TYPE.offlineImage, trimmed.offlineImages, originals.opened)
      const totals = (type: ContainerSource['type']) => {
        const of = sources.filter((source) => source.type === type)
        return { count: of.length, bytes: of.reduce((sum, source) => sum + source.bytes, 0) }
      }
      const manifest: ExportManifest = {
        containerVersion: CONTAINER_VERSION,
        schemaVersion: trimmed.schemaVersion,
        appVersion: deps.appVersion,
        exportedAt: now().toISOString(),
        includes: { offlineCopies: includeOffline, secrets: encryption !== null },
        credentialSequence: trimmed.credentialSequence,
        entries: { database: totals(ENTRY_TYPE.database), draftImages: totals(ENTRY_TYPE.draftImage), offlineImages: totals(ENTRY_TYPE.offlineImage) },
        stats: trimmed.stats
      }
      const totalBytes = containerBytes(manifest, sources, encryption?.params ?? null)
      send({ status: 'running', writtenBytes: 0, totalBytes }, true)
      writing = true
      const file = await createFile(partPath)
      try {
        await writeContainer(file, { manifest, sources }, {
          signal,
          onProgress: (writtenBytes) => send({ status: 'running', writtenBytes, totalBytes }, writtenBytes === totalBytes),
          ...(encryption === null ? {} : { encryption: { params: encryption.params, key: encryption.keys.content } })
        })
      } finally {
        await file.close()
      }
      check()
      await rename(partPath, target)
      syncDirectory(dirname(target))
      lastExport = target
      outcome = { status: 'done', fileName: basename(target) }
    } catch (error) {
      if (signal.aborted || error instanceof Cancelled) outcome = { status: 'cancelled' }
      else if ((error as NodeJS.ErrnoException).code === 'ENOSPC') {
        outcome = { status: 'failed', failure: { reason: 'space', shortBytes: Math.max(1, running.totalBytes - running.writtenBytes) } }
      } else if (error instanceof SecretsUnreadableError) outcome = { status: 'failed', failure: { reason: 'secrets' } }
      else outcome = { status: 'failed', failure: { reason: writing && !(error instanceof SourceReadError) ? 'write' : 'read' } }
    }
    if (encryption !== null) wipeKeys(encryption.keys)
    for (const handle of handles) await handle.close().catch(() => undefined)
    // The temporary files go before the outcome is told, so nothing partial outlives it.
    for (const path of [partPath, workPath, `${workPath}-journal`]) await rm(path, { force: true }).catch(() => undefined)
    return outcome
  }

  function cancel(): void {
    if (job === null) return
    job.controller.abort()
    deps.database.abort()
  }

  return {
    async estimate() {
      const state = deps.status().state
      if (state !== 'ready') return { available: false, reason: state === 'read-only' ? 'read-only' : 'unavailable' }
      // What runs when the answer goes out, not when it was asked for: an export that ended
      // meanwhile has told its outcome already and must not be reported running after it.
      const runningNow = () => (job === null ? null : { ...job.running })
      try {
        const counts = await deps.database.estimate(deps.databasePath)
        const totalBytes = (await databaseBytes()) + counts.draftImageBytes + counts.offlineBytes
        return {
          available: true,
          running: runningNow(),
          contents: {
            offline: counts.offlineThreads === 0 ? null : { threads: counts.offlineThreads, bytes: counts.offlineBytes },
            totalBytes
          }
        }
      } catch {
        return { available: true, running: runningNow(), contents: null }
      }
    },

    async start(input, chooseTarget) {
      const { includeOffline } = input
      if (starting) return failed({ reason: 'busy' })
      const refused = refusal()
      if (refused !== null) return failed(refused)
      starting = true
      try {
        const target = await chooseTarget(exportFileName(now()))
        if (target === null) return { status: 'dismissed' }
        // The dialog may have been open a while.
        const again = refusal()
        if (again !== null) return failed(again)
        let estimated: number
        let snapshotBytes: number
        try {
          const counts = await deps.database.estimate(deps.databasePath)
          snapshotBytes = await databaseBytes()
          const plain = snapshotBytes + counts.draftImageBytes + (includeOffline ? counts.offlineBytes : 0)
          // Sealing adds a tag to each chunk.
          estimated = input.passphrase === null ? plain : sealedBytes(plain)
        } catch {
          return failed({ reason: 'read' })
        }
        // The file and, until it is written, the database snapshot it is made from.
        const required = estimated + snapshotBytes
        let free: number
        try {
          free = await freeBytes(dirname(target))
        } catch {
          return failed({ reason: 'write' })
        }
        if (free < required) return failed({ reason: 'space', shortBytes: required - free })
        if (stopped) return failed({ reason: 'busy' })
        const controller = new AbortController()
        const running: ExportRunning = { status: 'running', writtenBytes: 0, totalBytes: estimated }
        const current = { controller, running, done: Promise.resolve() }
        job = current
        current.done = (async () => {
          let outcome: ExportProgress
          try {
            outcome = await run(target, input, controller, running)
          } finally {
            if (job === current) job = null
          }
          // Told only once nothing runs: an estimate answered from here on reports no export.
          deps.publish(outcome)
        })()
        return { status: 'started' }
      } finally {
        starting = false
      }
    },

    cancel,

    async reveal() {
      if (lastExport === null) return false
      try {
        if (!(await lstat(lastExport)).isFile()) return false
      } catch {
        return false
      }
      deps.showInFolder(lastExport)
      return true
    },

    async stop() {
      stopped = true
      if (job === null) return
      const { done } = job
      cancel()
      await done
    },

    resume() {
      stopped = false
    }
  }
}
