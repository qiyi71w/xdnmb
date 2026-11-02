import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isRecord } from '../../shared/theme'
import { isManagedName } from '../images/files'

/*
 * 恢复升级前备份, carried out by the next start. The run that showed the newer data read-only stages
 * the restore data (the pre-upgrade backup with its secrets filtered, see `./restore`) and writes the
 * journal; the next start settles it here before the database is opened: the current data moves to
 * `backups/before-restore/` (replacing the previous one), the staged data takes its place, and the
 * journal is cleared. Every step can run again after an interruption, and until the journal is
 * cleared, a complete copy of the current data and of the restore data each exists where the
 * journal's phase says. When the restore data is missing or incomplete, the restore is abandoned and
 * the current data is opened as it was. File system only: no database is opened here.
 *
 * Layout under the user data directory (the `before-restore` name appears in the public docs):
 *
 *   backups/restore-journal.json      RestoreJournal
 *   backups/restore-staging/          the restore data: the database file and draft-images/
 *   backups/before-restore/           the data a restore replaced: the database file with its -wal,
 *                                     -shm and -journal files, and draft-images/
 *   backups/before-restore.partial/   the current data while it moves there
 */

const BACKUPS = 'backups'
const JOURNAL = 'restore-journal.json'
const STAGING = 'restore-staging'
const BEFORE_RESTORE = 'before-restore'
const BEFORE_RESTORE_PARTIAL = 'before-restore.partial'
const DRAFT_IMAGES = 'draft-images'
/** Every file SQLite keeps next to a database; a stray one would be applied to the wrong database. */
const DATABASE_SUFFIXES = ['', '-wal', '-shm', '-journal']
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024

/**
 * `prepared`: the restore data is staged, the current data untouched. `moving-current`: the current
 * data is moving into `before-restore.partial/` (or, once that replaced `before-restore/`, is all
 * there). `placing-restore`: the current data is all in `before-restore/`; the restore data is moving
 * from staging into place. `returning-current`: abandoning after the restore data was partly placed;
 * what was placed is gone and the current data is moving back from `before-restore/`.
 */
export type RestorePhase = 'prepared' | 'moving-current' | 'placing-restore' | 'returning-current'
const PHASES: readonly RestorePhase[] = ['prepared', 'moving-current', 'placing-restore', 'returning-current']

export interface RestoreJournal {
  format: 1
  phase: RestorePhase
  /** Size in bytes of the staged database file. */
  databaseSize: number
  /** Every staged draft attachment copy, by managed name, with its size in bytes. */
  draftImages: { name: string; size: number }[]
}

/** What settling found: no restore pending, the restore done, or the restore given up (nothing changed). */
export type RestoreOutcome = 'none' | 'restored' | 'abandoned'

/** `backups/restore-staging/` of the user data directory. */
export function restoreStagingDirectory(userDataDirectory: string): string {
  return join(userDataDirectory, BACKUPS, STAGING)
}

/** `backups/before-restore/` of the user data directory. */
export function beforeRestoreDirectory(userDataDirectory: string): string {
  return join(userDataDirectory, BACKUPS, BEFORE_RESTORE)
}

function journalPath(userDataDirectory: string): string {
  return join(userDataDirectory, BACKUPS, JOURNAL)
}

