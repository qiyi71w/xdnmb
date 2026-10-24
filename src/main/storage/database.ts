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
import { DEFAULT_SETTINGS } from '../../shared/reading'
import type { AppSettings, AttentionSource, AttentionState, ReadingAnchor, SavedPosition, ThreadReadingState } from '../../shared/reading'
import type { ImageFormat, ImageKind } from '../../shared/images'
import { IDENTITY_ROLES } from '../../shared/identity'
import type { CredentialId, CredentialSource, CredentialSummary, IdentityRole, RoleSelection } from '../../shared/identity'
import type { AttachmentId, DraftId, DraftSaveInput, PostTarget } from '../../shared/drafts'
import { StorageWriteRefusedError } from './contract'
import type {
  AppStore, DraftAttachmentRecord, DraftRecord, DraftWriteOutcome, ImageHolder, ImageResourceRecord, NewImageResource, PostThreadRelation, Stored
} from './contract'
import { computeCoverage } from './coverage'
import { buildReadingState, emptyReadingState, endObservation, type AttentionRecord } from './reading-state'
import { MIGRATIONS } from './migrations'
import type { Migration } from './migrations'
import { RetainedContentDatabase, contentTick, touchThread } from './retained'

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
  return { browse: { state: 'none' }, 'default-post': { state: 'none' }, 'web-sync': { state: 'none' } }
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

const UPSERT_POST = `
  INSERT INTO posts (
    id, forum_id, created_at, user_hash, name, title, is_admin, is_sage,
    content_json, plain_text, image_path, image_ext, fetched_at
  ) VALUES (
    @id, @forumId, @createdAt, @userHash, @name, @title, @isAdmin, @isSage,
    @content, @plainText, @imagePath, @imageExt, @fetchedAt
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
        fetchedAt
      })
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
            firstProvenNewPostId: this.firstProvenNewPost(db, attentionRow.started_at)
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
  private firstProvenNewPost(db: Database.Database, since: string): PostId | null {
    const row = db.prepare<[string], { post_id: string }>(`
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

  loadSettings(): AppSettings {
    if (!this.db) return { ...DEFAULT_SETTINGS }
    const rows = this.db.prepare<[], { key: string; value_json: string }>('SELECT key, value_json FROM settings').all()
    const settings: AppSettings = { ...DEFAULT_SETTINGS }
    for (const row of rows) {
      const value: unknown = JSON.parse(row.value_json)
      if (row.key === 'newTabSplitDefault' && typeof value === 'boolean') settings.newTabSplitDefault = value
    }
    return settings
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

  listCredentials(): CredentialSummary[] {
    if (!this.db) return []
    return this.db.prepare<[], CredentialRow>(
      'SELECT id, name, source, imported_at FROM credentials ORDER BY id'
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
      INSERT INTO credentials (name, source, imported_at, ciphertext) VALUES (?, ?, ?, ?)
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

  saveDraft(input: DraftSaveInput, at: string): DraftWriteOutcome {
    const db = this.writable()
    return db.transaction((): DraftWriteOutcome => {
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

  deleteDraft(id: DraftId): boolean {
    return this.writable().prepare('DELETE FROM drafts WHERE id = ?').run(id).changes === 1
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
