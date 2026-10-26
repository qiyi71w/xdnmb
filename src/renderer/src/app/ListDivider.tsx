// The draggable divider between the thread list and the reader in split view. The chosen width is
// the `listWidth` setting, saved by the app at the end of each change.

import { useRef, type KeyboardEvent, type PointerEvent } from 'react'
import { LIST_WIDTH_LIMITS } from '../../../shared/settings'

/** Arrow-key step, CSS pixels. */
const STEP = 16

/**
 * Pointer drag, ←/→, Home/End; a double click restores the default width. `max` is the widest list
 * the reader currently leaves room for. `onResize` gets an in-range width; `done` marks the end of
 * a change (drag released, key, double click), when it is saved.
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
  const ceiling = Math.min(LIST_WIDTH_LIMITS.max, Math.max(LIST_WIDTH_LIMITS.min, max))
  const clamp = (value: number) => Math.round(Math.min(ceiling, Math.max(LIST_WIDTH_LIMITS.min, value)))
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
    else if (event.key === 'Home') next = LIST_WIDTH_LIMITS.min
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
      aria-valuemin={LIST_WIDTH_LIMITS.min}
      aria-valuemax={ceiling}
      tabIndex={0}
      title="拖动调整宽度，双击还原"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => onResize(LIST_WIDTH_LIMITS.default, true)}
      onKeyDown={onKeyDown}
    />
  )
}
