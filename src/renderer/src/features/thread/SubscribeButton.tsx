import { useCallback, useEffect, useId, useRef, useState, type ReactElement } from 'react'
import type { ThreadId } from '../../../../shared/forum'
import type {
  SubscriptionAction,
  SubscriptionOperation,
  SubscriptionOverview,
  SubscriptionSource
} from '../../../../shared/subscriptions'
import { ContextMenu, type ContextMenuItem, type ContextMenuPoint } from '../../components/ContextMenu'
import { Icon, Spinner } from '../../components/Icon'
import { useSettings } from '../../lib/settingsContext'
import { useSettingsOpener, type SettingsSectionId } from '../../lib/settingsOpener'
import { SUBSCRIPTION_OBSERVED_EVENT } from '../subscriptions/SubscriptionPane'
import {
  decideChange,
  nextStoredObservation,
  sourceObjectRef,
  threadMembership,
  type StoredObservation as Stored
} from '../subscriptions/subscriptionListState'
import { SOURCE_NAME, SOURCE_SHORT, failureText, needsReconcile, sourceBlocker } from '../subscriptions/subscriptionText'
import { useSubscriptionsContext, type ActiveWrite } from '../subscriptions/useSubscriptions'

/** The thread toolbar's borderless button with a collapsible label. */
const BUTTON = 'btn tb-btn subscribe-btn'
const SOURCES: readonly SubscriptionSource[] = ['app', 'web']
const UNRESOLVED = '这个串的上次操作待核对'
const MENU_NAME = '分别订阅到 App／网页'

const LOADING: Stored = { kind: 'loading' }

/** Where this thread stands in one source, from that source's own evidence only. */
type Membership =
  | { kind: 'loading' }
  /** The stored observation could not be read: neither in nor out is known. */
  | { kind: 'failed' }
  | { kind: 'in' }
  | { kind: 'out' }
  /** A write of this thread to this source is running in this window. */
  | { kind: 'pending'; action: SubscriptionAction }
  /** A read-only 核对 of this thread in this source is running. */
  | { kind: 'reconciling' }
  /** The latest write's result is not settled: only the read-only 核对 is offered. */
  | { kind: 'unknown'; operation: SubscriptionOperation }
  /** The source cannot be used now; `settings` is where it is configured (null: nothing to set there). */
  | { kind: 'unavailable'; reason: string; settings: SettingsSectionId | null }

/**
 * The stored observation of one source for the identity currently shown. Results are kept with the
 * source, identity generation and remote collection they were read for, so a result of an earlier
 * identity never shows for a later one; late replies of a superseded or unmounted read are dropped.
 * Local only: nothing is read from the forum.
 */
function useStoredObservation(
  source: SubscriptionSource,
  overview: SubscriptionOverview | null,
  operations: readonly SubscriptionOperation[] | null
): { stored: Stored; retry: () => void } {
  const objectRef = overview === null ? null : sourceObjectRef(overview.context, source)
  const key = overview === null ? null : `${source}|${overview.context.generation}|${objectRef ?? '-'}`
  const [result, setResult] = useState<{ key: string; stored: Stored } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (key === null) return
    let alive = true
    let latest = 0
    const load = () => {
      const request = ++latest
      const settle = (stored: Stored) => {
        if (!alive || request !== latest) return
        setResult((current) => ({ key, stored: current?.key === key ? nextStoredObservation(current.stored, stored) : stored }))
      }
      window.xidao.subscriptions.getObservation({ source }).then(
        (observation) =>
          settle(
            // Stored for another collection than the one shown here (an identity change not yet seen): no evidence.
            observation === null || (observation.source === source && sourceObjectRef(observation.context, source) === objectRef)
              ? { kind: 'read', observation }
              : { kind: 'failed' }
          ),
        () => settle({ kind: 'failed' })
      )
    }
    load()
    window.addEventListener(SUBSCRIPTION_OBSERVED_EVENT, load)
    return () => {
      alive = false
      window.removeEventListener(SUBSCRIPTION_OBSERVED_EVENT, load)
    }
    // A write's readback stores a new observation: read again whenever the journal changes.
  }, [source, key, objectRef, operations, attempt])
  const retry = useCallback(() => setAttempt((count) => count + 1), [])
  return { stored: result !== null && result.key === key ? result.stored : LOADING, retry }
}

