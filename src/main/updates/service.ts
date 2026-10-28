import type { AppSettings } from '../../shared/settings'
import {
  UPDATE_CHECK_INTERVAL_MS, type InstallResult, type ReleaseInfo, type UpdateCheckResult, type UpdateDownload,
  type UpdateFailure, type UpdatePlatform, type UpdateState, type UpdateUnavailable
} from '../../shared/updates'
import type { UpdateEngine } from './engine'
import type { ExitReason } from '../lifecycle/controller'
import { classifyUpdateError, compareVersions, isStableVersion } from './release'
import type { PendingInstallStore } from './startup'

/** What survives a restart: the verified package waiting to be installed and the last notified version. */
export interface UpdateRecord {
  /** The newest version an 「发现新版」 notice was shown for. */
  notified: string | null
  ready: { release: ReleaseInfo; sha512: string; path: string } | null
}

export interface UpdateRecordStore {
  load(): Promise<UpdateRecord | null>
  /** May reject; the running state stays as it is. */
  save(record: UpdateRecord): Promise<void>
}

export type UpdateSettings = Pick<AppSettings, 'updateAutoCheck' | 'updateAutoInstall' | 'updateAutoDownload' | 'updateNetwork'>

export interface UpdateServiceDeps {
  platform: UpdatePlatform
  unavailable: UpdateUnavailable | null
  currentVersion: string
  /** Null exactly when `unavailable` is set. */
  engine: UpdateEngine | null
  records: UpdateRecordStore
  pendingInstall: PendingInstallStore
  startupFailure: UpdateFailure | null
  /** SHA-512 (base64) of a file; null when it cannot be read. */
  sha512(path: string): Promise<string | null>
  /** Best effort; a missing file is fine. */
  remove(path: string): Promise<void>
  /** Starts the Windows installer (silent; `restart` reopens the app afterwards). Rejects if it cannot start. */
  runInstaller(path: string, restart: boolean): Promise<void>
  /** Opens the macOS DMG. Rejects if it cannot be opened. */
  openPackage(path: string): Promise<void>
  /** Starts a real quit whose purpose is installing (lifecycle `requestQuit('install')`). */
  requestInstallQuit(): void
  publish(state: UpdateState): void
}

export interface UpdateService {
  /** Cold start: restores a waiting package, then checks once when automatic checks are on. */
  start(settings: UpdateSettings): Promise<void>
  /** Settings changed (automatic check, download/install and network choices). */
  configure(settings: UpdateSettings): void
  state(): UpdateState
  check(): Promise<void>
  download(): Promise<void>
  cancelDownload(): void
  installAndRestart(): Promise<InstallResult>
  openInstaller(): Promise<InstallResult>
  acknowledgeNotice(version: string, kind: 'available' | 'ready'): Promise<void>
  /** Finishing a quit: timers stop and a running download is abandoned (nothing is downloaded at quit). */
  stop(): void
  /** The quit was called off by reopening: automatic checks continue. */
  resume(): void
  /**
   * The process is about to end for `reason`. On Windows, a ready package is confirmed and kept for
   * `launchInstaller` only for `install`, or `quit` with automatic install on; never after `endSession`.
   */
  prepareExit(reason: ExitReason): Promise<void>
  /** After storage has closed: starts the installer prepared by `prepareExit`, if any. */
  launchInstaller(): Promise<void>
  /** Session end never installs now; `draftsLost` is the lifecycle's synchronous current-quit snapshot. */
  endSession(draftsLost: boolean): void
}

/** Timers wake at most this far apart and compare wall-clock time, so sleep or a clock change cannot stretch the 24 hours. */
const MAX_TIMER_MS = 60 * 60 * 1000

