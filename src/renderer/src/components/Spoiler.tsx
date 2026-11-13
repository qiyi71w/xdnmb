import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'

/** Enter or Space without modifiers or composition: the key that toggles a spoiler. */
function isToggleKey(event: KeyboardEvent<HTMLSpanElement>): boolean {
  if (event.nativeEvent.isComposing || event.keyCode === 229) return false
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
  return event.key === 'Enter' || event.key === ' '
}

/**
 * 防剧透 segment in a post body. Masked, it is one inline control (click, or Enter / Space while
 * focused, reveals it); the hidden content keeps its place in the line but is not painted, read,
 * selected, found or focused. Revealed, it shows `revealed` (with working quote references); a
 * click on its text (not on a link or reference inside, nor one that ends a text selection) hides
 * it again, as do Enter / Space while it still holds focus after a keyboard reveal. The same
 * element stays mounted across each change, so focus stays where it was instead of dropping to
 * the page. A change between masked and revealed is immediate: only the hover tint fades, so the
 * words never sit on a fading bar and the bar never fades in over words already gone.
 */
export function Spoiler({ masked, revealed }: { masked: ReactNode; revealed: ReactNode }) {
  const [shown, setShown] = useState(false)
  // Set by a change, cleared when the pointer next enters or leaves: until then nothing fades.
  const [switched, setSwitched] = useState(false)
  const toggle = (next: boolean) => {
    setShown(next)
    setSwitched(true)
  }
  const pointer = {
    onPointerEnter: () => setSwitched(false),
    onPointerLeave: () => setSwitched(false)
  }
  const switchedClass = switched ? ' is-switched' : ''

  if (shown) {
    const onClick = (event: MouseEvent<HTMLSpanElement>) => {
      const target = event.target instanceof Element ? event.target : null
      const control = target?.closest('a, button, [role="button"], [role="link"]')
      if (control != null && control !== event.currentTarget && event.currentTarget.contains(control)) return
      // A click that ends a text selection inside must not hide it.
      const selection = window.getSelection()
      if (selection !== null && !selection.isCollapsed && selection.rangeCount > 0 && selection.getRangeAt(0).intersectsNode(event.currentTarget)) return
      toggle(false)
    }
    const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
      if (event.target !== event.currentTarget || !isToggleKey(event)) return
      event.preventDefault()
      toggle(false)
    }
    return (
      <span className={`spoiler is-revealed${switchedClass}`} tabIndex={-1} onClick={onClick} onKeyDown={onKeyDown} {...pointer}>
        {revealed}
      </span>
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (!isToggleKey(event)) return
    // Space would otherwise scroll the reader.
    event.preventDefault()
    toggle(true)
  }

  return (
    <span
      className={`spoiler is-masked is-interactive${switchedClass}`}
      role="button"
      tabIndex={0}
      aria-label="显示隐藏内容"
      onClick={() => toggle(true)}
      onKeyDown={onKeyDown}
      {...pointer}
    >
      <SpoilerContent>{masked}</SpoilerContent>
    </span>
  )
}

/**
 * 防剧透 segment in an excerpt (inside a list row's button): the same mask, never interactive.
 * Its name tells assistive technology that something is hidden there.
 */
export function SpoilerPlaceholder({ masked }: { masked: ReactNode }) {
  return (
    <span className="spoiler is-masked">
      <span className="visually-hidden">隐藏内容</span>
      <SpoilerContent>{masked}</SpoilerContent>
    </span>
  )
}

/** Holds the hidden content's space in the line; nothing inside can be seen, read or reached. */
function SpoilerContent({ children }: { children: ReactNode }) {
  return (
    <span className="spoiler-content" aria-hidden="true" inert>
      {children}
    </span>
  )
}
