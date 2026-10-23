import { createContext, useContext } from 'react'

/**
 * True while a modal layer (the settings dialog) covers the whole app. Content behind it is not in
 * view, so foreground reading (the read judgement) is suspended until the layer closes.
 */
export const AppCoveredContext = createContext(false)

export function useAppCovered(): boolean {
  return useContext(AppCoveredContext)
}
