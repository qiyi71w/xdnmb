import { reportContent } from '../../../../shared/report'
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { targetKey, type DraftContent, type EditorId, type PostTarget, type SavedDraft } from '../../../../shared/drafts'
import { isSent, isUnsettled, type PoAnswer, type PublicationAttempt, type SubmitResult } from '../../../../shared/publication'
import {
  attachmentHolds,
  editorForDraft,
  editorsReducer,
  INITIAL_EDITORS,
  isBlank,
  saveInput,
  wantsWrite,
  type Editor,
  type EditorsAction,
  type EditorsState
} from './editorsState'
import type { SendOrigin } from './sendFollowUp'

/**
 * Why an editor's draft could not be brought up to date; `locked`: a send holds the editor or the
 * draft (unresolved attempt); `internal`: the request itself failed.
 */
export type SaveFailure = 'storage' | 'not-found' | 'attachment-missing' | 'locked' | 'internal'

export type SaveOutcome = { ok: true } | { ok: false; reason: SaveFailure }

/** Quiet time after an editor's last change before its content is saved as its draft. */
export const AUTOSAVE_MS = 1000

/**
 * A draft deleted on request, restorable while its notice is shown. Its image copy is held (by
 * `key`) until then, so undoing brings the image back too. Not kept across a restart.
 */
export interface DeletedDraft {
  key: string
  /** What the draft (or the editor continuing it) held when it was deleted. */
  content: DraftContent
  /** The deletion emptied or closed an editor: undoing opens the restored draft again. */
  reopen: boolean
  restoring: boolean
  /** Why the last undo did not restore it; null when it has not failed. */
  failure: SaveFailure | null
}

/** Where keyboard focus should go next: the panel of this tab's editor for this target. */
export function focusKey(tabId: number, target: PostTarget): string {
  return `${tabId}|${targetKey(target)}`
}

/** A sent send of a tab's editor for a target, with its post known, shown beside that target's entry. */
export interface PublishedNote {
  postId: string
  threadId: string
  isThread: boolean
}

/**
 * How often an editor's attempt is read again while it is `sending`, or `unknown` with its
 * read-only check still to come. Reading never sends anything.
 */
const POLL_MS = 1000

/** The editor with the draft its latest save produced, even if the reducer has not re-rendered yet. */
function withLastSaved(editor: Editor, lastSaved: ReadonlyMap<EditorId, SavedDraft>): Editor {
  const saved = lastSaved.get(editor.id)
  if (saved === undefined) return editor
  if (editor.draft !== null && (editor.draft.id !== saved.id || editor.draft.version >= saved.version)) return editor
  return { ...editor, draft: saved }
}

