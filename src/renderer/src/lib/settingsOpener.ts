import { createContext, useContext } from 'react'

/**
 * Opens the settings dialog from anywhere below the app shell (e.g. an `identity` read failure).
 * `null` outside the provider: callers then offer no settings action.
 */
export const SettingsOpenerContext = createContext<(() => void) | null>(null)

export function useSettingsOpener(): (() => void) | null {
  return useContext(SettingsOpenerContext)
}
