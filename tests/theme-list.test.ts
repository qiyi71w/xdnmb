import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createSettingsService, type SettingsStore } from '../src/main/appearance'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { applySettingsPatch, DEFAULT_SETTINGS, settingsFromStored, type AppSettings } from '../src/shared/settings'
import { parseCustomTheme, themeFromBuiltin, type CustomTheme } from '../src/shared/theme'
import {
  copyTheme,
  exportedTheme,
  createTheme,
  customThemes,
  deleteTheme,
  importTheme,
  MAX_CUSTOM_THEMES,
  restoreTheme,
  saveCurrentTheme,
  selectBuiltinTheme,
  selectCustomTheme,
  uniqueThemeName,
  type DeletedTheme,
  type ThemeListResult
} from '../src/shared/themeList'

const folders: string[] = []
const databases: ReadingDatabase[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'xidao-theme-list-'))
  folders.push(path)
  return path
}

function open(path: string): ReadingDatabase {
  const db = openReadingDatabase(path)
  databases.push(db)
  return db
}

function close(db: ReadingDatabase): void {
  db.close()
  databases.splice(databases.indexOf(db), 1)
}

/** A store that counts the settings writes reaching it. */
function countingStore(db: ReadingDatabase): SettingsStore & { saves: number } {
  const store = {
    saves: 0,
    loadSettings: async () => db.loadSettings(),
    saveSettings: async (settings: AppSettings) => {
      store.saves++
      db.saveSettings(settings)
    }
  }
  return store
}

const theme = (name: string, accent = '#2f7d6d'): CustomTheme => {
  const seed = themeFromBuiltin('light')
  return { ...seed, name, colors: { ...seed.colors, light: { ...seed.colors.light, accent } } }
}

const [a, b, c] = [theme('青瓷'), theme('夜航', '#3355aa'), theme('纸白', '#7a3e12')]

/** 青瓷, 夜航 (current, in use), 纸白. */
const library: AppSettings = { ...DEFAULT_SETTINGS, customTheme: b, customThemeEnabled: true, customThemeList: { others: [a, c], currentIndex: 1 } }

const names = (settings: AppSettings) => customThemes(settings).map((item) => item.name)

function applied(settings: AppSettings, result: ThemeListResult): AppSettings {
  if (!result.ok) throw new Error(`refused: ${result.reason}`)
  const next = applySettingsPatch(settings, result.patch)
  if (!next.ok) throw new Error(JSON.stringify(next.issues))
  return next.value
}

function many(count: number): AppSettings {
  const themes = Array.from({ length: count }, (_, index) => theme(`主题 ${index + 1}`))
  return { ...DEFAULT_SETTINGS, customTheme: themes[0]!, customThemeEnabled: true, customThemeList: { others: themes.slice(1), currentIndex: 0 } }
}

