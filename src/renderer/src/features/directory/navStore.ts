// Navigation state of the icon rail and its board panel: the panel's open transaction and focus,
// compose-panel openers, what the shell adds to the tab content, and the rail / board preferences.
// The preferences live in the app settings (`rail`, `boards`) and are changed through
// `useNavActions`, which builds every patch from the latest settings.

import { createContext, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { BoardDirectory } from '../../../../shared/forum'
import { RAIL_FEATURES, type BoardSettings, type RailFeature, type RailSettings } from '../../../../shared/settings'
import type { IconName } from '../../components/Icon'
import { moveKey } from '../../lib/reorder'
import { useSettings } from '../../lib/settingsContext'
import { listKey, type ListRef } from '../tabs/tabsState'

// ---------- Small shared UI state ----------

function cell<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }
  return {
    get: () => value,
    set(next: T) {
      if (Object.is(next, value)) return
      value = next
      for (const listener of listeners) listener()
    },
    use: () => useSyncExternalStore(subscribe, () => value)
  }
}

/**
 * The board panel. One open transaction at a time, and `closeBoardPanel` alone decides where focus
 * goes when it ends: the opener is remembered as it really was when it opened.
 */
const boardPanel = cell(false)
let boardPanelOpener: HTMLElement | null = null

export const useBoardPanelOpen = boardPanel.use

/** The board panel's element id (its triggers' `aria-controls`). */
export const BOARD_PANEL_ID = 'board-panel'

/**
 * How the board panel closed:
 * - `cancel`: Esc, 关闭, a press outside, or a trigger again — focus returns to the opener;
 * - `select`: a board was chosen — focus goes to the new list's board name;
 * - `leave`: focus moved out by itself (Tab) — it stays where it went;
 * - `dismiss`: what holds it went away (overlay closed, layout switched) — focus untouched.
 * Without a visible target, focus goes to the host's `home`.
 */
export type BoardPanelEnd = 'cancel' | 'select' | 'leave' | 'dismiss'

/** What the app provides around the panel (App registers it). */
export interface BoardPanelHost {
  /** The visible, stable way back to the boards: 打开导航 (overlay layout) or the rail's 版块 button. */
  home(): HTMLElement | null
  /**
   * The panel just closed, before focus moves. `at`: the pressed element (cancel by a press outside)
   * or where focus went (leave); `null` otherwise.
   */
  closed(end: BoardPanelEnd, at: Element | null): void
}

let boardPanelHost: BoardPanelHost | null = null

export function setBoardPanelHost(host: BoardPanelHost | null): void {
  boardPanelHost = host
}

export function openBoardPanel(opener: HTMLElement | null): void {
  boardPanelOpener = opener
  boardPanel.set(true)
}

export function closeBoardPanel(end: BoardPanelEnd, at: Element | null = null): void {
  if (!boardPanel.get()) return
  boardPanel.set(false)
  const opener = boardPanelOpener
  boardPanelOpener = null
  const host = boardPanelHost
  host?.closed(end, at)
  if (end === 'cancel') {
    focusShown(opener, host)
  } else if (end === 'select') {
    // The chosen list replaces the shown one in this commit; its board name exists from the next frame.
    requestAnimationFrame(() => focusShown(document.querySelector<HTMLElement>('.tab-panel:not([hidden]) [data-board-title]'), host))
  }
}

/** In the document and laid out: a focus target the user can see (not `hidden`, not unmounted). */
export function isShown(element: Element | null | undefined): element is HTMLElement {
  return element instanceof HTMLElement && element.isConnected && element.getClientRects().length > 0
}

/** Focuses `target` when it is shown, else the host's home. */
function focusShown(target: HTMLElement | null, host: BoardPanelHost | null): void {
  if (isShown(target)) target.focus()
  else {
    const home = host?.home()
    if (isShown(home)) home.focus()
  }
}

// ---------- Editor panel ----------

/** The control that last opened each editor panel, by `focusKey`: focus goes back there on 收起. */
const composeOpeners = new Map<string, HTMLElement>()

export function rememberComposeOpener(key: string, opener: HTMLElement): void {
  composeOpeners.set(key, opener)
}

