import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, expect, it, vi } from 'vitest'
import { IpcChannel } from '../src/shared/api'
import { registerIpc } from '../src/main/ipc'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => unknown>(),
  clears: [] as unknown[]
}))
vi.mock('electron', () => ({
  ipcMain: { handle(channel: string, handler: (event: unknown, input: unknown) => unknown) { electron.handlers.set(channel, handler) } },
  BrowserWindow: {}, clipboard: {}, dialog: {}, nativeTheme: {}, shell: {}
}))

const main = { id: 1, send: () => undefined, isDestroyed: () => false }

beforeEach(() => {
  electron.handlers.clear()
  electron.clears.length = 0
  registerIpc({
    reminders: { onChanged: () => () => undefined, async clear(input: unknown) { electron.clears.push(input); return { ok: true } } },
    isTrustedSender: (event: IpcMainInvokeEvent) => (event.sender as unknown) === main
  } as unknown as Parameters<typeof registerIpc>[0])
})

function clear(input: unknown): Promise<unknown> {
  const handler = electron.handlers.get(IpcChannel.reminderClear)
  if (handler === undefined) throw new Error('reminders:clear not registered')
  return Promise.resolve().then(() => handler({ sender: main }, input))
}

it('passes an open or a manual clear through to the reminder service', async () => {
  await clear({ threadId: '100', source: 'open' })
  await clear({ threadId: '100', source: 'manual' })
  expect(electron.clears).toEqual([{ threadId: '100', source: 'open' }, { threadId: '100', source: 'manual' }])
})

it('refuses a missing or unknown clear source without clearing', async () => {
  for (const source of [undefined, null, 'restore', 'Open', 1, ['open']]) {
    await expect(clear({ threadId: '100', source })).rejects.toThrow('invalid request')
  }
  await expect(clear({ threadId: 'x', source: 'open' })).rejects.toThrow('invalid request')
  expect(electron.clears).toEqual([])
})
