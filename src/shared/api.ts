import type { ContentApi } from './content'
import type { BoardDirectory, FeedPage, FeedRef, Post, PostId, ReadingMode, ThreadCoverage, ThreadId, ThreadPage } from './forum'
import type {
  CredentialId, IdentityMutationResult, IdentityOverview, IdentityRole, ImportResult
} from './identity'
import type { ImageLoadOutcome, ImageLoadRequest, ImageSaveOutcome, ImageViewId } from './images'
import type {
  AttachmentId, AttachResult, DraftDeleteResult, DraftId, DraftListResult, DraftSaveInput, DraftSaveResult, EditorId,
  IdentityChoice, PostTarget
} from './drafts'
import type { AppSettings, MarkReadResult, ReadingAnchor, ThreadReadingState, WriteResult } from './reading'
import type { SubscriptionsApi } from './subscriptions'
import type { PublicationApi } from './publication'
import type { LifecycleApi } from './lifecycle'

/**
 * Classified read failure. Server/body text is never included except a short
 * business message the forum itself returned (e.g. "该串不存在").
 */
export type ReadErrorKind =
  | 'not-found'
  | 'permission'
  | 'rate-limited'
  | 'network'
  | 'unknown-structure'
  /** The browse identity cannot be used; the read was not sent. Never means the forum rejected it. */
  | 'identity'

export type ReadErrorDetail =
  | 'timeout'
  | 'connection'
  | 'http-status'
  | 'redirect'
  | 'too-large'
  | 'decode'
  | 'html'
  | 'json'
  | 'shape'
  | 'business'
  /** `identity`: the selected browse credential was removed; a new choice is required. */
  | 'identity-missing'
  /** `identity`: OS protection is unavailable or the stored ciphertext could not be decrypted. */
  | 'identity-locked'
  /** `identity`: local storage is unavailable, so the browse choice is unknown; not treated as "no cookie". */
  | 'identity-unknown'

export interface ReadError {
  kind: ReadErrorKind
  detail: ReadErrorDetail
  httpStatus?: number
  /** Short forum-provided business message, at most 200 characters. */
  serverMessage?: string
}

/**
 * Result of a named read operation.
 * - `fresh`: obtained from the forum now. `saved` is false when local storage refused/failed the write.
 * - `cached`: served from local storage. `networkError` is the failure that caused the fallback,
 *   or `null` when the cache was explicitly preferred.
 * - `failed`: nothing to show. `cancelled`: the caller cancelled; the result must be ignored.
 */
export type ReadOutcome<T> =
  | { status: 'fresh'; data: T; fetchedAt: string; saved: boolean }
  | { status: 'cached'; data: T; fetchedAt: string; networkError: ReadError | null }
  | { status: 'failed'; error: ReadError }
  | { status: 'cancelled' }

export interface ThreadPageResult {
  page: ThreadPage
  coverage: ThreadCoverage
}

/**
 * Bounded tail probe: estimate from ReplyCount, then verify by probing at most two pages forward
 * and two backward.
 * - `located`: `lastPage` is the last page with replies (or an empty page 1) and `endCandidatePage`
 *   is the observed end-candidate page that proves it (equal to `lastPage` for an empty page 1).
 * - `insufficient`: the bound was exhausted without a verifiable end.
 * - `interrupted`: a probe failed after earlier probes succeeded; carries what was observed.
 */
export type ThreadEndResult =
  | { status: 'located'; lastPage: ThreadPageResult; endCandidatePage: number; probedPages: number[] }
  | { status: 'insufficient'; probedPages: number[]; coverage: ThreadCoverage }
  | { status: 'interrupted'; probedPages: number[]; coverage: ThreadCoverage; failedPage: number; error: ReadError }

/**
 * Content of a quoted post (`/api/ref`). `threadId` is the owning thread when this machine has
 * observed the post in a thread page or a list; `null` means not known locally. The ref response
 * itself carries no thread or page, so ownership is never derived from it.
 */
export interface QuotePreview {
  post: Post
  threadId: ThreadId | null
}

/** Where a quote target is shown: a post verified on `page` of `mode` of its thread. */
export interface QuoteTarget {
  postId: PostId
  page: number
  mode: ReadingMode
}

