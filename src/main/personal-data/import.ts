import { mkdir, rm, stat, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  ImportBlock, ImportConfirmResult, ImportFailure, ImportInspection, ImportRejection, StorageStatus
} from '../../shared/api'
import type { SecretProtector } from '../identity/protection'
import type { QuitEnd } from '../lifecycle/controller'
import type { SecretRows } from '../storage/export-snapshot'
import { importStagingDirectory, preparedImportJournal, STAGED_DATABASE } from '../storage/import-journal'
import type { CredentialIdMap, ImportFileFacts, LocalMergeSize } from '../storage/import-staging'
import { beginSwap, discardSwapJournal, swapPending } from '../storage/swap-journal'
import { ContainerError, readContainer, readContainerHeader, type ContainerLimits, type ExportManifest } from './container'
import { unlockEncryption, wipeKeys, type EncryptionParams, type ExportKeys } from './encryption'
import { resealForImport } from './secrets'

/*
 * 导入个人数据 (see docs/development.md): the open dialog, every check of the chosen file before the
 * confirmation, then, once confirmed, the import result built in staging, the swap begun and the
 * app restarted through the ordinary quit; the next start swaps the data (`../storage/import-journal`).
 *
 * The file is untrusted. Its content is only ever written into the import staging directory
 * (`backups/import-staging/`), and this machine's database is only read until the next start.
 * Inspection, in order:
 *
 *   1. The plain-text header. An encrypted file carries 饼干与 App UUID: it is refused when this
 *      machine cannot protect them (never kept in plain text), else it waits for its 导出口令,
 *      as many tries as needed (`./encryption`: a wrong one is told apart before any content).
 *   2. Container: magic, container version, entry names and lengths, limits, the manifest
 *      (`./container`); an encrypted file's chunks are authenticated as they are read.
 *   3. The manifest's schema version: newer than this app's is refused, naming the version that
 *      exported it, before any entry is extracted. So is a file the staging volume has no room for
 *      (磁盘空间不足): its declared content, each entry a file (`allocated`), and SQLite's
 *      rollback journal of its database while it is migrated (`journalBytes`). Extraction never
 *      writes more, or more entries, than the manifest declares.
 *   4. The staged database (`../storage/import-staging`): its schema objects before anything of
 *      it runs, integrity, this version's migration chain, references, secret value sizes, and
 *      every draft attachment and offline original it names.
 *   5. Room for the merge, read from this machine's database only now that the file has passed:
 *      the files and rows the merge copies from it into staging (`LocalMergeSize`) and the merge's
 *      rollback journal of the staged database; refused as 磁盘空间不足 otherwise.
 *   6. What the confirmation shows: the manifest's facts and this machine's counts.
 *
 * Any failure removes the staging; this machine's data and the file are unchanged. The renderer
 * gets file facts and counts only, never a path or a secret. The passphrase only derives the keys;
 * the file's secret key stays in memory until the import is prepared or given up, when the file's
 * secrets are opened with it and encrypted by this machine's protector (`./secrets`).
 */

/** The SQLite work, off the main thread in the app. `abort` ends whatever runs; its promise rejects. */
export interface ImportDatabase {
  /** Checks the extracted database and migrates it in staging; rejects when it cannot be imported. */
  check(stagingDirectory: string, schemaVersion: number): Promise<void>
  /** This machine's 浏览历史 and 发送记录 counts. */
  counts(databasePath: string): Promise<{ history: number; sendRecords: number }>
  /** What the merge copies from this machine's database and files into staging at most. */
  appendedBytes(databasePath: string): Promise<LocalMergeSize>
  /** Every secret row of the database at `databasePath` (read-only). */
  secrets(databasePath: string): Promise<SecretRows>
  /** Builds the import result in staging (`stageImport`). */
  stage(stagingDirectory: string, databasePath: string, file: ImportFileFacts): Promise<{ credentialIds: CredentialIdMap }>
  abort(): void
}

export interface ImportService {
  /** `chooseFile` shows the open dialog; null when dismissed. */
  inspect(chooseFile: () => Promise<string | null>): Promise<ImportInspection>
  /** The 导出口令 for the file waiting for one, then the rest of the check. */
  submitPassphrase(passphrase: string): Promise<ImportInspection>
  /** Once per checked file; repeated while it runs, the same result. */
  confirm(): Promise<ImportConfirmResult>
  /** Gives up a file once chosen, while checked or checked; nothing while the import is being prepared or carried out. */
  cancel(): Promise<void>
  /** Quitting: stops checking or preparing and removes the staging, unless the quit is the import's own. */
  stop(): Promise<void>
}

