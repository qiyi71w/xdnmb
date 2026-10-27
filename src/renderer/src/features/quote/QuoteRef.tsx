import { useContext, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import type { PostId } from '../../../../shared/forum'
import { ContextMenu, contextMenuPoint, isContextMenuKey, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { copyNumberItem, selectionCopyItem, withSelectionCopy } from '../../components/copyMenuItems'
import { useCover } from '../../lib/appCovered'
import { QuoteActiveContext, QuoteControllerContext, QuoteEntryContext, quoteHostId, quoteKey, type QuoteAnchor, type QuoteHost, type QuoteRefInfo } from './QuoteContext'

/**
 * Quote reference inside a post, description or preview. Hover / focus / Space previews the
 * quoted post; click / Enter locates it; Ctrl/Cmd + click / Enter opens it in a new tab and
 * switches to it. Right click, the ContextMenu key or Shift+F10 opens the quote's own menu
 * (在新标签页打开, 复制串号; 复制选中文字 on top while text there is selected), never the menu of
 * the post around it. Outside a navigable entry (no controller or entry) it stays static text.
 */
export function QuoteRef({ host, origin, quoteIndex, postId, raw }: { host: QuoteHost; origin?: QuoteAnchor; quoteIndex: number; postId: PostId; raw: string }) {
  const controller = useContext(QuoteControllerContext)
  const entryKey = useContext(QuoteEntryContext)
  const active = useContext(QuoteActiveContext)
  const buttonRef = useRef<HTMLButtonElement>(null)
  /** Focus going back to the quote from its menu: not a new keyboard visit that previews it. */
  const restoringFocus = useRef(false)
  const [menu, setMenu] = useState<{ point: ContextMenuPoint; selection: ContextMenuItem | null } | null>(null)
  useCover(menu !== null)
  if (controller === null || entryKey === null) return <span className="quote-ref">{raw}</span>

  const hostId = quoteHostId(host)
  const info: QuoteRefInfo = { entryKey, host, origin, quoteIndex, postId }
  const expanded = active === quoteKey(entryKey, hostId, quoteIndex)

  const openMenu = (event: MouseEvent<HTMLButtonElement> | KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    controller.contextMenu(info)
    const body = event.currentTarget.closest('.content-body') ?? event.currentTarget
    setMenu({ point: contextMenuPoint(event, event.currentTarget), selection: selectionCopyItem(undefined, body) })
  }
  const items: ContextMenuItem[] = menu === null ? [] : withSelectionCopy(menu.selection, [
    { type: 'action', key: 'open-new-tab', label: '在新标签页打开', onSelect: () => controller.activate(info, true) },
    copyNumberItem(postId)
  ])

  const onPointerEnter = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') controller.pointerEnter(info)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.nativeEvent.isComposing) return
    if (isContextMenuKey(event)) {
      openMenu(event)
      return
    }
    if (event.altKey || event.shiftKey) return
    if (event.key === 'Enter') {
      event.preventDefault()
      controller.activate(info, controller.isNewTab(event))
    } else if (event.key === ' ' && !event.ctrlKey && !event.metaKey) {
      // Space previews instead of scrolling the reader or activating the button.
      event.preventDefault()
      controller.preview(info)
    } else if (event.key === 'Tab' && expanded && !event.ctrlKey && !event.metaKey) {
      if (controller.focusCard()) event.preventDefault()
    }
  }

  // The menu is the button's sibling: events from its portal bubble through the React tree, and
  // its clicks must not reach the button's own click.
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={expanded ? 'quote-ref is-interactive is-active' : 'quote-ref is-interactive'}
        data-quote-entry={entryKey}
        data-quote-host={hostId}
        data-quote-index={quoteIndex}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-label={`引用 No.${postId}`}
        onPointerEnter={onPointerEnter}
        onPointerLeave={() => controller.pointerLeave()}
        onFocus={(event) => {
          if (!restoringFocus.current && event.currentTarget.matches(':focus-visible')) controller.focus(info)
        }}
        onBlur={() => controller.blur()}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => {
          if (event.key === ' ') event.preventDefault()
        }}
        onContextMenu={openMenu}
        onClick={(event) => {
          // Keyboard activation is handled on keydown; this is the pointer.
          if (event.detail === 0) return
          controller.activate(info, controller.isNewTab(event))
        }}
      >
        {raw}
      </button>
      {menu !== null && (
        <ContextMenu
          point={menu.point}
          label={`引用 No.${postId} 操作`}
          items={items}
          onClose={(restore) => {
            setMenu(null)
            if (!restore) return
            restoringFocus.current = true
            try {
              buttonRef.current?.focus({ preventScroll: true })
            } finally {
              restoringFocus.current = false
            }
          }}
        />
      )}
    </>
  )
}
