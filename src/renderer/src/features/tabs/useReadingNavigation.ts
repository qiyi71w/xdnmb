import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ContentRegistry, ListMemory } from './contentRegistry'
import { createReadingNavigation, INITIAL_NAVIGATION_STATE, navigationReducer, navigationSeeds, type NavigationAction, type ReadingNavigation } from './readingNavigation'
import type { TabsState } from './tabsState'

export interface ReadingNavigationHost {
  tabs: TabsState | null
  dispatch: (action: NavigationAction) => void
  navigation: ReadingNavigation
  seeds: ReadonlyMap<number, ListMemory>
}

/** The shell owns tabs through this reducer; consumers only receive navigation.source/open. */
export function useReadingNavigation(registry: ContentRegistry, splitDefault: boolean): ReadingNavigationHost {
  const [state, dispatch] = useReducer(navigationReducer, INITIAL_NAVIGATION_STATE)
  const current = useRef({ state, splitDefault })
  const [driver] = useState(() => createReadingNavigation({
    getTabs: () => current.current.state.tabs,
    dispatch,
    registry,
    getSplitDefault: () => current.current.splitDefault
  }))
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    driver.mount()
    return () => {
      mounted.current = false
      // React StrictMode immediately replays setup; a real unmount settles all outstanding calls.
      queueMicrotask(() => { if (!mounted.current) driver.dispose() })
    }
  }, [driver])
  useLayoutEffect(() => {
    current.current = { state, splitDefault }
  }, [state, splitDefault])
  // Caller authorization reads refs updated by the shell's later layout effects too.
  useEffect(() => {
    driver.committed(state)
  }, [driver, state])
  const seeds = useMemo(() => navigationSeeds(state), [state.receipts])
  return { tabs: state.tabs, dispatch, navigation: driver.navigation, seeds }
}
