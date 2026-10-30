import type Database from 'better-sqlite3'
import { statSync } from 'node:fs'
import { DEFAULT_CACHE_LIMIT, type ContentUsage, type OfflineCopy, type OfflineEntry, type RetainedEntry } from '../../shared/content'
import type { Post, ThreadId, ThreadPage } from '../../shared/forum'
import { comparePostIds } from '../../shared/forum'

export function contentTick(db: Database.Database): number {
  const row = db.prepare<[], { tick: number }>('UPDATE content_clock SET tick = tick + 1 WHERE singleton = 1 RETURNING tick').get()
  if (!row) throw new Error('content clock unavailable')
  return row.tick
}
export function touchThread(db: Database.Database, threadId: string): void {
  const tick = contentTick(db)
  db.prepare('UPDATE thread_pages SET last_used = ? WHERE thread_id = ?').run(tick, threadId)
  db.prepare('UPDATE posts SET last_used = ? WHERE id IN (SELECT post_id FROM post_threads WHERE thread_id = ?)').run(tick, threadId)
}


interface CopyRow {
  thread_id: string; created_at: string; updated_at: string; include_images: number
  state: OfflineCopy['state']; end_candidate_page: number | null; failed_page: number | null
  error_json: string | null; image_failures_json: string
}

/** All calls run on the database worker; transactions never span a network or file operation. */
export class RetainedContentDatabase {
  constructor(
    private readonly database: () => Database.Database,
    private readonly savePage: (page: ThreadPage, at: string) => unknown,
    /** The stored post, without marking it used; null when not held. */
    private readonly peekPost: (postId: string) => Post | null
  ) {}

  listHistory(): RetainedEntry[] {
    const db = this.database()
    return db.transaction(() => db.prepare<[], {
      thread_id: string; at: string; title: string | null; reply_count: number | null
    }>(`
      SELECT e.thread_id, e.last_visited_at AS at, t.title, c.reply_count
      FROM thread_visits e LEFT JOIN retained_titles t USING(thread_id)
      LEFT JOIN thread_reply_counts c ON c.thread_id = e.thread_id AND c.mode = 'all'
      ORDER BY e.last_visited_at DESC, e.thread_id
    `).all().map((row) => ({ threadId: row.thread_id, at: row.at, title: row.title ?? null,
      head: this.peekPost(row.thread_id), replyCount: row.reply_count,
      offline: this.getOfflineCopy(row.thread_id) })))()
  }

  /** Ordered by first save, so updating a copy never moves it. Fields come from this machine only. */
  listOffline(): OfflineEntry[] {
    const db = this.database()
    return db.transaction(() => db.prepare<[], { thread_id: string; title: string | null; reply_count: number | null }>(`
      SELECT c.thread_id, t.title, (
        SELECT reply_count FROM offline_pages o WHERE o.thread_id = c.thread_id AND reply_count IS NOT NULL
        ORDER BY julianday(o.fetched_at) DESC, o.page DESC LIMIT 1
      ) AS reply_count
      FROM offline_copies c LEFT JOIN retained_titles t USING(thread_id)
      ORDER BY julianday(c.created_at) DESC, c.thread_id
    `).all().map((row) => ({ threadId: row.thread_id, head: this.peekPost(row.thread_id), title: row.title ?? null,
      replyCount: row.reply_count, copy: this.getOfflineCopy(row.thread_id)! })))()
  }

  /** Returns the threads whose reading positions were cleared: the deleted visit scope, or none when `clearReading` is false. */
  clearHistory(threadId: ThreadId | null, clearReading: boolean): ThreadId[] {
    const db = this.database()
    return db.transaction(() => {
      // Capture the visit scope before deleting it; unrelated reading records are not history.
      db.exec('CREATE TEMP TABLE IF NOT EXISTS cleared_visits (thread_id TEXT PRIMARY KEY)')
      db.exec('DELETE FROM cleared_visits')
      db.prepare('INSERT INTO cleared_visits SELECT thread_id FROM thread_visits WHERE ? IS NULL OR thread_id = ?').run(threadId, threadId)
      let cleared: ThreadId[] = []
      if (clearReading) {
        cleared = db.prepare<[], { thread_id: string }>('SELECT thread_id FROM cleared_visits ORDER BY thread_id').all().map((row) => row.thread_id)
        db.exec('DELETE FROM reading_positions WHERE thread_id IN (SELECT thread_id FROM cleared_visits)')
      }
      db.exec('DELETE FROM thread_visits WHERE thread_id IN (SELECT thread_id FROM cleared_visits)')
      db.exec('DELETE FROM cleared_visits')
      return cleared
    }).immediate()
  }

