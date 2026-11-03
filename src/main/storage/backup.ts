import Database from 'better-sqlite3'
import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync
} from 'node:fs'
import { rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isRecord } from '../../shared/theme'
import { isManagedName } from '../images/files'
import { copyFileDurably, syncDirectory, syncFile } from './durable'

/*
 * Pre-upgrade backup. Before a migration changes an existing database, the database as it is (a
 * consistent snapshot, committed WAL content included) and every managed draft attachment copy are
 * saved under the user data directory. The image cache (`images/`) is not: a missing cached image
 * is downloaded again. Only the latest backup is kept, and a new one replaces it only once it is
 * completely written and verified, so an interrupted or failed backup never leaves a half backup
 * that looks usable, and the previous one stays valid.
 *
 * Layout under the user data directory (the directory names appear in the public docs):
 *
 *   backups/pre-upgrade/manifest.json   PreUpgradeManifest (JSON)
 *   backups/pre-upgrade/xidao.sqlite    the database before the upgrade, one file (rollback journal)
 *   backups/pre-upgrade/draft-images/   copies of every managed file of `draft-images/`
 *   upgrade-without-backup.json         不备份升级 for the next start: { "schemaVersion": n }
 *
 * Work in progress lives in `backups/pre-upgrade.partial/`; the previous backup is moved to
 * `backups/pre-upgrade.replaced/` only for the instant of the swap.
 */

const BACKUPS = 'backups'
const PRE_UPGRADE = 'pre-upgrade'
const PARTIAL = 'pre-upgrade.partial'
const REPLACED = 'pre-upgrade.replaced'
const DRAFT_IMAGES = 'draft-images'
const UPGRADE_WITHOUT_BACKUP = 'upgrade-without-backup.json'

/** File names inside a backup directory. */
export const BACKUP_MANIFEST = 'manifest.json'
export const BACKUP_DATABASE = 'xidao.sqlite'
export const BACKUP_DRAFT_IMAGES = 'draft-images'
export const BACKUP_FORMAT = 1

/** Far beyond any real manifest (one short entry per draft attachment). */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_APP_VERSION_LENGTH = 64

export interface PreUpgradeManifest {
  format: typeof BACKUP_FORMAT
  /** Schema version (`user_version`) of the backed-up database. */
  schemaVersion: number
  /** Version of the app that took the backup and then upgraded the database. */
  appVersion: string
  /** When the backup was complete (ISO 8601, UTC). */
  completedAt: string
  /** Every copied draft attachment file, by managed name, with its size in bytes. */
  draftImages: { name: string; size: number }[]
}

/** `backups/pre-upgrade/` of the user data directory (the directory holding the database). */
export function preUpgradeBackupDirectory(userDataDirectory: string): string {
  return join(userDataDirectory, BACKUPS, PRE_UPGRADE)
}

function parseManifest(text: string): PreUpgradeManifest | null {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) return null
  const { format, schemaVersion, appVersion, completedAt, draftImages } = value
  if (format !== BACKUP_FORMAT) return null
  if (typeof schemaVersion !== 'number' || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) return null
  if (typeof appVersion !== 'string' || appVersion.length === 0 || appVersion.length > MAX_APP_VERSION_LENGTH) return null
  if (typeof completedAt !== 'string') return null
  const completed = new Date(completedAt)
  if (Number.isNaN(completed.getTime()) || completed.toISOString() !== completedAt) return null
  if (!Array.isArray(draftImages)) return null
  const names = new Set<string>()
  const images: PreUpgradeManifest['draftImages'] = []
  for (const entry of draftImages) {
    if (!isRecord(entry)) return null
    const { name, size } = entry
    if (typeof name !== 'string' || !isManagedName(name) || names.has(name)) return null
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null
    names.add(name)
    images.push({ name, size })
  }
  return { format, schemaVersion, appVersion, completedAt, draftImages: images }
}

/**
 * The "valid backup" check: the manifest is well formed, every listed draft attachment copy is
 * present with its size, and the database copy passes SQLite's integrity check at the manifest's
 * schema version. Returns the manifest, or null for anything else (missing, partial, corrupt).
 * Only reads: the copy is opened read-only. Whether this app can restore that schema version is
 * the caller's decision.
 */
export function verifyPreUpgradeBackup(directory: string): PreUpgradeManifest | null {
  try {
    const manifestPath = join(directory, BACKUP_MANIFEST)
    const manifestStat = lstatSync(manifestPath)
    if (!manifestStat.isFile() || manifestStat.size > MAX_MANIFEST_BYTES) return null
    const manifest = parseManifest(readFileSync(manifestPath, 'utf8'))
    if (manifest === null) return null
    for (const image of manifest.draftImages) {
      const stat = lstatSync(join(directory, BACKUP_DRAFT_IMAGES, image.name))
      if (!stat.isFile() || stat.size !== image.size) return null
    }
    const databasePath = join(directory, BACKUP_DATABASE)
    if (!lstatSync(databasePath).isFile()) return null
    const db = new Database(databasePath, { readonly: true, fileMustExist: true })
    try {
      if (Number(db.pragma('user_version', { simple: true })) !== manifest.schemaVersion) return null
      if (db.pragma('integrity_check', { simple: true }) !== 'ok') return null
    } finally {
      db.close()
    }
    return manifest
  } catch {
    return null
  }
}

/**
 * The current pre-upgrade backup if it is valid (see `verifyPreUpgradeBackup`), else null. A swap
 * interrupted after the previous backup was moved aside is finished first: that backup is then still
 * the latest one.
 */
