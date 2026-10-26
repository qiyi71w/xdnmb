import { parseReportContent, reportDraftContent, type ReportFields } from '../../../../shared/report'
import {
  EMPTY_FIELDS,
  sameTarget,
  type AttachmentId,
  type DraftAttachment,
  type DraftSaveInput,
  type EditorId,
  type IdentityChoice,
  type PostFields,
  type PostTarget,
  type SavedDraft
} from '../../../../shared/drafts'
import type { CredentialId, IdentityOverview } from '../../../../shared/identity'
import type { PoPrompt, PublicationAttempt, PublicationProblem } from '../../../../shared/publication'

/**
 * An explicit send of the editor that has not ended in something the editor can continue from.
 * While it is set the editor is locked: nothing edits, saves, discards, retargets or sends it again.
 * - `submitting`: the send request is on its way to the main process.
 * - `prompt`: the PO identity question holds the frozen payload.
 * - `uncertain`: that request failed inside the app; whether it left a durable attempt is being
 *   (or must be) checked by its `requestId`. Never sent again as a new request.
 * - `attempt`: a durable attempt that is `sending`, `unknown` or `unconfirmed`.
 */
export type EditorPublication =
  | { phase: 'submitting'; requestId: string }
  | { phase: 'prompt'; requestId: string; prompt: PoPrompt; resolving: boolean }
  | { phase: 'uncertain'; requestId: string; checking: boolean }
  | { phase: 'attempt'; attempt: PublicationAttempt; readFailed: boolean }

/** Outcome of the last send shown in an unlocked editor, until the next send. */
export type SendNotice =
  | { kind: 'refused'; reason: PublicationProblem }
  | { kind: 'failed'; problem: PublicationProblem | null; saved: boolean }
  /** An uncertain request turned out to have left no attempt: nothing was sent. */
  | { kind: 'not-sent' }

/**
 * Editors are keyed by target across the window. Tabs that have shown an editor share it;
 * navigation only hides it, and closing its last owning tab ends it after unsaved handling.
 * A saved draft is continued by at most one editor.
 */
export interface Editor {
  id: EditorId
  tabId: number
  /** Tabs sharing this editor; tabId is the most recent explicit opener, for navigation. */
  tabIds: number[]
  target: PostTarget
  /**
   * 发言饼干 fixed when the editor was created (thread selection → global default, or the
   * draft's own) and changed only by an explicit choice in this editor.
   */
  credentialId: CredentialId | null
  /** The stored selections could not be read when the editor started; a choice is required. */
  identityUnknown: boolean
  fields: PostFields
  attachment: DraftAttachment | null
  /** The saved draft this editor continues: the version that discarding returns to. */
  draft: SavedDraft | null
  expanded: boolean
  publication: EditorPublication | null
  sendNotice: SendNotice | null
  report?: ReportFields
  caret?: { offset: number; revision: number }
  discarded?: Pick<Editor, 'target' | 'credentialId' | 'identityUnknown' | 'fields' | 'attachment' | 'report' | 'draft'>
}

export interface EditorsState {
  editors: Editor[]
  nextId: number
}

export const INITIAL_EDITORS: EditorsState = { editors: [], nextId: 1 }

/**
 * Editor IDs are unique per window load: the main process keys send locks and attachment holds by
 * editor ID, and a send started by a closed window can still be running when a new window opens.
 */
const WINDOW_RUN = crypto.randomUUID().slice(0, 8)

function newEditorId(n: number): EditorId {
  return `editor-${WINDOW_RUN}-${n}`
}

