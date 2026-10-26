import { useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { useCover } from '../lib/appCovered'
import { openLayer } from '../lib/layers'
import { Icon } from './Icon'
import './modal.css'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Modal dialog: mount it to open (`showModal`), unmount it to close. Focus returns to whatever
 * had it when the dialog opened, or to `fallbackFocus` when that control is gone. Tab stays
 * inside; Esc asks `onClose`, which may ignore it (e.g. while an action runs). While mounted it
 * covers the whole app (`useCover`).
 */
export function Modal({
  className,
  label,
  labelledBy,
  onClose,
  fallbackFocus,
  children
}: {
  className?: string
  label?: string
  labelledBy?: string
  onClose: () => void
  fallbackFocus?: () => HTMLElement | null
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const fallback = useRef(fallbackFocus)
  useLayoutEffect(() => {
    fallback.current = fallbackFocus
  })
  useCover(true)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    const active = document.activeElement
    const opener = active instanceof HTMLElement && active !== document.body ? active : null
    // A closable layer above anything opened before it (a pinned quote card): Esc is the dialog's.
    const layer = openLayer()
    dialog.showModal()
    return () => {
      layer.release()
      dialog.close()
      if (opener?.isConnected) opener.focus()
      else fallback.current?.()?.focus()
    }
  }, [])

  // Keep Tab inside the dialog even where the platform would move focus out of the page.
  const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab' || dialogRef.current === null) return
    const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (element) => element.getClientRects().length > 0
    )
    const first = items[0]
    const last = items.at(-1)
    if (first === undefined || last === undefined) return
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className={className === undefined ? 'modal' : `modal ${className}`}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-modal="true"
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        // Esc: let React state close it so focus restoration and cleanup run in one place.
        event.preventDefault()
        onClose()
      }}
      onClose={() => {
        // A platform-forced close (not our own unmount, after which the dialog may be reopened) still updates state.
        if (dialogRef.current?.open === false) onClose()
      }}
    >
      {children}
    </dialog>
  )
}

/** Title row with a close button. */
export function ModalHeader({
  title,
  titleId,
  closeLabel,
  onClose,
  closeDisabled = false
}: {
  title: string
  titleId?: string
  closeLabel: string
  onClose: () => void
  closeDisabled?: boolean
}) {
  return (
    <header className="modal-header">
      <h2 className="modal-title" id={titleId}>
        {title}
      </h2>
      <button
        type="button"
        className="icon-btn"
        onClick={onClose}
        aria-label={closeLabel}
        title="关闭（Esc）"
        disabled={closeDisabled}
      >
        <Icon name="close" />
      </button>
    </header>
  )
}
