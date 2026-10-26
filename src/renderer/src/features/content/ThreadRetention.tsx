import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { OfflineCopy } from '../../../../shared/content'
import type { ThreadId } from '../../../../shared/forum'
import { Icon } from '../../components/Icon'
import { Modal, ModalHeader } from '../../components/Modal'
import { Loading } from '../../components/Notices'
import { formatPageList } from '../../lib/format'
import { formatRecordTime } from '../../lib/time'
import {
  attempt,
  contentFailureText,
  describeImageError,
  offlineAttention,
  offlineErrorText,
  offlineImagesText,
  offlineStateText,
  type Refused
} from './contentText'
import { announceOfflineCopy, isDeletingOffline, offlineGeneration, subscribeOffline, useOfflineDeletions } from './offlineSync'
import './content.css'

export const POLL_MS = 1000

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
 * Copies saved or cancelled elsewhere in this window are shown as announced; after a deletion
 * (here, another view, or the main process's notice) the copy is read again, and any read that
 * started before that is dropped, so a late result never brings back a deleted copy.
 */
function useOfflineCopy(threadId: ThreadId): OfflineCopyHandle {
  const [state, setState] = useState<CopyState>({ status: 'loading' })
  const [pollFailure, setPollFailure] = useState<string | null>(null)
  /** Completed status reads; every one schedules the next poll while saving. */
  const [reads, setReads] = useState(0)
  const alive = useRef(true)
  const known = useRef(false)
  /** Newest read or shown copy; an older read's result is dropped. */
  const seq = useRef(0)

  const load = useCallback(async () => {
    const at = ++seq.current
    const generation = offlineGeneration(threadId)
    const result = await attempt(() => window.xidao.content.offlineStatus({ threadId }))
    // A deletion started or storage changed meanwhile: its own read follows.
    if (!alive.current || at !== seq.current || generation !== offlineGeneration(threadId)) return
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

  const show = useCallback((copy: OfflineCopy | null) => {
    seq.current += 1
    known.current = true
    setPollFailure(null)
    setState({ status: 'ready', copy })
    setReads((count) => count + 1)
  }, [])

  useEffect(
    () =>
      subscribeOffline((change) => {
        if (change.kind === 'stale') {
          if (change.threadId === threadId) void load()
        } else if (change.copy.threadId === threadId) show(change.copy)
      }),
    [threadId, load, show]
  )

  const saving = state.status === 'ready' && state.copy?.state === 'saving'
  useEffect(() => {
    if (!saving) return
    const timer = window.setTimeout(() => void load(), POLL_MS)
    return () => window.clearTimeout(timer)
  }, [saving, reads, load])

  const update = useCallback(
    (next: CopyState) => {
      if (next.status === 'ready') show(next.copy)
      else setState(next)
    },
    [show]
  )

  return { state, setState: update, pollFailure, reload: load }
}

/** What the thread's offline entry (串工具栏 › 更多) says about its copy: its label, and whether it needs attention. */
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
            : offlineAttention(copy) === null
              ? '已离线'
              : '离线未完整'
  const warn = offline.state.status === 'failed' || (copy !== null && copy.state !== 'saving' && label === '离线未完整')
  return { offline, label, warn, saving: copy?.state === 'saving' }
}

/**
 * 离线副本: the copy's facts, save / update / cancel, and 删除离线副本… (`onDelete` asks its owner to
 * confirm). Results of a save or cancel that a deletion overtook are dropped; the copy is read again.
 */
export function OfflineDialog({
  threadId,
  title,
  offline,
  onClose,
  onDelete,
  fallbackFocus
}: {
  threadId: ThreadId
  title: string
  offline: OfflineCopyHandle
  onClose: () => void
  onDelete: () => void
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
  const { isDeleting } = useOfflineDeletions()
  const deleting = isDeleting(threadId)

  const save = async () => {
    if (busy !== null || isDeletingOffline(threadId)) return
    setBusy('save')
    setFailure(null)
    const generation = offlineGeneration(threadId)
    const result = await attempt(() => window.xidao.content.saveOffline({ threadId, includeImages }))
    setBusy(null)
    if (result?.ok !== true) setFailure(`${copy === null ? '保存' : '更新'}没有开始：${contentFailureText(result?.ok === false ? result : null)}`)
    else if (generation === offlineGeneration(threadId)) {
      setState({ status: 'ready', copy: result.value })
      announceOfflineCopy(result.value)
    }
  }

  const cancel = async () => {
    if (busy !== null || isDeletingOffline(threadId)) return
    setBusy('cancel')
    setFailure(null)
    const generation = offlineGeneration(threadId)
    const result = await attempt(() => window.xidao.content.cancelOffline({ threadId }))
    setBusy(null)
    if (result?.ok !== true) setFailure(`取消未完成：${contentFailureText(result?.ok === false ? result : null)}，保存可能仍在进行`)
    else if (generation === offlineGeneration(threadId)) {
      setState({ status: 'ready', copy: result.value })
      if (result.value !== null) announceOfflineCopy(result.value)
    }
  }

  return (
    <Modal className="offline-dialog" labelledBy={titleId} onClose={onClose} fallbackFocus={fallbackFocus}>
      <ModalHeader title="离线副本" titleId={titleId} closeLabel="关闭离线副本" onClose={onClose} />
      <div className="modal-body offline-body" aria-busy={state.status === 'loading' || undefined}>
        <p className="offline-thread">
          {title}
          <span className="offline-thread-id">No.{threadId}</span>
        </p>

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
              <span className="choice-title">文字和原图</span>
            </label>
            <label className="choice-row">
              <input type="radio" name={choiceName} checked={!includeImages} onChange={() => setIncludeImages(false)} />
              <span className="choice-title">仅文字</span>
            </label>
          </fieldset>
        )}

        {failure !== null && (
          <p className="form-message is-error" role="alert">
            <Icon name="alert" size={14} />
            {failure}
          </p>
        )}
        {deleting && <Loading live={false}>正在删除离线副本…</Loading>}
      </div>
      {state.status === 'ready' && (
        <div className="modal-actions">
          {copy !== null && (
            <button
              type="button"
              className="btn btn-danger offline-delete-entry"
              aria-haspopup="dialog"
              aria-disabled={deleting || undefined}
              onClick={() => {
                if (!isDeletingOffline(threadId)) onDelete()
              }}
            >
              <Icon name="trash" />
              删除离线副本…
            </button>
          )}
          {saving ? (
            <button
              type="button"
              className="btn"
              aria-disabled={deleting || undefined}
              aria-busy={busy === 'cancel' || undefined}
              onClick={() => void cancel()}
            >
              <Icon name="close" />
              {busy === 'cancel' ? '正在取消…' : '取消保存'}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              aria-disabled={deleting || undefined}
              aria-busy={busy === 'save' || undefined}
              onClick={() => void save()}
            >
              <Icon name="download" />
              {busy === 'save' ? '正在开始…' : copy === null ? '开始保存' : '更新离线副本'}
            </button>
          )}
        </div>
      )}
    </Modal>
  )
}

/**
 * The same 离线副本 dialog for a thread whose page is not open (离线 page rows), with a copy handle
 * of its own.
 */
export function OfflineDetailsDialog({
  threadId,
  title,
  onClose,
  onDelete,
  fallbackFocus
}: {
  threadId: ThreadId
  title: string
  onClose: () => void
  onDelete: (saving: boolean) => void
  fallbackFocus?: () => HTMLElement | null
}) {
  const offline = useOfflineCopy(threadId)
  const saving = offline.state.status === 'ready' && offline.state.copy?.state === 'saving'
  return (
    <OfflineDialog
      threadId={threadId}
      title={title}
      offline={offline}
      onClose={onClose}
      onDelete={() => onDelete(saving)}
      fallbackFocus={fallbackFocus}
    />
  )
}

/** What the copy holds, when, and exactly what failed. Never phrased as a complete snapshot. */
function OfflineSummary({ copy }: { copy: OfflineCopy }) {
  const error = offlineErrorText(copy)
  const pages = formatPageList(copy.pages)
  const stateWarning = copy.state === 'cancelled' || copy.state === 'interrupted' || error !== null
  return (
    <div className="offline-summary">
      <p className={stateWarning ? 'offline-state is-warning' : 'offline-state'} role="status">
        {copy.state === 'saving' ? <Loading live={false}>{offlineStateText(copy)}…</Loading> : offlineStateText(copy)}
      </p>
      <dl className="offline-facts">
        <div>
          <dt>首次保存</dt>
          <dd>{formatRecordTime(copy.createdAt)}</dd>
        </div>
        <div>
          <dt>最近更新</dt>
          <dd>{formatRecordTime(copy.updatedAt)}</dd>
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
      {copy.imageFailures.length > 0 && (
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
