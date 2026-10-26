import type Database from 'better-sqlite3'
import type { Post, ReadingMode, ThreadCoverage } from '../../shared/forum'
import { comparePostIds } from '../../shared/forum'
import {
  MAX_EVENTS_PER_GROUP, REMINDER_KINDS, type CheckRound, type CheckTrigger, type CoverageIssue, type NotificationCoverage,
  type ReminderCloseReason, type ReminderKind, type ReminderNotificationRecord, type ReminderRule,
  type ThreadCheckState, type ThreadReminders
} from '../../shared/reminders'
import type { EvaluationInput, EvaluationResult, ReminderCoverage, ReminderObservation, ReminderStoredOverview, RuleSnapshot } from '../reminders/contract'
import { evaluateObservedReplies } from '../reminders/evaluation'
import { endObservation } from './reading-state'

interface RuleRow {
  thread_id: string; kind: ReminderKind; enabled: number; generation: number; started_at: string
  watermark_post_id: string | null; closed_by: ReminderCloseReason | null
}
interface CoverageRow {
  thread_id: string; mode: ReadingMode; checkpoint_json: string | null; probe_json: string | null
  state: ThreadCheckState; issues_json: string; last_error_json: string | null; last_round_id: number | null
  updated_at: string | null; uncertain_count: number; quote_own_revision: string | null
  uncertainty_json: string
}
interface EventRow {
  post_id: string; thread_id: string; kinds_json: string; mode: ReadingMode; page: number; excerpt: string
  created_at: string | null; quoted_own_ids_json: string; round_id: number; discovered_at: string; notification_id: number | null
}
interface RoundRow {
  id: number; trigger: CheckTrigger; started_at: string; finished_at: string | null; state: CheckRound['state']
  stop_reason: CheckRound['stopReason']; threads_total: number; threads_done: number; threads_failed: number; new_events: number
}
interface NotificationRow {
  id: number; round_id: number; event_count: number; thread_count: number; coverage: NotificationCoverage
  state: ReminderNotificationRecord['state']; registered_at: string
}
function round(row: RoundRow): CheckRound {
  return { id: row.id, trigger: row.trigger, startedAt: row.started_at, finishedAt: row.finished_at,
    state: row.state, stopReason: row.stop_reason, threadsTotal: row.threads_total, threadsDone: row.threads_done,
    threadsFailed: row.threads_failed, newEvents: row.new_events }
}
function notification(row: NotificationRow): ReminderNotificationRecord {
  return { id: row.id, roundId: row.round_id, eventCount: row.event_count, threadCount: row.thread_count,
    coverage: row.coverage, state: row.state, registeredAt: row.registered_at }
}
function emptyRules(): ThreadReminders['rules'] {
  const disabled = (kind: ReminderKind): ReminderRule => ({ kind, enabled: false, startedAt: null, closedBy: null })
  return { all: disabled('all'), po: disabled('po'), quote: disabled('quote') }
}
function coverage(row: CoverageRow): ReminderCoverage {
  return { threadId: row.thread_id, mode: row.mode, checkpoint: row.checkpoint_json ? JSON.parse(row.checkpoint_json) : null,
    probe: row.probe_json ? JSON.parse(row.probe_json) : null, state: row.state, issues: JSON.parse(row.issues_json),
    lastError: row.last_error_json ? JSON.parse(row.last_error_json) : null, lastRoundId: row.last_round_id,
    updatedAt: row.updated_at, uncertainCount: row.uncertain_count,
    uncertainty: JSON.parse(row.uncertainty_json), quoteOwnRevision: row.quote_own_revision }
}

/** Durable personal records. No cascading FK to the evictable posts/thread_pages caches. */
export class ReminderDatabase {
  constructor(
    /** Write gate: refuses read-only (newer schema) and unavailable databases. */
    private readonly database: () => Database.Database,
    /** Read access: also allowed on a newer-schema database opened read-only. */
    private readonly readable: () => Database.Database,
    private readonly threshold: (since: string) => string | null,
    private readonly loadPost: (postId: string) => Post | null,
    private readonly coverage: (threadId: string, mode: ReadingMode) => ThreadCoverage
  ) {}

