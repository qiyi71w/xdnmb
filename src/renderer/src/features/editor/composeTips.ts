// PROTOTYPE (throwaway): when the float compose panel's `[data-tip]` tooltips may show. CSS shows a
// tip on hover unless the control carries `data-tip-off`, and on focus only while the control carries
// `data-tip-focus` and matches :focus-visible.
//
// - Pressing a control, a key on it, or changing its value (a cookie chosen from the native select)
//   hides its tip until the pointer leaves it; the pointer may still rest on it, and focus stays.
// - A focus tip needs focus that arrived by Tab / Shift+Tab. Focus placed by code (after a choice,
//   after closing a form) or by a press shows nothing.

import { useEffect, type RefObject } from 'react'

const TIP = '[data-tip]'

function tipOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(TIP) : null
}

export function useComposeTips(panelRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const panel = panelRef.current
    if (panel === null) return
    /** A Tab press is moving focus: the focus it lands on is keyboard focus. */
    let tabbing = false

    const hide = (tip: HTMLElement) => {
      tip.setAttribute('data-tip-off', '')
      tip.removeAttribute('data-tip-focus')
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        tabbing = true
        return
      }
      if (event.key === 'Shift' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Meta') return
      const tip = tipOf(event.target)
      if (tip !== null) hide(tip)
    }
    const onKeyUp = () => {
      tabbing = false
    }
    const onPointerDown = (event: PointerEvent) => {
      tabbing = false
      const tip = tipOf(event.target)
      if (tip !== null) hide(tip)
    }
    const onChange = (event: Event) => {
      const tip = tipOf(event.target)
      if (tip !== null) hide(tip)
    }
    const onPointerOut = (event: PointerEvent) => {
      const tip = tipOf(event.target)
      if (tip === null || (event.relatedTarget instanceof Node && tip.contains(event.relatedTarget))) return
      tip.removeAttribute('data-tip-off')
    }
    const onFocusIn = (event: FocusEvent) => {
      const tip = tipOf(event.target)
      if (tip === null) return
      if (tabbing) {
        tip.removeAttribute('data-tip-off')
        tip.setAttribute('data-tip-focus', '')
      } else {
        tip.removeAttribute('data-tip-focus')
      }
    }
    const onFocusOut = (event: FocusEvent) => {
      const tip = tipOf(event.target)
      if (tip === null || (event.relatedTarget instanceof Node && tip.contains(event.relatedTarget))) return
      tip.removeAttribute('data-tip-focus')
    }

    panel.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    panel.addEventListener('pointerdown', onPointerDown, true)
    panel.addEventListener('change', onChange, true)
    panel.addEventListener('pointerout', onPointerOut)
    panel.addEventListener('focusin', onFocusIn)
    panel.addEventListener('focusout', onFocusOut)
    return () => {
      panel.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      panel.removeEventListener('pointerdown', onPointerDown, true)
      panel.removeEventListener('change', onChange, true)
      panel.removeEventListener('pointerout', onPointerOut)
      panel.removeEventListener('focusin', onFocusIn)
      panel.removeEventListener('focusout', onFocusOut)
    }
  }, [panelRef])
}
