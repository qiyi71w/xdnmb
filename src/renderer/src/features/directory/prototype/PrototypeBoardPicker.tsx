// PROTOTYPE (throwaway): choosing a board by name, shared by D's board panel and E's 全部版块 list
// and empty tab page. A filter field, 收藏 first, then every group. `columns` lays the groups side by
// side so the whole directory is seen at once (D); `list` stacks them, each group collapsible (E,
// sharing the saved collapse state of the board trees).
// Hidden boards are never listed: filter matches among them (or all of them, when nothing else is
// left) are named below the results with 显示 to bring them back; no match offers 清除筛选.
// Keyboard: ↓ from the field enters the boards (or those buttons when there are none), ↑/↓/Home/End
// move, → reaches a board's star (收藏), ← returns; Enter in the field opens the first match.

import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '../../../components/Icon'
import { useRovingFocus } from '../../../lib/useRovingFocus'
import type { ListRef } from '../../tabs/tabsState'
import { groupKey, type RovingItemProps } from './PrototypeNavParts'
import { navActions, useNavPrefs, type Board, type BoardGroup, type BoardView } from './prototypeStore'

export function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query)
}

/** Groups narrowed to `query` (trimmed, lower case): a matching group title keeps the whole group. */
export function matchingGroups(groups: BoardGroup[], query: string): BoardGroup[] {
  return groups
    .map((group) => (matches(group.title, query) ? group : { ...group, boards: group.boards.filter((item) => matches(item.label, query)) }))
    .filter((group) => group.boards.length > 0)
}

/** The view narrowed to `query`. */
function filtered(view: BoardView, query: string): BoardView {
  if (query === '') return view
  return {
    favorites: view.favorites.filter((item) => matches(item.label, query)),
    groups: matchingGroups(view.groups, query)
  }
}

/** Up to three names, then 等. */
function someNames(boards: Board[]): string {
  const names = boards
    .slice(0, 3)
    .map((item) => item.label)
    .join('、')
  return boards.length > 3 ? `${names}等` : names
}

