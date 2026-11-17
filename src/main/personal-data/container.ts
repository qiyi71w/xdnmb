import { mkdir, open, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { isRecord } from '../../shared/theme'
import { isManagedName } from '../images/files'
import { APPENDED_FILES } from '../storage/classification'
import {
  CHUNK_BYTES, openChunk, parseEncryptionParams, plainBytes, sealChunk, sealedBytes, TAG_BYTES, type EncryptionParams
} from './encryption'

/*
 * The `.xidao` export file: the app's own sequential container (no archive dependency). Not a
 * published format until personal-data import and encrypted secrets ship with it.
 *
 *   magic                8 bytes  "XIDAOEXP"
 *   container version    uint16 BE (CONTAINER_VERSION)
 *   header length        uint32 BE, then the header: UTF-8 JSON `ContainerHeader`, in plain text.
 *                        It says whether the file is encrypted (`encryption`, null: not) and, if
 *                        so, how its key is derived (`./encryption`).
 *   content              the entries below; in an encrypted file sealed in chunks after the header
 *                        (`./encryption`), with the same entry layout inside.
 *   entries, in order    manifest, database, draft images, offline originals, end
 *     type               uint8 (ENTRY_TYPE)
 *     name length        uint16 BE, then the managed name (UTF-8)
 *     byte length        uint64 BE, then exactly that many bytes
 *
 * The end entry has an empty name and no bytes, and nothing may follow it. A file is encrypted
 * exactly when it carries secrets (`includes.secrets`). A plain file carries no content hash: the
 * database is checked by SQLite's integrity check, files by their lengths, which the manifest
 * repeats per kind. An encrypted one is authenticated chunk by chunk.
 */

export const CONTAINER_MAGIC = Buffer.from('XIDAOEXP', 'ascii')
export const CONTAINER_VERSION = 1

export const ENTRY_TYPE = { end: 0, manifest: 1, database: 2, draftImage: 3, offlineImage: 4 } as const
export type EntryType = (typeof ENTRY_TYPE)[keyof typeof ENTRY_TYPE]
/** Entry types that carry content after the manifest. */
export type ContentEntryType = typeof ENTRY_TYPE.database | typeof ENTRY_TYPE.draftImage | typeof ENTRY_TYPE.offlineImage

export const MANIFEST_NAME = 'manifest.json'
export const DATABASE_NAME = 'xidao.sqlite'
/** Where `readContainer` extracts draft images and offline originals, under its target directory (`APPENDED_FILES`). */
export const DRAFT_IMAGES_DIRECTORY = APPENDED_FILES.drafts
export const OFFLINE_IMAGES_DIRECTORY = APPENDED_FILES['offline-copies']

/** The plain-text header. `encryption`: how the content is sealed; null: not encrypted. */
export interface ContainerHeader {
  encryption: EncryptionParams | null
}

export interface EntryTotals {
  count: number
  bytes: number
}

/** The first entry: what the file holds and what an import confirmation shows. */
export interface ExportManifest {
  containerVersion: typeof CONTAINER_VERSION
  /** `user_version` of the exported database. */
  schemaVersion: number
  /** Version of the app that exported it. */
  appVersion: string
  /** ISO 8601, UTC. */
  exportedAt: string
  includes: { offlineCopies: boolean; secrets: boolean }
  /** Upper bound of the 饼干凭据 ID sequence, recorded with or without the credentials. */
  credentialSequence: number
  entries: { database: EntryTotals; draftImages: EntryTotals; offlineImages: EntryTotals }
  stats: { history: number; sendRecords: number; offlineThreads: number }
}

export interface ContainerLimits {
  maxHeaderBytes: number
  maxManifestBytes: number
  /** Entries after the manifest. */
  maxEntries: number
  /** Total bytes of all entries' contents. */
  maxTotalBytes: number
}

export const CONTAINER_LIMITS: ContainerLimits = {
  maxHeaderBytes: 64 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxEntries: 1_000_000,
  maxTotalBytes: 1024 ** 4
}

/**
 * Why a file was refused. `not-container`: not an export file at all. `unsupported`: a container
 * version or header this app does not read. `corrupt`: damaged, truncated or not well formed.
 * `too-large`: beyond the reader's limits.
 */
export class ContainerError extends Error {
  override readonly name = 'ContainerError'
  constructor(readonly kind: 'not-container' | 'unsupported' | 'corrupt' | 'too-large') {
    super(`export file ${kind}`)
  }
}

/** A content entry to write, read from an open file. */
export interface ContainerSource {
  type: ContentEntryType
  name: string
  bytes: number
  handle: FileHandle
}

/** A source file could not be read while writing (as opposed to the target failing). */
export class SourceReadError extends Error {
  override readonly name = 'SourceReadError'
}

const CHUNK = 1024 * 1024
const MAX_NAME_BYTES = 255
const ENTRY_PREFIX = 1 + 2 + 8

const ENTRY_NAME_CHECK: Record<EntryType, (name: string) => boolean> = {
  [ENTRY_TYPE.end]: (name) => name === '',
  [ENTRY_TYPE.manifest]: (name) => name === MANIFEST_NAME,
  [ENTRY_TYPE.database]: (name) => name === DATABASE_NAME,
  [ENTRY_TYPE.draftImage]: isManagedName,
  [ENTRY_TYPE.offlineImage]: isManagedName
}

function entryHeader(type: EntryType, name: string, bytes: number): Buffer {
  const nameBytes = Buffer.from(name, 'utf8')
  const buffer = Buffer.alloc(ENTRY_PREFIX + nameBytes.length)
  buffer.writeUInt8(type, 0)
  buffer.writeUInt16BE(nameBytes.length, 1)
  nameBytes.copy(buffer, 3)
  buffer.writeBigUInt64BE(BigInt(bytes), 3 + nameBytes.length)
  return buffer
}

function fileHeader(header: ContainerHeader): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const fixed = Buffer.alloc(CONTAINER_MAGIC.length + 2 + 4)
  CONTAINER_MAGIC.copy(fixed, 0)
  fixed.writeUInt16BE(CONTAINER_VERSION, CONTAINER_MAGIC.length)
  fixed.writeUInt32BE(json.length, CONTAINER_MAGIC.length + 2)
  return Buffer.concat([fixed, json])
}

