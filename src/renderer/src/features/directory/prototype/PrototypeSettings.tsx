// PROTOTYPE (throwaway): the settings page — a view filling the content area with a section directory
// on the left — reusing the sections of the settings dialog plus 功能显示 and 版块管理.

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { AppPlatform } from '../../../../../shared/api'
import type { BoardDirectory } from '../../../../../shared/forum'
import type { AppSettings } from '../../../../../shared/settings'
import {
  AppearanceSection,
  DensityMotionSection,
  PublicationSection,
  ReadingSection,
  SettingsStatusNotices,
  TabsSection,
  ThemeSection,
  WindowSection,
  ZoomSection,
  type Write
} from '../../../app/SettingsDialog'
import type { SettingsWriteStatus } from '../../../app/useSettingsWriter'
import { Icon } from '../../../components/Icon'
import { useCover } from '../../../lib/appCovered'
import { openLayer } from '../../../lib/layers'
import type { SettingsSectionId } from '../../../lib/settingsOpener'
import { usePopover } from '../../../lib/usePopover'
import { CacheSection } from '../../content/CacheSection'
import { CookieSection } from '../../identity/CookieSection'
import type { IdentitiesState } from '../../identity/useIdentities'
import { SubscriptionSection } from '../../subscriptions/SubscriptionSection'
import type { SubscriptionsState } from '../../subscriptions/useSubscriptions'
import { BoardManageSection, FeatureVisibilitySection } from './PrototypeNavSettings'
import { useBlocks } from '../../thread/useBlocks'
import './prototype.css'

type SectionId = SettingsSectionId

// Daily reading adjustments come first; making a theme comes after them.
const CATEGORIES: readonly { id: string; title: string; sections: readonly { id: SectionId; title: string }[] }[] = [
  {
    id: 'display',
    title: '显示',
    sections: [
      { id: 'appearance', title: '外观' },
      { id: 'reading', title: '阅读' },
      { id: 'density', title: '密度与动态' },
      { id: 'zoom', title: '界面缩放' },
      { id: 'theme', title: '自定义主题' }
    ]
  },
  {
    id: 'browse',
    title: '浏览',
    sections: [
      { id: 'features', title: '功能显示' },
      { id: 'boards', title: '版块管理' },
      { id: 'tabs', title: '标签' },
      { id: 'blocks', title: '屏蔽' }
    ]
  },
  {
    id: 'account',
    title: '账号',
    sections: [
      { id: 'cookies', title: '饼干' },
      { id: 'subscriptions', title: '订阅' },
      { id: 'publication', title: '发送' }
    ]
  },
  {
    id: 'system',
    title: '系统',
    sections: [
      { id: 'window', title: '窗口' },
      { id: 'cache', title: '存储与缓存' }
    ]
  }
]

const SECTIONS = CATEGORIES.flatMap((category) => category.sections)
const LAST_SECTION = SECTIONS.at(-1)?.id ?? 'appearance'

/** Within this many pixels of the end, the pane counts as scrolled to the bottom. */
const BOTTOM_SLACK = 4

export interface PrototypeSettingsProps {
  identities: IdentitiesState
  subscriptions: SubscriptionsState
  settings: AppSettings
  platform: AppPlatform | null
  status: SettingsWriteStatus
  write: Write
  adopt: (settings: AppSettings) => void
  directory: BoardDirectory | null
  /** Where the page lands: a section, or the top (`null`). A new `seq` moves an open page. */
  target: { section: SectionId | null; seq: number }
  /** Leaves the page. */
  onClose: () => void
}

export function PrototypeSettingsPage(props: PrototypeSettingsProps) {
  const { identities, subscriptions, target, onClose } = props
  const { refresh } = identities
  const { refreshOverview } = subscriptions
  const headingRef = useRef<HTMLHeadingElement>(null)
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })

  // Like the dialog: nothing behind the page counts as read while it is shown.
  useCover(true, 'app')

  useEffect(() => {
    void refresh()
    void refreshOverview()
  }, [refresh, refreshOverview])

  // A leave-able view: Esc goes back when nothing above it takes it.
  useEffect(() => {
    const layer = openLayer()
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !layer.isTop()) return
      event.preventDefault()
      closeRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      layer.release()
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  const section = (id: SectionId) => <SectionBody id={id} {...props} />
  return <SettingsView headingRef={headingRef} section={section} status={props.status} target={target} onClose={onClose} />
}

interface ShapeProps {
  headingRef: RefObject<HTMLHeadingElement | null>
  section: (id: SectionId) => ReactNode
  status: SettingsWriteStatus
  target: PrototypeSettingsProps['target']
}

// ---------- Content-area view with a section directory ----------

