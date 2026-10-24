import { useSyncExternalStore } from 'react'

/**
 * Number of open modal dialogs. A modal covers every reader below it, so no reader may judge
 * posts read while one is open (spec I6: only the visible foreground reader counts).
 */
let open = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/** A modal opened; the returned function closes it (idempotent). */
export function coverReaders(): () => void {
  open += 1
  notify()
  let released = false
  return () => {
    if (released) return
    released = true
    open -= 1
    notify()
  }
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

/** Whether any modal dialog currently covers the readers. */
export function useReadersCovered(): boolean {
  return useSyncExternalStore(subscribe, () => open > 0)
}
