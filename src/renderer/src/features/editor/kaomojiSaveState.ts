import type { CustomKaomoji } from '../../../../shared/settings'
import type { KaomojiSaveRefusal } from './kaomoji'

/**
 * The one bottom notice 存为颜文字 keeps: `saved` (with 撤销 for `entry`), `refused` (why nothing
 * was saved) or `not-saved` (local storage did not take the write). `id` is the save it answers.
 * A saved one's `undo` is under way (`busy`) or was not saved (`failed`, offered again). `rewrite`
 * once an unsaved 撤销 left the lists in effect without the kaomoji (a write that threw is not
 * rolled back): from then on 撤销 only writes the lists as they are, so a kaomoji with the same
 * text added since is never removed. `gone` once that kaomoji was removed or its text edited,
 * after which 撤销 does nothing.
 */
export type KaomojiSaveNotice =
  | { kind: 'saved'; id: number; entry: CustomKaomoji; undo: 'idle' | 'busy' | 'failed'; rewrite: boolean; gone: boolean }
  | { kind: 'refused'; id: number; reason: KaomojiSaveRefusal }
  | { kind: 'not-saved'; id: number }

export interface KaomojiSaveState {
  /** The latest save; only its outcome is shown. */
  latest: number
  notice: KaomojiSaveNotice | null
}

export type KaomojiSaveAction =
  /** Save `id` wrote the settings: the earlier notice goes, nothing shows until the write is answered. */
  | { type: 'writing'; id: number }
  /** Save `id`'s write was answered: saved shows 已存为颜文字 for `entry`, else 设置未保存. Ignored once a later save started. */
  | { type: 'written'; id: number; saved: boolean; entry: CustomKaomoji }
  /** Save `id` saved nothing, for `reason`. */
  | { type: 'refused'; id: number; reason: KaomojiSaveRefusal }
  /** 撤销 of save `id` wrote the settings. */
  | { type: 'undoing'; id: number }
  /**
   * 撤销 of save `id` was answered: saved closes the notice; not saved keeps it, 撤销 offered again,
   * `listed` telling whether the lists in effect still hold the kaomoji.
   */
  | { type: 'undone'; id: number; saved: boolean; listed: boolean }
  /** The kaomoji save `id` added left the lists in effect: removed or its text edited, or its own 撤销. */
  | { type: 'gone'; id: number }
  /** The notice of save `id` was closed (×, timed out, or 撤销 with nothing left to undo). */
  | { type: 'dismiss'; id: number }

export const INITIAL_KAOMOJI_SAVE: KaomojiSaveState = { latest: 0, notice: null }

export function kaomojiSaveReducer(state: KaomojiSaveState, action: KaomojiSaveAction): KaomojiSaveState {
  switch (action.type) {
    case 'writing':
      return { latest: action.id, notice: null }
    case 'written':
      if (action.id !== state.latest) return state
      return {
        ...state,
        notice: action.saved
          ? { kind: 'saved', id: action.id, entry: action.entry, undo: 'idle', rewrite: false, gone: false }
          : { kind: 'not-saved', id: action.id }
      }
    case 'refused':
      return { latest: action.id, notice: { kind: 'refused', id: action.id, reason: action.reason } }
    case 'dismiss':
      return state.notice?.id === action.id ? { ...state, notice: null } : state
  }
  const notice = state.notice
  if (notice?.kind !== 'saved' || notice.id !== action.id) return state
  switch (action.type) {
    case 'undoing':
      return { ...state, notice: { ...notice, undo: 'busy' } }
    case 'undone':
      return { ...state, notice: action.saved ? null : { ...notice, undo: 'failed', rewrite: notice.rewrite || !action.listed } }
    case 'gone':
      // Its own 撤销 (under way, or failed without rolling back) takes it out of the lists too.
      return notice.undo === 'busy' || notice.rewrite ? state : { ...state, notice: { ...notice, gone: true } }
  }
}
