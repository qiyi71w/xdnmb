// The 设置 tab's content: a section directory on the left (a sticky section menu in narrow
// windows) beside the scrolling sections. Every entry that opens settings lands on its section.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { AppPlatform } from '../../../shared/api'
import type { BoardDirectory } from '../../../shared/forum'
import type { AppSettings } from '../../../shared/settings'
import {
  AppearanceSection,
  DensityMotionSection,
  PublicationSection,
  ReadingSection,
  ReminderSection,
  SettingsStatusNotices,
  TabsSection,
  ThemeSection,
  WindowSection,
  ZoomSection,
  type Write
} from './settingsSections'
import type { SettingsWriteStatus } from './useSettingsWriter'
import { Icon } from '../components/Icon'
import { KaomojiDecor } from '../components/KaomojiDecor'
import { openLayer } from '../lib/layers'
import type { SettingsSectionId } from '../lib/settingsOpener'
import { usePopover } from '../lib/usePopover'
import { CacheSection } from '../features/content/CacheSection'
import { CookieSection } from '../features/identity/CookieSection'
import { CookieColorsSection } from '../features/cookieColors/CookieColorsSection'
import type { IdentitiesState } from '../features/identity/useIdentities'
import { SubscriptionSection } from '../features/subscriptions/SubscriptionSection'
import type { SubscriptionsState } from '../features/subscriptions/useSubscriptions'
import { BoardManageSection, FeatureVisibilitySection } from '../features/directory/NavigationSettings'
import { useBlocks } from '../features/thread/useBlocks'
import { AboutSection } from '../features/updates/AboutSection'
import '../features/directory/shell.css'

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
      { id: 'reminders', title: '提醒' },
      { id: 'blocks', title: '屏蔽' },
      { id: 'cookieColors', title: '饼干颜色' }
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
      { id: 'cache', title: '存储与缓存' },
      { id: 'about', title: '关于' }
    ]
  }
]

const SECTIONS = CATEGORIES.flatMap((category) => category.sections)
const LAST_SECTION = SECTIONS.at(-1)?.id ?? 'appearance'

/** Within this many pixels of the end, the pane counts as scrolled to the bottom. */
const BOTTOM_SLACK = 4

export interface SettingsPageProps {
  identities: IdentitiesState
  subscriptions: SubscriptionsState
  settings: AppSettings
  platform: AppPlatform | null
  status: SettingsWriteStatus
  write: Write
  adopt: (settings: AppSettings) => void
  directory: BoardDirectory | null
  /**
   * Where the page lands: a section, or the top (`null`). A new `seq` moves the page; with `keep`
   * it stays where it was and only takes focus (设置 entered again without a section).
   */
  target: SettingsTarget
  /** The 设置 tab's ID, naming its tab panel. */
  tabId: number
  /** 设置 is the active tab; it stays mounted, hidden, while another tab is. */
  active: boolean
  /** Closes the 设置 tab. */
  onClose: () => void
}

export interface SettingsTarget {
  section: SectionId | null
  seq: number
  keep: boolean
}

export function SettingsPage(props: SettingsPageProps) {
  const { identities, subscriptions, target, tabId, active, onClose } = props
  const { refresh } = identities
  const { refreshOverview } = subscriptions
  const headingRef = useRef<HTMLHeadingElement>(null)
  const closeRef = useRef(onClose)
  useLayoutEffect(() => {
    closeRef.current = onClose
  })

  // Each time 设置 becomes the active tab its identities and subscription overview are read again.
  useEffect(() => {
    if (!active) return
    void refresh()
    void refreshOverview()
  }, [active, refresh, refreshOverview])

  // While shown, Esc closes the tab when nothing above it takes it.
  useEffect(() => {
    if (!active) return
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
  }, [active])

  const section = (id: SectionId) => <SectionBody id={id} {...props} />
  return (
    <SettingsView
      headingRef={headingRef}
      section={section}
      status={props.status}
      target={target}
      tabId={tabId}
      active={active}
    />
  )
}

