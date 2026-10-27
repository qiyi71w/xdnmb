// 设置 › 浏览 › 饼干颜色: every colored 饼干 ID in 添加时间 order, each with its color and 删除;
// a filter; and adding an ID by hand (an ID that already has a color changes color instead).

import { useId, useRef, useState, type CSSProperties, type FormEvent, type RefObject } from 'react'
import { COOKIE_COLORS, DEFAULT_COOKIE_COLOR, type CookieColor, type CookieColorName } from '../../../../shared/cookieColors'
import { COOKIE_ID_MAX_LENGTH, validateCookieId } from '../../../../shared/identity'
import { cookieColorToken } from '../../../../shared/theme'
import { CookieId } from '../../components/CookieId'
import { Icon } from '../../components/Icon'
import { cookieIdErrorText } from '../identity/identityText'
import { COOKIE_COLOR_LABELS } from './cookieColorNames'
import { useCookieColors } from './cookieColorsStore'
import '../identity/identity.css'
import './cookieColors.css'

export function CookieColorsSection() {
  const { entries, colors, loaded, failure, retry, set } = useCookieColors()
  const headingId = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const addInputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const shown = needle === '' ? entries : entries.filter((entry) => entry.cookieId.toLowerCase().includes(needle))

  // The deleted row's place goes to the next row's 删除 (else the previous one, else the add field).
  const remove = async (cookieId: string) => {
    const at = shown.findIndex((entry) => entry.cookieId === cookieId)
    if (!(await set(cookieId, null))) return
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLElement>('[data-remove]') ?? []
      const next = buttons[Math.min(at, buttons.length - 1)]
      ;(next ?? addInputRef.current)?.focus()
    })
  }

  return (
    <section className="settings-section" aria-labelledby={headingId}>
      <h3 className="settings-section-title" id={headingId}>
        饼干颜色
      </h3>
      {failure !== null && (
        <div className="notice notice-error is-compact" role="alert">
          <Icon name="alert" className="notice-icon" />
          <p className="notice-text">{failure}</p>
          <button type="button" className="btn btn-small" onClick={() => void retry()}>
            重试
          </button>
        </div>
      )}
      {loaded && entries.length === 0 && <p className="settings-empty">还没有饼干颜色</p>}
      {entries.length > 0 && (
        <>
          <div className="shell-picker-field shell-manage-filter">
            <Icon name="search" size={15} />
            <input
              ref={filterRef}
              type="search"
              className="shell-picker-input"
              placeholder="筛选饼干 ID"
              aria-label="筛选饼干 ID"
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <ul className="shell-manage-list" ref={listRef} aria-labelledby={headingId}>
            {shown.map((entry) => (
              <CookieColorRow key={entry.cookieId} entry={entry} onSet={set} onRemove={() => void remove(entry.cookieId)} />
            ))}
          </ul>
          <div className="shell-picker-status" role="status">
            {shown.length === 0 && <p className="shell-picker-note">没有匹配的饼干 ID</p>}
            {shown.length === 0 && (
              <button
                type="button"
                className="btn btn-quiet btn-small"
                onClick={() => {
                  setQuery('')
                  filterRef.current?.focus()
                }}
              >
                清除筛选
              </button>
            )}
          </div>
        </>
      )}
      <AddCookieColor inputRef={addInputRef} colors={colors} onSet={set} />
    </section>
  )
}

function CookieColorRow({
  entry,
  onSet,
  onRemove
}: {
  entry: CookieColor
  onSet: (cookieId: string, color: CookieColorName | null) => Promise<boolean>
  onRemove: () => void
}) {
  // The chosen color shows at once; a failed save puts the stored one back (the section says why).
  const [choosing, setChoosing] = useState<CookieColorName | null>(null)
  const choose = async (color: CookieColorName) => {
    setChoosing(color)
    await onSet(entry.cookieId, color)
    setChoosing(null)
  }
  return (
    <li className="shell-manage-row cookie-color-row">
      <span className="shell-manage-label">
        <CookieId cookieId={entry.cookieId} />
      </span>
      <span className="shell-manage-actions">
        <ColorChoice label={`${entry.cookieId} 的颜色`} value={choosing ?? entry.color} onChange={(color) => void choose(color)} />
        <button type="button" className="btn btn-small" data-remove="" aria-label={`删除 ${entry.cookieId} 的颜色`} onClick={onRemove}>
          删除
        </button>
      </span>
    </li>
  )
}

