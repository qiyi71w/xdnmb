import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSettingsService, type SettingsStore } from '../src/main/appearance'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { applySettingsPatch, DEFAULT_SETTINGS, nextZoomFactor, resolveAppearance, settingsFromStored, type AppSettings } from '../src/shared/settings'
import { COOKIE_COLORS } from '../src/shared/cookieColors'
import {
  cookieColorToken,
  TEXT_CONTRAST_PAIRS,
  BUILTIN_PALETTES,
  contrastRatio,
  customPalette,
  MAX_THEME_FILE_BYTES,
  paletteContrastFailures,
  parseColor,
  parseCustomTheme,
  parseThemeDocument,
  serializeThemeDocument,
  themeDocument,
  themeFromBuiltin,
  type CustomTheme
} from '../src/shared/theme'

const folders: string[] = []
const databases: ReadingDatabase[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'xidao-appearance-'))
  folders.push(path)
  return path
}

function open(path: string): ReadingDatabase {
  const db = openReadingDatabase(path)
  databases.push(db)
  return db
}

function storeOf(db: ReadingDatabase): SettingsStore {
  return { loadSettings: async () => db.loadSettings(), saveSettings: async (settings) => db.saveSettings(settings) }
}

const color = (text: string) => parseColor(text)!

const sepia: CustomTheme = {
  name: '旧纸',
  colors: {
    light: { background: '#efe6d6', surface: '#fbf6ec', text: '#2b2118', secondaryText: '#5a4a3a', accent: '#7a3e12' },
    dark: themeFromBuiltin('dark').colors.dark
  },
  opacity: 0.7,
  radius: 10
}