/**
 * Focus after a panel closed: its opener when still shown, else the target's own 回复 / 发新串
 * entry (`data-compose-key`), else the shown content pane of the active tab.
 */
export function returnComposeFocus(key: string): void {
  const opener = composeOpeners.get(key)
  composeOpeners.delete(key)
  const entry = document.querySelector<HTMLElement>(`.tab-panel:not([hidden]) [data-compose-key="${CSS.escape(key)}"]`)
  const panes = [...document.querySelectorAll<HTMLElement>('.tab-panel:not([hidden]) [data-pane-focus]')]
  const target = [opener, entry, ...panes].find((element) => isShown(element))
  target?.focus({ preventScroll: true })
}

// ---------- List slots ----------

/** What the shell adds to the tab content: ways into the board panel. */
export interface ListHost {
  /** The board name at the top of a board list, as a button opening the board panel. */
  boardTitle: (name: string) => ReactNode
  /** The page of a tab without a list (or whose board left the directory): a way to the boards. */
  emptyPage: (title?: string) => ReactNode
}

export const ListHostContext = createContext<ListHost | null>(null)

// ---------- Features ----------

export type FeatureId = RailFeature

export const FEATURES: readonly { id: FeatureId; label: string; icon: IconName }[] = [
  { id: 'subscriptions', label: '订阅', icon: 'bookmark' },
  { id: 'reminders', label: '提醒', icon: 'bell' },
  { id: 'search', label: '搜索', icon: 'search' },
  { id: 'history', label: '历史', icon: 'history' },
  { id: 'offline', label: '离线', icon: 'download' },
  { id: 'drafts', label: '草稿', icon: 'draft' }
]

/** FEATURES in the saved rail order; features missing from it keep their default place after it. */
export function orderedFeatures(order: readonly FeatureId[]): (typeof FEATURES)[number][] {
  const rank = new Map(order.map((id, index) => [id, index]))
  return [...FEATURES].sort(
    (a, b) => (rank.get(a.id) ?? order.length + RAIL_FEATURES.indexOf(a.id)) - (rank.get(b.id) ?? order.length + RAIL_FEATURES.indexOf(b.id))
  )
}

// ---------- Preferences ----------

function toggled<T>(list: readonly T[], value: T, on: boolean): T[] {
  const without = list.filter((item) => item !== value)
  return on ? [...without, value] : without
}

/** Only forum groups take a custom board order; timelines keep the directory order. */
export function isReorderableGroup(groupId: string): boolean {
  return groupId.startsWith('group-')
}

/** Changes to the rail and board preferences, each saved to the settings at once. */
export interface NavActions {
  setFeatureShown(id: FeatureId, shown: boolean): void
  /** Moves a feature into `target`'s place in the rail order (hidden features count as places). */
  moveFeature(id: FeatureId, target: FeatureId): void
  /** Puts a feature right before `before` in the rail order, or last when `before` is `null`. */
  placeFeature(id: FeatureId, before: FeatureId | null): void
  setFavorite(key: string, favorite: boolean): void
  /** Moves a favorite into `target`'s place in the favorites order. */
  moveFavorite(key: string, target: string): void
  setBoardsHidden(keys: readonly string[], hidden: boolean): void
  setCollapsed(groupIds: readonly string[], collapsed: boolean): void
  /** Moves a board into `target`'s place within its forum group; `keys` is the group's current display order. */
  moveBoard(groupId: string, keys: readonly string[], key: string, target: string): void
}

