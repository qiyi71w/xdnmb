import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsUpdateResult } from '../../src/shared/api'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/settings'
import { themeFromBuiltin, type CustomTheme } from '../../src/shared/theme'
import {
  hasUnsavedEdits,
  reduceThemeEdits,
  savedThemeInUse,
  themeEditIssues,
  themeEditsFor,
  type ThemeEdits,
  type ThemeEditsAction
} from '../../src/renderer/src/app/themeEditsState'
import { themeListQueue } from '../../src/renderer/src/app/useThemeListOperations'
import { settingsWriter } from '../../src/renderer/src/app/useSettingsWriter'
import { applyAppearance, previewTheme } from '../../src/renderer/src/lib/useAppearance'
import { createTheme, customThemes, deleteTheme, restoreTheme, selectBuiltinTheme, selectCustomTheme } from '../../src/shared/themeList'

// Node's, used to let promise continuations run; renderer tests are type-checked without Node types.
declare function setImmediate(callback: () => void): unknown

function theme(name: string, surface: string): CustomTheme {
  const base = themeFromBuiltin('light')
  return { ...base, name, colors: { ...base.colors, light: { ...base.colors.light, surface } } }
}

const celadon = theme('青瓷', '#eef6f1')
const night = theme('夜航', '#e8ecf4')

const withList: AppSettings = {
  ...DEFAULT_SETTINGS,
  colorScheme: 'light',
  customTheme: celadon,
  customThemeEnabled: true,
  customThemeList: { others: [night], currentIndex: 0 }
}

const edited = theme('青瓷', '#aa3366')

function run(state: ThemeEdits, ...actions: ThemeEditsAction[]): ThemeEdits {
  return actions.reduce(reduceThemeEdits, state)
}

describe('unsaved theme edits', () => {
  it('keep their preview while 设置 is behind another tab, and are dropped when 设置 closes', () => {
    const editing = run(themeEditsFor(savedThemeInUse(withList)), { type: 'edit', theme: edited, settings: withList })
    expect(hasUnsavedEdits(editing)).toBe(true)
    expect(editing.preview).toEqual(edited)

    const behind = run(editing, { type: 'settings-tab', state: 'background' })
    expect(behind.draft).toEqual(edited)
    expect(behind.preview).toEqual(edited)
    expect(hasUnsavedEdits(behind)).toBe(true)

    const back = run(behind, { type: 'settings-tab', state: 'current' })
    expect(back.draft).toEqual(edited)

    const closed = run(back, { type: 'settings-tab', state: 'closed' })
    expect(closed).toEqual(themeEditsFor(celadon))
    expect(hasUnsavedEdits(closed)).toBe(false)
  })

  it('are dropped by 放弃修改', () => {
    const discarded = run(themeEditsFor(celadon), { type: 'edit', theme: edited, settings: withList }, { type: 'discard' })
    expect(discarded).toEqual(themeEditsFor(celadon))
  })

  it('are cleared once 保存 has written them', async () => {
    let saved = withList
    const queue = themeListQueue(
      async (patch) => {
        saved = { ...saved, ...patch }
        return true
      },
      () => saved,
      () => true
    )
    const editing = run(themeEditsFor(celadon), { type: 'edit', theme: edited, settings: withList })
    const result = await queue.save(edited)
    expect(result?.ok).toBe(true)
    expect(saved.customTheme).toEqual(edited)
    expect(saved.customThemeList).toEqual(withList.customThemeList)
    const after = run(editing, { type: 'settings', settings: saved })
    expect(after).toEqual(themeEditsFor(edited))
    expect(hasUnsavedEdits(after)).toBe(false)
  })

  it('are voided when the saved theme in use changes elsewhere, and kept for other settings', () => {
    const editing = run(themeEditsFor(celadon), { type: 'edit', theme: edited, settings: withList })
    expect(run(editing, { type: 'settings', settings: { ...withList, colorScheme: 'dark', density: 'compact' } })).toBe(editing)

    const changed = theme('青瓷', '#123456')
    expect(run(editing, { type: 'settings', settings: { ...withList, customTheme: changed } })).toEqual(themeEditsFor(changed))
    expect(run(editing, { type: 'settings', settings: { ...withList, customThemeEnabled: false } })).toEqual(themeEditsFor(null))
  })

  it('preview only valid edits: a bad color or a taken name keeps the last valid preview', () => {
    const valid = run(themeEditsFor(celadon), { type: 'edit', theme: edited, settings: withList })
    const badColor = { ...edited, colors: { ...edited.colors, light: { ...edited.colors.light, accent: '#12' } } }
    const invalid = run(valid, { type: 'edit', theme: badColor, settings: withList })
    expect(invalid.draft).toEqual(badColor)
    expect(invalid.preview).toEqual(edited)
    expect(themeEditIssues(badColor, withList).length).toBeGreaterThan(0)

    const taken = { ...edited, name: '夜航' }
    expect(run(valid, { type: 'edit', theme: taken, settings: withList }).preview).toEqual(edited)
    expect(themeEditIssues(taken, withList)).toEqual([{ kind: 'field', field: 'customTheme.name', problem: 'duplicate' }])
    expect(themeEditIssues({ ...edited, name: '汐岛' }, withList)).toEqual([{ kind: 'field', field: 'customTheme.name', problem: 'duplicate' }])
  })

  it('edits back to the saved theme are not unsaved', () => {
    expect(hasUnsavedEdits(run(themeEditsFor(celadon), { type: 'edit', theme: { ...celadon }, settings: withList }))).toBe(false)
  })

  it('cannot start while 汐岛 is in use', () => {
    const builtin = { ...withList, customThemeEnabled: false }
    const state = run(themeEditsFor(savedThemeInUse(builtin)), { type: 'edit', theme: edited, settings: builtin })
    expect(state).toEqual(themeEditsFor(null))
  })
})

