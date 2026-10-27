import type { Post, ThreadId } from '../../../../shared/forum'
import { REMINDER_KINDS, type ReminderKind, type ReminderRule, type ThreadReminders } from '../../../../shared/reminders'
import { ContextMenu, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { copyNumberItem, withSelectionCopy } from '../../components/copyMenuItems'
import { Icon } from '../../components/Icon'
import { useReminderToggle } from '../reminders/ReminderMenu'
import { KIND_NAME } from '../reminders/reminderText'
import { failureText, type LoadFailure } from '../reminders/useReminders'
import { useOpenThreadInTab } from '../tabs/openThreadInTab'

/**
 * Context menu of one subscription row: 在新标签页打开, 复制串号, then the three 提醒 kinds as
 * checkable items (saved like the 提醒 panel: one rule at a time, never starting a check) and
 * 取消订阅, which sends the write at once (no confirmation; the thread's reminders stay as they
 * are). While the rules are unknown the kinds cannot be toggled; a failed read offers a retry.
 * 复制选中文字 (taken when the menu opened) comes first.
 */
export function SubscriptionRowMenu({
  point,
  threadId,
  head,
  selection,
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
  /** Main post already on screen, shown in the new tab until page 1 arrives. */
  head: Post
  selection: ContextMenuItem | null
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
  const openInTab = useOpenThreadInTab()
  const unknownFailed = rules === undefined && failure !== null
  const items: ContextMenuItem[] = withSelectionCopy(selection, [
    ...(openInTab === null
      ? []
      : [{ type: 'action', key: 'open-tab', label: '在新标签页打开', onSelect: () => openInTab(threadId, head) } satisfies ContextMenuItem]),
    copyNumberItem(threadId),
    { type: 'separator', key: 'open-separator' },
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
      label: '取消订阅',
      disabled: removeBlocked !== null,
      title: removeBlocked ?? undefined,
      onSelect: onRemove
    }
  ])
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
