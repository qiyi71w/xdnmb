import Database from 'better-sqlite3'
import type { StorageStatus } from '../../shared/api'
import type {
  BoardDirectory,
  ContentNode,
  CoveragePage,
  FeedPage,
  FeedRef,
  Post,
  ReadingMode,
  ThreadCoverage,
  ThreadId,
  ThreadPage
} from '../../shared/forum'
import { IDENTITY_ROLES } from '../../shared/identity'
import type { CredentialId, CredentialSource, CredentialSummary, IdentityRole, RoleSelection } from '../../shared/identity'
import { StorageWriteRefusedError } from './contract'
import type { AppStore, Stored } from './contract'
import { computeCoverage } from './coverage'
import { MIGRATIONS } from './migrations'
import type { Migration } from './migrations'

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
    image_path = excluded.image_path, image_ext = excluded.image_ext,
    fetched_at = excluded.fetched_at
  WHERE julianday(excluded.fetched_at) >= julianday(posts.fetched_at)
`

class SqliteReadingDatabase implements ReadingDatabase {
  constructor(
    private db: Database.Database | null,
    private currentStatus: StorageStatus
  ) {}

  get status(): StorageStatus {
    return this.currentStatus
  }

  private writable(): Database.Database {
    if (this.currentStatus.state !== 'ready' || this.db === null) {
      throw new StorageWriteRefusedError(this.currentStatus)
    }
    return this.db
  }

  private postWriter(db: Database.Database, fetchedAt: string) {
    const postStatement = db.prepare(UPSERT_POST)
    const relationStatement = db.prepare(`
      INSERT INTO post_threads (
        post_id, thread_id, observed_as, feed_kind, feed_id, mode, page, fetched_at
      ) VALUES (@postId, @threadId, @observedAs, @feedKind, @feedId, @mode, @page, @fetchedAt)
      ON CONFLICT(post_id) DO NOTHING
    `)
    return (post: Post, threadId: ThreadId, source: RelationSource): void => {
      postStatement.run({
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
      relationStatement.run({ postId: post.id, threadId, ...source, fetchedAt })
    }
  }

  private postReader(db: Database.Database) {
    const statement = db.prepare<[string], PostRow>('SELECT * FROM posts WHERE id = ?')
    return (id: string): Post => {
      const row = statement.get(id)
      if (!row) throw new Error('cached page references a missing post')
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
  }

  saveDirectory(directory: BoardDirectory, fetchedAt: string): void {
    const db = this.writable()
    db.transaction(() => {
      db.prepare(`
        INSERT INTO directory_snapshot (singleton, directory_json, fetched_at) VALUES (1, ?, ?)
        ON CONFLICT(singleton) DO UPDATE SET
          directory_json = excluded.directory_json, fetched_at = excluded.fetched_at
      `).run(JSON.stringify(directory), fetchedAt)
    })()
  }

  loadDirectory(): Stored<BoardDirectory> | null {
    if (!this.db) return null
    const row = this.db.prepare<[], { directory_json: string; fetched_at: string }>(
      'SELECT directory_json, fetched_at FROM directory_snapshot WHERE singleton = 1'
    ).get()
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
      if (page.replyCount !== null) {
        db.prepare(`
          INSERT INTO thread_reply_counts (thread_id, mode, reply_count, fetched_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(thread_id, mode) DO UPDATE SET
            reply_count = excluded.reply_count, fetched_at = excluded.fetched_at
          WHERE julianday(excluded.fetched_at) >= julianday(thread_reply_counts.fetched_at)
        `).run(page.threadId, page.mode, page.replyCount, fetchedAt)
      }
      return this.getThreadCoverage(page.threadId, page.mode)
    })()
  }

  loadThreadPage(threadId: ThreadId, mode: ReadingMode, page: number): Stored<ThreadPage> | null {
    if (!this.db) return null
    const db = this.db
    return db.transaction(() => {
      const row = db.prepare<[string, string, number], ThreadPageRow>(
        'SELECT * FROM thread_pages WHERE thread_id = ? AND mode = ? AND page = ?'
      ).get(threadId, mode, page)
      if (!row) return null
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
    return computeCoverage(threadId, mode, pages, latestCount?.reply_count ?? null)
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
