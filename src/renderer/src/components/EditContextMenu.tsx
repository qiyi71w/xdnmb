import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ClipboardEditCommand } from '../../../shared/api'
import { KaomojiSavingContext, saveKaomojiItem } from '../features/editor/kaomojiSaving'
import { useCover } from '../lib/appCovered'
import { runEditCommand } from '../lib/clipboard'
import { ContextMenu, contextMenuPoint, isContextMenuKey, type ContextMenuItem, type ContextMenuPoint } from './ContextMenu'
import { selectionCopyItem } from './copyMenuItems'

/** Marks a compose panel's text (`data-save-kaomoji` on it): its edit menu adds 存为颜文字 for the selection. */
const SAVE_KAOMOJI_FIELD = 'data-save-kaomoji'

/** Input types holding text the edit menu serves; checkboxes, ranges, buttons and the like have none. */
const TEXT_INPUT_TYPES: Record<string, true> = { text: true, search: true, url: true, tel: true, email: true, password: true, number: true }

type TextField = HTMLInputElement | HTMLTextAreaElement

function textField(target: EventTarget | null): TextField | null {
  if (target instanceof HTMLTextAreaElement) return target
  if (target instanceof HTMLInputElement && Object.hasOwn(TEXT_INPUT_TYPES, target.type)) return target
  return null
}

/**
 * 剪切／复制／粘贴／全选 as the field allows now. A masked (password) field only pastes: its text
 * is never copied out, by the menu or by the platform, until 显示 turns it into plain text. A compose
 * panel's text adds 存为颜文字 for the selection (taken now), unavailable like 复制 without one.
 */
function fieldItems(field: TextField, saveKaomoji: ((selected: string) => void) | null): ContextMenuItem[] {
  // `:disabled` also covers a field inside a disabled fieldset, whose own `disabled` stays false.
  const usable = !field.matches(':disabled')
  const writable = usable && !field.readOnly
  const masked = field instanceof HTMLInputElement && field.type === 'password'
  const { selectionStart: start, selectionEnd: end } = field
  // Types without a selection API (email, number): the document selection reports their selected text.
  const selected = usable && (start === null || end === null ? (window.getSelection()?.toString() ?? '') !== '' : start !== end)
  const maskedTitle = masked ? '遮蔽时只能粘贴，点“显示”后可用' : undefined
  const item = (key: string, label: string, command: ClipboardEditCommand, enabled: boolean, title?: string): ContextMenuItem => ({
    type: 'action',
    key,
    label,
    disabled: !enabled,
    title,
    onSelect: () => void runEditCommand(command).catch(() => undefined)
  })
  const items: ContextMenuItem[] = [
    item('cut', '剪切', 'cut', writable && selected && !masked, maskedTitle),
    item('copy', '复制', 'copy', selected && !masked, maskedTitle),
    item('paste', '粘贴', 'paste', writable),
    { type: 'separator', key: 'separator' },
    item('select-all', '全选', 'selectAll', usable && !masked && field.value !== '', maskedTitle)
  ]
  if (saveKaomoji === null || !field.hasAttribute(SAVE_KAOMOJI_FIELD)) return items
  const text = start === null || end === null ? '' : field.value.slice(start, end)
  return [...items, { type: 'separator', key: 'kaomoji-separator' }, saveKaomojiItem(saveKaomoji, text, selected)]
}

interface OpenMenu {
  point: ContextMenuPoint
  label: string
  items: ContextMenuItem[]
  /** The modal dialog holding the target, else the body: a menu outside an open modal is inert. */
  container: Element
  /** Takes focus back on close; an edit command acts on this field. */
  restore: HTMLElement | null
}

/** The menu for a context-menu request at `target` (pointer at `pointer`, else the keyboard); null for none. */
function menuFor(target: EventTarget | null, pointer: ContextMenuPoint | null, saveKaomoji: ((selected: string) => void) | null): OpenMenu | null {
  const field = textField(target)
  if (field !== null) {
    return {
      point: pointer ?? contextMenuPoint(null, field),
      label: '编辑',
      items: fieldItems(field, saveKaomoji),
      container: field.closest('dialog') ?? document.body,
      restore: field
    }
  }
  const copy = selectionCopyItem('复制')
  const selection = window.getSelection()
  if (copy === null || selection === null || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  const node = range.commonAncestorContainer
  const holder = node instanceof Element ? node : node.parentElement
  return {
    point: pointer ?? { x: rect.left, y: rect.bottom },
    label: '选中文字',
    items: [copy],
    container: holder?.closest('dialog') ?? document.body,
    restore: document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
}

/**
 * Context menu wherever no other menu answers (right-click, ContextMenu key, Shift+F10): 剪切／
 * 复制／粘贴／全选 on a text field, 复制 over selected text. Elsewhere nothing opens. Areas with
 * their own menu (posts, thread rows) handle the request first and keep it.
 */
export function EditContextMenuHost() {
  const [open, setOpen] = useState<OpenMenu | null>(null)
  useCover(open !== null)
  const saveKaomoji = useContext(KaomojiSavingContext)
  const save = useRef(saveKaomoji)
  useLayoutEffect(() => {
    save.current = saveKaomoji
  })

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return
      const menu = menuFor(event.target, event.button === 2 ? { x: event.clientX, y: event.clientY } : null, save.current)
      if (menu === null) return
      event.preventDefault()
      setOpen(menu)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || !isContextMenuKey(event)) return
      const menu = menuFor(document.activeElement, null, save.current)
      if (menu === null) return
      event.preventDefault()
      setOpen(menu)
    }
    document.addEventListener('contextmenu', onContextMenu)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('contextmenu', onContextMenu)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  if (open === null) return null
  return (
    <ContextMenu
      point={open.point}
      label={open.label}
      items={open.items}
      container={open.container}
      onClose={(restore) => {
        setOpen(null)
        if (restore && open.restore?.isConnected === true) open.restore.focus({ preventScroll: true })
      }}
    />
  )
}
