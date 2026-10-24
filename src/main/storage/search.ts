import type Database from 'better-sqlite3'
import type { Post, ThreadCoverage } from '../../shared/forum'
import type { SearchBatch, SearchHit, ThreadFilterMetadata } from '../../shared/search'
import { matchContentFilters } from '../../shared/search-filters'
import type { SearchScan } from './search-contract'
import { createSearchFts } from './search-schema'

export const normalizeSearchText = (text: string): string => text.normalize('NFC').toLowerCase()
interface DocumentRow {
  rowid: number; post_id: string; owner: string; thread_id: string | null; title: string; excerpt: string
  forum_id: string | null; created_at: string | null; has_image: number | null; fetched_at: string
}
type SearchPost = Pick<Post, 'id' | 'title' | 'plainText' | 'forumId' | 'createdAt' | 'image' | 'imageKnown'>

/** Source fields only: never credentials, draft text or arbitrary journal strings. */
export function projectSearchPost(db: Database.Database, post: SearchPost, at: string, threadId: string | null, owner = 'cache', poEvidence?: boolean | null): void {
  const po = post.id === threadId ? 1 : poEvidence === undefined
    ? db.prepare<[string | null, string], { po: number | null }>('SELECT p.user_hash=h.user_hash AS po FROM posts p JOIN posts h ON h.id=? WHERE p.id=?').get(threadId, post.id)?.po ?? null
    : poEvidence === null ? null : Number(poEvidence)
  db.prepare(`INSERT INTO search_sources(owner,post_id,thread_id,title,body,forum_id,created_at,has_image,fetched_at,is_po)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(owner,post_id) DO UPDATE SET thread_id=excluded.thread_id,
    title=excluded.title,body=excluded.body,forum_id=excluded.forum_id,created_at=excluded.created_at,
    has_image=excluded.has_image,fetched_at=excluded.fetched_at,is_po=excluded.is_po
    WHERE julianday(excluded.fetched_at)>=julianday(search_sources.fetched_at)`).run(owner, post.id, threadId,
    normalizeSearchText(post.title ?? ''), normalizeSearchText(post.plainText), post.forumId, post.createdAt,
    post.image !== null ? 1 : post.imageKnown === true ? 0 : null, at, po)
}

// Fixed JSON paths select only normalized posts from durable subscription evidence.
const journalPosts = `
  WITH observations AS (
    SELECT 'observation:'||id AS owner, observation_json AS payload FROM subscription_observations WHERE id=@source
    UNION ALL SELECT 'valid:'||id, valid_observation_json FROM subscription_observations WHERE id=@source AND valid_observation_json IS NOT NULL
    UNION ALL SELECT 'before:'||id, json_extract(operation_json,'$.before') FROM subscription_operations WHERE id=@source
    UNION ALL SELECT 'after:'||id, json_extract(operation_json,'$.after') FROM subscription_operations WHERE id=@source
  ), threads AS (
    SELECT owner, json_extract(p.value,'$.fetchedAt') AS at, t.value AS thread
    FROM observations, json_each(payload,'$.pages') p, json_each(p.value,'$.threads') t
  )
  SELECT owner, at, json_extract(thread,'$.head.id') AS thread_id, json_extract(thread,'$.head.userHash') AS head_hash, json_extract(thread,'$.head') AS post FROM threads
  UNION ALL SELECT owner, at, json_extract(thread,'$.head.id'), json_extract(thread,'$.head.userHash'), r.value FROM threads, json_each(thread,'$.recentReplies') r
`

export class SearchDatabase {
  constructor(private readonly database: () => Database.Database, private readonly coverage: (id: string, mode: 'all' | 'po') => ThreadCoverage) {}

  private ready(): Database.Database {
    const db = this.database()
    if (!db.prepare<[], { ready: number }>('SELECT ready FROM search_state WHERE singleton=1').get()?.ready) throw new Error('search index unavailable')
    // Detect a missing or damaged virtual table even for short queries.
    db.prepare('SELECT rowid FROM search_fts LIMIT 1').get()
    return db
  }

  boundary(): number {
    return this.ready().prepare<[], { id: number }>('SELECT coalesce(max(rowid),0) AS id FROM search_documents').get()!.id
  }

