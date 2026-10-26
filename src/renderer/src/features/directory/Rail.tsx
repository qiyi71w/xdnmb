// The icon rail: 版块 on top (it opens the board panel) with up to five favorite boards under it,
// the shown features in the saved order (drag one to move it; Esc or leaving the window cancels),
// then 更多 (only the hidden features, absent when none are hidden) and 设置 at the bottom. Every
// button names itself in a tooltip shortly after a hover or keyboard focus; the name of the current
// item is announced when it changes. Order and visibility are app settings (`rail`).

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject
} from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../components/Icon'
import { useSettings } from '../../lib/settingsContext'
import { usePopover } from '../../lib/usePopover'
import { useRovingFocus } from '../../lib/useRovingFocus'
import type { ListRef } from '../tabs/tabsState'
import { FeatureDot, featureInfo, featureIsDialog, featureLabel, featureTitle, GridIcon, type FeatureHost } from './navParts'
import { orderedFeatures, useNavActions, type Board, type FeatureId } from './navStore'

/** Width of the rail, CSS pixels (App widens the navigation column by it). */
export const RAIL_WIDTH = 52

/** Favorite boards shown in the rail; the rest stay in the board panel's 收藏. */
const RAIL_FAVORITES = 5

const BOARDS_KEY = 'boards'
const MORE_KEY = 'more'
const SETTINGS_KEY = 'settings'
const favoriteKey = (key: string) => `fav:${key}`

/** The 版块 button on top of the rail: opens the board panel. */
export interface RailBoards {
  /** Whether the panel is open, and its element id. */
  popup: { expanded: boolean; controls: string }
  onClick: (button: HTMLButtonElement) => void
}

/** Favorite boards under the 版块 button. */
export interface RailFavorites {
  /** Favorites in their order, hidden boards left out; the first five are shown. */
  boards: readonly Board[]
  selectedKey: string | null
  onSelect: (ref: ListRef) => void
}

/** First character of each name; the first two for names whose first characters collide. */
function favoriteMarks(boards: readonly Board[]): string[] {
  const chars = boards.map((item) => Array.from(item.label.trim()))
  const firsts = chars.map((name) => name[0] ?? '')
  return chars.map((name, index) => (firsts.filter((first) => first === firsts[index]).length > 1 ? name.slice(0, 2).join('') : firsts[index]!))
}

