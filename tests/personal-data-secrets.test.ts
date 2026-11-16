import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExportProgress } from '../src/shared/api'
import {
  CONTAINER_MAGIC, CONTAINER_VERSION, ContainerError, DATABASE_NAME, ENTRY_TYPE, readContainer, readContainerHeader, writeContainer,
  type ExportManifest
} from '../src/main/personal-data/container'
import {
  CHUNK_BYTES, KDF_DEFAULTS, newEncryption, openSecret, TAG_BYTES, unlockEncryption, type EncryptionParams
} from '../src/main/personal-data/encryption'
import { createImportService, type ImportDatabase } from '../src/main/personal-data/import'
import { resealForImport } from '../src/main/personal-data/secrets'
import { createExportService } from '../src/main/personal-data/service'
import type { SecretProtector } from '../src/main/identity/protection'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { readExportEstimate, readSecretRows, takeExportSnapshot, trimExportSnapshot } from '../src/main/storage/export-snapshot'
import { importStagingDirectory } from '../src/main/storage/import-journal'
import { checkStagedImport, readLocalCounts, stageImport } from '../src/main/storage/import-staging'
import { MIGRATIONS } from '../src/main/storage/migrations'
import { settleSwap } from '../src/main/storage/swap-journal'
import { testProtector } from './helpers/protector'

const AT = '2026-11-16T08:00:00.000Z'
const SUPPORTED = Math.max(...MIGRATIONS.map((migration) => migration.version))
const PASSPHRASE = '导出口令 correct horse'
// Synthetic secrets: markers that must never appear in any file in plain text.
const USERHASH_1 = 'SYNTHETIC-USERHASH-ONE+abcdef0123456789'
const USERHASH_2 = 'SYNTHETIC-USERHASH-TWO+abcdef0123456789'
const USERHASH_B = 'SYNTHETIC-USERHASH-BEE+abcdef0123456789'
const APP_UUID_A = 'SYNTHETIC-APP-UUID-AAA'
const APP_UUID_B = 'SYNTHETIC-APP-UUID-BBB'
const MARKERS = [USERHASH_1, USERHASH_2, USERHASH_B, APP_UUID_A, APP_UUID_B, PASSPHRASE, 'correct horse']

const folders: string[] = []
const connections: Array<{ close(): void }> = []

afterEach(() => {
  for (const connection of connections.splice(0)) connection.close()
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true })
})

function folder(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  folders.push(path)
  return path
}

/** Every file under `root`, by path. */
function files(root: string): string[] {
  const found: string[] = []
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name)
      if (lstatSync(path).isDirectory()) walk(path)
      else found.push(path)
    }
  }
  if (existsSync(root)) walk(root)
  return found
}

function expectNoPlainSecrets(bytes: Buffer): void {
  for (const marker of MARKERS) {
    for (const encoding of ['utf8', 'utf16le'] as const) expect(bytes.includes(Buffer.from(marker, encoding))).toBe(false)
  }
}

/** Source machine A: two synthetic 饼干 and an App UUID protected by `protector`, and their references. */
async function machineA(protector: SecretProtector): Promise<{ userData: string; generation: number; ciphertexts: Uint8Array[] }> {
  const userData = folder('xidao-secrets-a-')
  mkdirSync(join(userData, 'images'))
  mkdirSync(join(userData, 'draft-images'))
  const ciphertexts = [await protector.encrypt(USERHASH_1), await protector.encrypt(USERHASH_2), await protector.encrypt(APP_UUID_A)]
  const db = openReadingDatabase(join(userData, 'xidao.sqlite'), MIGRATIONS, { appVersion: '1.5.0-a' })
  try {
    db.recordVisit('100', AT)
    const one = db.insertCredential({ name: '甲', cookieId: 'AAAAAAA', source: 'raw', importedAt: AT, ciphertext: ciphertexts[0]! }).id
    const two = db.insertCredential({ name: '乙', cookieId: 'BBBBBBB', source: 'raw', importedAt: AT, ciphertext: ciphertexts[1]! }).id
    db.saveDraft({ draftId: null, target: { kind: 'reply', threadId: '700' }, credentialId: one,
      fields: { content: 'A 的草稿', title: '', name: '', watermark: false }, attachmentId: null }, AT)
    db.setRoleSelection('default-post', one)
    db.setRoleSelection('web-sync', two)
    db.setThreadPostIdentity('700', two, AT)
    db.setSubscriptionAppCredential('uuid-a', ciphertexts[2]!)
    return { userData, generation: db.loadSubscriptionConfiguration().context.generation, ciphertexts }
  } finally {
    db.close()
  }
}

