import { useCallback, useEffect, useState } from 'react'
import { Icon } from './Icon'

/**
 * One full turn of a turning ↻. Paired with `.icon.is-turning` in styles/base.css
 * (`animation: spin 0.9s …`); change both together.
 */
const REFRESH_TURN_MS = 900

export type RefreshTurn = {
  /** The request is running, or the icon is finishing the turn it was on when it ended. */
  turning: boolean
  /** Wired to the turning svg's `animationiteration`; ends the finishing turn. */
  onTurnComplete: () => void
}

/**
 * Feedback for a manual-refresh ↻: it turns while `busy` and, when the request ends mid-turn,
 * keeps turning until that turn is complete, so a quick request still shows one full turn.
 * The finishing turn only animates; it starts nothing. Under reduced motion the icon stays
 * still (base.css) and turning ends with `busy`. Buttons show `aria-busy` while `turning` and
 * ignore clicks then.
 */
export function useRefreshTurn(busy: boolean): RefreshTurn {
  const [wasBusy, setWasBusy] = useState(busy)
  const [finishing, setFinishing] = useState(false)
  // Decided during render, so the icon never paints a frame without the animation between
  // the request ending and the finishing turn (which would restart the turn from zero).
  if (busy !== wasBusy) {
    setWasBusy(busy)
    setFinishing(!busy && document.documentElement.dataset.motion !== 'reduce')
  }

  // The turn ends on the next iteration; should the animation stop mid-turn (reduced motion
  // switched on, icon hidden), the period bounds it anyway.
  useEffect(() => {
    if (!finishing || busy) return
    const timer = window.setTimeout(() => setFinishing(false), REFRESH_TURN_MS)
    return () => window.clearTimeout(timer)
  }, [finishing, busy])

  const onTurnComplete = useCallback(() => {
    if (!busy) setFinishing(false)
  }, [busy])

  return { turning: busy || finishing, onTurnComplete }
}

/** The ↻ of a manual-refresh button; turns while `turn.turning`. */
export function RefreshIcon({ turn, size }: { turn: RefreshTurn; size?: number }) {
  return (
    <Icon
      name="refresh"
      size={size}
      className={turn.turning ? 'is-turning' : undefined}
      onAnimationIteration={turn.turning ? turn.onTurnComplete : undefined}
    />
  )
}
