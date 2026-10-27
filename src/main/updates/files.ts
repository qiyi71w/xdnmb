import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { UPDATE_REPOSITORY_URL, type NoteBlock, type NoteInline, type ReleaseInfo } from '../../shared/updates'
import { isStableVersion } from './release'
import type { UpdateRecord, UpdateRecordStore } from './service'

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
  if (!Array.isArray(notes) || !notes.every(isBlock)) return null
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

/** `update-state.json` in the user-data directory, replaced atomically. */
export function createRecordStore(path: string): UpdateRecordStore {
  return {
    async load() {
      try {
        return parseRecord(await readFile(path, 'utf8'))
      } catch {
        return null
      }
    },
    async save(record) {
      const temporary = `${path}.tmp`
      await writeFile(temporary, JSON.stringify({ version: 1, ...record }), 'utf8')
      await rename(temporary, path)
    }
  }
}

export async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined)
}

/**
 * Starts the downloaded NSIS installer the way electron-updater's NSIS updater does: `--updated`
 * (an update of the installed app: data kept, the running app is closed if still there) and `/S`
 * (silent); `--force-run` opens the new version afterwards. Detached, so it outlives this process.
 * Resolves once the process has started; rejects when it cannot start.
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
