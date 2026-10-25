import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { ThreadId } from '../../../../shared/forum'
import { REMINDER_KINDS, type ReminderKind, type ReminderRule, type ThreadReminders } from '../../../../shared/reminders'
import { Icon } from '../../components/Icon'
import { usePopover } from '../../lib/usePopover'
import { enabledKinds, KIND_HELP, KIND_NAME, KIND_SHORT, ruleStateText } from './reminderText'
import { failureText, type LoadFailure } from './useReminders'
import './reminders.css'

/**
 * 提醒 control of one thread: a button stating which kinds are on, opening a small panel with one
 * real checkbox per kind and its start (提醒起点). Toggling only saves the rule: it never starts a
 * check and never marks anything read. Esc, a press outside or Tab leaving the panel closes it;
 * Esc returns focus to the button.
 */
export function ReminderMenu({
  threadId,
  label,
  rules,
  failure,
  onRetry,
  onUpdated,
  small = false,
  tabIndex,
  onOpenChange
}: {
  threadId: ThreadId
  /** Thread title or `No.x`, for accessible names. */
  label: string
  /** `undefined` while not known. */
  rules: Record<ReminderKind, ReminderRule> | undefined
  failure: LoadFailure | null
  onRetry: () => void
  onUpdated: (thread: ThreadReminders) => void
  small?: boolean
  tabIndex?: number
  /** The panel opened or closed (a reader stops judging reading while it covers posts). */
  onOpenChange?: (open: boolean) => void
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const popover = usePopover(triggerRef, panelRef)
  const panelId = useId()

  const report = useRef(onOpenChange)
  useEffect(() => {
    report.current = onOpenChange
  })
  const open = popover.open
  useEffect(() => {
    report.current?.(open)
  }, [open])
  useEffect(() => () => report.current?.(false), [])

  const { on, known, text, state } = reminderSummary(rules, failure)
  const saving = useReminderToggle(threadId, onUpdated, open)

  return (
    <span
      className="reminder-menu"
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (popover.open && next !== null && !event.currentTarget.contains(next)) popover.close(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`btn${small ? ' btn-small btn-quiet' : ''} reminder-trigger${on.length > 0 ? ' is-on' : ''}${!known && failure !== null ? ' is-warning' : ''}`}
        aria-expanded={popover.open}
        aria-controls={popover.open ? panelId : undefined}
        aria-label={`提醒设置：${label}，${state}`}
        title="全串更新 / PO追更 / 引用我的发言"
        tabIndex={tabIndex}
        onClick={popover.toggle}
      >
        <Icon name={!known && failure !== null ? 'alert' : 'bell'} size={small ? 14 : 16} />
        {text}
      </button>
      {popover.open && (
        <ReminderPanel
          panelRef={panelRef}
          id={panelId}
          label={label}
          rules={rules}
          failure={failure}
          onRetry={onRetry}
          saving={saving}
        />
      )}
    </span>
  )
}

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
 * Saving state of a thread's 提醒 rules, owned by the control rather than its panel: a save still
 * running when the panel closes shows as 正在保存 when it reopens. Closing clears the last error.
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
 * The open 提醒 panel: one real checkbox per kind and its start. Anchored to the end of its
 * positioned parent; kept inside the scroller that would clip it (or the window) when that is
 * narrow or zoomed: narrowed to fit, then shifted sideways.
 */
export function ReminderPanel({
  panelRef,
  id,
  label,
  rules,
  failure,
  onRetry,
  saving
}: {
  panelRef: RefObject<HTMLDivElement | null>
  id: string
  label: string
  rules: Record<ReminderKind, ReminderRule> | undefined
  failure: LoadFailure | null
  onRetry: () => void
  /** The owner's `useReminderToggle`. */
  saving: ReminderToggle
}) {
  const { busy, error, toggle } = saving

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (panel === null) return
    const clip = panel.parentElement?.closest('.list-scroll, .reader-scroll, .modal-body')?.getBoundingClientRect()
    const left = Math.max(clip?.left ?? 0, 0) + 8
    const right = Math.min(clip?.right ?? window.innerWidth, window.innerWidth) - 8
    panel.style.transform = ''
    panel.style.maxWidth = `min(22rem, ${Math.max(160, right - left)}px)`
    const rect = panel.getBoundingClientRect()
    const shift = rect.left < left ? left - rect.left : rect.right > right ? right - rect.right : 0
    if (shift !== 0) panel.style.transform = `translateX(${shift}px)`
  }, [panelRef])

  const known = rules !== undefined

  return (
    <div
      ref={panelRef}
      id={id}
      className="reminder-panel"
      role="group"
      aria-label={`提醒规则：${label}`}
      // A list's roving focus must not take arrow keys from the checkboxes.
      onKeyDown={(event) => {
        if (/^(Arrow|Home$|End$|Page)/.test(event.key)) event.stopPropagation()
      }}
    >
      <p className="reminder-panel-title">提醒 · {label}</p>
      {!known && failure === null && <p className="reminder-panel-note">正在读取提醒状态…</p>}
      {!known && failure !== null && (
        <div className="reminder-panel-failure" role="alert">
          <p>
            <Icon name="alert" size={14} />
            提醒状态读取失败：{failureText(failure)}
          </p>
          <button type="button" className="btn btn-small" onClick={onRetry}>
            重试
          </button>
        </div>
      )}
      {rules !== undefined && (
        <ul className="reminder-rules">
          {REMINDER_KINDS.map((kind) => {
            const rule = rules[kind]
            return (
              <li key={kind}>
                <label className="reminder-rule">
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    aria-busy={busy === kind || undefined}
                    disabled={busy !== null && busy !== kind}
                    onChange={(event) => void toggle(kind, event.target.checked)}
                  />
                  <span className="reminder-rule-text">
                    <span className="reminder-rule-name">{KIND_NAME[kind]}</span>
                    <span className="reminder-rule-help">{KIND_HELP[kind]}</span>
                    <span className={rule.enabled ? 'reminder-rule-state is-on' : 'reminder-rule-state'}>
                      {busy === kind ? '正在保存…' : ruleStateText(rule)}
                    </span>
                  </span>
                </label>
              </li>
            )
          })}
        </ul>
      )}
      <div className="reminder-panel-message" role="status">
        {error !== null && (
          <p className="form-message is-error">
            <Icon name="alert" size={14} />
            <span>{error}</span>
          </p>
        )}
      </div>
      <p className="reminder-panel-note">从开启时起算，不补关闭期间的回复。</p>
    </div>
  )
}
