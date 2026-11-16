import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ExportEstimate } from '../../../../shared/api'
import { Icon } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { Modal, ModalHeader } from '../../components/Modal'
import {
  exportFailureText, exportPercent, exportProgressText, isBusy, offlineChoiceText, unavailableText, type ExportTask
} from './exportState'
import { exportTask, useExportTask } from './useExportTask'
import './content.css'

type Running = Extract<ExportTask, { phase: 'running' }>

/** Reads the estimate; null while unknown (the IPC call failed). Also tells the task what runs now. */
async function readEstimate(): Promise<ExportEstimate | null> {
  try {
    const estimate = await window.xidao.personalData.exportEstimate()
    if (estimate.available) exportTask.dispatch({ type: 'sync', running: estimate.running })
    return estimate
  } catch {
    return null
  }
}

async function reveal(setMessage: (text: string | null) => void): Promise<void> {
  const result = await window.xidao.personalData.revealExport().catch(() => ({ shown: false }))
  setMessage(result.shown ? null : '找不到导出的文件，它可能已被移动或删除')
}

function ExportProgressBar({ task }: { task: Running }) {
  const percent = exportPercent(task)
  const text = exportProgressText(task)
  return (
    <div
      className="export-progress"
      role="progressbar"
      aria-label="导出进度"
      aria-valuemin={percent === null ? undefined : 0}
      aria-valuemax={percent === null ? undefined : 100}
      aria-valuenow={percent ?? undefined}
      aria-valuetext={text}
    >
      <span className="usage-bar" aria-hidden="true">
        <span style={{ width: `${percent ?? 0}%` }} />
      </span>
      <span className="export-progress-text" aria-hidden="true">
        {text}
      </span>
    </div>
  )
}

/**
 * The task's state in words. The live region changes only with the phase (not with every progress
 * step), so a screen reader hears the start, the result and failures once.
 */
function ExportOutcome({ task }: { task: ExportTask }) {
  const announcement = task.phase === 'running' ? (task.cancelling ? '正在取消导出' : '正在导出')
    : task.phase === 'done' ? `已导出 ${task.fileName}`
    : task.phase === 'cancelled' ? '已取消导出'
    : ''
  return (
    <>
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
      {task.phase === 'done' && (
        <p className="notice-inline">
          <Icon name="check" size={14} />
          已导出 {task.fileName}
        </p>
      )}
      {task.phase === 'cancelled' && <p className="notice-inline">已取消导出</p>}
      {task.phase === 'running' && <ExportProgressBar task={task} />}
      {task.phase === 'failed' && (
        <p className="form-message is-error" role="alert">
          <Icon name="alert" size={14} />
          {exportFailureText(task.failure)}
          <KaomojiDecor state="failure" />
        </p>
      )}
    </>
  )
}

/**
 * 导出个人数据: what goes into the file, the 离线副本 choice, and the export itself. It may be
 * closed while the export runs; the progress stays in 存储与缓存.
 */
function ExportDialog({ onClose, fallbackFocus }: { onClose: () => void; fallbackFocus: () => HTMLElement | null }) {
  const titleId = useId()
  const descriptionId = useId()
  const task = useExportTask()
  const [estimate, setEstimate] = useState<ExportEstimate | null | 'loading'>('loading')
  const [includeOffline, setIncludeOffline] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const busy = isBusy(task)

  const load = useCallback(async () => {
    setEstimate('loading')
    setEstimate(await readEstimate())
  }, [])

  useEffect(() => {
    // A finished export belongs to the last time; this dialog starts a new one.
    if (!isBusy(task)) exportTask.dispatch({ type: 'dismiss' })
    void load()
    // Only when the dialog opens.
  }, [load])

  const ready = estimate !== 'loading' && estimate !== null && estimate.available ? estimate : null
  const offline = ready?.contents?.offline ?? null
  const canExport = ready !== null && ready.contents !== null

  const primary = () => {
    setMessage(null)
    if (task.phase === 'running') void exportTask.cancel()
    else if (task.phase === 'done') void reveal(setMessage)
    else if (task.phase !== 'starting' && canExport) void exportTask.start(offline !== null && includeOffline)
  }

  const label = task.phase === 'running' ? (task.cancelling ? '正在取消…' : '取消导出')
    : task.phase === 'done' ? '在文件夹中显示'
    : '导出…'
  const unavailable = task.phase === 'starting' || (task.phase === 'running' && task.cancelling) || (!busy && task.phase !== 'done' && !canExport)

  return (
    <Modal className="export-dialog" labelledBy={titleId} onClose={onClose} fallbackFocus={fallbackFocus}>
      <ModalHeader title="导出个人数据" titleId={titleId} closeLabel="关闭导出个人数据" onClose={onClose} />
      <div className="modal-body export-body" aria-busy={estimate === 'loading' || undefined}>
        <p id={descriptionId}>包含浏览历史、阅读位置、草稿、发送记录、屏蔽、饼干颜色、提醒和设置。</p>
        {offline !== null && (
          <label className="choice-row">
            <input type="checkbox" checked={includeOffline} disabled={busy} onChange={(event) => setIncludeOffline(event.target.checked)} />
            <span className="choice-title">{offlineChoiceText(offline)}</span>
          </label>
        )}
        <p className="export-note">文件不加密，含浏览历史、草稿与发送记录。</p>
        {(estimate === null || ready?.contents === null) && (
          <div className="notice notice-error" role="alert">
            <Icon name="alert" className="notice-icon" />
            <div className="notice-text">
              <p className="notice-title">读取本机数据失败</p>
            </div>
            <button type="button" className="btn btn-small" onClick={() => void load()}>
              重试
            </button>
          </div>
        )}
        {estimate !== 'loading' && estimate !== null && !estimate.available && (
          <p className="form-message is-error" role="alert">
            <Icon name="alert" size={14} />
            {unavailableText(estimate)}
          </p>
        )}
        <ExportOutcome task={task} />
        {message !== null && (
          <p className="form-message is-error" role="alert">
            <Icon name="alert" size={14} />
            {message}
          </p>
        )}
      </div>
      <div className="modal-actions">
        {!busy && task.phase !== 'done' && (
          <button key="close" type="button" className="btn" onClick={onClose}>
            取消
          </button>
        )}
        <button
          key="primary"
          type="button"
          className={busy || task.phase === 'done' ? 'btn' : 'btn btn-primary'}
          aria-disabled={unavailable || undefined}
          aria-busy={task.phase === 'starting' || (task.phase === 'running' && task.cancelling) || undefined}
          aria-describedby={descriptionId}
          onClick={() => {
            if (!unavailable) primary()
          }}
        >
          {label}
        </button>
      </div>
    </Modal>
  )
}

