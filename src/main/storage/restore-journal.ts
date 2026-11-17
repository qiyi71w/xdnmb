import { mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '../../shared/theme'
import { isManagedName } from '../images/files'
import { present, sizeOf, syncDirectory } from './durable'
import type { SwapContext, SwapKindHandler, SwapOutcome } from './swap-journal'

/*
 * 恢复升级前备份, the `restore` kind of swap (`./swap-journal`), carried out by the next start. The
 * run that showed the newer data read-only stages the restore data (the pre-upgrade backup with its
 * secrets filtered, see `./restore`) and begins the swap; the next start settles it here before the
 * database is opened: the current data moves to `backups/before-restore/` (replacing the previous
 * one), the staged data takes its place, and the journal is cleared. Every step can run again after
 * an interruption, and until the journal is cleared, a complete copy of the current data and of the
 * restore data each exists where the journal's phase says. When the restore data is missing or
 * incomplete, the restore is abandoned and the current data is opened as it was. File system only:
 * no database is opened here.
 *
 * Layout under the user data directory (the `before-restore` name appears in the public docs):
 *
 *   backups/restore-journal.json      the swap journal, kind `restore`
 *   backups/restore-staging/          the restore data: the database file and draft-images/
 *   backups/before-restore/           the data a restore replaced: the database file with its -wal,
 *                                     -shm and -journal files, and draft-images/
 *   backups/before-restore.partial/   the current data while it moves there
 */

const BACKUPS = 'backups'
const STAGING = 'restore-staging'
const BEFORE_RESTORE = 'before-restore'
const BEFORE_RESTORE_PARTIAL = 'before-restore.partial'
const DRAFT_IMAGES = 'draft-images'
/** Every file SQLite keeps next to a database; a stray one would be applied to the wrong database. */
const DATABASE_SUFFIXES = ['', '-wal', '-shm', '-journal']

/**
 * `prepared`: the restore data is staged, the current data untouched. `moving-current`: the current
 * data is moving into `before-restore.partial/` (made before this phase is written, and gone in this
 * phase only once it has replaced `before-restore/`). `placing-restore`: the current data is all in
 * `before-restore/`; the restore data is moving from staging into place. `returning-current`:
 * abandoning; whatever restore data was placed is gone and the current data is moving back from the
 * directory `returnFrom` names, which is recorded before anything moves back.
 */
export type RestorePhase = 'prepared' | 'moving-current' | 'placing-restore' | 'returning-current'
const PHASES: readonly RestorePhase[] = ['prepared', 'moving-current', 'placing-restore', 'returning-current']

/** Where an abandoned restore finds the current data: `before-restore.partial/` or `before-restore/`. */
export type ReturnSource = 'partial' | 'before'

export interface RestoreJournal {
  kind: 'restore'
  phase: RestorePhase
  /** Size in bytes of the staged database file. */
  databaseSize: number
  /** Every staged draft attachment copy, by managed name, with its size in bytes. */
  draftImages: { name: string; size: number }[]
  /** Only with `returning-current`. */
  returnFrom?: ReturnSource
}

/** `backups/restore-staging/` of the user data directory. */
export function restoreStagingDirectory(userDataDirectory: string): string {
  return join(userDataDirectory, BACKUPS, STAGING)
}

/** `backups/before-restore/` of the user data directory. */
export function beforeRestoreDirectory(userDataDirectory: string): string {
  return join(userDataDirectory, BACKUPS, BEFORE_RESTORE)
}

function parse(value: Record<string, unknown>): RestoreJournal | null {
  const { phase, databaseSize, draftImages, returnFrom } = value
  if (!PHASES.includes(phase as RestorePhase)) return null
  if (phase === 'returning-current' && returnFrom !== 'partial' && returnFrom !== 'before') return null
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
  const journal: RestoreJournal = { kind: 'restore', phase: phase as RestorePhase, databaseSize, draftImages: images }
  if (phase === 'returning-current') journal.returnFrom = returnFrom as ReturnSource
  return journal
}

function settle(context: SwapContext<RestoreJournal>): SwapOutcome {
  const { userData, databaseName, journal, step } = context
  const backups = join(userData, BACKUPS)
  const staging = join(backups, STAGING)
  const partial = join(backups, BEFORE_RESTORE_PARTIAL)
  const before = join(backups, BEFORE_RESTORE)
  const currentItems = [...DATABASE_SUFFIXES.map((suffix) => databaseName + suffix), DRAFT_IMAGES]
  const restoreItems = [databaseName, DRAFT_IMAGES]

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

  const write = (phase: RestorePhase, returnFrom?: ReturnSource): void => {
    const next: RestoreJournal = { kind: 'restore', phase, databaseSize: journal.databaseSize, draftImages: journal.draftImages }
    if (returnFrom !== undefined) next.returnFrom = returnFrom
    context.write(next)
    journal.phase = phase
    journal.returnFrom = returnFrom
    step()
  }

  const finish = (outcome: SwapOutcome): SwapOutcome => {
    rmSync(staging, { recursive: true, force: true })
    step()
    context.clear()
    step()
    return outcome
  }

  /**
   * Abandons: records where the current data is before moving any of it back, so an interrupted
   * return never takes another directory (such as an earlier restore's 降级前数据) for it.
   */
  const returnCurrent = (from: ReturnSource): SwapOutcome => {
    if (journal.phase !== 'returning-current') write('returning-current', from)
    const holder = journal.returnFrom === 'partial' ? partial : before
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
    // In this phase `partial` is gone only once it has become `before-restore/` (the swap below).
    if (!restoreDataComplete([staging])) return returnCurrent(present(partial) ? 'partial' : 'before')
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
    if (restoreDataComplete([staging, userData])) {
      for (const item of restoreItems) move(item, staging, userData)
      syncDirectory(userData)
      return finish('completed')
    }
    // Only restore data has been placed (the current data is all in `before-restore/`).
    for (const item of restoreItems) rmSync(join(userData, item), { recursive: true, force: true })
    syncDirectory(userData)
    return returnCurrent('before')
  }

  return returnCurrent(journal.returnFrom ?? 'before')
}

export const RESTORE_SWAP: SwapKindHandler<RestoreJournal> = {
  // What versions that only know restore read (see `./swap-journal`).
  format: 1,
  parse,
  discardLeftovers(userData) {
    // Leftovers of a preparation that ended before its journal was written: no journal locates
    // data there, and the current data never moves without one.
    rmSync(join(userData, BACKUPS, STAGING), { recursive: true, force: true })
    rmSync(join(userData, BACKUPS, BEFORE_RESTORE_PARTIAL), { recursive: true, force: true })
  },
  settle
}