/**
 * Result of locating a quoted post. Only recorded ownership is used: the post's thread from local
 * observations, then the latest stored page of each mode that contained it, verified by reading
 * that page again; or, with no record at all, whether the post is itself a thread's main post.
 * Never scans a thread, trusts web-ref page numbers or guesses an owner.
 * - `located`: the post was found on `target.page` of `target.mode` now (`fresh`), or on the stored
 *   copy of that page after the network read failed (`cached`, `networkError` set).
 * - `thread-known`: the owning thread is known and was just read (its recorded page, or page 1 of the
 *   preferred mode when no stored page records the post), but the post was not on its recorded page
 *   or no page records it. Opening the thread (打开原串) is a separate user action.
 * - `unknown-thread`: no local record and the post is not a thread's main post.
 * - `failed`: reading what was needed failed; `threadId` when the owner is known.
 * - `cancelled`: superseded or cancelled; must be ignored.
 */
export type QuoteLocation =
  | { status: 'located'; threadId: ThreadId; head: Post; target: QuoteTarget; source: 'fresh' | 'cached'; networkError: ReadError | null }
  | { status: 'thread-known'; threadId: ThreadId; head: Post }
  | { status: 'unknown-thread' }
  | { status: 'failed'; threadId: ThreadId | null; error: ReadError }
  | { status: 'cancelled' }

export type DirectoryStrategy =
  /** Use stored directory if any; otherwise fetch in the foreground lane. */
  | 'cache-first'
  /** Fetch in the background lane (yields to foreground reads); fall back to stored directory. */
  | 'background-refresh'
  /** Fetch in the foreground lane; fall back to stored directory. */
  | 'refresh'

/** Caller-generated ID used to cancel an operation; 1–64 chars of [A-Za-z0-9_-]. */
export type OperationId = string

export type StorageStatus =
  | { state: 'ready'; schemaVersion: number }
  /** Database written by a newer app version: reads allowed, all writes refused. */
  | { state: 'read-only'; reason: 'newer-schema'; schemaVersion: number; supportedVersion: number }
  /** Database could not be opened or migrated; the original file is left untouched. */
  | { state: 'unavailable'; reason: 'open-failed' | 'migration-failed' }

/** Desktop platform of the running app; decides which modifier keys the shortcuts use. */
export type AppPlatform = 'darwin' | 'win32' | 'linux'

export interface AppStatus {
  storage: StorageStatus
  platform: AppPlatform
}

/** Upper bound of post IDs per `markRead` call. */
export const MAX_MARK_READ_IDS = 2000

