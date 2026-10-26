import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject
} from 'react'
import { slotAt, slotIndex } from '../lib/reorder'
import { Icon } from './Icon'
import './sort-handle.css'

/** The pointer moves this far (CSS pixels) before a press on a handle becomes a drag (as on the rail). */
const DRAG_THRESHOLD = 5

interface Press {
  key: string
  pointerId: number
  startY: number
  handle: HTMLElement
  started: boolean
  cancelled: boolean
}

/** The list's rows (`data-sort-key`), as laid out now. */
function rowsOf(list: HTMLUListElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(':scope > [data-sort-key]')]
}

function handleOf(list: HTMLUListElement | null, key: string): HTMLElement | null {
  return list === null ? null : (rowsOf(list).find((row) => row.dataset.sortKey === key)?.querySelector<HTMLElement>('[data-sort-handle]') ?? null)
}

/** Where a drop at `y` puts row `key` (`from` → `to`) and the drop line's offset in the list; `null` when nothing would change. */
function dropAt(list: HTMLUListElement | null, key: string, y: number): { from: number; to: number; top: number } | null {
  if (list === null) return null
  const rows = rowsOf(list)
  const from = rows.findIndex((row) => row.dataset.sortKey === key)
  if (from < 0) return null
  const rects = rows.map((row) => row.getBoundingClientRect())
  const slot = slotAt(rects.map((rect) => rect.top + rect.height / 2), y)
  const to = slotIndex(from, slot, rows.length)
  if (to === null) return null
  const origin = list.getBoundingClientRect().top
  return { from, to, top: (slot < rects.length ? rects[slot]!.top : rects.at(-1)!.bottom) - origin }
}

/** One sortable list: its drag, keyboard moves and announcements. Use with `SortHandle` and `SortStatus`. */
export interface SortableList {
  /** On the `<ul>`; its direct `<li data-sort-key>` rows are the places. */
  listRef: RefObject<HTMLUListElement | null>
  /** `sort-list` plus drag-state classes, for the `<ul>`. */
  listClassName: string
  /** Carries the drop line's offset while dragging. */
  listStyle: CSSProperties | undefined
  /** The row being dragged (marked `is-sort-dragging` by its owner). */
  dragging: string | null
  /** What the polite status says after a move (`第 n 项，共 m 项`); `seq` counts moves, so a repeated text is announced again. */
  status: { text: string; seq: number }
  pointerDown(event: PointerEvent<HTMLElement>, key: string, disabled: boolean): void
  pointerMove(event: PointerEvent<HTMLElement>): void
  pointerUp(event: PointerEvent<HTMLElement>): void
  pointerCancel(event: PointerEvent<HTMLElement>): void
  keyDown(event: KeyboardEvent<HTMLElement>, key: string, disabled: boolean): void
}

/**
 * Sorting a list by its rows' handles. A press on a handle that moves more than 5px drags the row:
 * a line shows where it goes and release calls `onMove(from, to)` once (not when it would stay).
 * Esc, the window losing focus or a cancelled pointer end the drag with the order unchanged.
 * Alt+↑／Alt+↓ on a handle moves its row one place (nothing at either end). After a move, keyboard
 * focus stays on that row's handle, even when the reordered row is moved in the DOM.
 * `keys` are the rows' keys in display order.
 */