/** Exports `userData` with `passphrase` (null: without secrets) and returns the outcome. */
async function exportOf(userData: string, protector: SecretProtector, passphrase: string | null): Promise<{ outcome: ExportProgress; target: string }> {
  const target = folder('xidao-secrets-file-')
  const { promise, resolve } = Promise.withResolvers<ExportProgress>()
  const service = createExportService({
    databasePath: join(userData, 'xidao.sqlite'),
    draftImagesDirectory: join(userData, 'draft-images'),
    imagesDirectory: join(userData, 'images'),
    appVersion: '1.5.0-a',
    status: () => ({ state: 'ready', schemaVersion: SUPPORTED }),
    sending: () => false,
    database: {
      estimate: async (path) => readExportEstimate(path),
      snapshot: async (path, work) => takeExportSnapshot(path, work),
      secrets: async (path) => readSecretRows(path),
      trim: async (work, options) => trimExportSnapshot(work, options),
      abort: () => undefined
    },
    protector,
    publish(progress) {
      if (progress.status !== 'running') resolve(progress)
    },
    showInFolder: () => undefined,
    freeBytes: async () => 1024 ** 4
  })
  expect(await service.start({ includeOffline: true, passphrase }, async (name) => join(target, name))).toEqual({ status: 'started' })
  return { outcome: await promise, target }
}

async function encryptedExport(protector: SecretProtector): Promise<{ file: string; generation: number; ciphertexts: Uint8Array[] }> {
  const source = await machineA(protector)
  const { outcome, target } = await exportOf(source.userData, protector, PASSPHRASE)
  if (outcome.status !== 'done') throw new Error(`export ${outcome.status}`)
  return { file: join(target, outcome.fileName), generation: source.generation, ciphertexts: source.ciphertexts }
}

/**
 * Target machine B, open as in the app: a 饼干 of its own first in its list, one identical to A's
 * first after it, an identical App UUID and one of its own.
 */
async function machineB(protector: SecretProtector): Promise<{ userData: string; db: ReadingDatabase }> {
  const userData = folder('xidao-secrets-b-')
  mkdirSync(join(userData, 'images'))
  mkdirSync(join(userData, 'draft-images'))
  const db = openReadingDatabase(join(userData, 'xidao.sqlite'), MIGRATIONS, { appVersion: '1.5.0-b' })
  connections.push(db)
  db.insertCredential({ name: 'B 自己的', cookieId: 'CCCCCCC', source: 'raw', importedAt: AT, ciphertext: await protector.encrypt(USERHASH_B) })
  const same = db.insertCredential({ name: 'B 的甲', cookieId: 'AAAAAAA', source: 'raw', importedAt: AT, ciphertext: await protector.encrypt(USERHASH_1) }).id
  db.saveDraft({ draftId: null, target: { kind: 'reply', threadId: '800' }, credentialId: same,
    fields: { content: 'B 的草稿', title: '', name: '', watermark: false }, attachmentId: null }, AT)
  db.setSubscriptionAppCredential('uuid-b-same', await protector.encrypt(APP_UUID_A))
  db.setSubscriptionAppCredential('uuid-b-own', await protector.encrypt(APP_UUID_B))
  return { userData, db }
}

const inProcess: ImportDatabase = {
  check: async (staging, version) => checkStagedImport(staging, version),
  counts: async (path) => readLocalCounts(path),
  secrets: async (path) => readSecretRows(path),
  stage: async (staging, path, file) => stageImport(staging, path, file),
  abort: () => undefined
}

function importer(userData: string, protector: SecretProtector) {
  return createImportService({
    databasePath: join(userData, 'xidao.sqlite'),
    supportedVersion: SUPPORTED,
    status: () => ({ state: 'ready', schemaVersion: SUPPORTED }),
    database: inProcess,
    protector,
    restart: async () => 'exiting'
  })
}

