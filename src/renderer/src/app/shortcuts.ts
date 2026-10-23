import type { AppPlatform } from '../../../shared/api'

export type ShortcutAction = 'new-tab' | 'close-tab' | 'next-tab' | 'previous-tab' | 'refresh' | 'back' | 'forward'

export interface KeyInput {
  key: string
  code: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/** Letter of a key press: the produced character, or the physical key on non-Latin layouts. */
function letterOf(event: KeyInput): string | null {
  if (/^[a-z]$/i.test(event.key)) return event.key.toLowerCase()
  return /^Key[A-Z]$/.test(event.code) ? event.code.slice(3).toLowerCase() : null
}

/**
 * App shortcuts (spec I11). macOS: Cmd+T/W/R, Control+Tab, Cmd+[ / Cmd+]. Windows/Linux:
 * Ctrl+T/W/R, Ctrl+Tab, Alt+Left / Alt+Right. Backspace is never “back”.
 */
export function matchShortcut(event: KeyInput, platform: AppPlatform): ShortcutAction | null {
  if (event.key === 'Tab' && event.ctrlKey && !event.metaKey && !event.altKey) {
    return event.shiftKey ? 'previous-tab' : 'next-tab'
  }
  if (platform === 'darwin') {
    if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
    if (event.key === '[' || event.code === 'BracketLeft') return 'back'
    if (event.key === ']' || event.code === 'BracketRight') return 'forward'
  } else {
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (event.key === 'ArrowLeft') return 'back'
      if (event.key === 'ArrowRight') return 'forward'
      return null
    }
    if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null
  }
  switch (letterOf(event)) {
    case 't':
      return 'new-tab'
    case 'w':
      return 'close-tab'
    case 'r':
      return 'refresh'
    default:
      return null
  }
}

/** Text fields keep their own editing keys: history shortcuts are not taken there. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}

const LABELS: Record<ShortcutAction, { mac: string; other: string }> = {
  'new-tab': { mac: '⌘T', other: 'Ctrl+T' },
  'close-tab': { mac: '⌘W', other: 'Ctrl+W' },
  'next-tab': { mac: '⌃Tab', other: 'Ctrl+Tab' },
  'previous-tab': { mac: '⌃⇧Tab', other: 'Ctrl+Shift+Tab' },
  refresh: { mac: '⌘R', other: 'Ctrl+R' },
  back: { mac: '⌘[', other: 'Alt+←' },
  forward: { mac: '⌘]', other: 'Alt+→' }
}

/** Shortcut shown in tooltips; empty until the platform is known. */
export function shortcutLabel(action: ShortcutAction, platform: AppPlatform | null): string {
  if (platform === null) return ''
  return platform === 'darwin' ? LABELS[action].mac : LABELS[action].other
}
