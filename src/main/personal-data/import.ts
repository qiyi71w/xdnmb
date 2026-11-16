import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import type {
  ImportBlock, ImportConfirmResult, ImportFailure, ImportInspection, ImportRejection, StorageStatus
} from '../../shared/api'
import type { QuitEnd } from '../lifecycle/controller'
import { importStagingDirectory, preparedImportJournal } from '../storage/import-journal'
import type { CredentialIdMap, ImportFileFacts } from '../storage/import-staging'
import { beginSwap, discardSwapJournal, swapPending } from '../storage/swap-journal'
import { ContainerError, readContainer, type ContainerLimits, type ExportManifest } from './container'

/*
 * 导入个人数据 (see docs/development.md): the open dialog, every check of the chosen file before the
 * confirmation, then, once confirmed, the import result built in staging, the swap begun and the
 * app restarted through the ordinary quit; the next start swaps the data (`../storage/import-journal`).
 *
 * The file is untrusted. Its content is only ever written into the import staging directory
 * (`backups/import-staging/`), and this machine's database is only read until the next start.
 * Inspection, in order:
 *
 *   1. Container: magic, container version, header, entry names and lengths, limits, the manifest
 *      (`./container`). Where 05 adds encryption, an encrypted header asks for the passphrase here
 *      and the entries are decrypted as they are read; until then such a file is refused.
 *   2. The manifest's schema version: newer than this app's is refused, naming the version that
 *      exported it, before any entry is extracted.
 *   3. The staged database (`../storage/import-staging`): integrity, this version's migration
 *      chain, schema, references, and every draft attachment and offline original it names.
 *   4. What the confirmation shows: the manifest's facts and this machine's counts.
 *
 * Any failure removes the staging; this machine's data and the file are unchanged. The renderer
 * gets file facts and counts only, never a path.
 */

/** The SQLite work, off the main thread in the app. `abort` ends whatever runs; its promise rejects. */
export interface ImportDatabase {
  /** Checks the extracted database and migrates it in staging; rejects when it cannot be imported. */
  check(stagingDirectory: string, schemaVersion: number): Promise<void>
  /** This machine's 浏览历史 and 发送记录 counts. */
  counts(databasePath: string): Promise<{ history: number; sendRecords: number }>
  /** Builds the import result in staging (`stageImport`). */
  stage(stagingDirectory: string, databasePath: string, file: ImportFileFacts): Promise<{ credentialIds: CredentialIdMap }>
  abort(): void
}

