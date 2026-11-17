// The list of custom themes: one source of its rules for the settings page, theme file import and
// settings validation (docs/adr/0006-current-custom-theme-stays-in-legacy-setting.md).
//
// The current custom theme (in use, or the last one used before switching back to 汐岛) stays in
// `customTheme`, so versions that know a single theme keep showing it; `customThemeEnabled` says
// whether it is in use. `customThemeList` holds the other themes in order and where the current one
// sits among them. Every operation below is one settings patch over those keys, written in one update.
import type { AppSettings } from './settings'
import { isRecord, parseCustomTheme, THEME_LIMITS, themeFromBuiltin, type AppearanceIssue, type CustomTheme, type Parsed, type SchemeBase } from './theme'

/** The built-in theme's name: no custom theme may use it, every name check counts it as taken. */
export const BUILTIN_THEME_NAME = '汐岛'

/** At most this many custom themes, the current one included. */
export const MAX_CUSTOM_THEMES = 50

/** Name given to a new theme (before a number is added to keep names unique). */
export const NEW_THEME_NAME = '我的主题'

/** The `customThemeList` setting: the custom themes other than the current one, and the current one's place. */
export interface CustomThemeList {
  /** In list order: the order they were added, newest last. */
  others: readonly CustomTheme[]
  /** Index of the current theme in the whole list; 0 when there is none. */
  currentIndex: number
}

export const EMPTY_THEME_LIST: CustomThemeList = { others: [], currentIndex: 0 }

export type ThemeListSettings = Pick<AppSettings, 'customTheme' | 'customThemeEnabled' | 'customThemeList'>

/** The settings one operation writes, as one update. */
export type ThemeListPatch = Partial<ThemeListSettings>

export type ThemeListRejection =
  /** Another custom theme (or 汐岛) already has the name. */
  | 'name-taken'
  /** The list already has `MAX_CUSTOM_THEMES` themes. */
  | 'full'
  /** No custom theme has the name. */
  | 'not-found'

export type ThemeListResult = { ok: true; patch: ThemeListPatch } | { ok: false; reason: ThemeListRejection }

/** Every custom theme in list order: the other themes with the current one put back at its place. */
export function customThemes(settings: ThemeListSettings): readonly CustomTheme[] {
  const { customTheme, customThemeList } = settings
  if (customTheme === null) return customThemeList.others
  const { others, currentIndex } = customThemeList
  return [...others.slice(0, currentIndex), customTheme, ...others.slice(currentIndex)]
}

/** Names compare after trimming. */
const nameKey = (name: string) => name.trim()

/** `base` (trimmed) shortened so that `suffix` fits within the name length limit. */
function fitName(base: string, suffix: string): string {
  const room = THEME_LIMITS.nameLength.max - [...suffix].length
  const chars = [...base.trim()]
  return (chars.length > room ? chars.slice(0, room).join('').trimEnd() : chars.join('')) + suffix
}

/**
 * `name` when it is free, else `name 2`, `name 3`… (the smallest free number). 汐岛 always counts as
 * taken. The original part is shortened when the result would pass the name length limit.
 */
export function uniqueThemeName(name: string, taken: Iterable<string>): string {
  return uniqueLabelledName(name, '', taken)
}

/** `uniqueThemeName` of `name` followed by `label` (as in “青瓷 副本”, “青瓷 副本 2”); only `name` is shortened. */
function uniqueLabelledName(name: string, label: string, taken: Iterable<string>): string {
  const used = new Set([BUILTIN_THEME_NAME])
  for (const other of taken) used.add(nameKey(other))
  const plain = fitName(name, label)
  if (!used.has(plain)) return plain
  for (let number = 2; ; number++) {
    const candidate = fitName(name, `${label} ${number}`)
    if (!used.has(candidate)) return candidate
  }
}

/** Whether the current theme may not be renamed to `name`: 汐岛 or another custom theme has it. */
export function themeNameTaken(settings: ThemeListSettings, name: string): boolean {
  const key = nameKey(name)
  return key === BUILTIN_THEME_NAME || settings.customThemeList.others.some((theme) => theme.name === key)
}

/** Use 汐岛: the current theme stays where it is, only out of use. */
export function selectBuiltinTheme(): ThemeListResult {
  return { ok: true, patch: { customThemeEnabled: false } }
}

/** Use the custom theme named `name`. The current one goes back to its place; the order stays. */
export function selectCustomTheme(settings: ThemeListSettings, name: string): ThemeListResult {
  const key = nameKey(name)
  if (settings.customTheme?.name === key) return { ok: true, patch: { customThemeEnabled: true } }
  const all = customThemes(settings)
  const index = all.findIndex((theme) => theme.name === key)
  if (index < 0) return { ok: false, reason: 'not-found' }
  return {
    ok: true,
    patch: {
      customTheme: all[index]!,
      customThemeEnabled: true,
      customThemeList: { others: all.filter((_, at) => at !== index), currentIndex: index }
    }
  }
}

