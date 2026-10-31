import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import type { AnalyticsCredentials, AnalyticsPlatform } from '../../src/shared/analytics-protocol.ts'
import { activeWindowStart, addDays, detailCutoff, isValidDay, summaryCutoff } from './days.ts'
import { isJsonObject } from './json.ts'

// Storage model
// - `instances`: one row per participating instance while it still has a reason to exist.
//   Only a SHA-256 of the self-operation token is kept. `last_seen_day` is overwritten by
//   every activity (registration day until then), so no first-registration date survives.
// - `daily_activity`: one row per instance and statistics day, holding the last report of
//   that day. Today's row is the only one that can change.
// - `service_days`: one anonymous row per day on which the service ran. It separates a
//   real zero from a day without data. When a day's linked rows expire, its active count
//   is frozen here; those frozen counts no longer contain any instance identifier.
//
// Every write runs in one IMMEDIATE transaction, so deletion, late activity and cleanup
// are serialized and either fully apply or leave the previous state.

const SCHEMA_VERSION = 1

const SCHEMA_V1 = `
CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  token_hash BLOB NOT NULL,
  last_seen_day TEXT NOT NULL
) STRICT;
CREATE INDEX instances_last_seen ON instances(last_seen_day);
CREATE TABLE daily_activity (
  day TEXT NOT NULL,
  instance_id TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'macos')),
  PRIMARY KEY (day, instance_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX daily_activity_instance ON daily_activity(instance_id, day);
CREATE TABLE service_days (
  day TEXT PRIMARY KEY,
  frozen_active INTEGER CHECK (frozen_active IS NULL OR frozen_active >= 0)
) STRICT;
`

export class AnalyticsSchemaError extends Error {
  override name = 'AnalyticsSchemaError'
}

export type RegisterResult =
  | { kind: 'registered'; credentials: AnalyticsCredentials }
  | { kind: 'capacity_exhausted' }

export type ActivityResult =
  | { kind: 'recorded'; duplicate: boolean }
  | { kind: 'invalid_credentials' }

export type DeletionResult = 'deleted' | 'invalid_credentials'

export interface CleanupResult {
  frozenDays: number
  activityRows: number
  instances: number
  summaries: number
}

export interface DistributionEntry {
  value: string
  count: number
}

export interface Distribution {
  versions: DistributionEntry[]
  platforms: DistributionEntry[]
}

/**
 * `detail`: counted from retained linked records. `summary`: anonymous frozen count.
 * `missing`: the service has no record of running that day; its count is unknown, not zero.
 */
export type TrendSource = 'detail' | 'summary' | 'missing'

export interface TrendDay {
  day: string
  active: number | null
  source: TrendSource
}

export interface AnalyticsSummary {
  today: string
  todayActive: number
  window: {
    from: string
    to: string
    active: number
    /** Days in the window without any service record. */
    missingDays: number
    /** Days in the window known only from a restored anonymous count. */
    summaryOnlyDays: number
  }
  distributions: { today: Distribution; window: Distribution }
  trend: { from: string; to: string; days: TrendDay[] }
}

export interface SummaryBackup {
  format: 'xidao-analytics-summaries'
  version: 1
  createdDay: string
  days: Array<{ day: string; active: number }>
}

export interface AnalyticsStore {
  register(day: string, maxInstances: number): RegisterResult
  recordActivity(day: string, credentials: AnalyticsCredentials, version: string, platform: AnalyticsPlatform): ActivityResult
  deleteInstance(credentials: AnalyticsCredentials): DeletionResult
  markServiceDay(day: string): void
  cleanup(today: string): CleanupResult
  summary(today: string): AnalyticsSummary
  exportSummaries(today: string): SummaryBackup
  importSummaries(backup: SummaryBackup, today: string): number
  close(): void
}

export interface OpenAnalyticsStoreOptions {
  path: string
  /** Refuse to open an existing file; used by restore so it never merges into live data. */
  createOnly?: boolean
}

type Row = Record<string, unknown>

export function openAnalyticsStore(options: OpenAnalyticsStoreOptions): AnalyticsStore {
  if (options.createOnly && existsSync(options.path)) {
    throw new AnalyticsSchemaError(`refusing to overwrite existing database ${options.path}`)
  }
  const db = new DatabaseSync(options.path)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA journal_mode = WAL')
    // An acknowledged deletion must survive power loss, and deleted content is
    // overwritten instead of lingering in free pages.
    db.exec('PRAGMA synchronous = FULL')
    db.exec('PRAGMA secure_delete = ON')
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db)
  } catch (error) {
    db.close()
    throw error
  }
  return createStore(db)
}

function migrate(db: DatabaseSync): void {
  const version = Number((db.prepare('PRAGMA user_version').get() as Row).user_version)
  if (version > SCHEMA_VERSION) {
    throw new AnalyticsSchemaError(`database schema ${version} is newer than supported ${SCHEMA_VERSION}`)
  }
  if (version === SCHEMA_VERSION) return
  immediate(db, () => {
    db.exec(SCHEMA_V1)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  })
}

