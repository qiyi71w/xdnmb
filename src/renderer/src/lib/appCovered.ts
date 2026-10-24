import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react'

/**
 * Coverage: whether something blocking lies over content. Content behind a cover is not in view,
 * so foreground reading (the read judgement) is suspended while it is open and unfinished dwells
 * start afresh once it closes (spec I6). This is the one mechanism for every blocking layer:
 * - modal dialogs (`Modal`: settings, drafts, send records, quit / close questions, …) cover the
 *   whole app;
 * - overlays inside a reader (its image viewer, its 提醒 panel) cover that reader's scope.
 */
export interface Coverage {
  /** Something covers this scope or a scope around it. */
  covered: boolean
  /** Covers this scope until the returned release runs. */
  cover: () => () => void
  /** Covers the whole app until the returned release runs. */
  coverApp: () => () => void
}

const NO_SCOPE: Coverage = { covered: false, cover: () => () => undefined, coverApp: () => () => undefined }

/** Provide a scope made by `useCoverageScope`: the app root once, then one per reader. */
export const AppCoveredContext = createContext<Coverage>(NO_SCOPE)

/**
 * A coverage scope nested in the current one; the first one (no scope around it) is the app.
 * Covered while any cover of its own is registered or the scope around it is covered.
 */
export function useCoverageScope(): Coverage {
  const parent = useContext(AppCoveredContext)
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
  const coverApp = parent === NO_SCOPE ? cover : parent.coverApp
  const covered = parent.covered || count > 0
  return useMemo(() => ({ covered, cover, coverApp }), [covered, cover, coverApp])
}

/** Whether something covers the content of the current scope. */
export function useAppCovered(): boolean {
  return useContext(AppCoveredContext).covered
}

/**
 * Covers the current scope (`'scope'`) or the whole app (`'app'`) while `active`. Registered in a
 * layout effect: the cover is in place before the covering layer is painted.
 */
export function useCover(active: boolean, extent: 'scope' | 'app' = 'scope'): void {
  const { cover, coverApp } = useContext(AppCoveredContext)
  const register = extent === 'app' ? coverApp : cover
  useLayoutEffect(() => (active ? register() : undefined), [active, register])
}
