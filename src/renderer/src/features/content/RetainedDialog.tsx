import { useId, useMemo, useState } from 'react'
import type { RetainedEntry, RetainedList } from '../../../../shared/content'
import type { ForumId, ThreadId } from '../../../../shared/forum'
import { Icon, type IconName } from '../../components/Icon'
import { Modal, ModalHeader } from '../../components/Modal'
import { Loading } from '../../components/Notices'
import { formatLocalTime } from '../../lib/format'
import { attempt, contentFailureText, retainedHeading } from './contentText'
import type { FavoriteWrites } from './favoriteWrites'
import type { ReadingResets } from './readingResets'
import { HistoryConfirm, useRetainedList } from './retainedList'
import { OfflineSummary } from './ThreadRetention'
import { ReminderMenu } from '../reminders/ReminderMenu'
import { useThreadRules } from '../reminders/useReminders'
import { ListFilterBar, UncertainTag } from '../search/FilterFields'
import { filterList, listFilterCount, NO_LIST_FILTERS, type ListFilters } from '../search/listFilters'
import { useThreadMetadata } from '../search/useThreadMetadata'
import './content.css'

const LISTS: { kind: RetainedList; label: string; icon: IconName; at: string; empty: string; emptyHelp: string }[] = [
  {
    kind: 'favorites',
    label: '收藏',
    icon: 'star',
    at: '收藏于',
    empty: '还没有收藏',
    emptyHelp: '在串的工具栏点“收藏”。收藏只保存入口，不下载整串。'
  },
  {
    kind: 'history',
    label: '历史',
    icon: 'history',
    at: '最近访问',
    empty: '没有浏览历史',
    emptyHelp: '打开过的串会记在这里，保留到你手动删除。'
  },
  {
    kind: 'offline',
    label: '离线',
    icon: 'download',
    at: '最近更新',
    empty: '还没有离线副本',
    emptyHelp: '在串的工具栏点“离线保存”，可保存文字和原图或仅文字。'
  }
]

/**
 * 收藏 / 历史 / 离线 lists. 打开 hands the thread to the shell, which shows it in the actual reader
 * of the active tab. History deletion removes visit records only unless the reader's progress and
 * read records are explicitly included; it never clears favorites, offline copies, drafts,
 * reminders or sync records.
 */
