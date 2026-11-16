import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto'
import { isRecord } from '../../shared/theme'

/*
 * Encryption of an export file that carries 饼干凭据 and App UUIDs (see docs/development.md). Node's
 * built-in `crypto` only.
 *
 * Key derivation: scrypt over the 导出口令 (Unicode NFC, UTF-8) with a random salt per file. Its
 * parameters are in the plain-text header and bounded when read (`KDF_LIMITS`): a file asking for
 * more is refused before any work. The 96 derived bytes are three keys: content, secrets and check.
 *
 * Content: everything after the plain-text header, cut into chunks of `CHUNK_BYTES` plain bytes
 * (the last one shorter, never empty), each sealed with AES-256-GCM under the content key:
 *   nonce  12 bytes, the chunk index as uint64 BE in the last 8 (the first 4 are zero)
 *   AAD    the plain-text header exactly as written (magic to the end of its JSON), then one byte:
 *          1 for the last chunk, 0 for every other
 *   bytes  the ciphertext (as long as the plain text), then the 16-byte tag
 * The key is the file's own (its salt is random), so no (key, nonce) pair is used twice. A chunk
 * moved elsewhere fails under its new index; a changed header fails every chunk; a file cut short
 * or extended fails at its last chunk, which was not sealed as the last. Nothing is used before its
 * chunk is authenticated.
 *
 * Check: HMAC-SHA256 of a fixed label under the check key, in the header. It tells a wrong
 * passphrase from a damaged file before any content is read.
 *
 * Secrets: in the file's database each 饼干凭据 and App UUID is also sealed on its own under the
 * secret key (AES-256-GCM, random nonce, AAD naming its table and ID), so neither the export's
 * temporary files nor the import's staging ever hold one in plain text.
 */

export const CHUNK_BYTES = 64 * 1024
export const TAG_BYTES = 16
const NONCE_BYTES = 12
const KEY_BYTES = 32
const SALT_BYTES = 32
const CHECK_LABEL = 'xidao-export-passphrase-check'

/** The `encryption` slot of the plain-text header. `salt` and `check` are base64. */
export interface EncryptionParams {
  cipher: 'aes-256-gcm'
  kdf: { name: 'scrypt'; salt: string; N: number; r: number; p: number }
  check: string
}

/** scrypt cost of new files: 128 MiB of memory, under a second on current machines. */
export const KDF_DEFAULTS = { N: 2 ** 17, r: 8, p: 1 } as const

/** The most a file may ask for: at most 256 MiB of memory (128·N·r) and 4 passes of it. */
export const KDF_LIMITS = { maxN: 2 ** 18, maxR: 16, maxP: 4, maxMemory: 256 * 1024 * 1024 } as const

export interface ExportKeys {
  /** Seals the file's content (chunks). */
  content: Buffer
  /** Seals each secret in the file's database. */
  secrets: Buffer
}

