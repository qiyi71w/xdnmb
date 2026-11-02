import type Database from 'better-sqlite3'
import type { ReadError } from '../../shared/api'
import { comparePostIds, type Post, type PostId, type ReadingMode, type ThreadPage } from '../../shared/forum'
import {
  REMINDER_KINDS, type CoverageIssue, type ReminderCloseReason, type ReminderKind, type ReminderRule,
  type ReminderThreadRow, type ThreadReminders
} from '../../shared/reminders'
import { threadTotalPages } from '../../shared/threadPages'
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
/** A confirmed local reply whose 全串／PO baseline now covers its proof count. */
interface SettleRow {
  publication_id: number; kind: 'all' | 'po'; generation: number
  before_count: number; after_segment: number; proof_count: number
}
interface SegmentRow {
  id: number; source: 'check' | 'open'; count_from: number | null; count_to: number | null
  added: number; excluded: number; cleared: number
}
type LocalReplyResult = 'excluded' | 'absorbed' | 'unprovable'

function emptyRules(): ThreadReminders['rules'] {
  const disabled = (kind: ReminderKind): ReminderRule => ({ kind, enabled: false, closedBy: null, baseline: null })
  return { all: disabled('all'), po: disabled('po'), quote: disabled('quote') }
}

/** `a` later than `b` (ISO texts from one clock); null is earliest. */
function later(a: string | null, b: string | null): boolean {
  return a !== null && (b === null || Date.parse(a) > Date.parse(b))
}