  batch(input: SearchScan): { batch: SearchBatch; cursor: number } {
    const db = this.ready()
    const { query, scope, filters, after, upper } = input
    const long = Array.from(query).length >= 3
    const phrase = `"${query.replaceAll('"', '""')}"`
    const thread = scope.kind === 'thread' ? scope.threadId : null
    // Long queries advance through FTS candidates, short ones through at most 64 scoped rows.
    const candidates = db.prepare<Record<string, string | number | null>, { rowid: number }>(long
      ? `SELECT d.rowid FROM search_fts JOIN search_documents d ON d.rowid=search_fts.rowid
          WHERE search_fts MATCH @phrase AND search_fts.rowid>@after AND search_fts.rowid<=@upper
            AND (@thread IS NULL OR d.thread_id=@thread) ORDER BY d.rowid LIMIT 64`
      : `SELECT rowid FROM search_documents WHERE rowid>@after AND rowid<=@upper
          AND (@thread IS NULL OR thread_id=@thread) ORDER BY rowid LIMIT 64`)
      .all({ after, upper, thread, ...(long ? { phrase } : {}) })
    const cursor = candidates.at(-1)?.rowid ?? upper
    const rows = db.prepare<Record<string, string | number | null>, DocumentRow>(`
      SELECT d.rowid,d.post_id,d.owner,d.thread_id,substr(d.title,1,180) AS title,d.forum_id,d.created_at,d.has_image,d.fetched_at,
        CASE WHEN instr(d.body,@query)>0 THEN substr(d.body,max(1,instr(d.body,@query)-60),240)
          ELSE substr(d.title,max(1,instr(d.title,@query)-60),240) END AS excerpt
      FROM search_documents d WHERE d.rowid>@after AND d.rowid<=@cursor
        ${long ? 'AND d.rowid IN (SELECT rowid FROM search_fts WHERE search_fts MATCH @phrase AND rowid>@after AND rowid<=@cursor)' : ''}
        AND (instr(d.title,@query)>0 OR instr(d.body,@query)>0)
        AND (@thread IS NULL OR d.thread_id=@thread)
        AND (@po=0 OR d.is_po=1 OR d.post_id=d.thread_id OR EXISTS(SELECT 1 FROM posts p JOIN posts h ON h.id=d.thread_id
          WHERE p.id=d.post_id AND p.user_hash IS NOT NULL AND p.user_hash=h.user_hash)
          OR EXISTS(SELECT 1 FROM reading_observations o,json_each(o.reply_ids_json) r
            WHERE o.thread_id=d.thread_id AND o.mode='po' AND r.value=d.post_id)) ORDER BY d.rowid
    `).all({ query, after, cursor, ...(long ? { phrase } : {}), thread: scope.kind === 'thread' ? scope.threadId : null,
      po: Number(scope.kind === 'thread' && scope.mode === 'po') })
    const hits: SearchHit[] = []
    for (const row of rows) {
      const metadata = { forumId: row.forum_id, createdAt: row.created_at, hasImage: row.has_image === null ? null : row.has_image === 1 }
      const match = matchContentFilters(metadata, filters)
      if (!match.matches) continue
      const location = db.prepare<{ post: string; thread: string | null }, { page: number; mode: 'all' | 'po'; fetched_at: string; source: 'page' | 'offline' }>(`
        SELECT page,mode,fetched_at,'page' AS source FROM thread_pages p WHERE p.thread_id=@thread AND
          (p.head_id=@post OR EXISTS(SELECT 1 FROM json_each(p.reply_ids_json) WHERE value=@post))
        UNION ALL SELECT page,'all',fetched_at,'offline' FROM offline_pages o WHERE o.thread_id=@thread AND
          (head_id=@post OR EXISTS(SELECT 1 FROM offline_page_posts r WHERE r.thread_id=o.thread_id AND r.page=o.page AND r.post_id=@post))
        ORDER BY fetched_at DESC LIMIT 1`).get({ post: row.post_id, thread: row.thread_id })
      const offline = db.prepare<{ post: string }, { present: number }>(`SELECT 1 AS present FROM offline_pages WHERE head_id=@post
        UNION ALL SELECT 1 FROM offline_page_posts WHERE post_id=@post LIMIT 1`).get({ post: row.post_id })
      const title = row.thread_id === null ? null : db.prepare<{ thread: string }, { title: string | null }>(`SELECT substr(coalesce(
        (SELECT nullif(title,'') FROM search_documents WHERE post_id=@thread),
        (SELECT title FROM retained_titles WHERE thread_id=@thread)),1,180) AS title`).get({ thread: row.thread_id })?.title ?? null
      hits.push({ postId: row.post_id, threadId: row.thread_id, threadTitle: title, title: row.title || null,
        excerpt: row.excerpt, ...metadata, uncertainFilters: match.uncertain,
        retention: row.owner !== 'cache' ? 'subscription' : offline ? 'offline' : 'cache',
        location: location ? { page: location.page, mode: location.mode, fetchedAt: location.fetched_at, source: location.source } : null })
    }
    const totals = db.prepare<[], { posts: number; threads: number }>('SELECT count(*) AS posts,count(DISTINCT thread_id) AS threads FROM search_documents').get()!
    return { cursor, batch: { hits, done: cursor >= upper, coverage: { retainedPosts: totals.posts, retainedThreads: totals.threads,
      thread: scope.kind === 'thread' ? this.coverage(scope.threadId, scope.mode) : null } } }
  }

