import { useEffect, useId, useState } from 'react'
import type { AppSettings } from '../../../shared/reading'
import { Icon } from '../components/Icon'
import { Modal, ModalHeader } from '../components/Modal'
import { CacheSection } from '../features/content/CacheSection'
import { CookieSection } from '../features/identity/CookieSection'
import type { IdentitiesState } from '../features/identity/useIdentities'
import './settings.css'

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
  const titleId = useId()
  const { refresh } = identities

  // Show the current state each time settings opens.
  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      <ModalHeader title="设置" titleId={titleId} closeLabel="关闭设置" onClose={onClose} />
      <div className="modal-body settings-body">
        <TabsSection settings={settings} onChange={onSettingsChange} />
        <CookieSection identities={identities} />
        <CacheSection />
      </div>
    </Modal>
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
