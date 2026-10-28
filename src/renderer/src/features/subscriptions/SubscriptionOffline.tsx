import { useLayoutEffect, useState, type ReactNode } from 'react'
import type { ThreadId } from '../../../../shared/forum'
import { Icon } from '../../components/Icon'
import { KaomojiDecor } from '../../components/KaomojiDecor'
import { OfflineDeleteConfirm } from '../content/OfflineDeleteConfirm'
import { isDeletingOffline } from '../content/offlineSync'
import { OfflineDetailsDialog } from '../content/ThreadRetention'
import '../content/content.css'

interface Opened {
  threadId: ThreadId
  /** Thread title or `No.x`, as the thread's own 离线副本 dialog names it. */
  label: string
  /** The row control the menu opened from: focus goes back there. */
  row: HTMLElement
}

/**
 * 离线保存… of a subscription row (App and 网页 alike): the thread's own 离线副本 dialog by its number,
 * whatever the list row holds (no image or reply count needed). Saving, cancelling, updating and the
 * copy's details are the dialog's; 删除离线副本… asks with the same confirmation as elsewhere. Nothing
 * here changes the subscription, its reminders or 历史. `notice` says what a deletion did.
 */
export function useSubscriptionOffline(): { open: (opened: Opened) => void; dialogs: ReactNode; notice: ReactNode } {
  const [details, setDetails] = useState<Opened | null>(null)
  const [deleteAsk, setDeleteAsk] = useState<(Opened & { saving: boolean }) | null>(null)
  const [done, setDone] = useState<{ label: string; cacheCleanup: 'complete' | 'failed' } | null>(null)
  /** After a deletion closes both dialogs: focus its row (each value once). */
  const [focusRow, setFocusRow] = useState<{ row: HTMLElement; seq: number } | null>(null)
  useLayoutEffect(() => {
    if (focusRow !== null && focusRow.row.isConnected) focusRow.row.focus()
  }, [focusRow])

  const open = (opened: Opened) => {
    setDone(null)
    setDetails(opened)
  }

  const dialogs = (
    <>
      {details !== null && (
        <OfflineDetailsDialog
          key={`details:${details.threadId}`}
          threadId={details.threadId}
          title={details.label}
          onClose={() => setDetails(null)}
          onDelete={(saving) => {
            if (!isDeletingOffline(details.threadId)) setDeleteAsk({ ...details, saving })
          }}
          fallbackFocus={() => (details.row.isConnected ? details.row : null)}
        />
      )}
      {deleteAsk !== null && (
        <OfflineDeleteConfirm
          key={`delete:${deleteAsk.threadId}`}
          threadId={deleteAsk.threadId}
          title={deleteAsk.label}
          saving={deleteAsk.saving}
          onCancel={() => setDeleteAsk(null)}
          onDeleted={({ cacheCleanup }) => {
            const ask = deleteAsk
            setDeleteAsk((current) => (current?.threadId === ask.threadId ? null : current))
            setDetails((current) => (current?.threadId === ask.threadId ? null : current))
            setDone({ label: ask.label, cacheCleanup })
            setFocusRow((current) => ({ row: ask.row, seq: (current?.seq ?? 0) + 1 }))
          }}
          fallbackFocus={() => (deleteAsk.row.isConnected ? deleteAsk.row : null)}
        />
      )}
    </>
  )

  const notice = done !== null && (
    <p className={done.cacheCleanup === 'complete' ? 'notice-inline' : 'notice-inline is-warning'} role="status">
      <Icon name={done.cacheCleanup === 'complete' ? 'check' : 'alert'} size={14} />
      已删除「{done.label}」的离线副本{done.cacheCleanup === 'failed' && '；普通缓存额度检查失败'}
      {done.cacheCleanup === 'failed' && <KaomojiDecor state="failure" />}
    </p>
  )

  return { open, dialogs, notice }
}