/** Exact size of the file `writeContainer` writes for these contents (`encryption`: its parameters). */
export function containerBytes(
  manifest: ExportManifest,
  sources: readonly Pick<ContainerSource, 'name' | 'bytes'>[],
  encryption: EncryptionParams | null = null
): number {
  const manifestBytes = Buffer.byteLength(JSON.stringify(manifest), 'utf8')
  const content = ENTRY_PREFIX + MANIFEST_NAME.length + manifestBytes
    + sources.reduce((sum, source) => sum + ENTRY_PREFIX + Buffer.byteLength(source.name, 'utf8') + source.bytes, 0)
    + ENTRY_PREFIX
  return fileHeader({ encryption }).length + (encryption === null ? content : sealedBytes(content))
}

interface ContentWriter {
  write(buffer: Buffer): Promise<void>
  end(): Promise<void>
  /** Overwrites what is held in memory. */
  wipe(): void
}

/** Writes the content as sealed chunks; a full chunk waits for more, so the last is never empty. */
function sealingWriter(key: Buffer, header: Buffer, put: (buffer: Buffer) => Promise<void>): ContentWriter {
  const pending = Buffer.alloc(CHUNK_BYTES)
  let filled = 0
  let index = 0
  const seal = async (last: boolean) => {
    const sealed = sealChunk(key, header, index, last, pending.subarray(0, filled))
    index++
    filled = 0
    await put(sealed)
  }
  return {
    async write(buffer) {
      let offset = 0
      while (offset < buffer.length) {
        if (filled === CHUNK_BYTES) await seal(false)
        const length = Math.min(CHUNK_BYTES - filled, buffer.length - offset)
        buffer.copy(pending, filled, offset, offset + length)
        filled += length
        offset += length
      }
    },
    end: () => seal(true),
    wipe: () => pending.fill(0)
  }
}

/**
 * Writes the container to `file` from its start: header, manifest, then every source in the given
 * order (database, draft images, offline originals), then the end entry, and flushes it. Each source
 * must still have exactly its declared bytes (a shorter one is a `SourceReadError`). With
 * `encryption`, everything after the header is sealed under `key` (`./encryption`). `onProgress`
 * gets the bytes written so far; an aborted `signal` stops between chunks with its reason.
 */
