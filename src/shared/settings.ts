// Global preferences: one source of validation for IPC updates, stored rows and theme imports.
import {
  BUILTIN_PALETTES,
  BUILTIN_RADIUS,
  COLOR_TOKENS,
  customPalette,
  DEFAULT_READING,
  isRecord,
  parseCustomTheme,
  parseReadingParams,
  type AppearanceIssue,
  type CustomTheme,
  type Palette,
  type Parsed,
  type ReadingFont,
  type ReadingParams,
  type SchemeBase
} from './theme'

/** `system` follows the operating system's light/dark preference. */
export type ColorScheme = 'system' | 'light' | 'dark' | 'custom'

/** `compact` only reduces padding of the main lists and controls; text size, theme and split stay. */
export type Density = 'comfortable' | 'compact'

/** `system` follows the operating system; `reduce` turns motion off regardless of it. */
export type MotionPreference = 'system' | 'reduce'

export interface AppSettings {
  /** Split preference given to tabs created from now on; existing tabs keep their own. */
  newTabSplitDefault: boolean
  colorScheme: ColorScheme
  /** The user's custom theme; `null` until one is created or imported. Kept when another scheme is chosen. */
  customTheme: CustomTheme | null
  /** Post text font, size and preferred width; apply under every scheme. */
  reading: ReadingParams
  density: Density
  motion: MotionPreference
}

export const DEFAULT_SETTINGS: AppSettings = {
  newTabSplitDefault: true,
  colorScheme: 'system',
  customTheme: null,
  reading: DEFAULT_READING,
  density: 'comfortable',
  motion: 'system'
}

export const SETTING_KEYS = ['newTabSplitDefault', 'colorScheme', 'customTheme', 'reading', 'density', 'motion'] as const satisfies readonly (keyof AppSettings)[]

const COLOR_SCHEMES: readonly ColorScheme[] = ['system', 'light', 'dark', 'custom']
const DENSITIES: readonly Density[] = ['comfortable', 'compact']
const MOTIONS: readonly MotionPreference[] = ['system', 'reduce']

function choice<T extends string>(value: unknown, values: readonly T[], field: string): Parsed<T> {
  if (typeof value !== 'string') return { ok: false, issues: [{ kind: 'field', field, problem: 'type' }] }
  if (!values.includes(value as T)) return { ok: false, issues: [{ kind: 'field', field, problem: 'range' }] }
  return { ok: true, value: value as T }
}

/** Validates one setting value. */
export function parseSetting<K extends keyof AppSettings>(key: K, value: unknown): Parsed<AppSettings[K]> {
  let parsed: Parsed<unknown>
  switch (key) {
    case 'newTabSplitDefault':
      parsed = typeof value === 'boolean' ? { ok: true, value } : { ok: false, issues: [{ kind: 'field', field: key, problem: 'type' }] }
      break
    case 'colorScheme':
      parsed = choice(value, COLOR_SCHEMES, key)
      break
    case 'customTheme':
      parsed = value === null ? { ok: true, value: null } : parseCustomTheme(value, key)
      break
    case 'reading':
      parsed = parseReadingParams(value, key)
      break
    case 'density':
      parsed = choice(value, DENSITIES, key)
      break
    case 'motion':
      parsed = choice(value, MOTIONS, key)
      break
    default:
      parsed = { ok: false, issues: [{ kind: 'field', field: String(key), problem: 'unknown' }] }
  }
  return parsed as Parsed<AppSettings[K]>
}

/** The custom scheme needs a custom theme; anything else is consistent. */
function consistencyIssues(settings: AppSettings): AppearanceIssue[] {
  return settings.colorScheme === 'custom' && settings.customTheme === null
    ? [{ kind: 'field', field: 'colorScheme', problem: 'unavailable' }]
    : []
}

/**
 * Applies a partial update. Every value is validated (custom themes include the contrast checks);
 * any issue refuses the whole update and `current` stays in effect.
 */
