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
  },
  {
    // Managed image files. A resource is one fetched forum image (thumbnail or original) stored as
    // a file in the app's image directory; holders (reading views now, drafts and offline copies
    // later) protect it from cleanup. A file is renamed into place before its row is committed.
    version: 3,
    up(db) {
      db.exec(`
        CREATE TABLE image_resources (
          id INTEGER PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('thumb', 'original')),
          source_url TEXT NOT NULL,
          file_name TEXT NOT NULL UNIQUE,
          format TEXT NOT NULL CHECK (format IN ('jpeg', 'png', 'gif', 'webp')),
          bytes INTEGER NOT NULL CHECK (bytes > 0),
          width INTEGER NOT NULL CHECK (width > 0),
          height INTEGER NOT NULL CHECK (height > 0),
          fetched_at TEXT NOT NULL,
          UNIQUE (kind, source_url)
        );

        CREATE TABLE image_holders (
          resource_id INTEGER NOT NULL REFERENCES image_resources(id),
          holder_kind TEXT NOT NULL,
          holder_id TEXT NOT NULL,
          held_at TEXT NOT NULL,
          PRIMARY KEY (resource_id, holder_kind, holder_id)
        );
        CREATE INDEX image_holders_holder ON image_holders(holder_kind, holder_id);
      `)
    }
  },
  {
    version: 4,
    up(db) {
      db.exec(`
        -- Secrets are stored only as OS-protected ciphertext; AUTOINCREMENT keeps IDs from being reused.
        CREATE TABLE credentials (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL CHECK (length(name) >= 1),
          source TEXT NOT NULL CHECK (source IN ('export', 'raw')),
          imported_at TEXT NOT NULL,
          ciphertext BLOB NOT NULL CHECK (length(ciphertext) > 0)
        );

        -- No foreign key: a removed credential must remain referenced as missing, never replaced.
        CREATE TABLE identity_roles (
          role TEXT PRIMARY KEY NOT NULL CHECK (role IN ('browse', 'default-post', 'web-sync')),
          credential_id INTEGER CHECK (credential_id IS NULL OR credential_id >= 1)
        );
      `)
    }
  },
  {
    // Saved drafts, their managed image copies and per-thread 发言饼干 selections. Credential
    // references carry no foreign key: a removed credential stays referenced as missing.
    version: 5,
    up(db) {
      db.exec(`
        CREATE TABLE draft_attachments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          file_name TEXT NOT NULL UNIQUE,
          format TEXT NOT NULL CHECK (format IN ('jpeg', 'png', 'gif', 'webp')),
          bytes INTEGER NOT NULL CHECK (bytes > 0),
          width INTEGER NOT NULL CHECK (width > 0),
          height INTEGER NOT NULL CHECK (height > 0),
          original_name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        -- One row per draft holds its single saved version; saving replaces it in one transaction.
        CREATE TABLE drafts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          target_kind TEXT NOT NULL CHECK (target_kind IN ('reply', 'thread')),
          target_id TEXT NOT NULL,
          credential_id INTEGER CHECK (credential_id IS NULL OR credential_id >= 1),
          content TEXT NOT NULL,
          title TEXT NOT NULL,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          watermark INTEGER NOT NULL CHECK (watermark IN (0, 1)),
          attachment_id INTEGER REFERENCES draft_attachments(id),
          version INTEGER NOT NULL CHECK (version >= 1),
          created_at TEXT NOT NULL,
          saved_at TEXT NOT NULL
        );
        CREATE INDEX drafts_attachment_id ON drafts(attachment_id);

        CREATE TABLE thread_post_identities (
          thread_id TEXT PRIMARY KEY NOT NULL,
          credential_id INTEGER NOT NULL CHECK (credential_id >= 1),
          updated_at TEXT NOT NULL
        );
      `)
    }
  },
  {
    // Frozen publication intents outlive both editors and saved drafts. The attachment column
    // holds a managed copy only while the result still needs it; payload_json remains history.
    version: 6,
    up(db) {
      db.exec(`
        CREATE TABLE publication_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT NOT NULL UNIQUE,
          editor_id TEXT NOT NULL,
          draft_id INTEGER,
          payload_json TEXT NOT NULL,
          credential_id INTEGER NOT NULL CHECK (credential_id >= 1),
          forum_id TEXT NOT NULL,
          attachment_id INTEGER REFERENCES draft_attachments(id),
          state TEXT NOT NULL CHECK (state IN ('sending', 'confirmed', 'failed', 'unknown', 'unconfirmed')),
          problem TEXT CHECK (problem IS NULL OR problem IN (
            'storage', 'identity', 'attachment', 'target', 'empty', 'busy', 'interval',
            'rejected', 'rate-limited', 'captcha', 'network', 'response'
          )),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          post_id TEXT,
          thread_id TEXT,
          saved_draft_id INTEGER,
          CHECK (state != 'confirmed' OR (post_id IS NOT NULL AND thread_id IS NOT NULL))
        );
        CREATE UNIQUE INDEX publication_locked_draft ON publication_attempts(draft_id)
          WHERE draft_id IS NOT NULL AND state IN ('sending', 'unknown', 'unconfirmed');
        CREATE INDEX publication_attachment_id ON publication_attempts(attachment_id);
        CREATE INDEX publication_identity_forum ON publication_attempts(credential_id, forum_id, created_at);

        CREATE TABLE own_posts (
          post_id TEXT PRIMARY KEY NOT NULL,
          thread_id TEXT NOT NULL,
          is_thread INTEGER NOT NULL CHECK (is_thread IN (0, 1)),
          credential_id INTEGER CHECK (credential_id IS NULL OR credential_id >= 1),
          evidence TEXT NOT NULL CHECK (evidence IN ('submission-readback', 'manual')),
          confirmed_at TEXT NOT NULL,
          CHECK (is_thread = 0 OR post_id = thread_id),
          CHECK (evidence != 'submission-readback' OR credential_id IS NOT NULL)
        );

        -- Kept separate from reading settings so saving an older settings shape cannot reset it.
        CREATE TABLE publication_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          po_warning_enabled INTEGER NOT NULL CHECK (po_warning_enabled IN (0, 1))
        );
        INSERT INTO publication_settings (id, po_warning_enabled) VALUES (1, 1);
      `)
    }
  }
]