describe('contrast', () => {
  it('computes WCAG ratios at the 4.5:1 boundary', () => {
    expect(contrastRatio(color('#000000'), color('#ffffff'))).toBeCloseTo(21, 5)
    expect(contrastRatio(color('#767676'), color('#ffffff'))).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(color('#777777'), color('#ffffff'))).toBeLessThan(4.5)
  })

  it('keeps every ordinary text color of both built-in themes at 4.5:1 or more', () => {
    expect(paletteContrastFailures(BUILTIN_PALETTES.light)).toEqual([])
    expect(paletteContrastFailures(BUILTIN_PALETTES.dark)).toEqual([])
  })

  it('checks every 饼干标色 on the surfaces a 饼干 ID is drawn on, selected rows included, for built-in and custom themes', () => {
    for (const name of COOKIE_COLORS) {
      const surfaces = TEXT_CONTRAST_PAIRS.find((pair) => pair.foreground === cookieColorToken(name))?.surfaces ?? []
      // Quote cards (translucent glass) open over the reading paper and over the list pane alike.
      expect(surfaces).toEqual(expect.arrayContaining([['paper'], ['pane'], ['pane', 'selected'], ['paper', 'selected'], ['paper', 'glass-strong'], ['pane', 'glass-strong']]))
    }
    // A custom theme's 饼干标色 are its own, pulled toward the text color only as far as contrast needs.
    const palette = customPalette(sepia, 'light')
    expect(paletteContrastFailures(palette)).toEqual([])
    expect(new Set(COOKIE_COLORS.map((name) => palette[cookieColorToken(name)])).size).toBe(COOKIE_COLORS.length)
  })

  it('checks official red text on every surface a body, excerpt or board notice draws it on', () => {
    const surfaces = TEXT_CONTRAST_PAIRS.find((pair) => pair.foreground === 'danger-ink')?.surfaces ?? []
    expect(surfaces).toEqual(expect.arrayContaining([['paper'], ['pane'], ['info-bg'], ['paper', 'glass-strong'], ['pane', 'glass-strong'],
      ['paper', 'accent-soft'], ['pane', 'hover'], ['pane', 'selected'], ['paper', 'hover'], ['paper', 'selected']]))
    expect(paletteContrastFailures(customPalette(sepia, 'light'))).toEqual([])
    expect(paletteContrastFailures(customPalette(sepia, 'dark'))).toEqual([])
  })

  it('checks page buttons on the notices and panes they sit in, at rest and under the pointer', () => {
    const surfacesOf = (foreground: string) => TEXT_CONTRAST_PAIRS.filter((pair) => pair.foreground === foreground).flatMap((pair) => pair.surfaces)
    // 重试 inside error and cached notices: transparent at rest, the hover overlay on the notice tint.
    expect(surfacesOf('ink-2')).toEqual(expect.arrayContaining([['danger-bg'], ['warn-bg']]))
    expect(surfacesOf('ink')).toEqual(expect.arrayContaining([['danger-bg', 'hover'], ['warn-bg', 'hover']]))
    // Danger page buttons on the reading paper and the list pane, the danger tint under them on hover.
    expect(surfacesOf('danger-ink')).toEqual(expect.arrayContaining([['paper'], ['pane'], ['paper', 'danger-bg'], ['pane', 'danger-bg']]))
  })
  it('checks translucent glass as composited over the window, not the solid surface alone', () => {
    // Secondary text passes on the solid surface but not on 50% glass over a dark window.
    const theme: CustomTheme = { ...sepia, colors: { ...sepia.colors, light: { ...sepia.colors.light, background: '#5c5c5c', secondaryText: '#6e6e6e' } }, opacity: 0.5 }
    expect(contrastRatio(color('#6e6e6e'), color(sepia.colors.light.surface))).toBeGreaterThanOrEqual(4.5)
    const result = parseCustomTheme(theme)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toContainEqual(expect.objectContaining({ kind: 'contrast', foreground: 'ink-2', surface: ['window', 'glass'] }))
  })

  it('checks the transparent top bar text directly on the window tints', () => {
    // Secondary text passes on the plain window (4.52:1) but not on the accent tint drawn behind the tabs.
    const theme: CustomTheme = {
      ...sepia,
      colors: { ...sepia.colors, light: { background: '#ababab', surface: '#ffffff', text: '#000000', secondaryText: '#404040', accent: '#000000' } },
      opacity: 0.5
    }
    const result = parseCustomTheme(theme)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.issues).toContainEqual(expect.objectContaining({ kind: 'contrast', foreground: 'ink-2', surface: ['window-tint-a'] }))
  })
})

describe('custom themes', () => {
  it('uses the user colors as given and keeps derived status text legible', () => {
    const palette = customPalette(sepia, 'light')
    expect([palette.window, palette.paper, palette.ink, palette['ink-2'], palette['accent-ink']]).toEqual([
      sepia.colors.light.background,
      sepia.colors.light.surface,
      sepia.colors.light.text,
      sepia.colors.light.secondaryText,
      sepia.colors.light.accent
    ])
    expect(paletteContrastFailures(palette)).toEqual([])
  })

  it('refuses a theme whose own colors are too low in contrast, naming the pair and ratio', () => {
    const result = parseCustomTheme({ ...sepia, colors: { ...sepia.colors, light: { ...sepia.colors.light, text: '#b0a898' } } })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const issue = result.issues.find((i) => i.kind === 'contrast' && i.foreground === 'ink' && i.surface.join() === 'paper')
    expect(issue).toMatchObject({ minimum: 4.5 })
    expect(issue && issue.kind === 'contrast' && issue.ratio).toBeLessThan(4.5)
  })

  it('seeds custom themes from both built-in schemes that pass the same checks', () => {
    expect(parseCustomTheme(themeFromBuiltin('light')).ok).toBe(true)
    expect(parseCustomTheme(themeFromBuiltin('dark')).ok).toBe(true)
  })
})

