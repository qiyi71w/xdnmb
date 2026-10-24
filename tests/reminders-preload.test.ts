import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { XidaoApi } from '../src/shared/api'
import { REMINDERS_CHANGED_CHANNEL, REMINDERS_OPEN_CHANNEL } from '../src/shared/reminders'

const bridge = vi.hoisted(() => ({
  api: null as XidaoApi | null,
  listeners: new Map<string, Set<(...args: unknown[]) => void>>()
}))
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld(_name: string, api: XidaoApi) { bridge.api = api } },
  ipcRenderer: {
    on(channel: string, listener: (...args: unknown[]) => void) {
      const listeners = bridge.listeners.get(channel) ?? new Set<(...args: unknown[]) => void>()
      listeners.add(listener)
      bridge.listeners.set(channel, listeners)
    },
    removeListener(channel: string, listener: (...args: unknown[]) => void) { bridge.listeners.get(channel)?.delete(listener) },
    async invoke() { return undefined }
  }
}))
beforeEach(async () => {
  vi.resetModules()
  bridge.api = null
  bridge.listeners.clear()
  // Preload registers listeners at module load: each case needs a new window's isolated module
  // instance, so a static import would keep the preceding case's buffered click and listeners.
  await import('../src/preload/index')
})

describe('reminder preload delivery', () => {
  it('retains a notification click that arrived before the window renderer mounted and honors unsubscribe', async () => {
    const api = bridge.api
    if (api === null) throw new Error('preload did not expose the app API')
    for (const listener of bridge.listeners.get(REMINDERS_OPEN_CHANNEL) ?? []) listener({})
    let opens = 0
    const unsubscribe = api.reminders.onOpenList(() => { opens++ })
    expect(opens).toBe(0)
    await Promise.resolve()
    expect(opens).toBe(1)
    unsubscribe()
    for (const listener of bridge.listeners.get(REMINDERS_OPEN_CHANNEL) ?? []) listener({})
    expect(opens).toBe(1)
    api.reminders.onOpenList(() => { opens++ })
    await Promise.resolve()
    expect(opens).toBe(2)
  })

  it('coalesces a buffered intent with an immediate click and removes changed listeners', async () => {
    const api = bridge.api
    if (api === null) throw new Error('preload did not expose the app API')
    for (const listener of bridge.listeners.get(REMINDERS_OPEN_CHANNEL) ?? []) listener({})
    let opens = 0
    api.reminders.onOpenList(() => { opens++ })
    for (const listener of bridge.listeners.get(REMINDERS_OPEN_CHANNEL) ?? []) listener({})
    await Promise.resolve()
    expect(opens).toBe(1)
    let changes = 0
    const unsubscribe = api.reminders.onChanged(() => { changes++ })
    for (const listener of bridge.listeners.get(REMINDERS_CHANGED_CHANNEL) ?? []) listener({})
    unsubscribe()
    for (const listener of bridge.listeners.get(REMINDERS_CHANGED_CHANNEL) ?? []) listener({})
    expect(changes).toBe(1)
  })
})
