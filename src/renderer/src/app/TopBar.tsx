import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react'
import type { AppPlatform } from '../../../shared/api'
import { Icon } from '../components/Icon'
import type { Tab } from '../features/tabs/tabsState'
import { shortcutLabel } from './shortcuts'

function withShortcut(label: string, shortcut: string): string {
  return shortcut === '' ? label : `${label}（${shortcut}）`
}

/**
 * D layout top bar, which is also the window's title bar: back / forward of the current tab, the tab
 * strip, the tab's 分栏 toggle (list entries only), 新标签 and, while the navigation is an overlay,
 * its trigger first and 设置 last. Its empty space drags the window; the controls do not. It leaves
 * room for the window controls (Windows / Linux overlay on the right, macOS traffic lights on the left).
 */
export function TopBar({
  tabs,
  activeId,
  titleOf,
  platform,
  canBack,
  backLabel,
  canForward,
  splitToggle,
  navTrigger,
  settingsTrigger,
  onBack,
  onForward,
  onActivate,
  onClose,
  onNewTab
}: {
  tabs: readonly Tab[]
  activeId: number
  titleOf: (tab: Tab) => string
  platform: AppPlatform | null
  canBack: boolean
  /**
   * Back from an entry produced by a quote (返回引用处) or a search hit (返回搜索结果); null for a
   * plain back step or when back is not possible.
   */
  backLabel: string | null
  canForward: boolean
  /** Shown only for list entries. */
  splitToggle: { pressed: boolean; onToggle: () => void } | null
  navTrigger: { ref: RefObject<HTMLButtonElement | null>; expanded: boolean; onToggle: () => void } | null
  /** Opens the settings page (also Ctrl/Cmd+,); `null` hides it (the rail has 设置). */
  settingsTrigger: { ref: RefObject<HTMLButtonElement | null>; onOpen: () => void } | null
  onBack: () => void
  onForward: () => void
  onActivate: (tabId: number) => void
  onClose: (tabId: number) => void
  onNewTab: () => void
}) {
  const stripRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Instant on purpose: no smooth scrolling (reduced motion), the selected tab is simply brought into view.
    stripRef.current?.querySelector(`#tab-${activeId}`)?.scrollIntoView({ behavior: 'instant', block: 'nearest', inline: 'nearest' })
  }, [activeId, tabs.length])

  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    let next: number
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    const target = tabs[next]
    if (target === undefined) return
    onActivate(target.id)
    document.getElementById(`tab-${target.id}`)?.focus()
  }

  return (
    <header className={platform === 'darwin' ? 'topbar is-macos' : 'topbar'}>
      {navTrigger !== null && (
        <button
          ref={navTrigger.ref}
          type="button"
          className="icon-btn"
          aria-label="打开导航"
          title="导航"
          aria-haspopup="true"
          aria-expanded={navTrigger.expanded}
          aria-controls="nav-overlay"
          onClick={navTrigger.onToggle}
        >
          <Icon name="sidebar" />
        </button>
      )}
      <div className="history-buttons" role="group" aria-label="当前标签历史">
        <button
          type="button"
          className={backLabel !== null ? 'btn btn-back-quote' : 'icon-btn'}
          aria-label={backLabel ?? '后退'}
          title={withShortcut(backLabel ?? '后退', shortcutLabel('back', platform))}
          disabled={!canBack}
          onClick={onBack}
        >
          <Icon name="arrowLeft" />
          {backLabel !== null && <span aria-hidden="true">{backLabel}</span>}
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="前进"
          title={withShortcut('前进', shortcutLabel('forward', platform))}
          disabled={!canForward}
          onClick={onForward}
        >
          <Icon name="arrowRight" />
        </button>
      </div>

      <div className="tab-strip" role="tablist" aria-label="标签" ref={stripRef}>
        {tabs.map((tab, index) => {
          const selected = tab.id === activeId
          const title = titleOf(tab)
          return (
            <div key={tab.id} className={selected ? 'tab is-active' : 'tab'} role="presentation">
              <button
                type="button"
                role="tab"
                id={`tab-${tab.id}`}
                className="tab-button"
                aria-selected={selected}
                aria-controls={`tabpanel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                title={title}
                onClick={() => onActivate(tab.id)}
                onKeyDown={(event) => onTabKeyDown(event, index)}
              >
                {tab.split && <Icon name="split" size={14} className="tab-icon" />}
                <span className="tab-title">{title}</span>
              </button>
              <button
                type="button"
                className="tab-close"
                aria-label={`关闭标签：${title}`}
                title={withShortcut('关闭标签', selected ? shortcutLabel('close-tab', platform) : '')}
                tabIndex={selected ? 0 : -1}
                onClick={() => onClose(tab.id)}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          )
        })}
      </div>

      {splitToggle !== null && (
        <button type="button" className="btn btn-toggle" aria-pressed={splitToggle.pressed} onClick={splitToggle.onToggle}>
          <Icon name="split" />
          分栏
        </button>
      )}
      <button
        type="button"
        className="icon-btn"
        aria-label="新标签"
        title={withShortcut('新标签', shortcutLabel('new-tab', platform))}
        onClick={onNewTab}
      >
        <Icon name="plus" />
      </button>
      {settingsTrigger !== null && (
        <button
          ref={settingsTrigger.ref}
          type="button"
          className="icon-btn"
          aria-label="设置"
          title={withShortcut('设置', shortcutLabel('open-settings', platform))}
          onClick={settingsTrigger.onOpen}
        >
          <Icon name="settings" />
        </button>
      )}
    </header>
  )
}
