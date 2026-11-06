import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerIpc } from '../src/main/ipc'
import { IpcChannel } from '../src/shared/api'

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input: unknown) => unknown>(), openExternal: vi.fn(async () => undefined) }))
vi.mock('electron', () => ({
  ipcMain: { handle(channel: string, handler: (event: unknown, input: unknown) => unknown) { electron.handlers.set(channel, handler) } },
  BrowserWindow: {}, clipboard: {}, dialog: {}, nativeTheme: {}, shell: { openExternal: electron.openExternal }
}))
const sender = { id: 1, send: () => undefined, isDestroyed: () => false }
const search = {
  run: vi.fn(async () => ({ status: 'closed' })), page: vi.fn(async () => ({ status: 'closed' })),
  cancel: vi.fn(), close: vi.fn(), closeAll: vi.fn()
}
beforeEach(() => {
  electron.handlers.clear()
  vi.clearAllMocks()
  registerIpc({ onlineSearch: search, reminders: { onChanged: () => () => undefined },
    isTrustedSender: (event: IpcMainInvokeEvent) => (event.sender as unknown) === sender
  } as unknown as Parameters<typeof registerIpc>[0])
})
function call(channel: string, input: unknown, caller: unknown = sender): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (handler === undefined) throw new Error('handler not registered')
  return Promise.resolve().then(() => handler({ sender: caller }, input))
}

describe('search IPC restrictions', () => {
  it.each([
    { sessionId: 's' },
    { sessionId: 's', channel: 'nmb-search', query: 'word' },
    { sessionId: 's', query: 'word', url: 'https://evil.example' },
    { sessionId: 's', query: 'word', userhash: 'secret' },
    { sessionId: 's', query: '' }
  ])('refuses missing queries, unknown fields, arbitrary endpoints and identity fields (%#)', async (input) => {
    await expect(call(IpcChannel.runOnlineSearch, input)).rejects.toThrow('invalid request')
    expect(search.run).not.toHaveBeenCalled()
  })
  it('rejects non-primary senders', async () => {
    await expect(call(IpcChannel.runOnlineSearch, { sessionId: 's', query: 'word' }, { id: 2 })).rejects.toThrow('invalid request')
    expect(search.run).not.toHaveBeenCalled()
  })
  it('opens only the fixed website, never a renderer-supplied URL', async () => {
    await call(IpcChannel.openOnlineSearchSite, undefined)
    expect(electron.openExternal.mock.calls).toEqual([['https://nmb-search.166666666.xyz/']])
    await expect(call(IpcChannel.openOnlineSearchSite, { url: 'https://evil.example' })).rejects.toThrow('invalid request')
    expect(electron.openExternal).toHaveBeenCalledTimes(1)
  })
})
