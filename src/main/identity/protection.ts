import { safeStorage } from 'electron'

/**
 * OS-backed secret protection. Implementations must never fall back to storing or returning
 * plain text: when protection is unavailable, `encrypt`/`decrypt` reject.
 */
export interface SecretProtector {
  isAvailable(): Promise<boolean>
  encrypt(secret: string): Promise<Uint8Array>
  decrypt(ciphertext: Uint8Array): Promise<string>
}

export class ProtectionUnavailableError extends Error {
  override readonly name = 'ProtectionUnavailableError'
  constructor() {
    super('secret protection unavailable')
  }
}

/** Linux backends that are not OS secret storage (hard-coded/in-memory key). */
const PLAIN_TEXT_BACKENDS = new Set(['basic_text', 'unknown'])

/**
 * Electron 45 asynchronous safeStorage: Windows DPAPI, macOS Keychain. On Linux only a real
 * keyring backend (libsecret/kwallet) counts; the `basic_text` fallback is treated as unavailable.
 * Must be created after `app` is ready.
 */
export function createSafeStorageProtector(platform: NodeJS.Platform = process.platform): SecretProtector {
  async function isAvailable(): Promise<boolean> {
    try {
      if (!(await safeStorage.isAsyncEncryptionAvailable())) return false
      return platform !== 'linux' || !PLAIN_TEXT_BACKENDS.has(safeStorage.getSelectedStorageBackend())
    } catch {
      return false
    }
  }
  return {
    isAvailable,
    async encrypt(secret) {
      if (!(await isAvailable())) throw new ProtectionUnavailableError()
      return new Uint8Array(await safeStorage.encryptStringAsync(secret))
    },
    async decrypt(ciphertext) {
      if (!(await isAvailable())) throw new ProtectionUnavailableError()
      const { result } = await safeStorage.decryptStringAsync(Buffer.from(ciphertext))
      return result
    }
  }
}
