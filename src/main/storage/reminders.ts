import type Database from 'better-sqlite3'
import type { ReadError } from '../../shared/api'
import { comparePostIds, type Post, type PostId, type ReadingMode } from '../../shared/forum'
import {
  REMINDER_KINDS, type CoverageIssue, type ReminderCloseReason, type ReminderKind, type ReminderRule,
  type ReminderThreadRow, type ThreadReminders
} from '../../shared/reminders'
import type { QuoteSource, ReminderBackoff, ReminderKindState, ReminderStoredOverview, ReminderUpdate, RuleSnapshot } from '../reminders/contract'

interface RuleRow {
  thread_id: string; kind: ReminderKind; enabled: number; generation: number; enabled_at: string
  closed_by: ReminderCloseReason | null
}
interface StateRow {
  thread_id: string; kind: ReminderKind; baseline: number | null; checked_post_id: string | null; count: number
  first_page: number | null; increased_at: string | null; unverified: number; issues_json: string
  last_error_json: string | null; checked_at: string | null
}

function emptyRules(): ThreadReminders['rules'] {
  const disabled = (kind: ReminderKind): ReminderRule => ({ kind, enabled: false, closedBy: null })
  return { all: disabled('all'), po: disabled('po'), quote: disabled('quote') }
}

/** `a` later than `b` (ISO texts from one clock); null is earliest. */
function later(a: string | null, b: string | null): boolean {
  return a !== null && (b === null || Date.parse(a) > Date.parse(b))
}

/** Durable personal records. No cascading FK to the evictable posts/thread_pages caches. */
export class ReminderDatabase {
  constructor(
    /** Write gate: refuses read-only (newer schema) and unavailable databases. */
    private readonly database: () => Database.Database,
    /** Read access: also allowed on a newer-schema database opened read-only. */
    private readonly readable: () => Database.Database,
    /** The stored post, without marking it used; null when not held. */
    private readonly peekPost: (postId: string) => Post | null
  ) {}

  getRules(threadIds: string[]): ThreadReminders[] {
    const query = this.readable().prepare<[string], RuleRow>('SELECT * FROM reminder_rules WHERE thread_id = ?')
    return threadIds.map((threadId) => {
      const rules = emptyRules()
      for (const row of query.all(threadId)) rules[row.kind] = { kind: row.kind, enabled: row.enabled !== 0, closedBy: row.closed_by }
      return { threadId, rules }
    })
  }

  /**
   * Every change of a rule starts a new generation and drops that kind's state: enabling makes the
   * next check set a new baseline (nothing counted then), disabling deletes the count.
   */
  setRule(threadId: string, kind: ReminderKind, enabled: boolean, at: string): ThreadReminders {
    const db = this.database()
    return db.transaction(() => {
      const current = db.prepare<[string, string], RuleRow>('SELECT * FROM reminder_rules WHERE thread_id = ? AND kind = ?').get(threadId, kind)
      if (Boolean(current?.enabled) === enabled) return this.getRules([threadId])[0]!
      if (enabled) {
        db.prepare(`INSERT INTO reminder_rules VALUES (?, ?, 1, 1, ?, NULL, ?)
          ON CONFLICT(thread_id, kind) DO UPDATE SET enabled = 1, generation = generation + 1,
          enabled_at = excluded.enabled_at, closed_by = NULL, changed_at = excluded.changed_at`).run(threadId, kind, at, at)
      } else {
        db.prepare("UPDATE reminder_rules SET enabled = 0, generation = generation + 1, closed_by = 'user', changed_at = ? WHERE thread_id = ? AND kind = ?")
          .run(at, threadId, kind)
      }
      db.prepare('DELETE FROM reminder_state WHERE thread_id = ? AND kind = ?').run(threadId, kind)
      return this.getRules([threadId])[0]!
    }).immediate()
  }

  closeThreads(threadIds: string[], reason: ReminderCloseReason, at: string): string[] {
    const db = this.database()
    return db.transaction(() => {
      const update = db.prepare('UPDATE reminder_rules SET enabled = 0, generation = generation + 1, closed_by = ?, changed_at = ? WHERE thread_id = ? AND enabled = 1')
      const drop = db.prepare('DELETE FROM reminder_state WHERE thread_id = ?')
      return [...new Set(threadIds)].filter((threadId) => {
        if (update.run(reason, at, threadId).changes === 0) return false
        drop.run(threadId)
        return true
      })
    }).immediate()
  }