export async function writeContainer(
  file: FileHandle,
  contents: { manifest: ExportManifest; sources: readonly ContainerSource[] },
  options: { signal: AbortSignal; onProgress: (written: number) => void; encryption?: { params: EncryptionParams; key: Buffer } }
): Promise<number> {
  let written = 0
  const put = async (buffer: Buffer) => {
    options.signal.throwIfAborted()
    let offset = 0
    while (offset < buffer.length) {
      const { bytesWritten } = await file.write(buffer, offset, buffer.length - offset, written)
      offset += bytesWritten
      written += bytesWritten
    }
    options.onProgress(written)
  }
  const header = fileHeader({ encryption: options.encryption?.params ?? null })
  await put(header)
  const content: ContentWriter = options.encryption === undefined
    ? { write: put, end: async () => undefined, wipe: () => undefined }
    : sealingWriter(options.encryption.key, header, put)
  const chunk = Buffer.allocUnsafe(CHUNK)
  try {
    const manifest = Buffer.from(JSON.stringify(contents.manifest), 'utf8')
    await content.write(entryHeader(ENTRY_TYPE.manifest, MANIFEST_NAME, manifest.length))
    await content.write(manifest)
    for (const source of contents.sources) {
      await content.write(entryHeader(source.type, source.name, source.bytes))
      let position = 0
      while (position < source.bytes) {
        options.signal.throwIfAborted()
        let bytesRead: number
        try {
          ({ bytesRead } = await source.handle.read(chunk, 0, Math.min(CHUNK, source.bytes - position), position))
        } catch (error) {
          throw new SourceReadError('source not readable', { cause: error })
        }
        if (bytesRead === 0) throw new SourceReadError('source shorter than declared')
        position += bytesRead
        await content.write(chunk.subarray(0, bytesRead))
      }
    }
    await content.write(entryHeader(ENTRY_TYPE.end, '', 0))
    await content.end()
  } finally {
    content.wipe()
    chunk.fill(0)
  }
  options.signal.throwIfAborted()
  await file.sync()
  return written
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function totals(value: unknown): EntryTotals | null {
  if (!isRecord(value) || !nonNegativeInteger(value.count) || !nonNegativeInteger(value.bytes)) return null
  return { count: value.count, bytes: value.bytes }
}

/** The manifest if `value` is a well-formed one, else null. Only the documented fields are kept. */
export function parseManifest(value: unknown): ExportManifest | null {
  if (!isRecord(value)) return null
  const { containerVersion, schemaVersion, appVersion, exportedAt, includes, credentialSequence, entries, stats } = value
  if (containerVersion !== CONTAINER_VERSION) return null
  if (!nonNegativeInteger(schemaVersion) || schemaVersion < 1) return null
  if (typeof appVersion !== 'string' || appVersion.length === 0 || appVersion.length > 64) return null
  if (typeof exportedAt !== 'string' || Number.isNaN(Date.parse(exportedAt)) || new Date(exportedAt).toISOString() !== exportedAt) return null
  if (!isRecord(includes) || typeof includes.offlineCopies !== 'boolean' || typeof includes.secrets !== 'boolean') return null
  if (!nonNegativeInteger(credentialSequence)) return null
  if (!isRecord(entries) || !isRecord(stats)) return null
  const database = totals(entries.database)
  const draftImages = totals(entries.draftImages)
  const offlineImages = totals(entries.offlineImages)
  if (database === null || database.count !== 1 || draftImages === null || offlineImages === null) return null
  const { history, sendRecords, offlineThreads } = stats
  if (!nonNegativeInteger(history) || !nonNegativeInteger(sendRecords) || !nonNegativeInteger(offlineThreads)) return null
  return {
    containerVersion, schemaVersion, appVersion, exportedAt,
    includes: { offlineCopies: includes.offlineCopies, secrets: includes.secrets },
    credentialSequence,
    entries: { database, draftImages, offlineImages },
    stats: { history, sendRecords, offlineThreads }
  }
}

export interface ContainerEntry {
  type: ContentEntryType
  name: string
  bytes: number
}

export interface ContainerContents {
  header: ContainerHeader
  manifest: ExportManifest
  /** Content entries in file order. */
  entries: ContainerEntry[]
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true })

