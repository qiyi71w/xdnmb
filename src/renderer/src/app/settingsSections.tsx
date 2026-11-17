// Sections of the settings page (app/SettingsPage.tsx) that edit the
// global preferences and window behavior. Global preferences go through `write` (shown at once,
// saved by `useSettingsWriter`); the other sections keep their own APIs.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import type { AppPlatform } from '../../../shared/api'
import { BOSS_KEY_DEFAULT, bossKeyLabel, recordBossKey, type BossKeyStatus } from '../../../shared/bossKey'
import { CLOSE_ACTIONS, type CloseAction, type LoginItemState } from '../../../shared/lifecycle'
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
  type AppearanceIssue,
  type CustomTheme,
  type ReadingFont,
  type SchemeBase,
  type ThemeColors
} from '../../../shared/theme'
import {
  BUILTIN_THEME_NAME,
  createTheme,
  customThemes,
  MAX_CUSTOM_THEMES,
  saveCurrentTheme,
  selectBuiltinTheme,
  selectCustomTheme,
  themeNameTaken,
  type ThemeListResult
} from '../../../shared/themeList'
import imageMaskSample from '../../../../resources/image-mask-preview.png'
import { Icon } from '../components/Icon'
import { KaomojiDecor } from '../components/KaomojiDecor'
import { ImageMaskCover } from '../features/image/imageMask'
import { previewTheme, systemPrefersDark, systemReducesMotion } from '../lib/useAppearance'
import { useClearOnLeave } from '../lib/useClearOnLeave'
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

/**
 * On / off switch: a text-free track, its name outside (DESIGN.md). `locked`: unavailable but still
 * focusable (`aria-disabled`), for a switch that must keep focus or explain itself; presses are ignored.
 */
export function Switch({
  ref,
  labelledBy,
  describedBy,
  checked,
  busy,
  disabled,
  locked,
  onToggle
}: {
  ref?: Ref<HTMLButtonElement>
  labelledBy: string
  describedBy?: string
  checked: boolean
  busy?: boolean
  disabled?: boolean
  locked?: boolean
  onToggle: () => void
}) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      className="switch"
      aria-checked={checked}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-busy={busy}
      aria-disabled={locked || undefined}
      disabled={disabled}
      onClick={() => {
        if (!locked) onToggle()
      }}
    >
      <span className="switch-thumb" aria-hidden="true" />
    </button>
  )
}

// ---------------------------------------------------------------------------------------------
// Sections

