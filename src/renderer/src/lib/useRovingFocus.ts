import { useCallback, useState, type KeyboardEvent } from 'react'

const ITEM_SELECTOR = '[data-roving-item]'

/**
 * Single tab stop for a list of buttons; arrow keys, Home and End move focus between them.
 * The tab stop follows focus, then the current selection, then the first item.
 */
export function useRovingFocus(ids: readonly string[], currentId: string | null) {
  const [focusedId, setFocusedId] = useState<string | null>(null)

  const tabStopId =
    focusedId !== null && ids.includes(focusedId)
      ? focusedId
      : currentId !== null && ids.includes(currentId)
        ? currentId
        : (ids[0] ?? null)

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const { key } = event
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(ITEM_SELECTOR))
    const active = document.activeElement
    const index = items.findIndex((item) => item === active)
    if (index < 0 || items.length === 0) return
    event.preventDefault()
    const next =
      key === 'Home' ? 0 : key === 'End' ? items.length - 1 : key === 'ArrowDown' ? Math.min(index + 1, items.length - 1) : Math.max(index - 1, 0)
    items[next]?.focus()
  }, [])

  return {
    onKeyDown,
    itemProps: (id: string) => ({
      'data-roving-item': '',
      tabIndex: id === tabStopId ? 0 : -1,
      onFocus: () => setFocusedId(id)
    })
  }
}
