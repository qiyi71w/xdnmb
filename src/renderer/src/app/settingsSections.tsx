// Sections of the settings page (app/SettingsPage.tsx) that edit the
// global preferences and window behavior. Global preferences go through `write` (shown at once,
// saved by `useSettingsWriter`); the other sections keep their own APIs.

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
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
import { KaomojiDecor } from '../components/KaomojiDecor'
import { previewTheme, systemPrefersDark, systemReducesMotion } from '../lib/useAppearance'
import { describeIssues, invalidFields } from './appearanceIssues'
import type { SettingsWriteStatus } from './useSettingsWriter'
import './settings.css'

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<readonly { family: string }[]>
  }
}

export type Write = (patch: Partial<AppSettings>, delay?: number) => void

/** Slider and color edits are coalesced: one update after the input pauses this long. */
const INPUT_DELAY = 200

/** Whether the last setting changes could be saved or were refused. */
export function SettingsStatusNotices({ status }: { status: SettingsWriteStatus }) {
  return (
    <>
      {status.notSaved && (
        <p className="notice-inline is-warning" role="status">
          <Icon name="alert" size={14} />
          设置未保存
          <KaomojiDecor state="failure" />
        </p>
      )}
      {status.refused.length > 0 && <IssueList title="更改未应用" issues={status.refused} />}
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Building blocks

interface ChoiceOption<T extends string> {
  value: T
  label: string
  /** Shown but not selectable; the element with this id says why. */
  unavailableReason?: string
}

/** Exclusive choice as pressed buttons (`.segmented`); the pressed one is bold, not only tinted. */
export function Choice<T extends string>({
  labelledBy,
  describedBy,
  options,
  value,
  onChange
}: {
  labelledBy: string
  /** Help text of the whole choice. */
  describedBy?: string
  options: readonly ChoiceOption<T>[]
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="segmented setting-choice" role="group" aria-labelledby={labelledBy} aria-describedby={describedBy}>
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

export function Section({ id, title, children }: { id: string; title: ReactNode; children: ReactNode }) {
  return (
    <section className="settings-section" aria-labelledby={id}>
      <h3 className="settings-section-title" id={id}>
        {title}
      </h3>
      {children}
    </section>
  )
}

export function SettingRow({
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

function IssueList({ title, issues }: { title: string; issues: readonly AppearanceIssue[] }) {
  return (
    <div className="issue-list" role="status">
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
  min,
  max,
  step,
  value,
  valueText,
  onChange
}: {
  labelledBy: string
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
        aria-valuetext={valueText}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="setting-value" aria-hidden="true">
        {valueText}
      </span>
    </span>
  )
}

/** On / off switch: a text-free track, its name outside (DESIGN.md). */
export function Switch({
  labelledBy,
  describedBy,
  checked,
  busy,
  disabled,
  onToggle
}: {
  labelledBy: string
  describedBy?: string
  checked: boolean
  busy?: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-busy={busy}
      disabled={disabled}
      onClick={onToggle}
    >
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  )
}

// ---------------------------------------------------------------------------------------------
// Sections

export function AppearanceSection({ settings, write }: { settings: AppSettings; write: Write }) {
  return (
    <Section id="settings-appearance" title="外观">
      <SettingRow labelId="setting-scheme" label="配色">
        <Choice<ColorScheme>
          labelledBy="setting-scheme"
          options={[
            { value: 'system', label: '跟随系统' },
            { value: 'light', label: '浅色' },
            { value: 'dark', label: '深色' }
          ]}
          value={settings.colorScheme}
          onChange={(colorScheme) => write({ colorScheme })}
        />
      </SettingRow>
      <SettingRow labelId="setting-theme-source" label="主题">
        <Choice
          labelledBy="setting-theme-source"
          options={[
            { value: 'builtin', label: '汐岛' },
            { value: 'custom', label: settings.customTheme?.name ?? '自定义', unavailableReason: settings.customTheme === null ? 'theme-create-help' : undefined }
          ]}
          value={settings.customThemeEnabled ? 'custom' : 'builtin'}
          onChange={(value) => write({ customThemeEnabled: value === 'custom' })}
        />
        {settings.customTheme === null && (
          <span className="setting-help" id="theme-create-help">
            先创建或导入主题
          </span>
        )}
      </SettingRow>
    </Section>
  )
}

const COLOR_LABELS: Record<keyof ThemeColors, string> = {
  background: '窗口底色',
  surface: '正文底色',
  text: '正文文字',
  secondaryText: '次要文字',
  accent: '强调色'
}

const HEX = /^#[0-9a-f]{6}$/i

function sameTheme(a: CustomTheme | null, b: CustomTheme | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.name === b.name &&
    a.opacity === b.opacity &&
    a.radius === b.radius &&
    (['light', 'dark'] as const).every((scheme) => THEME_COLOR_KEYS.every((key) => a.colors[scheme][key] === b.colors[scheme][key]))
  )
}

const SCHEME_LABELS: Record<SchemeBase, string> = { light: '浅色', dark: '深色' }

/** Why parseCustomTheme refused the name: 1–40 characters once trimmed, no control or bidi characters. */
function nameError(name: string): string {
  const length = [...name.trim()].length
  if (length < THEME_LIMITS.nameLength.min) return '请填写名称'
  if (length > THEME_LIMITS.nameLength.max) return `最多 ${THEME_LIMITS.nameLength.max} 个字符，当前 ${length} 个`
  return '含有不可见的控制字符，请删除'
}

/**
 * A theme editor row laid out like `SettingRow` (name left, control right), with its own error line
 * under it. `labelFor` names one input; `labelId` names a group that refers to it.
 */
function ThemeField({
  label,
  labelFor,
  labelId,
  error,
  errorId,
  children
}: {
  label: string
  labelFor?: string
  labelId?: string
  error: string | null
  errorId: string
  children: ReactNode
}) {
  return (
    <div className="theme-field">
      {labelFor !== undefined ? (
        <label className="theme-field-label setting-label" htmlFor={labelFor}>
          {label}
        </label>
      ) : (
        <span className="theme-field-label setting-label" id={labelId}>
          {label}
        </span>
      )}
      <div className="theme-field-control">{children}</div>
      {error !== null && (
        <span className="field-error" id={errorId}>
          <Icon name="alert" size={13} />
          {error}
        </span>
      )}
    </div>
  )
}

/**
 * 自定义主题, collapsed until opened. Valid edits preview in this renderer at once; only 保存 writes
 * settings. 放弃修改, or leaving the page (unmount), restores the saved appearance.
 */
export function ThemeSection({ settings, write, adopt }: { settings: AppSettings; write: Write; adopt: (settings: AppSettings) => void }) {
  const [draft, setDraft] = useState<CustomTheme | null>(settings.customTheme)
  const [basis, setBasis] = useState(settings.customTheme)
  const [issues, setIssues] = useState<AppearanceIssue[]>([])
  const [expanded, setExpanded] = useState(false)
  const [editingScheme, setEditingScheme] = useState<SchemeBase>(resolveAppearance(settings, systemPrefersDark()).scheme)
  useEffect(() => () => previewTheme(null), [])
  useEffect(() => {
    if (!sameTheme(settings.customTheme, basis)) {
      setBasis(settings.customTheme)
      setDraft(settings.customTheme)
      setIssues([])
      previewTheme(null)
    }
  }, [settings.customTheme, basis])

  const edit = (next: CustomTheme) => {
    setDraft(next)
    const parsed = parseCustomTheme(next)
    setIssues(parsed.ok ? [] : parsed.issues)
    if (parsed.ok) previewTheme(parsed.value)
  }
  const create = () => edit(themeFromBuiltin(resolveAppearance(settings, systemPrefersDark()).scheme))
  const discard = () => {
    setDraft(settings.customTheme)
    setIssues([])
    previewTheme(null)
  }
  const save = () => {
    if (draft === null) return
    const parsed = parseCustomTheme(draft)
    if (!parsed.ok) {
      setIssues(parsed.issues)
      return
    }
    write({ customTheme: parsed.value, customThemeEnabled: true })
    previewTheme(null)
  }
  const dirty = !sameTheme(draft, settings.customTheme)
  const invalid = invalidFields(issues)
  const usable = settings.customTheme
  const nameInvalid = invalid.has('name')
  const otherScheme: SchemeBase = editingScheme === 'light' ? 'dark' : 'light'
  const otherInvalid = THEME_COLOR_KEYS.some((key) => invalid.has(`colors.${otherScheme}.${key}`))
  return (
    <Section
      id="settings-theme"
      title={
        <button type="button" className="theme-disclosure" aria-expanded={expanded} aria-controls="theme-editor-body" onClick={() => setExpanded(!expanded)}>
          自定义主题 <Icon name={expanded ? 'minus' : 'plus'} size={14} />
        </button>
      }
    >
      <div id="theme-editor-body" className="theme-body" hidden={!expanded}>
        {draft === null ? (
          <div className="theme-empty">
            <button type="button" className="btn btn-page" onClick={create}>
              <Icon name="plus" />
              创建主题
            </button>
          </div>
        ) : (
          <div className="theme-editor">
            <ThemeField label="名称" labelFor="theme-name" error={nameInvalid ? nameError(draft.name) : null} errorId="theme-name-error">
              <input
                id="theme-name"
                className="text-input theme-name-input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={draft.name}
                aria-invalid={nameInvalid ? true : undefined}
                aria-describedby={nameInvalid ? 'theme-name-error' : undefined}
                onChange={(event) => edit({ ...draft, name: event.target.value })}
              />
            </ThemeField>
            <ThemeField
              label="编辑颜色"
              labelId="theme-base"
              error={otherInvalid ? `${SCHEME_LABELS[otherScheme]}有颜色格式不正确` : null}
              errorId="theme-base-error"
            >
              <Choice<SchemeBase>
                labelledBy="theme-base"
                describedBy={otherInvalid ? 'theme-base-error' : undefined}
                options={[
                  { value: 'light', label: SCHEME_LABELS.light },
                  { value: 'dark', label: SCHEME_LABELS.dark }
                ]}
                value={editingScheme}
                onChange={setEditingScheme}
              />
            </ThemeField>

            <div className="theme-colors" role="group" aria-label="颜色">
              {THEME_COLOR_KEYS.map((key) => {
                const label = COLOR_LABELS[key]
                const typed = draft.colors[editingScheme][key]
                const picker = HEX.test(typed) ? typed.toLowerCase() : (usable?.colors[editingScheme][key] ?? '#000000')
                const fieldInvalid = invalid.has(`colors.${editingScheme}.${key}`)
                const errorId = `theme-color-${key}-error`
                const setColor = (value: string) =>
                  edit({ ...draft, colors: { ...draft.colors, [editingScheme]: { ...draft.colors[editingScheme], [key]: value } } })
                return (
                  <ThemeField key={key} label={label} labelFor={`theme-color-${key}`} error={fieldInvalid ? '格式应为 #rrggbb' : null} errorId={errorId}>
                    <span className="theme-color-inputs">
                      <input
                        type="color"
                        className="color-swatch"
                        aria-label={`${label}：取色器`}
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
                        aria-describedby={fieldInvalid ? errorId : undefined}
                        onChange={(event) => setColor(event.target.value)}
                      />
                    </span>
                  </ThemeField>
                )
              })}
            </div>

            <SettingRow labelId="theme-opacity" label="透明度">
              <Slider
                labelledBy="theme-opacity"
                min={THEME_LIMITS.opacity.min}
                max={THEME_LIMITS.opacity.max}
                step={0.05}
                value={draft.opacity}
                valueText={draft.opacity.toFixed(2)}
                onChange={(opacity) => edit({ ...draft, opacity: Math.round(opacity * 100) / 100 })}
              />
            </SettingRow>
            <SettingRow labelId="theme-radius" label="圆角">
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
          </div>
        )}
        {dirty && (
          <div className="theme-actions">
            <button type="button" className="btn btn-primary" aria-disabled={issues.length > 0 || undefined} onClick={save}>
              保存
            </button>
            <button type="button" className="btn btn-page" onClick={discard}>
              放弃修改
            </button>
            <span className="setting-help" role="status">
              {issues.length > 0 ? '修改未应用' : '预览中'}
            </span>
          </div>
        )}

        <ThemeTransfer
          adopt={(next) => {
            previewTheme(null)
            adopt(next)
          }}
        />
      </div>
    </Section>
  )
}

type TransferResult = { tone: 'done' | 'warning'; text: string; issues?: AppearanceIssue[] }

const IMPORT_FAILURES = {
  read: '无法读取文件',
  'too-large': '主题文件超过 64 KB',
  'not-saved': '主题未保存'
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
          setResult({ tone: 'done', text: `已导入“${outcome.settings.customTheme?.name ?? ''}”` })
        } else if (outcome.status === 'rejected') {
          setResult({ tone: 'warning', text: '主题文件不可用', issues: outcome.issues })
        } else if (outcome.status === 'failed') {
          setResult({ tone: 'warning', text: IMPORT_FAILURES[outcome.reason] })
        }
      } else {
        const outcome = await window.xidao.theme.export()
        if (outcome.status === 'exported') setResult({ tone: 'done', text: '已导出主题' })
        else if (outcome.status === 'failed') setResult({ tone: 'warning', text: '未能写入文件' })
      }
    } catch {
      setResult({ tone: 'warning', text: action === 'import' ? '导入未完成' : '导出未完成' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="theme-transfer">
      <div className="theme-transfer-buttons">
        <button type="button" className="btn btn-page" aria-disabled={busy ? true : undefined} onClick={() => void run('import')}>
          导入主题…
        </button>
        <button type="button" className="btn btn-page" aria-disabled={busy ? true : undefined} onClick={() => void run('export')}>
          导出主题…
        </button>
      </div>
      <div role="status" className="theme-transfer-result">
        {result !== null && (
          <>
            <p className={result.tone === 'done' ? 'notice-inline is-done' : 'notice-inline is-warning'}>
              <Icon name={result.tone === 'done' ? 'check' : 'alert'} size={14} />
              {result.text}
              {result.tone !== 'done' && <KaomojiDecor state="failure" />}
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

/**
 * Reading font: the built-in sans / serif, or an installed font. The installed fonts are read
 * (Local Font Access, which asks for permission) only when 读取本机字体 is pressed, never on mount.
 */
function FontPicker({ value, onChange }: { value: ReadingFont; onChange: (font: ReadingFont) => void }) {
  const [families, setFamilies] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
  const load = async () => {
    if (state === 'loading') return
    if (window.queryLocalFonts === undefined) {
      setState('unavailable')
      return
    }
    setState('loading')
    try {
      const fonts = await window.queryLocalFonts()
      setFamilies(
        [...new Set(fonts.map((font) => font.family))]
          .filter((family) => family.length > 0 && family.length <= 200)
          .sort((a, b) => a.localeCompare(b))
      )
      setState('ready')
    } catch {
      setState('unavailable')
    }
  }
  const selectedFamily = value.startsWith('local:') ? value.slice(6) : null
  const needle = filter.toLocaleLowerCase()
  const choices = [...new Set(selectedFamily === null ? families : [selectedFamily, ...families])].filter((family) =>
    family.toLocaleLowerCase().includes(needle)
  )
  return (
    <div className="font-picker">
      {state === 'ready' && (
        <input
          type="search"
          className="text-input"
          aria-label="筛选字体"
          placeholder="筛选字体"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      )}
      <select
        className="text-input"
        size={6}
        aria-labelledby="setting-font"
        value={value}
        onChange={(event) => onChange(event.target.value as ReadingFont)}
      >
        <option value="sans">系统无衬线</option>
        <option value="serif">系统衬线</option>
        {choices.map((family) => (
          <option key={family} value={`local:${family}`}>
            {family}
          </option>
        ))}
      </select>
      {state !== 'ready' && (
        <button type="button" className="btn btn-quiet" aria-disabled={state === 'loading' || undefined} onClick={() => void load()}>
          {state === 'loading' ? '读取中…' : '读取本机字体'}
        </button>
      )}
      {state === 'unavailable' && (
        <span className="setting-help" role="status">
          无法读取本机字体
        </span>
      )}
      {state === 'ready' && filter !== '' && choices.length === 0 && (
        <span className="setting-help" role="status">
          没有匹配的字体
        </span>
      )}
    </div>
  )
}

export function ReadingSection({ settings, write }: { settings: AppSettings; write: Write }) {
  const { reading } = settings
  return (
    <Section id="settings-reading" title="阅读">
      <SettingRow labelId="setting-font" label="正文字体">
        <FontPicker value={reading.font} onChange={(font) => write({ reading: { ...reading, font } })} />
      </SettingRow>
      <SettingRow labelId="setting-font-size" label="字号">
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
      <SettingRow labelId="setting-reading-width" label="阅读宽度">
        <Slider
          labelledBy="setting-reading-width"
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
        <p className="reading-preview-text">潮水退去，纸页留下。</p>
      </figure>
    </Section>
  )
}

export function DensityMotionSection({ settings, write }: { settings: AppSettings; write: Write }) {
  return (
    <Section id="settings-density" title="密度与动态">
      <SettingRow labelId="setting-density" label="密度">
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
      <SettingRow labelId="setting-motion" label="动态效果" help={systemReducesMotion() ? '系统已减少动态' : undefined}>
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

export function TabsSection({ settings, write }: { settings: AppSettings; write: Write }) {
  return (
    <Section id="settings-tabs" title="标签">
      <SettingRow labelId="setting-split-default" label="新标签默认开启分栏">
        <Switch
          labelledBy="setting-split-default"
          checked={settings.newTabSplitDefault}
          onToggle={() => write({ newTabSplitDefault: !settings.newTabSplitDefault })}
        />
      </SettingRow>
    </Section>
  )
}

/** 自动检查间隔 choices in minutes; 关闭 stops only the timer (cold start, reopen and 手动检查 remain). */
const REMINDER_INTERVALS: readonly AppSettings['reminderInterval'][] = [0, 15, 30, 60]

/** 提醒 settings: how often reminders are checked in the background and whether new ones notify the system. */
export function ReminderSection({ settings, write }: { settings: AppSettings; write: Write }) {
  return (
    <Section id="settings-reminders" title="提醒">
      <SettingRow labelId="setting-reminder-interval" label="自动检查间隔">
        <Choice
          labelledBy="setting-reminder-interval"
          options={REMINDER_INTERVALS.map((minutes) => ({ value: String(minutes), label: minutes === 0 ? '关闭' : `${minutes} 分钟` }))}
          value={String(settings.reminderInterval)}
          onChange={(value) => {
            const reminderInterval = REMINDER_INTERVALS.find((minutes) => String(minutes) === value)
            if (reminderInterval !== undefined) write({ reminderInterval })
          }}
        />
      </SettingRow>
      <SettingRow labelId="setting-reminder-notifications" label="新提醒系统通知">
        <Switch
          labelledBy="setting-reminder-notifications"
          checked={settings.reminderSystemNotifications}
          onToggle={() => write({ reminderSystemNotifications: !settings.reminderSystemNotifications })}
        />
      </SettingRow>
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
export function WindowSection({ settings, write }: { settings: AppSettings; write: Write }) {
  return (
    <Section id="settings-window" title="窗口">
      <SettingRow labelId="setting-close-action" label="关闭窗口时">
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
export function ZoomSection({ platform }: { platform: AppPlatform | null }) {
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
      <SettingRow labelId="setting-zoom" label="缩放比例">
        <div className="zoom-controls" role="group" aria-labelledby="setting-zoom">
          <button
            type="button"
            className="btn btn-page zoom-step"
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
            className="btn btn-page zoom-step"
            aria-label="放大界面"
            title={titleOf('放大', 'in')}
            aria-disabled={blocked.in ? true : undefined}
            onClick={() => run('in')}
          >
            +
          </button>
          <button
            type="button"
            className="btn btn-page"
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
export function PublicationSection() {
  const headingId = useId()
  const labelId = useId()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notSaved, setNotSaved] = useState(false)

  const read = useCallback((alive: () => boolean) => {
    setReadFailed(false)
    window.xidao.publication
      .getPoWarning()
      .then((result) => {
        if (alive()) setEnabled(result.enabled)
      })
      .catch(() => {
        if (alive()) setReadFailed(true)
      })
  }, [])

  useEffect(() => {
    let alive = true
    read(() => alive)
    return () => {
      alive = false
    }
  }, [read])

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
      <SettingRow labelId={labelId} label="回复自己的串时提示 PO 饼干">
        <Switch labelledBy={labelId} checked={enabled === true} busy={busy} disabled={enabled === null} onToggle={() => void toggle()} />
      </SettingRow>
      {readFailed && (
        <p className="notice-inline is-warning" role="status">
          <Icon name="alert" size={14} />
          未能读取这项设置
          <button type="button" className="btn btn-small btn-page" onClick={() => read(() => true)}>
            重试
          </button>
        </p>
      )}
      {notSaved && (
        <p className="notice-inline is-warning" role="status">
          <Icon name="alert" size={14} />
          设置未保存
          <KaomojiDecor state="failure" />
        </p>
      )}
    </section>
  )
}
