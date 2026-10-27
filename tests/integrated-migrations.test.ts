import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { Post, ThreadPage } from '../src/shared/forum'
import type { SubscriptionObservation, SubscriptionOperation, SubscriptionPlan } from '../src/shared/subscriptions'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { MIGRATIONS } from '../src/main/storage/migrations'
import { DEFAULT_SETTINGS } from '../src/shared/settings'
import { createRequestScheduler } from '../src/main/reading/scheduler'
import { createReminderService } from '../src/main/reminders/service'
import { createSubscriptionService } from '../src/main/subscriptions/service'
import { asStore } from './helpers/store'
import { MIGRATIONS as INTEGRATED_V7 } from './fixtures/integrated-v7'
import { MIGRATIONS as RECONCILIATION_V6 } from './fixtures/reconciliation-v6'
import { MIGRATIONS as LIFECYCLE_V7 } from './fixtures/lifecycle-v7'
import { MIGRATIONS as REMINDERS_V9 } from './fixtures/reminders-v9'
import { MIGRATIONS as SEARCH_V8 } from './fixtures/local-search-v8'

const at = '2026-10-24T00:00:00.000Z'
const later = '2026-10-24T00:01:00.000Z'
const uuid = '00000000-0000-4000-8000-000000000001'
const ciphertext = Uint8Array.of(4, 8, 15, 16, 23, 42)
const context = { generation: 9, appCredentialId: 'historical-app', webCredentialId: '7' }
const folders: string[] = []
const connections: ReadingDatabase[] = []
const supportedVersion = Math.max(...MIGRATIONS.map((migration) => migration.version))
const heads = ['integrated-v7', 'reconciliation-v6', 'lifecycle-v7', 'integrated-v8', 'reminders-v9'] as const
type Predecessor = 'subscriptions-v5' | 'retained-v6' | typeof heads[number]
const hasSubscriptions = (kind: Predecessor) => kind === 'subscriptions-v5' || kind === 'integrated-v7' || kind === 'reconciliation-v6' || kind === 'integrated-v8' || kind === 'reminders-v9'
const hasDrafts = (kind: Predecessor) => kind === 'retained-v6' || kind === 'integrated-v7' || kind === 'lifecycle-v7' || kind === 'integrated-v8' || kind === 'reminders-v9'
const hasRetained = (kind: Predecessor) => kind === 'retained-v6' || kind === 'integrated-v7' || kind === 'integrated-v8' || kind === 'reminders-v9'
/** Draft columns every version keeps; v18 drops `email`, so snapshots taken before it compare these. */
const draftColumns = 'id, target_kind, target_id, credential_id, content, title, name, watermark, attachment_id, version, created_at, saved_at'
// publication_attempts.forum_message comes with v19.
const attemptColumns = 'id, request_id, editor_id, draft_id, payload_json, credential_id, forum_id, attachment_id, state, problem, created_at, updated_at, post_id, thread_id, saved_draft_id, launch_notice'
const keptColumns = (table: string) => table === 'drafts' ? `SELECT ${draftColumns} FROM drafts`
  : table === 'publication_attempts' ? `SELECT ${attemptColumns} FROM publication_attempts` : `SELECT * FROM ${table}`

function plan(): SubscriptionPlan {
  return { id: 'historical-plan', preview: { id: 'historical-preview', mode: 'sync', context, createdAt: at,
    left: observation(), right: { ...observation('historical-web'), source: 'web' }, leftLabel: 'App', rightLabel: '网页',
    firstSync: false, deletionsAllowed: false, items: [] }, createdAt: at, finishedAt: later,
    state: 'completed', stopReason: null, items: [] }
}

// Frozen subscription-v5 schema, not the current v5 migration (which belongs to drafts).
const subscriptionV5 = `
  CREATE TABLE subscription_app_credentials (id TEXT PRIMARY KEY NOT NULL, ciphertext BLOB NOT NULL);
  CREATE TABLE subscription_configuration (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), generation INTEGER NOT NULL,
    app_credential_id TEXT, source TEXT NOT NULL CHECK(source IN ('app', 'web'))
  );
  CREATE TABLE subscription_observations (
    id TEXT PRIMARY KEY NOT NULL, source TEXT NOT NULL, generation INTEGER NOT NULL,
    app_credential_id TEXT, web_credential_id TEXT, observation_json TEXT NOT NULL, valid_observation_json TEXT
  );
  CREATE INDEX subscription_observations_context ON subscription_observations
    (source, generation, app_credential_id, web_credential_id);
  CREATE TABLE subscription_operations (id TEXT PRIMARY KEY NOT NULL, operation_json TEXT NOT NULL);
`

function post(id: string): Post {
  return { id, forumId: '4', createdAt: null, userHash: null, name: null, title: `标题${id}`,
    isAdmin: null, isSage: null, content: [{ type: 'text', text: `旧正文${id}` }], plainText: `旧正文${id}`, image: null }
}
function page(): ThreadPage {
  return { threadId: '100', mode: 'all', page: 1, head: post('100'), replies: [post('101')],
    replyCount: 1, skippedItems: 0, endCandidate: false }
}
function observation(id = 'historical-observation'): SubscriptionObservation {
  return { id, source: 'app', context, startedAt: at,
    pages: [{ page: 1, threads: [{ head: post('100'), recentReplies: [post('101')], replyCount: 1, remainReplies: null }],
      fetchedAt: at, endCandidate: false }], ids: ['100'], nextPage: 2, error: null, cancelled: false }
}
function operation(): SubscriptionOperation {
  return { id: 'historical-operation', source: 'app', threadId: '100', action: 'add', context,
    objectLabel: 'App 订阅对象', createdAt: at, state: 'pending', report: 'pending', reportError: null,
    before: observation(), after: null, verification: 'unknown' }
}

