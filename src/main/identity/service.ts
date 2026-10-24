import type { StorageStatus } from '../../shared/api'
import type {
  CredentialId, CredentialSource, IdentityMutationResult, IdentityOverview, IdentityRole, ImportResult
} from '../../shared/identity'
import { ForumReadError } from '../forum/contract'
import { StorageWriteRefusedError, type IdentityStore } from '../storage/contract'
import { parseExportPayload, parseRawUserhash, validateName, type ParsedCredential } from './parse'
import type { SecretProtector } from './protection'

/** Stored credentials and role selections cannot be read; distinct from a stored `none`. */
export class IdentityStorageUnavailableError extends Error {
  override readonly name = 'IdentityStorageUnavailableError'
  constructor() {
    super('identity storage unavailable')
  }
}

export interface IdentityService {
  getOverview(): Promise<IdentityOverview>
  importExport(payload: string, name: string | null): Promise<ImportResult>
  importRaw(userhash: string, name: string): Promise<ImportResult>
  rename(id: CredentialId, name: string): Promise<IdentityMutationResult>
  remove(id: CredentialId): Promise<IdentityMutationResult>
  select(role: IdentityRole, id: CredentialId | null): Promise<IdentityMutationResult>
  /**
   * Userhash for forum reads: `null` only when no browse credential is chosen. Throws
   * ForumReadError(identity/…) when the chosen credential was removed, cannot be decrypted, or the
   * choice itself cannot be read, so the read is not sent rather than silently sent anonymously or
   * with another credential. The secret is decrypted for each read and never cached.
   */
  browseUserhash(): Promise<string | null>
}

export function createIdentityService(deps: {
  store: IdentityStore
  protector: SecretProtector
  /** `ready`: read/write; `read-only`: readable, writes refused; `unavailable`: nothing readable. */
  storageState: () => StorageStatus['state']
  now?: () => Date
}): IdentityService {
  const { store, protector } = deps
  const now = deps.now ?? (() => new Date())
  const writable = (): boolean => deps.storageState() === 'ready'
  /** Mutations run one at a time so duplicate checks and inserts cannot interleave. */
  let queue: Promise<unknown> = Promise.resolve()

  function serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }

  function storageFailure(error: unknown): IdentityMutationResult {
    if (error instanceof StorageWriteRefusedError) return { ok: false, reason: 'storage' }
    throw error
  }

  async function importParsed(parsed: ParsedCredential, source: CredentialSource, requestedName: string | null): Promise<ImportResult> {
    if (!parsed.ok) return { ok: false, failure: { reason: 'format', detail: parsed.error } }
    let name: string
    if (requestedName !== null && requestedName.trim() !== '') {
      const checked = validateName(requestedName)
      if (!checked.ok) return { ok: false, failure: { reason: 'name', detail: checked.error } }
      name = checked.name
    } else if (parsed.payloadName !== null) {
      name = parsed.payloadName
    } else {
      return { ok: false, failure: { reason: 'name', detail: 'required' } }
    }
    if (!writable()) return { ok: false, failure: { reason: 'storage' } }
    if (!(await protector.isAvailable())) return { ok: false, failure: { reason: 'protection-unavailable' } }

    return serialized(async () => {
      // Duplicates are found by decrypting the stored secrets and comparing directly in memory.
      const existing = await store.loadCredentialCiphertexts()
      for (const entry of existing) {
        let stored: string
        try {
          stored = await protector.decrypt(entry.ciphertext)
        } catch {
          return { ok: false, failure: { reason: 'decrypt-failed' } }
        }
        if (stored === parsed.userhash) {
          const summary = (await store.listCredentials()).find((credential) => credential.id === entry.id)
          if (summary) return { ok: false, failure: { reason: 'duplicate', existing: summary } }
        }
      }
      let ciphertext: Uint8Array
      try {
        ciphertext = await protector.encrypt(parsed.userhash)
      } catch {
        return { ok: false, failure: { reason: 'protection-unavailable' } }
      }
      try {
        const credential = await store.insertCredential({ name, source, importedAt: now().toISOString(), ciphertext })
        return { ok: true, credential }
      } catch (error) {
        if (error instanceof StorageWriteRefusedError) return { ok: false, failure: { reason: 'storage' } }
        throw error
      }
    })
  }

  return {
    async getOverview() {
      if (deps.storageState() === 'unavailable') throw new IdentityStorageUnavailableError()
      const [credentials, roles, available] = await Promise.all([
        store.listCredentials(), store.loadRoleSelections(), protector.isAvailable()
      ])
      return { protection: available ? 'available' : 'unavailable', writable: writable(), credentials, roles }
    },

    importExport: (payload, name) => importParsed(parseExportPayload(payload), 'export', name),
    importRaw: (userhash, name) => importParsed(parseRawUserhash(userhash), 'raw', name),

    rename(id, name) {
      const checked = validateName(name)
      if (!checked.ok) return Promise.resolve({ ok: false, reason: 'name', nameError: checked.error })
      return serialized(async () => {
        try {
          return (await store.renameCredential(id, checked.name)) ? { ok: true } : { ok: false, reason: 'not-found' }
        } catch (error) {
          return storageFailure(error)
        }
      })
    },

    remove(id) {
      return serialized(async () => {
        try {
          const removed = await store.deleteCredential(id)
          return removed ? { ok: true } : { ok: false, reason: 'not-found' }
        } catch (error) {
          return storageFailure(error)
        }
      })
    },

    select(role, id) {
      return serialized(async () => {
        try {
          return (await store.setRoleSelection(role, id)) ? { ok: true } : { ok: false, reason: 'not-found' }
        } catch (error) {
          return storageFailure(error)
        }
      })
    },

    async browseUserhash() {
      if (deps.storageState() === 'unavailable') throw new ForumReadError({ kind: 'identity', detail: 'identity-unknown' })
      const selection = (await store.loadRoleSelections()).browse
      if (selection.state === 'none') return null
      if (selection.state === 'missing') throw new ForumReadError({ kind: 'identity', detail: 'identity-missing' })
      const ciphertext = await store.loadCredentialCiphertext(selection.credentialId)
      if (ciphertext === null) throw new ForumReadError({ kind: 'identity', detail: 'identity-missing' })
      let userhash: string
      try {
        userhash = await protector.decrypt(ciphertext)
      } catch {
        throw new ForumReadError({ kind: 'identity', detail: 'identity-locked' })
      }
      // The stored value passed import validation; anything else is not sent as a header.
      if (parseRawUserhash(userhash).ok !== true) throw new ForumReadError({ kind: 'identity', detail: 'identity-locked' })
      return userhash
    }
  }
}
