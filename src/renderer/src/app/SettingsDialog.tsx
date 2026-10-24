import { useEffect, useId, useState, type ReactNode } from 'react'
import type { AppPlatform } from '../../../shared/api'
import { CLOSE_ACTIONS, type CloseAction } from '../../../shared/lifecycle'
import {
  resolveAppearance,
  type AppSettings,
  type ColorScheme,
  type Density,
  type MotionPreference,
  type ZoomAction,
  type ZoomState
} from '../../../shared/settings'
import {
  parseCustomTheme,
  THEME_COLOR_KEYS,
  THEME_LIMITS,
  themeFromBuiltin,
  type AppearanceIssue,
  type CustomTheme,
  type ReadingFont,
  type SchemeBase,
  type ThemeColors
} from '../../../shared/theme'
import { Icon } from '../components/Icon'
import { Modal, ModalHeader } from '../components/Modal'
import { CacheSection } from '../features/content/CacheSection'
import { CookieSection } from '../features/identity/CookieSection'
import type { IdentitiesState } from '../features/identity/useIdentities'
import { SubscriptionSection } from '../features/subscriptions/SubscriptionSection'
import type { SubscriptionsState } from '../features/subscriptions/useSubscriptions'
import { systemPrefersDark, systemReducesMotion } from '../lib/useAppearance'
import { describeIssues, invalidFields } from './appearanceIssues'
import type { SettingsWriteStatus } from './useSettingsWriter'
import './settings.css'

type Write = (patch: Partial<AppSettings>, delay?: number) => void

/** Slider and color edits are coalesced: one update after the input pauses this long. */
const INPUT_DELAY = 200

/**
 * The one settings dialog (button, navigation or Ctrl/Cmd+,). Mount it to open and unmount it to
 * close: everything typed inside (including pasted secrets) is discarded with it, and focus returns
 * to whatever opened it (`fallbackFocus` when that control is gone). Global preferences go through
 * `write` (shown at once, saved by `useSettingsWriter`); the other sections keep their own APIs.
 */
