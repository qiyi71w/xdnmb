// PROTOTYPE (throwaway): B's icon rail, shared by every variant: an optional 版块 button on top, the
// shown features, then 全部功能 (every feature, hidden ones included) and 设置 at the bottom.

import { useMemo, useRef, type Ref } from 'react'
import { Icon } from '../../../components/Icon'
import { usePopover } from '../../../lib/usePopover'
import { useRovingFocus } from '../../../lib/useRovingFocus'
import { FeatureDot, featureInfo, featureIsDialog, featureLabel, featureTitle, GridIcon, type FeatureHost } from './PrototypeNavParts'
import { FEATURES, useNavPrefs } from './prototypeStore'

/** Width of the rail, CSS pixels (App widens the navigation column by it). */
export const RAIL_WIDTH = 52

const BOARDS_KEY = 'boards'
const ALL_KEY = 'all'
const SETTINGS_KEY = 'settings'

/** The 版块 button on top of the rail (D, F). */
export interface RailBoards {
  label: string
  buttonRef?: Ref<HTMLButtonElement>
  /** Opens a popup panel; `expanded` tells whether it is open. */
  popup: { expanded: boolean; controls: string } | null
  /** Tinted while what it controls is shown (F: the column); the label says what a click does. */
  active?: boolean
  onClick: (button: HTMLButtonElement) => void
}

export function PrototypeRail({
  features,
  settingsCurrent,
  onOpenSettings,
  boards = null
}: {
  features: FeatureHost
  settingsCurrent: boolean
  onOpenSettings: () => void
  boards?: RailBoards | null
}) {
  const prefs = useNavPrefs()
  const shown = useMemo(() => FEATURES.filter((feature) => !prefs.hiddenFeatures.includes(feature.id)), [prefs.hiddenFeatures])

  const allTriggerRef = useRef<HTMLButtonElement>(null)
  const allPanelRef = useRef<HTMLDivElement>(null)
  const allPopover = usePopover(allTriggerRef, allPanelRef)

  const hasBoards = boards !== null
  const railIds = useMemo(
    () => [...(hasBoards ? [BOARDS_KEY] : []), ...shown.map((feature) => feature.id), ALL_KEY, SETTINGS_KEY],
    [hasBoards, shown]
  )
  const railCurrent = settingsCurrent ? SETTINGS_KEY : features.current
  const rail = useRovingFocus(railIds, railCurrent)

  return (
    <>
      <div className="proto-rail" role="toolbar" aria-label="功能" aria-orientation="vertical" onKeyDown={rail.onKeyDown}>
        {boards !== null && (
          <>
            <button
              ref={boards.buttonRef}
              type="button"
              className={[
                'proto-rail-btn',
                boards.popup?.expanded === true ? 'is-open' : '',
                boards.active === true ? 'is-active' : ''
              ]
                .filter(Boolean)
                .join(' ')}
              aria-label={boards.label}
              title={boards.label}
              aria-haspopup={boards.popup === null ? undefined : 'dialog'}
              aria-expanded={boards.popup === null ? undefined : boards.popup.expanded}
              aria-controls={boards.popup?.expanded === true ? boards.popup.controls : undefined}
              data-proto-boards-trigger=""
              onClick={(event) => boards.onClick(event.currentTarget)}
              {...rail.itemProps(BOARDS_KEY)}
            >
              <Icon name="forum" size={18} />
            </button>
            <span className="proto-rail-sep" aria-hidden="true" />
          </>
        )}
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
          aria-haspopup="dialog"
          aria-expanded={allPopover.open}
          aria-controls={allPopover.open ? 'proto-all' : undefined}
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
          data-proto-settings=""
          title="设置"
          onClick={onOpenSettings}
          {...rail.itemProps(SETTINGS_KEY)}
        >
          <Icon name="settings" size={18} />
        </button>
      </div>

      {allPopover.open && (
        <div ref={allPanelRef} id="proto-all" className="proto-pop proto-all-panel" role="dialog" aria-label="全部功能">
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
                    // A dialog takes focus and later returns it to its opener: leave that on 全部功能.
                    // A list replaces this panel's place: it takes focus itself.
                    if (featureIsDialog(feature.id)) {
                      allPopover.close()
                      features.open(feature.id)
                    } else {
                      allPopover.close(false)
                      features.open(feature.id, true)
                    }
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
    </>
  )
}
