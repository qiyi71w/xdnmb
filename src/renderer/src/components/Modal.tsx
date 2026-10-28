import { useLayoutEffect, useRef, type MouseEvent, type PointerEvent, type ReactNode } from 'react'
import { useCover } from '../lib/appCovered'
import { registerDialog } from '../lib/dialogs'
import { openLayer } from '../lib/layers'
import { Icon } from './Icon'
import './modal.css'

export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Keeps Tab inside `dialog` even where the platform would move focus out of the page; returns the
 * removal. A native listener: the bottom notices placed in the topmost dialog (see
 * `BottomNoticeStack`) belong to another part of the React tree but are in this cycle too, after
 * the dialog's own controls. Keys from a dialog nested inside it (the compose image preview) are
 * that dialog's own.
 */
export function keepTabInside(dialog: HTMLDialogElement, focusable: string = FOCUSABLE): () => void {
  const onKeyDown = (event: globalThis.KeyboardEvent) => {
    if (event.key !== 'Tab' || !(event.target instanceof Element) || event.target.closest('dialog') !== dialog) return
    const items = [...dialog.querySelectorAll<HTMLElement>(focusable)].filter((element) => element.getClientRects().length > 0)
    const first = items[0]
    const last = items.at(-1)
    if (first === undefined || last === undefined) return
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }
  dialog.addEventListener('keydown', onKeyDown)
  return () => dialog.removeEventListener('keydown', onKeyDown)
}

/**
 * A press on a modal dialog's backdrop: only when the primary press and its release both land on
 * the backdrop (the dialog element itself) does `onPress` run. A drag from inside the dialog that
 * ends outside, or a right click, does not count.
 */
export function useBackdropPress(onPress: (() => void) | undefined) {
  const pressedBackdrop = useRef(false)
  return {
    onPointerDown: (event: PointerEvent<HTMLDialogElement>) => {
      pressedBackdrop.current = event.target === event.currentTarget
    },
    onClick: (event: MouseEvent<HTMLDialogElement>) => {
      if (pressedBackdrop.current && event.target === event.currentTarget) onPress?.()
      pressedBackdrop.current = false
    }
  }
}

/**
 * Modal dialog: mount it to open (`showModal`), unmount it to close. Focus returns to whatever
 * had it when the dialog opened, or to `fallbackFocus` when that control is gone. Tab stays
 * inside; Esc asks `onClose`, which may ignore it (e.g. while an action runs); so does a press on
 * the backdrop when `closeOnBackdrop` is set (for dialogs whose closing loses nothing). While
 * mounted it covers the whole app (`useCover`). The bottom notices show above it and stay
 * operable, unless `noticesBelow` keeps them under it.
 */
export function Modal({
  className,
  label,
  labelledBy,
  onClose,
  closeOnBackdrop = false,
  noticesBelow = false,
  fallbackFocus,
  children
}: {
  className?: string
  label?: string
  labelledBy?: string
  onClose: () => void
  /** A press on the backdrop asks `onClose` too, as Esc does. */
  closeOnBackdrop?: boolean
  /**
   * The bottom notices stay under this dialog, inert like the rest of the window, while it is the
   * topmost (a quit at work). Read when it opens.
   */
  noticesBelow?: boolean
  fallbackFocus?: () => HTMLElement | null
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const fallback = useRef(fallbackFocus)
  const keepsNoticesBelow = useRef(noticesBelow)
  const close = useRef(onClose)
  useLayoutEffect(() => {
    fallback.current = fallbackFocus
    close.current = onClose
  })
  useCover(true)
  const backdrop = useBackdropPress(closeOnBackdrop ? onClose : undefined)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    const active = document.activeElement
    const opener = active instanceof HTMLElement && active !== document.body ? active : null
    // A closable layer above anything opened before it (a pinned quote card): Esc is the dialog's.
    const layer = openLayer()
    dialog.showModal()
    const removeTab = keepTabInside(dialog)
    const unregister = registerDialog(dialog, () => close.current(), keepsNoticesBelow.current)
    return () => {
      unregister()
      removeTab()
      layer.release()
      dialog.close()
      if (opener?.isConnected) opener.focus()
      else fallback.current?.()?.focus()
    }
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className={className === undefined ? 'modal' : `modal ${className}`}
      aria-label={label}
      aria-labelledby={labelledBy}
      aria-modal="true"
      onPointerDown={backdrop.onPointerDown}
      onClick={backdrop.onClick}
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
