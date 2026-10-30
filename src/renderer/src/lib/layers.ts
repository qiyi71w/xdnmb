/**
 * Open closable layers (popovers, overlays, quote cards) in opening order. Escape belongs to the
 * most recently opened one only: each layer's handler checks `isTop()` before acting, so one Esc
 * closes one layer and the next Esc the layer below it.
 */
const stack: symbol[] = []
const listeners = new Set<() => void>()
let notifying = false

/**
 * Listeners hear about layer changes once the opening or closing code has finished: a dialog that
 * opens its layer and then calls `showModal()` (or releases it and is then removed) is already in
 * its new state by then.
 */
function changed(): void {
  if (notifying || listeners.size === 0) return
  notifying = true
  queueMicrotask(() => {
    notifying = false
    for (const listener of listeners) listener()
  })
}

/** Calls `listener` after layers open or close; returns the unsubscribe. */
export function onLayersChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export interface Layer {
  isTop(): boolean
  /** The layer closed: the one below it becomes the top again. */
  release(): void
}

export function openLayer(): Layer {
  const token = Symbol('layer')
  stack.push(token)
  changed()
  return {
    isTop: () => stack[stack.length - 1] === token,
    release: () => {
      const at = stack.indexOf(token)
      if (at < 0) return
      stack.splice(at, 1)
      changed()
    }
  }
}
