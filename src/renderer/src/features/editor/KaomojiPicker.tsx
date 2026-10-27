// The compose panel's 颜文字 button and its panel. The panel opens above the toolbar and stays open
// for several inserts; Esc (focus back on the button) or a press outside closes it. A kaomoji goes
// into the text at its caret or over its selection, wherever focus was. After the presets come the
// user's own kaomoji (removable; the `customKaomoji` setting) and 添加, which opens a multi-line
// field (Enter is a new line, Ctrl/Cmd+Enter saves) and an optional name. A named item shows its
// name in the interface face, like the named presets, and its full text on hover.

import { useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { KAOMOJI_LIMITS } from '../../../../shared/settings'
import { isSendShortcut, sendAriaShortcut, sendShortcutLabel } from '../../app/shortcuts'
import { Icon } from '../../components/Icon'
import { openLayer } from '../../lib/layers'
import { useSettings } from '../../lib/settingsContext'
import { KAOMOJI_PRESETS, newKaomoji, normalizeKaomojiText } from './kaomoji'
import { useEditorWorkspace } from './workspace'

const ITEM = '[data-kaomoji-item]'

/** The item a vertical arrow moves to: in the nearest row above or below, closest horizontally. */
function verticalNeighbour(items: readonly HTMLElement[], from: HTMLElement, down: boolean): HTMLElement | null {
  const origin = from.getBoundingClientRect()
  const centre = origin.left + origin.width / 2
  let best: HTMLElement | null = null
  let bestRow = Infinity
  let bestDistance = Infinity
  for (const item of items) {
    const rect = item.getBoundingClientRect()
    const row = down ? rect.top - origin.bottom : origin.top - rect.bottom
    if (row < -2) continue
    const distance = Math.abs(rect.left + rect.width / 2 - centre)
    if (row < bestRow - 2 || (Math.abs(row - bestRow) <= 2 && distance < bestDistance)) {
      best = item
      bestRow = row
      bestDistance = distance
    }
  }
  return best
}

export function KaomojiPicker({ disabled, onInsert }: { disabled: boolean; onInsert: (text: string) => void }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const { settings, latest, write } = useSettings()
  const { platform } = useEditorWorkspace()
  const custom = settings.customKaomoji
  /** The grid's one tabbable item (roving focus), by position. */
  const [active, setActive] = useState(0)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftName, setDraftName] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** Focus the item at this position once rendered (on opening, after adding or removing one). */
  const focusAt = useRef<number | null>(null)
  const itemCount = KAOMOJI_PRESETS.length + custom.length + 1
  const current = Math.min(active, itemCount - 1)

  // One closable layer: Esc closes the panel, not the compose panel under it.
  useEffect(() => {
    if (!open) return
    const layer = openLayer()
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || !layer.isTop()) return
      // Keeps the dialog's own Esc (collapse) from following.
      event.preventDefault()
      setOpen(false)
      buttonRef.current?.focus()
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      layer.release()
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  useEffect(() => {
    if (!open) {
      setAdding(false)
      setDraft('')
      setDraftName('')
    }
  }, [open])

  useLayoutEffect(() => {
    if (adding) inputRef.current?.focus()
  }, [adding])

  useLayoutEffect(() => {
    const at = focusAt.current
    if (at === null) return
    focusAt.current = null
    panelRef.current?.querySelectorAll<HTMLElement>(ITEM)[Math.min(at, itemCount - 1)]?.focus()
  })

  const toggle = () => {
    const opening = !open
    setOpen(opening)
    // Opening puts focus on the grid's current item.
    if (opening) focusAt.current = current
  }

  const onGridKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.matches(ITEM)) return
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEM)]
    const from = items.indexOf(event.target)
    let to: HTMLElement | null | undefined
    switch (event.key) {
      case 'ArrowLeft':
        to = items[from - 1]
        break
      case 'ArrowRight':
        to = items[from + 1]
        break
      case 'ArrowUp':
      case 'ArrowDown':
        to = verticalNeighbour(items, event.target, event.key === 'ArrowDown')
        break
      case 'Home':
        to = items[0]
        break
      case 'End':
        to = items.at(-1)
        break
      default:
        return
    }
    event.preventDefault()
    to?.focus()
  }

  const save = (event: FormEvent) => {
    event.preventDefault()
    const saved = latest().customKaomoji
    const entry = newKaomoji(saved, draft, draftName)
    if (entry === null) return
    write({ customKaomoji: [...saved, entry] })
    setDraft('')
    setDraftName('')
    setAdding(false)
    // 添加 again, after the new one.
    focusAt.current = itemCount
  }

  /** Esc closes the form only (the panel stays); Ctrl/Cmd+Enter saves here instead of sending the post. */
  const onAddKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      setAdding(false)
      setDraft('')
      setDraftName('')
      focusAt.current = itemCount - 1
    } else if (platform !== null && isSendShortcut(event.nativeEvent, platform)) {
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.requestSubmit()
    }
  }

  const remove = (text: string, position: number) => {
    write({ customKaomoji: latest().customKaomoji.filter((item) => item.text !== text) })
    focusAt.current = position
  }

  const nameTooLong = [...draftName.trim()].length > KAOMOJI_LIMITS.nameLength

  /** A press keeps focus where it is, so the text keeps its caret and selection. */
  const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault()

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="icon-btn"
        aria-label="颜文字"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        disabled={disabled}
        data-tip="颜文字"
        data-tip-place="start"
        onClick={toggle}
      >
        <Icon name="kaomoji" />
      </button>
      {open && (
        <div ref={panelRef} id={panelId} className="kaomoji-panel" role="group" aria-label="颜文字">
          <p className="visually-hidden" id={`${panelId}-custom`}>
            自定义颜文字，按 Delete 删除
          </p>
          <div className="kaomoji-grid" onKeyDown={onGridKeyDown} onFocus={(event) => {
            const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEM)]
            const at = items.indexOf(event.target as HTMLElement)
            if (at >= 0) setActive(at)
          }}>
            {KAOMOJI_PRESETS.map((kaomoji, index) => {
              const named = kaomoji.name !== kaomoji.text
              return (
                <button
                  key={kaomoji.name}
                  type="button"
                  className={`kaomoji-item${named ? ' is-named' : ''}`}
                  tabIndex={index === current ? 0 : -1}
                  title={named ? kaomoji.text : undefined}
                  data-kaomoji-item=""
                  onMouseDown={keepFocus}
                  onClick={() => onInsert(kaomoji.text)}
                >
                  {kaomoji.name}
                </button>
              )
            })}
            {custom.map(({ text, name }, index) => {
              const position = KAOMOJI_PRESETS.length + index
              return (
                <span key={text} className="kaomoji-custom">
                  <button
                    type="button"
                    className={`kaomoji-item${name === undefined ? '' : ' is-named'}`}
                    title={name === undefined ? undefined : text}
                    tabIndex={position === current ? 0 : -1}
                    aria-keyshortcuts="Delete"
                    aria-describedby={`${panelId}-custom`}
                    data-kaomoji-item=""
                    onMouseDown={keepFocus}
                    onClick={() => onInsert(text)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Delete' && event.key !== 'Backspace') return
                      event.preventDefault()
                      remove(text, position)
                    }}
                  >
                    {name ?? text}
                  </button>
                  <button
                    type="button"
                    className="kaomoji-remove"
                    tabIndex={-1}
                    aria-label={`删除 ${name ?? text}`}
                    title="删除"
                    onMouseDown={keepFocus}
                    onClick={() => remove(text, position)}
                  >
                    <Icon name="close" size={10} />
                  </button>
                </span>
              )
            })}
            {adding ? (
              <form className="kaomoji-add-form" onSubmit={save} onKeyDown={onAddKeyDown}>
                <textarea
                  ref={inputRef}
                  rows={3}
                  aria-label="新颜文字"
                  placeholder="颜文字"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft}
                  onChange={(event) => setDraft(normalizeKaomojiText(event.target.value))}
                />
                <div className="kaomoji-add-row">
                  <label className="kaomoji-add-name">
                    名称
                    <input
                      type="text"
                      placeholder="可不填"
                      autoComplete="off"
                      spellCheck={false}
                      value={draftName}
                      aria-invalid={nameTooLong || undefined}
                      aria-describedby={nameTooLong ? `${panelId}-name-note` : undefined}
                      onChange={(event) => setDraftName(event.target.value)}
                    />
                  </label>
                  {nameTooLong && (
                    <span className="kaomoji-add-note" id={`${panelId}-name-note`}>
                      名称最多 {KAOMOJI_LIMITS.nameLength} 个字
                    </span>
                  )}
                  <button
                    type="submit"
                    className="btn btn-small btn-primary"
                    aria-keyshortcuts={sendAriaShortcut(platform)}
                    title={sendShortcutLabel(platform) || undefined}
                    disabled={newKaomoji(custom, draft, draftName) === null}
                  >
                    保存
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                className="kaomoji-item kaomoji-add"
                tabIndex={itemCount - 1 === current ? 0 : -1}
                data-kaomoji-item=""
                onClick={() => setAdding(true)}
              >
                <Icon name="plus" size={12} />
                添加
              </button>
            )}
          </div>
        </div>
      )}
    </>
  )
}