export type EditorsAction =
  /**
   * Starts an editor for `target`, or expands the shared editor. Never picks up a saved draft.
   */
  | { type: 'open'; tabId: number; target: PostTarget; identity: IdentityChoice }
  | { type: 'open-quote'; tabId: number; target: PostTarget; identity: IdentityChoice; postId: string }
  | { type: 'open-report'; tabId: number; identity: IdentityChoice; postId: string }
  | { type: 'edit-report'; editorId: EditorId; patch: Partial<ReportFields> }
  /** Continues a saved draft in a tab. Ignored when any editor already continues it. */
  | { type: 'open-draft'; tabId: number; draft: SavedDraft }
  | { type: 'edit'; editorId: EditorId; patch: Partial<PostFields> }
  /** Explicit 发言饼干 choice in this editor only. */
  | { type: 'set-identity'; editorId: EditorId; credentialId: CredentialId }
  | { type: 'set-attachment'; editorId: EditorId; attachment: DraftAttachment | null }
  /** Explicit target change; ignored when another editor already edits that target. */
  | { type: 'retarget'; editorId: EditorId; target: PostTarget }
  | { type: 'set-expanded'; editorId: EditorId; expanded: boolean }
  /** A save of this editor succeeded; later edits made while saving stay unsaved. */
  | { type: 'saved'; editorId: EditorId; draft: SavedDraft }
  /**
   * Drops unsaved changes: a draft editor returns to its saved version, a new editor is removed.
   * When the tab already edits the draft's saved target with another editor, the draft editor is
   * removed instead (its saved version stays in the library), keeping one editor per target.
   */
  | { type: 'discard'; editorId: EditorId }
  | { type: 'discard-undoable'; editorId: EditorId }
  | { type: 'undo-discard'; editorId: EditorId }
  | { type: 'attach-tab'; editorId: EditorId; tabId: number }
  /** Legacy duplicates remain saved drafts; only the newest saved version is reopened. */
  | { type: 'restore-drafts'; items: { tabId: number; expanded: boolean; draft: SavedDraft }[] }
  /** The tab closed after its unsaved editors were handled. */
  | { type: 'close-tab'; tabId: number }
  /** Locks the editor for one explicit send. Ignored while it is already locked. */
  | { type: 'publish-start'; editorId: EditorId; requestId: string }
  | { type: 'publish-prompt'; editorId: EditorId; requestId: string; prompt: PoPrompt }
  | { type: 'publish-resolving'; editorId: EditorId; resolving: boolean }
  | { type: 'publish-uncertain'; editorId: EditorId; requestId: string; checking: boolean }
  /**
   * A durable attempt of this editor that is still unresolved. Its frozen payload's identity is
   * the editor's identity from now on (a PO switch changed it).
   */
  | { type: 'publish-attempt'; editorId: EditorId; attempt: PublicationAttempt; readFailed: boolean }
  /** Nothing was sent (refused, cancelled, or no attempt exists): unlocks the editor. */
  | { type: 'publish-released'; editorId: EditorId; notice: SendNotice | null }
  /** Explicit failure: unlocks and continues the automatically saved draft when there is one. */
  | { type: 'publish-failed'; editorId: EditorId; problem: PublicationProblem | null; draft: SavedDraft | null }
  /** The user answered 没发出 for this editor's attempt: unlocks and continues the draft it went to. */
  | { type: 'publish-withdrawn'; editorId: EditorId; draft: SavedDraft | null }
  /**
   * Removes a locked editor whose content now lives in its durable attempt: sent and confirmed,
   * or ended by the user while the result is unknown / the ID unconfirmed.
   */
  | { type: 'publish-ended'; editorId: EditorId }

function update(state: EditorsState, editorId: EditorId, change: (editor: Editor) => Editor): EditorsState {
  let changed = false
  const editors = state.editors.map((editor) => {
    if (editor.id !== editorId) return editor
    const next = change(editor)
    if (next !== editor) changed = true
    return next
  })
  return changed ? { ...state, editors } : state
}

function fromDraft(draft: SavedDraft): Pick<Editor, 'target' | 'credentialId' | 'fields' | 'attachment' | 'report'> {
  const report = draft.target.kind === 'thread' && draft.target.forumId === '18' ? parseReportContent(draft.fields.content) : undefined
  return { target: draft.target, credentialId: draft.credentialId, fields: { ...draft.fields }, attachment: draft.attachment, report }
}

/** Applies `change` only to an editor no send has locked. */
function unlocked(change: (editor: Editor) => Editor): (editor: Editor) => Editor {
  return (editor) => (editor.publication === null ? change(editor) : editor)
}

/** Changes the publication of a locked editor only. */
function locked(change: (editor: Editor, publication: EditorPublication) => Editor): (editor: Editor) => Editor {
  return (editor) => (editor.publication === null ? editor : change(editor, editor.publication))
}