export function createUpdateService(deps: UpdateServiceDeps): UpdateService {
  const { engine } = deps
  let settings: UpdateSettings | null = null
  let started = false
  let stopped = false
  let checking = false
  let lastCheck: UpdateCheckResult | null = null
  let lastCheckAt: number | null = null
  let release: { info: ReleaseInfo; sha512: string; download: UpdateDownload; path: string | null } | null = null
  let record: UpdateRecord = { notified: null, ready: null }
  let notice: UpdateState['notice'] = null
  const readyNotified = new Set<string>()
  let timer: NodeJS.Timeout | undefined
  let downloading: AbortController | null = null
  /** Versions whose download the user cancelled: not restarted automatically in this run. */
  const cancelled = new Set<string>()
  let armed: { path: string; restart: boolean } | null = null
  /** The operating system is ending the session: no installer starts in this process any more. */
  let sessionEnded = false
  /** The version the engine's last successful check offered; it can only download that one. */
  let offered: string | null = null

  function state(): UpdateState {
    return {
      currentVersion: deps.currentVersion,
      platform: deps.platform,
      unavailable: deps.unavailable,
      checking,
      lastCheck,
      release: release === null ? null : { info: release.info, download: release.download },
      installOnQuit: deps.platform === 'windows' && settings?.updateAutoInstall === true && release?.download.status === 'ready',
      startupFailure: deps.startupFailure,
      notice
    }
  }

  const publish = () => deps.publish(state())

  async function persist(next: UpdateRecord): Promise<void> {
    record = next
    try {
      await deps.records.save(next)
    } catch {
      console.error('[updates] state not saved')
    }
  }

  const automaticDownload = () =>
    deps.platform === 'windows' ? settings?.updateAutoInstall === true : settings?.updateAutoDownload === true

  function schedule(): void {
    clearTimeout(timer)
    timer = undefined
    if (stopped || engine === null || settings?.updateAutoCheck !== true) return
    const due = lastCheckAt === null ? Date.now() : lastCheckAt + UPDATE_CHECK_INTERVAL_MS
    const wait = Math.max(0, due - Date.now())
    timer = setTimeout(() => {
      timer = undefined
      if (lastCheckAt === null || Date.now() >= lastCheckAt + UPDATE_CHECK_INTERVAL_MS) void runCheck()
      else schedule()
    }, Math.min(wait, MAX_TIMER_MS))
  }

  /** Drops a waiting package (superseded, installed or corrupt). */
  async function discardReady(): Promise<void> {
    const ready = record.ready
    if (ready === null) return
    await persist({ ...record, ready: null })
    await deps.remove(ready.path)
  }

  async function runCheck(): Promise<void> {
    const busy = release?.download.status === 'downloading' || release?.download.status === 'verifying'
    if (engine === null || settings === null || stopped || checking || busy) return
    checking = true
    publish()
    let outcome: UpdateCheckResult
    try {
      await engine.setNetwork(settings.updateNetwork)
      const result = await engine.check()
      if (result.kind === 'up-to-date') {
        offered = null
        // A release no longer offered is forgotten, unless its verified package is already here.
        if (release !== null && release.download.status !== 'ready') release = null
        outcome = { at: new Date().toISOString(), outcome: 'up-to-date', failure: null }
      } else {
        const found = result.release
        offered = found.info.version
        if (release !== null && release.info.version === found.info.version && release.sha512 === found.sha512) {
          release.info = found.info
        } else {
          if (release?.download.status === 'ready') await discardReady()
          release = { info: found.info, sha512: found.sha512, download: { status: 'none', failure: null, cancelled: false }, path: null }
        }
        if (record.notified !== found.info.version && release.download.status !== 'ready') notice = { version: found.info.version, kind: 'available' }
        outcome = { at: new Date().toISOString(), outcome: 'available', failure: null }
      }
    } catch (error) {
      outcome = { at: new Date().toISOString(), outcome: 'failed', failure: classifyUpdateError(error) }
    }
    checking = false
    lastCheck = outcome
    lastCheckAt = Date.now()
    schedule()
    publish()
    const current = release
    if (current !== null && current.download.status === 'none' && automaticDownload() && !cancelled.has(current.info.version)) {
      await download()
    }
  }

  async function download(): Promise<void> {
    const current = release
    const downloadable = () => engine !== null && settings !== null && !stopped && !checking && current !== null && current.download.status === 'none'
    if (!downloadable() || current === null || engine === null || settings === null) return
    // A package restored from disk whose file went missing: the engine must be offered it again first.
    if (offered !== current.info.version) {
      await runCheck()
      if (release !== current || offered !== current.info.version || !downloadable()) return
    }
    const abort = new AbortController()
    downloading = abort
    current.download = { status: 'downloading', transferred: 0, total: null }
    publish()
    try {
      await engine.setNetwork(settings.updateNetwork)
      // Cancelled (or quitting) while the network was being set up: no transfer starts.
      if (abort.signal.aborted) throw new Error('cancelled')
      const path = await engine.download((transferred, total) => {
        if (abort.signal.aborted || release !== current) return
        // All bytes are in: the checksum is being confirmed and nothing can be installed yet.
        current.download = total !== null && transferred >= total ? { status: 'verifying' } : { status: 'downloading', transferred, total }
        publish()
      }, abort.signal)
      if (abort.signal.aborted) throw new Error('cancelled')
      current.path = path
      current.download = { status: 'ready' }
      await persist({ ...record, ready: { release: current.info, sha512: current.sha512, path } })
      if (!readyNotified.has(current.info.version)) notice = { version: current.info.version, kind: 'ready' }
    } catch (error) {
      current.download = abort.signal.aborted
        ? { status: 'none', failure: null, cancelled: true }
        : { status: 'none', failure: classifyUpdateError(error), cancelled: false }
    } finally {
      if (downloading === abort) downloading = null
    }
    publish()
    // An automatic check that fell due during the download runs now (or is scheduled as before).
    schedule()
  }

  /** The waiting package, confirmed against its checksum; a missing or changed one is discarded. */
  async function confirmedPackage(): Promise<{ ok: true; path: string } | { ok: false; failure: UpdateFailure | 'not-ready' }> {
    const current = release
    if (current === null || current.download.status !== 'ready' || current.path === null) return { ok: false, failure: 'not-ready' }
    const digest = await deps.sha512(current.path)
    if (digest === current.sha512) return { ok: true, path: current.path }
    const failure: UpdateFailure = digest === null ? 'storage' : 'integrity'
    await discardReady()
    if (release === current) {
      current.path = null
      current.download = { status: 'none', failure, cancelled: false }
      publish()
    }
    return { ok: false, failure }
  }

  return {
    async start(initial) {
      if (started) return
      started = true
      settings = initial
      const stored = await deps.records.load().catch(() => null)
      if (stored !== null) record = stored
      const ready = record.ready
      if (ready !== null) {
        const newer = isStableVersion(ready.release.version) && isStableVersion(deps.currentVersion) &&
          compareVersions(ready.release.version, deps.currentVersion) > 0
        // Installed (or older) packages are removed; a waiting one must still match its checksum.
        if (deps.unavailable !== null || !newer || (await deps.sha512(ready.path)) !== ready.sha512) await discardReady()
        else {
          release = { info: ready.release, sha512: ready.sha512, download: { status: 'ready' }, path: ready.path }
          notice = { version: ready.release.version, kind: 'ready' }
        }
      }
      publish()
      if (settings.updateAutoCheck) await runCheck()
      else schedule()
    },

    configure(next) {
      const previous = settings
      settings = next
      if (!started) return
      if (previous?.updateAutoCheck !== next.updateAutoCheck) schedule()
      publish()
      const current = release
      if (current !== null && current.download.status === 'none' && automaticDownload() && !cancelled.has(current.info.version) && !checking) {
        void download()
      }
    },

    state,

    check: runCheck,

    download,

    cancelDownload() {
      const current = release
      if (downloading === null || current === null) return
      cancelled.add(current.info.version)
      downloading.abort()
    },

    async installAndRestart() {
      if (deps.platform !== 'windows' || release?.download.status !== 'ready') return { started: false, failure: 'not-ready' }
      const confirmed = await confirmedPackage()
      if (!confirmed.ok) return { started: false, failure: confirmed.failure }
      deps.requestInstallQuit()
      return { started: true }
    },

    async openInstaller() {
      if (deps.platform !== 'mac' || release?.download.status !== 'ready') return { started: false, failure: 'not-ready' }
      const confirmed = await confirmedPackage()
      if (!confirmed.ok) return { started: false, failure: confirmed.failure }
      try {
        await deps.openPackage(confirmed.path)
        return { started: true }
      } catch {
        return { started: false, failure: 'install' }
      }
    },

    async acknowledgeNotice(version, kind) {
      // A discovery notice can be acted on just as a download finishes; it must not clear ready.
      if (kind === 'available' && record.notified !== version) await persist({ ...record, notified: version })
      if (notice === null || notice.version !== version || notice.kind !== kind) return
      if (kind === 'ready') readyNotified.add(version)
      notice = null
      publish()
    },

    stop() {
      stopped = true
      clearTimeout(timer)
      timer = undefined
      downloading?.abort()
    },

    resume() {
      if (!stopped) return
      stopped = false
      if (started) schedule()
    },

    async prepareExit(reason) {
      armed = null
      const allowed = reason === 'install' || (reason === 'quit' && settings?.updateAutoInstall === true)
      if (deps.platform !== 'windows' || sessionEnded || !allowed || release?.download.status !== 'ready') return
      const confirmed = await confirmedPackage()
      if (confirmed.ok && !sessionEnded) armed = { path: confirmed.path, restart: reason === 'install' }
    },

    async launchInstaller() {
      const pending = armed
      armed = null
      if (pending === null || sessionEnded) return
      try {
        await deps.runInstaller(pending.path, pending.restart)
      } catch {
        // The package stays; the next start shows it ready again and the running version is unchanged.
        console.error('[updates] installer did not start')
      }
    },

    endSession(draftsLost) {
      if (sessionEnded) return
      sessionEnded = true
      armed = null
      if (deps.platform !== 'windows' || deps.unavailable !== null || draftsLost ||
          settings?.updateAutoInstall !== true || release?.download.status !== 'ready' || record.ready === null) return
      try {
        deps.pendingInstall.save(record.ready)
      } catch {
        console.error('[updates] startup installation not saved')
      }
    }
  }
}
