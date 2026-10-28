import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { UPDATE_REPOSITORY_URL, type NoteBlock, type NoteInline, type ReleaseInfo } from '../../shared/updates'
import { isStableVersion } from './release'
import type { InstallMarkerStore, UpdateRecord, UpdateRecordStore } from './service'
import type { PendingInstallStore, ReadyPackage } from './startup'

/** SHA-512 (base64) of a file, or null when it cannot be read. */
export async function sha512OfFile(path: string): Promise<string | null> {
  const hash = createHash('sha512')
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk)
  } catch {
    return null
  }
  return hash.digest('base64')
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInline(value: unknown): value is NoteInline {
  if (!isRecordObject(value)) return false
  if (value.kind === 'break') return true
  if (value.kind === 'text') return typeof value.text === 'string'
  return value.kind === 'link' && typeof value.text === 'string' && typeof value.url === 'string' && value.url.startsWith('https://')
}

const isInlines = (value: unknown): value is NoteInline[] => Array.isArray(value) && value.every(isInline)

function isBlock(value: unknown): value is NoteBlock {
  if (!isRecordObject(value)) return false
  switch (value.kind) {
    case 'heading': return (value.level === 1 || value.level === 2 || value.level === 3) && isInlines(value.content)
    case 'paragraph': return isInlines(value.content)
    case 'code': return typeof value.text === 'string'
    case 'list':
      return typeof value.ordered === 'boolean' && Array.isArray(value.items) &&
        value.items.every((item) => isRecordObject(item) && (item.depth === 0 || item.depth === 1 || item.depth === 2) && isInlines(item.content))
    default: return false
  }
}

function releaseOf(value: unknown): ReleaseInfo | null {
  if (!isRecordObject(value)) return null
  const { version, releaseDate, notes, pageUrl } = value
  if (typeof version !== 'string' || !isStableVersion(version)) return null
  if (releaseDate !== null && typeof releaseDate !== 'string') return null
  if (typeof pageUrl !== 'string' || !pageUrl.startsWith(`${UPDATE_REPOSITORY_URL}/releases/tag/`)) return null
  if (notes !== null && (!Array.isArray(notes) || !notes.every(isBlock))) return null
  return { version, releaseDate, notes, pageUrl }
}

/** The stored record, or null when it is missing or not one this version wrote. */
function parseRecord(text: string): UpdateRecord | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecordObject(value) || value.version !== 1) return null
  const notified = typeof value.notified === 'string' && isStableVersion(value.notified) ? value.notified : null
  const ready = value.ready
  if (!isRecordObject(ready)) return { notified, ready: null }
  const release = releaseOf(ready.release)
  const { sha512, path } = ready
  if (release === null || typeof sha512 !== 'string' || typeof path !== 'string' || !isAbsolute(path)) return { notified, ready: null }
  return { notified, ready: { release, sha512, path } }
}

/** `update-state.json` in the user-data directory, replaced atomically; writes run one at a time, in call order. */
export function createRecordStore(path: string): UpdateRecordStore {
  let writes: Promise<unknown> = Promise.resolve()
  return {
    async load() {
      try {
        return parseRecord(await readFile(path, 'utf8'))
      } catch {
        return null
      }
    },
    save(record) {
      const write = writes.then(async () => {
        const temporary = `${path}.tmp`
        await writeFile(temporary, JSON.stringify({ version: 1, ...record }), 'utf8')
        await rename(temporary, path)
      })
      // A failed write is reported to its caller and does not stop later ones.
      writes = write.catch(() => undefined)
      return write
    }
  }
}

/** A self-contained snapshot, separate from queued update-state writes which shutdown may interrupt. */
export function createPendingInstallStore(path: string): PendingInstallStore {
  return {
    save(ready) {
      const temporary = `${path}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: 1, notified: null, ready }), { encoding: 'utf8', flush: true })
      renameSync(temporary, path)
    },
    consume(): ReadyPackage | null {
      let text: string
      try {
        text = readFileSync(path, 'utf8')
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
        throw error
      }
      // Also consume malformed records. Nothing can execute unless this removal succeeds.
      unlinkSync(path)
      return parseRecord(text)?.ready ?? null
    }
  }
}

/** The version an installer started at exit was to install; taken once at the next start. */
export function createInstallMarkerStore(path: string): InstallMarkerStore {
  return {
    save(target) {
      const temporary = `${path}.tmp`
      writeFileSync(temporary, JSON.stringify({ version: 1, target }), { encoding: 'utf8', flush: true })
      renameSync(temporary, path)
    },
    take(): string | null {
      let text: string
      try {
        text = readFileSync(path, 'utf8')
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
        throw error
      }
      unlinkSync(path)
      try {
        const value: unknown = JSON.parse(text)
        return isRecordObject(value) && typeof value.target === 'string' && isStableVersion(value.target) ? value.target : null
      } catch {
        return null
      }
    }
  }
}

export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined)
}

/**
 * Starts the downloaded NSIS installer at exit the way electron-updater's NSIS updater does:
 * `--updated` (an update of the installed app: its installation mode, location and shortcuts are
 * kept, no page is shown) and `/S`. `--force-run` opens the new version afterwards. An installation
 * for all users asks Windows for administrator approval first. Resolves once the process has
 * started; rejects when it cannot start.
 */
export function runWindowsInstaller(path: string, restart: boolean): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const child = spawn(path, ['--updated', '/S', ...(restart ? ['--force-run'] : [])], { detached: true, stdio: 'ignore' })
  child.once('error', reject)
  child.once('spawn', () => {
    child.unref()
    resolve()
  })
  return promise
}

/**
 * The installation before storage and windows open: visible NSIS progress, then `--force-run` opens
 * the installed version. Once installing begins the installer closes this process, so resolving
 * means it ended without installing (for example administrator approval was refused). Rejects when
 * it cannot start.
 */
export function runWindowsInstallerAndWait(path: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const child = spawn(path, ['--updated', '--force-run'], { detached: true, stdio: 'ignore' })
  child.once('error', reject)
  child.once('exit', () => resolve())
  return promise
}