  /**
   * 提醒基线 of one rule: this thread's end was observed at or after the rule start (the stored
   * all-mode end observations; a PO rule also accepts the end of the PO pages). This is separate
   * from proving any reply newer than the start, which may still be missing (uncertain replies).
   */
  private baselineEstablished(threadId: string, kind: ReminderKind, start: string): boolean {
    const ended = this.readable().prepare<[string, string], { found: number }>(
      'SELECT 1 AS found FROM end_observations WHERE thread_id = ? AND julianday(observed_at) >= julianday(?) LIMIT 1').get(threadId, start)
    if (ended) return true
    if (kind !== 'po') return false
    const end = endObservation(threadId, this.coverage(threadId, 'po'))
    return end !== null && Date.parse(end.observedAt) >= Date.parse(start)
  }

  getRules(threadIds: string[]): ThreadReminders[] {
    const query = this.readable().prepare<[string], RuleRow>('SELECT * FROM reminder_rules WHERE thread_id = ?')
    return threadIds.map((threadId) => {
      const rules = emptyRules()
      for (const row of query.all(threadId)) rules[row.kind] = { kind: row.kind, enabled: row.enabled !== 0, startedAt: row.started_at, closedBy: row.closed_by }
      return { threadId, rules }
    })
  }

  setRule(threadId: string, kind: ReminderKind, enabled: boolean, at: string): ThreadReminders {
    const db = this.database()
    return db.transaction(() => {
      const current = db.prepare<[string, string], RuleRow>('SELECT * FROM reminder_rules WHERE thread_id = ? AND kind = ?').get(threadId, kind)
      if (Boolean(current?.enabled) === enabled) return this.getRules([threadId])[0]!
      if (enabled) {
        // The highest post ID observed anywhere so far: every post at or below it existed before now.
        const watermark = db.prepare<[], { id: string }>('SELECT post_id AS id FROM post_threads ORDER BY length(post_id) DESC, post_id DESC LIMIT 1').get()?.id ?? null
        db.prepare(`INSERT INTO reminder_rules VALUES (?, ?, 1, 1, ?, ?, NULL, ?)
          ON CONFLICT(thread_id, kind) DO UPDATE SET enabled = 1, generation = generation + 1,
          started_at = excluded.started_at, watermark_post_id = excluded.watermark_post_id, closed_by = NULL, changed_at = excluded.changed_at`)
          .run(threadId, kind, at, watermark, at)
      } else db.prepare("UPDATE reminder_rules SET enabled = 0, generation = generation + 1, closed_by = 'user', changed_at = ? WHERE thread_id = ? AND kind = ?")
        .run(at, threadId, kind)
      return this.getRules([threadId])[0]!
    }).immediate()
  }

  closeThreads(threadIds: string[], reason: ReminderCloseReason, at: string): string[] {
    const db = this.database()
    return db.transaction(() => {
      const update = db.prepare('UPDATE reminder_rules SET enabled = 0, generation = generation + 1, closed_by = ?, changed_at = ? WHERE thread_id = ? AND enabled = 1')
      return [...new Set(threadIds)].filter((threadId) => update.run(reason, at, threadId).changes > 0)
    }).immediate()
  }

  snapshots(): RuleSnapshot[] {
    return this.readable().prepare<[], RuleRow>('SELECT * FROM reminder_rules WHERE enabled = 1 ORDER BY thread_id, kind').all()
      .map((row) => ({ threadId: row.thread_id, kind: row.kind, generation: row.generation, startedAt: row.started_at, watermarkPostId: row.watermark_post_id }))
  }

