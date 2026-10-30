import { useLayoutEffect, useRef, useState } from 'react'

/**
 * A page's visits, ended by leaving it. `begin` marks an operation's start; its check stays true
 * until the page is next left, so an operation that outlives the visit it began on is stale.
 */
export interface Visits {
  leave(): void
  begin(): () => boolean
}

export function visits(): Visits {
  let visit = 0
  return {
    leave() {
      visit += 1
    },
    begin() {
      const started = visit
      return () => visit === started
    }
  }
}

/**
 * Clears a displayed page's transient results when it is hidden or unmounted, not on window blur.
 * Returns `begin`: a success whose operation began before the page was last left is not shown, so
 * one finishing while hidden, or after a return, does not appear on the new visit.
 */
export function useClearOnLeave(displayed: boolean, clear: () => void): () => () => boolean {
  const latest = useRef(clear)
  const [tracker] = useState(visits)
  useLayoutEffect(() => {
    latest.current = clear
  })
  useLayoutEffect(() => {
    if (!displayed) return
    return () => {
      tracker.leave()
      latest.current()
    }
  }, [displayed, tracker])
  return tracker.begin
}
