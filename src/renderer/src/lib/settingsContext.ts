import { createContext, useContext } from 'react'
import type { AppSettings } from '../../../shared/settings'

/**
 * The settings in effect and the one way to change them: `write` shows a patch at once and saves it
 * through `settings.update` (see `useSettingsWriter`). Build a patch from `latest()`, not from a
 * rendered `settings`, so changes made in quick succession never drop each other.
 */
export interface SettingsAccess {
  settings: AppSettings
  latest: () => AppSettings
  write: (patch: Partial<AppSettings>, delay?: number) => void
}

export const SettingsContext = createContext<SettingsAccess | null>(null)

export function useSettings(): SettingsAccess {
  const access = useContext(SettingsContext)
  if (access === null) throw new Error('useSettings outside SettingsContext')
  return access
}
