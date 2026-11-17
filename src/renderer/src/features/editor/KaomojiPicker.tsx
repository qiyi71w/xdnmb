// The compose panel's 颜文字 button and its panel. The panel opens above the toolbar and stays open
// for several inserts; Esc (focus back on the button) or a left press outside closes it, while a
// right press (the text's own menu, 存为颜文字) and presses in a menu leave it open. A kaomoji goes
// into the text at its caret or over its selection, wherever focus was; 防剧透 goes around the
// selection instead. The 最近使用 row comes first (the `recentKaomoji` setting, as it was when the
// panel opened, so nothing moves under the pointer while inserting), then the presets, the user's
// own kaomoji (the `customKaomoji` setting) and 添加, which opens a multi-line field (Enter is a new
// line, Ctrl/Cmd+Enter saves) and an optional name. An own kaomoji is removed with its × or Delete;
// its menu (right press, ContextMenu key, Shift+F10) has 编辑, which opens the same form in its place
// to change its text and name, and 删除. Only one form is open at a time. A named item shows its
// name in the interface face, like the named presets, and its full text on hover.

import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { KAOMOJI_LIMITS } from '../../../../shared/settings'
import { isSendShortcut, sendAriaShortcut, sendShortcutLabel } from '../../app/shortcuts'
import { ContextMenu, contextMenuPoint, isContextMenuKey, type ContextMenuPoint } from '../../components/ContextMenu'
import { Icon } from '../../components/Icon'
import { openLayer } from '../../lib/layers'
import { useSettings } from '../../lib/settingsContext'
import {
  editKaomoji, KAOMOJI_PRESETS, newKaomoji, normalizeKaomojiText, recentKaomojiItems, renamedRecentKaomoji, withRecentKaomoji,
  type KaomojiInsert
} from './kaomoji'
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

/** The open form: 添加 at the end, or 编辑 in place of the own kaomoji whose text is `from`. */
type KaomojiForm = { kind: 'add' } | { kind: 'edit'; from: string }

/** An own kaomoji's open menu: for `text`, opened from `owner` (focus goes back to it). */
interface KaomojiMenu {
  point: ContextMenuPoint
  text: string
  owner: HTMLElement
}

