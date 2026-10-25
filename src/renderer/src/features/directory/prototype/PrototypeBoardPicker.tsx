// PROTOTYPE (throwaway): choosing a board by name, shared by D's board panel and E's 全部版块 list
// and empty tab page. A filter field, 收藏 first, then every group. `columns` lays the groups side by
// side so the whole directory is seen at once (D); `list` stacks them, each group collapsible (E).
// Keyboard: ↓ from the field enters the boards, ↑/↓/Home/End move, → reaches a board's star (收藏),
// ← returns; Enter in the field opens the first match.

import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from '../../../components/Icon'
import { useRovingFocus } from '../../../lib/useRovingFocus'
import type { ListRef } from '../../tabs/tabsState'
import { groupKey, type RovingItemProps } from './PrototypeNavParts'
import { navActions, type Board, type BoardView } from './prototypeStore'

function matches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query)
}

/** The view narrowed to `query`: a matching group title keeps the whole group. */
function filtered(view: BoardView, query: string): BoardView {
  if (query === '') return view
  return {
    favorites: view.favorites.filter((item) => matches(item.label, query)),
    groups: view.groups
      .map((group) => (matches(group.title, query) ? group : { ...group, boards: group.boards.filter((item) => matches(item.label, query)) }))
      .filter((group) => group.boards.length > 0)
  }
}

export function BoardPicker({
  view,
  selectedKey,
  onSelect,
  shape,
  autoFocus = false,
  placeholder
}: {
  view: BoardView
  selectedKey: string | null
  onSelect: (ref: ListRef) => void
  shape: 'columns' | 'list'
  /** The field takes focus when a popup opens (`data-autofocus`). */
  autoFocus?: boolean
  /** Directory loading / failure, shown instead of the boards while there are none. */
  placeholder?: ReactNode
}) {
  const fieldId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const normalized = query.trim().toLowerCase()
  const shown = useMemo(() => filtered(view, normalized), [view, normalized])
  const filtering = normalized !== ''

  const ids = useMemo(
    () => [
      ...shown.favorites.map((item) => item.key),
      ...shown.groups.flatMap((group) => [
        ...(shape === 'list' ? [groupKey(group.id)] : []),
        ...(shape === 'list' && !filtering && collapsed.has(group.id) ? [] : group.boards.map((item) => item.key))
      ])
    ],
    [shown, shape, filtering, collapsed]
  )
  const roving = useRovingFocus(ids, selectedKey)

  // Favoriting moves the row between sections: keep focus on its star.
  const refocusStar = useRef<string | null>(null)
  useLayoutEffect(() => {
    const key = refocusStar.current
    if (key === null) return
    refocusStar.current = null
    rootRef.current?.querySelector<HTMLElement>(`[data-star-key="${CSS.escape(key)}"]`)?.focus()
  })

  const first = shown.favorites[0] ?? shown.groups[0]?.boards[0]
  const nothing = shown.favorites.length === 0 && shown.groups.length === 0

  const onFieldKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      rootRef.current?.querySelector<HTMLElement>('[data-roving-item]')?.focus()
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
        refocusStar.current = item.key
        navActions.setFavorite(item.key, !favorite)
      }}
      itemProps={roving.itemProps(item.key)}
    />
  )

  return (
    <div className={`proto-picker is-${shape}`} ref={rootRef} data-keeps-arrows="">
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
              const closed = shape === 'list' && !filtering && collapsed.has(group.id)
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
                        onClick={() =>
                          setCollapsed((previous) => {
                            const next = new Set(previous)
                            if (next.has(group.id)) next.delete(group.id)
                            else next.add(group.id)
                            return next
                          })
                        }
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
        {nothing && (placeholder ?? <p className="proto-picker-empty">{filtering ? '没有匹配的版块。' : '没有可浏览的版面。'}</p>)}
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
