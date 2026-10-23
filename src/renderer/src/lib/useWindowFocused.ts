import { useSyncExternalStore } from 'react'

/** Starts from document.hasFocus(); afterwards only window focus/blur events decide. */
let focused = document.hasFocus()
const listeners = new Set<() => void>()

function update(next: boolean): void {
  if (focused === next) return
  focused = next
  for (const listener of listeners) listener()
}

window.addEventListener('focus', () => update(true))
window.addEventListener('blur', () => update(false))

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  return () => listeners.delete(onChange)
}

/** Whether the 汐岛 window has keyboard focus (the foreground window). */
export function useWindowFocused(): boolean {
  return useSyncExternalStore(subscribe, () => focused)
}
