import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react'

/**
 * Coverage: whether a blocking layer lies over the whole app — a modal dialog (`Modal`: drafts,
 * send records, quit / close questions, …), the compose dialog or a post's context menu. While
 * covered, app shortcuts and list-level Esc stand aside for that layer.
 */
export interface Coverage {
  /** Something covers the app. */
  covered: boolean
  /** Covers the app until the returned release runs. */
  cover: () => () => void
}

const NO_COVERAGE: Coverage = { covered: false, cover: () => () => undefined }

/** Provide the app's coverage made by `useAppCoverage`, once at the app root. */
export const AppCoveredContext = createContext<Coverage>(NO_COVERAGE)

/** The app's coverage: covered while any cover is registered. */
export function useAppCoverage(): Coverage {
  const [count, setCount] = useState(0)
  const cover = useCallback(() => {
    let released = false
    setCount((value) => value + 1)
    return () => {
      if (released) return
      released = true
      setCount((value) => value - 1)
    }
  }, [])
  const covered = count > 0
  return useMemo(() => ({ covered, cover }), [covered, cover])
}

/** Whether something covers the app. */
export function useAppCovered(): boolean {
  return useContext(AppCoveredContext).covered
}

/**
 * Covers the app while `active`. Registered in a layout effect: the cover is in place before the
 * covering layer is painted.
 */
export function useCover(active: boolean): void {
  const { cover } = useContext(AppCoveredContext)
  useLayoutEffect(() => (active ? cover() : undefined), [active, cover])
}