/** One source's state for this thread: its running write or 核对 first, then an unsettled result, then whether it can be used. */
function sourceState(
  source: SubscriptionSource,
  threadId: ThreadId,
  overview: SubscriptionOverview,
  operations: readonly SubscriptionOperation[] | null,
  active: ActiveWrite | null,
  stored: Stored
): Membership {
  if (active !== null && active.threadId === threadId && active.source === source) {
    return active.kind === 'change' ? { kind: 'pending', action: active.action } : { kind: 'reconciling' }
  }
  const objectRef = sourceObjectRef(overview.context, source)
  const entries = (operations ?? []).filter(
    (item) => item.threadId === threadId && item.source === source && sourceObjectRef(item.context, item.source) === objectRef
  )
  const membership = threadMembership(threadId, stored, entries, active)
  if (membership.kind === 'unknown') return membership
  const reason = sourceBlocker(overview, source)
  if (reason !== null) {
    // The App UUID is set in 订阅, the web sync object in 饼干 › 用途; unavailable protection is not a setting.
    const settings = overview.protection === 'unavailable' ? null : source === 'app' ? 'subscriptions' : 'cookies'
    return { kind: 'unavailable', reason, settings }
  }
  return membership
}

/**
 * 订阅 in the thread toolbar, split in two. The button writes to the default source saved in
 * 设置 › 订阅 (named on the button), whatever source the subscription page shows: a press writes
 * once at once (`decideChange`), never retried and without confirmation; an unsettled result turns
 * it into the read-only 核对订阅; an unusable default offers its settings instead, never the other
 * source. The arrow lists App and 网页 each with its own state: choosing one writes to that source
 * for this press only, changing neither the default nor the source the page shows.
 */
