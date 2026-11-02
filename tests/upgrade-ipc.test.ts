import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel, type StorageStatus } from '../src/shared/api'
import { registerIpc } from '../src/main/ipc'
import { markUpgradeWithoutBackup } from '../src/main/storage/backup'
import { createUpgradeService } from '../src/main/storage/upgrade'

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input?: unknown) => unknown>() }))
vi.mock('electron', () => ({
  ipcMain: { handle(channel: string, handler: (event: unknown, input?: unknown) => unknown) { electron.handlers.set(channel, handler) } },
  BrowserWindow: {}, clipboard: {}, dialog: {}, nativeTheme: {}, shell: {}
}))

const trusted = { id: 1, send: () => undefined, isDestroyed: () => false }
const untrusted = { id: 2, send: () => undefined, isDestroyed: () => false }
const BACKUP_FAILED: StorageStatus = { state: 'unavailable', reason: 'backup-failed', schemaVersion: 26, supportedVersion: 27 }
let folder: string
let status: StorageStatus
let restarts: number

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'xidao-upgrade-ipc-'))
  status = BACKUP_FAILED
  restarts = 0
  electron.handlers.clear()
  registerIpc({
    reminders: { onChanged: () => () => undefined },
    upgrade: createUpgradeService({
      status: () => status,
      markWithoutBackup: (schemaVersion) => markUpgradeWithoutBackup(folder, schemaVersion),
      restart: () => { restarts++ }
    }),
    isTrustedSender: (event: IpcMainInvokeEvent) => (event.sender as unknown) === trusted
  } as unknown as Parameters<typeof registerIpc>[0])
})

afterEach(() => {
  rmSync(folder, { recursive: true, force: true })
})

/** Invokes like `ipcRenderer.invoke(channel)` (no argument) unless `input` is given. */
function call(channel: string, sender: unknown, ...input: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (handler === undefined) throw new Error(`${channel} not registered`)
  return Promise.resolve().then(() => handler({ sender }, ...input))
}

const flag = () => join(folder, 'upgrade-without-backup.json')

describe('restart after a failed pre-upgrade backup', () => {
  it('records 不备份升级 for the failed schema version and restarts, returning no path', async () => {
    const result = await call(IpcChannel.restartToUpgradeWithoutBackup, trusted)
    expect(result).toEqual({ status: 'restarting' })
    expect(JSON.parse(readFileSync(flag(), 'utf8'))).toEqual({ schemaVersion: 26 })
    expect(restarts).toBe(1)
    expect(JSON.stringify(result)).not.toContain(folder)
  })

  it('restarts to retry without recording anything', async () => {
    expect(await call(IpcChannel.restartToRetryUpgrade, trusted)).toEqual({ status: 'restarting' })
    expect(restarts).toBe(1)
    expect(existsSync(flag())).toBe(false)
  })

  it('refuses both when storage is not waiting on a failed backup', async () => {
    for (const other of [
      { state: 'ready', schemaVersion: 27 },
      { state: 'unavailable', reason: 'migration-failed' },
      { state: 'read-only', reason: 'newer-schema', schemaVersion: 28, supportedVersion: 27 }
    ] satisfies StorageStatus[]) {
      status = other
      expect(await call(IpcChannel.restartToUpgradeWithoutBackup, trusted)).toEqual({ status: 'not-applicable' })
      expect(await call(IpcChannel.restartToRetryUpgrade, trusted)).toEqual({ status: 'not-applicable' })
    }
    expect(restarts).toBe(0)
    expect(existsSync(flag())).toBe(false)
  })

  it('does not restart when the choice cannot be recorded', async () => {
    rmSync(folder, { recursive: true, force: true })
    expect(await call(IpcChannel.restartToUpgradeWithoutBackup, trusted)).toEqual({ status: 'failed' })
    expect(restarts).toBe(0)
  })

  it('rejects other callers and any argument', async () => {
    for (const channel of [IpcChannel.restartToRetryUpgrade, IpcChannel.restartToUpgradeWithoutBackup]) {
      await expect(call(channel, untrusted)).rejects.toThrow('invalid request')
      for (const input of [null, {}, { schemaVersion: 1 }, '/tmp/elsewhere', 26]) {
        await expect(call(channel, trusted, input)).rejects.toThrow('invalid request')
      }
    }
    expect(restarts).toBe(0)
    expect(existsSync(flag())).toBe(false)
  })
})
