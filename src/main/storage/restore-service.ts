import type { RestoreInfo, RestoreResult } from '../../shared/api'
import type { AppStore } from './contract'

/**
 * 恢复升级前备份 from the read-only banner: what the confirmation shows, and 恢复并重新启动. Only
 * while a newer version's data is open read-only. The restore is staged by the storage worker and
 * carried out by the next start, before the database is opened (see `./restore-journal`).
 */
export interface RestoreService {
  info(): Promise<RestoreInfo>
  /** Prepares once; while preparing, or once prepared, a repeated request starts nothing. */
  restoreAndRestart(): Promise<RestoreResult>
}

export function createRestoreService(deps: {
  store: Pick<AppStore, 'status' | 'restoreInfo' | 'prepareRestore'>
  /** Quits through the lifecycle and starts the app again (`requestQuit('restart')`). */
  restart: () => void
}): RestoreService {
  let running: Promise<RestoreResult> | null = null
  let prepared = false

  const prepare = async (): Promise<RestoreResult> => {
    try {
      const outcome = await deps.store.prepareRestore()
      if (outcome !== 'prepared') return { status: outcome }
      prepared = true
      deps.restart()
      return { status: 'restarting' }
    } catch {
      return { status: 'failed' }
    } finally {
      running = null
    }
  }

  return {
    async info() {
      if (deps.store.status.state !== 'read-only') return { restorable: false }
      try {
        const info = await deps.store.restoreInfo()
        // Exactly the documented fields cross to the renderer.
        return info.restorable
          ? { restorable: true, backupCompletedAt: info.backupCompletedAt, sourceVersion: info.sourceVersion, secretsReadable: info.secretsReadable }
          : { restorable: false }
      } catch {
        return { restorable: false }
      }
    },
    restoreAndRestart() {
      if (prepared) return Promise.resolve({ status: 'restarting' })
      if (running !== null) return running
      if (deps.store.status.state !== 'read-only') return Promise.resolve({ status: 'not-applicable' })
      running = prepare()
      return running
    }
  }
}