describe('theme list operations while edits are unsaved', () => {
  it('refuses every list operation (undo included) without writing, and runs them again once saved or discarded', async () => {
    let unsaved = true
    let saved = withList
    const commit = vi.fn(async (patch: Partial<AppSettings>) => {
      saved = { ...saved, ...patch }
      return true
    })
    const queue = themeListQueue(commit, () => saved, () => unsaved)
    const deleted = deleteTheme(withList, '夜航')
    if (!deleted.ok) throw new Error('setup')

    for (const operation of [
      () => selectBuiltinTheme(),
      (current: AppSettings) => selectCustomTheme(current, '夜航'),
      (current: AppSettings) => createTheme(current, 'light'),
      (current: AppSettings) => deleteTheme(current, '夜航'),
      (current: AppSettings) => restoreTheme(current, deleted.deleted)
    ]) {
      expect(await queue.run(operation)).toEqual({ ok: false, reason: 'unsaved' })
    }
    expect(commit).not.toHaveBeenCalled()
    expect(saved).toBe(withList)

    unsaved = false
    expect((await queue.run((current) => selectCustomTheme(current, '夜航')))?.ok).toBe(true)
    expect(saved.customTheme).toEqual(night)
    expect(commit).toHaveBeenCalledTimes(1)
  })

  it('checks when an operation’s turn comes, so one queued before the edits began is refused too', async () => {
    let unsaved = false
    const pending = Promise.withResolvers<boolean>()
    const commit = vi.fn(() => pending.promise)
    const queue = themeListQueue(commit, () => withList, () => unsaved)
    const first = queue.run((current) => selectCustomTheme(current, '夜航'))
    const second = queue.run(() => selectBuiltinTheme())
    await Promise.resolve()
    unsaved = true
    pending.resolve(true)
    expect((await first)?.ok).toBe(true)
    expect(await second).toEqual({ ok: false, reason: 'unsaved' })
    expect(commit).toHaveBeenCalledTimes(1)
  })
})

