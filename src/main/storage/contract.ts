import type { StorageStatus } from '../../shared/api'
import type {
  BoardDirectory,
  FeedPage,
  FeedRef,
  Post,
  PostId,
  PostImage,
  ReadingMode,
  ThreadCoverage,
  ThreadId,
  ThreadPage
} from '../../shared/forum'
import type { ImageFormat, ImageKind } from '../../shared/images'
import type { AppSettings, AttentionSource, AttentionState, ReadingAnchor, ThreadReadingState } from '../../shared/reading'
import type { CredentialId, CredentialSource, CredentialSummary, IdentityRole, RoleSelection } from '../../shared/identity'
import type { AttachmentId, DraftId, DraftSaveInput, PostFields, PostTarget } from '../../shared/drafts'
import type { ContentStore } from './content-contract'
import type { SubscriptionContext, SubscriptionObservation, SubscriptionOperation, SubscriptionSource } from '../../shared/subscriptions'
import type { SearchStore } from './search-contract'

/** A write was refused because the database is read-only (newer schema) or unavailable. */
export class StorageWriteRefusedError extends Error {
  override readonly name = 'StorageWriteRefusedError'
  constructor(readonly status: StorageStatus) {
    super(`storage write refused: ${status.state}`)
  }
}

export interface Stored<T> {
  value: T
  /** ISO-8601 time the content was fetched from the forum. */
  fetchedAt: string
}

/** Locally recorded ownership of a post, used to locate quotes without guessing. */
export interface PostThreadRelation {
  threadId: ThreadId
  /** The post is the thread's main post (shown on page 1 of both modes). */
  isHead: boolean
  /** Saved mode preference of the thread; `all` when none was saved. */
  preferredMode: ReadingMode
  /** Latest-fetched stored page of each mode whose replies include the post; `null` when none. */
  pages: Record<ReadingMode, number | null>
}

/**
 * Who keeps a managed image from cleanup. `reading`: a reader view of the running app (cleared at
 * startup). Drafts and offline copies add their own kinds when they start holding images.
 */
export interface ImageHolder {
  kind: 'reading' | 'offline'
  id: string
}

/** One stored image file: what it is, where it came from, when it was fetched. */
export interface ImageResourceRecord {
  id: number
  kind: ImageKind
  /** Absolute URL the bytes were fetched from. */
  sourceUrl: string
  /** Managed file name inside the app's image directory. */
  fileName: string
  format: ImageFormat
  bytes: number
  width: number
  height: number
  fetchedAt: string
}

export type NewImageResource = Omit<ImageResourceRecord, 'id'>

/**
 * Persistence used by reading. Implemented by a single database worker owned by the main process;
 * every call is one short transaction executed serially in that worker.
 */
export interface ReadingStore {
  readonly status: StorageStatus
  saveDirectory(directory: BoardDirectory, fetchedAt: string): Promise<void>
  loadDirectory(): Promise<Stored<BoardDirectory> | null>
  saveFeedPage(page: FeedPage, fetchedAt: string): Promise<void>
  loadFeedPage(feed: FeedRef, page: number): Promise<Stored<FeedPage> | null>
  /** Saves posts, post→thread relations and the page observation; returns coverage from the same transaction. */
  saveThreadPage(page: ThreadPage, fetchedAt: string): Promise<ThreadCoverage>
  loadThreadPage(threadId: ThreadId, mode: ReadingMode, page: number): Promise<Stored<ThreadPage> | null>
  getThreadCoverage(threadId: ThreadId, mode: ReadingMode): Promise<ThreadCoverage>
  /** Saves one post's content without any thread relation (a quote preview carries none). */
  savePost(post: Post, fetchedAt: string): Promise<void>
  loadPost(postId: PostId): Promise<Stored<Post> | null>
  /** Recorded thread of a post and where stored pages contain it; `null` when never observed in a thread or list. */
  findPostThread(postId: PostId): Promise<PostThreadRelation | null>

  /** Mode preference, positions, read/unread posts, attention and both coverages of one thread. */
  getReadingState(threadId: ThreadId): Promise<ThreadReadingState>
  setReadingMode(threadId: ThreadId, mode: ReadingMode, at: string): Promise<void>
  saveReadingPosition(threadId: ThreadId, mode: ReadingMode, anchor: ReadingAnchor, at: string): Promise<void>
  /** Records posts observed in this thread as read; returns the ones newly recorded. */
  markPostsRead(threadId: ThreadId, postIds: PostId[], at: string): Promise<PostId[]>
  recordVisit(threadId: ThreadId, at: string): Promise<void>
  /**
   * Establishes the local attention start the first time attention begins (subscription, favorite,
   * reminder or import). Later calls, whatever their source, keep the original start and return it.
   * Never marks anything read.
   */
  establishAttention(threadId: ThreadId, source: AttentionSource, at: string): Promise<AttentionState>
  loadSettings(): Promise<AppSettings>
  saveSettings(settings: AppSettings): Promise<void>

