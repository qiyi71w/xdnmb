// PROTOTYPE (throwaway) variant F — 可收起版块栏: the board column stays, redrawn: no counts, 收藏 as the
// first group, groups open by default with headings that stick to the top and collapse on click, and
// a width that follows its names. The rail's 版块 button collapses the column to the rail; while it
// is collapsed the same button pops the column out over the content, choosing a board puts it away,
// and up to five favorite boards sit under it in the rail.

import { useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react'
import { Icon } from '../../../components/Icon'
import { usePopover } from '../../../lib/usePopover'
import { useRovingFocus } from '../../../lib/useRovingFocus'
import { listKey, type ListRef } from '../../tabs/tabsState'
import { DirectoryStatus } from '../Navigation'
import { BoardTree, boardTreeKeys, DirectoryPlaceholder, useBoardView, type PrototypeNavProps } from './PrototypeNavParts'
import { PrototypeRail, RAIL_WIDTH } from './PrototypeRail'
import { setBoardColumnCollapsed, setBoardColumnWidth, useBoardColumnCollapsed, useBoardColumnWidth, type BoardView } from './prototypeStore'

const POP_ID = 'proto-f-pop'
/** Narrowest and widest board column, CSS pixels. */
const MIN_COLUMN = 128
const MAX_COLUMN = 300

export function PrototypeNavF({
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
  const collapsed = useBoardColumnCollapsed()
  const columnWidth = useBoardColumnWidth()
  const { view } = useBoardView(state.directory)
  const railButtonRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const pop = usePopover(railButtonRef, popRef)
  const { close: closePop } = pop

  // Expanding again puts the popped-out copy away.
  useLayoutEffect(() => {
    if (!collapsed) closePop(false)
  }, [collapsed, closePop])

  const column = (popup: boolean) => (
    <BoardColumn
      state={state}
      selected={settingsCurrent ? null : selected}
      onSelect={
        popup
          ? (ref) => {
              closePop()
              onSelect(ref)
            }
          : onSelect
      }
      onRetry={onRetry}
      popup={popup}
      onCollapse={() => {
        setBoardColumnCollapsed(true)
        railButtonRef.current?.focus()
      }}
      onPin={() => {
        closePop()
        setBoardColumnCollapsed(false)
      }}
    />
  )

  return (
    <nav
      ref={panelRef}
      id={id}
      className={[
        'nav proto-nav proto-nav-f',
        variant === 'overlay' ? 'is-overlay' : '',
        collapsed ? 'is-collapsed' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      aria-label="功能与版块"
      style={{ '--proto-rail': `${RAIL_WIDTH}px`, '--proto-f-width': `${columnWidth}px` } as CSSProperties}
    >
      <PrototypeRail
        features={features}
        settingsCurrent={settingsCurrent}
        onOpenSettings={onOpenSettings}
        boards={{
          label: collapsed ? '版块' : '收起版块栏',
          buttonRef: railButtonRef,
          popup: collapsed ? { expanded: pop.open, controls: POP_ID } : null,
          active: !collapsed,
          onClick: () => (collapsed ? pop.toggle() : setBoardColumnCollapsed(true))
        }}
        favorites={
          collapsed
            ? {
                boards: view.favorites,
                selectedKey: settingsCurrent || selected === null ? null : listKey(selected),
                onSelect: (ref) => {
                  closePop(false)
                  onSelect(ref)
                }
              }
            : null
        }
      />
      {!collapsed && column(false)}
      {collapsed && pop.open && (
        <div ref={popRef} id={POP_ID} className="proto-pop proto-f-pop" role="dialog" aria-label="版块">
          {column(true)}
        </div>
      )}
      <ColumnMeasure view={view} />
    </nav>
  )
}

function BoardColumn({
  state,
  selected,
  onSelect,
  onRetry,
  popup,
  onCollapse,
  onPin
}: {
  state: PrototypeNavProps['state']
  selected: ListRef | null
  onSelect: (ref: ListRef) => void
  onRetry: () => void
  popup: boolean
  onCollapse: () => void
  onPin: () => void
}) {
  const { prefs, all, view } = useBoardView(state.directory)
  const boardIds = useMemo(() => boardTreeKeys(view, prefs), [view, prefs])
  const selectedKey = selected === null ? null : listKey(selected)
  const boards = useRovingFocus(boardIds, selectedKey)
  // A popup opens on the board list's tab stop, not on the header button.
  const itemProps = (key: string) => {
    const props = boards.itemProps(key)
    return popup && props.tabIndex === 0 ? { ...props, 'data-autofocus': '' } : props
  }

  return (
    <div className="proto-boards proto-f-column">
      <div className="proto-f-head">
        <h2 className="proto-f-title">版块</h2>
        <button
          type="button"
          className="icon-btn proto-f-head-btn"
          aria-label={popup ? '固定版块栏' : '收起版块栏'}
          title={popup ? '固定版块栏' : '收起版块栏'}
          onClick={popup ? onPin : onCollapse}
        >
          <Icon name="sidebar" size={15} />
        </button>
      </div>
      <div className="nav-scroll proto-f-scroll" onKeyDown={boards.onKeyDown}>
        <BoardTree
          view={view}
          prefs={prefs}
          selectedKey={selectedKey}
          onSelect={onSelect}
          itemProps={itemProps}
          favoritesTitle="收藏"
          counts={false}
        />
        <DirectoryPlaceholder state={state} onRetry={onRetry} empty={all.length === 0} />
      </div>
      <DirectoryStatus state={state} />
    </div>
  )
}

/** Invisible copy of the column's names at their natural width; the column takes that width. */
function ColumnMeasure({ view }: { view: BoardView }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const measure = () => setBoardColumnWidth(Math.min(MAX_COLUMN, Math.max(MIN_COLUMN, Math.ceil(element.getBoundingClientRect().width))))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return (
    <div className="proto-f-measure" ref={ref} aria-hidden="true">
      <div className="proto-f-head">
        <span className="proto-f-title">版块</span>
        <span className="proto-f-head-btn icon-btn" />
      </div>
      {view.favorites.length > 0 && <span className="nav-heading">收藏</span>}
      {[...view.favorites, ...view.groups.flatMap((group) => group.boards)].map((item) => (
        <span key={item.key} className="nav-item">
          <Icon name={item.icon} className="nav-item-icon" />
          <span>{item.label}</span>
        </span>
      ))}
      {view.groups.map((group) => (
        <span key={group.id} className="proto-group-toggle">
          <Icon name="chevron" size={12} />
          <span>{group.title}</span>
        </span>
      ))}
    </div>
  )
}