describe('theme list operations among other settings changes', () => {
  /** Main's settings: updates are handled in order, each when `answer` replies to it. */
  function fakeMain(initial: AppSettings) {
    let stored = initial
    const waiting: Array<{ patch: Partial<AppSettings>; reply: (result: SettingsUpdateResult) => void }> = []
    const update = vi.fn((patch: Partial<AppSettings>) => {
      const { promise, resolve } = Promise.withResolvers<SettingsUpdateResult>()
      waiting.push({ patch, reply: resolve })
      return promise
    })
    // The writer's send delay runs on the fake clock (`vi.advanceTimersByTime`).
    vi.stubGlobal('window', {
      xidao: { settings: { update } },
      setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
      clearTimeout: (timer: number) => clearTimeout(timer)
    })
    return {
      update,
      stored: () => stored,
      answer: async (saved = true) => {
        const { patch, reply } = waiting.shift()!
        if (saved) stored = { ...stored, ...patch }
        reply({ settings: stored, saved, issues: [] })
        await settle()
      }
    }
  }
  /** Runs every promise continuation; timers wait for the fake clock. */
  const settle = () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    setImmediate(resolve)
    return promise
  }
  const names = (settings: AppSettings) => customThemes(settings).map((theme) => theme.name)

  function setup() {
    const main = fakeMain(withList)
    const latest = { current: withList }
    const writer = settingsWriter(latest, () => undefined, () => undefined)
    const queue = themeListQueue(writer.commit, () => latest.current, () => false)
    return { main, latest, writer, queue }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it.each([
    ['sent before the first one’s reply', true],
    ['still waiting when the first one’s reply comes', false]
  ])('each one sees the one before, with a 配色 change %s', async (_, sentBefore) => {
    const { main, latest, writer, queue } = setup()
    const first = queue.run((current) => createTheme(current, 'light'))
    await settle()
    writer.write({ colorScheme: 'dark' })
    if (sentBefore) vi.advanceTimersByTime(0)
    const second = queue.run((current) => createTheme(current, 'light'))
    expect(main.update).toHaveBeenCalledTimes(sentBefore ? 2 : 1)

    await main.answer()
    // The new theme shows, and so does the newer 配色.
    expect(names(latest.current)).toEqual(['青瓷', '夜航', '我的主题'])
    expect(latest.current.colorScheme).toBe('dark')
    // Then the 配色 change (when it went on its own) and the second operation.
    if (sentBefore) await main.answer()
    await main.answer()

    expect((await first)?.ok).toBe(true)
    expect((await second)?.ok).toBe(true)
    expect(main.update).toHaveBeenCalledTimes(sentBefore ? 3 : 2)
    expect(names(main.stored())).toEqual(['青瓷', '夜航', '我的主题', '我的主题 2'])
    expect(main.stored().customTheme?.name).toBe('我的主题 2')
    expect(main.stored().colorScheme).toBe('dark')
    expect(latest.current).toEqual(main.stored())
  })

  it('a theme selected after 保存 and a 配色 change keeps the saved edits', async () => {
    const { main, latest, writer, queue } = setup()
    const saved = queue.save(edited)
    await settle()
    writer.write({ colorScheme: 'dark' })
    vi.advanceTimersByTime(0)
    const selected = queue.run((current) => selectCustomTheme(current, '夜航'))
    await main.answer()
    await main.answer()
    await main.answer()

    expect((await saved)?.ok).toBe(true)
    expect((await selected)?.ok).toBe(true)
    expect(main.stored().customTheme).toEqual(night)
    expect(main.stored().customThemeList.others).toEqual([edited])
    expect(latest.current).toEqual(main.stored())
  })

  it('an operation main did not save never shows, and the newer 配色 change stays', async () => {
    const { main, latest, writer, queue } = setup()
    const first = queue.run((current) => createTheme(current, 'light'))
    await settle()
    writer.write({ colorScheme: 'dark' })
    vi.advanceTimersByTime(0)
    await main.answer(false)

    expect(await first).toBeNull()
    expect(latest.current).toEqual({ ...withList, colorScheme: 'dark' })
  })

  it.each([true, false])('a waiting write sent by an operation is told that update’s result (saved: %s)', async (saved) => {
    const { main, writer, queue } = setup()
    const written = writer.write({ colorScheme: 'dark' }, 500)
    const created = queue.run((current) => createTheme(current, 'light'))
    await settle()
    expect(main.update).toHaveBeenCalledTimes(1)
    expect(main.update.mock.calls[0]![0]).toMatchObject({ colorScheme: 'dark' })
    await main.answer(saved)

    expect(await written).toBe(saved)
    expect((await created)?.ok ?? false).toBe(saved)
    // Nothing is left to send once the delay passes.
    vi.advanceTimersByTime(500)
    expect(main.update).toHaveBeenCalledTimes(1)
  })

  it('a write still waiting when settings are adopted is dropped and told it was not saved', async () => {
    const { main, latest, writer } = setup()
    const written = writer.write({ colorScheme: 'dark' }, 500)
    writer.adopt({ ...withList, density: 'compact' })
    vi.advanceTimersByTime(500)

    expect(await written).toBe(false)
    expect(main.update).not.toHaveBeenCalled()
    expect(latest.current).toEqual({ ...withList, density: 'compact' })
  })
})

describe('the window preview of unsaved edits', () => {
  const variables = new Map<string, string>()
  beforeEach(() => {
    const root = { style: { setProperty: (name: string, value: string) => variables.set(name, value) }, dataset: {} }
    vi.stubGlobal('document', { documentElement: root, querySelectorAll: () => [] })
    const events = new EventTarget()
    vi.stubGlobal('window', {
      addEventListener: events.addEventListener.bind(events),
      matchMedia: () => ({ matches: false }),
      xidao: { view: { updateTitleBar: async () => undefined } }
    })
  })
  afterEach(() => {
    previewTheme(null)
    vi.unstubAllGlobals()
  })

  it('stays on the root element while 设置 is behind another tab, follows 配色, and goes when 设置 closes', () => {
    applyAppearance(withList)
    expect(variables.get('--paper')).toBe(celadon.colors.light.surface)

    let state = run(themeEditsFor(celadon), { type: 'edit', theme: edited, settings: withList })
    previewTheme(state.preview)
    expect(variables.get('--paper')).toBe('#aa3366')

    state = run(state, { type: 'settings-tab', state: 'background' })
    previewTheme(state.preview)
    expect(variables.get('--paper')).toBe('#aa3366')

    // 配色 still switches: the preview shows the edited theme's dark set.
    const dark = { ...withList, colorScheme: 'dark' as const }
    state = run(state, { type: 'settings', settings: dark })
    applyAppearance(dark)
    expect(variables.get('--paper')).toBe(edited.colors.dark.surface)
    applyAppearance(withList)
    expect(variables.get('--paper')).toBe('#aa3366')

    state = run(state, { type: 'settings-tab', state: 'closed' })
    previewTheme(state.preview)
    expect(variables.get('--paper')).toBe(celadon.colors.light.surface)
  })
})
