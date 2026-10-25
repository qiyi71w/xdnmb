import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import type { Post, ThreadId } from '../../../../shared/forum'
import { ContextMenu, contextMenuPoint, isContextMenuKey, type ContextMenuPoint } from '../../components/ContextMenu'
import { useOpenThreadInTab } from './openThreadInTab'

export interface ThreadRowHandlers {
  onContextMenu?: (event: MouseEvent<HTMLElement>) => void
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void
  onMouseDown?: (event: MouseEvent<HTMLElement>) => void
  onAuxClick?: (event: MouseEvent<HTMLElement>) => void
}

export interface ThreadTabMenu {
  /**
   * Spread on the focusable row of `threadId`: right-click / ContextMenu / Shift+F10 menu and
   * middle-click. Empty for an unknown thread (`null`) or outside the app shell.
   */
  rowProps: (threadId: ThreadId | null, head?: Post | null) => ThreadRowHandlers
  /** Call first in the row's click handler: true when Ctrl/Cmd+click opened the thread in a new tab. */
  openFromClick: (event: MouseEvent, threadId: ThreadId | null, head?: Post | null) => boolean
  /**
   * The open menu (portal), or null. Render it outside the row: clicks in a portal still bubble
   * through React to the row's own handlers.
   */
  menu: ReactNode
}

/**
 * 在新标签页打开 for the thread rows of one list: one context menu at a time (right-click,
 * ContextMenu key, Shift+F10 on the focused row), middle-click and Ctrl/Cmd+click. Closing the
 * menu returns focus to its row.
 */
export function useThreadTabMenu(): ThreadTabMenu {
  const openInTab = useOpenThreadInTab()
  const [open, setOpen] = useState<{ threadId: ThreadId; head: Post | null; point: ContextMenuPoint; row: HTMLElement } | null>(null)

  const close = (returnFocus: boolean) => {
    const row = open?.row
    setOpen(null)
    if (returnFocus && row?.isConnected === true) row.focus()
  }

  return {
    rowProps: (threadId, head = null) => {
      if (openInTab === null || threadId === null) return {}
      const show = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
        event.preventDefault()
        const row = event.currentTarget
        // No scrolling into view: a scroll closes the menu that is about to open.
        row.focus({ preventScroll: true })
        setOpen({ threadId, head, point: contextMenuPoint(event, row), row })
      }
      return {
        onContextMenu: show,
        onKeyDown: (event) => {
          if (isContextMenuKey(event)) show(event)
        },
        // Middle press: no autoscroll; the release opens the tab.
        onMouseDown: (event) => {
          if (event.button === 1) event.preventDefault()
        },
        onAuxClick: (event) => {
          if (event.button !== 1) return
          event.preventDefault()
          openInTab(threadId, head)
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
      open === null || openInTab === null ? null : (
        <ContextMenu
          point={open.point}
          label={`串操作：No.${open.threadId}`}
          items={[{ type: 'action', key: 'open-in-tab', label: '在新标签页打开', onSelect: () => openInTab(open.threadId, open.head) }]}
          onClose={close}
        />
      )
  }
}
