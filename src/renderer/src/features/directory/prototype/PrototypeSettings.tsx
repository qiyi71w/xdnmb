// PROTOTYPE (throwaway): the settings page — a view filling the content area with a section directory
// on the left — reusing the sections of the settings dialog plus 功能显示 and 版块管理 (in-memory only).

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
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
import { Loading } from '../../../components/Notices'
import { useCover } from '../../../lib/appCovered'
import { openLayer } from '../../../lib/layers'
import { CacheSection } from '../../content/CacheSection'
import { CookieSection } from '../../identity/CookieSection'
import type { IdentitiesState } from '../../identity/useIdentities'
import { SubscriptionSection } from '../../subscriptions/SubscriptionSection'
import type { SubscriptionsState } from '../../subscriptions/useSubscriptions'
import { useBoardView } from './PrototypeNavParts'
import { FEATURES, navActions, useNavPrefs, type Board, type BoardGroup, type NavPrefs } from './prototypeStore'
import './prototype.css'

type SectionId =
  | 'appearance'
  | 'theme'
  | 'reading'
  | 'density'
  | 'zoom'
  | 'features'
  | 'boards'
  | 'tabs'
  | 'cookies'
  | 'subscriptions'
  | 'publication'
  | 'window'
  | 'cache'

const CATEGORIES: readonly { id: string; title: string; sections: readonly { id: SectionId; title: string }[] }[] = [
  {
    id: 'display',
    title: '显示',
    sections: [
      { id: 'appearance', title: '外观' },
      { id: 'theme', title: '自定义主题' },
      { id: 'reading', title: '阅读' },
      { id: 'density', title: '密度与动态' },
      { id: 'zoom', title: '界面缩放' }
    ]
  },
  {
    id: 'browse',
    title: '浏览',
    sections: [
      { id: 'features', title: '功能显示' },
      { id: 'boards', title: '版块管理' },
      { id: 'tabs', title: '标签' }
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

export interface PrototypeSettingsProps {
  identities: IdentitiesState
  subscriptions: SubscriptionsState
  settings: AppSettings
  platform: AppPlatform | null
  status: SettingsWriteStatus
  write: Write
  adopt: (settings: AppSettings) => void
  directory: BoardDirectory | null
  /** Leaves the page. */
  onClose: () => void
}

export function PrototypeSettingsPage(props: PrototypeSettingsProps) {
  const { identities, subscriptions, onClose } = props
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

  // Focus moves to the page title. Leaving the page, App returns focus (it knows what replaces the
  // page and which entry is still shown).
  useLayoutEffect(() => {
    headingRef.current?.focus({ preventScroll: true })
  }, [])

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
  return <SettingsView headingRef={headingRef} section={section} status={props.status} onClose={onClose} />
}

interface ShapeProps {
  headingRef: RefObject<HTMLHeadingElement | null>
  section: (id: SectionId) => ReactNode
  status: SettingsWriteStatus
}

// ---------- Content-area view with a section directory ----------

function SettingsView({ headingRef, section, status, onClose }: ShapeProps & { onClose: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [currentId, setCurrentId] = useState<SectionId>('appearance')

  // A directory entry scrolls to its section and hands it focus: the next Tab continues inside it.
  // The section headings come from shared section components, so they become focusable here.
  const go = (id: SectionId) => {
    setCurrentId(id)
    const item = document.getElementById(`proto-set-${id}`)
    item?.scrollIntoView({ block: 'start', behavior: 'instant' })
    const heading = item?.querySelector<HTMLElement>('.settings-section-title')
    if (heading == null) return
    heading.tabIndex = -1
    heading.focus({ preventScroll: true })
  }

  // The directory follows the section at the top of the pane.
  const onScroll = () => {
    const pane = scrollRef.current
    if (pane === null) return
    const top = pane.getBoundingClientRect().top + 24
    let found: SectionId = 'appearance'
    for (const category of CATEGORIES) {
      for (const item of category.sections) {
        const element = document.getElementById(`proto-set-${item.id}`)
        if (element !== null && element.getBoundingClientRect().top <= top) found = item.id
      }
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

function FeatureVisibilitySection() {
  const headingId = useId()
  const prefs = useNavPrefs()
  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 className="settings-section-title" id={headingId}>
        功能显示
      </h3>
      <ul className="proto-feature-toggles">
        {FEATURES.map((feature) => (
          <li key={feature.id}>
            <label className="proto-check">
              <input
                type="checkbox"
                checked={!prefs.hiddenFeatures.includes(feature.id)}
                onChange={(event) => navActions.setFeatureShown(feature.id, event.target.checked)}
              />
              <Icon name={feature.icon} className="proto-check-icon" />
              <span>{feature.label}</span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  )
}

function BoardManageSection({ directory }: { directory: BoardDirectory | null }) {
  const headingId = useId()
  const { prefs, all } = useBoardView(directory)
  const byKey = new Map(all.flatMap((group) => group.boards.map((item) => [item.key, item] as const)))
  const favorites = prefs.favorites.flatMap((key) => {
    const found = byKey.get(key)
    return found === undefined ? [] : [found]
  })

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 className="settings-section-title" id={headingId}>
        版块管理
      </h3>
      {directory === null && <Loading>正在读取版面目录…</Loading>}
      {directory !== null && (
        <>
          <div className="settings-group">
            <h4 className="settings-group-title">收藏</h4>
            {favorites.length === 0 ? (
              <p className="settings-empty">还没有收藏的版块。</p>
            ) : (
              <ul className="proto-manage-list">
                {favorites.map((item, index) => (
                  <ManageRow
                    key={item.key}
                    item={item}
                    prefs={prefs}
                    first={index === 0}
                    last={index === favorites.length - 1}
                    onMove={(delta) => navActions.moveFavorite(item.key, delta)}
                  />
                ))}
              </ul>
            )}
          </div>
          {all.map((group) => (
            <ManageGroup key={group.id} group={group} prefs={prefs} />
          ))}
        </>
      )}
    </section>
  )
}

function ManageGroup({ group, prefs }: { group: BoardGroup; prefs: NavPrefs }) {
  const keys = group.boards.map((item) => item.key)
  const hiddenCount = group.boards.filter((item) => prefs.hiddenBoards.includes(item.key)).length
  return (
    <details className="settings-group proto-manage-group">
      <summary className="proto-manage-summary">
        <Icon name="chevron" size={12} className="proto-chevron" />
        <span className="settings-group-title">{group.title}</span>
        <span className="proto-manage-count">
          {group.boards.length}
          {hiddenCount > 0 && ` · 隐藏 ${hiddenCount}`}
        </span>
      </summary>
      <ul className="proto-manage-list">
        {group.boards.map((item, index) => (
          <ManageRow
            key={item.key}
            item={item}
            prefs={prefs}
            first={index === 0}
            last={index === group.boards.length - 1}
            onMove={(delta) => navActions.moveBoard(group.id, keys, item.key, delta)}
          />
        ))}
      </ul>
    </details>
  )
}

function ManageRow({
  item,
  prefs,
  first,
  last,
  onMove
}: {
  item: Board
  prefs: NavPrefs
  first: boolean
  last: boolean
  onMove: (delta: -1 | 1) => void
}) {
  const favorite = prefs.favorites.includes(item.key)
  const hidden = prefs.hiddenBoards.includes(item.key)
  return (
    <li className={hidden ? 'proto-manage-row is-hidden' : 'proto-manage-row'}>
      <Icon name={item.icon} className="proto-manage-icon" />
      <span className="proto-manage-label">{item.label}</span>
      <span className="proto-manage-actions">
        <button
          type="button"
          className={favorite ? 'icon-btn proto-manage-star is-on' : 'icon-btn proto-manage-star'}
          aria-pressed={favorite}
          aria-label={`收藏 ${item.label}`}
          title={favorite ? '取消收藏' : '收藏'}
          onClick={() => navActions.setFavorite(item.key, !favorite)}
        >
          <Icon name="star" />
        </button>
        <button
          type="button"
          className="btn btn-small"
          aria-pressed={hidden}
          aria-label={`隐藏 ${item.label}`}
          onClick={() => navActions.setBoardHidden(item.key, !hidden)}
        >
          {hidden ? '已隐藏' : '隐藏'}
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={`上移 ${item.label}`}
          title="上移"
          aria-disabled={first ? true : undefined}
          onClick={() => !first && onMove(-1)}
        >
          <Icon name="arrowUp" />
        </button>
        <button
          type="button"
          className="icon-btn proto-flip"
          aria-label={`下移 ${item.label}`}
          title="下移"
          aria-disabled={last ? true : undefined}
          onClick={() => !last && onMove(1)}
        >
          <Icon name="arrowUp" />
        </button>
      </span>
    </li>
  )
}