/** Puts `theme` at the end of the list and uses it. */
function append(all: readonly CustomTheme[], theme: CustomTheme): ThemeListResult {
  if (all.length >= MAX_CUSTOM_THEMES) return { ok: false, reason: 'full' }
  return { ok: true, patch: { customTheme: theme, customThemeEnabled: true, customThemeList: { others: all, currentIndex: all.length } } }
}

/** A new theme seeded from 汐岛 (`scheme` gives the built-in opacity), named 我的主题, added last and used. */
export function createTheme(settings: ThemeListSettings, scheme: SchemeBase): ThemeListResult {
  const all = customThemes(settings)
  return append(all, { ...themeFromBuiltin(scheme), name: uniqueThemeName(NEW_THEME_NAME, all.map((theme) => theme.name)) })
}

/**
 * A copy of the theme named `name`, named “<name> 副本”, added last and used. A copy of 汐岛 is a new
 * theme (`scheme` as in `createTheme`) named 汐岛 副本.
 */
export function copyTheme(settings: ThemeListSettings, name: string, scheme: SchemeBase): ThemeListResult {
  const key = nameKey(name)
  const all = customThemes(settings)
  const source = key === BUILTIN_THEME_NAME ? themeFromBuiltin(scheme) : all.find((theme) => theme.name === key)
  if (source === undefined) return { ok: false, reason: 'not-found' }
  return append(all, { ...source, name: uniqueLabelledName(key, ' 副本', all.map((theme) => theme.name)) })
}

/** A theme `deleteTheme` took out of the list, with what `restoreTheme` needs to put it back. */
export interface DeletedTheme {
  theme: CustomTheme
  /** Its place in the whole list. */
  index: number
  /** It was the theme in use. */
  inUse: boolean
}

export type DeleteThemeResult = { ok: true; patch: ThemeListPatch; deleted: DeletedTheme } | { ok: false; reason: 'not-found' }

/**
 * Deletes the theme named `name`. Deleting the current theme leaves 汐岛 in use when it was in use;
 * the theme after it (else the one before it) becomes the current theme, out of use. Deleting
 * another theme keeps what is in use.
 */
export function deleteTheme(settings: ThemeListSettings, name: string): DeleteThemeResult {
  const key = nameKey(name)
  const all = customThemes(settings)
  const index = all.findIndex((theme) => theme.name === key)
  if (index < 0) return { ok: false, reason: 'not-found' }
  const theme = all[index]!
  const { others, currentIndex } = settings.customThemeList
  if (settings.customTheme?.name !== key) {
    return {
      ok: true,
      deleted: { theme, index, inUse: false },
      patch: { customThemeList: { others: others.filter((other) => other !== theme), currentIndex: index < currentIndex ? currentIndex - 1 : currentIndex } }
    }
  }
  const rest = all.filter((_, at) => at !== index)
  const promoted = Math.min(index, rest.length - 1)
  return {
    ok: true,
    deleted: { theme, index, inUse: settings.customThemeEnabled },
    patch:
      promoted < 0
        ? { customTheme: null, customThemeEnabled: false, customThemeList: EMPTY_THEME_LIST }
        : {
            customTheme: rest[promoted]!,
            customThemeEnabled: false,
            customThemeList: { others: rest.filter((_, at) => at !== promoted), currentIndex: promoted }
          }
  }
}

/**
 * Puts a deleted theme back at its place (the end, when the list is shorter now) and uses it again
 * when it was in use; otherwise what is in use stays. A name taken since gets a number. Refused
 * when the list is full.
 */
export function restoreTheme(settings: ThemeListSettings, deleted: DeletedTheme): { ok: true; patch: ThemeListPatch } | { ok: false; reason: 'full' } {
  const all = customThemes(settings)
  if (all.length >= MAX_CUSTOM_THEMES) return { ok: false, reason: 'full' }
  const theme = { ...deleted.theme, name: uniqueThemeName(deleted.theme.name, all.map((other) => other.name)) }
  const index = Math.min(deleted.index, all.length)
  const restored = [...all.slice(0, index), theme, ...all.slice(index)]
  const kept = settings.customTheme
  const current = deleted.inUse || kept === null ? index : restored.findIndex((other) => other !== theme && other.name === kept.name)
  return {
    ok: true,
    patch: {
      customTheme: restored[current]!,
      customThemeEnabled: deleted.inUse || settings.customThemeEnabled,
      customThemeList: { others: restored.filter((_, at) => at !== current), currentIndex: current }
    }
  }
}

/** Saves edits of the current theme (which is then in use). Renaming it to a taken name is refused. */
export function saveCurrentTheme(settings: ThemeListSettings, theme: CustomTheme): ThemeListResult {
  if (themeNameTaken(settings, theme.name)) return { ok: false, reason: 'name-taken' }
  return { ok: true, patch: { customTheme: { ...theme, name: nameKey(theme.name) }, customThemeEnabled: true } }
}

/**
 * A theme from a theme file is added last and used; no theme is replaced. A name another custom
 * theme (or 汐岛) has gets a number. Refused when the list is full.
 */
export function importTheme(settings: ThemeListSettings, theme: CustomTheme): ThemeListResult {
  const all = customThemes(settings)
  return append(all, { ...theme, name: uniqueThemeName(theme.name, all.map((other) => other.name)) })
}

