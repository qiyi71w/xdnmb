import { useEffect, useRef, useState } from 'react'
import type { ThreadId } from '../../../../shared/forum'
import { REMINDER_KINDS, type ReminderKind, type ReminderRule, type ThreadReminders } from '../../../../shared/reminders'
import { ContextMenu, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { Icon } from '../../components/Icon'
import { enabledKinds, KIND_NAME, KIND_SHORT } from './reminderText'
import { failureText, type LoadFailure } from './useReminders'

/** What a thread's 提醒 control says: the kinds on, whether the rules are known, label and state. */
export function reminderSummary(rules: Record<ReminderKind, ReminderRule> | undefined, failure: LoadFailure | null) {
  const on = rules === undefined ? [] : enabledKinds(rules)
  const known = rules !== undefined
  const text = !known ? (failure !== null ? '提醒状态未知' : '提醒…') : on.length === 0 ? '提醒' : `提醒：${on.map((kind) => KIND_SHORT[kind]).join('、')}`
  const state = !known
    ? failure !== null
      ? `状态读取失败（${failureText(failure)}）`
      : '正在读取状态'
    : on.length === 0
      ? '未开启'
      : `已开启：${on.map((kind) => KIND_NAME[kind]).join('、')}`
  return { on, known, text, state }
}

/** Saving state of a thread's 提醒 rules (see `useReminderToggle`). */
export interface ReminderToggle {
  /** Kind whose save is running. */
  busy: ReminderKind | null
  /** Why the last save did not apply. */
  error: string | null
  toggle: (kind: ReminderKind, enabled: boolean) => Promise<void>
}

/**
 * Saving state of a thread's 提醒 rules, owned by the control rather than its menu: a save still
 * running when the menu closes shows as busy when it reopens. Closing clears the last error.
 */
export function useReminderToggle(threadId: ThreadId, onUpdated: (thread: ThreadReminders) => void, open: boolean): ReminderToggle {
  const [busy, setBusy] = useState<ReminderKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (!open) setError(null)
  }, [open])

  const toggle = async (kind: ReminderKind, enabled: boolean) => {
    if (busy !== null) return
    setBusy(kind)
    setError(null)
    let text: string | null = null
    try {
      const result = await window.xidao.reminders.setRule({ threadId, kind, enabled })
      if (result.ok) onUpdated(result.thread)
      else text = `${KIND_NAME[kind]}没有${enabled ? '开启' : '关闭'}：${failureText('storage')}`
    } catch {
      text = `${KIND_NAME[kind]}没有${enabled ? '开启' : '关闭'}：${failureText('internal')}`
    }
    if (!alive.current) return
    setBusy(null)
    setError(text)
  }

  return { busy, error, toggle }
}

/**
 * 更多 › 提醒 of a thread: the three kinds as checkable items, as in the 提醒 and 订阅 row menus.
 * Toggling only saves the rule (one at a time); it never starts a check. While a save runs, or
 * while the rules are unknown, no kind can be chosen; a failed read offers a retry.
 */
export function ThreadReminderMenu({
  point,
  label,
  rules,
  failure,
  onRetry,
  saving,
  onClose
}: {
  point: ContextMenuPoint
  /** Thread title or `No.x`. */
  label: string
  rules: Record<ReminderKind, ReminderRule> | undefined
  failure: LoadFailure | null
  onRetry: () => void
  /** The owner's `useReminderToggle`. */
  saving: ReminderToggle
  onClose: (returnFocus: boolean) => void
}) {
  const unknownFailed = rules === undefined && failure !== null
  const items: ContextMenuItem[] = [
    ...REMINDER_KINDS.map((kind): ContextMenuItem => ({
      type: 'check',
      key: kind,
      label: KIND_NAME[kind],
      checked: rules?.[kind].enabled === true,
      disabled: rules === undefined || saving.busy !== null,
      busy: saving.busy === kind,
      onSelect: () => {
        if (rules !== undefined) void saving.toggle(kind, !rules[kind].enabled)
      }
    })),
    ...(unknownFailed ? [{ type: 'action', key: 'retry', label: '重新读取提醒', keepOpen: true, onSelect: onRetry } as const] : [])
  ]
  const message = saving.error ?? (rules === undefined && failure !== null ? `提醒状态读取失败：${failureText(failure)}` : null)
  return (
    <ContextMenu
      point={point}
      label={`提醒：${label}`}
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
