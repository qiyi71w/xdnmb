import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/shared/settings'
import { readContainer, readContainerHeader } from '../src/main/personal-data/container'
import { unlockEncryption } from '../src/main/personal-data/encryption'
import { createImportService, type ImportDatabase } from '../src/main/personal-data/import'
import type { SecretProtector } from '../src/main/identity/protection'
import { preUpgradeBackupDirectory } from '../src/main/storage/backup'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { readSecretRows } from '../src/main/storage/export-snapshot'
import { beforeImportDirectory } from '../src/main/storage/import-journal'
import { checkStagedImport, readLocalAppendedBytes, readLocalCounts, stageImport } from '../src/main/storage/import-staging'
import { MIGRATIONS } from '../src/main/storage/migrations'
import { settleSwap } from '../src/main/storage/swap-journal'
import { parseWorkspace } from '../src/renderer/src/features/tabs/workspaceSnapshot'
import { draftIdentities } from './helpers/draft-identities'
import { testProtector } from './helpers/protector'

/*
 * The first released personal-data export format (ADR 0005): two files exported by the export
 * service at schema v29 from one synthetic source machine, without and with 饼干与 App UUID. They
 * hold at least one item of every 随文件覆盖, 目标机保留并追加 and 秘密 category of the data
 * classification (`src/main/storage/classification.ts`); the source machine's own items (window and
 * update settings, account session) were set too and must not arrive.
 *
 * Never regenerate them: they stand for files users already have. Each new migration must import
 * both into a new installation with the content below; when a migration deliberately reshapes some
 * of it, change only how this test reads it.
 */
const PLAIN = fileURLToPath(new URL('./fixtures/personal-data-v29.xidao', import.meta.url))
const ENCRYPTED = fileURLToPath(new URL('./fixtures/personal-data-v29-encrypted.xidao', import.meta.url))
const PASSPHRASE = '汐岛样本口令 sample passphrase'
const SUPPORTED = Math.max(...MIGRATIONS.map((migration) => migration.version))
const ORIGINAL_SHA = '0ea8cf70c424eef22ff085162e4812ece3d5b8017aaf19cd4c8b381cdbcc0087'
const ATTACHMENT_SHA = 'a74bcc3d77728e5d8b378a263040bb0220ad23fa53bcd5cc1adde0e8dd6c1da4'

const folders: string[] = []
const connections: Array<{ close(): void }> = []

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close()
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true })
})

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const inProcess: ImportDatabase = {
  check: async (staging, version) => checkStagedImport(staging, version),
  counts: async (path) => readLocalCounts(path),
  appendedBytes: async (path) => readLocalAppendedBytes(path),
  secrets: async (path) => readSecretRows(path),
  stage: async (staging, path, file) => stageImport(staging, path, file),
  abort: () => undefined
}

/** A new installation of the current version imports `sample`; returns it reopened after the restart. */
async function importedInto(sample: string, protector: SecretProtector, passphrase: string | null): Promise<{ userData: string; db: ReadingDatabase }> {
  const userData = mkdtempSync(join(tmpdir(), 'xidao-sample-'))
  folders.push(userData)
  mkdirSync(join(userData, 'images'))
  mkdirSync(join(userData, 'draft-images'))
  const databasePath = join(userData, 'xidao.sqlite')
  const running = openReadingDatabase(databasePath, MIGRATIONS, { appVersion: 'current' })
  const service = createImportService({
    databasePath,
    supportedVersion: SUPPORTED,
    status: () => running.status,
    database: inProcess,
    protector,
    restart: async () => 'exiting'
  })
  let inspection = await service.inspect(async () => sample)
  if (passphrase !== null) {
    expect(inspection).toEqual({ status: 'passphrase', wrong: false })
    inspection = await service.submitPassphrase(passphrase)
  }
  expect(inspection).toMatchObject({
    status: 'ready',
    summary: { appVersion: '1.5.0', offlineThreads: 1, secrets: passphrase !== null, local: { history: 0, sendRecords: 0 } }
  })
  expect(await service.confirm()).toEqual({ status: 'restarting' })
  running.close()
  expect(settleSwap(databasePath)).toEqual({ kind: 'import', outcome: 'completed' })
  const db = openReadingDatabase(databasePath, MIGRATIONS, { appVersion: 'current' })
  connections.push(db)
  expect(db.status).toEqual({ state: 'ready', schemaVersion: SUPPORTED })
  // Imported data is at the current schema already: no pre-upgrade backup is taken for it.
  expect(existsSync(preUpgradeBackupDirectory(userData))).toBe(false)
  expect(existsSync(beforeImportDirectory(userData))).toBe(true)
  return { userData, db }
}

