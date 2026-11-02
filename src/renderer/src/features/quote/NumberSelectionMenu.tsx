import { useContext, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import type { PostId } from '../../../../shared/forum'
import { ContextMenu, contextMenuPoint, isContextMenuKey, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { selectionCopyItem, withSelectionCopy } from '../../components/copyMenuItems'
import { useCover } from '../../lib/appCovered'
import { QuoteActiveContext, QuoteControllerContext, type QuoteController } from './QuoteContext'
import { selectedPostNumber } from './selectionNumber'

/**
 * 预览／打开／在新标签页打开 No.x for a selected whole post number: every one goes through the quote
 * card (`QuoteController.selection`), so nothing opens before it is located and a failure stays on
 * the card. Shared by the post menu and the bodies without a menu of their own.
 */
export function numberActionItems(
  controller: QuoteController,
  entryKey: number,
  number: { postId: PostId; range: Range },
  returnFocus: HTMLElement | null
): ContextMenuItem[] {
  return (['preview', 'navigate', 'new-tab'] as const).map((action) => ({
    type: 'action' as const,
    key: `number-${action}`,
    label: `${action === 'preview' ? '预览' : action === 'navigate' ? '打开' : '在新标签页打开'} No.${number.postId}`,
    onSelect: () => controller.selection({ entryKey, postId: number.postId, range: number.range, returnFocus }, action)
  }))
}

/**
 * The selected-number menu of a content body that has no context menu of its own (a quote card's
 * post, 版规／时间线说明). Spread `areaProps` on the element around the body: it takes focus when text
 * in it is clicked or selected (`tabIndex` −1, never a Tab stop), so the ContextMenu key and
 * Shift+F10 reach it as well as a right click. The menu opens only for a whole valid number selected
 * inside the body; any other right click keeps its default. `previewId` (quote card host) keeps that
 * card while the menu is open. Outside a navigable entry nothing is offered.
 */
export function useNumberSelectionMenu(entryKey: number | null, previewId?: string): {
  areaProps: {
    ref: RefObject<HTMLDivElement | null>
    tabIndex: number
    onContextMenu: (event: MouseEvent<HTMLDivElement>) => void
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void
  }
  menu: ReactNode
} {
  const controller = useContext(QuoteControllerContext)
  const active = useContext(QuoteActiveContext)
  const ref = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ point: ContextMenuPoint; number: { postId: PostId; range: Range }; selection: ContextMenuItem | null } | null>(null)
  useCover(menu !== null)

  const openMenu = (event: MouseEvent<HTMLDivElement> | KeyboardEvent<HTMLDivElement>) => {
    if (controller === null || entryKey === null) return
    const area = event.currentTarget
    const number = selectedPostNumber(area)
    if (number === null) return
    event.preventDefault()
    event.stopPropagation()
    // A card's own body: the card stays (pinned) while its menu is open and the pointer is away.
    if (previewId !== undefined) controller.contextMenu({ entryKey, host: { previewId }, quoteIndex: 0, postId: number.postId })
    setMenu({ point: contextMenuPoint(event, area), number, selection: selectionCopyItem(undefined, area) })
  }

  return {
    areaProps: {
      ref,
      tabIndex: -1,
      onContextMenu: openMenu,
      onKeyDown: (event) => {
        if (event.nativeEvent.isComposing) return
        if (isContextMenuKey(event)) {
          openMenu(event)
          return
        }
        // Tab from the body whose selected number's card is open moves into that card, as from a quote
        // (not inside a card: there Tab already moves through the card).
        if (event.key === 'Tab' && !event.shiftKey && previewId === undefined && event.target === event.currentTarget && controller !== null &&
          entryKey !== null && active?.startsWith(`${entryKey}:selection:`) === true && controller.focusCard()) event.preventDefault()
      }
    },
    menu:
      menu === null || controller === null || entryKey === null ? null : (
        <ContextMenu
          point={menu.point}
          label={`No.${menu.number.postId} 操作`}
          items={withSelectionCopy(menu.selection, numberActionItems(controller, entryKey, menu.number, ref.current))}
          onClose={(restore) => {
            setMenu(null)
            if (restore) ref.current?.focus({ preventScroll: true })
          }}
        />
      )
  }
}