describe('theme list rules', () => {
  it('lists the current theme at its place among the others', () => {
    expect(names(library)).toEqual(['青瓷', '夜航', '纸白'])
    expect(names({ ...library, customThemeList: { others: [a, c], currentIndex: 2 } })).toEqual(['青瓷', '纸白', '夜航'])
    expect(customThemes(DEFAULT_SETTINGS)).toEqual([])
  })

  it('switches the current theme in one update, putting the previous one back at its place', () => {
    const result = selectCustomTheme(library, '纸白')
    expect(result).toEqual({ ok: true, patch: { customTheme: c, customThemeEnabled: true, customThemeList: { others: [a, b], currentIndex: 2 } } })
    const switched = applied(library, result)
    expect(names(switched)).toEqual(['青瓷', '夜航', '纸白'])
    const back = applied(switched, selectCustomTheme(switched, '青瓷'))
    expect(names(back)).toEqual(['青瓷', '夜航', '纸白'])
    expect(back).toMatchObject({ customTheme: a, customThemeEnabled: true, customThemeList: { others: [b, c], currentIndex: 0 } })
    expect(selectCustomTheme(library, '不存在')).toEqual({ ok: false, reason: 'not-found' })
  })

  it('choosing 汐岛 only turns the custom theme off and keeps the current theme', () => {
    expect(selectBuiltinTheme()).toEqual({ ok: true, patch: { customThemeEnabled: false } })
    const builtin = applied(library, selectBuiltinTheme())
    expect(builtin).toEqual({ ...library, customThemeEnabled: false })
    expect(applied(builtin, selectCustomTheme(builtin, '夜航'))).toEqual(library)
  })

  it('creates 我的主题 from 汐岛 at the end and uses it, numbering repeated names from 2', () => {
    const first = applied(library, createTheme(library, 'light'))
    expect(names(first)).toEqual(['青瓷', '夜航', '纸白', '我的主题'])
    expect(first.customTheme).toEqual(themeFromBuiltin('light'))
    expect(first.customThemeEnabled).toBe(true)
    const second = applied(first, createTheme(first, 'dark'))
    expect(names(second)).toEqual(['青瓷', '夜航', '纸白', '我的主题', '我的主题 2'])
    expect(second.customTheme).toEqual({ ...themeFromBuiltin('dark'), name: '我的主题 2' })
    // The smallest free number.
    const gap = { ...DEFAULT_SETTINGS, customTheme: theme('我的主题'), customThemeList: { others: [theme('我的主题 3')], currentIndex: 0 } }
    expect(applied(gap, createTheme(gap, 'light')).customTheme?.name).toBe('我的主题 2')
    expect(applied(DEFAULT_SETTINGS, createTheme(DEFAULT_SETTINGS, 'light'))).toMatchObject({
      customTheme: themeFromBuiltin('light'), customThemeEnabled: true, customThemeList: { others: [], currentIndex: 0 }
    })
  })

  it('refuses renaming the current theme to another theme’s name or 汐岛, compared after trimming', () => {
    for (const name of ['青瓷', ' 纸白 ', '汐岛']) {
      expect(saveCurrentTheme(library, { ...b, name })).toEqual({ ok: false, reason: 'name-taken' })
      expect(applySettingsPatch(library, { customTheme: { ...b, name } })).toMatchObject({
        ok: false, issues: [{ kind: 'field', field: 'customTheme.name', problem: 'duplicate' }]
      })
    }
    const renamed = applied(library, saveCurrentTheme(library, { ...b, name: ' 夜航 2 ' }))
    expect(names(renamed)).toEqual(['青瓷', '夜航 2', '纸白'])
  })

  it(`refuses the ${MAX_CUSTOM_THEMES + 1}th theme`, () => {
    const full = many(MAX_CUSTOM_THEMES)
    expect(customThemes(full)).toHaveLength(MAX_CUSTOM_THEMES)
    expect(createTheme(full, 'light')).toEqual({ ok: false, reason: 'full' })
    expect(createTheme(many(MAX_CUSTOM_THEMES - 1), 'light').ok).toBe(true)
  })

  it('shortens the original name to fit a number within 40 characters', () => {
    const long = '长'.repeat(40)
    expect(uniqueThemeName(long, [])).toBe(long)
    const numbered = uniqueThemeName(long, [long])
    expect(numbered).toBe(`${'长'.repeat(38)} 2`)
    expect([...numbered]).toHaveLength(40)
    expect(uniqueThemeName(long, [long, numbered])).toBe(`${'长'.repeat(38)} 3`)
    expect(uniqueThemeName('汐岛', [])).toBe('汐岛 2')
    // The imported theme is added last under a name unique among all custom themes and still valid.
    const settings = { ...library, customThemeList: { others: [a, { ...c, name: long }], currentIndex: 1 } }
    const imported = applied(settings, importTheme(settings, { ...c, name: long }))
    expect(imported.customTheme?.name).toBe(numbered)
    expect(names(imported)).toEqual(['青瓷', '夜航', long, numbered])
    expect(parseCustomTheme(imported.customTheme).ok).toBe(true)
  })

  it('adds an imported theme last and uses it, keeping every theme, until the list is full', () => {
    const builtin = applied(library, selectBuiltinTheme())
    const imported = applied(builtin, importTheme(builtin, { ...b, name: '夜航' }))
    expect(names(imported)).toEqual(['青瓷', '夜航', '纸白', '夜航 2'])
    expect(customThemes(imported).slice(0, 3)).toEqual([a, b, c])
    expect(imported).toMatchObject({ customTheme: { ...b, name: '夜航 2' }, customThemeEnabled: true })
    expect(applied(DEFAULT_SETTINGS, importTheme(DEFAULT_SETTINGS, a))).toMatchObject({ customTheme: a, customThemeEnabled: true, customThemeList: { others: [], currentIndex: 0 } })
    expect(importTheme(many(MAX_CUSTOM_THEMES), a)).toEqual({ ok: false, reason: 'full' })
    expect(importTheme(many(MAX_CUSTOM_THEMES - 1), a).ok).toBe(true)
  })

  it('finds the custom theme to export by name, never 汐岛', () => {
    expect(exportedTheme(library, '纸白')).toEqual(c)
    expect(exportedTheme(library, ' 夜航 ')).toEqual(b)
    expect(exportedTheme(applied(library, selectBuiltinTheme()), '夜航')).toEqual(b)
    expect(exportedTheme(library, '汐岛')).toBeNull()
    expect(exportedTheme(library, '不存在')).toBeNull()
    expect(exportedTheme(DEFAULT_SETTINGS, '汐岛')).toBeNull()
  })

  it('copies a theme as “<name> 副本” at the end and uses it, numbering repeated copies', () => {
    const copied = applied(library, copyTheme(library, '青瓷', 'light'))
    expect(names(copied)).toEqual(['青瓷', '夜航', '纸白', '青瓷 副本'])
    expect(copied.customTheme).toEqual({ ...a, name: '青瓷 副本' })
    expect(copied.customThemeEnabled).toBe(true)
    const again = applied(copied, copyTheme(copied, '青瓷', 'light'))
    expect(names(again).at(-1)).toBe('青瓷 副本 2')
    expect(names(applied(again, copyTheme(again, '青瓷 副本', 'light'))).at(-1)).toBe('青瓷 副本 副本')
    // A copy of the theme not in use (汐岛 in use) is used.
    const builtin = applied(library, selectBuiltinTheme())
    expect(applied(builtin, copyTheme(builtin, '纸白', 'light'))).toMatchObject({ customTheme: { ...c, name: '纸白 副本' }, customThemeEnabled: true })
    expect(copyTheme(library, '不存在', 'light')).toEqual({ ok: false, reason: 'not-found' })
  })

  it('copies 汐岛 as a new theme named 汐岛 副本', () => {
    const copied = applied(library, copyTheme(library, '汐岛', 'dark'))
    expect(copied.customTheme).toEqual({ ...themeFromBuiltin('dark'), name: '汐岛 副本' })
    expect(names(applied(copied, copyTheme(copied, '汐岛', 'dark'))).at(-1)).toBe('汐岛 副本 2')
    expect(applied(DEFAULT_SETTINGS, copyTheme(DEFAULT_SETTINGS, '汐岛', 'light'))).toMatchObject({
      customTheme: { ...themeFromBuiltin('light'), name: '汐岛 副本' }, customThemeEnabled: true, customThemeList: { others: [], currentIndex: 0 }
    })
  })

  it('shortens the original name of a copy, keeping 副本 and the number within 40 characters', () => {
    const long = '长'.repeat(40)
    const settings = { ...DEFAULT_SETTINGS, customTheme: theme(long), customThemeEnabled: true }
    const first = applied(settings, copyTheme(settings, long, 'light'))
    expect(first.customTheme?.name).toBe(`${'长'.repeat(37)} 副本`)
    const second = applied(first, copyTheme(first, long, 'light'))
    expect(second.customTheme?.name).toBe(`${'长'.repeat(35)} 副本 2`)
    expect([...second.customTheme!.name]).toHaveLength(40)
  })

  it(`refuses copies past ${MAX_CUSTOM_THEMES} themes, 汐岛 included`, () => {
    const full = many(MAX_CUSTOM_THEMES)
    expect(copyTheme(full, '主题 1', 'light')).toEqual({ ok: false, reason: 'full' })
    expect(copyTheme(full, '汐岛', 'light')).toEqual({ ok: false, reason: 'full' })
  })

  it('deletes a theme not in use without changing what is in use', () => {
    for (const settings of [library, applied(library, selectBuiltinTheme())]) {
      const before = deleteTheme(settings, '青瓷')
      expect(before).toEqual({ ok: true, deleted: { theme: a, index: 0, inUse: false }, patch: { customThemeList: { others: [c], currentIndex: 0 } } })
      expect(applied(settings, before)).toMatchObject({ customTheme: b, customThemeEnabled: settings.customThemeEnabled })
      const after = applied(settings, deleteTheme(settings, '纸白'))
      expect(names(after)).toEqual(['青瓷', '夜航'])
      expect(after).toMatchObject({ customTheme: b, customThemeEnabled: settings.customThemeEnabled, customThemeList: { others: [a], currentIndex: 1 } })
    }
    expect(deleteTheme(library, '不存在')).toEqual({ ok: false, reason: 'not-found' })
    expect(deleteTheme(library, '汐岛')).toEqual({ ok: false, reason: 'not-found' })
  })

  it('deleting the theme in use goes back to 汐岛 and makes the next (else the previous) theme current, out of use', () => {
    const result = deleteTheme(library, '夜航')
    expect(result).toMatchObject({ ok: true, deleted: { theme: b, index: 1, inUse: true } })
    const next = applied(library, result)
    expect(next).toMatchObject({ customTheme: c, customThemeEnabled: false, customThemeList: { others: [a], currentIndex: 1 } })
    expect(names(next)).toEqual(['青瓷', '纸白'])
    // The last one: the previous theme.
    const last = applied(next, selectCustomTheme(next, '纸白'))
    const previous = applied(last, deleteTheme(last, '纸白'))
    expect(previous).toMatchObject({ customTheme: a, customThemeEnabled: false, customThemeList: { others: [], currentIndex: 0 } })
    // The only one: no current theme.
    expect(applied(previous, deleteTheme(previous, '青瓷'))).toMatchObject({ customTheme: null, customThemeEnabled: false, customThemeList: { others: [], currentIndex: 0 } })
    // The current theme while 汐岛 is in use: the same promotion, nothing put in use.
    const builtin = applied(library, selectBuiltinTheme())
    expect(deleteTheme(builtin, '夜航')).toMatchObject({ deleted: { inUse: false } })
    expect(applied(builtin, deleteTheme(builtin, '夜航'))).toMatchObject({ customTheme: c, customThemeEnabled: false })
  })

  it('restores a deleted theme at its place and its use', () => {
    const undo = (settings: AppSettings, name: string) => {
      const result = deleteTheme(settings, name)
      if (!result.ok) throw new Error(result.reason)
      const deletedFrom = applied(settings, result)
      return applied(deletedFrom, restoreTheme(deletedFrom, result.deleted))
    }
    // In use: back in use, at its place.
    expect(undo(library, '夜航')).toEqual(library)
    // Not in use: back at its place; what is in use stays.
    expect(undo(library, '青瓷')).toEqual(library)
    expect(undo(library, '纸白')).toEqual(library)
    const builtin = applied(library, selectBuiltinTheme())
    for (const name of ['青瓷', '纸白']) expect(undo(builtin, name)).toEqual(builtin)
    // The current theme deleted while 汐岛 was in use: 汐岛 stays in use.
    const restored = undo(builtin, '夜航')
    expect(names(restored)).toEqual(['青瓷', '夜航', '纸白'])
    expect(restored.customThemeEnabled).toBe(false)
    // The only theme: it is the current one again.
    const single = { ...DEFAULT_SETTINGS, customTheme: a, customThemeEnabled: true }
    expect(undo(single, '青瓷')).toEqual(single)
    // Things changed since: in use again even after another theme was chosen; past the end it goes last.
    const deleted: DeletedTheme = { theme: b, index: 1, inUse: true }
    const back = applied(single, restoreTheme(single, deleted))
    expect(names(back)).toEqual(['青瓷', '夜航'])
    expect(back).toMatchObject({ customTheme: b, customThemeEnabled: true, customThemeList: { others: [a], currentIndex: 1 } })
    expect(applied(DEFAULT_SETTINGS, restoreTheme(DEFAULT_SETTINGS, { theme: c, index: 2, inUse: false }))).toMatchObject({
      customTheme: c, customThemeEnabled: false, customThemeList: { others: [], currentIndex: 0 }
    })
  })

  it('numbers a restored theme whose name was taken since', () => {
    const result = deleteTheme(library, '青瓷')
    if (!result.ok) throw new Error(result.reason)
    const deletedFrom = applied(library, result)
    const renamed = applied(deletedFrom, saveCurrentTheme(deletedFrom, { ...b, name: '青瓷' }))
    const restored = applied(renamed, restoreTheme(renamed, result.deleted))
    expect(names(restored)).toEqual(['青瓷 2', '青瓷', '纸白'])
    expect(restored.customThemeList.others[0]).toEqual({ ...a, name: '青瓷 2' })
  })

  it(`refuses restoring when the list already has ${MAX_CUSTOM_THEMES} themes`, () => {
    const full = many(MAX_CUSTOM_THEMES)
    const result = deleteTheme(full, '主题 2')
    if (!result.ok) throw new Error(result.reason)
    const deletedFrom = applied(full, result)
    const refilled = applied(deletedFrom, createTheme(deletedFrom, 'light'))
    expect(customThemes(refilled)).toHaveLength(MAX_CUSTOM_THEMES)
    expect(restoreTheme(refilled, result.deleted)).toEqual({ ok: false, reason: 'full' })
    expect(applied(deletedFrom, restoreTheme(deletedFrom, result.deleted))).toEqual(full)
  })

  it('writes every operation as one settings update', async () => {
    const db = open(join(folder(), 'a.sqlite'))
    const store = countingStore(db)
    const service = createSettingsService(store)
    expect((await service.update({ customTheme: b, customThemeEnabled: true, customThemeList: { others: [a, c], currentIndex: 1 } })).saved).toBe(true)
    const steps: ((current: AppSettings) => ThemeListResult)[] = [
      (current) => selectCustomTheme(current, '纸白'),
      () => selectBuiltinTheme(),
      (current) => createTheme(current, 'light'),
      (current) => saveCurrentTheme(current, { ...current.customTheme!, name: '晨雾' }),
      (current) => selectCustomTheme(current, '夜航'),
      (current) => copyTheme(current, '晨雾', 'light'),
      (current) => deleteTheme(current, '晨雾 副本'),
      (current) => restoreTheme(current, { theme: { ...b, name: '晨雾 副本' }, index: 4, inUse: true }),
      (current) => deleteTheme(current, '晨雾 副本'),
      (current) => importTheme(current, { ...a, name: '晨雾' }),
      (current) => deleteTheme(current, '晨雾 2'),
      (current) => selectCustomTheme(current, '夜航')
    ]
    for (const step of steps) {
      const before = store.saves
      const current = db.loadSettings()
      const result = step(current)
      if (!result.ok) throw new Error(result.reason)
      expect(await service.update(result.patch)).toMatchObject({ saved: true, issues: [] })
      expect(store.saves - before).toBe(1)
      expect(db.loadSettings()).toEqual(applied(current, result))
    }
    expect(names(db.loadSettings())).toEqual(['青瓷', '夜航', '纸白', '晨雾'])
    expect(db.loadSettings()).toMatchObject({ customTheme: b, customThemeEnabled: true })
  })
})

