import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import type { DraftSaveInput } from '../../shared/drafts'
import type { PublicationApi, PublicationAttempt, PublicationProblem, SubmitInput, SubmitResult, PoPrompt } from '../../shared/publication'
import type { AppStore } from '../storage/contract'
import type { DraftService } from '../drafts/service'
import type { ManagedImageFiles } from '../images/files'
import type { SecretProtector } from '../identity/protection'
import { ForumReadError, type ForumClient } from '../forum/contract'
import type { PublicationAdapter, PublishReport } from './contract'

export interface PublicationService extends PublicationApi {
  recover(): Promise<void>
  /** Discard only uncommitted prompts when the renderer goes away; in-flight writes continue. */
  releasePrompts(): void
}
class Refusal extends Error {
  constructor(readonly reason: PublicationProblem) { super(reason) }
}

export function createPublicationService(deps: {
  store: AppStore
  drafts: DraftService
  files: ManagedImageFiles
  protector: SecretProtector
  clientFor: (userhash: string) => ForumClient
  adapter: PublicationAdapter
  now?: () => Date
}): PublicationService {
  const { store, drafts, files, protector, adapter } = deps
  const now = deps.now ?? (() => new Date())
  // Active secrets only: local credential IDs can change when a cookie is removed and reimported.
  const busy = new Set<string>()
  const editorAttempts = new Map<string, PublicationAttempt>()
  const submissions = new Map<string, Promise<SubmitResult>>()
  const prompts = new Map<string, { input: SubmitInput; prompt: PoPrompt }>()
  const resolving = new Set<string>()
  // Main-process lifetime, not window lifetime. Re-enabling the persistent setting clears it.
  let suppressed = false
  let recovered = false

  async function secret(id: string | null): Promise<string> {
    if (id === null || !(await protector.isAvailable())) throw new Refusal('identity')
    const ciphertext = await store.loadCredentialCiphertext(id)
    if (ciphertext === null) throw new Refusal('identity')
    try { return await protector.decrypt(ciphertext) }
    catch { throw new Refusal('identity') }
  }

  async function validate(payload: DraftSaveInput, userhash: string) {
    if (!recovered || store.status.state !== 'ready') throw new Refusal('storage')
    if (payload.fields.content.trim() === '' && payload.attachmentId === null) throw new Refusal('empty')
    let attachment: { path: string; format: string } | null = null
    if (payload.attachmentId !== null) {
      const record = await store.getDraftAttachment(payload.attachmentId)
      const path = record === null ? null : files.pathOf(record.fileName)
      if (record === null || path === null) throw new Refusal('attachment')
      try { if (!(await lstat(path)).isFile()) throw new Error('missing') }
      catch { throw new Refusal('attachment') }
      attachment = { path, format: record.format }
    }
    // Never use the mutable browse/default identity to validate a fixed posting target.
    const client = deps.clientFor(userhash)
    let forumId: string | null
    let directory
    try {
      const signal = new AbortController().signal
      forumId = payload.target.kind === 'thread' ? payload.target.forumId
        : (await client.getThreadPage(payload.target.threadId, 'all', 1, signal)).head.forumId
      directory = await client.getDirectory(signal)
    } catch (error) {
      if (error instanceof ForumReadError) {
        if (error.error.kind === 'rate-limited') throw new Refusal('rate-limited')
        if (error.error.kind === 'network') throw new Refusal('network')
        if (error.error.kind === 'identity' || error.error.kind === 'permission') throw new Refusal('identity')
      }
      throw new Refusal('target')
    }
    const forum = directory.groups.flatMap(group => group.forums).find(item => item.id === forumId)
    if (forum === undefined) throw new Refusal('target')
    const last = await store.lastPublicationAt(payload.credentialId!, forum.id)
    if (last !== null && forum.postIntervalSeconds !== null && now().getTime() - Date.parse(last) < forum.postIntervalSeconds * 1000) throw new Refusal('interval')
    return { userhash, attachment, forumId: forum.id }
  }

  async function promptFor(input: SubmitInput): Promise<PoPrompt | null> {
    if (input.payload.target.kind !== 'reply' || suppressed || !(await store.getPoWarningEnabled())) return null
    const threadId = input.payload.target.threadId
    const own = (await store.listOwnPosts()).find(post => post.isThread && post.postId === threadId && post.threadId === threadId)
    if (!own || own.credentialId === null || own.credentialId === input.payload.credentialId) return null
    const credentials = await store.listCredentials()
    const current = credentials.find(credential => credential.id === input.payload.credentialId)
    const po = credentials.find(credential => credential.id === own.credentialId)
    let canSwitch = false
    try { await secret(own.credentialId); canSwitch = true } catch { /* Missing/locked PO remains known, but unusable. */ }
    return { token: randomUUID(), currentName: current?.name ?? '不可用的饼干', poName: po?.name ?? '已移除的 PO 饼干', poCredentialId: own.credentialId, canSwitch }
  }

  async function run(attempt: PublicationAttempt, validated: Awaited<ReturnType<typeof validate>>) {
    try {
      let report: PublishReport = await adapter.publish({ payload: attempt.payload, userhash: validated.userhash, attachment: validated.attachment })
      if (report.state === 'confirmed') {
        const candidateId = report.postId
        if ((await store.listOwnPosts()).some(post => post.postId === candidateId)) report = { state: 'unconfirmed', problem: null }
      }
      let result: PublicationAttempt
      try {
        result = await store.finishPublication({ id: attempt.id, state: report.state,
          problem: report.state === 'confirmed' ? null : report.problem,
          postId: report.state === 'confirmed' ? report.postId : null,
          threadId: report.state === 'confirmed' ? report.threadId : null, at: now().toISOString() })
      } catch {
        // Durable intent survives even if recording the result fails. Never expose a retryable failure.
        result = { ...attempt, state: 'unknown', problem: 'storage', updatedAt: now().toISOString() }
      }
      editorAttempts.set(attempt.editorId, result)
      if (result.state === 'confirmed' || result.state === 'failed') editorAttempts.delete(attempt.editorId)
    } catch {
      const result: PublicationAttempt = { ...attempt, state: 'unknown', problem: 'network', updatedAt: now().toISOString() }
      editorAttempts.set(attempt.editorId, result)
      try { await store.finishPublication({ id: attempt.id, state: 'unknown', problem: 'network', postId: null, threadId: null, at: result.updatedAt }) } catch { /* Intent remains sending, recovered as unknown. */ }
    } finally {
      busy.delete(validated.userhash)
      await drafts.releaseEditor('publication', attempt.id).catch(() => undefined)
    }
  }

  async function start(input: SubmitInput, bypassPrompt: boolean, switchIdentity = false): Promise<SubmitResult> {
    const previous = (await store.listPublications()).find(attempt => attempt.requestId === input.requestId)
    if (previous) return { kind: 'attempt', attempt: previous }
    const locked = editorAttempts.get(input.editorId)
    if (locked) return { kind: 'attempt', attempt: locked }
    let launched = false
    let lockedUserhash: string | null = null
    // Protect the managed attachment across preflight and the intent transaction.
    const preparation = `prepare-${input.requestId}`
    try {
      if (!recovered || store.status.state !== 'ready') throw new Refusal('storage')
      const userhash = await secret(input.payload.credentialId)
      if (busy.has(userhash)) return { kind: 'refused', reason: 'busy' }
      busy.add(userhash)
      lockedUserhash = userhash
      await drafts.holdAttachment('publication', preparation, input.payload.attachmentId)
      const validated = await validate(input.payload, userhash)
      if (!bypassPrompt) {
        const prompt = await promptFor(input)
        if (prompt !== null) {
          prompts.set(prompt.token, { input, prompt })
          return { kind: 'prompt', prompt }
        }
      }
      const attempt = await store.createPublication({ ...input, forumId: validated.forumId, at: now().toISOString(), switchThreadIdentity: switchIdentity })
      editorAttempts.set(input.editorId, attempt)
      await drafts.holdAttachment('publication', attempt.id, input.payload.attachmentId)
      launched = true
      void run(attempt, validated)
      return { kind: 'attempt', attempt }
    } catch (error) {
      return { kind: 'refused', reason: error instanceof Refusal ? error.reason : 'storage' }
    } finally {
      if (!launched && lockedUserhash !== null) busy.delete(lockedUserhash)
      if (![...prompts.values()].some(item => item.input.requestId === input.requestId)) await drafts.releaseEditor('publication', preparation).catch(() => undefined)
    }
  }

  const api: PublicationService = {
    async recover() {
      if (store.status.state !== 'ready') return
      await store.recoverPublications(now().toISOString())
      recovered = true
    },
    releasePrompts() {
      for (const { input } of prompts.values()) void drafts.releaseEditor('publication', `prepare-${input.requestId}`).catch(() => undefined)
      prompts.clear()
    },
    submit(input) {
      const existing = submissions.get(input.editorId)
      if (existing) return existing
      const prompt = [...prompts.values()].find(item => item.input.editorId === input.editorId)
      if (prompt) return Promise.resolve({ kind: 'prompt', prompt: prompt.prompt })
      const frozen = structuredClone(input)
      const work = start(frozen, false).catch((): SubmitResult => ({ kind: 'refused', reason: 'storage' }))
      submissions.set(input.editorId, work)
      void work.finally(() => submissions.delete(input.editorId))
      return work
    },
    async resolvePrompt({ token, choice, suppress }) {
      const pending = prompts.get(token)
      if (!pending || resolving.has(token)) return { kind: 'refused', reason: 'busy' }
      if (choice === 'cancel') {
        prompts.delete(token)
        await drafts.releaseEditor('publication', `prepare-${pending.input.requestId}`)
        return { kind: 'cancelled' }
      }
      resolving.add(token)
      try {
        if (choice === 'switch' && !pending.prompt.canSwitch) return { kind: 'refused', reason: 'identity' }
        const input = structuredClone(pending.input)
        if (choice === 'switch') input.payload.credentialId = pending.prompt.poCredentialId
        const result = await start(input, true, choice === 'switch')
        if (result.kind === 'attempt' && suppress) suppressed = true
        return result
      } finally {
        prompts.delete(token)
        resolving.delete(token)
        if (!prompts.has(token)) await drafts.releaseEditor('publication', `prepare-${pending.input.requestId}`).catch(() => undefined)
      }
    },
    async listAttempts() {
      try {
        if (store.status.state === 'unavailable') throw new Error('storage')
        const attempts = await store.listPublications()
        return { ok: true, attempts: attempts.map(attempt => [...editorAttempts.values()].find(value => value.id === attempt.id) ?? attempt) }
      } catch { return { ok: false, reason: 'storage' } }
    },
    async getAttempt({ attemptId }) {
      try {
        if (store.status.state === 'unavailable') throw new Error('storage')
        const attempt = [...editorAttempts.values()].find(item => item.id === attemptId) ?? await store.getPublication(attemptId)
        const list = attempt?.state === 'failed' ? await drafts.list() : null
        const draft = list?.ok ? list.drafts.find(item => item.id === attempt?.savedDraftId) ?? null : null
        return { ok: true, attempt, draft }
      } catch { return { ok: false, reason: 'storage' } }
    },
    async listOwnPosts() {
      try {
        if (store.status.state === 'unavailable') throw new Error('storage')
        return { ok: true, posts: await store.listOwnPosts() }
      } catch { return { ok: false, reason: 'storage' } }
    },
    async addOwnPost({ postId, threadId, isThread }) {
      if (isThread !== (postId === threadId)) return { ok: false, reason: 'target' }
      try { await store.addManualOwnPost({ postId, threadId, isThread, at: now().toISOString() }); return { ok: true } }
      catch { return { ok: false, reason: 'storage' } }
    },
    async getPoWarning() { return { enabled: await store.getPoWarningEnabled() } },
    async setPoWarning({ enabled }) {
      try { await store.setPoWarningEnabled(enabled); if (enabled) suppressed = false; return { ok: true, enabled } }
      catch { return { ok: false, enabled: await store.getPoWarningEnabled().catch(() => true) } }
    }
  }
  return api
}
