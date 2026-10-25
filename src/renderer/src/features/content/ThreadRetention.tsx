import { useCallback, useContext, useEffect, useId, useRef, useState } from 'react'
import type { OfflineCopy } from '../../../../shared/content'
import type { ThreadId } from '../../../../shared/forum'
import { Icon } from '../../components/Icon'
import { Modal, ModalHeader } from '../../components/Modal'
import { Loading } from '../../components/Notices'
import { formatLocalTime, formatPageList } from '../../lib/format'
import {
  attempt,
  contentFailureText,
  describeImageError,
  offlineErrorText,
  offlineImagesText,
  offlineStateText,
  type Refused
} from './contentText'
import { ContentRegistryContext } from '../tabs/contentRegistry'
import { createFavoriteWrites, useWrittenFavorite } from './favoriteWrites'
import './content.css'

type FavoriteState = { status: 'loading' } | { status: 'failed'; refused: Refused } | { status: 'ready'; favorite: boolean }

/**
 * 收藏 toggle of the open thread. The stored state is queried first; until it is known the button
 * does nothing. A successful write from any entry point (another tab, the 收藏 list) replaces the
 * queried state. Favoriting records an entry only: nothing is downloaded.
 */
export function FavoriteButton({ threadId }: { threadId: ThreadId }) {
  const registry = useContext(ContentRegistryContext)
  // Outside the shell (no registry) this button is the only entry point.
  const [ownWrites] = useState(createFavoriteWrites)
  const writes = registry?.favorites ?? ownWrites
  const written = useWrittenFavorite(writes, threadId)
  const [queried, setQueried] = useState<FavoriteState>({ status: 'loading' })
  const state: FavoriteState = written === undefined ? queried : { status: 'ready', favorite: written }
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const alive = useRef(true)

  const query = useCallback(async () => {
    setQueried({ status: 'loading' })
    const result = await attempt(() => window.xidao.content.isFavorite({ threadId }))
    if (!alive.current) return
    setQueried(result?.ok === true ? { status: 'ready', favorite: result.value } : { status: 'failed', refused: result?.ok === false ? result : null })
  }, [threadId])

  useEffect(() => {
    alive.current = true
    void query()
    return () => {
      alive.current = false
    }
  }, [query])

  const toggle = async () => {
    if (state.status !== 'ready' || busy) return
    const next = !state.favorite
    setBusy(true)
    setFailure(null)
    const result = await attempt(() => window.xidao.content.favorite({ threadId, favorite: next }))
    // Shared even when this button is gone: other entry points show the stored state.
    if (result?.ok === true) writes.written(threadId, result.value)
    if (!alive.current) return
    setBusy(false)
    if (result?.ok !== true) setFailure(`${next ? '收藏' : '取消收藏'}未完成：${contentFailureText(result?.ok === false ? result : null)}`)
  }

  if (state.status === 'failed') {
    return (
      <span className="retention-inline">
        <button type="button" className="btn" onClick={() => void query()} title="重新读取这个串的收藏状态">
          <Icon name="alert" />
          收藏状态未知 · 重试
        </button>
        <span className="visually-hidden" role="status">
          收藏状态读取失败：{contentFailureText(state.refused)}
        </span>
      </span>
    )
  }

  const favorite = state.status === 'ready' && state.favorite
  return (
    <span className="retention-inline">
      <button
        type="button"
        className={favorite ? 'btn favorite-btn is-on' : 'btn favorite-btn'}
        aria-pressed={state.status === 'ready' ? favorite : undefined}
        aria-busy={state.status === 'loading' || busy || undefined}
        disabled={state.status === 'loading'}
        onClick={() => void toggle()}
        title={favorite ? '取消收藏；不影响离线副本和阅读记录' : '收藏只保存入口，不下载整串'}
      >
        <Icon name="star" />
        {state.status === 'loading' ? '收藏…' : favorite ? '已收藏' : '收藏'}
      </button>
      {failure !== null && (
        <span className="toolbar-warning" role="alert">
          <Icon name="alert" size={14} />
          {failure}
        </span>
      )}
    </span>
  )
}

const POLL_MS = 1000

type CopyState = { status: 'loading' } | { status: 'failed'; refused: Refused } | { status: 'ready'; copy: OfflineCopy | null }

export interface OfflineCopyHandle {
  state: CopyState
  setState: (state: CopyState) => void
  /** Progress refresh failed while saving; the last known copy stays shown. */
  pollFailure: string | null
  reload: () => Promise<void>
}

/**
 * Offline copy of a thread as storage records it. Progress is persisted by the main process; it is
 * polled only while the copy is `saving`. A copy found `interrupted` stays so until updated.
 */
