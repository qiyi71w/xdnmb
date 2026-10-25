// PROTOTYPE (throwaway) variant B — 版块栏 (the reference): the icon rail, and beside it a fixed-width
// column of boards (收藏, then the groups, each collapsible).

import { useMemo, type CSSProperties } from 'react'
import { useRovingFocus } from '../../../lib/useRovingFocus'
import { listKey } from '../../tabs/tabsState'
import { DirectoryStatus } from '../Navigation'
import { BoardTree, boardTreeKeys, DirectoryPlaceholder, useBoardView, type PrototypeNavProps } from './PrototypeNavParts'
import { PrototypeRail, RAIL_WIDTH } from './PrototypeRail'

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
  const boardIds = useMemo(() => boardTreeKeys(view, prefs), [view, prefs])
  const selectedKey = settingsCurrent || selected === null ? null : listKey(selected)
  const boards = useRovingFocus(boardIds, selectedKey)

  return (
    <nav
      ref={panelRef}
      id={id}
      className={variant === 'overlay' ? 'nav proto-nav proto-nav-b is-overlay' : 'nav proto-nav proto-nav-b'}
      aria-label="功能与版块"
      style={{ '--nav-t': progress, '--proto-rail': `${RAIL_WIDTH}px` } as CSSProperties}
    >
      <PrototypeRail features={features} settingsCurrent={settingsCurrent} onOpenSettings={onOpenSettings} />

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
    </nav>
  )
}