  getCoverage(threadId: string, mode: ReadingMode): ReminderCoverage {
    const row = this.readable().prepare<[string, string], CoverageRow>('SELECT * FROM reminder_coverage WHERE thread_id = ? AND mode = ?').get(threadId, mode)
    return row ? coverage(row) : { threadId, mode, checkpoint: null, probe: null, state: 'baseline-pending', issues: [], lastError: null,
      lastRoundId: null, updatedAt: null, uncertainCount: 0, uncertainty: {}, quoteOwnRevision: null }
  }

  saveCoverage(value: ReminderCoverage): void {
    this.database().prepare(`INSERT INTO reminder_coverage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, mode) DO UPDATE SET checkpoint_json = excluded.checkpoint_json, probe_json = excluded.probe_json,
      state = excluded.state, issues_json = excluded.issues_json, last_error_json = excluded.last_error_json,
      last_round_id = excluded.last_round_id, updated_at = excluded.updated_at, uncertain_count = excluded.uncertain_count,
      quote_own_revision = excluded.quote_own_revision, uncertainty_json = excluded.uncertainty_json`)
      .run(value.threadId, value.mode, value.checkpoint ? JSON.stringify(value.checkpoint) : null,
        value.probe ? JSON.stringify(value.probe) : null, value.state, JSON.stringify(value.issues),
        value.lastError ? JSON.stringify(value.lastError) : null, value.lastRoundId, value.updatedAt, value.uncertainCount, value.quoteOwnRevision,
        JSON.stringify(value.uncertainty))
  }

  observations(threadId: string, mode: ReadingMode): ReminderObservation[] {
    return this.readable().prepare<[string, string], { page: number; reply_ids_json: string; skipped_items: number }>(
      'SELECT page, reply_ids_json, skipped_items FROM reading_observations WHERE thread_id = ? AND mode = ? ORDER BY page').all(threadId, mode)
      .map((row) => {
        const replyIds = JSON.parse(row.reply_ids_json) as string[]
        return { page: row.page, replyIds, skippedItems: row.skipped_items, posts: replyIds.map((id) => this.loadPost(id)) }
      })
  }

  ownRevision(): string {
    return JSON.stringify(this.readable().prepare<[], { post_id: string; evidence: string; confirmed_at: string }>(
      'SELECT post_id, evidence, confirmed_at FROM own_posts ORDER BY length(post_id), post_id').all())
  }