/** Content of every category the samples carry, the same with or without secrets. */
function expectSampleContent(userData: string, db: ReadingDatabase): void {
  const sql = new Database(join(userData, 'xidao.sqlite'), { readonly: true })
  connections.push(sql)
  const rows = (table: string): number => sql.prepare(`SELECT count(*) FROM "${table}"`).pluck().get() as number

  // 浏览历史、阅读模式与位置、阅读观察
  expect(sql.prepare('SELECT thread_id, visit_count FROM thread_visits').all()).toEqual([{ thread_id: '50000100', visit_count: 1 }])
  const reading = db.getReadingState('50000100')
  expect(reading.mode).toBe('po')
  expect(reading.positions.all).toMatchObject({ anchor: { postId: '50000101', page: 1, offsetRatio: 0.5, viewportOffset: 120 } })
  expect(db.findPostThread('50000101')).toMatchObject({ threadId: '50000100' })
  expect(rows('reading_observations')).toBeGreaterThan(0)
  // 发送记录及 PO 提示开关
  expect(db.listPublications().map((attempt) => [attempt.state, attempt.postId, attempt.threadId])).toEqual([['confirmed', '50000102', '50000100']])
  expect(db.getPoWarningEnabled()).toBe(false)
  // 屏蔽；饼干标色及自动标色记录
  expect(db.listBlocks().map((block) => [block.kind, block.value]).sort()).toEqual([['cookie', 'BLOCKED'], ['post', '50000999']])
  expect(db.listCookieColors().map((entry) => [entry.cookieId, entry.color])).toEqual([['SMPL001', 'blue'], ['SMPL002', 'violet']])
  expect(sql.prepare('SELECT cookie_id FROM cookie_color_auto ORDER BY cookie_id').pluck().all()).toEqual(['SMPL001', 'SMPL002'])
  // 提醒规则、基线状态与区段、本机回复归属、回复数观察 (the checker itself starts over)
  expect(db.getReminderRules(['50000100'])).toMatchObject([{ threadId: '50000100', rules: { all: { enabled: true }, quote: { enabled: true }, po: { enabled: false } } }])
  expect(sql.prepare("SELECT baseline, count FROM reminder_state WHERE thread_id = '50000100' AND kind = 'all'").get()).toEqual({ baseline: 2, count: 1 })
  expect(rows('reminder_baseline_segments')).toBe(1)
  expect(rows('reminder_local_replies')).toBeGreaterThan(0)
  expect(rows('reminder_count_observations')).toBeGreaterThan(0)
  expect(rows('reminder_checker')).toBe(0)
  // 订阅观察与操作
  expect(db.loadSubscriptionObservationById('sample-observation')).toMatchObject({ source: 'app', nextPage: null })
  expect(db.loadSubscriptionOperations()).toMatchObject([{ id: 'sample-operation', threadId: '50000100', report: 'success' }])
  // 工作区；X 岛公告状态
  expect(parseWorkspace(db.loadWorkspace() ?? '')).not.toBeNull()
  expect(db.loadAnnouncements()).toEqual({
    latest: { date: '2026-11-16', content: '样本公告', enable: true, fetchedAt: '2026-11-16T08:00:00.000Z' },
    suppressed: { date: '2026-11-16', content: '样本公告' }
  })
  // 设置: the file's, except this machine's own (a new installation's defaults here).
  expect(db.loadSettings()).toMatchObject({ colorScheme: 'dark', density: 'compact', reminderInterval: 30, imageMaskEnabled: true,
    closeAction: DEFAULT_SETTINGS.closeAction, listWidth: DEFAULT_SETTINGS.listWidth })
  expect(db.loadAccountSession()).toBeNull()

  // 离线副本 with its page, posts and original.
  expect(sql.prepare('SELECT thread_id, state FROM offline_copies').all()).toEqual([{ thread_id: '50000200', state: 'stopped' }])
  expect(db.loadThreadPage('50000200', 'all', 1)?.value).toMatchObject({ head: { plainText: '离线样本主帖' }, replies: [{ id: '50000201', plainText: '离线样本回复' }] })
  const original = sql.prepare<[], { name: string; bytes: number }>(`SELECT r.file_name AS name, r.bytes FROM offline_images o
    JOIN image_resources r ON r.id = o.resource_id WHERE o.thread_id = '50000200' AND o.post_id = '50000201'`).get()!
  expect(sha(join(userData, 'images', original.name))).toBe(ORIGINAL_SHA)
  // 草稿与草稿附图
  const attachment = sql.prepare<[], { name: string; content: string }>(`SELECT a.file_name AS name, d.content FROM drafts d
    JOIN draft_attachments a ON a.id = d.attachment_id`).get()!
  expect(attachment.content).toBe('样本草稿，带附图')
  expect(sha(join(userData, 'draft-images', attachment.name))).toBe(ATTACHMENT_SHA)
  expect(db.listDrafts().map((draft) => [draft.target, draft.fields])).toEqual(expect.arrayContaining([
    [{ kind: 'reply', threadId: '50000100' }, { content: '样本草稿，带附图', title: '', name: '', watermark: true }],
    [{ kind: 'thread', forumId: '4' }, { content: '样本新串草稿', title: '样本标题', name: '样本名称', watermark: false }]
  ]))
}