export function editorsReducer(state: EditorsState, action: EditorsAction): EditorsState {
  switch (action.type) {
    case 'restore-drafts': {
      const items = [...action.items].sort((a, b) => b.draft.savedAt.localeCompare(a.draft.savedAt) || a.draft.id.localeCompare(b.draft.id) || a.tabId - b.tabId)
      return items.reduce((restored, item) => {
        const existing = editorFor(restored, item.draft.target)
        if (existing !== null) return editorsReducer(restored, { type: 'attach-tab', editorId: existing.id, tabId: item.tabId })
        const opened = editorsReducer(restored, { type: 'open-draft', tabId: item.tabId, draft: item.draft })
        const editor = editorFor(opened, item.draft.target)!
        return editorsReducer(opened, { type: 'set-expanded', editorId: editor.id, expanded: item.expanded })
      }, state)
    }
    case 'open-quote': {
      const opened = editorsReducer(state, { type: 'open', tabId: action.tabId, target: action.target, identity: action.identity })
      const editor = editorFor(opened, action.target)!
      return update(opened, editor.id, unlocked((item) => {
        const content = `${item.fields.content}${item.fields.content !== '' && !item.fields.content.endsWith('\n') ? '\n' : ''}>>No.${action.postId}\n`
        return { ...item, discarded: undefined, fields: { ...item.fields, content }, caret: { offset: content.length, revision: (item.caret?.revision ?? 0) + 1 } }
      }))
    }
    case 'open-report': {
      const target: PostTarget = { kind: 'thread', forumId: '18' }
      const opened = editorsReducer(state, { type: 'open', tabId: action.tabId, target, identity: action.identity })
      const editor = editorFor(opened, target)!
      const report = { postId: action.postId, reason: editor.report?.reason ?? '', customReason: editor.report?.customReason ?? '', text: editor.report?.text ?? editor.fields.content }
      return update(opened, editor.id, unlocked((item) => ({ ...item, discarded: undefined, report, fields: { ...item.fields, content: reportDraftContent(report) } })))
    }
    case 'edit-report':
      return update(state, action.editorId, unlocked((item) => {
        if (item.report === undefined) return item
        const report = { ...item.report, ...action.patch }
        return { ...item, discarded: undefined, report, fields: { ...item.fields, content: reportDraftContent(report) } }
      }))
    case 'open': {
      const existing = editorFor(state, action.target)
      if (existing !== null) return update(state, existing.id, (editor) => ({ ...editor, tabId: action.tabId,
        tabIds: editor.tabIds.includes(action.tabId) ? editor.tabIds : [...editor.tabIds, action.tabId], expanded: true }))
      const identity = action.identity
      const editor: Editor = {
        id: newEditorId(state.nextId),
        tabId: action.tabId,
        tabIds: [action.tabId],
        target: action.target,
        credentialId: identity.source === 'unknown' || identity.selection.state === 'none' ? null : identity.selection.credentialId,
        identityUnknown: identity.source === 'unknown',
        fields: { ...EMPTY_FIELDS },
        attachment: null,
        draft: null,
        expanded: true,
        publication: null,
        sendNotice: null
      }
      return { editors: [...state.editors, editor], nextId: state.nextId + 1 }
    }
    case 'open-draft': {
      const existing = editorForDraft(state, action.draft.id)
      if (existing !== null) return editorsReducer(state, { type: 'attach-tab', editorId: existing.id, tabId: action.tabId })
      if (editorFor(state, action.draft.target) !== null) return state
      const editor: Editor = {
        id: newEditorId(state.nextId),
        tabId: action.tabId,
        tabIds: [action.tabId],
        ...fromDraft(action.draft),
        identityUnknown: false,
        draft: action.draft,
        expanded: true,
        publication: null,
        sendNotice: null
      }
      return { editors: [...state.editors, editor], nextId: state.nextId + 1 }
    }
    case 'edit':
      return update(
        state,
        action.editorId,
        unlocked((editor) => ({ ...editor, discarded: undefined, caret: undefined, fields: { ...editor.fields, ...action.patch } }))
      )
    case 'set-identity':
      return update(
        state,
        action.editorId,
        unlocked((editor) => ({ ...editor, discarded: undefined, credentialId: action.credentialId, identityUnknown: false }))
      )
    case 'set-attachment':
      return update(state, action.editorId, unlocked((editor) => ({ ...editor, discarded: undefined, attachment: action.attachment })))
    case 'retarget':
      return update(
        state,
        action.editorId,
        unlocked((editor) => {
          if (sameTarget(editor.target, action.target)) return editor
          if (editorFor(state, action.target) !== null) return editor
          return { ...editor, discarded: undefined, target: action.target }
        })
      )
    case 'set-expanded':
      return update(state, action.editorId, (editor) => (editor.expanded === action.expanded ? editor : { ...editor, expanded: action.expanded, discarded: action.expanded ? editor.discarded : undefined }))
    case 'saved':
      return update(state, action.editorId, (editor) => ({ ...editor, draft: action.draft }))
    case 'discard': {
      const editor = state.editors.find((item) => item.id === action.editorId)
      if (editor === undefined || editor.publication !== null) return state
      const draft = editor.draft
      const occupant = draft === null ? null : editorFor(state, draft.target)
      if (draft === null || (occupant !== null && occupant.id !== editor.id)) {
        return { ...state, editors: state.editors.filter((item) => item.id !== editor.id) }
      }
      return update(state, editor.id, (item) => ({ ...item, ...fromDraft(draft), identityUnknown: false, discarded: undefined, caret: undefined }))
    }
    case 'discard-undoable':
      return update(state, action.editorId, unlocked((editor) => {
        if (editor.discarded !== undefined && !isUnsaved(editor)) return editor
        const { target, credentialId, identityUnknown, fields, attachment, report, draft } = editor
        const discarded = { target, credentialId, identityUnknown, fields, attachment, report, draft }
        const occupant = draft === null ? null : editorFor(state, draft.target)
        if (draft === null || (occupant !== null && occupant.id !== editor.id)) {
          return { ...editor, caret: undefined, fields: { ...EMPTY_FIELDS }, attachment: null, report: undefined, draft: null, discarded }
        }
        return { ...editor, ...fromDraft(draft), caret: undefined, identityUnknown: false, discarded }
      }))
    case 'undo-discard':
      return update(state, action.editorId, unlocked((editor) => {
        if (editor.discarded === undefined) return editor
        const occupant = editorFor(state, editor.discarded.target)
        if (occupant !== null && occupant.id !== editor.id) return editor
        return { ...editor, ...editor.discarded, discarded: undefined }
      }))
    case 'attach-tab':
      return update(state, action.editorId, (editor) => editor.tabIds.includes(action.tabId)
        ? editor : { ...editor, tabIds: [...editor.tabIds, action.tabId] })
    case 'close-tab': {
      const editors = state.editors.flatMap((editor) => {
        if (!editor.tabIds.includes(action.tabId)) return [editor]
        const tabIds = editor.tabIds.filter((id) => id !== action.tabId)
        return tabIds.length === 0 ? [] : [{ ...editor, tabIds, tabId: editor.tabId === action.tabId ? tabIds[0]! : editor.tabId }]
      })
      return editors.every((editor, index) => editor === state.editors[index]) && editors.length === state.editors.length ? state : { ...state, editors }
    }
    case 'publish-start':
      return update(
        state,
        action.editorId,
        unlocked((editor) => ({ ...editor, discarded: undefined, publication: { phase: 'submitting', requestId: action.requestId }, sendNotice: null }))
      )
    case 'publish-prompt':
      return update(
        state,
        action.editorId,
        locked((editor) => ({
          ...editor,
          publication: { phase: 'prompt', requestId: action.requestId, prompt: action.prompt, resolving: false }
        }))
      )
    case 'publish-resolving':
      return update(
        state,
        action.editorId,
        locked((editor, publication) =>
          publication.phase === 'prompt' && publication.resolving !== action.resolving
            ? { ...editor, publication: { ...publication, resolving: action.resolving } }
            : editor
        )
      )
    case 'publish-uncertain':
      return update(
        state,
        action.editorId,
        locked((editor) => ({ ...editor, publication: { phase: 'uncertain', requestId: action.requestId, checking: action.checking } }))
      )
    case 'publish-attempt':
      return update(
        state,
        action.editorId,
        locked((editor) => ({
          ...editor,
          credentialId: action.attempt.payload.credentialId,
          identityUnknown: false,
          publication: { phase: 'attempt', attempt: action.attempt, readFailed: action.readFailed }
        }))
      )
    case 'publish-released':
      return update(state, action.editorId, locked((editor) => ({ ...editor, publication: null, sendNotice: action.notice })))
    case 'publish-failed':
    case 'publish-withdrawn':
      return update(
        state,
        action.editorId,
        locked((editor) => {
          const notice: SendNotice = action.type === 'publish-failed'
            ? { kind: 'failed', problem: action.problem, saved: action.draft !== null }
            : { kind: 'not-sent' }
          const draft = action.draft
          if (draft === null) return { ...editor, publication: null, sendNotice: notice }
          return { ...editor, ...fromDraft(draft), identityUnknown: false, draft, publication: null, sendNotice: notice }
        })
      )
    case 'publish-ended': {
      const editors = state.editors.filter((editor) => editor.id !== action.editorId || editor.publication === null)
      return editors.length === state.editors.length ? state : { ...state, editors }
    }
  }
}

