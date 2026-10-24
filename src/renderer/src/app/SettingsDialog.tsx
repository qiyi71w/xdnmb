import { useEffect, useId, useState } from 'react'
import { CLOSE_ACTIONS, type CloseAction } from '../../../shared/lifecycle'
import type { AppSettings } from '../../../shared/reading'
import { Icon } from '../components/Icon'
import { Modal, ModalHeader } from '../components/Modal'
import { CacheSection } from '../features/content/CacheSection'
import { CookieSection } from '../features/identity/CookieSection'
import type { IdentitiesState } from '../features/identity/useIdentities'
import { SubscriptionSection } from '../features/subscriptions/SubscriptionSection'
import type { SubscriptionsState } from '../features/subscriptions/useSubscriptions'
import './settings.css'

/**
 * Modal settings. Mount it to open and unmount it to close: everything typed inside (including
 * pasted secrets) is discarded with it, and focus returns to whatever opened it.
 */
export function SettingsDialog({
  identities,
  subscriptions,
  settings,
  onSettingsChange,
  onClose
}: {
  identities: IdentitiesState
  subscriptions: SubscriptionsState
  settings: AppSettings
  onSettingsChange: (settings: AppSettings) => void
  onClose: () => void
}) {
  const titleId = useId()
  const { refresh } = identities
  const { refreshOverview: refreshSubscriptions } = subscriptions

  // Show the current state each time settings opens.
  useEffect(() => {
    void refresh()
    void refreshSubscriptions()
  }, [refresh, refreshSubscriptions])

  return (
    <Modal labelledBy={titleId} onClose={onClose}>
      <ModalHeader title="设置" titleId={titleId} closeLabel="关闭设置" onClose={onClose} />
      <div className="modal-body settings-body">
        <TabsSection settings={settings} onChange={onSettingsChange} />
        <WindowSection settings={settings} onChange={onSettingsChange} />
        <PublicationSection />
        <CookieSection identities={identities} />
        <SubscriptionSection subscriptions={subscriptions} />
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

const CLOSE_ACTION_LABEL: Record<CloseAction, string> = {
  ask: '每次询问',
  background: '后台驻留',
  quit: '退出汐岛'
}

/**
 * 窗口 settings: what the window's close button does. A remembered 退出汐岛 still handles every
 * unsaved edit before quitting; 后台驻留 never asks anything.
 */
function WindowSection({ settings, onChange }: { settings: AppSettings; onChange: (settings: AppSettings) => void }) {
  const headingId = useId()
  const labelId = useId()
  const helpId = useId()
  const [busy, setBusy] = useState(false)
  const [notSaved, setNotSaved] = useState(false)

  const choose = async (closeAction: CloseAction) => {
    if (busy || closeAction === settings.closeAction) return
    setBusy(true)
    setNotSaved(false)
    try {
      const result = await window.xidao.settings.update({ closeAction })
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
        窗口
      </h3>
      <div className="setting-row is-choice">
        <div className="setting-text">
          <span className="setting-label" id={labelId}>
            关闭窗口时
          </span>
          <span className="setting-help" id={helpId}>
            后台驻留只隐藏窗口，保留标签和编辑，可从系统托盘（macOS 为 Dock）重新打开。记住的选择不会跳过退出时对未保存编辑的处理。
          </span>
        </div>
        <div className="segmented" role="group" aria-labelledby={labelId} aria-describedby={helpId} aria-busy={busy || undefined}>
          {CLOSE_ACTIONS.map((action) => (
            <button
              key={action}
              type="button"
              className="segmented-item"
              aria-pressed={settings.closeAction === action}
              aria-disabled={busy || undefined}
              onClick={() => void choose(action)}
            >
              {CLOSE_ACTION_LABEL[action]}
            </button>
          ))}
        </div>
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

/**
 * 发送 settings: the persistent PO identity prompt switch. Turning it on again restores the prompt
 * at once, even when “本次启动不再提示” was chosen earlier in this run (the main process clears it).
 */
function PublicationSection() {
  const headingId = useId()
  const labelId = useId()
  const helpId = useId()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notSaved, setNotSaved] = useState(false)

  useEffect(() => {
    let alive = true
    window.xidao.publication
      .getPoWarning()
      .then((result) => {
        if (alive) setEnabled(result.enabled)
      })
      .catch(() => {
        if (alive) setReadFailed(true)
      })
    return () => {
      alive = false
    }
  }, [])

  const toggle = async () => {
    if (busy || enabled === null) return
    setBusy(true)
    setNotSaved(false)
    try {
      const result = await window.xidao.publication.setPoWarning({ enabled: !enabled })
      setEnabled(result.enabled)
      setNotSaved(!result.ok)
    } catch {
      setNotSaved(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 className="settings-section-title" id={headingId}>
        发送
      </h3>
      <div className="setting-row">
        <div className="setting-text">
          <span className="setting-label" id={labelId}>
            回复自己的串时提示 PO 饼干
          </span>
          <span className="setting-help" id={helpId}>
            当前饼干与开串时不同才提示。重新开启会立即恢复提示，包括本次启动中选过“不再提示”的情况。
          </span>
        </div>
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={enabled === true}
          aria-labelledby={labelId}
          aria-describedby={helpId}
          aria-busy={busy}
          disabled={enabled === null}
          onClick={() => void toggle()}
        >
          <span className="switch-thumb" aria-hidden="true" />
          <span className="switch-state" aria-hidden="true">
            {enabled === null ? '…' : enabled ? '开' : '关'}
          </span>
        </button>
      </div>
      {readFailed && (
        <p className="notice-inline is-warning" role="status">
          <Icon name="alert" size={14} />
          未能读取这项设置
        </p>
      )}
      {notSaved && (
        <p className="notice-inline is-warning" role="status">
          <Icon name="alert" size={14} />
          未能保存：本地存储当前不可写入，设置显示的是实际生效的值
        </p>
      )}
    </section>
  )
}