class Refused extends Error {
  override readonly name = 'Refused'
  constructor(readonly rejection: ImportRejection) {
    super(`import refused: ${rejection.reason}`)
  }
}

/** The staging volume has no room for the file's content and the work after it. */
class NoSpace extends Error {
  override readonly name = 'NoSpace'
}

/** Assumed when the staging volume does not tell its block size. */
const DEFAULT_BLOCK_SIZE = 4096
/** The largest directory entry a file name takes (ext4's 8-byte header and a 255-byte name, 4-byte aligned). */
const DIRECTORY_ENTRY_BYTES = 264
/** SQLite's smallest page and the largest sector its journal header is padded to. */
const MIN_PAGE_BYTES = 512
const MAX_SECTOR_BYTES = 65536

/** At most what `files` files of `bytes` in all take on a volume of `blockSize` blocks: each a block more, and its directory entry. */
function allocated(bytes: number, files: number, blockSize: number): number {
  return bytes + files * (blockSize + DIRECTORY_ENTRY_BYTES)
}

/** At most the size of SQLite's rollback journal for a database of `bytes`: each page with its number and checksum, and the header. */
function journalBytes(bytes: number): number {
  return bytes + Math.ceil(bytes / MIN_PAGE_BYTES) * 8 + MAX_SECTOR_BYTES
}

type State =
  | { phase: 'idle' }
  /** An encrypted file waits for its passphrase; `unlocking`: one is being tried. */
  | { phase: 'locked'; path: string; params: EncryptionParams; unlocking: boolean; cancelled: boolean }
  | { phase: 'inspecting'; controller: AbortController; done: Promise<ImportInspection>; keys: ExportKeys | null }
  | { phase: 'inspected'; manifest: ExportManifest; keys: ExportKeys | null }
  | { phase: 'confirming'; done: Promise<ImportConfirmResult> }

const BLOCKS: Readonly<Partial<Record<QuitEnd, ImportBlock>>> = { unchecked: 'unchecked', drafts: 'drafts', workspace: 'workspace' }