function syncFile(path: string): void {
  const fd = openSync(path, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Best effort: not every platform can open a directory to flush its entries. */
function syncDirectory(path: string): void {
  try {
    syncFile(path)
  } catch {
    // The renames themselves are atomic.
  }
}

function present(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function sizeOf(path: string): number | null {
  try {
    const stat = lstatSync(path)
    return stat.isFile() ? stat.size : null
  } catch {
    return null
  }
}

/** Replaces the journal atomically, so a start never reads half of one. */
export function writeRestoreJournal(userDataDirectory: string, journal: RestoreJournal): void {
  const path = journalPath(userDataDirectory)
  const partial = `${path}.partial`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(partial, JSON.stringify(journal))
  syncFile(partial)
  renameSync(partial, path)
  syncDirectory(dirname(path))
}

/** Removes the journal (and a half-written one), so the next start carries out nothing. */
export function discardRestoreJournal(userDataDirectory: string): void {
  const path = journalPath(userDataDirectory)
  rmSync(`${path}.partial`, { force: true })
  rmSync(path, { force: true })
  syncDirectory(dirname(path))
}

function parseJournal(text: string): RestoreJournal | null {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) return null
  const { format, phase, databaseSize, draftImages } = value
  if (format !== 1 || !PHASES.includes(phase as RestorePhase)) return null
  if (typeof databaseSize !== 'number' || !Number.isSafeInteger(databaseSize) || databaseSize <= 0) return null
  if (!Array.isArray(draftImages)) return null
  const names = new Set<string>()
  const images: RestoreJournal['draftImages'] = []
  for (const entry of draftImages) {
    if (!isRecord(entry)) return null
    const { name, size } = entry
    if (typeof name !== 'string' || !isManagedName(name) || names.has(name)) return null
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return null
    names.add(name)
    images.push({ name, size })
  }
  return { format, phase: phase as RestorePhase, databaseSize, draftImages: images }
}

/** The journal; null when there is none. Throws when one exists but cannot be read. */
function readJournal(userDataDirectory: string): RestoreJournal | null {
  const path = journalPath(userDataDirectory)
  let text: string
  try {
    if (lstatSync(path).size > MAX_JOURNAL_BYTES) throw new Error('restore journal unreadable')
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  const journal = parseJournal(text)
  // Journals are only ever replaced whole; one that does not parse was not written by this app, and
  // without its phase it is unknown where the current data is, so nothing is moved.
  if (journal === null) throw new Error('restore journal unreadable')
  return journal
}

/**
 * Carries out or abandons a restore the previous run prepared, before `databasePath` is opened.
 * Returns what happened; throws when the file system refused a step, in which case the database
 * must not be opened this run (the next start continues from the journal). `step` is called after
 * every durable change (a test seam for interrupting the sequence).
 */
export function settleRestore(databasePath: string, options: { step?: () => void } = {}): RestoreOutcome {
  const userData = dirname(databasePath)
  const databaseName = basename(databasePath)
  const step = options.step ?? (() => undefined)
  const backups = join(userData, BACKUPS)
  const staging = join(backups, STAGING)
  const partial = join(backups, BEFORE_RESTORE_PARTIAL)
  const before = join(backups, BEFORE_RESTORE)
  const currentItems = [...DATABASE_SUFFIXES.map((suffix) => databaseName + suffix), DRAFT_IMAGES]
  const restoreItems = [databaseName, DRAFT_IMAGES]

  const journal = readJournal(userData)
  if (journal === null) {
    // Leftovers of a preparation that ended before its journal was written: no journal locates
    // data there, and the current data never moves without one.
    rmSync(staging, { recursive: true, force: true })
    rmSync(partial, { recursive: true, force: true })
    return 'none'
  }

  /** Whether the restore data is complete, each item looked for in `places` in order. */
  const restoreDataComplete = (places: string[]): boolean => {
    const database = places.map((place) => join(place, databaseName)).find(present)
    if (database === undefined || sizeOf(database) !== journal.databaseSize) return false
    if (journal.draftImages.length === 0) return true
    const images = places.map((place) => join(place, DRAFT_IMAGES)).find(present)
    return images !== undefined && journal.draftImages.every((image) => sizeOf(join(images, image.name)) === image.size)
  }

  /** Moves `item` from one directory to another unless already moved; never replaces anything. */
  const move = (item: string, from: string, to: string): void => {
    const source = join(from, item)
    if (!present(source)) return
    if (present(join(to, item))) throw new Error('restore target already exists')
    renameSync(source, join(to, item))
    step()
  }

  const write = (phase: RestorePhase): void => {
    writeRestoreJournal(userData, { ...journal, phase })
    journal.phase = phase
    step()
  }

  const finish = (outcome: RestoreOutcome): RestoreOutcome => {
    rmSync(staging, { recursive: true, force: true })
    step()
    discardRestoreJournal(userData)
    step()
    return outcome
  }

  /** Puts the current data back from wherever it was moved to, then forgets the restore. */
  const returnCurrent = (): RestoreOutcome => {
    const holder = present(partial) ? partial : before
    for (const item of currentItems) move(item, holder, userData)
    syncDirectory(userData)
    rmSync(holder, { recursive: true, force: true })
    step()
    return finish('abandoned')
  }

  if (journal.phase === 'prepared') {
    if (!restoreDataComplete([staging])) return finish('abandoned')
    // A leftover from an earlier abandoned restore never holds data: the journal names it first.
    rmSync(partial, { recursive: true, force: true })
    mkdirSync(partial, { recursive: true })
    syncDirectory(backups)
    write('moving-current')
  }

  if (journal.phase === 'moving-current') {
    if (!restoreDataComplete([staging])) return returnCurrent()
    // Until the swap, `partial` exists (it was made before this phase was written).
    if (present(partial)) {
      for (const item of currentItems) move(item, userData, partial)
      syncDirectory(partial)
      syncDirectory(userData)
      // The previous 降级前数据 is replaced only once the current data is all in `partial`.
      rmSync(before, { recursive: true, force: true })
      step()
      renameSync(partial, before)
      syncDirectory(backups)
      step()
    }
    write('placing-restore')
  }

  if (journal.phase === 'placing-restore') {
    if (!restoreDataComplete([staging, userData])) {
      // Only restore data has been placed (the current data is all in `before-restore/`).
      for (const item of restoreItems) rmSync(join(userData, item), { recursive: true, force: true })
      syncDirectory(userData)
      write('returning-current')
    } else {
      for (const item of restoreItems) move(item, staging, userData)
      syncDirectory(userData)
      return finish('restored')
    }
  }

  return returnCurrent()
}
