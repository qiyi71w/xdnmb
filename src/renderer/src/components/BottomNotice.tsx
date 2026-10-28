import { useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { closeDialogs, noticeHost, onDialogsChange, topDialog } from '../lib/dialogs'
import { Icon, Spinner, type IconName } from './Icon'
import { KaomojiDecor } from './KaomojiDecor'
import { FOCUSABLE } from './Modal'
import './bottom-notice.css'

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

function documentVisible(): boolean {
  return document.visibilityState === 'visible'
}

/** Order in which notices appeared; each notice keeps its place while it stays shown. */
let appeared = 0

export interface BottomNoticeAction {
  label: string
  /** The action is under way: kept focusable, presses are ignored. */
  busy?: boolean
  /**
   * The action takes the user elsewhere (查看更新, 打开草稿, …): open dialogs are closed first, each
   * through its own close path; when one refuses (busy), the press does nothing.
   */
  leaves?: boolean
  onAction: () => void
}

/**
 * The bottom centre of the content column (never over the icon rail), where the notices stack in
 * the order they appeared, oldest on top. The polite live region is always mounted, so a notice
 * that appears is announced once; changes inside one are not re-read as a whole
 * (`aria-atomic="false"`), and a part the caller wraps in `aria-live="off"` updates silently.
 *
 * While a modal dialog is open (outside it everything is inert), the same region moves into the
 * topmost dialog as a manual popover: in the top layer above the dialog and its backdrop, operable
 * by pointer, its actions in the dialog's Tab cycle, and inside the dialog's accessibility tree so
 * new notices are still announced. The element itself moves, so notices keep their state. A
 * topmost dialog that keeps the notices below (`Modal`'s `noticesBelow`) sends the region back to
 * its own place, under every dialog and inert.
 */
export function BottomNoticeStack({ children }: { children: ReactNode }) {
  const homeRef = useRef<HTMLDivElement>(null)
  const [region] = useState(() => {
    const element = document.createElement('div')
    element.className = 'bottom-notice-region'
    element.setAttribute('role', 'status')
    element.setAttribute('aria-atomic', 'false')
    return element
  })

  useLayoutEffect(() => {
    const home = homeRef.current
    if (home === null) return
    const place = () => {
      const dialog = noticeHost()
      if (dialog === null) {
        // Moving it out hides it as a popover; at home it is in the page again.
        if (region.parentElement !== home) home.append(region)
        region.removeAttribute('popover')
        return
      }
      region.setAttribute('popover', 'manual')
      if (region.parentElement !== dialog) dialog.append(region)
      if (!region.matches(':popover-open')) region.showPopover()
    }
    place()
    const stop = onDialogsChange(place)
    return () => {
      stop()
      region.remove()
    }
  }, [region])

  return (
    <>
      <div ref={homeRef} className="bottom-notice-home" />
      {createPortal(children, region)}
    </>
  )
}

/**
 * One in-app notice of a `BottomNoticeStack`: strong glass like menus and dialogs, a message and
 * its actions, each notice closed on its own. Not modal and never takes focus. While the window is
 * hidden nothing is shown: a notice that arrives then appears (and is announced) when the window
 * is shown again. When new actions replace the focused one, focus moves to the action now in its
 * place (else the last). When the notice goes away with focus inside, focus returns to where it
 * came from, else to `fallbackFocus`; while a dialog is open, focus stays in the topmost dialog.
 */
export function BottomNotice({
  open,
  children,
  icon = 'alert',
  tone = 'warning',
  note,
  context,
  detail,
  actions,
  fallbackFocus
}: {
  open: boolean
  /** The message, one sentence. */
  children: ReactNode
  /** The leading mark: the warning sign by default; `spinner` while something is being checked. */
  icon?: IconName | 'spinner'
  /**
   * `warning` draws the mark in the warning ink and ends the message with the warning kaomoji;
   * `neutral` (a plain outcome) draws it in the secondary ink.
   */
  tone?: 'warning' | 'neutral'
  /**
   * Supporting words of the message, e.g. the forum's own reason, right under it: two lines at
   * most on screen, all of it on hover and for screen readers. Plain text; null for none.
   */
  note?: string | null
  /** What the message is about, in a quieter line under it; null for none. */
  context?: ReactNode
  /** A warning under the message, e.g. why an action did not apply; null for none. */
  detail?: ReactNode
  actions: readonly BottomNoticeAction[]
  fallbackFocus: () => HTMLElement | null
}) {
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible)
  const shown = open && visible

  // Taken when first shown and kept while open, so hiding and showing the window keeps the order.
  const order = useRef<number | null>(null)
  if (!open) order.current = null
  else if (shown) order.current ??= ++appeared

  const focusInside = useRef(false)
  const returnTo = useRef<HTMLElement | null>(null)
  /**
   * Focus left with the notice (now on the body): back to where it came from, else the fallback.
   * While a dialog is open everything outside it is inert: focus goes back only to a place inside
   * the topmost dialog, else to its first control (not a notice), else to the dialog itself.
   */
  const restoreFocus = (back: HTMLElement | null) => {
    const active = document.activeElement
    if (active !== null && active !== document.body) return
    const returnable = back !== null && back.isConnected ? back : null
    const dialog = topDialog()
    if (dialog === null) {
      const target = returnable ?? fallbackFocus()
      target?.focus({ preventScroll: true })
      return
    }
    if (returnable !== null && dialog.contains(returnable)) {
      returnable.focus({ preventScroll: true })
      return
    }
    const control = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].find(
      (element) => element.closest('.bottom-notice-region') === null && element.getClientRects().length > 0
    )
    if (control !== undefined) {
      control.focus({ preventScroll: true })
      return
    }
    // A dialog element takes focus only with a tabindex; -1 keeps it out of the Tab order.
    if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1
    dialog.focus({ preventScroll: true })
  }
  const restoreRef = useRef(restoreFocus)
  useLayoutEffect(() => {
    restoreRef.current = restoreFocus
  })

  // Removing a focused element fires no blur: `focusInside` still says where focus was.
  useLayoutEffect(() => {
    if (shown || !focusInside.current) return
    focusInside.current = false
    const back = returnTo.current
    returnTo.current = null
    restoreRef.current(back)
  }, [shown])

  // Removed altogether (not closed) with focus inside: once the removal is committed, put focus back.
  useLayoutEffect(
    () => () => {
      if (!focusInside.current) return
      const back = returnTo.current
      const restore = restoreRef.current
      queueMicrotask(() => restore(back))
    },
    []
  )

  /** Position of the focused action that this render removed (focus is left on the body). */
  const replaced = useRef<number | null>(null)
  const actionsRow = useRef<HTMLDivElement>(null)
  // Focus stays in the notice, and closing it later still returns focus to where it came from.
  useLayoutEffect(() => {
    const index = replaced.current
    replaced.current = null
    if (index === null || !shown) return
    const active = document.activeElement
    if (active !== null && active !== document.body) return
    const buttons = actionsRow.current?.querySelectorAll<HTMLElement>('button') ?? []
    const back = returnTo.current
    if (buttons.length === 0) {
      focusInside.current = false
      returnTo.current = null
      restoreFocus(back)
      return
    }
    buttons[Math.min(index, buttons.length - 1)]?.focus({ preventScroll: true })
    focusInside.current = true
    returnTo.current = back
  })

  if (!shown) return null
  return (
    <div
      className="bottom-notice"
      style={{ order: order.current ?? undefined }}
      onFocus={(event) => {
        if (focusInside.current) return
        focusInside.current = true
        const from = event.relatedTarget
        returnTo.current = from instanceof HTMLElement && !event.currentTarget.contains(from) ? from : null
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) focusInside.current = false
      }}
    >
      {icon === 'spinner' ? (
        <span className={`bottom-notice-icon is-${tone}`}>
          <Spinner />
        </span>
      ) : (
        <Icon name={icon} className={`bottom-notice-icon is-${tone}`} />
      )}
      <div className="bottom-notice-text">
        <p className="bottom-notice-message">
          {children}
          {tone === 'warning' && icon !== 'spinner' && <KaomojiDecor state="warningNotice" />}
        </p>
        {note !== undefined && note !== null && <p className="bottom-notice-note" title={note}>{note}</p>}
        {context !== undefined && context !== null && <p className="bottom-notice-context">{context}</p>}
        {detail !== undefined && detail !== null && <p className="bottom-notice-detail">{detail}</p>}
      </div>
      <div className="bottom-notice-actions" ref={actionsRow}>
        {actions.map((action, index) => (
          <button
            key={action.label}
            type="button"
            ref={(button) => () => {
              // Detached while still in the document: focused here means focus leaves with it.
              if (document.activeElement === button) replaced.current = index
            }}
            className="btn btn-small bottom-notice-action"
            aria-disabled={action.busy || undefined}
            aria-busy={action.busy || undefined}
            onClick={() => {
              if (action.busy) return
              if (action.leaves === true && !closeDialogs()) return
              action.onAction()
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  )
}
