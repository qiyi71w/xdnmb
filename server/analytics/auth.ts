import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import type { ScryptOptions } from 'node:crypto'

// Single-administrator HTTP Basic authentication for the private dashboard. The server
// only holds an scrypt hash of the password (Node's built-in implementation); the
// password itself never appears in configuration, logs or dashboard assets.

const DEFAULT_COST = 32768
const BLOCK_SIZE = 8
const PARALLELISM = 1
const KEY_LENGTH = 32
const SALT_LENGTH = 16
const MAX_MEMORY = 128 * 1024 * 1024
/** Verified credentials skip the deliberately slow scrypt check for a short while. */
const VERIFIED_TTL_MS = 10 * 60 * 1000
const VERIFIED_CACHE_SIZE = 8

export interface PasswordHash {
  cost: number
  blockSize: number
  parallelism: number
  salt: Buffer
  key: Buffer
}

/** `throttled`: the credentials would need a fresh scrypt check and no capacity was available. */
export type AdminCheck = 'ok' | 'missing' | 'invalid' | 'throttled'

/**
 * Capacity for fresh password checks. A check reserves before scrypt starts, so concurrent
 * attempts cannot all pass while earlier checks are still running; a successful check is refunded,
 * so only failed attempts use up the budget.
 */
export interface VerificationAdmission {
  reserve(): boolean
  refund(): void
}

export interface AdminAuthenticator {
  check(authorization: string | undefined, admission: VerificationAdmission): Promise<AdminCheck>
}

export interface AdminAuthenticatorOptions {
  username: string
  passwordHash: PasswordHash
  clock: () => number
}

/** Encodes as `scrypt$<N>$<r>$<p>$<salt base64url>$<key base64url>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const key = await derive(password, salt, { N: DEFAULT_COST, r: BLOCK_SIZE, p: PARALLELISM })
  return ['scrypt', DEFAULT_COST, BLOCK_SIZE, PARALLELISM, salt.toString('base64url'), key.toString('base64url')].join('$')
}

export function parsePasswordHash(encoded: string): PasswordHash {
  const parts = encoded.trim().split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') throw new Error('admin password hash must be an scrypt$… value from hash-password')
  const [cost, blockSize, parallelism] = parts.slice(1, 4).map(Number) as [number, number, number]
  const salt = Buffer.from(parts[4] ?? '', 'base64url')
  const key = Buffer.from(parts[5] ?? '', 'base64url')
  const powerOfTwo = Number.isSafeInteger(cost) && cost >= 16384 && (cost & (cost - 1)) === 0
  if (!powerOfTwo || !Number.isSafeInteger(blockSize) || blockSize < 1 || blockSize > 32 ||
      !Number.isSafeInteger(parallelism) || parallelism < 1 || parallelism > 16 ||
      salt.length < SALT_LENGTH || key.length !== KEY_LENGTH) {
    throw new Error('admin password hash has unsupported parameters')
  }
  return { cost, blockSize, parallelism, salt, key }
}

export function createAdminAuthenticator(options: AdminAuthenticatorOptions): AdminAuthenticator {
  const expectedUser = digest(options.username)
  const verified = new Map<string, number>()

  return {
    async check(authorization, admission) {
      const match = /^Basic ([A-Za-z0-9+/=]{1,512})$/.exec(authorization ?? '')
      if (!match?.[1]) return 'missing'
      const cacheKey = digest(match[1]).toString('base64')
      const now = options.clock()
      const expiresAt = verified.get(cacheKey)
      if (expiresAt !== undefined && expiresAt > now) return 'ok'
      verified.delete(cacheKey)
      if (!admission.reserve()) return 'throttled'

      const decoded = Buffer.from(match[1], 'base64').toString('utf8')
      const separator = decoded.indexOf(':')
      if (separator < 0) return 'invalid'
      const userMatches = timingSafeEqual(digest(decoded.slice(0, separator)), expectedUser)
      const { passwordHash } = options
      const key = await derive(decoded.slice(separator + 1), passwordHash.salt, {
        N: passwordHash.cost, r: passwordHash.blockSize, p: passwordHash.parallelism
      })
      if (!userMatches || !timingSafeEqual(key, passwordHash.key)) return 'invalid'
      admission.refund()

      for (const [entry, entryExpiry] of verified) if (entryExpiry <= now) verified.delete(entry)
      if (verified.size >= VERIFIED_CACHE_SIZE) verified.delete(verified.keys().next().value as string)
      verified.set(cacheKey, now + VERIFIED_TTL_MS)
      return 'ok'
    }
  }
}

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  const { promise, resolve, reject } = Promise.withResolvers<Buffer>()
  scrypt(password.normalize('NFC'), salt, KEY_LENGTH, { ...options, maxmem: MAX_MEMORY }, (error, key) => {
    if (error) reject(error)
    else resolve(key)
  })
  return promise
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}
