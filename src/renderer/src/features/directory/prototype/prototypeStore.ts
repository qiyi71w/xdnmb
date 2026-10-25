// PROTOTYPE (throwaway): three variants of the navigation and settings page, switchable in the
// running app with the floating bar (components/PrototypeSwitcher.tsx). Built only with
// VITE_XIDAO_PROTOTYPE=1. Feature visibility and board favorites / hiding / order / collapsing live
// in memory only; a restart forgets them on purpose. The chosen variant is kept in localStorage.

import { useSyncExternalStore } from 'react'
import type { BoardDirectory } from '../../../../../shared/forum'
import type { IconName } from '../../../components/Icon'
import { listKey, type ListRef } from '../../tabs/tabsState'

export const PROTOTYPE_ENABLED = import.meta.env.VITE_XIDAO_PROTOTYPE === '1'

// ---------- Variant ----------

export type NavVariant = 'A' | 'B' | 'C'

export const NAV_VARIANTS: readonly { key: NavVariant; name: string }[] = [
  { key: 'A', name: '单栏分组' },
  { key: 'B', name: '图标栏' },
  { key: 'C', name: '版块优先' }
]

const VARIANT_KEY = 'xidao.prototype.navVariant'

function readVariant(): NavVariant {
  try {
    const saved = localStorage.getItem(VARIANT_KEY)
    return saved === 'B' || saved === 'C' ? saved : 'A'
  } catch {
    return 'A'
  }
}

let variant: NavVariant = PROTOTYPE_ENABLED ? readVariant() : 'A'
const variantListeners = new Set<() => void>()

export function setNavVariant(next: NavVariant): void {
  if (next === variant) return
  variant = next
  try {
    localStorage.setItem(VARIANT_KEY, next)
  } catch {
    // Not remembered across restarts; switching still works.
  }
  for (const listener of variantListeners) listener()
}

function subscribeVariant(listener: () => void): () => void {
  variantListeners.add(listener)
  return () => variantListeners.delete(listener)
}

/** The current variant, or `null` when the prototype is not built in. */
export function useNavVariant(): NavVariant | null {
  const current = useSyncExternalStore(subscribeVariant, () => variant)
  return PROTOTYPE_ENABLED ? current : null
}

// ---------- Command palette (variant C) ----------

let paletteOpen = false
const paletteListeners = new Set<() => void>()

export function setPaletteOpen(open: boolean): void {
  if (open === paletteOpen) return
  paletteOpen = open
  for (const listener of paletteListeners) listener()
}

function subscribePalette(listener: () => void): () => void {
  paletteListeners.add(listener)
  return () => paletteListeners.delete(listener)
}

export function usePaletteOpen(): boolean {
  return useSyncExternalStore(subscribePalette, () => paletteOpen)
}

// ---------- Features ----------

export type FeatureId = 'subscriptions' | 'reminders' | 'search' | 'history' | 'offline' | 'drafts' | 'attempts'

export const FEATURES: readonly { id: FeatureId; label: string; icon: IconName }[] = [
  { id: 'subscriptions', label: '订阅的串', icon: 'bookmark' },
  { id: 'reminders', label: '提醒', icon: 'bell' },
  { id: 'search', label: '搜索', icon: 'search' },
  { id: 'history', label: '历史', icon: 'history' },
  { id: 'offline', label: '离线', icon: 'download' },
  { id: 'drafts', label: '草稿', icon: 'draft' },
  { id: 'attempts', label: '发送记录', icon: 'send' }
]

// ---------- In-memory navigation state ----------

export interface NavPrefs {
  hiddenFeatures: readonly FeatureId[]
  /** Favorite board keys (`listKey`) in their own order. */
  favorites: readonly string[]
  hiddenBoards: readonly string[]
  /** Custom board order per group id; boards missing from it keep the directory order after it. */
  order: Readonly<Record<string, readonly string[]>>
  collapsed: readonly string[]
}

let prefs: NavPrefs = { hiddenFeatures: [], favorites: [], hiddenBoards: [], order: {}, collapsed: [] }
const prefListeners = new Set<() => void>()

function update(next: Partial<NavPrefs>): void {
  prefs = { ...prefs, ...next }
  for (const listener of prefListeners) listener()
}

function subscribePrefs(listener: () => void): () => void {
  prefListeners.add(listener)
  return () => prefListeners.delete(listener)
}

export function useNavPrefs(): NavPrefs {
  return useSyncExternalStore(subscribePrefs, () => prefs)
}

function toggled<T>(list: readonly T[], value: T, on: boolean): T[] {
  const without = list.filter((item) => item !== value)
  return on ? [...without, value] : without
}

export const navActions = {
  setFeatureShown(id: FeatureId, shown: boolean) {
    update({ hiddenFeatures: toggled(prefs.hiddenFeatures, id, !shown) })
  },
  setFavorite(key: string, favorite: boolean) {
    update({ favorites: toggled(prefs.favorites, key, favorite) })
  },
  setBoardHidden(key: string, hidden: boolean) {
    update({ hiddenBoards: toggled(prefs.hiddenBoards, key, hidden) })
  },
  setCollapsed(groupId: string, collapsed: boolean) {
    update({ collapsed: toggled(prefs.collapsed, groupId, collapsed) })
  },
  moveFavorite(key: string, delta: -1 | 1) {
    update({ favorites: moved(prefs.favorites, key, delta) })
  },
  /** Moves a board within its group; `keys` is the group's current display order. */
  moveBoard(groupId: string, keys: readonly string[], key: string, delta: -1 | 1) {
    update({ order: { ...prefs.order, [groupId]: moved(keys, key, delta) } })
  }
}

function moved(list: readonly string[], key: string, delta: -1 | 1): string[] {
  const result = [...list]
  const from = result.indexOf(key)
  const to = from + delta
  if (from < 0 || to < 0 || to >= result.length) return result
  result.splice(from, 1)
  result.splice(to, 0, key)
  return result
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
  /** Every board of the group in the custom order, hidden and favorite ones included. */
  boards: Board[]
}

/** Timelines first, then the forum groups, each in the custom order. */
export function boardGroups(directory: BoardDirectory | null, order: NavPrefs['order']): BoardGroup[] {
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
    groups.push({
      id: `group-${group.id}`,
      title: group.name,
      boards: group.forums.map((forum) => board({ kind: 'forum', id: forum.id }, forum.displayName))
    })
  }
  return groups.map((group) => ({ ...group, boards: ordered(group.boards, order[group.id]) }))
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
export function visibleBoards(all: BoardGroup[], prefs: NavPrefs): BoardView {
  const hidden = new Set(prefs.hiddenBoards)
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