  setCacheLimit(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('invalid cache limit')
    this.database().prepare(`INSERT INTO settings VALUES ('cacheLimitBytes', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`).run(JSON.stringify(bytes))
  }

  getContentUsage(): ContentUsage {
    const db = this.database()
    return db.transaction(() => {
      const scalar = (sql: string): number => (db.prepare<[], { bytes: number }>(sql).get()?.bytes ?? 0)
      const limit = db.prepare<[], { value_json: string }>("SELECT value_json FROM settings WHERE key = 'cacheLimitBytes'").get()
      const limitBytes = limit ? Number(JSON.parse(limit.value_json)) : DEFAULT_CACHE_LIMIT
      const cachePosts = scalar('SELECT coalesce(sum(bytes), 0) AS bytes FROM content_post_bytes WHERE NOT protected')
      const protectedTextBytes = scalar('SELECT coalesce(sum(bytes), 0) AS bytes FROM content_post_bytes WHERE protected')
        + scalar(`SELECT coalesce(sum(length(CAST(title AS BLOB))+length(CAST(body AS BLOB))),0) AS bytes FROM search_sources WHERE owner<>'cache'`)
        + scalar(`SELECT coalesce(sum(2*(length(CAST(title AS BLOB))+length(CAST(body AS BLOB)))),0) AS bytes FROM search_documents WHERE owner<>'cache'`)
      const metadata = scalar('SELECT coalesce(sum(bytes), 0) AS bytes FROM content_metadata_bytes WHERE NOT protected')
      const heldMetadata = scalar('SELECT coalesce(sum(bytes), 0) AS bytes FROM content_metadata_bytes WHERE protected')
      const cacheImageBytes = scalar('SELECT coalesce(sum(bytes), 0) AS bytes FROM image_resources r WHERE NOT EXISTS(SELECT 1 FROM image_holders h WHERE h.resource_id = r.id) AND NOT EXISTS(SELECT 1 FROM offline_images o WHERE o.resource_id = r.id)')
      const protectedImageBytes = scalar('SELECT coalesce(sum(bytes), 0) AS bytes FROM image_resources r WHERE EXISTS(SELECT 1 FROM image_holders h WHERE h.resource_id = r.id) OR EXISTS(SELECT 1 FROM offline_images o WHERE o.resource_id = r.id)')
        + scalar('SELECT coalesce(sum(bytes), 0) AS bytes FROM draft_attachments')
      // Logical record bytes, independent of SQLite pages, freelists and indexes.
      const personalTables = ['thread_reading', 'reading_positions', 'thread_visits', 'settings', 'credentials', 'identity_roles', 'drafts', 'thread_post_identities', 'retained_titles', 'post_threads', 'reading_observations', 'offline_copies', 'offline_pages', 'offline_page_posts', 'offline_images', 'image_holders', 'content_readers', 'draft_attachments']
      // Observations and fixed-context write/readback evidence are durable, not ordinary cache.
      personalTables.push('subscription_app_credentials', 'subscription_configuration', 'subscription_observations', 'subscription_operations', 'subscription_baselines', 'subscription_plans')
      personalTables.push('reminder_rules', 'reminder_state', 'reminder_checker')
      personalTables.push('workspace', 'publication_attempts', 'publication_settings', 'account_session', 'local_blocks', 'cookie_colors', 'cookie_color_auto')
      let personalDataBytes = 0
      for (const table of personalTables) {
        const columns = db.prepare<[], { name: string }>(`PRAGMA table_info(${table})`).all().map((column) => `coalesce(length(CAST("${column.name}" AS BLOB)), 0)`)
        personalDataBytes += scalar(`SELECT coalesce(sum(${columns.join(' + ')}), 0) AS bytes FROM ${table}`)
      }
      let databaseBytes = 0
      for (const path of [db.name, `${db.name}-wal`]) {
        try { databaseBytes += statSync(path).size } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
        }
      }
      const cacheTextBytes = cachePosts + metadata
      return { limitBytes, cacheTextBytes, cacheImageBytes, protectedTextBytes: protectedTextBytes + heldMetadata,
        protectedImageBytes, personalDataBytes, databaseBytes,
        overLimit: cacheTextBytes + cacheImageBytes > limitBytes,
        protectedOverLimit: protectedTextBytes + heldMetadata + protectedImageBytes > limitBytes }
    })()
  }

  holdContentReader(holder: string, threadId: ThreadId): void {
    this.database().prepare('INSERT INTO content_readers VALUES (?, ?) ON CONFLICT(holder) DO UPDATE SET thread_id = excluded.thread_id').run(holder, threadId)
  }

  releaseContentReaders(prefix: string): void {
    this.database().prepare('DELETE FROM content_readers WHERE substr(holder, 1, length(?)) = ?').run(prefix, prefix)
  }

  getOfflineCopy(threadId: ThreadId): OfflineCopy | null {
    const db = this.database()
    const row = db.prepare<[string], CopyRow>('SELECT * FROM offline_copies WHERE thread_id = ?').get(threadId)
    if (!row) return null
    const counts = db.prepare<[string, string], { posts: number; images: number }>(`SELECT count(*) AS posts, coalesce(sum(image_path IS NOT NULL), 0) AS images FROM posts WHERE id IN (
      SELECT post_id FROM offline_page_posts WHERE thread_id = ? UNION SELECT head_id FROM offline_pages WHERE thread_id = ?
    )`).get(threadId, threadId)!
    const saved = db.prepare<[string], { count: number }>(`SELECT count(DISTINCT o.post_id) AS count FROM offline_images o
      JOIN image_resources r ON r.id = o.resource_id AND r.kind = 'original'
      WHERE o.thread_id = ?`).get(threadId)!
    return { threadId, createdAt: row.created_at, updatedAt: row.updated_at, includeImages: row.include_images !== 0,
      state: row.state, pages: db.prepare<[string], { page: number }>('SELECT page FROM offline_pages WHERE thread_id = ? ORDER BY page').all(threadId).map((page) => page.page),
      endCandidatePage: row.end_candidate_page, postCount: counts.posts, imageCount: counts.images, savedImages: saved.count,
      imageFailures: JSON.parse(row.image_failures_json) as OfflineCopy['imageFailures'], failedPage: row.failed_page,
      error: row.error_json === null ? null : JSON.parse(row.error_json) as OfflineCopy['error'] }
  }

  deleteOfflineCopy(threadId: ThreadId): void {
    const db = this.database()
    db.transaction(() => {
      // Cache eviction can remove ordinary pages while the offline union remains readable.
      // Promote that union before releasing its references, without treating deletion as use.
      const pages = db.prepare<[string], { page: number; head_id: string; fetched_at: string; reply_count: number | null;
        skipped_items: number; end_candidate: number }>('SELECT * FROM offline_pages WHERE thread_id = ?').all(threadId)
      const cached = db.prepare<[string, number], { head_id: string; fetched_at: string; reply_ids_json: string;
        reply_count: number | null; skipped_items: number; end_candidate: number; last_used: number }>(
        "SELECT * FROM thread_pages WHERE thread_id = ? AND mode = 'all' AND page = ?")
      const observed = db.prepare<[string, number], { fetched_at: string; reply_ids_json: string }>(
        "SELECT fetched_at, reply_ids_json FROM reading_observations WHERE thread_id = ? AND mode = 'all' AND page = ?")
      const replies = db.prepare<[string, number], { post_id: string }>('SELECT post_id FROM offline_page_posts WHERE thread_id = ? AND page = ?')
      const lastUsed = db.prepare<[string], { used: number }>(`SELECT coalesce(max(last_used), 0) AS used FROM posts
        WHERE id IN (SELECT post_id FROM post_threads WHERE thread_id = ?)`).get(threadId)!.used
      const insert = db.prepare(`INSERT INTO thread_pages(thread_id, mode, page, head_id, fetched_at, reply_ids_json,
        reply_count, skipped_items, end_candidate, last_used) VALUES (?, 'all', ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, mode, page) DO UPDATE SET reply_ids_json = excluded.reply_ids_json,
          skipped_items = excluded.skipped_items, end_candidate = excluded.end_candidate`)
      for (const offline of pages) {
        const row = cached.get(threadId, offline.page)
        const source = row ?? offline
        const currentIds = row ? JSON.parse(row.reply_ids_json) as string[] : []
        const ids = [...new Set([...currentIds, ...replies.all(threadId, offline.page).map((reply) => reply.post_id)])].sort(comparePostIds)
        const proof = row ?? observed.get(threadId, offline.page)
        // Accumulated offline posts can span incompatible server snapshots. Keep them readable,
        // but only keep coverage evidence when this is still the exact observed page.
        const exact = proof !== undefined && proof.fetched_at === source.fetched_at
          && JSON.stringify((JSON.parse(proof.reply_ids_json) as string[]).sort(comparePostIds)) === JSON.stringify(ids)
        insert.run(threadId, offline.page, source.head_id, source.fetched_at, JSON.stringify(ids), source.reply_count,
          exact ? source.skipped_items : Math.max(1, source.skipped_items), exact ? source.end_candidate : 0,
          row?.last_used ?? lastUsed)
      }
      db.prepare('DELETE FROM offline_images WHERE thread_id = ?').run(threadId)
      db.prepare("DELETE FROM image_holders WHERE holder_kind = 'offline' AND holder_id = ?").run(threadId)
      db.prepare('DELETE FROM offline_page_posts WHERE thread_id = ?').run(threadId)
      db.prepare('DELETE FROM offline_pages WHERE thread_id = ?').run(threadId)
      db.prepare('DELETE FROM offline_copies WHERE thread_id = ?').run(threadId)
    }).immediate()
  }

  beginOfflineCopy(threadId: ThreadId, includeImages: boolean, at: string): OfflineCopy {
    const db = this.database()
    return db.transaction(() => {
      db.prepare(`INSERT INTO offline_copies(thread_id, created_at, updated_at, include_images, state) VALUES (?, ?, ?, ?, 'saving')
        ON CONFLICT(thread_id) DO UPDATE SET updated_at = excluded.updated_at, include_images = excluded.include_images,
          state = 'saving', end_candidate_page = NULL, failed_page = NULL, error_json = NULL, image_failures_json = '[]'`).run(threadId, at, at, Number(includeImages))
      return this.getOfflineCopy(threadId)!
    }).immediate()
  }

  saveOfflinePage(page: ThreadPage, at: string): OfflineCopy {
    const db = this.database()
    return db.transaction(() => {
      if (page.mode !== 'all' || !this.getOfflineCopy(page.threadId)) throw new Error('offline copy not started in all mode')
      this.savePage(page, at)
      db.prepare(`INSERT INTO offline_pages(thread_id, page, head_id, fetched_at, reply_count, skipped_items, end_candidate) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, page) DO UPDATE SET fetched_at = excluded.fetched_at, reply_count = excluded.reply_count,
          skipped_items = excluded.skipped_items, end_candidate = excluded.end_candidate`).run(page.threadId, page.page, page.head.id, at, page.replyCount, page.skippedItems, Number(page.endCandidate))
      const insert = db.prepare('INSERT INTO offline_page_posts VALUES (?, ?, ?) ON CONFLICT DO NOTHING')
      for (const reply of page.replies) insert.run(page.threadId, page.page, reply.id)
      db.prepare(`UPDATE offline_copies SET updated_at = ?, end_candidate_page = CASE WHEN ? THEN ? ELSE end_candidate_page END WHERE thread_id = ?`)
        .run(at, Number(page.endCandidate), page.page, page.threadId)
      return this.getOfflineCopy(page.threadId)!
    }).immediate()
  }

  updateOfflineCopy(threadId: ThreadId, patch: Pick<OfflineCopy, 'state' | 'failedPage' | 'error' | 'imageFailures'>, at: string): OfflineCopy {
    const db = this.database()
    return db.transaction(() => {
      const changed = db.prepare(`UPDATE offline_copies SET state = ?, failed_page = ?, error_json = ?, image_failures_json = ?, updated_at = ? WHERE thread_id = ?`)
        .run(patch.state, patch.failedPage, patch.error === null ? null : JSON.stringify(patch.error), JSON.stringify(patch.imageFailures), at, threadId).changes
      if (!changed) throw new Error('offline copy not started')
      return this.getOfflineCopy(threadId)!
    }).immediate()
  }

  holdOfflineImage(threadId: ThreadId, postId: string): void {
    const db = this.database()
    db.transaction(() => {
      const resource = db.prepare<[string, string, string], { id: number }>(`SELECT r.id FROM image_resources r JOIN posts p ON p.id = ?
        WHERE r.kind = 'original' AND substr(r.source_url, -length('/image/' || p.image_path || p.image_ext)) = '/image/' || p.image_path || p.image_ext
          AND p.id IN (SELECT post_id FROM offline_page_posts WHERE thread_id = ? UNION SELECT head_id FROM offline_pages WHERE thread_id = ?)
        ORDER BY r.last_used DESC, r.id DESC LIMIT 1`).get(postId, threadId, threadId)
      if (!resource) throw new Error('retained original image unavailable')
      db.prepare("INSERT INTO image_holders VALUES (?, 'offline', ?, ?) ON CONFLICT DO NOTHING").run(resource.id, threadId, new Date().toISOString())
      db.prepare('INSERT INTO offline_images VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(threadId, postId, resource.id)
    }).immediate()
  }

  listOfflineImagePosts(threadId: ThreadId, after: string | null, limit: number): string[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid offline image batch size')
    return this.database().prepare<[string, string, string, number], { id: string }>(`SELECT p.id FROM posts p WHERE p.image_path IS NOT NULL
      AND p.id IN (SELECT post_id FROM offline_page_posts WHERE thread_id = ? UNION SELECT head_id FROM offline_pages WHERE thread_id = ?)
      AND p.id > ? ORDER BY p.id LIMIT ?`).all(threadId, threadId, after ?? '', limit).map((row) => row.id)
  }

  recoverContent(): void {
    const db = this.database()
    db.transaction(() => {
      db.exec("DELETE FROM content_readers; DELETE FROM image_holders WHERE holder_kind = 'reading'; UPDATE offline_copies SET state = 'interrupted' WHERE state = 'saving'")
    }).immediate()
  }

  evictContentBatch(clearAll: boolean): { fileNames: string[]; more: boolean } {
    const db = this.database()
    return db.transaction(() => {
      const fileNames: string[] = []
      const candidates = () => db.prepare<[], { kind: string; id: string; mode: string | null; page: number | null }>(`
        SELECT kind, id, mode, page FROM (
          SELECT 'thread' AS kind, thread_id AS id, NULL AS mode, NULL AS page, min(last_used) AS used FROM thread_pages
            WHERE thread_id NOT IN (SELECT thread_id FROM content_readers) AND thread_id NOT IN (SELECT target_id FROM drafts WHERE target_kind = 'reply') GROUP BY thread_id
          UNION ALL SELECT 'feed', feed_id, feed_kind, page, last_used FROM feed_pages
          UNION ALL SELECT 'directory', '', NULL, NULL, last_used FROM directory_snapshot
          UNION ALL SELECT 'post', p.id, NULL, NULL, p.last_used FROM posts p
            WHERE NOT EXISTS(SELECT 1 FROM cached_post_references r WHERE r.post_id = p.id)
              AND NOT EXISTS(SELECT 1 FROM protected_posts h WHERE h.post_id = p.id)
          UNION ALL SELECT 'image', CAST(id AS TEXT), NULL, NULL, last_used FROM image_resources r
            WHERE NOT EXISTS(SELECT 1 FROM image_holders h WHERE h.resource_id = r.id)
              AND NOT EXISTS(SELECT 1 FROM offline_images o WHERE o.resource_id = r.id)
        ) ORDER BY used, kind, id LIMIT 1
      `).get()
      const setting = db.prepare<[], { value_json: string }>("SELECT value_json FROM settings WHERE key = 'cacheLimitBytes'").get()
      const limitBytes = setting ? Number(JSON.parse(setting.value_json)) : DEFAULT_CACHE_LIMIT
      const needsWork = () => clearAll || (db.prepare<[], { bytes: number }>('SELECT bytes FROM content_cache_bytes').get()?.bytes ?? 0) > limitBytes
      for (let removed = 0; removed < 50 && needsWork(); removed++) {
        const item = candidates()
        if (!item) break
        if (item.kind === 'thread') {
          db.prepare('DELETE FROM thread_pages WHERE thread_id = ?').run(item.id)
          db.prepare('DELETE FROM thread_reply_counts WHERE thread_id = ?').run(item.id)
        } else if (item.kind === 'feed') {
          db.prepare('DELETE FROM feed_pages WHERE feed_kind = ? AND feed_id = ? AND page = ?').run(item.mode, item.id, item.page)
        } else if (item.kind === 'directory') db.exec('DELETE FROM directory_snapshot')
        else if (item.kind === 'post') db.prepare('DELETE FROM posts WHERE id = ? AND NOT EXISTS(SELECT 1 FROM protected_posts WHERE post_id = ?) AND NOT EXISTS(SELECT 1 FROM cached_post_references WHERE post_id = ?)').run(item.id, item.id, item.id)
        else {
          const row = db.prepare<[string], { file_name: string }>('DELETE FROM image_resources WHERE id = ? AND NOT EXISTS(SELECT 1 FROM image_holders WHERE resource_id = image_resources.id) AND NOT EXISTS(SELECT 1 FROM offline_images WHERE resource_id = image_resources.id) RETURNING file_name').get(item.id)
          if (row) fileNames.push(row.file_name)
        }
      }
      return { fileNames, more: needsWork() && candidates() !== undefined }
    }).immediate()
  }
}
