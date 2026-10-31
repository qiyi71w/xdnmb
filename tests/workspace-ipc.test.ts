import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '../src/shared/api'
import { registerIpc } from '../src/main/ipc'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { MIGRATIONS } from '../src/main/storage/migrations'
import type { AppStore } from '../src/main/storage/contract'
import { asStore } from './helpers/store'

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input: unknown) => unknown>() }))
vi.mock('electron', () => ({
  ipcMain: { handle(channel: string, handler: (event: unknown, input: unknown) => unknown) { electron.handlers.set(channel, handler) } },
  BrowserWindow: {}, clipboard: {}, dialog: {}, nativeTheme: {}, shell: {}
}))

const sender = { id: 1, send: () => undefined, isDestroyed: () => false }
let folder: string
let path: string
let db: ReadingDatabase

function register(store: AppStore): void {
  electron.handlers.clear()
  registerIpc({
    store,
    reminders: { onChanged: () => () => undefined },
    isTrustedSender: (event: IpcMainInvokeEvent) => (event.sender as unknown) === sender
  } as unknown as Parameters<typeof registerIpc>[0])
}

function save(workspace: string): Promise<unknown> {
  const handler = electron.handlers.get(IpcChannel.saveWorkspace)
  if (handler === undefined) throw new Error('saveWorkspace not registered')
  return Promise.resolve().then(() => handler({ sender }, { workspace }))
}

beforeEach(() => {
  folder = mkdtempSync(join(tmpdir(), 'xidao-workspace-ipc-'))
  path = join(folder, 'db.sqlite')
  db = openReadingDatabase(path)
})

afterEach(() => {
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

describe('saveWorkspace IPC', () => {
  it('saves on writable storage', async () => {
    register(asStore(db))
    expect(await save('{"a":1}')).toEqual({ ok: true, writable: true })
    expect(db.loadWorkspace()).toBe('{"a":1}')
  })

  it('reports a failed save on writable storage as retryable', async () => {
    const store = asStore(db)
    store.saveWorkspace = async () => {
      throw new Error('disk full')
    }
    register(store)
    expect(await save('{"a":1}')).toEqual({ ok: false, writable: true })
  })

  it('reports a database written by a newer version as not writable and keeps its workspace', async () => {
    db.saveWorkspace('{"before":true}', '2026-10-31T00:00:00.000Z')
    db.close()
    db = openReadingDatabase(path, MIGRATIONS.slice(0, -1))
    expect(db.status.state).toBe('read-only')
    register(asStore(db))
    expect(await save('{"after":true}')).toEqual({ ok: false, writable: false })
    expect(db.loadWorkspace()).toBe('{"before":true}')
  })

  it('reports unavailable storage as not writable', async () => {
    db.close()
    db = openReadingDatabase(join(folder, 'missing', 'db.sqlite'))
    expect(db.status.state).toBe('unavailable')
    register(asStore(db))
    expect(await save('{"a":1}')).toEqual({ ok: false, writable: false })
  })
})
