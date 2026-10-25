import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { openLayer } from '../lib/layers'
import { Icon } from './Icon'
import './context-menu.css'

/** Viewport point a context menu opens at. */
export interface ContextMenuPoint {
  x: number
  y: number
}

export type ContextMenuItem =
  | {
      /** A setting toggled in place: the menu stays open so its new state and any error show. */
      type: 'check'
      key: string
      label: string
      checked: boolean
      disabled?: boolean
      busy?: boolean
      onSelect: () => void
    }
  | {
      type: 'action'
      key: string
      label: string
      disabled?: boolean
      title?: string
      /** Runs without closing the menu (e.g. a retry whose result shows in the menu). */
      keepOpen?: boolean
      onSelect: () => void
    }
  | { type: 'separator'; key: string }

/**
 * Where a context menu for `owner` opens: the pointer for a right-click, else (ContextMenu key,
 * Shift+F10) a point near the start of the owner's first line.
 */
export function contextMenuPoint(event: MouseEvent | KeyboardEvent | null, owner: HTMLElement): ContextMenuPoint {
  if (event !== null && 'button' in event && event.button === 2) return { x: event.clientX, y: event.clientY }
  const rect = owner.getBoundingClientRect()
  return { x: rect.left + 24, y: rect.top + Math.min(rect.height, 32) }
}

/** The ContextMenu key or Shift+F10: the keyboard asks for the focused element's context menu. */
export function isContextMenuKey(event: KeyboardEvent): boolean {
  return event.key === 'ContextMenu' || (event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && event.key === 'F10')
}

/**
 * A themed context menu at a viewport point, kept inside the window. Opening focuses its first
 * item; arrow keys, Home and End move between items; Enter or Space chooses. Esc, Tab, a press
 * outside, scrolling, resizing or leaving the window closes it; `onClose(true)` asks the owner to
 * take focus back. Choosing an action closes the menu (focus back first) before it runs.
 */
export function ContextMenu({
  point,
  label,
  items,
  footer,
  onClose
}: {
  point: ContextMenuPoint
  /** Accessible name of the menu. */
  label: string
  items: readonly ContextMenuItem[]
  /** Status shown under the items (e.g. why a toggle did not apply); outside the menu role. */
  footer?: ReactNode
  onClose: (returnFocus: boolean) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })

  // Inside the window: left of the point when it would cross the right edge, above it when it
  // would cross the bottom; never past the top-left margin.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (box === null) return
    const margin = 8
    const { width, height } = box.getBoundingClientRect()
    const maxLeft = window.innerWidth - margin - width
    const maxTop = window.innerHeight - margin - height
    const left = point.x > maxLeft ? Math.max(margin, Math.min(point.x - width, maxLeft)) : Math.max(margin, point.x)
    const top = point.y > maxTop ? Math.max(margin, Math.min(point.y - height, maxTop)) : Math.max(margin, point.y)
    box.style.left = `${left}px`
    box.style.top = `${top}px`
    box.style.visibility = ''
  })

  useLayoutEffect(() => {
    menuRef.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus()
  }, [point])

  useEffect(() => {
    const layer = openLayer()
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || !layer.isTop()) return
      event.preventDefault()
      event.stopPropagation()
      closeRef.current(true)
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target !== null && boxRef.current?.contains(target)) return
      closeRef.current(true)
    }
    const dismiss = () => closeRef.current(false)
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && boxRef.current?.contains(event.target)) return
      dismiss()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', dismiss)
    window.addEventListener('blur', dismiss)
    return () => {
      layer.release()
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('blur', dismiss)
    }
  }, [])

  // React events from a portal still bubble to the owner's handlers (a list's roving focus, the
  // owner's own context-menu keys): the menu keeps every key to itself.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation()
    if (event.key === 'Tab' || isContextMenuKey(event)) {
      event.preventDefault()
      onClose(true)
      return
    }
    const entries = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    const at = entries.indexOf(document.activeElement as HTMLElement)
    let next: HTMLElement | undefined
    if (event.key === 'ArrowDown') next = entries[(at + 1) % entries.length]
    else if (event.key === 'ArrowUp') next = entries[(at - 1 + entries.length) % entries.length]
    else if (event.key === 'Home') next = entries[0]
    else if (event.key === 'End') next = entries.at(-1)
    else return
    event.preventDefault()
    next?.focus()
  }

  const choose = (item: ContextMenuItem) => {
    if (item.type === 'separator' || item.disabled === true) return
    if (item.type === 'action' && item.keepOpen !== true) onClose(true)
    item.onSelect()
  }

  return createPortal(
    <div
      ref={boxRef}
      className="context-menu"
      style={{ left: point.x, top: point.y, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <div ref={menuRef} role="menu" aria-label={label} className="context-menu-items">
        {items.map((item) =>
          item.type === 'separator' ? (
            <div key={item.key} role="separator" className="context-menu-separator" />
          ) : (
            <button
              key={item.key}
              type="button"
              role={item.type === 'check' ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={item.type === 'check' ? item.checked : undefined}
              aria-disabled={item.disabled === true ? true : undefined}
              aria-busy={item.type === 'check' && item.busy === true ? true : undefined}
              title={item.type === 'action' ? item.title : undefined}
              className={item.type === 'check' && item.checked ? 'context-menu-item is-on' : 'context-menu-item'}
              tabIndex={-1}
              onClick={() => choose(item)}
            >
              {item.type === 'check' && (
                <span className="context-menu-check" aria-hidden="true">
                  {item.checked && <Icon name="check" size={14} />}
                </span>
              )}
              <span className="context-menu-label">{item.label}</span>
            </button>
          )
        )}
      </div>
      {footer !== undefined && footer !== null && footer !== false && <div className="context-menu-footer">{footer}</div>}
    </div>,
    document.body
  )
}
