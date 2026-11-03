import Database from 'better-sqlite3'
import { constants, copyFileSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { RestoreInfo } from '../../shared/api'
import { BACKUP_DATABASE, BACKUP_DRAFT_IMAGES, preUpgradeBackupDirectory, readPreUpgradeBackup, type PreUpgradeManifest } from './backup'
import type { RestorePreparation } from './contract'
import { discardRestoreJournal, restoreStagingDirectory, writeRestoreJournal } from './restore-journal'
import { syncFile } from './durable'

/*
 * 恢复升级前备份, the part in the run that shows a newer version's data read-only: whether the
 * pre-upgrade backup can be restored, and staging it for the next start (`./restore-journal`).
 *
 * Secrets removed after the upgrade must not come back. The backup's copy keeps only the 饼干凭据
 * and App UUIDs whose key still exists in the current database, and the 官网账号会话 only while the
 * current database has one. Later versions keep these three tables' names and key columns; when the
 * current database's tables are not understood, every row of all three is removed instead. Nothing
 * is decrypted, and the current database is only read.
 */

/** The current (newer) database, open read-only, and what this app supports. */
export interface RestoreSource {
  current: Database.Database
  databasePath: string
  supportedVersion: number
}

/** The keys of the current database's secrets; null when its secret tables are not understood. */
interface SecretKeys {
  credentials: number[]
  appCredentials: string[]
  session: boolean
}

/** The pre-upgrade backup when it is valid and this app's migrations know its schema version. */
function restorableBackup(source: RestoreSource): PreUpgradeManifest | null {
  const manifest = readPreUpgradeBackup(dirname(source.databasePath))
  return manifest !== null && manifest.schemaVersion <= source.supportedVersion ? manifest : null
}

/** `table` exists and `column` is its whole primary key. */
function keyedBy(db: Database.Database, table: string, column: string): boolean {
  const keys = db.prepare<[string], { name: string }>('SELECT name FROM pragma_table_info(?) WHERE pk > 0').all(table)
  return keys.length === 1 && keys[0]?.name === column
}

function readSecretKeys(db: Database.Database): SecretKeys | null {
  try {
    if (!keyedBy(db, 'credentials', 'id') || !keyedBy(db, 'subscription_app_credentials', 'id')) return null
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'account_session'").get() === undefined) return null
    const credentials = db.prepare('SELECT id FROM credentials').pluck().all() as unknown[]
    const appCredentials = db.prepare('SELECT id FROM subscription_app_credentials').pluck().all() as unknown[]
    if (!credentials.every((id) => Number.isSafeInteger(id)) || !appCredentials.every((id) => typeof id === 'string')) return null
    const session = db.prepare('SELECT EXISTS (SELECT 1 FROM account_session)').pluck().get() === 1
    return { credentials: credentials as number[], appCredentials: appCredentials as string[], session }
  } catch {
    return null
  }
}

/** 读取恢复信息: no path and no secret, only what the confirmation shows. */
export function restoreInfo(source: RestoreSource | null): RestoreInfo {
  if (source === null) return { restorable: false }
  const manifest = restorableBackup(source)
  if (manifest === null) return { restorable: false }
  return {
    restorable: true,
    backupCompletedAt: manifest.completedAt,
    sourceVersion: manifest.appVersion,
    secretsReadable: readSecretKeys(source.current) !== null
  }
}

/**
 * Removes from the staged copy the secrets the current database no longer has (all of them with
 * `keys` null). A removed 饼干凭据 keeps its references, as an ordinary removal does (shown as
 * 已移除). When the App UUID the subscription configuration uses is removed, the configuration is
 * 未配置 under a new generation, so earlier observations, operations and plans stay history and are
 * never carried on under it.
 */
function filterSecrets(path: string, keys: SecretKeys | null, schemaVersion: number): void {
  const db = new Database(path, { fileMustExist: true })
  try {
    if (Number(db.pragma('user_version', { simple: true })) !== schemaVersion) throw new Error('staged database changed')
    db.transaction(() => {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[])
      if (tables.has('credentials')) {
        db.prepare('DELETE FROM credentials WHERE id NOT IN (SELECT value FROM json_each(?))').run(JSON.stringify(keys?.credentials ?? []))
      }
      if (tables.has('subscription_app_credentials')) {
        db.prepare('DELETE FROM subscription_app_credentials WHERE id NOT IN (SELECT value FROM json_each(?))')
          .run(JSON.stringify(keys?.appCredentials ?? []))
        if (tables.has('subscription_configuration')) {
          db.exec(`UPDATE subscription_configuration SET app_credential_id = NULL, generation = generation + 1
            WHERE app_credential_id IS NOT NULL AND app_credential_id NOT IN (SELECT id FROM subscription_app_credentials)`)
        }
      }
      if (tables.has('account_session') && keys?.session !== true) db.exec('DELETE FROM account_session')
    }).immediate()
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('staged database failed verification')
  } finally {
    db.close()
  }
}

/**
 * Stages the restore and writes the journal the next start carries out. `prepared`: the app may now
 * restart. `not-applicable`: the data is not a newer version's, or there is no restorable backup.
 * `failed`: nothing was staged and no journal is left; the current data and files are unchanged.
 */
export function prepareRestore(source: RestoreSource | null): RestorePreparation {
  if (source === null) return 'not-applicable'
  const manifest = restorableBackup(source)
  if (manifest === null) return 'not-applicable'
  const keys = readSecretKeys(source.current)
  const userData = dirname(source.databasePath)
  const backup = preUpgradeBackupDirectory(userData)
  const staging = restoreStagingDirectory(userData)
  try {
    discardRestoreJournal(userData)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(join(staging, BACKUP_DRAFT_IMAGES), { recursive: true })
    for (const image of manifest.draftImages) {
      const copy = join(staging, BACKUP_DRAFT_IMAGES, image.name)
      copyFileSync(join(backup, BACKUP_DRAFT_IMAGES, image.name), copy, constants.COPYFILE_EXCL)
      syncFile(copy)
      if (lstatSync(copy).size !== image.size) throw new Error('staged draft image incomplete')
    }
    const database = join(staging, basename(source.databasePath))
    copyFileSync(join(backup, BACKUP_DATABASE), database, constants.COPYFILE_EXCL)
    filterSecrets(database, keys, manifest.schemaVersion)
    syncFile(database)
    // Staged entries the system had not flushed by a crash only make the next start abandon.
    writeRestoreJournal(userData, { format: 1, phase: 'prepared', databaseSize: lstatSync(database).size, draftImages: manifest.draftImages })
    return 'prepared'
  } catch {
    try {
      discardRestoreJournal(userData)
      rmSync(staging, { recursive: true, force: true })
    } catch {
      // Without a journal, the next start removes the staged copy.
    }
    return 'failed'
  }
}