function useOfflineCopy(threadId: ThreadId): OfflineCopyHandle {
  const [state, setState] = useState<CopyState>({ status: 'loading' })
  const [pollFailure, setPollFailure] = useState<string | null>(null)
  /** Completed status reads; every one schedules the next poll while saving. */
  const [reads, setReads] = useState(0)
  const alive = useRef(true)
  const known = useRef(false)

  const load = useCallback(async () => {
    const result = await attempt(() => window.xidao.content.offlineStatus({ threadId }))
    if (!alive.current) return
    setReads((count) => count + 1)
    if (result?.ok === true) {
      known.current = true
      setPollFailure(null)
      setState({ status: 'ready', copy: result.value })
      return
    }
    const refused = result?.ok === false ? result : null
    if (known.current) setPollFailure(`进度读取失败：${contentFailureText(refused)}，稍后自动再试`)
    else setState({ status: 'failed', refused })
  }, [threadId])

  useEffect(() => {
    alive.current = true
    void load()
    return () => {
      alive.current = false
    }
  }, [load])

  const saving = state.status === 'ready' && state.copy?.state === 'saving'
  useEffect(() => {
    if (!saving) return
    const timer = window.setTimeout(() => void load(), POLL_MS)
    return () => window.clearTimeout(timer)
  }, [saving, reads, load])

  const update = useCallback((next: CopyState) => {
    if (next.status === 'ready') known.current = true
    setState(next)
  }, [])

  return { state, setState: update, pollFailure, reload: load }
}

/** What the thread's offline entry says about its copy: its label, and whether it needs attention. */
export function useOfflineEntry(threadId: ThreadId) {
  const offline = useOfflineCopy(threadId)
  const copy = offline.state.status === 'ready' ? offline.state.copy : null
  const label =
    offline.state.status === 'loading'
      ? '离线…'
      : offline.state.status === 'failed'
        ? '离线状态未知'
        : copy === null
          ? '离线保存'
          : copy.state === 'saving'
            ? `离线保存中 · ${copy.pages.length} 页`
            : copy.state === 'stopped' && copy.error === null && copy.imageFailures.length === 0
              ? '已离线'
              : '离线未完整'
  const warn = offline.state.status === 'failed' || (copy !== null && copy.state !== 'saving' && label === '离线未完整')
  return { offline, label, warn, saving: copy?.state === 'saving' }
}

/** Toolbar entry for the thread's offline copy; opens its dialog. */
export function OfflineButton({ threadId, title }: { threadId: ThreadId; title: string }) {
  const { offline, label, warn, saving } = useOfflineEntry(threadId)
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        className={warn ? 'btn offline-btn is-warning' : 'btn offline-btn'}
        aria-haspopup="dialog"
        aria-busy={saving || undefined}
        onClick={() => setOpen(true)}
        title="保存或更新这个串的离线副本"
      >
        <Icon name={warn ? 'alert' : 'download'} />
        {label}
      </button>
      {open && <OfflineDialog threadId={threadId} title={title} offline={offline} onClose={() => setOpen(false)} />}
    </>
  )
}

