// The navigation: the icon rail, with the favorite boards under its 版块 button. That button
// (and the board name at the top of a board list) opens a wide panel beside the rail: a filter with
// 关闭 beside it, 收藏, then every group laid out in columns. Choosing a board closes it.
// The panel is not modal: Esc, 关闭 or a press outside cancels it (focus back to its opener), Tab
// leaving it closes it and leaves focus where it went; `closeBoardPanel` alone decides focus.

import { useEffect, useLayoutEffect, useRef, type CSSProperties, type FocusEvent } from 'react'
import { Icon } from '../../components/Icon'
import { openLayer } from '../../lib/layers'
import { listKey, type ListRef } from '../tabs/tabsState'
import { BoardPicker } from './BoardPicker'
import { DirectoryPlaceholder, DirectoryStatus, useBoardView, type NavProps } from './navParts'
import { Rail, RAIL_WIDTH } from './Rail'
import { BOARD_PANEL_ID, closeBoardPanel, openBoardPanel, useBoardPanelOpen } from './navStore'

export function RailNavigation({
  state,
  selected,
  onSelect,
  onRetry,
  features,
  settingsCurrent,
  onOpenSettings,
  variant,
  panelRef,
  id
}: NavProps) {
  const open = useBoardPanelOpen()
  const selectedKey = settingsCurrent || selected === null ? null : listKey(selected)
  const { view } = useBoardView(state.directory)

  return (
    <nav
      ref={panelRef}
      id={id}
      className={variant === 'overlay' ? 'nav shell-nav is-overlay' : 'nav shell-nav'}
      aria-label="功能与版块"
      style={{ '--shell-rail': `${RAIL_WIDTH}px` } as CSSProperties}
    >
      <Rail
        features={features}
        settingsCurrent={settingsCurrent}
        onOpenSettings={onOpenSettings}
        boards={{
          popup: { expanded: open, controls: BOARD_PANEL_ID },
          onClick: (button) => (open ? closeBoardPanel('cancel') : openBoardPanel(button))
        }}
        favorites={{
          boards: view.favorites,
          selectedKey,
          onSelect: (ref) => {
            closeBoardPanel('dismiss')
            onSelect(ref)
          }
        }}
      />
      {open && <BoardPanel state={state} selectedKey={selectedKey} onSelect={onSelect} onRetry={onRetry} />}
    </nav>
  )
}

function BoardPanel({
  state,
  selectedKey,
  onSelect,
  onRetry
}: {
  state: NavProps['state']
  selectedKey: string | null
  onSelect: (ref: ListRef) => void
  onRetry: () => void
}) {
  const { all, view, hidden } = useBoardView(state.directory)
  const panelRef = useRef<HTMLDivElement>(null)
  /** A pointer press is under way: the press handler below owns closing, not focus moving out. */
  const pressing = useRef(false)

  useLayoutEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus()
  }, [])

  // Esc (when on top) and a press outside cancel it; the triggers toggle it themselves.
  useEffect(() => {
    const layer = openLayer()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented || !layer.isTop()) return
      event.preventDefault()
      event.stopPropagation()
      closeBoardPanel('cancel')
    }
    // On window, so it runs before a holding overlay's own document handler sees the same press.
    const onPointerDown = (event: PointerEvent) => {
      pressing.current = true
      setTimeout(() => (pressing.current = false))
      const target = event.target as Element | null
      if (target === null || panelRef.current?.contains(target) || target.closest('[data-boards-trigger], [data-rail-board]') !== null) return
      closeBoardPanel('cancel', target)
    }
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      layer.release()
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [])

  // Not modal: focus leaving the panel by keyboard (Tab, Shift+Tab) closes it and stays where it went,
  // so nothing the panel covered can hold focus unseen. Focus going nowhere (window switch) keeps it.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget
    if (pressing.current || !(next instanceof Element) || event.currentTarget.contains(next)) return
    closeBoardPanel('leave', next)
  }

  // Closing first ends the transaction (and a holding overlay) before the list changes; the new
  // list's board name then takes focus.
  const choose = (ref: ListRef) => {
    closeBoardPanel('select')
    onSelect(ref)
  }

  return (
    <div ref={panelRef} id={BOARD_PANEL_ID} className="shell-pop shell-board-panel" role="dialog" aria-label="版块" onBlur={onBlur}>
      <BoardPicker
        view={view}
        hidden={hidden}
        selectedKey={selectedKey}
        onSelect={choose}
        onClose={() => closeBoardPanel('cancel')}
        placeholder={
          state.directory === null || all.length === 0 ? <DirectoryPlaceholder state={state} onRetry={onRetry} empty={all.length === 0} /> : undefined
        }
      />
      <DirectoryStatus state={state} onRetry={onRetry} />
    </div>
  )
}

/** The board name at the top of a board list: opens (or closes) the board panel. */
export function BoardPanelTitle({ name, onOpen }: { name: string; onOpen: (button: HTMLButtonElement) => void }) {
  const open = useBoardPanelOpen()
  return (
    <button
      type="button"
      className="shell-list-title-btn"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? BOARD_PANEL_ID : undefined}
      title="切换版块"
      data-board-title=""
      data-boards-trigger=""
      onClick={(event) => (open ? closeBoardPanel('cancel') : onOpen(event.currentTarget))}
    >
      <span>{name}</span>
      <Icon name="chevron" size={14} className="shell-list-title-chevron" />
    </button>
  )
}

/** A tab without a list (or whose board left the directory): the way to the boards. */
export function BoardPanelEmptyPage({ title = '选择版块', onOpen }: { title?: string; onOpen: (button: HTMLButtonElement) => void }) {
  const open = useBoardPanelOpen()
  return (
    <div className="pane-empty">
      <p className="pane-empty-title">{title}</p>
      <button
        type="button"
        className="btn btn-page pane-empty-action"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? BOARD_PANEL_ID : undefined}
        data-boards-trigger=""
        onClick={(event) => (open ? closeBoardPanel('cancel') : onOpen(event.currentTarget))}
      >
        <Icon name="forum" />
        全部版块
      </button>
    </div>
  )
}
