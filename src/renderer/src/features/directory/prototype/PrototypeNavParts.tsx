// PROTOTYPE (throwaway): pieces the navigation variants share (feature labels and badges, the board
// tree, directory placeholders). Each variant owns where its boards go.

import { useMemo, type Ref } from 'react'
import type { BoardDirectory } from '../../../../../shared/forum'
import { formatReminderCount } from '../../../../../shared/reminders'
import { Icon } from '../../../components/Icon'
import { FailureNotice, Loading } from '../../../components/Notices'
import type { PendingAttempts } from '../../publication/usePendingAttempts'
import type { ListRef } from '../../tabs/tabsState'
import type { ReminderBadge } from '../Navigation'
import type { DirectoryState } from '../useDirectory'
import {
  boardGroups,
  FEATURES,
  hiddenBoardGroups,
  navActions,
  useNavPrefs,
  visibleBoards,
  type Board,
  type BoardView,
  type FeatureId,
  type NavPrefs
} from './prototypeStore'
import './prototype.css'

/** Props of one roving item (`useRovingFocus().itemProps`). */
export interface RovingItemProps {
  'data-roving-item': string
  tabIndex: number
  onFocus: () => void
  /** Where a popup moves focus when it opens (`usePopover`). */
  'data-autofocus'?: string
}

/** What the app gives every variant for the 功能 entries. */
export interface FeatureHost {
  /**
   * Opens a feature. `focusTarget`: the list it shows takes focus (its opener is going away, e.g.
   * the 全部功能 panel); dialogs always take focus themselves.
   */
  open: (id: FeatureId, focusTarget?: boolean) => void
  /** The feature the active tab shows (订阅的串, 提醒, 搜索, 历史, 离线 pages), if any. */
  current: FeatureId | null
  reminderBadge: ReminderBadge | null
  pendingAttempts: PendingAttempts
  searchShortcut: string
}

export interface PrototypeNavProps {
  state: DirectoryState
  /** The list the active tab shows; `null` while the settings page is shown. */
  selected: ListRef | null
  onSelect: (ref: ListRef) => void
  onRetry: () => void
  features: FeatureHost
  settingsCurrent: boolean
  onOpenSettings: () => void
  variant: 'inline' | 'overlay'
  progress: number
  panelRef?: Ref<HTMLElement>
  id?: string
}

export function featureInfo(id: FeatureId) {
  return FEATURES.find((feature) => feature.id === id) ?? FEATURES[0]!
}

export function featureTitle(id: FeatureId, host: FeatureHost): string | undefined {
  return id === 'search' && host.searchShortcut !== '' ? `搜索（${host.searchShortcut}）` : undefined
}

/** Badge of a feature: confirmed unread reminders, sends to check. */
export function featureBadge(id: FeatureId, host: FeatureHost): { text: string; tone: 'count' | 'warning'; spoken: string } | null {
  if (id === 'reminders') {
    const badge = host.reminderBadge
    if (badge === null || badge.unread <= 0) return null
    const text = formatReminderCount(badge.unread)
    return { text, tone: 'count', spoken: `${text} 条未读` }
  }
  if (id === 'attempts') {
    const count = host.pendingAttempts.count
    if (count === null || count <= 0) return null
    return { text: `${count} 待核对`, tone: 'warning', spoken: `${count} 项需要留意` }
  }
  return null
}

export function featureMarked(id: FeatureId, host: FeatureHost): boolean {
  if (id === 'reminders') return host.reminderBadge?.coverageProblem === true
  if (id === 'attempts') return host.pendingAttempts.failed
  return false
}

export function featureLabel(id: FeatureId, host: FeatureHost): string {
  const badge = featureBadge(id, host)
  const marked = featureMarked(id, host)
  const label = featureInfo(id).label
  return `${label}${badge === null ? '' : `，${badge.spoken}`}${marked ? (id === 'attempts' ? '，状态读取失败' : '，部分串检查未完成') : ''}`
}

/** Opens a dialog (草稿, 发送记录) rather than a page of the tab. */
export function featureIsDialog(id: FeatureId): boolean {
  return id === 'drafts' || id === 'attempts'
}

/** Small count / warning dot for icon-only feature buttons. */
export function FeatureDot({ id, host }: { id: FeatureId; host: FeatureHost }) {
  const badge = featureBadge(id, host)
  const marked = featureMarked(id, host)
  if (badge === null && !marked) return null
  const text = badge === null ? '' : id === 'attempts' ? String(host.pendingAttempts.count) : badge.text
  return (
    <span className={badge?.tone === 'count' ? 'proto-dot is-count' : 'proto-dot is-warning'} aria-hidden="true">
      {text}
    </span>
  )
}

// ---------- Boards ----------

type ItemProps = (key: string) => RovingItemProps

export const groupKey = (id: string) => `group:${id}`

