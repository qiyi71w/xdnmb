// Pieces of the icon-rail navigation: feature labels and badges, the board view from the settings,
// and the directory's placeholder and status lines.

import { useMemo, type Ref } from 'react'
import type { BoardDirectory } from '../../../../shared/forum'
import { formatReminderCount } from '../../../../shared/reminders'
import { Icon } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { FailureNotice, IdentitySettingsAction, SourceNotice } from '../../components/Notices'
import { formatRecordTime } from '../../lib/time'
import { useSettings } from '../../lib/settingsContext'
import type { ListRef } from '../tabs/tabsState'
import type { DirectoryState } from './useDirectory'
import { boardGroups, FEATURES, hiddenBoardGroups, visibleBoards, type FeatureId } from './navStore'
import './shell.css'

/** Props of one roving item (`useRovingFocus().itemProps`). */
export interface RovingItemProps {
  'data-roving-item': string
  tabIndex: number
  onFocus: () => void
  /** Where a popup moves focus when it opens (`usePopover`). */
  'data-autofocus'?: string
}

/** Count of the 提醒 entry: threads with a non-zero reminder count (coverage issues never count). */
export interface ReminderBadge {
  threads: number
}

/** What the app gives the rail for its feature entries. */
export interface FeatureHost {
  /**
   * Opens a feature. `focusTarget`: the list it shows takes focus (its opener is going away, e.g.
   * the 更多 panel); dialogs always take focus themselves.
   */
  open: (id: FeatureId, focusTarget?: boolean) => void
  /** The feature the active tab shows (订阅, 提醒, 搜索, 历史, 离线 pages), if any. */
  current: FeatureId | null
  reminderBadge: ReminderBadge | null
  searchShortcut: string
}

export interface NavProps {
  state: DirectoryState
  /** The list the active tab shows; `null` while the settings page is shown. */
  selected: ListRef | null
  onSelect: (ref: ListRef) => void
  onRetry: () => void
  features: FeatureHost
  settingsCurrent: boolean
  onOpenSettings: () => void
  variant: 'inline' | 'overlay'
  panelRef?: Ref<HTMLElement>
  id?: string
}

export function featureInfo(id: FeatureId) {
  return FEATURES.find((feature) => feature.id === id) ?? FEATURES[0]!
}

/** Badge of a feature: threads with new reminders. */
function featureBadge(id: FeatureId, host: FeatureHost): { text: string; spoken: string } | null {
  if (id !== 'reminders') return null
  const threads = host.reminderBadge?.threads ?? 0
  if (threads <= 0) return null
  return { text: formatReminderCount(threads), spoken: `${threads} 个串有新提醒` }
}

/** Accessible name: the feature's name, then what its badge says. */
export function featureLabel(id: FeatureId, host: FeatureHost): string {
  const badge = featureBadge(id, host)
  const label = featureInfo(id).label
  return `${label}${badge === null ? '' : `，${badge.spoken}`}`
}

/** Tooltip: the name, with the shortcut of 搜索. */
export function featureTitle(id: FeatureId, host: FeatureHost): string {
  const label = featureInfo(id).label
  return id === 'search' && host.searchShortcut !== '' ? `${label}（${host.searchShortcut}）` : label
}

/** Opens the draft dialog rather than a page of the tab. */
export function featureIsDialog(id: FeatureId): boolean {
  return id === 'drafts'
}

/** Small count for icon-only feature buttons. */
export function FeatureDot({ id, host }: { id: FeatureId; host: FeatureHost }) {
  const badge = featureBadge(id, host)
  if (badge === null) return null
  return (
    <span className="shell-dot is-count" aria-hidden="true">
      {badge.text}
    </span>
  )
}

// ---------- Boards ----------

export const groupKey = (id: string) => `group:${id}`

/** The board settings, every board group, what the navigation lists and what it hides. */
export function useBoardView(directory: BoardDirectory | null) {
  const prefs = useSettings().settings.boards
  const all = useMemo(() => boardGroups(directory, prefs.order), [directory, prefs.order])
  const view = useMemo(() => visibleBoards(all, prefs), [all, prefs])
  const hidden = useMemo(() => hiddenBoardGroups(all, prefs), [all, prefs])
  return { prefs, all, view, hidden }
}

/** First directory load: a text-free skeleton; only a failure is put into words. */
export function DirectorySkeleton() {
  return (
    <div className="nav-placeholder" aria-busy="true">
      <div className="nav-skeleton" aria-hidden="true">
        {Array.from({ length: 7 }, (_, index) => (
          <span key={index} className="skeleton-line" />
        ))}
      </div>
    </div>
  )
}

/** First-load skeleton, failure and empty states of the directory part. */
export function DirectoryPlaceholder({ state, onRetry, empty }: { state: DirectoryState; onRetry: () => void; empty: boolean }) {
  const { directory } = state
  return (
    <>
      {directory === null && state.loading && <DirectorySkeleton />}
      {directory === null && state.failure !== null && (
        <div className="nav-placeholder">
          <FailureNotice title="版面目录读取失败" failure={state.failure} onRetry={onRetry} compact />
        </div>
      )}
      {directory !== null && empty && (
        <p className="nav-empty">
          没有可浏览的版面
          <KaomojiDecor state="directoryEmpty" />
        </p>
      )}
    </>
  )
}

/** A background refresh is quiet; only its failure, a cached source or unreadable entries are named. */
export function DirectoryStatus({ state, onRetry }: { state: DirectoryState; onRetry: () => void }) {
  const { source, refreshing, refreshFailure, directory } = state
  if (source === null) return null
  let body = null
  if (!refreshing && refreshFailure !== null) {
    body = (
      <>
        <p className="nav-foot-text" role="status">
          目录未更新，显示 {formatRecordTime(source.fetchedAt)} 的缓存
        </p>
        <span className="nav-foot-actions">
          <button type="button" className="btn btn-small btn-page" onClick={onRetry}>
            重试
          </button>
          <IdentitySettingsAction error={refreshFailure} />
        </span>
      </>
    )
  } else if (!refreshing && (source.status === 'cached' || !source.saved)) {
    body = <SourceNotice source={source} subject="目录" />
  }
  const skipped = directory?.skippedItems ?? 0
  if (body === null && skipped <= 0) return null
  return (
    <div className="nav-foot">
      {skipped > 0 && (
        <p className="notice-inline is-warning" role="status">
          <Icon name="alert" size={14} />
          {skipped} 个目录项无法显示
        </p>
      )}
      {body}
    </div>
  )
}

/** Four squares: 更多. */
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
