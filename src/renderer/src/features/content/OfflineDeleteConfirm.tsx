import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ThreadId } from '../../../../shared/forum'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { useClearOnLeave } from '../../lib/useClearOnLeave'
import { deleteOfflineCopy, deletionNote, showDeletionNote, useOfflineDeletions, type DeletionOutcome } from './offlineSync'
import './content.css'

/**
 * 删除离线副本？ for both entrances (a 离线 row's menu, the 离线副本 dialog). Focus starts on 取消;
 * 取消, Esc or a press on the backdrop changes nothing, a save in progress included. While the deletion runs (here or from
 * another view) nothing can be asked again; a refusal stays here with the copy untouched, and a
 * deletion goes to `onDeleted`, whose owner closes this and says what happened. The owner keeps
 * this mounted whatever its lists do meanwhile: storage's change notice usually arrives first.
 */
export function OfflineDeleteConfirm({
  threadId,
  title,
  saving,
  onCancel,
  onDeleted,
  fallbackFocus
}: {
  threadId: ThreadId
  /** Thread title or `No.x`. */
  title: string
  /** The copy is being saved: it is stopped first. */
  saving: boolean
  onCancel: () => void
  onDeleted: (outcome: Extract<DeletionOutcome, { kind: 'deleted' }>) => void
  fallbackFocus?: () => HTMLElement | null
}) {
  const titleId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  const { isDeleting } = useOfflineDeletions()
  const busy = isDeleting(threadId)
  const [failure, setFailure] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // Start on 取消, the choice that changes nothing (Modal focused its first control).
  useLayoutEffect(() => {
    cancelRef.current?.focus()
  }, [])

  const cancel = () => {
    if (!busy) onCancel()
  }

  const confirm = async () => {
    if (busy) return
    setFailure(null)
    const outcome = await deleteOfflineCopy(threadId)
    if (outcome.kind === 'deleted') onDeleted(outcome)
    else if (alive.current) setFailure(outcome.text)
  }

  return (
    <Modal className="offline-delete-dialog" labelledBy={titleId} onClose={cancel} closeOnBackdrop fallbackFocus={fallbackFocus}>
      <header className="modal-header">
        <h2 className="modal-title" id={titleId}>
          删除离线副本？
        </h2>
      </header>
      <div className="modal-body offline-delete-body">
        <p className="offline-thread">
          {title}
          <span className="offline-thread-id">No.{threadId}</span>
        </p>
        <p>已保存内容将转为普通缓存，历史和阅读位置保留。</p>
        {saving && <p>将先停止当前保存，再删除副本。</p>}
        {failure !== null && (
          <p className="form-message is-error" role="alert">
            <Icon name="alert" size={14} />
            {failure}
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button ref={cancelRef} type="button" className="btn" aria-disabled={busy || undefined} onClick={cancel}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-danger"
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          onClick={() => void confirm()}
        >
          {busy ? (saving ? '正在停止保存并删除…' : '正在删除…') : '删除离线副本'}
        </button>
      </div>
    </Modal>
  )
}

/**
 * Under a thread's toolbar: what the deletion asked for in its 更多 menu did, until dismissed or a
 * new save starts; a successful note also ends when the reader is left. A failed cache check stays.
 */
export function OfflineDeleteNote({ threadId, displayed }: { threadId: ThreadId; displayed: boolean }) {
  const { note } = useOfflineDeletions()
  useClearOnLeave(displayed, () => {
    if (note?.threadId === threadId && note.cacheCleanup === 'complete' && deletionNote() === note) showDeletionNote(null)
  })
  if (note === null || note.threadId !== threadId) return null
  const failed = note.cacheCleanup === 'failed'
  return (
    <span className={failed ? 'offline-delete-note toolbar-warning' : 'offline-delete-note'}>
      <Icon name={failed ? 'alert' : 'check'} size={14} />
      {failed ? '已删除离线副本；普通缓存额度检查失败' : '已删除离线副本'}
      <button type="button" className="icon-btn offline-delete-note-close" onClick={() => showDeletionNote(null)} aria-label="关闭这条结果">
        <Icon name="close" size={12} />
      </button>
    </span>
  )
}