export function readPreUpgradeBackup(userDataDirectory: string): PreUpgradeManifest | null {
  try {
    settleInterruptedSwap(join(userDataDirectory, BACKUPS))
  } catch {
    // Verified below as it is.
  }
  return verifyPreUpgradeBackup(preUpgradeBackupDirectory(userDataDirectory))
}

function settleInterruptedSwap(backups: string): void {
  const current = join(backups, PRE_UPGRADE)
  const replaced = join(backups, REPLACED)
  if (!existsSync(current) && existsSync(replaced)) renameSync(replaced, current)
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    // A leftover is removed before the next backup.
  }
}

/** Copies the regular managed files of `source` (symbolic links are never followed). */
function copyDraftImages(source: string, target: string): PreUpgradeManifest['draftImages'] {
  let names: string[]
  try {
    names = readdirSync(source)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const copied: PreUpgradeManifest['draftImages'] = []
  for (const name of names.sort()) {
    if (!isManagedName(name)) continue
    const from = join(source, name)
    const stat = lstatSync(from)
    if (!stat.isFile()) continue
    const to = join(target, name)
    copyFileDurably(from, to)
    copied.push({ name, size: stat.size })
  }
  return copied
}

/**
 * Saves the pre-upgrade backup of the database `source` is connected to, replacing the previous
 * backup only after the new one is verified. Throws when it could not be saved; the previous backup
 * is then unchanged and nothing partial is left that could pass as a backup. `source` is only read
 * (`VACUUM INTO` writes the snapshot elsewhere), so a read-only connection may be used.
 */
export function writePreUpgradeBackup(input: {
  source: Database.Database
  userDataDirectory: string
  schemaVersion: number
  appVersion: string
  now: () => Date
}): PreUpgradeManifest {
  const backups = join(input.userDataDirectory, BACKUPS)
  const partial = join(backups, PARTIAL)
  const current = join(backups, PRE_UPGRADE)
  const replaced = join(backups, REPLACED)
  mkdirSync(backups, { recursive: true })
  settleInterruptedSwap(backups)
  rmSync(partial, { recursive: true, force: true })
  rmSync(replaced, { recursive: true, force: true })
  let manifest: PreUpgradeManifest
  try {
    mkdirSync(join(partial, BACKUP_DRAFT_IMAGES), { recursive: true })
    const databasePath = join(partial, BACKUP_DATABASE)
    input.source.prepare('VACUUM INTO ?').run(databasePath)
    syncFile(databasePath)
    const draftImages = copyDraftImages(join(input.userDataDirectory, DRAFT_IMAGES), join(partial, BACKUP_DRAFT_IMAGES))
    manifest = {
      format: BACKUP_FORMAT,
      schemaVersion: input.schemaVersion,
      appVersion: input.appVersion,
      completedAt: input.now().toISOString(),
      draftImages
    }
    const manifestPath = join(partial, BACKUP_MANIFEST)
    writeFileSync(manifestPath, JSON.stringify(manifest), { flag: 'wx' })
    syncFile(manifestPath)
    syncDirectory(join(partial, BACKUP_DRAFT_IMAGES))
    syncDirectory(partial)
    if (verifyPreUpgradeBackup(partial)?.schemaVersion !== input.schemaVersion) throw new Error('pre-upgrade backup failed verification')
  } catch (error) {
    removeQuietly(partial)
    throw error
  }

  // The swap: until `partial` takes its place, `current` (or, once moved aside, `replaced`) is the
  // previous backup, which `settleInterruptedSwap` restores after an interruption.
  const hadPrevious = existsSync(current)
  try {
    if (hadPrevious) renameSync(current, replaced)
    renameSync(partial, current)
  } catch (error) {
    try {
      settleInterruptedSwap(backups)
    } catch {
      // Restored by the next backup or read.
    }
    removeQuietly(partial)
    throw error
  }
  syncDirectory(backups)
  if (hadPrevious) removeQuietly(replaced)
  return manifest
}

/**
 * Records 不备份升级: the next start upgrades a database at `schemaVersion` without a backup. The
 * choice is replaced atomically, so a start never reads half of it.
 */
export async function markUpgradeWithoutBackup(userDataDirectory: string, schemaVersion: number): Promise<void> {
  const path = join(userDataDirectory, UPGRADE_WITHOUT_BACKUP)
  const partial = `${path}.partial`
  await writeFile(partial, JSON.stringify({ schemaVersion }), { flush: true })
  await rename(partial, path)
}

/**
 * Takes the 不备份升级 choice: it is removed by the first start that looks for it, whatever happens
 * next (upgrade, failed migration, or nothing to upgrade), so it never applies to a later upgrade.
 * Returns the schema version it was made for; null when there is none, it is unreadable, or it could
 * not be removed (a choice that would outlive this start is not used).
 */
export function takeUpgradeWithoutBackup(userDataDirectory: string): number | null {
  const path = join(userDataDirectory, UPGRADE_WITHOUT_BACKUP)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return null
  }
  try {
    unlinkSync(path)
  } catch {
    return null
  }
  try {
    const value: unknown = JSON.parse(text)
    const schemaVersion = isRecord(value) ? value.schemaVersion : undefined
    return typeof schemaVersion === 'number' && Number.isSafeInteger(schemaVersion) && schemaVersion > 0 ? schemaVersion : null
  } catch {
    return null
  }
}
