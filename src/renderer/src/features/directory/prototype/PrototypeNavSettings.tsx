// PROTOTYPE (throwaway): the settings page's 功能显示 (show / hide each rail feature, 上移 / 下移 in
// the rail order) and 版块管理 (filter, favorite, hide, reorder boards) sections.

import { useId, useRef, useState } from 'react'
import type { BoardDirectory } from '../../../../../shared/forum'
import { Icon } from '../../../components/Icon'
import { Loading } from '../../../components/Notices'
import { matches, matchingGroups } from './PrototypeBoardPicker'
import { useBoardView } from './PrototypeNavParts'
import { navActions, orderedFeatures, useNavPrefs, type Board, type BoardGroup, type NavPrefs } from './prototypeStore'

export function FeatureVisibilitySection() {
  const headingId = useId()
  const prefs = useNavPrefs()
  const ordered = orderedFeatures(prefs.featureOrder)
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 className="settings-section-title" id={headingId}>
        功能显示
      </h3>
      <ul className="proto-manage-list">
        {ordered.map((feature, index) => (
          <li key={feature.id} className="proto-manage-row">
            <label className="proto-check">
              <input
                type="checkbox"
                checked={!prefs.hiddenFeatures.includes(feature.id)}
                onChange={(event) => navActions.setFeatureShown(feature.id, event.target.checked)}
              />
              <Icon name={feature.icon} className="proto-check-icon" />
              <span>{feature.label}</span>
            </label>
            <span className="proto-manage-actions">
              <MoveButtons
                label={feature.label}
                first={index === 0}
                last={index === ordered.length - 1}
                onMove={(delta) => navActions.moveFeature(feature.id, delta)}
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
      {directory === null && <Loading>正在读取版面目录…</Loading>}
      {directory !== null && (
        <>
          <div className="proto-picker-field proto-manage-filter">
            <Icon name="search" size={15} />
            <input
              ref={inputRef}
              type="search"
              className="proto-picker-input"
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
                <ul className="proto-manage-list">
                  {favorites.map((item, index) => (
                    <ManageRow
                      key={item.key}
                      item={item}
                      prefs={prefs}
                      move={
                        filtering
                          ? null
                          : { first: index === 0, last: index === favorites.length - 1, onMove: (delta) => navActions.moveFavorite(item.key, delta) }
                      }
                    />
                  ))}
                </ul>
              )}
            </div>
          )}
          {groups.map((group) => (
            <ManageGroup key={group.id} group={group} prefs={prefs} filtering={filtering} />
          ))}
          <div className="proto-picker-status" role="status">
            {nothing && <p className="proto-picker-note">没有匹配的版块</p>}
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

/** A group: collapsible while not filtering; while filtering, its matches shown open, without reordering. */
function ManageGroup({ group, prefs, filtering }: { group: BoardGroup; prefs: NavPrefs; filtering: boolean }) {
  const keys = group.boards.map((item) => item.key)
  const hiddenCount = group.boards.filter((item) => prefs.hiddenBoards.includes(item.key)).length
  const head = (
    <>
      <span className="settings-group-title">{group.title}</span>
      <span className="proto-manage-count">
        {group.boards.length}
        {hiddenCount > 0 && ` · 隐藏 ${hiddenCount}`}
      </span>
    </>
  )
  const list = (
    <ul className="proto-manage-list">
      {group.boards.map((item, index) => (
        <ManageRow
          key={item.key}
          item={item}
          prefs={prefs}
          move={
            filtering
              ? null
              : { first: index === 0, last: index === group.boards.length - 1, onMove: (delta) => navActions.moveBoard(group.id, keys, item.key, delta) }
          }
        />
      ))}
    </ul>
  )
  if (filtering) {
    return (
      <section className="settings-group proto-manage-group" aria-label={group.title}>
        <div className="proto-manage-summary">{head}</div>
        {list}
      </section>
    )
  }
  return (
    <details className="settings-group proto-manage-group">
      <summary className="proto-manage-summary">
        <Icon name="chevron" size={12} className="proto-chevron" />
        {head}
      </summary>
      {list}
    </details>
  )
}

function ManageRow({
  item,
  prefs,
  move
}: {
  item: Board
  prefs: NavPrefs
  /** `null`: no reordering (filtered list). */
  move: { first: boolean; last: boolean; onMove: (delta: -1 | 1) => void } | null
}) {
  const favorite = prefs.favorites.includes(item.key)
  const hidden = prefs.hiddenBoards.includes(item.key)
  return (
    <li className={hidden ? 'proto-manage-row is-hidden' : 'proto-manage-row'}>
      <Icon name={item.icon} className="proto-manage-icon" />
      <span className="proto-manage-label">{item.label}</span>
      <span className="proto-manage-actions">
        <button
          type="button"
          className={favorite ? 'icon-btn proto-manage-star is-on' : 'icon-btn proto-manage-star'}
          aria-pressed={favorite}
          aria-label={`收藏 ${item.label}`}
          title={favorite ? '取消收藏' : '收藏'}
          onClick={() => navActions.setFavorite(item.key, !favorite)}
        >
          <Icon name="star" />
        </button>
        <button
          type="button"
          className="btn btn-small"
          aria-pressed={hidden}
          aria-label={`隐藏 ${item.label}`}
          onClick={() => navActions.setBoardHidden(item.key, !hidden)}
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
        className="icon-btn proto-flip"
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