export function applySettingsPatch(current: AppSettings, patch: unknown): Parsed<AppSettings> {
  if (!isRecord(patch)) return { ok: false, issues: [{ kind: 'field', field: '', problem: 'type' }] }
  const next: AppSettings = { ...current }
  const issues: AppearanceIssue[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) {
      issues.push({ kind: 'field', field: key, problem: 'unknown' })
      continue
    }
    const settingKey = key as keyof AppSettings
    const parsed = parseSetting(settingKey, value)
    if (parsed.ok) (next as Record<keyof AppSettings, unknown>)[settingKey] = parsed.value
    else issues.push(...parsed.issues)
  }
  issues.push(...(issues.length === 0 ? consistencyIssues(next) : []))
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: next }
}

/**
 * Settings from stored values. A missing or no longer valid value falls back to its default, and a
 * custom scheme whose theme is unusable falls back to `system`; the stored rows are not rewritten.
 */
export function settingsFromStored(stored: ReadonlyMap<string, unknown>): AppSettings {
  const settings: AppSettings = { ...DEFAULT_SETTINGS }
  for (const key of SETTING_KEYS) {
    if (!stored.has(key)) continue
    const parsed = parseSetting(key, stored.get(key))
    if (parsed.ok) (settings as Record<keyof AppSettings, unknown>)[key] = parsed.value
  }
  if (consistencyIssues(settings).length > 0) settings.colorScheme = 'system'
  return settings
}

/** Interface zoom steps (page zoom factors); 2 = 200%. */
export const ZOOM_FACTORS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3] as const

export type ZoomAction = 'in' | 'out' | 'reset'

export interface ZoomState {
  factor: number
  canZoomIn: boolean
  canZoomOut: boolean
}

/** Next zoom factor from `current` (which may lie between steps). */
export function nextZoomFactor(current: number, action: ZoomAction): number {
  if (action === 'reset') return 1
  const epsilon = 0.001
  if (action === 'in') return ZOOM_FACTORS.find((f) => f > current + epsilon) ?? ZOOM_FACTORS[ZOOM_FACTORS.length - 1]!
  return [...ZOOM_FACTORS].reverse().find((f) => f < current - epsilon) ?? ZOOM_FACTORS[0]
}

/** Zoom as reported to the UI; Chromium's factor carries float noise (e.g. 1.7499999999999998). */
export function zoomState(rawFactor: number): ZoomState {
  const factor = Math.round(rawFactor * 1000) / 1000
  return { factor, canZoomIn: factor < ZOOM_FACTORS[ZOOM_FACTORS.length - 1]!, canZoomOut: factor > ZOOM_FACTORS[0] }
}

const READING_FONTS: Record<ReadingFont, string> = {
  sans: 'var(--font-ui)',
  serif: "'Songti SC', STSong, 'Noto Serif CJK SC', 'Noto Serif SC', 'Source Han Serif SC', SimSun, serif"
}

export interface ResolvedAppearance {
  /** Scheme for native controls (`color-scheme`) and the built-in palette in use. */
  scheme: SchemeBase
  /** CSS custom properties to set on the root element: palette, radii and reading parameters. */
  variables: Record<string, string>
}

/** What the UI draws for `settings`; `systemDark` is the operating system's current preference. */
export function resolveAppearance(settings: AppSettings, systemDark: boolean): ResolvedAppearance {
  const custom = settings.colorScheme === 'custom' ? settings.customTheme : null
  const scheme: SchemeBase =
    custom !== null ? custom.base : settings.colorScheme === 'light' || settings.colorScheme === 'dark' ? settings.colorScheme : systemDark ? 'dark' : 'light'
  const palette: Palette = custom !== null ? customPalette(custom) : BUILTIN_PALETTES[scheme]
  const radius = custom !== null ? custom.radius : BUILTIN_RADIUS
  const { font, fontSize, readingWidth } = settings.reading
  const variables: Record<string, string> = {}
  for (const token of COLOR_TOKENS) variables[`--${token}`] = palette[token]
  variables['--shadow-nav'] = palette['shadow-nav']
  variables['--shadow-bar'] = palette['shadow-bar']
  variables['--radius-l'] = `${radius}px`
  variables['--radius-m'] = `${Math.round((radius * 9) / 14)}px`
  variables['--radius-s'] = `${Math.round((radius * 6) / 14)}px`
  variables['--text-body'] = `${fontSize}px`
  variables['--reading-width'] = `${readingWidth * fontSize}px`
  variables['--font-reading'] = READING_FONTS[font]
  return { scheme, variables }
}
