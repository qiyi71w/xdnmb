import Database from 'better-sqlite3'
import type { Post, ThreadPage } from '../../src/shared/forum'
import { openReadingDatabase } from '../../src/main/storage/database'
import { MIGRATIONS } from '../../src/main/storage/migrations'

const at = '2026-10-24T00:00:00.000Z'
const later = '2026-10-24T00:01:00.000Z'

export function v26Post(id: string): Post {
  return { id, forumId: '4', createdAt: null, userHash: null, name: null, title: `标题${id}`,
    isAdmin: null, isSage: null, content: [{ type: 'text', text: `旧正文${id}` }], plainText: `旧正文${id}`, image: null }
}

function threadPage(threadId: string, replyCount: number): ThreadPage {
  return { threadId, mode: 'all', page: 1, head: v26Post(threadId), replies: [v26Post(`${threadId}1`)],
    replyCount, skippedItems: 0, endCandidate: false }
}

/**
 * Writes a schema-v26 database, the last version before visits protected their head text:
 * visited 100 with its head and all-reply count (1) held; visited 200 whose pages, count and head
 * the v26 eviction already removed; visited 300 also saved offline (count 3); unvisited 400 as
 * ordinary cache. Built with the v1–v26 migrations and real writes; 200 is then evicted in the
 * order v26 used (pages and counts, then posts).
 */
export function writeVisitsV26(path: string): void {
  const old = openReadingDatabase(path, MIGRATIONS.filter((migration) => migration.version <= 26), { appVersion: '0.0.0-test' })
  try {
    for (const id of ['100', '200', '300', '400']) {
      old.saveThreadPage(threadPage(id, Number(id) / 100), at)
      if (id !== '400') old.recordVisit(id, later)
    }
    old.beginOfflineCopy('300', false, at)
    old.saveOfflinePage(threadPage('300', 3), at)
  } finally { old.close() }
  const raw = new Database(path)
  try {
    raw.exec(`DELETE FROM thread_pages WHERE thread_id = '200'; DELETE FROM thread_reply_counts WHERE thread_id = '200';
      DELETE FROM posts WHERE id IN ('200', '2001');`)
  } finally { raw.close() }
}
