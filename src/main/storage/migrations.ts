import type Database from 'better-sqlite3'

export interface Migration {
  version: number
  up(db: Database.Database): void
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE directory_snapshot (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          directory_json TEXT NOT NULL,
          fetched_at TEXT NOT NULL
        );

        CREATE TABLE posts (
          id TEXT PRIMARY KEY NOT NULL,
          forum_id TEXT,
          created_at TEXT,
          user_hash TEXT,
          name TEXT,
          title TEXT,
          is_admin INTEGER CHECK (is_admin IN (0, 1)),
          is_sage INTEGER CHECK (is_sage IN (0, 1)),
          content_json TEXT NOT NULL,
          plain_text TEXT NOT NULL,
          image_path TEXT,
          image_ext TEXT,
          fetched_at TEXT NOT NULL,
          CHECK ((image_path IS NULL) = (image_ext IS NULL))
        );

        CREATE TABLE post_threads (
          post_id TEXT PRIMARY KEY NOT NULL REFERENCES posts(id),
          thread_id TEXT NOT NULL REFERENCES posts(id),
          observed_as TEXT NOT NULL CHECK (observed_as IN ('head', 'thread-reply', 'feed-recent-reply')),
          feed_kind TEXT CHECK (feed_kind IN ('forum', 'timeline')),
          feed_id TEXT,
          mode TEXT CHECK (mode IN ('all', 'po')),
          page INTEGER NOT NULL CHECK (page >= 1),
          fetched_at TEXT NOT NULL
        );
        CREATE INDEX post_threads_thread_id ON post_threads(thread_id);

        CREATE TABLE feed_pages (
          feed_kind TEXT NOT NULL CHECK (feed_kind IN ('forum', 'timeline')),
          feed_id TEXT NOT NULL,
          page INTEGER NOT NULL CHECK (page >= 1),
          fetched_at TEXT NOT NULL,
          summaries_json TEXT NOT NULL,
          skipped_items INTEGER NOT NULL CHECK (skipped_items >= 0),
          PRIMARY KEY (feed_kind, feed_id, page)
        );

        CREATE TABLE thread_pages (
          thread_id TEXT NOT NULL REFERENCES posts(id),
          mode TEXT NOT NULL CHECK (mode IN ('all', 'po')),
          page INTEGER NOT NULL CHECK (page >= 1),
          head_id TEXT NOT NULL REFERENCES posts(id),
          fetched_at TEXT NOT NULL,
          reply_ids_json TEXT NOT NULL,
          reply_count INTEGER CHECK (reply_count >= 0),
          skipped_items INTEGER NOT NULL CHECK (skipped_items >= 0),
          end_candidate INTEGER NOT NULL CHECK (end_candidate IN (0, 1)),
          PRIMARY KEY (thread_id, mode, page)
        );

        CREATE TABLE thread_reply_counts (
          thread_id TEXT NOT NULL REFERENCES posts(id),
          mode TEXT NOT NULL CHECK (mode IN ('all', 'po')),
          reply_count INTEGER NOT NULL CHECK (reply_count >= 0),
          fetched_at TEXT NOT NULL,
          PRIMARY KEY (thread_id, mode)
        );
      `)
    }
  },
  {
    // Reading context. These are personal records, not cache: no foreign keys to cached posts, so
    // evicting cached content never removes reads, positions, attention or visits.
    version: 2,
    up(db) {
      db.exec(`
        CREATE TABLE thread_reading (
          thread_id TEXT PRIMARY KEY NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('all', 'po')),
          updated_at TEXT NOT NULL
        );

        CREATE TABLE reading_positions (
          thread_id TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('all', 'po')),
          post_id TEXT NOT NULL,
          page INTEGER NOT NULL CHECK (page >= 1),
          offset_ratio REAL NOT NULL CHECK (offset_ratio >= 0 AND offset_ratio <= 1),
          viewport_offset REAL NOT NULL,
          saved_at TEXT NOT NULL,
          PRIMARY KEY (thread_id, mode)
        );

        CREATE TABLE post_reads (
          post_id TEXT PRIMARY KEY NOT NULL,
          thread_id TEXT NOT NULL,
          read_at TEXT NOT NULL
        );
        CREATE INDEX post_reads_thread_id ON post_reads(thread_id);

        CREATE TABLE thread_attention (
          thread_id TEXT PRIMARY KEY NOT NULL,
          started_at TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('subscription', 'favorite', 'reminder', 'import')),
          watermark_post_id TEXT
        );

        -- A thread's end seen at observed_at: every reply existing then had an ID <= bound_post_id,
        -- so a reply observed later above the bound was posted after observed_at.
        CREATE TABLE end_observations (
          thread_id TEXT NOT NULL,
          observed_at TEXT NOT NULL,
          bound_post_id TEXT NOT NULL,
          PRIMARY KEY (thread_id, observed_at)
        );
        CREATE INDEX end_observations_observed_at ON end_observations(observed_at);

        CREATE TABLE thread_visits (
          thread_id TEXT PRIMARY KEY NOT NULL,
          first_visited_at TEXT NOT NULL,
          last_visited_at TEXT NOT NULL,
          visit_count INTEGER NOT NULL CHECK (visit_count >= 1)
        );

        CREATE TABLE settings (
          key TEXT PRIMARY KEY NOT NULL,
          value_json TEXT NOT NULL
        );
      `)
    }
  }
]
