import { useId, useRef, useState, type ReactElement } from 'react'
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
import { formatRecordTime } from '../../lib/time'
import { DismissButton, DismissError, unsettledEntryOf } from '../subscriptions/SubscriptionActivity'
import { activeFor, decideChange, sourceObjectRef, threadMembership, type CollectionState } from '../subscriptions/subscriptionListState'
import { SOURCE_NAME, SOURCE_SHORT, dismissFailureText, failureText, needsReconcile, readbackText, sourceBlocker } from '../subscriptions/subscriptionText'
import { useCollection, useSubscriptionsContext, type ActiveWrite } from '../subscriptions/useSubscriptions'

/** The thread toolbar's borderless button with a collapsible label. */
const BUTTON = 'btn tb-btn subscribe-btn'
const SOURCES: readonly SubscriptionSource[] = ['app', 'web']
const UNRESOLVED = '这个串的上次操作待核对'
const MENU_NAME = '分别订阅到 App／网页'

/** Where this thread stands in one source, from that source's own evidence only. */
type Membership =
  /** The stored list or a read of it is on its way, with no evidence yet. */
  | { kind: 'loading' }
  /** No evidence either way (no complete list, no read that listed it); `failed`: the last attempt failed. */
  | { kind: 'unread'; failed: boolean }
  /** Evidence as of `at`: a list read or a confirmed write. */
  | { kind: 'in'; at: string }
  | { kind: 'out'; at: string }
  /** A write of this thread to this source is running in this window. */
  | { kind: 'pending'; action: SubscriptionAction }
  /** A read-only 核对 of this thread in this source is running. */
  | { kind: 'reconciling' }
  /** The latest write's result is not settled: only the read-only 核对 (or closing its reminder) is offered. */
  | { kind: 'unknown'; operation: SubscriptionOperation }
  /** The source cannot be used now; `settings` is where it is configured (null: nothing to set there). */
  | { kind: 'unavailable'; reason: string; settings: SettingsSectionId | null }

/** What the latest readback or 核对 of an unsettled write saw, as a clause; empty before any. */
function readbackDetail(operation: SubscriptionOperation): string {
  const text = readbackText(operation)
  return text === null ? '' : `：${text}`
}

/** One source's state for this thread: its running write or 核对 first, then an unsettled result, then whether it can be used. */
function sourceState(
  source: SubscriptionSource,
  threadId: ThreadId,
  overview: SubscriptionOverview,
  operations: readonly SubscriptionOperation[] | null,
  active: ActiveWrite | null,
  collection: CollectionState | null
): Membership {
  if (active !== null && activeFor(active, { source, threadId, generation: overview.context.generation })) {
    return active.kind === 'change' ? { kind: 'pending', action: active.action } : { kind: 'reconciling' }
  }
  const objectRef = sourceObjectRef(overview.context, source)
  const entries = (operations ?? []).filter(
    (item) => item.threadId === threadId && item.source === source && sourceObjectRef(item.context, item.source) === objectRef
  )
  const membership = threadMembership(threadId, collection, entries, active)
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
 * source; without evidence it offers reading that source's list (the same shared read round as the
 * subscription page). The arrow lists App and 网页 each with its own state: choosing one writes to
 * that source for this press only, changing neither the default nor the source the page shows.
 */
