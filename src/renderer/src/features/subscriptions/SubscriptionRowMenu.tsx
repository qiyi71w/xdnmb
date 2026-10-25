// PROTOTYPE (throwaway): a subscription row's actions live in its context menu instead of buttons
// on the row. Built only with VITE_XIDAO_PROTOTYPE=1.

import type { ThreadId } from '../../../../shared/forum'
import { REMINDER_KINDS, type ReminderKind, type ReminderRule, type ThreadReminders } from '../../../../shared/reminders'
import { ContextMenu, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { Icon } from '../../components/Icon'
import { useReminderToggle } from '../reminders/ReminderMenu'
import { KIND_NAME } from '../reminders/reminderText'
import { failureText, type LoadFailure } from '../reminders/useReminders'

/**
 * Context menu of one subscription row: the three 提醒 kinds as checkable items (saved like the
 * 提醒 panel: one rule at a time, never starting a check) and 取消订阅, which opens the usual
 * confirmation. While the rules are unknown the kinds cannot be toggled; a failed read offers a retry.
 */
export function SubscriptionRowMenu({
  point,
  threadId,
  label,
  rules,
  failure,
  onRetry,
  onUpdated,
  removeBlocked,
  onRemove,
  onClose
}: {
  point: ContextMenuPoint
  threadId: ThreadId
  /** Thread title or `No.x`. */
  label: string
  rules: Record<ReminderKind, ReminderRule> | undefined
  failure: LoadFailure | null
  onRetry: () => void
  onUpdated: (thread: ThreadReminders) => void
  /** Why 取消订阅 cannot start now; null when it can. */
  removeBlocked: string | null
  onRemove: () => void
  onClose: (returnFocus: boolean) => void
}) {
  const saving = useReminderToggle(threadId, onUpdated, true)
  const unknownFailed = rules === undefined && failure !== null
  const items: ContextMenuItem[] = [
    ...REMINDER_KINDS.map((kind): ContextMenuItem => ({
      type: 'check',
      key: kind,
      label: KIND_NAME[kind],
      checked: rules?.[kind].enabled === true,
      disabled: rules === undefined || (saving.busy !== null && saving.busy !== kind),
      busy: saving.busy === kind,
      onSelect: () => {
        if (rules !== undefined) void saving.toggle(kind, !rules[kind].enabled)
      }
    })),
    ...(unknownFailed ? [{ type: 'action', key: 'retry', label: '重新读取提醒', keepOpen: true, onSelect: onRetry } as const] : []),
    { type: 'separator', key: 'separator' },
    {
      type: 'action',
      key: 'remove',
      label: '取消订阅…',
      disabled: removeBlocked !== null,
      title: removeBlocked ?? undefined,
      onSelect: onRemove
    }
  ]
  const message = saving.error ?? (rules === undefined && failure !== null ? `提醒状态读取失败：${failureText(failure)}` : null)
  return (
    <ContextMenu
      point={point}
      label={`订阅操作：${label}`}
      items={items}
      footer={
        <div role="status">
          {message !== null && (
            <p className="form-message is-error">
              <Icon name="alert" size={14} />
              <span>{message}</span>
            </p>
          )}
        </div>
      }
      onClose={onClose}
    />
  )
}
