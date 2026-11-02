import type { StorageStatus, UpgradeRestartResult } from '../../shared/api'

/**
 * The two ways on from a failed pre-upgrade backup. Both end this run through the ordinary quit and
 * start the app again; the database is upgraded (or the backup retried) only by that new start.
 */
export interface UpgradeService {
  /** 重新启动重试: the next start tries the backup and the upgrade again. */
  restartToRetry(): Promise<UpgradeRestartResult>
  /** 不备份升级: the next start upgrades the same database once without a backup. */
  restartWithoutBackup(): Promise<UpgradeRestartResult>
}

export function createUpgradeService(deps: {
  status: () => StorageStatus
  /** Records 不备份升级 for the next start (`markUpgradeWithoutBackup`). */
  markWithoutBackup: (schemaVersion: number) => Promise<void>
  /** Quits through the lifecycle and starts the app again (`requestQuit('restart')`). */
  restart: () => void
}): UpgradeService {
  const backupFailed = () => {
    const status = deps.status()
    return status.state === 'unavailable' && status.reason === 'backup-failed' ? status : null
  }
  return {
    async restartToRetry() {
      if (backupFailed() === null) return { status: 'not-applicable' }
      deps.restart()
      return { status: 'restarting' }
    },
    async restartWithoutBackup() {
      const failed = backupFailed()
      if (failed === null) return { status: 'not-applicable' }
      try {
        await deps.markWithoutBackup(failed.schemaVersion)
      } catch {
        return { status: 'failed' }
      }
      deps.restart()
      return { status: 'restarting' }
    }
  }
}