  begin(): void {
    const db = this.database()
    db.transaction(() => {
      db.exec('UPDATE search_state SET ready=0; DELETE FROM search_backfill;')
      // Repair the virtual table before any projection writes; source records remain authoritative.
      createSearchFts(db)
      db.exec(`INSERT INTO search_backfill(kind,source_id) VALUES('clear','');`)
    })()
  }

  step(): boolean {
    const db = this.database()
    return db.transaction(() => {
      const task = db.prepare<[], { id: number; kind: string; source_id: string; offset: number }>('SELECT * FROM search_backfill ORDER BY id LIMIT 1').get()
      if (!task) { db.exec('UPDATE search_state SET ready=1'); return true }
      if (task.kind === 'clear') {
        db.exec('DELETE FROM search_sources WHERE rowid IN (SELECT rowid FROM search_sources LIMIT 64)')
        if (db.prepare('SELECT 1 FROM search_sources LIMIT 1').get()) return false
        db.prepare('DELETE FROM search_backfill WHERE id=?').run(task.id)
        db.exec(`INSERT INTO search_backfill(kind,source_id) VALUES('posts','');
          INSERT INTO search_backfill(kind,source_id) SELECT 'journal',id FROM subscription_observations
            UNION SELECT 'journal',id FROM subscription_operations;`)
      } else if (task.kind === 'posts') {
        const rows = db.prepare<[number], { rowid: number; id: string; title: string | null; plain_text: string; forum_id: string | null; created_at: string | null; image_path: string | null; image_ext: string | null; image_known: number | null; fetched_at: string; thread_id: string | null }>(`
          SELECT p.rowid,p.id,p.title,p.plain_text,p.forum_id,p.created_at,p.image_path,p.image_ext,p.image_known,p.fetched_at,t.thread_id
          FROM posts p LEFT JOIN post_threads t ON t.post_id=p.id WHERE p.rowid>? ORDER BY p.rowid LIMIT 32`).all(task.offset)
        for (const row of rows) projectSearchPost(db, { id: row.id, title: row.title, plainText: row.plain_text,
          forumId: row.forum_id, createdAt: row.created_at, image: row.image_path === null ? null : { path: row.image_path, ext: row.image_ext ?? '' }, imageKnown: row.image_known === 1 }, row.fetched_at, row.thread_id)
        if (rows.length < 32) db.prepare('DELETE FROM search_backfill WHERE id=?').run(task.id)
        else db.prepare('UPDATE search_backfill SET offset=? WHERE id=?').run(rows.at(-1)!.rowid, task.id)
      } else {
        const rows = db.prepare<{ source: string; offset: number }, { owner: string; at: string; thread_id: string; id: string;
          title: string | null; body: string; forum_id: string | null; created_at: string | null; image_path: string | null;
          image_ext: string | null; image_known: number | null; is_po: number | null }>(`SELECT owner,at,thread_id,
            json_extract(post,'$.id') AS id,json_extract(post,'$.title') AS title,json_extract(post,'$.plainText') AS body,
            json_extract(post,'$.forumId') AS forum_id,json_extract(post,'$.createdAt') AS created_at,
            json_extract(post,'$.image.path') AS image_path,json_extract(post,'$.image.ext') AS image_ext,
            json_extract(post,'$.imageKnown') AS image_known,
            json_extract(post,'$.userHash')=head_hash AS is_po FROM (${journalPosts}) LIMIT 32 OFFSET @offset`)
          .all({ source: task.source_id, offset: task.offset })
        for (const row of rows) projectSearchPost(db, { id: row.id, title: row.title, plainText: row.body,
          forumId: row.forum_id, createdAt: row.created_at, imageKnown: row.image_known === 1,
          image: row.image_path === null ? null : { path: row.image_path, ext: row.image_ext ?? '' } }, row.at, row.thread_id, row.owner, row.is_po === null ? null : row.is_po === 1)
        if (rows.length < 32) db.prepare('DELETE FROM search_backfill WHERE id=?').run(task.id)
        else db.prepare('UPDATE search_backfill SET offset=offset+32 WHERE id=?').run(task.id)
      }
      return false
    })()
  }

  metadata(ids: string[]): ThreadFilterMetadata[] {
    const db = this.database()
    return ids.map((threadId) => {
      const row = db.prepare<[string], { forum_id: string | null; created_at: string | null; has_image: number | null }>('SELECT forum_id,created_at,has_image FROM search_documents WHERE post_id=?').get(threadId)
      const coverage = this.coverage(threadId, 'all')
      return { threadId, forumId: row?.forum_id ?? null, createdAt: row?.created_at ?? null,
        hasImage: row?.has_image === null || row?.has_image === undefined ? null : row.has_image === 1,
        unreadCount: null, coverageUnknown: !row || coverage.endCandidatePage === null || coverage.gaps.length > 0 || coverage.countMismatch !== false }
    })
  }
}
