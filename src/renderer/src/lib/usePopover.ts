import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { openLayer } from './layers'

/**
 * Open state of a popover or overlay owned by a trigger button. While open: Escape or a pointer
 * press outside the panel and trigger closes it and returns focus to the trigger, unless
 * `keepsOpen` claims that press (it acts on its own, leaving the popover and focus as they are).
 * Opening moves focus into the panel (`[data-autofocus]`, else its first focusable control).
 */
export function usePopover(
  triggerRef: RefObject<HTMLElement | null>,
  panelRef: RefObject<HTMLElement | null>,
  keepsOpen?: (event: PointerEvent) => boolean
) {
  const [open, setOpen] = useState(false)
  const openRef = useRef(open)
  const keepsOpenRef = useRef(keepsOpen)
  useLayoutEffect(() => {
    openRef.current = open
    keepsOpenRef.current = keepsOpen
  })

  /** Closes; `returnFocus` sends focus back to the trigger. */
  const close = useCallback(
    (returnFocus = true) => {
      if (!openRef.current) return
      openRef.current = false
      setOpen(false)
      if (returnFocus) triggerRef.current?.focus()
    },
    [triggerRef]
  )

  const toggle = useCallback(() => {
    if (openRef.current) close()
    else setOpen(true)
  }, [close])

  useLayoutEffect(() => {
    if (!open) return
    const panel = panelRef.current
    const first =
      panel?.querySelector<HTMLElement>('[data-autofocus]') ??
      panel?.querySelector<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), [href], input, [tabindex="0"]')
    first?.focus()
  }, [open, panelRef])

  useEffect(() => {
    if (!open) return
    const layer = openLayer()
    const onKeyDown = (event: KeyboardEvent) => {
      // Only the most recently opened layer answers Esc; the next Esc reaches the one below.
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || !layer.isTop()) return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target !== null && (panelRef.current?.contains(target) || triggerRef.current?.contains(target))) return
      if (keepsOpenRef.current?.(event)) return
      close()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      layer.release()
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open, close, panelRef, triggerRef])

  return { open, toggle, close }
}
