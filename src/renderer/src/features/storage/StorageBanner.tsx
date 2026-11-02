import { useEffect, useId, useRef, useState } from 'react'
import type { StorageStatus, UpgradeRestartResult } from '../../../../shared/api'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { useStayOpen } from '../lifecycle/QuitDialogs'
import { storageBanner, withoutBackupOutcome, type UpgradeRestart } from './storageBanner'
import './storage.css'

/**
 * Persistent state of storage that takes no writes this run. After a failed pre-upgrade backup it
 * offers 重新启动重试 and 不备份升级… (asked first); both restart through the ordinary quit. A
 * restart in progress ignores further presses.
 */
export function StorageBanner({ storage }: { storage: StorageStatus | null }) {
  const view = storageBanner(storage)
  const [running, setRunning] = useState<UpgradeRestart>(null)
  /** Set at once, so a second press before the next render is ignored too. */
  const pending = useRef(false)
  const [asking, setAsking] = useState(false)
  const withoutBackupRef = useRef<HTMLButtonElement>(null)
  if (view === null) return null

  /** `undefined`: another restart is running, so this press is ignored; `null`: the request failed. */
  const restart = async (kind: Exclude<UpgradeRestart, null>): Promise<UpgradeRestartResult | null | undefined> => {
    if (pending.current) return undefined
    pending.current = true
    setRunning(kind)
    try {
      const call = kind === 'retry' ? window.xidao.app.restartToRetryUpgrade : window.xidao.app.restartToUpgradeWithoutBackup
      return await call().catch(() => null)
    } finally {
      pending.current = false
      setRunning(null)
    }
  }

  // The dialog is not inside the banner, so it takes none of the banner's type.
  return (
    <>
      <div className="storage-banner">
        <Icon name="alert" />
        <span className="storage-banner-text" role="status">
          {view.text}
        </span>
        {view.upgrade && (
          <span className="storage-banner-actions">
            <button
              type="button"
              className="btn btn-small"
              aria-disabled={running !== null || undefined}
              aria-busy={running === 'retry' || undefined}
              onClick={() => void restart('retry')}
            >
              重新启动重试
            </button>
            <button
              ref={withoutBackupRef}
              type="button"
              className="btn btn-small"
              aria-disabled={running !== null || undefined}
              onClick={() => {
                if (!pending.current) setAsking(true)
              }}
            >
              不备份升级…
            </button>
          </span>
        )}
      </div>
      {asking && (
        <WithoutBackupDialog
          busy={running === 'without-backup'}
          onConfirm={() => restart('without-backup')}
          onClose={() => setAsking(false)}
          fallbackFocus={() => withoutBackupRef.current}
        />
      )}
    </>
  )
}

/**
 * 不备份直接升级？ Focus starts on 取消; 取消 and Esc change nothing, but not while the choice is being
 * recorded. Recorded: the app restarts (the quit takes over) and this closes. Not recorded: it stays
 * open saying nothing changed.
 */
function WithoutBackupDialog({
  busy,
  onConfirm,
  onClose,
  fallbackFocus
}: {
  busy: boolean
  /** Records the choice and restarts; `undefined` when a restart is already running. */
  onConfirm: () => Promise<UpgradeRestartResult | null | undefined>
  onClose: () => void
  fallbackFocus: () => HTMLElement | null
}) {
  const titleId = useId()
  const stay = useStayOpen()
  const [failed, setFailed] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const cancel = () => {
    if (busy) stay.reopenIfClosed()
    else onClose()
  }

  const confirm = async () => {
    setFailed(false)
    const result = await onConfirm()
    if (result === undefined || !alive.current) return
    if (withoutBackupOutcome(result) === 'close') onClose()
    else setFailed(true)
  }

  return (
    <Modal key={stay.key} className="storage-upgrade-dialog" labelledBy={titleId} onClose={cancel} fallbackFocus={fallbackFocus}>
      <header className="modal-header">
        <h2 className="modal-title" id={titleId}>
          不备份直接升级？
        </h2>
      </header>
      <div className="modal-body" ref={stay.ref}>
        <p>数据会保留并升级到新版本。之后如果改用旧版本，将无法回到升级前的状态。汐岛将重新启动。</p>
        {failed && (
          <p className="notice-inline is-warning storage-upgrade-failure" role="alert">
            <Icon name="alert" size={14} />
            <span>没能记下这个选择，数据没有改动。</span>
          </p>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" aria-disabled={busy || undefined} onClick={cancel}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          onClick={() => void confirm()}
        >
          不备份升级并重新启动
        </button>
      </div>
    </Modal>
  )
}
