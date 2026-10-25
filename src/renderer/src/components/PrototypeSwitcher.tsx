// PROTOTYPE (throwaway): floating bar that cycles UI prototype variants. Mounted only in builds
// with VITE_XIDAO_PROTOTYPE=1. ← / → cycle too, except inside text fields, dialogs, menus, tab
// strips and other controls that use those keys themselves.

import { useEffect, useLayoutEffect, useRef } from 'react'
import { Icon } from './Icon'
import './prototype-switcher.css'

const KEEPS_ARROWS =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"]), dialog, [role="dialog"], [role="menu"], [role="listbox"], [role="tablist"], [role="toolbar"], [role="slider"], [data-keeps-arrows], .image-viewer, .nav.is-overlay'

export function PrototypeSwitcher<K extends string>({
  variants,
  current,
  onChange
}: {
  variants: readonly { key: K; name: string }[]
  current: K
  onChange: (key: K) => void
}) {
  const index = Math.max(0, variants.findIndex((variant) => variant.key === current))
  const step = (delta: number) => {
    const next = variants[(index + delta + variants.length) % variants.length]
    if (next !== undefined) onChange(next.key)
  }
  const stepRef = useRef(step)
  useLayoutEffect(() => {
    stepRef.current = step
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest(KEEPS_ARROWS) != null || document.querySelector('dialog[open]') !== null) return
      event.preventDefault()
      stepRef.current(event.key === 'ArrowRight' ? 1 : -1)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const variant = variants[index]
  return (
    <div className="prototype-switcher" role="group" aria-label="原型方案">
      <button type="button" className="prototype-switcher-arrow" aria-label="上一个方案" onClick={() => step(-1)}>
        <Icon name="arrowLeft" size={14} />
      </button>
      <span className="prototype-switcher-label" aria-live="polite">
        {variant === undefined ? '' : `${variant.key} ${variant.name}`}
      </span>
      <button type="button" className="prototype-switcher-arrow" aria-label="下一个方案" onClick={() => step(1)}>
        <Icon name="arrowRight" size={14} />
      </button>
    </div>
  )
}