export function RetainedDialog({
  initial,
  resets,
  favorites,
  filters: filterMemory,
  forumNames,
  onOpenThread,
  onClose,
  fallbackFocus
}: {
  initial: RetainedList
  /** Shell's reading-reset store: readers of a thread whose reading data is cleared start again. */
  resets: ReadingResets
  /** Shell's favorite store: 收藏 buttons of open readers follow what this list writes. */
  favorites: FavoriteWrites
  /** Filters of each list, kept by the shell while the app runs. */
  filters: Map<RetainedList, ListFilters>
  forumNames: ReadonlyMap<ForumId, string>
  onOpenThread: (threadId: ThreadId) => void
  onClose: () => void
  fallbackFocus?: () => HTMLElement | null
}) {
  const titleId = useId()
  const [kind, setKind] = useState<RetainedList>(initial)
  const {
    list,
    entries,
    load,
    confirming,
    setConfirming,
    busy,
    setBusy,
    failure,
    setFailure,
    done,
    setDone,
    alive,
    listRef,
    bodyRef,
    confirmRef,
    ask,
    removeRows,
    clearHistory
  } = useRetainedList(kind, resets)
  const info = LISTS.find((item) => item.kind === kind) ?? (LISTS[0] as (typeof LISTS)[number])

  const unfavorite = async (entry: RetainedEntry) => {
    if (busy) return
    setBusy(true)
    setFailure(null)
    setDone(null)
    const result = await attempt(() => window.xidao.content.favorite({ threadId: entry.threadId, favorite: false }))
    if (result?.ok === true) favorites.written(entry.threadId, result.value)
    if (!alive.current) return
    setBusy(false)
    if (result?.ok === true && !result.value) {
      setDone(`已取消收藏「${retainedHeading(entry).text}」`)
      removeRows(entry.threadId)
    } else {
      setFailure({ threadId: entry.threadId, text: `取消收藏未完成：${contentFailureText(result?.ok === false ? result : null)}` })
    }
  }

  // 收藏 rows carry each thread's 提醒 control; favorites and reminders stay independent records.
  const favoriteIds = useMemo(
    () => (kind === 'favorites' && list.status === 'ready' ? list.entries.map((entry) => entry.threadId) : []),
    [kind, list]
  )
  const rules = useThreadRules(favoriteIds)
  const confirmingAll = confirming !== null && confirming.threadId === null

  // Filters choose among the entries listed; the fields come from local records of each thread's
  // main post (and its unread count for 收藏). Nothing is downloaded and nothing is marked read.
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

  return (
    <Modal className="retained-dialog" labelledBy={titleId} onClose={busy ? () => undefined : onClose} fallbackFocus={fallbackFocus}>
      <ModalHeader title={info.label === '离线' ? '离线副本' : info.label} titleId={titleId} closeLabel="关闭" onClose={onClose} closeDisabled={busy} />
      <div className="modal-body retained-body" ref={bodyRef}>
        <div className="retained-head">
          <div className="segmented" role="group" aria-label="列表">
            {LISTS.map((item) => (
              <button
                key={item.kind}
                type="button"
                className="segmented-item"
                aria-pressed={kind === item.kind}
                disabled={busy}
                onClick={() => setKind(item.kind)}
              >
                {item.label}
              </button>
            ))}
          </div>
          {kind === 'history' && entries.length > 0 && !confirmingAll && (
            <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={(event) => ask(null, event.currentTarget)}>
              <Icon name="trash" size={14} />
              清空历史…
            </button>
          )}
        </div>

        {kind === 'history' && (
          <p className="retained-note">删除历史默认只删访问记录，不影响收藏、离线副本、草稿、提醒和同步记录，也不是完整的隐私清除。</p>
        )}
        {kind === 'offline' && (
          <p className="retained-note">离线副本不随普通缓存清理。更新和取消在串的工具栏“离线”中进行。</p>
        )}

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

        {done !== null && (
          <p className="notice-inline" role="status">
            <Icon name="check" size={14} />
            {done}
          </p>
        )}

        {list.status === 'loading' && <Loading>正在读取{info.label}…</Loading>}
        {list.status === 'failed' && (
          <div className="notice notice-error" role="alert">
            <Icon name="alert" className="notice-icon" />
            <div className="notice-text">
              <p className="notice-title">
                {info.label}读取失败：{contentFailureText(list.refused)}
              </p>
            </div>
            <button type="button" className="btn btn-small" onClick={() => void load(kind)}>
              重试
            </button>
          </div>
        )}
        {list.status === 'ready' && entries.length === 0 && (
          <div className="retained-empty" role="status">
            <p className="retained-empty-title">{info.empty}</p>
            <p className="retained-empty-text">{info.emptyHelp}</p>
          </div>
        )}
        {entries.length > 0 && (
          <ListFilterBar
            key={kind}
            filters={listFilters}
            onChange={changeFilters}
            forums={forumNames}
            unreadOffered={kind === 'favorites'}
            noun="串"
            total={entries.length}
            result={filtered}
            metadata={filtering ? metadata : null}
            coverage={`本机的${info.label}列表`}
          />
        )}
        {filtering && entries.length > 0 && filtered.shown.length === 0 && (
          <p className="list-filters-empty" role="status">
            {info.label}中没有符合筛选的串。
          </p>
        )}
        {filtered.shown.length > 0 && (
          <ul className="retained-list" ref={listRef} aria-label={`${info.label}，显示 ${filtered.shown.length} / ${entries.length} 项`}>
            {filtered.shown.map(({ item: entry, uncertain }) => {
              const rowId = `retained-${kind}-${entry.threadId}`
              const heading = retainedHeading(entry)
              const title = heading.text
              const rowConfirming = confirming !== null && confirming.threadId === entry.threadId
              return (
                <li key={entry.threadId} className="retained-item" aria-labelledby={`${rowId}-title`} data-retained-row="">
                  <div className="retained-text">
                    <p className={heading.source === 'excerpt' ? 'retained-title is-excerpt' : 'retained-title'} id={`${rowId}-title`}>
                      {title}
                    </p>
                    <p className="retained-meta">
                      {heading.source !== 'number' && <span>No.{entry.threadId}</span>}
                      <span>
                        {info.at} {formatLocalTime(entry.at)}
                      </span>
                      {kind !== 'offline' && entry.offline !== null && (
                        <span className="retained-tag">
                          <Icon name="download" size={13} />
                          有离线副本
                        </span>
                      )}
                      {uncertain && <UncertainTag />}
                    </p>
                    {kind === 'offline' && entry.offline !== null && <OfflineSummary copy={entry.offline} compact />}
                    {failure !== null && failure.threadId === entry.threadId && !rowConfirming && (
                      <p className="notice-inline is-warning" role="alert">
                        <Icon name="alert" size={14} />
                        {failure.text}
                      </p>
                    )}
                  </div>
                  {!rowConfirming && (
                    <div className="retained-actions">
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-describedby={`${rowId}-title`}
                        disabled={busy}
                        onClick={() => onOpenThread(entry.threadId)}
                      >
                        <Icon name="chevron" size={14} />
                        打开
                      </button>
                      {kind === 'favorites' && (
                        <ReminderMenu
                          threadId={entry.threadId}
                          label={title}
                          rules={rules.rulesOf(entry.threadId)}
                          failure={rules.failure}
                          onRetry={rules.reload}
                          onUpdated={rules.updated}
                          small
                        />
                      )}
                      {kind === 'favorites' && (
                        <button
                          type="button"
                          className="btn btn-small"
                          aria-describedby={`${rowId}-title`}
                          disabled={busy}
                          onClick={() => void unfavorite(entry)}
                        >
                          <Icon name="star" size={14} />
                          取消收藏
                        </button>
                      )}
                      {kind === 'history' && (
                        <button
                          type="button"
                          className="btn btn-small btn-danger"
                          aria-describedby={`${rowId}-title`}
                          disabled={busy || confirmingAll}
                          onClick={(event) => ask(entry.threadId, event.currentTarget)}
                        >
                          <Icon name="trash" size={14} />
                          删除…
                        </button>
                      )}
                    </div>
                  )}
                  {rowConfirming && confirming !== null && (
                    <HistoryConfirm
                      confirming={confirming}
                      title={title}
                      busy={busy}
                      confirmRef={confirmRef}
                      failure={failure?.threadId === entry.threadId ? failure.text : null}
                      onChange={setConfirming}
                      onConfirm={() => void clearHistory(confirming)}
                      onCancel={() => setConfirming(null)}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </Modal>
  )
}