  evaluate(input: EvaluationInput): EvaluationResult {
    const db = this.database()
    return db.transaction(() => {
      // Re-read inside the same write transaction: a late page cannot resurrect a disabled kind.
      const current = db.prepare<[string, string], RuleRow>('SELECT * FROM reminder_rules WHERE thread_id = ? AND kind = ?')
      const rules = input.rules.filter((rule) => {
        const row = current.get(input.threadId, rule.kind)
        return row?.enabled === 1 && row.generation === rule.generation
      })
      const thresholds = new Map(rules.map((rule) => [rule.kind, this.threshold(rule.startedAt)]))
      const ownIds = new Set(db.prepare<[], { post_id: string }>('SELECT post_id FROM own_posts').all().map((row) => row.post_id))
      const result = evaluateObservedReplies({ rules, thresholds, ownIds, target: input.target, observations: this.observations(input.threadId, input.mode) })
      let newEvents = 0
      const select = db.prepare<[string], EventRow>('SELECT * FROM reminder_events WHERE post_id = ?')
      for (const hit of result.hits) {
        const existing = select.get(hit.postId)
        if (existing) {
          const kinds = { ...JSON.parse(existing.kinds_json), ...hit.kinds }
          const quoted = [...new Set([...(JSON.parse(existing.quoted_own_ids_json) as string[]), ...hit.quotedOwnIds])].sort(comparePostIds)
          db.prepare('UPDATE reminder_events SET kinds_json = ?, quoted_own_ids_json = ? WHERE post_id = ?')
            .run(JSON.stringify(kinds), JSON.stringify(quoted), hit.postId)
        } else {
          const excerpt = [...(hit.post?.plainText ?? '').replace(/\s+/gu, ' ').trim()].slice(0, 120).join('')
          db.prepare('INSERT INTO reminder_events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
            .run(hit.postId, input.threadId, JSON.stringify(hit.kinds), input.mode, hit.page, excerpt, hit.post?.createdAt ?? null,
              JSON.stringify({ isAdmin: hit.post?.isAdmin ?? null, isSage: hit.post?.isSage ?? null, userHash: hit.post?.userHash ?? null }),
              JSON.stringify(hit.quotedOwnIds), input.roundId, input.at)
          newEvents++
        }
      }
      return { newEvents, uncertainCount: result.uncertainIds.length, uncertainty: result.uncertainty,
        baselinePending: rules.some((rule) => !this.baselineEstablished(input.threadId, rule.kind, rule.startedAt)) }
    }).immediate()
  }

  createRound(trigger: CheckTrigger, at: string, threadsTotal: number): CheckRound {
    const row = this.database().prepare<[string, string, number], RoundRow>(`INSERT INTO reminder_rounds
      (trigger, started_at, state, threads_total) VALUES (?, ?, 'running', ?) RETURNING *`).get(trigger, at, threadsTotal)!
    return round(row)
  }
  saveRound(value: CheckRound): void {
    this.database().prepare(`UPDATE reminder_rounds SET finished_at = ?, state = ?, stop_reason = ?, threads_done = ?, threads_failed = ?, new_events = ? WHERE id = ?`)
      .run(value.finishedAt, value.state, value.stopReason, value.threadsDone, value.threadsFailed, value.newEvents, value.id)
  }
  recover(at: string): void {
    const db = this.database()
    db.transaction(() => {
      db.prepare("UPDATE reminder_rounds SET state = 'interrupted', stop_reason = 'crash', finished_at = ? WHERE state = 'running'").run(at)
      db.exec("UPDATE reminder_notifications SET state = 'unknown' WHERE state = 'registered'; UPDATE reminder_coverage SET state = 'incomplete' WHERE state = 'checking'")
    }).immediate()
  }

  registerNotification(roundId: number, scope: NotificationCoverage, at: string): ReminderNotificationRecord | null {
    const db = this.database()
    return db.transaction(() => {
      const current = db.prepare<[string, string], RuleRow>('SELECT * FROM reminder_rules WHERE thread_id = ? AND kind = ?')
      const events = db.prepare<[number], EventRow>('SELECT * FROM reminder_events WHERE round_id = ? AND notification_id IS NULL').all(roundId)
        .filter((event) => Object.entries(JSON.parse(event.kinds_json) as Record<string, number>).some(([kind, generation]) => {
          const rule = current.get(event.thread_id, kind)
          return rule?.enabled === 1 && rule.generation === generation
        }))
      if (events.length === 0) return null
      const row = db.prepare<[number, number, number, string, string], NotificationRow>(`INSERT INTO reminder_notifications
        (round_id, event_count, thread_count, coverage, state, registered_at) VALUES (?, ?, ?, ?, 'registered', ?) RETURNING *`)
        .get(roundId, events.length, new Set(events.map((event) => event.thread_id)).size, scope, at)!
      const update = db.prepare('UPDATE reminder_events SET notification_id = ? WHERE post_id = ? AND notification_id IS NULL')
      for (const event of events) update.run(row.id, event.post_id)
      return notification(row)
    }).immediate()
  }
  settleNotification(id: number, state: 'shown' | 'unavailable' | 'failed'): void {
    this.database().prepare("UPDATE reminder_notifications SET state = ? WHERE id = ? AND state = 'registered'").run(state, id)
  }

  overview(): ReminderStoredOverview {
    const db = this.readable()
    return db.transaction(() => {
      const threads = db.prepare<[], { thread_id: string }>(`SELECT thread_id FROM reminder_rules WHERE enabled = 1
        UNION SELECT thread_id FROM reminder_events`).all()
      const rules = this.getRules(threads.map((item) => item.thread_id))
      const snapshots = this.snapshots()
      const groups = rules.map(({ threadId, rules: threadRules }) => {
        const modes = new Set<ReadingMode>()
        if (threadRules.all.enabled || threadRules.quote.enabled) modes.add('all')
        if (threadRules.po.enabled) modes.add('po')
        const coverages = [...modes].map((mode) => this.getCoverage(threadId, mode))
        const uncertainIds = new Set<string>()
        for (const rule of snapshots.filter((item) => item.threadId === threadId)) {
          const threshold = this.threshold(rule.startedAt)
          for (const value of coverages) {
            const evidence = value.uncertainty[rule.kind]
            if (evidence?.generation !== rule.generation) continue
            for (const id of evidence.postIds) if (threshold === null || comparePostIds(id, threshold) < 0) uncertainIds.add(id)
          }
        }
        const issues: CoverageIssue[] = [...new Set(coverages.flatMap((item) => item.issues))].filter((value) => value !== 'boundary-uncertain')
        if (uncertainIds.size > 0) issues.push('boundary-uncertain')
        const baseline = REMINDER_KINDS.some((kind) => threadRules[kind].enabled && !this.baselineEstablished(threadId, kind, threadRules[kind].startedAt!))
        const states = coverages.map((item) => item.state)
        const state: ThreadCheckState = states.includes('checking') ? 'checking' : states.includes('failed') ? 'failed'
          : baseline ? 'baseline-pending' : states.includes('incomplete') ? 'incomplete' : issues.length ? 'uncertain' : 'done'
        const eventCount = db.prepare<[string], { total: number }>('SELECT count(*) AS total FROM reminder_events WHERE thread_id = ?').get(threadId)!.total
        const events = db.prepare<[string, number], EventRow>(`SELECT * FROM reminder_events WHERE thread_id = ?
          ORDER BY discovered_at DESC, length(post_id) DESC, post_id DESC LIMIT ?`).all(threadId, MAX_EVENTS_PER_GROUP)
        const head = this.loadPost(threadId)
        const title = head ? head.title || head.plainText.replace(/\s+/gu, ' ').trim().slice(0, 80) || null : null
        const latest = coverages.map((item) => item.updatedAt).filter((at): at is string => at !== null).sort().at(-1) ?? null
        return { threadId, title, rules: threadRules, state, issues,
          lastError: coverages.find((item) => item.lastError !== null)?.lastError ?? null, lastCheckedAt: latest,
          uncertainCount: uncertainIds.size, eventCount,
          events: events.map((event) => ({ postId: event.post_id, threadId: event.thread_id,
            kinds: REMINDER_KINDS.filter((kind) => kind in (JSON.parse(event.kinds_json) as object)), mode: event.mode, page: event.page,
            excerpt: event.excerpt, createdAt: event.created_at, quotedOwnIds: JSON.parse(event.quoted_own_ids_json) as string[],
            discoveredAt: event.discovered_at })) }
      })
      groups.sort((a, b) => (b.events[0]?.discoveredAt ?? '').localeCompare(a.events[0]?.discoveredAt ?? '') || comparePostIds(b.threadId, a.threadId))
      const current = db.prepare<[], RoundRow>("SELECT * FROM reminder_rounds WHERE state = 'running' ORDER BY id DESC LIMIT 1").get()
      const last = db.prepare<[], RoundRow>("SELECT * FROM reminder_rounds WHERE state <> 'running' ORDER BY id DESC LIMIT 1").get()
      const lastNotification = db.prepare<[], NotificationRow>('SELECT * FROM reminder_notifications ORDER BY id DESC LIMIT 1').get()
      return { currentRound: current ? round(current) : null, lastRound: last ? round(last) : null,
        lastNotification: lastNotification ? notification(lastNotification) : null, threads: groups }
    })()
  }
}