export function SubscribeButton({ threadId, label, displayed }: { threadId: ThreadId; label: string; displayed: boolean }) {
  const { overview, operations, active, busy, change, reconcile, dismiss, dismissFailure, refreshCollection } = useSubscriptionsContext()
  const target = useSettings().settings.defaultSubscriptionSource
  const openSettings = useSettingsOpener()
  const reasonId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const collections: Record<SubscriptionSource, CollectionState | null> = {
    app: useCollection('app').state,
    web: useCollection('web').state
  }

  /** The open source menu, for the thread it was opened on. */
  const [menu, setMenu] = useState<{ threadId: ThreadId; point: ContextMenuPoint } | null>(null)
  // A hidden tab or another thread drops the menu without taking focus anywhere.
  if (menu !== null && (!displayed || menu.threadId !== threadId || overview === null)) setMenu(null)

  if (overview === null) return null

  const states: Record<SubscriptionSource, Membership> = {
    app: sourceState('app', threadId, overview, operations, active, collections.app),
    web: sourceState('web', threadId, overview, operations, active, collections.web)
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
  /** The press on one source: its write, its 核对, its settings or one read round of its list; nothing else. */
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
      case 'unread':
        refreshCollection(source, overview.context)
    }
  }
  /** Where the evidence comes from, for the button's title. */
  const asOf = (state: Membership) => (state.kind === 'in' || state.kind === 'out' ? `（据 ${formatRecordTime(state.at)} 的读取）` : '')

  const state = states[target]
  const targetTag = <span className="subscribe-target">{SOURCE_SHORT[target]}</span>
  let main: ReactElement
  if (state.kind === 'pending' || state.kind === 'reconciling' || state.kind === 'loading') {
    const text =
      state.kind === 'loading' ? '读取中…' : state.kind === 'reconciling' ? '核对中…' : state.action === 'remove' ? '取消中…' : '订阅中…'
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
        ? {
            text: '核对订阅',
            icon: 'alert' as const,
            warn: true,
            title: `${SOURCE_NAME[target]}：上次操作结果未确认${readbackDetail(state.operation)}；核对只读取，不会重发`
          }
        : state.kind === 'unread'
          ? state.failed
            ? { text: '重新读取', icon: 'alert' as const, warn: true, title: `${SOURCE_NAME[target]}：订阅状态读取失败，点按重新读取订阅列表` }
            : { text: '读取状态', icon: 'bookmark' as const, warn: false, title: `${SOURCE_NAME[target]}：订阅状态未知，点按读取订阅列表` }
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
                title: `${SOURCE_NAME[target]}：${subscribed ? '已订阅，点按取消订阅' : '未订阅，点按订阅'}${asOf(state)}`
              }
    main = (
      <button
        type="button"
        className={view.warn ? `${BUTTON} is-warning` : subscribed ? `${BUTTON} is-on` : BUTTON}
        aria-pressed={state.kind === 'in' || state.kind === 'out' ? subscribed : undefined}
        aria-disabled={reason !== null || undefined}
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
      case 'unread':
        return { type: 'action', key: source, label: `${name}：${item.failed ? '重新读取状态' : '读取状态'}`, keepOpen: true, onSelect }
      case 'unknown':
        return { type: 'action', key: source, label: `${name}：核对订阅`, disabled: busy, keepOpen: true, onSelect }
      case 'unavailable': {
        const blocked = blockedReason(source) !== null
        return { type: 'action', key: source, label: `${name}：${blocked ? '不可用' : '去设置…'}`, disabled: blocked, onSelect }
      }
    }
  }
  /** 关闭 of an unsettled result's reminder, beside its 核对; local only. */
  const dismissItem = (source: SubscriptionSource): ContextMenuItem[] => {
    const item = states[source]
    if (item.kind !== 'unknown') return []
    return [
      {
        type: 'action',
        key: `${source}-dismiss`,
        label: `${SOURCE_NAME[source]}：关闭待核对提示`,
        disabled: busy,
        onSelect: () => {
          if (!busy) void dismiss(item.operation)
        }
      }
    ]
  }
  /** Why each source's item does what it does, when its label alone does not say. */
  const notes = SOURCES.flatMap((source) => {
    const item = states[source]
    const reason =
      item.kind === 'unavailable'
        ? item.reason
        : item.kind === 'unknown'
          ? dismissFailure?.id === item.operation.id
            ? dismissFailureText(dismissFailure.reason)
            : `上次操作结果未确认${readbackDetail(item.operation)}；核对只读取，不会重发；关闭提示不更改远端订阅`
          : item.kind === 'unread'
            ? item.failed
              ? '订阅状态读取失败'
              : '没有读完的订阅列表，状态未知'
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
          items={SOURCES.flatMap((source) => [menuItem(source), ...dismissItem(source)])}
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
 * One line for the last write or 核对 of this thread made anywhere in the app, naming the source it
 * went to, with what its readback or 核对 saw; nothing once it is closed. A confirmed result is the
 * source's own state (the button or its menu item); only failures and unknown outcomes leave a line.
 * While it leaves an unresolved entry, its × closes that entry's reminder durably (local only), and
 * focus moves to the subscribe button.
 */
export function SubscribeNote({ threadId }: { threadId: ThreadId }) {
  const { lastWrite, active, operations, dismissLastWrite } = useSubscriptionsContext()
  if (active !== null || lastWrite === null || lastWrite.write.threadId !== threadId) return null
  const { write, outcome } = lastWrite
  const what = `${SOURCE_NAME[write.source]}：${write.kind === 'change' ? (write.action === 'add' ? '订阅' : '取消订阅') : '核对'}`
  let text: string
  switch (outcome.type) {
    case 'done': {
      const detail = readbackDetail(outcome.operation)
      if (outcome.operation.reportError?.kind === 'rate-limited') text = `${what}结果未确认：限流或需要验证${detail}`
      else if (needsReconcile(outcome.operation)) text = `${what}结果未确认${detail}`
      else return null
      break
    }
    case 'refused':
      text = outcome.reason === 'result-storage' ? `${what}结果未知` : `${what}未执行：${failureText(outcome.reason)}`
      break
    case 'failed':
      text = write.kind === 'change' ? `${what}结果未知` : `${SOURCE_NAME[write.source]}：核对请求失败`
      break
  }
  const unsettled = unsettledEntryOf(lastWrite, operations, active)
  return (
    <span className="subscribe-note toolbar-warning">
      <Icon name="alert" size={14} />
      {text}
      {unsettled !== null && <DismissError operation={unsettled} />}
      {unsettled !== null ? (
        <DismissButton
          operation={unsettled}
          className="icon-btn subscribe-note-close"
          focusAfter={(from) => from.closest('.reader-toolbar-inner')?.querySelector<HTMLElement>('.subscribe-split > .btn') ?? null}
        />
      ) : (
        <button type="button" className="icon-btn subscribe-note-close" onClick={dismissLastWrite} aria-label="关闭这条结果">
          <Icon name="close" size={12} />
        </button>
      )}
    </span>
  )
}
