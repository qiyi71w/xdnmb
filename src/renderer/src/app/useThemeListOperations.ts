import { useCallback, useMemo, useRef, useState } from 'react'
import type { AppSettings } from '../../../shared/settings'
import type { CustomTheme } from '../../../shared/theme'
import { deleteTheme, restoreTheme, saveCurrentTheme, type DeletedTheme, type ThemeListResult } from '../../../shared/themeList'

/** A theme list operation refused because the theme in use has unsaved edits: save or discard them first. */
export interface ThemeListLocked {
  ok: false
  reason: 'unsaved'
}

const LOCKED: ThemeListLocked = { ok: false, reason: 'unsaved' }

/** Why 撤销 did not put a deleted theme back: the list was full, the settings were not saved, or there were unsaved edits. */
export type ThemeRestoreFailure = 'full' | 'not-saved' | 'unsaved'

/** The latest deleted theme, which 撤销 puts back. */
export interface ThemeDeletion {
  /** New for each deletion. */
  key: number
  deleted: DeletedTheme
  restoring: boolean
  failure: ThemeRestoreFailure | null
}

export interface ThemeListQueue {
  /**
   * Runs `operation` on the settings the previous operation left and saves its patch as one update
   * (shown once saved). Resolves the result, `{ ok: false, reason: 'unsaved' }` without running it
   * while the theme in use has unsaved edits, or null when it was not saved.
   */
  run: <R extends ThemeListResult>(operation: (current: AppSettings) => R) => Promise<R | ThemeListLocked | null>
  /** 保存: writes the edited theme in use, in the same queue; the one operation unsaved edits allow. */
  save: (theme: CustomTheme) => Promise<ThemeListResult | null>
}

export interface ThemeListOperations extends ThemeListQueue {
  /** Deletes the theme named `name`; it becomes the one deletion 撤销 can undo. Resolves whether it was deleted. */
  remove: (name: string) => Promise<boolean>
  deletion: ThemeDeletion | null
  /** 撤销: puts the deleted theme back; a failure keeps the deletion with its reason. */
  undo: () => void
  /** The deletion `key` can no longer be undone (its notice closed). */
  forget: (key: number) => void
}

/**
 * One operation after another, so each one sees what the previous one saved. While `unsaved()` holds
 * (checked when an operation's turn comes) every list operation is refused, so the edits are never
 * dropped by a change of the theme in use; only saving them runs.
 */
export function themeListQueue(
  commit: (patch: Partial<AppSettings>) => Promise<boolean>,
  latest: () => AppSettings,
  unsaved: () => boolean
): ThemeListQueue {
  let queue: Promise<unknown> = Promise.resolve()
  const queued = <T>(task: () => Promise<T>): Promise<T> => {
    const done = queue.then(task)
    queue = done.catch(() => undefined)
    return done
  }
  const apply = async <R extends ThemeListResult>(result: R): Promise<R | null> => (!result.ok ? result : (await commit(result.patch)) ? result : null)
  return {
    run: <R extends ThemeListResult>(operation: (current: AppSettings) => R) =>
      queued<R | ThemeListLocked | null>(async () => (unsaved() ? LOCKED : apply(operation(latest())))),
    save: (theme) => queued(async () => apply(saveCurrentTheme(latest(), theme)))
  }
}

/**
 * The theme list operations of 设置 › 外观 and of the 主题已删除 notice, which outlives the settings
 * tab (themeListQueue). Only the latest deletion can be undone; another deletion ends it.
 */
export function useThemeListOperations(
  commit: (patch: Partial<AppSettings>) => Promise<boolean>,
  latest: () => AppSettings,
  unsaved: () => boolean
): ThemeListOperations {
  const { run, save } = useMemo(() => themeListQueue(commit, latest, unsaved), [commit, latest, unsaved])

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

  return useMemo(() => ({ run, save, remove, deletion, undo, forget }), [run, save, remove, deletion, undo, forget])
}
