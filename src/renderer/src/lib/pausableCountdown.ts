/**
 * A countdown that counts only the time nothing holds it: while any reason is held it stands still,
 * and once all are released it goes on with the time it had left. `onExpire` runs once, from a
 * timer, after `duration` ms of unheld time; never after `dispose()`.
 */
export interface PausableCountdown {
  /** Holds (`true`) or releases (`false`) the countdown for `reason`. Repeating either is harmless. */
  hold(reason: string, held: boolean): void
  /** Stops it for good. */
  dispose(): void
}

export function pausableCountdown(
  duration: number,
  onExpire: () => void,
  { held = [], now = () => performance.now() }: { held?: Iterable<string>; now?: () => number } = {}
): PausableCountdown {
  const holds = new Set(held)
  let left = duration
  let startedAt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let finished = false

  const pause = () => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
    left = Math.max(0, left - (now() - startedAt))
  }

  const sync = () => {
    if (holds.size > 0) {
      pause()
      return
    }
    if (timer !== null) return
    startedAt = now()
    const handle = setTimeout(() => {
      // A timer cleared after it was already queued must not count.
      if (timer !== handle) return
      timer = null
      finished = true
      onExpire()
    }, left)
    timer = handle
  }

  sync()
  return {
    hold(reason, isHeld) {
      if (finished) return
      if (isHeld) holds.add(reason)
      else holds.delete(reason)
      sync()
    },
    dispose() {
      pause()
      finished = true
    }
  }
}