export function KaomojiPicker({ disabled, onInsert }: { disabled: boolean; onInsert: (kaomoji: KaomojiInsert) => void }) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const { settings, latest, write } = useSettings()
  const { platform } = useEditorWorkspace()
  const custom = settings.customKaomoji
  /** The recent list as it was when the panel opened; a removed kaomoji leaves the row at once. */
  const [shownRecent, setShownRecent] = useState<readonly string[]>([])
  const recent = recentKaomojiItems(shownRecent, custom)
  /** The grid's one tabbable item (roving focus), by position. */
  const [active, setActive] = useState(0)
  const [form, setForm] = useState<KaomojiForm | null>(null)
  const [draft, setDraft] = useState('')
  const [draftName, setDraftName] = useState('')
  const [menu, setMenu] = useState<KaomojiMenu | null>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** Focus the item at this position once rendered (on opening, after adding, editing or removing one). */
  const focusAt = useRef<number | null>(null)
  const presetStart = recent.length
  const customStart = presetStart + KAOMOJI_PRESETS.length
  const itemCount = customStart + custom.length + 1
  const current = Math.min(active, itemCount - 1)

  // One closable layer: Esc closes the panel, not the compose panel under it. A menu opened over it
  // is the top layer, so its Esc closes the menu first.
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
      // A right press opens the text's menu (存为颜文字 adds to this panel); a menu is chosen from.
      if (event.button === 2) return
      const target = event.target as Node | null
      if (panelRef.current?.contains(target) || buttonRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('.context-menu') !== null) return
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
      setForm(null)
      setDraft('')
      setDraftName('')
      setMenu(null)
    }
  }, [open])

  useLayoutEffect(() => {
    if (form !== null) inputRef.current?.focus()
  }, [form])

  useLayoutEffect(() => {
    const at = focusAt.current
    if (at === null) return
    focusAt.current = null
    panelRef.current?.querySelectorAll<HTMLElement>(ITEM)[Math.min(at, itemCount - 1)]?.focus()
  })

  const toggle = () => {
    const opening = !open
    setOpen(opening)
    if (!opening) return
    // Opening shows the recent row as it is now and puts focus on the grid's current item: the same
    // preset or own kaomoji as before, or the row's first item when it was one of the row.
    const saved = latest()
    const shown = recentKaomojiItems(saved.recentKaomoji, saved.customKaomoji).length
    const at = current < presetStart ? 0 : current - presetStart + shown
    setShownRecent(saved.recentKaomoji)
    setActive(at)
    focusAt.current = at
  }

  const insert = (kaomoji: KaomojiInsert) => {
    onInsert(kaomoji)
    void write({ recentKaomoji: withRecentKaomoji(latest().recentKaomoji, kaomoji.text) })
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

  /** Opens 添加, or 编辑 filled in with an own kaomoji's text and name; the other form closes. */
  const openForm = (next: KaomojiForm, text = '', name = '') => {
    setForm(next)
    setDraft(text)
    setDraftName(name)
  }

  /** Closes the form; focus goes to the item at `position` (添加, or the item edited). */
  const closeForm = (position: number) => {
    setForm(null)
    setDraft('')
    setDraftName('')
    focusAt.current = position
  }

  /** The position in the grid of the own kaomoji whose text is `text`. */
  const positionOf = (text: string) => customStart + Math.max(0, custom.findIndex((item) => item.text === text))

  const save = (event: FormEvent) => {
    event.preventDefault()
    if (form === null) return
    const saved = latest()
    if (form.kind === 'add') {
      const entry = newKaomoji(saved.customKaomoji, draft, draftName)
      if (entry === null) return
      void write({ customKaomoji: [...saved.customKaomoji, entry] })
      // 添加 again, after the new one.
      closeForm(itemCount)
      return
    }
    const result = editKaomoji(saved.customKaomoji, saved.recentKaomoji, form.from, draft, draftName)
    if (!result.ok) return
    void write({ customKaomoji: result.customKaomoji, recentKaomoji: result.recentKaomoji })
    // The row shown keeps the edited kaomoji in its place, under its new text.
    const shown = renamedRecentKaomoji(shownRecent, form.from, draft)
    setShownRecent(shown)
    const index = result.customKaomoji.findIndex((item) => item.text === draft)
    closeForm(recentKaomojiItems(shown, result.customKaomoji).length + KAOMOJI_PRESETS.length + index)
  }

  /** Esc closes the form only (the panel stays); Ctrl/Cmd+Enter saves here instead of sending the post. */
  const onFormKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
      event.preventDefault()
      closeForm(form?.kind === 'edit' ? positionOf(form.from) : itemCount - 1)
    } else if (platform !== null && isSendShortcut(event.nativeEvent, platform)) {
      event.preventDefault()
      event.stopPropagation()
      event.currentTarget.requestSubmit()
    }
  }

  const remove = (text: string, position: number) => {
    const saved = latest()
    void write({
      customKaomoji: saved.customKaomoji.filter((item) => item.text !== text),
      recentKaomoji: saved.recentKaomoji.filter((item) => item !== text)
    })
    if (form?.kind === 'edit' && form.from === text) setForm(null)
    // The next item takes its place, one earlier when the row loses it too.
    focusAt.current = recent.some((item) => item.text === text) ? position - 1 : position
  }

  const openMenu = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, text: string) => {
    event.preventDefault()
    event.stopPropagation()
    setMenu({ point: contextMenuPoint(event, event.currentTarget), text, owner: event.currentTarget })
  }

  const nameTooLong = [...draftName.trim()].length > KAOMOJI_LIMITS.nameLength
  const canSave =
    form?.kind === 'add' ? newKaomoji(custom, draft, draftName) !== null : form?.kind === 'edit' && editKaomoji(custom, [], form.from, draft, draftName).ok

  /** A press keeps focus where it is, so the text keeps its caret and selection. */
  const keepFocus = (event: { preventDefault: () => void }) => event.preventDefault()

  const formView = form !== null && (
    <form className="kaomoji-add-form" onSubmit={save} onKeyDown={onFormKeyDown}>
      <textarea
        ref={inputRef}
        rows={3}
        aria-label={form.kind === 'add' ? '新颜文字' : '编辑颜文字'}
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
          disabled={!canSave}
        >
          保存
        </button>
      </div>
    </form>
  )

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
            自定义颜文字，按 Delete 删除，按 Shift+F10 编辑
          </p>
          <div className="kaomoji-grid" onKeyDown={onGridKeyDown} onFocus={(event) => {
            const items = [...event.currentTarget.querySelectorAll<HTMLElement>(ITEM)]
            const at = items.indexOf(event.target as HTMLElement)
            if (at >= 0) setActive(at)
          }}>
            {recent.length > 0 && (
              <div className="kaomoji-recent" role="group" aria-label="最近使用">
                {recent.map(({ text, name, wrap }, index) => (
                  <button
                    key={text}
                    type="button"
                    className={`kaomoji-item${name === null ? '' : ' is-named'}`}
                    tabIndex={index === current ? 0 : -1}
                    title={name === null ? undefined : text}
                    data-kaomoji-item=""
                    onMouseDown={keepFocus}
                    onClick={() => insert({ text, wrap })}
                  >
                    {name ?? text}
                  </button>
                ))}
              </div>
            )}
            {KAOMOJI_PRESETS.map((kaomoji, index) => {
              const named = kaomoji.name !== kaomoji.text
              return (
                <button
                  key={kaomoji.name}
                  type="button"
                  className={`kaomoji-item${named ? ' is-named' : ''}`}
                  tabIndex={presetStart + index === current ? 0 : -1}
                  title={named ? kaomoji.text : undefined}
                  data-kaomoji-item=""
                  onMouseDown={keepFocus}
                  onClick={() => insert(kaomoji)}
                >
                  {kaomoji.name}
                </button>
              )
            })}
            {custom.map(({ text, name }, index) => {
              // 编辑 opens the form where the kaomoji was.
              if (form?.kind === 'edit' && form.from === text) return <Fragment key={text}>{formView}</Fragment>
              const position = customStart + index
              return (
                <span key={text} className="kaomoji-custom">
                  <button
                    type="button"
                    className={`kaomoji-item${name === undefined ? '' : ' is-named'}`}
                    title={name === undefined ? undefined : text}
                    tabIndex={position === current ? 0 : -1}
                    aria-haspopup="menu"
                    aria-keyshortcuts="Delete Shift+F10"
                    aria-describedby={`${panelId}-custom`}
                    data-kaomoji-item=""
                    onMouseDown={keepFocus}
                    onClick={() => insert({ text })}
                    onContextMenu={(event) => openMenu(event, text)}
                    onKeyDown={(event) => {
                      if (isContextMenuKey(event)) {
                        openMenu(event, text)
                        return
                      }
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
            {form?.kind === 'add' ? (
              formView
            ) : (
              <button
                type="button"
                className="kaomoji-item kaomoji-add"
                tabIndex={itemCount - 1 === current ? 0 : -1}
                data-kaomoji-item=""
                onClick={() => openForm({ kind: 'add' })}
              >
                <Icon name="plus" size={12} />
                添加
              </button>
            )}
          </div>
        </div>
      )}
      {menu !== null && (
        <ContextMenu
          point={menu.point}
          label="自定义颜文字"
          container={panelRef.current?.closest('dialog') ?? undefined}
          items={[
            {
              type: 'action',
              key: 'edit',
              label: '编辑',
              onSelect: () => {
                const entry = latest().customKaomoji.find((item) => item.text === menu.text)
                if (entry !== undefined) openForm({ kind: 'edit', from: entry.text }, entry.text, entry.name)
              }
            },
            { type: 'action', key: 'remove', label: '删除', onSelect: () => remove(menu.text, positionOf(menu.text)) }
          ]}
          onClose={(restore) => {
            setMenu(null)
            if (restore && menu.owner.isConnected) menu.owner.focus({ preventScroll: true })
          }}
        />
      )}
    </>
  )
}