describe('dual-set appearance', () => {
  it.each(['light', 'dark'] as const)('migrates an old %s theme without changing its colors', (base) => {
    const old = { name: '旧主题', base, colors: sepia.colors[base], opacity: 0.7, radius: 10 }
    const settings = settingsFromStored(new Map<string, unknown>([['colorScheme', 'custom'], ['customTheme', old]]))
    expect(settings.colorScheme).toBe(base)
    expect(settings.customThemeEnabled).toBe(true)
    expect(settings.customTheme?.colors[base]).toEqual(old.colors)
    const other = base === 'light' ? 'dark' : 'light'
    expect(settings.customTheme?.colors[other]).toEqual(themeFromBuiltin(other).colors[other])
  })

  it('selects the custom set using the app mode and follows system changes', () => {
    const settings = { ...DEFAULT_SETTINGS, customTheme: sepia, customThemeEnabled: true }
    expect(resolveAppearance(settings, false).variables['--paper']).toBe(sepia.colors.light.surface)
    expect(resolveAppearance(settings, true).variables['--paper']).toBe(sepia.colors.dark.surface)
    expect(resolveAppearance({ ...settings, colorScheme: 'light' }, true).scheme).toBe('light')
    expect(resolveAppearance({ ...settings, colorScheme: 'dark' }, false).scheme).toBe('dark')
    expect(resolveAppearance({ ...settings, customThemeEnabled: false }, false).variables['--paper']).toBe(BUILTIN_PALETTES.light.paper)
  })

  it('checks the inactive dark set too', () => {
    const parsed = parseCustomTheme({ ...sepia, colors: { ...sepia.colors, dark: { ...sepia.colors.dark, text: sepia.colors.dark.surface } } })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues).toContainEqual(expect.objectContaining({ kind: 'contrast', scheme: 'dark', foreground: 'ink' }))
  })

  it('accepts installed font family names and safely quotes the CSS font family', () => {
    const reading = { ...DEFAULT_SETTINGS.reading, font: 'local:Noto Serif CJK SC' as const }
    expect(applySettingsPatch(DEFAULT_SETTINGS, { reading }).ok).toBe(true)
    expect(resolveAppearance({ ...DEFAULT_SETTINGS, reading }, false).variables['--font-reading']).toBe('"Noto Serif CJK SC", var(--font-ui)')
    expect(applySettingsPatch(DEFAULT_SETTINGS, { reading: { ...reading, font: 'local:bad\nfont' } }).ok).toBe(false)
  })
})

describe('theme documents', () => {
  const valid = () => themeDocument(sepia, { font: 'serif', fontSize: 18, readingWidth: 38 })

  it('round-trips through the file format', () => {
    const parsed = parseThemeDocument(serializeThemeDocument(valid()))
    expect(parsed).toEqual({ ok: true, theme: sepia, reading: { font: 'serif', fontSize: 18, readingWidth: 38 } })
  })

  it.each(['light', 'dark'] as const)('imports version 1 %s files and exports version 2', (base) => {
    const old = { format: 'xidao-theme', version: 1, name: '旧主题', base, colors: sepia.colors[base], opacity: 0.7, radius: 10, font: 'sans', fontSize: 16, readingWidth: 42 }
    const parsed = parseThemeDocument(JSON.stringify(old))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.theme.colors[base]).toEqual(old.colors)
    expect(themeDocument(parsed.theme, parsed.reading).version).toBe(2)
  })


  it.each([
    ['not JSON', '{', { kind: 'syntax' }],
    ['another format', JSON.stringify({ format: 'other', version: 1 }), { kind: 'format' }],
    ['a newer version', JSON.stringify({ ...valid(), version: 3 }), { kind: 'version', found: 3 }],
    ['an unknown field', JSON.stringify({ ...valid(), css: 'body{}' }), { kind: 'field', field: 'css', problem: 'unknown' }],
    ['a non-hex color', JSON.stringify({ ...valid(), colors: { ...sepia.colors, light: { ...sepia.colors.light, text: 'red' } } }), { kind: 'field', field: 'colors.light.text', problem: 'range' }],
    ['an out-of-range size', JSON.stringify({ ...valid(), fontSize: 40 }), { kind: 'field', field: 'fontSize', problem: 'range' }],
    ['an unknown font', JSON.stringify({ ...valid(), font: 'Comic Sans' }), { kind: 'field', field: 'font', problem: 'range' }],
    ['a missing field', JSON.stringify({ ...valid(), radius: undefined }), { kind: 'field', field: 'radius', problem: 'missing' }]
  ])('refuses %s', (_label, text, issue) => {
    const parsed = parseThemeDocument(text)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.issues).toContainEqual(issue)
  })
})