function decodeName(bytes: Buffer): string {
  try {
    return STRICT_UTF8.decode(bytes)
  } catch {
    throw new ContainerError('corrupt')
  }
}

function extractPath(directory: string, type: ContentEntryType, name: string): string {
  if (type === ENTRY_TYPE.database) return join(directory, DATABASE_NAME)
  return join(directory, type === ENTRY_TYPE.draftImage ? DRAFT_IMAGES_DIRECTORY : OFFLINE_IMAGES_DIRECTORY, name)
}

/** Reads exactly `length` bytes of `file` at `position` into the start of `buffer`. */
async function readAt(file: FileHandle, buffer: Buffer, length: number, position: number): Promise<void> {
  let offset = 0
  while (offset < length) {
    const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset)
    if (bytesRead === 0) throw new ContainerError('corrupt')
    offset += bytesRead
  }
}

/** The header, and its bytes exactly as in the file (the chunks' AAD). */
async function readHeader(file: FileHandle, size: number, limits: ContainerLimits): Promise<{ header: ContainerHeader; bytes: Buffer }> {
  const fixed = Buffer.alloc(CONTAINER_MAGIC.length + 2 + 4)
  if (size < CONTAINER_MAGIC.length) throw new ContainerError('not-container')
  await readAt(file, fixed, Math.min(fixed.length, size), 0)
  if (!fixed.subarray(0, CONTAINER_MAGIC.length).equals(CONTAINER_MAGIC)) throw new ContainerError('not-container')
  if (size < fixed.length) throw new ContainerError('corrupt')
  if (fixed.readUInt16BE(CONTAINER_MAGIC.length) !== CONTAINER_VERSION) throw new ContainerError('unsupported')
  const headerLength = fixed.readUInt32BE(CONTAINER_MAGIC.length + 2)
  if (headerLength > limits.maxHeaderBytes) throw new ContainerError('too-large')
  if (headerLength > size - fixed.length) throw new ContainerError('corrupt')
  const json = Buffer.alloc(headerLength)
  await readAt(file, json, headerLength, fixed.length)
  let header: unknown
  try {
    header = JSON.parse(decodeName(json))
  } catch (error) {
    throw error instanceof ContainerError ? error : new ContainerError('corrupt')
  }
  if (!isRecord(header) || !Object.hasOwn(header, 'encryption')) throw new ContainerError('corrupt')
  if (header.encryption === null) return { header: { encryption: null }, bytes: Buffer.concat([fixed, json]) }
  const encryption = parseEncryptionParams(header.encryption)
  // Key derivation beyond the bounds is refused before any of it runs.
  if (encryption === 'over-limit') throw new ContainerError('too-large')
  if (encryption === null) throw new ContainerError('unsupported')
  return { header: { encryption }, bytes: Buffer.concat([fixed, json]) }
}

/** Reads the plain-text header only: whether the file is encrypted, and its key derivation. */
export async function readContainerHeader(path: string, limits: Partial<ContainerLimits> = {}): Promise<ContainerHeader> {
  const file = await open(path, 'r')
  try {
    return (await readHeader(file, (await file.stat()).size, { ...CONTAINER_LIMITS, ...limits })).header
  } finally {
    await file.close()
  }
}

/** The content after the header, read in order. */
interface ContentReader {
  /** Content bytes not read yet. */
  remaining(): number
  /** Reads exactly `length` bytes into the start of `buffer`; past the end is `corrupt`. */
  read(buffer: Buffer, length: number): Promise<void>
  /** Passes over `length` bytes. */
  skip(length: number): Promise<void>
  /** Overwrites what is held in memory. */
  wipe(): void
}

function plainReader(file: FileHandle, start: number, size: number): ContentReader {
  let position = start
  return {
    remaining: () => size - position,
    async read(buffer, length) {
      if (length > size - position) throw new ContainerError('corrupt')
      await readAt(file, buffer, length, position)
      position += length
    },
    async skip(length) {
      if (length > size - position) throw new ContainerError('corrupt')
      position += length
    },
    wipe: () => undefined
  }
}