export function AppearanceSection({
  settings,
  write,
  commit,
  latest,
  adopt,
  shown
}: {
  settings: AppSettings
  write: Write
  commit: (patch: Partial<AppSettings>) => Promise<boolean>
  latest: () => AppSettings
  adopt: (settings: AppSettings) => void
  /** 设置 is the active tab. */
  shown: boolean
}) {
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
      <ThemeList settings={settings} commit={commit} latest={latest} adopt={adopt} shown={shown} />
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
 * 主题: 汐岛 and the custom themes as a radio list; choosing one uses it at once (saved without
 * 保存). Under it 新建主题 and the theme file buttons, then the collapsed editor of the custom theme in
 * use (none while 汐岛 is). Valid edits preview in this renderer at once; only 保存 writes settings.
 * 放弃修改, leaving 设置 (another tab shown, or 设置 closed), or the theme in use changing (another one
 * chosen, 汐岛 included) drops the unsaved edits and restores the saved appearance; a choice that was
 * not saved changes nothing.
 */
function ThemeList({
  settings,
  commit,
  latest,
  adopt,
  shown
}: {
  settings: AppSettings
  commit: (patch: Partial<AppSettings>) => Promise<boolean>
  latest: () => AppSettings
  adopt: (settings: AppSettings) => void
  shown: boolean
}) {
  const groupName = useId()
  const saved = settings.customThemeEnabled ? settings.customTheme : null
  const [edits, setEdits] = useState<CustomTheme | null>(null)
  const [basis, setBasis] = useState(saved)
  const [issues, setIssues] = useState<AppearanceIssue[]>([])
  const [expanded, setExpanded] = useState(false)
  const [focusName, setFocusName] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const [editingScheme, setEditingScheme] = useState<SchemeBase>(resolveAppearance(settings, systemPrefersDark()).scheme)
  useEffect(() => () => previewTheme(null), [])
  useEffect(() => {
    if (!sameTheme(saved, basis)) {
      setBasis(saved)
      setEdits(null)
      setIssues([])
      previewTheme(null)
    }
  }, [saved, basis])
  useEffect(() => {
    if (focusName && nameRef.current !== null) {
      nameRef.current.focus()
      setFocusName(false)
    }
  })

  // List operations run one after another, each on the settings the previous one left.
  const queue = useRef<Promise<void>>(Promise.resolve())
  const run = (operation: (current: AppSettings) => ThemeListResult, onSaved?: () => void) => {
    queue.current = queue.current.then(async () => {
      const result = operation(latest())
      if (result.ok && (await commit(result.patch))) onSaved?.()
    })
  }

  const edit = (next: CustomTheme) => {
    setEdits(next)
    const parsed = parseCustomTheme(next)
    const found: AppearanceIssue[] = !parsed.ok
      ? parsed.issues
      : themeNameTaken(settings, next.name)
        ? [{ kind: 'field', field: 'customTheme.name', problem: 'duplicate' }]
        : []
    setIssues(found)
    if (parsed.ok && found.length === 0) previewTheme(parsed.value)
  }
  const discard = () => {
    setEdits(null)
    setIssues([])
    previewTheme(null)
  }
  const discardRef = useRef(discard)
  useLayoutEffect(() => {
    discardRef.current = discard
  })
  useEffect(() => {
    if (!shown) discardRef.current()
  }, [shown])
  const save = () => {
    if (edits === null || issues.length > 0) return
    const parsed = parseCustomTheme(edits)
    if (!parsed.ok) {
      setIssues(parsed.issues)
      return
    }
    run((current) => saveCurrentTheme(current, parsed.value))
  }
  const create = () =>
    run(
      (current) => createTheme(current, resolveAppearance(current, systemPrefersDark()).scheme),
      () => {
        setExpanded(true)
        setFocusName(true)
      }
    )

  const themes = customThemes(settings)
  const choices = [
    { name: BUILTIN_THEME_NAME, inUse: saved === null, select: () => run(() => selectBuiltinTheme()) },
    ...themes.map((theme) => ({
      name: theme.name,
      inUse: theme.name === saved?.name,
      select: () => run((current) => selectCustomTheme(current, theme.name))
    }))
  ]
  const full = themes.length >= MAX_CUSTOM_THEMES
  const draft = edits ?? saved
  const dirty = edits !== null && !sameTheme(edits, saved)
  const invalid = invalidFields(issues)
  const nameProblem = issues.find((issue) => issue.kind === 'field' && issue.field === 'customTheme.name')
  const otherScheme: SchemeBase = editingScheme === 'light' ? 'dark' : 'light'
  const otherInvalid = THEME_COLOR_KEYS.some((key) => invalid.has(`colors.${otherScheme}.${key}`))
  return (
    <>
      <div className="theme-row">
        <span className="setting-label theme-row-label" id="setting-theme-list">
          主题
        </span>
        <div className="theme-row-control">
          <div className="theme-list" role="radiogroup" aria-labelledby="setting-theme-list">
            {choices.map((choice) => (
              <label key={choice.name} className={choice.inUse ? 'theme-choice is-selected' : 'theme-choice'}>
                <input type="radio" name={groupName} checked={choice.inUse} onChange={choice.select} />
                <span className="theme-choice-name">{choice.name}</span>
              </label>
            ))}
          </div>
          <ThemeTransfer
            shown={shown}
            adopt={(next) => {
              discard()
              adopt(next)
            }}
            note={
              full ? (
                <span className="setting-help" id="theme-full-note">
                  最多 {MAX_CUSTOM_THEMES} 个自定义主题
                </span>
              ) : null
            }
          >
            <button
              type="button"
              className="btn btn-page"
              aria-disabled={full || undefined}
              aria-describedby={full ? 'theme-full-note' : undefined}
              onClick={() => {
                if (!full) create()
              }}
            >
              <Icon name="plus" />
              新建主题
            </button>
          </ThemeTransfer>
        </div>
      </div>

      {saved !== null && draft !== null && (
        <div className="theme-editor-block">
          <h4 className="theme-editor-title">
            <button type="button" className="theme-disclosure" aria-expanded={expanded} aria-controls="theme-editor-body" onClick={() => setExpanded(!expanded)}>
              编辑“{saved.name}” <Icon name={expanded ? 'minus' : 'plus'} size={14} />
            </button>
          </h4>
          <div id="theme-editor-body" className="theme-body" hidden={!expanded}>
            <div className="theme-editor">
              <ThemeField
                label="名称"
                labelFor="theme-name"
                error={nameProblem === undefined ? null : nameProblem.kind === 'field' && nameProblem.problem === 'duplicate' ? '已有同名主题' : nameError(draft.name)}
                errorId="theme-name-error"
              >
                <input
                  ref={nameRef}
                  id="theme-name"
                  className="text-input theme-name-input"
                  type="text"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft.name}
                  aria-invalid={nameProblem !== undefined ? true : undefined}
                  aria-describedby={nameProblem !== undefined ? 'theme-name-error' : undefined}
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
                  const picker = HEX.test(typed) ? typed.toLowerCase() : saved.colors[editingScheme][key]
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
          </div>
        </div>
      )}
    </>
  )
}

