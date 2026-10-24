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

/**
 * Editors (未发送编辑) of all tabs. Each editor belongs to one tab and one target; a tab has at
 * most one editor per target, and a saved draft is continued by at most one editor anywhere, so
 * two writable copies can never overwrite each other. Navigation never changes an editor's
 * target or identity; leaving a target only hides its editor until the tab shows it again.
 */
export interface Editor {
  id: EditorId
  tabId: number
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
}

export interface EditorsState {
  editors: Editor[]
  nextId: number
}

export const INITIAL_EDITORS: EditorsState = { editors: [], nextId: 1 }

export type EditorsAction =
  /**
   * Starts a new editor for `target` in the tab unless one already exists there, in which case
   * that editor is only expanded. Never picks up a saved draft.
   */
  | { type: 'open'; tabId: number; target: PostTarget; identity: IdentityChoice }
  /** Continues a saved draft in a tab. Ignored when any editor already continues it. */
  | { type: 'open-draft'; tabId: number; draft: SavedDraft }
  | { type: 'edit'; editorId: EditorId; patch: Partial<PostFields> }
  /** Explicit 发言饼干 choice in this editor only. */
  | { type: 'set-identity'; editorId: EditorId; credentialId: CredentialId }
  | { type: 'set-attachment'; editorId: EditorId; attachment: DraftAttachment | null }
  /** Explicit target change; identity untouched. Ignored when the tab already edits that target. */
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
  /** The tab closed after its unsaved editors were handled. */
  | { type: 'close-tab'; tabId: number }

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

function fromDraft(draft: SavedDraft): Pick<Editor, 'target' | 'credentialId' | 'fields' | 'attachment'> {
  return { target: draft.target, credentialId: draft.credentialId, fields: { ...draft.fields }, attachment: draft.attachment }
}

export function editorsReducer(state: EditorsState, action: EditorsAction): EditorsState {
  switch (action.type) {
    case 'open': {
      const existing = editorFor(state, action.tabId, action.target)
      if (existing !== null) return update(state, existing.id, (editor) => (editor.expanded ? editor : { ...editor, expanded: true }))
      const identity = action.identity
      const editor: Editor = {
        id: `editor-${state.nextId}`,
        tabId: action.tabId,
        target: action.target,
        credentialId: identity.source === 'unknown' || identity.selection.state === 'none' ? null : identity.selection.credentialId,
        identityUnknown: identity.source === 'unknown',
        fields: { ...EMPTY_FIELDS },
        attachment: null,
        draft: null,
        expanded: true
      }
      return { editors: [...state.editors, editor], nextId: state.nextId + 1 }
    }
    case 'open-draft': {
      if (editorForDraft(state, action.draft.id) !== null) return state
      if (editorFor(state, action.tabId, action.draft.target) !== null) return state
      const editor: Editor = {
        id: `editor-${state.nextId}`,
        tabId: action.tabId,
        ...fromDraft(action.draft),
        identityUnknown: false,
        draft: action.draft,
        expanded: true
      }
      return { editors: [...state.editors, editor], nextId: state.nextId + 1 }
    }
    case 'edit':
      return update(state, action.editorId, (editor) => ({ ...editor, fields: { ...editor.fields, ...action.patch } }))
    case 'set-identity':
      return update(state, action.editorId, (editor) => ({ ...editor, credentialId: action.credentialId, identityUnknown: false }))
    case 'set-attachment':
      return update(state, action.editorId, (editor) => ({ ...editor, attachment: action.attachment }))
    case 'retarget':
      return update(state, action.editorId, (editor) => {
        if (sameTarget(editor.target, action.target)) return editor
        if (editorFor(state, editor.tabId, action.target) !== null) return editor
        return { ...editor, target: action.target }
      })
    case 'set-expanded':
      return update(state, action.editorId, (editor) => (editor.expanded === action.expanded ? editor : { ...editor, expanded: action.expanded }))
    case 'saved':
      return update(state, action.editorId, (editor) => ({ ...editor, draft: action.draft }))
    case 'discard': {
      const editor = state.editors.find((item) => item.id === action.editorId)
      if (editor === undefined) return state
      const draft = editor.draft
      const occupant = draft === null ? null : editorFor(state, editor.tabId, draft.target)
      if (draft === null || (occupant !== null && occupant.id !== editor.id)) {
        return { ...state, editors: state.editors.filter((item) => item.id !== editor.id) }
      }
      return update(state, editor.id, (item) => ({ ...item, ...fromDraft(draft), identityUnknown: false }))
    }
    case 'close-tab': {
      const editors = state.editors.filter((editor) => editor.tabId !== action.tabId)
      return editors.length === state.editors.length ? state : { ...state, editors }
    }
  }
}

export function editorFor(state: EditorsState, tabId: number, target: PostTarget): Editor | null {
  return state.editors.find((editor) => editor.tabId === tabId && sameTarget(editor.target, target)) ?? null
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

/** Unsaved editors of one tab, including those hidden because the tab shows another target. */
export function unsavedInTab(state: EditorsState, tabId: number): Editor[] {
  return state.editors.filter((editor) => editor.tabId === tabId && isUnsaved(editor))
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
  return new Map(state.editors.map((editor) => [editor.id, attachmentId(editor.attachment)]))
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
