// 存为颜文字: selected text in a post or in a compose panel's text becomes one of the user's own
// kaomoji, at the end of the list and without a name. A bottom notice tells what came of it: saved
// (with 撤销), or why nothing was saved. Only the latest one stays.

import { createContext, useCallback, useEffect, useReducer, useRef } from 'react'
import { KAOMOJI_LIMITS, type AppSettings, type CustomKaomoji } from '../../../../shared/settings'
import { BottomNotice } from '../../components/BottomNotice'
import type { ContextMenuItem } from '../../components/ContextMenu'
import { saveSelectionAsKaomoji, undoSavedKaomoji, type KaomojiSaveRefusal } from './kaomoji'
import { INITIAL_KAOMOJI_SAVE, kaomojiSaveReducer, type KaomojiSaveNotice, type KaomojiSaveState } from './kaomojiSaveState'

/** Why the selected text was not saved, said in the notice. */
const REFUSAL_TEXT: Record<KaomojiSaveRefusal, string> = {
  blank: '选中的只有空白，没有存为颜文字',
  'too-long': `选中的文字超过 ${KAOMOJI_LIMITS.length} 字，没有存为颜文字`,
  forbidden: '选中的文字含有不能保存的控制字符，没有存为颜文字',
  duplicate: '颜文字里已经有这段文字，没有重复保存',
  full: `自定义颜文字已满 ${KAOMOJI_LIMITS.count} 个，没有存为颜文字`
}

/** Unattended time on screen after which 已存为颜文字 closes and can no longer be undone (as 草稿已删除). */
const UNDO_WINDOW = 10_000

/** Saves selected text as one of the user's own kaomoji; null where 存为颜文字 is not offered. */
export const KaomojiSavingContext = createContext<((selected: string) => void) | null>(null)

/** The 存为颜文字 menu item for `selected` (taken when the menu opened); unavailable without a selection. */
export function saveKaomojiItem(save: (selected: string) => void, selected: string, enabled = true): ContextMenuItem {
  return { type: 'action', key: 'save-kaomoji', label: '存为颜文字', disabled: !enabled, onSelect: () => save(selected) }
}

export interface KaomojiSaving {
  state: KaomojiSaveState
  save: (selected: string) => void
  /** 撤销 of a saved notice: its kaomoji goes, unless that one was removed or its text edited since. */
  undo: (notice: SavedNotice) => void
  dismiss: (id: number) => void
}

type SavedNotice = Extract<KaomojiSaveNotice, { kind: 'saved' }>

/**
 * 存为颜文字 through the settings writer, `custom` being the own kaomoji in effect. A save shows
 * 已存为颜文字 only once its write is saved; one that is not shows 设置未保存 instead. Once the
 * saved kaomoji leaves the list (removed, or its text edited) its 撤销 does nothing, even if
 * another one with the same text is added later.
 */
export function useKaomojiSaving(
  custom: readonly CustomKaomoji[],
  latest: () => AppSettings,
  write: (patch: Partial<AppSettings>) => Promise<boolean>
): KaomojiSaving {
  const [state, dispatch] = useReducer(kaomojiSaveReducer, INITIAL_KAOMOJI_SAVE)
  const attempts = useRef(0)

  const notice = state.notice
  const watched = notice?.kind === 'saved' && !notice.gone ? notice : null
  useEffect(() => {
    if (watched !== null && !custom.some((item) => item.text === watched.entry.text)) dispatch({ type: 'gone', id: watched.id })
  }, [custom, watched])

  const save = useCallback(
    (selected: string) => {
      const id = ++attempts.current
      const result = saveSelectionAsKaomoji(latest().customKaomoji, selected)
      if (!result.ok) {
        dispatch({ type: 'refused', id, reason: result.reason })
        return
      }
      dispatch({ type: 'writing', id })
      void write({ customKaomoji: result.customKaomoji }).then((saved) => dispatch({ type: 'written', id, saved, entry: result.entry }))
    },
    [latest, write]
  )

  const undo = useCallback(
    (saved: SavedNotice) => {
      if (saved.undo === 'busy') return
      const settings = latest()
      // Once a failed 撤销 left the lists in effect without it (a write that threw is not rolled
      // back), trying again writes them as they are, never removing a kaomoji added since.
      const lists = saved.gone
        ? null
        : saved.rewrite
          ? { customKaomoji: [...settings.customKaomoji], recentKaomoji: [...settings.recentKaomoji] }
          : undoSavedKaomoji(settings.customKaomoji, settings.recentKaomoji, saved.entry.text)
      if (lists === null) {
        dispatch({ type: 'dismiss', id: saved.id })
        return
      }
      dispatch({ type: 'undoing', id: saved.id })
      void write(lists).then((done) => {
        // Read once the writer has applied what main kept (the old lists when it refused).
        const listed = latest().customKaomoji.some((item) => item.text === saved.entry.text)
        dispatch({ type: 'undone', id: saved.id, saved: done, listed })
      })
    },
    [latest, write]
  )

  const dismiss = useCallback((id: number) => dispatch({ type: 'dismiss', id }), [])

  return { state, save, undo, dismiss }
}

/**
 * The bottom notice of the latest 存为颜文字 (in a `BottomNoticeStack`). 已存为颜文字 closes after
 * `UNDO_WINDOW` like 草稿已删除; an undo that was not saved keeps it, saying so, with 撤销 again.
 */
export function KaomojiSaveNotices({ saving, fallbackFocus }: { saving: KaomojiSaving; fallbackFocus: () => HTMLElement | null }) {
  const notice = saving.state.notice
  if (notice === null) return null
  if (notice.kind === 'saved') {
    const busy = notice.undo === 'busy'
    return (
      <BottomNotice
        key={notice.id}
        open
        icon="kaomoji"
        tone="neutral"
        detail={notice.undo === 'failed' ? '没能撤销：设置未保存' : null}
        expiresAfter={notice.undo === 'failed' ? null : UNDO_WINDOW}
        onExpire={() => saving.dismiss(notice.id)}
        actions={[
          { label: '撤销', busy, onAction: () => saving.undo(notice) },
          { label: '关闭', icon: 'close', busy, onAction: () => saving.dismiss(notice.id) }
        ]}
        fallbackFocus={fallbackFocus}
      >
        已存为颜文字
      </BottomNotice>
    )
  }
  return (
    <BottomNotice key={notice.id} open actions={[{ label: '关闭', icon: 'close', onAction: () => saving.dismiss(notice.id) }]} fallbackFocus={fallbackFocus}>
      {notice.kind === 'refused' ? REFUSAL_TEXT[notice.reason] : '设置未保存'}
    </BottomNotice>
  )
}
