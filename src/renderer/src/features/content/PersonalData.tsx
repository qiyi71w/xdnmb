import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ExportEstimate } from '../../../../shared/api'
import { Icon } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { Modal, ModalHeader } from '../../components/Modal'
import {
  exportFailureText, exportPassphrase, exportPercent, exportProgressText, isBusy, NO_SECRETS, offlineChoiceText, secretsState, unavailableText,
  type ExportTask, type SecretsChoice
} from './exportState'
import { exportTask, useExportTask } from './useExportTask'
import { formatRecordTime } from '../../lib/time'
import { useStayOpen } from '../lifecycle/QuitDialogs'
import { canConfirm, canSubmit, importBusy, importConfirmText, importOutcomeText, importProblemText, type ImportFlow } from './importState'
import { importFlow, useImportFlow } from './useImportFlow'
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
 * 导出个人数据: what goes into the file, the 离线副本 and 饼干与 App UUID choices (the latter with
 * its 导出口令, typed twice), and the export itself. It may be closed while the export runs; the
 * progress stays in 存储与缓存. The passphrase is cleared here once the export has it.
 */
function ExportDialog({ onClose, fallbackFocus }: { onClose: () => void; fallbackFocus: () => HTMLElement | null }) {
  const titleId = useId()
  const descriptionId = useId()
  const task = useExportTask()
  const [estimate, setEstimate] = useState<ExportEstimate | null | 'loading'>('loading')
  const [includeOffline, setIncludeOffline] = useState(true)
  const [secrets, setSecrets] = useState<SecretsChoice>(NO_SECRETS)
  const [message, setMessage] = useState<string | null>(null)
  const passphraseId = useId()
  const confirmationId = useId()
  const mismatchId = useId()
  const busy = isBusy(task)
  const passphrase = secretsState(secrets)

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
  const canExport = ready !== null && ready.contents !== null && passphrase.ready

  const primary = () => {
    setMessage(null)
    if (task.phase === 'running') void exportTask.cancel()
    else if (task.phase === 'done') void reveal(setMessage)
    else if (task.phase !== 'starting' && canExport) {
      void exportTask.start({ includeOffline: offline !== null && includeOffline, passphrase: exportPassphrase(secrets) }).then((started) => {
        if (started) setSecrets((choice) => ({ ...choice, passphrase: '', confirmation: '' }))
      })
    }
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
        <label className="choice-row">
          <input
            type="checkbox"
            checked={secrets.include}
            disabled={busy}
            onChange={(event) => setSecrets({ ...secrets, include: event.target.checked })}
          />
          <span className="choice-title">饼干与 App UUID</span>
        </label>
        {secrets.include ? (
          <div className="export-passphrase">
            <label className="field-label" htmlFor={passphraseId}>
              导出口令
            </label>
            <input
              id={passphraseId}
              className="text-input"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={secrets.passphrase}
              disabled={busy}
              onChange={(event) => setSecrets({ ...secrets, passphrase: event.target.value })}
            />
            <label className="field-label" htmlFor={confirmationId}>
              再次输入口令
            </label>
            <input
              id={confirmationId}
              className="text-input"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={secrets.confirmation}
              disabled={busy}
              aria-invalid={passphrase.mismatch || undefined}
              aria-describedby={passphrase.mismatch ? mismatchId : undefined}
              onChange={(event) => setSecrets({ ...secrets, confirmation: event.target.value })}
            />
            {passphrase.mismatch && (
              <p className="form-message is-error" id={mismatchId}>
                <Icon name="alert" size={14} />
                两次输入的口令不一致
              </p>
            )}
            <p className="export-note">忘记口令将无法导入此文件。</p>
          </div>
        ) : (
          <p className="export-note">文件不加密，含浏览历史、草稿与发送记录。</p>
        )}
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
 * 导入个人数据？: what the checked file holds and what this machine keeps. Focus starts on 取消;
 * 取消 and Esc give the file up, but not while 导入并重新启动 runs. Once prepared, the quit takes
 * over; when it is called off, or preparing fails, this stays open saying nothing changed.
 */
function ImportConfirmDialog({ flow, fallbackFocus }: {
  flow: Extract<ImportFlow, { phase: 'confirming' }>
  fallbackFocus: () => HTMLElement | null
}) {
  const titleId = useId()
  const stay = useStayOpen()
  const close = () => {
    if (flow.busy) stay.reopenIfClosed()
    else void importFlow.cancel()
  }
  const unavailable = !canConfirm(flow)
  return (
    <Modal key={stay.key} className="import-dialog" labelledBy={titleId} onClose={close} fallbackFocus={fallbackFocus}>
      <header className="modal-header">
        <h2 className="modal-title" id={titleId}>
          导入个人数据？
        </h2>
      </header>
      <div className="modal-body import-body" ref={stay.ref}>
        <p>{importConfirmText(flow.summary, formatRecordTime(flow.summary.exportedAt))}</p>
        <p>当前数据会另存为导入前数据。汐岛将重新启动。</p>
        {flow.outcome !== null && (
          <p className="notice-inline is-warning import-outcome" role="alert">
            <Icon name="alert" size={14} />
            <span>{importOutcomeText(flow.outcome)}</span>
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" aria-disabled={flow.busy || undefined} onClick={close}>
          {flow.outcome === null ? '取消' : '关闭'}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={unavailable || undefined}
          aria-busy={flow.busy || undefined}
          onClick={() => void importFlow.confirm()}
        >
          {flow.busy ? '正在准备导入…' : '导入并重新启动'}
        </button>
      </div>
    </Modal>
  )
}

/**
 * 输入导出口令: the chosen file is encrypted. 继续 tries the passphrase (Enter too); a wrong one
 * stays selected under “口令不正确” to be typed over, as many times as needed. 取消 and Esc give
 * the file up, also while a passphrase is tried or the file then checked.
 */
function ImportPassphraseDialog({ flow, fallbackFocus }: {
  flow: Extract<ImportFlow, { phase: 'locked' }>
  fallbackFocus: () => HTMLElement | null
}) {
  const titleId = useId()
  const messageId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const [passphrase, setPassphrase] = useState('')
  const close = () => void importFlow.cancel()
  const wrong = flow.wrong && !flow.busy

  // After the dialog has opened (its own layout effect), and again after each wrong try.
  useEffect(() => {
    if (flow.busy) return
    inputRef.current?.focus()
    if (flow.wrong) inputRef.current?.select()
  }, [flow.busy, flow.wrong])

  return (
    <Modal className="import-dialog" labelledBy={titleId} onClose={close} fallbackFocus={fallbackFocus}>
      <form
        className="modal-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault()
          void importFlow.submitPassphrase(passphrase)
        }}
      >
        <header className="modal-header">
          <h2 className="modal-title" id={titleId}>
            输入导出口令
          </h2>
        </header>
        <div className="modal-body import-body">
          <input
            ref={inputRef}
            className="text-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={passphrase}
            readOnly={flow.busy}
            aria-labelledby={titleId}
            aria-invalid={wrong || undefined}
            aria-describedby={wrong ? messageId : undefined}
            onChange={(event) => setPassphrase(event.target.value)}
          />
          {wrong && (
            <p className="form-message is-error" id={messageId} role="alert">
              <Icon name="alert" size={14} />
              口令不正确
            </p>
          )}
        </div>
        <div className="modal-actions">
          <button type="button" className="btn" aria-disabled={flow.cancelling || undefined} onClick={close}>
            取消
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            aria-disabled={!canSubmit(flow, passphrase) || undefined}
            aria-busy={flow.busy || undefined}
          >
            {flow.busy ? '正在检查…' : '继续'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

/**
 * The 个人数据 part of 存储与缓存: 导出个人数据… and 导入个人数据…, the reason they are unavailable,
 * a running or finished export once its dialog is closed, a file being checked, and why a file was
 * refused. A finished export and a refusal clear when 设置 is left; an export failure stays until
 * replaced.
 */
export function PersonalDataBlock({ active }: { active: boolean }) {
  const task = useExportTask()
  const flow = useImportFlow()
  const [estimate, setEstimate] = useState<ExportEstimate | null>(null)
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const exportRef = useRef<HTMLButtonElement>(null)
  const importRef = useRef<HTMLButtonElement>(null)
  const actionFocused = useRef(false)
  const cancelFocused = useRef(false)
  const reasonId = useId()

  useEffect(() => {
    if (!active) {
      if (task.phase === 'done' || task.phase === 'cancelled') exportTask.dispatch({ type: 'dismiss' })
      importFlow.dispatch({ type: 'dismiss' })
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

  // The check's 取消 goes away with the check: focus goes back to 导入个人数据… unless the
  // confirmation opens and takes it.
  const checking = flow.phase === 'inspecting'
  useLayoutEffect(() => {
    if (!checking && cancelFocused.current) {
      cancelFocused.current = false
      if (flow.phase !== 'confirming') importRef.current?.focus()
    }
  }, [checking, flow.phase])

  const reason = unavailableText(estimate)
  const closeDialog = useCallback(() => setOpen(false), [])
  const importUnavailable = reason !== null || importBusy(flow)

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
        <button
          ref={importRef}
          type="button"
          className="btn btn-page"
          aria-haspopup="dialog"
          aria-disabled={importUnavailable || undefined}
          aria-busy={checking || undefined}
          aria-describedby={reason !== null ? reasonId : undefined}
          onClick={() => {
            if (importUnavailable) return
            importFlow.dispatch({ type: 'dismiss' })
            void importFlow.inspect()
          }}
        >
          <Icon name="upload" />
          导入个人数据…
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
      {flow.phase === 'inspecting' && (
        <div className="personal-data-status">
          <p className="notice-inline" role="status">
            {flow.cancelling ? '正在取消…' : '正在检查文件…'}
          </p>
          <div>
            <button
              type="button"
              className="btn btn-small btn-page"
              aria-disabled={flow.cancelling || undefined}
              onFocus={() => { cancelFocused.current = true }}
              onBlur={(event) => {
                if (event.relatedTarget !== null) cancelFocused.current = false
              }}
              onClick={() => void importFlow.cancel()}
            >
              取消
            </button>
          </div>
        </div>
      )}
      {flow.phase === 'refused' && (
        <p className="form-message is-error personal-data-status" role="alert">
          <Icon name="alert" size={14} />
          {importProblemText(flow.problem)}
          <KaomojiDecor state="failure" />
        </p>
      )}
      {open && <ExportDialog onClose={closeDialog} fallbackFocus={() => exportRef.current} />}
      {flow.phase === 'locked' && <ImportPassphraseDialog flow={flow} fallbackFocus={() => importRef.current} />}
      {flow.phase === 'confirming' && <ImportConfirmDialog flow={flow} fallbackFocus={() => importRef.current} />}
    </div>
  )
}
