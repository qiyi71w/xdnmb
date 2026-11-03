import type { RestoreInfo, RestoreResult, StorageStatus, UpgradeRestartResult } from '../../../../shared/api'
import { UPDATE_REPOSITORY_URL } from '../../../../shared/updates'

/**
 * The strip under the tab bar for storage that takes no writes this run. `upgrade`: the pre-upgrade backup
 * failed, so 重新启动重试 and 不备份升级… are offered. `newer`: the data is a newer version's, so
 * 了解更多 is offered, and 恢复升级前备份… when a backup can be restored.
 */
export interface StorageBannerView {
  text: string
  actions: 'upgrade' | 'newer' | null
}

export function storageBanner(storage: StorageStatus | null): StorageBannerView | null {
  if (storage === null || storage.state === 'ready') return null
  if (storage.state === 'read-only') {
    return { text: '数据来自更新版本的汐岛，这里只能查看、改动不会保存。', actions: 'newer' }
  }
  if (storage.reason === 'backup-failed') return { text: '升级前的备份没有成功，数据还未升级，暂时不会保存改动。', actions: 'upgrade' }
  return { text: '本地存储不可用，内容不会保存', actions: null }
}

/** Shown for the run in which a prepared restore was given up. */
export const RESTORE_ABANDONED_TEXT = '恢复没有完成，数据没有改动。'

/** 了解更多: the public developer docs' section on downgrading and the pre-upgrade backup. */
export const DOWNGRADE_DOCS_URL = `${UPDATE_REPOSITORY_URL}/blob/main/docs/development.md#降级与恢复升级前备份`

/**
 * Which of the two restarts is running (`null`: none). While one runs, neither can start again;
 * any answer ends it (a restart that went ahead is now the quit's).
 */
export type UpgradeRestart = 'retry' | 'without-backup' | null

/**
 * What a confirmation that restarts (不备份直接升级？, 恢复升级前备份？) shows after its request
 * answered: it closes once the restart went ahead, and otherwise stays open saying nothing changed.
 */
export function restartOutcome(result: UpgradeRestartResult | RestoreResult | null): 'close' | 'failed' {
  return result?.status === 'restarting' ? 'close' : 'failed'
}

/** The 恢复升级前备份？ dialog's secrets sentence, by whether the newer data's secrets are understood. */
export function restoreSecretsText(info: Extract<RestoreInfo, { restorable: true }>): string {
  return info.secretsReadable ? '升级后移除的饼干和退出的官网登录不会恢复。' : '饼干和官网登录需要重新导入。'
}