export function useNavActions(): NavActions {
  const { latest, write } = useSettings()
  return useMemo<NavActions>(() => {
    const rail = (next: Partial<RailSettings>) => write({ rail: { ...latest().rail, ...next } })
    const boards = (next: Partial<BoardSettings>) => write({ boards: { ...latest().boards, ...next } })
    const featureIds = () => orderedFeatures(latest().rail.order).map((feature) => feature.id)
    return {
      setFeatureShown(id: FeatureId, shown: boolean) {
        rail({ hidden: toggled(latest().rail.hidden, id, !shown) })
      },
      moveFeature(id: FeatureId, target: FeatureId) {
        const order = moveKey(featureIds(), id, target)
        if (order !== null) rail({ order })
      },
      /** Puts a feature right before `before` in the rail order, or last when `before` is `null`. */
      placeFeature(id: FeatureId, before: FeatureId | null) {
        if (id === before) return
        const ids = featureIds().filter((item) => item !== id)
        const at = before === null ? -1 : ids.indexOf(before)
        ids.splice(at < 0 ? ids.length : at, 0, id)
        rail({ order: ids })
      },
      setFavorite(key: string, favorite: boolean) {
        boards({ favorites: toggled(latest().boards.favorites, key, favorite) })
      },
      moveFavorite(key: string, target: string) {
        const favorites = moveKey(latest().boards.favorites, key, target)
        if (favorites !== null) boards({ favorites })
      },
      setBoardsHidden(keys: readonly string[], hidden: boolean) {
        const set = new Set(latest().boards.hidden)
        for (const key of keys) {
          if (hidden) set.add(key)
          else set.delete(key)
        }
        boards({ hidden: [...set] })
      },
      setCollapsed(groupIds: readonly string[], collapsed: boolean) {
        const set = new Set(latest().boards.collapsed)
        for (const id of groupIds) {
          if (collapsed) set.add(id)
          else set.delete(id)
        }
        boards({ collapsed: [...set] })
      },
      moveBoard(groupId: string, keys: readonly string[], key: string, target: string) {
        const order = isReorderableGroup(groupId) ? moveKey(keys, key, target) : null
        if (order !== null) boards({ order: { ...latest().boards.order, [groupId]: order } })
      }
    }
  }, [latest, write])
}

// ---------- Boards ----------

export interface Board {
  key: string
  ref: ListRef
  label: string
  icon: IconName
}

export interface BoardGroup {
  id: string
  title: string
  /** Every board of the group in its order, hidden and favorite ones included. */
  boards: Board[]
}

/** Timelines first (directory order), then the forum groups, each in the custom order. */
export function boardGroups(directory: BoardDirectory | null, order: BoardSettings['order']): BoardGroup[] {
  if (directory === null) return []
  const groups: BoardGroup[] = []
  if (directory.timelines.length > 0) {
    groups.push({
      id: 'timelines',
      title: '时间线',
      boards: directory.timelines.map((timeline) => board({ kind: 'timeline', id: timeline.id }, timeline.displayName))
    })
  }
  for (const group of directory.groups) {
    if (group.forums.length === 0) continue
    const id = `group-${group.id}`
    groups.push({
      id,
      title: group.name,
      boards: ordered(
        group.forums.map((forum) => board({ kind: 'forum', id: forum.id }, forum.displayName)),
        order[id]
      )
    })
  }
  return groups
}

function board(ref: ListRef, label: string): Board {
  return { key: listKey(ref), ref, label, icon: ref.kind === 'timeline' ? 'timeline' : 'forum' }
}

function ordered(boards: Board[], keys: readonly string[] | undefined): Board[] {
  if (keys === undefined) return boards
  const rank = new Map(keys.map((key, index) => [key, index]))
  return [...boards].sort((a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity))
}

export interface BoardView {
  favorites: Board[]
  /** Groups with their visible, non-favorite boards; empty groups left out. */
  groups: BoardGroup[]
}

/** What the navigation lists: favorites on top (in their order), hidden boards nowhere. */
export function visibleBoards(all: BoardGroup[], prefs: BoardSettings): BoardView {
  const hidden = new Set(prefs.hidden)
  const favorite = new Set(prefs.favorites)
  const byKey = new Map(all.flatMap((group) => group.boards.map((item) => [item.key, item] as const)))
  const favorites = prefs.favorites.flatMap((key) => {
    const found = byKey.get(key)
    return found === undefined || hidden.has(key) ? [] : [found]
  })
  const groups = all
    .map((group) => ({ ...group, boards: group.boards.filter((item) => !hidden.has(item.key) && !favorite.has(item.key)) }))
    .filter((group) => group.boards.length > 0)
  return { favorites, groups }
}

/** The hidden boards, still in their groups (empty groups left out). */
export function hiddenBoardGroups(all: BoardGroup[], prefs: BoardSettings): BoardGroup[] {
  const hidden = new Set(prefs.hidden)
  return all
    .map((group) => ({ ...group, boards: group.boards.filter((item) => hidden.has(item.key)) }))
    .filter((group) => group.boards.length > 0)
}
