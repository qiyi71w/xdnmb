import type { ThreadId } from './forum'
import type { CredentialId, RoleSelection } from './identity'
import type { ImageFormat } from './images'

/**
 * Editing and saved drafts (编辑与草稿). An editor is the renderer's working copy, saved to its
 * draft automatically; a draft is the saved version kept locally until it is sent or deleted.
 * Saving replaces a draft's version as a whole; nothing else changes a saved draft.
 */

/** Local reference to a saved draft: decimal string of a never-reused local ID. */
export type DraftId = string
/** Local reference to a managed copy of an image attached to an editor or draft. */
export type AttachmentId = string
/** Renderer-generated ID of one editor; 1–64 chars of [A-Za-z0-9_-]. */
export type EditorId = string

/** Where a post goes. Changed only explicitly, never by navigation. */
export type PostTarget =
  | { kind: 'reply'; threadId: ThreadId }
  /** New thread (发新串) in a forum. Timelines are not post targets. */
  | { kind: 'thread'; forumId: string }

export interface PostFields {
  content: string
  title: string
  name: string
  /** 水印; off by default. Sending omits the field when off (publication ticket). */
  watermark: boolean
}

export const EMPTY_FIELDS: PostFields = { content: '', title: '', name: '', watermark: false }

/** Upper bounds accepted over IPC; not forum limits. */
export const MAX_DRAFT_CONTENT_LENGTH = 100_000
export const MAX_DRAFT_FIELD_LENGTH = 1_000

/** A managed copy of the attached image. The user's original file is never touched. */
export interface DraftAttachment {
  id: AttachmentId
  format: ImageFormat
  bytes: number
  width: number
  height: number
  /** File name the image was chosen from (display only). */
  originalName: string
  /** `xidao-image://draft/<managed name>`. */
  url: string
}

/** Everything a saved version holds: target, identity reference, text fields and attachment. */
export interface DraftContent {
  target: PostTarget
  /** 发言饼干 reference; `null`: none chosen. A removed credential stays referenced (missing). */
  credentialId: CredentialId | null
  fields: PostFields
  attachment: DraftAttachment | null
}

export interface SavedDraft extends DraftContent {
  id: DraftId
  /** Increases by one with every save. */
  version: number
  createdAt: string
  savedAt: string
}

export interface DraftSaveInput {
  /** `null` creates a new draft; otherwise replaces that draft's saved version. */
  draftId: DraftId | null
  target: PostTarget
  credentialId: CredentialId | null
  fields: PostFields
  attachmentId: AttachmentId | null
}

/**
 * - `storage`: local storage is unavailable, read-only or the write failed.
 * - `not-found`: the draft no longer exists.
 * - `attachment-missing`: the attachment's managed copy is gone.
 * - `locked`: a sending or unresolved publication owns the saved draft.
 * Every failure leaves the previously saved version untouched.
 */
export type DraftSaveResult =
  | { ok: true; draft: SavedDraft }
  | { ok: false; reason: 'storage' | 'not-found' | 'attachment-missing' | 'locked' }

export type DraftDeleteResult = { ok: true } | { ok: false; reason: 'storage' | 'locked' }

export type DraftListResult = { ok: true; drafts: SavedDraft[] } | { ok: false; reason: 'storage' }

/**
 * - `cancelled`: no file chosen.
 * - `source-unreadable`: the chosen file is missing or cannot be read.
 * - `not-image`: not a JPEG, PNG, GIF or WebP by its own bytes.
 * - `too-large`: dimensions beyond what the app can display.
 * - `no-space`: the disk is full.
 * - `storage`: local storage is unavailable or another write failed.
 */
export type AttachFailure = 'cancelled' | 'source-unreadable' | 'not-image' | 'too-large' | 'no-space' | 'storage'

export type AttachResult = { ok: true; attachment: DraftAttachment } | { ok: false; reason: AttachFailure }

/**
 * Identity a new editor starts with. Replies: the thread's own selection when one exists, else
 * the global default. New threads: the global default. `unknown`: stored selections cannot be
 * read. A missing selection is reported as such; it never falls back to another one.
 */
export type IdentityChoice =
  | { source: 'thread' | 'default'; selection: RoleSelection }
  | { source: 'unknown' }

export function targetKey(target: PostTarget): string {
  return target.kind === 'reply' ? `reply:${target.threadId}` : `thread:${target.forumId}`
}

export function sameTarget(a: PostTarget, b: PostTarget): boolean {
  return targetKey(a) === targetKey(b)
}

export function forumLabel(forumId: string, forumName: (forumId: string | null) => string | null): string {
  return forumName(forumId) ?? `版面 ${forumId}`
}

/** “回复 No.X” / “在「X」发新串”. */
export function targetText(target: PostTarget, forumName: (forumId: string | null) => string | null): string {
  return target.kind === 'reply' ? `回复 No.${target.threadId}` : `在「${forumLabel(target.forumId, forumName)}」发新串`
}