/** The in-memory preferences, every board group, what the navigation lists and what it hides. */
export function useBoardView(directory: BoardDirectory | null) {
  const prefs = useNavPrefs()
  const all = useMemo(() => boardGroups(directory, prefs.order), [directory, prefs.order])
  const view = useMemo(() => visibleBoards(all, prefs), [all, prefs])
  const hidden = useMemo(() => hiddenBoardGroups(all, prefs), [all, prefs])
  return { prefs, all, view, hidden }
}

/** Roving keys of the board tree in display order (collapsed groups keep only their heading). */
export function boardTreeKeys(view: BoardView, prefs: NavPrefs): string[] {
  return [
    ...view.favorites.map((item) => item.key),
    ...view.groups.flatMap((group) =>
      prefs.collapsed.includes(group.id) ? [groupKey(group.id)] : [groupKey(group.id), ...group.boards.map((item) => item.key)]
    )
  ]
}

function BoardRow({
  item,
  selectedKey,
  onSelect,
  itemProps
}: {
  item: Board
  selectedKey: string | null
  onSelect: (ref: ListRef) => void
  itemProps: ItemProps
}) {
  const current = item.key === selectedKey
  return (
    <li>
      <button
        type="button"
        className={current ? 'nav-item is-current' : 'nav-item'}
        aria-current={current ? 'page' : undefined}
        onClick={() => onSelect(item.ref)}
        {...itemProps(item.key)}
      >
        <Icon name={item.icon} className="nav-item-icon" />
        <span className="nav-item-label">{item.label}</span>
      </button>
    </li>
  )
}

/**
 * Favorite boards on top, then the groups, each collapsible from its heading. `counts`: a collapsed
 * group shows how many boards it holds.
 */
export function BoardTree({
  view,
  prefs,
  selectedKey,
  onSelect,
  itemProps,
  favoritesTitle,
  counts = true
}: {
  view: BoardView
  prefs: NavPrefs
  selectedKey: string | null
  onSelect: (ref: ListRef) => void
  itemProps: ItemProps
  favoritesTitle: string
  counts?: boolean
}) {
  return (
    <>
      {view.favorites.length > 0 && (
        <section className="nav-section proto-favorites" aria-label={favoritesTitle}>
          <h2 className="nav-heading">{favoritesTitle}</h2>
          <ul className="nav-list">
            {view.favorites.map((item) => (
              <BoardRow key={item.key} item={item} selectedKey={selectedKey} onSelect={onSelect} itemProps={itemProps} />
            ))}
          </ul>
        </section>
      )}
      {view.groups.map((group) => {
        const collapsed = prefs.collapsed.includes(group.id)
        const listId = `proto-group-${group.id}`
        return (
          <section key={group.id} className="nav-section proto-group" aria-label={group.title}>
            <h2 className="proto-group-heading">
              <button
                type="button"
                className="proto-group-toggle"
                aria-expanded={!collapsed}
                aria-controls={collapsed ? undefined : listId}
                onClick={() => navActions.setCollapsed(group.id, !collapsed)}
                {...itemProps(groupKey(group.id))}
              >
                <Icon name="chevron" size={12} className="proto-chevron" />
                <span className="proto-group-title">{group.title}</span>
                {counts && collapsed && <span className="proto-group-count">{group.boards.length}</span>}
              </button>
            </h2>
            {!collapsed && (
              <ul className="nav-list" id={listId}>
                {group.boards.map((item) => (
                  <BoardRow key={item.key} item={item} selectedKey={selectedKey} onSelect={onSelect} itemProps={itemProps} />
                ))}
              </ul>
            )}
          </section>
        )
      })}
    </>
  )
}

/** Loading, failure and empty states of the directory part. */
export function DirectoryPlaceholder({ state, onRetry, empty }: { state: DirectoryState; onRetry: () => void; empty: boolean }) {
  const { directory } = state
  return (
    <>
      {directory === null && state.loading && (
        <div className="nav-placeholder">
          <Loading>正在读取版面目录…</Loading>
          <div className="nav-skeleton" aria-hidden="true">
            {Array.from({ length: 7 }, (_, index) => (
              <span key={index} className="skeleton-line" />
            ))}
          </div>
        </div>
      )}
      {directory === null && state.failure !== null && (
        <div className="nav-placeholder">
          <FailureNotice title="版面目录读取失败" failure={state.failure} onRetry={onRetry} compact />
        </div>
      )}
      {directory !== null && empty && <p className="nav-empty">没有可浏览的版面。</p>}
    </>
  )
}

/** Four squares: every feature. */
export function GridIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="4.5" y="4.5" width="6" height="6" rx="1.5" />
      <rect x="13.5" y="4.5" width="6" height="6" rx="1.5" />
      <rect x="4.5" y="13.5" width="6" height="6" rx="1.5" />
      <rect x="13.5" y="13.5" width="6" height="6" rx="1.5" />
    </svg>
  )
}