/** The only surface exposed to the renderer (window.xidao). */
export interface XidaoApi {
  content: ContentApi
  subscriptions: SubscriptionsApi
  reading: {
    loadDirectory(input: { operationId: OperationId; strategy: DirectoryStrategy }): Promise<ReadOutcome<BoardDirectory>>
    /** Foreground read; falls back to the stored page when the network read fails. */
    readFeedPage(input: { operationId: OperationId; feed: FeedRef; page: number }): Promise<ReadOutcome<FeedPage>>
    /**
     * Foreground read of one thread page in the given mode (`po` reads the forum's PO-only pages);
     * falls back to the stored page of the same mode on failure. Modes never stand in for each other.
     */
    readThreadPage(input: { operationId: OperationId; threadId: ThreadId; mode: ReadingMode; page: number }): Promise<ReadOutcome<ThreadPageResult>>
    /** Bounded tail probe of one mode in the foreground lane; cancellable between and during page reads. */
    locateThreadEnd(input: { operationId: OperationId; threadId: ThreadId; mode: ReadingMode }): Promise<ReadOutcome<ThreadEndResult>>
    /** Cancels queued and in-flight reads of the operation. Unknown IDs are ignored. */
    cancel(input: { operationId: OperationId }): Promise<void>
  }
  /**
   * Quote preview and location. Both are foreground reads that never mark anything read and never
   * navigate; the renderer decides what to do with a result.
   */
  quotes: {
    /** Network first (`/api/ref`), falling back to the stored post with the failure reason. */
    preview(input: { operationId: OperationId; postId: PostId }): Promise<ReadOutcome<QuotePreview>>
    /** Resolves owner, page and mode of a quoted post; see QuoteLocation. Cancel with `reading.cancel`. */
    locate(input: { operationId: OperationId; postId: PostId }): Promise<QuoteLocation>
  }
  /** Local reading context. Never touches the network; downloads and previews never call it. */
  readingState: {
    /** Mode preference, per-mode positions, read/unread posts, attention and coverage of one thread. */
    get(input: { threadId: ThreadId }): Promise<ThreadReadingState>
    /** Saves the thread's mode preference. Temporary target display must not call this. */
    setMode(input: { threadId: ThreadId; mode: ReadingMode }): Promise<WriteResult>
    /** Saves the position of one mode; the other mode's position is untouched. */
    savePosition(input: { threadId: ThreadId; mode: ReadingMode; anchor: ReadingAnchor }): Promise<WriteResult>
    /**
     * Records posts as read. Called only by the foreground reader's dwell judgement and by the explicit
     * “全部标为已读” with the confirmed unread IDs it showed. Posts not observed in this thread are ignored.
     */
    markRead(input: { threadId: ThreadId; postIds: PostId[] }): Promise<MarkReadResult>
    /** Records a visit to the thread (browsing history). Not a navigation step and not a read. */
    recordVisit(input: { threadId: ThreadId }): Promise<WriteResult>
  }
  settings: {
    get(): Promise<AppSettings>
    update(input: Partial<AppSettings>): Promise<WriteResult & { settings: AppSettings }>
  }
  /**
   * Post images. The caller names a stored post, never a URL or path; requests go only to the
   * forum image server, without cookies or credentials, and never follow redirects.
   */
  images: {
    /**
     * Fetches (or reuses) the post's thumbnail or original as a managed file, judged by its actual
     * bytes, and protects it from cleanup while `viewId` is held. Originals are queued before thumbnails.
     */
    load(input: ImageLoadRequest): Promise<ImageLoadOutcome>
    /** Cancels a queued or running `load` of this caller. Unknown IDs are ignored. */
    cancel(input: { operationId: OperationId }): Promise<void>
    /** The view closed: its images are no longer protected by reading. */
    releaseView(input: { viewId: ImageViewId }): Promise<void>
    /**
     * Asks where to save with the system dialog and writes a copy of the post's stored original,
     * named by its detected format. Never saves a thumbnail instead.
     */
    saveOriginal(input: { postId: PostId }): Promise<ImageSaveOutcome>
  }
  links: {
    /** Opens an absolute http(s) URL in the system browser; anything else is refused. */
    openExternal(input: { url: string }): Promise<{ opened: boolean }>
  }
  identities: {
    /** Names, sources, role selections and protection state; never any secret. */
    getOverview(): Promise<IdentityOverview>
    /** 官网导出内容: Base64 of JSON `{"cookie": "<userhash>", "name": "…"}` (or that JSON itself). `name` overrides the payload name. */
    importExport(input: { payload: string; name?: string }): Promise<ImportResult>
    /** 原始 userhash, optionally prefixed with `userhash=`. */
    importRaw(input: { userhash: string; name: string }): Promise<ImportResult>
    rename(input: { credentialId: CredentialId; name: string }): Promise<IdentityMutationResult>
    /** Deletes the credential; roles that referenced it become `missing`. */
    remove(input: { credentialId: CredentialId }): Promise<IdentityMutationResult>
    /** Sets one role only; `null` clears it to `none`. */
    select(input: { role: IdentityRole; credentialId: CredentialId | null }): Promise<IdentityMutationResult>
  }
  /**
   * Saved drafts and editor attachments. Drafts are never sent automatically; nothing here talks
   * to the forum.
   */
  drafts: {
    /** All saved drafts, most recently saved first; several may share one target. */
    list(): Promise<DraftListResult>
    /** Creates a draft or replaces its saved version; on failure the old version stays. */
    save(input: DraftSaveInput): Promise<DraftSaveResult>
    /** Deletes the draft record; its attachment copy is removed once nothing holds it. */
    delete(input: { draftId: DraftId }): Promise<DraftDeleteResult>
    /** System file chooser, then a managed copy held for `editorId`. The chosen file is only read. */
    attachImage(input: { editorId: EditorId }): Promise<AttachResult>
    /** The attachment the editor now shows (`null`: none). Held copies are never removed. */
    holdAttachment(input: { editorId: EditorId; attachmentId: AttachmentId | null }): Promise<void>
    /** The editor was closed or discarded. */
    releaseEditor(input: { editorId: EditorId }): Promise<void>
  }
  /**
   * 发言饼干 for editors: a reply starts with the thread's own selection, else the global default;
   * a new thread with the global default. Never changes browse or sync identities.
   */
  posting: {
    /** Starting identity for a new editor: the thread's own selection, else the global default. */
    identityFor(input: { target: PostTarget }): Promise<IdentityChoice>
    /** Remembers an explicit selection made in a reply editor for that thread only. */
    selectThreadIdentity(input: { threadId: ThreadId; credentialId: CredentialId }): Promise<IdentityMutationResult>
  }
  publication: PublicationApi
  /** Close choice, real quit, workspace restore and notices left by sends that finished without a window. */
  lifecycle: LifecycleApi
  app: {
    getStatus(): Promise<AppStatus>
  }
}

