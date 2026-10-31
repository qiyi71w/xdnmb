// 饼干颜色… from a post or thread-row context menu: a small palette beside the 饼干 ID (at the menu's
// place when that ID is not in view), 默认 and the eight colors. Choosing saves at once.

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { CookieColorName } from '../../../../shared/cookieColors'
import { validateCookieId } from '../../../../shared/identity'
import { isContextMenuKey, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { CookieId } from '../../components/CookieId'
import { Icon } from '../../components/Icon'
import { useCover } from '../../lib/appCovered'
import { openLayer } from '../../lib/layers'
import { COOKIE_COLOR_CHOICES, cookieColorLabel, cookieSwatchFill } from './cookieColorNames'
import { setCookieColor, useCookieColor } from './cookieColorsStore'
import '../../components/context-menu.css'
import './cookieColors.css'

interface PickerRequest {
  /** Remounts the picker for each request. */
  seq: number
  cookieId: string
  /** Where the menu opened: the palette's place when the 饼干 ID is not in view. */
  point: ContextMenuPoint
  /** The post or row the menu belonged to: it holds the shown 饼干 ID and gets focus back. */
  owner: HTMLElement
}

let request: PickerRequest | null = null
let seq = 0
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
function show(next: PickerRequest | null) {
  request = next
  for (const listener of listeners) listener()
}

/**
 * 饼干颜色… for a context menu about the 饼干 ID `userHash` (a post's, or a thread row's 串主):
 * nothing when the ID is unknown or an admin's. `owner` is the post or row the menu belongs to.
 */
export function cookieColorItems(
  cookie: { userHash: string | null; isAdmin?: boolean | null } | null,
  point: ContextMenuPoint,
  owner: HTMLElement
): ContextMenuItem[] {
  if (cookie === null || cookie.userHash === null || cookie.isAdmin === true) return []
  const valid = validateCookieId(cookie.userHash)
  // The store keys colors by the verbatim ID; one that trimming would change cannot be colored.
  if (!valid.ok || valid.cookieId !== cookie.userHash) return []
  const cookieId = valid.cookieId
  return [{ type: 'action', key: 'cookie-color', label: '饼干颜色…', onSelect: () => show({ seq: ++seq, cookieId, point, owner }) }]
}

/** Shows the palette 饼干颜色… asked for; mounted once in the app shell. */
export function CookieColorPickerHost() {
  const open = useSyncExternalStore(subscribe, () => request)
  useCover(open !== null)
  if (open === null) return null
  return (
    <CookieColorPicker
      key={open.seq}
      request={open}
      onClose={(returnFocus) => {
        if (request === open) show(null)
        if (returnFocus && open.owner.isConnected) open.owner.focus({ preventScroll: true })
      }}
    />
  )
}

/** The shown 饼干 ID inside `owner`, when on screen and not covered. */
function visibleCookieId(owner: HTMLElement, cookieId: string): DOMRect | null {
  const element = owner.querySelector<HTMLElement>(`[data-cookie-id="${CSS.escape(cookieId)}"]`)
  if (element === null) return null
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return null
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null
  const hit = document.elementFromPoint(x, y)
  return hit !== null && element.contains(hit) ? rect : null
}

/**
 * Focus starts on the current choice (默认 for an ID that is not listed). Arrow keys, Home and End
 * move; Enter or Space chooses. Esc, Tab, a press outside, scrolling, resizing or leaving the
 * window closes it like a context menu; `onClose(true)` hands focus back to the post or row. A
 * choice that does not save keeps the palette open with the reason. Choosing 默认 for a listed ID
 * keeps it listed; 设置 › 饼干颜色 removes IDs.
 */
function CookieColorPicker({ request: { cookieId, point, owner }, onClose }: { request: PickerRequest; onClose: (returnFocus: boolean) => void }) {
  const current = useCookieColor(cookieId) ?? null
  const boxRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)

  // Under the 饼干 ID (above it when there is no room below), else at the menu's place; inside the window.
  useLayoutEffect(() => {
    const box = boxRef.current
    if (box === null) return
    if (!box.matches(':popover-open')) box.showPopover()
    const margin = 8
    const gap = 4
    const { width, height } = box.getBoundingClientRect()
    const maxLeft = window.innerWidth - margin - width
    const maxTop = window.innerHeight - margin - height
    const anchor = visibleCookieId(owner, cookieId)
    let left: number
    let top: number
    if (anchor !== null) {
      left = Math.max(margin, Math.min(anchor.left, maxLeft))
      top = anchor.bottom + gap <= maxTop ? anchor.bottom + gap : Math.max(margin, anchor.top - gap - height)
    } else {
      left = point.x > maxLeft ? Math.max(margin, Math.min(point.x - width, maxLeft)) : Math.max(margin, point.x)
      top = point.y > maxTop ? Math.max(margin, Math.min(point.y - height, maxTop)) : Math.max(margin, point.y)
    }
    box.style.left = `${left}px`
    box.style.top = `${top}px`
    box.style.visibility = ''
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]
    ;(items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus({ preventScroll: true })
    // Placed once, when it opens; a later color change keeps it where it is.
  }, [])

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

  const choose = async (color: CookieColorName | null) => {
    if (saving) return
    if (color === current) {
      onClose(true)
      return
    }
    setSaving(true)
    setFailed(false)
    const saved = await setCookieColor(cookieId, color)
    if (saved) {
      onClose(true)
      return
    }
    setSaving(false)
    setFailed(true)
  }

  // Events from a portal still bubble through React to the app shell: the palette keeps its keys.
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
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = entries[(at + 1) % entries.length]
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = entries[(at - 1 + entries.length) % entries.length]
    else if (event.key === 'Home') next = entries[0]
    else if (event.key === 'End') next = entries.at(-1)
    else return
    event.preventDefault()
    next?.focus()
  }

  return createPortal(
    <div
      ref={boxRef}
      className="context-menu cookie-color-picker"
      popover="manual"
      style={{ left: point.x, top: point.y, visibility: 'hidden' }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    >
      <p className="cookie-color-picker-state">
        <CookieId cookieId={cookieId} />
        <span>当前：{cookieColorLabel(current)}</span>
      </p>
      <div ref={menuRef} role="menu" aria-label={`饼干颜色：${cookieId}`} aria-busy={saving || undefined} className="context-menu-items">
        <div role="group" aria-label="颜色" className="cookie-color-picker-swatches">
          {COOKIE_COLOR_CHOICES.map((color) => {
            const on = current === color
            const style = { '--swatch': cookieSwatchFill(color) } as CSSProperties
            const label = cookieColorLabel(color)
            return (
              <button
                key={color ?? 'default'}
                type="button"
                role="menuitemradio"
                aria-checked={on}
                aria-label={label}
                title={label}
                className={color === null ? 'cookie-color-picker-swatch is-default' : 'cookie-color-picker-swatch'}
                style={style}
                tabIndex={-1}
                onClick={() => void choose(color)}
              >
                <span className="cookie-swatch-dot" aria-hidden="true">
                  {on && <Icon name="check" size={12} />}
                </span>
              </button>
            )
          })}
        </div>
      </div>
      <div className="context-menu-footer" role="status">
        {failed && (
          <p className="form-message is-error">
            <Icon name="alert" size={14} />
            <span>颜色未保存，请再选一次</span>
          </p>
        )}
      </div>
    </div>,
    document.body
  )
}
