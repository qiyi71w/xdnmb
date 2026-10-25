// PROTOTYPE (throwaway): 历史 and 离线 as list pages of a tab, like 订阅 and 提醒. Choosing a row opens
// the thread the way the thread lists do (beside the list when split, else a new step).

import { createContext, useContext, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ForumId, ThreadId } from '../../../../shared/forum'
import { Icon } from '../../components/Icon'
import { formatLocalTime, meaningfulName, meaningfulTitle } from '../../lib/format'
import { useRovingFocus } from '../../lib/useRovingFocus'
import { ListFilterBar, UncertainTag } from '../search/FilterFields'
import { filterList, listFilterCount, NO_LIST_FILTERS, type ListFilters } from '../search/listFilters'
import { useThreadMetadata } from '../search/useThreadMetadata'
import { ContentRegistryContext, useRegisterContent } from '../tabs/contentRegistry'
import { PROTOTYPE_ENABLED } from '../directory/prototype/prototypeStore'
import { AttemptsBody, type AttemptsBodyProps } from '../publication/AttemptsDialog'
import { RowThumbnail } from '../image/RowThumbnail'
import { useImageScope } from '../image/useImageLoad'
import { useThreadTabMenu } from '../tabs/ThreadTabMenu'
import { contentFailureText, retainedHeading } from './contentText'
import { createReadingResets } from './readingResets'
import { HistoryConfirm, useRetainedList } from './retainedList'
import { OfflineSummary } from './ThreadRetention'
import './content.css'

const PAGES = {
  history: { title: '历史', at: '最近访问', empty: '还没有浏览记录' },
  offline: { title: '离线', at: '最近更新', empty: '还没有离线副本' }
} as const

export type HistoryView = 'browsing' | 'attempts'
export interface HistoryPageHost extends AttemptsBodyProps {
  request: { tabId: number; view: HistoryView; seq: number } | null
}
export const HistoryPageContext = createContext<HistoryPageHost | null>(null)

interface RetainedPaneProps {
  tabId: number
  entryKey: number
  kind: 'history' | 'offline'
  forumNames: ReadonlyMap<ForumId, string>
  /** The thread shown beside the list (split), highlighted. */
  selectedThreadId: ThreadId | null
  onOpenThread: (threadId: ThreadId) => void
}

export function RetainedPane(props: RetainedPaneProps) {
  const host = useContext(HistoryPageContext)
  if (!PROTOTYPE_ENABLED || props.kind !== 'history' || host === null) return <RetainedListPane {...props} />
  return <HistoryPage {...props} host={host} />
}

function HistoryPage({ host, ...props }: RetainedPaneProps & { host: HistoryPageHost }) {
  const headingId = useId()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const request = host.request?.tabId === props.tabId ? host.request : null
  const [view, setView] = useState<HistoryView>(() => request?.view ?? 'browsing')
  const [attemptsVisited, setAttemptsVisited] = useState(view === 'attempts')
  const [attemptsRefresh, setAttemptsRefresh] = useState(0)
  useLayoutEffect(() => {
    if (request === null) return
    setView(request.view)
    if (request.view === 'attempts') setAttemptsVisited(true)
    headingRef.current?.focus({ preventScroll: true })
  }, [request])

  return (
    <section className="list-pane history-page" aria-labelledby={headingId}>
      <header className="list-header history-page-header">
        <h2 className="list-title" id={headingId} ref={headingRef} tabIndex={-1} data-history-heading="" data-pane-focus="">
          <span className="list-name">历史</span>
        </h2>
        <div className="segmented history-view-switch" role="group" aria-label="历史记录类型" data-view={view}>
          {(['browsing', 'attempts'] as const).map((item) => (
            <button key={item} type="button" className="segmented-item" aria-pressed={view === item} onClick={() => {
              setView(item)
              if (item === 'attempts') setAttemptsVisited(true)
            }}>
              {item === 'browsing' ? '浏览记录' : '发送记录'}
            </button>
          ))}
        </div>
      </header>
      <div className="history-page-view" hidden={view !== 'browsing'}>
        <RetainedListPane {...props} showHeading={false} displayed={view === 'browsing'}
          refreshOverride={view === 'attempts' ? () => setAttemptsRefresh((value) => value + 1) : undefined} />
      </div>
      <div className="history-page-view history-attempts-scroll" hidden={view !== 'attempts'}>
        {attemptsVisited && <AttemptsBody tabTitle={host.tabTitle} onContinue={host.onContinue} onOpenTarget={host.onOpenTarget} refreshRevision={attemptsRefresh} />}
      </div>
    </section>
  )
}