describe('settings', () => {
  it('refuses a whole update when any part is invalid', () => {
    const result = applySettingsPatch(DEFAULT_SETTINGS, { density: 'compact', reading: { font: 'sans', fontSize: 99, readingWidth: 42 } })
    expect(result).toEqual({ ok: false, issues: [{ kind: 'field', field: 'reading.fontSize', problem: 'range' }] })
  })

  it('validates close behavior with appearance and falls back independently for invalid stored values', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { closeAction: 'background', density: 'compact' })).toEqual({
      ok: true, value: { ...DEFAULT_SETTINGS, closeAction: 'background', density: 'compact' }
    })
    expect(applySettingsPatch(DEFAULT_SETTINGS, { closeAction: 'invalid', density: 'compact' })).toMatchObject({
      ok: false, issues: [{ field: 'closeAction', problem: 'range' }]
    })
    expect(settingsFromStored(new Map<string, unknown>([['closeAction', 'invalid'], ['density', 'compact']]))).toEqual({
      ...DEFAULT_SETTINGS, density: 'compact'
    })
    expect(settingsFromStored(new Map<string, unknown>([['closeAction', 'quit'], ['density', 'invalid']]))).toEqual({
      ...DEFAULT_SETTINGS, closeAction: 'quit'
    })
  })

  it('refuses enabling a custom theme before one exists', () => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, { customThemeEnabled: true })).toMatchObject({ ok: false, issues: [{ field: 'customThemeEnabled', problem: 'unavailable' }] })
  })

  it('falls back per value when stored settings are no longer valid', () => {
    const stored = new Map<string, unknown>([
      ['density', 'compact'],
      ['colorScheme', 'custom'],
      ['customTheme', { ...sepia, colors: { ...sepia.colors, light: { ...sepia.colors.light, text: sepia.colors.light.surface } } }],
      ['reading', { font: 'serif', fontSize: 12, readingWidth: 42 }]
    ])
    expect(settingsFromStored(stored)).toEqual({ ...DEFAULT_SETTINGS, density: 'compact', colorScheme: 'system', customTheme: null })
  })

  const navigation: Pick<AppSettings, 'rail' | 'boards' | 'listWidth' | 'customKaomoji'> = {
    rail: { order: ['history', 'search'], hidden: ['drafts'] },
    boards: { favorites: ['forum:4', 'timeline:1'], hidden: ['forum:20'], order: { 'group-1': ['forum:9', 'forum:4'] }, collapsed: ['group-2', 'timelines'] },
    listWidth: 512,
    customKaomoji: [{ text: '(｀・ω・)' }, { text: '多行\n颜文字', name: '多行' }]
  }

  it('keeps navigation, list width and custom kaomoji across a restart', async () => {
    const path = join(folder(), 'settings.sqlite')
    const first = open(path)
    const result = await createSettingsService(storeOf(first)).update(navigation)
    expect(result).toMatchObject({ saved: true, issues: [] })
    first.close()
    databases.splice(databases.indexOf(first), 1)
    expect(open(path).loadSettings()).toEqual({ ...DEFAULT_SETTINGS, ...navigation })
  })

  it('uses the default for each navigation value that is missing, corrupt or no longer valid', () => {
    const path = join(folder(), 'settings.sqlite')
    const first = open(path)
    first.saveSettings({ ...DEFAULT_SETTINGS, ...navigation, density: 'compact' })
    first.close()
    databases.splice(databases.indexOf(first), 1)
    const raw = new Database(path)
    const set = raw.prepare('UPDATE settings SET value_json = ? WHERE key = ?')
    set.run('{not json', 'rail')
    set.run(JSON.stringify({ ...navigation.boards, hidden: ['forum:20', 'forum:20'] }), 'boards')
    set.run(JSON.stringify(99), 'listWidth')
    raw.prepare('DELETE FROM settings WHERE key = ?').run('customKaomoji')
    raw.close()
    expect(open(path).loadSettings()).toEqual({ ...DEFAULT_SETTINGS, density: 'compact' })
  })

  it('reads stored kaomoji saved as plain strings as unnamed entries', () => {
    const stored = new Map<string, unknown>([['customKaomoji', ['(｀・ω・)', '多行\n颜文字']]])
    expect(settingsFromStored(stored).customKaomoji).toEqual([{ text: '(｀・ω・)' }, { text: '多行\n颜文字' }])
  })

  it('drops only the invalid stored kaomoji and keeps the rest and the other settings', () => {
    const stored = new Map<string, unknown>([
      ['density', 'compact'],
      ['customKaomoji', [
        'old',
        { text: 'a', name: '一二三四五六七八九十一二三四五六七' },
        { text: 'b', name: '两\n行' },
        { text: 'c', name: ' padded ' },
        { text: 'd', name: '' },
        { text: 'e\r\nf' },
        { text: 'old', name: 'again' },
        { text: 'g', name: '一二三四五六七八九十一二三四五六' },
        { text: 'h', extra: true },
        42
      ]]
    ])
    expect(settingsFromStored(stored)).toEqual({ ...DEFAULT_SETTINGS, density: 'compact', customKaomoji: [{ text: 'old' }, { text: 'g', name: '一二三四五六七八九十一二三四五六' }] })
  })

  it.each([
    ['a timeline order', { boards: { ...navigation.boards, order: { timelines: ['timeline:1'] } } }, 'boards.order'],
    ['a timeline in a group order', { boards: { ...navigation.boards, order: { 'group-1': ['timeline:1'] } } }, 'boards.order'],
    ['a repeated favorite', { boards: { ...navigation.boards, favorites: ['forum:4', 'forum:4'] } }, 'boards.favorites'],
    ['an unknown feature', { rail: { order: ['settings'], hidden: [] } }, 'rail.order'],
    ['a blank kaomoji', { customKaomoji: [{ text: '  ' }] }, 'customKaomoji'],
    ['a kaomoji named past 16 characters', { customKaomoji: [{ text: 'x', name: '一二三四五六七八九十一二三四五六七' }] }, 'customKaomoji'],
    ['a kaomoji repeated under another name', { customKaomoji: [{ text: 'x' }, { text: 'x', name: '别名' }] }, 'customKaomoji'],
    ['a list narrower than the minimum', { listWidth: 100 }, 'listWidth']
  ])('refuses %s', (_label, patch, field) => {
    expect(applySettingsPatch(DEFAULT_SETTINGS, patch)).toMatchObject({ ok: false, issues: [{ field }] })
  })

  it('steps interface zoom through exactly 200% and stops at both ends', () => {
    let factor = 1
    const seen: number[] = []
    for (let i = 0; i < 20; i++) seen.push((factor = nextZoomFactor(factor, 'in')))
    expect(seen).toContain(2)
    expect(nextZoomFactor(factor, 'in')).toBe(factor)
    expect(nextZoomFactor(0.5, 'out')).toBe(0.5)
    expect(nextZoomFactor(1.3, 'out')).toBe(1.25)
    expect(nextZoomFactor(2.5, 'reset')).toBe(1)
  })
})

