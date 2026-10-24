/**
 * Open closable layers (popovers, overlays, quote cards) in opening order. Escape belongs to the
 * most recently opened one only: each layer's handler checks `isTop()` before acting, so one Esc
 * closes one layer and the next Esc the layer below it (spec I11).
 */
const stack: symbol[] = []

export interface Layer {
  isTop(): boolean
  /** The layer closed: the one below it becomes the top again. */
  release(): void
}

export function openLayer(): Layer {
  const token = Symbol('layer')
  stack.push(token)
  return {
    isTop: () => stack[stack.length - 1] === token,
    release: () => {
      const at = stack.indexOf(token)
      if (at >= 0) stack.splice(at, 1)
    }
  }
}
