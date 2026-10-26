import { beforeAll, expect, it, vi } from 'vitest'
import type { ResolvePendingInput } from '../src/shared/publication'
import { IpcChannel } from '../src/shared/api'
import { registerIpc } from '../src/main/ipc'

type Handler = (event: { sender: { id: number }; trusted: boolean }, input: unknown) => Promise<unknown>
const handlers = vi.hoisted(() => new Map<string, Handler>())
vi.mock('electron', () => ({
  ipcMain: { handle(channel: string, handler: Handler) { handlers.set(channel, handler) } },
  BrowserWindow: {}, dialog: {}, nativeTheme: {}, shell: {}
}))

const received: ResolvePendingInput[] = []

beforeAll(() => {
  // Every other dependency is unused by this channel.
  const unused = new Proxy({}, { get: () => () => undefined })
  const publication = new Proxy({}, { get: (_target, key) => key === 'resolvePending'
    ? async (input: ResolvePendingInput) => { received.push(input); return { ok: false, reason: 'not-pending' } }
    : () => undefined })
  registerIpc(new Proxy({ publication, isTrustedSender: (event: { trusted: boolean }) => event.trusted }, {
    get: (target, key) => Reflect.get(target, key) ?? unused
  }) as unknown as Parameters<typeof registerIpc>[0])
})

async function resolvePending(input: unknown, trusted = true) {
  const handler = handlers.get(IpcChannel.resolvePendingPublication)
  if (!handler) throw new Error('resolve-pending channel not registered')
  return handler({ sender: { id: 1 }, trusted }, input)
}

it('accepts a well-formed answer and returns the publication result to the window: 已发出 with or without a numeric 串号, 没发出 without one', async () => {
  const valid = [
    { attemptId: '12', choice: 'sent', postId: '69687055' },
    { attemptId: '12', choice: 'sent', postId: null },
    { attemptId: '12', choice: 'not-sent', postId: null }
  ]
  for (const input of valid) await expect(resolvePending(input)).resolves.toEqual({ ok: false, reason: 'not-pending' })
})

it.each([
  ['a non-numeric attempt ID', { attemptId: 'abc', choice: 'sent', postId: null }],
  ['a zero attempt ID', { attemptId: '0', choice: 'sent', postId: null }],
  ['a numeric (not string) attempt ID', { attemptId: 12, choice: 'sent', postId: null }],
  ['an unknown choice', { attemptId: '12', choice: 'maybe', postId: null }],
  ['a 串号 with the No. prefix', { attemptId: '12', choice: 'sent', postId: 'No.123' }],
  ['a 串号 with letters', { attemptId: '12', choice: 'sent', postId: '12a' }],
  ['an empty 串号 string', { attemptId: '12', choice: 'sent', postId: '' }],
  ['a numeric (not string) 串号', { attemptId: '12', choice: 'sent', postId: 123 }],
  ['a 串号 with 没发出', { attemptId: '12', choice: 'not-sent', postId: '123' }],
  ['a missing 串号 field', { attemptId: '12', choice: 'sent' }],
  ['an extra field', { attemptId: '12', choice: 'sent', postId: null, threadId: '1' }],
  ['a non-object', '12']
])('refuses %s without touching publication', async (_name, input) => {
  received.length = 0
  await expect(resolvePending(input)).rejects.toThrow('invalid request')
  expect(received).toEqual([])
})

it('refuses a sender that is not the app window', async () => {
  received.length = 0
  await expect(resolvePending({ attemptId: '12', choice: 'sent', postId: null }, false)).rejects.toThrow('invalid request')
  expect(received).toEqual([])
})
