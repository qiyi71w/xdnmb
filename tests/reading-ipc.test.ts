import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '../src/shared/api'
import { registerIpc } from '../src/main/ipc'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => unknown>(),
  reads: [] as unknown[][]
}))
vi.mock('electron', () => ({
  ipcMain: { handle(channel: string, handler: (event: unknown, input: unknown) => unknown) { electron.handlers.set(channel, handler) } },
  BrowserWindow: {}, clipboard: {}, dialog: {}, nativeTheme: {}, shell: {}
}))

const main = { id: 1, send: () => undefined, isDestroyed: () => false }

beforeEach(() => {
  electron.handlers.clear()
  electron.reads.length = 0
  registerIpc({
    reminders: { onChanged: () => () => undefined },
    content: { holdReader: async () => undefined, releaseReader: async () => undefined },
    store: { findPostThread: async () => null },
    reading: {
      async readThreadPage(...args: unknown[]) { electron.reads.push(['page', args[0], args[1], args[2], args[4]]); return { status: 'cancelled' } },
      async locateThreadEnd(...args: unknown[]) { electron.reads.push(['end', args[0], args[1], args[3]]); return { status: 'cancelled' } },
      async locateQuote(...args: unknown[]) { electron.reads.push(['quote', args[0], args[2], args[3]]); return { status: 'cancelled' } }
    },
    isTrustedSender: (event: IpcMainInvokeEvent) => (event.sender as unknown) === main
  } as unknown as Parameters<typeof registerIpc>[0])
})

function call(channel: string, input: unknown): Promise<unknown> {
  const handler = electron.handlers.get(channel)
  if (handler === undefined) throw new Error(`${channel} not registered`)
  return Promise.resolve().then(() => handler({ sender: main }, input))
}

describe('thread read purpose over IPC', () => {
  it('passes display and lookup through to the reading service', async () => {
    for (const purpose of ['display', 'lookup']) {
      await call(IpcChannel.readThreadPage, { operationId: `page-${purpose}`, threadId: '100', mode: 'po', page: 2, purpose })
      await call(IpcChannel.locateThreadEnd, { operationId: `end-${purpose}`, threadId: '100', mode: 'all', purpose })
    }
    expect(electron.reads).toEqual([
      ['page', '100', 'po', 2, 'display'], ['end', '100', 'all', 'display'],
      ['page', '100', 'po', 2, 'lookup'], ['end', '100', 'all', 'lookup']
    ])
  })

  it('refuses a missing or unknown purpose without reading', async () => {
    for (const purpose of [undefined, null, 'search', 'Display', 1, ['display']]) {
      await expect(call(IpcChannel.readThreadPage, { operationId: 'page', threadId: '100', mode: 'all', page: 1, purpose })).rejects.toThrow('invalid request')
      await expect(call(IpcChannel.locateThreadEnd, { operationId: 'end', threadId: '100', mode: 'all', purpose })).rejects.toThrow('invalid request')
    }
    expect(electron.reads).toEqual([])
  })
})

describe('quote locate context over IPC', () => {
  it('passes an absent context as none and a valid one through', async () => {
    await call(IpcChannel.locateQuote, { operationId: 'q1', postId: '1050' })
    await call(IpcChannel.locateQuote, { operationId: 'q2', postId: '1050', context: { threadId: '1000', fromPostId: '1185' } })
    expect(electron.reads).toEqual([['quote', '1050', null, null], ['quote', '1050', null, { threadId: '1000', fromPostId: '1185' }]])
  })

  it('refuses a malformed context without reading', async () => {
    for (const context of [null, '1000', { threadId: '1000' }, { threadId: 'x', fromPostId: '1185' }, { threadId: '1000', fromPostId: 1185 }]) {
      await expect(call(IpcChannel.locateQuote, { operationId: 'q', postId: '1050', context })).rejects.toThrow('invalid request')
    }
    expect(electron.reads).toEqual([])
  })
})
