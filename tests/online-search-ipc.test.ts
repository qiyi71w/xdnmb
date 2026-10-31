import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerIpc } from '../src/main/ipc'
import { IpcChannel } from '../src/shared/api'
import { DEFAULT_XDS_SEARCH_FILTERS } from '../src/shared/online-search'

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
    { sessionId: 's', query: 'word', filters: DEFAULT_XDS_SEARCH_FILTERS },
    { sessionId: 's', channel: 'other', query: 'word', filters: DEFAULT_XDS_SEARCH_FILTERS },
    { sessionId: 's', channel: 'xds', query: 'word', filters: DEFAULT_XDS_SEARCH_FILTERS, url: 'https://evil.example' },
    { sessionId: 's', channel: 'xds', query: 'word', filters: DEFAULT_XDS_SEARCH_FILTERS, userhash: 'secret' },
    { sessionId: 's', channel: 'xds', query: '', filters: DEFAULT_XDS_SEARCH_FILTERS }
  ])('refuses missing channels, arbitrary endpoints and identity fields (%#)', async (input) => {
    await expect(call(IpcChannel.runOnlineSearch, input)).rejects.toThrow('invalid request')
    expect(search.run).not.toHaveBeenCalled()
  })
  it.each([
    undefined, null, [], {}, { ...DEFAULT_XDS_SEARCH_FILTERS, image: 'with' },
    { ...DEFAULT_XDS_SEARCH_FILTERS, fid: '0' }, { ...DEFAULT_XDS_SEARCH_FILTERS, fid: '01' },
    { ...DEFAULT_XDS_SEARCH_FILTERS, fid: '123456789012345678901' }, { ...DEFAULT_XDS_SEARCH_FILTERS, fid: 1 },
    { ...DEFAULT_XDS_SEARCH_FILTERS, since: '2025-02-29' }, { ...DEFAULT_XDS_SEARCH_FILTERS, until: '2026-04-31' },
    { ...DEFAULT_XDS_SEARCH_FILTERS, since: '7d' }, { ...DEFAULT_XDS_SEARCH_FILTERS, until: '2026-01-01T00:00:00Z' },
    { ...DEFAULT_XDS_SEARCH_FILTERS, since: '2026-10-30', until: '2026-10-29' },
    { ...DEFAULT_XDS_SEARCH_FILTERS, scope: 'head' }, { ...DEFAULT_XDS_SEARCH_FILTERS, sort: 'hits_desc' },
    { ...DEFAULT_XDS_SEARCH_FILTERS, mode: 'phrase' }, { ...DEFAULT_XDS_SEARCH_FILTERS, match: 'all' },
    { ...DEFAULT_XDS_SEARCH_FILTERS, op: 'xor' }
  ])('rejects malformed XDS filter shapes, dates, order and enums before the service (%#)', async (filters) => {
    await expect(call(IpcChannel.runOnlineSearch, { sessionId: 's', channel: 'xds', query: 'word', filters })).rejects.toThrow('invalid request')
    expect(search.run).not.toHaveBeenCalled()
  })
  it('requires the filters field and accepts only null for nmb-search', async () => {
    await expect(call(IpcChannel.runOnlineSearch, { sessionId: 's', channel: 'xds', query: 'word' })).rejects.toThrow('invalid request')
    await expect(call(IpcChannel.runOnlineSearch, { sessionId: 's', channel: 'nmb-search', query: 'word' })).rejects.toThrow('invalid request')
    await expect(call(IpcChannel.runOnlineSearch, { sessionId: 's', channel: 'nmb-search', query: 'word', filters: DEFAULT_XDS_SEARCH_FILTERS })).rejects.toThrow('invalid request')
    expect(search.run).not.toHaveBeenCalled()
    await call(IpcChannel.runOnlineSearch, { sessionId: 's', channel: 'nmb-search', query: 'word', filters: null })
    expect(search.run).toHaveBeenCalledWith('1', 's', 'nmb-search', 'word', null)
  })
  it('passes valid calendar filters without changing their values or decimal IDs', async () => {
    const filters = { fid: '99999999999999999999', since: '2024-02-29', until: '2024-02-29', scope: 'threads', sort: 'replies_desc', mode: 'exact', match: 'aggregate', op: 'auto' }
    await call(IpcChannel.runOnlineSearch, { sessionId: 's', channel: 'xds', query: ' word ', filters })
    expect(search.run).toHaveBeenCalledWith('1', 's', 'xds', 'word', filters)
  })
  it('rejects non-primary senders for queries and ownership lookup', async () => {
    await expect(call(IpcChannel.runOnlineSearch, { sessionId: 's', channel: 'xds', query: 'word', filters: DEFAULT_XDS_SEARCH_FILTERS }, { id: 2 })).rejects.toThrow('invalid request')
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
