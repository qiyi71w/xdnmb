// Theme palettes, custom theme documents and contrast checks shared by the main process and the UI.
//
// Built-in and custom themes are both a `Palette` (one value per color token). The UI applies the
// palette as CSS custom properties; the checks below run on the same values, so what is checked is
// what is drawn. Theme data never carries CSS text or scripts: colors are #rrggbb, every other field
// is an enumerated choice or a bounded number.

/** Color tokens used by the stylesheets as `var(--<token>)`. */
export const COLOR_TOKENS = [
  'window',
  'window-tint-a',
  'window-tint-b',
  'glass',
  'glass-strong',
  'glass-edge',
  'pane',
  'paper',
  'ink',
  'ink-2',
  'ink-3',
  'line',
  'line-soft',
  'hover',
  'selected',
  'nav-current',
  'accent',
  'accent-ink',
  'accent-soft',
  'greentext',
  'quote-ref-ink',
  'quote-ref-bg',
  'warn-ink',
  'warn-bg',
  'danger-ink',
  'danger-bg',
  'info-bg',
  'skeleton'
] as const

export type ColorToken = (typeof COLOR_TOKENS)[number]

/** Palette: CSS color per token plus the two shadow values that depend on the scheme. */
export type Palette = Record<ColorToken, string> & { 'shadow-nav': string; 'shadow-bar': string }

export type SchemeBase = 'light' | 'dark'

export const BUILTIN_PALETTES: Record<SchemeBase, Palette> = {
  light: {
    window: 'oklch(0.952 0.009 228)',
    'window-tint-a': 'oklch(0.93 0.03 215)',
    'window-tint-b': 'oklch(0.95 0.025 85)',
    glass: 'oklch(0.985 0.005 225 / 0.6)',
    'glass-strong': 'oklch(0.99 0.004 225 / 0.82)',
    'glass-edge': 'oklch(1 0 0 / 0.7)',
    pane: 'oklch(0.985 0.003 230)',
    paper: 'oklch(1 0 0)',
    ink: 'oklch(0.25 0.012 240)',
    'ink-2': 'oklch(0.41 0.012 240)',
    'ink-3': 'oklch(0.49 0.01 240)',
    line: 'oklch(0.89 0.006 240)',
    'line-soft': 'oklch(0.94 0.004 240)',
    hover: 'oklch(0.45 0.02 240 / 0.07)',
    selected: 'oklch(0.56 0.095 215 / 0.14)',
    'nav-current': 'oklch(0.45 0.03 230 / 0.12)',
    accent: 'oklch(0.55 0.095 215)',
    'accent-ink': 'oklch(0.44 0.1 222)',
    'accent-soft': 'oklch(0.55 0.095 215 / 0.12)',
    greentext: 'oklch(0.46 0.11 145)',
    'quote-ref-ink': 'oklch(0.42 0.06 260)',
    'quote-ref-bg': 'oklch(0.55 0.06 260 / 0.1)',
    'warn-ink': 'oklch(0.44 0.1 65)',
    'warn-bg': 'oklch(0.965 0.035 85)',
    'danger-ink': 'oklch(0.47 0.15 27)',
    'danger-bg': 'oklch(0.97 0.018 27)',
    'info-bg': 'oklch(0.965 0.015 225)',
    skeleton: 'oklch(0.45 0.02 240 / 0.08)',
    'shadow-nav': '0 18px 40px -22px oklch(0.3 0.05 230 / 0.35), 0 1px 2px oklch(0.3 0.03 230 / 0.06)',
    'shadow-bar': '0 8px 20px -16px oklch(0.25 0.03 240 / 0.35)'
  },
  dark: {
    window: 'oklch(0.17 0.008 240)',
    'window-tint-a': 'oklch(0.24 0.035 235)',
    'window-tint-b': 'oklch(0.22 0.025 200)',
    glass: 'oklch(0.27 0.01 240 / 0.55)',
    'glass-strong': 'oklch(0.24 0.01 240 / 0.85)',
    'glass-edge': 'oklch(1 0 0 / 0.08)',
    pane: 'oklch(0.205 0.007 240)',
    paper: 'oklch(0.185 0.006 240)',
    ink: 'oklch(0.93 0.006 240)',
    'ink-2': 'oklch(0.81 0.008 240)',
    'ink-3': 'oklch(0.71 0.008 240)',
    line: 'oklch(0.33 0.008 240)',
    'line-soft': 'oklch(0.27 0.006 240)',
    hover: 'oklch(0.9 0.01 240 / 0.07)',
    selected: 'oklch(0.74 0.09 210 / 0.18)',
    'nav-current': 'oklch(0.9 0.02 230 / 0.12)',
    accent: 'oklch(0.74 0.09 210)',
    'accent-ink': 'oklch(0.81 0.08 210)',
    'accent-soft': 'oklch(0.74 0.09 210 / 0.16)',
    greentext: 'oklch(0.79 0.12 145)',
    'quote-ref-ink': 'oklch(0.82 0.06 260)',
    'quote-ref-bg': 'oklch(0.75 0.06 260 / 0.14)',
    'warn-ink': 'oklch(0.84 0.1 80)',
    'warn-bg': 'oklch(0.27 0.035 80)',
    'danger-ink': 'oklch(0.82 0.1 27)',
    'danger-bg': 'oklch(0.27 0.04 27)',
    'info-bg': 'oklch(0.25 0.02 225)',
    skeleton: 'oklch(0.9 0.01 240 / 0.08)',
    'shadow-nav': '0 18px 40px -20px oklch(0 0 0 / 0.6), 0 0 0 1px oklch(1 0 0 / 0.05)',
    'shadow-bar': '0 8px 20px -14px oklch(0 0 0 / 0.6)'
  }
}