function SettingsView({ headingRef, section, status, target, onClose }: ShapeProps & { onClose: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const jumpRef = useRef<HTMLDivElement>(null)
  const [currentId, setCurrentId] = useState<SectionId>('appearance')
  /** Where a directory entry scrolled the pane: its choice stays current until the pane moves. */
  const chosenAt = useRef<number | null>(null)

  /** Height of the narrow window's sticky section control (0 while the directory column shows). */
  const stickyOffset = () => {
    const bar = jumpRef.current
    return bar !== null && bar.getClientRects().length > 0 ? bar.offsetHeight : 0
  }

  // A directory entry scrolls to its section and hands it focus: the next Tab continues inside it.
  // The section headings come from shared section components, so they become focusable here.
  const go = (id: SectionId) => {
    setCurrentId(id)
    const pane = scrollRef.current
    const item = document.getElementById(`proto-set-${id}`)
    if (pane !== null && item !== null) {
      pane.scrollTop += item.getBoundingClientRect().top - pane.getBoundingClientRect().top - stickyOffset()
      chosenAt.current = pane.scrollTop
    }
    const heading = item?.querySelector<HTMLElement>('.settings-section-title')
    if (heading == null) return
    heading.tabIndex = -1
    heading.focus({ preventScroll: true })
  }
  const goRef = useRef(go)
  useLayoutEffect(() => {
    goRef.current = go
  })

  // Each opening lands where its entry points: that section and its heading, else the page title
  // at the top. Focus returns to the opener when the page is left (App).
  useLayoutEffect(() => {
    if (target.section !== null) {
      goRef.current(target.section)
      return
    }
    const pane = scrollRef.current
    if (pane !== null) pane.scrollTop = 0
    chosenAt.current = null
    setCurrentId('appearance')
    headingRef.current?.focus({ preventScroll: true })
  }, [target.seq, target.section, headingRef])
  // A modal that was open when the page opened (the compose panel's 导入饼干) keeps the page inert
  // until it closes, then drops focus on its hidden opener: take focus once the page can hold it.
  useEffect(() => {
    let frame = 0
    let tries = 0
    const settle = () => {
      const page = scrollRef.current?.closest('.proto-settings')
      if (page == null || page.contains(document.activeElement) || tries++ > 30) return
      if (target.section !== null) goRef.current(target.section)
      else headingRef.current?.focus({ preventScroll: true })
      frame = requestAnimationFrame(settle)
    }
    frame = requestAnimationFrame(settle)
    return () => cancelAnimationFrame(frame)
  }, [target.seq, target.section, headingRef])

  // The directory follows the section at the top of the pane; scrolled to the end, the last one
  // (the last sections are too short to reach the top).
  const onScroll = () => {
    const pane = scrollRef.current
    if (pane === null) return
    if (chosenAt.current !== null && Math.abs(pane.scrollTop - chosenAt.current) < 1) return
    chosenAt.current = null
    if (pane.scrollTop > 0 && pane.scrollTop + pane.clientHeight >= pane.scrollHeight - BOTTOM_SLACK) {
      setCurrentId(LAST_SECTION)
      return
    }
    const top = pane.getBoundingClientRect().top + stickyOffset() + 24
    let found: SectionId = 'appearance'
    for (const item of SECTIONS) {
      const element = document.getElementById(`proto-set-${item.id}`)
      if (element !== null && element.getBoundingClientRect().top <= top) found = item.id
    }
    setCurrentId(found)
  }

  return (
    <div className="proto-settings proto-settings-b">
      <header className="proto-settings-b-head">
        <button type="button" className="btn btn-quiet" onClick={onClose}>
          <Icon name="arrowLeft" />
          返回
        </button>
        <h1 className="proto-settings-title" ref={headingRef} tabIndex={-1}>
          设置
        </h1>
      </header>
      <div className="proto-settings-b-body">
        <nav className="proto-settings-toc" aria-label="设置分区">
          {CATEGORIES.map((category) => (
            <div key={category.id} className="proto-toc-group">
              <p className="proto-toc-category">{category.title}</p>
              <ul>
                {category.sections.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={item.id === currentId ? 'proto-toc-item is-current' : 'proto-toc-item'}
                      aria-current={item.id === currentId ? 'true' : undefined}
                      onClick={() => go(item.id)}
                    >
                      {item.title}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="proto-settings-scroll" ref={scrollRef} onScroll={onScroll}>
          <SectionJump barRef={jumpRef} currentId={currentId} onGo={go} />
          <div className="proto-settings-column">
            <SettingsStatusNotices status={status} />
            {CATEGORIES.map((category) => (
              <section key={category.id} className="proto-category" aria-labelledby={`proto-cat-${category.id}`}>
                <h2 className="proto-category-title" id={`proto-cat-${category.id}`}>
                  {category.title}
                </h2>
                {category.sections.map((item) => (
                  <div key={item.id} className="proto-settings-item" id={`proto-set-${item.id}`}>
                    {section(item.id)}
                  </div>
                ))}
              </section>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Narrow window, where the directory column is hidden: a sticky control naming the current section,
 * opening a menu of every section. Esc closes the menu only (back to the control).
 */
function SectionJump({
  barRef,
  currentId,
  onGo
}: {
  barRef: RefObject<HTMLDivElement | null>
  currentId: SectionId
  onGo: (id: SectionId) => void
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menu = usePopover(triggerRef, menuRef)
  const menuId = useId()
  const current = SECTIONS.find((item) => item.id === currentId)?.title ?? ''

  // A menu: arrow keys, Home and End move between its items.
  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    let next: HTMLElement | undefined
    if (event.key === 'ArrowDown') next = items[(at + 1) % items.length]
    else if (event.key === 'ArrowUp') next = items[(at - 1 + items.length) % items.length]
    else if (event.key === 'Home') next = items[0]
    else if (event.key === 'End') next = items.at(-1)
    else return
    event.preventDefault()
    event.stopPropagation()
    next?.focus()
  }

  return (
    <div
      ref={barRef}
      className="proto-settings-jump"
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (next !== null && !event.currentTarget.contains(next)) menu.close(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="btn proto-settings-jump-trigger"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? menuId : undefined}
        aria-label={`设置分区：${current}`}
        onClick={menu.toggle}
      >
        {current}
        <Icon name="chevron" size={14} className="proto-settings-jump-chevron" />
      </button>
      {menu.open && (
        <div ref={menuRef} id={menuId} className="proto-pop proto-settings-jump-menu" role="menu" aria-label="设置分区" onKeyDown={onMenuKeyDown}>
          {CATEGORIES.map((category) => (
            <div key={category.id} role="group" aria-labelledby={`${menuId}-${category.id}`}>
              <p className="proto-toc-category" id={`${menuId}-${category.id}`}>
                {category.title}
              </p>
              {category.sections.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.id === currentId}
                  className={item.id === currentId ? 'proto-toc-item is-current' : 'proto-toc-item'}
                  tabIndex={-1}
                  data-autofocus={item.id === currentId ? '' : undefined}
                  onClick={() => {
                    menu.close(false)
                    onGo(item.id)
                  }}
                >
                  {item.title}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- Sections ----------

function SectionBody({ id, settings, write, adopt, platform, identities, subscriptions, directory }: PrototypeSettingsProps & { id: SectionId }) {
  switch (id) {
    case 'appearance':
      return <AppearanceSection settings={settings} write={write} />
    case 'theme':
      return <ThemeSection settings={settings} write={write} adopt={adopt} />
    case 'reading':
      return <ReadingSection settings={settings} write={write} />
    case 'density':
      return <DensityMotionSection settings={settings} write={write} />
    case 'zoom':
      return <ZoomSection platform={platform} />
    case 'features':
      return <FeatureVisibilitySection />
    case 'boards':
      return <BoardManageSection directory={directory} />
    case 'tabs':
      return <TabsSection settings={settings} write={write} />
    case 'blocks':
      return <BlocksSection />
    case 'cookies':
      return <CookieSection identities={identities} />
    case 'subscriptions':
      return <SubscriptionSection subscriptions={subscriptions} />
    case 'publication':
      return <PublicationSection />
    case 'window':
      return <WindowSection settings={settings} write={write} />
    case 'cache':
      return <CacheSection />
  }
}

function BlocksSection() {
  const { blocks, failure, reload, setBlocked } = useBlocks()
  const headingId = useId()
  return <section className="settings-section" aria-labelledby={headingId}>
    <h3 className="settings-section-title" id={headingId}>屏蔽</h3>
    {failure !== null && <p role="alert">{failure} <button type="button" className="btn btn-small" onClick={() => void reload()}>重试</button></p>}
    {blocks.length === 0 && failure === null && <p className="settings-empty">暂无屏蔽</p>}
    <ul className="proto-manage-list">{blocks.map((block) => <li className="proto-manage-row" key={`${block.kind}:${block.value}`}>
      <span>{block.kind === 'post' ? `No.${block.value}` : `饼干 ${block.value}`}</span>
      <span className="proto-manage-actions"><button type="button" className="btn btn-small" aria-label={`取消屏蔽${block.kind === 'post' ? ` No.${block.value}` : `饼干 ${block.value}`}`} onClick={() => void setBlocked(block.kind, block.value, false)}>取消屏蔽</button></span>
    </li>)}</ul>
  </section>
}