describe('settings service with real storage', () => {
  it('persists updates across reopening and leaves settings untouched when an update is refused', async () => {
    const path = join(folder(), 'reading.sqlite')
    const service = createSettingsService(storeOf(open(path)))
    const saved = await service.update({ density: 'compact', motion: 'reduce', reading: { font: 'serif', fontSize: 20, readingWidth: 36 } })
    expect(saved).toMatchObject({ saved: true, issues: [] })
    const refused = await service.update({ customTheme: { ...sepia, colors: { ...sepia.colors, light: { ...sepia.colors.light, accent: '#fbf6ec' } } }, customThemeEnabled: true })
    expect(refused.saved).toBe(false)
    expect(refused.issues.length).toBeGreaterThan(0)
    expect(refused.settings).toEqual(saved.settings)
    expect(open(path).loadSettings()).toEqual(saved.settings)
  })

  it('keeps the previous theme when an import is invalid, too large or unreadable', async () => {
    const dir = folder()
    const db = open(join(dir, 'reading.sqlite'))
    const service = createSettingsService(storeOf(db))
    await service.update({ customTheme: sepia, customThemeEnabled: true })
    const before = db.loadSettings()

    const lowContrast = join(dir, 'low.json')
    writeFileSync(lowContrast, serializeThemeDocument(themeDocument({ ...sepia, colors: { ...sepia.colors, light: { ...sepia.colors.light, text: '#d8d0c0' } } }, DEFAULT_SETTINGS.reading)))
    expect(await service.importTheme(lowContrast)).toMatchObject({
      status: 'rejected',
      issues: expect.arrayContaining([expect.objectContaining({ kind: 'contrast', foreground: 'ink', surface: ['paper'] })])
    })

    const large = join(dir, 'large.json')
    writeFileSync(large, ' '.repeat(MAX_THEME_FILE_BYTES + 1))
    expect(await service.importTheme(large)).toEqual({ status: 'failed', reason: 'too-large' })

    const notUtf8 = join(dir, 'bytes.json')
    writeFileSync(notUtf8, Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))
    expect(await service.importTheme(notUtf8)).toEqual({ status: 'rejected', issues: [{ kind: 'syntax' }] })

    expect(await service.importTheme(join(dir, 'missing.json'))).toEqual({ status: 'failed', reason: 'read' })
    expect(await service.importTheme(null)).toEqual({ status: 'cancelled' })
    expect(db.loadSettings()).toEqual(before)
  })

  it('restores the exported theme and reading parameters in another profile', async () => {
    const dir = folder()
    const source = createSettingsService(storeOf(open(join(dir, 'a.sqlite'))))
    await source.update({ customTheme: sepia, colorScheme: 'light', reading: { font: 'serif', fontSize: 19, readingWidth: 34 } })
    const file = join(dir, 'theme.json')
    expect(await source.exportTheme(file, false)).toEqual({ status: 'exported' })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ format: 'xidao-theme', version: 2 })

    const targetDb = open(join(dir, 'b.sqlite'))
    const target = createSettingsService(storeOf(targetDb))
    expect(await target.importTheme(file)).toMatchObject({ status: 'imported' })
    expect(targetDb.loadSettings()).toEqual({
      ...DEFAULT_SETTINGS,
      customThemeEnabled: true,
      customTheme: sepia,
      reading: { font: 'serif', fontSize: 19, readingWidth: 34 }
    })
  })

  it('exports a seed of the built-in scheme in effect when there is no custom theme', async () => {
    const dir = folder()
    const service = createSettingsService(storeOf(open(join(dir, 'a.sqlite'))))
    const file = join(dir, 'theme.json')
    expect(await service.exportTheme(file, true)).toEqual({ status: 'exported' })
    const parsed = parseThemeDocument(readFileSync(file, 'utf8'))
    expect(parsed).toMatchObject({ ok: true, theme: themeFromBuiltin('dark') })
  })
})