  snapshots(): RuleSnapshot[] {
    return this.readable().prepare<[], RuleRow>(`SELECT r.* FROM reminder_rules r JOIN (
      SELECT r.thread_id, CASE WHEN count(s.checked_at) < count(*) THEN NULL ELSE min(julianday(s.checked_at)) END AS checked
      FROM reminder_rules r LEFT JOIN reminder_state s USING(thread_id, kind)
      WHERE r.enabled = 1 GROUP BY r.thread_id
    ) t USING(thread_id) WHERE r.enabled = 1 ORDER BY t.checked, r.thread_id, r.kind`).all()
      .map((row) => ({ threadId: row.thread_id, kind: row.kind, generation: row.generation }))
  }

  states(): ReminderKindState[] {
    return this.readable().prepare<[], StateRow>(`SELECT s.* FROM reminder_state s JOIN reminder_rules r USING(thread_id, kind)
      WHERE r.enabled = 1 ORDER BY s.thread_id, s.kind`).all()
      .map((row) => ({ threadId: row.thread_id, kind: row.kind, baseline: row.baseline, checkedPostId: row.checked_post_id,
        issues: JSON.parse(row.issues_json) as CoverageIssue[] }))
  }

  /** Distinct known 饼干 IDs of the imported cookies, sorted; unknown (NULL) IDs match nothing. */
  cookieIds(): string[] {
    return this.readable().prepare<[], { cookie_id: string }>(
      'SELECT DISTINCT cookie_id FROM credentials WHERE cookie_id IS NOT NULL ORDER BY cookie_id').all().map((row) => row.cookie_id)
  }

  quoteSources(postIds: PostId[]): QuoteSource[] {
    const db = this.readable()
    const own = db.prepare<[string], { found: number }>("SELECT 1 AS found FROM publication_attempts WHERE post_id = ? AND state = 'confirmed' LIMIT 1")
    return [...new Set(postIds)].map((postId) => ({ postId, own: own.get(postId) !== undefined, cookieId: this.peekPost(postId)?.userHash ?? null }))
  }

  update(value: ReminderUpdate): boolean {
    const db = this.database()
    return db.transaction(() => {
      // Checked inside the write: a late result cannot write to a disabled or re-enabled kind.
      const rule = db.prepare<[string, string], RuleRow>('SELECT * FROM reminder_rules WHERE thread_id = ? AND kind = ?').get(value.threadId, value.kind)
      if (rule?.enabled !== 1 || rule.generation !== value.generation) return false
      db.prepare('INSERT INTO reminder_state (thread_id, kind) VALUES (?, ?) ON CONFLICT DO NOTHING').run(value.threadId, value.kind)
      const add = value.add ?? 0
      db.prepare(`UPDATE reminder_state SET
          baseline = coalesce(@baseline, baseline),
          checked_post_id = coalesce(@checked, checked_post_id),
          first_page = CASE WHEN @add > 0 AND count = 0 THEN @firstPage ELSE first_page END,
          increased_at = CASE WHEN @add > 0 THEN @at ELSE increased_at END,
          count = count + @add,
          unverified = unverified + @unverified,
          issues_json = coalesce(@issues, issues_json),
          last_error_json = CASE WHEN @issues IS NULL THEN last_error_json ELSE @lastError END,
          checked_at = CASE WHEN @markChecked THEN @at ELSE checked_at END
        WHERE thread_id = @threadId AND kind = @kind`).run({
        threadId: value.threadId, kind: value.kind, at: value.at, add, firstPage: value.firstPage ?? null,
        baseline: value.baseline ?? null, checked: value.checkedPostId ?? null, unverified: value.unverified ?? 0,
        issues: value.issues === undefined ? null : JSON.stringify([...new Set(value.issues)]),
        lastError: value.lastError ? JSON.stringify(value.lastError) : null, markChecked: value.checked ? 1 : 0
      })
      return true
    }).immediate()
  }

  clearCounts(threadId: string): boolean {
    return this.database().prepare('UPDATE reminder_state SET count = 0, first_page = NULL, unverified = 0 WHERE thread_id = ? AND (count > 0 OR unverified > 0)')
      .run(threadId).changes > 0
  }

  finishCheck(at: string): void {
    this.database().prepare('INSERT INTO reminder_checker (singleton, last_checked_at) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET last_checked_at = excluded.last_checked_at').run(at)
  }

