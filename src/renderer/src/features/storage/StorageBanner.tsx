import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { RestoreInfo, RestoreResult, StorageStatus, UpgradeRestartResult } from '../../../../shared/api'
import { Icon } from '../../components/Icon'
import { Modal } from '../../components/Modal'
import { formatRecordTime } from '../../lib/time'
import { useStayOpen } from '../lifecycle/QuitDialogs'
import {
  DOWNGRADE_DOCS_URL, RESTORE_ABANDONED_TEXT, restartOutcome, restoreSecretsText, storageBanner, type UpgradeRestart
} from './storageBannerModel'
import './storage.css'

type Restorable = Extract<RestoreInfo, { restorable: true }>

/**
 * Persistent state of storage that takes no writes this run, and the notice that a prepared restore
 * was given up. After a failed pre-upgrade backup it offers 重新启动重试 and 不备份升级… (asked
 * first); for a newer version's data, 了解更多 and, when the pre-upgrade backup can be restored,
 * 恢复升级前备份… (asked first). Every restart goes through the ordinary quit; one in progress
 * ignores further presses.
 */
export function StorageBanner({ storage, restoreAbandoned }: { storage: StorageStatus | null; restoreAbandoned: boolean }) {
  const view = storageBanner(storage)
  return (
    <>
      {restoreAbandoned && (
        <div className="storage-banner">
          <Icon name="alert" />
          <span className="storage-banner-text" role="status">
            {RESTORE_ABANDONED_TEXT}
          </span>
        </div>
      )}
      {view?.actions === 'upgrade' && <UpgradeBanner text={view.text} />}
      {view?.actions === 'newer' && <NewerDataBanner text={view.text} />}
      {view?.actions === null && <Banner text={view.text} />}
    </>
  )
}

function Banner({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="storage-banner">
      <Icon name="alert" />
      <span className="storage-banner-text" role="status">
        {text}
      </span>
      {children !== undefined && <span className="storage-banner-actions">{children}</span>}
    </div>
  )
}

function UpgradeBanner({ text }: { text: string }) {
  const [running, setRunning] = useState<UpgradeRestart>(null)
  /** Set at once, so a second press before the next render is ignored too. */
  const pending = useRef(false)
  const [asking, setAsking] = useState(false)
  const withoutBackupRef = useRef<HTMLButtonElement>(null)

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
      <Banner text={text}>
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
      </Banner>
      {asking && (
        <RestartDialog
          title="不备份直接升级？"
          confirmLabel="不备份升级并重新启动"
          failureText="没能记下这个选择，数据没有改动。"
          busy={running === 'without-backup'}
          onConfirm={() => restart('without-backup')}
          onClose={() => setAsking(false)}
          fallbackFocus={() => withoutBackupRef.current}
        >
          <p>数据会保留并升级到新版本。之后如果改用旧版本，将无法回到升级前的状态。汐岛将重新启动。</p>
        </RestartDialog>
      )}
    </>
  )
}

/**
 * A newer version's data. Whether the pre-upgrade backup can be restored is asked once for the
 * banner and again just before the confirmation opens, so the confirmation says what restoring
 * now would do.
 */