  /** Image location of a stored post; null when the post is not stored or has no image. */
  getPostImage(postId: PostId): Promise<PostImage | null>
  /** The stored resource for `kind` + `sourceUrl`; when found and `holder` is given, it is held too. */
  findImageResource(kind: ImageKind, sourceUrl: string, holder: ImageHolder | null): Promise<ImageResourceRecord | null>
  /**
   * Records a file already renamed into the image directory and holds it for `holders`, in one
   * transaction. An existing resource for the same kind + source keeps its ID and holders and now
   * points at the new file; `replacedFileName` is its previous file, which nothing references any more.
   */
  commitImageResource(
    resource: NewImageResource,
    holders: ImageHolder[]
  ): Promise<{ resource: ImageResourceRecord; replacedFileName: string | null }>
  /** Drops holders of `kind` whose ID starts with `idPrefix` (`''`: all of that kind). */
  releaseImageHolders(kind: ImageHolder['kind'], idPrefix: string): Promise<void>
  /**
   * Deletes the records of those `resourceIds` that no holder references, in one transaction, and
   * returns their file names for removal. Held resources are left untouched.
   */
  deleteUnheldImages(resourceIds: number[]): Promise<string[]>
  /** Every managed file name that a resource record points at. */
  listImageFileNames(): Promise<string[]>
  close(): Promise<void>
}

/**
 * Credential persistence: local references, names and ciphertext only. Plain-text secrets never
 * reach this layer. IDs are never reused, so a role pointing at a removed credential stays missing.
 */
export interface IdentityStore {
  listCredentials(): Promise<CredentialSummary[]>
  loadCredentialCiphertexts(): Promise<Array<{ id: CredentialId; ciphertext: Uint8Array }>>
  loadCredentialCiphertext(id: CredentialId): Promise<Uint8Array | null>
  insertCredential(input: { name: string; source: CredentialSource; importedAt: string; ciphertext: Uint8Array }): Promise<CredentialSummary>
  /** False when the credential does not exist. */
  renameCredential(id: CredentialId, name: string): Promise<boolean>
  /** Deletes the ciphertext; role references are kept. False when it did not exist. */
  deleteCredential(id: CredentialId): Promise<boolean>
  loadRoleSelections(): Promise<Record<IdentityRole, RoleSelection>>
  /** Sets one role. False (and no change) when `id` is not an existing credential. */
  setRoleSelection(role: IdentityRole, id: CredentialId | null): Promise<boolean>
}

/** One managed copy of an attached image, as stored. */
export interface DraftAttachmentRecord {
  id: AttachmentId
  fileName: string
  format: ImageFormat
  bytes: number
  width: number
  height: number
  originalName: string
  createdAt: string
}

export interface DraftRecord {
  id: DraftId
  target: PostTarget
  credentialId: CredentialId | null
  fields: PostFields
  attachment: DraftAttachmentRecord | null
  version: number
  createdAt: string
  savedAt: string
}

export type DraftWriteOutcome =
  | { ok: true; draft: DraftRecord }
  | { ok: false; reason: 'not-found' | 'attachment-missing' }

/**
 * Saved drafts, their attachment records and per-thread 发言饼干 selections. A draft has exactly
 * one saved version: saving replaces target, identity, fields and attachment together.
 */
export interface DraftStore {
  /** Most recently saved first. */
  listDrafts(): Promise<DraftRecord[]>
  /** Creates (`draftId: null`) or replaces a draft's saved version in one transaction. */
  saveDraft(input: DraftSaveInput, at: string): Promise<DraftWriteOutcome>
  /** False when it did not exist. Its attachment record stays until unreferenced records are deleted. */
  deleteDraft(id: DraftId): Promise<boolean>
  insertDraftAttachment(input: Omit<DraftAttachmentRecord, 'id'>): Promise<DraftAttachmentRecord>
  getDraftAttachment(id: AttachmentId): Promise<DraftAttachmentRecord | null>
  /**
   * Deletes, in one transaction, attachment records no draft references except those in `keep`,
   * and returns their file names for removal.
   */
  deleteUnreferencedAttachments(keep: AttachmentId[]): Promise<string[]>
  listDraftAttachmentFileNames(): Promise<string[]>
  /** The thread's own 发言饼干 selection (`none` when never chosen). */
  getThreadPostIdentity(threadId: ThreadId): Promise<RoleSelection>
  /** False (and no change) when `id` is not an existing credential. */
  setThreadPostIdentity(threadId: ThreadId, id: CredentialId, at: string): Promise<boolean>
}

export interface SubscriptionConfiguration {
  context: SubscriptionContext
  source: SubscriptionSource
}

/** UUID ciphertexts are immutable and retained for fixed-context readback after replacement. */
export interface SubscriptionStore {
  loadSubscriptionConfiguration(): Promise<SubscriptionConfiguration>
  setSubscriptionAppCredential(id: string, ciphertext: Uint8Array): Promise<void>
  loadSubscriptionAppCiphertext(id: string): Promise<Uint8Array | null>
  setSubscriptionSource(source: SubscriptionSource): Promise<void>
  loadSubscriptionObservation(source: SubscriptionSource, context: SubscriptionContext, validOnly?: boolean): Promise<SubscriptionObservation | null>
  loadSubscriptionObservationById(id: string): Promise<SubscriptionObservation | null>
  /** Saves the observation and first attention starts in the same transaction. */
  saveSubscriptionObservation(observation: SubscriptionObservation, attention: AttentionSource): Promise<void>
  saveSubscriptionOperation(operation: SubscriptionOperation): Promise<void>
  loadSubscriptionOperations(): Promise<SubscriptionOperation[]>
  recoverSubscriptionOperations(): Promise<void>
}

export type AppStore = ReadingStore & IdentityStore & DraftStore & ContentStore & SubscriptionStore & SearchStore
