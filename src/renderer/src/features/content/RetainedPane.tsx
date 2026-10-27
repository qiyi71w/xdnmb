// 历史 and 离线 as list pages of a tab, like 订阅 and 提醒. Choosing a row opens the thread the way
// the thread lists do (beside the list when split, else a new step). 历史 switches between three
// pages: 浏览, and the sent records of 新串 and of 回复 (SentPage); 离线 is its own pane (OfflinePane).

import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { ForumId, Post, ThreadId } from '../../../../shared/forum'
import { ContextMenu, contextMenuPoint, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { CookieId } from '../../components/CookieId'
import { Icon } from '../../components/Icon'
import { meaningfulName, meaningfulTitle } from '../../lib/format'
import { formatForumTime, formatRecordTime } from '../../lib/time'
import { useRovingFocus } from '../../lib/useRovingFocus'
import { RowThumbnail } from '../image/RowThumbnail'
import { useImageScope } from '../image/useImageLoad'
import { SentPage, useSentAttempts } from '../publication/SentPage'
import type { SentKind } from '../publication/sentRecords'
import { ListFilterBar, UncertainTag } from '../search/FilterFields'
import { contentFilterCount, filterList } from '../search/listFilters'
import { useThreadMetadata } from '../search/useThreadMetadata'
import { ContentRegistryContext, useRegisterContent, type HistoryView } from '../tabs/contentRegistry'
import { useOpenThreadInTab } from '../tabs/openThreadInTab'
import { listRowGestures } from '../tabs/ThreadTabMenu'
import type { EntryInit } from '../tabs/tabsState'
import { contentFailureText, retainedHeading } from './contentText'
import { OfflinePane } from './OfflinePane'
import { createReadingResets } from './readingResets'
import { HistoryConfirm, historyMemory, rememberHistory, useRetainedFilters, useRetainedList, useRetainedScroll } from './retainedList'
import '../feed/feed.css'
import './content.css'

const PAGE = { title: '历史', at: '最近访问', empty: '还没有浏览过的串' } as const

const VIEWS: readonly { view: HistoryView; label: string; kind: SentKind | null }[] = [
  { view: 'browsing', label: '浏览', kind: null },
  { view: 'threads', label: '新串', kind: 'thread' },
  { view: 'replies', label: '回复', kind: 'reply' }
]

export interface HistoryPageHost {
  /** The page to show in tab `tabId` (the rail's 历史); each `seq` applies once. */
  request: { tabId: number; view: HistoryView; seq: number } | null
  /**
   * Opens a place as a new step of the tab whose current entry is `entryKey` (后退 comes back to
   * 历史); false when no tab shows that entry now.
   */
  openStep: (entryKey: number, init: EntryInit) => boolean
  /** Opens a place in a new active tab. */
  openInTab: (init: EntryInit) => void
}
export const HistoryPageContext = createContext<HistoryPageHost | null>(null)

/** Newest request already applied: a 历史 entry shown again later goes back to its own page. */
let appliedRequest = 0

interface RetainedPaneProps {
  tabId: number
  entryKey: number
  kind: 'history' | 'offline'
  forumNames: ReadonlyMap<ForumId, string>
  /** The thread shown beside the list (split), highlighted. */
  selectedThreadId: ThreadId | null
  /** `head`: the main post when the list holds it, shown until page 1 arrives. */
  onOpenThread: (threadId: ThreadId, head: Post | null) => void
}

export function RetainedPane(props: RetainedPaneProps) {
  const host = useContext(HistoryPageContext)
  if (props.kind === 'offline') return <OfflinePane entryKey={props.entryKey} forumNames={props.forumNames} selectedThreadId={props.selectedThreadId} onOpenThread={props.onOpenThread} />
  if (host === null) return <BrowsingPane {...props} />
  return <HistoryPage {...props} host={host} />
}

function HistoryPage({ host, ...props }: RetainedPaneProps & { host: HistoryPageHost }) {
  const registry = useContext(ContentRegistryContext)
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const request = host.request?.tabId === props.tabId ? host.request : null
  const [view, setView] = useState<HistoryView>(() => {
    if (request !== null && request.seq > appliedRequest) return request.view
    return (registry === null ? undefined : historyMemory(registry.listMemory, props.entryKey)?.view) ?? 'browsing'
  })
  /** 新串／回复 read the attempts once either was shown. */
  const [sentShown, setSentShown] = useState(view !== 'browsing')
  const [sentRefresh, setSentRefresh] = useState(0)
  const sent = useSentAttempts(sentShown, sentRefresh)

  const show = (next: HistoryView) => {
    setView(next)
    if (next !== 'browsing') setSentShown(true)
  }
  useLayoutEffect(() => {
    if (request === null || request.seq <= appliedRequest) return
    appliedRequest = request.seq
    show(request.view)
    headingRef.current?.focus({ preventScroll: true })
  }, [request])
  useLayoutEffect(() => {
    if (registry !== null) rememberHistory(registry.listMemory, props.entryKey, { view })
  }, [registry, props.entryKey, view])

  return (
    <section className="list-pane history-page" aria-labelledby={headingId}>
      <header className="list-header history-page-header">
        <h2 className="list-title" id={headingId} ref={headingRef} tabIndex={-1} data-history-heading="" data-pane-focus="">
          <span className="list-name">{PAGE.title}</span>
        </h2>
        <div className="segmented history-view-switch" role="group" aria-label="历史分页" data-view={view}>
          {VIEWS.map((item) => (
            <button key={item.view} type="button" className="segmented-item" aria-pressed={view === item.view} onClick={() => show(item.view)}>
              {item.label}
            </button>
          ))}
        </div>
      </header>
      <div className="history-page-view" hidden={view !== 'browsing'}>
        <BrowsingPane
          {...props}
          showHeading={false}
          displayed={view === 'browsing'}
          refreshOverride={view === 'browsing' ? undefined : () => setSentRefresh((value) => value + 1)}
        />
      </div>
      {sentShown &&
        VIEWS.flatMap((item) =>
          item.kind === null
            ? []
            : [
                <div key={item.view} className="history-page-view" hidden={view !== item.view}>
                  <SentPage
                    kind={item.kind}
                    entryKey={props.entryKey}
                    displayed={view === item.view}
                    list={sent.list}
                    readFailed={sent.readFailed}
                    onReload={(quiet) => void sent.load(quiet)}
                    onOpenThread={props.onOpenThread}
                    openStep={(init) => host.openStep(props.entryKey, init)}
                    openInTab={host.openInTab}
                  />
                </div>
              ]
        )}
    </section>
  )
}

/**
 * 浏览: visited threads, most recent first. A row's actions live in its context menu (right-click,
 * ContextMenu key, Shift+F10): 在新标签页打开 and 删除…, which asks first; 清空历史… is in the header.
 * Middle-click or Ctrl/Cmd+click opens a new tab, as in the thread lists.
 */
function BrowsingPane({ entryKey, forumNames, selectedThreadId, onOpenThread, showHeading = true, displayed = true, refreshOverride }: RetainedPaneProps & {
  showHeading?: boolean
  displayed?: boolean
  refreshOverride?: () => void
}) {
  const headingId = useId()
  const registry = useContext(ContentRegistryContext)
  // Outside the shell (no registry) nothing else clears reading data: a private store never resets.
  const [ownResets] = useState(createReadingResets)
  const { list, entries, load, confirming, setConfirming, busy, failure, setFailure, done, listRef, bodyRef, ask, clearHistory } =
    useRetainedList(registry?.readingResets ?? ownResets)
  const images = useImageScope(bodyRef)
  const openInTab = useOpenThreadInTab()
  useRegisterContent('lists', entryKey, { refresh: refreshOverride ?? (() => void load()) })
  const onScroll = useRetainedScroll(entryKey, bodyRef, list.status === 'ready', displayed)

  // ---------- Filters ----------
  const [listFilters, changeFilters] = useRetainedFilters('history')
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

  // ---------- Row context menu: 在新标签页打开, 删除… ----------
  const [rowMenu, setRowMenu] = useState<{ threadId: ThreadId; point: ContextMenuPoint; row: HTMLElement } | null>(null)
  /** The row a deletion was asked from; focus goes back there when the dialog closes without deleting. */
  const askedFrom = useRef<HTMLElement | null>(null)
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
  const confirmingEntry = confirming?.threadId == null ? undefined : entries.find((entry) => entry.threadId === confirming.threadId)

  return (
    <section className="list-pane retained-page" aria-labelledby={showHeading ? headingId : undefined} aria-label={showHeading ? undefined : '浏览'} aria-busy={list.status === 'loading' || undefined}>
      <div className="list-scroll" ref={bodyRef} onScroll={onScroll} tabIndex={-1} data-pane-focus={showHeading ? '' : undefined}>
        <header className="list-header">
          <div className="list-title-row">
            {showHeading && <h2 className="list-title" id={headingId}>
              <span className="list-name">{PAGE.title}</span>
            </h2>}
            {entries.length > 0 && (
              <button
                type="button"
                className="btn btn-small btn-danger"
                aria-disabled={busy || undefined}
                onClick={(event) => {
                  if (busy) return
                  askedFrom.current = event.currentTarget
                  ask(null)
                }}
              >
                <Icon name="trash" size={14} />
                清空历史…
              </button>
            )}
          </div>
        </header>

        <div className="list-status">
          {done !== null && (
            <p className="notice-inline" role="status">
              <Icon name="check" size={14} />
              {done}
            </p>
          )}
          {list.status === 'failed' && (
            <div className="notice notice-error is-compact" role="alert">
              <Icon name="alert" className="notice-icon" />
              <p className="notice-text">
                {PAGE.title}读取失败：{contentFailureText(list.refused)}
              </p>
              <button type="button" className="btn btn-small" onClick={() => void load()}>
                重试
              </button>
            </div>
          )}
        </div>

        {list.status === 'ready' && entries.length === 0 && (
          <div className="list-empty" role="status">
            <p className="list-empty-title">{PAGE.empty}</p>
          </div>
        )}

        {entries.length > 0 && (
          <ListFilterBar
            key="history"
            filters={listFilters}
            onChange={changeFilters}
            forums={forumNames}
            noun="串"
            total={entries.length}
            result={filtered}
            metadata={filtering ? metadata : null}
            coverage={`本机的${PAGE.title}列表`}
          />
        )}
        {filtering && entries.length > 0 && filtered.shown.length === 0 && (
          <p className="list-filters-empty" role="status">
            {PAGE.title}中没有符合筛选的串。
          </p>
        )}

        {filtered.shown.length > 0 && (
          <ul
            className="thread-list"
            ref={listRef}
            aria-label={filtering ? '浏览（已筛选）' : '浏览'}
            onKeyDown={roving.onKeyDown}
          >
            {filtered.shown.map(({ item: entry, uncertain }) => {
              const head = entry.head
              const title = meaningfulTitle(head?.title ?? entry.title)
              const name = meaningfulName(head?.name ?? null)
              const hasImage = head?.image != null
              const excerpt = entry.excerpt?.trim() || null
              const selected = entry.threadId === selectedThreadId
              const rowClass = ['thread-row', hasImage && 'has-thumb', selected && 'is-selected'].filter(Boolean).join(' ')
              return (
                <li
                  key={entry.threadId}
                  className={rowMenu?.threadId === entry.threadId ? 'history-row is-menu-open' : 'history-row'}
                  data-retained-row=""
                  {...listRowGestures(
                    (event) => openRowMenu(entry.threadId, event),
                    openInTab === null ? null : () => openInTab(entry.threadId, null)
                  )}
                >
                  <button
                    type="button"
                    className={rowClass}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => onOpenThread(entry.threadId, null)}
                    {...roving.itemProps(entry.threadId)}
                  >
                    <span className="row-text">
                      {head !== null && <span className="row-byline">
                        <span className="row-author">
                          {head.userHash !== null && <CookieId cookieId={head.userHash} admin={head.isAdmin === true} />}
                          {head.isSage === true && <span className="tag tag-sage">SAGE</span>}
                        </span>
                        {head.createdAt !== null && <span className="row-time">{formatForumTime(head.createdAt)}</span>}
                      </span>}
                      {title !== null && <span className="row-title">{title}</span>}
                      {name !== null && <span className="row-name">{name}</span>}
                      {excerpt !== null && <span className="row-excerpt is-plain">{excerpt}</span>}
                      <span className="row-meta">
                        <span>No.{entry.threadId}</span>
                        <span>{PAGE.at} {formatRecordTime(entry.at)}</span>
                        {entry.offline !== null && (
                          <span className="retained-tag"><Icon name="download" size={13} />有离线副本</span>
                        )}
                        {hasImage && <span className="visually-hidden">附图</span>}
                        {uncertain && <UncertainTag />}
                      </span>
                    </span>
                    {hasImage && <RowThumbnail postId={entry.threadId} scope={images} />}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <div className="list-footer" />
      </div>
      {rowMenu !== null && menuEntry !== undefined && (
        <ContextMenu
          key={`menu:${rowMenu.threadId}`}
          point={rowMenu.point}
          label={`串操作：${retainedHeading(menuEntry).text}`}
          items={[
            ...(openInTab === null
              ? []
              : [
                  { type: 'action', key: 'open-tab', label: '在新标签页打开', onSelect: () => openInTab(menuEntry.threadId, null) } satisfies ContextMenuItem,
                  { type: 'separator', key: 'open-separator' } satisfies ContextMenuItem
                ]),
            {
              type: 'action',
              key: 'delete',
              label: '删除…',
              disabled: busy,
              title: busy ? '正在删除' : undefined,
              onSelect: () => {
                askedFrom.current = rowMenu.row
                ask(menuEntry.threadId)
              }
            }
          ]}
          onClose={closeRowMenu}
        />
      )}
      {confirming !== null && (
        <HistoryConfirm
          key={confirming.threadId ?? '*'}
          confirming={confirming}
          title={confirmingEntry === undefined ? undefined : retainedHeading(confirmingEntry).text}
          busy={busy}
          failure={failure !== null && failure.threadId === confirming.threadId ? failure.text : null}
          onChange={setConfirming}
          onConfirm={() => void clearHistory(confirming)}
          onCancel={() => {
            setConfirming(null)
            setFailure(null)
          }}
          fallbackFocus={() => {
            const from = askedFrom.current
            return from?.isConnected === true ? from : bodyRef.current
          }}
        />
      )}
    </section>
  )
}