export interface EditorsStore {
  state: EditorsState
  dispatch: (action: EditorsAction) => void
  /** Latest committed state, for event handlers that run outside render. */
  current: () => EditorsState
  /** Editors whose draft write is running. */
  saving: ReadonlySet<EditorId>
  /** Last failed write of each editor, until a write of it succeeds or starts again. */
  saveErrors: ReadonlyMap<EditorId, SaveFailure>
  /**
   * Brings the editors' drafts up to date now (all editors when omitted), without waiting for the
   * automatic save: content is saved (creating or replacing the draft), and the draft of an editor
   * that was emptied is deleted. Locked editors are not written: one that is still settling its
   * send fails as `locked`; one whose content an attempt holds needs nothing. Resolves to the
   * editors whose write failed.
   */
  flush: (editorIds?: readonly EditorId[]) => Promise<ReadonlyMap<EditorId, SaveFailure>>
  /**
   * Deletes a draft on request. An unlocked editor continuing it is emptied and collapsed
   * (`empty`, from the editor) or closed (`close`, from the library); a locked one refuses (`locked`). The deleted
   * content is kept in `deleted` for undoing.
   */
  deleteDraft: (draft: SavedDraft, editorMode: 'empty' | 'close') => Promise<SaveOutcome>
  /** Deletions that can still be undone, oldest first. */
  deleted: readonly DeletedDraft[]
  /**
   * Saves the deleted content as a draft again; resolves to it (and whether to reopen it), or null
   * when it could not be restored (the entry then says why and stays).
   */
  undoDelete: (key: string) => Promise<{ draft: SavedDraft; reopen: boolean } | null>
  /** The deletion's notice went away: it can no longer be undone and its image copy is released. */
  forgetDeleted: (key: string) => void
  /**
   * Continues `draft` in the editor (same target): the editor's own content is saved first, then
   * replaced. Refused while the editor is locked or when that save fails.
   */
  loadDraft: (editorId: EditorId, draft: SavedDraft) => Promise<SaveOutcome>
  /**
   * The one send handler of every entry (button, Ctrl/Cmd+Enter) in tab `tabId`: locks the editor,
   * waits for a running save, then submits its contents once with a fresh request ID. Ignored
   * while locked.
   */
  send: (editorId: EditorId, tabId: number) => Promise<void>
  /** Answers the PO identity question holding the editor's frozen payload. */
  resolvePrompt: (editorId: EditorId, answer: PoAnswer) => Promise<void>
  /** Looks up again, by its request ID, whether an uncertain request left an attempt. */
  recheck: (editorId: EditorId) => Promise<void>
  /** Sent sends with their post known, by `focusKey`, until a new editor opens there or the tab closes. */
  published: ReadonlyMap<string, PublishedNote>
  clearPublished: (key: string) => void
  /** Grows whenever a send created or changed an attempt, saved a draft or ended an editor, and when the automatic check changed a stored send. */
  publicationRevision: number
  /** Panel to focus once it is displayed (see `focusKey`). */
  focusRequest: string | null
  requestFocus: (key: string | null) => void
}

/**
 * Where each send starts and what its own result does there: `origin` is read when a send in tab
 * `tabId` starts; `settled` hears that send's result with it once the attempt is no longer
 * `sending` (a user's later choice about an ended attempt is not a send result).
 */
export interface SendHooks {
  origin: (tabId: number) => SendOrigin
  settled: (attempt: PublicationAttempt, origin: SendOrigin) => void
}

/**
 * The app-level store of all editors. Lives beside the tab state, so editors survive their
 * panels unmounting, thread switches and content refreshes. Saves each editor's content as its
 * draft `AUTOSAVE_MS` after its last change (and at once whenever the window is hidden). Holds
 * each editor's attachment copy in the main process while the editor shows it, and releases
 * editors that are gone.
 */
