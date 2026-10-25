import { createContext, useContext } from 'react'

/** Sections of the settings page an entry can open at. */
export type SettingsSectionId =
  | 'appearance'
  | 'reading'
  | 'density'
  | 'zoom'
  | 'theme'
  | 'features'
  | 'boards'
  | 'tabs'
  | 'cookies'
  | 'subscriptions'
  | 'publication'
  | 'window'
  | 'cache'
  | 'blocks'

/**
 * Opens settings from anywhere below the app shell, at the section the entry is about (the top
 * without one). Pass the section explicitly: never hand this to `onClick` directly.
 * `null` outside the provider: callers then offer no settings action.
 */
export type SettingsOpener = (section?: SettingsSectionId) => void

export const SettingsOpenerContext = createContext<SettingsOpener | null>(null)

export function useSettingsOpener(): SettingsOpener | null {
  return useContext(SettingsOpenerContext)
}