/** Built-in large corner radius, CSS pixels. */
export const BUILTIN_RADIUS = 14

// ---------------------------------------------------------------------------------------------
// Color math (sRGB, WCAG 2.x relative luminance)

/** Gamma-encoded sRGB channels and alpha, each 0–1. */
export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

function linearToGamma(value: number): number {
  const v = clamp01(value)
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
}

function gammaToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

function oklchToRgb(l: number, c: number, hDegrees: number): Omit<Rgba, 'a'> {
  const h = (hDegrees * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return {
    r: linearToGamma(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    g: linearToGamma(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    b: linearToGamma(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_)
  }
}

const HEX = /^#([0-9a-f]{6})$/i
const OKLCH = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)\s*)?\)$/
const RGB = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)\s*(?:\/\s*([\d.]+)\s*)?\)$/

/** Parses the color forms palettes use: `#rrggbb`, `rgb(R G B [/ A])` and `oklch(L C H [/ A])`. */
export function parseColor(text: string): Rgba | null {
  const hex = HEX.exec(text)
  if (hex) {
    const n = Number.parseInt(hex[1]!, 16)
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 }
  }
  const rgb = RGB.exec(text)
  if (rgb) {
    const channel = (value: string) => clamp01(Number(value) / 255)
    return { r: channel(rgb[1]!), g: channel(rgb[2]!), b: channel(rgb[3]!), a: rgb[4] === undefined ? 1 : clamp01(Number(rgb[4])) }
  }
  const lch = OKLCH.exec(text)
  if (lch) {
    return { ...oklchToRgb(Number(lch[1]), Number(lch[2]), Number(lch[3])), a: lch[4] === undefined ? 1 : clamp01(Number(lch[4])) }
  }
  return null
}