export function BoardPicker({
  view,
  hidden,
  selectedKey,
  onSelect,
  shape,
  autoFocus = false,
  placeholder,
  onClose
}: {
  view: BoardView
  /** Hidden boards in their groups (`useBoardView().hidden`): offered back, never listed. */
  hidden: BoardGroup[]
  selectedKey: string | null
  onSelect: (ref: ListRef) => void
  shape: 'columns' | 'list'
  /** The field takes focus when a popup opens (`data-autofocus`). */
  autoFocus?: boolean
  /** Directory not obtained, failed or empty: shown in place of the boards, filtering or not. */
  placeholder?: ReactNode
  /** A popup holding the picker: a 关闭 button right of the field. */
  onClose?: () => void
}) {
  const fieldId = useId()
  const noteId = `${fieldId}-note`
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const collapsed = useNavPrefs().collapsed
  const normalized = query.trim().toLowerCase()
  const shown = useMemo(() => filtered(view, normalized), [view, normalized])
  const filtering = normalized !== ''

  const ids = useMemo(
    () => [
      ...shown.favorites.map((item) => item.key),
      ...shown.groups.flatMap((group) => [
        ...(shape === 'list' ? [groupKey(group.id)] : []),
        ...(shape === 'list' && !filtering && collapsed.includes(group.id) ? [] : group.boards.map((item) => item.key))
      ])
    ],
    [shown, shape, filtering, collapsed]
  )
  const roving = useRovingFocus(ids, selectedKey)

  // Favoriting moves the row between sections: keep focus on its star. Showing hidden boards
  // removes 显示: focus goes to the first board shown.
  const refocus = useRef<{ key: string; star: boolean } | null>(null)
  useLayoutEffect(() => {
    const target = refocus.current
    if (target === null) return
    refocus.current = null
    const star = rootRef.current?.querySelector<HTMLElement>(`[data-star-key="${CSS.escape(target.key)}"]`)
    const focused = target.star ? star : star?.parentElement?.querySelector<HTMLElement>('[data-roving-item]')
    focused?.focus()
  })

  const first = shown.favorites[0] ?? shown.groups[0]?.boards[0]
  const nothing = shown.favorites.length === 0 && shown.groups.length === 0

  // Hidden filter matches, or every hidden board when they are all there is.
  const hiddenShown = useMemo(
    () => (filtering ? matchingGroups(hidden, normalized) : nothing ? hidden : []),
    [hidden, normalized, filtering, nothing]
  )
  const offered = useMemo(() => hiddenShown.flatMap((group) => group.boards), [hiddenShown])

  const showOffered = () => {
    const firstOffered = offered[0]
    if (firstOffered === undefined) return
    refocus.current = { key: firstOffered.key, star: false }
    for (const group of hiddenShown) if (collapsed.includes(group.id)) navActions.setCollapsed(group.id, false)
    for (const item of offered) navActions.setBoardHidden(item.key, false)
  }

  const clearFilter = () => {
    setQuery('')
    inputRef.current?.focus()
  }

  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      rootRef.current?.querySelector<HTMLElement>('[data-roving-item], .proto-picker-status button')?.focus()
    } else if (event.key === 'Enter' && filtering && first !== undefined) {
      event.preventDefault()
      onSelect(first.ref)
    }
  }

  const onBodyKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement
    if (event.key === 'ArrowRight' && target.matches('[data-roving-item]')) {
      const star = target.parentElement?.querySelector<HTMLElement>('[data-star-key]')
      if (star != null) {
        event.preventDefault()
        star.focus()
      }
      return
    }
    if (event.key === 'ArrowLeft' && target.matches('[data-star-key]')) {
      event.preventDefault()
      target.parentElement?.querySelector<HTMLElement>('[data-roving-item]')?.focus()
      return
    }
    if (event.key === 'ArrowUp' && target === rootRef.current?.querySelector('[data-roving-item]')) {
      event.preventDefault()
      inputRef.current?.focus()
      return
    }
    // From 显示 / 清除筛选: ↑ goes back to the last board, or to the field when there is none.
    if (event.key === 'ArrowUp' && target.closest('.proto-picker-status') !== null) {
      event.preventDefault()
      const boards = rootRef.current?.querySelectorAll<HTMLElement>('[data-roving-item]') ?? []
      const last = boards.length > 0 ? boards[boards.length - 1] : inputRef.current
      last?.focus()
      return
    }
    roving.onKeyDown(event)
  }

  const row = (item: Board, favorite: boolean) => (
    <BoardChoice
      key={item.key}
      item={item}
      favorite={favorite}
      current={item.key === selectedKey}
      onSelect={onSelect}
      onStar={() => {
        refocus.current = { key: item.key, star: true }
        navActions.setFavorite(item.key, !favorite)
      }}
      itemProps={roving.itemProps(item.key)}
    />
  )

  return (
    <div className={`proto-picker is-${shape}`} ref={rootRef} data-keeps-arrows="">
      <div className="proto-picker-top">
        <div className="proto-picker-field">
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            id={fieldId}
            type="search"
            className="proto-picker-input"
            placeholder="筛选版块"
            aria-label="筛选版块"
            autoComplete="off"
            spellCheck={false}
            value={query}
            data-autofocus={autoFocus ? '' : undefined}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onFieldKeyDown}
          />
        </div>
        {onClose !== undefined && (
          <button type="button" className="btn btn-quiet proto-picker-close" onClick={onClose}>
            <Icon name="close" size={15} />
            关闭
          </button>
        )}
      </div>
      <div className="proto-picker-body" onKeyDown={onBodyKeyDown}>
        {shown.favorites.length > 0 && (
          <section className="proto-picker-favorites" aria-label="收藏">
            <h3 className="proto-picker-heading">收藏</h3>
            <ul className="proto-picker-list">{shown.favorites.map((item) => row(item, true))}</ul>
          </section>
        )}
        {shown.groups.length > 0 && (
          <div className="proto-picker-groups">
            {shown.groups.map((group) => {
              const closed = shape === 'list' && !filtering && collapsed.includes(group.id)
              const listId = `${fieldId}-${group.id}`
              return (
                <section key={group.id} className="proto-picker-group" aria-label={group.title}>
                  {shape === 'list' ? (
                    <h3 className="proto-picker-heading">
                      <button
                        type="button"
                        className="proto-picker-toggle"
                        aria-expanded={!closed}
                        aria-controls={closed ? undefined : listId}
                        disabled={filtering}
                        onClick={() => navActions.setCollapsed(group.id, !collapsed.includes(group.id))}
                        {...(filtering ? {} : roving.itemProps(groupKey(group.id)))}
                      >
                        <Icon name="chevron" size={12} className={closed ? 'proto-chevron' : 'proto-chevron is-open'} />
                        {group.title}
                      </button>
                    </h3>
                  ) : (
                    <h3 className="proto-picker-heading">{group.title}</h3>
                  )}
                  {!closed && (
                    <ul className="proto-picker-list" id={listId}>
                      {group.boards.map((item) => row(item, false))}
                    </ul>
                  )}
                </section>
              )
            })}
          </div>
        )}
        {placeholder ?? (
          <div className={nothing ? 'proto-picker-status' : 'proto-picker-status is-below'} role="status">
            {nothing && offered.length === 0 && <p className="proto-picker-note">{filtering ? '没有匹配的版块' : '没有可浏览的版面。'}</p>}
            {offered.length > 0 && (
              <p className="proto-picker-note" id={noteId}>
                {filtering ? `已隐藏 ${offered.length} 个匹配：${someNames(offered)}` : '版块都已隐藏'}
              </p>
            )}
            {offered.length > 0 && (
              <button type="button" className="btn btn-quiet btn-small" aria-describedby={noteId} onClick={showOffered}>
                显示
              </button>
            )}
            {filtering && nothing && (
              <button type="button" className="btn btn-quiet btn-small" onClick={clearFilter}>
                清除筛选
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function BoardChoice({
  item,
  favorite,
  current,
  onSelect,
  onStar,
  itemProps
}: {
  item: Board
  favorite: boolean
  current: boolean
  onSelect: (ref: ListRef) => void
  onStar: () => void
  itemProps: RovingItemProps
}) {
  return (
    <li className="proto-choice">
      <button
        type="button"
        className={current ? 'proto-choice-btn is-current' : 'proto-choice-btn'}
        aria-current={current ? 'page' : undefined}
        onClick={() => onSelect(item.ref)}
        {...itemProps}
      >
        <Icon name={item.icon} size={14} className="proto-choice-icon" />
        <span className="proto-choice-label">{item.label}</span>
      </button>
      <button
        type="button"
        className={favorite ? 'proto-star is-on' : 'proto-star'}
        tabIndex={-1}
        data-star-key={item.key}
        aria-pressed={favorite}
        aria-label={`收藏 ${item.label}`}
        title={favorite ? '取消收藏（←／→）' : '收藏（→ 选中星标）'}
        onClick={onStar}
      >
        <Icon name="star" size={13} />
      </button>
    </li>
  )
}