type TransferResult = { tone: 'done' | 'warning'; text: string; issues?: AppearanceIssue[] }

const IMPORT_FAILURES = {
  read: '无法读取文件',
  'too-large': '主题文件超过 64 KB',
  'not-saved': '主题未保存'
} as const

/**
 * Theme import / export through the system file dialogs (main shows them), after the list's own
 * buttons (`children`) and before a `note` about them. Cancelling says nothing. Leaving 设置 clears a
 * completed result; an import finishing after that is still adopted, unannounced.
 */
function ThemeTransfer({
  adopt,
  shown,
  note,
  children
}: {
  adopt: (settings: AppSettings) => void
  shown: boolean
  note: ReactNode
  children: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<TransferResult | null>(null)
  const begin = useClearOnLeave(shown, () => setResult((last) => (last?.tone === 'done' ? null : last)))

  const run = async (action: 'import' | 'export') => {
    if (busy) return
    setBusy(true)
    setResult(null)
    const current = begin()
    try {
      if (action === 'import') {
        const outcome = await window.xidao.theme.import()
        if (outcome.status === 'imported') {
          adopt(outcome.settings)
          if (current()) setResult({ tone: 'done', text: `已导入“${outcome.settings.customTheme?.name ?? ''}”` })
        } else if (outcome.status === 'rejected') {
          setResult({ tone: 'warning', text: '主题文件不可用', issues: outcome.issues })
        } else if (outcome.status === 'failed') {
          setResult({ tone: 'warning', text: IMPORT_FAILURES[outcome.reason] })
        }
      } else {
        const outcome = await window.xidao.theme.export()
        if (outcome.status === 'exported') {
          if (current()) setResult({ tone: 'done', text: '已导出主题' })
        } else if (outcome.status === 'failed') setResult({ tone: 'warning', text: '未能写入文件' })
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
        {children}
        <button type="button" className="btn btn-page" aria-disabled={busy ? true : undefined} onClick={() => void run('import')}>
          导入主题…
        </button>
        <button type="button" className="btn btn-page" aria-disabled={busy ? true : undefined} onClick={() => void run('export')}>
          导出主题…
        </button>
        {note}
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
      <SettingRow labelId="setting-image-mask" label="图片遮罩">
        <Switch
          labelledBy="setting-image-mask"
          checked={settings.imageMaskEnabled}
          onToggle={() => write({ imageMaskEnabled: !settings.imageMaskEnabled })}
        />
      </SettingRow>
      {settings.imageMaskEnabled && (
        <>
          <SettingRow labelId="setting-image-mask-strength" label="模糊强度">
            <Slider
              labelledBy="setting-image-mask-strength"
              min={0}
              max={100}
              step={1}
              value={settings.imageMaskStrength}
              valueText={`${settings.imageMaskStrength}%`}
              onChange={(imageMaskStrength) => write({ imageMaskStrength }, INPUT_DELAY)}
            />
          </SettingRow>
          {/* `write` shows the new strength in this render; only saving waits for the input to pause. */}
          <figure className="image-mask-preview">
            <figcaption className="setting-help">预览</figcaption>
            <span className="image-mask-preview-frame" aria-hidden="true">
              <img src={imageMaskSample} alt="" draggable={false} />
              {settings.imageMaskStrength > 0 && <ImageMaskCover strength={settings.imageMaskStrength} />}
            </span>
          </figure>
        </>
      )}
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

/**
 * 提醒 settings: how often reminders are checked in the background, whether new ones notify the
 * system, and whether a send from this app turns on 引用我 for its thread.
 */
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
      <SettingRow
        labelId="setting-reminder-auto-quote"
        label="发言后提醒引用我"
        helpId="setting-reminder-auto-quote-help"
        help="在汐岛发言的串自动开启，7 天没再发言后关闭"
      >
        <Switch
          labelledBy="setting-reminder-auto-quote"
          describedBy="setting-reminder-auto-quote-help"
          checked={settings.reminderAutoQuote}
          onToggle={() => write({ reminderAutoQuote: !settings.reminderAutoQuote })}
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
 * 窗口 settings: what the window's close button does, 开机自启 and the 老板键. A remembered 退出汐岛
 * still handles every unsaved edit before quitting; 后台驻留 never asks anything.
 */
export function WindowSection({
  settings,
  write,
  active,
  platform,
  onLoginItemNotApplied
}: {
  settings: AppSettings
  write: Write
  /** 设置 is shown: 开机自启 and the 老板键 status are read again from the system. */
  active: boolean
  platform: AppPlatform | null
  /** The system did not take a 开机自启 change (the switch shows what it reports instead). */
  onLoginItemNotApplied: () => void
}) {
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
      <LoginItemRows settings={settings} write={write} active={active} onNotApplied={onLoginItemNotApplied} />
      {platform !== null && platform !== 'linux' && <BossKeyRow settings={settings} write={write} active={active} platform={platform} />}
    </Section>
  )
}

/**
 * 开机时启动汐岛 is the system login item itself, read whenever 设置 is shown or the window comes
 * back to the front (after Task Manager or System Settings); 开机启动时后台驻留 is an ordinary setting
 * that only applies while the login item is on. Nothing shows where the system has no login items.
 */
function LoginItemRows({
  settings,
  write,
  active,
  onNotApplied
}: {
  settings: AppSettings
  write: Write
  active: boolean
  onNotApplied: () => void
}) {
  const [state, setState] = useState<LoginItemState | null>(null)
  const [writing, setWriting] = useState(false)

  useEffect(() => {
    if (!active) return
    let alive = true
    const refresh = () => {
      window.xidao.loginItem
        .get()
        .then((next) => {
          if (alive) setState(next)
        })
        .catch(() => undefined)
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      window.removeEventListener('focus', refresh)
    }
  }, [active])

  if (state !== null && !state.available && state.reason === 'unsupported') return null
  const usable = state !== null && state.available
  const enabled = usable && state.enabled
  const toggle = () => {
    if (!usable || writing) return
    setWriting(true)
    window.xidao.loginItem
      .set({ enabled: !state.enabled })
      .then((result) => {
        setState(result.state)
        if (!result.applied) onNotApplied()
      })
      .catch(onNotApplied)
      .finally(() => setWriting(false))
  }
  const help = state === null ? undefined : !state.available ? '开发运行时不可用' : state.needsApproval ? '需要在系统设置的登录项中允许' : undefined

  return (
    <>
      <SettingRow labelId="setting-login-item" label="开机时启动汐岛" helpId="setting-login-item-help" help={help}>
        <span className="login-item-control">
          {usable && state.needsApproval && (
            <button type="button" className="btn btn-small btn-page" onClick={() => void window.xidao.loginItem.openSystemSettings().catch(() => undefined)}>
              打开系统设置
            </button>
          )}
          <Switch
            labelledBy="setting-login-item"
            describedBy={help === undefined ? undefined : 'setting-login-item-help'}
            checked={enabled}
            busy={state === null || writing}
            disabled={state !== null && !state.available}
            onToggle={toggle}
          />
        </span>
      </SettingRow>
      <SettingRow labelId="setting-login-resident" label="开机启动时后台驻留">
        <Switch
          labelledBy="setting-login-resident"
          checked={settings.loginLaunchResident}
          disabled={!enabled}
          onToggle={() => write({ loginLaunchResident: !settings.loginLaunchResident })}
        />
      </SettingRow>
    </>
  )
}

const BOSS_KEY_REJECTED: Record<'key' | 'modifier' | 'app', (platform: AppPlatform) => string> = {
  key: () => '只能以字母、数字或 F1–F12 结尾',
  modifier: (platform) => (platform === 'darwin' ? '需要包含 ⌃、⌥ 或 ⌘' : '需要包含 Ctrl、Alt 或 Win'),
  app: () => '汐岛已在使用这个组合键'
}

/**
 * 老板键: one row whose combination sits beside the switch it belongs to. The switch and the
 * combination are settings; whether the system took the combination is read whenever 设置 is
 * shown, the window comes back to the front or a saved setting comes back (each read retries a
 * refused one). While recording, main releases the registered combination and hands every key press
 * here; it ends on Esc, on a recorded press, on leaving the field and on leaving 设置. The row's one help
 * line says what the recording or the system needs; nothing shows where there is no 老板键 (Linux).
 */
function BossKeyRow({
  settings,
  write,
  active,
  platform
}: {
  settings: AppSettings
  write: Write
  active: boolean
  platform: AppPlatform
}) {
  const [status, setStatus] = useState<BossKeyStatus | null>(null)
  const [recording, setRecording] = useState(false)
  const [rejected, setRejected] = useState<'key' | 'modifier' | 'app' | null>(null)

  // `settings` is replaced by every reply from main, so a change is read back once it is in effect.
  useEffect(() => {
    if (!active) return
    let alive = true
    const refresh = () => {
      window.xidao.bossKey
        .get()
        .then((next) => {
          if (alive) setStatus(next)
        })
        .catch(() => undefined)
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      window.removeEventListener('focus', refresh)
    }
  }, [active, settings])

  const recordingNow = useRef(false)
  const record = useCallback((next: boolean) => {
    recordingNow.current = next
    setRecording(next)
    setRejected(null)
    window.xidao.bossKey
      .setRecording({ recording: next })
      .then(setStatus)
      .catch(() => undefined)
  }, [])

  // Leaving 设置 (or the page) ends a recording, so the combination is registered again.
  useEffect(() => {
    if (recording && !active) record(false)
  }, [recording, active, record])
  useEffect(
    () => () => {
      if (recordingNow.current) void window.xidao.bossKey.setRecording({ recording: false }).catch(() => undefined)
    },
    []
  )

  // While recording, main takes every key press (but Tab) before the page and the menus, and hands
  // it over here: ⌘Q, Alt+F4 and the app's own shortcuts are refused in place instead of acting.
  useEffect(() => {
    if (!recording) return
    return window.xidao.bossKey.onInput((press) => {
      if (press.repeat) return
      if (press.key === 'Escape' && !press.ctrlKey && !press.altKey && !press.metaKey && !press.shiftKey) {
        record(false)
        return
      }
      const result = recordBossKey(press, platform)
      if (result.kind === 'pending') return
      if (result.kind === 'rejected') {
        setRejected(result.reason)
        return
      }
      record(false)
      if (result.accelerator !== settings.bossKey) write({ bossKey: result.accelerator })
    })
  }, [recording, platform, record, settings.bossKey, write])

  if (status === 'unsupported') return null

  const help = recording
    ? rejected === null ? '按 Esc 取消' : BOSS_KEY_REJECTED[rejected](platform)
    : settings.bossKeyEnabled && status === 'unavailable' ? '未生效，组合键可能已被其他程序占用' : undefined
  const describedBy = help === undefined ? undefined : 'setting-boss-key-help'
  const combination = bossKeyLabel(settings.bossKey, platform)

  return (
    <SettingRow
      labelId="setting-boss-key"
      label="老板键"
      helpId="setting-boss-key-help"
      help={help === undefined ? undefined : <span aria-live="polite">{help}</span>}
    >
      <span className="boss-key-control">
        {!recording && settings.bossKey !== BOSS_KEY_DEFAULT && (
          <button type="button" className="btn btn-small btn-quiet" onClick={() => write({ bossKey: BOSS_KEY_DEFAULT })}>
            恢复默认
          </button>
        )}
        <button
          type="button"
          className="btn boss-key-field"
          aria-label={recording ? '按下新的老板键组合键' : `更改老板键组合键，当前为 ${combination}`}
          aria-describedby={describedBy}
          aria-pressed={recording}
          title={recording ? undefined : '更改组合键'}
          onClick={(event) => {
            // While recording, Space and Enter are presses to record, not a click that cancels.
            if (!recording || event.detail > 0) record(!recording)
          }}
          onBlur={() => {
            if (recording) record(false)
          }}
        >
          {recording ? '按下新的组合键' : combination}
        </button>
        <Switch
          labelledBy="setting-boss-key"
          describedBy={describedBy}
          checked={settings.bossKeyEnabled}
          busy={status === null}
          onToggle={() => write({ bossKeyEnabled: !settings.bossKeyEnabled })}
        />
      </span>
    </SettingRow>
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