/** The custom theme named `name`, to export; never 汐岛, which no custom theme may be named. */
export function exportedTheme(settings: ThemeListSettings, name: string): CustomTheme | null {
  const key = nameKey(name)
  return customThemes(settings).find((theme) => theme.name === key) ?? null
}

/** Validates a `customThemeList` value: shape, each theme and the size only (see `themeListIssues`). */
export function parseThemeList(value: unknown, field: string): Parsed<CustomThemeList> {
  if (!isRecord(value)) return { ok: false, issues: [{ kind: 'field', field, problem: 'type' }] }
  const issues: AppearanceIssue[] = []
  for (const key of Object.keys(value)) if (key !== 'others' && key !== 'currentIndex') issues.push({ kind: 'field', field: `${field}.${key}`, problem: 'unknown' })
  const others: CustomTheme[] = []
  const rawOthers = value.others
  if (!Array.isArray(rawOthers)) issues.push({ kind: 'field', field: `${field}.others`, problem: rawOthers === undefined ? 'missing' : 'type' })
  else if (rawOthers.length >= MAX_CUSTOM_THEMES) issues.push({ kind: 'field', field: `${field}.others`, problem: 'range' })
  else {
    rawOthers.forEach((item, index) => {
      const parsed = parseCustomTheme(item, `${field}.others.${index}`)
      if (parsed.ok) others.push(parsed.value)
      else issues.push(...parsed.issues)
    })
  }
  const currentIndex = value.currentIndex
  if (typeof currentIndex !== 'number' || !Number.isInteger(currentIndex)) {
    issues.push({ kind: 'field', field: `${field}.currentIndex`, problem: currentIndex === undefined ? 'missing' : 'type' })
  } else if (currentIndex < 0) issues.push({ kind: 'field', field: `${field}.currentIndex`, problem: 'range' })
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: { others, currentIndex: currentIndex as number } }
}

/**
 * What breaks the list's invariants: other themes without a current one, the current theme's place
 * past the end, more than `MAX_CUSTOM_THEMES` themes, a name used twice or named 汐岛. A name the
 * current theme shares with another one is the current theme's issue (as when it is renamed).
 */
export function themeListIssues(settings: ThemeListSettings): AppearanceIssue[] {
  const { customTheme, customThemeList } = settings
  const { others, currentIndex } = customThemeList
  const issues: AppearanceIssue[] = []
  if (customTheme === null && others.length > 0) issues.push({ kind: 'field', field: 'customThemeList', problem: 'unavailable' })
  if (currentIndex > others.length) issues.push({ kind: 'field', field: 'customThemeList.currentIndex', problem: 'range' })
  if (others.length + (customTheme === null ? 0 : 1) > MAX_CUSTOM_THEMES) issues.push({ kind: 'field', field: 'customThemeList.others', problem: 'range' })
  const used = new Set([BUILTIN_THEME_NAME])
  others.forEach((theme, index) => {
    if (used.has(nameKey(theme.name))) issues.push({ kind: 'field', field: `customThemeList.others.${index}.name`, problem: 'duplicate' })
    used.add(nameKey(theme.name))
  })
  if (customTheme !== null && used.has(nameKey(customTheme.name))) issues.push({ kind: 'field', field: 'customTheme.name', problem: 'duplicate' })
  return issues
}

/**
 * The list from stored values, each part falling back on its own: a missing or unreadable list has
 * no other themes; invalid themes are dropped; a theme named like the current one, an earlier one or
 * 汐岛 gets a number; past `MAX_CUSTOM_THEMES` the last ones are dropped; without a current theme the
 * first other one becomes current (the caller keeps it out of use); the place is kept within the list.
 * `customTheme` is the stored current theme as read on its own (an older version may have rewritten it).
 */
export function themeListFromStored(
  customTheme: CustomTheme | null,
  stored: unknown
): Pick<AppSettings, 'customTheme' | 'customThemeList'> {
  const raw = isRecord(stored) && Array.isArray(stored.others) ? stored.others : []
  const storedIndex = isRecord(stored) && typeof stored.currentIndex === 'number' && Number.isInteger(stored.currentIndex) ? stored.currentIndex : 0
  let others: CustomTheme[] = []
  let currentIndex = 0
  raw.forEach((item, index) => {
    const parsed = parseCustomTheme(item, `customThemeList.others.${index}`)
    if (!parsed.ok) return
    others.push(parsed.value)
    if (index < storedIndex) currentIndex++
  })
  let current = customTheme
  if (current === null && others.length > 0) {
    current = others.shift()!
    currentIndex = 0
  }
  others = others.slice(0, MAX_CUSTOM_THEMES - (current === null ? 0 : 1))
  const used: string[] = []
  const named = (theme: CustomTheme): CustomTheme => {
    const name = uniqueThemeName(theme.name, used)
    used.push(name)
    return name === theme.name ? theme : { ...theme, name }
  }
  if (current !== null) current = named(current)
  others = others.map(named)
  return { customTheme: current, customThemeList: { others, currentIndex: Math.min(currentIndex, others.length) } }
}
