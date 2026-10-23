import { useContext, type KeyboardEvent, type PointerEvent } from 'react'
import type { PostId } from '../../../../shared/forum'
import { QuoteActiveContext, QuoteControllerContext, QuoteEntryContext, quoteKey, type QuoteRefInfo } from './QuoteContext'

/**
 * Quote reference inside a reader post body. Hover (after a short delay) or Space previews the
 * quoted post; click / Enter locates it; Ctrl/Cmd + click / Enter opens it in a background tab.
 * Outside a reader (no controller or entry) it stays static text.
 */
export function QuoteRef({ hostPostId, quoteIndex, postId, raw }: { hostPostId: PostId; quoteIndex: number; postId: PostId; raw: string }) {
  const controller = useContext(QuoteControllerContext)
  const entryKey = useContext(QuoteEntryContext)
  const active = useContext(QuoteActiveContext)
  if (controller === null || entryKey === null) return <span className="quote-ref">{raw}</span>

  const info: QuoteRefInfo = { entryKey, hostPostId, quoteIndex, postId }
  const expanded = active === quoteKey(entryKey, hostPostId, quoteIndex)

  const onPointerEnter = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') controller.pointerEnter(info)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.nativeEvent.isComposing || event.altKey || event.shiftKey) return
    if (event.key === 'Enter') {
      event.preventDefault()
      controller.activate(info, controller.isBackground(event))
    } else if (event.key === ' ' && !event.ctrlKey && !event.metaKey) {
      // Space previews instead of scrolling the reader or activating the button.
      event.preventDefault()
      controller.preview(info)
    } else if (event.key === 'Tab' && expanded && !event.ctrlKey && !event.metaKey) {
      if (controller.focusCard()) event.preventDefault()
    }
  }

  return (
    <button
      type="button"
      className={expanded ? 'quote-ref is-interactive is-active' : 'quote-ref is-interactive'}
      data-quote-entry={entryKey}
      data-quote-host={hostPostId}
      data-quote-index={quoteIndex}
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={`引用 No.${postId}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={() => controller.pointerLeave()}
      onBlur={() => controller.blur()}
      onKeyDown={onKeyDown}
      onKeyUp={(event) => {
        if (event.key === ' ') event.preventDefault()
      }}
      onClick={(event) => {
        // Keyboard activation is handled on keydown; this is the pointer.
        if (event.detail === 0) return
        controller.activate(info, controller.isBackground(event))
      }}
    >
      {raw}
    </button>
  )
}
