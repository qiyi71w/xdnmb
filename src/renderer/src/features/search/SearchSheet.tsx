import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react'
import type { AppPlatform } from '../../../../shared/api'
import type { ForumId, ThreadId } from '../../../../shared/forum'
import type { SearchHit } from '../../../../shared/search'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { Loading } from '../../components/Notices'
import { meaningfulTitle } from '../../lib/format'
import { useRovingFocus } from '../../lib/useRovingFocus'
import { FilterFields, FilterRules, UncertainTag } from './FilterFields'
import { contentFilterCount } from './listFilters'
import {
  coverageText,
  failureText,
  fetchText,
  highlightParts,
  imageText,
  locationText,
  MODE_TEXT,
  readErrorText,
  RETENTION_TEXT
} from './searchText'
import type { HitLocate, RebuildState, SearchRun, SearchView, TabSearch } from './searchState'
import { filtersSearchable, MAX_QUERY_LENGTH, type SearchCommands } from './useSearch'
import { shortcutLabel } from '../../app/shortcuts'
import { PROTOTYPE_ENABLED } from '../directory/prototype/prototypeStore'
import { useThreadTabMenu, type ThreadTabMenu } from '../tabs/ThreadTabMenu'
import './search.css'

const VIEW_TEXT: Record<SearchView, string> = { local: '本机内容', thread: '当前串' }

/**
 * Search sheet of one tab (spec I10 / I11): 本机内容 searches every retained title and body
 * (normal cache, offline copies, subscription records); 当前串 searches the thread on screen in
 * either mode without changing how it is read, and can fetch the whole thread on request. The
 * sheet is modal: the reader below judges nothing read while it is open, and results shown here
 * never count as reading. Esc cancels a running locate first, then closes. PROTOTYPE: 本机内容 is
 * the 搜索 page instead, so the sheet is 串内搜索 only.
 */
