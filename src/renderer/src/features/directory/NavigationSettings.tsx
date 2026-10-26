// The settings page's 功能显示 (show / hide each rail feature, 上移 / 下移 in the rail order) and
// 版块管理 (filter, favorite, hide, reorder boards within forum groups; timelines keep their order).

import { useId, useRef, useState } from 'react'
import type { BoardDirectory } from '../../../../shared/forum'
import type { BoardSettings } from '../../../../shared/settings'
import { Icon } from '../../components/Icon'
import { useSettings } from '../../lib/settingsContext'
import { matches, matchingGroups } from './BoardPicker'
import { DirectorySkeleton, useBoardView } from './navParts'
import { isReorderableGroup, orderedFeatures, useNavActions, type Board, type BoardGroup, type NavActions as Actions } from './navStore'

export function FeatureVisibilitySection() {
  const headingId = useId()
  const prefs = useSettings().settings.rail
  const actions = useNavActions()
  const ordered = orderedFeatures(prefs.order)
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 className="settings-section-title" id={headingId}>
        功能显示
      </h3>
      <ul className="shell-manage-list">
        {ordered.map((feature, index) => (
          <li key={feature.id} className="shell-manage-row">
            <label className="shell-check">
              <input
                type="checkbox"
                checked={!prefs.hidden.includes(feature.id)}
                onChange={(event) => actions.setFeatureShown(feature.id, event.target.checked)}
              />
              <Icon name={feature.icon} className="shell-check-icon" />
              <span>{feature.label}</span>
            </label>
            <span className="shell-manage-actions">
              <MoveButtons
                label={feature.label}
                first={index === 0}
                last={index === ordered.length - 1}
                onMove={(delta) => actions.moveFeature(feature.id, delta)}
              />
            </span>
          </li>
        ))}
      </ul>
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
                <p className="settings-empty">没有收藏的版块</p>
              ) : (
                <ul className="shell-manage-list">
                  {favorites.map((item, index) => (
                    <ManageRow
                      key={item.key}
                      item={item}
                      prefs={prefs}
                      actions={actions}
                      move={
                        filtering
                          ? null
                          : { first: index === 0, last: index === favorites.length - 1, onMove: (delta) => actions.moveFavorite(item.key, delta) }
                      }
                    />
                  ))}
                </ul>
              )}
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
    <ul className="shell-manage-list">
      {group.boards.map((item, index) => (
        <ManageRow
          key={item.key}
          item={item}
          prefs={prefs}
          actions={actions}
          move={
            reorder
              ? { first: index === 0, last: index === group.boards.length - 1, onMove: (delta) => actions.moveBoard(group.id, keys, item.key, delta) }
              : null
          }
        />
      ))}
    </ul>
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
  move
}: {
  item: Board
  prefs: BoardSettings
  actions: Actions
  /** `null`: no reordering (timelines, filtered list). */
  move: { first: boolean; last: boolean; onMove: (delta: -1 | 1) => void } | null
}) {
  const favorite = prefs.favorites.includes(item.key)
  const hidden = prefs.hidden.includes(item.key)
  return (
    <li className={hidden ? 'shell-manage-row is-hidden' : 'shell-manage-row'}>
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
          className="btn btn-small"
          aria-pressed={hidden}
          aria-label={`隐藏 ${item.label}`}
          onClick={() => actions.setBoardsHidden([item.key], !hidden)}
        >
          {hidden ? '已隐藏' : '隐藏'}
        </button>
        {move !== null && <MoveButtons label={item.label} first={move.first} last={move.last} onMove={move.onMove} />}
      </span>
    </li>
  )
}

function MoveButtons({ label, first, last, onMove }: { label: string; first: boolean; last: boolean; onMove: (delta: -1 | 1) => void }) {
  return (
    <>
      <button
        type="button"
        className="icon-btn"
        aria-label={`上移 ${label}`}
        title="上移"
        aria-disabled={first ? true : undefined}
        onClick={() => !first && onMove(-1)}
      >
        <Icon name="arrowUp" />
      </button>
      <button
        type="button"
        className="icon-btn shell-flip"
        aria-label={`下移 ${label}`}
        title="下移"
        aria-disabled={last ? true : undefined}
        onClick={() => !last && onMove(1)}
      >
        <Icon name="arrowUp" />
      </button>
    </>
  )
}
