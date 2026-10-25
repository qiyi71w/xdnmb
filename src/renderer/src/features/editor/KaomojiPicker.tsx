// PROTOTYPE (throwaway): the float compose panel's 颜文字 button and its panel. The panel opens above
// the toolbar and stays open for several inserts; Esc (focus back on the button) or a press outside
// closes it. A kaomoji goes into the text at its caret or over its selection, wherever focus was.
// After the presets come the user's own kaomoji (removable) and 添加.

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react'
import { Icon } from '../../components/Icon'
import { openLayer } from '../../lib/layers'
import { addKaomoji, canAddKaomoji, customKaomoji, KAOMOJI_PRESETS, removeKaomoji, subscribeCustomKaomoji } from './kaomoji'

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
  const buttonRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const custom = useSyncExternalStore(subscribeCustomKaomoji, customKaomoji)
  /** The grid's one tabbable item (roving focus), by position. */
  const [active, setActive] = useState(0)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
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
    if (!canAddKaomoji(draft)) return
    addKaomoji(draft)
    setDraft('')
    setAdding(false)
    // 添加 again, after the new one.
    focusAt.current = itemCount
  }

  const remove = (text: string, position: number) => {
    removeKaomoji(text)
    focusAt.current = position
  }

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
            {KAOMOJI_PRESETS.map((kaomoji, index) => (
              <button
                key={kaomoji.name}
                type="button"
                className={`kaomoji-item${kaomoji.name === kaomoji.text ? '' : ' is-named'}`}
                tabIndex={index === current ? 0 : -1}
                data-kaomoji-item=""
                onMouseDown={keepFocus}
                onClick={() => onInsert(kaomoji.text)}
              >
                {kaomoji.name}
              </button>
            ))}
            {custom.map((text, index) => {
              const position = KAOMOJI_PRESETS.length + index
              return (
                <span key={text} className="kaomoji-custom">
                  <button
                    type="button"
                    className="kaomoji-item"
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
                    {text}
                  </button>
                  <button
                    type="button"
                    className="kaomoji-remove"
                    tabIndex={-1}
                    aria-label={`删除 ${text}`}
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
              <form className="kaomoji-add-form" onSubmit={save}>
                <input
                  ref={inputRef}
                  type="text"
                  aria-label="新颜文字"
                  placeholder="颜文字"
                  autoComplete="off"
                  spellCheck={false}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Escape' || event.nativeEvent.isComposing) return
                    // Closes the form only; the panel stays.
                    event.preventDefault()
                    setAdding(false)
                    setDraft('')
                    focusAt.current = itemCount - 1
                  }}
                />
                <button type="submit" className="btn btn-small btn-primary" disabled={!canAddKaomoji(draft)}>
                  保存
                </button>
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
