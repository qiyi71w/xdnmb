import type { UpdateFailure } from '../../shared/updates'
import type { UpdateRecord } from './service'
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
  /** Visible NSIS progress, then opens the installed version; resolves only when the process starts. */
  runInstaller(path: string): Promise<void>
}

/** Called only by the primary, installed Windows process, before storage or application windows open. */
export async function installPendingUpdate(deps: StartupInstallDeps): Promise<{ started: boolean; failure: UpdateFailure | null }> {
  let ready: ReadyPackage | null
  try {
    ready = deps.pending.consume()
  } catch {
    return { started: false, failure: 'storage' }
  }
  if (ready === null) return { started: false, failure: null }
  if (!isStableVersion(deps.currentVersion) || compareVersions(ready.release.version, deps.currentVersion) <= 0) {
    await deps.remove(ready.path)
    return { started: false, failure: null }
  }
  const digest = await deps.sha512(ready.path)
  if (digest !== ready.sha512) {
    await deps.remove(ready.path)
    return { started: false, failure: digest === null ? 'storage' : 'integrity' }
  }
  if (deps.sessionEnding()) return { started: false, failure: null }
  try {
    await deps.runInstaller(ready.path)
    return { started: true, failure: null }
  } catch {
    return { started: false, failure: 'install' }
  }
}
