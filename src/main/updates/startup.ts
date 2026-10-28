import type { InstallFailure, UpdateFailure } from '../../shared/updates'
import type { InstallMarkerStore, UpdateRecord } from './service'
import { compareVersions, isStableVersion } from './release'

export type ReadyPackage = NonNullable<UpdateRecord['ready']>

/** Separate from the asynchronously saved update state: session-end must finish its write immediately. */
export interface PendingInstallStore {
  save(ready: ReadyPackage): void
  /** Removes the marker before returning its package. Throws if consumption cannot be made durable. */
  consume(): ReadyPackage | null
}

interface StartupInstallDeps {
  currentVersion: string
  sessionEnding(): boolean
  pending: PendingInstallStore
  sha512(path: string): Promise<string | null>
  remove(path: string): Promise<void>
  /**
   * Visible NSIS progress, then the installer opens the installed version. Installing closes this
   * process, so it resolves only when the installer ended without installing; rejects when it cannot start.
   */
  runInstaller(path: string): Promise<void>
}

/**
 * Called only by the primary, installed Windows process, before storage or application windows open.
 * Returns only when this process goes on running the current version (nothing to install, or the
 * installation did not happen).
 */
export async function installPendingUpdate(deps: StartupInstallDeps): Promise<{ failure: UpdateFailure | null }> {
  let ready: ReadyPackage | null
  try {
    ready = deps.pending.consume()
  } catch {
    return { failure: 'storage' }
  }
  if (ready === null) return { failure: null }
  if (!isStableVersion(deps.currentVersion) || compareVersions(ready.release.version, deps.currentVersion) <= 0) {
    await deps.remove(ready.path)
    return { failure: null }
  }
  const digest = await deps.sha512(ready.path)
  if (digest !== ready.sha512) {
    await deps.remove(ready.path)
    return { failure: digest === null ? 'storage' : 'integrity' }
  }
  if (deps.sessionEnding()) return { failure: null }
  try {
    await deps.runInstaller(ready.path)
    // Still running: the installer ended before replacing this version (e.g. approval refused).
    // The package stays for 「安装并重启」 or the next quit; this start does not try again.
    return { failure: 'incomplete' }
  } catch {
    return { failure: 'install' }
  }
}

/**
 * Whether the installer started when the app last quit replaced it: the version it was to install
 * is newer than the one now running when it did not (approval refused, the installer failed or was
 * stopped). Consumes the marker either way.
 */
export function exitInstallFailure(marker: InstallMarkerStore, currentVersion: string): InstallFailure | null {
  let target: string | null
  try {
    target = marker.take()
  } catch {
    console.error('[updates] install marker not read')
    return null
  }
  if (target === null || !isStableVersion(currentVersion) || compareVersions(target, currentVersion) <= 0) return null
  return { when: 'exit', failure: 'incomplete' }
}
