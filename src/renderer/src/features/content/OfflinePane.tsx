// 离线 as a list page of a tab: the thread lists' row for every offline copy, most recently first
// saved first. A copy that is saving or needs attention shows one small icon at the end of the
// meta line; the copy's facts live in 离线详情… (the 离线副本 dialog of the thread's 更多 menu).
// 删除离线副本… (row menu, or that dialog) confirms first; a deleted row's neighbour takes focus.

import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { OfflineEntry } from '../../../../shared/content'
import type { ForumId, Post, ThreadId } from '../../../../shared/forum'
import { contextMenuPoint, isContextMenuKey, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { selectionCopyItem } from '../../components/copyMenuItems'
import { Icon, Spinner } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { meaningfulTitle } from '../../lib/format'
import { useRovingFocus } from '../../lib/useRovingFocus'
import { ThreadRow } from '../feed/ThreadRow'
import { useImageScope } from '../image/useImageLoad'
import { useListImageViewer } from '../image/useListImageViewer'
import { ListFilterPanel, ListFilterToggle, useListFilter } from '../search/FilterFields'
import { contentFilterCount, filterList } from '../search/listFilters'
import { useThreadMetadata } from '../search/useThreadMetadata'
import { useRegisterContent } from '../tabs/contentRegistry'
import { useOpenThreadInTab } from '../tabs/openThreadInTab'
import { contentFailureText, offlineAttention, type OfflineAttention } from './contentText'
import { OfflineDeleteConfirm } from './OfflineDeleteConfirm'
import { useOfflineList } from './offlineList'
import { OfflineRowMenu } from './OfflineRowMenu'
import { useOfflineDeletions } from './offlineSync'
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
  const { list, entries, load, remove, update, starting, startFailures, pollFailures } = useOfflineList()
  const { isDeleting } = useOfflineDeletions()
  const bodyRef = useRef<HTMLDivElement>(null)
  const { images, open: viewerOpen, viewer } = useListImageViewer(useImageScope(bodyRef), bodyRef)
  const openInTab = useOpenThreadInTab()
  useRegisterContent('lists', entryKey, {
    refresh: () => {
      setDone(null)
      void load()
    }
  })
  const onScroll = useRetainedScroll(entryKey, bodyRef, list.status === 'ready', true)

  // ---------- Filters ----------
  const [listFilters, changeFilters] = useRetainedFilters('offline')
  const filtering = contentFilterCount(listFilters) > 0
  const filter = useListFilter(listFilters, changeFilters)
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
  const [rowMenu, setRowMenu] = useState<{ threadId: ThreadId; point: ContextMenuPoint; row: HTMLElement; selection: ContextMenuItem | null } | null>(null)
  /** The row whose 离线副本 dialog is open; focus goes back to its row control. */
  const [details, setDetails] = useState<{ threadId: ThreadId; label: string; row: HTMLElement } | null>(null)
  const openRowMenu = (threadId: ThreadId, event: ReactMouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>) => {
    const row = event.currentTarget.querySelector<HTMLElement>('[data-roving-item]')
    if (row === null) return
    event.preventDefault()
    const selection = selectionCopyItem(undefined, event.currentTarget)
    // No scrolling into view: a scroll closes the menu that is about to open.
    row.focus({ preventScroll: true })
    setRowMenu({ threadId, point: contextMenuPoint(event, row), row, selection })
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

  // ---------- 删除离线副本 ----------
  // The confirmation is kept apart from the rows and the 离线副本 dialog: storage's change notice
  // usually removes the row before the deletion's own answer arrives.
  const headingRef = useRef<HTMLHeadingElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  /** The copy being confirmed: its label, whether it was saving, where its row was shown and that row. */
  const [deleteAsk, setDeleteAsk] = useState<{ threadId: ThreadId; label: string; saving: boolean; index: number; row: HTMLElement | null } | null>(null)
  /** What the last deletion here did, until the next one or a reload. */
  const [done, setDone] = useState<{ label: string; cacheCleanup: 'complete' | 'failed' } | null>(null)
  /** After a deletion: focus the row now at this position, else the heading. */
  const [focusAfter, setFocusAfter] = useState<{ index: number; seq: number } | null>(null)
  useLayoutEffect(() => {
    if (focusAfter === null) return
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[data-roving-item]') ?? []
    ;(rows[Math.min(focusAfter.index, rows.length - 1)] ?? headingRef.current)?.focus()
  }, [focusAfter])

  const askDelete = (threadId: ThreadId, label: string, saving: boolean, row: HTMLElement | null) => {
    if (isDeleting(threadId)) return
    setDone(null)
    setDeleteAsk({ threadId, label, saving, index: Math.max(shownIds.indexOf(threadId), 0), row })
  }
  const deleteEntry = deleteAsk === null ? undefined : entries.find((entry) => entry.threadId === deleteAsk.threadId)

  /** The row's status, with a failed progress read added while it is saving. */
  const attentionOf = (entry: OfflineEntry): OfflineAttention | null => {
    const attention = offlineAttention(entry.copy)
    const pollFailure = pollFailures.get(entry.threadId)
    if (attention?.kind !== 'saving' || pollFailure === undefined) return attention
    return { kind: 'saving', text: `${attention.text}；${pollFailure}` }
  }

  return (
    <section className="list-pane retained-page" aria-labelledby={headingId} aria-busy={list.status === 'loading' || undefined}>
      <div className="list-scroll" ref={bodyRef} onScroll={onScroll} tabIndex={-1} data-pane-focus="" inert={viewerOpen}>
        <header className="list-header">
          <div className="list-title-row">
            <h2 className="list-title" id={headingId} ref={headingRef} tabIndex={-1}>
              <span className="list-name">{TITLE}</span>
            </h2>
            {entries.length > 0 && <ListFilterToggle filter={filter} />}
          </div>
        </header>

        {entries.length > 0 && (
          <ListFilterPanel
            filter={filter}
            forums={forumNames}
            noun="串"
            total={entries.length}
            result={filtered}
            metadata={filtering ? metadata : null}
            coverage={`本机的${TITLE}列表`}
          />
        )}

        <div className="list-status">
          {done !== null && (
            <p className={done.cacheCleanup === 'complete' ? 'notice-inline' : 'notice-inline is-warning'} role="status">
              <Icon name={done.cacheCleanup === 'complete' ? 'check' : 'alert'} size={14} />
              已删除「{done.label}」的离线副本{done.cacheCleanup === 'failed' && '；普通缓存额度检查失败'}
              {done.cacheCleanup === 'failed' && <KaomojiDecor state="failure" />}
            </p>
          )}
          {list.status === 'failed' && (
            <div className="notice notice-error is-compact" role="alert">
              <Icon name="alert" className="notice-icon" />
              <p className="notice-text">
                {TITLE}读取失败：{contentFailureText(list.refused)}
                <KaomojiDecor state="failure" />
              </p>
              <button type="button" className="btn btn-small btn-page" onClick={() => void load()}>
                重试
              </button>
            </div>
          )}
        </div>

        {list.status === 'ready' && entries.length === 0 && (
          <div className="list-empty" role="status">
            <p className="list-empty-title">
              <KaomojiDecor state="offlineEmpty" above />
              还没有离线副本
            </p>
          </div>
        )}

        {filtering && entries.length > 0 && filtered.shown.length === 0 && (
          <p className="list-filters-empty" role="status">
            {TITLE}中没有符合筛选的串。
            <KaomojiDecor state="filteredOut" />
          </p>
        )}

        {filtered.shown.length > 0 && (
          <ul className="thread-list" ref={listRef} aria-label={filtering ? `${TITLE}（已筛选）` : TITLE} onKeyDown={roving.onKeyDown}>
            {filtered.shown.map(({ item: entry, uncertain }) => {
              const attention = attentionOf(entry)
              const startFailure = startFailures.get(entry.threadId)
              // 在新标签页打开, 更新离线副本, 离线详情… and 删除离线副本… live in the row's context menu
              // (right-click, ContextMenu, Shift+F10); middle-click or Ctrl/Cmd+click opens a new tab, as in 订阅.
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
                      <KaomojiDecor state="failure" />
                    </p>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        <div className="list-footer" />
      </div>
      {viewer}
      {rowMenu !== null && menuEntry !== undefined && (
        <OfflineRowMenu
          key={`menu:${rowMenu.threadId}`}
          point={rowMenu.point}
          row={rowMenu.row}
          threadId={rowMenu.threadId}
          head={menuEntry.head}
          selection={rowMenu.selection}
          label={menuLabel}
          updateBlocked={
            isDeleting(menuEntry.threadId)
              ? '正在删除'
              : menuEntry.copy.state === 'saving'
                ? '正在保存'
                : starting.has(menuEntry.threadId)
                  ? '正在开始保存'
                  : null
          }
          deleting={isDeleting(menuEntry.threadId)}
          onUpdate={() => void update(menuEntry.threadId)}
          onDetails={() => setDetails({ threadId: menuEntry.threadId, label: menuLabel, row: rowMenu.row })}
          onDelete={() => askDelete(menuEntry.threadId, menuLabel, menuEntry.copy.state === 'saving', rowMenu.row)}
          onClose={closeRowMenu}
        />
      )}
      {details !== null && (
        <OfflineDetailsDialog
          key={`details:${details.threadId}`}
          threadId={details.threadId}
          title={details.label}
          onClose={() => setDetails(null)}
          onDelete={(saving) => askDelete(details.threadId, details.label, saving, details.row)}
          fallbackFocus={() => (details.row.isConnected ? details.row : null)}
        />
      )}
      {deleteAsk !== null && (
        <OfflineDeleteConfirm
          key={`delete:${deleteAsk.threadId}`}
          threadId={deleteAsk.threadId}
          title={deleteAsk.label}
          saving={deleteEntry === undefined ? deleteAsk.saving : deleteEntry.copy.state === 'saving'}
          onCancel={() => setDeleteAsk(null)}
          onDeleted={({ cacheCleanup }) => {
            const ask = deleteAsk
            setDeleteAsk((current) => (current?.threadId === ask.threadId ? null : current))
            setDetails((current) => (current?.threadId === ask.threadId ? null : current))
            remove(ask.threadId)
            setDone({ label: ask.label, cacheCleanup })
            setFocusAfter((current) => ({ index: ask.index, seq: (current?.seq ?? 0) + 1 }))
          }}
          fallbackFocus={() => (deleteAsk.row?.isConnected === true ? deleteAsk.row : headingRef.current)}
        />
      )}
    </section>
  )
}