interface ShapeProps {
  headingRef: RefObject<HTMLHeadingElement | null>
  section: (id: SectionId) => ReactNode
  status: SettingsWriteStatus
  target: SettingsTarget
  tabId: number
  active: boolean
}

// ---------- Content-area view with a section directory ----------

function SettingsView({ headingRef, section, status, target, tabId, active }: ShapeProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const jumpRef = useRef<HTMLDivElement>(null)
  const [currentId, setCurrentId] = useState<SectionId>('appearance')
  /** Where a directory entry scrolled the pane: its choice stays current until the pane moves. */
  const chosenAt = useRef<number | null>(null)
  /** The section that scroll landed on; kept at the top while content above it still loads. */
  const chosenId = useRef<SectionId | null>(null)
  /** Where the pane was last scrolled while shown, put back when the tab is shown again. */
  const shownScroll = useRef(0)

  /** Height of the narrow window's sticky section control (0 while the directory column shows). */
  const stickyOffset = () => {
    const bar = jumpRef.current
    return bar !== null && bar.getClientRects().length > 0 ? bar.offsetHeight : 0
  }

  /** Scrolls `id` to the top of the pane (as far as the pane scrolls) and remembers the landing. */
  const align = (id: SectionId) => {
    const pane = scrollRef.current
    const item = document.getElementById(`shell-set-${id}`)
    if (pane === null || item === null) return
    pane.scrollTop += item.getBoundingClientRect().top - pane.getBoundingClientRect().top - stickyOffset()
    chosenAt.current = pane.scrollTop
    chosenId.current = id
  }

  // A directory entry scrolls to its section and hands it focus: the next Tab continues inside it.
  // The section headings come from shared section components, so they become focusable here.
  const go = (id: SectionId) => {
    setCurrentId(id)
    align(id)
    const heading = document.getElementById(`shell-set-${id}`)?.querySelector<HTMLElement>('.settings-section-title')
    if (heading == null) return
    heading.tabIndex = -1
    heading.focus({ preventScroll: true })
  }
  const goRef = useRef(go)
  const alignRef = useRef(align)
  useLayoutEffect(() => {
    goRef.current = go
    alignRef.current = align
  })

  // Sections above the landing fill in after opening (storage figures, lists) and push it down,
  // with or without a scroll event: until the user acts on the page, the chosen section stays
  // where the entry put it. Pointer, key and wheel input in the pane end the hold, and so does
  // focus reaching anything there but the landing's heading (Tab from outside, a screen reader).
  useEffect(() => {
    const pane = scrollRef.current
    const column = columnRef.current
    if (pane === null || column === null) return
    const observer = new ResizeObserver(() => {
      if (chosenAt.current !== null && chosenId.current !== null) alignRef.current(chosenId.current)
    })
    observer.observe(column)
    const release = () => { chosenId.current = null }
    const focusIn = (event: FocusEvent) => {
      const id = chosenId.current
      if (id === null) return
      const heading = document.getElementById(`shell-set-${id}`)?.querySelector('.settings-section-title')
      if (event.target !== heading) release()
    }
    const events = ['pointerdown', 'keydown', 'wheel'] as const
    for (const name of events) pane.addEventListener(name, release, { passive: true })
    pane.addEventListener('focusin', focusIn)
    return () => {
      observer.disconnect()
      for (const name of events) pane.removeEventListener(name, release)
      pane.removeEventListener('focusin', focusIn)
    }
  }, [])

  // Shown again after another tab: the pane where it was left (a hidden pane may lose it).
  useLayoutEffect(() => {
    const pane = scrollRef.current
    if (active && pane !== null && pane.scrollTop !== shownScroll.current) pane.scrollTop = shownScroll.current
  }, [active])

  // Each opening lands where its entry points: that section and its heading, else the top of the
  // page with focus on its (hidden) title; entered again without a section, it only takes focus.
  useLayoutEffect(() => {
    if (target.keep) {
      headingRef.current?.focus({ preventScroll: true })
      return
    }
    if (target.section !== null) {
      goRef.current(target.section)
      return
    }
    const pane = scrollRef.current
    if (pane !== null) pane.scrollTop = 0
    chosenAt.current = null
    chosenId.current = null
    setCurrentId('appearance')
    headingRef.current?.focus({ preventScroll: true })
  }, [target.seq, target.section, target.keep, headingRef])
  // A modal that was open when the page opened (the compose panel's 导入饼干) keeps the page inert
  // until it closes, then drops focus on its hidden opener: take focus once the page can hold it.
  useEffect(() => {
    let frame = 0
    let tries = 0
    const settle = () => {
      const page = scrollRef.current?.closest('.shell-settings')
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
    if (pane.clientHeight > 0) shownScroll.current = pane.scrollTop
    // Not the user (they end the hold first): content above moved the landing; put it back.
    if (chosenId.current !== null) {
      align(chosenId.current)
      return
    }
    if (chosenAt.current !== null && Math.abs(pane.scrollTop - chosenAt.current) < 1) return
    chosenAt.current = null
    if (pane.scrollTop > 0 && pane.scrollTop + pane.clientHeight >= pane.scrollHeight - BOTTOM_SLACK) {
      setCurrentId(LAST_SECTION)
      return
    }
    const top = pane.getBoundingClientRect().top + stickyOffset() + 24
    let found: SectionId = 'appearance'
    for (const item of SECTIONS) {
      const element = document.getElementById(`shell-set-${item.id}`)
      if (element !== null && element.getBoundingClientRect().top <= top) found = item.id
    }
    setCurrentId(found)
  }

  return (
    // The tab's own panel inside the shared tab content paper, under the shared top bar.
    <div className="tab-panel shell-settings" role="tabpanel" id={`tabpanel-${tabId}`} aria-labelledby={`tab-${tabId}`} hidden={!active}>
      <h1 className="visually-hidden" ref={headingRef} tabIndex={-1}>
        设置
      </h1>
      <div className="shell-settings-body">
        <nav className="shell-settings-toc" aria-label="设置分区">
          {CATEGORIES.map((category) => (
            <div key={category.id} className="shell-toc-group">
              <p className="shell-toc-category">{category.title}</p>
              <ul>
                {category.sections.map((item) => (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={item.id === currentId ? 'shell-toc-item is-current' : 'shell-toc-item'}
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
        <div className="shell-settings-scroll" ref={scrollRef} onScroll={onScroll}>
          <SectionJump barRef={jumpRef} currentId={currentId} onGo={go} active={active} />
          <div className="shell-settings-column" ref={columnRef}>
            <SettingsStatusNotices status={status} />
            {CATEGORIES.map((category) => (
              <section key={category.id} className="shell-category" aria-labelledby={`shell-cat-${category.id}`}>
                <h2 className="shell-category-title" id={`shell-cat-${category.id}`}>
                  {category.title}
                </h2>
                {category.sections.map((item) => (
                  <div key={item.id} className="shell-settings-item" id={`shell-set-${item.id}`}>
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

/** Space kept between the section menu and the bottom of the scrolling pane. */
const MENU_BOTTOM_GAP = 8

/**
 * Narrow window, where the directory column is hidden: a sticky control naming the current section,
 * opening a menu of every section. Esc closes the menu only (back to the control).
 */
function SectionJump({
  barRef,
  currentId,
  onGo,
  active
}: {
  barRef: RefObject<HTMLDivElement | null>
  currentId: SectionId
  onGo: (id: SectionId) => void
  /** 设置 is the active tab. */
  active: boolean
}) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const menu = usePopover(triggerRef, menuRef)
  const { close } = menu
  // Another tab shown: the menu closes with it, giving up its Esc layer; focus stays where it went.
  useEffect(() => {
    if (!active) close(false)
  }, [active, close])
  const menuId = useId()
  const current = SECTIONS.find((item) => item.id === currentId)?.title ?? ''

  // The menu hangs from the sticky control inside the scrolling pane, which clips it: it keeps to
  // the pane's visible height below the control (a wrapped top bar or a large zoom leaves little)
  // and scrolls within that. Sized as it attaches, before the popover focuses the current item.
  const attachMenu = useCallback((node: HTMLDivElement | null) => {
    menuRef.current = node
    const pane = node?.closest<HTMLElement>('.shell-settings-scroll')
    if (node == null || pane == null) return
    const fit = () => {
      const room = pane.getBoundingClientRect().bottom - node.getBoundingClientRect().top - MENU_BOTTOM_GAP
      node.style.setProperty('--jump-menu-room', `${Math.max(Math.floor(room), 0)}px`)
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(pane)
    return () => {
      observer.disconnect()
      menuRef.current = null
    }
  }, [])

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
      className="shell-settings-jump"
      onBlur={(event) => {
        const next = event.relatedTarget as Node | null
        if (next !== null && !event.currentTarget.contains(next)) menu.close(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className="btn shell-settings-jump-trigger"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? menuId : undefined}
        aria-label={`设置分区：${current}`}
        onClick={menu.toggle}
      >
        {current}
        <Icon name="chevron" size={14} className="shell-settings-jump-chevron" />
      </button>
      {menu.open && (
        <div ref={attachMenu} id={menuId} className="shell-pop shell-settings-jump-menu" role="menu" aria-label="设置分区" onKeyDown={onMenuKeyDown}>
          {CATEGORIES.map((category) => (
            <div key={category.id} role="group" aria-labelledby={`${menuId}-${category.id}`}>
              <p className="shell-toc-category" id={`${menuId}-${category.id}`}>
                {category.title}
              </p>
              {category.sections.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.id === currentId}
                  className={item.id === currentId ? 'shell-toc-item is-current' : 'shell-toc-item'}
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

function SectionBody({ id, settings, write, adopt, platform, identities, subscriptions, directory, active }: SettingsPageProps & { id: SectionId }) {
  switch (id) {
    case 'appearance':
      return <AppearanceSection settings={settings} write={write} />
    case 'theme':
      return <ThemeSection settings={settings} write={write} adopt={adopt} shown={active} />
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
    case 'reminders':
      return <ReminderSection settings={settings} write={write} />
    case 'blocks':
      return <BlocksSection />
    case 'cookieColors':
      return <CookieColorsSection active={active} />
    case 'cookies':
      return <CookieSection identities={identities} active={active} />
    case 'subscriptions':
      return <SubscriptionSection subscriptions={subscriptions} active={active} settings={settings} write={write} />
    case 'publication':
      return <PublicationSection />
    case 'window':
      return <WindowSection settings={settings} write={write} />
    case 'cache':
      return <CacheSection active={active} />
    case 'about':
      return <AboutSection settings={settings} write={write} active={active} />
  }
}

function BlocksSection() {
  const { blocks, failure, retry, setBlocked } = useBlocks()
  const headingId = useId()
  return <section className="settings-section" aria-labelledby={headingId}>
    <h3 className="settings-section-title" id={headingId}>屏蔽</h3>
    {failure !== null && <p role="alert">{failure} <button type="button" className="btn btn-small btn-page" onClick={() => void retry()}>重试</button></p>}
    {blocks.length === 0 && failure === null && <p className="settings-empty">没有屏蔽<KaomojiDecor state="blocksEmpty" /></p>}
    <ul className="shell-manage-list">{blocks.map((block) => <li className="shell-manage-row" key={`${block.kind}:${block.value}`}>
      <span>{block.kind === 'post' ? `No.${block.value}` : `饼干 ${block.value}`}</span>
      <span className="shell-manage-actions"><button type="button" className="btn btn-small btn-page" aria-label={`取消屏蔽${block.kind === 'post' ? ` No.${block.value}` : `饼干 ${block.value}`}`} onClick={() => void setBlocked(block.kind, block.value, false)}>取消屏蔽</button></span>
    </li>)}</ul>
  </section>
}