export function createImportService(deps: {
  databasePath: string
  /** Schema version this app supports. */
  supportedVersion: number
  status: () => StorageStatus
  database: ImportDatabase
  /** This machine's secret protection (keeps the secrets a file carries). */
  protector: SecretProtector
  /** Quits through the lifecycle to start again (`requestQuit('restart')`); settles with how the quit ended. */
  restart: () => Promise<QuitEnd>
  /** Test seam: tighter container limits. */
  limits?: Partial<ContainerLimits>
  /** Test seam: free bytes and block size of the volume of a directory. */
  volume?: (directory: string) => Promise<{ available: number; blockSize: number }>
}): ImportService {
  const userData = dirname(deps.databasePath)
  const staging = importStagingDirectory(userData)
  const volume = deps.volume ?? (async (directory: string) => {
    const info = await statfs(directory)
    return { available: info.bavail * info.bsize, blockSize: info.bsize > 0 ? info.bsize : DEFAULT_BLOCK_SIZE }
  })
  /** Throws `NoSpace` unless the staging volume has the bytes `needed` gives for its block size free. */
  const roomFor = async (needed: (blockSize: number) => number): Promise<void> => {
    const { available, blockSize } = await volume(staging)
    if (available < needed(blockSize)) throw new NoSpace()
  }
  let state: State = { phase: 'idle' }
  /** The quit the confirmed import started; `stop` keeps its staging. */
  let restarting = false
  /**
   * The press of 导入个人数据… being answered, from the open dialog until the file waits for its
   * passphrase or its check has ended. `cancelled`: 取消 or the quit came before it got that far,
   * so it ends there (dismissed), never asking for a passphrase or starting the check.
   */
  let opening: { cancelled: boolean } | null = null

  const removeStaging = () => rm(staging, { recursive: true, force: true }).catch(() => undefined)

  /** Leaves `state` for idle, wiping the keys it held. */
  function forget(): void {
    if ((state.phase === 'inspecting' || state.phase === 'inspected') && state.keys !== null) wipeKeys(state.keys)
    state = { phase: 'idle' }
  }

  async function check(path: string, signal: AbortSignal, keys: ExportKeys | null): Promise<ImportInspection> {
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    try {
      const { manifest } = await readContainer(path, {
        extractTo: staging,
        limits: deps.limits,
        signal,
        ...(keys === null ? {} : { contentKey: keys.content }),
        checkManifest(manifest) {
          if (manifest.schemaVersion > deps.supportedVersion) throw new Refused({ reason: 'newer', appVersion: manifest.appVersion })
          const { database, draftImages, offlineImages } = manifest.entries
          return roomFor((block) => allocated(database.bytes, database.count, block) + allocated(journalBytes(database.bytes), 1, block)
            + allocated(draftImages.bytes, draftImages.count, block) + allocated(offlineImages.bytes, offlineImages.count, block))
        }
      })
      signal.throwIfAborted()
      try {
        await deps.database.check(staging, manifest.schemaVersion)
      } catch {
        signal.throwIfAborted()
        throw new Refused({ reason: 'corrupt' })
      }
      signal.throwIfAborted()
      let local: { history: number; sendRecords: number }
      let merged: LocalMergeSize
      try {
        local = await deps.database.counts(deps.databasePath)
        merged = await deps.database.appendedBytes(deps.databasePath)
      } catch {
        signal.throwIfAborted()
        return { status: 'failed', failure: { reason: 'read' } }
      }
      signal.throwIfAborted()
      // The staged database as checked (migrated): the merge adds its rows to it and journals its pages.
      const database = (await stat(join(staging, STAGED_DATABASE))).size
      signal.throwIfAborted()
      await roomFor((block) => allocated(merged.fileBytes, merged.files, block) + allocated(merged.rowBytes, 1, block)
        + allocated(journalBytes(database), 1, block))
      signal.throwIfAborted()
      state = { phase: 'inspected', manifest, keys }
      return {
        status: 'ready',
        summary: {
          exportedAt: manifest.exportedAt,
          appVersion: manifest.appVersion,
          offlineThreads: manifest.stats.offlineThreads,
          secrets: manifest.includes.secrets,
          local
        }
      }
    } catch (error) {
      if (signal.aborted) return { status: 'dismissed' }
      if (error instanceof Refused) return { status: 'rejected', rejection: error.rejection }
      if (error instanceof ContainerError) {
        return { status: 'rejected', rejection: { reason: error.kind === 'not-container' ? 'not-export' : 'corrupt' } }
      }
      const code = (error as NodeJS.ErrnoException).code
      return { status: 'failed', failure: { reason: error instanceof NoSpace || code === 'ENOSPC' ? 'space' : 'read' } satisfies ImportFailure }
    }
  }

  function startCheck(path: string, keys: ExportKeys | null): Promise<ImportInspection> {
    const controller = new AbortController()
    const done = (async () => {
      const result = await check(path, controller.signal, keys).catch((): ImportInspection => ({ status: 'failed', failure: { reason: 'read' } }))
      if (result.status !== 'ready') {
        await removeStaging()
        if (keys !== null) wipeKeys(keys)
        state = { phase: 'idle' }
      }
      return result
    })()
    state = { phase: 'inspecting', controller, done, keys }
    return done
  }

  /** The header first: an encrypted file waits for its passphrase, or is refused here. */
  async function inspectFile(path: string, request: { cancelled: boolean }): Promise<ImportInspection> {
    let encryption: EncryptionParams | null
    try {
      encryption = (await readContainerHeader(path, deps.limits)).encryption
    } catch (error) {
      if (request.cancelled) return { status: 'dismissed' }
      if (error instanceof ContainerError) {
        return { status: 'rejected', rejection: { reason: error.kind === 'not-container' ? 'not-export' : 'corrupt' } }
      }
      return { status: 'failed', failure: { reason: 'read' } }
    }
    if (request.cancelled) return { status: 'dismissed' }
    if (encryption === null) return startCheck(path, null)
    // Only a file with secrets is encrypted; they are never kept without this machine's protection.
    const protectable = await deps.protector.isAvailable()
    if (request.cancelled) return { status: 'dismissed' }
    if (!protectable) return { status: 'rejected', rejection: { reason: 'protection' } }
    if (state.phase !== 'idle') return { status: 'failed', failure: { reason: 'busy' } }
    state = { phase: 'locked', path, params: encryption, unlocking: false, cancelled: false }
    return { status: 'passphrase', wrong: false }
  }

  async function prepare(manifest: ExportManifest, keys: ExportKeys | null): Promise<ImportConfirmResult> {
    try {
      let secrets: ImportFileFacts['secrets'] = null
      if (manifest.includes.secrets) {
        if (keys === null) throw new Error('secrets without their key')
        const file = await deps.database.secrets(join(staging, STAGED_DATABASE))
        const local = await deps.database.secrets(deps.databasePath)
        secrets = await resealForImport(file, local, deps.protector, keys.secrets)
      }
      await deps.database.stage(staging, deps.databasePath, { credentialSequence: manifest.credentialSequence, secrets })
      // Rejected while another swap (a restore) is pending, leaving that one as it is.
      beginSwap(userData, preparedImportJournal(userData))
    } catch {
      await removeStaging()
      state = { phase: 'idle' }
      return { status: 'failed' }
    } finally {
      if (keys !== null) wipeKeys(keys)
    }
    restarting = true
    const end = await deps.restart()
    if (end === 'exiting') return { status: 'restarting' }
    // The quit was called off: so is the import, before anything else can start it.
    restarting = false
    try {
      discardSwapJournal(userData)
    } catch {
      // The next start abandons a swap whose staging is gone.
    }
    await removeStaging()
    state = { phase: 'idle' }
    return { status: 'blocked', reason: BLOCKS[end] ?? 'other' }
  }

  return {
    async inspect(chooseFile) {
      if (opening !== null || state.phase === 'inspecting' || state.phase === 'confirming' || (state.phase === 'locked' && state.unlocking)) {
        return { status: 'failed', failure: { reason: 'busy' } }
      }
      if (deps.status().state !== 'ready') return { status: 'failed', failure: { reason: 'storage' } }
      // A file checked before and not confirmed (or still locked) is given up for the new choice.
      if (state.phase === 'inspected' || state.phase === 'locked') {
        forget()
        await removeStaging()
      }
      // Until the file is waiting for a passphrase or its check has ended, another press is busy.
      const request = { cancelled: false }
      opening = request
      try {
        const path = await chooseFile()
        if (path === null || request.cancelled) return { status: 'dismissed' }
        if (state.phase !== 'idle') return { status: 'failed', failure: { reason: 'busy' } }
        if (deps.status().state !== 'ready') return { status: 'failed', failure: { reason: 'storage' } }
        // The staging of a pending swap (never while the app runs normally) is not this import's to touch.
        if (swapPending(userData)) return { status: 'failed', failure: { reason: 'busy' } }
        return await inspectFile(path, request)
      } finally {
        opening = null
      }
    },

    async submitPassphrase(passphrase) {
      const locked = state
      if (locked.phase !== 'locked' || locked.unlocking) return { status: 'failed', failure: { reason: 'busy' } }
      if (deps.status().state !== 'ready') {
        state = { phase: 'idle' }
        return { status: 'failed', failure: { reason: 'storage' } }
      }
      locked.unlocking = true
      let keys: ExportKeys | null
      try {
        keys = await unlockEncryption(passphrase, locked.params)
      } catch {
        keys = null
        if (!locked.cancelled) state = { phase: 'idle' }
        return locked.cancelled ? { status: 'dismissed' } : { status: 'failed', failure: { reason: 'read' } }
      } finally {
        locked.unlocking = false
      }
      if (locked.cancelled || state !== locked) {
        if (keys !== null) wipeKeys(keys)
        return { status: 'dismissed' }
      }
      if (keys === null) return { status: 'passphrase', wrong: true }
      if (swapPending(userData)) {
        wipeKeys(keys)
        state = { phase: 'idle' }
        return { status: 'failed', failure: { reason: 'busy' } }
      }
      state = { phase: 'idle' }
      return startCheck(locked.path, keys)
    },

    confirm() {
      if (state.phase === 'confirming') return state.done
      if (state.phase !== 'inspected' || deps.status().state !== 'ready') return Promise.resolve({ status: 'failed' })
      const done = prepare(state.manifest, state.keys)
      state = { phase: 'confirming', done }
      return done
    },

    async cancel() {
      if (opening !== null) opening.cancelled = true
      if (state.phase === 'inspecting') {
        state.controller.abort()
        deps.database.abort()
        await state.done
      } else if (state.phase === 'locked') {
        state.cancelled = true
        state = { phase: 'idle' }
      } else if (state.phase === 'inspected') {
        forget()
        await removeStaging()
      }
    },

    async stop() {
      if (restarting) return
      if (opening !== null) opening.cancelled = true
      if (state.phase === 'inspecting') {
        state.controller.abort()
        deps.database.abort()
        await state.done
      } else if (state.phase === 'confirming') {
        deps.database.abort()
        await state.done
      } else if (state.phase === 'locked') {
        state.cancelled = true
        state = { phase: 'idle' }
      } else if (state.phase === 'inspected') {
        forget()
        await removeStaging()
      }
    }
  }
}
