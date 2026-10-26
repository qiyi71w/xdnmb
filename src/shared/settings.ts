// Global preferences: one source of validation for IPC updates, stored rows and theme imports.
import { CLOSE_ACTIONS, type CloseAction } from './lifecycle'
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
  type ReadingParams,
  type SchemeBase
} from './theme'

/** `system` follows the operating system's light/dark preference. */
export type ColorScheme = 'system' | 'light' | 'dark'

/** `compact` only reduces padding of the main lists and controls; text size, theme and split stay. */
export type Density = 'comfortable' | 'compact'

/** `system` follows the operating system; `reduce` turns motion off regardless of it. */
export type MotionPreference = 'system' | 'reduce'

/** Features the icon rail can show; `search` opens the one search page. */
export const RAIL_FEATURES = ['subscriptions', 'reminders', 'search', 'history', 'offline', 'drafts'] as const
export type RailFeature = (typeof RAIL_FEATURES)[number]

/** The icon rail: every feature's place (hidden ones included) and which ones are hidden (they go to 更多). */
export interface RailSettings {
  /** Rail order; features missing from it keep their default place after it. */
  order: readonly RailFeature[]
  hidden: readonly RailFeature[]
}

/**
 * Board management. Boards are named by their list key (`forum:<id>` / `timeline:<id>`), groups by
 * the navigation's group id (`group-<id>`, `timelines`, `favorites`). Only forum groups take a
 * custom order; timelines keep the directory order.
 */
export interface BoardSettings {
  /** Favorite boards in their own order. */
  favorites: readonly string[]
  hidden: readonly string[]
  /** Custom board order per forum group; boards missing from it keep the directory order after it. */
  order: Readonly<Record<string, readonly string[]>>
  /** Collapsed board groups. */
  collapsed: readonly string[]
}

/** Split-view list width bounds, CSS pixels; the reader still keeps its minimum text width. */
export const LIST_WIDTH_LIMITS = { min: 260, max: 1600, default: 340 } as const

/** The user's own kaomoji: count and per-entry length (characters) limits. */
export const KAOMOJI_LIMITS = { count: 200, length: 500 } as const

export interface AppSettings {
  /** Automatic reminder checks in minutes; 0 disables only the timer. */
  reminderInterval: 0 | 15 | 30 | 60
  reminderSystemNotifications: boolean
  /** Split preference given to tabs created from now on; existing tabs keep their own. */
  newTabSplitDefault: boolean
  /** Remembered close behavior; actual quit still handles unsaved editors. */
  closeAction: CloseAction
  colorScheme: ColorScheme
  customThemeEnabled: boolean
  /** The user's custom theme; `null` until one is created or imported. Kept when another scheme is chosen. */
  customTheme: CustomTheme | null
  /** Post text font, size and preferred width; apply under every scheme. */
  reading: ReadingParams
  density: Density
  motion: MotionPreference
  rail: RailSettings
  boards: BoardSettings
  /** List width chosen with the split divider. */
  listWidth: number
  /** Kaomoji added by the user, after the presets, in the order added. */
  customKaomoji: readonly string[]
}

export const DEFAULT_SETTINGS: AppSettings = {
  reminderInterval: 15,
  reminderSystemNotifications: true,
  newTabSplitDefault: true,
  closeAction: 'ask',
  colorScheme: 'system',
  customThemeEnabled: false,
  customTheme: null,
  reading: DEFAULT_READING,
  density: 'comfortable',
  motion: 'system',
  rail: { order: [], hidden: [] },
  boards: { favorites: [], hidden: [], order: {}, collapsed: [] },
  listWidth: LIST_WIDTH_LIMITS.default,
  customKaomoji: []
}

export const SETTING_KEYS = [
  'reminderInterval',
  'reminderSystemNotifications',
  'newTabSplitDefault',
  'closeAction',
  'colorScheme',
  'customThemeEnabled',
  'customTheme',
  'reading',
  'density',
  'motion',
  'rail',
  'boards',
  'listWidth',
  'customKaomoji'
] as const satisfies readonly (keyof AppSettings)[]

