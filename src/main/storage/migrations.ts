import type Database from 'better-sqlite3'
import { createSearchSchema } from './search-schema'

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
    version: 6,
    up(db) {
      // The subscription predecessor also used v5, without the draft schema. Reconcile only
      // that known layout before retention views start referencing drafts; never reset data.
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'drafts'").get()) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'subscription_configuration'").get()) {
          throw new Error('unrecognized version 5 schema: missing drafts')
        }
        MIGRATIONS.find((migration) => migration.version === 5)!.up(db)
      }
      db.exec(`
        -- Relations and observations are personal evidence, independent of cached payload lifetime.
        ALTER TABLE post_threads RENAME TO old_post_threads;
        CREATE TABLE post_threads (
          post_id TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL,
          observed_as TEXT NOT NULL, feed_kind TEXT, feed_id TEXT, mode TEXT,
          page INTEGER NOT NULL, fetched_at TEXT NOT NULL
        );
        INSERT INTO post_threads SELECT * FROM old_post_threads;
        DROP TABLE old_post_threads;
        CREATE INDEX post_threads_thread_id ON post_threads(thread_id);
        CREATE TABLE reading_observations AS SELECT thread_id, mode, page, fetched_at,
          reply_ids_json, end_candidate, skipped_items FROM thread_pages;
        CREATE UNIQUE INDEX reading_observations_page ON reading_observations(thread_id, mode, page);
        CREATE TABLE retained_titles (thread_id TEXT PRIMARY KEY NOT NULL, title TEXT, fetched_at TEXT NOT NULL);
        INSERT INTO retained_titles SELECT id, title, fetched_at FROM posts WHERE id IN (SELECT thread_id FROM post_threads);
        CREATE TABLE favorites (thread_id TEXT PRIMARY KEY NOT NULL, added_at TEXT NOT NULL);
        CREATE TABLE content_readers (holder TEXT PRIMARY KEY NOT NULL, thread_id TEXT NOT NULL);
        CREATE INDEX content_readers_thread ON content_readers(thread_id);
        CREATE TABLE content_clock (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), tick INTEGER NOT NULL);
        INSERT INTO content_clock VALUES (1, 0);
        ALTER TABLE posts ADD COLUMN last_used INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE posts ADD COLUMN derived_bytes INTEGER NOT NULL DEFAULT 0 CHECK(derived_bytes >= 0);
        ALTER TABLE thread_pages ADD COLUMN last_used INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE feed_pages ADD COLUMN last_used INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE directory_snapshot ADD COLUMN last_used INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE image_resources ADD COLUMN last_used INTEGER NOT NULL DEFAULT 0;
        CREATE TABLE offline_copies (
          thread_id TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          include_images INTEGER NOT NULL CHECK(include_images IN (0, 1)),
          state TEXT NOT NULL CHECK(state IN ('saving', 'stopped', 'cancelled', 'interrupted')),
          end_candidate_page INTEGER, failed_page INTEGER, error_json TEXT,
          image_failures_json TEXT NOT NULL DEFAULT '[]'
        );
        CREATE TABLE offline_pages (
          thread_id TEXT NOT NULL REFERENCES offline_copies(thread_id), page INTEGER NOT NULL CHECK(page >= 1),
          head_id TEXT NOT NULL REFERENCES posts(id), fetched_at TEXT NOT NULL,
          reply_count INTEGER, skipped_items INTEGER NOT NULL, end_candidate INTEGER NOT NULL,
          PRIMARY KEY(thread_id, page)
        );
        CREATE TABLE offline_page_posts (
          thread_id TEXT NOT NULL, page INTEGER NOT NULL, post_id TEXT NOT NULL REFERENCES posts(id),
          PRIMARY KEY(thread_id, page, post_id),
          FOREIGN KEY(thread_id, page) REFERENCES offline_pages(thread_id, page)
        );
        CREATE INDEX offline_page_posts_post ON offline_page_posts(post_id);
        CREATE TABLE offline_images (
          thread_id TEXT NOT NULL REFERENCES offline_copies(thread_id),
          post_id TEXT NOT NULL REFERENCES posts(id), resource_id INTEGER NOT NULL REFERENCES image_resources(id),
          PRIMARY KEY(thread_id, post_id, resource_id)
        );
        CREATE VIEW protected_posts AS
          SELECT head_id AS post_id FROM offline_pages UNION SELECT post_id FROM offline_page_posts
          UNION SELECT p.post_id FROM post_threads p JOIN content_readers r ON r.thread_id = p.thread_id
          UNION SELECT p.post_id FROM post_threads p JOIN drafts d ON d.target_kind = 'reply' AND d.target_id = p.thread_id;
        CREATE VIEW cached_post_references AS
          SELECT head_id AS post_id FROM thread_pages
          UNION SELECT j.value FROM thread_pages, json_each(reply_ids_json) j
          UNION SELECT json_extract(s.value, '$.headId') FROM feed_pages, json_each(summaries_json) s
          UNION SELECT j.value FROM feed_pages, json_each(summaries_json) s,
            json_each(json_extract(s.value, '$.recentReplyIds')) j;
        CREATE VIEW content_post_bytes AS SELECT p.id,
          length(CAST(json_array(p.id, forum_id, created_at, user_hash, name, title, is_admin, is_sage,
            content_json, plain_text, image_path, image_ext, fetched_at) AS BLOB)) + derived_bytes AS bytes,
          EXISTS(SELECT 1 FROM protected_posts h WHERE h.post_id = p.id) AS protected
          FROM posts p;
        CREATE VIEW content_metadata_bytes AS
          SELECT length(CAST(json_array(thread_id, mode, page, head_id, fetched_at, reply_ids_json, reply_count, skipped_items, end_candidate) AS BLOB)) AS bytes,
            (thread_id IN (SELECT thread_id FROM content_readers) OR thread_id IN (SELECT target_id FROM drafts WHERE target_kind = 'reply')) AS protected FROM thread_pages
          UNION ALL SELECT length(CAST(json_array(feed_kind, feed_id, page, fetched_at, summaries_json, skipped_items) AS BLOB)), 0 FROM feed_pages
          UNION ALL SELECT length(CAST(json_array(directory_json, fetched_at) AS BLOB)), 0 FROM directory_snapshot
          UNION ALL SELECT length(CAST(json_array(id, kind, source_url, file_name, format, bytes, width, height, fetched_at) AS BLOB)),
            (EXISTS(SELECT 1 FROM image_holders h WHERE h.resource_id = r.id) OR EXISTS(SELECT 1 FROM offline_images o WHERE o.resource_id = r.id)) FROM image_resources r;
        CREATE VIEW content_cache_bytes AS SELECT
          (SELECT coalesce(sum(bytes), 0) FROM content_post_bytes WHERE NOT protected) +
          (SELECT coalesce(sum(bytes), 0) FROM content_metadata_bytes WHERE NOT protected) +
          (SELECT coalesce(sum(bytes), 0) FROM image_resources r WHERE NOT EXISTS(SELECT 1 FROM image_holders h WHERE h.resource_id = r.id)
            AND NOT EXISTS(SELECT 1 FROM offline_images o WHERE o.resource_id = r.id)) AS bytes;
      `)
    }
  },
  {
    // v7 unifies the retained-v6 and subscription-v5 histories without replacing either's data.
    version: 7,
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS subscription_app_credentials (
          id TEXT PRIMARY KEY NOT NULL,
          ciphertext BLOB NOT NULL
        );
        CREATE TABLE IF NOT EXISTS subscription_configuration (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          generation INTEGER NOT NULL,
          app_credential_id TEXT,
          source TEXT NOT NULL CHECK (source IN ('app', 'web'))
        );
        INSERT OR IGNORE INTO subscription_configuration VALUES (1, 0, NULL, 'app');
        CREATE TABLE IF NOT EXISTS subscription_observations (
          id TEXT PRIMARY KEY NOT NULL,
          source TEXT NOT NULL,
          generation INTEGER NOT NULL,
          app_credential_id TEXT,
          web_credential_id TEXT,
          observation_json TEXT NOT NULL,
          valid_observation_json TEXT
        );
        CREATE INDEX IF NOT EXISTS subscription_observations_context ON subscription_observations
          (source, generation, app_credential_id, web_credential_id);
        CREATE TABLE IF NOT EXISTS subscription_operations (
          id TEXT PRIMARY KEY NOT NULL,
          operation_json TEXT NOT NULL
        );
      `)
    }
  },
  {
    version: 8,
    up(db) {
      // Reconciliation-v6 already has these personal records; retained-v7 does not.
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'offline_copies'").get()) {
        MIGRATIONS.find((migration) => migration.version === 6)!.up(db)
      }
      MIGRATIONS.find((migration) => migration.version === 7)!.up(db)
      ensurePublication(db)
      db.exec(`
        CREATE TABLE IF NOT EXISTS workspace (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          state_json TEXT NOT NULL,
          saved_at TEXT NOT NULL
        );
      `)
      const columns = db.pragma('table_info(publication_attempts)') as { name: string }[]
      if (!columns.some((column) => column.name === 'launch_notice')) {
        db.exec('ALTER TABLE publication_attempts ADD COLUMN launch_notice INTEGER NOT NULL DEFAULT 0 CHECK (launch_notice IN (0, 1))')
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS subscription_baselines (
          generation INTEGER PRIMARY KEY NOT NULL,
          baseline_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS subscription_plans (
          id TEXT PRIMARY KEY NOT NULL,
          plan_json TEXT NOT NULL
        );
      `)
    }
  },
  {
    version: 9,
    up(db) {
      // Search-v8 was developed on a different history. Do not treat its version number as
      // convergence-v8: fail inside the migration transaction, leaving that database untouched.
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
      for (const name of ['workspace', 'publication_attempts', 'subscription_plans', 'subscription_baselines']) {
        if (!tables.some((table) => table.name === name)) throw new Error('incompatible version 8 schema')
      }
      db.exec(`
        CREATE TABLE reminder_rules (
          thread_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('all', 'po', 'quote')),
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          generation INTEGER NOT NULL,
          started_at TEXT NOT NULL,
          watermark_post_id TEXT,
          closed_by TEXT CHECK (closed_by IN ('user', 'unsubscribe', 'sync-delete')),
          changed_at TEXT NOT NULL,
          PRIMARY KEY (thread_id, kind)
        );
        CREATE TABLE reminder_coverage (
          thread_id TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('all', 'po')),
          checkpoint_json TEXT,
          probe_json TEXT,
          state TEXT NOT NULL,
          issues_json TEXT NOT NULL,
          last_error_json TEXT,
          last_round_id INTEGER,
          updated_at TEXT,
          uncertain_count INTEGER NOT NULL DEFAULT 0,
          quote_own_revision TEXT,
          uncertainty_json TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY (thread_id, mode)
        );
        CREATE TABLE reminder_rounds (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trigger TEXT NOT NULL CHECK (trigger IN ('cold-start', 'reopen', 'manual')),
          started_at TEXT NOT NULL,
          finished_at TEXT,
          state TEXT NOT NULL CHECK (state IN ('running', 'finished', 'cancelled', 'interrupted')),
          stop_reason TEXT,
          threads_total INTEGER NOT NULL,
          threads_done INTEGER NOT NULL DEFAULT 0,
          threads_failed INTEGER NOT NULL DEFAULT 0,
          new_events INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE reminder_notifications (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          round_id INTEGER NOT NULL REFERENCES reminder_rounds(id),
          event_count INTEGER NOT NULL,
          thread_count INTEGER NOT NULL,
          coverage TEXT NOT NULL,
          state TEXT NOT NULL CHECK (state IN ('registered', 'shown', 'unavailable', 'failed', 'unknown')),
          registered_at TEXT NOT NULL
        );
        CREATE TABLE reminder_events (
          post_id TEXT PRIMARY KEY NOT NULL,
          thread_id TEXT NOT NULL,
          kinds_json TEXT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('all', 'po')),
          page INTEGER NOT NULL,
          excerpt TEXT NOT NULL CHECK (length(excerpt) <= 120),
          created_at TEXT,
          author_flags_json TEXT NOT NULL,
          quoted_own_ids_json TEXT NOT NULL,
          round_id INTEGER NOT NULL REFERENCES reminder_rounds(id),
          discovered_at TEXT NOT NULL,
          notification_id INTEGER REFERENCES reminder_notifications(id)
        );
        CREATE INDEX reminder_events_thread ON reminder_events(thread_id, discovered_at DESC);
        CREATE INDEX reminder_events_round ON reminder_events(round_id, notification_id);
      `)
    }
  },
  {
    version: 10,
    up(db) {
      db.exec(`ALTER TABLE posts ADD COLUMN image_known INTEGER;
        DROP VIEW content_post_bytes;
        CREATE VIEW content_post_bytes AS SELECT p.id,
          length(CAST(json_array(p.id,forum_id,created_at,user_hash,name,title,is_admin,is_sage,
            content_json,plain_text,image_path,image_ext,fetched_at,image_known) AS BLOB))+derived_bytes AS bytes,
          EXISTS(SELECT 1 FROM protected_posts h WHERE h.post_id=p.id) AS protected FROM posts p;`)
      createSearchSchema(db)
    }
  },
  {
    // Credentials get a user order; forum reads use the first one instead of a separate browse
    // role. The former browse choice moves to the front so reads keep the same identity.
    version: 11,
    up(db) {
      db.exec(`ALTER TABLE credentials ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
        WITH ordered AS (
          SELECT id, ROW_NUMBER() OVER (
            ORDER BY COALESCE(id = (SELECT credential_id FROM identity_roles WHERE role = 'browse'), 0) DESC, id
          ) AS n FROM credentials
        )
        UPDATE credentials SET position = (SELECT n FROM ordered WHERE ordered.id = credentials.id);
        DELETE FROM identity_roles WHERE role = 'browse';`)
    }
  },
  {
    version: 12,
    up(db) {
      db.exec(`CREATE TABLE account_session (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        ciphertext BLOB NOT NULL CHECK (typeof(ciphertext) = 'blob' AND length(ciphertext) > 0),
        expires_at TEXT NOT NULL
      );`)
    }
  },
  {
    version: 13,
    up(db) {
      db.exec(`CREATE TABLE local_blocks (
        kind TEXT NOT NULL CHECK (kind IN ('post', 'cookie')),
        value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 128),
        created_at TEXT NOT NULL,
        PRIMARY KEY (kind, value)
      );`)
    }
  },
  {
    // Thread favourites and read/unread tracking are gone. Their records are dropped, not migrated;
    // reading positions, visits, end/reading observations (reminder evidence) and reminders stay.
    version: 14,
    up(db) {
      db.exec(`DROP TABLE IF EXISTS favorites;
        DROP TABLE IF EXISTS post_reads;
        DROP TABLE IF EXISTS thread_attention;`)
    }
  },
  {
    // Cookies keep their public 饼干 ID beside the display name; cookies imported earlier have
    // none (NULL) and match nothing until re-imported or filled in. The own-post record is gone:
    // own posts, the PO cookie and quotes of mine are matched by 饼干 ID; publication attempts keep
    // their results and confirmed IDs. The quote re-check marker now follows the 饼干 ID set: every
    // credential is unknown here, so a marker already evaluated equals the empty set.
    version: 15,
    up(db) {
      db.exec(`ALTER TABLE credentials ADD COLUMN cookie_id TEXT;
        DROP TABLE IF EXISTS own_posts;
        ALTER TABLE reminder_coverage RENAME COLUMN quote_own_revision TO quote_cookie_revision;
        UPDATE reminder_coverage SET quote_cookie_revision = '[]' WHERE quote_cookie_revision IS NOT NULL;`)
    }
  },
  {
    // Reminders compare forum reply counts with a per-thread baseline instead of proving coverage
    // from page 1. Rules keep their enabled state and generation (the start becomes the latest enable
    // time); the start/watermark proof, coverage, rounds, events, notification records and end
    // observations are dropped, not converted. The first check after this rebuilds every baseline.
    version: 16,
    up(db) {
      db.exec(`CREATE TABLE reminder_rules_v16 (
          thread_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('all', 'po', 'quote')),
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          generation INTEGER NOT NULL,
          enabled_at TEXT NOT NULL,
          closed_by TEXT CHECK (closed_by IN ('user', 'unsubscribe', 'sync-delete')),
          changed_at TEXT NOT NULL,
          PRIMARY KEY (thread_id, kind)
        );
        INSERT INTO reminder_rules_v16 SELECT thread_id, kind, enabled, generation, started_at, closed_by, changed_at FROM reminder_rules;
        DROP TABLE reminder_rules;
        ALTER TABLE reminder_rules_v16 RENAME TO reminder_rules;
        DROP TABLE reminder_events;
        DROP TABLE reminder_notifications;
        DROP TABLE reminder_rounds;
        DROP TABLE reminder_coverage;
        DROP TABLE end_observations;
        -- One row per enabled kind once a check has seen it. baseline: the last reply count of the
        -- kind's mode (quote: replies whose quotes are checked); NULL until the first check sets it.
        CREATE TABLE reminder_state (
          thread_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('all', 'po', 'quote')),
          baseline INTEGER CHECK (baseline IS NULL OR baseline >= 0),
          checked_post_id TEXT,
          count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
          first_page INTEGER CHECK (first_page IS NULL OR first_page >= 1),
          increased_at TEXT,
          unverified INTEGER NOT NULL DEFAULT 0 CHECK (unverified >= 0),
          issues_json TEXT NOT NULL DEFAULT '[]',
          last_error_json TEXT,
          checked_at TEXT,
          PRIMARY KEY (thread_id, kind)
        );
        CREATE TABLE reminder_checker (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          last_checked_at TEXT
        );`)
    }
  },
  {
    version: 17,
    up(db) {
      db.exec(`ALTER TABLE reminder_checker ADD COLUMN backoff_minutes INTEGER NOT NULL DEFAULT 0 CHECK (backoff_minutes BETWEEN 0 AND 120);
        ALTER TABLE reminder_checker ADD COLUMN episode_id TEXT;
        ALTER TABLE reminder_checker ADD COLUMN notified INTEGER NOT NULL DEFAULT 0 CHECK (notified IN (0, 1));
        ALTER TABLE reminder_checker ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0 CHECK (dismissed IN (0, 1));`)
    }
  },
  {
    // Drafts no longer keep an E-mail field; every other draft column and its attachment stay.
    // Send attempts keep their stored payload_json unchanged; a leftover email there is ignored.
    version: 18,
    up(db) {
      db.exec('ALTER TABLE drafts DROP COLUMN email;')
    }
  },
  {
    // Each attempt keeps the sending cookie's 饼干 ID (existing attempts take the ID their never
    // reused credential has now, if any), and a send whose result was lost and could not be found
    // fails as `unverified`. Only `sending` / `unknown` attempts lock their source draft now: an
    // `unconfirmed` one was sent, so, as for a send recorded so from now on, its source draft goes
    // and it no longer holds its image. SQLite cannot change a CHECK in place, so the table is
    // rebuilt; every row, ID and the ID counter are kept.
    version: 19,
    up(db) {
      const sequence = db.prepare<[], { seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'publication_attempts'").get()
      db.exec(`CREATE TABLE publication_attempts_v19 (
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
            'rejected', 'rate-limited', 'captcha', 'network', 'response', 'unverified'
          )),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          post_id TEXT,
          thread_id TEXT,
          saved_draft_id INTEGER,
          launch_notice INTEGER NOT NULL DEFAULT 0 CHECK (launch_notice IN (0, 1)),
          cookie_id TEXT,
          CHECK (state != 'confirmed' OR (post_id IS NOT NULL AND thread_id IS NOT NULL))
        );
        INSERT INTO publication_attempts_v19 (
          id, request_id, editor_id, draft_id, payload_json, credential_id, forum_id, attachment_id, state, problem,
          created_at, updated_at, post_id, thread_id, saved_draft_id, launch_notice, cookie_id
        ) SELECT id, request_id, editor_id, draft_id, payload_json, credential_id, forum_id, attachment_id, state, problem,
          created_at, updated_at, post_id, thread_id, saved_draft_id, launch_notice,
          (SELECT cookie_id FROM credentials WHERE credentials.id = publication_attempts.credential_id)
        FROM publication_attempts;
        DROP TABLE publication_attempts;
        ALTER TABLE publication_attempts_v19 RENAME TO publication_attempts;
        CREATE UNIQUE INDEX publication_locked_draft ON publication_attempts(draft_id)
          WHERE draft_id IS NOT NULL AND state IN ('sending', 'unknown');
        CREATE INDEX publication_attachment_id ON publication_attempts(attachment_id);
        CREATE INDEX publication_identity_forum ON publication_attempts(credential_id, forum_id, created_at);
        DELETE FROM drafts WHERE id IN (SELECT draft_id FROM publication_attempts WHERE state = 'unconfirmed' AND draft_id IS NOT NULL);
        UPDATE publication_attempts SET attachment_id = NULL WHERE state = 'unconfirmed';`)
      if (sequence !== undefined) {
        db.prepare("DELETE FROM sqlite_sequence WHERE name = 'publication_attempts'").run()
        db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('publication_attempts', ?)").run(sequence.seq)
      }
    }
  },
  {
    // 饼干标色: a color name per 饼干 ID (exact text), and the IDs that were ever given the default
    // color automatically, so that a cleared or changed color is never given back. Imported cookies
    // whose 饼干 ID is known get the default color ('blue') once, dated by their earliest import.
    version: 20,
    up(db) {
      db.exec(`CREATE TABLE cookie_colors (
          cookie_id TEXT PRIMARY KEY,
          color TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE cookie_color_auto (cookie_id TEXT PRIMARY KEY);
        INSERT INTO cookie_colors (cookie_id, color, created_at)
          SELECT cookie_id, 'blue', MIN(imported_at) FROM credentials WHERE cookie_id IS NOT NULL GROUP BY cookie_id;
        INSERT INTO cookie_color_auto (cookie_id) SELECT cookie_id FROM cookie_colors;`)
    }
  },
  {
    // A failed attempt may keep the forum's own error text (plain, at most 120 characters).
    // Existing attempts have none.
    version: 21,
    up(db) {
      db.exec('ALTER TABLE publication_attempts ADD COLUMN forum_message TEXT CHECK (forum_message IS NULL OR length(forum_message) BETWEEN 1 AND 120);')
    }
  }
]

/** Publication-v6 and lifecycle-v7 used the same versions as retained/subscription layouts. */
function ensurePublication(db: Database.Database): void {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'publication_attempts'").get()) return
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