function NewerDataBanner({ text }: { text: string }) {
  const [restorable, setRestorable] = useState(false)
  const [checking, setChecking] = useState(false)
  const [asking, setAsking] = useState<Restorable | null>(null)
  const [preparing, setPreparing] = useState(false)
  const [docsFailed, setDocsFailed] = useState(false)
  /** Set at once, so a second press before the next render is ignored too. */
  const pending = useRef(false)
  const restoreRef = useRef<HTMLButtonElement>(null)
  const docsRef = useRef<HTMLButtonElement>(null)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    window.xidao.app.getRestoreInfo().then(
      (info) => {
        if (alive.current) setRestorable(info.restorable)
      },
      () => undefined
    )
    return () => {
      alive.current = false
    }
  }, [])

  const ask = async () => {
    if (pending.current) return
    pending.current = true
    setChecking(true)
    try {
      const info = await window.xidao.app.getRestoreInfo().catch(() => null)
      if (!alive.current) return
      if (info?.restorable === true) setAsking(info)
      else {
        // The backup is gone (or unreadable): the action goes, and focus stays in the banner.
        docsRef.current?.focus()
        setRestorable(false)
      }
    } finally {
      pending.current = false
      if (alive.current) setChecking(false)
    }
  }

  /** `undefined`: a request is already running, so this press is ignored; `null`: the request failed. */
  const restore = async (): Promise<RestoreResult | null | undefined> => {
    if (pending.current) return undefined
    pending.current = true
    setPreparing(true)
    try {
      return await window.xidao.app.restoreBackupAndRestart().catch(() => null)
    } finally {
      pending.current = false
      if (alive.current) setPreparing(false)
    }
  }

  const openDocs = () => {
    setDocsFailed(false)
    window.xidao.links.openExternal({ url: DOWNGRADE_DOCS_URL }).then(
      (result) => {
        if (alive.current) setDocsFailed(!result.opened)
      },
      () => {
        if (alive.current) setDocsFailed(true)
      }
    )
  }

  return (
    <>
      <Banner text={text}>
        {restorable && (
          <button
            ref={restoreRef}
            type="button"
            className="btn btn-small"
            aria-disabled={checking || preparing || undefined}
            aria-busy={checking || undefined}
            onClick={() => void ask()}
          >
            恢复升级前备份…
          </button>
        )}
        <button ref={docsRef} type="button" className="btn btn-small" onClick={openDocs}>
          <Icon name="external" size={14} />
          了解更多
        </button>
        {docsFailed && (
          <span className="storage-banner-note" role="alert">
            无法打开浏览器
          </span>
        )}
      </Banner>
      {asking !== null && (
        <RestartDialog
          title="恢复升级前备份？"
          confirmLabel="恢复并重新启动"
          busyLabel="正在准备恢复…"
          failureText="没能准备恢复，数据没有改动。"
          busy={preparing}
          onConfirm={restore}
          onClose={() => setAsking(null)}
          fallbackFocus={() => restoreRef.current ?? docsRef.current}
        >
          <p>
            备份保存于 {formatRecordTime(asking.backupCompletedAt)}，是升级到汐岛 {asking.sourceVersion} 之前的数据。恢复后，此后的这些改动都会丢失：草稿与发送记录、导入的饼干、阅读位置与访问记录、设置、屏蔽、饼干颜色、离线副本、提醒。
          </p>
          <p>{restoreSecretsText(asking)}</p>
          <p>当前数据会另存为降级前数据，不会删除。汐岛将重新启动。</p>
        </RestartDialog>
      )}
    </>
  )
}

/**
 * A confirmation whose action restarts the app. Focus starts on 取消; 取消 and Esc change nothing,
 * but not while the request runs. Restarting: the quit takes over and this closes. Otherwise it
 * stays open saying nothing changed.
 */
function RestartDialog({
  title,
  confirmLabel,
  busyLabel,
  failureText,
  busy,
  onConfirm,
  onClose,
  fallbackFocus,
  children
}: {
  title: string
  confirmLabel: string
  /** Names the running operation when it takes noticeable time; the action's own name otherwise. */
  busyLabel?: string
  failureText: string
  busy: boolean
  /** Runs the request; `undefined` when one is already running. */
  onConfirm: () => Promise<UpgradeRestartResult | RestoreResult | null | undefined>
  onClose: () => void
  fallbackFocus: () => HTMLElement | null
  children: ReactNode
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
    if (restartOutcome(result) === 'close') onClose()
    else setFailed(true)
  }

  return (
    <Modal key={stay.key} className="storage-upgrade-dialog" labelledBy={titleId} onClose={cancel} fallbackFocus={fallbackFocus}>
      <header className="modal-header">
        <h2 className="modal-title" id={titleId}>
          {title}
        </h2>
      </header>
      <div className="modal-body" ref={stay.ref}>
        {children}
        {failed && (
          <p className="notice-inline is-warning storage-upgrade-failure" role="alert">
            <Icon name="alert" size={14} />
            <span>{failureText}</span>
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
          {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