/** Overwrites the keys once they are no longer needed. */
export function wipeKeys(keys: ExportKeys): void {
  keys.content.fill(0)
  keys.secrets.fill(0)
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function base64(value: unknown, minBytes: number, maxBytes: number): Buffer | null {
  if (typeof value !== 'string' || !BASE64.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  return bytes.length >= minBytes && bytes.length <= maxBytes ? bytes : null
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

/**
 * The header's encryption parameters: `null` when not well formed, `'over-limit'` when the key
 * derivation asks for more than `KDF_LIMITS`. Only the documented fields are kept.
 */
export function parseEncryptionParams(value: unknown): EncryptionParams | 'over-limit' | null {
  if (!isRecord(value) || value.cipher !== 'aes-256-gcm' || !isRecord(value.kdf) || value.kdf.name !== 'scrypt') return null
  const { salt, N, r, p } = value.kdf
  if (base64(salt, 16, 64) === null || base64(value.check, 32, 32) === null) return null
  if (!positiveInteger(N) || !positiveInteger(r) || !positiveInteger(p) || N < 2 || (N & (N - 1)) !== 0) return null
  if (N > KDF_LIMITS.maxN || r > KDF_LIMITS.maxR || p > KDF_LIMITS.maxP || 128 * N * r > KDF_LIMITS.maxMemory) return 'over-limit'
  return { cipher: 'aes-256-gcm', kdf: { name: 'scrypt', salt: salt as string, N, r, p }, check: value.check as string }
}

function scryptAsync(password: Buffer, salt: Buffer, length: number, options: ScryptOptions): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>()
  scrypt(password, salt, length, options, (error, key) => (error ? reject(error) : resolve(key)))
  return promise
}

async function derive(passphrase: string, kdf: EncryptionParams['kdf']): Promise<{ keys: ExportKeys; check: Buffer }> {
  const password = Buffer.from(passphrase.normalize('NFC'), 'utf8')
  // OpenSSL needs 128·r·(N + p + 2) bytes; the bound above keeps this within KDF_LIMITS.
  const maxmem = 128 * kdf.r * (kdf.N + kdf.p + 2) + 1024 * 1024
  const material = await scryptAsync(password, Buffer.from(kdf.salt, 'base64'), KEY_BYTES * 3, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem })
  password.fill(0)
  const keys = { content: Buffer.from(material.subarray(0, KEY_BYTES)), secrets: Buffer.from(material.subarray(KEY_BYTES, KEY_BYTES * 2)) }
  const check = createHmac('sha256', material.subarray(KEY_BYTES * 2)).update(CHECK_LABEL).digest()
  material.fill(0)
  return { keys, check }
}

/** Parameters and keys for a new file, with a new random salt. */
export async function newEncryption(passphrase: string): Promise<{ params: EncryptionParams; keys: ExportKeys }> {
  const kdf = { name: 'scrypt' as const, salt: randomBytes(SALT_BYTES).toString('base64'), ...KDF_DEFAULTS }
  const { keys, check } = await derive(passphrase, kdf)
  return { params: { cipher: 'aes-256-gcm', kdf, check: check.toString('base64') }, keys }
}

/** The file's keys; null when the passphrase is not the file's. */
export async function unlockEncryption(passphrase: string, params: EncryptionParams): Promise<ExportKeys | null> {
  const { keys, check } = await derive(passphrase, params.kdf)
  if (timingSafeEqual(check, Buffer.from(params.check, 'base64'))) return keys
  wipeKeys(keys)
  return null
}

function chunkNonce(index: number): Buffer {
  const nonce = Buffer.alloc(NONCE_BYTES)
  nonce.writeBigUInt64BE(BigInt(index), NONCE_BYTES - 8)
  return nonce
}

function chunkAad(header: Buffer, last: boolean): Buffer {
  return Buffer.concat([header, Buffer.from([last ? 1 : 0])])
}

/** Seals chunk `index` (`last`: the file's last chunk): ciphertext then tag. */
export function sealChunk(key: Buffer, header: Buffer, index: number, last: boolean, plain: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, chunkNonce(index), { authTagLength: TAG_BYTES })
  cipher.setAAD(chunkAad(header, last))
  return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()])
}

/** Opens a sealed chunk; null when it does not authenticate at that index and place. */
export function openChunk(key: Buffer, header: Buffer, index: number, last: boolean, sealed: Buffer): Buffer | null {
  if (sealed.length <= TAG_BYTES) return null
  const decipher = createDecipheriv('aes-256-gcm', key, chunkNonce(index), { authTagLength: TAG_BYTES })
  decipher.setAAD(chunkAad(header, last))
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES))
  try {
    return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()])
  } catch {
    return null
  }
}

/** Sealed size of `plain` content bytes (at least one). */
export function sealedBytes(plain: number): number {
  return plain + Math.ceil(plain / CHUNK_BYTES) * TAG_BYTES
}

/** Plain size of `sealed` content bytes; null when no sequence of chunks has that size. */
export function plainBytes(sealed: number): number | null {
  if (sealed <= TAG_BYTES) return null
  const chunks = Math.ceil(sealed / (CHUNK_BYTES + TAG_BYTES))
  const last = sealed - (chunks - 1) * (CHUNK_BYTES + TAG_BYTES)
  return last > TAG_BYTES ? sealed - chunks * TAG_BYTES : null
}

/** A secret sealed under the secret key: nonce, ciphertext, tag. `label` names its table and ID. */
export function sealSecret(key: Buffer, label: string, secret: string): Buffer {
  const nonce = randomBytes(NONCE_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(label, 'utf8'))
  const plain = Buffer.from(secret, 'utf8')
  const sealed = Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  plain.fill(0)
  return sealed
}

/** Opens a sealed secret; null when it does not authenticate under `label`. */
export function openSecret(key: Buffer, label: string, sealed: Uint8Array): string | null {
  const bytes = Buffer.from(sealed)
  if (bytes.length < NONCE_BYTES + TAG_BYTES) return null
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, NONCE_BYTES), { authTagLength: TAG_BYTES })
  decipher.setAAD(Buffer.from(label, 'utf8'))
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES))
  try {
    const plain = Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)), decipher.final()])
    const secret = plain.toString('utf8')
    plain.fill(0)
    return secret
  } catch {
    return null
  }
}