export function SubscribeButton({ threadId, label, displayed }: { threadId: ThreadId; label: string; displayed: boolean }) {
  const { overview, operations, active, busy, change, reconcile } = useSubscriptionsContext()
  const target = useSettings().settings.defaultSubscriptionSource
  const openSettings = useSettingsOpener()
  const reasonId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const observed: Record<SubscriptionSource, { stored: Stored; retry: () => void }> = {
    app: useStoredObservation('app', overview, operations),
    web: useStoredObservation('web', overview, operations)
  }

  /** The open source menu, for the thread it was opened on. */
  const [menu, setMenu] = useState<{ threadId: ThreadId; point: ContextMenuPoint } | null>(null)
  // A hidden tab or another thread drops the menu without taking focus anywhere.
  if (menu !== null && (!displayed || menu.threadId !== threadId || overview === null)) setMenu(null)

  if (overview === null) return null

  const states: Record<SubscriptionSource, Membership> = {
    app: sourceState('app', threadId, overview, operations, active, observed.app.stored),
    web: sourceState('web', threadId, overview, operations, active, observed.web.stored)
  }
  const decide = (source: SubscriptionSource, action: SubscriptionAction) =>
    decideChange({ overview, source, operations, busy, action, threadId, label, unresolved: UNRESOLVED })
  /** Why a press on `source` cannot start now; null when it can. */
  const blockedReason = (source: SubscriptionSource): string | null => {
    const state = states[source]
    if (state.kind === 'in' || state.kind === 'out') {
      const decision = decide(source, state.kind === 'in' ? 'remove' : 'add')
      return decision.kind === 'blocked' ? decision.reason : null
    }
    if (state.kind === 'unknown') return busy ? '另一项订阅操作正在进行' : null
    if (state.kind === 'unavailable') return state.settings === null || openSettings === null ? state.reason : null
    return null
  }
  /** The press on one source: its write, its 核对, its settings or a fresh local read; nothing else. */
  const press = (source: SubscriptionSource) => {
    const state = states[source]
    switch (state.kind) {
      case 'in':
      case 'out': {
        const decision = decide(source, state.kind === 'in' ? 'remove' : 'add')
        if (decision.kind === 'write') void change(decision.request)
        return
      }
      case 'unknown':
        if (!busy) void reconcile(state.operation)
        return
      case 'unavailable':
        if (state.settings !== null) openSettings?.(state.settings)
        return
      case 'failed':
        observed[source].retry()
    }
  }

  const state = states[target]
  const targetTag = <span className="subscribe-target">{SOURCE_SHORT[target]}</span>
  let main: ReactElement
  if (state.kind === 'pending' || state.kind === 'reconciling') {
    const text = state.kind === 'reconciling' ? '核对中…' : state.action === 'remove' ? '取消中…' : '订阅中…'
    // The press turns this same button pending: aria-disabled keeps the focus on it.
    main = (
      <button type="button" className={BUTTON} aria-disabled aria-busy="true" title={`${SOURCE_NAME[target]}：${text}`}>
        <Spinner />
        <span className="btn-label">{text}</span>
        {targetTag}
      </button>
    )
  } else {
    const reason = blockedReason(target)
    const subscribed = state.kind === 'in'
    const view =
      state.kind === 'unknown'
        ? { text: '核对订阅', icon: 'alert' as const, warn: true, title: `${SOURCE_NAME[target]}：上次操作结果未确认，核对只读取，不会重发` }
        : state.kind === 'failed'
          ? { text: '重新读取', icon: 'alert' as const, warn: true, title: `${SOURCE_NAME[target]}：订阅状态读取失败，点按重新读取` }
          : state.kind === 'unavailable'
            ? {
                text: reason === null ? '设置订阅' : '订阅',
                icon: 'bookmark' as const,
                warn: false,
                title: reason === null ? `${state.reason}，点按打开设置` : state.reason
              }
            : {
                text: subscribed ? '已订阅' : '订阅',
                icon: subscribed ? ('check' as const) : ('bookmark' as const),
                warn: false,
                title: `${SOURCE_NAME[target]}：${subscribed ? '取消订阅' : '订阅'}`
              }
    main = (
      <button
        type="button"
        className={view.warn ? `${BUTTON} is-warning` : subscribed ? `${BUTTON} is-on` : BUTTON}
        aria-pressed={state.kind === 'in' || state.kind === 'out' ? subscribed : undefined}
        aria-disabled={state.kind === 'loading' || reason !== null || undefined}
        aria-describedby={reason !== null ? reasonId : undefined}
        title={reason ?? view.title}
        onClick={() => press(target)}
      >
        <Icon name={view.icon} />
        <span className="btn-label">{view.text}</span>
        {targetTag}
        {reason !== null && (
          <span id={reasonId} className="visually-hidden">
            {reason}
          </span>
        )}
      </button>
    )
  }

  /** One source in the menu: its membership as a check, or what can be done instead. */
  const menuItem = (source: SubscriptionSource): ContextMenuItem => {
    const item = states[source]
    const name = SOURCE_NAME[source]
    const onSelect = () => press(source)
    switch (item.kind) {
      case 'in':
      case 'out':
        return { type: 'check', key: source, label: name, checked: item.kind === 'in', disabled: blockedReason(source) !== null, onSelect }
      case 'pending':
        return {
          type: 'check',
          key: source,
          label: `${name}：${item.action === 'remove' ? '取消中…' : '订阅中…'}`,
          checked: item.action === 'remove',
          disabled: true,
          busy: true,
          onSelect
        }
      case 'reconciling':
        return { type: 'action', key: source, label: `${name}：核对中…`, disabled: true, onSelect }
      case 'loading':
        return { type: 'action', key: source, label: `${name}：读取中…`, disabled: true, onSelect }
      case 'failed':
        return { type: 'action', key: source, label: `${name}：重新读取状态`, keepOpen: true, onSelect }
      case 'unknown':
        return { type: 'action', key: source, label: `${name}：核对订阅`, disabled: busy, keepOpen: true, onSelect }
      case 'unavailable': {
        const blocked = blockedReason(source) !== null
        return { type: 'action', key: source, label: `${name}：${blocked ? '不可用' : '去设置…'}`, disabled: blocked, onSelect }
      }
    }
  }
  /** Why each source's item does what it does, when its label alone does not say. */
  const notes = SOURCES.flatMap((source) => {
    const item = states[source]
    const reason =
      item.kind === 'unavailable'
        ? item.reason
        : item.kind === 'unknown'
          ? '上次操作结果未确认，核对只读取，不会重发'
          : item.kind === 'failed'
            ? '订阅状态读取失败'
            : blockedReason(source)
    return reason === null ? [] : [{ source, text: `${SOURCE_NAME[source]}：${reason}` }]
  })

  return (
    <span className="subscribe-split">
      {main}
      <button
        ref={triggerRef}
        type="button"
        className="btn tb-btn subscribe-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        aria-label={MENU_NAME}
        title={MENU_NAME}
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          setMenu({ threadId, point: { x: box.right, y: box.bottom + 4, end: true } })
        }}
      >
        <Icon name="chevron" size={14} className="subscribe-menu-chevron" />
      </button>
      {menu !== null && (
        <ContextMenu
          point={menu.point}
          label={`订阅：${label}`}
          items={SOURCES.map(menuItem)}
          footer={
            <div role="status">
              {notes.map((note) => (
                <p key={note.source} className="form-message">
                  <Icon name="info" size={14} />
                  <span>{note.text}</span>
                </p>
              ))}
            </div>
          }
          onClose={(returnFocus) => {
            setMenu(null)
            // Only to the opener still on screen: a hidden tab's toolbar never takes the focus.
            if (returnFocus && displayed) triggerRef.current?.focus()
          }}
        />
      )}
    </span>
  )
}

