import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { app } from 'electron'
import { BaseUpdater, CancellationToken, type ProgressInfo } from 'electron-updater'
import type { DownloadUpdateOptions } from 'electron-updater/out/AppUpdater'
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import type { ReleaseInfo, UpdateNetwork, UpdatePlatform, UpdateUnavailable } from '../../shared/updates'
import { releaseNotesFromHtml } from './notes'
import {
  compareVersions, isAllowedUpdateRequest, isStableVersion, releaseDateOf, releasePageUrl, ReleaseSourceError,
  selectPackage, UPDATE_OWNER, UPDATE_REPO, type PackageTarget
} from './release'

/** A release newer than the running app, validated for this installation. */
export interface FoundRelease {
  info: ReleaseInfo
  /** SHA-512 (base64) the release metadata binds to this installation's package. */
  sha512: string
}

export type EngineCheck = { kind: 'up-to-date' } | { kind: 'newer'; release: FoundRelease }

/** Checking and downloading over the update-only network session. */
export interface UpdateEngine {
  /** Applies the network choice to later update requests (new connections). */
  setNetwork(mode: UpdateNetwork): Promise<void>
  check(): Promise<EngineCheck>
  /**
   * Downloads the package of the release found by the last `check` into the updater cache; resolves
   * with its path once the bytes match the metadata's SHA-512. Rejects on abort, failure or mismatch.
   */
  download(onProgress: (transferred: number, total: number | null) => void, signal: AbortSignal): Promise<string>
}

/**
 * electron-updater on the fixed GitHub source. The provider options are passed here (never read from
 * `app-update.yml`), pre-releases and downgrades are refused, and nothing is installed by the library:
 * the quit coordinator starts the installer itself (see `files.ts`). Both platforms share this
 * path; they differ only in which file of the metadata they take.
 */
class ReleasePackageUpdater extends BaseUpdater {
  /** The library's own executor: requests go through the same `electron-updater` session (proxy and request filter). */
  private readonly downloader = new ElectronHttpExecutor()

  constructor(private readonly target: PackageTarget) {
    super({ provider: 'github', owner: UPDATE_OWNER, repo: UPDATE_REPO, releaseType: 'release' })
    this.autoDownload = false
    this.autoInstallOnAppQuit = false
    this.autoRunAppAfterInstall = false
    this.allowPrerelease = false
    this.allowDowngrade = false
    this.fullChangelog = false
    this.disableWebInstaller = true
    // Always the whole file, so the one SHA-512 of the metadata covers every byte installed.
    this.disableDifferentialDownload = true
    // Library messages can embed whole feed documents; failures are classified by the caller.
    this.logger = null
  }

  protected doDownloadUpdate(options: DownloadUpdateOptions): Promise<string[]> {
    const { info, provider } = options.updateInfoAndProvider
    const chosen = selectPackage(info.version, info.files, this.target)
    const fileInfo = chosen === null ? undefined : provider.resolveFiles(info).find((file) => file.info.url === chosen.url)
    if (chosen === null || fileInfo === undefined || !isAllowedUpdateRequest(fileInfo.url.href) || !fileInfo.url.pathname.endsWith(`/${chosen.url}`)) {
      return Promise.reject(new ReleaseSourceError('package not offered for this installation'))
    }
    return this.executeDownload({
      fileExtension: this.target.platform === 'windows' ? 'exe' : 'dmg',
      fileInfo,
      downloadUpdateOptions: options,
      task: async (destination, downloadOptions) => {
        await this.downloader.download(fileInfo.url, destination, downloadOptions)
      }
    })
  }

  /** Never installs: see the class comment. */
  protected doInstall(): boolean {
    return false
  }
}

/** Platform, package target and why this build cannot update itself, if it cannot. */
export function updateAvailability(): { platform: UpdatePlatform; target: PackageTarget | null; unavailable: UpdateUnavailable | null } {
  const configured = app.isPackaged && existsSync(join(process.resourcesPath, 'app-update.yml'))
  if (process.platform === 'win32') {
    // Only the NSIS installation updates itself: it leaves `Uninstall <executable name>.exe` beside the
    // app (`Uninstall xidao.exe`); an unpacked copy of the app is not an installation.
    const exe = app.getPath('exe')
    const installed = configured && existsSync(join(dirname(exe), `Uninstall ${basename(exe)}`))
    return { platform: 'windows', target: { platform: 'windows' }, unavailable: installed ? null : 'not-installed' }
  }
  if (process.platform === 'darwin') {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
    return { platform: 'mac', target: { platform: 'mac', arch }, unavailable: configured ? null : 'not-installed' }
  }
  return { platform: 'none', target: null, unavailable: 'platform' }
}

export function createUpdateEngine(target: PackageTarget): UpdateEngine {
  const updater = new ReleasePackageUpdater(target)
  // Without a listener an 'error' event would throw; failures already reject the calls below.
  updater.on('error', () => undefined)
  const network = updater.netSession
  // Every request and redirect hop of the update session; anything else is cancelled.
  network.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !isAllowedUpdateRequest(details.url) }))
  // The session is in memory and separate from the forum's; no cookie or credential is ever sent.
  network.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders }
    for (const name of Object.keys(headers)) {
      if (/^(cookie|authorization|proxy-authorization)$/i.test(name)) delete headers[name]
    }
    callback({ requestHeaders: headers })
  })
  let appliedNetwork: UpdateNetwork | null = null

  return {
    async setNetwork(mode) {
      if (mode === appliedNetwork) return
      // `system` is the operating system's proxy policy (not environment variables); `direct` uses none.
      await network.setProxy({ mode })
      await network.closeAllConnections()
      appliedNetwork = mode
    },

    async check() {
      const result = await updater.checkForUpdates()
      if (result === null) throw new ReleaseSourceError('updater inactive')
      const metadata = result.updateInfo
      if (!result.isUpdateAvailable) return { kind: 'up-to-date' }
      const { version } = metadata
      const current = app.getVersion()
      if (!isStableVersion(version) || !isStableVersion(current) || compareVersions(version, current) <= 0) {
        throw new ReleaseSourceError('not a newer stable version')
      }
      const file = selectPackage(version, metadata.files, target)
      const tag = 'tag' in metadata ? metadata.tag : undefined
      const pageUrl = releasePageUrl(tag, version)
      if (file === null || pageUrl === null) throw new ReleaseSourceError('package not offered for this installation')
      const notes = releaseNotesFromHtml(typeof metadata.releaseNotes === 'string' ? metadata.releaseNotes : null, pageUrl)
      return { kind: 'newer', release: { info: { version, releaseDate: releaseDateOf(metadata.releaseDate), notes, pageUrl }, sha512: file.sha512 } }
    },

    async download(onProgress, signal) {
      const token = new CancellationToken()
      const abort = () => token.cancel()
      signal.addEventListener('abort', abort)
      const progress = (info: ProgressInfo) => onProgress(info.transferred, info.total > 0 ? info.total : null)
      updater.on('download-progress', progress)
      try {
        const [file] = await updater.downloadUpdate(token)
        if (file === undefined) throw new ReleaseSourceError('no file downloaded')
        return file
      } finally {
        updater.off('download-progress', progress)
        signal.removeEventListener('abort', abort)
      }
    }
  }
}