/**
 * Opens sealed chunks as the content is read (`./encryption`). The chunk count follows from the
 * file size, so the chunk read last is opened as the last: a cut or extended file fails there. No
 * content is handed out before its chunk is authenticated.
 */
function sealedReader(file: FileHandle, start: number, size: number, key: Buffer, header: Buffer): ContentReader {
  const total = plainBytes(size - start)
  if (total === null) throw new ContainerError('corrupt')
  const chunks = Math.ceil((size - start) / (CHUNK_BYTES + TAG_BYTES))
  const sealed = Buffer.allocUnsafe(CHUNK_BYTES + TAG_BYTES)
  let position = start
  let index = 0
  let current: Buffer = Buffer.alloc(0)
  let at = 0
  let consumed = 0
  const next = async () => {
    const length = Math.min(CHUNK_BYTES + TAG_BYTES, size - position)
    await readAt(file, sealed, length, position)
    const opened = openChunk(key, header, index, index === chunks - 1, sealed.subarray(0, length))
    if (opened === null) throw new ContainerError('corrupt')
    current.fill(0)
    current = opened
    at = 0
    index++
    position += length
  }
  const read = async (buffer: Buffer, length: number) => {
    if (length > total - consumed) throw new ContainerError('corrupt')
    let offset = 0
    while (offset < length) {
      if (at === current.length) await next()
      const step = Math.min(current.length - at, length - offset)
      current.copy(buffer, offset, at, at + step)
      at += step
      offset += step
    }
    consumed += length
  }
  return {
    remaining: () => total - consumed,
    read,
    async skip(length) {
      // Skipped content is still opened, so it is still authenticated.
      const scratch = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(1, length)))
      for (let left = length; left > 0;) {
        const step = Math.min(scratch.length, left)
        await read(scratch, step)
        left -= step
      }
      scratch.fill(0)
    },
    wipe: () => current.fill(0)
  }
}

/**
 * Reads and checks a container without trusting it: magic and version, header, entry order and
 * kinds, managed names (no path components), each declared length against what the file actually
 * holds, the limits, and the manifest's per-kind totals against the entries: an entry beyond what
 * the manifest declares for its kind is refused before any of it is written, so extraction never
 * writes more than the manifest declares. An encrypted file needs its `contentKey`
 * (`./encryption`); every chunk is authenticated before its content is used, and a plain file given
 * a key is refused. With `extractTo`, the database is written to `<extractTo>/xidao.sqlite`, draft
 * images to `draft-images/` and offline originals to `images/` under it (new files only; nothing
 * else is written). `checkManifest` sees the manifest as soon as it is read, before any content is
 * extracted, and may throw (or reject) to refuse the file. Throws `ContainerError`; whether the
 * schema version can be imported is the caller's decision.
 */