describe('theme list settings', () => {
  it.each([
    ['other themes without a current one', { customTheme: null, customThemeEnabled: false, customThemeList: { others: [a], currentIndex: 0 } }, 'customThemeList'],
    ['the place past the end', { customThemeList: { others: [a, c], currentIndex: 3 } }, 'customThemeList.currentIndex'],
    ['a name used twice', { customThemeList: { others: [a, { ...c, name: '青瓷' }], currentIndex: 1 } }, 'customThemeList.others.1.name'],
    ['a name equal to the current one', { customThemeList: { others: [a, { ...c, name: '夜航' }], currentIndex: 1 } }, 'customTheme.name'],
    ['a custom theme named 汐岛', { customThemeList: { others: [a, { ...c, name: '汐岛' }], currentIndex: 1 } }, 'customThemeList.others.1.name'],
    ['more than 50 themes', { customThemeList: { others: many(MAX_CUSTOM_THEMES).customThemeList.others.concat(theme('多余')), currentIndex: 0 } }, 'customThemeList.others']
  ])('refuses a whole update with %s and keeps the settings', async (_label, patch, field) => {
    const db = open(join(folder(), 'a.sqlite'))
    const service = createSettingsService(countingStore(db))
    await service.update({ customTheme: b, customThemeEnabled: true, customThemeList: { others: [a, c], currentIndex: 1 } })
    const before = db.loadSettings()
    const refused = await service.update({ ...patch, density: 'compact' })
    expect(refused).toMatchObject({ saved: false, settings: before })
    expect(refused.issues.map((issue) => issue.kind === 'field' && issue.field)).toContain(field)
    expect(db.loadSettings()).toEqual(before)
  })

  it.each([true, false])('reads settings with only the single-theme keys as one custom theme, in use: %s', (enabled) => {
    const settings = settingsFromStored(new Map<string, unknown>([['customTheme', a], ['customThemeEnabled', enabled]]))
    expect(names(settings)).toEqual(['青瓷'])
    expect(settings).toMatchObject({ customTheme: a, customThemeEnabled: enabled, customThemeList: { others: [], currentIndex: 0 } })
  })

  it.each<[string, unknown, Partial<AppSettings>]>([
    ['a missing list', undefined, { customThemeList: { others: [], currentIndex: 0 } }],
    ['an unreadable list', 'broken', { customThemeList: { others: [], currentIndex: 0 } }],
    [
      'invalid themes among the others, keeping the place',
      { others: [a, { ...c, colors: 'red' }, { name: '' }, c], currentIndex: 3 },
      { customThemeList: { others: [a, c], currentIndex: 1 } }
    ],
    [
      'repeated names, numbered in order',
      { others: [a, { ...c, name: '夜航' }, { ...c, name: '青瓷' }], currentIndex: 1 },
      { customThemeList: { others: [a, { ...c, name: '夜航 2' }, { ...c, name: '青瓷 2' }], currentIndex: 1 } }
    ],
    ['a custom theme named 汐岛', { others: [{ ...a, name: '汐岛' }], currentIndex: 0 }, { customThemeList: { others: [{ ...a, name: '汐岛 2' }], currentIndex: 0 } }],
    ['the place past the end', { others: [a, c], currentIndex: 9 }, { customThemeList: { others: [a, c], currentIndex: 2 } }],
    ['a negative place', { others: [a, c], currentIndex: -4 }, { customThemeList: { others: [a, c], currentIndex: 0 } }]
  ])('falls back for %s', (_label, list, expected) => {
    const stored = new Map<string, unknown>([['customTheme', b], ['customThemeEnabled', true], ['density', 'compact']])
    if (list !== undefined) stored.set('customThemeList', list)
    expect(settingsFromStored(stored)).toEqual({ ...DEFAULT_SETTINGS, density: 'compact', customTheme: b, customThemeEnabled: true, ...expected })
  })

  it('renames a current theme named 汐岛 and keeps it in use', () => {
    const settings = settingsFromStored(new Map<string, unknown>([['customTheme', { ...a, name: '汐岛' }], ['customThemeEnabled', true]]))
    expect(settings).toMatchObject({ customTheme: { ...a, name: '汐岛 2' }, customThemeEnabled: true })
  })

  it('makes the first other theme current, not in use, when there is no current theme', () => {
    const settings = settingsFromStored(new Map<string, unknown>([
      ['customTheme', null], ['customThemeEnabled', true], ['customThemeList', { others: [{ name: 'bad' }, a, c], currentIndex: 2 }]
    ]))
    expect(settings).toMatchObject({ customTheme: a, customThemeEnabled: false, customThemeList: { others: [c], currentIndex: 0 } })
  })

  it('keeps the list when an older version rewrites only customTheme, which reads as the current theme', async () => {
    const path = join(folder(), 'a.sqlite')
    const db = open(path)
    await createSettingsService(countingStore(db)).update({ customTheme: b, customThemeEnabled: true, customThemeList: { others: [a, c], currentIndex: 1 } })
    close(db)

    // An older version knows customTheme and customThemeEnabled only: it rewrites those rows and leaves the list row.
    const rewrite = (current: CustomTheme, enabled: boolean) => {
      const raw = new Database(path)
      raw.prepare("UPDATE settings SET value_json = ? WHERE key = 'customTheme'").run(JSON.stringify(current))
      raw.prepare("UPDATE settings SET value_json = ? WHERE key = 'customThemeEnabled'").run(JSON.stringify(enabled))
      raw.close()
    }
    const edited = { ...b, colors: { ...b.colors, light: { ...b.colors.light, accent: '#aa3366' } } }
    rewrite(edited, true)
    let reopened = open(path)
    expect(reopened.loadSettings()).toMatchObject({ customTheme: edited, customThemeEnabled: true, customThemeList: { others: [a, c], currentIndex: 1 } })
    expect(names(reopened.loadSettings())).toEqual(['青瓷', '夜航', '纸白'])
    close(reopened)

    // Renamed there to another theme's name: the current theme keeps it, the other one is numbered.
    rewrite({ ...edited, name: '纸白' }, false)
    reopened = open(path)
    expect(names(reopened.loadSettings())).toEqual(['青瓷', '纸白', '纸白 2'])
    expect(reopened.loadSettings()).toMatchObject({ customTheme: { ...edited, name: '纸白' }, customThemeEnabled: false })
  })
})
