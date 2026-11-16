import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel, type ImportInspection } from '../src/shared/api'
import { registerIpc } from '../src/main/ipc'
import type { ImportService } from '../src/main/personal-data/import'
import type { QuitCallOff } from '../src/shared/lifecycle'

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input?: unknown) => unknown>() }))
vi.mock('electron', () => ({
  ipcMain: { handle(channel: string, handler: (event: unknown, input?: unknown) => unknown) { electron.handlers.set(channel, handler) } },
  BrowserWindow: {}, clipboard: {}, dialog: {}, nativeTheme: {}, shell: {}
}))

const trusted = { id: 1, send: () => undefined, isDestroyed: () => false }
const untrusted = { id: 2, send: () => undefined, isDestroyed: () => false }
const CHOSEN = '/home/someone/Documents/汐岛个人数据-2026-11-16.xidao'

let calls: string[]
let cancelled: QuitCallOff[]
let chosen: Array<string | null>

beforeEach(() => {
  calls = []
  cancelled = []
  chosen = []
  const service: ImportService = {
    async inspect(chooseFile) {
      calls.push('inspect')
      chosen.push(await chooseFile())
      return { status: 'ready', summary: { exportedAt: '2026-11-16T08:00:00.000Z', appVersion: '1.5.0', offlineThreads: 0, local: { history: 3, sendRecords: 1 } } }
    },
    async confirm() {
      calls.push('confirm')
      return { status: 'blocked', reason: 'unchecked' }
    },
    async cancel() {
      calls.push('cancel')
    },
    async stop() {}
  }
  electron.handlers.clear()
  registerIpc({
    reminders: { onChanged: () => () => undefined },
    personalImport: service,
    async chooseImportPath(sender: unknown) {
      expect(sender).toBe(trusted)
      return CHOSEN
    },
    lifecycle: {
      cancelQuit: (reason: QuitCallOff) => { cancelled.push(reason) },
      requestQuit: () => new Promise(() => undefined)
    },
    isTrustedSender: (event: IpcMainInvokeEvent) => (event.sender as unknown) === trusted
  } as unknown as Parameters<typeof registerIpc>[0])
})

function call(channel: string, sender: unknown, ...input: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (handler === undefined) throw new Error(`${channel} not registered`)
  return Promise.resolve().then(() => handler({ sender }, ...input))
}

describe('personal data import operations', () => {
  it('shows the open dialog in main and returns no path', async () => {
    const inspection = await call(IpcChannel.inspectImport, trusted) as ImportInspection
    expect(inspection.status).toBe('ready')
    expect(chosen).toEqual([CHOSEN])
    expect(JSON.stringify(inspection)).not.toContain('Documents')
    expect(await call(IpcChannel.confirmImport, trusted)).toEqual({ status: 'blocked', reason: 'unchecked' })
    expect(await call(IpcChannel.cancelImport, trusted)).toBeUndefined()
    expect(calls).toEqual(['inspect', 'confirm', 'cancel'])
  })

  it('rejects other callers and any argument without doing anything', async () => {
    for (const channel of [IpcChannel.inspectImport, IpcChannel.confirmImport, IpcChannel.cancelImport]) {
      await expect(call(channel, untrusted)).rejects.toThrow('invalid request')
      for (const input of [null, {}, { path: '/tmp/x.xidao' }, { passphrase: 'p' }, 'x', 1]) {
        await expect(call(channel, trusted, input)).rejects.toThrow('invalid request')
      }
    }
    expect(calls).toEqual([])
    expect(chosen).toEqual([])
  })

  it('takes a quit call-off with one of the renderer’s reasons only', async () => {
    expect(await call(IpcChannel.lifecycleCancelQuit, trusted, { reason: 'unchecked' })).toBeUndefined()
    for (const input of [undefined, {}, { reason: 'other' }, { reason: 'unchecked', extra: 1 }, 'unchecked']) {
      await expect(call(IpcChannel.lifecycleCancelQuit, trusted, input)).rejects.toThrow('invalid request')
    }
    await expect(call(IpcChannel.lifecycleCancelQuit, untrusted, { reason: 'drafts' })).rejects.toThrow('invalid request')
    expect(cancelled).toEqual(['unchecked'])
    // Asking for a quit never waits for its end.
    expect(await call(IpcChannel.lifecycleRequestQuit, trusted)).toBeUndefined()
  })
})
