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
  cancel: vi.fn(), close: vi.fn(), closeAll: vi.fn(), threadOf: vi.fn(async () => ({ status: 'not-indexed' }))
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
    { sessionId: 's', query: 'word' },
    { sessionId: 's', channel: 'other', query: 'word' },
    { sessionId: 's', channel: 'xds', query: 'word', url: 'https://evil.example' },
    { sessionId: 's', channel: 'xds', query: 'word', userhash: 'secret' },
    { sessionId: 's', channel: 'xds', query: '' }
  ])('refuses missing channels, arbitrary endpoints and identity fields (%#)', async (input) => {
    await expect(call(IpcChannel.runOnlineSearch, input)).rejects.toThrow('invalid request')
    expect(search.run).not.toHaveBeenCalled()
  })
  it('rejects non-primary senders for queries and ownership lookup', async () => {
    await expect(call(IpcChannel.runOnlineSearch, { sessionId: 's', channel: 'xds', query: 'word' }, { id: 2 })).rejects.toThrow('invalid request')
    await expect(call(IpcChannel.searchThreadOf, { operationId: 'lookup', postId: '7' }, { id: 2 })).rejects.toThrow('invalid request')
    expect(search.threadOf).not.toHaveBeenCalled()
    expect(search.run).not.toHaveBeenCalled()
  })
  it.each(['0', '012', '123456789012345678901', 'https://evil.example', 7])('rejects unsafe ownership target %s before request', async (postId) => {
    await expect(call(IpcChannel.searchThreadOf, { operationId: 'lookup', postId })).rejects.toThrow('invalid request')
    expect(search.threadOf).not.toHaveBeenCalled()
  })
  it('opens only the selected fixed website, never a renderer-supplied URL', async () => {
    await call(IpcChannel.openOnlineSearchSite, { channel: 'xds' })
    await call(IpcChannel.openOnlineSearchSite, { channel: 'nmb-search' })
    expect(electron.openExternal.mock.calls).toEqual([['https://xds.wol.moe/'], ['https://nmb-search.166666666.xyz/']])
    await expect(call(IpcChannel.openOnlineSearchSite, { channel: 'xds', url: 'https://evil.example' })).rejects.toThrow('invalid request')
    expect(electron.openExternal).toHaveBeenCalledTimes(2)
  })
})
