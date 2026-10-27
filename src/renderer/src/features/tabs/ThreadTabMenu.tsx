import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { Post, ThreadId } from '../../../../shared/forum'
import { ContextMenu, contextMenuPoint, isContextMenuKey, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { copyNumberItem, selectionCopyItem, withSelectionCopy } from '../../components/copyMenuItems'
import { cookieColorItems } from '../cookieColors/CookieColorPicker'
import { useOpenThreadInTab } from './openThreadInTab'

export interface ThreadRowHandlers {
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
  onMouseDown?: (event: MouseEvent<HTMLElement>) => void
  onAuxClick?: (event: MouseEvent<HTMLElement>) => void
}

export interface ThreadTabMenu {
  /**
   * Spread on the row of `threadId`: right-click / ContextMenu / Shift+F10 menu and middle-click.
   * The row is the focusable item itself, or a container holding it (`[data-roving-item]`) beside
   * other controls; the menu focuses and returns to that item. Empty for an unknown thread (`null`);
   * no new-tab gestures outside the app shell or when not `openable` (the number is known but the
   * thread cannot be opened yet: 复制串号 only).
   */
  rowProps: (threadId: ThreadId | null, head?: Post | null, openable?: boolean) => ThreadRowHandlers
  /** Call first in the row's click handler: true when Ctrl/Cmd+click opened the thread in a new tab. */
  openFromClick: (event: MouseEvent, threadId: ThreadId | null, head?: Post | null) => boolean
  /**
   * The open menu (portal), or null. Render it outside the row: clicks in a portal still bubble
   * through React to the row's own handlers.
   */
  menu: ReactNode
}

/**
 * Gestures of a list row (`li`) whose own context menu holds its actions: right-click and the
 * ContextMenu key / Shift+F10 call `openMenu`; middle-click and Ctrl/Cmd+click call `openInTab`
 * (`null`: the row has no new-tab variant) instead of the row's click.
 */
export function listRowGestures(
  openMenu: (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => void,
  openInTab: (() => void) | null
): ThreadRowHandlers & { onClickCapture: (event: MouseEvent<HTMLElement>) => void } {
  return {
    onContextMenu: openMenu,
    onKeyDown: (event) => {
      if (isContextMenuKey(event)) openMenu(event)
    },
    onClickCapture: (event) => {
      if (openInTab === null || (!event.ctrlKey && !event.metaKey)) return
      event.preventDefault()
      event.stopPropagation()
      openInTab()
    },
    // Middle press: no autoscroll; the release opens the tab.
    onMouseDown: (event) => {
      if (openInTab !== null && event.button === 1) event.preventDefault()
    },
    onAuxClick: (event) => {
      if (openInTab === null || event.button !== 1) return
      event.preventDefault()
      openInTab()
    }
  }
}

/**
 * 在新标签页打开 and 复制串号 for the thread rows of one list: one context menu at a time
 * (right-click, ContextMenu key, Shift+F10 on the focused row; 复制选中文字 on top while text in
 * the row is selected), middle-click and Ctrl/Cmd+click. Closing the menu returns focus to its row.
 * With `cookieColor` (rows that show the head post's 饼干 ID), 饼干颜色… for the 串主's ID follows.
 */
export function useThreadTabMenu({ cookieColor = false }: { cookieColor?: boolean } = {}): ThreadTabMenu {
  const openInTab = useOpenThreadInTab()
  const [open, setOpen] = useState<{ threadId: ThreadId; head: Post | null; openable: boolean; point: ContextMenuPoint; row: HTMLElement; selection: ContextMenuItem | null } | null>(null)

  const close = (returnFocus: boolean) => {
    const row = open?.row
    setOpen(null)
    if (returnFocus && row?.isConnected === true) row.focus()
  }

  return {
    rowProps: (threadId, head = null, openable = true) => {
      if (threadId === null) return {}
      const inTab = openable ? openInTab : null
      const show = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
        event.preventDefault()
        const owner = event.currentTarget
        const row = owner.matches('[data-roving-item]') ? owner : (owner.querySelector<HTMLElement>('[data-roving-item]') ?? owner)
        const selection = selectionCopyItem(undefined, owner)
        // No scrolling into view: a scroll closes the menu that is about to open.
        row.focus({ preventScroll: true })
        setOpen({ threadId, head, openable, point: contextMenuPoint(event, row), row, selection })
      }
      return {
        onContextMenu: show,
        onKeyDown: (event) => {
          if (isContextMenuKey(event)) show(event)
        },
        // Middle press: no autoscroll; the release opens the tab.
        onMouseDown: (event) => {
          if (inTab !== null && event.button === 1) event.preventDefault()
        },
        onAuxClick: (event) => {
          if (inTab === null || event.button !== 1) return
          event.preventDefault()
          inTab(threadId, head)
        }
      }
    },
    openFromClick: (event, threadId, head = null) => {
      if (openInTab === null || threadId === null || (!event.ctrlKey && !event.metaKey)) return false
      event.preventDefault()
      openInTab(threadId, head)
      return true
    },
    menu:
      open === null ? null : (
        <ContextMenu
          point={open.point}
          label={`串操作：No.${open.threadId}`}
          items={withSelectionCopy(open.selection, [
            ...(openInTab === null || !open.openable ? [] : [{ type: 'action', key: 'open-in-tab', label: '在新标签页打开', onSelect: () => openInTab(open.threadId, open.head) } satisfies ContextMenuItem]),
            copyNumberItem(open.threadId),
            ...(cookieColor ? cookieColorItems(open.head, open.point, open.row) : [])
          ])}
          onClose={close}
        />
      )
  }
}
