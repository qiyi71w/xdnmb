import type { Post, ThreadId } from '../../../../shared/forum'
import { REMINDER_KINDS, type ReminderKind, type ReminderRule, type ThreadReminders } from '../../../../shared/reminders'
import { ContextMenu, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { copyNumberItem, withSelectionCopy } from '../../components/copyMenuItems'
import { Icon } from '../../components/Icon'
import { useOpenThreadInTab } from '../tabs/openThreadInTab'
import { useReminderToggle } from './ReminderMenu'
import { KIND_NAME } from './reminderText'

/**
 * Context menu of one 提醒 row: 在新标签页打开, 复制串号, the three kinds as checkable items (saved
 * like the 提醒 panel: one rule at a time, never starting a check) and 清除提醒, unavailable while
 * the thread has no count. 复制选中文字 (taken when the menu opened) comes first.
 */
export function ReminderRowMenu({
  point,
  threadId,
  head,
  selection,
  label,
  rules,
  clearable,
  onUpdated,
  onClear,
  onClose
}: {
  point: ContextMenuPoint
  threadId: ThreadId
  /** Main post held here, shown in the new tab until page 1 arrives; null when not held. */
  head: Post | null
  selection: ContextMenuItem | null
  /** Thread title or `No.x`. */
  label: string
  rules: Record<ReminderKind, ReminderRule>
  /** Some count of the thread is not 0. */
  clearable: boolean
  onUpdated: (thread: ThreadReminders) => void
  onClear: () => void
  onClose: (returnFocus: boolean) => void
}) {
  const saving = useReminderToggle(threadId, onUpdated, true)
  const openInTab = useOpenThreadInTab()
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
      checked: rules[kind].enabled,
      disabled: saving.busy !== null && saving.busy !== kind,
      busy: saving.busy === kind,
      onSelect: () => void saving.toggle(kind, !rules[kind].enabled)
    })),
    { type: 'separator', key: 'separator' },
    {
      type: 'action',
      key: 'clear',
      label: '清除提醒',
      disabled: !clearable,
      title: clearable ? undefined : '没有提醒计数',
      onSelect: onClear
    }
  ])
  return (
    <ContextMenu
      point={point}
      label={`提醒操作：${label}`}
      items={items}
      footer={
        <div role="status">
          {saving.error !== null && (
            <p className="form-message is-error">
              <Icon name="alert" size={14} />
              <span>{saving.error}</span>
            </p>
          )}
        </div>
      }
      onClose={onClose}
    />
  )
}