export function Rail({
  features,
  settingsCurrent,
  onOpenSettings,
  boards,
  favorites
}: {
  features: FeatureHost
  settingsCurrent: boolean
  onOpenSettings: () => void
  boards: RailBoards
  favorites: RailFavorites
}) {
  const prefs = useSettings().settings.rail
  const actions = useNavActions()
  const ordered = orderedFeatures(prefs.order)
  const shown = ordered.filter((feature) => !prefs.hidden.includes(feature.id))
  const hidden = ordered.filter((feature) => prefs.hidden.includes(feature.id))
  const railFavorites = favorites.boards.slice(0, RAIL_FAVORITES)
  const marks = favoriteMarks(railFavorites)

  const railRef = useRef<HTMLDivElement>(null)
  const moreTriggerRef = useRef<HTMLButtonElement>(null)
  const morePanelRef = useRef<HTMLDivElement>(null)
  const morePopover = usePopover(moreTriggerRef, morePanelRef)
  const { close: closeMore } = morePopover
  const hasMore = hidden.length > 0

  // Showing the last hidden feature removes 更多: its panel goes with it.
  useEffect(() => {
    if (!hasMore) closeMore(false)
  }, [hasMore, closeMore])

  const railIds = [
    BOARDS_KEY,
    ...railFavorites.map((item) => favoriteKey(item.key)),
    ...shown.map((feature) => feature.id),
    ...(hasMore ? [MORE_KEY] : []),
    SETTINGS_KEY
  ]
  const selectedFavorite = railFavorites.find((item) => item.key === favorites.selectedKey)
  const railCurrent = settingsCurrent
    ? SETTINGS_KEY
    : (features.current ?? (selectedFavorite === undefined ? null : favoriteKey(selectedFavorite.key)))
  const rail = useRovingFocus(railIds, railCurrent)

  // The current item's name, announced when it changes (not on first render).
  const currentName = settingsCurrent ? '设置' : features.current !== null ? featureInfo(features.current).label : (selectedFavorite?.label ?? null)
  const [announced, setAnnounced] = useState({ name: currentName, text: '' })
  if (announced.name !== currentName) setAnnounced({ name: currentName, text: currentName === null ? '' : `当前：${currentName}` })

  const tip = useRailTip()
  const drag = useRailDrag(railRef, tip.hide, actions.placeFeature)

  return (
    <>
      <div
        ref={railRef}
        className={drag.dragging === null ? 'shell-rail' : 'shell-rail is-dragging'}
        role="toolbar"
        aria-label="功能"
        aria-orientation="vertical"
        onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
          tip.hide()
          rail.onKeyDown(event)
        }}
        onPointerOver={tip.onPointerOver}
        onPointerOut={tip.onPointerOut}
        onPointerDown={tip.hide}
        onFocus={tip.onFocus}
        onBlur={tip.hide}
        onScroll={tip.hide}
      >
        <button
          type="button"
          className={boards.popup.expanded ? 'shell-rail-btn is-open' : 'shell-rail-btn'}
          aria-label="版块"
          data-rail-tip="版块"
          aria-haspopup="dialog"
          aria-expanded={boards.popup.expanded}
          aria-controls={boards.popup.expanded ? boards.popup.controls : undefined}
          data-boards-trigger=""
          onClick={(event) => boards.onClick(event.currentTarget)}
          {...rail.itemProps(BOARDS_KEY)}
        >
          <Icon name="forum" size={18} />
        </button>
        {railFavorites.map((item, index) => {
          const current = item.key === favorites.selectedKey
          const mark = marks[index]!
          return (
            <button
              key={item.key}
              type="button"
              className={['shell-rail-btn', 'shell-rail-fav', current ? 'is-current' : '', Array.from(mark).length > 1 ? 'is-pair' : '']
                .filter(Boolean)
                .join(' ')}
              aria-label={item.label}
              aria-current={current ? 'page' : undefined}
              data-rail-tip={item.label}
              data-rail-board=""
              onClick={() => favorites.onSelect(item.ref)}
              {...rail.itemProps(favoriteKey(item.key))}
            >
              <span aria-hidden="true">{mark}</span>
            </button>
          )
        })}
        <span className="shell-rail-sep" aria-hidden="true" />
        {shown.map((feature) => {
          const current = features.current === feature.id
          return (
            <button
              key={feature.id}
              type="button"
              className={['shell-rail-btn', current ? 'is-current' : '', drag.dragging === feature.id ? 'is-dragging' : '']
                .filter(Boolean)
                .join(' ')}
              aria-current={current ? 'page' : undefined}
              aria-haspopup={featureIsDialog(feature.id) ? 'dialog' : undefined}
              aria-label={featureLabel(feature.id, features)}
              data-rail-tip={featureTitle(feature.id, features)}
              data-rail-feature={feature.id}
              onPointerDown={(event) => drag.onPointerDown(event, feature.id)}
              onPointerMove={drag.onPointerMove}
              onPointerUp={drag.onPointerUp}
              onPointerCancel={drag.cancel}
              onClick={() => {
                if (!drag.consumeClick()) features.open(feature.id)
              }}
              {...rail.itemProps(feature.id)}
            >
              <Icon name={feature.icon} size={18} />
              <FeatureDot id={feature.id} host={features} />
            </button>
          )
        })}
        {drag.dropTop !== null && <span className="shell-rail-drop" style={{ top: drag.dropTop }} aria-hidden="true" />}
        <span className="shell-rail-gap" />
        {hasMore && (
          <button
            ref={moreTriggerRef}
            type="button"
            className={morePopover.open ? 'shell-rail-btn is-open' : 'shell-rail-btn'}
            aria-label="更多"
            data-rail-tip="更多"
            aria-haspopup="dialog"
            aria-expanded={morePopover.open}
            aria-controls={morePopover.open ? 'shell-all' : undefined}
            onClick={morePopover.toggle}
            {...rail.itemProps(MORE_KEY)}
          >
            <GridIcon />
          </button>
        )}
        <button
          type="button"
          className={settingsCurrent ? 'shell-rail-btn is-current' : 'shell-rail-btn'}
          aria-current={settingsCurrent ? 'page' : undefined}
          aria-label="设置"
          data-settings-entry=""
          data-rail-tip="设置"
          onClick={onOpenSettings}
          {...rail.itemProps(SETTINGS_KEY)}
        >
          <Icon name="settings" size={18} />
        </button>
        <span className="visually-hidden" role="status">
          {announced.text}
        </span>
      </div>

      {hasMore && morePopover.open && (
        <div ref={morePanelRef} id="shell-all" className="shell-pop shell-all-panel" role="dialog" aria-labelledby="shell-all-title">
          <h2 className="shell-all-title" id="shell-all-title">
            更多
          </h2>
          <div className="shell-all-grid">
            {hidden.map((feature) => (
              <button
                key={feature.id}
                type="button"
                className="shell-all-item"
                aria-label={featureLabel(feature.id, features)}
                onClick={() => {
                  // A dialog takes focus and later returns it to its opener: leave that on 更多.
                  // A list replaces this panel's place: it takes focus itself.
                  if (featureIsDialog(feature.id)) {
                    morePopover.close()
                    features.open(feature.id)
                  } else {
                    morePopover.close(false)
                    features.open(feature.id, true)
                  }
                }}
              >
                <span className="shell-all-icon">
                  <Icon name={feature.icon} size={20} />
                  <FeatureDot id={feature.id} host={features} />
                </span>
                <span>{feature.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {tip.shown !== null &&
        createPortal(
          <div className="shell-rail-tip" style={{ left: tip.shown.x, top: tip.shown.y }} aria-hidden="true">
            {tip.shown.text}
          </div>,
          document.body
        )}
    </>
  )
}

// ---------- Tooltip ----------

/** Hover or keyboard focus this long before the tooltip shows. */
const TIP_DELAY = 450
/** Within this long after a tooltip hid, the next one shows at once (moving along the rail). */
const TIP_WARM = 300

/**
 * One tooltip for the rail's `[data-rail-tip]` buttons, beside the button. Its text repeats the
 * button's accessible name, so it is hidden from assistive technology. Esc, a press, a key, blur,
 * scrolling or the pointer leaving hides it.
 */
function useRailTip() {
  const [shown, setShown] = useState<{ text: string; x: number; y: number } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const at = useRef<HTMLElement | null>(null)
  const visible = useRef(false)
  const warmUntil = useRef(0)

  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    if (visible.current) warmUntil.current = performance.now() + TIP_WARM
    visible.current = false
    at.current = null
    setShown(null)
  }, [])

  const schedule = useCallback(
    (button: HTMLElement) => {
      if (at.current === button) return
      hide()
      at.current = button
      const show = () => {
        if (!button.isConnected || at.current !== button) return
        const rect = button.getBoundingClientRect()
        visible.current = true
        setShown({ text: button.dataset.railTip ?? '', x: rect.right + 8, y: rect.top + rect.height / 2 })
      }
      if (performance.now() < warmUntil.current) show()
      else timer.current = window.setTimeout(show, TIP_DELAY)
    },
    [hide]
  )

  useEffect(() => () => window.clearTimeout(timer.current), [])

  // Esc dismisses it without taking the key from anything else.
  useEffect(() => {
    if (shown === null) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') hide()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [shown, hide])

  const tipButton = (target: EventTarget | null) => (target instanceof Element ? target.closest<HTMLElement>('[data-rail-tip]') : null)

  return {
    shown,
    hide,
    onPointerOver(event: PointerEvent<HTMLElement>) {
      if (event.pointerType !== 'mouse' || event.buttons !== 0) return
      const button = tipButton(event.target)
      if (button !== null) schedule(button)
    },
    onPointerOut(event: PointerEvent<HTMLElement>) {
      const button = tipButton(event.target)
      if (button !== null && !(event.relatedTarget instanceof Node && button.contains(event.relatedTarget))) hide()
    },
    onFocus(event: FocusEvent<HTMLElement>) {
      const button = tipButton(event.target)
      if (button !== null && button.matches(':focus-visible')) schedule(button)
    }
  }
}

// ---------- Drag to reorder ----------

/** The pointer moves this far (CSS pixels) before a press on a feature becomes a drag. */
const DRAG_THRESHOLD = 5

interface DragPress {
  id: FeatureId
  pointerId: number
  startY: number
  button: HTMLElement
  started: boolean
  cancelled: boolean
}

/**
 * Dragging a feature button along the rail: a line shows where it will go, release puts it there
 * (`place`, saved to the settings). Esc, the window losing focus or a cancelled pointer leave the
 * order as it was. The click that ends a drag does not open the feature.
 */
function useRailDrag(railRef: RefObject<HTMLDivElement | null>, onStart: () => void, place: (id: FeatureId, before: FeatureId | null) => void) {
  const press = useRef<DragPress | null>(null)
  const [dragging, setDragging] = useState<FeatureId | null>(null)
  const [drop, setDrop] = useState<{ before: FeatureId | null; top: number } | null>(null)
  const swallowClick = useRef(false)

  /** Where a drop at `y` puts `id`: before which shown feature, and the line's offset; `null` when nothing would change. */
  const dropAt = (id: FeatureId, y: number) => {
    const rail = railRef.current
    if (rail === null) return null
    const buttons = [...rail.querySelectorAll<HTMLElement>('[data-rail-feature]')]
    const ids = buttons.map((button) => button.dataset.railFeature as FeatureId)
    const index = buttons.findIndex((button) => {
      const rect = button.getBoundingClientRect()
      return y < rect.top + rect.height / 2
    })
    const from = ids.indexOf(id)
    if (index === from || index === from + 1 || (index < 0 && from === ids.length - 1)) return null
    const origin = rail.getBoundingClientRect().top - rail.scrollTop
    const top = index < 0 ? buttons.at(-1)!.getBoundingClientRect().bottom - origin : buttons[index]!.getBoundingClientRect().top - origin - 2
    return { before: index < 0 ? null : ids[index]!, top }
  }

  const cancel = useCallback(() => {
    const current = press.current
    if (current !== null) {
      current.cancelled = true
      if (current.button.hasPointerCapture(current.pointerId)) current.button.releasePointerCapture(current.pointerId)
    }
    setDragging(null)
    setDrop(null)
  }, [])

  useEffect(() => {
    if (dragging === null) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', cancel)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', cancel)
    }
  }, [dragging, cancel])

  return {
    dragging,
    dropTop: drop?.top ?? null,
    cancel,
    onPointerDown(event: PointerEvent<HTMLElement>, id: FeatureId) {
      swallowClick.current = false
      press.current =
        event.button === 0
          ? { id, pointerId: event.pointerId, startY: event.clientY, button: event.currentTarget, started: false, cancelled: false }
          : null
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      const current = press.current
      if (current === null || current.pointerId !== event.pointerId || current.cancelled) return
      if (!current.started) {
        if (Math.abs(event.clientY - current.startY) < DRAG_THRESHOLD) return
        current.started = true
        current.button.setPointerCapture(event.pointerId)
        onStart()
        setDragging(current.id)
      }
      setDrop(dropAt(current.id, event.clientY))
    },
    onPointerUp(event: PointerEvent<HTMLElement>) {
      const current = press.current
      if (current === null || current.pointerId !== event.pointerId) return
      press.current = null
      if (!current.started) return
      swallowClick.current = true
      if (!current.cancelled) {
        const target = dropAt(current.id, event.clientY)
        if (target !== null) place(current.id, target.before)
      }
      setDragging(null)
      setDrop(null)
    },
    /** True when this click ends a drag (and must not open the feature). */
    consumeClick(): boolean {
      const ended = swallowClick.current || press.current?.started === true
      swallowClick.current = false
      if (press.current?.started === true) press.current = null
      return ended
    }
  }
}
