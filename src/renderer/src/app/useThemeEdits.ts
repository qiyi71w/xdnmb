import { useCallback, useLayoutEffect, useMemo, useReducer, useRef } from 'react'
import type { AppSettings } from '../../../shared/settings'
import type { AppearanceIssue, CustomTheme } from '../../../shared/theme'
import { previewTheme } from '../lib/useAppearance'
import { hasUnsavedEdits, reduceThemeEdits, savedThemeInUse, themeEditIssues, themeEditsFor, type SettingsTabState } from './themeEditsState'

export interface ThemeEditsAccess {
  /** The saved custom theme in use; null while 汐岛 is (no editor then). */
  saved: CustomTheme | null
  /** What the editor shows: the edits, else the saved theme. */
  draft: CustomTheme | null
  /** Why the edits cannot be saved (nor previewed); empty when they can. */
  issues: AppearanceIssue[]
  /** The edits differ from the saved theme. */
  unsaved: boolean
  /** The same as `unsaved`, read when called (for operations queued earlier). */
  isUnsaved: () => boolean
  edit: (theme: CustomTheme) => void
  /** 放弃修改. */
  discard: () => void
  /** Where the 设置 tab is now; closing it drops the edits. */
  settingsTab: (state: SettingsTabState) => void
}

/**
 * The app's one record of unsaved theme edits (themeEditsState.ts), with this window's preview
 * following it: valid edits preview at once in every tab, and dropping them shows the saved
 * appearance again. The preview never writes settings.
 */
export function useThemeEdits(settings: AppSettings): ThemeEditsAccess {
  const [stored, dispatch] = useReducer(reduceThemeEdits, settings, (initial) => themeEditsFor(savedThemeInUse(initial)))
  // The reducer drops the edits once it sees the new settings (before paint, so a dropped preview
  // never shows for a frame); this render already shows them dropped.
  useLayoutEffect(() => dispatch({ type: 'settings', settings }), [settings])
  const state = reduceThemeEdits(stored, { type: 'settings', settings })
  useLayoutEffect(() => previewTheme(state.preview), [state.preview])

  const unsaved = hasUnsavedEdits(state)
  const unsavedRef = useRef(unsaved)
  useLayoutEffect(() => {
    unsavedRef.current = unsaved
  })
  const isUnsaved = useCallback(() => unsavedRef.current, [])

  const issues = useMemo(() => (state.draft === null ? [] : themeEditIssues(state.draft, settings)), [state.draft, settings])
  const edit = useCallback((theme: CustomTheme) => dispatch({ type: 'edit', theme, settings }), [settings])
  const discard = useCallback(() => dispatch({ type: 'discard' }), [])
  const settingsTab = useCallback((tab: SettingsTabState) => dispatch({ type: 'settings-tab', state: tab }), [])

  return useMemo(
    () => ({ saved: state.basis, draft: state.draft ?? state.basis, issues, unsaved, isUnsaved, edit, discard, settingsTab }),
    [state.basis, state.draft, issues, unsaved, isUnsaved, edit, discard, settingsTab]
  )
}