export function toHex(color: Rgba): string {
  const channel = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`
}

function rgbaCss(color: Rgba, alpha: number): string {
  const c = (v: number) => Math.round(clamp01(v) * 255)
  return `rgb(${c(color.r)} ${c(color.g)} ${c(color.b)} / ${Number(alpha.toFixed(3))})`
}

/** Source-over compositing in gamma-encoded sRGB, as the page draws it. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const blend = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a
  return { r: blend(top.r, bottom.r), g: blend(top.g, bottom.g), b: blend(top.b, bottom.b), a }
}

/** `weight` of `a` mixed with `b` (opaque result). */
function mix(a: Rgba, b: Rgba, weight: number): Rgba {
  const w = clamp01(weight)
  return { r: a.r * w + b.r * (1 - w), g: a.g * w + b.g * (1 - w), b: a.b * w + b.b * (1 - w), a: 1 }
}

export function relativeLuminance(color: Rgba): number {
  return 0.2126 * gammaToLinear(color.r) + 0.7152 * gammaToLinear(color.g) + 0.0722 * gammaToLinear(color.b)
}

/** WCAG contrast ratio of two opaque colors (1–21). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// ---------------------------------------------------------------------------------------------
// Contrast checks

/** Minimum contrast for ordinary text (WCAG 2.2 SC 1.4.3). */
export const MIN_TEXT_CONTRAST = 4.5

/**
 * A background as drawn: tokens painted bottom to top. Translucent layers (glass, selections) are
 * composited over the layer below them. Backdrop blur/saturation are not modelled.
 */
export type Surface = readonly ColorToken[]

const GLASS_BACKDROPS: Surface[] = [['window', 'glass'], ['window-tint-a', 'glass'], ['window-tint-b', 'glass']]
/** The top bar (tabs, history and toggle buttons) is transparent: its text sits on the window and its tints. */
const WINDOW_BACKDROPS: Surface[] = [['window'], ['window-tint-a'], ['window-tint-b'], ['window', 'hover'], ['window-tint-a', 'hover']]

/** Ordinary text tokens and every surface the stylesheets draw them on. */
export const TEXT_CONTRAST_PAIRS: readonly { foreground: ColorToken; surfaces: readonly Surface[] }[] = [
  ...(['ink', 'ink-2', 'ink-3'] as const).map((foreground) => ({
    foreground,
    surfaces: [
      ['paper'],
      ['pane'],
      ...WINDOW_BACKDROPS,
      ['info-bg'],
      ['pane', 'selected'],
      ['pane', 'hover'],
      ['window', 'glass-strong'],
      ...GLASS_BACKDROPS,
      ['window', 'glass', 'nav-current']
    ] satisfies Surface[]
  })),
  {
    foreground: 'accent-ink',
    surfaces: [
      ['paper'],
      ['pane'],
      ['info-bg'],
      ['paper', 'accent-soft'],
      ['pane', 'accent-soft'],
      ['window', 'accent-soft'],
      ['window-tint-a', 'accent-soft'],
      ['window', 'glass-strong'],
      ...GLASS_BACKDROPS
    ]
  },
  { foreground: 'greentext', surfaces: [['paper']] },
  { foreground: 'quote-ref-ink', surfaces: [['paper', 'quote-ref-bg']] },
  { foreground: 'warn-ink', surfaces: [['warn-bg'], ['paper'], ['pane'], ['window', 'glass-strong']] },
  { foreground: 'danger-ink', surfaces: [['danger-bg'], ['paper']] }
]

export interface ContrastFailure {
  foreground: ColorToken
  surface: Surface
  ratio: number
}

function surfaceColor(palette: Palette, surface: Surface): Rgba | null {
  let result: Rgba | null = null
  for (const token of surface) {
    const color = parseColor(palette[token])
    if (color === null) return null
    result = result === null ? { ...color, a: 1 } : over(color, result)
  }
  return result
}

/** Every listed text/surface combination below `MIN_TEXT_CONTRAST`, worst first. */
export function paletteContrastFailures(palette: Palette): ContrastFailure[] {
  const failures: ContrastFailure[] = []
  for (const { foreground, surfaces } of TEXT_CONTRAST_PAIRS) {
    const fg = parseColor(palette[foreground])
    for (const surface of surfaces) {
      const bg = surfaceColor(palette, surface)
      const ratio = fg === null || bg === null ? 0 : contrastRatio(over(fg, bg), bg)
      if (ratio < MIN_TEXT_CONTRAST) failures.push({ foreground, surface, ratio })
    }
  }
  return failures.sort((a, b) => a.ratio - b.ratio)
}

// ---------------------------------------------------------------------------------------------
// Reading parameters and custom themes

export type ReadingFont = 'sans' | 'serif'

/** Reading parameters: they apply to post text under any theme and travel with theme files. */
export interface ReadingParams {
  font: ReadingFont
  /** Post text size, CSS pixels. */
  fontSize: number
  /** Preferred reading text width, in multiples of the post text size. */
  readingWidth: number
}

export const DEFAULT_READING: ReadingParams = { font: 'sans', fontSize: 16, readingWidth: 42 }

/** Accepted ranges (inclusive). Integers except `opacity` (rounded to two decimals). */
export const THEME_LIMITS = {
  fontSize: { min: 13, max: 28 },
  readingWidth: { min: 28, max: 64 },
  opacity: { min: 0.5, max: 1 },
  radius: { min: 0, max: 20 },
  nameLength: { min: 1, max: 40 }
} as const

export interface ThemeColors {
  /** Window background behind navigation and panes. */
  background: string
  /** Solid surface under post text, lists and dialogs. */
  surface: string
  /** Post and primary text. */
  text: string
  /** Secondary text (metadata, hints). */
  secondaryText: string
  /** Links, selection and focus; also drawn as text. */
  accent: string
}

export const THEME_COLOR_KEYS = ['background', 'surface', 'text', 'secondaryText', 'accent'] as const satisfies readonly (keyof ThemeColors)[]

export interface CustomTheme {
  name: string
  /** Native control scheme and the starting hues of status colors. */
  base: SchemeBase
  /** `#rrggbb`, lowercase. */
  colors: ThemeColors
  /** Opacity of the frosted navigation, toolbars and overlays; 1 is solid. */
  opacity: number
  /** Large corner radius, CSS pixels; smaller radii scale with it. */
  radius: number
}

