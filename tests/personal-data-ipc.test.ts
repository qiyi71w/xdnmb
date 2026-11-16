import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel, type ExportProgress } from '../src/shared/api'
import { registerIpc } from '../src/main/ipc'
import { createExportService, type ExportService } from '../src/main/personal-data/service'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { readExportEstimate, takeExportSnapshot, trimExportSnapshot } from '../src/main/storage/export-snapshot'

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input?: unknown) => unknown>() }))
vi.mock('electron', () => ({
  ipcMain: { handle(channel: string, handler: (event: unknown, input?: unknown) => unknown) { electron.handlers.set(channel, handler) } },
  BrowserWindow: {}, clipboard: {}, dialog: {}, nativeTheme: {}, shell: {}
}))

const trusted = { id: 1, send: () => undefined, isDestroyed: () => false }
const untrusted = { id: 2, send: () => undefined, isDestroyed: () => false }

let root: string
let db: ReadingDatabase
let service: ExportService
let events: ExportProgress[]
let dialogs: string[]
let finished: PromiseWithResolvers<ExportProgress>

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xidao-export-ipc-'))
  db = openReadingDatabase(join(root, 'xidao.sqlite'))
  db.recordVisit('100', '2026-11-16T00:00:00.000Z')
  events = []
  dialogs = []
  finished = Promise.withResolvers()
  service = createExportService({
    databasePath: join(root, 'xidao.sqlite'),
    draftImagesDirectory: join(root, 'draft-images'),
    imagesDirectory: join(root, 'images'),
    appVersion: '1.5.0-test',
    status: () => db.status,
    sending: () => false,
    database: {
      estimate: async (path) => readExportEstimate(path),
      snapshot: async (path, work) => takeExportSnapshot(path, work),
      trim: async (work, options) => trimExportSnapshot(work, options),
      abort: () => undefined
    },
    publish(progress) {
      events.push(progress)
      if (progress.status !== 'running') finished.resolve(progress)
    },
    showInFolder: () => undefined,
    freeBytes: async () => 1024 ** 4
  })
  electron.handlers.clear()
  registerIpc({
    reminders: { onChanged: () => () => undefined },
    personalData: service,
    async chooseExportPath(sender: unknown, defaultName: string) {
      expect(sender).toBe(trusted)
      dialogs.push(defaultName)
      return join(root, defaultName)
    },
    isTrustedSender: (event: IpcMainInvokeEvent) => (event.sender as unknown) === trusted
  } as unknown as Parameters<typeof registerIpc>[0])
})

afterEach(() => {
  db.close()
  rmSync(root, { recursive: true, force: true })
})

function call(channel: string, sender: unknown, ...input: unknown[]): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (handler === undefined) throw new Error(`${channel} not registered`)
  return Promise.resolve().then(() => handler({ sender }, ...input))
}

describe('personal data export operations', () => {
  it('exports through the save dialog in main and returns no path', async () => {
    const estimate = await call(IpcChannel.exportEstimate, trusted)
    expect(estimate).toMatchObject({ available: true, running: null, contents: { offline: null } })
    const started = await call(IpcChannel.startExport, trusted, { includeOffline: true })
    expect(started).toEqual({ status: 'started' })
    const outcome = await finished.promise
    expect(outcome).toEqual({ status: 'done', fileName: dialogs[0] })
    expect(readdirSync(root)).toContain(dialogs[0])
    expect(await call(IpcChannel.revealExport, trusted)).toEqual({ shown: true })
    expect(await call(IpcChannel.cancelExport, trusted)).toBeUndefined()
    for (const value of [estimate, started, ...events]) expect(JSON.stringify(value)).not.toContain(root)
  })

  it('rejects other callers and invalid arguments without starting anything', async () => {
    const channels = [IpcChannel.exportEstimate, IpcChannel.startExport, IpcChannel.cancelExport, IpcChannel.revealExport]
    for (const channel of channels) await expect(call(channel, untrusted)).rejects.toThrow('invalid request')
    await expect(call(IpcChannel.startExport, untrusted, { includeOffline: true })).rejects.toThrow('invalid request')
    for (const channel of [IpcChannel.exportEstimate, IpcChannel.cancelExport, IpcChannel.revealExport]) {
      for (const input of [null, {}, { path: '/tmp/elsewhere' }, 'x', 1]) await expect(call(channel, trusted, input)).rejects.toThrow('invalid request')
    }
    for (const input of [undefined, null, {}, { includeOffline: 'yes' }, { includeOffline: true, path: '/tmp/x.xidao' }, { includeOffline: true, passphrase: 'p' }, [true]]) {
      await expect(call(IpcChannel.startExport, trusted, input)).rejects.toThrow('invalid request')
    }
    expect(dialogs).toEqual([])
    expect(events).toEqual([])
  })
})