export function OfflineDialog({
  threadId,
  title,
  offline,
  onClose,
  fallbackFocus
}: {
  threadId: ThreadId
  title: string
  offline: OfflineCopyHandle
  onClose: () => void
  /** Where focus goes on close when the control that had it at opening is gone. */
  fallbackFocus?: () => HTMLElement | null
}) {
  const titleId = useId()
  const choiceName = useId()
  const { state, setState, pollFailure, reload } = offline
  const copy = state.status === 'ready' ? state.copy : null
  // Originals by default for a first save and for every update; 仅文字 is an explicit choice.
  const [includeImages, setIncludeImages] = useState(true)
  const [busy, setBusy] = useState<'save' | 'cancel' | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const saving = copy?.state === 'saving'

  const save = async () => {
    if (busy !== null) return
    setBusy('save')
    setFailure(null)
    const result = await attempt(() => window.xidao.content.saveOffline({ threadId, includeImages }))
    setBusy(null)
    if (result?.ok === true) setState({ status: 'ready', copy: result.value })
    else setFailure(`${copy === null ? '保存' : '更新'}没有开始：${contentFailureText(result?.ok === false ? result : null)}`)
  }

  const cancel = async () => {
    if (busy !== null) return
    setBusy('cancel')
    setFailure(null)
    const result = await attempt(() => window.xidao.content.cancelOffline({ threadId }))
    setBusy(null)
    if (result?.ok === true) setState({ status: 'ready', copy: result.value })
    else setFailure(`取消未完成：${contentFailureText(result?.ok === false ? result : null)}，保存可能仍在进行`)
  }

  return (
    <Modal className="offline-dialog" labelledBy={titleId} onClose={onClose} fallbackFocus={fallbackFocus}>
      <ModalHeader title="离线副本" titleId={titleId} closeLabel="关闭离线副本" onClose={onClose} />
      <div className="modal-body offline-body">
        <p className="offline-thread">
          {title}
          <span className="offline-thread-id">No.{threadId}</span>
        </p>
        <p className="offline-intro">离线副本保存在本机，不随普通缓存清理。</p>

        {state.status === 'loading' && <Loading>正在读取离线副本状态…</Loading>}
        {state.status === 'failed' && (
          <div className="notice notice-error" role="alert">
            <Icon name="alert" className="notice-icon" />
            <div className="notice-text">
              <p className="notice-title">离线副本状态读取失败：{contentFailureText(state.refused)}</p>
            </div>
            <button type="button" className="btn btn-small" onClick={() => void reload()}>
              重试
            </button>
          </div>
        )}

        {copy !== null && <OfflineSummary copy={copy} />}
        {pollFailure !== null && (
          <p className="notice-inline is-warning" role="status">
            <Icon name="alert" size={14} />
            {pollFailure}
          </p>
        )}

        {state.status === 'ready' && !saving && (
          <fieldset className="offline-choice">
            <legend className="field-label">{copy === null ? '保存内容' : '这次更新保存'}</legend>
            <label className="choice-row">
              <input type="radio" name={choiceName} checked={includeImages} onChange={() => setIncludeImages(true)} />
              <span>
                <span className="choice-title">文字和原图</span>
                <span className="choice-help">正文、回复，以及能取得的原图。缩略图不算原图。</span>
              </span>
            </label>
            <label className="choice-row">
              <input type="radio" name={choiceName} checked={!includeImages} onChange={() => setIncludeImages(false)} />
              <span>
                <span className="choice-title">仅文字</span>
                <span className="choice-help">不下载原图，占用更少。</span>
              </span>
            </label>
            {copy !== null && <p className="field-hint">更新保留已保存的内容，只补充新取得的页面和图片。</p>}
          </fieldset>
        )}

        {failure !== null && (
          <p className="form-message is-error" role="alert">
            <Icon name="alert" size={14} />
            {failure}
          </p>
        )}
      </div>
      {state.status === 'ready' && (
        <div className="modal-actions">
          {saving ? (
            <button type="button" className="btn" aria-busy={busy === 'cancel' || undefined} onClick={() => void cancel()}>
              <Icon name="close" />
              {busy === 'cancel' ? '正在取消…' : '取消保存'}
            </button>
          ) : (
            <button type="button" className="btn btn-primary" aria-busy={busy === 'save' || undefined} onClick={() => void save()}>
              <Icon name="download" />
              {busy === 'save' ? '正在开始…' : copy === null ? '开始保存' : '更新离线副本'}
            </button>
          )}
        </div>
      )}
    </Modal>
  )
}

/** What the copy holds, when, and exactly what failed. Never phrased as a complete snapshot. */
export function OfflineSummary({ copy, compact = false }: { copy: OfflineCopy; compact?: boolean }) {
  const error = offlineErrorText(copy)
  const pages = formatPageList(copy.pages)
  const stateWarning = copy.state === 'cancelled' || copy.state === 'interrupted' || error !== null
  return (
    <div className={compact ? 'offline-summary is-compact' : 'offline-summary'}>
      <p className={stateWarning ? 'offline-state is-warning' : 'offline-state'} role={compact ? undefined : 'status'}>
        {copy.state === 'saving' ? <Loading live={false}>{offlineStateText(copy)}…</Loading> : offlineStateText(copy)}
      </p>
      <dl className="offline-facts">
        <div>
          <dt>首次保存</dt>
          <dd>{formatLocalTime(copy.createdAt)}</dd>
        </div>
        <div>
          <dt>最近更新</dt>
          <dd>{formatLocalTime(copy.updatedAt)}</dd>
        </div>
        <div>
          <dt>已保存页</dt>
          <dd>{pages === '' ? '尚无' : `第 ${pages} 页（共 ${copy.pages.length} 页）`}</dd>
        </div>
        <div>
          <dt>发言</dt>
          <dd>{copy.postCount} 条</dd>
        </div>
        <div>
          <dt>末尾候选</dt>
          <dd>{copy.endCandidatePage === null ? '未读到空页，末尾未确认' : `第 ${copy.endCandidatePage} 页为空（读取当时）`}</dd>
        </div>
        <div>
          <dt>图片</dt>
          <dd>{offlineImagesText(copy)}</dd>
        </div>
      </dl>
      {error !== null && (
        <p className="notice-inline is-warning">
          <Icon name="alert" size={14} />
          {error}
        </p>
      )}
      {!compact && copy.imageFailures.length > 0 && (
        <div className="offline-failures">
          <p className="field-label">未保存的原图</p>
          <ul aria-label={`未保存的原图，共 ${copy.imageFailures.length} 张`}>
            {copy.imageFailures.map((item) => (
              <li key={item.postId}>
                <span className="offline-failure-id">No.{item.postId}</span>
                {describeImageError(item.error)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
