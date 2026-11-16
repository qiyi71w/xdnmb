import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { SecretProtector } from '../../src/main/identity/protection'

/**
 * A machine's secret protection for tests: AES-256-GCM under a key of its own, so two of them
 * cannot decrypt each other's ciphertext (as two machines' system protection cannot).
 * `available: false` behaves like a machine without system protection.
 */
export function testProtector(options: { available?: boolean } = {}): SecretProtector & { available: boolean } {
  const key = randomBytes(32)
  return {
    available: options.available ?? true,
    async isAvailable() {
      return this.available
    },
    async encrypt(secret) {
      if (!this.available) throw new Error('protection unavailable')
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, nonce)
      return new Uint8Array(Buffer.concat([nonce, cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()]))
    },
    async decrypt(ciphertext) {
      if (!this.available) throw new Error('protection unavailable')
      const bytes = Buffer.from(ciphertext)
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(bytes.length - 16))
      return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString('utf8')
    }
  }
}
