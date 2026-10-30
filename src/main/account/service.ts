import type { StorageStatus } from '../../shared/api'
import type { AccountApi, AccountCookie, AccountOverview, AccountResult } from '../../shared/account'
import type { AccountSessionStore } from '../storage/contract'
import type { SecretProtector } from '../identity/protection'
import type { IdentityService } from '../identity/service'
import type { AccountLoginSession } from './login'
import type { AccountClient } from './client'
import { AccountError } from './protocol'

export type AccountService = AccountApi & { cancel(): void }
export function createAccountService(deps: {
  store: AccountSessionStore
  protector: SecretProtector
  storageState: () => StorageStatus['state']
  identities: Pick<IdentityService, 'importExport'>
  client: AccountClient
  openLogin: (signal: AbortSignal) => Promise<AccountLoginSession>
  now?: () => number
}): AccountService {
  const now = deps.now ?? Date.now
  let queue: Promise<unknown> = Promise.resolve()
  let active: AbortController | null = null
  let listedIds = new Set<string>()
  let generation = 0
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }
  async function blocker(): Promise<AccountOverview['blocker']> {
    if (deps.storageState() !== 'ready') return 'storage'
    return await deps.protector.isAvailable() ? null : 'protection-unavailable'
  }
  async function stored() {
    const saved = await deps.store.loadAccountSession()
    if (!saved) return null
    const expiry = Date.parse(saved.expiresAt)
    if (!Number.isFinite(expiry) || expiry <= now()) {
      listedIds.clear()
      await deps.store.clearAccountSession()
      return null
    }
    return saved
  }
  async function secret(): Promise<string> {
    const saved = await stored()
    if (!saved) throw new AccountError('expired')
    try { return await deps.protector.decrypt(saved.ciphertext) }
    catch {
      listedIds.clear()
      throw new AccountError('protection-unavailable')
    }
  }
  function operation<T>(work: (signal: AbortSignal) => Promise<T>): Promise<AccountResult<T>> {
    const expectedGeneration = generation
    return serial<AccountResult<T>>(async () => {
      try {
        const blocked = await blocker()
        if (blocked) return { ok: false, reason: blocked }
        if (generation !== expectedGeneration) throw new AccountError('cancelled')
        const controller = new AbortController()
        active = controller
        return { ok: true, value: await work(controller.signal) }
      } catch (error) {
        const reason = active?.signal.aborted ? 'cancelled' : error instanceof AccountError ? error.reason : 'storage'
        if (reason === 'expired') {
          listedIds.clear()
          try { await deps.store.clearAccountSession() } catch { return { ok: false, reason: 'storage' } }
        }
        return { ok: false, reason }
      } finally { active = null }
    })
  }
  async function listWith(value: string, signal: AbortSignal): Promise<AccountCookie[]> {
    const cookies = await deps.client.list(value, signal)
    listedIds = new Set(cookies.map((cookie) => cookie.id))
    return cookies
  }
  return {
    getOverview: () => serial<AccountOverview>(async () => {
      try {
        const blocked = await blocker()
        if (blocked === 'storage') return { available: false, blocker: blocked, loggedIn: false, expiresAt: null }
        const saved = await stored()
        return { available: blocked === null, blocker: blocked, loggedIn: saved !== null, expiresAt: saved?.expiresAt ?? null }
      } catch { return { available: false, blocker: 'storage', loggedIn: false, expiresAt: null } }
    }),
    login: () => operation(async (signal) => {
      const saved = await stored()
      if (saved) return listWith(await secret(), signal)
      listedIds.clear()
      const login = await deps.openLogin(signal)
      if (signal.aborted) throw new AccountError('cancelled')
      if (Date.parse(login.expiresAt) <= now() || !Number.isFinite(Date.parse(login.expiresAt))) throw new AccountError('expired')
      let ciphertext: Uint8Array
      try { ciphertext = await deps.protector.encrypt(login.secret) }
      catch { throw new AccountError('protection-unavailable') }
      if (signal.aborted) throw new AccountError('cancelled')
      await deps.store.saveAccountSession({ ciphertext, expiresAt: login.expiresAt })
      return listWith(login.secret, signal)
    }),
    list: () => operation(async (signal) => listWith(await secret(), signal)),
    importSelected: ({ ids }) => operation(async (signal) => {
      if (!ids.length || ids.length > 1000 || new Set(ids).size !== ids.length || ids.some((id) => !listedIds.has(id))) throw new AccountError('blocked')
      const value = await secret()
      const payloads: Array<{ id: string; payload: string }> = []
      // Finish all reads before any local insert, so failed exports never hide a partial import.
      for (const id of ids) payloads.push({ id, payload: await deps.client.exportCookie(id, value, signal) })
      const imported = []
      for (const { id, payload } of payloads) {
        if (signal.aborted) throw new AccountError('cancelled')
        imported.push({ id, result: await deps.identities.importExport(payload, null) })
      }
      return imported
    }),
    forget() {
      generation++
      active?.abort()
      return serial<AccountResult<null>>(async () => {
        listedIds.clear()
        try { await deps.store.clearAccountSession(); return { ok: true, value: null } }
        catch { return { ok: false, reason: 'storage' } }
      })
    },
    cancel() { generation++; active?.abort() }
  }
}
