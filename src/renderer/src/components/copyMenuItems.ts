import { MAX_CLIPBOARD_TEXT_LENGTH } from '../../../shared/api'
import { copyText } from '../lib/clipboard'
import type { ContextMenuItem } from './ContextMenu'

/**
 * An item putting `text` on the clipboard as given. Unavailable, with `emptyTitle` saying why,
 * when there is no text; unavailable when the text is longer than the clipboard channel takes.
 */
export function copyTextItem(key: string, label: string, text: string, emptyTitle: string): ContextMenuItem {
  const tooLong = text.length > MAX_CLIPBOARD_TEXT_LENGTH
  return {
    type: 'action',
    key,
    label,
    disabled: text === '' || tooLong,
    title: text === '' ? emptyTitle : tooLong ? '文字太长' : undefined,
    onSelect: () => void copyText(text).catch(() => undefined)
  }
}

/** 复制串号 of a post or thread: `No.x`, the form quote cards copy. */
export function copyNumberItem(postId: string): ContextMenuItem {
  return copyTextItem('copy-number', '复制串号', `No.${postId}`, '')
}

/**
 * 复制选中文字 for a context menu opening now: null without a selection that has visible text, or
 * (with `within`) whose range does not reach that element. The text is taken as the menu opens,
 * so focus moving into the menu cannot lose it.
 */
export function selectionCopyItem(label = '复制选中文字', within: Element | null = null): ContextMenuItem | null {
  const selection = window.getSelection()
  const text = selection?.toString() ?? ''
  if (text.trim() === '') return null
  if (within !== null && (selection === null || selection.rangeCount === 0 || !selection.getRangeAt(0).intersectsNode(within))) return null
  return copyTextItem('copy-selection', label, text, '')
}

/** A menu's items with 复制选中文字 (taken when it opened) on top. */
export function withSelectionCopy(selection: ContextMenuItem | null, items: ContextMenuItem[]): ContextMenuItem[] {
  return selection === null ? items : [selection, { type: 'separator', key: 'selection-separator' }, ...items]
}