export function SettingsDialog({
  identities,
  subscriptions,
  settings,
  platform,
  status,
  write,
  adopt,
  onClose,
  fallbackFocus
}: {
  identities: IdentitiesState
  subscriptions: SubscriptionsState
  settings: AppSettings
  platform: AppPlatform | null
  status: SettingsWriteStatus
  write: Write
  /** Settings that main changed by itself (theme import). */
  adopt: (settings: AppSettings) => void
  onClose: () => void
  fallbackFocus: () => HTMLElement | null
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
    <Modal className="settings-dialog" labelledBy={titleId} onClose={onClose} fallbackFocus={fallbackFocus}>
      <ModalHeader title="设置" titleId={titleId} closeLabel="关闭设置" onClose={onClose} />
      <div className="modal-body settings-body">
        {status.notSaved && (
          <p className="notice-inline is-warning" role="status">
            <Icon name="alert" size={14} />
            未能保存：本地存储当前不可写入，设置显示的是实际生效的值
          </p>
        )}
        {status.refused.length > 0 && <IssueList title="更改被拒绝，之前的设置保持生效：" issues={status.refused} />}

        <AppearanceSection settings={settings} write={write} />
        <ThemeSection settings={settings} write={write} adopt={adopt} />
        <ReadingSection settings={settings} write={write} />
        <DensityMotionSection settings={settings} write={write} />
        <ZoomSection platform={platform} />
        <TabsSection settings={settings} write={write} />
        <WindowSection settings={settings} write={write} />
        <PublicationSection />
        <CookieSection identities={identities} />
        <SubscriptionSection subscriptions={subscriptions} />
        <CacheSection />
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------
// Building blocks

interface ChoiceOption<T extends string> {
  value: T
  label: string
  /** Shown but not selectable; the element with this id explains why. */
  unavailableReason?: string
}

/** Exclusive choice as pressed buttons (`.segmented`); the pressed one is bold, not only tinted. */
function Choice<T extends string>({
  labelledBy,
  options,
  value,
  onChange
}: {
  labelledBy: string
  options: readonly ChoiceOption<T>[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="segmented setting-choice" role="group" aria-labelledby={labelledBy}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="segmented-item"
          aria-pressed={option.value === value}
          aria-disabled={option.unavailableReason !== undefined ? true : undefined}
          aria-describedby={option.unavailableReason}
          onClick={() => {
            if (option.unavailableReason === undefined && option.value !== value) onChange(option.value)
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 className="settings-section-title" id={id}>
        {title}
      </h3>
      {children}
    </section>
  )
}

function SettingRow({
  labelId,
  label,
  help,
  helpId,
  children
}: {
  labelId: string
  label: string
  help?: ReactNode
  helpId?: string
  children: ReactNode
}) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        <span className="setting-label" id={labelId}>
          {label}
        </span>
        {help !== undefined && (
          <span className="setting-help" id={helpId}>
            {help}
          </span>
        )}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  )
}

function IssueList({ id, title, issues }: { id?: string; title: string; issues: readonly AppearanceIssue[] }) {
  return (
    <div className="issue-list" id={id} role="status">
      <p className="issue-list-title">
        <Icon name="alert" size={14} />
        {title}
      </p>
      <ul className="issue-items">
        {describeIssues(issues).map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </div>
  )
}

/** Range input with its value written beside it (and spoken through aria-valuetext). */
function Slider({
  labelledBy,
  describedBy,
  min,
  max,
  step,
  value,
  valueText,
  onChange
}: {
  labelledBy: string
  describedBy?: string
  min: number
  max: number
  step: number
  value: number
  valueText: string
  onChange: (value: number) => void
}) {
  return (
    <span className="setting-slider">
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-valuetext={valueText}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="setting-value" aria-hidden="true">
        {valueText}
      </span>
    </span>
  )
}

// ---------------------------------------------------------------------------------------------
// Sections

function AppearanceSection({ settings, write }: { settings: AppSettings; write: Write }) {
  const noCustom = settings.customTheme === null
  const options: ChoiceOption<ColorScheme>[] = [
    { value: 'system', label: '跟随系统' },
    { value: 'light', label: '浅色' },
    { value: 'dark', label: '深色' },
    { value: 'custom', label: '自定义', unavailableReason: noCustom ? 'setting-scheme-help' : undefined }
  ]
  return (
    <Section id="settings-appearance" title="外观">
      <SettingRow
        labelId="setting-scheme"
        label="配色"
        helpId="setting-scheme-help"
        help={noCustom ? '“自定义”暂不可选：需要先在下方创建或导入一个自定义主题。' : '“自定义”使用下方的自定义主题。'}
      >
        <Choice
          labelledBy="setting-scheme"
          options={options}
          value={settings.colorScheme}
          onChange={(colorScheme) => write({ colorScheme })}
        />
      </SettingRow>
    </Section>
  )
}

const COLOR_FIELDS: Record<keyof ThemeColors, { label: string; help: string }> = {
  background: { label: '窗口底色', help: '导航与面板后面的底色' },
  surface: { label: '正文底色', help: '正文、列表与对话框的实底' },
  text: { label: '正文文字', help: '正文与主要文字' },
  secondaryText: { label: '次要文字', help: '时间、编号与说明' },
  accent: { label: '强调色', help: '链接、选中与焦点' }
}

const HEX = /^#[0-9a-f]{6}$/i

function sameTheme(a: CustomTheme | null, b: CustomTheme | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.name === b.name &&
    a.base === b.base &&
    a.opacity === b.opacity &&
    a.radius === b.radius &&
    THEME_COLOR_KEYS.every((key) => a.colors[key] === b.colors[key])
  )
}

/**
 * Custom theme editor. The draft keeps exactly what the user typed; every change is validated with
 * the shared checks. Valid drafts are applied (and the custom scheme selected); invalid ones are not,
 * their issues are listed, and the last usable theme stays in effect.
 */
function ThemeSection({ settings, write, adopt }: { settings: AppSettings; write: Write; adopt: (settings: AppSettings) => void }) {
  const [draft, setDraft] = useState<CustomTheme | null>(settings.customTheme)
  const [issues, setIssues] = useState<AppearanceIssue[]>([])
  /** Last theme this editor applied; any other custom theme in settings came from elsewhere (import). */
  const [written, setWritten] = useState<CustomTheme | null>(settings.customTheme)
  const [basis, setBasis] = useState<CustomTheme | null>(settings.customTheme)
  if (settings.customTheme !== basis) {
    setBasis(settings.customTheme)
    if (!sameTheme(settings.customTheme, written)) {
      setDraft(settings.customTheme)
      setWritten(settings.customTheme)
      setIssues([])
    }
  }

  const apply = (theme: CustomTheme, delay: number) => {
    setWritten(theme)
    write({ customTheme: theme, colorScheme: 'custom' }, delay)
  }

  const edit = (next: CustomTheme, delay = INPUT_DELAY) => {
    setDraft(next)
    const parsed = parseCustomTheme(next)
    if (parsed.ok) {
      setIssues([])
      apply(parsed.value, delay)
    } else setIssues(parsed.issues)
  }

  const create = () => {
    const theme = themeFromBuiltin(resolveAppearance(settings, systemPrefersDark()).scheme)
    setDraft(theme)
    setIssues([])
    apply(theme, 0)
  }

  const invalid = invalidFields(issues)
  const describedBy = issues.length > 0 ? 'theme-issues' : undefined
  const usable = settings.customTheme

  return (
    <Section id="settings-theme" title="自定义主题">
      {draft === null ? (
        <div className="theme-empty">
          <p className="setting-help">还没有自定义主题。可以复制当前生效的配色，再调整颜色、透明度和圆角。</p>
          <button type="button" className="btn" onClick={create}>
            <Icon name="plus" />
            从当前配色创建自定义主题
          </button>
        </div>
      ) : (
        <div className="theme-editor">
          <p className="setting-help">修改有效时立即应用，配色随之切换为“自定义”；无效的修改不会应用，也不会被自动更正。</p>
          <div className="theme-field">
            <label className="setting-label" htmlFor="theme-name">
              名称
            </label>
            <input
              id="theme-name"
              className="text-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={draft.name}
              aria-invalid={invalid.has('name') ? true : undefined}
              aria-describedby={describedBy}
              onChange={(event) => edit({ ...draft, name: event.target.value })}
            />
          </div>
          <SettingRow labelId="theme-base" label="基调" help="系统控件的明暗与状态颜色的起点">
            <Choice<SchemeBase>
              labelledBy="theme-base"
              options={[
                { value: 'light', label: '浅色基调' },
                { value: 'dark', label: '深色基调' }
              ]}
              value={draft.base}
              onChange={(base) => edit({ ...draft, base }, 0)}
            />
          </SettingRow>

          <div className="theme-colors" role="group" aria-label="颜色">
            {THEME_COLOR_KEYS.map((key) => {
              const field = COLOR_FIELDS[key]
              const typed = draft.colors[key]
              const picker = HEX.test(typed) ? typed.toLowerCase() : (usable?.colors[key] ?? '#000000')
              const fieldInvalid = invalid.has(`colors.${key}`)
              const setColor = (value: string) => edit({ ...draft, colors: { ...draft.colors, [key]: value } })
              return (
                <div key={key} className="theme-color">
                  <label className="theme-color-label" htmlFor={`theme-color-${key}`}>
                    <span className="setting-label">{field.label}</span>
                    <span className="setting-help">{field.help}</span>
                  </label>
                  <span className="theme-color-inputs">
                    <input
                      type="color"
                      className="color-swatch"
                      aria-label={`${field.label}：取色器`}
                      value={picker}
                      onChange={(event) => setColor(event.target.value)}
                    />
                    <input
                      id={`theme-color-${key}`}
                      className="text-input color-text"
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      value={typed}
                      aria-invalid={fieldInvalid ? true : undefined}
                      aria-describedby={describedBy}
                      onChange={(event) => setColor(event.target.value)}
                    />
                  </span>
                  {fieldInvalid && (
                    <span className="field-error">
                      <Icon name="alert" size={13} />
                      格式应为 #rrggbb
                    </span>
                  )}
                </div>
              )
            })}
          </div>

          <SettingRow
            labelId="theme-opacity"
            label="透明度"
            helpId="theme-opacity-help"
            help="磨砂导航、工具栏和浮层的不透明程度，1 为完全不透明"
          >
            <Slider
              labelledBy="theme-opacity"
              describedBy="theme-opacity-help"
              min={THEME_LIMITS.opacity.min}
              max={THEME_LIMITS.opacity.max}
              step={0.05}
              value={draft.opacity}
              valueText={draft.opacity.toFixed(2)}
              onChange={(opacity) => edit({ ...draft, opacity: Math.round(opacity * 100) / 100 })}
            />
          </SettingRow>
          <SettingRow labelId="theme-radius" label="圆角" help="面板与控件的圆角大小">
            <Slider
              labelledBy="theme-radius"
              min={THEME_LIMITS.radius.min}
              max={THEME_LIMITS.radius.max}
              step={1}
              value={draft.radius}
              valueText={`${draft.radius} 像素`}
              onChange={(radius) => edit({ ...draft, radius })}
            />
          </SettingRow>

          {issues.length > 0 && (
            <IssueList
              id="theme-issues"
              title={`以下问题未解决，这些修改没有应用；${usable === null ? '当前配色' : `上次可用的主题“${usable.name}”`}仍然生效：`}
              issues={issues}
            />
          )}
        </div>
      )}

      <ThemeTransfer adopt={adopt} />
    </Section>
  )
}

type TransferResult = { tone: 'done' | 'warning'; text: string; issues?: AppearanceIssue[] }

const IMPORT_FAILURES = {
  read: '导入失败：无法读取所选文件，当前设置未改变',
  'too-large': '导入失败：文件过大（主题文件不超过 64 KB），当前设置未改变',
  'not-saved': '导入失败：主题有效，但本地存储拒绝保存，当前设置未改变'
} as const

/** Theme import / export through the system file dialogs (main shows them). Cancelling says nothing. */
function ThemeTransfer({ adopt }: { adopt: (settings: AppSettings) => void }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TransferResult | null>(null)

  const run = async (action: 'import' | 'export') => {
    if (busy) return
    setBusy(true)
    setResult(null)
    try {
      if (action === 'import') {
        const outcome = await window.xidao.theme.import()
        if (outcome.status === 'imported') {
          adopt(outcome.settings)
          setResult({
            tone: 'done',
            text: `已导入主题“${outcome.settings.customTheme?.name ?? ''}”：配色已切换为自定义，文件中的字体、字号和阅读宽度已一并应用`
          })
        } else if (outcome.status === 'rejected') {
          setResult({ tone: 'warning', text: '未导入：主题文件不可用，当前主题和阅读参数保持不变。原因：', issues: outcome.issues })
        } else if (outcome.status === 'failed') {
          setResult({ tone: 'warning', text: IMPORT_FAILURES[outcome.reason] })
        }
      } else {
        const outcome = await window.xidao.theme.export()
        if (outcome.status === 'exported') setResult({ tone: 'done', text: '已导出主题文件（含当前阅读参数）' })
        else if (outcome.status === 'failed') setResult({ tone: 'warning', text: '导出失败：未能写入所选文件' })
      }
    } catch {
      setResult({ tone: 'warning', text: action === 'import' ? '导入失败：操作未完成，当前设置未改变' : '导出失败：操作未完成' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="theme-transfer">
      <div className="theme-transfer-buttons">
        <button type="button" className="btn" aria-disabled={busy ? true : undefined} onClick={() => void run('import')}>
          导入主题…
        </button>
        <button type="button" className="btn" aria-disabled={busy ? true : undefined} onClick={() => void run('export')}>
          导出主题…
        </button>
      </div>
      <p className="setting-help">主题文件是带版本的 JSON，包含颜色、透明度、圆角与阅读参数；不可用的文件会被拒绝，当前设置保持不变。</p>
      <div role="status" className="theme-transfer-result">
        {result !== null && (
          <>
            <p className={result.tone === 'done' ? 'notice-inline is-done' : 'notice-inline is-warning'}>
              <Icon name={result.tone === 'done' ? 'check' : 'alert'} size={14} />
              {result.text}
            </p>
            {result.issues !== undefined && (
              <ul className="issue-items">
                {describeIssues(result.issues).map((text) => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ReadingSection({ settings, write }: { settings: AppSettings; write: Write }) {
  const { reading } = settings
  return (
    <Section id="settings-reading" title="阅读">
      <SettingRow labelId="setting-font" label="字体">
        <Choice<ReadingFont>
          labelledBy="setting-font"
          options={[
            { value: 'sans', label: '无衬线' },
            { value: 'serif', label: '衬线' }
          ]}
          value={reading.font}
          onChange={(font) => write({ reading: { ...reading, font } })}
        />
      </SettingRow>
      <SettingRow labelId="setting-font-size" label="字号" help="正文与串标题的文字大小">
        <Slider
          labelledBy="setting-font-size"
          min={THEME_LIMITS.fontSize.min}
          max={THEME_LIMITS.fontSize.max}
          step={1}
          value={reading.fontSize}
          valueText={`${reading.fontSize} 像素`}
          onChange={(fontSize) => write({ reading: { ...reading, fontSize } }, INPUT_DELAY)}
        />
      </SettingRow>
      <SettingRow
        labelId="setting-reading-width"
        label="阅读宽度"
        helpId="setting-reading-width-help"
        help="正文每行最多的字数；窗口不够宽时先收窄两侧留白，再收起导航。"
      >
        <Slider
          labelledBy="setting-reading-width"
          describedBy="setting-reading-width-help"
          min={THEME_LIMITS.readingWidth.min}
          max={THEME_LIMITS.readingWidth.max}
          step={1}
          value={reading.readingWidth}
          valueText={`约 ${reading.readingWidth} 字`}
          onChange={(readingWidth) => write({ reading: { ...reading, readingWidth } }, INPUT_DELAY)}
        />
      </SettingRow>
      <figure className="reading-preview">
        <figcaption className="setting-help">预览</figcaption>
        <p className="reading-preview-text">汐岛的正文使用这里选择的字体与字号。窗口变窄时，正文两侧的留白先收窄，字号保持不变。</p>
      </figure>
    </Section>
  )
}

function DensityMotionSection({ settings, write }: { settings: AppSettings; write: Write }) {
  return (
    <Section id="settings-density" title="密度与动态">
      <SettingRow labelId="setting-density" label="密度" help="紧凑只减少列表和按钮的留白，不改变字号、配色或分栏。">
        <Choice<Density>
          labelledBy="setting-density"
          options={[
            { value: 'comfortable', label: '舒适' },
            { value: 'compact', label: '紧凑' }
          ]}
          value={settings.density}
          onChange={(density) => write({ density })}
        />
      </SettingRow>
      <SettingRow
        labelId="setting-motion"
        label="动态效果"
        help={
          systemReducesMotion()
            ? '系统已要求减少动态：当前不使用动画、闪烁或平滑滚动。'
            : '减少动态后不使用动画、闪烁或平滑滚动；位置与结果始终直接显示。'
        }
      >
        <Choice<MotionPreference>
          labelledBy="setting-motion"
          options={[
            { value: 'system', label: '跟随系统' },
            { value: 'reduce', label: '减少动态' }
          ]}
          value={settings.motion}
          onChange={(motion) => write({ motion })}
        />
      </SettingRow>
    </Section>
  )
}

function TabsSection({ settings, write }: { settings: AppSettings; write: Write }) {
  return (
    <Section id="settings-tabs" title="标签">
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
          onClick={() => write({ newTabSplitDefault: !settings.newTabSplitDefault })}
        >
          <span className="switch-thumb" aria-hidden="true" />
          <span className="switch-state" aria-hidden="true">
            {settings.newTabSplitDefault ? '开' : '关'}
          </span>
        </button>
      </div>
    </Section>
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
function WindowSection({ settings, write }: { settings: AppSettings; write: Write }) {
  return (
    <Section id="settings-window" title="窗口">
      <SettingRow
        labelId="setting-close-action"
        label="关闭窗口时"
        help="后台驻留只隐藏窗口，保留标签和编辑，可从系统托盘（macOS 为 Dock）重新打开。记住的选择不会跳过退出时对未保存编辑的处理。"
      >
        <Choice<CloseAction>
          labelledBy="setting-close-action"
          options={CLOSE_ACTIONS.map((value) => ({ value, label: CLOSE_ACTION_LABEL[value] }))}
          value={settings.closeAction}
          onChange={(closeAction) => write({ closeAction })}
        />
      </SettingRow>
    </Section>
  )
}

const ZOOM_KEYS: Record<ZoomAction, { mac: string; other: string }> = {
  in: { mac: '⌘ =', other: 'Ctrl + =' },
  out: { mac: '⌘ −', other: 'Ctrl + −' },
  reset: { mac: '⌘ 0', other: 'Ctrl + 0' }
}

/** Interface zoom of the window. The keys are handled by main; this only offers buttons. */
function ZoomSection({ platform }: { platform: AppPlatform | null }) {
  const [zoom, setZoom] = useState<ZoomState | null>(null)

  // Zooming (buttons or keys) changes the page size in CSS pixels: query the factor again then.
  useEffect(() => {
    let alive = true
    const refresh = () => {
      window.xidao.view
        .getZoom()
        .then((state) => {
          if (alive) setZoom(state)
        })
        .catch(() => undefined)
    }
    refresh()
    window.addEventListener('resize', refresh)
    return () => {
      alive = false
      window.removeEventListener('resize', refresh)
    }
  }, [])

  const keyOf = (action: ZoomAction) => (platform === 'darwin' ? ZOOM_KEYS[action].mac : ZOOM_KEYS[action].other)
  const titleOf = (label: string, action: ZoomAction) => (platform === null ? label : `${label}（${keyOf(action)}）`)
  const blocked: Record<ZoomAction, boolean> = {
    in: zoom === null || !zoom.canZoomIn,
    out: zoom === null || !zoom.canZoomOut,
    reset: zoom === null || Math.abs(zoom.factor - 1) < 0.001
  }

  // Limits use aria-disabled: the focused button stays focused when a limit is reached.
  const run = (action: ZoomAction) => {
    if (blocked[action]) return
    window.xidao.view
      .zoom({ action })
      .then(setZoom)
      .catch(() => undefined)
  }

  const percent = zoom === null ? '—' : `${Math.round(zoom.factor * 100)}%`
  return (
    <Section id="settings-zoom" title="界面缩放">
      <SettingRow
        labelId="setting-zoom"
        label="缩放比例"
        help={platform === null ? undefined : `快捷键：${keyOf('in')} 放大，${keyOf('out')} 缩小，${keyOf('reset')} 还原`}
      >
        <div className="zoom-controls" role="group" aria-labelledby="setting-zoom">
          <button
            type="button"
            className="btn zoom-step"
            aria-label="缩小界面"
            title={titleOf('缩小', 'out')}
            aria-disabled={blocked.out ? true : undefined}
            onClick={() => run('out')}
          >
            −
          </button>
          <output className="zoom-value" aria-live="polite">
            {percent}
          </output>
          <button
            type="button"
            className="btn zoom-step"
            aria-label="放大界面"
            title={titleOf('放大', 'in')}
            aria-disabled={blocked.in ? true : undefined}
            onClick={() => run('in')}
          >
            +
          </button>
          <button
            type="button"
            className="btn"
            title={titleOf('还原为 100%', 'reset')}
            aria-disabled={blocked.reset ? true : undefined}
            onClick={() => run('reset')}
          >
            还原
          </button>
        </div>
      </SettingRow>
    </Section>
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