export interface ImportService {
  /** `chooseFile` shows the open dialog; null when dismissed. */
  inspect(chooseFile: () => Promise<string | null>): Promise<ImportInspection>
  /** Once per checked file; repeated while it runs, the same result. */
  confirm(): Promise<ImportConfirmResult>
  /** Gives up a file being checked or checked; nothing while the import is being prepared or carried out. */
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

type State =
  | { phase: 'idle' }
  | { phase: 'inspecting'; controller: AbortController; done: Promise<ImportInspection> }
  | { phase: 'inspected'; manifest: ExportManifest }
  | { phase: 'confirming'; done: Promise<ImportConfirmResult> }

const BLOCKS: Readonly<Partial<Record<QuitEnd, ImportBlock>>> = { unchecked: 'unchecked', drafts: 'drafts', workspace: 'workspace' }

export function createImportService(deps: {
  databasePath: string
  /** Schema version this app supports. */
  supportedVersion: number
  status: () => StorageStatus
  database: ImportDatabase
  /** Quits through the lifecycle to start again (`requestQuit('restart')`); settles with how the quit ended. */
  restart: () => Promise<QuitEnd>
  /** Test seam: tighter container limits. */
  limits?: Partial<ContainerLimits>
}): ImportService {
  const userData = dirname(deps.databasePath)
  const staging = importStagingDirectory(userData)
  let state: State = { phase: 'idle' }
  /** The quit the confirmed import started; `stop` keeps its staging. */
  let restarting = false
  /** The open dialog is showing. */
  let choosing = false

  const removeStaging = () => rm(staging, { recursive: true, force: true }).catch(() => undefined)

  async function check(path: string, signal: AbortSignal): Promise<ImportInspection> {
    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    try {
      const { header, manifest } = await readContainer(path, {
        extractTo: staging,
        limits: deps.limits,
        signal,
        checkManifest(manifest) {
          if (manifest.schemaVersion > deps.supportedVersion) throw new Refused({ reason: 'newer', appVersion: manifest.appVersion })
          // Secrets travel only encrypted, which this version does not read.
          if (manifest.includes.secrets) throw new ContainerError('unsupported')
        }
      })
      if (header.encryption !== null) throw new ContainerError('unsupported')
      signal.throwIfAborted()
      try {
        await deps.database.check(staging, manifest.schemaVersion)
      } catch {
        signal.throwIfAborted()
        throw new Refused({ reason: 'corrupt' })
      }
      signal.throwIfAborted()
      let local: { history: number; sendRecords: number }
      try {
        local = await deps.database.counts(deps.databasePath)
      } catch {
        signal.throwIfAborted()
        return { status: 'failed', failure: { reason: 'read' } }
      }
      signal.throwIfAborted()
      state = { phase: 'inspected', manifest }
      return {
        status: 'ready',
        summary: { exportedAt: manifest.exportedAt, appVersion: manifest.appVersion, offlineThreads: manifest.stats.offlineThreads, local }
      }
    } catch (error) {
      if (signal.aborted) return { status: 'dismissed' }
      if (error instanceof Refused) return { status: 'rejected', rejection: error.rejection }
      if (error instanceof ContainerError) {
        return { status: 'rejected', rejection: { reason: error.kind === 'not-container' ? 'not-export' : 'corrupt' } }
      }
      const code = (error as NodeJS.ErrnoException).code
      return { status: 'failed', failure: { reason: code === 'ENOSPC' ? 'space' : 'read' } satisfies ImportFailure }
    }
  }

  async function inspectFile(path: string, controller: AbortController): Promise<ImportInspection> {
    const result = await check(path, controller.signal).catch((): ImportInspection => ({ status: 'failed', failure: { reason: 'read' } }))
    if (result.status !== 'ready') {
      await removeStaging()
      state = { phase: 'idle' }
    }
    return result
  }

  async function prepare(manifest: ExportManifest): Promise<ImportConfirmResult> {
    try {
      await deps.database.stage(staging, deps.databasePath, { credentialSequence: manifest.credentialSequence, secrets: manifest.includes.secrets })
      // Rejected while another swap (a restore) is pending, leaving that one as it is.
      beginSwap(userData, preparedImportJournal(userData))
    } catch {
      await removeStaging()
      state = { phase: 'idle' }
      return { status: 'failed' }
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
      if (choosing || state.phase === 'inspecting' || state.phase === 'confirming') return { status: 'failed', failure: { reason: 'busy' } }
      if (deps.status().state !== 'ready') return { status: 'failed', failure: { reason: 'storage' } }
      // A file checked before and not confirmed is given up for the new choice.
      if (state.phase === 'inspected') {
        state = { phase: 'idle' }
        await removeStaging()
      }
      choosing = true
      let path: string | null
      try {
        path = await chooseFile()
      } finally {
        choosing = false
      }
      if (path === null) return { status: 'dismissed' }
      if (state.phase !== 'idle') return { status: 'failed', failure: { reason: 'busy' } }
      if (deps.status().state !== 'ready') return { status: 'failed', failure: { reason: 'storage' } }
      // The staging of a pending swap (never while the app runs normally) is not this import's to touch.
      if (swapPending(userData)) return { status: 'failed', failure: { reason: 'busy' } }
      const controller = new AbortController()
      const done = inspectFile(path, controller)
      state = { phase: 'inspecting', controller, done }
      return done
    },

    confirm() {
      if (state.phase === 'confirming') return state.done
      if (state.phase !== 'inspected' || deps.status().state !== 'ready') return Promise.resolve({ status: 'failed' })
      const done = prepare(state.manifest)
      state = { phase: 'confirming', done }
      return done
    },

    async cancel() {
      if (state.phase === 'inspecting') {
        state.controller.abort()
        deps.database.abort()
        await state.done
      } else if (state.phase === 'inspected') {
        state = { phase: 'idle' }
        await removeStaging()
      }
    },

    async stop() {
      if (restarting) return
      if (state.phase === 'inspecting') {
        state.controller.abort()
        deps.database.abort()
        await state.done
      } else if (state.phase === 'confirming') {
        deps.database.abort()
        await state.done
      } else if (state.phase === 'inspected') {
        state = { phase: 'idle' }
        await removeStaging()
      }
    }
  }
}
