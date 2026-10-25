import { createContext, useContext } from 'react'
import type { ListRef } from '../tabs/tabsState'

/**
 * Opens a list in the current tab (as choosing it in the navigation does) and moves focus to it.
 * `null` outside the app shell: callers then offer no such action.
 */
export type ListOpener = (ref: ListRef) => void

export const ListOpenerContext = createContext<ListOpener | null>(null)

export function useListOpener(): ListOpener | null {
  return useContext(ListOpenerContext)
}