/** At most this many entries in any board list (favorites, hidden, one group's order, collapsed). */
const MAX_BOARD_ENTRIES = 2000
const BOARD_KEY = /^(?:forum|timeline):[0-9A-Za-z_-]{1,32}$/
const FORUM_KEY = /^forum:[0-9A-Za-z_-]{1,32}$/
const GROUP_ID = /^(?:timelines|favorites|group-[0-9A-Za-z_-]{1,32})$/
const FORUM_GROUP_ID = /^group-[0-9A-Za-z_-]{1,32}$/
const KAOMOJI_FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f]/

type Issues = AppearanceIssue[]

/** A list of distinct strings that each pass `valid`; anything else is a `field` issue. */
function stringList(value: unknown, field: string, valid: (item: string) => boolean, max: number, issues: Issues): string[] | null {
  if (!Array.isArray(value)) {
    issues.push({ kind: 'field', field, problem: value === undefined ? 'missing' : 'type' })
    return null
  }
  if (value.length > max) {
    issues.push({ kind: 'field', field, problem: 'range' })
    return null
  }
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item !== 'string') {
      issues.push({ kind: 'field', field, problem: 'type' })
      return null
    }
    if (!valid(item) || seen.has(item)) {
      issues.push({ kind: 'field', field, problem: 'range' })
      return null
    }
    seen.add(item)
  }
  return [...seen]
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string, issues: Issues): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) issues.push({ kind: 'field', field: `${field}.${key}`, problem: 'unknown' })
}

function parseRail(value: unknown, field: string): Parsed<RailSettings> {
  if (!isRecord(value)) return { ok: false, issues: [{ kind: 'field', field, problem: 'type' }] }
  const issues: Issues = []
  exactKeys(value, ['order', 'hidden'], field, issues)
  const isFeature = (item: string) => (RAIL_FEATURES as readonly string[]).includes(item)
  const order = stringList(value.order, `${field}.order`, isFeature, RAIL_FEATURES.length, issues)
  const hidden = stringList(value.hidden, `${field}.hidden`, isFeature, RAIL_FEATURES.length, issues)
  if (order === null || hidden === null || issues.length > 0) return { ok: false, issues }
  return { ok: true, value: { order: order as RailFeature[], hidden: hidden as RailFeature[] } }
}

function parseBoards(value: unknown, field: string): Parsed<BoardSettings> {
  if (!isRecord(value)) return { ok: false, issues: [{ kind: 'field', field, problem: 'type' }] }
  const issues: Issues = []
  exactKeys(value, ['favorites', 'hidden', 'order', 'collapsed'], field, issues)
  const isBoard = (item: string) => BOARD_KEY.test(item)
  const favorites = stringList(value.favorites, `${field}.favorites`, isBoard, MAX_BOARD_ENTRIES, issues)
  const hidden = stringList(value.hidden, `${field}.hidden`, isBoard, MAX_BOARD_ENTRIES, issues)
  const collapsed = stringList(value.collapsed, `${field}.collapsed`, (item) => GROUP_ID.test(item), MAX_BOARD_ENTRIES, issues)
  let order: Record<string, string[]> | null = null
  if (!isRecord(value.order)) issues.push({ kind: 'field', field: `${field}.order`, problem: value.order === undefined ? 'missing' : 'type' })
  else {
    const groups = Object.entries(value.order)
    if (groups.length > MAX_BOARD_ENTRIES) issues.push({ kind: 'field', field: `${field}.order`, problem: 'range' })
    else {
      order = {}
      for (const [groupId, keys] of groups) {
        if (!FORUM_GROUP_ID.test(groupId)) {
          issues.push({ kind: 'field', field: `${field}.order`, problem: 'range' })
          break
        }
        const list = stringList(keys, `${field}.order`, (item) => FORUM_KEY.test(item), MAX_BOARD_ENTRIES, issues)
        if (list === null) break
        order[groupId] = list
      }
    }
  }
  if (favorites === null || hidden === null || collapsed === null || order === null || issues.length > 0) return { ok: false, issues }
  return { ok: true, value: { favorites, hidden, order, collapsed } }
}

