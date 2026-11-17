import { lstatSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '../../shared/theme'
import { isManagedName } from '../images/files'
import { APPENDED_FILES, userDataEntriesIn } from './classification'
import { present, sizeOf, syncDirectory } from './durable'
import type { SwapContext, SwapKindHandler, SwapOutcome } from './swap-journal'

/*
 * 导入个人数据, the `import` kind of swap (`./swap-journal`), carried out by the next start. The run
 * that imported built the import result in staging (`./import-staging`) and began the swap; the
 * next start settles it here before the database is opened: the current data moves to
 * `backups/before-import/` (replacing the previous one), the staged database and draft attachments
 * take its place, the staged offline originals move into the image directory, the pre-upgrade
 * backup (of data that is no longer there) is removed, and the journal is cleared. Every step can
 * run again after an interruption, and until the journal is cleared, a complete copy of the current
 * data or of the import result exists where the journal's phase says (until the import result is in
 * place, both do). When the staged data is missing or incomplete before it is placed, the import is
 * abandoned and the current data is opened as it was. File system only: no database is opened here.
 *
 * Layout under the user data directory (the `before-import` name appears in the public docs):
 *
 *   backups/restore-journal.json      the swap journal, kind `import`
 *   backups/import-staging/           the import result: xidao.sqlite, draft-images/ and images/
 *                                     (offline originals); also the export file's content while
 *                                     it is checked, before any journal exists
 *   backups/before-import/            the data an import replaced: the database file with its -wal,
 *                                     -shm and -journal files, and draft-images/
 *   backups/before-import.partial/    the current data while it moves there
 *
 * The image directory itself is not moved: its cached images are not personal data, and those the
 * import result does not record are removed by the next start's image cleanup.
 */

const BACKUPS = 'backups'
const STAGING = 'import-staging'
const BEFORE_IMPORT = 'before-import'
const BEFORE_IMPORT_PARTIAL = 'before-import.partial'
/**
 * Draft attachments, and images (offline originals among them), in the user data directory and,
 * by the same names, in staging (`APPENDED_FILES`, the layout `readContainer` extracts to).
 */
export const DRAFT_IMAGES = APPENDED_FILES.drafts
export const IMAGES = APPENDED_FILES['offline-copies']
/** The pre-upgrade backup and its work directories (`./backup`): removed once the import is in place. */
const PRE_UPGRADE_ENTRIES = ['pre-upgrade', 'pre-upgrade.partial', 'pre-upgrade.replaced']
/** Every file SQLite keeps next to a database; a stray one would be applied to the wrong database. */
const DATABASE_SUFFIXES = ['', '-wal', '-shm', '-journal']
/** The database inside the staging directory. */
export const STAGED_DATABASE = 'xidao.sqlite'

/**
 * `prepared`: the import result is staged, the current data untouched. `moving-current`: the
 * current data is moving into `before-import.partial/` (made before this phase is written, and gone
 * in this phase only once it has replaced `before-import/`). `placing-import`: the current data is
 * all in `before-import/`; the staged database and draft attachments are moving into place.
 * `placing-originals`: they are in place; the staged offline originals are moving into the image
 * directory. `removing-backup`: everything is in place; the pre-upgrade backup is being removed.
 * `returning-current`: abandoning; whatever import data was placed is gone and the current data is
 * moving back from the directory `returnFrom` names, which is recorded before anything moves back.
 */
export type ImportPhase = 'prepared' | 'moving-current' | 'placing-import' | 'placing-originals' | 'removing-backup' | 'returning-current'
const PHASES: readonly ImportPhase[] = ['prepared', 'moving-current', 'placing-import', 'placing-originals', 'removing-backup', 'returning-current']

/** Where an abandoned import finds the current data: `before-import.partial/` or `before-import/`. */
export type ImportReturnSource = 'partial' | 'before'

export interface ImportJournal {
  kind: 'import'
  phase: ImportPhase
  /** Size in bytes of the staged database file. */
  databaseSize: number
  /** Every staged draft attachment, by managed name, with its size in bytes. */
  draftImages: { name: string; size: number }[]
  /** The staged offline originals: how many, and their bytes together. */
  offlineImages: { count: number; bytes: number }
  /** Only with `returning-current`. */
  returnFrom?: ImportReturnSource
}

/** `backups/import-staging/` of the user data directory. */
export function importStagingDirectory(userDataDirectory: string): string {
  return join(userDataDirectory, BACKUPS, STAGING)
}

/** `backups/before-import/` of the user data directory. */
export function beforeImportDirectory(userDataDirectory: string): string {
  return join(userDataDirectory, BACKUPS, BEFORE_IMPORT)
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** The managed regular files of a directory with their sizes (none when it is absent). */
function managedFiles(directory: string): { name: string; size: number }[] {
  let names: string[]
  try {
    names = readdirSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const files: { name: string; size: number }[] = []
  for (const name of names.sort()) {
    if (!isManagedName(name)) continue
    const stat = lstatSync(join(directory, name))
    if (stat.isFile()) files.push({ name, size: stat.size })
  }
  return files
}

function totals(files: { size: number }[]): { count: number; bytes: number } {
  return { count: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) }
}

/** The first journal of an import whose result is staged (`./import-staging`). */
export function preparedImportJournal(userDataDirectory: string): ImportJournal {
  const staging = importStagingDirectory(userDataDirectory)
  const databaseSize = sizeOf(join(staging, STAGED_DATABASE))
  if (databaseSize === null || databaseSize <= 0) throw new Error('staged import database missing')
  return {
    kind: 'import',
    phase: 'prepared',
    databaseSize,
    draftImages: managedFiles(join(staging, DRAFT_IMAGES)),
    offlineImages: totals(managedFiles(join(staging, IMAGES)))
  }
}

function parse(value: Record<string, unknown>): ImportJournal | null {
  const { phase, databaseSize, draftImages, offlineImages, returnFrom } = value
  if (!PHASES.includes(phase as ImportPhase)) return null
  if (phase === 'returning-current' && returnFrom !== 'partial' && returnFrom !== 'before') return null
  if (!nonNegativeInteger(databaseSize) || databaseSize === 0) return null
  if (!isRecord(offlineImages) || !nonNegativeInteger(offlineImages.count) || !nonNegativeInteger(offlineImages.bytes)) return null
  if (!Array.isArray(draftImages)) return null
  const names = new Set<string>()
  const images: ImportJournal['draftImages'] = []
  for (const entry of draftImages) {
    if (!isRecord(entry)) return null
    const { name, size } = entry
    if (typeof name !== 'string' || !isManagedName(name) || names.has(name) || !nonNegativeInteger(size)) return null
    names.add(name)
    images.push({ name, size })
  }
  const journal: ImportJournal = {
    kind: 'import',
    phase: phase as ImportPhase,
    databaseSize,
    draftImages: images,
    offlineImages: { count: offlineImages.count, bytes: offlineImages.bytes }
  }
  if (phase === 'returning-current') journal.returnFrom = returnFrom as ImportReturnSource
  return journal
}

function settle(context: SwapContext<ImportJournal>): SwapOutcome {
  const { userData, databaseName, journal, step } = context
  const backups = join(userData, BACKUPS)
  const staging = join(backups, STAGING)
  const partial = join(backups, BEFORE_IMPORT_PARTIAL)
  const before = join(backups, BEFORE_IMPORT)
  // The database with its companions and the `target-appended` entries move as one; offline
  // originals are placed among the images one by one.
  const currentItems = [...DATABASE_SUFFIXES.map((suffix) => databaseName + suffix), ...userDataEntriesIn('target-appended')]
  /** The staged database and draft attachments: [name in staging, name in the user data directory]. */
  const importItems: [string, string][] = [[STAGED_DATABASE, databaseName], ...userDataEntriesIn('target-appended').map((entry): [string, string] => [entry, entry])]

  /**
   * Whether the staged database and draft attachments are complete, each looked for in staging,
   * then (when `placed`) where it goes in the user data directory.
   */
  const importDataComplete = (placed: boolean): boolean => {
    const find = ([staged, target]: [string, string]) => [join(staging, staged), ...(placed ? [join(userData, target)] : [])].find(present)
    const [databaseItem, imagesItem] = importItems
    const database = find(databaseItem!)
    if (database === undefined || sizeOf(database) !== journal.databaseSize) return false
    if (journal.draftImages.length === 0) return true
    const images = find(imagesItem!)
    return images !== undefined && journal.draftImages.every((image) => sizeOf(join(images, image.name)) === image.size)
  }

  /** Whether every staged offline original is still in staging (none has been placed before `placing-originals`). */
  const originalsStaged = (): boolean => {
    const staged = totals(managedFiles(join(staging, IMAGES)))
    return staged.count === journal.offlineImages.count && staged.bytes === journal.offlineImages.bytes
  }

  /** Moves `from` to `to` unless already moved; never replaces anything. */
  const move = (from: string, to: string): void => {
    if (!present(from)) return
    if (present(to)) throw new Error('import target already exists')
    renameSync(from, to)
    step()
  }

  const write = (phase: ImportPhase, returnFrom?: ImportReturnSource): void => {
    const next: ImportJournal = {
      kind: 'import', phase, databaseSize: journal.databaseSize, draftImages: journal.draftImages, offlineImages: journal.offlineImages
    }
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
   * return never takes another directory (such as an earlier import's 导入前数据) for it.
   */
  const returnCurrent = (from: ImportReturnSource): SwapOutcome => {
    if (journal.phase !== 'returning-current') write('returning-current', from)
    const holder = journal.returnFrom === 'partial' ? partial : before
    for (const item of currentItems) move(join(holder, item), join(userData, item))
    syncDirectory(userData)
    rmSync(holder, { recursive: true, force: true })
    step()
    return finish('abandoned')
  }

  if (journal.phase === 'prepared') {
    if (!importDataComplete(false) || !originalsStaged()) return finish('abandoned')
    // A leftover from an earlier abandoned import never holds data: the journal names it first.
    rmSync(partial, { recursive: true, force: true })
    mkdirSync(partial, { recursive: true })
    syncDirectory(backups)
    write('moving-current')
  }

  if (journal.phase === 'moving-current') {
    // In this phase `partial` is gone only once it has become `before-import/` (the swap below).
    if (!importDataComplete(false) || !originalsStaged()) return returnCurrent(present(partial) ? 'partial' : 'before')
    // Until the swap, `partial` exists (it was made before this phase was written).
    if (present(partial)) {
      for (const item of currentItems) move(join(userData, item), join(partial, item))
      syncDirectory(partial)
      syncDirectory(userData)
      // The previous 导入前数据 is replaced only once the current data is all in `partial`.
      rmSync(before, { recursive: true, force: true })
      step()
      renameSync(partial, before)
      syncDirectory(backups)
      step()
    }
    write('placing-import')
  }

  if (journal.phase === 'placing-import') {
    if (importDataComplete(true) && originalsStaged()) {
      for (const [staged, target] of importItems) move(join(staging, staged), join(userData, target))
      syncDirectory(userData)
      write('placing-originals')
    } else {
      // Only import data has been placed (the current data is all in `before-import/`).
      for (const [, target] of importItems) rmSync(join(userData, target), { recursive: true, force: true })
      syncDirectory(userData)
      return returnCurrent('before')
    }
  }

  if (journal.phase === 'placing-originals') {
    // The import is in place: from here it only completes. An image of the same managed name is
    // replaced: a cached one the import result does not record, or this machine's own original whose
    // copy in staging is the same file.
    const images = join(userData, IMAGES)
    mkdirSync(images, { recursive: true })
    for (const { name } of managedFiles(join(staging, IMAGES))) {
      renameSync(join(staging, IMAGES, name), join(images, name))
      step()
    }
    syncDirectory(images)
    write('removing-backup')
  }

  if (journal.phase === 'removing-backup') {
    // A pre-upgrade backup is of data that is no longer here; restoring it would bring that back.
    for (const entry of PRE_UPGRADE_ENTRIES) {
      rmSync(join(backups, entry), { recursive: true, force: true })
      step()
    }
    syncDirectory(backups)
    return finish('completed')
  }

  return returnCurrent(journal.returnFrom ?? 'before')
}

export const IMPORT_SWAP: SwapKindHandler<ImportJournal> = {
  // Versions that only know restore (format 1) refuse it and leave the database unopened.
  format: 2,
  parse,
  discardLeftovers(userData) {
    // Leftovers of an import checked or prepared but never begun: no journal locates data there,
    // and the current data never moves without one.
    rmSync(join(userData, BACKUPS, STAGING), { recursive: true, force: true })
    rmSync(join(userData, BACKUPS, BEFORE_IMPORT_PARTIAL), { recursive: true, force: true })
  },
  settle
}
