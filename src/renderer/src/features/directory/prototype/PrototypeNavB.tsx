// PROTOTYPE (throwaway) variant B — 图标栏＋版块栏: a narrow icon rail with the shown features,
// 全部功能 (a grid of every feature, hidden ones included) and 设置; beside it a column of boards only.

import { useMemo, useRef, type CSSProperties } from 'react'
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
  featureInfo,
  featureIsDialog,
  featureLabel,
  featureTitle,
  GridIcon,
  useBoardView,
  type PrototypeNavProps
} from './PrototypeNavParts'
import { FEATURES } from './prototypeStore'

/** Width the rail adds to the navigation column (App widens the column by it). */
export const RAIL_WIDTH = 52

const ALL_KEY = 'all'
const SETTINGS_KEY = 'settings'

export function PrototypeNavB({
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

  const allTriggerRef = useRef<HTMLButtonElement>(null)
  const allPanelRef = useRef<HTMLDivElement>(null)
  const allPopover = usePopover(allTriggerRef, allPanelRef)

  const railIds = useMemo(() => [...shown.map((feature) => feature.id), ALL_KEY, SETTINGS_KEY], [shown])
  const railCurrent = settingsCurrent ? SETTINGS_KEY : features.current
  const rail = useRovingFocus(railIds, railCurrent)

  const boardIds = useMemo(() => boardTreeKeys(view, prefs), [view, prefs])
  const selectedKey = settingsCurrent || selected === null ? null : listKey(selected)
  const boards = useRovingFocus(boardIds, selectedKey)

  return (
    <nav
      ref={panelRef}
      id={id}
      className={variant === 'overlay' ? 'nav proto-nav-b is-overlay' : 'nav proto-nav-b'}
      aria-label="功能与版块"
      style={{ '--nav-t': progress, '--proto-rail': `${RAIL_WIDTH}px` } as CSSProperties}
    >
      <div className="proto-rail" role="toolbar" aria-label="功能" aria-orientation="vertical" onKeyDown={rail.onKeyDown}>
        {shown.map((feature) => {
          const current = features.current === feature.id
          return (
            <button
              key={feature.id}
              type="button"
              className={current ? 'proto-rail-btn is-current' : 'proto-rail-btn'}
              aria-current={current ? 'page' : undefined}
              aria-haspopup={featureIsDialog(feature.id) ? 'dialog' : undefined}
              aria-label={featureLabel(feature.id, features)}
              title={featureTitle(feature.id, features) ?? feature.label}
              onClick={() => features.open(feature.id)}
              {...rail.itemProps(feature.id)}
            >
              <Icon name={feature.icon} size={18} />
              <FeatureDot id={feature.id} host={features} />
            </button>
          )
        })}
        <span className="proto-rail-gap" />
        <button
          ref={allTriggerRef}
          type="button"
          className={allPopover.open ? 'proto-rail-btn is-open' : 'proto-rail-btn'}
          aria-label="全部功能"
          title="全部功能"
          aria-haspopup="true"
          aria-expanded={allPopover.open}
          aria-controls={allPopover.open ? 'proto-b-all' : undefined}
          onClick={allPopover.toggle}
          {...rail.itemProps(ALL_KEY)}
        >
          <GridIcon />
        </button>
        <button
          type="button"
          className={settingsCurrent ? 'proto-rail-btn is-current' : 'proto-rail-btn'}
          aria-current={settingsCurrent ? 'page' : undefined}
          aria-label="设置"
          title="设置"
          onClick={onOpenSettings}
          {...rail.itemProps(SETTINGS_KEY)}
        >
          <Icon name="settings" size={18} />
        </button>
      </div>

      <div className="proto-boards">
        <h2 className="proto-boards-title">版块</h2>
        <div className="nav-scroll" onKeyDown={boards.onKeyDown}>
          <BoardTree
            view={view}
            prefs={prefs}
            selectedKey={selectedKey}
            onSelect={onSelect}
            itemProps={boards.itemProps}
            favoritesTitle="收藏"
          />
          <DirectoryPlaceholder state={state} onRetry={onRetry} empty={all.length === 0} />
        </div>
        <DirectoryStatus state={state} />
      </div>

      {allPopover.open && (
        <div ref={allPanelRef} id="proto-b-all" className="proto-all-panel" role="group" aria-label="全部功能">
          <p className="proto-all-title">全部功能</p>
          <div className="proto-all-grid">
            {FEATURES.map((feature) => {
              const info = featureInfo(feature.id)
              return (
                <button
                  key={feature.id}
                  type="button"
                  className={prefs.hiddenFeatures.includes(feature.id) ? 'proto-all-item is-hidden' : 'proto-all-item'}
                  aria-label={featureLabel(feature.id, features)}
                  onClick={() => {
                    allPopover.close(false)
                    features.open(feature.id)
                  }}
                >
                  <span className="proto-all-icon">
                    <Icon name={info.icon} size={20} />
                    <FeatureDot id={feature.id} host={features} />
                  </span>
                  <span>{info.label}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </nav>
  )
}
