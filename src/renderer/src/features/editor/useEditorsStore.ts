import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { targetKey, type AttachmentId, type EditorId, type PostTarget, type SavedDraft } from '../../../../shared/drafts'
import {
  attachmentHolds,
  editorsReducer,
  INITIAL_EDITORS,
  isUnsaved,
  saveInput,
  type Editor,
  type EditorsAction,
  type EditorsState
} from './editorsState'

/** Why a save did not replace the saved version; `internal`: the request itself failed. */
export type SaveFailure = 'storage' | 'not-found' | 'attachment-missing' | 'internal'

export type SaveOutcome = { ok: true } | { ok: false; reason: SaveFailure }

/** Where keyboard focus should go next: the panel of this tab's editor for this target. */
export function focusKey(tabId: number, target: PostTarget): string {
  return `${tabId}|${targetKey(target)}`
}

export interface EditorsStore {
  state: EditorsState
  dispatch: (action: EditorsAction) => void
  /** Latest committed state, for event handlers that run outside render. */
  current: () => EditorsState
  /** Editors whose save request is running. */
  saving: ReadonlySet<EditorId>
  /** Last failed save of each editor, until it is saved, discarded or saved again. */
  saveErrors: ReadonlyMap<EditorId, SaveFailure>
  /**
   * Saves the editor as a draft (new or replacing its version). Never runs two saves of one editor
   * at once: while one runs, the call waits for it and then saves again only if edits made
   * meanwhile are still unsaved, so success always covers the contents at the time of the call.
   */
  save: (editorId: EditorId) => Promise<SaveOutcome>
  /** Panel to focus once it is displayed (see `focusKey`). */
  focusRequest: string | null
  requestFocus: (key: string | null) => void
}

/**
 * The app-level store of all editors. Lives beside the tab state, so editors survive their
 * panels unmounting, thread switches and content refreshes. Holds each editor's attachment copy
 * in the main process while the editor shows it, and releases editors that are gone.
 */
export function useEditorsStore(): EditorsStore {
  const [state, rawDispatch] = useReducer(editorsReducer, INITIAL_EDITORS)
  const [saving, setSaving] = useState<ReadonlySet<EditorId>>(() => new Set())
  const [saveErrors, setSaveErrors] = useState<ReadonlyMap<EditorId, SaveFailure>>(() => new Map())
  const [focusRequest, requestFocus] = useState<string | null>(null)
  const stateRef = useRef(state)
  useLayoutEffect(() => {
    stateRef.current = state
  })
  const inflight = useRef(new Map<EditorId, Promise<SaveOutcome>>())

  const clearError = useCallback((editorId: EditorId) => {
    setSaveErrors((previous) => {
      if (!previous.has(editorId)) return previous
      const next = new Map(previous)
      next.delete(editorId)
      return next
    })
  }, [])

  const dispatch = useCallback(
    (action: EditorsAction) => {
      if (action.type === 'discard') clearError(action.editorId)
      rawDispatch(action)
    },
    [clearError]
  )

  /** The draft each editor's latest successful save produced, before the reducer state reflects it. */
  const lastSaved = useRef(new Map<EditorId, SavedDraft>())

  const save = useCallback(
    (editorId: EditorId): Promise<SaveOutcome> => {
      /** The editor with the draft its latest save produced, even if the reducer has not re-rendered yet. */
      const withLastSaved = (editor: Editor): Editor => {
        const saved = lastSaved.current.get(editor.id)
        if (saved === undefined) return editor
        if (editor.draft !== null && (editor.draft.id !== saved.id || editor.draft.version >= saved.version)) return editor
        return { ...editor, draft: saved }
      }
      const running = inflight.current.get(editorId)
      if (running !== undefined) {
        // Edits made while that save ran are not in it: once it succeeds, save again if anything is left.
        return running.then((outcome) => {
          if (!outcome.ok) return outcome
          const latest = stateRef.current.editors.find((item) => item.id === editorId)
          return latest === undefined || !isUnsaved(withLastSaved(latest)) ? outcome : save(editorId)
        })
      }
      const found = stateRef.current.editors.find((item) => item.id === editorId)
      if (found === undefined) return Promise.resolve({ ok: false, reason: 'internal' })
      const input = saveInput(withLastSaved(found))
      clearError(editorId)
      setSaving((previous) => new Set(previous).add(editorId))
      const run = (async (): Promise<SaveOutcome> => {
        let outcome: SaveOutcome
        try {
          const result = await window.xidao.drafts.save(input)
          if (result.ok) {
            lastSaved.current.set(editorId, result.draft)
            rawDispatch({ type: 'saved', editorId, draft: result.draft })
            outcome = { ok: true }
          } else outcome = { ok: false, reason: result.reason }
        } catch {
          outcome = { ok: false, reason: 'internal' }
        }
        inflight.current.delete(editorId)
        setSaving((previous) => {
          const next = new Set(previous)
          next.delete(editorId)
          return next
        })
        if (!outcome.ok) {
          const reason = outcome.reason
          setSaveErrors((previous) => new Map(previous).set(editorId, reason))
        }
        return outcome
      })()
      inflight.current.set(editorId, run)
      return run
    },
    [clearError]
  )

  // Attachment copies: hold what each editor shows now; release editors that no longer exist.
  const holds = useRef(new Map<EditorId, AttachmentId | null>())
  useEffect(() => {
    const next = attachmentHolds(state)
    const previous = holds.current
    for (const [editorId, attachmentId] of next) {
      const before = previous.has(editorId) ? previous.get(editorId) : null
      if (before !== attachmentId) window.xidao.drafts.holdAttachment({ editorId, attachmentId }).catch(() => undefined)
    }
    const gone: EditorId[] = []
    for (const editorId of previous.keys()) {
      if (next.has(editorId)) continue
      gone.push(editorId)
      window.xidao.drafts.releaseEditor({ editorId }).catch(() => undefined)
    }
    holds.current = next
    if (gone.length > 0) {
      setSaveErrors((errors) => {
        if (!gone.some((editorId) => errors.has(editorId))) return errors
        const kept = new Map(errors)
        for (const editorId of gone) kept.delete(editorId)
        return kept
      })
    }
  }, [state])

  const current = useCallback(() => stateRef.current, [])

  return useMemo(
    () => ({ state, dispatch, current, saving, saveErrors, save, focusRequest, requestFocus }),
    [state, dispatch, current, saving, saveErrors, save, focusRequest]
  )
}