const STATUS_TOKENS = ['greentext', 'quote-ref-ink', 'warn-ink', 'danger-ink'] as const

function must(text: string): Rgba {
  const color = parseColor(text)
  if (color === null) throw new Error('invalid palette color')
  return color
}

/**
 * Palette of a custom theme. The five user colors are used as given and never adjusted to pass the
 * checks. Status text colors are the app's own: each starts from the base scheme's hue and is pulled
 * toward the user's text color only as far as needed for contrast.
 */
export function customPalette(theme: CustomTheme): Palette {
  const background = must(theme.colors.background)
  const surface = must(theme.colors.surface)
  const text = must(theme.colors.text)
  const secondary = must(theme.colors.secondaryText)
  const accent = must(theme.colors.accent)
  const builtin = BUILTIN_PALETTES[theme.base]
  const seed = (token: ColorToken) => must(builtin[token])

  const palette: Palette = {
    window: toHex(background),
    'window-tint-a': toHex(mix(accent, background, 0.06)),
    'window-tint-b': toHex(mix(accent, background, 0.03)),
    glass: rgbaCss(surface, theme.opacity),
    'glass-strong': rgbaCss(surface, theme.opacity + (1 - theme.opacity) * 0.55),
    'glass-edge': builtin['glass-edge'],
    pane: toHex(mix(surface, background, 0.65)),
    paper: toHex(surface),
    ink: toHex(text),
    'ink-2': toHex(secondary),
    'ink-3': toHex(secondary),
    line: toHex(mix(text, surface, 0.14)),
    'line-soft': toHex(mix(text, surface, 0.07)),
    hover: rgbaCss(text, 0.07),
    selected: rgbaCss(accent, 0.14),
    'nav-current': rgbaCss(text, 0.1),
    accent: toHex(accent),
    'accent-ink': toHex(accent),
    'accent-soft': rgbaCss(accent, theme.base === 'dark' ? 0.16 : 0.12),
    greentext: toHex(text),
    'quote-ref-ink': toHex(text),
    'quote-ref-bg': rgbaCss(seed('quote-ref-ink'), 0.1),
    'warn-ink': toHex(text),
    'warn-bg': toHex(mix(seed('warn-ink'), surface, 0.1)),
    'danger-ink': toHex(text),
    'danger-bg': toHex(mix(seed('danger-ink'), surface, 0.08)),
    'info-bg': toHex(mix(accent, surface, 0.07)),
    skeleton: rgbaCss(text, 0.08),
    'shadow-nav': builtin['shadow-nav'],
    'shadow-bar': builtin['shadow-bar']
  }

  for (const token of STATUS_TOKENS) {
    const surfaces = TEXT_CONTRAST_PAIRS.find((pair) => pair.foreground === token)!.surfaces
    // From the pure status hue (step 0) toward the text color (step 10); the first legible step wins.
    for (let step = 0; step <= 10; step++) {
      const candidate = toHex(mix(text, seed(token), step / 10))
      const legible = surfaces.every((s) => {
        const bg = surfaceColor(palette, s)
        return bg !== null && contrastRatio(must(candidate), bg) >= MIN_TEXT_CONTRAST
      })
      if (legible || step === 10) {
        palette[token] = candidate
        break
      }
    }
  }
  return palette
}

