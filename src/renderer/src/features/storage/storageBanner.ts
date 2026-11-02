import type { StorageStatus, UpgradeRestartResult } from '../../../../shared/api'

/**
 * The window-top strip for storage that takes no writes this run. `upgrade`: the pre-upgrade backup
 * failed, so 重新启动重试 and 不备份升级… are offered.
 */
export interface StorageBannerView {
  text: string
  upgrade: boolean
}

export function storageBanner(storage: StorageStatus | null): StorageBannerView | null {
  if (storage === null || storage.state === 'ready') return null
  if (storage.state === 'read-only') return { text: '数据库只读，新内容不会保存', upgrade: false }
  if (storage.reason === 'backup-failed') return { text: '升级前未能备份数据，数据尚未升级，当前不会保存新内容。', upgrade: true }
  return { text: '本地存储不可用，内容不会保存', upgrade: false }
}

/**
 * Which of the two restarts is running (`null`: none). While one runs, neither can start again;
 * any answer ends it (a restart that went ahead is now the quit's).
 */
export type UpgradeRestart = 'retry' | 'without-backup' | null

/** What the 不备份直接升级？ dialog shows after its request answered. */
export type WithoutBackupOutcome = 'close' | 'failed'

export function withoutBackupOutcome(result: UpgradeRestartResult | null): WithoutBackupOutcome {
  return result?.status === 'restarting' ? 'close' : 'failed'
}
