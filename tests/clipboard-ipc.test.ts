import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { IpcChannel, MAX_CLIPBOARD_TEXT_LENGTH } from '../src/shared/api'
import { registerIpc } from '../src/main/ipc'

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => unknown>(),
  written: [] as string[]
}))
vi.mock('electron', () => ({
  ipcMain: { handle(channel: string, handler: (event: unknown, input: unknown) => unknown) { electron.handlers.set(channel, handler) } },
  clipboard: { writeText(text: string) { electron.written.push(text) } },
  BrowserWindow: {}, dialog: {}, nativeTheme: {}, shell: {}
}))

interface FakeSender { id: number; calls: string[]; cut(): void; copy(): void; paste(): void; selectAll(): void; send(): void; isDestroyed(): boolean }

function sender(id: number): FakeSender {
  const calls: string[] = []
  return {
    id, calls,
    cut: () => calls.push('cut'), copy: () => calls.push('copy'), paste: () => calls.push('paste'), selectAll: () => calls.push('selectAll'),
    send: () => undefined, isDestroyed: () => false
  }
}

const main = sender(1)
const other = sender(2)

beforeEach(() => {
  electron.handlers.clear()
  electron.written.length = 0
  main.calls.length = 0
  other.calls.length = 0
  // Only reminders is touched while registering; every other service is reached through a handler.
  registerIpc({
    reminders: { onChanged: () => () => undefined },
    isTrustedSender: (event: IpcMainInvokeEvent) => (event.sender as unknown) === main
  } as unknown as Parameters<typeof registerIpc>[0])
})

function run(from: FakeSender, input: unknown): Promise<unknown> {
  const handler = electron.handlers.get(IpcChannel.clipboard)
  if (handler === undefined) throw new Error('clipboard channel not registered')
  return Promise.resolve().then(() => handler({ sender: from }, input))
}

describe('clipboard IPC', () => {
  it('runs each edit command on the requesting window and writes app-given text', async () => {
    for (const command of ['cut', 'copy', 'paste', 'selectAll']) await run(main, { command })
    await run(main, { command: 'writeText', text: 'No.123' })
    expect(main.calls).toEqual(['cut', 'copy', 'paste', 'selectAll'])
    expect(electron.written).toEqual(['No.123'])
  })

  it('refuses a sender other than the main window', async () => {
    await expect(run(other, { command: 'paste' })).rejects.toThrow('invalid request')
    await expect(run(other, { command: 'writeText', text: 'x' })).rejects.toThrow('invalid request')
    expect(other.calls).toEqual([])
    expect(electron.written).toEqual([])
  })

  it('refuses commands outside the enumeration', async () => {
    for (const input of [{ command: 'readText' }, { command: 'undo' }, { command: 'toString' }, { command: 'constructor' }, {}, null, 'paste']) {
      await expect(run(main, input)).rejects.toThrow('invalid request')
    }
    expect(main.calls).toEqual([])
  })

  it('bounds written text: empty, non-string and overlong text are refused', async () => {
    await run(main, { command: 'writeText', text: 'x'.repeat(MAX_CLIPBOARD_TEXT_LENGTH) })
    for (const text of ['', 'x'.repeat(MAX_CLIPBOARD_TEXT_LENGTH + 1), 42, undefined]) {
      await expect(run(main, { command: 'writeText', text })).rejects.toThrow('invalid request')
    }
    expect(electron.written).toHaveLength(1)
  })
})
