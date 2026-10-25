// PROTOTYPE (throwaway): 更多 of the one-row thread toolbar. Holds 提醒 and 离线保存; choosing one
// opens its existing panel (the 提醒 panel anchored to 更多, the 离线副本 dialog) with its usual
// behaviour. Built only with VITE_XIDAO_PROTOTYPE=1.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { ThreadId } from '../../../../shared/forum'
import type { ReminderKind, ReminderRule, ThreadReminders } from '../../../../shared/reminders'
import { Icon } from '../../components/Icon'
import { usePopover } from '../../lib/usePopover'
import { OfflineDialog, useOfflineEntry } from '../content/ThreadRetention'
import { ReminderPanel, reminderSummary, useReminderToggle } from '../reminders/ReminderMenu'
import type { LoadFailure } from '../reminders/useReminders'

export function ThreadMoreMenu({
  threadId,
  label,
  rules,
  failure,
  onRetry,
  onUpdated,
  onReminderOpenChange
}: {
  threadId: ThreadId
  /** Thread title or `No.x`. */
  label: string
  rules: Record<ReminderKind, ReminderRule> | undefined
  failure: LoadFailure | null
  onRetry: () => void
  onUpdated: (thread: ThreadReminders) => void
  /** The 提醒 panel opened or closed (the reader stops judging reading while it covers posts). */
  onReminderOpenChange: (open: boolean) => void
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const reminderRef = useRef<HTMLDivElement>(null)
  const menu = usePopover(triggerRef, menuRef)
  const reminder = usePopover(triggerRef, reminderRef)
  const [offlineOpen, setOfflineOpen] = useState(false)
  const menuId = useId()
  const reminderId = useId()
  const reminders = reminderSummary(rules, failure)
  const offline = useOfflineEntry(threadId)
  const reminderWarn = !reminders.known && failure !== null
  const saving = useReminderToggle(threadId, onUpdated, reminder.open)
  const warn = reminderWarn || offline.warn

  const report = useRef(onReminderOpenChange)
  useEffect(() => {
    report.current = onReminderOpenChange
  })
  useEffect(() => {
    report.current(reminder.open)
  }, [reminder.open])
  useEffect(() => () => report.current(false), [])

  const chooseReminder = () => {
    menu.close(false)
    reminder.toggle()
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

  const expanded = menu.open || reminder.open
  return (
    <span
      className="thread-more"
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (next === null || event.currentTarget.contains(next)) return
        menu.close(false)
        reminder.close(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={warn ? 'btn thread-more-trigger is-warning' : 'btn thread-more-trigger'}
        aria-haspopup="menu"
        aria-expanded={expanded}
        aria-controls={menu.open ? menuId : reminder.open ? reminderId : undefined}
        aria-label={warn ? '更多（有需要注意的状态）' : '更多'}
        onClick={() => (reminder.open ? reminder.close() : menu.toggle())}
      >
        <Icon name={warn ? 'alert' : 'more'} />
        更多
      </button>
      {menu.open && (
        <div ref={menuRef} id={menuId} className="thread-more-menu" role="menu" aria-label="更多操作" onKeyDown={onMenuKeyDown}>
          <button
            type="button"
            role="menuitem"
            className={reminders.on.length > 0 ? 'thread-more-item is-on' : reminderWarn ? 'thread-more-item is-warning' : 'thread-more-item'}
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
      {reminder.open && (
        <ReminderPanel
          panelRef={reminderRef}
          id={reminderId}
          saving={saving}
          label={label}
          rules={rules}
          failure={failure}
          onRetry={onRetry}
        />
      )}
      {offlineOpen && (
        <OfflineDialog
          threadId={threadId}
          title={label}
          offline={offline.offline}
          onClose={() => setOfflineOpen(false)}
          fallbackFocus={() => triggerRef.current}
        />
      )}
    </span>
  )
}
