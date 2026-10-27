import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IpcChannel } from '../src/shared/api'
import { registerIpc } from '../src/main/ipc'
import type { SearchFilters } from '../src/shared/search'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => unknown>(),
  started: [] as { filters: SearchFilters }[]
}))
vi.mock('electron', () => ({
  ipcMain: { handle(channel: string, handler: (event: unknown, input: unknown) => unknown) { electron.handlers.set(channel, handler) } },
  BrowserWindow: {}, clipboard: {}, dialog: {}, nativeTheme: {}, shell: {}
}))

const main = { id: 1, send: () => undefined, isDestroyed: () => false }
const filters = { forumId: null, fromDate: null, toDate: null, image: 'any', postKind: 'any' }

beforeEach(() => {
  electron.handlers.clear()
  electron.started.length = 0
  registerIpc({
    reminders: { onChanged: () => () => undefined },
    search: { forOwner: () => ({ start: async (input: { filters: SearchFilters }) => { electron.started.push(input); return { ok: false, reason: 'busy' } } }) },
    isTrustedSender: (event: IpcMainInvokeEvent) => (event.sender as unknown) === main
  } as unknown as Parameters<typeof registerIpc>[0])
})

function start(applied: unknown): Promise<unknown> {
  const handler = electron.handlers.get(IpcChannel.searchStart)
  if (handler === undefined) throw new Error('search start channel not registered')
  return Promise.resolve().then(() => handler({ sender: main }, { operationId: 'op', query: 'q', scope: { kind: 'local' }, filters: applied }))
}

describe('search start IPC filters', () => {
  it('passes each 发言类型 through to the search service', async () => {
    for (const postKind of ['any', 'head', 'reply']) await start({ ...filters, postKind })
    expect(electron.started.map((input) => input.filters.postKind)).toEqual(['any', 'head', 'reply'])
  })

  it('refuses an unknown 发言类型, a missing key and an extra key', async () => {
    const { postKind: _omitted, ...withoutKind } = filters
    for (const applied of [
      { ...filters, postKind: 'main' }, { ...filters, postKind: null }, { ...filters, postKind: 1 },
      withoutKind, { ...filters, extra: true }
    ]) {
      await expect(start(applied)).rejects.toThrow('invalid request')
    }
    expect(electron.started).toEqual([])
  })
})
