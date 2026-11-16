import { userhashCookieValue } from '../forum/userhash'
import type { SecretProtector } from '../identity/protection'
import type { SecretRows } from '../storage/export-snapshot'
import type { ImportSecrets } from '../storage/import-staging'
import { openSecret, sealSecret } from './encryption'

/*
 * The secrets of an export file, in the main process (the only place they are ever decrypted):
 * this machine's 饼干凭据 and App UUIDs decrypted by its protector and sealed under the file's
 * secret key for export; on import, the file's opened with that key and encrypted by this
 * machine's protector. Decrypted values live only in memory here; nothing is logged.
 */

/** A secret could not be decrypted (this machine's protector, or the file's seal). */
export class SecretsUnreadableError extends Error {
  override readonly name = 'SecretsUnreadableError'
}

const credentialLabel = (id: number) => `credentials:${id}`
const appCredentialLabel = (id: string) => `subscription_app_credentials:${id}`

async function decrypted(protector: SecretProtector, ciphertext: Uint8Array): Promise<string> {
  try {
    return await protector.decrypt(ciphertext)
  } catch (error) {
    throw new SecretsUnreadableError('secret not decryptable', { cause: error })
  }
}

/** Export: every secret row decrypted by this machine's protector, sealed under `key`. */
export async function sealForExport(rows: SecretRows, protector: SecretProtector, key: Buffer): Promise<SecretRows> {
  const credentials = []
  for (const row of rows.credentials) {
    credentials.push({ id: row.id, value: sealSecret(key, credentialLabel(row.id), await decrypted(protector, row.value)) })
  }
  const appCredentials = []
  for (const row of rows.appCredentials) {
    appCredentials.push({ id: row.id, value: sealSecret(key, appCredentialLabel(row.id), await decrypted(protector, row.value)) })
  }
  return { credentials, appCredentials }
}

/**
 * Import: every file secret opened under `key` and encrypted by this machine's protector, and this
 * machine's secrets identical to one of them: a 饼干凭据 by the cookie value it sends (as importing
 * a 饼干 compares), an App UUID by its value. One of this machine's that cannot be decrypted is
 * not compared and stays as it is.
 */
export async function resealForImport(file: SecretRows, local: SecretRows, protector: SecretProtector, key: Buffer): Promise<ImportSecrets> {
  const open = (label: string, value: Uint8Array): string => {
    const secret = openSecret(key, label, value)
    if (secret === null) throw new SecretsUnreadableError('file secret does not open')
    return secret
  }
  const encrypt = async (secret: string): Promise<Uint8Array> => {
    try {
      return await protector.encrypt(secret)
    } catch (error) {
      throw new SecretsUnreadableError('secret not encryptable', { cause: error })
    }
  }
  const resealed: SecretRows = { credentials: [], appCredentials: [] }
  const fileCredentials = new Map<string, number>()
  for (const row of file.credentials) {
    const secret = open(credentialLabel(row.id), row.value)
    resealed.credentials.push({ id: row.id, value: await encrypt(secret) })
    const cookie = userhashCookieValue(secret)
    if (!fileCredentials.has(cookie)) fileCredentials.set(cookie, row.id)
  }
  const fileAppCredentials = new Set<string>()
  for (const row of file.appCredentials) {
    const secret = open(appCredentialLabel(row.id), row.value)
    resealed.appCredentials.push({ id: row.id, value: await encrypt(secret) })
    fileAppCredentials.add(secret)
  }

  const localSecret = (ciphertext: Uint8Array): Promise<string | null> => protector.decrypt(ciphertext).catch(() => null)
  const sameCredentials: ImportSecrets['sameCredentials'] = []
  for (const row of local.credentials) {
    const secret = fileCredentials.size === 0 ? null : await localSecret(row.value)
    const fileId = secret === null ? undefined : fileCredentials.get(userhashCookieValue(secret))
    if (fileId !== undefined) sameCredentials.push({ localId: row.id, ciphertext: row.value, fileId })
  }
  const sameAppCredentials: ImportSecrets['sameAppCredentials'] = []
  for (const row of local.appCredentials) {
    const secret = fileAppCredentials.size === 0 ? null : await localSecret(row.value)
    if (secret !== null && fileAppCredentials.has(secret)) sameAppCredentials.push({ localId: row.id, ciphertext: row.value })
  }
  return { file: resealed, sameCredentials, sameAppCredentials }
}
