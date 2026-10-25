// PROTOTYPE (throwaway) variant C — 版块优先＋命令入口: the navigation is boards first (收藏 and
// the board tree). One compact row on top holds the shown features; every feature, hidden ones
// included, is reached from the … menu beside them and from the Ctrl/Cmd+K command palette.

import { useMemo, useRef, type CSSProperties, type KeyboardEvent } from 'react'
import { Icon } from '../../../components/Icon'
import { usePopover } from '../../../lib/usePopover'
import { useRovingFocus } from '../../../lib/useRovingFocus'
import { listKey } from '../../tabs/tabsState'
import { DirectoryStatus } from '../Navigation'
import {
  BoardTree,
  boardTreeKeys,
  DirectoryPlaceholder,
  FeatureDot,
  featureIsDialog,
  featureLabel,
  featureTitle,
  FeatureRow,
  MoreIcon,
  useBoardView,
  type PrototypeNavProps
} from './PrototypeNavParts'
import { FEATURES, setPaletteOpen } from './prototypeStore'

const MORE_KEY = 'more'

export function PrototypeNavC({
  state,
  selected,
  onSelect,
  onRetry,
  features,
  settingsCurrent,
  onOpenSettings,
  variant,
  progress,
  panelRef,
  id
}: PrototypeNavProps) {
  const { prefs, all, view } = useBoardView(state.directory)
  const shown = useMemo(() => FEATURES.filter((feature) => !prefs.hiddenFeatures.includes(feature.id)), [prefs.hiddenFeatures])

  const moreTriggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menu = usePopover(moreTriggerRef, menuRef)

  const rowIds = useMemo(() => [...shown.map((feature) => feature.id), MORE_KEY], [shown])
  const row = useRovingFocus(rowIds, features.current)
  const menuIds = useMemo(() => [...FEATURES.map((feature) => feature.id), 'settings', 'palette'], [])
  const menuRoving = useRovingFocus(menuIds, null)

  const boardIds = useMemo(() => boardTreeKeys(view, prefs), [view, prefs])
  const selectedKey = settingsCurrent || selected === null ? null : listKey(selected)
  const boards = useRovingFocus(boardIds, selectedKey)

  const run = (action: () => void) => {
    menu.close(false)
    action()
  }

  return (
    <nav
      ref={panelRef}
      id={id}
      className={variant === 'overlay' ? 'nav proto-nav-c is-overlay' : 'nav proto-nav-c'}
      aria-label="版块与功能"
      style={{ '--nav-t': progress } as CSSProperties}
    >
      <div className="proto-c-head">
        <button type="button" className="proto-c-command" aria-haspopup="dialog" onClick={() => setPaletteOpen(true)}>
          <Icon name="search" size={14} />
          <span className="proto-c-command-label">跳转到…</span>
          {features.commandShortcut !== '' && <kbd className="proto-kbd">{features.commandShortcut}</kbd>}
        </button>
        <div className="proto-c-features" role="toolbar" aria-label="功能" onKeyDown={onRowKeyDown(row.onKeyDown)}>
          {shown.map((feature) => {
            const current = features.current === feature.id
            return (
              <button
                key={feature.id}
                type="button"
                className={current ? 'proto-c-feature is-current' : 'proto-c-feature'}
                aria-current={current ? 'page' : undefined}
                aria-haspopup={featureIsDialog(feature.id) ? 'dialog' : undefined}
                aria-label={featureLabel(feature.id, features)}
                title={featureTitle(feature.id, features) ?? feature.label}
                onClick={() => features.open(feature.id)}
                {...row.itemProps(feature.id)}
              >
                <Icon name={feature.icon} />
                <FeatureDot id={feature.id} host={features} />
              </button>
            )
          })}
          <button
            ref={moreTriggerRef}
            type="button"
            className={menu.open ? 'proto-c-feature is-open' : 'proto-c-feature'}
            aria-label="全部功能"
            title="全部功能"
            aria-haspopup="menu"
            aria-expanded={menu.open}
            aria-controls={menu.open ? 'proto-c-menu' : undefined}
            onClick={menu.toggle}
            {...row.itemProps(MORE_KEY)}
          >
            <MoreIcon />
          </button>
        </div>
        {menu.open && (
          <div ref={menuRef} id="proto-c-menu" className="proto-c-menu" role="menu" aria-label="全部功能" onKeyDown={menuRoving.onKeyDown}>
            {FEATURES.map((feature) => (
              <FeatureRow
                key={feature.id}
                id={feature.id}
                host={{ ...features, open: (featureId) => run(() => features.open(featureId)), current: null }}
                itemProps={menuRoving.itemProps(feature.id)}
                className="proto-menu-item"
                role="menuitem"
              />
            ))}
            <hr className="proto-menu-sep" role="separator" />
            <button
              type="button"
              role="menuitem"
              className="nav-item proto-menu-item"
              onClick={() => run(onOpenSettings)}
              {...menuRoving.itemProps('settings')}
            >
              <Icon name="settings" className="nav-item-icon" />
              <span className="nav-item-label">设置</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="nav-item proto-menu-item"
              aria-haspopup="dialog"
              onClick={() => run(() => setPaletteOpen(true))}
              {...menuRoving.itemProps('palette')}
            >
              <Icon name="search" className="nav-item-icon" />
              <span className="nav-item-label">跳转到…</span>
              {features.commandShortcut !== '' && <kbd className="proto-kbd">{features.commandShortcut}</kbd>}
            </button>
          </div>
        )}
      </div>

      <div className="nav-scroll" onKeyDown={boards.onKeyDown}>
        <BoardTree view={view} prefs={prefs} selectedKey={selectedKey} onSelect={onSelect} itemProps={boards.itemProps} favoritesTitle="收藏" />
        <DirectoryPlaceholder state={state} onRetry={onRetry} empty={all.length === 0} />
      </div>
      <DirectoryStatus state={state} />
    </nav>
  )
}

/** The feature row is horizontal: ←/→ move like ↓/↑ (and are not taken by the variant switcher). */
function onRowKeyDown(vertical: (event: KeyboardEvent<HTMLElement>) => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-roving-item]'))
      const index = items.findIndex((item) => item === document.activeElement)
      if (index < 0) return
      event.preventDefault()
      const next = event.key === 'ArrowRight' ? Math.min(index + 1, items.length - 1) : Math.max(index - 1, 0)
      items[next]?.focus()
      return
    }
    vertical(event)
  }
}
