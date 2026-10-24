import { useLayoutEffect, useMemo, useRef, type CSSProperties, type Ref } from 'react'
import type { RetainedList } from '../../../../shared/content'
import type { BoardDirectory } from '../../../../shared/forum'
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

/** The remote subscription list does not depend on the forum directory, so it is always offered. */
const SUBSCRIPTION_SECTION: NavSection = {
  id: 'subscriptions',
  title: '订阅',
  items: [{ ref: { kind: 'subscriptions' }, label: '订阅的串' }]
}

const NAV_ICON: Record<ListRef['kind'], IconName> = { subscriptions: 'bookmark', timeline: 'timeline', forum: 'forum' }

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

/**
 * Navigation panel. `inline` sits in the layout column and narrows continuously (`progress` 0 → 1
 * reduces its padding); `overlay` is the floating panel opened from the top bar.
 */
export function Navigation({
  state,
  selected,
  onSelect,
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
  pendingAttempts
}: {
  state: DirectoryState
  selected: ListRef | null
  onSelect: (ref: ListRef) => void
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
}) {
  const { directory } = state
  const sections = useMemo(() => navSections(directory), [directory])

  const ids = useMemo(() => sections.flatMap((section) => section.items.map((item) => listKey(item.ref))), [sections])
  const selectedKey = selected === null ? null : listKey(selected)
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
        {sections.map((section) => (
          <section key={section.id} className="nav-section" aria-labelledby={`nav-${section.id}`}>
            <h2 className="nav-heading" id={`nav-${section.id}`}>
              {section.title}
            </h2>
            <ul className="nav-list">
              {section.items.map((item) => {
                const key = listKey(item.ref)
                const current = key === selectedKey
                return (
                  <li key={key}>
                    <button
                      type="button"
                      className={current ? 'nav-item is-current' : 'nav-item'}
                      aria-current={current ? 'page' : undefined}
                      onClick={() => onSelect(item.ref)}
                      {...roving.itemProps(key)}
                    >
                      <Icon name={NAV_ICON[item.ref.kind]} className="nav-item-icon" />
                      <span className="nav-item-label">{item.label}</span>
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
        {sections.map((section) => (
          <div key={section.id} className="nav-section">
            <p className="nav-heading">{section.title}</p>
            {section.items.map((item) => (
              <span key={listKey(item.ref)} className="nav-item">
                <Icon name={NAV_ICON[item.ref.kind]} className="nav-item-icon" />
                <span className="nav-item-label">{item.label}</span>
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