/** IPC channel names. Each maps 1:1 to an XidaoApi method; there is no generic channel. */
export const IpcChannel = {
  listRetained: 'content:list',
  favorite: 'content:favorite',
  isFavorite: 'content:is-favorite',
  clearHistory: 'content:clear-history',
  contentUsage: 'content:usage',
  setCacheLimit: 'content:set-cache-limit',
  clearCache: 'content:clear-cache',
  saveOffline: 'content:save-offline',
  offlineStatus: 'content:offline-status',
  cancelOffline: 'content:cancel-offline',
  holdContentReader: 'content:hold-reader',
  releaseContentReader: 'content:release-reader',
  loadDirectory: 'reading:load-directory',
  readFeedPage: 'reading:read-feed-page',
  readThreadPage: 'reading:read-thread-page',
  locateThreadEnd: 'reading:locate-thread-end',
  cancel: 'reading:cancel',
  previewQuote: 'quotes:preview',
  locateQuote: 'quotes:locate',
  getReadingState: 'reading-state:get',
  setReadingMode: 'reading-state:set-mode',
  saveReadingPosition: 'reading-state:save-position',
  markRead: 'reading-state:mark-read',
  recordVisit: 'reading-state:record-visit',
  getSettings: 'settings:get',
  updateSettings: 'settings:update',
  openExternal: 'links:open-external',
  loadImage: 'images:load',
  cancelImage: 'images:cancel',
  releaseImageView: 'images:release-view',
  saveOriginalImage: 'images:save-original',
  identityOverview: 'identities:get-overview',
  identityImportExport: 'identities:import-export',
  identityImportRaw: 'identities:import-raw',
  identityRename: 'identities:rename',
  identityRemove: 'identities:remove',
  identitySelect: 'identities:select',
  listDrafts: 'drafts:list',
  saveDraft: 'drafts:save',
  deleteDraft: 'drafts:delete',
  attachDraftImage: 'drafts:attach-image',
  holdDraftAttachment: 'drafts:hold-attachment',
  releaseEditor: 'drafts:release-editor',
  postingIdentityFor: 'posting:identity-for',
  selectThreadIdentity: 'posting:select-thread-identity',
  subscriptionOverview: 'subscriptions:overview',
  subscriptionConfigureApp: 'subscriptions:configure-app',
  subscriptionSelectSource: 'subscriptions:select-source',
  subscriptionObservation: 'subscriptions:observation',
  subscriptionRead: 'subscriptions:read',
  subscriptionChange: 'subscriptions:change',
  subscriptionOperations: 'subscriptions:operations',
  subscriptionReconcile: 'subscriptions:reconcile',
  subscriptionMergeSources: 'subscriptions:merge-sources',
  subscriptionPreviewSync: 'subscriptions:preview-sync',
  subscriptionPreviewMerge: 'subscriptions:preview-merge',
  subscriptionExecutePlan: 'subscriptions:execute-plan',
  subscriptionPlans: 'subscriptions:plans',
  subscriptionCancel: 'subscriptions:cancel',
  submitPublication: 'publication:submit',
  resolvePoPrompt: 'publication:resolve-prompt',
  listPublications: 'publication:list',
  getPublication: 'publication:get',
  listOwnPosts: 'publication:own-posts',
  addOwnPost: 'publication:add-own-post',
  getPoWarning: 'publication:get-po-warning',
  setPoWarning: 'publication:set-po-warning',
  lifecycleReside: 'lifecycle:reside',
  lifecycleRequestQuit: 'lifecycle:request-quit',
  lifecyclePresentQuit: 'lifecycle:present-quit',
  lifecycleCancelQuit: 'lifecycle:cancel-quit',
  lifecycleCompleteQuit: 'lifecycle:complete-quit',
  loadWorkspace: 'lifecycle:load-workspace',
  saveWorkspace: 'lifecycle:save-workspace',
  listLaunchNotices: 'lifecycle:list-launch-notices',
  dismissLaunchNotices: 'lifecycle:dismiss-launch-notices',
  listUnstoredResults: 'lifecycle:list-unstored-results',
  retryUnstoredResults: 'lifecycle:retry-unstored-results',
  getStatus: 'app:get-status'
} as const

/** The one main → renderer event channel; carries a `LifecycleRequest`. */
export const LIFECYCLE_REQUEST_CHANNEL = 'lifecycle:request'
