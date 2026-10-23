import { useMemo } from 'react'
import type { FeedRef } from '../../../../shared/forum'
import { Icon } from '../../components/Icon'
import { FailureNotice, Loading, SourceNotice } from '../../components/Notices'
import { describeFailure, formatLocalTime } from '../../lib/format'
import { useRovingFocus } from '../../lib/useRovingFocus'
import { feedKey } from './feeds'
import type { DirectoryState } from './useDirectory'
import './navigation.css'

interface NavItem {
  ref: FeedRef
  label: string
}

interface NavSection {
  id: string
  title: string
  items: NavItem[]
}

export function Navigation({
  state,
  selected,
  onSelect,
  onRetry
}: {
  state: DirectoryState
  selected: FeedRef | null
  onSelect: (ref: FeedRef) => void
  onRetry: () => void
}) {
  const { directory } = state

  const sections = useMemo<NavSection[]>(() => {
    if (directory === null) return []
    const result: NavSection[] = []
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
  }, [directory])

  const ids = useMemo(() => sections.flatMap((section) => section.items.map((item) => feedKey(item.ref))), [sections])
  const selectedKey = selected === null ? null : feedKey(selected)
  const roving = useRovingFocus(ids, selectedKey)

  return (
    <nav className="nav" aria-label="时间线与版面">
      <div className="nav-brand">
        <span className="nav-mark" aria-hidden="true" />
        <span>汐岛</span>
      </div>

      <div className="nav-scroll" onKeyDown={roving.onKeyDown}>
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

        {directory !== null && sections.length === 0 && <p className="nav-empty">目录中没有可浏览的版面或时间线。</p>}

        {sections.map((section) => (
          <section key={section.id} className="nav-section" aria-labelledby={`nav-${section.id}`}>
            <h2 className="nav-heading" id={`nav-${section.id}`}>
              {section.title}
            </h2>
            <ul className="nav-list">
              {section.items.map((item) => {
                const key = feedKey(item.ref)
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
                      <Icon name={item.ref.kind === 'timeline' ? 'timeline' : 'forum'} className="nav-item-icon" />
                      <span className="nav-item-label">{item.label}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>

      <DirectoryStatus state={state} />
    </nav>
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
      <p className="nav-foot-text" role="status">
        目录更新失败（{describeFailure(refreshFailure)}），显示 {formatLocalTime(source.fetchedAt)} 获取的本地缓存
      </p>
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