describe('first-version export samples', () => {
  it('were written at schema v29 in container format 1, without and with 饼干与 App UUID', async () => {
    const plain = await readContainer(PLAIN)
    expect(plain.header).toEqual({ encryption: null })
    expect(plain.manifest).toMatchObject({ containerVersion: 1, schemaVersion: 29, appVersion: '1.5.0', credentialSequence: 2,
      includes: { offlineCopies: true, secrets: false }, stats: { history: 1, sendRecords: 1, offlineThreads: 1 } })
    const header = await readContainerHeader(ENCRYPTED)
    expect(header.encryption).toMatchObject({ cipher: 'aes-256-gcm', kdf: { name: 'scrypt' } })
    const keys = await unlockEncryption(PASSPHRASE, header.encryption!)
    expect(keys).not.toBeNull()
    const encrypted = await readContainer(ENCRYPTED, { contentKey: keys!.content })
    expect(encrypted.manifest).toMatchObject({ containerVersion: 1, schemaVersion: 29, credentialSequence: 2,
      includes: { offlineCopies: true, secrets: true }, stats: { history: 1, sendRecords: 1, offlineThreads: 1 } })
  }, 60_000)

  it('the file without secrets imports with its content; its 饼干 references show as removed', async () => {
    const protector = testProtector()
    const { userData, db } = await importedInto(PLAIN, protector, null)
    expectSampleContent(userData, db)
    expect(db.listCredentials()).toEqual([])
    expect(db.listSubscriptionAppCredentials()).toEqual([])
    expect(db.loadRoleSelections()).toMatchObject({ 'default-post': { state: 'missing' }, 'web-sync': { state: 'missing' } })
    expect(db.getThreadPostIdentity('50000100')).toMatchObject({ state: 'missing' })
    expect(db.loadSubscriptionConfiguration().context.appCredentialId).toBeNull()
    expect((await draftIdentities(db, join(userData, 'draft-images'), protector)).map(([, status]) => status.state)).toEqual(['missing', 'missing'])
  }, 60_000)

  it('the encrypted file imports with its content, its 饼干 and App UUID protected by this machine', async () => {
    const protector = testProtector()
    const { userData, db } = await importedInto(ENCRYPTED, protector, PASSPHRASE)
    expectSampleContent(userData, db)
    expect(db.listCredentials().map((credential) => [credential.id, credential.name, credential.cookieId]))
      .toEqual([['1', '样本饼干一', 'SMPL001'], ['2', '样本饼干二', 'SMPL002']])
    expect(await Promise.all(db.loadCredentialCiphertexts().map((entry) => protector.decrypt(entry.ciphertext))))
      .toEqual(['SAMPLE-USERHASH-ONE-0123456789abcdef', 'SAMPLE-USERHASH-TWO-0123456789abcdef'])
    expect(db.loadRoleSelections()).toMatchObject({ 'default-post': { state: 'selected', credentialId: '1' }, 'web-sync': { state: 'selected', credentialId: '2' } })
    expect(db.getThreadPostIdentity('50000100')).toEqual({ state: 'selected', credentialId: '2' })
    expect(db.loadSubscriptionConfiguration().context.appCredentialId).toBe('sample-app-uuid')
    expect(await protector.decrypt(db.loadSubscriptionAppCiphertext('sample-app-uuid')!)).toBe('SAMPLE-APP-UUID-0123')
    expect(Object.fromEntries(await draftIdentities(db, join(userData, 'draft-images'), protector))).toEqual({
      '样本新串草稿': { state: 'selected', credentialId: '2', name: '样本饼干二' },
      '样本草稿，带附图': { state: 'selected', credentialId: '1', name: '样本饼干一' }
    })
  }, 60_000)
})