function RetainedListPane({ entryKey, kind, forumNames, selectedThreadId, onOpenThread, showHeading = true, displayed = true, refreshOverride }: RetainedPaneProps & {
  showHeading?: boolean
  displayed?: boolean
  refreshOverride?: () => void
}) {
  const page = PAGES[kind]
  const headingId = useId()
  const registry = useContext(ContentRegistryContext)
  // Outside the shell (no registry) nothing else clears reading data: a private store never resets.
  const [ownResets] = useState(createReadingResets)
  const [ownFilters] = useState(() => new Map<'history' | 'offline', ListFilters>())
  const filterMemory = registry?.retainedFilters ?? ownFilters
  const { list, entries, load, confirming, setConfirming, busy, failure, done, listRef, bodyRef, confirmRef, ask, clearHistory } =
    useRetainedList(kind, registry?.readingResets ?? ownResets)
  const images = useImageScope(bodyRef)
  const inTab = useThreadTabMenu()
  useRegisterContent('lists', entryKey, { refresh: refreshOverride ?? (() => void load(kind)) })

  // ---------- Scroll memory (runtime and restored after a quit) ----------
  const [initialScroll] = useState(() => {
    const memory = registry?.listMemory.get(entryKey)
    if (memory?.kind === 'retained') return memory.scrollTop
    return registry?.savedLists.get(entryKey)?.scrollTop ?? 0
  })
  const scrollTop = useRef(initialScroll)
  const placed = useRef(false)
  const ready = list.status === 'ready'
  useLayoutEffect(() => {
    const scroller = bodyRef.current
    if (!ready || !displayed || placed.current || scroller === null) return
    placed.current = true
    scroller.scrollTop = scrollTop.current
    registry?.savedLists.delete(entryKey)
  }, [ready, displayed, registry, entryKey, bodyRef])
  useLayoutEffect(() => {
    registry?.listMemory.set(entryKey, { kind: 'retained', scrollTop: scrollTop.current })
  })
  const onScroll = () => {
    const scroller = bodyRef.current
    if (scroller === null || scroller.clientHeight === 0 || !placed.current) return
    scrollTop.current = scroller.scrollTop
    registry?.listMemory.set(entryKey, { kind: 'retained', scrollTop: scrollTop.current })
  }

  // ---------- Filters ----------
  const [, setFilterVersion] = useState(0)
  const listFilters = filterMemory.get(kind) ?? NO_LIST_FILTERS
  const changeFilters = (next: ListFilters) => {
    filterMemory.set(kind, next)
    setFilterVersion((version) => version + 1)
  }
  const filtering = listFilterCount(listFilters) > 0
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
  const confirmingAll = confirming !== null && confirming.threadId === null

  return (
    <section className="list-pane retained-page" aria-labelledby={showHeading ? headingId : undefined} aria-label={showHeading ? undefined : '浏览记录'} aria-busy={list.status === 'loading' || undefined}>
      <div className="list-scroll" ref={bodyRef} onScroll={onScroll} tabIndex={-1} data-pane-focus={showHeading ? '' : undefined}>
        <header className="list-header">
          <div className="list-title-row">
            {showHeading && <h2 className="list-title" id={headingId}>
              <span className="list-name">{page.title}</span>
            </h2>}
            {kind === 'history' && entries.length > 0 && !confirmingAll && (
              <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={(event) => ask(null, event.currentTarget)}>
                <Icon name="trash" size={14} />
                清空历史…
              </button>
            )}
          </div>
        </header>

        {confirmingAll && confirming !== null && (
          <HistoryConfirm
            confirming={confirming}
            busy={busy}
            confirmRef={confirmRef}
            failure={failure?.threadId === null ? failure.text : null}
            onChange={setConfirming}
            onConfirm={() => void clearHistory(confirming)}
            onCancel={() => setConfirming(null)}
          />
        )}

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
                {page.title}读取失败：{contentFailureText(list.refused)}
              </p>
              <button type="button" className="btn btn-small" onClick={() => void load(kind)}>
                重试
              </button>
            </div>
          )}
        </div>

        {list.status === 'ready' && entries.length === 0 && (
          <div className="list-empty" role="status">
            <p className="list-empty-title">{page.empty}</p>
          </div>
        )}

        {entries.length > 0 && (
          <ListFilterBar
            key={kind}
            filters={listFilters}
            onChange={changeFilters}
            forums={forumNames}
            unreadOffered={false}
            noun="串"
            total={entries.length}
            result={filtered}
            metadata={filtering ? metadata : null}
            coverage={`本机的${page.title}列表`}
          />
        )}
        {filtering && entries.length > 0 && filtered.shown.length === 0 && (
          <p className="list-filters-empty" role="status">
            {page.title}中没有符合筛选的串。
          </p>
        )}

        {filtered.shown.length > 0 && (
          <ul
            className="thread-list"
            ref={listRef}
            aria-label={filtering ? `${page.title}（已筛选）` : page.title}
            onKeyDown={roving.onKeyDown}
          >
            {filtered.shown.map(({ item: entry, uncertain }) => {
              const rowId = `retained-page-${entryKey}-${entry.threadId}`
              const heading = retainedHeading(entry)
              const head = entry.head
              const title = meaningfulTitle(head?.title ?? entry.title)
              const name = meaningfulName(head?.name ?? null)
              const hasImage = head?.image != null
              const excerpt = entry.excerpt?.trim() || null
              const selected = entry.threadId === selectedThreadId
              const rowConfirming = confirming !== null && confirming.threadId === entry.threadId
              const rowFailure = failure !== null && failure.threadId === entry.threadId && !rowConfirming ? failure.text : null
              const itemProps = roving.itemProps(entry.threadId)
              const offline = kind === 'offline' ? entry.offline : null
              return (
                <li key={entry.threadId} className={selected ? 'retained-row is-selected' : 'retained-row'} data-retained-row="">
                  <button
                    type="button"
                    className="retained-open"
                    aria-current={selected ? 'true' : undefined}
                    onClick={(event) => {
                      if (!inTab.openFromClick(event, entry.threadId)) onOpenThread(entry.threadId)
                    }}
                    {...inTab.rowProps(entry.threadId)}
                    {...itemProps}
                  >
                    <span className="row-text">
                      {head !== null && <span className="row-byline">
                        <span className="row-author">
                          {head.userHash !== null && <span className={head.isAdmin === true ? 'user-hash is-admin' : 'user-hash'}>{head.userHash}</span>}
                          {head.isSage === true && <span className="tag tag-sage">SAGE</span>}
                        </span>
                        {head.createdAt !== null && <span className="row-time">{head.createdAt}</span>}
                      </span>}
                      {title !== null && <span className="row-title">{title}</span>}
                      {name !== null && <span className="row-name">{name}</span>}
                      {excerpt !== null && <span className="retained-excerpt">{excerpt}</span>}
                      <span className="visually-hidden" id={`${rowId}-title`}>{heading.text}</span>
                      <span className="row-meta">
                        <span>No.{entry.threadId}</span>
                        <span>{page.at} {formatLocalTime(entry.at)}</span>
                        {kind === 'history' && entry.offline !== null && (
                          <span className="retained-tag"><Icon name="download" size={13} />有离线副本</span>
                        )}
                        {hasImage && <span className="visually-hidden">附图</span>}
                        {uncertain && <UncertainTag />}
                      </span>
                    </span>
                    {hasImage && <RowThumbnail postId={entry.threadId} scope={images} />}
                  </button>
                  {kind === 'history' && !rowConfirming && (
                    <button
                      type="button"
                      className="icon-btn retained-row-action"
                      aria-label="删除访问记录…"
                      aria-describedby={`${rowId}-title`}
                      title="删除…"
                      tabIndex={itemProps.tabIndex}
                      disabled={busy || confirmingAll}
                      onClick={(event) => ask(entry.threadId, event.currentTarget)}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  )}
                  {(offline !== null || rowFailure !== null || rowConfirming) && (
                    <div className="retained-row-below">
                      {offline !== null && <OfflineSummary copy={offline} compact />}
                      {rowFailure !== null && (
                        <p className="notice-inline is-warning" role="alert">
                          <Icon name="alert" size={14} />
                          {rowFailure}
                        </p>
                      )}
                      {rowConfirming && confirming !== null && (
                        <HistoryConfirm
                          confirming={confirming}
                          title={heading.text}
                          busy={busy}
                          confirmRef={confirmRef}
                          failure={failure?.threadId === entry.threadId ? failure.text : null}
                          onChange={setConfirming}
                          onConfirm={() => void clearHistory(confirming)}
                          onCancel={() => setConfirming(null)}
                        />
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {inTab.menu}
        <div className="list-footer" />
      </div>
    </section>
  )
}