/**
 * One line for the last write of this thread made anywhere in the app, naming the source it went
 * to; nothing once it is dismissed. A confirmed result is the source's own state (the button or its
 * menu item); only failures and unknown outcomes leave a line, whose 核对 is that source's 核对订阅.
 */
export function SubscribeNote({ threadId }: { threadId: ThreadId }) {
  const { lastWrite, active, dismissLastWrite } = useSubscriptionsContext()
  if (active !== null || lastWrite === null || lastWrite.write.threadId !== threadId) return null
  const { write, outcome } = lastWrite
  const what = `${SOURCE_NAME[write.source]}：${write.kind === 'change' ? (write.action === 'add' ? '订阅' : '取消订阅') : '核对'}`
  let text: string
  switch (outcome.type) {
    case 'done':
      if (outcome.operation.reportError?.kind === 'rate-limited') text = `${what}结果未确认：限流或需要验证`
      else if (needsReconcile(outcome.operation)) text = `${what}结果未确认`
      else return null
      break
    case 'refused':
      text = outcome.reason === 'result-storage' ? `${what}结果未知` : `${what}未执行：${failureText(outcome.reason)}`
      break
    case 'failed':
      text = write.kind === 'change' ? `${what}结果未知` : `${SOURCE_NAME[write.source]}：核对请求失败`
      break
  }
  return (
    <span className="subscribe-note toolbar-warning">
      <Icon name="alert" size={14} />
      {text}
      <button type="button" className="icon-btn subscribe-note-close" onClick={dismissLastWrite} aria-label="关闭这条结果">
        <Icon name="close" size={12} />
      </button>
    </span>
  )
}