/** Custom theme seeded from a built-in scheme; it passes the same checks. */
export function themeFromBuiltin(base: SchemeBase): CustomTheme {
  const p = BUILTIN_PALETTES[base]
  const hex = (token: ColorToken) => toHex(must(p[token]))
  return {
    name: base === 'light' ? '浅色副本' : '深色副本',
    base,
    colors: { background: hex('window'), surface: hex('paper'), text: hex('ink'), secondaryText: hex('ink-2'), accent: hex('accent-ink') },
    opacity: must(p.glass).a,
    radius: BUILTIN_RADIUS
  }
}

// ---------------------------------------------------------------------------------------------
// Validation issues

/**
 * Why a theme file or a settings change was refused. The previous settings stay in effect.
 * - `syntax`: not JSON; `format`: not an 汐岛 theme document; `version`: unsupported version.
 * - `field`: `field` is a dotted path (e.g. `colors.text`). `unavailable` means the value is valid
 *   alone but not usable now (e.g. the custom scheme without a custom theme).
 * - `contrast`: ordinary text below `minimum` on a surface (layers bottom to top); `ratio` is
 *   rounded down to two decimals.
 */
export type AppearanceIssue =
  | { kind: 'syntax' }
  | { kind: 'format' }
  | { kind: 'version'; found: number | null }
  | { kind: 'field'; field: string; problem: 'missing' | 'type' | 'range' | 'unknown' | 'unavailable' }
  | { kind: 'contrast'; foreground: ColorToken; surface: Surface; ratio: number; minimum: number }

type Fields = Record<string, unknown>

export function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unknownFields(input: Fields, allowed: readonly string[], prefix: string, issues: AppearanceIssue[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) issues.push({ kind: 'field', field: prefix + key, problem: 'unknown' })
  }
}

function intField(input: Fields, key: string, field: string, range: { min: number; max: number }, issues: AppearanceIssue[]): number | null {
  const value = input[key]
  if (value === undefined) issues.push({ kind: 'field', field, problem: 'missing' })
  else if (typeof value !== 'number' || !Number.isInteger(value)) issues.push({ kind: 'field', field, problem: 'type' })
  else if (value < range.min || value > range.max) issues.push({ kind: 'field', field, problem: 'range' })
  else return value
  return null
}

