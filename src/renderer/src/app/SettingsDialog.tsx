import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { AppSettings } from '../../../shared/reading'
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
export function SettingsDialog({
  identities,
  settings,
  onSettingsChange,
  onClose
}: {
  identities: IdentitiesState
  settings: AppSettings
  onSettingsChange: (settings: AppSettings) => void
  onClose: () => void
}) {
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
        <TabsSection settings={settings} onChange={onSettingsChange} />
        <CookieSection identities={identities} />
      </div>
    </dialog>
  )
}

/** 标签 settings. Changing the default affects only tabs created afterwards. */
function TabsSection({ settings, onChange }: { settings: AppSettings; onChange: (settings: AppSettings) => void }) {
  const headingId = useId()
  const labelId = useId()
  const helpId = useId()
  const [busy, setBusy] = useState(false)
  const [notSaved, setNotSaved] = useState(false)

  const toggleSplitDefault = async () => {
    if (busy) return
    setBusy(true)
    setNotSaved(false)
    try {
      const result = await window.xidao.settings.update({ newTabSplitDefault: !settings.newTabSplitDefault })
      onChange(result.settings)
      setNotSaved(!result.saved)
    } catch {
      setNotSaved(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 className="settings-section-title" id={headingId}>
        标签
      </h3>
      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-label" id={labelId}>
            新标签默认开启分栏
          </span>
          <span className="setting-help" id={helpId}>
            只影响之后新建的标签，已有标签保留各自的分栏选择。
          </span>
        </div>
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={settings.newTabSplitDefault}
          aria-labelledby={labelId}
          aria-describedby={helpId}
          aria-busy={busy}
          onClick={() => void toggleSplitDefault()}
        >
          <span className="switch-thumb" aria-hidden="true" />
          <span className="switch-state" aria-hidden="true">
            {settings.newTabSplitDefault ? '开' : '关'}
          </span>
        </button>
      </div>
      {notSaved && (
        <p className="notice-inline is-warning" role="status">
          <Icon name="alert" size={14} />
          未能保存：本地存储当前不可写入，设置显示的是实际生效的值
        </p>
      )}
    </section>
  )
}
