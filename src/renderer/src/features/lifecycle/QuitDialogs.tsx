import { useEffect, useId, useRef, useState } from 'react'
import { targetText } from '../../../../shared/drafts'
import type { PublicationAttempt } from '../../../../shared/publication'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { useEditorWorkspace } from '../editor/workspace'
import { ATTEMPT_STATE_LABEL } from '../publication/publicationText'
import './lifecycle.css'

/**
 * For a dialog that must stay open while its action runs: the platform may still close a modal
 * dialog (a repeated Esc closes it regardless of `cancel` handling). `reopenIfClosed` then remounts
 * it through `key`, opened again. `ref` goes on any element inside the dialog.
 */
function useStayOpen() {
  const ref = useRef<HTMLDivElement>(null)
  const [key, setKey] = useState(0)
  const reopenIfClosed = () => {
    if (ref.current?.closest('dialog')?.open === false) setKey((value) => value + 1)
  }
  return { ref, key, reopenIfClosed }
}

/** What a quit does while it asks nothing. */
export type QuitWork = 'preparing' | 'saving'

const QUIT_WORK_TEXT: Record<QuitWork, string> = {
  preparing: '正在确认发送和编辑的状态…',
  saving: '正在保存工作区…'
}

/** Short work stays invisible; only a noticeable wait (e.g. a storage lock) shows the status. */
const QUIT_WORK_SHOW_DELAY_MS = 300

/**
 * Mounted for as long as a quit works without asking: as a modal dialog it keeps the rest of the
 * window inert (the bottom notices included) and takes focus out of any editor, so nothing changes
 * after its unsaved edits were handled. Transparent at first; the status appears after a short
 * delay. Esc does nothing.
 */
export function QuitWorkingDialog({ work }: { work: QuitWork }) {
  const titleId = useId()
  const stay = useStayOpen()
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), QUIT_WORK_SHOW_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [])
  return (
    <Modal
      key={stay.key}
      className={shown ? 'lifecycle-dialog lifecycle-working is-shown' : 'lifecycle-dialog lifecycle-working'}
      labelledBy={titleId}
      onClose={stay.reopenIfClosed}
      noticesBelow
    >
      <header className="modal-header">
        <h2 className="modal-title" id={titleId}>
          正在退出汐岛
        </h2>
      </header>
      <div className="modal-body" ref={stay.ref}>
        <p className="notice-inline" role="status">
          <Icon name="info" size={14} />
          {QUIT_WORK_TEXT[work]}
        </p>
      </div>
    </Modal>
  )
}

/** The quit stopped: a send's state could not be checked, so its editor stays as it is. */
export function QuitUncheckedDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId()
  return (
    <Modal className="lifecycle-dialog" labelledBy={titleId} onClose={onClose}>
      <header className="modal-header">
        <h2 className="modal-title" id={titleId}>
          未退出：有发送的状态无法确认
        </h2>
      </header>
      <div className="modal-body">
        <p className="lifecycle-intro">有一次发送没能确认是否已经记录，请在它的编辑中再次检查后再退出。</p>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          知道了
        </button>
      </div>
    </Modal>
  )
}

/** Saving the workspace failed: the quit waits here and never continues without it. */
export function WorkspaceSaveFailedDialog({
  saving,
  onRetry,
  onCancel
}: {
  /** A retry is running. */
  saving: boolean
  onRetry: () => void
  onCancel: () => void
}) {
  const titleId = useId()
  const stay = useStayOpen()
  const cancel = () => {
    if (saving) stay.reopenIfClosed()
    else onCancel()
  }
  return (
    <Modal key={stay.key} className="lifecycle-dialog" labelledBy={titleId} onClose={cancel}>
      <header className="modal-header">
        <h2 className="modal-title" id={titleId}>
          工作区未能保存，未退出
        </h2>
      </header>
      <div className="modal-body" ref={stay.ref}>
        <p className="lifecycle-intro">标签、导航历史和阅读位置没能写入本地存储。</p>
        {saving && (
          <p className="notice-inline" role="status">
            <Icon name="info" size={14} />
            正在保存工作区…
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" aria-disabled={saving || undefined} onClick={cancel}>
          取消退出
        </button>
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={saving || undefined}
          aria-busy={saving || undefined}
          onClick={() => {
            if (!saving) onRetry()
          }}
        >
          重试
        </button>
      </div>
    </Modal>
  )
}

/** The result each listed send should have recorded. */
function resultText(attempt: PublicationAttempt): string {
  if (attempt.state === 'unknown') return '结果不明，下次启动时确认'
  return ATTEMPT_STATE_LABEL[attempt.state]
}

/**
 * The last quit stopped because results of sends could not be stored while finishing. 重试 stores
 * them again (never sends) and, once all are stored, `onStored` continues the quit; 取消退出 and Esc
 * keep the app running with the results still listed for the next quit.
 */
export function UnstoredResultsDialog({
  attempts,
  onCancel,
  onStored
}: {
  attempts: readonly PublicationAttempt[]
  onCancel: () => void
  onStored: () => void
}) {
  const { forumName } = useEditorWorkspace()
  const titleId = useId()
  const stay = useStayOpen()
  const [retrying, setRetrying] = useState(false)
  const [failed, setFailed] = useState(false)
  /** Unmounted (cancelled, or a quit took over): a late retry result changes nothing here. */
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const cancel = () => {
    if (retrying) stay.reopenIfClosed()
    else onCancel()
  }

  const retry = async () => {
    if (retrying) return
    setRetrying(true)
    setFailed(false)
    let stored = false
    try {
      stored = (await window.xidao.lifecycle.retryUnstoredResults()).ok
    } catch {
      stored = false
    }
    if (!mounted.current) return
    setRetrying(false)
    if (stored) onStored()
    else setFailed(true)
  }

  return (
    <Modal key={stay.key} className="lifecycle-dialog" labelledBy={titleId} onClose={cancel}>
      <header className="modal-header">
        <h2 className="modal-title" id={titleId}>
          发送结果未能保存，未退出
        </h2>
      </header>
      <div className="modal-body" ref={stay.ref}>
        <p className="lifecycle-intro">下面 {attempts.length} 个发送的结果没能写入本地存储。</p>
        {failed && (
          <p className="notice-inline is-warning" role="alert">
            <Icon name="alert" size={14} />
            仍未能保存
          </p>
        )}
        <ul className="lifecycle-list" aria-labelledby={titleId}>
          {attempts.map((attempt) => (
            <li key={attempt.id} className="lifecycle-list-item">
              <span className="lifecycle-list-target">{targetText(attempt.payload.target, forumName)}</span>
              <span className="lifecycle-list-detail">应记录为：{resultText(attempt)}</span>
            </li>
          ))}
        </ul>
        {retrying && (
          <p className="notice-inline" role="status">
            <Icon name="info" size={14} />
            正在保存发送结果…
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" aria-disabled={retrying || undefined} onClick={cancel}>
          取消退出
        </button>
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={retrying || undefined}
          aria-busy={retrying || undefined}
          onClick={() => void retry()}
        >
          重试
        </button>
      </div>
    </Modal>
  )
}
