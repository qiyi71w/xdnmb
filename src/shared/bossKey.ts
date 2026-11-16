// 老板键: the one system-wide shortcut. Pressing it sends the app to 后台驻留, pressing it again opens
// the window. Stored and registered as an Electron accelerator in one canonical form.
import type { AppPlatform } from './api'

/** ⌃⌥H on macOS, Ctrl+Alt+H on Windows. */
export const BOSS_KEY_DEFAULT = 'Control+Alt+H'

/** Canonical order (also the order macOS shows them in: ⌃⌥⇧⌘). `Super` is the Windows key. */
const MODIFIERS = ['Control', 'Alt', 'Shift', 'Command', 'Super'] as const
type Modifier = (typeof MODIFIERS)[number]

/** Keys a 老板键 may end with: letters, digits and F1–F12, named as in an accelerator. */
const KEY = /^(?:[A-Z]|[0-9]|F(?:[1-9]|1[0-2]))$/

/**
 * Whether `value` is a 老板键 in canonical form: distinct modifiers in canonical order, at least one of
 * them other than Shift (a lone key or Shift+key would take typing away from every other app), then
 * one key.
 */
export function isBossKey(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split('+')
  const key = parts.pop()
  if (key === undefined || !KEY.test(key)) return false
  let last = -1
  for (const part of parts) {
    const index = MODIFIERS.indexOf(part as Modifier)
    if (index <= last) return false
    last = index
  }
  if (parts.includes('Command') && parts.includes('Super')) return false
  return parts.some((part) => part !== 'Shift')
}

/**
 * Combinations the app itself uses (its shortcuts, the edit and app menus, Alt+F4): taken system-wide
 * they would stop working in 汐岛 too. The primary modifier is Command on macOS and Control elsewhere.
 */
function appShortcuts(platform: AppPlatform): ReadonlySet<string> {
  const mac = platform === 'darwin'
  const list = [
    // Tabs, refresh, save, search, zoom reset; select all, copy, cut, paste, undo, redo.
    ...['T', 'W', 'R', 'S', 'F', '0', 'A', 'C', 'X', 'V', 'Z', 'Y'].map((key) => `${mac ? 'Command' : 'Control'}+${key}`),
    // Local search, redo.
    ...['F', 'Z'].map((key) => `${mac ? 'Shift+Command' : 'Control+Shift'}+${key}`)
  ]
  if (mac) {
    // Hide, quit, minimize, hide others, full screen, paste and match style.
    list.push('Command+H', 'Command+Q', 'Command+M', 'Alt+Command+H', 'Control+Command+F', 'Alt+Shift+Command+V')
  } else {
    list.push('Alt+F4')
  }
  return new Set(list)
}

export interface BossKeyInput {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/**
 * Main → renderer: a key pressed in the window while a 老板键 is being recorded. Main takes every such
 * press (but Tab) before the page and the menus see it, so ⌘Q, Alt+F4 and the app's own shortcuts are
 * recorded (and refused) instead of acting.
 */
export const BOSS_KEY_INPUT_CHANNEL = 'boss-key:input'

export interface BossKeyPress extends BossKeyInput {
  /** `KeyboardEvent.key`: Esc ends the recording. */
  key: string
  repeat: boolean
}

/**
 * One key press while recording a 老板键.
 * - `pending`: only modifiers so far; keep listening.
 * - `rejected`: `key` — the key cannot be one (only letters, digits and F1–F12); `modifier` — needs
 *   Ctrl, Alt, ⌘ or the Windows key, not only Shift; `app` — 汐岛 uses this combination itself.
 */
export type BossKeyRecord =
  | { kind: 'pending' }
  | { kind: 'recorded'; accelerator: string }
  | { kind: 'rejected'; reason: 'key' | 'modifier' | 'app' }

const MODIFIER_CODE = /^(?:Control|Alt|Shift|Meta|OS)(?:Left|Right)?$/

/** The physical key, so ⌥ producing another character on macOS still records the key pressed. */
function keyOf(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code
  return null
}

export function recordBossKey(input: BossKeyInput, platform: AppPlatform): BossKeyRecord {
  if (MODIFIER_CODE.test(input.code)) return { kind: 'pending' }
  const key = keyOf(input.code)
  if (key === null) return { kind: 'rejected', reason: 'key' }
  const modifiers: string[] = []
  if (input.ctrlKey) modifiers.push('Control')
  if (input.altKey) modifiers.push('Alt')
  if (input.shiftKey) modifiers.push('Shift')
  if (input.metaKey) modifiers.push(platform === 'darwin' ? 'Command' : 'Super')
  const accelerator = [...modifiers, key].join('+')
  if (!isBossKey(accelerator)) return { kind: 'rejected', reason: 'modifier' }
  if (appShortcuts(platform).has(accelerator)) return { kind: 'rejected', reason: 'app' }
  return { kind: 'recorded', accelerator }
}

const MAC_SYMBOLS: Record<Modifier, string> = { Control: '⌃', Alt: '⌥', Shift: '⇧', Command: '⌘', Super: '⌘' }
const OTHER_NAMES: Record<Modifier, string> = { Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Command: 'Win', Super: 'Win' }

/** How the combination is written for the user: `⌃⌥H` on macOS, `Ctrl+Alt+H` elsewhere. */
export function bossKeyLabel(accelerator: string, platform: AppPlatform): string {
  const parts = accelerator.split('+')
  const key = parts.pop() ?? ''
  const modifiers = parts as Modifier[]
  return platform === 'darwin'
    ? modifiers.map((modifier) => MAC_SYMBOLS[modifier]).join('') + key
    : [...modifiers.map((modifier) => OTHER_NAMES[modifier]), key].join('+')
}

/**
 * Whether the 老板键 works right now.
 * - `off`: not turned on.
 * - `active`: registered with the system.
 * - `unavailable`: turned on, but the system refused it (another program holds the combination).
 * - `unsupported`: no 老板键 here (Linux).
 */
export type BossKeyStatus = 'off' | 'active' | 'unavailable' | 'unsupported'

export interface BossKeyApi {
  /** The current status; when turned on but not registered, registering is tried again first. */
  get(): Promise<BossKeyStatus>
  /**
   * While the settings page records a new combination, the registered one is released so pressing it
   * reaches the page; `false` registers it again. Leaving the page always ends a recording.
   */
  setRecording(input: { recording: boolean }): Promise<BossKeyStatus>
  /** Key presses taken by main while recording; returns the unsubscribe function. */
  onInput(listener: (press: BossKeyPress) => void): () => void
}
