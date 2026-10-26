import { useState, type KeyboardEvent, type ReactNode } from 'react'

/**
 * 防剧透 segment in a post body. Masked, it is one inline control (click, or Enter / Space while
 * focused, reveals it); the hidden content keeps its place in the line but is not painted, read,
 * selected, found or focused. Revealed, it shows `revealed` (with working quote references) until
 * the post renders anew. The same element stays mounted across the change, so a keyboard reveal
 * keeps focus where it was instead of dropping it to the page.
 */
export function Spoiler({ masked, revealed }: { masked: ReactNode; revealed: ReactNode }) {
  const [shown, setShown] = useState(false)

  if (shown) {
    return (
      <span className="spoiler is-revealed" tabIndex={-1}>
        {revealed}
      </span>
    )
  }

  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    if (event.key !== 'Enter' && event.key !== ' ') return
    // Space would otherwise scroll the reader.
    event.preventDefault()
    setShown(true)
  }

  return (
    <span className="spoiler is-masked is-interactive" role="button" tabIndex={0} aria-label="显示隐藏内容" onClick={() => setShown(true)} onKeyDown={onKeyDown}>
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
