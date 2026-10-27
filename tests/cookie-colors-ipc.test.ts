import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '../src/shared/api'
import { registerIpc } from '../src/main/ipc'
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
  folder = mkdtempSync(join(tmpdir(), 'xidao-cookie-colors-'))
  db = openReadingDatabase(join(folder, 'db.sqlite'))
  // Only reminders is touched while registering; the store is reached through the handlers.
  registerIpc({
    store: asStore(db),
    reminders: { onChanged: () => () => undefined },
    isTrustedSender: (event: IpcMainInvokeEvent) => (event.sender as unknown) === sender
  } as unknown as Parameters<typeof registerIpc>[0])
})

afterEach(() => {
  db.close()
  rmSync(folder, { recursive: true, force: true })
})

function call(channel: string, input?: unknown): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (handler === undefined) throw new Error(`${channel} not registered`)
  return Promise.resolve().then(() => handler({ sender }, input))
}

describe('饼干标色 IPC', () => {
  it('sets, recolors in place and clears one 饼干 ID, matched case-sensitively', async () => {
    expect(await call(IpcChannel.setCookieColor, { cookieId: 'AbC123', color: 'teal' })).toEqual({ saved: true })
    expect(await call(IpcChannel.setCookieColor, { cookieId: 'abc123', color: 'amber' })).toEqual({ saved: true })
    const [first] = await call(IpcChannel.listCookieColors) as { cookieId: string; createdAt: string }[]
    expect(await call(IpcChannel.setCookieColor, { cookieId: 'AbC123', color: 'violet' })).toEqual({ saved: true })
    expect(await call(IpcChannel.listCookieColors)).toEqual([
      { cookieId: 'AbC123', color: 'violet', createdAt: first!.createdAt },
      { cookieId: 'abc123', color: 'amber', createdAt: expect.any(String) }
    ])
    expect(await call(IpcChannel.setCookieColor, { cookieId: 'AbC123', color: null })).toEqual({ saved: true })
    expect(await call(IpcChannel.listCookieColors)).toEqual([expect.objectContaining({ cookieId: 'abc123' })])
  })

  it.each([
    [{ cookieId: 'AbC123', color: 'red' }],
    [{ cookieId: 'AbC123', color: 'Blue' }],
    [{ cookieId: 'AbC123', color: '#ff0000' }],
    [{ cookieId: 'AbC123' }],
    [{ cookieId: '', color: 'blue' }],
    [{ cookieId: ' AbC123', color: 'blue' }],
    [{ cookieId: 'two words', color: 'blue' }],
    [{ cookieId: 'line\nbreak', color: 'blue' }],
    [{ cookieId: 'x'.repeat(33), color: 'blue' }],
    [{ cookieId: 42, color: 'blue' }],
    [{ cookieId: 'AbC123', color: 'blue', extra: true }],
    ['AbC123']
  ])('refuses an unknown color name or an invalid 饼干 ID (%#)', async (input) => {
    await expect(call(IpcChannel.setCookieColor, input)).rejects.toThrow('invalid request')
    expect(db.listCookieColors()).toEqual([])
  })
})
