import type { LocalBlock } from '../../shared/blocks'
import Database from 'better-sqlite3'
import type { StorageStatus } from '../../shared/api'
import type {
  BoardDirectory,
  ContentNode,
  CoveragePage,
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
import type { AttentionSource, AttentionState, ReadingAnchor, SavedPosition, ThreadReadingState } from '../../shared/reading'
import { DEFAULT_SETTINGS, settingsFromStored, type AppSettings } from '../../shared/settings'
import type { ImageFormat, ImageKind } from '../../shared/images'
import { IDENTITY_ROLES } from '../../shared/identity'
import type { CredentialId, CredentialSource, CredentialSummary, IdentityRole, RoleSelection } from '../../shared/identity'
import type { AttachmentId, DraftId, DraftSaveInput, PostTarget } from '../../shared/drafts'
import type { SubscriptionContext, SubscriptionObservation, SubscriptionOperation, SubscriptionPlan, SubscriptionSource } from '../../shared/subscriptions'
import type { SubscriptionBaseline, SubscriptionConfiguration } from './contract'
import type { OwnPost, PublicationAttempt } from '../../shared/publication'
import type { PublicationStore } from '../publication/contract'
import { StorageWriteRefusedError } from './contract'
import type {
  AppStore, DraftAttachmentRecord, DraftRecord, DraftWriteOutcome, ImageHolder, ImageResourceRecord, NewImageResource, PostThreadRelation, Stored
} from './contract'
import { assertReadablePage, computeCoverage } from './coverage'
import { buildReadingState, emptyReadingState, endObservation, type AttentionRecord } from './reading-state'
import { MIGRATIONS } from './migrations'
import type { Migration } from './migrations'
import { RetainedContentDatabase, contentTick, touchThread } from './retained'
import { ReminderDatabase } from './reminders'
import { SearchDatabase, projectSearchPost } from './search'

/** The worker owns this synchronous core; callers outside the worker use AppStore. */
export type ReadingDatabase = {
  [K in keyof AppStore]: AppStore[K] extends (...args: infer Args) => Promise<infer Value>
    ? (...args: Args) => Value
    : AppStore[K]
}

interface CredentialRow {
  id: number
  name: string
  source: CredentialSource
  imported_at: string
}

function credentialSummary(row: CredentialRow): CredentialSummary {
  return { id: String(row.id), name: row.name, source: row.source, importedAt: row.imported_at }
}

function noRoles(): Record<IdentityRole, RoleSelection> {
  return { 'default-post': { state: 'none' }, 'web-sync': { state: 'none' } }
}

interface PostRow {
  id: string
  forum_id: string | null
  created_at: string | null
  user_hash: string | null
  name: string | null
  title: string | null
  is_admin: number | null
  is_sage: number | null
  content_json: string
  plain_text: string
  image_path: string | null
  image_ext: string | null
  image_known: number | null
  fetched_at: string
}

function postFromRow(row: PostRow): Post {
  return {
    id: row.id,
    forumId: row.forum_id,
    createdAt: row.created_at,
    userHash: row.user_hash,
    name: row.name,
    title: row.title,
    isAdmin: row.is_admin === null ? null : row.is_admin !== 0,
    isSage: row.is_sage === null ? null : row.is_sage !== 0,
    content: JSON.parse(row.content_json) as ContentNode[],
    plainText: row.plain_text,
    ...(row.image_known === 1 ? { imageKnown: true } : {}),
    image: row.image_path === null || row.image_ext === null
      ? null
      : { path: row.image_path, ext: row.image_ext }
  }
}

interface FeedSummaryRow {
  headId: string
  replyCount: number | null
  recentReplyIds: string[]
  remainReplies: number | null
}

interface ThreadPageRow {
  page: number
  head_id: string
  fetched_at: string
  reply_ids_json: string
  reply_count: number | null
  skipped_items: number
  end_candidate: number
}

interface RelationSource {
  observedAs: 'head' | 'thread-reply' | 'feed-recent-reply'
  feedKind: FeedRef['kind'] | null
  feedId: string | null
  mode: ReadingMode | null
  page: number
}

interface ImageResourceRow {
  id: number
  kind: ImageKind
  source_url: string
  file_name: string
  format: ImageResourceRecord['format']
  bytes: number
  width: number
  height: number
  fetched_at: string
}

function imageResource(row: ImageResourceRow): ImageResourceRecord {
  return {
    id: row.id,
    kind: row.kind,
    sourceUrl: row.source_url,
    fileName: row.file_name,
    format: row.format,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    fetchedAt: row.fetched_at
  }
}

interface DraftAttachmentRow {
  id: number
  file_name: string
  format: ImageFormat
  bytes: number
  width: number
  height: number
  original_name: string
  created_at: string
}

function draftAttachment(row: DraftAttachmentRow): DraftAttachmentRecord {
  return {
    id: String(row.id),
    fileName: row.file_name,
    format: row.format,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    originalName: row.original_name,
    createdAt: row.created_at
  }
}

interface DraftRow {
  id: number
  target_kind: PostTarget['kind']
  target_id: string
  credential_id: number | null
  content: string
  title: string
  name: string
  email: string
  watermark: number
  attachment_id: number | null
  version: number
  created_at: string
  saved_at: string
}

function draftRecord(row: DraftRow, attachment: DraftAttachmentRecord | null): DraftRecord {
  return {
    id: String(row.id),
    target: row.target_kind === 'reply' ? { kind: 'reply', threadId: row.target_id } : { kind: 'thread', forumId: row.target_id },
    credentialId: row.credential_id === null ? null : String(row.credential_id),
    fields: { content: row.content, title: row.title, name: row.name, email: row.email, watermark: row.watermark === 1 },
    attachment,
    version: row.version,
    createdAt: row.created_at,
    savedAt: row.saved_at
  }
}

interface PublicationRow {
  id: number
  request_id: string
  editor_id: string
  draft_id: number | null
  payload_json: string
  state: PublicationAttempt['state']
  problem: PublicationAttempt['problem']
  created_at: string
  updated_at: string
  post_id: string | null
  thread_id: string | null
  saved_draft_id: number | null
}

function publicationAttempt(row: PublicationRow): PublicationAttempt {
  return {
    id: String(row.id),
    requestId: row.request_id,
    editorId: row.editor_id,
    draftId: row.draft_id === null ? null : String(row.draft_id),
    payload: JSON.parse(row.payload_json) as DraftSaveInput,
    state: row.state,
    problem: row.problem,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    postId: row.post_id,
    threadId: row.thread_id,
    savedDraftId: row.saved_draft_id === null ? null : String(row.saved_draft_id)
  }
}

interface OwnPostRow {
  post_id: string
  thread_id: string
  is_thread: number
  credential_id: number | null
  evidence: OwnPost['evidence']
  confirmed_at: string
}

function ownPost(row: OwnPostRow): OwnPost {
  return {
    postId: row.post_id,
    threadId: row.thread_id,
    isThread: row.is_thread === 1,
    credentialId: row.credential_id === null ? null : String(row.credential_id),
    evidence: row.evidence,
    confirmedAt: row.confirmed_at
  }
}

const UPSERT_POST = `
  INSERT INTO posts (
    id, forum_id, created_at, user_hash, name, title, is_admin, is_sage,
    content_json, plain_text, image_path, image_ext, fetched_at, image_known
  ) VALUES (
    @id, @forumId, @createdAt, @userHash, @name, @title, @isAdmin, @isSage,
    @content, @plainText, @imagePath, @imageExt, @fetchedAt, @imageKnown
  ) ON CONFLICT(id) DO UPDATE SET
    forum_id = excluded.forum_id, created_at = excluded.created_at,
    user_hash = excluded.user_hash, name = excluded.name, title = excluded.title,
    is_admin = excluded.is_admin, is_sage = excluded.is_sage,
    content_json = excluded.content_json, plain_text = excluded.plain_text,
    image_path = CASE
      WHEN excluded.image_path IS NULL AND (
        EXISTS (SELECT 1 FROM offline_page_posts WHERE post_id = posts.id)
        OR EXISTS (SELECT 1 FROM offline_pages WHERE head_id = posts.id)
      ) THEN posts.image_path
      ELSE excluded.image_path
    END,
    image_ext = CASE
      WHEN excluded.image_path IS NULL AND (
        EXISTS (SELECT 1 FROM offline_page_posts WHERE post_id = posts.id)
        OR EXISTS (SELECT 1 FROM offline_pages WHERE head_id = posts.id)
      ) THEN posts.image_ext
      ELSE excluded.image_ext
    END,
    image_known = excluded.image_known,
    fetched_at = excluded.fetched_at
  WHERE julianday(excluded.fetched_at) >= julianday(posts.fetched_at)
`

class SqliteReadingDatabase implements ReadingDatabase {
  constructor(
    private db: Database.Database | null,
    private currentStatus: StorageStatus
  ) {}

  private readonly content = new RetainedContentDatabase(
    () => this.writable(),
    (page, at) => this.saveThreadPage(page, at),
    (threadId, at) => this.establishAttention(threadId, 'favorite', at)
  )

  listRetained: ReadingDatabase['listRetained'] = (kind) => this.content.listRetained(kind)
  isFavorite: ReadingDatabase['isFavorite'] = (threadId) => this.content.isFavorite(threadId)
  setFavorite: ReadingDatabase['setFavorite'] = (threadId, favorite, at) => this.content.setFavorite(threadId, favorite, at)
  clearHistory: ReadingDatabase['clearHistory'] = (threadId, clearReading) => this.content.clearHistory(threadId, clearReading)
  getContentUsage: ReadingDatabase['getContentUsage'] = () => this.content.getContentUsage()
  setCacheLimit: ReadingDatabase['setCacheLimit'] = (bytes) => this.content.setCacheLimit(bytes)
  evictContentBatch: ReadingDatabase['evictContentBatch'] = (clearAll) => this.content.evictContentBatch(clearAll)
  holdContentReader: ReadingDatabase['holdContentReader'] = (holder, threadId) => this.content.holdContentReader(holder, threadId)
  releaseContentReaders: ReadingDatabase['releaseContentReaders'] = (prefix) => this.content.releaseContentReaders(prefix)
  getOfflineCopy: ReadingDatabase['getOfflineCopy'] = (threadId) => this.content.getOfflineCopy(threadId)
  beginOfflineCopy: ReadingDatabase['beginOfflineCopy'] = (threadId, images, at) => this.content.beginOfflineCopy(threadId, images, at)
  saveOfflinePage: ReadingDatabase['saveOfflinePage'] = (page, at) => this.content.saveOfflinePage(page, at)
  updateOfflineCopy: ReadingDatabase['updateOfflineCopy'] = (threadId, patch, at) => this.content.updateOfflineCopy(threadId, patch, at)
  holdOfflineImage: ReadingDatabase['holdOfflineImage'] = (threadId, postId) => this.content.holdOfflineImage(threadId, postId)
  listOfflineImagePosts: ReadingDatabase['listOfflineImagePosts'] = (threadId, after, limit) => this.content.listOfflineImagePosts(threadId, after, limit)
  recoverContent: ReadingDatabase['recoverContent'] = () => this.content.recoverContent()

  private readonly reminders = new ReminderDatabase(
    () => this.writable(),
    () => this.publicationDatabase(),
    (threadId, at) => this.establishAttention(threadId, 'reminder', at),
    (since) => this.firstProvenNewPost(since),
    (postId) => this.loadPost(postId)?.value ?? null,
    (threadId, mode) => this.getThreadCoverage(threadId, mode)
  )
  getReminderRules: ReadingDatabase['getReminderRules'] = (ids) => this.reminders.getRules(ids)
  setReminderRule: ReadingDatabase['setReminderRule'] = (id, kind, enabled, at) => this.reminders.setRule(id, kind, enabled, at)
  closeReminderThreads: ReadingDatabase['closeReminderThreads'] = (ids, reason, at) => this.reminders.closeThreads(ids, reason, at)
  reminderRuleSnapshots: ReadingDatabase['reminderRuleSnapshots'] = () => this.reminders.snapshots()
  getReminderCoverage: ReadingDatabase['getReminderCoverage'] = (id, mode) => this.reminders.getCoverage(id, mode)
  saveReminderCoverage: ReadingDatabase['saveReminderCoverage'] = (value) => this.reminders.saveCoverage(value)
  getReminderObservations: ReadingDatabase['getReminderObservations'] = (id, mode) => this.reminders.observations(id, mode)
  reminderOwnRevision: ReadingDatabase['reminderOwnRevision'] = () => this.reminders.ownRevision()
  evaluateReminders: ReadingDatabase['evaluateReminders'] = (input) => this.reminders.evaluate(input)
  createReminderRound: ReadingDatabase['createReminderRound'] = (trigger, at, total) => this.reminders.createRound(trigger, at, total)
  saveReminderRound: ReadingDatabase['saveReminderRound'] = (value) => this.reminders.saveRound(value)
  recoverReminders: ReadingDatabase['recoverReminders'] = (at) => this.reminders.recover(at)
  registerReminderNotification: ReadingDatabase['registerReminderNotification'] = (id, scope, at) => this.reminders.registerNotification(id, scope, at)
  settleReminderNotification: ReadingDatabase['settleReminderNotification'] = (id, state) => this.reminders.settleNotification(id, state)
  reminderOverview: ReadingDatabase['reminderOverview'] = () => this.reminders.overview()
  private readonly search = new SearchDatabase(() => this.writable(), (id, mode) => this.getThreadCoverage(id, mode))
  searchBoundary: ReadingDatabase['searchBoundary'] = () => this.search.boundary()
  searchBatch: ReadingDatabase['searchBatch'] = (input) => this.search.batch(input)
  beginSearchRebuild: ReadingDatabase['beginSearchRebuild'] = () => this.search.begin()
  rebuildSearchBatch: ReadingDatabase['rebuildSearchBatch'] = () => this.search.step()
  searchMetadata: ReadingDatabase['searchMetadata'] = (ids) => this.search.metadata(ids).map((metadata) => {
    const reading = this.getReadingState(metadata.threadId)
    return { ...metadata, unreadCount: reading.attention === null ? null : reading.attention.newUnreadIds.length,
      coverageUnknown: metadata.coverageUnknown || (reading.attention?.uncertainUnreadIds.length ?? 0) > 0 }
  })

  listBlocks: ReadingDatabase['listBlocks'] = () => this.publicationDatabase()
    .prepare('SELECT kind, value, created_at AS createdAt FROM local_blocks ORDER BY created_at DESC, kind, value')
    .all() as LocalBlock[]

  setBlock: ReadingDatabase['setBlock'] = (kind, value, blocked, at) => {
    const db = this.writable()
    if (blocked) db.prepare('INSERT OR IGNORE INTO local_blocks (kind, value, created_at) VALUES (?, ?, ?)').run(kind, value, at)
    else db.prepare('DELETE FROM local_blocks WHERE kind = ? AND value = ?').run(kind, value)
  }

  get status(): StorageStatus {
    return this.currentStatus
  }

  private writable(): Database.Database {
    if (this.currentStatus.state !== 'ready' || this.db === null) {
      throw new StorageWriteRefusedError(this.currentStatus)
    }
    return this.db
  }

  private postUpserter(db: Database.Database, fetchedAt: string) {
    const statement = db.prepare(UPSERT_POST)
    return (post: Post): void => {
      statement.run({
        id: post.id,
        forumId: post.forumId,
        createdAt: post.createdAt,
        userHash: post.userHash,
        name: post.name,
        title: post.title,
        isAdmin: post.isAdmin === null ? null : Number(post.isAdmin),
        isSage: post.isSage === null ? null : Number(post.isSage),
        content: JSON.stringify(post.content),
        plainText: post.plainText,
        imagePath: post.image?.path ?? null,
        imageExt: post.image?.ext ?? null,
        imageKnown: post.imageKnown === true ? 1 : null,
        fetchedAt
      })
      const retained = db.prepare<[string], PostRow>('SELECT id,title,plain_text,forum_id,created_at,image_path,image_ext,image_known,fetched_at FROM posts WHERE id=?').get(post.id)!
      const relation = db.prepare<[string], { thread_id: string }>('SELECT thread_id FROM post_threads WHERE post_id=?').get(post.id)
      projectSearchPost(db, { id: retained.id, title: retained.title, plainText: retained.plain_text,
        forumId: retained.forum_id, createdAt: retained.created_at, imageKnown: retained.image_known === 1,
        image: retained.image_path === null ? null : { path: retained.image_path, ext: retained.image_ext ?? '' } }, retained.fetched_at, relation?.thread_id ?? null)
    }
  }

  private postWriter(db: Database.Database, fetchedAt: string) {
    const upsert = this.postUpserter(db, fetchedAt)
    const relationStatement = db.prepare(`
      INSERT INTO post_threads (
        post_id, thread_id, observed_as, feed_kind, feed_id, mode, page, fetched_at
      ) VALUES (@postId, @threadId, @observedAs, @feedKind, @feedId, @mode, @page, @fetchedAt)
      ON CONFLICT(post_id) DO NOTHING
    `)
    return (post: Post, threadId: ThreadId, source: RelationSource): void => {
      upsert(post)
      relationStatement.run({ postId: post.id, threadId, ...source, fetchedAt })
      db.prepare("UPDATE search_sources SET thread_id=? WHERE owner='cache' AND post_id=? AND thread_id IS NULL").run(threadId, post.id)
      db.prepare('UPDATE posts SET last_used = ? WHERE id = ?').run(contentTick(db), post.id)
      if (source.observedAs === 'head') {
        db.prepare(`INSERT INTO retained_titles VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET
          title = coalesce(excluded.title, retained_titles.title), fetched_at = excluded.fetched_at
          WHERE julianday(excluded.fetched_at) >= julianday(retained_titles.fetched_at)`).run(threadId, post.title, fetchedAt)
      }
    }
  }

  private postReader(db: Database.Database) {
    const statement = db.prepare<[string], PostRow>('SELECT * FROM posts WHERE id = ?')
    return (id: string): Post => {
      const row = statement.get(id)
      if (!row) throw new Error('cached page references a missing post')
      return postFromRow(row)
    }
  }

  saveDirectory(directory: BoardDirectory, fetchedAt: string): void {
    const db = this.writable()
    db.transaction(() => {
      db.prepare(`
        INSERT INTO directory_snapshot (singleton, directory_json, fetched_at) VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          directory_json = excluded.directory_json, fetched_at = excluded.fetched_at
      `).run(JSON.stringify(directory), fetchedAt)
      db.prepare('UPDATE directory_snapshot SET last_used = ? WHERE singleton = 1').run(contentTick(db))
    })()
  }

  loadDirectory(): Stored<BoardDirectory> | null {
    if (!this.db) return null
    const row = this.db.prepare<[], { directory_json: string; fetched_at: string }>(
      'SELECT directory_json, fetched_at FROM directory_snapshot WHERE singleton = 1'
    ).get()
    if (row && this.currentStatus.state === 'ready') this.db.prepare('UPDATE directory_snapshot SET last_used = ? WHERE singleton = 1').run(contentTick(this.db))
    return row ? { value: JSON.parse(row.directory_json) as BoardDirectory, fetchedAt: row.fetched_at } : null
  }

  saveFeedPage(page: FeedPage, fetchedAt: string): void {
    const db = this.writable()
    db.transaction(() => {
      const writePost = this.postWriter(db, fetchedAt)
      const summaries: FeedSummaryRow[] = []
      for (const thread of page.threads) {
        const source = { feedKind: page.feed.kind, feedId: page.feed.id, mode: null, page: page.page }
        writePost(thread.head, thread.head.id, { ...source, observedAs: 'head' })
        for (const reply of thread.recentReplies) {
          writePost(reply, thread.head.id, { ...source, observedAs: 'feed-recent-reply' })
        }
        summaries.push({
          headId: thread.head.id,
          replyCount: thread.replyCount,
          recentReplyIds: thread.recentReplies.map((reply) => reply.id),
          remainReplies: thread.remainReplies
        })
      }
      db.prepare(`
        INSERT INTO feed_pages (feed_kind, feed_id, page, fetched_at, summaries_json, skipped_items)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(feed_kind, feed_id, page) DO UPDATE SET
          fetched_at = excluded.fetched_at, summaries_json = excluded.summaries_json,
          skipped_items = excluded.skipped_items
      `).run(page.feed.kind, page.feed.id, page.page, fetchedAt, JSON.stringify(summaries), page.skippedItems)
      db.prepare('UPDATE feed_pages SET last_used = ? WHERE feed_kind = ? AND feed_id = ? AND page = ?').run(contentTick(db), page.feed.kind, page.feed.id, page.page)
    })()
  }

  loadFeedPage(feed: FeedRef, page: number): Stored<FeedPage> | null {
    if (!this.db) return null
    const db = this.db
    return db.transaction(() => {
      const row = db.prepare<[string, string, number], {
        fetched_at: string
        summaries_json: string
        skipped_items: number
      }>('SELECT * FROM feed_pages WHERE feed_kind = ? AND feed_id = ? AND page = ?')
        .get(feed.kind, feed.id, page)
      if (!row) return null
      const readPost = this.postReader(db)
      const summaries = JSON.parse(row.summaries_json) as FeedSummaryRow[]
      if (this.currentStatus.state === 'ready') {
        db.prepare('UPDATE feed_pages SET last_used = ? WHERE feed_kind = ? AND feed_id = ? AND page = ?').run(contentTick(db), feed.kind, feed.id, page)
        for (const summary of summaries) touchThread(db, summary.headId)
      }
      return {
        fetchedAt: row.fetched_at,
        value: {
          feed,
          page,
          skippedItems: row.skipped_items,
          threads: summaries.map((summary) => ({
            head: readPost(summary.headId),
            replyCount: summary.replyCount,
            recentReplies: summary.recentReplyIds.map(readPost),
            remainReplies: summary.remainReplies
          }))
        }
      }
    })()
  }

  saveThreadPage(page: ThreadPage, fetchedAt: string): ThreadCoverage {
    const db = this.writable()
    return db.transaction(() => {
      assertReadablePage(page, this.getThreadCoverage(page.threadId, page.mode))
      const writePost = this.postWriter(db, fetchedAt)
      const source = { feedKind: null, feedId: null, mode: page.mode, page: page.page }
      writePost(page.head, page.threadId, { ...source, observedAs: 'head' })
      for (const reply of page.replies) {
        writePost(reply, page.threadId, { ...source, observedAs: 'thread-reply' })
      }
      db.prepare(`
        INSERT INTO thread_pages (
          thread_id, mode, page, head_id, fetched_at, reply_ids_json,
          reply_count, skipped_items, end_candidate
        ) VALUES (
          @threadId, @mode, @page, @headId, @fetchedAt, @replyIds,
          @replyCount, @skippedItems, @endCandidate
        ) ON CONFLICT(thread_id, mode, page) DO UPDATE SET
          head_id = excluded.head_id, fetched_at = excluded.fetched_at,
          reply_ids_json = excluded.reply_ids_json, reply_count = excluded.reply_count,
          skipped_items = excluded.skipped_items, end_candidate = excluded.end_candidate
      `).run({
        threadId: page.threadId,
        mode: page.mode,
        page: page.page,
        headId: page.head.id,
        fetchedAt,
        replyIds: JSON.stringify(page.replies.map((reply) => reply.id)),
        replyCount: page.replyCount,
        skippedItems: page.skippedItems,
        endCandidate: Number(page.endCandidate)
      })
      db.prepare(`INSERT INTO reading_observations(thread_id, mode, page, fetched_at, reply_ids_json, end_candidate, skipped_items)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(thread_id, mode, page) DO UPDATE SET fetched_at = excluded.fetched_at,
        reply_ids_json = excluded.reply_ids_json, end_candidate = excluded.end_candidate, skipped_items = excluded.skipped_items`)
        .run(page.threadId, page.mode, page.page, fetchedAt, JSON.stringify(page.replies.map((reply) => reply.id)), Number(page.endCandidate), page.skippedItems)
      touchThread(db, page.threadId)
      if (page.replyCount !== null) {
        db.prepare(`
          INSERT INTO thread_reply_counts (thread_id, mode, reply_count, fetched_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(thread_id, mode) DO UPDATE SET
            reply_count = excluded.reply_count, fetched_at = excluded.fetched_at
          WHERE julianday(excluded.fetched_at) >= julianday(thread_reply_counts.fetched_at)
        `).run(page.threadId, page.mode, page.replyCount, fetchedAt)
      }
      const coverage = this.getThreadCoverage(page.threadId, page.mode)
      if (page.mode === 'all') {
        const end = endObservation(page.threadId, coverage)
        if (end !== null) {
          db.prepare('INSERT INTO end_observations (thread_id, observed_at, bound_post_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
            .run(page.threadId, end.observedAt, end.boundPostId)
        }
      }
      return coverage
    })()
  }

  loadThreadPage(threadId: ThreadId, mode: ReadingMode, page: number): Stored<ThreadPage> | null {
    if (!this.db) return null
    const db = this.db
    return db.transaction(() => {
      let row = db.prepare<[string, string, number], ThreadPageRow>(
        'SELECT * FROM thread_pages WHERE thread_id = ? AND mode = ? AND page = ?'
      ).get(threadId, mode, page)
      if (mode === 'all') {
        const offline = db.prepare<[string, number], ThreadPageRow>(`SELECT page, head_id, fetched_at,
          '[]' AS reply_ids_json, reply_count, skipped_items, end_candidate FROM offline_pages WHERE thread_id = ? AND page = ?`).get(threadId, page)
        if (offline) {
          const ids = new Set(row ? JSON.parse(row.reply_ids_json) as string[] : [])
          for (const post of db.prepare<[string, number], { post_id: string }>('SELECT post_id FROM offline_page_posts WHERE thread_id = ? AND page = ?').all(threadId, page)) ids.add(post.post_id)
          const replies = [...ids].sort((a, b) => a.length - b.length || a.localeCompare(b))
          row = { ...(row ?? offline), reply_ids_json: JSON.stringify(replies) }
        }
      }
      if (!row) return null
      if (this.currentStatus.state === 'ready') touchThread(db, threadId)
      const readPost = this.postReader(db)
      return {
        fetchedAt: row.fetched_at,
        value: {
          threadId,
          mode,
          page,
          head: readPost(row.head_id),
          replies: (JSON.parse(row.reply_ids_json) as string[]).map(readPost),
          replyCount: row.reply_count,
          skippedItems: row.skipped_items,
          endCandidate: row.end_candidate !== 0
        }
      }
    })()
  }

  getThreadCoverage(threadId: ThreadId, mode: ReadingMode): ThreadCoverage {
    if (!this.db) return computeCoverage(threadId, mode, [], null)
    const db = this.db
    const rows = db.prepare<[string, string], ThreadPageRow>(`
      SELECT * FROM thread_pages WHERE thread_id = ? AND mode = ? ORDER BY page
    `).all(threadId, mode)
    const latestCount = db.prepare<[string, string], { reply_count: number }>(`
      SELECT reply_count FROM thread_reply_counts WHERE thread_id = ? AND mode = ?
    `).get(threadId, mode)
    const pages: CoveragePage[] = rows.map((row) => ({
      page: row.page,
      fetchedAt: row.fetched_at,
      replyIds: JSON.parse(row.reply_ids_json) as string[],
      endCandidate: row.end_candidate !== 0,
      skippedItems: row.skipped_items
    }))
    if (mode === 'all') {
      const retained = db.prepare<[string], ThreadPageRow>(`SELECT o.*, '[]' AS reply_ids_json FROM offline_pages o WHERE thread_id = ? ORDER BY page`).all(threadId)
      for (const offline of retained) {
        if (pages.some((page) => page.page === offline.page)) continue
        const replies = db.prepare<[string, number], { post_id: string }>('SELECT post_id FROM offline_page_posts WHERE thread_id = ? AND page = ?').all(threadId, offline.page)
        pages.push({ page: offline.page, fetchedAt: offline.fetched_at, replyIds: replies.map((reply) => reply.post_id), endCandidate: offline.end_candidate !== 0, skippedItems: offline.skipped_items })
      }
      pages.sort((a, b) => a.page - b.page)
    }
    return computeCoverage(threadId, mode, pages, latestCount?.reply_count ?? null)
  }

  savePost(post: Post, fetchedAt: string): void {
    const db = this.writable()
    db.transaction(() => {
      this.postUpserter(db, fetchedAt)(post)
      db.prepare('UPDATE posts SET last_used = ? WHERE id = ?').run(contentTick(db), post.id)
    })()
  }

  loadPost(postId: PostId): Stored<Post> | null {
    if (!this.db) return null
    const row = this.db.prepare<[string], PostRow>('SELECT * FROM posts WHERE id = ?').get(postId)
    if (row && this.currentStatus.state === 'ready') {
      this.db.prepare('UPDATE posts SET last_used = ? WHERE id = ?').run(contentTick(this.db), postId)
    }
    return row ? { value: postFromRow(row), fetchedAt: row.fetched_at } : null
  }

  findPostThread(postId: PostId): PostThreadRelation | null {
    if (!this.db) return null
    const db = this.db
    return db.transaction(() => {
      const relation = db.prepare<[string], { thread_id: string }>('SELECT thread_id FROM post_threads WHERE post_id = ?').get(postId)
      if (!relation) return null
      const threadId = relation.thread_id
      const preference = db.prepare<[string], { mode: ReadingMode }>('SELECT mode FROM thread_reading WHERE thread_id = ?').get(threadId)
      const pages: Record<ReadingMode, number | null> = { all: null, po: null }
      if (threadId !== postId) {
        const rows = db.prepare<[string, string, string, string], { mode: ReadingMode; page: number }>(`
          SELECT mode, page FROM (
            SELECT thread_pages.mode, thread_pages.page, thread_pages.fetched_at
            FROM thread_pages, json_each(thread_pages.reply_ids_json) AS reply
            WHERE thread_pages.thread_id = ? AND reply.value = ?
            UNION ALL
            SELECT 'all', offline_pages.page, offline_pages.fetched_at
            FROM offline_pages JOIN offline_page_posts USING (thread_id, page)
            WHERE offline_pages.thread_id = ? AND offline_page_posts.post_id = ?
          ) ORDER BY julianday(fetched_at) DESC, page DESC
        `).all(threadId, postId, threadId, postId)
        for (const row of rows) pages[row.mode] ??= row.page
      }
      return { threadId, isHead: threadId === postId, preferredMode: preference?.mode ?? 'all', pages }
    })()
  }

  getReadingState(threadId: ThreadId): ThreadReadingState {
    if (!this.db) return emptyReadingState(threadId)
    const db = this.db
    return db.transaction(() => {
      const modeRow = db.prepare<[string], { mode: ReadingMode }>('SELECT mode FROM thread_reading WHERE thread_id = ?').get(threadId)
      const positions: Record<ReadingMode, SavedPosition | null> = { all: null, po: null }
      const positionRows = db.prepare<[string], {
        mode: ReadingMode
        post_id: string
        page: number
        offset_ratio: number
        viewport_offset: number
        saved_at: string
      }>('SELECT * FROM reading_positions WHERE thread_id = ?').all(threadId)
      for (const row of positionRows) {
        positions[row.mode] = {
          anchor: { postId: row.post_id, page: row.page, offsetRatio: row.offset_ratio, viewportOffset: row.viewport_offset },
          savedAt: row.saved_at
        }
      }
      const readPostIds = db.prepare<[string], { post_id: string }>('SELECT post_id FROM post_reads WHERE thread_id = ?')
        .all(threadId)
        .map((row) => row.post_id)
      const attentionRow = db.prepare<[string], { started_at: string; source: AttentionSource; watermark_post_id: string | null }>(
        'SELECT started_at, source, watermark_post_id FROM thread_attention WHERE thread_id = ?'
      ).get(threadId)
      const attention: AttentionRecord | null = attentionRow
        ? {
            startedAt: attentionRow.started_at,
            source: attentionRow.source,
            watermarkPostId: attentionRow.watermark_post_id,
            firstProvenNewPostId: this.firstProvenNewPost(attentionRow.started_at)
          }
        : null
      const coverage = { all: this.getThreadCoverage(threadId, 'all'), po: this.getThreadCoverage(threadId, 'po') }
      const observedCoverage = (mode: ReadingMode): ThreadCoverage => {
        const rows = db.prepare<[string, string], ThreadPageRow>('SELECT * FROM reading_observations WHERE thread_id = ? AND mode = ? ORDER BY page').all(threadId, mode)
        return computeCoverage(threadId, mode, rows.map((row) => ({ page: row.page, fetchedAt: row.fetched_at,
          replyIds: JSON.parse(row.reply_ids_json) as string[], endCandidate: row.end_candidate !== 0, skippedItems: row.skipped_items })), coverage[mode].reportedReplyCount)
      }
      const state = buildReadingState({
        threadId,
        mode: modeRow?.mode ?? 'all',
        positions,
        readPostIds,
        attention,
        coverage: { all: observedCoverage('all'), po: observedCoverage('po') }
      })
      return { ...state, coverage }
    })()
  }

  setReadingMode(threadId: ThreadId, mode: ReadingMode, at: string): void {
    const db = this.writable()
    db.prepare(`
      INSERT INTO thread_reading (thread_id, mode, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET mode = excluded.mode, updated_at = excluded.updated_at
    `).run(threadId, mode, at)
  }

  saveReadingPosition(threadId: ThreadId, mode: ReadingMode, anchor: ReadingAnchor, at: string): void {
    const db = this.writable()
    db.prepare(`
      INSERT INTO reading_positions (thread_id, mode, post_id, page, offset_ratio, viewport_offset, saved_at)
      VALUES (@threadId, @mode, @postId, @page, @offsetRatio, @viewportOffset, @at)
      ON CONFLICT(thread_id, mode) DO UPDATE SET
        post_id = excluded.post_id, page = excluded.page, offset_ratio = excluded.offset_ratio,
        viewport_offset = excluded.viewport_offset, saved_at = excluded.saved_at
    `).run({ threadId, mode, ...anchor, at })
  }

  markPostsRead(threadId: ThreadId, postIds: PostId[], at: string): PostId[] {
    const db = this.writable()
    return db.transaction(() => {
      // Only posts actually observed as part of this thread can be read in it.
      const belongs = db.prepare<[string, string], { found: number }>(
        'SELECT 1 AS found FROM post_threads WHERE post_id = ? AND thread_id = ?'
      )
      const insert = db.prepare(`
        INSERT INTO post_reads (post_id, thread_id, read_at) VALUES (?, ?, ?)
        ON CONFLICT(post_id) DO NOTHING
      `)
      const marked: PostId[] = []
      for (const postId of new Set(postIds)) {
        if (!belongs.get(postId, threadId)) continue
        if (insert.run(postId, threadId, at).changes === 1) marked.push(postId)
      }
      return marked
    })()
  }

  recordVisit(threadId: ThreadId, at: string): void {
    const db = this.writable()
    db.prepare(`
      INSERT INTO thread_visits (thread_id, first_visited_at, last_visited_at, visit_count) VALUES (?, ?, ?, 1)
      ON CONFLICT(thread_id) DO UPDATE SET
        last_visited_at = excluded.last_visited_at, visit_count = thread_visits.visit_count + 1
    `).run(threadId, at, at)
  }

  establishAttention(threadId: ThreadId, source: AttentionSource, at: string): AttentionState {
    const db = this.writable()
    return db.transaction(() => {
      // The highest post ID observed anywhere so far: every post at or below it existed before now.
      const watermark = db.prepare<[], { id: string }>('SELECT post_id AS id FROM post_threads ORDER BY length(post_id) DESC, post_id DESC LIMIT 1').get()
      db.prepare(`
        INSERT INTO thread_attention (thread_id, started_at, source, watermark_post_id) VALUES (?, ?, ?, ?)
        ON CONFLICT(thread_id) DO NOTHING
      `).run(threadId, at, source, watermark?.id ?? null)
      return this.getReadingState(threadId).attention as AttentionState
    })()
  }

  /**
   * Lowest observed post ID proven to be posted after `since`: a reply of any thread that was first
   * seen after an end observation made at or after `since` and lies above that observation's bound.
   * A reply seen before the observation existed then and only fell outside the bound because it
   * was removed, so it proves nothing. Post IDs increase with time, so every post with an ID at or
   * above the result was posted after `since` too. Uses only observations already stored.
   */
  firstProvenNewPost(since: string): PostId | null {
    if (!this.db) return null
    const row = this.db.prepare<[string], { post_id: string }>(`
      SELECT relation.post_id FROM end_observations AS observation
      JOIN post_threads AS relation
        ON relation.thread_id = observation.thread_id AND relation.post_id <> observation.thread_id
      WHERE julianday(observation.observed_at) >= julianday(?)
        AND julianday(relation.fetched_at) > julianday(observation.observed_at)
        AND (length(relation.post_id) > length(observation.bound_post_id)
          OR (length(relation.post_id) = length(observation.bound_post_id) AND relation.post_id > observation.bound_post_id))
      ORDER BY length(relation.post_id), relation.post_id
      LIMIT 1
    `).get(since)
    return row?.post_id ?? null
  }

  /** Each stored value is validated again; an unreadable or invalid value falls back to its default. */
  loadSettings(): AppSettings {
    if (!this.db) return { ...DEFAULT_SETTINGS }
    const rows = this.db.prepare<[], { key: string; value_json: string }>('SELECT key, value_json FROM settings').all()
    const stored = new Map<string, unknown>()
    for (const row of rows) {
      try {
        stored.set(row.key, JSON.parse(row.value_json))
      } catch {
        // Corrupt row: its default applies.
      }
    }
    return settingsFromStored(stored)
  }

  saveSettings(settings: AppSettings): void {
    const db = this.writable()
    db.transaction(() => {
      const statement = db.prepare(`
        INSERT INTO settings (key, value_json) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json
      `)
      for (const [key, value] of Object.entries(settings)) statement.run(key, JSON.stringify(value))
    })()
  }

  /** The workspace saved at the last real quit, as given; `null` when none was saved. */
  loadWorkspace(): string | null {
    if (!this.db) throw new StorageWriteRefusedError(this.currentStatus)
    return this.db.prepare<[], { state_json: string }>('SELECT state_json FROM workspace WHERE id = 1').get()?.state_json ?? null
  }

  saveWorkspace(state: string, at: string): void {
    this.writable().prepare(`
      INSERT INTO workspace (id, state_json, saved_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state_json = excluded.state_json, saved_at = excluded.saved_at
    `).run(state, at)
  }

  getPostImage(postId: PostId): PostImage | null {
    if (!this.db) return null
    const row = this.db.prepare<[string], { image_path: string | null; image_ext: string | null }>(
      'SELECT image_path, image_ext FROM posts WHERE id = ?'
    ).get(postId)
    return row?.image_path == null || row.image_ext === null ? null : { path: row.image_path, ext: row.image_ext }
  }

  private holdImage(db: Database.Database, resourceId: number, holders: ImageHolder[]): void {
    const statement = db.prepare(`
      INSERT INTO image_holders (resource_id, holder_kind, holder_id, held_at) VALUES (?, ?, ?, ?)
      ON CONFLICT DO NOTHING
    `)
    const at = new Date().toISOString()
    for (const holder of holders) statement.run(resourceId, holder.kind, holder.id, at)
  }

  findImageResource(kind: ImageKind, sourceUrl: string, holder: ImageHolder | null): ImageResourceRecord | null {
    if (!this.db) return null
    const db = this.db
    const find = () => {
      const row = db.prepare<[string, string], ImageResourceRow>(
        'SELECT * FROM image_resources WHERE kind = ? AND source_url = ?'
      ).get(kind, sourceUrl)
      if (!row) return null
      if (this.currentStatus.state === 'ready') db.prepare('UPDATE image_resources SET last_used = ? WHERE id = ?').run(contentTick(db), row.id)
      if (holder !== null) this.holdImage(this.writable(), row.id, [holder])
      return imageResource(row)
    }
    return holder === null ? find() : db.transaction(find)()
  }

  commitImageResource(
    resource: NewImageResource,
    holders: ImageHolder[]
  ): { resource: ImageResourceRecord; replacedFileName: string | null } {
    const db = this.writable()
    return db.transaction(() => {
      const previous = db.prepare<[string, string], { file_name: string }>(
        'SELECT file_name FROM image_resources WHERE kind = ? AND source_url = ?'
      ).get(resource.kind, resource.sourceUrl)
      const row = db.prepare<NewImageResource, ImageResourceRow>(`
        INSERT INTO image_resources (kind, source_url, file_name, format, bytes, width, height, fetched_at)
        VALUES (@kind, @sourceUrl, @fileName, @format, @bytes, @width, @height, @fetchedAt)
        ON CONFLICT(kind, source_url) DO UPDATE SET
          file_name = excluded.file_name, format = excluded.format, bytes = excluded.bytes,
          width = excluded.width, height = excluded.height, fetched_at = excluded.fetched_at
        RETURNING *
      `).get(resource) as ImageResourceRow
      this.holdImage(db, row.id, holders)
      db.prepare('UPDATE image_resources SET last_used = ? WHERE id = ?').run(contentTick(db), row.id)
      const replaced = previous !== undefined && previous.file_name !== row.file_name ? previous.file_name : null
      return { resource: imageResource(row), replacedFileName: replaced }
    })()
  }

  releaseImageHolders(kind: ImageHolder['kind'], idPrefix: string): void {
    const db = this.writable()
    db.prepare('DELETE FROM image_holders WHERE holder_kind = ? AND substr(holder_id, 1, length(?)) = ?')
      .run(kind, idPrefix, idPrefix)
  }

  deleteUnheldImages(resourceIds: number[]): string[] {
    const db = this.writable()
    return db.transaction(() => {
      const remove = db.prepare<[number], { file_name: string }>(`
        DELETE FROM image_resources
        WHERE id = ? AND NOT EXISTS (SELECT 1 FROM image_holders WHERE resource_id = image_resources.id)
          AND NOT EXISTS (SELECT 1 FROM offline_images WHERE resource_id = image_resources.id)
        RETURNING file_name
      `)
      const removed: string[] = []
      for (const id of new Set(resourceIds)) {
        const row = remove.get(id)
        if (row) removed.push(row.file_name)
      }
      return removed
    })()
  }

  listImageFileNames(): string[] {
    if (!this.db) return []
    return this.db.prepare<[], { file_name: string }>('SELECT file_name FROM image_resources').all().map((row) => row.file_name)
  }

  loadAccountSession(): { ciphertext: Uint8Array; expiresAt: string } | null {
    if (!this.db) throw new StorageWriteRefusedError(this.status)
    const row = this.db.prepare<[], { ciphertext: Buffer; expires_at: string }>(
      'SELECT ciphertext, expires_at FROM account_session WHERE singleton = 1'
    ).get()
    return row ? { ciphertext: new Uint8Array(row.ciphertext), expiresAt: row.expires_at } : null
  }

  saveAccountSession(input: { ciphertext: Uint8Array; expiresAt: string }): void {
    this.writable().prepare(`INSERT INTO account_session (singleton, ciphertext, expires_at) VALUES (1, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET ciphertext = excluded.ciphertext, expires_at = excluded.expires_at`)
      .run(Buffer.from(input.ciphertext), input.expiresAt)
  }

  clearAccountSession(): void {
    this.writable().prepare('DELETE FROM account_session WHERE singleton = 1').run()
  }

  listCredentials(): CredentialSummary[] {
    if (!this.db) return []
    return this.db.prepare<[], CredentialRow>(
      'SELECT id, name, source, imported_at FROM credentials ORDER BY position, id'
    ).all().map(credentialSummary)
  }

  loadCredentialCiphertexts(): Array<{ id: CredentialId; ciphertext: Uint8Array }> {
    if (!this.db) return []
    return this.db.prepare<[], { id: number; ciphertext: Buffer }>('SELECT id, ciphertext FROM credentials ORDER BY id')
      .all().map((row) => ({ id: String(row.id), ciphertext: new Uint8Array(row.ciphertext) }))
  }

  loadCredentialCiphertext(id: CredentialId): Uint8Array | null {
    if (!this.db) return null
    const row = this.db.prepare<[string], { ciphertext: Buffer }>('SELECT ciphertext FROM credentials WHERE id = ?').get(id)
    return row ? new Uint8Array(row.ciphertext) : null
  }

  insertCredential(input: { name: string; source: CredentialSource; importedAt: string; ciphertext: Uint8Array }): CredentialSummary {
    const db = this.writable()
    const row = db.prepare<[string, string, string, Buffer], CredentialRow>(`
      INSERT INTO credentials (name, source, imported_at, ciphertext, position)
      VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM credentials))
      RETURNING id, name, source, imported_at
    `).get(input.name, input.source, input.importedAt, Buffer.from(input.ciphertext))
    if (!row) throw new Error('credential insert returned no row')
    return credentialSummary(row)
  }

  renameCredential(id: CredentialId, name: string): boolean {
    return this.writable().prepare('UPDATE credentials SET name = ? WHERE id = ?').run(name, id).changes === 1
  }

  deleteCredential(id: CredentialId): boolean {
    return this.writable().prepare('DELETE FROM credentials WHERE id = ?').run(id).changes === 1
  }

  reorderCredentials(ids: CredentialId[]): boolean {
    const db = this.writable()
    return db.transaction(() => {
      const stored = db.prepare<[], { id: number }>('SELECT id FROM credentials').all().map((row) => String(row.id))
      if (ids.length !== stored.length || new Set(ids).size !== ids.length || !ids.every((id) => stored.includes(id))) return false
      const update = db.prepare('UPDATE credentials SET position = ? WHERE id = ?')
      ids.forEach((id, index) => update.run(index + 1, id))
      return true
    }).immediate()
  }

  loadRoleSelections(): Record<IdentityRole, RoleSelection> {
    const roles = noRoles()
    if (!this.db) return roles
    const rows = this.db.prepare<[], { role: IdentityRole; credential_id: number | null; present: number }>(`
      SELECT r.role, r.credential_id, EXISTS (SELECT 1 FROM credentials c WHERE c.id = r.credential_id) AS present
      FROM identity_roles r
    `).all()
    for (const row of rows) {
      if (!IDENTITY_ROLES.includes(row.role) || row.credential_id === null) continue
      const credentialId = String(row.credential_id)
      roles[row.role] = row.present ? { state: 'selected', credentialId } : { state: 'missing', credentialId }
    }
    return roles
  }

  setRoleSelection(role: IdentityRole, id: CredentialId | null): boolean {
    const db = this.writable()
    return db.transaction(() => {
      if (id !== null && !db.prepare('SELECT 1 FROM credentials WHERE id = ?').get(id)) return false
      const previous = db.prepare<[string], { credential_id: number | null }>(
        'SELECT credential_id FROM identity_roles WHERE role = ?'
      ).get(role)
      if (role === 'web-sync' && (previous?.credential_id === null || previous === undefined ? null : String(previous.credential_id)) !== id) {
        db.prepare('UPDATE subscription_configuration SET generation = generation + 1 WHERE singleton = 1').run()
      }
      db.prepare(`
        INSERT INTO identity_roles (role, credential_id) VALUES (?, ?)
        ON CONFLICT(role) DO UPDATE SET credential_id = excluded.credential_id
      `).run(role, id)
      return true
    }).immediate()
  }

  private attachmentById(db: Database.Database, id: number | string | null): DraftAttachmentRecord | null {
    if (id === null) return null
    const row = db.prepare<[number | string], DraftAttachmentRow>('SELECT * FROM draft_attachments WHERE id = ?').get(id)
    return row ? draftAttachment(row) : null
  }

  listDrafts(): DraftRecord[] {
    if (!this.db) return []
    const db = this.db
    return db.transaction(() =>
      db.prepare<[], DraftRow>('SELECT * FROM drafts ORDER BY saved_at DESC, id DESC').all()
        .map((row) => draftRecord(row, this.attachmentById(db, row.attachment_id)))
    )()
  }

  private draftLocked(db: Database.Database, id: DraftId): boolean {
    return db.prepare(`
      SELECT 1 FROM publication_attempts
      WHERE draft_id = ? AND state IN ('sending', 'unknown', 'unconfirmed')
    `).get(id) !== undefined
  }

  saveDraft(input: DraftSaveInput, at: string): DraftWriteOutcome {
    const db = this.writable()
    return db.transaction((): DraftWriteOutcome => {
      if (input.draftId !== null && this.draftLocked(db, input.draftId)) return { ok: false, reason: 'locked' }
      const attachment = input.attachmentId === null ? null : this.attachmentById(db, input.attachmentId)
      if (input.attachmentId !== null && attachment === null) return { ok: false, reason: 'attachment-missing' }
      const values = {
        targetKind: input.target.kind,
        targetId: input.target.kind === 'reply' ? input.target.threadId : input.target.forumId,
        credentialId: input.credentialId,
        ...input.fields,
        watermark: input.fields.watermark ? 1 : 0,
        attachmentId: input.attachmentId,
        at
      }
      const row = input.draftId === null
        ? db.prepare<typeof values, DraftRow>(`
            INSERT INTO drafts (target_kind, target_id, credential_id, content, title, name, email, watermark,
              attachment_id, version, created_at, saved_at)
            VALUES (@targetKind, @targetId, @credentialId, @content, @title, @name, @email, @watermark,
              @attachmentId, 1, @at, @at)
            RETURNING *
          `).get(values)
        : db.prepare<typeof values & { id: string }, DraftRow>(`
            UPDATE drafts SET target_kind = @targetKind, target_id = @targetId, credential_id = @credentialId,
              content = @content, title = @title, name = @name, email = @email, watermark = @watermark,
              attachment_id = @attachmentId, version = version + 1, saved_at = @at
            WHERE id = @id
            RETURNING *
          `).get({ ...values, id: input.draftId })
      if (!row) return { ok: false, reason: 'not-found' }
      return { ok: true, draft: draftRecord(row, attachment) }
    }).immediate()
  }

  private publicationDatabase(): Database.Database {
    if (this.db === null) throw new StorageWriteRefusedError(this.currentStatus)
    return this.db
  }

  createPublication(input: Parameters<PublicationStore['createPublication']>[0]): PublicationAttempt {
    const db = this.writable()
    return db.transaction(() => {
      const existing = db.prepare<[string], PublicationRow>('SELECT * FROM publication_attempts WHERE request_id = ?').get(input.requestId)
      if (existing) return publicationAttempt(existing)
      const { payload } = input
      if (payload.credentialId === null) throw new Error('publication requires a credential')
      if (payload.draftId !== null) {
        if (!db.prepare('SELECT 1 FROM drafts WHERE id = ?').get(payload.draftId)) throw new Error('source draft not found')
        if (this.draftLocked(db, payload.draftId)) throw new Error('source draft locked')
      }
      if (payload.attachmentId !== null && this.attachmentById(db, payload.attachmentId) === null) {
        throw new Error('publication attachment missing')
      }
      if (input.switchThreadIdentity && payload.target.kind === 'reply' &&
          !this.setThreadPostIdentity(payload.target.threadId, payload.credentialId, input.at)) {
        throw new Error('publication credential unavailable')
      }
      const row = db.prepare<{
        requestId: string; editorId: string; draftId: string | null; payload: string;
        credentialId: string; forumId: string; attachmentId: string | null; at: string
      }, PublicationRow>(`
        INSERT INTO publication_attempts (
          request_id, editor_id, draft_id, payload_json, credential_id, forum_id,
          attachment_id, state, created_at, updated_at
        ) VALUES (@requestId, @editorId, @draftId, @payload, @credentialId, @forumId,
          @attachmentId, 'sending', @at, @at)
        RETURNING *
      `).get({
        requestId: input.requestId, editorId: input.editorId, draftId: payload.draftId,
        payload: JSON.stringify(payload), credentialId: payload.credentialId, forumId: input.forumId,
        attachmentId: payload.attachmentId, at: input.at
      })
      if (!row) throw new Error('publication insert returned no row')
      return publicationAttempt(row)
    }).immediate()
  }

  listPublications(): PublicationAttempt[] {
    return this.publicationDatabase().prepare<[], PublicationRow>(
      'SELECT * FROM publication_attempts ORDER BY created_at DESC, id DESC'
    ).all().map(publicationAttempt)
  }

  getPublication(id: string): PublicationAttempt | null {
    const row = this.publicationDatabase().prepare<[string], PublicationRow>('SELECT * FROM publication_attempts WHERE id = ?').get(id)
    return row ? publicationAttempt(row) : null
  }

  finishPublication(input: Parameters<PublicationStore['finishPublication']>[0]): PublicationAttempt {
    const db = this.writable()
    return db.transaction(() => {
      const attempt = this.getPublication(input.id)
      if (!attempt) throw new Error('publication not found')
      // A stale callback cannot undo known success or make an uncertain submission retryable.
      // Positive evidence may still resolve an unknown result (including startup recovery).
      if (attempt.state === 'confirmed' || attempt.state === 'failed' || attempt.state === input.state
        || (attempt.state === 'unconfirmed' && input.state !== 'confirmed')
        || (attempt.state === 'unknown' && input.state !== 'confirmed' && input.state !== 'unconfirmed')) return attempt

      let savedDraftId: string | null = null
      if (input.state === 'confirmed') {
        const { payload } = attempt
        const isThread = payload.target.kind === 'thread'
        if (!input.postId || !input.threadId || payload.credentialId === null
          || (isThread ? input.postId !== input.threadId : payload.target.kind === 'reply' && payload.target.threadId !== input.threadId)) {
          throw new Error('publication confirmation target mismatch')
        }
        const previous = db.prepare<[string], OwnPostRow>('SELECT * FROM own_posts WHERE post_id = ?').get(input.postId)
        if (previous && (previous.thread_id !== input.threadId || previous.is_thread !== Number(isThread)
          || (previous.evidence === 'submission-readback' && String(previous.credential_id) !== payload.credentialId))) {
          throw new Error('own post confirmation conflict')
        }
        db.prepare(`
          INSERT INTO own_posts (post_id, thread_id, is_thread, credential_id, evidence, confirmed_at)
          VALUES (?, ?, ?, ?, 'submission-readback', ?)
          ON CONFLICT(post_id) DO UPDATE SET credential_id = excluded.credential_id,
            evidence = excluded.evidence, confirmed_at = excluded.confirmed_at
          WHERE own_posts.evidence = 'manual'
        `).run(input.postId, input.threadId, Number(isThread), payload.credentialId, input.at)
        if (isThread) {
          db.prepare(`
            INSERT OR IGNORE INTO thread_post_identities (thread_id, credential_id, updated_at) VALUES (?, ?, ?)
          `).run(input.threadId, payload.credentialId, input.at)
        }
        if (attempt.draftId !== null) db.prepare('DELETE FROM drafts WHERE id = ?').run(attempt.draftId)
      }

      // A launch notice is kept only for a failed / unknown result reached without a window; any
      // later result (e.g. positive evidence resolving an unknown one) replaces it.
      const launchNotice = input.launchNotice === true && (input.state === 'failed' || input.state === 'unknown')
      db.prepare(`
        UPDATE publication_attempts SET state = ?, problem = ?, post_id = ?, thread_id = ?, updated_at = ?, launch_notice = ?
        WHERE id = ?
      `).run(input.state, input.state === 'confirmed' ? null : input.problem,
        input.state === 'confirmed' ? input.postId : null, input.state === 'confirmed' ? input.threadId : null, input.at,
        Number(launchNotice), input.id)

      if (input.state === 'failed') {
        // Changing the state above releases the source lock within this same transaction only.
        // A failed save throws, rolling back both the result and all draft changes.
        const saved = this.saveDraft(attempt.payload, input.at)
        if (!saved.ok) throw new Error('failed publication draft could not be saved')
        savedDraftId = saved.draft.id
      }
      if (input.state === 'confirmed' || input.state === 'failed') {
        db.prepare('UPDATE publication_attempts SET attachment_id = NULL, saved_draft_id = ? WHERE id = ?')
          .run(savedDraftId, input.id)
      }
      const finished = this.getPublication(input.id)
      if (!finished) throw new Error('publication result returned no row')
      return finished
    }).immediate()
  }

  /** Startup only: an attempt left `sending` by the last run becomes unknown and leaves a launch notice. */
  recoverPublications(at: string): void {
    this.writable().prepare(`
      UPDATE publication_attempts SET state = 'unknown', problem = 'network', updated_at = ?, launch_notice = 1 WHERE state = 'sending'
    `).run(at)
  }

  listLaunchNotices(): PublicationAttempt[] {
    return this.publicationDatabase().prepare<[], PublicationRow>(
      'SELECT * FROM publication_attempts WHERE launch_notice = 1 ORDER BY created_at, id'
    ).all().map(publicationAttempt)
  }

  dismissLaunchNotices(ids: string[]): void {
    const db = this.writable()
    db.transaction(() => {
      const statement = db.prepare('UPDATE publication_attempts SET launch_notice = 0 WHERE id = ?')
      for (const id of ids) statement.run(id)
    })()
  }

  listOwnPosts(): OwnPost[] {
    return this.publicationDatabase().prepare<[], OwnPostRow>(
      'SELECT * FROM own_posts ORDER BY confirmed_at DESC, post_id DESC'
    ).all().map(ownPost)
  }

  addManualOwnPost(input: Parameters<PublicationStore['addManualOwnPost']>[0]): void {
    const db = this.writable()
    db.transaction(() => {
      if (input.isThread && input.postId !== input.threadId) throw new Error('manual own post target mismatch')
      const previous = db.prepare<[string], OwnPostRow>('SELECT * FROM own_posts WHERE post_id = ?').get(input.postId)
      if (previous && (previous.thread_id !== input.threadId || previous.is_thread !== Number(input.isThread))) {
        throw new Error('manual own post conflict')
      }
      db.prepare(`
        INSERT OR IGNORE INTO own_posts (post_id, thread_id, is_thread, credential_id, evidence, confirmed_at)
        VALUES (?, ?, ?, NULL, 'manual', ?)
      `).run(input.postId, input.threadId, Number(input.isThread), input.at)
    }).immediate()
  }

  getPoWarningEnabled(): boolean {
    const row = this.publicationDatabase().prepare<[], { po_warning_enabled: number }>(
      'SELECT po_warning_enabled FROM publication_settings WHERE id = 1'
    ).get()
    if (!row) throw new Error('publication settings missing')
    return row.po_warning_enabled === 1
  }

  setPoWarningEnabled(enabled: boolean): void {
    this.writable().prepare('UPDATE publication_settings SET po_warning_enabled = ? WHERE id = 1').run(Number(enabled))
  }

  lastPublicationAt(credentialId: string, forumId: string): string | null {
    const row = this.publicationDatabase().prepare<[string, string], { created_at: string }>(`
      SELECT created_at FROM publication_attempts WHERE credential_id = ? AND forum_id = ?
      ORDER BY julianday(created_at) DESC, id DESC LIMIT 1
    `).get(credentialId, forumId)
    return row?.created_at ?? null
  }

  deleteDraft(id: DraftId): boolean | 'locked' {
    const db = this.writable()
    return db.transaction(() => {
      if (this.draftLocked(db, id)) return 'locked' as const
      return db.prepare('DELETE FROM drafts WHERE id = ?').run(id).changes === 1
    }).immediate()
  }

  insertDraftAttachment(input: Omit<DraftAttachmentRecord, 'id'>): DraftAttachmentRecord {
    const row = this.writable().prepare<Omit<DraftAttachmentRecord, 'id'>, DraftAttachmentRow>(`
      INSERT INTO draft_attachments (file_name, format, bytes, width, height, original_name, created_at)
      VALUES (@fileName, @format, @bytes, @width, @height, @originalName, @createdAt)
      RETURNING *
    `).get(input)
    if (!row) throw new Error('attachment insert returned no row')
    return draftAttachment(row)
  }

  getDraftAttachment(id: AttachmentId): DraftAttachmentRecord | null {
    return this.db ? this.attachmentById(this.db, id) : null
  }

  deleteUnreferencedAttachments(keep: AttachmentId[]): string[] {
    const db = this.writable()
    return db.transaction(() => {
      const kept = new Set(keep)
      const rows = db.prepare<[], { id: number; file_name: string }>(`
        SELECT id, file_name FROM draft_attachments
        WHERE NOT EXISTS (SELECT 1 FROM drafts WHERE drafts.attachment_id = draft_attachments.id)
          AND NOT EXISTS (SELECT 1 FROM publication_attempts WHERE publication_attempts.attachment_id = draft_attachments.id)
      `).all().filter((row) => !kept.has(String(row.id)))
      const remove = db.prepare('DELETE FROM draft_attachments WHERE id = ?')
      for (const row of rows) remove.run(row.id)
      return rows.map((row) => row.file_name)
    }).immediate()
  }

  listDraftAttachmentFileNames(): string[] {
    if (!this.db) return []
    return this.db.prepare<[], { file_name: string }>('SELECT file_name FROM draft_attachments').all().map((row) => row.file_name)
  }

  getThreadPostIdentity(threadId: ThreadId): RoleSelection {
    if (!this.db) return { state: 'none' }
    const row = this.db.prepare<[string], { credential_id: number; present: number }>(`
      SELECT t.credential_id, EXISTS (SELECT 1 FROM credentials c WHERE c.id = t.credential_id) AS present
      FROM thread_post_identities t WHERE t.thread_id = ?
    `).get(threadId)
    if (!row) return { state: 'none' }
    const credentialId = String(row.credential_id)
    return row.present ? { state: 'selected', credentialId } : { state: 'missing', credentialId }
  }

  setThreadPostIdentity(threadId: ThreadId, id: CredentialId, at: string): boolean {
    const db = this.writable()
    return db.transaction(() => {
      if (!db.prepare('SELECT 1 FROM credentials WHERE id = ?').get(id)) return false
      db.prepare(`
        INSERT INTO thread_post_identities (thread_id, credential_id, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET credential_id = excluded.credential_id, updated_at = excluded.updated_at
      `).run(threadId, id, at)
      return true
    }).immediate()
  }

  loadSubscriptionConfiguration(): SubscriptionConfiguration {
    if (!this.db) return { context: { generation: 0, appCredentialId: null, webCredentialId: null }, source: 'app' }
    const row = this.db.prepare<[], { generation: number; app_credential_id: string | null; source: SubscriptionSource }>(
      'SELECT generation, app_credential_id, source FROM subscription_configuration WHERE singleton = 1'
    ).get()!
    const selection = this.loadRoleSelections()['web-sync']
    return {
      source: row.source,
      context: { generation: row.generation, appCredentialId: row.app_credential_id,
        webCredentialId: selection.state === 'none' ? null : selection.credentialId }
    }
  }

  setSubscriptionAppCredential(id: string, ciphertext: Uint8Array): void {
    const db = this.writable()
    db.transaction(() => {
      db.prepare('INSERT INTO subscription_app_credentials (id, ciphertext) VALUES (?, ?)').run(id, Buffer.from(ciphertext))
      db.prepare(`UPDATE subscription_configuration SET app_credential_id = ?, generation = generation + 1 WHERE singleton = 1`).run(id)
    }).immediate()
  }

  loadSubscriptionAppCiphertext(id: string): Uint8Array | null {
    if (!this.db) return null
    const row = this.db.prepare<[string], { ciphertext: Buffer }>(
      'SELECT ciphertext FROM subscription_app_credentials WHERE id = ?'
    ).get(id)
    return row ? new Uint8Array(row.ciphertext) : null
  }

  listSubscriptionAppCredentials(): string[] {
    if (!this.db) return []
    return this.db.prepare<[], { id: string }>('SELECT id FROM subscription_app_credentials ORDER BY rowid DESC').all().map((row) => row.id)
  }

  setSubscriptionSource(source: SubscriptionSource): void {
    this.writable().prepare('UPDATE subscription_configuration SET source = ? WHERE singleton = 1').run(source)
  }

  loadSubscriptionObservation(source: SubscriptionSource, context: SubscriptionContext, validOnly = false): SubscriptionObservation | null {
    if (!this.db) return null
    const column = validOnly ? 'valid_observation_json' : 'observation_json'
    const row = this.db.prepare<[string, number, string | null, string | null, number], { observation_json: string }>(`
      SELECT ${column} AS observation_json FROM subscription_observations
      WHERE source = ? AND generation = ? AND app_credential_id IS ? AND web_credential_id IS ?
      AND (? = 0 OR valid_observation_json IS NOT NULL)
      ORDER BY rowid DESC LIMIT 1
    `).get(source, context.generation, context.appCredentialId, context.webCredentialId, Number(validOnly))
    return row ? JSON.parse(row.observation_json) as SubscriptionObservation : null
  }

  loadSubscriptionObservationById(id: string): SubscriptionObservation | null {
    if (!this.db) return null
    const row = this.db.prepare<[string], { observation_json: string }>(
      'SELECT observation_json FROM subscription_observations WHERE id = ?'
    ).get(id)
    return row ? JSON.parse(row.observation_json) as SubscriptionObservation : null
  }

  saveSubscriptionObservation(observation: SubscriptionObservation, attention: AttentionSource): void {
    const db = this.writable()
    db.transaction(() => {
      const serialized = JSON.stringify(observation)
      const valid = !observation.error && !observation.cancelled && observation.pages.length > 0 ? serialized : null
      db.prepare(`INSERT INTO subscription_observations
        (id, source, generation, app_credential_id, web_credential_id, observation_json, valid_observation_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET observation_json = excluded.observation_json,
          valid_observation_json = COALESCE(excluded.valid_observation_json, subscription_observations.valid_observation_json)
      `).run(observation.id, observation.source, observation.context.generation, observation.context.appCredentialId,
        observation.context.webCredentialId, serialized, valid)
      this.projectSubscriptionEvidence(db, observation, 'observation:' + observation.id)
      if (valid !== null) this.projectSubscriptionEvidence(db, observation, 'valid:' + observation.id)
      for (const page of observation.pages) {
        const writePost = this.postWriter(db, page.fetchedAt)
        for (const thread of page.threads) {
          const source = { feedKind: null, feedId: null, mode: null, page: page.page }
          writePost(thread.head, thread.head.id, { ...source, observedAs: 'head' })
          for (const reply of thread.recentReplies) {
            writePost(reply, thread.head.id, { ...source, observedAs: 'feed-recent-reply' })
          }
          this.establishAttention(thread.head.id, attention, page.fetchedAt)
        }
      }
    })()
  }

  private projectSubscriptionEvidence(db: Database.Database, observation: SubscriptionObservation, owner: string): void {
    db.exec('CREATE TEMP TABLE IF NOT EXISTS search_observed_ids(id TEXT PRIMARY KEY); DELETE FROM search_observed_ids')
    const remember = db.prepare('INSERT OR IGNORE INTO search_observed_ids VALUES(?)')
    for (const page of observation.pages) for (const thread of page.threads) {
      remember.run(thread.head.id)
      projectSearchPost(db, thread.head, page.fetchedAt, thread.head.id, owner)
      for (const reply of thread.recentReplies) {
        remember.run(reply.id)
        projectSearchPost(db, reply, page.fetchedAt, thread.head.id, owner,
          reply.userHash === null || thread.head.userHash === null ? null : reply.userHash === thread.head.userHash)
      }
    }
    db.prepare('DELETE FROM search_sources WHERE owner=? AND post_id NOT IN (SELECT id FROM search_observed_ids)').run(owner)
  }

  saveSubscriptionOperation(operation: SubscriptionOperation): void {
    const db = this.writable()
    db.transaction(() => {
      db.prepare(`INSERT INTO subscription_operations (id, operation_json) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET operation_json = excluded.operation_json`).run(operation.id, JSON.stringify(operation))
      for (const key of ['before', 'after'] as const) {
        const owner = key + ':' + operation.id
        const observation = operation[key]
        if (observation !== null) this.projectSubscriptionEvidence(db, observation, owner)
        else db.prepare('DELETE FROM search_sources WHERE owner=?').run(owner)
      }
    })()
  }

  loadSubscriptionOperations(): SubscriptionOperation[] {
    if (!this.db) return []
    return this.db.prepare<[], { operation_json: string }>(
      'SELECT operation_json FROM subscription_operations ORDER BY rowid DESC'
    ).all().map((row) => JSON.parse(row.operation_json) as SubscriptionOperation)
  }

  recoverSubscriptionOperations(): void {
    const db = this.writable()
    db.transaction(() => {
      for (const operation of this.loadSubscriptionOperations()) {
        if (operation.state !== 'pending') continue
        operation.state = 'needs-reconciliation'
        if (operation.report === 'pending') operation.report = 'unknown'
        this.saveSubscriptionOperation(operation)
      }
    })()
  }

  loadSubscriptionBaseline(context: SubscriptionContext): SubscriptionBaseline | null {
    if (!this.db) return null
    const row = this.db.prepare<[number], { baseline_json: string }>(
      'SELECT baseline_json FROM subscription_baselines WHERE generation = ?'
    ).get(context.generation)
    if (!row) return null
    const baseline = JSON.parse(row.baseline_json) as SubscriptionBaseline
    return baseline.context.appCredentialId === context.appCredentialId && baseline.context.webCredentialId === context.webCredentialId ? baseline : null
  }

  loadSubscriptionPlans(): SubscriptionPlan[] {
    if (!this.db) return []
    return this.db.prepare<[], { plan_json: string }>('SELECT plan_json FROM subscription_plans ORDER BY rowid DESC')
      .all().map((row) => JSON.parse(row.plan_json) as SubscriptionPlan)
  }

  saveSubscriptionPlan(plan: SubscriptionPlan, operation?: SubscriptionOperation, baseline?: SubscriptionBaseline): void {
    const db = this.writable()
    db.transaction(() => {
      if (operation) this.saveSubscriptionOperation(operation)
      db.prepare(`INSERT INTO subscription_plans (id, plan_json) VALUES (?, ?)
        ON CONFLICT(id) DO UPDATE SET plan_json = excluded.plan_json`).run(plan.id, JSON.stringify(plan))
      if (baseline) db.prepare(`INSERT INTO subscription_baselines (generation, baseline_json) VALUES (?, ?)
        ON CONFLICT(generation) DO UPDATE SET baseline_json = excluded.baseline_json`).run(baseline.context.generation, JSON.stringify(baseline))
    }).immediate()
  }

  recoverSubscriptionPlans(at: string): void {
    const db = this.writable()
    db.transaction(() => {
      for (const plan of this.loadSubscriptionPlans()) {
        if (plan.state !== 'running') continue
        plan.state = 'interrupted'
        plan.stopReason = 'result-storage'
        plan.finishedAt = at
        for (const item of plan.items) {
          if (item.state === 'pending') item.state = item.operationId === null ? 'skipped' : 'unknown'
        }
        this.saveSubscriptionPlan(plan)
      }
    }).immediate()
  }

  close(): void {
    this.db?.close()
    this.db = null
    this.currentStatus = { state: 'unavailable', reason: 'open-failed' }
  }
}

function closeQuietly(db: Database.Database | null): void {
  try {
    db?.close()
  } catch {
    // Opening must report a status even if releasing a failed connection also fails.
  }
}

export function openReadingDatabase(
  databasePath: string,
  migrations: readonly Migration[] = MIGRATIONS
): ReadingDatabase {
  let db: Database.Database | null = null
  let schemaVersion: number
  const supportedVersion = migrations.reduce((highest, migration) => Math.max(highest, migration.version), 0)
  try {
    db = new Database(databasePath, { timeout: 5000 })
    schemaVersion = Number(db.pragma('user_version', { simple: true }))
    if (schemaVersion > supportedVersion) {
      db.close()
      db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 5000 })
      return new SqliteReadingDatabase(db, {
        state: 'read-only', reason: 'newer-schema', schemaVersion, supportedVersion
      })
    }
    db.pragma('foreign_keys = ON')
    db.pragma('busy_timeout = 5000')
  } catch {
    closeQuietly(db)
    return new SqliteReadingDatabase(null, { state: 'unavailable', reason: 'open-failed' })
  }

  const connection = db
  try {
    const ordered = [...migrations].sort((left, right) => left.version - right.version)
    let previousVersion = 0
    for (const migration of ordered) {
      if (!Number.isSafeInteger(migration.version) || migration.version <= previousVersion) {
        throw new Error('migration versions must be distinct positive integers')
      }
      previousVersion = migration.version
    }
    const pending = ordered.filter((migration) => migration.version > schemaVersion)
    if (pending.length > 0) {
      connection.transaction(() => {
        for (const migration of pending) {
          migration.up(connection)
          connection.pragma(`user_version = ${migration.version}`)
        }
      }).immediate()
      schemaVersion = supportedVersion
    }
  } catch {
    closeQuietly(connection)
    return new SqliteReadingDatabase(null, { state: 'unavailable', reason: 'migration-failed' })
  }

  try {
    // Do not change the file's journal mode before migration success or newer-schema detection.
    connection.pragma('journal_mode = WAL')
    return new SqliteReadingDatabase(connection, { state: 'ready', schemaVersion })
  } catch {
    closeQuietly(connection)
    return new SqliteReadingDatabase(null, { state: 'unavailable', reason: 'open-failed' })
  }
}
