// PROTOTYPE (throwaway): the draggable divider between the thread list and the reader in split view.
// Active only with VITE_XIDAO_PROTOTYPE=1; the chosen width is kept in localStorage.

import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { LAYOUT_DEFAULTS } from '../features/layout/layout'

/** Narrowest list the divider allows. */
export const LIST_WIDTH_MIN = 260
/** Arrow-key step, CSS pixels. */
const STEP = 16
const LIST_WIDTH_KEY = 'xidao.prototype.listWidth'

/** The saved list width; the default when nothing usable is saved. */
export function readListWidth(): number {
  try {
    const saved = Number(localStorage.getItem(LIST_WIDTH_KEY))
    return Number.isFinite(saved) && saved >= LIST_WIDTH_MIN ? Math.round(saved) : LAYOUT_DEFAULTS.listWidth
  } catch {
    return LAYOUT_DEFAULTS.listWidth
  }
}

export function saveListWidth(width: number): void {
  try {
    localStorage.setItem(LIST_WIDTH_KEY, String(Math.round(width)))
  } catch {
    // Not remembered across restarts; the width still applies.
  }
}

/**
 * Pointer drag, ←/→, Home/End; a double click restores the default width. `max` is the widest list
 * the reader currently leaves room for. `onResize` gets an in-range width; `done` marks the end of
 * a change (drag released, key, double click), when it is worth saving.
 */
export function ListDivider({
  width,
  max,
  onResize
}: {
  width: number
  max: number
  onResize: (width: number, done: boolean) => void
}) {
  const ceiling = Math.max(LIST_WIDTH_MIN, max)
  const clamp = (value: number) => Math.round(Math.min(ceiling, Math.max(LIST_WIDTH_MIN, value)))
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; last: number } | null>(null)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    event.currentTarget.classList.add('is-dragging')
    event.currentTarget.focus({ preventScroll: true })
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: width, last: width }
  }
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (current === null || current.pointerId !== event.pointerId) return
    const next = clamp(current.startWidth + event.clientX - current.startX)
    if (next === current.last) return
    current.last = next
    onResize(next, false)
  }
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current
    if (current === null || current.pointerId !== event.pointerId) return
    drag.current = null
    event.currentTarget.classList.remove('is-dragging')
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    if (current.last !== current.startWidth) onResize(current.last, true)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number
    if (event.key === 'ArrowLeft') next = width - STEP
    else if (event.key === 'ArrowRight') next = width + STEP
    else if (event.key === 'Home') next = LIST_WIDTH_MIN
    else if (event.key === 'End') next = ceiling
    else return
    event.preventDefault()
    const clamped = clamp(next)
    if (clamped !== width) onResize(clamped, true)
  }

  return (
    <div
      className="list-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label="串列表宽度"
      aria-valuenow={width}
      aria-valuemin={LIST_WIDTH_MIN}
      aria-valuemax={ceiling}
      tabIndex={0}
      title="拖动调整宽度，双击还原"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onResize(clamp(LAYOUT_DEFAULTS.listWidth), true)}
      onKeyDown={onKeyDown}
    />
  )
}
