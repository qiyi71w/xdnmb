// Choosing a board by name in the board panel: a filter field, 收藏 first, then every group side by
// side so the whole directory is seen at once. Each group (收藏 too) collapses from its heading and
// stays collapsed (settings `boards.collapsed`); while filtering every match is shown.
// Hidden boards are never listed: filter matches among them (or all of them, when nothing else is
// left) are counted below the results with 显示 to bring them back; no match offers 清除筛选.
// Keyboard: ↓ from the field enters the boards (or those buttons when there are none), ↑/↓/Home/End
// move, → reaches a board's star (收藏), ← returns; Enter in the field opens the first match.

import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { useRovingFocus } from '../../lib/useRovingFocus'
import type { ListRef } from '../tabs/tabsState'
import { useSettings } from '../../lib/settingsContext'
import { groupKey, type RovingItemProps } from './navParts'
import { useNavActions, type Board, type BoardGroup, type BoardView } from './navStore'

export function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query)
}

/** Groups narrowed to `query` (trimmed, lower case): a matching group title keeps the whole group. */
export function matchingGroups(groups: BoardGroup[], query: string): BoardGroup[] {
  return groups
    .map((group) => (matches(group.title, query) ? group : { ...group, boards: group.boards.filter((item) => matches(item.label, query)) }))
    .filter((group) => group.boards.length > 0)
}

const FAVORITES_GROUP = 'favorites'