/** Adds a 饼干 ID by hand, checked by the same rules as filling a cookie's 饼干 ID. */
function AddCookieColor({
  inputRef,
  colors,
  onSet
}: {
  inputRef: RefObject<HTMLInputElement | null>
  colors: ReadonlyMap<string, CookieColorName>
  onSet: (cookieId: string, color: CookieColorName) => Promise<boolean>
}) {
  const titleId = useId()
  const inputId = useId()
  const messageId = useId()
  const [draft, setDraft] = useState('')
  const [color, setColor] = useState<CookieColorName>(DEFAULT_COOKIE_COLOR)
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    const checked = validateCookieId(draft)
    if (!checked.ok) {
      setMessage({ tone: 'error', text: cookieIdErrorText(checked.error) })
      inputRef.current?.focus()
      return
    }
    const { cookieId } = checked
    const before = colors.get(cookieId)
    setPending(true)
    setMessage(null)
    const saved = await onSet(cookieId, color)
    setPending(false)
    // A failed save is reported (with 重试) at the top of the section; the typed ID stays.
    if (!saved) return
    setDraft('')
    const label = COOKIE_COLOR_LABELS[color]
    setMessage({
      tone: 'success',
      text: before === undefined ? `已添加 ${cookieId}` : before === color ? `${cookieId} 已是${label}` : `${cookieId} 已有颜色，已改为${label}`
    })
  }

  const invalid = message?.tone === 'error'
  return (
    <form className="settings-group cookie-color-add" aria-labelledby={titleId} onSubmit={(event) => void submit(event)} noValidate>
      <h4 className="settings-group-title" id={titleId}>
        添加
      </h4>
      <label className="field-label" htmlFor={inputId}>
        饼干 ID
      </label>
      <div className="cookie-color-add-row">
        <input
          ref={inputRef}
          id={inputId}
          className="text-input cookie-id-input cookie-color-add-input"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            if (invalid) setMessage(null)
          }}
          maxLength={COOKIE_ID_MAX_LENGTH}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby={messageId}
          aria-invalid={invalid ? true : undefined}
        />
        <ColorChoice label="颜色" value={color} onChange={setColor} />
        <button type="submit" className="btn btn-small" aria-disabled={pending ? true : undefined}>
          添加
        </button>
      </div>
      <div id={messageId} className="form-message-region" role="status">
        {message !== null && (
          <p className={message.tone === 'error' ? 'form-message is-error' : 'form-message is-success'}>
            <Icon name={message.tone === 'error' ? 'alert' : 'info'} size={14} />
            <span>{message.text}</span>
          </p>
        )}
      </div>
    </form>
  )
}

/**
 * The eight 饼干颜色 as a radio group: Tab reaches the chosen one, arrow keys move and choose. Each
 * swatch is named for screen readers and in its tip; the chosen one carries a check mark.
 */
function ColorChoice({ label, value, onChange }: { label: string; value: CookieColorName; onChange: (color: CookieColorName) => void }) {
  const name = useId()
  return (
    <span className="cookie-swatches" role="radiogroup" aria-label={label}>
      {COOKIE_COLORS.map((color) => {
        const style = { '--swatch': `var(--${cookieColorToken(color)})` } as CSSProperties
        return (
          <label key={color} className="cookie-swatch" style={style} title={COOKIE_COLOR_LABELS[color]}>
            <input
              type="radio"
              className="cookie-swatch-input"
              name={name}
              value={color}
              checked={value === color}
              aria-label={COOKIE_COLOR_LABELS[color]}
              onChange={() => onChange(color)}
            />
            <span className="cookie-swatch-dot" aria-hidden="true">
              {value === color && <Icon name="check" size={12} />}
            </span>
          </label>
        )
      })}
    </span>
  )
}
