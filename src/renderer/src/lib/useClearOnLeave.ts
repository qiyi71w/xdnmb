import { useLayoutEffect, useRef } from 'react'

/** Clears a displayed page's transient results when it is hidden or unmounted, not on window blur. */
export function useClearOnLeave(displayed: boolean, clear: () => void): void {
  const latest = useRef(clear)
  useLayoutEffect(() => {
    latest.current = clear
  })
  useLayoutEffect(() => {
    if (!displayed) return
    return () => latest.current()
  }, [displayed])
}
