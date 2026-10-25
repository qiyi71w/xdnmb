// PROTOTYPE (throwaway) variant D — 版块浮层: no board column. The navigation is the icon rail only;
// its 版块 button (and the board name at the top of a board list) opens a wide panel beside the rail:
// a filter, 收藏, then every group laid out in columns. Choosing a board closes it. The panel is not
// modal: Esc or a press outside cancels it (focus back to its opener), Tab leaving it closes it and
// leaves focus where it went; prototypeStore's `closeBoardPanel` is the one place focus is decided.

import { useEffect, useLayoutEffect, useRef, type CSSProperties, type FocusEvent } from 'react'
import { Icon } from '../../../components/Icon'
import { openLayer } from '../../../lib/layers'
import { listKey, type ListRef } from '../../tabs/tabsState'
import { DirectoryStatus } from '../Navigation'
import { BoardPicker } from './PrototypeBoardPicker'
import { DirectoryPlaceholder, useBoardView, type PrototypeNavProps } from './PrototypeNavParts'
import { PrototypeRail, RAIL_WIDTH } from './PrototypeRail'
import { BOARD_PANEL_ID, closeBoardPanel, openBoardPanel, useBoardPanelOpen } from './prototypeStore'

export function PrototypeNavD({
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
}: PrototypeNavProps) {
  const open = useBoardPanelOpen()
  const selectedKey = settingsCurrent || selected === null ? null : listKey(selected)

  return (
    <nav
      ref={panelRef}
      id={id}
      className={variant === 'overlay' ? 'nav proto-nav proto-nav-d is-overlay' : 'nav proto-nav proto-nav-d'}
      aria-label="功能与版块"
      style={{ '--proto-rail': `${RAIL_WIDTH}px` } as CSSProperties}
    >
      <PrototypeRail
        features={features}
        settingsCurrent={settingsCurrent}
        onOpenSettings={onOpenSettings}
        boards={{
          label: '版块',
          popup: { expanded: open, controls: BOARD_PANEL_ID },
          onClick: (button) => (open ? closeBoardPanel('cancel') : openBoardPanel(button))
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
  state: PrototypeNavProps['state']
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
      if (target === null || panelRef.current?.contains(target) || target.closest('[data-proto-boards-trigger]') !== null) return
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
    <div ref={panelRef} id={BOARD_PANEL_ID} className="proto-pop proto-board-panel" role="dialog" aria-label="版块" onBlur={onBlur}>
      <BoardPicker
        view={view}
        hidden={hidden}
        selectedKey={selectedKey}
        onSelect={choose}
        shape="columns"
        autoFocus
        placeholder={
          state.directory === null || all.length === 0 ? <DirectoryPlaceholder state={state} onRetry={onRetry} empty={all.length === 0} /> : undefined
        }
      />
      <DirectoryStatus state={state} />
    </div>
  )
}

/** The board name at the top of a board list: opens (or closes) the board panel. */
export function BoardPanelTitle({ name, onOpen }: { name: string; onOpen: (button: HTMLButtonElement) => void }) {
  const open = useBoardPanelOpen()
  return (
    <button
      type="button"
      className="proto-list-title-btn"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? BOARD_PANEL_ID : undefined}
      title="切换版块"
      data-proto-board-title=""
      data-proto-boards-trigger=""
      onClick={(event) => (open ? closeBoardPanel('cancel') : onOpen(event.currentTarget))}
    >
      <span>{name}</span>
      <Icon name="chevron" size={14} className="proto-list-title-chevron" />
    </button>
  )
}

/** A tab without a list: the way to the boards. */
export function BoardPanelEmptyPage({ onOpen }: { onOpen: (button: HTMLButtonElement) => void }) {
  const open = useBoardPanelOpen()
  return (
    <div className="pane-empty">
      <p className="pane-empty-title">选择版块</p>
      <button
        type="button"
        className="btn pane-empty-action"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? BOARD_PANEL_ID : undefined}
        data-proto-boards-trigger=""
        onClick={(event) => (open ? closeBoardPanel('cancel') : onOpen(event.currentTarget))}
      >
        <Icon name="forum" />
        全部版块
      </button>
    </div>
  )
}