function sql(path: string): Database.Database {
  const db = new Database(path, { readonly: true })
  connections.push(db)
  return db
}

/** A container with secrets around a database entry of `databaseBytes` patterned bytes, sealed with `PASSPHRASE`. */
async function sealedContainer(databaseBytes: number): Promise<{ file: string; params: EncryptionParams; key: Buffer }> {
  const dir = folder('xidao-secrets-sealed-')
  const source = join(dir, 'source.bin')
  writeFileSync(source, Buffer.from(Array.from({ length: databaseBytes }, (_, index) => (index * 7919) % 251)))
  const manifest: ExportManifest = {
    containerVersion: CONTAINER_VERSION, schemaVersion: SUPPORTED, appVersion: '1.5.0', exportedAt: AT,
    includes: { offlineCopies: false, secrets: true }, credentialSequence: 0,
    entries: { database: { count: 1, bytes: databaseBytes }, draftImages: { count: 0, bytes: 0 }, offlineImages: { count: 0, bytes: 0 } },
    stats: { history: 0, sendRecords: 0, offlineThreads: 0 }
  }
  const { params, keys } = await newEncryption(PASSPHRASE)
  const file = join(dir, 'sealed.xidao')
  const handle = await open(file, 'wx')
  const input = await open(source, 'r')
  try {
    await writeContainer(handle, { manifest, sources: [{ type: ENTRY_TYPE.database, name: DATABASE_NAME, bytes: databaseBytes, handle: input }] }, {
      signal: new AbortController().signal, onProgress: () => undefined, encryption: { params, key: keys.content }
    })
  } finally {
    await handle.close()
    await input.close()
  }
  return { file, params, key: keys.content }
}

function headerEnd(bytes: Buffer): number {
  return CONTAINER_MAGIC.length + 6 + bytes.readUInt32BE(CONTAINER_MAGIC.length + 2)
}

/** The file with its header JSON replaced by `change` of it. */
function withHeader(bytes: Buffer, change: (header: { encryption: { kdf: Record<string, unknown> } }) => void): Buffer {
  const end = headerEnd(bytes)
  const header = JSON.parse(bytes.subarray(CONTAINER_MAGIC.length + 6, end).toString('utf8'))
  change(header)
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const fixed = Buffer.from(bytes.subarray(0, CONTAINER_MAGIC.length + 6))
  fixed.writeUInt32BE(json.length, CONTAINER_MAGIC.length + 2)
  return Buffer.concat([fixed, json, bytes.subarray(end)])
}

