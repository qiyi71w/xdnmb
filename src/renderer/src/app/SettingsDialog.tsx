import { useEffect, useId, useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import { Icon } from '../components/Icon'
import { CookieSection } from '../features/identity/CookieSection'
import type { IdentitiesState } from '../features/identity/useIdentities'
import './settings.css'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Modal settings. Mount it to open and unmount it to close: everything typed inside (including
 * pasted secrets) is discarded with it, and focus returns to whatever opened it.
 */
export function SettingsDialog({ identities, onClose }: { identities: IdentitiesState; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const { refresh } = identities

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.showModal()
    return () => {
      dialog.close()
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  // Show the current state each time settings opens.
  useEffect(() => {
    void refresh()
  }, [refresh])

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
      className="settings-dialog"
      aria-labelledby={titleId}
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
      <header className="settings-header">
        <h2 className="settings-title" id={titleId}>
          设置
        </h2>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭设置" title="关闭（Esc）">
          <Icon name="close" />
        </button>
      </header>
      <div className="settings-body">
        <CookieSection identities={identities} />
      </div>
    </dialog>
  )
}
