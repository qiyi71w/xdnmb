// PROTOTYPE (throwaway): when the reader's floating 开头 / 末尾 pills show. Pure, so the rules can be
// tested without a DOM; JumpPills.tsx feeds it the reader's own scrolls only.

/** `start` is 开头 (above, after moving up), `end` is 末尾 (below, after moving down). */
export type JumpPill = 'start' | 'end'

export interface PillTracker {
  /** Direction of the current run of user scrolls. */
  direction: 'up' | 'down' | null
  /** Distance scrolled in that direction since it started, in px. */
  travelled: number
  shown: JumpPill | null
}

export const PILL_REST: PillTracker = { direction: null, travelled: 0, shown: null }

/** Part of the viewport that one run of scrolling in a direction must cover before its pill shows. */
export const PILL_TRAVEL = 1 / 3

/** How long a shown pill stays without scrolling, unless the pointer or focus is on it. */
export const PILL_IDLE_MS = 2500

/**
 * A scroll counts for the pills only within this long after the user's own input on the reader
 * (wheel, touch, key) or while a pointer is held on it (scrollbar drag). Scrolls the reader or the
 * browser makes by itself while a thread opens and settles (positioning, late layout, focus) do not.
 */
export const PILL_GESTURE_MS = 600

/** One observed scroll: `delta` is the scrollTop change, positive downwards. */
export interface PillScroll {
  delta: number
  /** Viewport height in px. */
  viewport: number
  /** Made by a user gesture (see PILL_GESTURE_MS). */
  byGesture: boolean
}

/** Which ends of the thread are on screen now. */
export interface PillEnds {
  /** Page 1 is loaded and its top is on screen. */
  atStart: boolean
  /** The real last page is loaded and its bottom is on screen. */
  atEnd: boolean
}

/**
 * One scroll of the reader. Only scrolls made by a user gesture count: anything else neither shows
 * a pill nor extends or breaks a run. A run in one direction shows its pill once it covers a third
 * of the viewport; turning around hides the shown pill and starts a new run. No pill shows for an
 * end that is already on screen.
 */
export function scrollStep(state: PillTracker, { delta, viewport, byGesture }: PillScroll, ends: PillEnds): PillTracker {
  if (delta === 0 || !byGesture) return state
  const direction = delta > 0 ? 'down' : 'up'
  const same = direction === state.direction
  const travelled = (same ? state.travelled : 0) + Math.abs(delta)
  const pill: JumpPill = direction === 'down' ? 'end' : 'start'
  const there = pill === 'end' ? ends.atEnd : ends.atStart
  const shown = there ? null : travelled >= viewport * PILL_TRAVEL ? pill : same ? state.shown : null
  return { direction, travelled, shown }
}
