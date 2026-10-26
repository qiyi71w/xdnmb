// 离线 as a list page of a tab: the thread lists' row for every offline copy, most recently first
// saved first. A copy that is saving or needs attention shows one small icon at the end of the
// meta line; the copy's facts live in 离线详情… (the 离线副本 dialog of the thread's 更多 menu).

import { useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { OfflineEntry } from '../../../../shared/content'
import type { ForumId, Post, ThreadId } from '../../../../shared/forum'
import { contextMenuPoint, isContextMenuKey, type ContextMenuPoint } from '../../components/ContextMenu'
import { Icon, Spinner } from '../../components/Icon'
import { meaningfulTitle } from '../../lib/format'
import { useRovingFocus } from '../../lib/useRovingFocus'
import { ThreadRow } from '../feed/ThreadRow'
import { useImageScope } from '../image/useImageLoad'
import { ListFilterBar } from '../search/FilterFields'
import { contentFilterCount, filterList } from '../search/listFilters'
import { useThreadMetadata } from '../search/useThreadMetadata'
import { useRegisterContent } from '../tabs/contentRegistry'
import { useOpenThreadInTab } from '../tabs/openThreadInTab'
import { contentFailureText, offlineAttention, type OfflineAttention } from './contentText'
import { useOfflineList } from './offlineList'
import { OfflineRowMenu } from './OfflineRowMenu'
import { useRetainedFilters, useRetainedScroll } from './retainedList'
import { OfflineDetailsDialog } from './ThreadRetention'
import '../feed/feed.css'
import './content.css'

const TITLE = '离线'

/**
 * The copy's status at the end of the row's meta line: an icon whose accessible name is the reason
 * (so the row's name ends with it), repeated as a tip on hover or keyboard focus of the row.
 */
function CopyStatus({ attention }: { attention: OfflineAttention }) {
  return (
    <span className={attention.kind === 'saving' ? 'row-status is-saving' : 'row-status is-warning'}>
      <span className="row-status-icon" role="img" aria-label={attention.text}>
        {attention.kind === 'saving' ? <Spinner /> : <Icon name="alert" size={14} />}
      </span>
      <span className="row-status-tip" aria-hidden="true">
        {attention.text}
      </span>
    </span>
  )
}

export function OfflinePane({
  entryKey,
  forumNames,
  selectedThreadId,
  onOpenThread
}: {
  entryKey: number
  forumNames: ReadonlyMap<ForumId, string>
  /** The thread shown beside the list (split), highlighted. */
  selectedThreadId: ThreadId | null
  /** `head`: the main post when held here, shown until page 1 arrives. */
  onOpenThread: (threadId: ThreadId, head: Post | null) => void
}) {
  const headingId = useId()
  const { list, entries, load, patch, update, starting, startFailures, pollFailures } = useOfflineList()
  const bodyRef = useRef<HTMLDivElement>(null)
  const images = useImageScope(bodyRef)
  const openInTab = useOpenThreadInTab()
  useRegisterContent('lists', entryKey, { refresh: () => void load() })
  const onScroll = useRetainedScroll(entryKey, bodyRef, list.status === 'ready', true)

  // ---------- Filters ----------
  const [listFilters, changeFilters] = useRetainedFilters('offline')
  const filtering = contentFilterCount(listFilters) > 0
  const entryIds = useMemo(() => entries.map((entry) => entry.threadId), [entries])
  const metadata = useThreadMetadata(entryIds, filtering)
  const filtered = useMemo(
    () =>
      filterList(
        entries,
        (entry) => (metadata.status === 'ready' ? (metadata.byId.get(entry.threadId) ?? null) : null),
        listFilters
      ),
    [entries, metadata, listFilters]
  )
  const shownIds = useMemo(() => filtered.shown.map(({ item }) => item.threadId), [filtered])
  const roving = useRovingFocus(shownIds, selectedThreadId)

  // ---------- Row context menu and 离线详情… ----------
  /** The row whose context menu is open, where it opened and the row control focus returns to. */
  const [rowMenu, setRowMenu] = useState<{ threadId: ThreadId; point: ContextMenuPoint; row: HTMLElement } | null>(null)
  /** The row whose 离线副本 dialog is open; focus goes back to its row control. */
  const [details, setDetails] = useState<{ threadId: ThreadId; label: string; row: HTMLElement } | null>(null)
  const openRowMenu = (threadId: ThreadId, event: ReactMouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    const row = event.currentTarget.querySelector<HTMLElement>('[data-roving-item]')
    if (row === null) return
    event.preventDefault()
    // No scrolling into view: a scroll closes the menu that is about to open.
    row.focus({ preventScroll: true })
    setRowMenu({ threadId, point: contextMenuPoint(event, row), row })
  }
  const closeRowMenu = (returnFocus: boolean) => {
    const row = rowMenu?.row
    setRowMenu(null)
    if (returnFocus && row?.isConnected === true) row.focus()
  }
  const menuEntry = rowMenu === null ? undefined : entries.find((entry) => entry.threadId === rowMenu.threadId)
  // Thread title or `No.x`, as the thread's own 离线副本 dialog names it.
  const menuLabel =
    menuEntry === undefined ? '' : (meaningfulTitle(menuEntry.head === null ? menuEntry.title : menuEntry.head.title) ?? `No.${menuEntry.threadId}`)

  /** The row's status, with a failed progress read added while it is saving. */
  const attentionOf = (entry: OfflineEntry): OfflineAttention | null => {
    const attention = offlineAttention(entry.copy)
    const pollFailure = pollFailures.get(entry.threadId)
    if (attention?.kind !== 'saving' || pollFailure === undefined) return attention
    return { kind: 'saving', text: `${attention.text}；${pollFailure}` }
  }

  return (
    <section className="list-pane retained-page" aria-labelledby={headingId} aria-busy={list.status === 'loading' || undefined}>
      <div className="list-scroll" ref={bodyRef} onScroll={onScroll} tabIndex={-1} data-pane-focus="">
        <header className="list-header">
          <div className="list-title-row">
            <h2 className="list-title" id={headingId}>
              <span className="list-name">{TITLE}</span>
            </h2>
          </div>
        </header>

        <div className="list-status">
          {list.status === 'failed' && (
            <div className="notice notice-error is-compact" role="alert">
              <Icon name="alert" className="notice-icon" />
              <p className="notice-text">
                {TITLE}读取失败：{contentFailureText(list.refused)}
              </p>
              <button type="button" className="btn btn-small" onClick={() => void load()}>
                重试
              </button>
            </div>
          )}
        </div>

        {list.status === 'ready' && entries.length === 0 && (
          <div className="list-empty" role="status">
            <p className="list-empty-title">还没有离线副本</p>
          </div>
        )}

        {entries.length > 0 && (
          <ListFilterBar
            filters={listFilters}
            onChange={changeFilters}
            forums={forumNames}
            noun="串"
            total={entries.length}
            result={filtered}
            metadata={filtering ? metadata : null}
            coverage={`本机的${TITLE}列表`}
          />
        )}
        {filtering && entries.length > 0 && filtered.shown.length === 0 && (
          <p className="list-filters-empty" role="status">
            {TITLE}中没有符合筛选的串。
          </p>
        )}

        {filtered.shown.length > 0 && (
          <ul className="thread-list" aria-label={filtering ? `${TITLE}（已筛选）` : TITLE} onKeyDown={roving.onKeyDown}>
            {filtered.shown.map(({ item: entry, uncertain }) => {
              const attention = attentionOf(entry)
              const startFailure = startFailures.get(entry.threadId)
              // 在新标签页打开, 更新离线副本 and 离线详情… live in the row's context menu (right-click,
              // ContextMenu, Shift+F10); middle-click or Ctrl/Cmd+click opens a new tab, as in 订阅.
              return (
                <li
                  key={entry.threadId}
                  className={rowMenu?.threadId === entry.threadId ? 'offline-row is-menu-open' : 'offline-row'}
                  onContextMenu={(event) => openRowMenu(entry.threadId, event)}
                  onKeyDown={(event) => {
                    if (isContextMenuKey(event)) openRowMenu(entry.threadId, event)
                  }}
                  onClickCapture={(event) => {
                    if (openInTab === null || (!event.ctrlKey && !event.metaKey)) return
                    event.preventDefault()
                    event.stopPropagation()
                    openInTab(entry.threadId, entry.head)
                  }}
                  // Middle press: no autoscroll; the release opens the tab.
                  onMouseDown={(event) => {
                    if (openInTab !== null && event.button === 1) event.preventDefault()
                  }}
                  onAuxClick={(event) => {
                    if (openInTab === null || event.button !== 1) return
                    event.preventDefault()
                    openInTab(entry.threadId, entry.head)
                  }}
                >
                  <ThreadRow
                    thread={
                      entry.head === null
                        ? { head: null, id: entry.threadId, title: entry.title, replyCount: entry.replyCount }
                        : { head: entry.head, replyCount: entry.replyCount }
                    }
                    forumName={entry.head !== null && entry.head.forumId !== null ? (forumNames.get(entry.head.forumId) ?? null) : null}
                    selected={entry.threadId === selectedThreadId}
                    uncertain={uncertain}
                    images={images}
                    onOpen={() => onOpenThread(entry.threadId, entry.head)}
                    itemProps={roving.itemProps(entry.threadId)}
                    metaEnd={attention !== null && <CopyStatus attention={attention} />}
                  />
                  {startFailure !== undefined && (
                    <p className="notice-inline is-warning" role="alert">
                      <Icon name="alert" size={14} />
                      {startFailure}
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <div className="list-footer" />
      </div>
      {rowMenu !== null && menuEntry !== undefined && (
        <OfflineRowMenu
          key={rowMenu.threadId}
          point={rowMenu.point}
          threadId={rowMenu.threadId}
          head={menuEntry.head}
          label={menuLabel}
          updateBlocked={menuEntry.copy.state === 'saving' ? '正在保存' : starting.has(menuEntry.threadId) ? '正在开始保存' : null}
          onUpdate={() => void update(menuEntry.threadId)}
          onDetails={() => setDetails({ threadId: menuEntry.threadId, label: menuLabel, row: rowMenu.row })}
          onClose={closeRowMenu}
        />
      )}
      {details !== null && (
        <OfflineDetailsDialog
          key={details.threadId}
          threadId={details.threadId}
          title={details.label}
          onClose={(copy) => {
            setDetails(null)
            if (copy !== null) patch(copy)
          }}
          fallbackFocus={() => (details.row.isConnected ? details.row : null)}
        />
      )}
    </section>
  )
}