/** How much of the reply count interval `(from, to]` the segments' ranges cover together. */
function covered(segments: SegmentRow[], from: number, to: number): number {
  const parts = segments.map((segment) => [Math.max(from, segment.count_from!), Math.min(to, segment.count_to!)] as const)
    .filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0])
  let total = 0
  let reached = from
  for (const [start, end] of parts) {
    if (end <= reached) continue
    total += end - Math.max(start, reached)
    reached = end
  }
  return total
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
    const db = this.readable()
    const query = db.prepare<[string], RuleRow>('SELECT * FROM reminder_rules WHERE thread_id = ?')
    const state = db.prepare<[string], StateRow>('SELECT * FROM reminder_state WHERE thread_id = ?')
    return threadIds.map((threadId) => {
      const rules = emptyRules()
      const states = new Map(state.all(threadId).map((row) => [row.kind, row]))
      for (const row of query.all(threadId)) {
        const value = states.get(row.kind)
        const ready = value?.baseline !== null && value?.baseline !== undefined
          && (row.kind !== 'quote' || value.checked_post_id !== null)
        rules[row.kind] = { kind: row.kind, enabled: row.enabled !== 0, closedBy: row.closed_by,
          baseline: row.enabled === 0 ? null : ready ? 'ready' : 'pending' }
      }
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
      // A new generation starts without the old one's evidence: replies sent before it are not its.
      db.prepare('DELETE FROM reminder_local_replies WHERE thread_id = ? AND kind = ?').run(threadId, kind)
      db.prepare('DELETE FROM reminder_baseline_segments WHERE thread_id = ? AND kind = ?').run(threadId, kind)
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
        db.prepare('DELETE FROM reminder_local_replies WHERE thread_id = ?').run(threadId)
        db.prepare('DELETE FROM reminder_baseline_segments WHERE thread_id = ?').run(threadId)
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

  /**
   * Called in the transaction that persists a reply's send intent. For each enabled 全串 rule, and
   * the PO rule when the sending 饼干 ID is known and equals the head's public one, the reply gets
   * the largest reply count already committed for that mode (its baseline or saved pages): a count
   * the reply cannot be within. Without one, or when the saved count is below the baseline (the
   * count fell), the reply is unprovable in that mode.
   */
  recordIntent(publicationId: number, threadId: string): void {
    const db = this.database()
    const po = db.prepare(`SELECT 1 FROM publication_attempts p JOIN posts h ON h.id = ?
      WHERE p.id = ? AND p.cookie_id IS NOT NULL AND p.cookie_id = h.user_hash`).get(threadId, publicationId) !== undefined
    const modes = db.prepare<[string], { kind: 'all' | 'po'; generation: number; baseline: number | null; saved: number | null; segment: number }>(`
      SELECT r.kind, r.generation, s.baseline, c.reply_count AS saved,
        (SELECT coalesce(max(g.id), 0) FROM reminder_baseline_segments g WHERE g.thread_id = r.thread_id AND g.kind = r.kind) AS segment
      FROM reminder_rules r LEFT JOIN reminder_state s USING(thread_id, kind)
      LEFT JOIN thread_reply_counts c ON c.thread_id = r.thread_id AND c.mode = r.kind
      WHERE r.thread_id = ? AND r.enabled = 1 AND r.kind IN ('all', 'po')`).all(threadId)
    const insert = db.prepare(`INSERT INTO reminder_local_replies
      (publication_id, thread_id, kind, generation, before_count, after_segment, status) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    for (const mode of modes) {
      if (mode.kind === 'po' && !po) continue
      const observed = [mode.baseline, mode.saved].filter((count): count is number => count !== null)
      const before = observed.length === 0 || (mode.saved !== null && mode.baseline !== null && mode.saved < mode.baseline)
        ? null : Math.max(...observed)
      insert.run(publicationId, threadId, mode.kind, mode.generation, before, mode.segment, before === null ? 'unprovable' : 'pending')
    }
  }

  /**
   * Called in the publication result transaction (also for background and startup confirmation):
   * the smallest reply count of a saved page of that mode already holding the reply is its proof.
   */
  confirmedPublication(publicationId: number, threadId: string): void {
    const db = this.database()
    const pending = db.prepare<[number], { kind: 'all' | 'po'; post_id: string }>(`SELECT l.kind, p.post_id
      FROM reminder_local_replies l JOIN publication_attempts p ON p.id = l.publication_id
      WHERE l.publication_id = ? AND l.status = 'pending' AND p.state = 'confirmed'`).all(publicationId)
    const seen = db.prepare<[string, string, string], { proof: number | null }>(`SELECT min(t.reply_count) AS proof
      FROM thread_pages t, json_each(t.reply_ids_json) r WHERE t.thread_id = ? AND t.mode = ? AND r.value = ?`)
    const prove = db.prepare(`UPDATE reminder_local_replies SET proof_count = min(coalesce(proof_count, @proof), @proof)
      WHERE publication_id = @publicationId AND kind = @kind AND status = 'pending'`)
    for (const { kind, post_id: postId } of pending) {
      const proof = seen.get(threadId, kind, postId)?.proof ?? null
      if (proof !== null) prove.run({ proof, publicationId, kind })
    }
    this.settle(threadId)
  }

  /**
   * Called in the transaction that saves a fresh page. A count below the baseline makes every
   * pending reply of that mode unprovable (earlier counts no longer share its ordering); a page
   * holding a confirmed pending reply proves it with its count; a reader's read advances the
   * baseline; then replies the baseline now covers are settled.
   */
  pageSaved(page: ThreadPage, display: boolean): void {
    const count = page.replyCount
    if (count === null || !Number.isSafeInteger(count) || count < 0) return
    const db = this.database()
    const baseline = db.prepare<[string, string], { baseline: number }>(`SELECT s.baseline FROM reminder_rules r JOIN reminder_state s USING(thread_id, kind)
      WHERE r.thread_id = ? AND r.kind = ? AND r.enabled = 1 AND s.baseline IS NOT NULL`).get(page.threadId, page.mode)?.baseline ?? null
    if (baseline !== null && count < baseline) this.countDecreased(page.threadId, page.mode)
    if (page.replies.length > 0) {
      db.prepare(`UPDATE reminder_local_replies SET proof_count = min(coalesce(proof_count, @count), @count)
        WHERE thread_id = @threadId AND kind = @mode AND status = 'pending' AND publication_id IN (
          SELECT id FROM publication_attempts WHERE state = 'confirmed' AND thread_id = @threadId
            AND post_id IN (SELECT value FROM json_each(@ids))
        )`).run({ count, threadId: page.threadId, mode: page.mode, ids: JSON.stringify(page.replies.map((reply) => reply.id)) })
    }
    if (display) this.absorbDisplayed(page.threadId, page.mode, count)
    this.settle(page.threadId)
  }

  private countDecreased(threadId: string, kind: ReminderKind): void {
    this.database().prepare("UPDATE reminder_local_replies SET status = 'unprovable' WHERE thread_id = ? AND kind = ? AND status = 'pending'").run(threadId, kind)
  }

  /**
   * Decides each confirmed pending reply whose baseline now covers its proof count, once: within
   * `(before, proof]` only uncleared check growth (one or more segments) deducts 1; no uncleared
   * check growth (open absorption, cleared growth, the initial baseline) needs none; a mix is
   * unprovable and keeps the ordinary count.
   */
  private settle(threadId: string): void {
    const db = this.database()
    const ready = db.prepare<[string], SettleRow>(`SELECT l.publication_id, l.kind, l.generation, l.before_count, l.after_segment, l.proof_count
      FROM reminder_local_replies l
      JOIN publication_attempts p ON p.id = l.publication_id AND p.state = 'confirmed'
      JOIN reminder_rules r ON r.thread_id = l.thread_id AND r.kind = l.kind AND r.generation = l.generation AND r.enabled = 1
      JOIN reminder_state s ON s.thread_id = l.thread_id AND s.kind = l.kind
      WHERE l.thread_id = ? AND l.status = 'pending' AND l.proof_count IS NOT NULL AND s.baseline >= l.proof_count
      ORDER BY l.publication_id, l.kind`).all(threadId)
    const mark = db.prepare(`UPDATE reminder_local_replies SET status = ?
      WHERE publication_id = ? AND kind = ? AND generation = ? AND status = 'pending'`)
    for (const row of ready) mark.run(this.settleOne(threadId, row), row.publication_id, row.kind, row.generation)
  }

  private settleOne(threadId: string, row: SettleRow): LocalReplyResult {
    const db = this.database()
    const before = row.before_count
    const proof = row.proof_count
    if (proof <= before) return 'unprovable'
    // Segments committed after the intent only: earlier ones end at or below the pre-send count.
    const segments = db.prepare<[string, string, number, number, number, number], SegmentRow>(`SELECT id, source, count_from, count_to, added, excluded, cleared
      FROM reminder_baseline_segments WHERE thread_id = ? AND kind = ? AND generation = ? AND id > ?
        AND (count_from IS NULL OR count_to IS NULL OR (count_to > ? AND count_from < ?)) ORDER BY id`)
      .all(threadId, row.kind, row.generation, row.after_segment, before, proof)
    if (segments.some((segment) => segment.count_from === null || segment.count_to === null)) return 'unprovable'
    const counted = segments.filter((segment) => segment.source === 'check' && segment.cleared === 0)
    if (counted.length === 0) return 'absorbed'
    // Open absorption, cleared growth or the initial baseline inside the interval leave it uncovered.
    if (covered(counted, before, proof) < proof - before) return 'unprovable'
    // The earliest segment with room: a later round's notification keeps any peer reply it holds.
    const target = counted.find((segment) => segment.added > segment.excluded)
    if (target === undefined) return 'unprovable'
    const corrected = db.prepare(`UPDATE reminder_state SET count = count - 1, first_page = CASE WHEN count = 1 THEN NULL ELSE first_page END
      WHERE thread_id = ? AND kind = ? AND count > 0`).run(threadId, row.kind)
    if (corrected.changes !== 1) return 'unprovable'
    db.prepare('UPDATE reminder_baseline_segments SET excluded = excluded + 1 WHERE id = ?').run(target.id)
    return 'excluded'
  }

  increasedThreads(roundId: string): string[] {
    return this.readable().prepare<[string], { thread_id: string }>(`SELECT DISTINCT i.thread_id
      FROM reminder_baseline_segments i JOIN reminder_rules r USING(thread_id, kind, generation)
      JOIN reminder_state s USING(thread_id, kind)
      WHERE i.round_id = ? AND i.source = 'check' AND r.enabled = 1 AND i.cleared = 0 AND i.added > i.excluded AND s.count > 0
      ORDER BY i.thread_id`).all(roundId).map((row) => row.thread_id)
  }

  update(value: ReminderUpdate): boolean {
    const db = this.database()
    return db.transaction(() => {
      // Checked inside the write: a late result cannot write to a disabled or re-enabled kind.
      const rule = db.prepare<[string, string], RuleRow>('SELECT * FROM reminder_rules WHERE thread_id = ? AND kind = ?').get(value.threadId, value.kind)
      if (rule?.enabled !== 1 || rule.generation !== value.generation) return false
      db.prepare('INSERT INTO reminder_state (thread_id, kind) VALUES (?, ?) ON CONFLICT DO NOTHING').run(value.threadId, value.kind)
      const previous = db.prepare<[string, string], StateRow>('SELECT * FROM reminder_state WHERE thread_id = ? AND kind = ?').get(value.threadId, value.kind)!
      let baseline = value.baseline
      let add = value.add ?? 0
      let firstPage = value.firstPage
      if (value.kind !== 'quote' && baseline !== undefined && value.countedFrom !== undefined && value.countedFrom !== null
        && previous.baseline !== null && previous.baseline > value.countedFrom && baseline >= value.countedFrom) {
        // A reader's read advanced the baseline after this check loaded it: only growth past the
        // stored baseline is counted, and an older page 1 never lowers it.
        add = Math.max(0, baseline - previous.baseline)
        firstPage = add > 0 ? threadTotalPages(previous.baseline + 1)! : undefined
        baseline = Math.max(baseline, previous.baseline)
      }
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
        threadId: value.threadId, kind: value.kind, at: value.at, add, firstPage: firstPage ?? null,
        baseline: baseline ?? null, checked: value.checkedPostId ?? null, unverified: value.unverified ?? 0,
        issues: value.issues === undefined ? null : JSON.stringify([...new Set(value.issues)]),
        lastError: value.lastError ? JSON.stringify(value.lastError) : null, markChecked: value.checked ? 1 : 0
      })
      if (baseline !== undefined && previous.baseline !== null && baseline < previous.baseline) this.countDecreased(value.threadId, value.kind)
      if (add > 0) {
        const counted = value.kind !== 'quote' && previous.baseline !== null && baseline === previous.baseline + add
        db.prepare(`INSERT INTO reminder_baseline_segments
          (thread_id, kind, generation, source, round_id, count_from, count_to, added) VALUES (?, ?, ?, 'check', ?, ?, ?, ?)`)
          .run(value.threadId, value.kind, value.generation, value.roundId ?? '', counted ? previous.baseline : null, counted ? baseline! : null, add)
      }
      this.settle(value.threadId)
      return true
    }).immediate()
  }

  /**
   * A reader's fresh read of `mode` saw `replyCount`. An enabled 全串／PO rule with a baseline below
   * it advances to it, recorded as an `open` segment; nothing is counted. A waiting (unset) baseline
   * is left to the next check, and a smaller count never lowers a baseline.
   */
  private absorbDisplayed(threadId: string, mode: ReadingMode, replyCount: number): void {
    const db = this.database()
    const kind: ReminderKind = mode
    const current = db.prepare<[string, string], { generation: number; baseline: number }>(`SELECT r.generation, s.baseline
      FROM reminder_rules r JOIN reminder_state s USING(thread_id, kind)
      WHERE r.thread_id = ? AND r.kind = ? AND r.enabled = 1 AND s.baseline IS NOT NULL`).get(threadId, kind)
    if (current === undefined || replyCount <= current.baseline) return
    db.prepare('UPDATE reminder_state SET baseline = ? WHERE thread_id = ? AND kind = ?').run(replyCount, threadId, kind)
    db.prepare(`INSERT INTO reminder_baseline_segments
      (thread_id, kind, generation, source, round_id, count_from, count_to, added) VALUES (?, ?, ?, 'open', '', ?, ?, 0)`)
      .run(threadId, kind, current.generation, current.baseline, replyCount)
  }

  /** Every count of the thread becomes 0; its check segments are marked cleared. */
  clearCounts(threadId: string): boolean {
    const db = this.database()
    return db.transaction(() => {
      db.prepare("UPDATE reminder_baseline_segments SET cleared = 1 WHERE thread_id = ? AND source = 'check'").run(threadId)
      return db.prepare('UPDATE reminder_state SET count = 0, first_page = NULL, unverified = 0 WHERE thread_id = ? AND (count > 0 OR unverified > 0)')
        .run(threadId).changes > 0
    }).immediate()
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
