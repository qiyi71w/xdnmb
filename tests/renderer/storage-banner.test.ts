import { expect, it } from 'vitest'
import { DOWNGRADE_DOCS_URL, restartOutcome, restoreSecretsText, storageBanner } from '../../src/renderer/src/features/storage/storageBannerModel'

it('offers the upgrade restarts after a failed pre-upgrade backup and the restore entry for newer data', () => {
  expect(storageBanner(null)).toBeNull()
  expect(storageBanner({ state: 'ready', schemaVersion: 27 })).toBeNull()
  expect(storageBanner({ state: 'unavailable', reason: 'backup-failed', schemaVersion: 26, supportedVersion: 27 })?.actions).toBe('upgrade')
  expect(storageBanner({ state: 'unavailable', reason: 'open-failed' })?.actions).toBeNull()
  expect(storageBanner({ state: 'unavailable', reason: 'migration-failed' })?.actions).toBeNull()
  expect(storageBanner({ state: 'read-only', reason: 'newer-schema', schemaVersion: 28, supportedVersion: 27 })?.actions).toBe('newer')
})

it('links 了解更多 to the public downgrade section', () => {
  const url = new URL(DOWNGRADE_DOCS_URL)
  expect(url.origin + url.pathname).toBe('https://github.com/qiyi71w/xdnmb/blob/main/docs/development.md')
  expect(decodeURIComponent(url.hash)).toBe('#降级与恢复升级前备份')
})

it('chooses the secrets sentence by whether the newer data is understood', () => {
  const info = { restorable: true, backupCompletedAt: '2026-11-02T08:00:00.000Z', sourceVersion: '1.2.0' } as const
  expect(restoreSecretsText({ ...info, secretsReadable: true })).toBe('升级后移除的饼干和退出的官网登录不会恢复。')
  expect(restoreSecretsText({ ...info, secretsReadable: false })).toBe('饼干和官网登录需要重新导入。')
})

it('closes a restarting confirmation only once the restart went ahead', () => {
  expect(restartOutcome({ status: 'restarting' })).toBe('close')
  expect(restartOutcome({ status: 'failed' })).toBe('failed')
  expect(restartOutcome({ status: 'not-applicable' })).toBe('failed')
  expect(restartOutcome(null)).toBe('failed')
})
