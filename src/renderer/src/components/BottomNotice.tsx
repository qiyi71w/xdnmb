import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { Icon, Spinner, type IconName } from './Icon'
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
  onAction: () => void
}

/**
 * The bottom centre of the content column (never over the icon rail), where the notices stack in
 * the order they appeared, oldest on top. The polite live region is always mounted, so a notice
 * that appears is announced once; changes inside one are not re-read as a whole
 * (`aria-atomic="false"`), and a part the caller wraps in `aria-live="off"` updates silently.
 */
export function BottomNoticeStack({ children }: { children: ReactNode }) {
  return (
    <div className="bottom-notice-region" role="status" aria-atomic="false">
      {children}
    </div>
  )
}

/**
 * One in-app notice of a `BottomNoticeStack`: strong glass like menus and dialogs, a message and
 * its actions, each notice closed on its own. Not modal and never takes focus. While the window is
 * hidden nothing is shown: a notice that arrives then appears (and is announced) when the window
 * is shown again. When the notice goes away with focus inside, focus returns to where it came
 * from, else to `fallbackFocus`.
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
  /** `warning` draws the mark in the warning ink; `neutral` (a plain outcome) in the secondary ink. */
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
  /** Focus left with the notice (now on the body): back to where it came from, else the fallback. */
  const restoreFocus = (back: HTMLElement | null) => {
    const active = document.activeElement
    if (active !== null && active !== document.body) return
    const target = back !== null && back.isConnected ? back : fallbackFocus()
    target?.focus({ preventScroll: true })
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
        <p className="bottom-notice-message">{children}</p>
        {note !== undefined && note !== null && <p className="bottom-notice-note" title={note}>{note}</p>}
        {context !== undefined && context !== null && <p className="bottom-notice-context">{context}</p>}
        {detail !== undefined && detail !== null && <p className="bottom-notice-detail">{detail}</p>}
      </div>
      <div className="bottom-notice-actions">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className="btn btn-small bottom-notice-action"
            aria-disabled={action.busy || undefined}
            aria-busy={action.busy || undefined}
            onClick={() => {
              if (!action.busy) action.onAction()
            }}
          >
            {action.label}
          </button>
        ))}
      </div>
    </div>
  )
}
