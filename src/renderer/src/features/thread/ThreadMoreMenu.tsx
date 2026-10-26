// 更多 of the one-row thread toolbar: 刷新 (also Ctrl/⌘+R and the end of the thread), 在新标签页打开,
// 开头 / 末尾 (also Ctrl/⌘+Home / End and the corner buttons), 举报 (the head post), 提醒 and
// 离线保存; choosing 提醒 opens its check menu under
// 更多 (as the 提醒 and 订阅 row menus), 离线保存 the 离线副本 dialog. Deleting the copy from that
// dialog closes it, puts focus back on 更多 and leaves the result under the toolbar (OfflineDeleteNote).

import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ReadingMode, ThreadId } from '../../../../shared/forum'
import type { ReminderKind, ReminderRule, ThreadReminders } from '../../../../shared/reminders'
import type { ContextMenuPoint } from '../../components/ContextMenu'
import { Icon } from '../../components/Icon'
import { usePopover } from '../../lib/usePopover'
import { OfflineDeleteConfirm } from '../content/OfflineDeleteConfirm'
import { showDeletionNote } from '../content/offlineSync'
import { OfflineDialog, useOfflineEntry } from '../content/ThreadRetention'
import { reminderSummary, ThreadReminderMenu, useReminderToggle } from '../reminders/ReminderMenu'
import type { LoadFailure } from '../reminders/useReminders'
import { useOpenThreadInTab } from '../tabs/openThreadInTab'

