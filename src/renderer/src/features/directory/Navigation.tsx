import { useLayoutEffect, useMemo, useRef, type CSSProperties, type Ref } from 'react'
import type { RetainedList } from '../../../../shared/content'
import type { BoardDirectory } from '../../../../shared/forum'
import { formatReminderCount } from '../../../../shared/reminders'
import { Icon, type IconName } from '../../components/Icon'
import { FailureNotice, IdentitySettingsAction, Loading, SourceNotice } from '../../components/Notices'
import { describeFailure, formatLocalTime } from '../../lib/format'
import { useRovingFocus } from '../../lib/useRovingFocus'
import { browseStatus } from '../identity/identityText'
import type { IdentitiesState } from '../identity/useIdentities'
import { listKey, type ListRef } from '../tabs/tabsState'
import type { PendingAttempts } from '../publication/usePendingAttempts'
import type { DirectoryState } from './useDirectory'
import './navigation.css'

const RETAINED_ENTRIES: { kind: RetainedList; label: string; icon: IconName }[] = [
  { kind: 'favorites', label: '收藏', icon: 'star' },
  { kind: 'history', label: '历史', icon: 'history' },
  { kind: 'offline', label: '离线', icon: 'download' }
]

interface NavItem {
  ref: ListRef
  label: string
}

interface NavSection {
  id: string
  title: string
  items: NavItem[]
}

/** The remote subscription list and the local 提醒 list do not depend on the forum directory, so they are always offered. */
const SUBSCRIPTION_SECTION: NavSection = {
  id: 'subscriptions',
  title: '订阅',
  items: [
    { ref: { kind: 'subscriptions' }, label: '订阅的串' },
    { ref: { kind: 'reminders' }, label: '提醒' }
  ]
}

const NAV_ICON: Record<ListRef['kind'], IconName> = { subscriptions: 'bookmark', reminders: 'bell', timeline: 'timeline', forum: 'forum' }

/**
 * Badge of the 提醒 entry: confirmed unread reminders only (`99+` from 100), hidden at 0. Coverage
 * that is incomplete, failed or uncertain is a separate marker and never adds to the number.
 */
export interface ReminderBadge {
  unread: number
  coverageProblem: boolean
}

function navSections(directory: BoardDirectory | null): NavSection[] {
  const result: NavSection[] = [SUBSCRIPTION_SECTION]
  if (directory === null) return result
  if (directory.timelines.length > 0) {
    result.push({
      id: 'timelines',
      title: '时间线',
      items: directory.timelines.map((timeline) => ({ ref: { kind: 'timeline', id: timeline.id }, label: timeline.displayName }))
    })
  }
  for (const group of directory.groups) {
    if (group.forums.length === 0) continue
    result.push({
      id: `group-${group.id}`,
      title: group.name,
      items: group.forums.map((forum) => ({ ref: { kind: 'forum', id: forum.id }, label: forum.displayName }))
    })
  }
  return result
}

/** Roving-focus keys of the two search items (list keys are `kind` or `kind:id`). */
const LOCAL_SEARCH_KEY = 'local-search'
const ONLINE_SEARCH_KEY = 'online-search'

/**
 * Navigation panel. `inline` sits in the layout column and narrows continuously (`progress` 0 → 1
 * reduces its padding); `overlay` is the floating panel opened from the top bar. 本机搜索 (the
 * local / thread search sheet) and 联网搜索 (a page of the active tab) sit above the directory and
 * are available whether or not the directory loaded.
 */
