// PROTOTYPE (throwaway) variant E — 列表内切换: no board column and no board button. The navigation is
// the icon rail only; boards are switched at the top of the list: a scrolling row of favorite boards
// (the current one marked) and 全部版块, a filterable drop-down list of every group. A tab without a
// list shows the same board choice as its page.

import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { BoardDirectory } from '../../../../../shared/forum'
import { Icon } from '../../../components/Icon'
import { usePopover } from '../../../lib/usePopover'
import { listKey, type ListRef } from '../../tabs/tabsState'
import { DirectorySkeleton } from '../Navigation'
import { BoardPicker } from './PrototypeBoardPicker'
import { useBoardView, type PrototypeNavProps } from './PrototypeNavParts'
import { PrototypeRail, RAIL_WIDTH } from './PrototypeRail'

export function PrototypeNavE({ features, settingsCurrent, onOpenSettings, variant, panelRef, id }: PrototypeNavProps) {
  return (
    <nav
      ref={panelRef}
      id={id}
      className={variant === 'overlay' ? 'nav proto-nav proto-nav-e is-overlay' : 'nav proto-nav proto-nav-e'}
      aria-label="功能"
      style={{ '--proto-rail': `${RAIL_WIDTH}px` } as CSSProperties}
    >
      <PrototypeRail features={features} settingsCurrent={settingsCurrent} onOpenSettings={onOpenSettings} />
    </nav>
  )
}

const ALL_KEY = 'all'

/** The row above a list: favorite boards, the current board when it is not one of them, 全部版块. */
export function BoardStrip({
  current,
  directory,
  onSelect
}: {
  current: ListRef | null
  directory: BoardDirectory | null
  onSelect: (ref: ListRef) => void
}) {
  const { all, view, hidden } = useBoardView(directory)
  const currentKey = current === null ? null : listKey(current)
  const currentBoard = useMemo(
    () => all.flatMap((group) => group.boards).find((item) => item.key === currentKey) ?? null,
    [all, currentKey]
  )
  const currentIsFavorite = view.favorites.some((item) => item.key === currentKey)

  const ids = useMemo(() => [...view.favorites.map((item) => item.key), ALL_KEY], [view.favorites])
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const tabStop = focusedId !== null && ids.includes(focusedId) ? focusedId : currentIsFavorite && currentKey !== null ? currentKey : ids[0]
  const itemProps = (key: string) => ({
    'data-strip-item': '',
    tabIndex: key === tabStop ? 0 : -1,
    onFocus: () => setFocusedId(key)
  })

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const { key } = event
    if (key !== 'ArrowLeft' && key !== 'ArrowRight' && key !== 'Home' && key !== 'End') return
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[data-strip-item]'))
    const index = items.findIndex((item) => item === document.activeElement)
    if (index < 0) return
    event.preventDefault()
    const next =
      key === 'Home' ? 0 : key === 'End' ? items.length - 1 : key === 'ArrowRight' ? Math.min(index + 1, items.length - 1) : Math.max(index - 1, 0)
    items[next]?.focus()
  }

  // The current favorite stays in sight in the scrolling row.
  const scrollRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    scrollRef.current?.querySelector<HTMLElement>('.proto-strip-tab.is-current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [currentKey])

  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropRef = useRef<HTMLDivElement>(null)
  const drop = usePopover(triggerRef, dropRef)

  return (
    <div className="proto-strip" role="toolbar" aria-label="版块" onKeyDown={onKeyDown}>
      {currentBoard !== null && !currentIsFavorite && (
        <span className="proto-strip-current" aria-current="page">
          <Icon name={currentBoard.icon} size={14} />
          {currentBoard.label}
        </span>
      )}
      <div className="proto-strip-scroll" ref={scrollRef}>
        {view.favorites.map((item) => {
          const selected = item.key === currentKey
          return (
            <button
              key={item.key}
              type="button"
              className={selected ? 'proto-strip-tab is-current' : 'proto-strip-tab'}
              aria-current={selected ? 'page' : undefined}
              onClick={() => onSelect(item.ref)}
              {...itemProps(item.key)}
            >
              {item.label}
            </button>
          )
        })}
      </div>
      <button
        ref={triggerRef}
        type="button"
        className={drop.open ? 'proto-strip-all is-open' : 'proto-strip-all'}
        aria-haspopup="dialog"
        aria-expanded={drop.open}
        aria-controls={drop.open ? 'proto-strip-drop' : undefined}
        onClick={drop.toggle}
        {...itemProps(ALL_KEY)}
      >
        全部版块
        <Icon name="chevron" size={12} className="proto-strip-all-chevron" />
      </button>
      {drop.open && (
        <div ref={dropRef} id="proto-strip-drop" className="proto-pop proto-strip-drop" role="dialog" aria-label="全部版块">
          <BoardPicker
            view={view}
            hidden={hidden}
            selectedKey={currentKey}
            onSelect={(ref) => {
              drop.close()
              onSelect(ref)
            }}
            shape="list"
            autoFocus
          />
        </div>
      )}
    </div>
  )
}

/** A tab without a list: choose its board right on the page. */
export function BoardChooserPage({ directory, onSelect }: { directory: BoardDirectory | null; onSelect: (ref: ListRef) => void }) {
  const { view, hidden } = useBoardView(directory)
  return (
    <div className="proto-chooser-page">
      <div className="proto-chooser-column">
        <h2 className="proto-chooser-title">选择版块</h2>
        <BoardPicker
          view={view}
          hidden={hidden}
          selectedKey={null}
          onSelect={onSelect}
          shape="list"
          placeholder={directory === null ? <DirectorySkeleton /> : undefined}
        />
      </div>
    </div>
  )
}