function parseKaomoji(value: unknown, field: string): Parsed<string[]> {
  const issues: Issues = []
  const valid = (item: string) => item.trim() !== '' && [...item].length <= KAOMOJI_LIMITS.length && !KAOMOJI_FORBIDDEN.test(item)
  const list = stringList(value, field, valid, KAOMOJI_LIMITS.count, issues)
  return list === null ? { ok: false, issues } : { ok: true, value: list }
}

function parseListWidth(value: unknown, field: string): Parsed<number> {
  if (typeof value !== 'number' || !Number.isInteger(value)) return { ok: false, issues: [{ kind: 'field', field, problem: 'type' }] }
  if (value < LIST_WIDTH_LIMITS.min || value > LIST_WIDTH_LIMITS.max) return { ok: false, issues: [{ kind: 'field', field, problem: 'range' }] }
  return { ok: true, value }
}

const COLOR_SCHEMES: readonly ColorScheme[] = ['system', 'light', 'dark']
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
    case 'reminderInterval':
      parsed = typeof value !== 'number'
        ? { ok: false, issues: [{ kind: 'field', field: key, problem: 'type' }] }
        : [0, 15, 30, 60].includes(value)
          ? { ok: true, value }
          : { ok: false, issues: [{ kind: 'field', field: key, problem: 'range' }] }
      break
    case 'reminderSystemNotifications':
    case 'newTabSplitDefault':
    case 'customThemeEnabled':
      parsed = typeof value === 'boolean' ? { ok: true, value } : { ok: false, issues: [{ kind: 'field', field: key, problem: 'type' }] }
      break
    case 'closeAction':
      parsed = choice(value, CLOSE_ACTIONS, key)
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
    case 'rail':
      parsed = parseRail(value, key)
      break
    case 'boards':
      parsed = parseBoards(value, key)
      break
    case 'listWidth':
      parsed = parseListWidth(value, key)
      break
    case 'customKaomoji':
      parsed = parseKaomoji(value, key)
      break
    default:
      parsed = { ok: false, issues: [{ kind: 'field', field: String(key), problem: 'unknown' }] }
  }
  return parsed as Parsed<AppSettings[K]>
}

/** The custom scheme needs a custom theme; anything else is consistent. */
function consistencyIssues(settings: AppSettings): AppearanceIssue[] {
  return settings.customThemeEnabled && settings.customTheme === null
    ? [{ kind: 'field', field: 'customThemeEnabled', problem: 'unavailable' }]
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
  if (stored.get('colorScheme') === 'custom' && settings.customTheme !== null) {
    const oldTheme = stored.get('customTheme')
    settings.colorScheme = isRecord(oldTheme) && (oldTheme.base === 'light' || oldTheme.base === 'dark') ? oldTheme.base : 'system'
    settings.customThemeEnabled = true
  }
  if (consistencyIssues(settings).length > 0) settings.customThemeEnabled = false
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

const READING_FONTS: Record<'sans' | 'serif', string> = {
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
  const custom = settings.customThemeEnabled ? settings.customTheme : null
  const scheme: SchemeBase = settings.colorScheme === 'light' || settings.colorScheme === 'dark' ? settings.colorScheme : systemDark ? 'dark' : 'light'
  const palette: Palette = custom !== null ? customPalette(custom, scheme) : BUILTIN_PALETTES[scheme]
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
  variables['--font-reading'] = font === 'sans' || font === 'serif' ? READING_FONTS[font] : `${JSON.stringify(font.slice(6))}, var(--font-ui)`
  return { scheme, variables }
}