export function editorFor(state: EditorsState, target: PostTarget): Editor | null {
  return state.editors.find((editor) => sameTarget(editor.target, target)) ?? null
}

export function editorForDraft(state: EditorsState, draftId: string): Editor | null {
  return state.editors.find((editor) => editor.draft?.id === draftId) ?? null
}

function sameFields(a: PostFields, b: PostFields): boolean {
  return a.content === b.content && a.title === b.title && a.name === b.name && a.email === b.email && a.watermark === b.watermark
}

function attachmentId(attachment: DraftAttachment | null): AttachmentId | null {
  return attachment?.id ?? null
}

/**
 * Whether the editor holds anything not in a saved version. A new editor counts once it has
 * text or an image; target and identity alone are nothing to save. A draft editor counts as soon
 * as anything differs from its saved version.
 */
export function isUnsaved(editor: Editor): boolean {
  const draft = editor.draft
  if (draft === null) {
    const { content, title, name, email } = editor.fields
    return content !== '' || title !== '' || name !== '' || email !== '' || editor.attachment !== null
  }
  return (
    !sameTarget(editor.target, draft.target) ||
    editor.credentialId !== draft.credentialId ||
    !sameFields(editor.fields, draft.fields) ||
    attachmentId(editor.attachment) !== attachmentId(draft.attachment)
  )
}

