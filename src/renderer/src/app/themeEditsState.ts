import type { AppSettings } from '../../../shared/settings'
import { parseCustomTheme, THEME_COLOR_KEYS, type AppearanceIssue, type CustomTheme } from '../../../shared/theme'
import { themeNameTaken, type ThemeListSettings } from '../../../shared/themeList'

/**
 * The unsaved edits of the custom theme in use: the one record that the 设置 › 外观 editor, the
 * window's preview, the 设置 tab's mark and the theme list operations read. It lives in the app,
 * not in the settings page, so the edits and their preview stay while another tab is shown; they
 * are dropped by 放弃修改, by closing 设置, and when the saved theme in use changes (saved, another
 * theme chosen, or changed elsewhere). Never written to settings, so quitting drops them too.
 */
export interface ThemeEdits {
  /** The saved custom theme in use that `draft` edits; null while 汐岛 is in use. */
  basis: CustomTheme | null
  /** The theme as edited, valid or not; null when it was not edited since `basis` was saved. */
  draft: CustomTheme | null
  /** What this window previews: the latest valid `draft`; null shows the saved appearance. */
  preview: CustomTheme | null
}

/** Where the 设置 tab is: shown, open behind another tab, or closed. */
export type SettingsTabState = 'current' | 'background' | 'closed'

export type ThemeEditsAction =
  /** An edit in the editor; `settings` are those shown, for the name check. */
  | { type: 'edit'; theme: CustomTheme; settings: ThemeListSettings }
  /** 放弃修改. */
  | { type: 'discard' }
  | { type: 'settings-tab'; state: SettingsTabState }
  /** The settings in effect now (after a save, a theme list operation, or a change elsewhere). */
  | { type: 'settings'; settings: AppSettings }

/** The saved custom theme in use, or null while 汐岛 is. */
export function savedThemeInUse(settings: Pick<AppSettings, 'customTheme' | 'customThemeEnabled'>): CustomTheme | null {
  return settings.customThemeEnabled ? settings.customTheme : null
}

export function sameTheme(a: CustomTheme | null, b: CustomTheme | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.name === b.name &&
    a.opacity === b.opacity &&
    a.radius === b.radius &&
    (['light', 'dark'] as const).every((scheme) => THEME_COLOR_KEYS.every((key) => a.colors[scheme][key] === b.colors[scheme][key]))
  )
}

/** No edits of `saved`. */
export function themeEditsFor(saved: CustomTheme | null): ThemeEdits {
  return { basis: saved, draft: null, preview: null }
}

/**
 * Why `theme` cannot be saved: its fields, or a name another custom theme (or 汐岛) already has.
 * Empty when it can be saved and previewed.
 */
export function themeEditIssues(theme: CustomTheme, settings: ThemeListSettings): AppearanceIssue[] {
  const parsed = parseCustomTheme(theme)
  if (!parsed.ok) return parsed.issues
  return themeNameTaken(settings, theme.name) ? [{ kind: 'field', field: 'customTheme.name', problem: 'duplicate' }] : []
}

/** The edits differ from the saved theme: the 设置 tab is marked and the theme list is locked. */
export function hasUnsavedEdits(state: ThemeEdits): boolean {
  return state.draft !== null && !sameTheme(state.draft, state.basis)
}

export function reduceThemeEdits(state: ThemeEdits, action: ThemeEditsAction): ThemeEdits {
  switch (action.type) {
    case 'edit': {
      // 汐岛 has no editor.
      if (state.basis === null) return state
      const valid = themeEditIssues(action.theme, action.settings).length === 0
      return { ...state, draft: action.theme, preview: valid ? action.theme : state.preview }
    }
    case 'discard':
      return state.draft === null && state.preview === null ? state : themeEditsFor(state.basis)
    case 'settings-tab':
      // Another tab shown keeps the edits and their preview; only closing 设置 drops them.
      return action.state === 'closed' ? reduceThemeEdits(state, { type: 'discard' }) : state
    case 'settings': {
      const saved = savedThemeInUse(action.settings)
      return sameTheme(saved, state.basis) ? state : themeEditsFor(saved)
    }
  }
}
