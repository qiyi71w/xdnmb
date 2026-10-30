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

describe('饼干颜色 IPC', () => {
  const list = () => call(IpcChannel.listCookieColors) as Promise<{ cookieId: string; color: string | null; createdAt: string }[]>

  it('adds in 默认, colors and recolors in place, keeps an entry set back to 默认 and removes only on 删除', async () => {
    expect(await call(IpcChannel.addCookieColor, { cookieId: 'AbC123' })).toEqual({ saved: true, added: true })
    expect(await list()).toEqual([{ cookieId: 'AbC123', color: null, createdAt: expect.any(String) }])
    // An unlisted ID given a color is added; IDs match case-sensitively.
    expect(await call(IpcChannel.setCookieColor, { cookieId: 'abc123', color: 'amber' })).toEqual({ saved: true })
    const [first, second] = await list()
    expect(await call(IpcChannel.setCookieColor, { cookieId: 'AbC123', color: 'violet' })).toEqual({ saved: true })
    // Adding a listed ID again changes nothing: color, date and place stay.
    expect(await call(IpcChannel.addCookieColor, { cookieId: 'AbC123' })).toEqual({ saved: true, added: false })
    expect(await call(IpcChannel.addCookieColor, { cookieId: 'abc123' })).toEqual({ saved: true, added: false })
    expect(await list()).toEqual([{ ...first!, color: 'violet' }, { ...second!, color: 'amber' }])
    expect(await call(IpcChannel.setCookieColor, { cookieId: 'AbC123', color: null })).toEqual({ saved: true })
    expect(await list()).toEqual([{ ...first!, color: null }, { ...second!, color: 'amber' }])
    expect(await call(IpcChannel.removeCookieColor, { cookieId: 'AbC123' })).toEqual({ saved: true })
    expect(await list()).toEqual([second])
    expect(await call(IpcChannel.removeCookieColor, { cookieId: 'AbC123' })).toEqual({ saved: true })

    // Kept across a restart.
    db.close()
    db = openReadingDatabase(join(folder, 'db.sqlite'))
    expect(db.listCookieColors()).toEqual([second])
  })

  it('reports a write the storage refuses as not saved, without changing the list', async () => {
    expect(await call(IpcChannel.setCookieColor, { cookieId: 'AbC123', color: 'teal' })).toEqual({ saved: true })
    db.close()
    expect(await call(IpcChannel.addCookieColor, { cookieId: 'New1' })).toEqual({ saved: false })
    expect(await call(IpcChannel.setCookieColor, { cookieId: 'AbC123', color: null })).toEqual({ saved: false })
    expect(await call(IpcChannel.removeCookieColor, { cookieId: 'AbC123' })).toEqual({ saved: false })
    db = openReadingDatabase(join(folder, 'db.sqlite'))
    expect(db.listCookieColors()).toEqual([expect.objectContaining({ cookieId: 'AbC123', color: 'teal' })])
  })

  it.each([
    [{ cookieId: 'AbC123', color: 'red' }],
    [{ cookieId: 'AbC123', color: 'Blue' }],
    [{ cookieId: 'AbC123', color: 'default' }],
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

  it.each([IpcChannel.addCookieColor, IpcChannel.removeCookieColor])('%s refuses an invalid 饼干 ID or extra fields', async (channel) => {
    for (const input of [{ cookieId: ' AbC123' }, { cookieId: '' }, { cookieId: 7 }, { cookieId: 'AbC123', color: null }, {}, 'AbC123']) {
      await expect(call(channel, input)).rejects.toThrow('invalid request')
    }
    expect(db.listCookieColors()).toEqual([])
  })
})
