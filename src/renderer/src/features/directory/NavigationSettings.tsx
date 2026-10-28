// The settings page's 功能显示 (show / hide each rail feature, sort the rail order by handle) and
// 版块管理 (filter, favorite, hide, sort favorites and boards within forum groups by handle;
// timelines keep their order, nothing sorts while filtering).

import { useId, useRef, useState } from 'react'
import type { BoardDirectory } from '../../../../shared/forum'
import type { BoardSettings } from '../../../../shared/settings'
import { Icon } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { SortHandle, SortStatus, useSortableList, type SortableList } from '../../components/SortHandle'
import { useSettings } from '../../lib/settingsContext'
import { matches, matchingGroups } from './BoardPicker'
import { DirectorySkeleton, useBoardView } from './navParts'
import { isReorderableGroup, orderedFeatures, useNavActions, type Board, type BoardGroup, type NavActions as Actions } from './navStore'

export function FeatureVisibilitySection() {
  const headingId = useId()
  const prefs = useSettings().settings.rail
  const actions = useNavActions()
  const ordered = orderedFeatures(prefs.order)
  const sort = useSortableList(
    ordered.map((feature) => feature.id),
    (from, to) => actions.moveFeature(ordered[from]!.id, ordered[to]!.id)
  )
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 className="settings-section-title" id={headingId}>
        功能显示
      </h3>
      <ul ref={sort.listRef} className={`shell-manage-list ${sort.listClassName}`} style={sort.listStyle}>
        {ordered.map((feature) => (
          <li
            key={feature.id}
            className={sort.dragging === feature.id ? 'shell-manage-row is-sort-dragging' : 'shell-manage-row'}
            data-sort-key={feature.id}
          >
            <SortHandle sort={sort} itemKey={feature.id} label={feature.label} />
            <label className="shell-check">
              <input
                type="checkbox"
                checked={!prefs.hidden.includes(feature.id)}
                onChange={(event) => actions.setFeatureShown(feature.id, event.target.checked)}
              />
              <Icon name={feature.icon} className="shell-check-icon" />
              <span>{feature.label}</span>
            </label>
          </li>
        ))}
      </ul>
      <SortStatus sort={sort} />
    </section>
  )
}

