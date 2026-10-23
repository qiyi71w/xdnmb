import { useEffect, useRef, type RefObject } from 'react'

/**
 * Calls `onReach` when `sentinel` comes within `margin` of the bottom of `root`.
 * The observer is re-armed whenever `armKey` changes; observing reports the current state
 * immediately, so a sentinel that is still visible after a load triggers the next one.
 */
export function useNearEnd(
  root: RefObject<HTMLElement | null>,
  sentinel: RefObject<HTMLElement | null>,
  enabled: boolean,
  armKey: unknown,
  onReach: () => void,
  margin = '0px 0px 640px 0px'
): void {
  const callback = useRef(onReach)
  useEffect(() => {
    callback.current = onReach
  })

  useEffect(() => {
    const target = sentinel.current
    if (!enabled || target === null) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) callback.current()
      },
      { root: root.current, rootMargin: margin }
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [root, sentinel, enabled, armKey, margin])
}