describe('encrypted export file', () => {
  it('reads back only with the key, and refuses any changed byte, a cut, reordered or extended file', async () => {
    const { file, key } = await sealedContainer(3 * CHUNK_BYTES + 1234)
    const original = readFileSync(file)
    await expect(readContainer(file, { contentKey: key })).resolves.toMatchObject({ manifest: { includes: { secrets: true } } })
    // Without the key, the content is not read at all.
    await expect(readContainer(file)).rejects.toEqual(new ContainerError('unsupported'))

    const end = headerEnd(original)
    const sealedChunk = CHUNK_BYTES + TAG_BYTES
    const chunks = Math.ceil((original.length - end) / sealedChunk)
    expect(chunks).toBe(4)
    const chunk = (index: number) => original.subarray(end + index * sealedChunk, Math.min(original.length, end + (index + 1) * sealedChunk))
    const variants: Array<[string, Buffer]> = []
    const positions = new Set<number>()
    for (let at = 0; at < end; at++) positions.add(at)
    for (let at = end; at < original.length; at += 1021) positions.add(at)
    for (let index = 0; index < chunks; index++) positions.add(Math.min(original.length, end + (index + 1) * sealedChunk) - 1)
    for (let at = original.length - 40; at < original.length; at++) positions.add(at)
    for (const at of positions) {
      const changed = Buffer.from(original)
      changed[at] = changed[at]! ^ 0x01
      variants.push([`byte ${at}`, changed])
    }
    variants.push(
      ['cut by one byte', original.subarray(0, original.length - 1)],
      ['cut at a chunk boundary (last chunk dropped)', original.subarray(0, end + (chunks - 1) * sealedChunk)],
      ['cut to the header', original.subarray(0, end)],
      ['chunks reordered', Buffer.concat([original.subarray(0, end), chunk(1), chunk(0), chunk(2), chunk(3)])],
      ['a chunk repeated in place of another', Buffer.concat([original.subarray(0, end), chunk(0), chunk(0), chunk(2), chunk(3)])],
      ['extended with a chunk', Buffer.concat([original, chunk(0)])],
      ['extended with a byte', Buffer.concat([original, Buffer.of(0)])]
    )
    const dir = folder('xidao-secrets-variant-')
    for (const [name, bytes] of variants) {
      const path = join(dir, 'variant.xidao')
      writeFileSync(path, bytes)
      const extractTo = join(dir, 'out')
      rmSync(extractTo, { recursive: true, force: true })
      mkdirSync(extractTo)
      await expect(readContainer(path, { contentKey: key, extractTo }), name).rejects.toBeInstanceOf(ContainerError)
    }
  }, 120_000)

  it('derives no key from a wrong passphrase, and refuses key derivation beyond its bounds before running it', async () => {
    const { file, params } = await sealedContainer(100)
    expect(params.kdf).toMatchObject(KDF_DEFAULTS)
    expect(await unlockEncryption('导出口令 wrong horse', params)).toBeNull()
    expect(await unlockEncryption(PASSPHRASE, params)).not.toBeNull()
    // The same passphrase typed as decomposed characters (Unicode NFC).
    const composed = await newEncryption('é口令')
    expect(await unlockEncryption('e\u0301口令', composed.params)).not.toBeNull()

    const original = readFileSync(file)
    const dir = folder('xidao-secrets-kdf-')
    const path = join(dir, 'kdf.xidao')
    const refused: Array<[Record<string, unknown>, 'too-large' | 'unsupported']> = [
      [{ N: 2 ** 19 }, 'too-large'],
      [{ N: 2 ** 18, r: 16 }, 'too-large'],
      [{ r: 32 }, 'too-large'],
      [{ p: 5 }, 'too-large'],
      [{ N: 2 ** 40 }, 'too-large'],
      [{ N: 3 * 2 ** 10 }, 'unsupported'],
      [{ N: 1 }, 'unsupported'],
      [{ p: 0 }, 'unsupported'],
      [{ salt: 'not base64!' }, 'unsupported'],
      [{ name: 'argon2' }, 'unsupported']
    ]
    for (const [kdf, kind] of refused) {
      writeFileSync(path, withHeader(original, (header) => { Object.assign(header.encryption.kdf, kdf) }))
      await expect(readContainerHeader(path), JSON.stringify(kdf)).rejects.toEqual(new ContainerError(kind))
    }
    // An import refuses it as damaged, before asking for a passphrase.
    writeFileSync(path, withHeader(original, (header) => { Object.assign(header.encryption.kdf, { N: 2 ** 20 }) }))
    const { userData } = await machineB(testProtector())
    expect(await importer(userData, testProtector()).inspect(async () => path)).toEqual({ status: 'rejected', rejection: { reason: 'corrupt' } })
    // Within the bounds the header is read.
    writeFileSync(path, withHeader(original, (header) => { Object.assign(header.encryption.kdf, { N: 2 ** 18, r: 8, p: 4 }) }))
    await expect(readContainerHeader(path)).resolves.toMatchObject({ encryption: { kdf: { N: 2 ** 18, r: 8, p: 4 } } })
  }, 120_000)

  it('carries 饼干与 App UUID only sealed: no plain text or source ciphertext in the file or its database', async () => {
    const protectorA = testProtector()
    const { file, ciphertexts } = await encryptedExport(protectorA)
    const bytes = readFileSync(file)
    expectNoPlainSecrets(bytes)
    for (const ciphertext of ciphertexts) expect(bytes.includes(Buffer.from(ciphertext))).toBe(false)

    const header = await readContainerHeader(file)
    expect(header.encryption).toMatchObject({ cipher: 'aes-256-gcm', kdf: { name: 'scrypt', ...KDF_DEFAULTS } })
    const keys = (await unlockEncryption(PASSPHRASE, header.encryption!))!
    const out = folder('xidao-secrets-extract-')
    const contents = await readContainer(file, { contentKey: keys.content, extractTo: out })
    expect(contents.manifest.includes).toEqual({ offlineCopies: true, secrets: true })
    // The extracted database (what an import's staging holds) has every secret sealed on its own.
    const database = readFileSync(join(out, DATABASE_NAME))
    expectNoPlainSecrets(database)
    for (const ciphertext of ciphertexts) expect(database.includes(Buffer.from(ciphertext))).toBe(false)
    const db = sql(join(out, DATABASE_NAME))
    const credentials = db.prepare<[], { id: number; ciphertext: Buffer }>('SELECT id, ciphertext FROM credentials ORDER BY id').all()
    expect(credentials.map((row) => openSecret(keys.secrets, `credentials:${row.id}`, row.ciphertext))).toEqual([USERHASH_1, USERHASH_2])
    // A sealed value moved to another row does not open there.
    expect(openSecret(keys.secrets, 'credentials:2', credentials[0]!.ciphertext)).toBeNull()
    const app = db.prepare<[], { id: string; ciphertext: Buffer }>('SELECT id, ciphertext FROM subscription_app_credentials').get()!
    expect(openSecret(keys.secrets, `subscription_app_credentials:${app.id}`, app.ciphertext)).toBe(APP_UUID_A)
  }, 60_000)

  it('fails without leaving a file when a secret cannot be decrypted on this machine', async () => {
    const source = await machineA(testProtector())
    const { outcome, target } = await exportOf(source.userData, testProtector(), PASSPHRASE)
    expect(outcome).toEqual({ status: 'failed', failure: { reason: 'secrets' } })
    expect(readdirSync(target)).toEqual([])
  }, 60_000)

  it('stays the plain format without secrets', async () => {
    const source = await machineA(testProtector())
    const { outcome, target } = await exportOf(source.userData, testProtector(), null)
    if (outcome.status !== 'done') throw new Error('export failed')
    const file = join(target, outcome.fileName)
    expect(await readContainerHeader(file)).toEqual({ encryption: null })
    await expect(readContainer(file)).resolves.toMatchObject({ manifest: { includes: { secrets: false } } })
  }, 60_000)
})

