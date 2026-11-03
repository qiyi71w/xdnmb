import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel, type RestoreInfo, type StorageStatus } from '../src/shared/api'
import { registerIpc } from '../src/main/ipc'
import type { RestorePreparation } from '../src/main/storage/contract'
import { createRestoreService } from '../src/main/storage/restore-service'

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input?: unknown) => unknown>() }))
vi.mock('electron', () => ({
  ipcMain: { handle(channel: string, handler: (event: unknown, input?: unknown) => unknown) { electron.handlers.set(channel, handler) } },
  BrowserWindow: {}, clipboard: {}, dialog: {}, nativeTheme: {}, shell: {}
}))

const trusted = { id: 1, send: () => undefined, isDestroyed: () => false }
const untrusted = { id: 2, send: () => undefined, isDestroyed: () => false }
const READ_ONLY: StorageStatus = { state: 'read-only', reason: 'newer-schema', schemaVersion: 27, supportedVersion: 26 }
const INFO = { restorable: true, backupCompletedAt: '2026-11-02T08:00:00.000Z', sourceVersion: '1.2.0', secretsReadable: true } as const

let status: StorageStatus
let info: RestoreInfo
let preparation: () => Promise<RestorePreparation>
let prepared: number
let restarts: number

beforeEach(() => {
  status = READ_ONLY
  // A store answer carrying more than the documented fields: none of the rest may cross.
  info = { ...INFO, path: '/home/someone/.config/xidao/backups/pre-upgrade', ciphertext: 'AAAA' } as RestoreInfo
  preparation = async () => 'prepared'
  prepared = 0
  restarts = 0
  electron.handlers.clear()
  registerIpc({
    reminders: { onChanged: () => () => undefined },
    restore: createRestoreService({
      store: {
        get status() { return status },
        restoreInfo: async () => info,
        prepareRestore: () => {
          prepared++
          return preparation()
        }
      },
      restart: () => { restarts++ }
    }),
    isTrustedSender: (event: IpcMainInvokeEvent) => (event.sender as unknown) === trusted
  } as unknown as Parameters<typeof registerIpc>[0])
})

function call(channel: string, sender: unknown, ...input: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (handler === undefined) throw new Error(`${channel} not registered`)
  return Promise.resolve().then(() => handler({ sender }, ...input))
}

describe('restore operations', () => {
  it('reads exactly the restore information, with no path or secret', async () => {
    const result = await call(IpcChannel.getRestoreInfo, trusted)
    expect(result).toEqual(INFO)
    expect(JSON.stringify(result)).not.toContain('/home')
    info = { restorable: false }
    expect(await call(IpcChannel.getRestoreInfo, trusted)).toEqual({ restorable: false })
  })

  it('prepares once and restarts, ignoring repeated requests', async () => {
    const { promise, resolve } = Promise.withResolvers<RestorePreparation>()
    preparation = () => promise
    const first = call(IpcChannel.restoreBackupAndRestart, trusted)
    const second = call(IpcChannel.restoreBackupAndRestart, trusted)
    await Promise.resolve()
    resolve('prepared')
    expect(await first).toEqual({ status: 'restarting' })
    expect(await second).toEqual({ status: 'restarting' })
    expect(await call(IpcChannel.restoreBackupAndRestart, trusted)).toEqual({ status: 'restarting' })
    expect(prepared).toBe(1)
    expect(restarts).toBe(1)
  })

  it('stays put when preparing fails, and may be tried again', async () => {
    preparation = async () => 'failed'
    expect(await call(IpcChannel.restoreBackupAndRestart, trusted)).toEqual({ status: 'failed' })
    preparation = async () => { throw new Error('worker gone') }
    expect(await call(IpcChannel.restoreBackupAndRestart, trusted)).toEqual({ status: 'failed' })
    preparation = async () => 'not-applicable'
    expect(await call(IpcChannel.restoreBackupAndRestart, trusted)).toEqual({ status: 'not-applicable' })
    expect(restarts).toBe(0)
    expect(prepared).toBe(3)
  })

  it('refuses unless a newer version’s data is open read-only', async () => {
    for (const other of [
      { state: 'ready', schemaVersion: 26 },
      { state: 'unavailable', reason: 'open-failed' },
      { state: 'unavailable', reason: 'backup-failed', schemaVersion: 25, supportedVersion: 26 }
    ] satisfies StorageStatus[]) {
      status = other
      expect(await call(IpcChannel.getRestoreInfo, trusted)).toEqual({ restorable: false })
      expect(await call(IpcChannel.restoreBackupAndRestart, trusted)).toEqual({ status: 'not-applicable' })
    }
    expect(prepared).toBe(0)
    expect(restarts).toBe(0)
  })

  it('rejects other callers and any argument', async () => {
    for (const channel of [IpcChannel.getRestoreInfo, IpcChannel.restoreBackupAndRestart]) {
      await expect(call(channel, untrusted)).rejects.toThrow('invalid request')
      for (const input of [null, {}, { path: '/tmp/elsewhere' }, 'restore', 1]) {
        await expect(call(channel, trusted, input)).rejects.toThrow('invalid request')
      }
    }
    expect(prepared).toBe(0)
    expect(restarts).toBe(0)
  })
})
