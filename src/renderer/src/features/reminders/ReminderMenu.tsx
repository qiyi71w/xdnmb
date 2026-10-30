import { useContext, useEffect, useRef, useState } from 'react'
import type { ThreadId } from '../../../../shared/forum'
import { REMINDER_KINDS, type ReminderKind, type ReminderRule, type ThreadReminders } from '../../../../shared/reminders'
import { ContextMenu, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { Icon } from '../../components/Icon'
import { baselineMenuText, baselineState, enabledKinds, issuesText, KIND_NAME, KIND_SHORT } from './reminderText'
import { failureText, RemindersContext, type LoadFailure } from './useReminders'
import './reminders.css'

/** What a thread's 提醒 control says: the kinds on, whether the rules are known, label and state. */
export function reminderSummary(rules: Record<ReminderKind, ReminderRule> | undefined, failure: LoadFailure | null) {
  const on = rules === undefined ? [] : enabledKinds(rules)
  const known = rules !== undefined
  const text = !known ? (failure !== null ? '提醒状态未知' : '提醒…') : on.length === 0 ? '提醒' : `提醒：${on.map((kind) => KIND_SHORT[kind]).join('、')}`
  const pending = rules === undefined ? null : baselineState(rules, null)
  const state = !known
    ? failure !== null
      ? `状态读取失败（${failureText(failure)}）`
      : '正在读取状态'
    : on.length === 0
      ? '未开启'
      : `已开启：${on.map((kind) => KIND_NAME[kind]).join('、')}${pending === null ? '' : `；${pending.kinds.map((kind) => KIND_NAME[kind]).join('、')}等待建立基线`}`
  return { on, known, text, state }
}

/**
 * The line a thread's 提醒 menus add for kinds still waiting for their baseline (提醒基线): quiet
 * while waiting, a warning with the reasons once the thread's latest check failed to read it (from
 * the app-wide overview's row; without one only the waiting is said). Nothing when every enabled
 * kind is counting. Main schedules the reading; this never starts a check.
 */
export function ReminderBaselineNote({ threadId, rules }: { threadId: ThreadId; rules: Record<ReminderKind, ReminderRule> | undefined }) {
  const row = useContext(RemindersContext)?.overview?.threads.find((thread) => thread.threadId === threadId) ?? null
  if (rules === undefined) return null
  const state = baselineState(rules, row?.issues ?? null)
  if (state === null) return null
  return (
    <p className={state.failed ? 'form-message reminder-baseline-note is-warning' : 'form-message reminder-baseline-note'}>
      <Icon name={state.failed ? 'alert' : 'info'} size={14} />
      <span>{baselineMenuText(state, row === null ? null : issuesText(row))}</span>
    </p>
  )
}

/** Saving state of a thread's 提醒 rules (see `useReminderToggle`). */
export interface ReminderToggle {
  /** The thread whose rules it saves. */
  threadId: ThreadId
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

  return { threadId, busy, error, toggle }
}

/**
 * 更多 › 提醒 of a thread: the three kinds as checkable items, as in the 提醒 and 订阅 row menus.
 * Toggling only saves the rule (one at a time); it never starts a check. While a save runs, or
 * while the rules are unknown, no kind can be chosen; a failed read offers a retry. Enabled kinds
 * still waiting for their baseline say so under the items.
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
          <ReminderBaselineNote threadId={saving.threadId} rules={rules} />
        </div>
      }
      onClose={onClose}
    />
  )
}
