import { useRef, useState } from 'react'
import type { AppSettings } from '../../../shared/reading'
import { Icon } from '../components/Icon'
import { usePopover } from '../lib/usePopover'

/** Top-bar settings popover. Changing the default affects only tabs created afterwards. */
export function SettingsMenu({ settings, onChange }: { settings: AppSettings; onChange: (settings: AppSettings) => void }) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const popover = usePopover(triggerRef, panelRef)
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
    <div className="settings-menu">
      <button
        ref={triggerRef}
        type="button"
        className="icon-btn"
        aria-label="设置"
        title="设置"
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        aria-controls="settings-panel"
        onClick={popover.toggle}
      >
        <Icon name="settings" />
      </button>
      {popover.open && (
        <div ref={panelRef} id="settings-panel" className="popover settings-panel" role="dialog" aria-label="设置">
          <div className="setting-row">
            <div className="setting-text">
              <span className="setting-label" id="setting-split-default">
                新标签默认开启分栏
              </span>
              <span className="setting-help" id="setting-split-default-help">
                只影响之后新建的标签，已有标签保留各自的分栏选择。
              </span>
            </div>
            <button
              type="button"
              role="switch"
              className="switch"
              aria-checked={settings.newTabSplitDefault}
              aria-labelledby="setting-split-default"
              aria-describedby="setting-split-default-help"
              aria-busy={busy}
              data-autofocus=""
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
        </div>
      )}
    </div>
  )
}