export function Navigation({
  state,
  selected,
  onSelect,
  onlineSearchCurrent,
  onOpenOnlineSearch,
  onRetry,
  variant,
  progress = 0,
  panelRef,
  id,
  identities,
  onOpenSettings,
  onOpenDrafts,
  onOpenRetained,
  onOpenAttempts,
  onOpenOwnPosts,
  pendingAttempts,
  reminderBadge,
  onOpenLocalSearch,
  localSearchShortcut
}: {
  state: DirectoryState
  selected: ListRef | null
  onSelect: (ref: ListRef) => void
  /** The active tab shows an online search page. */
  onlineSearchCurrent: boolean
  /** Opens 联网搜索 as a page of the active tab (focuses its search box when already there). */
  onOpenOnlineSearch: () => void
  onRetry: () => void
  variant: 'inline' | 'overlay'
  progress?: number
  panelRef?: Ref<HTMLElement>
  id?: string
  identities: IdentitiesState
  onOpenSettings: () => void
  /** Opens the 草稿 library. */
  onOpenDrafts: () => void
  /** Opens the 收藏 / 历史 / 离线 lists. */
  onOpenRetained: (kind: RetainedList) => void
  /** Opens 发送记录. */
  onOpenAttempts: () => void
  /** Opens 我的发言. */
  onOpenOwnPosts: () => void
  pendingAttempts: PendingAttempts
  /** `null` while the reminder overview is not known. */
  reminderBadge: ReminderBadge | null
  /** Opens the search of everything retained on this machine (the search sheet of the active tab). */
  onOpenLocalSearch: () => void
  /** Shortcut shown in the 本机搜索 tooltip; empty until the platform is known. */
  localSearchShortcut: string
}) {
  const { directory } = state
  const sections = useMemo(() => navSections(directory), [directory])

  const ids = useMemo(
    () => [LOCAL_SEARCH_KEY, ONLINE_SEARCH_KEY, ...sections.flatMap((section) => section.items.map((item) => listKey(item.ref)))],
    [sections]
  )
  const selectedKey = onlineSearchCurrent ? ONLINE_SEARCH_KEY : selected === null ? null : listKey(selected)
  const roving = useRovingFocus(ids, selectedKey)

  return (
    <nav
      ref={panelRef}
      id={id}
      className={variant === 'overlay' ? 'nav is-overlay' : 'nav'}
      aria-label="订阅、时间线与版面"
      style={{ '--nav-t': progress } as CSSProperties}
    >
      <div className="nav-brand">
        <span className="nav-mark" aria-hidden="true" />
        <span>汐岛</span>
      </div>

      <div className="nav-scroll" onKeyDown={roving.onKeyDown}>
        <ul className="nav-list nav-search" aria-label="搜索">
          <li>
            <button
              type="button"
              className="nav-item"
              aria-haspopup="dialog"
              title={localSearchShortcut === '' ? '搜索本机保有的内容' : `搜索本机保有的内容（${localSearchShortcut}）`}
              onClick={onOpenLocalSearch}
              {...roving.itemProps(LOCAL_SEARCH_KEY)}
            >
              <Icon name="search" className="nav-item-icon" />
              <span className="nav-item-label">本机搜索</span>
            </button>
          </li>
          <li>
            <button
              type="button"
              className={onlineSearchCurrent ? 'nav-item is-current' : 'nav-item'}
              aria-current={onlineSearchCurrent ? 'page' : undefined}
              title="通过第三方搜索服务查找论坛页面"
              onClick={onOpenOnlineSearch}
              {...roving.itemProps(ONLINE_SEARCH_KEY)}
            >
              <Icon name="globe" className="nav-item-icon" />
              <span className="nav-item-label">联网搜索</span>
            </button>
          </li>
        </ul>

        {sections.map((section) => (
          <section key={section.id} className="nav-section" aria-labelledby={`nav-${section.id}`}>
            <h2 className="nav-heading" id={`nav-${section.id}`}>
              {section.title}
            </h2>
            <ul className="nav-list">
              {section.items.map((item) => {
                const key = listKey(item.ref)
                const current = key === selectedKey
                const badge = item.ref.kind === 'reminders' ? reminderBadge : null
                const unread = badge !== null && badge.unread > 0 ? formatReminderCount(badge.unread) : null
                const marked = badge?.coverageProblem === true
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className={current ? 'nav-item is-current' : 'nav-item'}
                      aria-current={current ? 'page' : undefined}
                      aria-label={
                        unread === null && !marked
                          ? undefined
                          : `${item.label}${unread === null ? '' : `，${unread} 条未读`}${marked ? '，部分串检查未完成或无法确认' : ''}`
                      }
                      onClick={() => onSelect(item.ref)}
                      {...roving.itemProps(key)}
                    >
                      <Icon name={NAV_ICON[item.ref.kind]} className="nav-item-icon" />
                      <span className="nav-item-label">{item.label}</span>
                      {unread !== null && (
                        <span className="nav-badge is-count" aria-hidden="true">
                          {unread}
                        </span>
                      )}
                      {marked && <span className="nav-coverage-mark" aria-hidden="true" title="部分串检查未完成或无法确认" />}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}

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

        {directory !== null && sections.length === 1 && <p className="nav-empty">目录中没有可浏览的版面或时间线。</p>}
      </div>

      <DirectoryStatus state={state} />
      <div className="nav-tools">
        {RETAINED_ENTRIES.map((item) => (
          <button key={item.kind} type="button" className="nav-item" aria-haspopup="dialog" onClick={() => onOpenRetained(item.kind)}>
            <Icon name={item.icon} className="nav-item-icon" />
            <span className="nav-item-label">{item.label}</span>
          </button>
        ))}
        <button type="button" className="nav-item" aria-haspopup="dialog" onClick={onOpenDrafts}>
          <Icon name="draft" className="nav-item-icon" />
          <span className="nav-item-label">草稿</span>
        </button>
        <button
          type="button"
          className="nav-item"
          aria-haspopup="dialog"
          aria-label={
            pendingAttempts.count !== null && pendingAttempts.count > 0
              ? `发送记录，${pendingAttempts.count} 项需要留意`
              : pendingAttempts.failed
                ? '发送记录，状态读取失败'
                : undefined
          }
          onClick={onOpenAttempts}
        >
          <Icon name="history" className="nav-item-icon" />
          <span className="nav-item-label">发送记录</span>
          {pendingAttempts.count !== null && pendingAttempts.count > 0 && (
            <span className="nav-badge is-warning" aria-hidden="true">
              {pendingAttempts.count} 待核对
            </span>
          )}
          {pendingAttempts.failed && <Icon name="alert" size={14} className="nav-badge-icon" />}
        </button>
        <button type="button" className="nav-item" aria-haspopup="dialog" onClick={onOpenOwnPosts}>
          <Icon name="person" className="nav-item-icon" />
          <span className="nav-item-label">我的发言</span>
        </button>
      </div>
      <IdentityFooter identities={identities} onOpenSettings={onOpenSettings} />
    </nav>
  )
}

/** Space outside the measured panel: the column's left margin (`.nav` margin-left). */
const NAV_OUTER_MARGIN = 8

/**
 * Invisible copy of the navigation at its compact padding, laid out at max-content width: the
 * narrowest column in which every heading and label stays complete on one line beside its icon.
 * Reports the width (including the column margin) whenever the content or font size changes;
 * reports nothing while the directory has no entries to measure.
 */
export function NavMeasure({ directory, onMeasure }: { directory: BoardDirectory | null; onMeasure: (width: number) => void }) {
  const sections = useMemo(() => navSections(directory), [directory])
  const ref = useRef<HTMLDivElement>(null)
  const report = useRef(onMeasure)
  useLayoutEffect(() => {
    report.current = onMeasure
  })

  const empty = sections.length <= 1
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null || empty) return
    const measure = () => report.current(Math.ceil(element.getBoundingClientRect().width) + NAV_OUTER_MARGIN)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [empty])

  if (empty) return null
  return (
    <div ref={ref} className="nav nav-measure" aria-hidden="true" inert style={{ '--nav-t': 1 } as CSSProperties}>
      <div className="nav-brand">
        <span className="nav-mark" />
        <span>汐岛</span>
      </div>
      <div className="nav-scroll">
        <div className="nav-list nav-search">
          <span className="nav-item">
            <Icon name="search" className="nav-item-icon" />
            <span className="nav-item-label">本机搜索</span>
          </span>
          <span className="nav-item">
            <Icon name="globe" className="nav-item-icon" />
            <span className="nav-item-label">联网搜索</span>
          </span>
        </div>
        {sections.map((section) => (
          <div key={section.id} className="nav-section">
            <p className="nav-heading">{section.title}</p>
            {section.items.map((item) => (
              <span key={listKey(item.ref)} className="nav-item">
                <Icon name={NAV_ICON[item.ref.kind]} className="nav-item-icon" />
                <span className="nav-item-label">{item.label}</span>
                {/* The widest 提醒 badge stays beside its label at the compact width. */}
                {item.ref.kind === 'reminders' && <span className="nav-badge is-count">99+</span>}
                {item.ref.kind === 'reminders' && <span className="nav-coverage-mark" />}
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

function IdentityFooter({ identities, onOpenSettings }: { identities: IdentitiesState; onOpenSettings: () => void }) {
  const { overview, failed } = identities
  const status = overview === null ? null : browseStatus(overview)
  const value =
    status === null
      ? failed
        ? '状态读取失败'
        : '读取中…'
      : status.state === 'none'
        ? '不使用饼干'
        : status.state === 'missing'
          ? '已移除，需重选'
          : status.name
  const warning = status?.state === 'missing' || (status === null && failed)
  return (
    <div className="nav-account">
      <button
        type="button"
        className={warning ? 'nav-identity is-warning' : 'nav-identity'}
        onClick={onOpenSettings}
        aria-label={`浏览饼干：${value}。打开设置`}
      >
        {warning && <Icon name="alert" size={14} className="nav-identity-icon" />}
        <span className="nav-identity-label">浏览饼干</span>
        <span className="nav-identity-value">{value}</span>
      </button>
    </div>
  )
}

function DirectoryStatus({ state }: { state: DirectoryState }) {
  const { source, refreshing, refreshFailure, directory } = state
  if (source === null) return null
  let body = null
  if (refreshing) {
    body = <Loading>正在后台更新目录…</Loading>
  } else if (refreshFailure !== null) {
    body = (
      <>
        <p className="nav-foot-text" role="status">
          目录更新失败（{describeFailure(refreshFailure)}），显示 {formatLocalTime(source.fetchedAt)} 获取的本地缓存
        </p>
        <IdentitySettingsAction error={refreshFailure} />
      </>
    )
  } else if (source.status === 'cached' || !source.saved) {
    body = <SourceNotice source={source} subject="目录" />
  }
  const skipped = directory?.skippedItems ?? 0
  if (body === null && skipped <= 0) return null
  return (
    <div className="nav-foot">
      {skipped > 0 && (
        <p className="notice-inline is-warning" role="status">
          <Icon name="alert" size={14} />
          目录中 {skipped} 项无法解析，未显示
        </p>
      )}
      {body}
    </div>
  )
}
