import type { Announcement, AnnouncementState } from '../../../../shared/announcements'

/**
 * What a startup prompt (a dialog the app raises by itself, not in answer to the user) waits for.
 * The app shell gathers these in one place; a prompt shows only while every one allows it, so it
 * never lands on top of restoring, editing, another dialog or a quit, and never takes focus from
 * a field the user is typing in.
 */
export interface PromptConditions {
  /** Tabs exist, the saved workspace and its drafts were reopened, and the startup lifecycle check settled. */
  restored: boolean
  /** The window is shown and focused. */
  foreground: boolean
  /** A modal layer covers the app: any dialog, the compose panel, a context menu, a running quit. */
  covered: boolean
  /** Keyboard focus is in a text field. */
  typing: boolean
  /** A send is settling by itself (its request, a PO answer or a lookup of an uncertain result). */
  sending: boolean
}

export function promptEligible(conditions: PromptConditions): boolean {
  return conditions.restored && conditions.foreground && !conditions.covered && !conditions.typing && !conditions.sending
}

/** Text entry: where a dialog appearing would take the keys the user is typing. */
export function isTextEntry(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false
  if (element.isContentEditable || element instanceof HTMLTextAreaElement) return true
  if (!(element instanceof HTMLInputElement)) return false
  return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(element.type)
}

/**
 * The one automatic presentation of this run. The main process grants the cold-start announcement
 * at most once, and only while the window is in the foreground; the renderer asks only while a
 * prompt is eligible, holds a grant that arrives after the moment passed, and shows it once a
 * prompt is eligible again.
 * - `reading`: waiting for the cold-start read.
 * - `none`: that read gave nothing that could be shown automatically.
 * - `waiting`: may be granted; `armed` once a new eligible moment began since the last ask.
 * - `taking`: asking for the grant.
 * - `held`: granted, not shown yet.
 * - `shown` / `done`: on screen / closed (or dropped by a quit) — never shown again this run.
 */
export type AutomaticState =
  | { phase: 'reading' }
  | { phase: 'none' }
  | { phase: 'waiting'; armed: boolean }
  | { phase: 'taking' }
  | { phase: 'held'; announcement: Announcement }
  | { phase: 'shown'; announcement: Announcement }
  | { phase: 'done' }

export type AutomaticAction =
  | { type: 'read'; state: AnnouncementState | null }
  /** A prompt became eligible again (a dialog closed, the window came back to the foreground, …). */
  | { type: 'eligible' }
  | { type: 'take' }
  | { type: 'taken'; announcement: Announcement | null }
  | { type: 'show' }
  | { type: 'close' }

export const INITIAL_AUTOMATIC: AutomaticState = { phase: 'reading' }

/**
 * Only a fresh enabled result of this run's read can be granted; a cached copy, a failure or a
 * disabled result never is, so nothing is asked for then.
 */
export function mayBeGranted(state: AnnouncementState | null): boolean {
  return state !== null && state.source === 'current' && state.outcome === 'ready' && state.latest?.enable === true
}

export function automaticReducer(state: AutomaticState, action: AutomaticAction): AutomaticState {
  switch (action.type) {
    case 'read':
      if (state.phase !== 'reading') return state
      return mayBeGranted(action.state) ? { phase: 'waiting', armed: true } : { phase: 'none' }
    case 'eligible':
      return state.phase === 'waiting' && !state.armed ? { phase: 'waiting', armed: true } : state
    case 'take':
      return state.phase === 'waiting' && state.armed ? { phase: 'taking' } : state
    case 'taken':
      if (state.phase !== 'taking') return state
      // Nothing granted: suppressed, or the window was not in the foreground after all; the next
      // eligible moment asks again (the main process never reads again for it).
      return action.announcement === null ? { phase: 'waiting', armed: false } : { phase: 'held', announcement: action.announcement }
    case 'show':
      return state.phase === 'held' ? { phase: 'shown', announcement: state.announcement } : state
    case 'close':
      return state.phase === 'shown' ? { phase: 'done' } : state
  }
}