export function BoardPicker({
  view,
  hidden,
  selectedKey,
  onSelect,
  placeholder,
  onClose
}: {
  view: BoardView
  /** Hidden boards in their groups (`useBoardView().hidden`): offered back, never listed. */
  hidden: BoardGroup[]
  selectedKey: string | null
  onSelect: (ref: ListRef) => void
  /** Directory not obtained, failed or empty: shown in place of the boards, filtering or not. */
  placeholder?: ReactNode
  /** 关闭 right of the field. */
  onClose: () => void
}) {
  const fieldId = useId()
  const noteId = `${fieldId}-note`
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const collapsed = useSettings().settings.boards.collapsed
  const actions = useNavActions()
  const normalized = query.trim().toLowerCase()
  const filtering = normalized !== ''

  // 收藏 is the first group; while filtering, groups only hold their matches.
  const groups = useMemo(() => {
    const all: BoardGroup[] = [
      ...(view.favorites.length > 0 ? [{ id: FAVORITES_GROUP, title: '收藏', boards: view.favorites }] : []),
      ...view.groups
    ]
    if (!filtering) return all
    return all
      .map((group) => (group.id === FAVORITES_GROUP ? { ...group, boards: group.boards.filter((item) => matches(item.label, normalized)) } : group))
      .flatMap((group) => (group.id === FAVORITES_GROUP ? (group.boards.length > 0 ? [group] : []) : matchingGroups([group], normalized)))
  }, [view, filtering, normalized])
  const isClosed = (id: string) => !filtering && collapsed.includes(id)

  const ids = useMemo(
    () =>
      groups.flatMap((group) =>
        filtering ? group.boards.map((item) => item.key) : [groupKey(group.id), ...(collapsed.includes(group.id) ? [] : group.boards.map((item) => item.key))]
      ),
    [groups, filtering, collapsed]
  )
  const roving = useRovingFocus(ids, selectedKey)

  // Favoriting moves the row between groups: keep focus on its star. Showing hidden boards
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

  const first = groups[0]?.boards[0]
  const nothing = groups.length === 0

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
    actions.setCollapsed(hiddenShown.map((group) => group.id), false)
    actions.setBoardsHidden(offered.map((item) => item.key), false)
  }

  const clearFilter = () => {
    setQuery('')
    inputRef.current?.focus()
  }

  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      rootRef.current?.querySelector<HTMLElement>('[data-roving-item], .shell-picker-status button')?.focus()
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
    if (event.key === 'ArrowUp' && target.closest('.shell-picker-status') !== null) {
      event.preventDefault()
      const boards = rootRef.current?.querySelectorAll<HTMLElement>('[data-roving-item]') ?? []
      const last = boards.length > 0 ? boards[boards.length - 1] : inputRef.current
      last?.focus()
      return
    }
    roving.onKeyDown(event)
  }

  const favoriteKeys = new Set(view.favorites.map((item) => item.key))

  return (
    <div className="shell-picker" ref={rootRef} data-keeps-arrows="">
      <div className="shell-picker-top">
        <div className="shell-picker-field">
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            id={fieldId}
            type="search"
            className="shell-picker-input"
            placeholder="筛选版块"
            aria-label="筛选版块"
            autoComplete="off"
            spellCheck={false}
            value={query}
            data-autofocus=""
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onFieldKeyDown}
          />
        </div>
        <button type="button" className="btn btn-quiet shell-picker-close" onClick={onClose}>
          <Icon name="close" size={15} />
          关闭
        </button>
      </div>
      <div className="shell-picker-body" onKeyDown={onBodyKeyDown}>
        {groups.length > 0 && (
          <div className="shell-picker-groups">
            {groups.map((group) => {
              const closed = isClosed(group.id)
              const listId = `${fieldId}-${group.id}`
              return (
                <section key={group.id} className="shell-picker-group" aria-label={group.title}>
                  <h3 className="shell-picker-heading">
                    <button
                      type="button"
                      className="shell-picker-toggle"
                      aria-expanded={!closed}
                      aria-controls={closed ? undefined : listId}
                      disabled={filtering}
                      onClick={() => actions.setCollapsed([group.id], !collapsed.includes(group.id))}
                      {...(filtering ? {} : roving.itemProps(groupKey(group.id)))}
                    >
                      <Icon name="chevron" size={12} className={closed ? 'shell-chevron' : 'shell-chevron is-open'} />
                      {group.title}
                      {closed && <span className="shell-group-count">{group.boards.length}</span>}
                    </button>
                  </h3>
                  {!closed && (
                    <ul className="shell-picker-list" id={listId}>
                      {group.boards.map((item) => {
                        const favorite = favoriteKeys.has(item.key)
                        return (
                          <BoardChoice
                            key={item.key}
                            item={item}
                            favorite={favorite}
                            current={item.key === selectedKey}
                            onSelect={onSelect}
                            onStar={() => {
                              refocus.current = { key: item.key, star: true }
                              actions.setFavorite(item.key, !favorite)
                            }}
                            itemProps={roving.itemProps(item.key)}
                          />
                        )
                      })}
                    </ul>
                  )}
                </section>
              )
            })}
          </div>
        )}
        {placeholder ?? (
          <div className={nothing ? 'shell-picker-status' : 'shell-picker-status is-below'} role="status">
            {nothing && offered.length === 0 && <p className="shell-picker-note">{filtering ? '没有匹配的版块' : '没有可浏览的版块'}</p>}
            {offered.length > 0 && (
              <p className="shell-picker-note" id={noteId}>
                {filtering ? `已隐藏 ${offered.length} 个匹配` : `版块都已隐藏`}
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
    <li className="shell-choice">
      <button
        type="button"
        className={current ? 'shell-choice-btn is-current' : 'shell-choice-btn'}
        aria-current={current ? 'page' : undefined}
        onClick={() => onSelect(item.ref)}
        {...itemProps}
      >
        <Icon name={item.icon} size={14} className="shell-choice-icon" />
        <span className="shell-choice-label">{item.label}</span>
      </button>
      <button
        type="button"
        className={favorite ? 'shell-star is-on' : 'shell-star'}
        tabIndex={-1}
        data-star-key={item.key}
        aria-pressed={favorite}
        aria-label={`收藏 ${item.label}`}
        title={favorite ? '取消收藏' : '收藏'}
        onClick={onStar}
      >
        <Icon name="star" size={13} />
      </button>
    </li>
  )
}
