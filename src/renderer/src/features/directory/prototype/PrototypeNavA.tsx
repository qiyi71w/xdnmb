// PROTOTYPE (throwaway) variant A — 单栏分组: one column, top to bottom 收藏版块 → 功能 → board
// groups. Hidden features sit behind 更多 at the end of 功能. 设置 is the last row and opens as a tab.

import { useMemo, useState, type CSSProperties } from 'react'
import { Icon } from '../../../components/Icon'
import { useRovingFocus } from '../../../lib/useRovingFocus'
import { listKey } from '../../tabs/tabsState'
import { DirectoryStatus } from '../Navigation'
import { BoardTree, boardTreeKeys, DirectoryPlaceholder, FeatureRow, MoreIcon, useBoardView, type PrototypeNavProps } from './PrototypeNavParts'
import { FEATURES } from './prototypeStore'

const MORE_KEY = 'more'
const SETTINGS_KEY = 'settings'
const featureKey = (id: string) => `feature:${id}`

export function PrototypeNavA({
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
  const [moreOpen, setMoreOpen] = useState(false)
  const shown = useMemo(() => FEATURES.filter((feature) => !prefs.hiddenFeatures.includes(feature.id)), [prefs.hiddenFeatures])
  const hidden = useMemo(() => FEATURES.filter((feature) => prefs.hiddenFeatures.includes(feature.id)), [prefs.hiddenFeatures])
  const moreExpanded = moreOpen && hidden.length > 0

  const ids = useMemo(
    () => [
      ...boardTreeKeys(view, prefs, 'favorites'),
      ...shown.map((feature) => featureKey(feature.id)),
      ...(hidden.length > 0 ? [MORE_KEY] : []),
      ...(moreExpanded ? hidden.map((feature) => featureKey(feature.id)) : []),
      ...boardTreeKeys(view, prefs, 'groups'),
      SETTINGS_KEY
    ],
    [view, prefs, shown, hidden, moreExpanded]
  )
  const selectedKey = settingsCurrent
    ? SETTINGS_KEY
    : features.current !== null
      ? featureKey(features.current)
      : selected === null
        ? null
        : listKey(selected)
  const roving = useRovingFocus(ids, selectedKey)

  return (
    <nav
      ref={panelRef}
      id={id}
      className={variant === 'overlay' ? 'nav proto-nav-a is-overlay' : 'nav proto-nav-a'}
      aria-label="功能与版块"
      style={{ '--nav-t': progress } as CSSProperties}
      onKeyDown={roving.onKeyDown}
    >
      <div className="nav-scroll proto-scroll-top">
        <BoardTree
          part="favorites"
          view={view}
          prefs={prefs}
          selectedKey={selectedKey}
          onSelect={onSelect}
          itemProps={roving.itemProps}
          favoritesTitle="收藏版块"
          quickFavorite
        />

        <section className="nav-section" aria-labelledby="proto-a-features">
          <h2 className="nav-heading" id="proto-a-features">
            功能
          </h2>
          <ul className="nav-list">
            {shown.map((feature) => (
              <li key={feature.id}>
                <FeatureRow id={feature.id} host={features} itemProps={roving.itemProps(featureKey(feature.id))} />
              </li>
            ))}
            {hidden.length > 0 && (
              <li>
                <button
                  type="button"
                  className="nav-item proto-more"
                  aria-expanded={moreExpanded}
                  aria-controls={moreExpanded ? 'proto-a-more' : undefined}
                  onClick={() => setMoreOpen(!moreOpen)}
                  {...roving.itemProps(MORE_KEY)}
                >
                  <span className="nav-item-icon proto-more-icon">
                    <MoreIcon />
                  </span>
                  <span className="nav-item-label">{moreExpanded ? '收起' : '更多'}</span>
                  <span className="proto-more-count">{hidden.length}</span>
                  <Icon name="chevron" size={12} className={moreExpanded ? 'proto-chevron is-open' : 'proto-chevron'} />
                </button>
                {moreExpanded && (
                  <ul className="nav-list proto-more-list" id="proto-a-more">
                    {hidden.map((feature) => (
                      <li key={feature.id}>
                        <FeatureRow id={feature.id} host={features} itemProps={roving.itemProps(featureKey(feature.id))} />
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )}
          </ul>
        </section>

        <BoardTree
          part="groups"
          view={view}
          prefs={prefs}
          selectedKey={selectedKey}
          onSelect={onSelect}
          itemProps={roving.itemProps}
          favoritesTitle="收藏版块"
          quickFavorite
        />
        <DirectoryPlaceholder state={state} onRetry={onRetry} empty={all.length === 0} />
      </div>

      <DirectoryStatus state={state} />
      <div className="proto-nav-foot">
        <button
          type="button"
          className={settingsCurrent ? 'nav-item is-current' : 'nav-item'}
          aria-current={settingsCurrent ? 'page' : undefined}
          onClick={onOpenSettings}
          {...roving.itemProps(SETTINGS_KEY)}
        >
          <Icon name="settings" className="nav-item-icon" />
          <span className="nav-item-label">设置</span>
        </button>
      </div>
    </nav>
  )
}
