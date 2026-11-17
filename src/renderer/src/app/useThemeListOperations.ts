import { useCallback, useMemo, useRef, useState } from 'react'
import type { AppSettings } from '../../../shared/settings'
import { deleteTheme, restoreTheme, type DeletedTheme, type ThemeListResult } from '../../../shared/themeList'

/** Why 撤销 did not put a deleted theme back: the list was full, or the settings were not saved. */
export type ThemeRestoreFailure = 'full' | 'not-saved'

/** The latest deleted theme, which 撤销 puts back. */
export interface ThemeDeletion {
  /** New for each deletion. */
  key: number
  deleted: DeletedTheme
  restoring: boolean
  failure: ThemeRestoreFailure | null
}

export interface ThemeListOperations {
  /**
   * Runs `operation` on the settings the previous operation left and saves its patch as one update
   * (shown once saved). Resolves the result, or null when it was not saved.
   */
  run: <R extends ThemeListResult>(operation: (current: AppSettings) => R) => Promise<R | null>
  /** Deletes the theme named `name`; it becomes the one deletion 撤销 can undo. Resolves whether it was deleted. */
  remove: (name: string) => Promise<boolean>
  deletion: ThemeDeletion | null
  /** 撤销: puts the deleted theme back; a failure keeps the deletion with its reason. */
  undo: () => void
  /** The deletion `key` can no longer be undone (its notice closed). */
  forget: (key: number) => void
}

/**
 * The theme list operations of 设置 › 外观 and of the 主题已删除 notice, which outlives the settings
 * tab: they run one after another, so each one sees what the previous one saved. Only the latest
 * deletion can be undone; another deletion ends it.
 */
export function useThemeListOperations(commit: (patch: Partial<AppSettings>) => Promise<boolean>, latest: () => AppSettings): ThemeListOperations {
  const queue = useRef<Promise<unknown>>(Promise.resolve())
  const run = useCallback(
    <R extends ThemeListResult>(operation: (current: AppSettings) => R): Promise<R | null> => {
      const done = queue.current.then(async () => {
        const result = operation(latest())
        if (!result.ok) return result
        return (await commit(result.patch)) ? result : null
      })
      queue.current = done.catch(() => undefined)
      return done
    },
    [commit, latest]
  )

  const sequence = useRef(0)
  const [deletion, setDeletion] = useState<ThemeDeletion | null>(null)
  const remove = useCallback(
    async (name: string) => {
      const result = await run((current) => deleteTheme(current, name))
      if (result === null || !result.ok) return false
      setDeletion({ key: ++sequence.current, deleted: result.deleted, restoring: false, failure: null })
      return true
    },
    [run]
  )

  const undo = useCallback(() => {
    if (deletion === null || deletion.restoring) return
    const { key, deleted } = deletion
    setDeletion({ ...deletion, restoring: true, failure: null })
    void run((current) => restoreTheme(current, deleted)).then((result) => {
      const failure = result === null ? 'not-saved' : result.ok ? null : result.reason
      setDeletion((previous) => (previous?.key !== key ? previous : failure === null ? null : { ...previous, restoring: false, failure }))
    })
  }, [deletion, run])

  const forget = useCallback((key: number) => setDeletion((previous) => (previous?.key === key ? null : previous)), [])

  return useMemo(() => ({ run, remove, deletion, undo, forget }), [run, remove, deletion, undo, forget])
}
