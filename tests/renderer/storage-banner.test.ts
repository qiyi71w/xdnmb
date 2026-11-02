import { expect, it } from 'vitest'
import { storageBanner, withoutBackupOutcome } from '../../src/renderer/src/features/storage/storageBanner'

it('offers the upgrade restarts only after a failed pre-upgrade backup, other banners unchanged', () => {
  expect(storageBanner(null)).toBeNull()
  expect(storageBanner({ state: 'ready', schemaVersion: 27 })).toBeNull()
  expect(storageBanner({ state: 'unavailable', reason: 'backup-failed', schemaVersion: 26, supportedVersion: 27 })).toEqual({
    text: '升级前未能备份数据，数据尚未升级，当前不会保存新内容。',
    upgrade: true
  })
  expect(storageBanner({ state: 'unavailable', reason: 'open-failed' })).toEqual({ text: '本地存储不可用，内容不会保存', upgrade: false })
  expect(storageBanner({ state: 'unavailable', reason: 'migration-failed' })).toEqual({ text: '本地存储不可用，内容不会保存', upgrade: false })
  expect(storageBanner({ state: 'read-only', reason: 'newer-schema', schemaVersion: 28, supportedVersion: 27 })).toEqual({
    text: '数据库只读，新内容不会保存',
    upgrade: false
  })
})

it('closes the no-backup dialog only once the restart went ahead', () => {
  expect(withoutBackupOutcome({ status: 'restarting' })).toBe('close')
  expect(withoutBackupOutcome({ status: 'failed' })).toBe('failed')
  expect(withoutBackupOutcome({ status: 'not-applicable' })).toBe('failed')
  expect(withoutBackupOutcome(null)).toBe('failed')
})
