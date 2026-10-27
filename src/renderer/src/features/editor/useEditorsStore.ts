import { reportContent } from '../../../../shared/report'
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import { targetKey, type AttachmentId, type EditorId, type PostTarget, type SavedDraft } from '../../../../shared/drafts'
import { isSent, isUnsettled, type PublicationAttempt, type SubmitResult } from '../../../../shared/publication'
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
import type { SendOrigin } from './sendFollowUp'

/**
 * Why a save did not replace the saved version; `locked`: a send holds the editor or the draft
 * (unresolved attempt); `internal`: the request itself failed.
 */
export type SaveFailure = 'storage' | 'not-found' | 'attachment-missing' | 'locked' | 'internal'

export type SaveOutcome = { ok: true } | { ok: false; reason: SaveFailure }

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

export type PromptChoice = 'switch' | 'current' | 'cancel'

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
  /** Editors whose save request is running. */
  saving: ReadonlySet<EditorId>
  /** Last failed save of each editor, until it is saved, discarded or saved again. */
  saveErrors: ReadonlyMap<EditorId, SaveFailure>
  /**
   * Saves the editor as a draft (new or replacing its version). Never runs two saves of one editor
   * at once: while one runs, the call waits for it and then saves again only if edits made
   * meanwhile are still unsaved, so success always covers the contents at the time of the call.
   * A locked editor (see `Editor.publication`) is never saved.
   */
  save: (editorId: EditorId) => Promise<SaveOutcome>
  /**
   * The one send handler of every entry (button, Ctrl/Cmd+Enter) in tab `tabId`: locks the editor,
   * waits for a running save, then submits its contents once with a fresh request ID. Ignored
   * while locked.
   */
  send: (editorId: EditorId, tabId: number) => Promise<void>
  /** Answers the PO identity question holding the editor's frozen payload. */
  resolvePrompt: (editorId: EditorId, choice: PromptChoice, suppress: boolean) => Promise<void>
  /** Looks up again, by its request ID, whether an uncertain request left an attempt. */
  recheck: (editorId: EditorId) => Promise<void>
  /** Sent sends with their post known, by `focusKey`, until a new editor opens there or the tab closes. */
  published: ReadonlyMap<string, PublishedNote>
  clearPublished: (key: string) => void
  /** Grows whenever a send created or changed an attempt, saved a draft or ended an editor. */
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
 * panels unmounting, thread switches and content refreshes. Holds each editor's attachment copy
 * in the main process while the editor shows it, and releases editors that are gone.
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

  const dispatch = useCallback(
    (action: EditorsAction) => {
      if (action.type === 'discard' || action.type === 'discard-undoable') clearError(action.editorId)
      if (action.type === 'close-tab') {
        const prefix = `${action.tabId}|`
        setPublished((previous) => {
          const kept = new Map([...previous].filter(([key]) => !key.startsWith(prefix)))
          return kept.size === previous.size ? previous : kept
        })
      }
      rawDispatch(action)
    },
    [clearError]
  )

  /** The draft each editor's latest successful save produced, before the reducer state reflects it. */
  const lastSaved = useRef(new Map<EditorId, SavedDraft>())

  const save = useCallback(
    (editorId: EditorId): Promise<SaveOutcome> => {
      const running = inflight.current.get(editorId)
      if (running !== undefined) {
        // Edits made while that save ran are not in it: once it succeeds, save again if anything is left.
        return running.then((outcome) => {
          if (!outcome.ok) return outcome
          const latest = stateRef.current.editors.find((item) => item.id === editorId)
          if (latest === undefined || latest.publication !== null) return outcome
          return isUnsaved(withLastSaved(latest, lastSaved.current)) ? save(editorId) : outcome
        })
      }
      const found = stateRef.current.editors.find((item) => item.id === editorId)
      if (found === undefined) return Promise.resolve({ ok: false, reason: 'internal' })
      if (found.publication !== null) return Promise.resolve({ ok: false, reason: 'locked' })
      const input = saveInput(withLastSaved(found, lastSaved.current))
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
      sentFrom.current.delete(editorId)
      // A question nobody can answer any more: cancel it (no identity change, no request).
      const token = promptTokens.current.get(editorId)
      if (token !== undefined) {
        promptTokens.current.delete(editorId)
        window.xidao.publication.resolvePrompt({ token, choice: 'cancel', suppress: false }).catch(() => undefined)
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
  const bump = useCallback(() => setPublicationRevision((revision) => revision + 1), [])
  const find = useCallback((editorId: EditorId) => stateRef.current.editors.find((item) => item.id === editorId), [])

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
      rawDispatch({ type: 'publish-failed', editorId, problem: attempt.problem, draft: saved })
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
            window.xidao.publication.resolvePrompt({ token: result.prompt.token, choice: 'cancel', suppress: false }).catch(() => undefined)
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
        clearError(editorId)
        // A running save may be creating this editor's draft: the attempt must reference it.
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
    [find, clearError, lookup, handleResult]
  )

  const resolvePrompt = useCallback(
    async (editorId: EditorId, choice: PromptChoice, suppress: boolean) => {
      const publication = find(editorId)?.publication
      if (publication?.phase !== 'prompt' || publication.resolving || handling.current.has(editorId)) return
      handling.current.add(editorId)
      rawDispatch({ type: 'publish-resolving', editorId, resolving: true })
      try {
        const result = await window.xidao.publication.resolvePrompt({ token: publication.prompt.token, choice, suppress })
        await handleResult(editorId, publication.requestId, result)
      } catch {
        promptTokens.current.delete(editorId)
        if (choice === 'cancel') {
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
      save,
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
      save,
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
