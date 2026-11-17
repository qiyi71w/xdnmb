import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { applyAppearance, previewTheme } from '../../src/renderer/src/lib/useAppearance'
import { createTheme, deleteTheme, restoreTheme, selectBuiltinTheme, selectCustomTheme } from '../../src/shared/themeList'

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