describe('importing an encrypted file', () => {
  it('asks for the passphrase until it is right, then keeps the file’s secrets re-encrypted for this machine', async () => {
    const protectorA = testProtector()
    const protectorB = testProtector()
    const { file, generation, ciphertexts } = await encryptedExport(protectorA)
    // The two machines' protection cannot decrypt each other's ciphertext.
    await expect(protectorB.decrypt(ciphertexts[0]!)).rejects.toThrow()
    const { userData, db } = await machineB(protectorB)
    await expect(protectorA.decrypt(db.loadCredentialCiphertexts()[0]!.ciphertext)).rejects.toThrow()
    const service = importer(userData, protectorB)

    expect(await service.inspect(async () => file)).toEqual({ status: 'passphrase', wrong: false })
    expect(existsSync(importStagingDirectory(userData))).toBe(false)
    expect(await service.submitPassphrase('不对')).toEqual({ status: 'passphrase', wrong: true })
    expect(await service.submitPassphrase('也不对')).toEqual({ status: 'passphrase', wrong: true })
    expect(existsSync(importStagingDirectory(userData))).toBe(false)
    const ready = await service.submitPassphrase(PASSPHRASE)
    expect(ready).toMatchObject({ status: 'ready', summary: { secrets: true, appVersion: '1.5.0-a' } })
    expect(await service.confirm()).toEqual({ status: 'restarting' })
    db.close()
    connections.splice(0)
    expect(settleSwap(join(userData, 'xidao.sqlite'))).toEqual({ kind: 'import', outcome: 'completed' })

    const after = openReadingDatabase(join(userData, 'xidao.sqlite'), MIGRATIONS, { appVersion: '1.5.0-b' })
    connections.push(after)
    // The file's 饼干 keep their IDs and come first; B's identical one is not appended; B's own
    // follows the sequence and the file's list.
    expect(after.listCredentials().map((credential) => [credential.id, credential.name])).toEqual([['1', '甲'], ['2', '乙'], ['3', 'B 自己的']])
    const stored = after.loadCredentialCiphertexts()
    expect(await Promise.all(stored.map((entry) => protectorB.decrypt(entry.ciphertext)))).toEqual([USERHASH_1, USERHASH_2, USERHASH_B])
    for (const entry of stored) await expect(protectorA.decrypt(entry.ciphertext)).rejects.toThrow()
    // Every reference in the file still finds its 饼干.
    expect(after.loadRoleSelections()).toMatchObject({ 'default-post': { state: 'selected', credentialId: '1' }, 'web-sync': { state: 'selected', credentialId: '2' } })
    expect(after.getThreadPostIdentity('700')).toEqual({ state: 'selected', credentialId: '2' })
    expect(after.listDrafts().map((draft) => draft.credentialId)).toEqual(['1'])
    // The subscription configuration's App UUID is in the file: still configured, same generation.
    expect(after.loadSubscriptionConfiguration().context).toMatchObject({ appCredentialId: 'uuid-a', generation })
    expect(after.listSubscriptionAppCredentials().sort()).toEqual(['uuid-a', 'uuid-b-own'])
    expect(await protectorB.decrypt(after.loadSubscriptionAppCiphertext('uuid-a')!)).toBe(APP_UUID_A)
    expect(await protectorB.decrypt(after.loadSubscriptionAppCiphertext('uuid-b-own')!)).toBe(APP_UUID_B)
    // Neither a secret nor the passphrase was written anywhere in plain text.
    for (const path of files(userData)) expectNoPlainSecrets(readFileSync(path))
  }, 60_000)

  it('maps an identical local 饼干 to the file’s ID, so references to it land on the file’s copy', async () => {
    const protectorB = testProtector()
    const { file } = await encryptedExport(testProtector())
    const { userData } = await machineB(protectorB)
    const header = await readContainerHeader(file)
    const keys = (await unlockEncryption(PASSPHRASE, header.encryption!))!
    const staging = folder('xidao-secrets-staging-')
    const { manifest } = await readContainer(file, { contentKey: keys.content, extractTo: staging })
    checkStagedImport(staging, manifest.schemaVersion)
    const local = join(userData, 'xidao.sqlite')
    const secrets = await resealForImport(readSecretRows(join(staging, DATABASE_NAME)), readSecretRows(local), protectorB, keys.secrets)
    expect(secrets.sameCredentials.map(({ localId, fileId }) => [localId, fileId])).toEqual([[2, 1]])
    expect(secrets.sameAppCredentials.map(({ localId }) => localId)).toEqual(['uuid-b-same'])
    const { credentialIds } = stageImport(staging, local, { credentialSequence: manifest.credentialSequence, secrets })
    expect([...credentialIds]).toEqual([[1, 3], [2, 1]])
  }, 60_000)

  it('refuses a file with secrets when this machine cannot protect them, before asking or writing anything', async () => {
    const { file } = await encryptedExport(testProtector())
    const { userData } = await machineB(testProtector())
    const before = files(userData).map((path) => [path, readFileSync(path).toString('base64')])
    const service = importer(userData, testProtector({ available: false }))
    expect(await service.inspect(async () => file)).toEqual({ status: 'rejected', rejection: { reason: 'protection' } })
    expect(existsSync(importStagingDirectory(userData))).toBe(false)
    expect(files(userData).map((path) => [path, readFileSync(path).toString('base64')])).toEqual(before)
  }, 60_000)

  it('refuses a damaged encrypted file after the right passphrase, and gives a locked file up on cancel', async () => {
    const { file } = await encryptedExport(testProtector())
    const { userData } = await machineB(testProtector())
    const service = importer(userData, testProtector())
    const damaged = join(folder('xidao-secrets-damaged-'), 'damaged.xidao')
    const bytes = readFileSync(file)
    bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0x80
    writeFileSync(damaged, bytes)
    expect(await service.inspect(async () => damaged)).toEqual({ status: 'passphrase', wrong: false })
    expect(await service.submitPassphrase(PASSPHRASE)).toEqual({ status: 'rejected', rejection: { reason: 'corrupt' } })
    expect(existsSync(importStagingDirectory(userData))).toBe(false)

    expect(await service.inspect(async () => file)).toEqual({ status: 'passphrase', wrong: false })
    await service.cancel()
    expect(await service.submitPassphrase(PASSPHRASE)).toEqual({ status: 'failed', failure: { reason: 'busy' } })
    expect(await service.confirm()).toEqual({ status: 'failed' })
  }, 60_000)
})