  loadBackoff(): ReminderBackoff {
    const row = this.readable().prepare<[], { backoff_minutes: number; episode_id: string | null; notified: number; dismissed: number }>(
      'SELECT backoff_minutes, episode_id, notified, dismissed FROM reminder_checker WHERE singleton = 1').get()
    return { minutes: row?.backoff_minutes ?? 0, episodeId: row?.episode_id ?? null, notified: row?.notified === 1, dismissed: row?.dismissed === 1 }
  }

  saveBackoff(value: ReminderBackoff): void {
    this.database().prepare(`INSERT INTO reminder_checker (singleton, backoff_minutes, episode_id, notified, dismissed)
      VALUES (1, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET backoff_minutes = excluded.backoff_minutes,
      episode_id = excluded.episode_id, notified = excluded.notified, dismissed = excluded.dismissed`)
      .run(value.minutes, value.episodeId, Number(value.notified), Number(value.dismissed))
  }

  overview(): ReminderStoredOverview {
    const db = this.readable()
    return db.transaction(() => {
      const rules = db.prepare<[], RuleRow>('SELECT * FROM reminder_rules WHERE enabled = 1').all()
      const states = new Map(db.prepare<[], StateRow>('SELECT * FROM reminder_state').all().map((row) => [`${row.thread_id}:${row.kind}`, row]))
      const title = db.prepare<[string], { title: string | null }>('SELECT title FROM retained_titles WHERE thread_id = ?')
      const replyCount = db.prepare<[string], { reply_count: number }>("SELECT reply_count FROM thread_reply_counts WHERE thread_id = ? AND mode = 'all'")
      const threads: ReminderThreadRow[] = []
      for (const threadId of new Set(rules.map((rule) => rule.thread_id))) {
        const enabled = rules.filter((rule) => rule.thread_id === threadId)
        const counts: Record<ReminderKind, number> = { all: 0, po: 0, quote: 0 }
        const firstPages: Partial<Record<ReminderKind, number>> = {}
        const issues = new Set<CoverageIssue>()
        let lastError: ReadError | null = null
        let lastIncreasedAt: string | null = null
        let lastCheckedAt: string | null = null
        let unverifiedQuotes = 0
        for (const rule of enabled) {
          const state = states.get(`${threadId}:${rule.kind}`)
          if (!state) continue
          counts[rule.kind] = state.count
          if (state.count > 0) {
            if (state.first_page !== null) firstPages[rule.kind] = state.first_page
            if (later(state.increased_at, lastIncreasedAt)) lastIncreasedAt = state.increased_at
          }
          if (later(state.checked_at, lastCheckedAt)) lastCheckedAt = state.checked_at
          for (const value of JSON.parse(state.issues_json) as CoverageIssue[]) issues.add(value)
          lastError ??= state.last_error_json ? JSON.parse(state.last_error_json) as ReadError : null
          unverifiedQuotes += state.unverified
        }
        if (unverifiedQuotes > 0) issues.add('quote-unverified')
        const allPage = [firstPages.all, firstPages.quote].filter((page): page is number => page !== undefined)
        const firstNew = counts.all === 0 && counts.quote === 0
          ? firstPages.po !== undefined ? { mode: 'po' as ReadingMode, page: firstPages.po } : null
          : allPage.length > 0 ? { mode: 'all' as ReadingMode, page: Math.min(...allPage) } : null
        const ruleState = this.getRules([threadId])[0]!.rules
        threads.push({ threadId, head: this.peekPost(threadId), title: title.get(threadId)?.title ?? null,
          replyCount: replyCount.get(threadId)?.reply_count ?? null, rules: ruleState, counts, issues: [...issues],
          lastError, unverifiedQuotes, firstNew, lastIncreasedAt: REMINDER_KINDS.some((kind) => counts[kind] > 0) ? lastIncreasedAt : null,
          enabledAt: enabled.map((rule) => rule.enabled_at).reduce((a, b) => later(b, a) ? b : a), lastCheckedAt })
      }
      const counted = (row: ReminderThreadRow) => row.lastIncreasedAt !== null
      threads.sort((a, b) => Number(counted(b)) - Number(counted(a))
        || (counted(a) ? Date.parse(b.lastIncreasedAt!) - Date.parse(a.lastIncreasedAt!) : Date.parse(b.enabledAt) - Date.parse(a.enabledAt))
        || comparePostIds(b.threadId, a.threadId))
      const checker = db.prepare<[], { last_checked_at: string | null }>('SELECT last_checked_at FROM reminder_checker WHERE singleton = 1').get()
      return { threads, badge: threads.filter(counted).length, lastCheckedAt: checker?.last_checked_at ?? null }
    })()
  }
}