export function useEditorsStore(hooks?: SendHooks): EditorsStore {
  const [state, rawDispatch] = useReducer(editorsReducer, INITIAL_EDITORS)
  const [saving, setSaving] = useState<ReadonlySet<EditorId>>(() => new Set())
  const [saveErrors, setSaveErrors] = useState<ReadonlyMap<EditorId, SaveFailure>>(() => new Map())
  const [focusRequest, requestFocus] = useState<string | null>(null)
  const stateRef = useRef(state)
  useLayoutEffect(() => {
    stateRef.current = state
  })
  const inflight = useRef(new Map<EditorId, Promise<SaveOutcome>>())
  /** Open PO question of each editor, cancelled if the editor goes away. */
  const promptTokens = useRef(new Map<EditorId, string>())
  /** Where each editor's running send started, until it has a result or the editor goes away. */
  const sentFrom = useRef(new Map<EditorId, SendOrigin>())

  const clearError = useCallback((editorId: EditorId) => {
    setSaveErrors((previous) => {
      if (!previous.has(editorId)) return previous
      const next = new Map(previous)
      next.delete(editorId)
      return next
    })
  }, [])

  const [published, setPublished] = useState<ReadonlyMap<string, PublishedNote>>(() => new Map())
  const [publicationRevision, setPublicationRevision] = useState(0)

  const clearPublished = useCallback((key: string) => {
    setPublished((previous) => {
      if (!previous.has(key)) return previous
      const next = new Map(previous)
      next.delete(key)
      return next
    })
  }, [])

  const dispatch = useCallback((action: EditorsAction) => {
    if (action.type === 'close-tab') {
      const prefix = `${action.tabId}|`
      setPublished((previous) => {
        const kept = new Map([...previous].filter(([key]) => !key.startsWith(prefix)))
        return kept.size === previous.size ? previous : kept
      })
    }
    rawDispatch(action)
  }, [])

  const find = useCallback((editorId: EditorId) => stateRef.current.editors.find((item) => item.id === editorId), [])
  const bump = useCallback(() => setPublicationRevision((revision) => revision + 1), [])

  /** The draft each editor's latest successful save produced, before the reducer state reflects it. */
  const lastSaved = useRef(new Map<EditorId, SavedDraft>())
  /** The editor's draft is gone (deleted): its last save no longer applies. */
  const forgetDraft = useCallback((editorId: EditorId, draftId: string) => {
    lastSaved.current.delete(editorId)
    rawDispatch({ type: 'draft-cleared', editorId, draftId })
  }, [])

  /**
   * Brings one editor's draft up to date: saves its content (creating or replacing the draft), or
   * deletes the draft of an emptied editor. Never runs two writes of one editor at once: while one
   * runs, the call waits for it and then writes again only if edits made meanwhile are still out of
   * date, so success always covers the contents at the time of the call. A locked editor (see
   * `Editor.publication`) is never written.
   */
  const write = useCallback(
    (editorId: EditorId): Promise<SaveOutcome> => {
      const running = inflight.current.get(editorId)
      if (running !== undefined) {
        return running.then((outcome) => {
          const latest = find(editorId)
          if (latest === undefined || latest.publication !== null) return outcome
          return wantsWrite(withLastSaved(latest, lastSaved.current)) ? write(editorId) : outcome
        })
      }
      const found = find(editorId)
      if (found === undefined) return Promise.resolve({ ok: false, reason: 'internal' })
      if (found.publication !== null) return Promise.resolve({ ok: false, reason: 'locked' })
      const editor = withLastSaved(found, lastSaved.current)
      if (!wantsWrite(editor)) return Promise.resolve({ ok: true })
      clearError(editorId)
      setSaving((previous) => new Set(previous).add(editorId))
      const run = (async (): Promise<SaveOutcome> => {
        let outcome: SaveOutcome
        try {
          if (isBlank(editor)) {
            // Emptied: its draft goes too (nothing to undo; the content was cleared by hand).
            const draftId = editor.draft!.id
            const result = await window.xidao.drafts.delete({ draftId })
            if (result.ok) {
              forgetDraft(editorId, draftId)
              outcome = { ok: true }
            } else outcome = { ok: false, reason: result.reason }
          } else {
            let input = saveInput(editor)
            let result = await window.xidao.drafts.save(input)
            if (!result.ok && result.reason === 'not-found' && input.draftId !== null) {
              // Its draft is gone: keep the content as a new draft rather than losing it.
              forgetDraft(editorId, input.draftId)
              input = { ...input, draftId: null }
              result = await window.xidao.drafts.save(input)
            }
            if (result.ok) {
              lastSaved.current.set(editorId, result.draft)
              rawDispatch({ type: 'saved', editorId, draft: result.draft })
              outcome = { ok: true }
            } else outcome = { ok: false, reason: result.reason }
          }
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
    [clearError, find, forgetDraft]
  )

  // ---------- Automatic saving ----------
  const timers = useRef(new Map<EditorId, number>())
  /** The editor object each timer was set for: any change of the editor restarts its wait. */
  const timed = useRef(new Map<EditorId, Editor>())
  const cancelTimer = useCallback((editorId: EditorId) => {
    const timer = timers.current.get(editorId)
    if (timer !== undefined) window.clearTimeout(timer)
    timers.current.delete(editorId)
  }, [])
  useEffect(() => {
    const present = new Set<EditorId>()
    for (const editor of state.editors) {
      present.add(editor.id)
      const before = timed.current.get(editor.id)
      if (before === editor) continue
      timed.current.set(editor.id, editor)
      cancelTimer(editor.id)
      if (editor.publication !== null || !wantsWrite(withLastSaved(editor, lastSaved.current))) continue
      // Collapsing saves at once; any other change waits for a quiet moment.
      if (before?.expanded === true && !editor.expanded) {
        void write(editor.id)
        continue
      }
      timers.current.set(editor.id, window.setTimeout(() => {
        timers.current.delete(editor.id)
        void write(editor.id)
      }, AUTOSAVE_MS))
    }
    for (const editorId of [...timed.current.keys()]) {
      if (present.has(editorId)) continue
      timed.current.delete(editorId)
      cancelTimer(editorId)
      lastSaved.current.delete(editorId)
    }
  }, [state, cancelTimer, write])

  const flush = useCallback(
    async (editorIds?: readonly EditorId[]): Promise<ReadonlyMap<EditorId, SaveFailure>> => {
      const ids = editorIds ?? stateRef.current.editors.map((editor) => editor.id)
      const failures = new Map<EditorId, SaveFailure>()
      await Promise.all(ids.map(async (editorId) => {
        cancelTimer(editorId)
        const editor = find(editorId)
        if (editor === undefined || editor.publication?.phase === 'attempt') return
        if (!inflight.current.has(editorId) && !wantsWrite(withLastSaved(editor, lastSaved.current))) return
        const outcome = await write(editorId)
        if (!outcome.ok) failures.set(editorId, outcome.reason)
      }))
      return failures
    },
    [cancelTimer, find, write]
  )

  // A hidden window (resident in the background, minimised) may not come back: save now.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void flush()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [flush])

  // ---------- Deleting and undoing ----------
  const [deleted, setDeleted] = useState<readonly DeletedDraft[]>([])
  const deletedRef = useRef(deleted)
  useLayoutEffect(() => {
    deletedRef.current = deleted
  })
  const patchDeleted = useCallback((key: string, patch: Partial<DeletedDraft>) => {
    setDeleted((list) => list.map((item) => (item.key === key ? { ...item, ...patch } : item)))
  }, [])
  const releaseDeleted = useCallback((key: string) => {
    setDeleted((list) => list.filter((item) => item.key !== key))
    window.xidao.drafts.releaseEditor({ editorId: key }).catch(() => undefined)
  }, [])

  const deleteDraft = useCallback(
    async (draft: SavedDraft, editorMode: 'empty' | 'close'): Promise<SaveOutcome> => {
      let editor = editorForDraft(stateRef.current, draft.id)
      if (editor !== null) {
        if (editor.publication !== null) return { ok: false, reason: 'locked' }
        // A running write may be replacing this draft; what the editor shows is what gets deleted.
        cancelTimer(editor.id)
        await inflight.current.get(editor.id)
        editor = find(editor.id) ?? null
        if (editor !== null && editor.publication !== null) return { ok: false, reason: 'locked' }
      }
      const content: DraftContent = editor === null
        ? { target: draft.target, credentialId: draft.credentialId, fields: draft.fields, attachment: draft.attachment }
        : { target: editor.target, credentialId: editor.credentialId, fields: editor.fields, attachment: editor.attachment }
      const key = `undo-${crypto.randomUUID()}`
      try {
        // Hold the image first: deleting the draft reclaims every copy nobody holds.
        if (content.attachment !== null) await window.xidao.drafts.holdAttachment({ editorId: key, attachmentId: content.attachment.id })
        const result = await window.xidao.drafts.delete({ draftId: draft.id })
        if (!result.ok) {
          window.xidao.drafts.releaseEditor({ editorId: key }).catch(() => undefined)
          return { ok: false, reason: result.reason }
        }
      } catch {
        window.xidao.drafts.releaseEditor({ editorId: key }).catch(() => undefined)
        return { ok: false, reason: 'internal' }
      }
      if (editor !== null) {
        lastSaved.current.delete(editor.id)
        clearError(editor.id)
        rawDispatch(editorMode === 'empty' ? { type: 'draft-deleted', editorId: editor.id } : { type: 'close-editor', editorId: editor.id })
      }
      setDeleted((list) => [...list, { key, content, reopen: editor !== null, restoring: false, failure: null }])
      bump()
      return { ok: true }
    },
    [cancelTimer, clearError, find, bump]
  )

  const undoDelete = useCallback(
    async (key: string): Promise<{ draft: SavedDraft; reopen: boolean } | null> => {
      const entry = deletedRef.current.find((item) => item.key === key)
      if (entry === undefined || entry.restoring) return null
      patchDeleted(key, { restoring: true, failure: null })
      const { content } = entry
      let failure: SaveFailure
      try {
        const result = await window.xidao.drafts.save({ draftId: null, target: content.target, credentialId: content.credentialId,
          fields: content.fields, attachmentId: content.attachment?.id ?? null })
        if (result.ok) {
          // The restored draft references the image now: the undo hold can go.
          releaseDeleted(key)
          bump()
          return { draft: result.draft, reopen: entry.reopen }
        }
        failure = result.reason
      } catch {
        failure = 'internal'
      }
      patchDeleted(key, { restoring: false, failure })
      return null
    },
    [patchDeleted, releaseDeleted, bump]
  )

  const forgetDeleted = useCallback((key: string) => {
    if (deletedRef.current.some((item) => item.key === key && !item.restoring)) releaseDeleted(key)
  }, [releaseDeleted])

  const loadDraft = useCallback(
    async (editorId: EditorId, draft: SavedDraft): Promise<SaveOutcome> => {
      const editor = find(editorId)
      if (editor === undefined) return { ok: false, reason: 'internal' }
      if (editor.publication !== null) return { ok: false, reason: 'locked' }
      if (editor.draft?.id === draft.id) {
        rawDispatch({ type: 'set-expanded', editorId, expanded: true })
        return { ok: true }
      }
      // Its own content first, so nothing it holds is lost by continuing another draft.
      const failures = await flush([editorId])
      const failure = failures.get(editorId)
      if (failure !== undefined) return { ok: false, reason: failure }
      if (find(editorId)?.publication !== null) return { ok: false, reason: 'locked' }
      cancelTimer(editorId)
      lastSaved.current.delete(editorId)
      clearError(editorId)
      rawDispatch({ type: 'load-draft', editorId, draft })
      return { ok: true }
    },
    [find, flush, cancelTimer, clearError]
  )

  // Attachment copies: hold what each editor shows now; release editors that no longer exist.
  const holds = useRef(new Map<EditorId, string | null>())
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
      sentFrom.current.delete(editorId)
      // A question nobody can answer any more: cancel it (no identity change, no request).
      const token = promptTokens.current.get(editorId)
      if (token !== undefined) {
        promptTokens.current.delete(editorId)
        window.xidao.publication.resolvePrompt({ token, answer: { kind: 'cancel' } }).catch(() => undefined)
      }
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

  // ---------- Publication ----------

  /** Editors whose send or prompt answer is being handled now (state may not show it yet). */
  const handling = useRef(new Set<EditorId>())
  const hooksRef = useRef(hooks)
  useLayoutEffect(() => {
    hooksRef.current = hooks
  })
  useEffect(() => window.xidao.publication.onChanged(bump), [bump])

  /** Hands a send's result to `hooks.settled` once, then forgets where the send started. */
  const settle = useCallback((editorId: EditorId, attempt: PublicationAttempt | null) => {
    if (attempt?.state === 'sending') return
    const origin = sentFrom.current.get(editorId)
    sentFrom.current.delete(editorId)
    if (attempt !== null && origin !== undefined) hooksRef.current?.settled(attempt, origin)
  }, [])

  /** Applies an attempt of the editor's send; `draft` given when already read with it. */
  const applyAttempt = useCallback(
    async (editorId: EditorId, attempt: PublicationAttempt, draft?: SavedDraft | null) => {
      bump()
      if (isUnsettled(attempt)) {
        rawDispatch({ type: 'publish-attempt', editorId, attempt, readFailed: false })
        settle(editorId, attempt)
        return
      }
      if (isSent(attempt)) {
        const editor = find(editorId)
        const postId = attempt.postId
        if (editor !== undefined && postId !== null) {
          const note: PublishedNote = { postId, threadId: attempt.threadId ?? postId, isThread: attempt.payload.target.kind === 'thread' }
          setPublished((previous) => {
            const next = new Map(previous)
            for (const tabId of editor.tabIds) next.set(focusKey(tabId, editor.target), note)
            return next
          })
        }
        rawDispatch({ type: 'publish-ended', editorId })
        settle(editorId, attempt)
        return
      }
      settle(editorId, attempt)
      // Explicit failure: continue the automatically saved draft (read it when not given).
      let saved = draft ?? null
      if (draft === undefined && attempt.savedDraftId !== null) {
        try {
          const read = await window.xidao.publication.getAttempt({ attemptId: attempt.id })
          if (read.ok) saved = read.draft
        } catch {
          saved = null
        }
      }
      if (saved !== null) lastSaved.current.set(editorId, saved)
      rawDispatch({ type: 'publish-failed', editorId, problem: attempt.problem, forumMessage: attempt.forumMessage, draft: saved })
    },
    [bump, find, settle]
  )

  /** Whether an uncertain request left an attempt: adopt it, or unlock when there is none. */
  const lookup = useCallback(
    async (editorId: EditorId, requestId: string) => {
      rawDispatch({ type: 'publish-uncertain', editorId, requestId, checking: true })
      try {
        const result = await window.xidao.publication.listAttempts()
        if (result.ok) {
          const found = result.attempts.find((attempt) => attempt.requestId === requestId)
          if (found !== undefined) await applyAttempt(editorId, found)
          else {
            settle(editorId, null)
            rawDispatch({ type: 'publish-released', editorId, notice: { kind: 'not-sent' } })
          }
          return
        }
      } catch {
        // Still unknown: stays locked until checked again.
      }
      rawDispatch({ type: 'publish-uncertain', editorId, requestId, checking: false })
    },
    [applyAttempt, settle]
  )

  const handleResult = useCallback(
    async (editorId: EditorId, requestId: string, result: SubmitResult | { kind: 'cancelled' }) => {
      promptTokens.current.delete(editorId)
      switch (result.kind) {
        case 'attempt':
          await applyAttempt(editorId, result.attempt)
          return
        case 'prompt':
          if (find(editorId) === undefined) {
            settle(editorId, null)
            window.xidao.publication.resolvePrompt({ token: result.prompt.token, answer: { kind: 'cancel' } }).catch(() => undefined)
            return
          }
          promptTokens.current.set(editorId, result.prompt.token)
          rawDispatch({ type: 'publish-prompt', editorId, requestId, prompt: result.prompt })
          return
        case 'refused':
          settle(editorId, null)
          rawDispatch({ type: 'publish-released', editorId, notice: { kind: 'refused', reason: result.reason } })
          return
        case 'cancelled':
          settle(editorId, null)
          rawDispatch({ type: 'publish-released', editorId, notice: null })
      }
    },
    [applyAttempt, find, settle]
  )

  const send = useCallback(
    async (editorId: EditorId, tabId: number) => {
      const editor = find(editorId)
      if (editor === undefined || editor.publication !== null || handling.current.has(editorId)) return
      if (editor.report !== undefined && reportContent(editor.report) === null) return
      handling.current.add(editorId)
      const origin = hooksRef.current?.origin(tabId)
      if (origin !== undefined) sentFrom.current.set(editorId, origin)
      const requestId = crypto.randomUUID()
      try {
        // Lock first, so nothing typed from now on can miss the payload or change it.
        rawDispatch({ type: 'publish-start', editorId, requestId })
        cancelTimer(editorId)
        clearError(editorId)
        // A running save may be creating this editor's draft: the attempt must reference it, so a
        // failure writes back to that draft instead of creating a second one.
        await inflight.current.get(editorId)
        const latest = find(editorId) ?? editor
        const payload = saveInput(withLastSaved(latest, lastSaved.current))
        let result: SubmitResult
        try {
          result = await window.xidao.publication.submit({ requestId, editorId, payload })
        } catch {
          await lookup(editorId, requestId)
          return
        }
        await handleResult(editorId, requestId, result)
      } finally {
        handling.current.delete(editorId)
      }
    },
    [find, cancelTimer, clearError, lookup, handleResult]
  )

  const resolvePrompt = useCallback(
    async (editorId: EditorId, answer: PoAnswer) => {
      const publication = find(editorId)?.publication
      if (publication?.phase !== 'prompt' || publication.resolving || handling.current.has(editorId)) return
      handling.current.add(editorId)
      rawDispatch({ type: 'publish-resolving', editorId, resolving: true })
      try {
        const result = await window.xidao.publication.resolvePrompt({ token: publication.prompt.token, answer })
        await handleResult(editorId, publication.requestId, result)
      } catch {
        promptTokens.current.delete(editorId)
        if (answer.kind === 'cancel') {
          settle(editorId, null)
          rawDispatch({ type: 'publish-released', editorId, notice: null })
        } else await lookup(editorId, publication.requestId)
      } finally {
        handling.current.delete(editorId)
      }
    },
    [find, handleResult, lookup, settle]
  )

  const recheck = useCallback(
    async (editorId: EditorId) => {
      const publication = find(editorId)?.publication
      if (publication?.phase !== 'uncertain' || publication.checking || handling.current.has(editorId)) return
      handling.current.add(editorId)
      try {
        await lookup(editorId, publication.requestId)
      } finally {
        handling.current.delete(editorId)
      }
    },
    [find, lookup]
  )

  // While any editor's attempt is sending, or its result is unknown and being checked, read its local
  // record until that settles: sent ends the editor, failed continues its saved draft. Runs for
  // hidden editors too; an editor that went away leaves its attempt to 发送记录 and 草稿.
  const watchedKey = state.editors
    .flatMap((editor) => (editor.publication?.phase === 'attempt' && isUnsettled(editor.publication.attempt) ? [editor.publication.attempt.id] : []))
    .join('|')
  useEffect(() => {
    if (watchedKey === '') return
    let alive = true
    let reading = false
    const tick = async () => {
      if (reading) return
      reading = true
      for (const editor of stateRef.current.editors) {
        const publication = editor.publication
        if (publication?.phase !== 'attempt' || !isUnsettled(publication.attempt)) continue
        let attempt: PublicationAttempt | null = null
        let draft: SavedDraft | null = null
        try {
          const read = await window.xidao.publication.getAttempt({ attemptId: publication.attempt.id })
          if (read.ok) {
            attempt = read.attempt
            draft = read.draft
          }
        } catch {
          attempt = null
        }
        if (!alive) break
        const now = find(editor.id)?.publication
        if (now?.phase !== 'attempt' || now.attempt.id !== publication.attempt.id) continue
        if (attempt === null) {
          // The local record could not be read: say so and keep reading; nothing is sent again.
          if (!now.readFailed) rawDispatch({ type: 'publish-attempt', editorId: editor.id, attempt: now.attempt, readFailed: true })
        } else if (attempt.state !== now.attempt.state || attempt.updatedAt !== now.attempt.updatedAt || now.readFailed) {
          await applyAttempt(editor.id, attempt, draft)
        }
      }
      reading = false
    }
    const timer = window.setInterval(() => void tick(), POLL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [watchedKey, find, applyAttempt])

  const current = useCallback(() => stateRef.current, [])

  return useMemo(
    () => ({
      state,
      dispatch,
      current,
      saving,
      saveErrors,
      flush,
      deleteDraft,
      deleted,
      undoDelete,
      forgetDeleted,
      loadDraft,
      send,
      resolvePrompt,
      recheck,
      published,
      clearPublished,
      publicationRevision,
      focusRequest,
      requestFocus
    }),
    [
      state,
      dispatch,
      current,
      saving,
      saveErrors,
      flush,
      deleteDraft,
      deleted,
      undoDelete,
      forgetDeleted,
      loadDraft,
      send,
      resolvePrompt,
      recheck,
      published,
      clearPublished,
      publicationRevision,
      focusRequest
    ]
  )
}
