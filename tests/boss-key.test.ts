import { describe, expect, it } from 'vitest'
import { BOSS_KEY_DEFAULT, bossKeyLabel, recordBossKey, type BossKeyInput } from '../src/shared/bossKey'
import { applySettingsPatch, DEFAULT_SETTINGS, settingsFromStored } from '../src/shared/settings'
import { createBossKeyService } from '../src/main/bossKey'

const press = (code: string, modifiers: Partial<Omit<BossKeyInput, 'code'>> = {}): BossKeyInput => ({
  code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers
})

describe('老板键 recording', () => {
  it('records the physical key with its modifiers in canonical order', () => {
    // ⌥ changes the produced character on macOS; the physical key decides.
    expect(recordBossKey(press('KeyH', { ctrlKey: true, altKey: true }), 'darwin')).toEqual({ kind: 'recorded', accelerator: 'Control+Alt+H' })
    expect(recordBossKey(press('Digit3', { metaKey: true, shiftKey: true }), 'darwin')).toEqual({ kind: 'recorded', accelerator: 'Shift+Command+3' })
    expect(recordBossKey(press('F9', { metaKey: true }), 'win32')).toEqual({ kind: 'recorded', accelerator: 'Super+F9' })
    expect(recordBossKey(press('ControlLeft', { ctrlKey: true }), 'win32')).toEqual({ kind: 'pending' })
  })

  it('refuses a lone key, Shift as the only modifier, keys it cannot hold and combinations 汐岛 uses', () => {
    expect(recordBossKey(press('KeyH'), 'win32')).toEqual({ kind: 'rejected', reason: 'modifier' })
    expect(recordBossKey(press('KeyH', { shiftKey: true }), 'win32')).toEqual({ kind: 'rejected', reason: 'modifier' })
    expect(recordBossKey(press('Space', { ctrlKey: true }), 'win32')).toEqual({ kind: 'rejected', reason: 'key' })
    expect(recordBossKey(press('KeyW', { ctrlKey: true }), 'win32')).toEqual({ kind: 'rejected', reason: 'app' })
    expect(recordBossKey(press('KeyF', { ctrlKey: true, shiftKey: true }), 'win32')).toEqual({ kind: 'rejected', reason: 'app' })
    expect(recordBossKey(press('KeyC', { metaKey: true }), 'darwin')).toEqual({ kind: 'rejected', reason: 'app' })
    expect(recordBossKey(press('KeyQ', { metaKey: true }), 'darwin')).toEqual({ kind: 'rejected', reason: 'app' })
    expect(recordBossKey(press('F4', { altKey: true }), 'win32')).toEqual({ kind: 'rejected', reason: 'app' })
    // Zoom reset reaches the page while recording (the window's zoom handling steps aside) and is refused.
    expect(recordBossKey(press('Digit0', { ctrlKey: true }), 'win32')).toEqual({ kind: 'rejected', reason: 'app' })
    expect(recordBossKey(press('Digit0', { metaKey: true }), 'darwin')).toEqual({ kind: 'rejected', reason: 'app' })
    // Only the platform's own primary modifier is taken: Ctrl+W is free on macOS.
    expect(recordBossKey(press('KeyW', { ctrlKey: true }), 'darwin')).toEqual({ kind: 'recorded', accelerator: 'Control+W' })
  })

  it('writes the combination the way each system does', () => {
    expect(bossKeyLabel(BOSS_KEY_DEFAULT, 'darwin')).toBe('⌃⌥H')
    expect(bossKeyLabel(BOSS_KEY_DEFAULT, 'win32')).toBe('Ctrl+Alt+H')
    expect(bossKeyLabel('Control+Shift+Super+F9', 'win32')).toBe('Ctrl+Shift+Win+F9')
  })

  it('stores only well-formed combinations and keeps the default otherwise', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { bossKey: 'Alt+Shift+K', bossKeyEnabled: true })).toMatchObject({
      ok: true, value: { bossKey: 'Alt+Shift+K', bossKeyEnabled: true }
    })
    for (const bossKey of ['H', 'Shift+H', 'Alt+Control+H', 'Control+Control+H', 'Control+Space', 'Command+Super+H', 42]) {
      expect(applySettingsPatch(DEFAULT_SETTINGS, { bossKey }).ok).toBe(false)
    }
    expect(settingsFromStored(new Map([['bossKey', 'H']])).bossKey).toBe(BOSS_KEY_DEFAULT)
  })
})

describe('老板键 registration', () => {
  function setup(platform: NodeJS.Platform = 'win32') {
    const held = new Set<string>()
    const registered = new Set<string>()
    const service = createBossKeyService({
      platform,
      register(accelerator) {
        if (held.has(accelerator)) return false
        registered.add(accelerator)
        return true
      },
      unregister: (accelerator) => registered.delete(accelerator),
      pressed: () => undefined
    })
    return { service, held, registered }
  }

  it('registers while turned on, swaps the combination and releases it while recording', () => {
    const s = setup()
    s.service.configure({ bossKeyEnabled: false, bossKey: BOSS_KEY_DEFAULT })
    expect(s.service.status()).toBe('off')
    expect([...s.registered]).toEqual([])

    s.service.configure({ bossKeyEnabled: true, bossKey: BOSS_KEY_DEFAULT })
    expect(s.service.status()).toBe('active')
    expect([...s.registered]).toEqual([BOSS_KEY_DEFAULT])

    s.service.configure({ bossKeyEnabled: true, bossKey: 'Alt+K' })
    expect([...s.registered]).toEqual(['Alt+K'])

    expect(s.service.setRecording(true)).toBe('active')
    expect(s.service.recording).toBe(true)
    expect([...s.registered]).toEqual([])
    expect(s.service.setRecording(false)).toBe('active')
    expect(s.service.recording).toBe(false)
    expect([...s.registered]).toEqual(['Alt+K'])

    s.service.configure({ bossKeyEnabled: false, bossKey: 'Alt+K' })
    expect([...s.registered]).toEqual([])
  })

  it('keeps a refused combination turned on and registers it once the other program lets go', () => {
    const s = setup()
    s.held.add(BOSS_KEY_DEFAULT)
    s.service.configure({ bossKeyEnabled: true, bossKey: BOSS_KEY_DEFAULT })
    expect(s.service.status()).toBe('unavailable')
    s.held.clear()
    // Asking again (设置 shown) retries.
    expect(s.service.status()).toBe('active')
    expect([...s.registered]).toEqual([BOSS_KEY_DEFAULT])
  })

  it('treats a combination Electron cannot parse as refused', () => {
    const service = createBossKeyService({
      platform: 'darwin',
      register: () => { throw new Error('bad accelerator') },
      unregister: () => undefined,
      pressed: () => undefined
    })
    service.configure({ bossKeyEnabled: true, bossKey: BOSS_KEY_DEFAULT })
    expect(service.status()).toBe('unavailable')
  })

  it('has no 老板键 on Linux', () => {
    const s = setup('linux')
    s.service.configure({ bossKeyEnabled: true, bossKey: BOSS_KEY_DEFAULT })
    expect(s.service.status()).toBe('unsupported')
    expect([...s.registered]).toEqual([])
  })
})
