// PROTOTYPE (throwaway): the reader's floating 开头 / 末尾 pills. The reader reports its user scrolls
// (never a position it set itself) and the user's input on it; the rules are in jumpPills.ts.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { PILL_GESTURE_MS, PILL_IDLE_MS, PILL_REST, scrollStep, type JumpPill, type PillEnds, type PillTracker } from './jumpPills'

export interface JumpPills {
  shown: JumpPill | null
  /** A scroll of `delta` px, not set by the reader, in a viewport `viewport` px high. */
  scrolled: (delta: number, viewport: number, ends: PillEnds) => void
  /** The user's own input on the reader that may scroll it: wheel, touch, a key. */
  gesture: () => void
  /** A pointer pressed on the reader (a scrollbar drag): its scrolls count until it is released. */
  pressed: () => void
  /** Hides at once and forgets the run (the reader placed a position, an action ran). */
  hide: () => void
  /** Pointer over or focus on a pill: it does not time out meanwhile. */
  hold: (by: 'pointer' | 'focus', on: boolean) => void
}

/** Re-renders only when the shown pill changes, not on every scroll. */
export function useJumpPills(): JumpPills {
  const [shown, setShown] = useState<JumpPill | null>(null)
  const tracker = useRef(PILL_REST)
  const timer = useRef<number | undefined>(undefined)
  const held = useRef({ pointer: false, focus: false })
  /** Time of the last user input on the reader, and whether a pointer is held on it. */
  const lastGesture = useRef(Number.NEGATIVE_INFINITY)
  const pointerDown = useRef(false)

  const apply = useCallback((next: PillTracker) => {
    tracker.current = next
    // A hidden pill is inert: a pointer resting there or a focus it had no longer holds the next one.
    if (next.shown === null) held.current = { pointer: false, focus: false }
    setShown(next.shown)
  }, [])

  const arm = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      if (!held.current.pointer && !held.current.focus) apply(PILL_REST)
    }, PILL_IDLE_MS)
  }, [apply])

  const scrolled = useCallback(
    (delta: number, viewport: number, ends: PillEnds) => {
      const byGesture = pointerDown.current || performance.now() - lastGesture.current < PILL_GESTURE_MS
      const next = scrollStep(tracker.current, { delta, viewport, byGesture }, ends)
      if (next === tracker.current) return
      apply(next)
      if (next.shown === null) window.clearTimeout(timer.current)
      else arm()
    },
    [apply, arm]
  )

  const gesture = useCallback(() => {
    lastGesture.current = performance.now()
  }, [])

  const pressed = useCallback(() => {
    pointerDown.current = true
  }, [])

  // Released anywhere: a drag's last scroll events may still arrive just after.
  useEffect(() => {
    const release = () => {
      if (!pointerDown.current) return
      pointerDown.current = false
      lastGesture.current = performance.now()
    }
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', release, true)
    return () => {
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('pointercancel', release, true)
    }
  }, [])

  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    if (tracker.current !== PILL_REST) apply(PILL_REST)
  }, [apply])

  const hold = useCallback(
    (by: 'pointer' | 'focus', on: boolean) => {
      held.current[by] = on
      if (on) window.clearTimeout(timer.current)
      else if (tracker.current.shown !== null) arm()
    },
    [arm]
  )

  useEffect(() => () => window.clearTimeout(timer.current), [])
  return { shown, scrolled, gesture, pressed, hide, hold }
}

const PILL_TEXT: Record<JumpPill, { text: string; name: string; keys: string; icon: 'toTop' | 'toEnd' }> = {
  start: { text: '开头', name: '回到开头', keys: 'Control+Home Meta+Home', icon: 'toTop' },
  end: { text: '末尾', name: '跳到末尾', keys: 'Control+End Meta+End', icon: 'toEnd' }
}

/**
 * One pill. Mounted always so it can fade; while hidden it is inert (no Tab stop, not announced).
 * It never takes focus by itself; if it is hidden while focused, `onFocusLost` puts focus back.
 */
export function JumpPillButton({
  pill,
  shown,
  onActivate,
  onHold,
  onFocusLost
}: {
  pill: JumpPill
  shown: boolean
  onActivate: () => void
  onHold: (by: 'pointer' | 'focus', on: boolean) => void
  onFocusLost: () => void
}) {
  const ref = useRef<HTMLButtonElement>(null)
  const { text, name, keys, icon } = PILL_TEXT[pill]
  // Runs before the browser drops focus from the now inert pill.
  useLayoutEffect(() => {
    if (!shown && ref.current !== null && ref.current === document.activeElement) onFocusLost()
  }, [shown, onFocusLost])
  return (
    <button
      ref={ref}
      type="button"
      className={`jump-pill is-${pill}`}
      data-shown={shown ? '' : undefined}
      inert={!shown}
      aria-label={name}
      aria-keyshortcuts={keys}
      onPointerEnter={() => onHold('pointer', true)}
      onPointerLeave={() => onHold('pointer', false)}
      onFocus={() => onHold('focus', true)}
      onBlur={() => onHold('focus', false)}
      onClick={onActivate}
    >
      <Icon name={icon} size={14} />
      {text}
    </button>
  )
}
