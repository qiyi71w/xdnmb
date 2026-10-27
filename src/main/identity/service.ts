import type { StorageStatus } from '../../shared/api'
import type {
  CredentialId, CredentialSource, DuplicateCookieId, IdentityMutationResult, IdentityOverview, IdentityRole, ImportResult
} from '../../shared/identity'
import { ForumReadError } from '../forum/contract'
import { userhashCookieValue } from '../forum/userhash'
import { StorageWriteRefusedError, type IdentityStore } from '../storage/contract'
import { validateCookieId } from '../../shared/identity'
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
  /** The 饼干 ID is required; an empty `name` defaults the display name to it. */
  importRaw(userhash: string, cookieId: string, name: string | null): Promise<ImportResult>
  rename(id: CredentialId, name: string): Promise<IdentityMutationResult>
  /** Fills in or replaces the 饼干 ID; only later matching changes. */
  setCookieId(id: CredentialId, cookieId: string): Promise<IdentityMutationResult>
  remove(id: CredentialId): Promise<IdentityMutationResult>
  select(role: IdentityRole, id: CredentialId | null): Promise<IdentityMutationResult>
  /** Stores the credential order; the first credential is the one sent with forum reads. */
  reorder(ids: CredentialId[]): Promise<IdentityMutationResult>
  /**
   * Userhash for forum reads: the first credential in the user's order, `null` only when no
   * credential is stored. Throws ForumReadError(identity/…) when it cannot be decrypted or the list
   * itself cannot be read, so the read is not sent rather than silently sent anonymously or with
   * another credential. The secret is decrypted for each read and never cached.
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

  async function importParsed(parsed: ParsedCredential, source: CredentialSource, typedCookieId: string | null, requestedName: string | null): Promise<ImportResult> {
    if (!parsed.ok) return { ok: false, failure: { reason: 'format', detail: parsed.error } }
    let cookieId: string
    if (parsed.cookieId !== null) {
      cookieId = parsed.cookieId
    } else {
      const checked = validateCookieId(typedCookieId ?? '')
      if (!checked.ok) return { ok: false, failure: { reason: 'cookie-id', detail: checked.error } }
      cookieId = checked.cookieId
    }
    let name: string
    if (requestedName !== null && requestedName.trim() !== '') {
      const checked = validateName(requestedName)
      if (!checked.ok) return { ok: false, failure: { reason: 'name', detail: checked.error } }
      name = checked.name
    } else {
      // The 饼干 ID is the default display name; it stays a separate value when renamed later.
      const checked = validateName(cookieId)
      if (!checked.ok) return { ok: false, failure: { reason: 'name', detail: 'required' } }
      name = checked.name
    }
    if (!writable()) return { ok: false, failure: { reason: 'storage' } }
    if (!(await protector.isAvailable())) return { ok: false, failure: { reason: 'protection-unavailable' } }

    return serialized(async () => {
      // Duplicates are found by decrypting the stored secrets and comparing directly in memory, in the
      // form actually sent: the export form (`+`) and the browser form (`%20`) are one cookie.
      const imported = userhashCookieValue(parsed.userhash)
      const existing = await store.loadCredentialCiphertexts()
      for (const entry of existing) {
        let stored: string
        try {
          stored = await protector.decrypt(entry.ciphertext)
        } catch {
          return { ok: false, failure: { reason: 'decrypt-failed' } }
        }
        if (userhashCookieValue(stored) === imported) {
          const summary = (await store.listCredentials()).find((credential) => credential.id === entry.id)
          if (summary) {
            // Re-importing the same secret only ever fills a missing 饼干 ID: name, order and roles stay.
            let filled = false
            if (summary.cookieId === null) {
              try {
                filled = await store.fillCredentialCookieId(summary.id, cookieId, now().toISOString())
              } catch (error) {
                if (error instanceof StorageWriteRefusedError) return { ok: false, failure: { reason: 'storage' } }
                throw error
              }
            }
            const current = (await store.listCredentials()).find((credential) => credential.id === entry.id) ?? summary
            const outcome: DuplicateCookieId = filled ? 'filled' : current.cookieId === cookieId ? 'same' : 'conflict'
            return { ok: false, failure: { reason: 'duplicate', existing: current, cookieId: outcome } }
          }
        }
      }
      let ciphertext: Uint8Array
      try {
        ciphertext = await protector.encrypt(parsed.userhash)
      } catch {
        return { ok: false, failure: { reason: 'protection-unavailable' } }
      }
      try {
        const credential = await store.insertCredential({ name, cookieId, source, importedAt: now().toISOString(), ciphertext })
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

    importExport: (payload, name) => importParsed(parseExportPayload(payload), 'export', null, name),
    importRaw: (userhash, cookieId, name) => importParsed(parseRawUserhash(userhash), 'raw', cookieId, name),

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

    setCookieId(id, cookieId) {
      const checked = validateCookieId(cookieId)
      if (!checked.ok) return Promise.resolve({ ok: false, reason: 'cookie-id', cookieIdError: checked.error })
      return serialized(async () => {
        try {
          return (await store.setCredentialCookieId(id, checked.cookieId, now().toISOString())) ? { ok: true } : { ok: false, reason: 'not-found' }
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

    reorder(ids) {
      return serialized(async () => {
        try {
          return (await store.reorderCredentials(ids)) ? { ok: true } : { ok: false, reason: 'not-found' }
        } catch (error) {
          return storageFailure(error)
        }
      })
    },

    async browseUserhash() {
      if (deps.storageState() === 'unavailable') throw new ForumReadError({ kind: 'identity', detail: 'identity-unknown' })
      const first = (await store.listCredentials())[0]
      if (first === undefined) return null
      const ciphertext = await store.loadCredentialCiphertext(first.id)
      // Removed between the two reads: never fall back to another credential or to none.
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