export function ThreadMoreMenu({
  onRefresh,
  threadId,
  mode,
  label,
  rules,
  failure,
  onRetry,
  onUpdated,
  onReport,
  onToStart,
  onToEnd
}: {
  /** The reader's 刷新; the same path as the end of the thread and Ctrl/Cmd+R. */
  onRefresh: () => void
  threadId: ThreadId
  mode: ReadingMode
  /** Thread title or `No.x`. */
  label: string
  rules: Record<ReminderKind, ReminderRule> | undefined
  failure: LoadFailure | null
  onRetry: () => void
  onUpdated: (thread: ThreadReminders) => void
  onReport?: (opener: HTMLElement | null) => void
  /** The reader's 开头 and 末尾. */
  onToStart: () => void
  onToEnd: () => void
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const openInTab = useOpenThreadInTab()
  const menuRef = useRef<HTMLDivElement>(null)
  const menu = usePopover(triggerRef, menuRef)
  /** Where the 提醒 menu opens under 更多; null: closed. */
  const [reminderAt, setReminderAt] = useState<ContextMenuPoint | null>(null)
  const [offlineOpen, setOfflineOpen] = useState(false)
  /** 删除离线副本？ is open. */
  const [deleteAsk, setDeleteAsk] = useState(false)
  /** After a deletion both dialogs are gone: focus goes back to 更多 once they have closed. */
  const [focusTrigger, setFocusTrigger] = useState(0)
  useLayoutEffect(() => {
    if (focusTrigger > 0) triggerRef.current?.focus()
  }, [focusTrigger])
  const menuId = useId()
  const reminders = reminderSummary(rules, failure)
  const offline = useOfflineEntry(threadId)
  const reminderWarn = !reminders.known && failure !== null
  const saving = useReminderToggle(threadId, onUpdated, reminderAt !== null)
  const warn = reminderWarn || offline.warn

  const chooseReminder = () => {
    menu.close(false)
    const box = triggerRef.current?.getBoundingClientRect()
    if (box !== undefined) setReminderAt({ x: box.right, y: box.bottom + 4, end: true })
  }

  const closeReminder = (returnFocus: boolean) => {
    setReminderAt(null)
    if (returnFocus) triggerRef.current?.focus()
  }

  const chooseOffline = () => {
    // Focus is on 更多 when the dialog opens, so it comes back there.
    menu.close()
    setOfflineOpen(true)
  }

  // A menu: arrow keys, Home and End move between its items.
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    let next: HTMLElement | undefined
    if (event.key === 'ArrowDown') next = items[(at + 1) % items.length]
    else if (event.key === 'ArrowUp') next = items[(at - 1 + items.length) % items.length]
    else if (event.key === 'Home') next = items[0]
    else if (event.key === 'End') next = items.at(-1)
    else return
    event.preventDefault()
    event.stopPropagation()
    next?.focus()
  }

  const expanded = menu.open || reminderAt !== null
  return (
    <span
      className="thread-more"
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (next === null || event.currentTarget.contains(next)) return
        menu.close(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={warn ? 'btn tb-btn thread-more-trigger is-warning' : 'btn tb-btn thread-more-trigger'}
        aria-haspopup="menu"
        aria-expanded={expanded}
        aria-controls={menu.open ? menuId : undefined}
        aria-label={warn ? '更多（有需要注意的状态）' : '更多'}
        title={warn ? '更多（有需要注意的状态）' : '更多'}
        onClick={menu.toggle}
      >
        <Icon name={warn ? 'alert' : 'more'} />
        <span className="btn-label">更多</span>
      </button>
      {menu.open && (
        <div ref={menuRef} id={menuId} className="thread-more-menu" role="menu" aria-label="更多操作" onKeyDown={onMenuKeyDown}>
          <button type="button" role="menuitem" className="thread-more-item" aria-keyshortcuts="Control+R Meta+R" onClick={() => { menu.close(); onRefresh() }}>
            <Icon name="refresh" />
            刷新
          </button>
          {openInTab !== null && (
            <button type="button" role="menuitem" className="thread-more-item" onClick={() => { menu.close(); openInTab(threadId, null, mode) }}>
              <Icon name="newTab" />
              在新标签页打开
            </button>
          )}
          <button type="button" role="menuitem" className="thread-more-item" aria-keyshortcuts="Control+Home Meta+Home" onClick={() => { menu.close(); onToStart() }}>
            <Icon name="toTop" />
            开头
          </button>
          <button type="button" role="menuitem" className="thread-more-item" aria-keyshortcuts="Control+End Meta+End" onClick={() => { menu.close(); onToEnd() }}>
            <Icon name="toEnd" />
            末尾
          </button>
          <div role="separator" className="thread-more-separator" />
          {onReport !== undefined && (
            <button type="button" role="menuitem" className="thread-more-item" onClick={() => { menu.close(); onReport(triggerRef.current) }}>
              <Icon name="flag" />
              举报
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className={reminders.on.length > 0 ? 'thread-more-item is-on' : reminderWarn ? 'thread-more-item is-warning' : 'thread-more-item'}
            aria-haspopup="menu"
            aria-label={`提醒设置：${reminders.state}`}
            onClick={chooseReminder}
          >
            <Icon name={reminderWarn ? 'alert' : 'bell'} />
            {reminders.text}
          </button>
          <button
            type="button"
            role="menuitem"
            className={offline.warn ? 'thread-more-item is-warning' : 'thread-more-item'}
            aria-haspopup="dialog"
            aria-busy={offline.saving || undefined}
            onClick={chooseOffline}
          >
            <Icon name={offline.warn ? 'alert' : 'download'} />
            {offline.label}
          </button>
        </div>
      )}
      {reminderAt !== null && (
        <ThreadReminderMenu
          point={reminderAt}
          label={label}
          rules={rules}
          failure={failure}
          onRetry={onRetry}
          saving={saving}
          onClose={closeReminder}
        />
      )}
      {offlineOpen && (
        <OfflineDialog
          threadId={threadId}
          title={label}
          offline={offline.offline}
          onClose={() => setOfflineOpen(false)}
          onDelete={() => setDeleteAsk(true)}
          fallbackFocus={() => triggerRef.current}
        />
      )}
      {deleteAsk && (
        <OfflineDeleteConfirm
          threadId={threadId}
          title={label}
          saving={offline.saving}
          onCancel={() => setDeleteAsk(false)}
          onDeleted={({ cacheCleanup }) => {
            setDeleteAsk(false)
            setOfflineOpen(false)
            showDeletionNote({ threadId, cacheCleanup })
            setFocusTrigger((count) => count + 1)
          }}
          fallbackFocus={() => triggerRef.current}
        />
      )}
    </span>
  )
}