export function BoardManageSection({ directory }: { directory: BoardDirectory | null }) {
  const headingId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const normalized = query.trim().toLowerCase()
  const filtering = normalized !== ''
  const { prefs, all } = useBoardView(directory)
  const actions = useNavActions()
  const byKey = new Map(all.flatMap((group) => group.boards.map((item) => [item.key, item] as const)))
  const favorites = prefs.favorites.flatMap((key) => {
    const found = byKey.get(key)
    return found === undefined || (filtering && !matches(found.label, normalized)) ? [] : [found]
  })
  const groups = filtering ? matchingGroups(all, normalized) : all
  const nothing = filtering && favorites.length === 0 && groups.length === 0
  const favoriteSort = useSortableList(
    favorites.map((item) => item.key),
    (from, to) => actions.moveFavorite(favorites[from]!.key, favorites[to]!.key)
  )

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 className="settings-section-title" id={headingId}>
        版块管理
      </h3>
      {directory === null && <DirectorySkeleton />}
      {directory !== null && (
        <>
          <div className="shell-picker-field shell-manage-filter">
            <Icon name="search" size={15} />
            <input
              ref={inputRef}
              type="search"
              className="shell-picker-input"
              placeholder="筛选版块"
              aria-label="筛选版块"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          {(!filtering || favorites.length > 0) && (
            <div className="settings-group">
              <h4 className="settings-group-title">收藏</h4>
              {favorites.length === 0 ? (
                <p className="settings-empty">
                  没有收藏的版块
                  <KaomojiDecor state="favoritesEmpty" />
                </p>
              ) : (
                <ul ref={favoriteSort.listRef} className={`shell-manage-list ${favoriteSort.listClassName}`} style={favoriteSort.listStyle}>
                  {favorites.map((item) => (
                    <ManageRow key={item.key} item={item} prefs={prefs} actions={actions} sort={filtering ? null : favoriteSort} />
                  ))}
                </ul>
              )}
              <SortStatus sort={favoriteSort} />
            </div>
          )}
          {groups.map((group) => (
            <ManageGroup key={group.id} group={group} prefs={prefs} actions={actions} filtering={filtering} />
          ))}
          <div className="shell-picker-status" role="status">
            {nothing && <p className="shell-picker-note">没有匹配的版块</p>}
            {nothing && (
              <button
                type="button"
                className="btn btn-quiet btn-small"
                onClick={() => {
                  setQuery('')
                  inputRef.current?.focus()
                }}
              >
                清除筛选
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}

/**
 * A group: collapsible while not filtering; while filtering, its matches shown open. Only forum
 * groups reorder, and not while filtering.
 */
function ManageGroup({ group, prefs, actions, filtering }: { group: BoardGroup; prefs: BoardSettings; actions: Actions; filtering: boolean }) {
  const keys = group.boards.map((item) => item.key)
  const sort = useSortableList(keys, (from, to) => actions.moveBoard(group.id, keys, keys[from]!, keys[to]!))
  const hiddenCount = group.boards.filter((item) => prefs.hidden.includes(item.key)).length
  const reorder = !filtering && isReorderableGroup(group.id)
  const head = (
    <>
      <span className="settings-group-title">{group.title}</span>
      <span className="shell-manage-count">
        {group.boards.length}
        {hiddenCount > 0 && ` · 隐藏 ${hiddenCount}`}
      </span>
    </>
  )
  const list = (
    <>
      <ul ref={sort.listRef} className={`shell-manage-list ${sort.listClassName}`} style={sort.listStyle}>
        {group.boards.map((item) => (
          <ManageRow key={item.key} item={item} prefs={prefs} actions={actions} sort={reorder ? sort : null} />
        ))}
      </ul>
      {reorder && <SortStatus sort={sort} />}
    </>
  )
  if (filtering) {
    return (
      <section className="settings-group shell-manage-group" aria-label={group.title}>
        <div className="shell-manage-summary">{head}</div>
        {list}
      </section>
    )
  }
  return (
    <details className="settings-group shell-manage-group">
      <summary className="shell-manage-summary">
        <Icon name="chevron" size={12} className="shell-chevron" />
        {head}
      </summary>
      {list}
    </details>
  )
}

function ManageRow({
  item,
  prefs,
  actions,
  sort
}: {
  item: Board
  prefs: BoardSettings
  actions: Actions
  /** The list this row sorts in; `null`: no sorting (timelines, filtered list). */
  sort: SortableList | null
}) {
  const favorite = prefs.favorites.includes(item.key)
  const hidden = prefs.hidden.includes(item.key)
  const className = ['shell-manage-row', hidden ? 'is-hidden' : null, sort?.dragging === item.key ? 'is-sort-dragging' : null]
  return (
    <li className={className.filter(Boolean).join(' ')} data-sort-key={sort === null ? undefined : item.key}>
      {sort !== null && <SortHandle sort={sort} itemKey={item.key} label={item.label} />}
      <Icon name={item.icon} className="shell-manage-icon" />
      <span className="shell-manage-label">{item.label}</span>
      <span className="shell-manage-actions">
        <button
          type="button"
          className={favorite ? 'icon-btn shell-manage-star is-on' : 'icon-btn shell-manage-star'}
          aria-pressed={favorite}
          aria-label={`收藏 ${item.label}`}
          title={favorite ? '取消收藏' : '收藏'}
          onClick={() => actions.setFavorite(item.key, !favorite)}
        >
          <Icon name="star" />
        </button>
        <button
          type="button"
          className="btn btn-small btn-page"
          aria-pressed={hidden}
          aria-label={`隐藏 ${item.label}`}
          onClick={() => actions.setBoardsHidden([item.key], !hidden)}
        >
          {hidden ? '已隐藏' : '隐藏'}
        </button>
      </span>
    </li>
  )
}