function enumField<T extends string>(input: Fields, key: string, field: string, values: readonly T[], issues: AppearanceIssue[]): T | null {
  const value = input[key]
  if (value === undefined) issues.push({ kind: 'field', field, problem: 'missing' })
  else if (typeof value !== 'string') issues.push({ kind: 'field', field, problem: 'type' })
  else if (!values.includes(value as T)) issues.push({ kind: 'field', field, problem: 'range' })
  else return value as T
  return null
}

const READING_KEYS = ['font', 'fontSize', 'readingWidth'] as const

function readReading(input: Fields, prefix: string, issues: AppearanceIssue[]): ReadingParams | null {
  const font = enumField(input, 'font', prefix + 'font', ['sans', 'serif'] as const, issues)
  const fontSize = intField(input, 'fontSize', prefix + 'fontSize', THEME_LIMITS.fontSize, issues)
  const readingWidth = intField(input, 'readingWidth', prefix + 'readingWidth', THEME_LIMITS.readingWidth, issues)
  return font === null || fontSize === null || readingWidth === null ? null : { font, fontSize, readingWidth }
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; issues: AppearanceIssue[] }

/** Validates reading parameters (settings value). */
export function parseReadingParams(value: unknown, field = 'reading'): Parsed<ReadingParams> {
  if (!isRecord(value)) return { ok: false, issues: [{ kind: 'field', field, problem: 'type' }] }
  const issues: AppearanceIssue[] = []
  unknownFields(value, READING_KEYS, `${field}.`, issues)
  const reading = readReading(value, `${field}.`, issues)
  return reading !== null && issues.length === 0 ? { ok: true, value: reading } : { ok: false, issues }
}

const THEME_KEYS = ['name', 'base', 'colors', 'opacity', 'radius'] as const
// Control characters and bidirectional overrides are refused in names.
const NAME_FORBIDDEN = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]/u

function readTheme(input: Fields, prefix: string, issues: AppearanceIssue[]): CustomTheme | null {
  const start = issues.length
  let name: string | null = null
  const rawName = input.name
  if (rawName === undefined) issues.push({ kind: 'field', field: prefix + 'name', problem: 'missing' })
  else if (typeof rawName !== 'string') issues.push({ kind: 'field', field: prefix + 'name', problem: 'type' })
  else {
    const trimmed = rawName.trim()
    const length = [...trimmed].length
    if (length < THEME_LIMITS.nameLength.min || length > THEME_LIMITS.nameLength.max || NAME_FORBIDDEN.test(trimmed)) {
      issues.push({ kind: 'field', field: prefix + 'name', problem: 'range' })
    } else name = trimmed
  }
  const base = enumField(input, 'base', prefix + 'base', ['light', 'dark'] as const, issues)

  const colors: Partial<ThemeColors> = {}
  const rawColors = input.colors
  if (rawColors === undefined) issues.push({ kind: 'field', field: prefix + 'colors', problem: 'missing' })
  else if (!isRecord(rawColors)) issues.push({ kind: 'field', field: prefix + 'colors', problem: 'type' })
  else {
    unknownFields(rawColors, THEME_COLOR_KEYS, `${prefix}colors.`, issues)
    for (const key of THEME_COLOR_KEYS) {
      const field = `${prefix}colors.${key}`
      const value = rawColors[key]
      if (value === undefined) issues.push({ kind: 'field', field, problem: 'missing' })
      else if (typeof value !== 'string') issues.push({ kind: 'field', field, problem: 'type' })
      else if (!HEX.test(value)) issues.push({ kind: 'field', field, problem: 'range' })
      else colors[key] = value.toLowerCase()
    }
  }

  let opacity: number | null = null
  const rawOpacity = input.opacity
  if (rawOpacity === undefined) issues.push({ kind: 'field', field: prefix + 'opacity', problem: 'missing' })
  else if (typeof rawOpacity !== 'number' || !Number.isFinite(rawOpacity)) issues.push({ kind: 'field', field: prefix + 'opacity', problem: 'type' })
  else if (rawOpacity < THEME_LIMITS.opacity.min || rawOpacity > THEME_LIMITS.opacity.max) {
    issues.push({ kind: 'field', field: prefix + 'opacity', problem: 'range' })
  } else opacity = Math.round(rawOpacity * 100) / 100
  const radius = intField(input, 'radius', prefix + 'radius', THEME_LIMITS.radius, issues)

  if (issues.length > start || name === null || base === null || opacity === null || radius === null) return null
  return { name, base, colors: colors as ThemeColors, opacity, radius }
}