/**
 * Unsaved editors of every tab, including collapsed ones and those hidden because their tab shows
 * another target. An editor whose content is held by a durable unresolved attempt is not among
 * them: its content stays in that attempt (发送记录).
 */
export function unsavedEditors(state: EditorsState): Editor[] {
  return state.editors.filter((editor) => editor.publication?.phase !== 'attempt' && isUnsaved(editor))
}

/** Editors that would lose their last owning tab; shared content needs no close prompt. */
export function unsavedInTab(state: EditorsState, tabId: number): Editor[] {
  return unsavedEditors(state).filter((editor) => editor.tabIds.length === 1 && editor.tabIds[0] === tabId)
}

export function saveInput(editor: Editor): DraftSaveInput {
  return {
    draftId: editor.draft?.id ?? null,
    target: editor.target,
    credentialId: editor.credentialId,
    fields: editor.fields,
    attachmentId: attachmentId(editor.attachment)
  }
}

/** The attachment each editor shows, for holding its managed copy in the main process. */
export function attachmentHolds(state: EditorsState): Map<EditorId, AttachmentId | null> {
  const holds = new Map<EditorId, AttachmentId | null>()
  for (const editor of state.editors) {
    // Reserve the undo image before replacing the editor's current attachment hold.
    if (editor.discarded?.attachment) holds.set(`${editor.id}-undo`, editor.discarded.attachment.id)
    holds.set(editor.id, attachmentId(editor.attachment))
  }
  return holds
}

export type IdentityStatus =
  | { state: 'unknown' }
  | { state: 'none' }
  | { state: 'missing'; credentialId: CredentialId }
  | { state: 'selected'; credentialId: CredentialId; name: string }

/**
 * What the editor's 发言饼干 is now. A removed credential stays `missing` and must be chosen
 * again; it is never replaced by the global default. `overview` null: not readable.
 */
export function identityStatus(editor: Editor, overview: IdentityOverview | null): IdentityStatus {
  if (editor.credentialId === null) return editor.identityUnknown ? { state: 'unknown' } : { state: 'none' }
  if (overview === null) return { state: 'unknown' }
  const credential = overview.credentials.find((item) => item.id === editor.credentialId)
  return credential === undefined
    ? { state: 'missing', credentialId: editor.credentialId }
    : { state: 'selected', credentialId: credential.id, name: credential.name }
}
