import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { Icon } from './Icon'
import './bottom-notice.css'

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}

function documentVisible(): boolean {
  return document.visibilityState === 'visible'
}

/**
 * In-app notice at the bottom centre of the content column (never over the icon rail): strong
 * glass like menus and dialogs, one message and one action. Not modal and never takes focus.
 *
 * The polite live region is always mounted, so a notice that appears is announced once; changes
 * inside it are not re-read as a whole (`aria-atomic="false"`), and a part the caller wraps in
 * `aria-live="off"` updates silently. While the window is hidden nothing is shown: a notice that
 * arrives then appears (and is announced) when the window is shown again. When the notice goes away
 * with focus inside, focus returns to where it came from, else to `fallbackFocus`.
 */
export function BottomNotice({
  open,
  children,
  detail,
  actionLabel,
  actionBusy = false,
  onAction,
  fallbackFocus
}: {
  open: boolean
  /** The message, one sentence. */
  children: ReactNode
  /** A second line under the message, e.g. why the action did not apply; null for none. */
  detail?: ReactNode
  actionLabel: string
  /** The action is under way: kept focusable, presses are ignored. */
  actionBusy?: boolean
  onAction: () => void
  fallbackFocus: () => HTMLElement | null
}) {
  const visible = useSyncExternalStore(subscribeVisibility, documentVisible)
  const shown = open && visible

  const focusInside = useRef(false)
  const returnTo = useRef<HTMLElement | null>(null)
  // Removing a focused element fires no blur: `focusInside` still says where focus was.
  useLayoutEffect(() => {
    if (shown || !focusInside.current) return
    focusInside.current = false
    const back = returnTo.current
    returnTo.current = null
    const active = document.activeElement
    if (active !== null && active !== document.body) return
    const target = back !== null && back.isConnected ? back : fallbackFocus()
    target?.focus({ preventScroll: true })
  }, [shown, fallbackFocus])

  return (
    <div className="bottom-notice-region" role="status" aria-atomic="false">
      {shown && (
        <div
          className="bottom-notice"
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
          <Icon name="alert" className="bottom-notice-icon" />
          <div className="bottom-notice-text">
            <p className="bottom-notice-message">{children}</p>
            {detail !== undefined && detail !== null && <p className="bottom-notice-detail">{detail}</p>}
          </div>
          <button
            type="button"
            className="btn btn-small bottom-notice-action"
            aria-disabled={actionBusy || undefined}
            aria-busy={actionBusy || undefined}
            onClick={() => {
              if (!actionBusy) onAction()
            }}
          >
            {actionLabel}
          </button>
        </div>
      )}
    </div>
  )
}