function predecessor(kind: Predecessor): string {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-integration-migration-'))
  folders.push(folder)
  const path = join(folder, 'app.sqlite')
  const db = new Database(path)
  try {
    const migrations = kind === 'integrated-v7' ? INTEGRATED_V7 : kind === 'reconciliation-v6' ? RECONCILIATION_V6
      : kind === 'lifecycle-v7' ? LIFECYCLE_V7 : kind === 'reminders-v9' ? REMINDERS_V9
        : MIGRATIONS.filter((migration) => migration.version <= (kind === 'integrated-v8' ? 8 : kind === 'subscriptions-v5' ? 4 : 6))
    for (const migration of migrations) migration.up(db)
    db.prepare('INSERT INTO credentials(id, name, source, imported_at, ciphertext) VALUES (7, ?, ?, ?, ?)')
      .run('旧同步饼干', 'raw', at, Buffer.from(ciphertext))
    db.prepare("INSERT INTO identity_roles VALUES ('web-sync', 7)").run()
    db.prepare("INSERT INTO identity_roles VALUES ('browse', 7)").run()
    for (const value of [post('100'), post('101')]) {
      db.prepare(`INSERT INTO posts(id, forum_id, title, content_json, plain_text, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(value.id, value.forumId, value.title, JSON.stringify(value.content), value.plainText, at)
      db.prepare(`INSERT INTO post_threads(post_id, thread_id, observed_as, mode, page, fetched_at)
        VALUES (?, '100', ?, 'all', 1, ?)`).run(value.id, value.id === '100' ? 'head' : 'thread-reply', at)
    }
    db.prepare(`INSERT INTO thread_pages(thread_id, mode, page, head_id, fetched_at, reply_ids_json, reply_count, skipped_items, end_candidate)
      VALUES ('100', 'all', 1, '100', ?, '["101"]', 1, 0, 0)`).run(at)
    db.prepare("INSERT INTO thread_reading VALUES ('100', 'po', ?)").run(at)
    db.prepare("INSERT INTO reading_positions VALUES ('100', 'all', '101', 1, 0.4, 12, ?)").run(at)
    db.prepare("INSERT INTO post_reads VALUES ('101', '100', ?)").run(at)
    db.prepare("INSERT INTO thread_attention VALUES ('100', ?, 'import', '101')").run(at)
    db.prepare("INSERT INTO thread_visits VALUES ('100', ?, ?, 3)").run(at, later)
    db.prepare("INSERT INTO settings VALUES ('newTabSplitDefault', 'false')").run()
    if (hasSubscriptions(kind)) {
      if (kind === 'subscriptions-v5') db.exec(subscriptionV5)
      db.prepare("INSERT INTO subscription_app_credentials VALUES ('historical-app', ?)").run(Buffer.from(ciphertext))
      db.prepare("INSERT INTO subscription_app_credentials VALUES ('replaced-app', ?)").run(Buffer.from([99, 88]))
      db.prepare("INSERT OR REPLACE INTO subscription_configuration VALUES (1, 9, 'historical-app', 'web')").run()
      db.prepare("INSERT INTO subscription_observations VALUES (?, 'app', 9, 'historical-app', '7', ?, ?)")
        .run(observation().id, JSON.stringify(observation()), JSON.stringify(observation()))
      db.prepare('INSERT INTO subscription_operations VALUES (?, ?)').run(operation().id, JSON.stringify(operation()))
    }
    if (hasDrafts(kind)) {
      db.prepare(`INSERT INTO draft_attachments(id, file_name, format, bytes, width, height, original_name, created_at)
        VALUES (4, 'old-copy.png', 'png', 24, 2, 3, 'original.png', ?)`).run(at)
      db.prepare(`INSERT INTO drafts(id, target_kind, target_id, credential_id, content, title, name, email,
        watermark, attachment_id, version, created_at, saved_at)
        VALUES (8, 'reply', '100', 7, '未发送草稿', '草稿标题', '', '', 1, 4, 3, ?, ?)`).run(at, later)
      db.prepare("INSERT INTO thread_post_identities VALUES ('100', 7, ?)").run(at)
    }
    if (hasRetained(kind)) {
      db.prepare("INSERT INTO favorites VALUES ('100', ?)").run(at)
      db.prepare("INSERT INTO retained_titles VALUES ('100', '离线标题', ?)").run(at)
      db.prepare(`INSERT INTO offline_copies(thread_id, created_at, updated_at, include_images, state, end_candidate_page)
        VALUES ('100', ?, ?, 0, 'stopped', 1)`).run(at, later)
      db.prepare("INSERT INTO offline_pages VALUES ('100', 1, '100', ?, 1, 0, 1)").run(at)
      db.prepare("INSERT INTO offline_page_posts VALUES ('100', 1, '101')").run()
      db.prepare("INSERT INTO reading_observations VALUES ('100', 'all', 1, ?, '[\"101\"]', 0, 0)").run(at)
    }
    if (kind === 'reconciliation-v6' || kind === 'integrated-v8' || kind === 'reminders-v9') {
      db.prepare('INSERT INTO subscription_baselines VALUES (9, ?)').run(JSON.stringify({ context, ids: ['100'] }))
      db.prepare('INSERT INTO subscription_plans VALUES (?, ?)').run(plan().id, JSON.stringify(plan()))
    }
    if (kind === 'lifecycle-v7' || kind === 'integrated-v8' || kind === 'reminders-v9') {
      const payload = { draftId: null, target: { kind: 'reply', threadId: '100' }, credentialId: '7',
        fields: { content: '待核对的发送', title: '', name: '', email: '', watermark: false }, attachmentId: '4' }
      db.prepare(`INSERT INTO publication_attempts(request_id, editor_id, payload_json, credential_id, forum_id,
        attachment_id, state, created_at, updated_at, launch_notice) VALUES ('historical-send', 'old-editor', ?, 7, '4', 4, 'unknown', ?, ?, 1)`)
        .run(JSON.stringify(payload), at, later)
      db.prepare("INSERT INTO workspace VALUES (1, '{\"saved\":true}', ?)").run(at)
    }
    if (kind === 'reminders-v9') {
      db.prepare("INSERT INTO reminder_rules VALUES ('100', 'all', 1, 3, ?, '101', NULL, ?)").run(at, later)
      db.prepare("INSERT INTO reminder_rounds(id, trigger, started_at, finished_at, state, threads_total, threads_done, new_events) VALUES (1, 'manual', ?, ?, 'finished', 1, 1, 1)").run(at, later)
      db.prepare("INSERT INTO reminder_notifications VALUES (1, 1, 1, 1, 'complete', 'shown', ?)").run(later)
      db.prepare("INSERT INTO reminder_events VALUES ('101', '100', '[\"all\"]', 'all', 1, '保留提醒摘要', NULL, '{}', '[]', 1, ?, 1)").run(later)
    }
    const version = kind === 'subscriptions-v5' ? 5 : Math.max(...migrations.map((migration) => migration.version))
    db.pragma(`user_version = ${version}`)
  } finally { db.close() }
  return path
}

function open(path: string) {
  const db = openReadingDatabase(path)
  connections.push(db)
  return db
}
function clear(db: ReadingDatabase) {
  for (let batch = 0; batch < 100; batch++) if (!db.evictContentBatch(true).more) return
  throw new Error('cache eviction did not settle')
}

afterEach(() => {
  for (const db of connections.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { force: true, recursive: true })
})

describe('combined predecessor migration', () => {
  it('rejects frozen search-v8 without changing any original bytes', () => {
    const folder = mkdtempSync(join(tmpdir(), 'xidao-search-v8-collision-'))
    folders.push(folder)
    const path = join(folder, 'old.sqlite')
    const old = new Database(path)
    for (const migration of SEARCH_V8) migration.up(old)
    old.prepare("INSERT INTO credentials(id, name, source, imported_at, ciphertext) VALUES (7, '保留凭据', 'raw', ?, ?)").run(at, Buffer.from(ciphertext))
    old.pragma('user_version = 8')
    old.close()
    const original = readFileSync(path)
    const refused = open(path)
    expect(refused.status).toEqual({ state: 'unavailable', reason: 'migration-failed' })
    refused.close()
    expect(readFileSync(path)).toEqual(original)
    const unchanged = new Database(path, { readonly: true })
    try {
      expect(unchanged.pragma('user_version', { simple: true })).toBe(8)
      expect(unchanged.prepare('SELECT name, ciphertext FROM credentials WHERE id = 7').get()).toEqual({ name: '保留凭据', ciphertext: Buffer.from(ciphertext) })
      expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name = 'reminder_rules'").get()).toBeUndefined()
    } finally { unchanged.close() }
  })

  it('upgrades frozen reminders-v9 to the current schema, keeping reminder rules but not the old event records', () => {
    const path = predecessor('reminders-v9')
    const db = open(path)
    expect(db.status).toEqual({ state: 'ready', schemaVersion: Math.max(...MIGRATIONS.map((migration) => migration.version)) })
    db.beginSearchRebuild()
    let rebuilt = false
    for (let batch = 0; batch < 100 && !rebuilt; batch++) rebuilt = db.rebuildSearchBatch()
    expect(rebuilt).toBe(true)
    const result = db.searchBatch({ query: '旧正文', scope: { kind: 'local' },
      filters: { forumId: null, fromDate: null, toDate: null, image: 'any' }, after: 0, upper: db.searchBoundary() })
    expect(result.batch.hits.map((hit) => hit.postId)).toEqual(['100', '101'])
    expect(db.getContentUsage().protectedTextBytes).toBeGreaterThan(0)
    const raw = new Database(path, { readonly: true })
    try {
      const bytes = raw.prepare<[], { bytes: number }>('SELECT sum(derived_bytes) AS bytes FROM posts').get()
      expect(bytes?.bytes).toBeGreaterThan(0)
      expect(raw.prepare('SELECT generation, enabled FROM reminder_rules').get()).toEqual({ generation: 3, enabled: 1 })
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE name IN ('reminder_events', 'reminder_notifications', 'reminder_rounds')").all()).toEqual([])
    } finally { raw.close() }
  })

  it.each(heads)('converges %s to the same tables, columns and indexes as a fresh install', (kind) => {
    const path = predecessor(kind)
    const folder = mkdtempSync(join(tmpdir(), 'xidao-fresh-schema-'))
    folders.push(folder)
    const freshPath = join(folder, 'fresh.sqlite')
    open(path).close()
    open(freshPath).close()
    const shape = (file: string) => {
      const connection = new Database(file, { readonly: true })
      try {
        const objects = connection.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as { type: string; name: string }[]
        return objects.map((object) => ({ ...object,
          columns: object.type === 'table' ? connection.pragma(`table_info(${object.name})`) : null,
          indexes: object.type === 'table' ? connection.pragma(`index_list(${object.name})`) : null }))
      } finally { connection.close() }
    }
    expect(shape(path)).toEqual(shape(freshPath))
  })

  it.each(['subscriptions-v5', 'retained-v6', ...heads] as const)('preserves %s personal state and supports combined reading and operation APIs', async (kind) => {
    const path = predecessor(kind)
    const db = open(path)
    expect(db.status).toEqual({ state: 'ready', schemaVersion: supportedVersion })
    expect(db.loadCredentialCiphertext('7')).toEqual(ciphertext)
    expect(db.loadRoleSelections()['web-sync']).toEqual({ state: 'selected', credentialId: '7' })
    expect(db.loadSettings()).toEqual({ ...DEFAULT_SETTINGS, newTabSplitDefault: false })
    expect(db.loadThreadPage('100', 'all', 1)?.value.replies).toEqual([post('101')])
    expect(db.findPostThread('101')).toEqual({ threadId: '100', isHead: false, preferredMode: 'po', pages: { all: 1, po: null } })
    expect(db.getReadingState('100')).toMatchObject({ mode: 'po',
      positions: { all: { anchor: { postId: '101', offsetRatio: 0.4, viewportOffset: 12 } } } })
    expect(db.listHistory()[0]).toMatchObject({ threadId: '100', at: later })
    if (hasSubscriptions(kind)) {
      expect(db.loadSubscriptionConfiguration()).toEqual({ source: 'web', context })
      expect(db.loadSubscriptionAppCiphertext('historical-app')).toEqual(ciphertext)
      expect(db.loadSubscriptionAppCiphertext('replaced-app')).toEqual(Uint8Array.of(99, 88))
      expect(db.loadSubscriptionObservation('app', context, true)).toEqual(observation())
      expect(db.loadSubscriptionOperations()).toEqual([operation()])
    }
    if (hasDrafts(kind)) {
      expect(db.listDrafts()[0]).toMatchObject({ id: '8', version: 3, credentialId: '7', fields: { content: '未发送草稿', watermark: true },
        attachment: { id: '4', fileName: 'old-copy.png', bytes: 24, originalName: 'original.png' } })
      expect(db.getThreadPostIdentity('100')).toEqual({ state: 'selected', credentialId: '7' })
    } else expect(db.listDrafts()).toEqual([])
    if (hasRetained(kind)) {
      expect(db.getOfflineCopy('100')).toMatchObject({ pages: [1], postCount: 2, state: 'stopped' })
    }
    if (kind === 'reconciliation-v6' || kind === 'integrated-v8' || kind === 'reminders-v9') {
      expect(db.loadSubscriptionBaseline(context)).toEqual({ context, ids: ['100'] })
      expect(db.loadSubscriptionPlans()).toEqual([plan()])
    }
    if (kind === 'lifecycle-v7' || kind === 'integrated-v8' || kind === 'reminders-v9') {
      expect(db.listPublications()[0]).toMatchObject({ requestId: 'historical-send', state: 'unknown', payload: { attachmentId: '4' } })
      expect(db.listLaunchNotices().map((attempt) => attempt.requestId)).toEqual(['historical-send'])
      expect(db.loadWorkspace()).toBe('{"saved":true}')
    }
    if (!hasSubscriptions(kind)) {
      expect(db.loadSubscriptionConfiguration()).toEqual({ source: 'app', context: { generation: 0, appCredentialId: null, webCredentialId: '7' } })
      db.setSubscriptionAppCredential(context.appCredentialId, ciphertext)
      db.saveSubscriptionObservation({ ...observation(), context: db.loadSubscriptionConfiguration().context })
      db.saveSubscriptionOperation({ ...operation(), context: db.loadSubscriptionConfiguration().context })
    }
    const requests: string[] = []
    const service = createSubscriptionService({ store: asStore(db), scheduler: createRequestScheduler({ backgroundSpacingMs: 0 }),
      protector: { isAvailable: async () => true, encrypt: async () => ciphertext, decrypt: async () => uuid },
      transport: { async get(url) { requests.push(url.pathname); return { mediaType: 'application/json', text: JSON.stringify([{ id: '100', fid: '4', content: '回读正文' }]) } } },
      appOrigin: 'https://app.example', webOrigin: 'https://web.example' })
    await service.recover()
    expect(db.loadSubscriptionOperations()[0]).toMatchObject({ state: 'needs-reconciliation', report: 'unknown' })
    expect(requests).toEqual([])
    const result = await service.reconcile({ id: operation().id, operationId: 'check' }, new AbortController().signal)
    expect(result).toMatchObject({ ok: true, value: { state: 'settled', report: 'unknown', verification: 'present' } })
    expect(requests).toEqual(['/Api/feed'])
    expect(db.getReadingState('100').positions.all?.anchor.postId).toBe('101')
    expect(db.saveDraft({ draftId: null, target: { kind: 'reply', threadId: '100' }, credentialId: '7',
      fields: { content: '新草稿', title: '', name: '', watermark: false }, attachmentId: null }, later)).toMatchObject({ ok: true })
    db.close()
    const reopened = open(path)
    expect(reopened.loadSubscriptionOperations()[0]).toMatchObject({ state: 'settled', verification: 'present' })
    expect(reopened.loadCredentialCiphertext('7')).toEqual(ciphertext)
    expect(reopened.listDrafts().some((draft) => draft.fields.content === '新草稿')).toBe(true)
    if (hasRetained(kind)) {
      clear(reopened)
      expect(reopened.loadThreadPage('100', 'all', 1)?.value.replies).toEqual([post('101')])
      expect(reopened.listDrafts().some((draft) => draft.attachment?.fileName === 'old-copy.png')).toBe(true)
    }
  })

  it.each(['subscriptions-v5', 'retained-v6', ...heads] as const)('rolls back every schema/data change when %s migration fails', (kind) => {
    const path = predecessor(kind)
    const originalBytes = readFileSync(path)
    const db = openReadingDatabase(path, [...MIGRATIONS, { version: supportedVersion + 1, up(connection) {
      connection.exec("UPDATE credentials SET name = 'must roll back'")
      throw new Error('injected failure after all integration migrations')
    } }])
    connections.push(db)
    expect(db.status).toEqual({ state: 'unavailable', reason: 'migration-failed' })
    expect(readFileSync(path)).toEqual(originalBytes)
    const recovered = open(path)
    expect(recovered.status.state).toBe('ready')
    expect(recovered.listCredentials()[0]?.name).toBe('旧同步饼干')
    expect(recovered.loadThreadPage('100', 'all', 1)?.value.replies[0]?.plainText).toBe('旧正文101')
    if (hasSubscriptions(kind)) expect(recovered.loadSubscriptionOperations()).toEqual([operation()])
    else expect(recovered.listDrafts()[0]?.fields.content).toBe('未发送草稿')
  })

  it('accounts and evicts normalized subscription and quote content without erasing journals or navigation evidence', () => {
    const folder = mkdtempSync(join(tmpdir(), 'xidao-subscription-cache-'))
    folders.push(folder)
    const db = open(join(folder, 'app.sqlite'))
    const before = db.getContentUsage()
    db.saveSubscriptionObservation(observation())
    db.saveSubscriptionOperation(operation())
    db.savePost(post('999'), at)
    expect(db.loadPost('101')?.value).toEqual(post('101'))
    expect(db.findPostThread('101')).toMatchObject({ threadId: '100', pages: { all: null, po: null } })
    db.saveThreadPage(page(), at)
    const usage = db.getContentUsage()
    expect(usage.cacheTextBytes).toBeGreaterThan(before.cacheTextBytes)
    expect(usage.personalDataBytes).toBeGreaterThan(before.personalDataBytes + Buffer.byteLength(JSON.stringify(operation())))
    expect(db.loadPost('101')?.value).toEqual(post('101'))
    expect(db.findPostThread('101')?.pages.all).toBe(1)
    clear(db)
    expect(db.getContentUsage().cacheTextBytes).toBe(0)
    expect(db.loadPost('100')).toBeNull()
    expect(db.loadPost('101')).toBeNull()
    expect(db.loadPost('999')).toBeNull()
    expect(db.findPostThread('101')).toMatchObject({ threadId: '100', pages: { all: null, po: null } })
    expect(db.loadSubscriptionObservationById(observation().id)).toEqual(observation())
    expect(db.loadSubscriptionOperations()).toEqual([operation()])
  })
})

describe('schema v14: thread favourites and read state removed', () => {
  const removed = ['favorites', 'post_reads', 'thread_attention']
  const kept = ['thread_reading', 'reading_positions', 'thread_visits', 'reading_observations', 'post_threads',
    'local_blocks', 'drafts', 'draft_attachments', 'publication_attempts', 'settings', 'credentials', 'subscription_operations',
    'offline_copies', 'workspace']

  /** A v13 database with favourites, read records, attention starts and reminder observation data. */
  function v13(): string {
    const path = predecessor('reminders-v9')
    openReadingDatabase(path, MIGRATIONS.filter((migration) => migration.version <= 13)).close()
    const raw = new Database(path)
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(13)
      raw.prepare("INSERT INTO local_blocks VALUES ('cookie', 'blocked-id', ?)").run(at)
      expect(raw.prepare('SELECT count(*) AS n FROM favorites').get()).toEqual({ n: 1 })
      expect(raw.prepare('SELECT count(*) AS n FROM post_reads').get()).toEqual({ n: 1 })
      expect(raw.prepare('SELECT count(*) AS n FROM thread_attention').get()).toEqual({ n: 1 })
    } finally { raw.close() }
    return path
  }
  function snapshot(path: string) {
    const raw = new Database(path, { readonly: true })
    try {
      const tables = new Set((raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name))
      // Later versions add columns (credentials.cookie_id in v15) or drop them (drafts.email in v18); compare the columns kept throughout.
      const query = (table: string) => table === 'credentials' ? 'SELECT id, name, source, imported_at, ciphertext, position FROM credentials' : keptColumns(table)
      const rows = Object.fromEntries(kept.map((table) => [table, (raw.prepare(query(table)).all() as object[]).map((row) => JSON.stringify(row)).sort()]))
      return { version: raw.pragma('user_version', { simple: true }), tables, rows }
    } finally { raw.close() }
  }

  it('drops only the removed tables and keeps positions, history, reminders, blocks, drafts and observations', () => {
    const path = v13()
    const before = snapshot(path)
    const db = open(path)
    expect(db.status).toEqual({ state: 'ready', schemaVersion: supportedVersion })
    const after = snapshot(path)
    expect(after.version).toBe(supportedVersion)
    for (const table of removed) expect(after.tables.has(table)).toBe(false)
    expect(after.rows).toEqual(before.rows)
    expect(before.rows.reading_observations?.length).toBeGreaterThan(0)
    expect(db.getReadingState('100')).toMatchObject({ mode: 'po', positions: { all: { anchor: { postId: '101', offsetRatio: 0.4 } }, po: null } })
    expect(db.listHistory().map((entry) => entry.threadId)).toEqual(['100'])
    expect(db.listBlocks()).toEqual([{ kind: 'cookie', value: 'blocked-id', createdAt: at }])
    expect(db.listDrafts()[0]?.fields.content).toBe('未发送草稿')
  })

  it('leaves the v13 file byte-for-byte unchanged when the v14 migration fails', () => {
    const path = v13()
    const original = readFileSync(path)
    const failing = openReadingDatabase(path, [...MIGRATIONS.filter((migration) => migration.version <= 13), { version: 14, up(connection) {
      MIGRATIONS.find((migration) => migration.version === 14)!.up(connection)
      throw new Error('injected failure after dropping the tables')
    } }])
    connections.push(failing)
    expect(failing.status).toEqual({ state: 'unavailable', reason: 'migration-failed' })
    failing.close()
    expect(readFileSync(path)).toEqual(original)
    const unchanged = snapshot(path)
    expect(unchanged.version).toBe(13)
    for (const table of removed) expect(unchanged.tables.has(table)).toBe(true)
    expect(open(path).status).toEqual({ state: 'ready', schemaVersion: supportedVersion })
  })
})

describe('schema v15: 饼干 IDs replace the own-post record', () => {
  const kept = ['thread_reading', 'reading_positions', 'thread_visits', 'reading_observations', 'post_threads',
    'local_blocks', 'drafts', 'draft_attachments', 'publication_attempts', 'publication_settings', 'thread_post_identities',
    'identity_roles', 'settings', 'subscription_operations', 'offline_copies', 'workspace']

  /** A v14 database with an own-post record, a confirmed send and quote re-check markers. */
  function v14(): string {
    const path = predecessor('reminders-v9')
    openReadingDatabase(path, MIGRATIONS.filter((migration) => migration.version <= 14)).close()
    const raw = new Database(path)
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(14)
      const payload = { draftId: null, target: { kind: 'thread', forumId: '4' }, credentialId: '7',
        fields: { content: '已确认的发送', title: '', name: '', email: '', watermark: false }, attachmentId: null }
      raw.prepare(`INSERT INTO publication_attempts(request_id, editor_id, payload_json, credential_id, forum_id, state,
        created_at, updated_at, post_id, thread_id, launch_notice) VALUES ('confirmed-send', 'editor', ?, 7, '4', 'confirmed', ?, ?, '700', '700', 0)`)
        .run(JSON.stringify(payload), at, later)
      raw.prepare("INSERT INTO own_posts VALUES ('700', '700', 1, 7, 'submission-readback', ?)").run(later)
      raw.prepare(`INSERT INTO reminder_coverage(thread_id, mode, state, issues_json, quote_own_revision)
        VALUES ('100', 'all', 'done', '[]', '[{"post_id":"700"}]'), ('100', 'po', 'done', '[]', NULL)`).run()
    } finally { raw.close() }
    return path
  }
  function snapshot(path: string) {
    const raw = new Database(path, { readonly: true })
    try {
      const tables = new Set((raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name))
      const rows = Object.fromEntries(kept.map((table) => [table, (raw.prepare(keptColumns(table)).all() as object[]).map((row) => JSON.stringify(row)).sort()]))
      return { version: raw.pragma('user_version', { simple: true }), tables, rows }
    } finally { raw.close() }
  }

  it('keeps earlier cookies usable with an unknown 饼干 ID, drops own_posts and keeps send results and ID confirmations', () => {
    const path = v14()
    const before = snapshot(path)
    const db = open(path)
    expect(db.status).toEqual({ state: 'ready', schemaVersion: supportedVersion })
    const after = snapshot(path)
    expect(after.tables.has('own_posts')).toBe(false)
    expect(after.rows).toEqual(before.rows)
    expect(db.listCredentials()).toEqual([{ id: '7', name: '旧同步饼干', cookieId: null, source: 'raw', importedAt: at }])
    expect(db.loadCredentialCiphertext('7')).toEqual(ciphertext)
    expect(db.loadRoleSelections()['web-sync']).toEqual({ state: 'selected', credentialId: '7' })
    expect(db.reminderCookieIds()).toEqual([])
    expect(db.listPublications().find((item) => item.requestId === 'confirmed-send')).toMatchObject({ state: 'confirmed', postId: '700', threadId: '700' })
    expect(db.fillCredentialCookieId('7', 'Filled1')).toBe(true)
    expect(db.fillCredentialCookieId('7', 'Other22')).toBe(false)
    expect(db.listCredentials()[0]).toMatchObject({ name: '旧同步饼干', cookieId: 'Filled1' })
  })

  it('leaves the v14 file byte-for-byte unchanged when the v15 migration fails', () => {
    const path = v14()
    const original = readFileSync(path)
    const failing = openReadingDatabase(path, [...MIGRATIONS.filter((migration) => migration.version <= 14), { version: 15, up(connection) {
      MIGRATIONS.find((migration) => migration.version === 15)!.up(connection)
      throw new Error('injected failure after the v15 changes')
    } }])
    connections.push(failing)
    expect(failing.status).toEqual({ state: 'unavailable', reason: 'migration-failed' })
    failing.close()
    expect(readFileSync(path)).toEqual(original)
    const unchanged = snapshot(path)
    expect(unchanged.version).toBe(14)
    expect(unchanged.tables.has('own_posts')).toBe(true)
    expect(open(path).status).toEqual({ state: 'ready', schemaVersion: supportedVersion })
  })
})

describe('schema v16: reminders count reply growth from a baseline', () => {
  const kept = ['thread_reading', 'reading_positions', 'thread_visits', 'reading_observations', 'post_threads', 'local_blocks',
    'drafts', 'draft_attachments', 'publication_attempts', 'publication_settings', 'thread_post_identities', 'identity_roles',
    'settings', 'credentials', 'subscription_operations', 'offline_copies', 'workspace']
  const dropped = ['reminder_events', 'reminder_notifications', 'reminder_rounds', 'reminder_coverage', 'end_observations']

  /** A v15 database with enabled and closed rules and old per-event, coverage, round and notification records. */
  function v15(): string {
    const path = predecessor('reminders-v9')
    openReadingDatabase(path, MIGRATIONS.filter((migration) => migration.version <= 15)).close()
    const raw = new Database(path)
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(15)
      raw.prepare("INSERT INTO reminder_rules VALUES ('100', 'quote', 0, 2, ?, NULL, 'unsubscribe', ?), ('200', 'po', 1, 5, ?, '201', NULL, ?)")
        .run(at, later, later, later)
      raw.prepare(`INSERT INTO reminder_coverage(thread_id, mode, checkpoint_json, state, issues_json, quote_cookie_revision)
        VALUES ('100', 'all', '{"page":1,"pageIds":["101"],"prevIds":[],"complete":true}', 'done', '["gaps"]', '[]')`).run()
      raw.prepare("INSERT INTO end_observations VALUES ('100', ?, '101')").run(later)
      for (const table of ['reminder_events', 'reminder_notifications', 'reminder_rounds']) {
        expect(raw.prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: 1 })
      }
    } finally { raw.close() }
    return path
  }
  function snapshot(path: string) {
    const raw = new Database(path, { readonly: true })
    try {
      const tables = new Set((raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name))
      const rows = Object.fromEntries(kept.map((table) => [table, (raw.prepare(keptColumns(table)).all() as object[]).map((row) => JSON.stringify(row)).sort()]))
      return { version: raw.pragma('user_version', { simple: true }), tables, rows }
    } finally { raw.close() }
  }

  it('keeps rules, enabled state and generations, clears all other reminder data, and the first check only sets baselines', async () => {
    const path = v15()
    const before = snapshot(path)
    const db = open(path)
    const after = snapshot(path)
    expect(after.rows).toEqual(before.rows)
    for (const table of dropped) expect(after.tables.has(table)).toBe(false)
    const raw = new Database(path, { readonly: true })
    try {
      expect(raw.prepare('SELECT thread_id, kind, enabled, generation, enabled_at, closed_by FROM reminder_rules ORDER BY thread_id, kind').all()).toEqual([
        { thread_id: '100', kind: 'all', enabled: 1, generation: 3, enabled_at: at, closed_by: null },
        { thread_id: '100', kind: 'quote', enabled: 0, generation: 2, enabled_at: at, closed_by: 'unsubscribe' },
        { thread_id: '200', kind: 'po', enabled: 1, generation: 5, enabled_at: later, closed_by: null }
      ])
      expect(raw.prepare('SELECT count(*) AS n FROM reminder_state').get()).toEqual({ n: 0 })
      expect(raw.prepare('SELECT count(*) AS n FROM reminder_checker').get()).toEqual({ n: 0 })
    } finally { raw.close() }

    const reads: string[] = []
    const service = createReminderService({ store: asStore(db), scheduler: createRequestScheduler({ backgroundSpacingMs: 0 }), notifier: { show: () => true },
      client: {
        async getThreadPage(threadId, mode, number) {
          reads.push(`${mode}:${threadId}:${number}`)
          return { threadId, mode, page: number, head: post(threadId), replies: [], replyCount: 40, skippedItems: 0, endCandidate: true }
        },
        async getRef() { throw new Error('no quote reads') }
      } })
    expect((await service.check()).accepted).toBe(true)
    await service.whenIdle()
    expect(reads).toEqual(['all:100:1', 'po:200:1'])
    const overview = await service.overview()
    expect(overview.ok && overview.overview.threads.map((row) => [row.threadId, row.counts])).toEqual([
      ['200', { all: 0, po: 0, quote: 0 }], ['100', { all: 0, po: 0, quote: 0 }]
    ])
  })

  it('leaves the v15 file byte-for-byte unchanged when the v16 migration fails', () => {
    const path = v15()
    const original = readFileSync(path)
    const failing = openReadingDatabase(path, [...MIGRATIONS.filter((migration) => migration.version <= 15), { version: 16, up(connection) {
      MIGRATIONS.find((migration) => migration.version === 16)!.up(connection)
      throw new Error('injected failure after the v16 changes')
    } }])
    connections.push(failing)
    expect(failing.status).toEqual({ state: 'unavailable', reason: 'migration-failed' })
    failing.close()
    expect(readFileSync(path)).toEqual(original)
    const unchanged = snapshot(path)
    expect(unchanged.version).toBe(15)
    for (const table of dropped) expect(unchanged.tables.has(table)).toBe(true)
    expect(open(path).status.state).toBe('ready')
  })
})

describe('reminder scheduling upgrade', () => {
  function v16() {
    const path = predecessor('reminders-v9')
    const db = openReadingDatabase(path, MIGRATIONS.filter((migration) => migration.version <= 16))
    db.setReminderRule('100', 'all', true, at)
    const rule = db.reminderRuleSnapshots().find((rule) => rule.threadId === '100' && rule.kind === 'all')!
    db.updateReminderState({ ...rule, at, baseline: 95, add: 3, firstPage: 5, checked: true })
    db.finishReminderCheck(at)
    db.close()
    return path
  }

  it('keeps reply baselines, counts and last check when adding durable backoff', () => {
    const db = open(v16())
    expect(db.reminderStates()).toContainEqual(expect.objectContaining({ threadId: '100', kind: 'all', baseline: 95 }))
    expect(db.reminderOverview()).toMatchObject({ lastCheckedAt: at, threads: [expect.objectContaining({ counts: { all: 3, po: 0, quote: 0 } })] })
    const limited = { minutes: 60, episodeId: 'episode', notified: true, dismissed: false }
    db.saveReminderBackoff(limited)
    db.finishReminderCheck(later)
    expect(db.loadReminderBackoff()).toEqual(limited)
    expect(db.reminderOverview().lastCheckedAt).toBe(later)
  })

  it('rolls back an interrupted checker upgrade without changing the v16 file', () => {
    const path = v16()
    const original = readFileSync(path)
    const db = openReadingDatabase(path, [...MIGRATIONS.filter((migration) => migration.version <= 16), { version: 17, up(connection) {
      MIGRATIONS.find((migration) => migration.version === 17)!.up(connection)
      throw new Error('injected checker upgrade failure')
    } }])
    expect(db.status).toEqual({ state: 'unavailable', reason: 'migration-failed' })
    db.close()
    expect(readFileSync(path)).toEqual(original)
    expect(open(path).reminderOverview().threads[0]?.counts.all).toBe(3)
  })
})

describe('schema v18: drafts drop the E-mail field', () => {
  /** A v17 database whose saved draft has a title, name, E-mail, identity and attached image. */
  function v17(): string {
    const path = predecessor('reminders-v9')
    openReadingDatabase(path, MIGRATIONS.filter((migration) => migration.version <= 17)).close()
    const raw = new Database(path)
    try {
      expect(raw.pragma('user_version', { simple: true })).toBe(17)
      raw.prepare("UPDATE drafts SET name = '旧名称', email = 'sage' WHERE id = 8").run()
    } finally { raw.close() }
    return path
  }
  function draftTable(path: string) {
    const raw = new Database(path, { readonly: true })
    try {
      const columns = (raw.prepare('PRAGMA table_info(drafts)').all() as { name: string }[]).map((column) => column.name)
      const kept = columns.filter((column) => column !== 'email').join(', ')
      return { columns, rows: raw.prepare(`SELECT ${kept} FROM drafts`).all(), attempts: raw.prepare(keptColumns('publication_attempts')).all() }
    } finally { raw.close() }
  }

  it('removes only the E-mail column and keeps every draft field, its identity, target and image', () => {
    const path = v17()
    const before = draftTable(path)
    expect(before.columns).toContain('email')
    const db = open(path)
    expect(db.status).toEqual({ state: 'ready', schemaVersion: supportedVersion })
    const after = draftTable(path)
    expect(after.columns).not.toContain('email')
    expect(after.columns).toEqual(before.columns.filter((column) => column !== 'email'))
    expect(after.rows).toEqual(before.rows)
    // Stored send payloads are not rewritten, even where they still name an E-mail.
    expect(after.attempts).toEqual(before.attempts)
    expect(db.listDrafts()).toEqual([expect.objectContaining({ id: '8', version: 3, target: { kind: 'reply', threadId: '100' }, credentialId: '7',
      fields: { content: '未发送草稿', title: '草稿标题', name: '旧名称', watermark: true },
      attachment: expect.objectContaining({ id: '4', fileName: 'old-copy.png', originalName: 'original.png' }) })])
    expect(db.saveDraft({ draftId: '8', target: { kind: 'reply', threadId: '100' }, credentialId: '7',
      fields: { content: '升级后改写', title: '草稿标题', name: '旧名称', watermark: true }, attachmentId: '4' }, later)).toMatchObject({ ok: true, draft: { version: 4 } })
  })

  it('leaves the v17 file byte-for-byte unchanged when the v18 migration fails', () => {
    const path = v17()
    const original = readFileSync(path)
    const failing = openReadingDatabase(path, [...MIGRATIONS.filter((migration) => migration.version <= 17), { version: 18, up(connection) {
      MIGRATIONS.find((migration) => migration.version === 18)!.up(connection)
      throw new Error('injected failure after dropping the column')
    } }])
    connections.push(failing)
    expect(failing.status).toEqual({ state: 'unavailable', reason: 'migration-failed' })
    failing.close()
    expect(readFileSync(path)).toEqual(original)
    expect(draftTable(path).columns).toContain('email')
    expect(open(path).listDrafts()[0]?.fields).toEqual({ content: '未发送草稿', title: '草稿标题', name: '旧名称', watermark: true })
  })
})

describe('schema v19: failed attempts may keep the forum’s error text', () => {
  function attempts(path: string) {
    const raw = new Database(path, { readonly: true })
    try { return raw.prepare('SELECT * FROM publication_attempts ORDER BY id').all() as Record<string, unknown>[] } finally { raw.close() }
  }

  it('adds an empty column and reads every recorded attempt as before, without forum text', () => {
    const path = predecessor('reminders-v9')
    const v18 = openReadingDatabase(path, MIGRATIONS.filter((migration) => migration.version <= 18))
    const before = v18.listPublications()
    v18.close()
    const rows = attempts(path)
    expect(rows.length).toBeGreaterThan(0)
    const db = open(path)
    expect(db.status).toEqual({ state: 'ready', schemaVersion: supportedVersion })
    expect(attempts(path)).toEqual(rows.map((row) => ({ ...row, forum_message: null })))
    expect(db.listPublications()).toEqual(before)
    expect(db.listPublications().every((attempt) => !('forumMessage' in attempt))).toBe(true)
  })

  it('leaves the v18 file byte-for-byte unchanged when the v19 migration fails', () => {
    const path = predecessor('reminders-v9')
    openReadingDatabase(path, MIGRATIONS.filter((migration) => migration.version <= 18)).close()
    const original = readFileSync(path)
    const failing = openReadingDatabase(path, [...MIGRATIONS.filter((migration) => migration.version <= 18), { version: 19, up(connection) {
      MIGRATIONS.find((migration) => migration.version === 19)!.up(connection)
      throw new Error('injected failure after adding the column')
    } }])
    connections.push(failing)
    expect(failing.status).toEqual({ state: 'unavailable', reason: 'migration-failed' })
    failing.close()
    expect(readFileSync(path)).toEqual(original)
    expect(Object.keys(attempts(path)[0]!)).not.toContain('forum_message')
    expect(open(path).status).toEqual({ state: 'ready', schemaVersion: supportedVersion })
  })
})
