import type Database from 'better-sqlite3'

export function createSearchSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE search_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), ready INTEGER NOT NULL);
    INSERT INTO search_state VALUES (1, 0);
    CREATE TABLE search_sources (
      owner TEXT NOT NULL, post_id TEXT NOT NULL, thread_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL,
      forum_id TEXT, created_at TEXT, has_image INTEGER, fetched_at TEXT NOT NULL, is_po INTEGER,
      PRIMARY KEY(owner, post_id)
    );
    CREATE INDEX search_sources_post ON search_sources(post_id, fetched_at DESC, owner DESC);
    CREATE TABLE search_documents (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT, post_id TEXT UNIQUE NOT NULL, owner TEXT NOT NULL,
      thread_id TEXT, title TEXT NOT NULL, body TEXT NOT NULL, forum_id TEXT, created_at TEXT, has_image INTEGER,
      fetched_at TEXT NOT NULL, is_po INTEGER
    );
    CREATE INDEX search_documents_thread ON search_documents(thread_id, rowid);
    CREATE TABLE search_backfill (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, source_id TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0);
    CREATE TRIGGER search_post_delete AFTER DELETE ON posts BEGIN
      DELETE FROM search_sources WHERE owner='cache' AND post_id=old.id;
    END;
  `)
  for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
    const ref = event === 'DELETE' ? 'old' : 'new'
    db.exec(`CREATE TRIGGER search_source_${event.toLowerCase()} AFTER ${event} ON search_sources BEGIN
      INSERT INTO search_documents(post_id,owner,thread_id,title,body,forum_id,created_at,has_image,fetched_at,is_po)
        SELECT post_id,owner,thread_id,title,body,forum_id,created_at,has_image,fetched_at,is_po FROM search_sources
        WHERE post_id=${ref}.post_id ORDER BY julianday(fetched_at) DESC, owner DESC LIMIT 1
        ON CONFLICT(post_id) DO UPDATE SET owner=excluded.owner,thread_id=excluded.thread_id,
          title=excluded.title,body=excluded.body,forum_id=excluded.forum_id,created_at=excluded.created_at,
          has_image=excluded.has_image,fetched_at=excluded.fetched_at,is_po=excluded.is_po;
      DELETE FROM search_documents WHERE post_id=${ref}.post_id AND NOT EXISTS(SELECT 1 FROM search_sources WHERE post_id=${ref}.post_id);
      UPDATE posts SET derived_bytes =
        coalesce((SELECT sum(length(CAST(title AS BLOB))+length(CAST(body AS BLOB))) FROM search_sources WHERE owner='cache' AND post_id=${ref}.post_id),0)
        + coalesce((SELECT 2*(length(CAST(title AS BLOB))+length(CAST(body AS BLOB))) FROM search_documents WHERE owner='cache' AND post_id=${ref}.post_id),0)
        WHERE id=${ref}.post_id;
    END;`)
  }
  // FTS capability failure leaves reading storage usable and search explicitly unavailable.
  try { createSearchFts(db) } catch { /* explicit rebuild retries the capability */ }
}

export function createSearchFts(db: Database.Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS search_document_insert;
    DROP TRIGGER IF EXISTS search_document_update;
    DROP TRIGGER IF EXISTS search_document_delete;
    DROP TABLE IF EXISTS search_fts;
    CREATE VIRTUAL TABLE search_fts USING fts5(title, body, tokenize='trigram case_sensitive 1');
    CREATE TRIGGER search_document_insert AFTER INSERT ON search_documents BEGIN
      INSERT INTO search_fts(rowid,title,body) VALUES(new.rowid,new.title,new.body);
    END;
    CREATE TRIGGER search_document_update AFTER UPDATE ON search_documents BEGIN
      DELETE FROM search_fts WHERE rowid=old.rowid;
      INSERT INTO search_fts(rowid,title,body) VALUES(new.rowid,new.title,new.body);
    END;
    CREATE TRIGGER search_document_delete AFTER DELETE ON search_documents BEGIN
      DELETE FROM search_fts WHERE rowid=old.rowid;
    END;
  `)
}