function createStore(db: DatabaseSync): AnalyticsStore {
  const countInstances = db.prepare('SELECT count(*) AS n FROM instances')
  const insertInstance = db.prepare('INSERT INTO instances (id, token_hash, last_seen_day) VALUES (?, ?, ?)')
  const selectTokenHash = db.prepare('SELECT token_hash FROM instances WHERE id = ?')
  const selectActivity = db.prepare('SELECT 1 FROM daily_activity WHERE day = ? AND instance_id = ?')
  const insertActivity = db.prepare('INSERT INTO daily_activity (day, instance_id, version, platform) VALUES (?, ?, ?, ?)')
  const updateActivity = db.prepare('UPDATE daily_activity SET version = ?, platform = ? WHERE day = ? AND instance_id = ?')
  const touchInstance = db.prepare('UPDATE instances SET last_seen_day = ? WHERE id = ? AND last_seen_day < ?')
  const deleteActivityOf = db.prepare('DELETE FROM daily_activity WHERE instance_id = ?')
  const deleteInstanceRow = db.prepare('DELETE FROM instances WHERE id = ?')
  const markDay = db.prepare('INSERT OR IGNORE INTO service_days (day) VALUES (?)')
  const freezeExpired = db.prepare(`
    UPDATE service_days
    SET frozen_active = (SELECT count(*) FROM daily_activity a WHERE a.day = service_days.day)
    WHERE day < ? AND frozen_active IS NULL`)
  const purgeActivity = db.prepare('DELETE FROM daily_activity WHERE day < ?')
  const purgeInstances = db.prepare('DELETE FROM instances WHERE last_seen_day < ?')
  const purgeSummaries = db.prepare('DELETE FROM service_days WHERE day < ?')
  const countDay = db.prepare('SELECT count(*) AS n FROM daily_activity WHERE day = ?')
  const countWindow = db.prepare('SELECT count(DISTINCT instance_id) AS n FROM daily_activity WHERE day BETWEEN ? AND ?')
  const todayBuckets = {
    versions: db.prepare('SELECT version AS value, count(*) AS n FROM daily_activity WHERE day = ? GROUP BY version'),
    platforms: db.prepare('SELECT platform AS value, count(*) AS n FROM daily_activity WHERE day = ? GROUP BY platform')
  }
  // An instance belongs to the bucket of its last report inside the window.
  const latestInWindow = `
    WITH latest AS (
      SELECT instance_id, max(day) AS day FROM daily_activity WHERE day BETWEEN ? AND ? GROUP BY instance_id
    )
    SELECT a.%COLUMN% AS value, count(*) AS n
    FROM daily_activity a JOIN latest l ON a.instance_id = l.instance_id AND a.day = l.day
    GROUP BY a.%COLUMN%`
  const windowBuckets = {
    versions: db.prepare(latestInWindow.replaceAll('%COLUMN%', 'version')),
    platforms: db.prepare(latestInWindow.replaceAll('%COLUMN%', 'platform'))
  }
  const serviceDaysBetween = db.prepare(`
    SELECT day, frozen_active,
      (SELECT count(*) FROM daily_activity a WHERE a.day = s.day) AS live
    FROM service_days s WHERE day BETWEEN ? AND ? ORDER BY day`)
  const insertSummary = db.prepare('INSERT INTO service_days (day, frozen_active) VALUES (?, ?)')

  function authorize(credentials: AnalyticsCredentials): 'ok' | 'unknown' | 'mismatch' {
    const row = selectTokenHash.get(credentials.instanceId) as Row | undefined
    if (!row) return 'unknown'
    const stored = row.token_hash as Uint8Array
    return timingSafeEqual(stored, hashToken(credentials.token)) ? 'ok' : 'mismatch'
  }

  function distribution(statements: { versions: StatementSync; platforms: StatementSync }, ...params: string[]): Distribution {
    const read = (statement: StatementSync): DistributionEntry[] =>
      (statement.all(...params) as Row[])
        .map((row) => ({ value: String(row.value), count: Number(row.n) }))
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    return { versions: read(statements.versions), platforms: read(statements.platforms) }
  }

  function checkpoint(): void {
    // Moves committed deletions out of the WAL file; a busy checkpoint is retried next time.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  }

  return {
    register(day, maxInstances) {
      return immediate(db, () => {
        if (Number((countInstances.get() as Row).n) >= maxInstances) return { kind: 'capacity_exhausted' } as const
        const credentials = {
          instanceId: randomBytes(16).toString('base64url'),
          token: randomBytes(32).toString('base64url')
        }
        insertInstance.run(credentials.instanceId, hashToken(credentials.token), day)
        return { kind: 'registered', credentials } as const
      })
    },

    recordActivity(day, credentials, version, platform) {
      return immediate(db, () => {
        if (authorize(credentials) !== 'ok') return { kind: 'invalid_credentials' } as const
        const duplicate = selectActivity.get(day, credentials.instanceId) !== undefined
        if (duplicate) updateActivity.run(version, platform, day, credentials.instanceId)
        else insertActivity.run(day, credentials.instanceId, version, platform)
        touchInstance.run(day, credentials.instanceId, day)
        markDay.run(day)
        return { kind: 'recorded', duplicate } as const
      })
    },

    deleteInstance(credentials) {
      const result = immediate(db, (): DeletionResult => {
        const authorization = authorize(credentials)
        if (authorization === 'mismatch') return 'invalid_credentials'
        // Unknown credentials have nothing linked left: deleted earlier or already expired.
        if (authorization === 'unknown') return 'deleted'
        deleteActivityOf.run(credentials.instanceId)
        deleteInstanceRow.run(credentials.instanceId)
        return 'deleted'
      })
      if (result === 'deleted') checkpoint()
      return result
    },

    markServiceDay(day) {
      markDay.run(day)
    },

    cleanup(today) {
      const cutoff = detailCutoff(today)
      const result = immediate(db, () => ({
        frozenDays: Number(freezeExpired.run(cutoff).changes),
        activityRows: Number(purgeActivity.run(cutoff).changes),
        instances: Number(purgeInstances.run(cutoff).changes),
        summaries: Number(purgeSummaries.run(summaryCutoff(today)).changes)
      }))
      checkpoint()
      return result
    },

    summary(today) {
      return readTransaction(db, () => {
        const from = activeWindowStart(today)
        const trendFrom = summaryCutoff(today)
        const recorded = new Map<string, TrendDay>()
        for (const row of serviceDaysBetween.all(trendFrom, today) as Row[]) {
          const day = String(row.day)
          const frozen = row.frozen_active === null ? null : Number(row.frozen_active)
          recorded.set(day, frozen === null
            ? { day, active: Number(row.live), source: 'detail' }
            : { day, active: frozen, source: 'summary' })
        }
        const days: TrendDay[] = []
        let missingDays = 0
        let summaryOnlyDays = 0
        for (let day = trendFrom; day <= today; day = addDays(day, 1)) {
          const entry = recorded.get(day) ?? { day, active: null, source: 'missing' as const }
          days.push(entry)
          if (day >= from) {
            if (entry.source === 'missing') missingDays += 1
            if (entry.source === 'summary') summaryOnlyDays += 1
          }
        }
        return {
          today,
          todayActive: Number((countDay.get(today) as Row).n),
          window: {
            from,
            to: today,
            active: Number((countWindow.get(from, today) as Row).n),
            missingDays,
            summaryOnlyDays
          },
          distributions: {
            today: distribution(todayBuckets, today),
            window: distribution(windowBuckets, from, today)
          },
          trend: { from: trendFrom, to: today, days }
        }
      })
    },

    exportSummaries(today) {
      // Only finished days, as anonymous counts: a backup can never bring back an instance.
      return readTransaction(db, () => ({
        format: 'xidao-analytics-summaries' as const,
        version: 1 as const,
        createdDay: today,
        days: (serviceDaysBetween.all(summaryCutoff(today), addDays(today, -1)) as Row[]).map((row) => ({
          day: String(row.day),
          active: row.frozen_active === null ? Number(row.live) : Number(row.frozen_active)
        }))
      }))
    },

    importSummaries(backup, today) {
      return immediate(db, () => {
        let imported = 0
        for (const entry of backup.days) {
          if (entry.day >= today) continue
          insertSummary.run(entry.day, entry.active)
          imported += 1
        }
        return imported
      })
    },

    close() {
      db.close()
    }
  }
}

/** Validates an untrusted backup document; throws with the first problem found. */
export function parseSummaryBackup(value: unknown): SummaryBackup {
  if (!isJsonObject(value) || value.format !== 'xidao-analytics-summaries' || value.version !== 1) {
    throw new Error('not a supported summary backup')
  }
  if (typeof value.createdDay !== 'string' || !isValidDay(value.createdDay) || !Array.isArray(value.days)) {
    throw new Error('malformed summary backup')
  }
  const seen = new Set<string>()
  const days = value.days.map((entry: unknown) => {
    if (!isJsonObject(entry) || Object.keys(entry).length !== 2) throw new Error('malformed backup entry')
    const { day, active } = entry
    if (typeof day !== 'string' || !isValidDay(day) || seen.has(day)) throw new Error('invalid or duplicate backup day')
    if (typeof active !== 'number' || !Number.isSafeInteger(active) || active < 0) throw new Error('invalid backup count')
    seen.add(day)
    return { day, active }
  })
  return { format: value.format, version: value.version, createdDay: value.createdDay, days }
}

function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

function immediate<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK')
    throw error
  }
}

function readTransaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN')
  try {
    return work()
  } finally {
    if (db.isTransaction) db.exec('COMMIT')
  }
}
