import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IpcChannel } from '../src/shared/api'
import { MAX_ANNOUNCEMENT_LENGTH } from '../src/shared/announcements'
import { registerIpc } from '../src/main/ipc'
import { createAnnouncementService } from '../src/main/announcements/service'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { asStore } from './helpers/store'

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input: unknown) => unknown>() }))
vi.mock('electron', () => ({
  ipcMain: { handle(channel: string, handler: (event: unknown, input: unknown) => unknown) { electron.handlers.set(channel, handler) } },
  BrowserWindow: {}, clipboard: {}, dialog: {}, nativeTheme: {}, shell: {}
}))
const sender = { id: 1, send: () => undefined, isDestroyed: () => false }
let folder: string
let db: ReadingDatabase
beforeEach(() => {
  electron.handlers.clear()
  folder = mkdtempSync(join(tmpdir(), 'xidao-announcement-ipc-'))
  db = openReadingDatabase(join(folder, 'db.sqlite'))
  const announcements = createAnnouncementService({ store: asStore(db), isForeground: () => true,
    transport: { get: async () => ({ mediaType: 'application/json', text: '{"date":"v","content":"notice","enable":true}' }) } })
  registerIpc({
    announcements,
    reminders: { onChanged: () => () => undefined },
    isTrustedSender: (event: IpcMainInvokeEvent) => (event.sender as unknown) === sender
  } as unknown as Parameters<typeof registerIpc>[0])
})
afterEach(() => { db.close(); rmSync(folder, { recursive: true, force: true }) })
function call(channel: string, input?: unknown, owner: unknown = sender) {
  const handler = electron.handlers.get(channel)
  if (!handler) throw new Error('Missing handler')
  return Promise.resolve().then(() => handler({ sender: owner }, input))
}
it('rejects untrusted callers before reading, fetching, consuming or writing an announcement', async () => {
  for (const channel of [IpcChannel.announcementGetState, IpcChannel.announcementRefresh, IpcChannel.announcementTakeAutomatic, IpcChannel.announcementSuppress]) {
    await expect(call(channel, { date: 'v', content: 'notice' }, { id: 99 })).rejects.toThrow('invalid request')
  }
  expect(db.loadAnnouncements()).toEqual({ latest: null, suppressed: null })
  expect(await call(IpcChannel.announcementTakeAutomatic)).toMatchObject({ date: 'v', content: 'notice' })
})
it('refuses malformed or expanded suppression payloads without changing the stored choice', async () => {
  await call(IpcChannel.announcementGetState)
  for (const input of [null, {}, { date: true, content: 'notice' }, { date: 'v', content: '' },
    { date: 'v', content: 'x'.repeat(MAX_ANNOUNCEMENT_LENGTH + 1) }, { date: 'v', content: 'notice', url: 'https://evil.invalid/' }]) {
    await expect(call(IpcChannel.announcementSuppress, input)).rejects.toThrow('invalid request')
  }
  expect(db.loadAnnouncements().suppressed).toBeNull()
  expect(await call(IpcChannel.announcementSuppress, { date: 'v', content: 'notice' })).toEqual({ saved: true })
  expect(await call(IpcChannel.announcementTakeAutomatic)).toBeNull()
})