export function useSortableList(keys: readonly string[], onMove: (from: number, to: number) => void): SortableList {
  const listRef = useRef<HTMLUListElement>(null)
  const press = useRef<Press | null>(null)
  const lastY = useRef(0)
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropTop, setDropTop] = useState<number | null>(null)
  const [status, setStatus] = useState({ text: '', seq: 0 })
  /** The handle that keeps focus after a move, until focus or a press goes elsewhere. */
  const [focusKey, setFocusKey] = useState<string | null>(null)

  const cancel = useCallback(() => {
    const current = press.current
    if (current !== null) {
      current.cancelled = true
      if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId)
    }
    setDragging(null)
    setDropTop(null)
  }, [])

  useEffect(() => {
    if (dragging === null) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    // A scrolled page moves the rows under a still pointer.
    const onScroll = () => setDropTop(dropAt(listRef.current, dragging, lastY.current)?.top ?? null)
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', cancel)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', cancel)
    }
  }, [dragging, cancel])

  // React moves a reordered row's element, which drops its focus: give it back to the handle.
  useLayoutEffect(() => {
    if (focusKey === null) return
    const handle = handleOf(listRef.current, focusKey)
    const active = document.activeElement
    if (handle !== null && (active === null || active === document.body)) handle.focus()
  })

  useEffect(() => {
    if (focusKey === null) return
    const release = (event: Event) => {
      if (!(event.target instanceof Node) || !handleOf(listRef.current, focusKey)?.contains(event.target)) setFocusKey(null)
    }
    document.addEventListener('focusin', release)
    document.addEventListener('pointerdown', release, true)
    return () => {
      document.removeEventListener('focusin', release)
      document.removeEventListener('pointerdown', release, true)
    }
  }, [focusKey])

  const moved = (key: string, from: number, to: number) => {
    onMove(from, to)
    setFocusKey(key)
    setStatus((previous) => ({ text: `第 ${to + 1} 项，共 ${keys.length} 项`, seq: previous.seq + 1 }))
  }

  const classes = ['sort-list', dragging !== null ? 'is-sorting' : null, dropTop !== null ? 'has-drop' : null]
  return {
    listRef,
    listClassName: classes.filter(Boolean).join(' '),
    listStyle: dropTop === null ? undefined : ({ '--sort-drop': `${dropTop}px` } as CSSProperties),
    dragging,
    status,
    pointerDown(event, key, disabled) {
      if (event.button !== 0 || disabled) {
        press.current = null
        return
      }
      // Captured at once: the handle is small, the pointer leaves it before the threshold.
      event.currentTarget.setPointerCapture(event.pointerId)
      press.current = { key, pointerId: event.pointerId, startY: event.clientY, handle: event.currentTarget, started: false, cancelled: false }
    },
    pointerMove(event) {
      const current = press.current
      if (current === null || current.pointerId !== event.pointerId || current.cancelled) return
      lastY.current = event.clientY
      if (!current.started) {
        if (Math.abs(event.clientY - current.startY) < DRAG_THRESHOLD) return
        current.started = true
        setDragging(current.key)
      }
      setDropTop(dropAt(listRef.current, current.key, event.clientY)?.top ?? null)
    },
    pointerUp(event) {
      const current = press.current
      if (current === null || current.pointerId !== event.pointerId) return
      press.current = null
      if (current.started && !current.cancelled) {
        const drop = dropAt(listRef.current, current.key, event.clientY)
        if (drop !== null) moved(current.key, drop.from, drop.to)
      }
      setDragging(null)
      setDropTop(null)
    },
    pointerCancel(event) {
      if (press.current?.pointerId !== event.pointerId) return
      cancel()
      press.current = null
    },
    keyDown(event, key, disabled) {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      event.stopPropagation()
      if (disabled || dragging !== null) return
      const from = keys.indexOf(key)
      const to = event.key === 'ArrowUp' ? from - 1 : from + 1
      if (from < 0 || to < 0 || to >= keys.length) return
      moved(key, from, to)
    }
  }
}

/**
 * The ≡ handle that sorts its row: drag it, or Alt+↑／Alt+↓ while focused. `disabled` keeps it
 * focusable (`aria-disabled`) while moves are not possible, so keyboard focus is not lost.
 */
export function SortHandle({ sort, itemKey, label, disabled = false }: { sort: SortableList; itemKey: string; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      className={sort.dragging === itemKey ? 'icon-btn sort-handle is-dragging' : 'icon-btn sort-handle'}
      data-sort-handle=""
      aria-label={`拖动排序：${label}`}
      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
      aria-disabled={disabled || undefined}
      title="拖动排序（Alt+↑／Alt+↓）"
      onPointerDown={(event) => sort.pointerDown(event, itemKey, disabled)}
      onPointerMove={sort.pointerMove}
      onPointerUp={sort.pointerUp}
      onPointerCancel={sort.pointerCancel}
      onLostPointerCapture={sort.pointerCancel}
      onKeyDown={(event) => sort.keyDown(event, itemKey, disabled)}
    >
      <Icon name="grip" />
    </button>
  )
}

/** The list's polite status: always mounted; each move adds a new text node, so even a repeated position is announced. */
export function SortStatus({ sort }: { sort: SortableList }) {
  return (
    <div className="visually-hidden" role="status">
      {sort.status.text !== '' && <span key={sort.status.seq}>{sort.status.text}</span>}
    </div>
  )
}
