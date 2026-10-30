import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '../src/shared/api'
import { registerIpc } from '../src/main/ipc'

const electron = vi.hoisted(() => ({ handlers: new Map<string, (event: unknown, input: unknown) => unknown>() }))
vi.mock('electron', () => ({
  ipcMain: { handle(channel: string, handler: (event: unknown, input: unknown) => unknown) { electron.handlers.set(channel, handler) } },
  BrowserWindow: {}, clipboard: {}, dialog: {}, nativeTheme: {}, shell: {}
}))
const sender = { id: 1, send: () => undefined, isDestroyed: () => false }
const calls: unknown[] = []
beforeEach(() => {
  electron.handlers.clear()
  calls.length = 0
  registerIpc({
    subscriptions: {
      async getSnapshot(input: unknown) { calls.push(input); return null },
      async dismiss(input: unknown) { calls.push(input); return { ok: false, reason: 'not-found' } }
    },
    reminders: { onChanged: () => () => undefined },
    isTrustedSender: (event: IpcMainInvokeEvent) => (event.sender as unknown) === sender
  } as unknown as Parameters<typeof registerIpc>[0])
})
function call(channel: string, input: unknown, caller: unknown = sender): Promise<unknown> {
  return Promise.resolve().then(() => electron.handlers.get(channel)!({ sender: caller }, input))
}
describe('subscription snapshot and local closure IPC', () => {
  it('accepts only the named source and durable operation reference', async () => {
    expect(await call(IpcChannel.subscriptionSnapshot, { source: 'app' })).toBeNull()
    expect(await call(IpcChannel.subscriptionDismiss, { id: 'saved-operation' })).toEqual({ ok: false, reason: 'not-found' })
    expect(calls).toEqual([{ source: 'app' }, { id: 'saved-operation' }])
  })
  it.each([
    [IpcChannel.subscriptionSnapshot, { source: 'other' }],
    [IpcChannel.subscriptionSnapshot, null],
    [IpcChannel.subscriptionDismiss, { id: '' }],
    [IpcChannel.subscriptionDismiss, { id: 1 }],
    [IpcChannel.subscriptionDismiss, { id: 'a'.repeat(201) }]
  ])('rejects invalid local operations without touching storage (%#)', async (channel, input) => {
    await expect(call(channel as string, input)).rejects.toThrow('invalid request')
    expect(calls).toEqual([])
  })
  it('refuses an unauthorized renderer for both operations', async () => {
    await expect(call(IpcChannel.subscriptionSnapshot, { source: 'web' }, {})).rejects.toThrow()
    await expect(call(IpcChannel.subscriptionDismiss, { id: 'saved-operation' }, {})).rejects.toThrow()
    expect(calls).toEqual([])
  })
})
