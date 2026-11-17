import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isRecord } from '../../shared/theme'
import { syncDirectory, syncFile } from './durable'
import { IMPORT_SWAP, type ImportJournal } from './import-journal'
import { RESTORE_SWAP, type RestoreJournal } from './restore-journal'

/*
 * 换库: the current data (the database with its -wal, -shm and -journal files, and the files that go
 * with it) is replaced by data an earlier run staged. The next start carries it out before the
 * database is opened, following a phased journal: every step can run again after an interruption,
 * and until the journal is cleared, a complete copy of the current data and of the staged data each
 * exists where the journal's phase says. A swap whose staged data is missing or incomplete is
 * abandoned and the current data is opened as it was.
 *
 * Each kind of swap (恢复升级前备份 in `./restore-journal`, 导入个人数据 in `./import-journal`) has
 * its own staging, phases and settling;
 * this module owns what they share: the one journal file, at most one pending swap, and settling
 * whichever kind is pending. A kind is added to `SwapJournal` and `KINDS` (a missing handler is a
 * type error).
 *
 * The journal keeps the path restore has used since it shipped, `backups/restore-journal.json`, so
 * every version that can restore finds a pending swap before opening the database. Restore journals
 * are `format` 1, which those versions read; a later kind is written with a format they reject, so
 * they leave the database unopened rather than open it in the middle of a swap they do not know.
 */

const BACKUPS = 'backups'
const JOURNAL = 'restore-journal.json'
const MAX_JOURNAL_BYTES = 16 * 1024 * 1024

/** A pending swap: its kind, its phase and what the kind records to check its staged data. */
export type SwapJournal = RestoreJournal | ImportJournal
export type SwapKind = SwapJournal['kind']
type JournalOf<K extends SwapKind> = Extract<SwapJournal, { kind: K }>

/** What settling did with a pending swap: carried it out, or gave it up (the current data unchanged). */
export type SwapOutcome = 'completed' | 'abandoned'

export interface SwapSettlement {
  kind: SwapKind
  outcome: SwapOutcome
}

/** What a kind's settling works with. */
export interface SwapContext<J extends SwapJournal> {
  /** The user data directory: the directory holding the database. */
  userData: string
  /** The database file's name in it. */
  databaseName: string
  /** The journal as read; the kind updates it as it writes later phases. */
  journal: J
  /** Replaces the journal atomically. */
  write(journal: J): void
  /** Removes the journal: the swap is over. */
  clear(): void
  /** Called after every durable change (a test seam for interrupting the sequence). */
  step(): void
}

export interface SwapKindHandler<J extends SwapJournal> {
  /** The journal format this kind is written with (see above). */
  format: number
  /** The journal from its parsed fields; null when they are not a valid journal of this kind. */
  parse(value: Record<string, unknown>): J | null
  /** Removes leftovers of a preparation that ended before its journal was written (no journal locates data there). */
  discardLeftovers(userData: string): void
  /** Carries out or abandons the swap; throws when the file system refused a step. */
  settle(context: SwapContext<J>): SwapOutcome
}

const KINDS: { [K in SwapKind]: SwapKindHandler<JournalOf<K>> } = {
  restore: RESTORE_SWAP,
  import: IMPORT_SWAP
}

/** Another swap is pending (or may be: its journal cannot be read); nothing was changed. */
export class SwapPendingError extends Error {
  constructor() {
    super('another swap is pending')
  }
}

function journalPath(userDataDirectory: string): string {
  return join(userDataDirectory, BACKUPS, JOURNAL)
}

function parseJournal(text: string): SwapJournal | null {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)) return null
  // Restore journals written before swaps had kinds carry none.
  const kind = value.kind === undefined ? 'restore' : typeof value.kind === 'string' && Object.hasOwn(KINDS, value.kind) ? (value.kind as SwapKind) : null
  if (kind === null || value.format !== KINDS[kind].format) return null
  return KINDS[kind].parse(value)
}

/**
 * The journal; null when there provably is none (no such file, or `backups` is not a directory).
 * Throws when one may exist but cannot be read.
 */
function readJournal(userDataDirectory: string): SwapJournal | null {
  const path = journalPath(userDataDirectory)
  let text: string
  try {
    if (lstatSync(path).size > MAX_JOURNAL_BYTES) throw new Error('swap journal unreadable')
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return null
    throw error
  }
  const journal = parseJournal(text)
  // Journals are only ever replaced whole; one that does not parse was not written by this app (or
  // is of a kind this version does not know), and without its phase it is unknown where the current
  // data is, so nothing is moved.
  if (journal === null) throw new Error('swap journal unreadable')
  return journal
}

/** Replaces the journal atomically, so a start never reads half of one. */
function writeJournal(userDataDirectory: string, journal: SwapJournal): void {
  const path = journalPath(userDataDirectory)
  const partial = `${path}.partial`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(partial, JSON.stringify({ format: KINDS[journal.kind].format, ...journal }))
  syncFile(partial)
  renameSync(partial, path)
  syncDirectory(dirname(path))
}

/** Whether a swap is pending; also when a journal may exist but cannot be read. */
export function swapPending(userDataDirectory: string): boolean {
  try {
    return readJournal(userDataDirectory) !== null
  } catch {
    return true
  }
}

/**
 * Writes the first journal of a swap whose data is staged; the next start carries it out. At most
 * one swap is pending at a time: while another is, this throws `SwapPendingError` and changes nothing.
 */
export function beginSwap(userDataDirectory: string, journal: SwapJournal): void {
  if (swapPending(userDataDirectory)) throw new SwapPendingError()
  writeJournal(userDataDirectory, journal)
}

/** Removes the journal (and a half-written one), so the next start carries out nothing. */
export function discardSwapJournal(userDataDirectory: string): void {
  const path = journalPath(userDataDirectory)
  rmSync(`${path}.partial`, { force: true })
  rmSync(path, { force: true })
  syncDirectory(dirname(path))
}

function settleKind<J extends SwapJournal>(handler: SwapKindHandler<J>, journal: J, databasePath: string, step: () => void): SwapOutcome {
  const userData = dirname(databasePath)
  return handler.settle({
    userData,
    databaseName: basename(databasePath),
    journal,
    write: (next) => writeJournal(userData, next),
    clear: () => discardSwapJournal(userData),
    step
  })
}

/**
 * Carries out or abandons the swap the previous run prepared, before `databasePath` is opened.
 * Returns what happened, null when no swap was pending; throws when the journal cannot be read or
 * the file system refused a step, in which case the database must not be opened this run (the next
 * start continues from the journal). `step` is called after every durable change (a test seam for
 * interrupting the sequence).
 */
export function settleSwap(databasePath: string, options: { step?: () => void } = {}): SwapSettlement | null {
  const userData = dirname(databasePath)
  const journal = readJournal(userData)
  if (journal === null) {
    // `backups` that is not a directory holds nothing of a swap; the pre-upgrade backup decides
    // what that means for opening.
    if (!lstatSync(join(userData, BACKUPS), { throwIfNoEntry: false })?.isDirectory()) return null
    for (const handler of Object.values(KINDS)) handler.discardLeftovers(userData)
    return null
  }
  const outcome = settleKind(KINDS[journal.kind], journal, databasePath, options.step ?? (() => undefined))
  return { kind: journal.kind, outcome }
}