/** Contrast issues of a custom theme (empty when every listed pair reaches the minimum). */
export function themeContrastIssues(theme: CustomTheme): AppearanceIssue[] {
  return paletteContrastFailures(customPalette(theme)).map((failure) => ({
    kind: 'contrast',
    foreground: failure.foreground,
    surface: failure.surface,
    ratio: Math.floor(failure.ratio * 100) / 100,
    minimum: MIN_TEXT_CONTRAST
  }))
}

/** Validates a custom theme value (settings or editor), including the contrast checks. */
export function parseCustomTheme(value: unknown, field = 'customTheme'): Parsed<CustomTheme> {
  if (!isRecord(value)) return { ok: false, issues: [{ kind: 'field', field, problem: 'type' }] }
  const issues: AppearanceIssue[] = []
  unknownFields(value, THEME_KEYS, `${field}.`, issues)
  const theme = readTheme(value, `${field}.`, issues)
  if (theme === null || issues.length > 0) return { ok: false, issues }
  const contrast = themeContrastIssues(theme)
  return contrast.length > 0 ? { ok: false, issues: contrast } : { ok: true, value: theme }
}

// ---------------------------------------------------------------------------------------------
// Theme files

export const THEME_FORMAT = 'xidao-theme'
export const THEME_VERSION = 1
/** Largest theme file accepted for import, bytes. */
export const MAX_THEME_FILE_BYTES = 64 * 1024

/** Version 1 theme file: one JSON object with exactly these fields. */
export interface ThemeDocument extends CustomTheme, ReadingParams {
  format: typeof THEME_FORMAT
  version: typeof THEME_VERSION
}

const DOCUMENT_KEYS = ['format', 'version', ...THEME_KEYS, ...READING_KEYS] as const

export function themeDocument(theme: CustomTheme, reading: ReadingParams): ThemeDocument {
  return { format: THEME_FORMAT, version: THEME_VERSION, ...theme, colors: { ...theme.colors }, ...reading }
}

export function serializeThemeDocument(document: ThemeDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`
}

/** Parses a theme file. Unknown versions and fields, out-of-range values and low contrast are refused. */
export function parseThemeDocument(text: string): { ok: true; theme: CustomTheme; reading: ReadingParams } | { ok: false; issues: AppearanceIssue[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, issues: [{ kind: 'syntax' }] }
  }
  if (!isRecord(raw) || raw.format !== THEME_FORMAT) return { ok: false, issues: [{ kind: 'format' }] }
  if (raw.version !== THEME_VERSION) {
    return { ok: false, issues: [{ kind: 'version', found: typeof raw.version === 'number' ? raw.version : null }] }
  }
  const issues: AppearanceIssue[] = []
  unknownFields(raw, DOCUMENT_KEYS, '', issues)
  const theme = readTheme(raw, '', issues)
  const reading = readReading(raw, '', issues)
  if (theme === null || reading === null || issues.length > 0) return { ok: false, issues }
  const contrast = themeContrastIssues(theme)
  return contrast.length > 0 ? { ok: false, issues: contrast } : { ok: true, theme, reading }
}