export function SearchSheet({
  tabId,
  tab,
  rebuild,
  focus,
  focusSeq,
  restoreSeq,
  commands,
  forums,
  platform,
  fallbackFocus
}: {
  tabId: number
  tab: TabSearch
  rebuild: RebuildState
  focus: 'input' | 'hit'
  focusSeq: number
  /** Restore generation this sheet shows: its text writes are dropped after a later restore. */
  restoreSeq: number
  commands: SearchCommands
  forums: ReadonlyMap<ForumId, string>
  platform: AppPlatform | null
  fallbackFocus: () => HTMLElement | null
}) {
  const titleId = useId()
  const view = tab.view
  const scope = tab.thread.scope
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  // Opening (or asking again) puts focus on the query, or back on the hit that was opened. Runs
  // after the dialog's own layout effect has shown it.
  useLayoutEffect(() => {
    focusSearch({ input: inputRef, list: listRef }, tab, view, focus)
    // Only a new request moves focus, not every update of the results.
  }, [focusSeq])

  const onEscape = () => {
    if (commands.cancelLocate(tabId)) return
    commands.close()
  }

  return (
    <Modal className="search-sheet" labelledBy={titleId} onClose={onEscape} fallbackFocus={fallbackFocus}>
      <header className="modal-header search-header">
        <h2 className="modal-title" id={titleId}>
          {PROTOTYPE_ENABLED ? '串内搜索' : '搜索'}
        </h2>
        {!PROTOTYPE_ENABLED && (
          <div className="segmented" role="group" aria-label="搜索什么">
            {(['local', 'thread'] as const).map((item) => (
              <button
                key={item}
                type="button"
                className="segmented-item"
                aria-pressed={view === item}
                disabled={item === 'thread' && scope === null}
                title={
                  item === 'thread'
                    ? scope === null
                      ? '先打开一个串，再搜索它的内容'
                      : `搜索 No.${scope.threadId}（${shortcutLabel('search-thread', platform)}）`
                    : `搜索本机保有的全部内容（${shortcutLabel('search-local', platform)}）`
                }
                onClick={() => commands.setView(tabId, item)}
              >
                {VIEW_TEXT[item]}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="icon-btn search-close" onClick={() => commands.close()} aria-label="关闭搜索" title="关闭（Esc）">
          <Icon name="close" />
        </button>
      </header>

      <SearchBody
        className="modal-body search-body"
        tabId={tabId}
        tab={tab}
        view={view}
        rebuild={rebuild}
        restoreSeq={restoreSeq}
        commands={commands}
        forums={forums}
        focusRefs={{ input: inputRef, list: listRef }}
      />
    </Modal>
  )
}

/** Where a search body's owner moves focus: its query field and its hit list. */
export interface SearchFocusRefs {
  input: RefObject<HTMLInputElement | null>
  list: RefObject<HTMLUListElement | null>
}

/** Focus on the query (text selected), or with `hit` back on the hit last chosen in `view` if listed. */
export function focusSearch(refs: SearchFocusRefs, tab: TabSearch, view: SearchView, focus: 'input' | 'hit'): void {
  const last = tab.lastHit
  if (focus === 'hit' && last !== null && last.view === view) {
    const hit = refs.list.current?.querySelector<HTMLElement>(`[data-hit="${CSS.escape(last.postId)}"]`)
    if (hit != null) {
      hit.focus()
      return
    }
  }
  refs.input.current?.focus()
  refs.input.current?.select()
}

/**
 * What one view of a tab's search shows: query, filters, coverage, index state, run status and
 * hits. The sheet shows it for either view; the PROTOTYPE 搜索 page shows its 本机 side with it.
 * Typing stays here (the shell does not re-render per key); the text is handed to the tab's search
 * on submit, on switching views and on unmount. Its owner moves focus (`focusSearch`).
 */
export function SearchBody({
  className,
  tabId,
  tab,
  view,
  rebuild,
  restoreSeq,
  commands,
  forums,
  focusRefs,
  brief = false,
  tabMenu = false
}: {
  className: string
  tabId: number
  tab: TabSearch
  view: SearchView
  rebuild: RebuildState
  /** Text writes are dropped after a later restore; none: this body is never replaced by one. */
  restoreSeq?: number
  commands: SearchCommands
  forums: ReadonlyMap<ForumId, string>
  focusRefs: SearchFocusRefs
  /** Only what is needed to search (PROTOTYPE page): no hint or explanatory sentences. */
  brief?: boolean
  /** Hits offer 在新标签页打开 (not in the modal sheet, whose top layer would hide the menu). */
  tabMenu?: boolean
}) {
  const inputId = useId()
  const filtersId = useId()
  const hintId = useId()
  const session = tab[view]
  const run = session.run
  const scope = tab.thread.scope
  const { input: inputRef, list: listRef } = focusRefs
  const filterCount = contentFilterCount(session.filters)
  const [filtersOpen, setFiltersOpen] = useState(filterCount > 0)

  const [draft, setDraft] = useState({ view, text: session.input })
  if (draft.view !== view) setDraft({ view, text: session.input })
  const text = draft.view === view ? draft.text : session.input
  const latest = useRef({ view, text })
  useLayoutEffect(() => {
    // The view changed (switch button, or Ctrl/Cmd+F while open): the other view keeps its text.
    const before = latest.current
    if (before.view !== view) commands.setInput(tabId, before.view, before.text, restoreSeq)
    latest.current = { view, text }
  })
  useEffect(
    () => () => {
      const { view: lastView, text: lastText } = latest.current
      commands.setInput(tabId, lastView, lastText, restoreSeq)
    },
    [commands, tabId, restoreSeq]
  )

  const query = text.trim()
  const searchable = query !== '' && query.length <= MAX_QUERY_LENGTH && filtersSearchable(session.filters)
  const running = run !== null && (run.status === 'running' || run.waiting) && run.status !== 'stopped'
  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (!searchable) return
    commands.setInput(tabId, view, text)
    commands.submit(tabId, view)
  }

  const hitIds = useMemo(() => (run?.hits ?? []).map((hit) => hit.postId), [run])
  const roving = useRovingFocus(hitIds, tab.lastHit?.view === view ? tab.lastHit.postId : null)
  const inTab = useThreadTabMenu()

  const indexMissing = run?.failure === 'index-unavailable'
  const showRebuild = indexMissing || rebuild.status === 'running'

  return (
    <div className={className}>
      <form className="search-form" role="search" onSubmit={onSubmit}>
        <label className="visually-hidden" htmlFor={inputId}>
          {view === 'local' ? '在本机内容中搜索' : '在当前串中搜索'}
        </label>
        <div className="search-field">
          <Icon name="search" className="search-field-icon" />
          <input
            ref={inputRef}
            id={inputId}
            type="search"
            className="search-input"
            value={text}
            maxLength={MAX_QUERY_LENGTH}
            autoComplete="off"
            spellCheck={false}
            placeholder={view === 'local' ? '标题或正文中的文字' : '这个串里的文字'}
            aria-describedby={brief ? undefined : hintId}
            onChange={(event) => setDraft({ view, text: event.target.value })}
          />
        </div>
        {running ? (
          <button type="button" className="btn" onClick={() => commands.stop(tabId, view)}>
            <Icon name="close" size={14} />
            停止
          </button>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={!searchable}>
            搜索
          </button>
        )}
        <button
          type="button"
          className={filterCount > 0 ? 'btn filter-toggle is-active' : 'btn filter-toggle'}
          aria-expanded={filtersOpen}
          aria-controls={filtersId}
          aria-label={filterCount > 0 ? `筛选（已启用 ${filterCount} 项）` : '筛选'}
          onClick={() => setFiltersOpen((value) => !value)}
        >
          <Icon name="filter" size={14} />
          筛选
          {filterCount > 0 && <span className="btn-count">{filterCount}</span>}
        </button>
      </form>
      {!brief && (
        <p className="search-hint" id={hintId}>
          按字面文字查找（不区分大小写，引号、星号等符号也按原样），提交后才搜索。不搜索草稿和饼干。
        </p>
      )}

      <div className="search-filters" id={filtersId} hidden={!filtersOpen}>
        <FilterFields value={session.filters} onChange={(filters) => commands.setFilters(tabId, view, filters)} forums={forums} />
        <FilterRules />
        {!brief && <p className="filter-rules">筛选按命中的那条发言自己的版面、日期和图片判断。</p>}
      </div>

      {view === 'thread' && scope !== null && (
        <section className="search-scope" aria-label="搜索的串">
          <p className="search-scope-title">
            <span className="search-scope-name">{scope.title ?? `No.${scope.threadId}`}</span>
            {scope.title !== null && <span className="search-scope-no">No.{scope.threadId}</span>}
          </p>
          <div className="search-scope-row">
            <div className="segmented" role="group" aria-label="搜索的回复">
              {(['all', 'po'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className="segmented-item"
                  aria-pressed={scope.mode === mode}
                  onClick={() => commands.setThreadMode(tabId, mode)}
                >
                  {MODE_TEXT[mode]}
                </button>
              ))}
            </div>
            <span className="search-scope-note">只改变搜索范围，不改变阅读模式</span>
          </div>
          {run?.coverage?.thread != null && (
            <p className="search-coverage">
              <Icon name="info" size={14} />
              <span>{coverageText(run.coverage.thread)}。只搜索这些已取得的页，不代表整串。</span>
            </p>
          )}
          <FetchBlock tab={tab} tabId={tabId} commands={commands} />
        </section>
      )}

      {view === 'local' && run?.coverage != null && (
        <p className="search-coverage">
          <Icon name="info" size={14} />
          <span>
            {brief
              ? `在本机保有的 ${run.coverage.retainedThreads} 个串、${run.coverage.retainedPosts} 条发言中搜索`
              : `在本机保有的 ${run.coverage.retainedThreads} 个串、${run.coverage.retainedPosts} 条发言中搜索：普通缓存、离线副本和订阅记录中的标题与正文。普通缓存被清理后，其中的内容就搜不到了。`}
          </span>
        </p>
      )}

      {showRebuild && <RebuildBlock rebuild={rebuild} indexMissing={indexMissing} commands={commands} />}
      {!showRebuild && rebuild.status !== 'idle' && <RebuildResult rebuild={rebuild} />}

      {run !== null && (
        <RunStatus run={run} brief={brief} onMore={() => commands.more(tabId, view)} onRerun={() => commands.submit(tabId, view, run.query)} />
      )}

      {run !== null && run.hits.length > 0 && (
        <ul className="search-hits" ref={listRef} aria-label={`搜索结果，已显示 ${run.hits.length} 条`} onKeyDown={roving.onKeyDown}>
          {run.hits.map((hit) => (
            <HitRow
              key={hit.postId}
              hit={hit}
              query={run.query}
              forumName={hit.forumId === null ? null : (forums.get(hit.forumId) ?? `版面 ${hit.forumId}`)}
              locate={tab.locate !== null && tab.locate.view === view && tab.locate.postId === hit.postId ? tab.locate : null}
              itemProps={roving.itemProps(hit.postId)}
              inTab={inTab}
              tabThreadId={tabMenu ? hit.threadId : null}
              onChoose={() => commands.chooseHit(tabId, view, hit, 'navigate')}
              onRetry={() => commands.chooseHit(tabId, view, hit, 'resolve')}
              onOpenThread={() => commands.openHitThread(tabId)}
              onDismiss={() => commands.dismissLocate(tabId)}
            />
          ))}
        </ul>
      )}
      {inTab.menu}
    </div>
  )
}

function RunStatus({ run, brief, onMore, onRerun }: { run: SearchRun; brief: boolean; onMore: () => void; onRerun: () => void }) {
  const count = run.hits.length
  let body: ReactNode
  switch (run.status) {
    case 'running':
      body = <Loading live={false}>正在搜索…已找到 {count} 条</Loading>
      break
    case 'paused':
      body = (
        <>
          <span>已找到 {count} 条，还有没搜索到的内容</span>
          <button type="button" className="btn btn-small" onClick={onMore}>
            继续搜索
          </button>
        </>
      )
      break
    case 'done':
      body =
        count === 0 ? (
          <span className="search-empty">
            <strong>没有找到「{run.query}」</strong>
            {!brief && <span>只说明本机目前保有的内容里没有，不代表论坛上没有。</span>}
          </span>
        ) : (
          <span>共找到 {count} 条</span>
        )
      break
    case 'stopped':
      body = (
        <>
          <span>已停止，显示停止前找到的 {count} 条</span>
          <button type="button" className="btn btn-small" onClick={onRerun}>
            重新搜索
          </button>
        </>
      )
      break
    case 'failed':
      if (run.failure === 'index-unavailable') return null
      body = (
        <span className="search-failure">
          <Icon name="alert" size={14} />
          <span>
            {run.failure === null ? '搜索失败' : failureText(run.failure)}
            {count > 0 && `，保留已找到的 ${count} 条`}
          </span>
          <button type="button" className="btn btn-small" onClick={onRerun}>
            {run.failure === 'expired' ? '重新搜索' : '重试'}
          </button>
        </span>
      )
      break
  }
  return (
    <div className="search-status" role="status">
      {body}
    </div>
  )
}

function RebuildBlock({ rebuild, indexMissing, commands }: { rebuild: RebuildState; indexMissing: boolean; commands: SearchCommands }) {
  const running = rebuild.status === 'running'
  return (
    <div className="notice notice-error search-index" role="alert">
      <Icon name="alert" className="notice-icon" />
      <div className="notice-text">
        <p className="notice-title">{indexMissing ? '搜索索引不可用，这次没有执行搜索' : '正在重建搜索索引'}</p>
        <p className="notice-detail">
          这不是“没有结果”。重建只整理本机已保有的内容，不联网，也不改动阅读记录；可以随时取消。
        </p>
        {running && <Loading>{rebuild.cancelling ? '正在取消重建…' : '正在重建索引…'}</Loading>}
      </div>
      {running ? (
        <button type="button" className="btn btn-small" onClick={commands.cancelRebuild} disabled={rebuild.cancelling}>
          取消重建
        </button>
      ) : (
        <button type="button" className="btn btn-small" onClick={commands.rebuild}>
          重建索引
        </button>
      )}
    </div>
  )
}

function RebuildResult({ rebuild }: { rebuild: Exclude<RebuildState, { status: 'idle' } | { status: 'running' }> }) {
  const text =
    rebuild.status === 'done'
      ? rebuild.rebuilt
        ? '搜索索引已重建'
        : '重建已结束，索引没有变化'
      : rebuild.status === 'cancelled'
        ? '已取消重建，索引可能仍不可用'
        : `重建失败：${failureText(rebuild.failure)}`
  return (
    <p className={rebuild.status === 'done' ? 'notice-inline' : 'notice-inline is-warning'} role="status">
      <Icon name={rebuild.status === 'done' ? 'check' : 'alert'} size={14} />
      {text}
    </p>
  )
}

/** 获取完整串并搜索: explicit, cancellable, showing the pages actually obtained. */
function FetchBlock({ tab, tabId, commands }: { tab: TabSearch; tabId: number; commands: SearchCommands }) {
  const fetch = tab.thread.fetch
  const status = fetch?.status ?? null
  const running = fetch !== null && fetch.failure === null && (status === null || status.state === 'running')
  return (
    <div className="search-fetch">
      {fetch === null && (
        <p className="search-fetch-text">默认只搜索本机已有的内容。获取会按页读取这个串的全部回复并存入普通缓存，不会标为已读，可以随时取消。</p>
      )}
      {running && (
        <Loading>{fetch.cancelling ? '正在取消获取…' : status === null ? '正在开始获取…' : fetchText(status)}</Loading>
      )}
      {!running && status !== null && (
        <p className={status.state === 'stopped' && status.error === null ? 'search-fetch-text' : 'search-fetch-text is-warning'} role="status">
          {fetchText(status)}
        </p>
      )}
      {status !== null && (
        <p className="search-fetch-coverage">
          {coverageText(status.coverage)}。末尾候选只说明读取时没有更多回复，不代表与论坛完全一致。
        </p>
      )}
      {fetch !== null && fetch.failure !== null && (
        <p className="search-fetch-text is-warning" role="status">
          获取未进行或状态读取失败：{failureText(fetch.failure)}
        </p>
      )}
      <div className="search-fetch-actions">
        {running ? (
          <button type="button" className="btn btn-small" onClick={() => commands.cancelFetch(tabId)} disabled={fetch.cancelling}>
            取消获取
          </button>
        ) : (
          <button type="button" className="btn btn-small" onClick={() => commands.fetchThread(tabId)}>
            <Icon name="download" size={14} />
            {fetch === null ? '获取完整串并搜索' : '再次获取'}
          </button>
        )}
        {!running && status !== null && status.pages.length > 0 && tab.thread.run !== null && (
          <span className="search-fetch-note">获取结束后已用取得的内容重新搜索</span>
        )}
      </div>
    </div>
  )
}

function Highlighted({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => highlightParts(text, query), [text, query])
  return (
    <>
      {parts.map((part, index) => (part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>))}
    </>
  )
}

function HitRow({
  hit,
  query,
  forumName,
  locate,
  itemProps,
  inTab,
  tabThreadId,
  onChoose,
  onRetry,
  onOpenThread,
  onDismiss
}: {
  hit: SearchHit
  query: string
  forumName: string | null
  locate: HitLocate | null
  itemProps: { 'data-roving-item': string; tabIndex: number; onFocus: () => void }
  inTab: ThreadTabMenu
  /** The thread 在新标签页打开 opens; null: not offered. */
  tabThreadId: ThreadId | null
  onChoose: () => void
  onRetry: () => void
  onOpenThread: () => void
  onDismiss: () => void
}) {
  const statusId = useId()
  const threadTitle = meaningfulTitle(hit.threadTitle)
  const title = meaningfulTitle(hit.title)
  const isHead = hit.threadId !== null && hit.threadId === hit.postId
  return (
    <li className={locate !== null ? 'search-hit is-locating' : 'search-hit'}>
      <button
        type="button"
        className="search-hit-main"
        data-hit={hit.postId}
        aria-describedby={locate !== null ? statusId : undefined}
        onClick={(event) => {
          if (!inTab.openFromClick(event, tabThreadId)) onChoose()
        }}
        {...inTab.rowProps(tabThreadId)}
        {...itemProps}
      >
        <span className="search-hit-post">
          <span className="search-hit-kind">{isHead ? '主帖' : '回复'}</span>
          <span className="search-hit-no">No.{hit.postId}</span>
          {hit.createdAt !== null && <span className="search-hit-time">{hit.createdAt}</span>}
        </span>
        {title !== null && (
          <span className="search-hit-title">
            <Highlighted text={title} query={query} />
          </span>
        )}
        <span className="search-hit-excerpt">
          <Highlighted text={hit.excerpt} query={query} />
        </span>
        <span className="search-hit-meta">
          {forumName !== null && <span>{forumName}</span>}
          <span className="search-hit-thread">
            {hit.threadId === null ? '所属串未知' : threadTitle !== null ? `${threadTitle} · No.${hit.threadId}` : `串 No.${hit.threadId}`}
          </span>
          <span>{imageText(hit.hasImage)}</span>
          <span className={hit.retention === 'cache' ? 'tag' : 'tag tag-po'}>{RETENTION_TEXT[hit.retention]}</span>
          <span className="search-hit-location">{locationText(hit.location)}</span>
          {hit.uncertainFilters && <UncertainTag />}
        </span>
      </button>
      {locate !== null && (
        <LocateStatus id={statusId} locate={locate} onRetry={onRetry} onOpen={onChoose} onOpenThread={onOpenThread} onDismiss={onDismiss} />
      )}
    </li>
  )
}

function LocateStatus({
  id,
  locate,
  onRetry,
  onOpen,
  onOpenThread,
  onDismiss
}: {
  id: string
  locate: HitLocate
  /** Resolve-only: finds out where the hit is now, never jumps. */
  onRetry: () => void
  /** Choosing the hit again: locates it afresh and opens it. */
  onOpen: () => void
  onOpenThread: () => void
  onDismiss: () => void
}) {
  const result = locate.result
  if (result === null && !locate.internal) {
    return (
      <div className="search-locate" id={id}>
        <Loading>
          {locate.intent === 'open-thread'
            ? '正在打开原串…（Esc 取消）'
            : locate.intent === 'resolve'
              ? '正在重新定位，不会自动跳转…（Esc 取消）'
              : '正在定位这条发言…（Esc 取消）'}
        </Loading>
      </div>
    )
  }
  let text: string
  let action: { label: string; run: () => void } | null = { label: '重试', run: onRetry }
  if (locate.internal && result?.status === 'thread-known') {
    text = '打开原串的请求失败（应用内部）'
    action = { label: '打开原串', run: onOpenThread }
  } else if (locate.internal && result === null) {
    text = '定位请求失败（应用内部）'
  } else if (result === null || result.status === 'cancelled') {
    return null
  } else if (result.status === 'located') {
    // Only a resolve-only retry stores a located result; a chosen hit has opened instead.
    const mode = result.target.mode === 'po' ? '只看 PO ' : ''
    return (
      <div className="search-locate" id={id} role="status">
        <Icon name="check" size={14} className="search-locate-icon" />
        <span className="search-locate-text">
          现在可以定位：串 No.{result.threadId} {mode}第 {result.target.page} 页{result.source === 'cached' ? '（网络读取失败，按本地缓存核对）' : ''}。重试不会跳转。
        </span>
        <button type="button" className="btn btn-small" onClick={onOpen}>
          打开
        </button>
        <button type="button" className="btn btn-small btn-quiet" onClick={onDismiss}>
          知道了
        </button>
      </div>
    )
  } else if (result.status === 'thread-known') {
    text = `所属串 No.${result.threadId} 已知，但记录的页面中没有找到这条发言；不会把别处当成它。`
    action = { label: '打开原串', run: onOpenThread }
  } else if (result.status === 'unknown-thread') {
    text = '本机没有这条发言所属串的记录，无法定位；不会猜测所属串。'
    action = null
  } else {
    const unavailable = result.error.kind === 'not-found' || result.error.kind === 'permission'
    text = `定位失败：${readErrorText(result.error)}${unavailable ? '' : '。阅读位置没有改变'}`
    if (unavailable) action = null
  }
  return (
    <div className="search-locate is-failed" id={id} role="alert">
      <Icon name="alert" size={14} className="search-locate-icon" />
      <span className="search-locate-text">{text}</span>
      {action !== null && (
        <button type="button" className="btn btn-small" onClick={action.run}>
          {action.label}
        </button>
      )}
      <button type="button" className="btn btn-small btn-quiet" onClick={onDismiss}>
        知道了
      </button>
    </div>
  )
}