export async function readContainer(
  path: string,
  options: {
    limits?: Partial<ContainerLimits>
    extractTo?: string
    signal?: AbortSignal
    contentKey?: Buffer
    checkManifest?: (manifest: ExportManifest) => void | Promise<void>
  } = {}
): Promise<ContainerContents> {
  const limits = { ...CONTAINER_LIMITS, ...options.limits }
  const file = await open(path, 'r')
  let content: ContentReader | null = null
  try {
    const size = (await file.stat()).size
    const { header, bytes: headerBytes } = await readHeader(file, size, limits)
    if (header.encryption === null) {
      // The file changed since its header was read for the passphrase.
      if (options.contentKey !== undefined) throw new ContainerError('corrupt')
      content = plainReader(file, headerBytes.length, size)
    } else {
      if (options.contentKey === undefined) throw new ContainerError('unsupported')
      content = sealedReader(file, headerBytes.length, size, options.contentKey, headerBytes)
    }
    const reader = content
    const readExact = async (length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length)
      await reader.read(buffer, length)
      return buffer
    }

    let manifest: ExportManifest | null = null
    const entries: ContainerEntry[] = []
    const kinds = { [ENTRY_TYPE.database]: 'database', [ENTRY_TYPE.draftImage]: 'draftImages', [ENTRY_TYPE.offlineImage]: 'offlineImages' } as const
    const actual = { database: { count: 0, bytes: 0 }, draftImages: { count: 0, bytes: 0 }, offlineImages: { count: 0, bytes: 0 } }
    const seen = new Set<string>()
    let previous: EntryType = ENTRY_TYPE.manifest
    let total = 0
    if (options.extractTo !== undefined) {
      await mkdir(join(options.extractTo, DRAFT_IMAGES_DIRECTORY), { recursive: true })
      await mkdir(join(options.extractTo, OFFLINE_IMAGES_DIRECTORY), { recursive: true })
    }
    for (;;) {
      options.signal?.throwIfAborted()
      const prefix = await readExact(3)
      const type = prefix.readUInt8(0) as EntryType
      const nameLength = prefix.readUInt16BE(1)
      const check = (ENTRY_NAME_CHECK as Partial<Record<number, (name: string) => boolean>>)[type]
      if (check === undefined || nameLength > MAX_NAME_BYTES) throw new ContainerError('corrupt')
      const name = decodeName(await readExact(nameLength))
      const declared = (await readExact(8)).readBigUInt64BE(0)
      if (!check(name) || declared > BigInt(Number.MAX_SAFE_INTEGER)) throw new ContainerError('corrupt')
      const bytes = Number(declared)

      if (manifest === null) {
        if (type !== ENTRY_TYPE.manifest) throw new ContainerError('corrupt')
        if (bytes > limits.maxManifestBytes) throw new ContainerError('too-large')
        let parsed: unknown
        try {
          parsed = JSON.parse(decodeName(await readExact(bytes)))
        } catch (error) {
          throw error instanceof ContainerError ? error : new ContainerError('corrupt')
        }
        manifest = parseManifest(parsed)
        // Secrets travel only encrypted, and only a file with secrets is encrypted.
        if (manifest === null || manifest.includes.secrets !== (header.encryption !== null)) throw new ContainerError('corrupt')
        await options.checkManifest?.(manifest)
        continue
      }
      if (type === ENTRY_TYPE.end) {
        if (bytes !== 0 || reader.remaining() !== 0) throw new ContainerError('corrupt')
        break
      }
      // After the manifest: exactly one database, then images grouped by kind.
      const inOrder = previous === ENTRY_TYPE.manifest ? type === ENTRY_TYPE.database : type >= ENTRY_TYPE.draftImage && type >= previous
      if (!inOrder) throw new ContainerError('corrupt')
      const key = `${type}:${name}`
      if (seen.has(key)) throw new ContainerError('corrupt')
      seen.add(key)
      if (entries.length + 1 > limits.maxEntries) throw new ContainerError('too-large')
      total += bytes
      if (total > limits.maxTotalBytes) throw new ContainerError('too-large')
      if (bytes > reader.remaining()) throw new ContainerError('corrupt')
      // Never more of a kind than the manifest declares: extraction stays within its totals.
      const of = kinds[type as ContentEntryType]
      actual[of].count++
      actual[of].bytes += bytes
      if (actual[of].count > manifest.entries[of].count || actual[of].bytes > manifest.entries[of].bytes) throw new ContainerError('corrupt')

      if (options.extractTo === undefined) await reader.skip(bytes)
      else {
        const target = await open(extractPath(options.extractTo, type as ContentEntryType, name), 'wx')
        const chunk = Buffer.allocUnsafe(Math.min(CHUNK, Math.max(1, bytes)))
        try {
          for (let left = bytes; left > 0;) {
            options.signal?.throwIfAborted()
            const step = Math.min(chunk.length, left)
            await reader.read(chunk, step)
            let offset = 0
            while (offset < step) offset += (await target.write(chunk, offset, step - offset)).bytesWritten
            left -= step
          }
          await target.sync()
        } finally {
          chunk.fill(0)
          await target.close()
        }
      }
      entries.push({ type: type as ContentEntryType, name, bytes })
      previous = type
    }

    if (manifest === null || entries[0]?.type !== ENTRY_TYPE.database) throw new ContainerError('corrupt')
    for (const kind of ['database', 'draftImages', 'offlineImages'] as const) {
      if (actual[kind].count !== manifest.entries[kind].count || actual[kind].bytes !== manifest.entries[kind].bytes) throw new ContainerError('corrupt')
    }
    if (!manifest.includes.offlineCopies && actual.offlineImages.count > 0) throw new ContainerError('corrupt')
    return { header, manifest, entries }
  } finally {
    content?.wipe()
    await file.close()
  }
}