/**
 * The 个人数据 part of 存储与缓存: 导出个人数据… (import joins this row), the reason it is
 * unavailable, and a running or finished export once its dialog is closed. A finished result
 * clears when 设置 is left; a failure stays until replaced.
 */
export function PersonalDataBlock({ active }: { active: boolean }) {
  const task = useExportTask()
  const [estimate, setEstimate] = useState<ExportEstimate | null>(null)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const exportRef = useRef<HTMLButtonElement>(null)
  const actionFocused = useRef(false)
  const reasonId = useId()

  useEffect(() => {
    if (!active) {
      if (task.phase === 'done' || task.phase === 'cancelled') exportTask.dispatch({ type: 'dismiss' })
      setMessage(null)
      return
    }
    let alive = true
    void readEstimate().then((value) => {
      if (alive) setEstimate(value)
    })
    return () => {
      alive = false
    }
    // Read again whenever 设置 is shown; leaving only puts a finished result away.
  }, [active])

  // The result line's own button goes away with the result: focus goes back to 导出个人数据….
  const hasAction = !open && (task.phase === 'running' || task.phase === 'done')
  useLayoutEffect(() => {
    if (!hasAction && actionFocused.current) {
      actionFocused.current = false
      exportRef.current?.focus()
    }
  }, [hasAction])

  const reason = unavailableText(estimate)
  const closeDialog = useCallback(() => setOpen(false), [])

  return (
    <div className="usage-block personal-data">
      <span className="setting-label">个人数据</span>
      <div className="personal-data-actions">
        <button
          ref={exportRef}
          type="button"
          className="btn btn-page"
          aria-haspopup="dialog"
          aria-disabled={reason !== null || undefined}
          aria-describedby={reason !== null ? reasonId : undefined}
          onClick={() => {
            if (reason !== null) return
            setMessage(null)
            setOpen(true)
          }}
        >
          <Icon name="download" />
          导出个人数据…
        </button>
      </div>
      {reason !== null && (
        <p className="field-hint" id={reasonId}>
          {reason}
        </p>
      )}
      {!open && task.phase !== 'idle' && task.phase !== 'starting' && (
        <div className="personal-data-status">
          <ExportOutcome task={task} />
          {hasAction && (
            <div>
              <button
                type="button"
                className="btn btn-small btn-page"
                aria-disabled={(task.phase === 'running' && task.cancelling) || undefined}
                aria-busy={(task.phase === 'running' && task.cancelling) || undefined}
                onFocus={() => { actionFocused.current = true }}
                onBlur={(event) => {
                  // A button removed while focused has nowhere to send focus: it stays marked.
                  if (event.relatedTarget !== null) actionFocused.current = false
                }}
                onClick={() => {
                  if (task.phase === 'running') void exportTask.cancel()
                  else if (task.phase === 'done') void reveal(setMessage)
                }}
              >
                {task.phase === 'running' ? (task.cancelling ? '正在取消…' : '取消导出') : '在文件夹中显示'}
              </button>
            </div>
          )}
          {message !== null && (
            <p className="form-message is-error" role="alert">
              <Icon name="alert" size={14} />
              {message}
            </p>
          )}
        </div>
      )}
      {open && <ExportDialog onClose={closeDialog} fallbackFocus={() => exportRef.current} />}
    </div>
  )
}
