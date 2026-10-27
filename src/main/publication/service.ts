import { randomUUID } from 'node:crypto'
import { lstat } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import type { DraftSaveInput } from '../../shared/drafts'
import { isUnsettled, type PublicationApi, type PublicationAttempt, type PublicationProblem, type SubmitInput, type SubmitResult, type PoPrompt } from '../../shared/publication'
import type { AppStore } from '../storage/contract'
import type { DraftService } from '../drafts/service'
import type { ManagedImageFiles } from '../images/files'
import type { SecretProtector } from '../identity/protection'
import { ForumReadError, type ForumClient } from '../forum/contract'
import { userhashCookieValue } from '../forum/userhash'
import { PUBLISH_DEADLINE_MS, type PublicationAdapter, type PublicationFinish, type PublishReport } from './contract'
import { findSentPost, type CheckOutcome } from './check'

/** Wait after a send ends `unknown` / `unconfirmed` before its one check: the forum shows new posts late. */
const CHECK_AFTER_SEND_MS = 10_000
/** Pause after a check that read the forum, before the next one starts. */
const CHECK_GAP_MS = 1_000

/** A send whose intent is recorded and whose request has not produced a recorded result yet. */
export interface InFlightPublication {
  attempt: PublicationAttempt
  /** Original deadline (epoch ms): intent time + the publish limit. Nothing ever moves it. */
  deadline: number
  /** Settles with the attempt as recorded at the end of this run (`null`: unreadable). */
  done: Promise<PublicationAttempt | null>
}

export interface PublicationService extends PublicationApi {
  recover(): Promise<void>
  /** Discard only uncommitted prompts when the renderer goes away; in-flight writes continue. */
  releasePrompts(): void
  /** Started sends that are still running. */
  inFlight(): InFlightPublication[]
  /**
   * On: results are being reached without a window (the app is finishing a quit). A failed or
   * unknown result then keeps a launch notice for the next start.
   */
  setUnattended(on: boolean): void
  /**
   * The send's original deadline passed while finishing: records it as unknown — or as sent with
   * the ID unconfirmed when the forum already accepted the POST — with a launch notice. It is never
   * sent again. Returns the recorded attempt; `null` when it is not running or recording failed
   * (it is then listed by `unstoredResults`).
   */
  abandon(attemptId: string): Promise<PublicationAttempt | null>
  /**
   * Results reached by this process that could not be written to storage, each as it should have
   * been recorded. Their attempts stay `sending` in storage (recovered as unknown at a later start).
   */
  unstoredResults(): PublicationAttempt[]
  /** Writes those results again (never sends). `true` when none is left unstored. */
  retryUnstored(): Promise<boolean>
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
  /** Publish limit of one send from its intent; the adapter's POST limit. */
  deadlineMs?: number
  /** The one automatic check per send; tests shorten it or switch it off (`null`). */
  checks?: { afterSendMs?: number | null; onRecover?: boolean; gapMs?: number }
}): PublicationService {
  const { store, drafts, files, protector, adapter } = deps
  const now = deps.now ?? (() => new Date())
  const deadlineMs = deps.deadlineMs ?? PUBLISH_DEADLINE_MS
  // Active secrets, in the form sent (one actual cookie, however it was written when imported):
  // local credential IDs can change when a cookie is removed and reimported.
  const busy = new Set<string>()
  const editorAttempts = new Map<string, PublicationAttempt>()
  const submissions = new Map<string, Promise<SubmitResult>>()
  const prompts = new Map<string, { input: SubmitInput; prompt: PoPrompt }>()
  const resolving = new Set<string>()
  const running = new Map<string, Running>()
  // Main-process lifetime, not window lifetime. Re-enabling the persistent setting clears it.
  let suppressed = false
  let recovered = false
  let unattended = false
  /**
   * Per attempt: the writes that could not reach storage, best first (the result itself, then an
   * `unknown` fallback the store always accepts, so only a storage failure keeps one here).
   */
  const unstored = new Map<string, { attempt: PublicationAttempt; writes: PublicationFinish[] }>()
  const afterSendMs = deps.checks?.afterSendMs === undefined ? CHECK_AFTER_SEND_MS : deps.checks.afterSendMs
  const gapMs = deps.checks?.gapMs ?? CHECK_GAP_MS
  /** Queued or running check per attempt; all checks run one after another. */
  const queued = new Map<string, Promise<CheckRun>>()
  let line: Promise<unknown> = Promise.resolve()

  interface CheckRun {
    /** The attempt as stored after the check; null when storage could not be read. */
    attempt: PublicationAttempt | null
    /** The forum was read. */
    read: boolean
  }

  interface Running extends InFlightPublication {
    /** The forum reported the POST a success; only the ID confirmation is left. */
    accepted: boolean
    abandoned: boolean
  }

  /** Stores the first write the store accepts; `null` when none could be written (kept unstored). */
  async function persist(attempt: PublicationAttempt, writes: PublicationFinish[]): Promise<PublicationAttempt | null> {
    for (const write of writes) {
      try {
        const stored = await store.finishPublication(write)
        unstored.delete(attempt.id)
        return stored
      } catch { /* Try the next write. */ }
    }
    const best = writes[0]!
    unstored.set(attempt.id, {
      attempt: { ...attempt, state: best.state, problem: best.problem, postId: best.postId, threadId: best.threadId, updatedAt: best.at },
      writes
    })
    return null
  }

  async function secret(id: string | null): Promise<string> {
    if (id === null || !(await protector.isAvailable())) throw new Refusal('identity')
    const ciphertext = await store.loadCredentialCiphertext(id)
    if (ciphertext === null) throw new Refusal('identity')
    try { return await protector.decrypt(ciphertext) }
    catch { throw new Refusal('identity') }
  }

  /**
   * The one read-only check (never sends) of a send whose result was lost (`unknown`) or whose post
   * could not be named (`unconfirmed`). A single matching post confirms it. Anything else — no
   * match, several, a failed or throttled read, no 饼干 ID or no usable cookie — fails an unknown
   * send as `unverified` (its content goes to a draft) and leaves an unconfirmed one as sent.
   */
  async function check(attemptId: string): Promise<CheckRun> {
    let attempt: PublicationAttempt | null
    try { attempt = await store.getPublication(attemptId) } catch { return { attempt: null, read: false } }
    // A running send (or one whose result waits for storage) has its own outcome coming.
    if (attempt === null || (attempt.state !== 'unknown' && attempt.state !== 'unconfirmed') || running.has(attemptId) || unstored.has(attemptId)) {
      return { attempt, read: false }
    }
    let found: Extract<CheckOutcome, { kind: 'found' }> | null = null
    let read = false
    try {
      if (attempt.cookieId === null) throw new Refusal('identity')
      const userhash = await secret(attempt.payload.credentialId)
      const claimed = new Set((await store.listPublications()).flatMap(other =>
        other.id !== attemptId && other.state === 'confirmed' && other.postId !== null ? [other.postId] : []))
      read = true
      const outcome = await findSentPost(attempt, deps.clientFor(userhash), claimed, new AbortController().signal)
      if (outcome.kind === 'found') found = outcome
    } catch { /* Not found, as far as this one check can tell. */ }
    const at = now().toISOString()
    try {
      const stored = found !== null
        ? await store.finishPublication({ id: attemptId, state: 'confirmed', problem: null, postId: found.postId, threadId: found.threadId, at, launchNotice: false })
        : attempt.state === 'unknown' ? await store.failUnverifiedPublication({ id: attemptId, at }) : attempt
      if (!isUnsettled(stored)) for (const [editorId, held] of editorAttempts) if (held.id === attemptId) editorAttempts.delete(editorId)
      return { attempt: stored, read }
    } catch {
      // Storage refused: it stays as it was and is checked again at the next start.
      return { attempt, read }
    }
  }

  function enqueue(attemptId: string): Promise<CheckRun> {
    const existing = queued.get(attemptId)
    if (existing) return existing
    const work = line.then(async () => {
      const result = await check(attemptId)
      if (result.read && gapMs > 0) await sleep(gapMs, undefined, { ref: false })
      return result
    })
    queued.set(attemptId, work)
    line = work.catch(() => undefined)
    void work.finally(() => queued.delete(attemptId)).catch(() => undefined)
    return work
  }

  /** The one automatic check after a send ended `unknown` / `unconfirmed`. */
  function scheduleCheck(attemptId: string) {
    if (afterSendMs === null) return
    setTimeout(() => void enqueue(attemptId), afterSendMs).unref?.()
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

  /**
   * The thread's stored main post names its 饼干 ID; when it belongs to another imported cookie than
   * the one about to send, ask first. Unknown IDs (main post not stored, or no cookie with that ID)
   * never prompt. This is a hint only, never evidence of who sent anything.
   */
  async function promptFor(input: SubmitInput): Promise<PoPrompt | null> {
    if (input.payload.target.kind !== 'reply' || suppressed || !(await store.getPoWarningEnabled())) return null
    const poCookieId = (await store.loadPost(input.payload.target.threadId))?.value.userHash ?? null
    if (poCookieId === null) return null
    const credentials = await store.listCredentials()
    const current = credentials.find(credential => credential.id === input.payload.credentialId)
    if (current?.cookieId === poCookieId) return null
    const po = credentials.find(credential => credential.cookieId === poCookieId)
    if (po === undefined) return null
    let canSwitch = false
    try { await secret(po.id); canSwitch = true } catch { /* Missing/locked PO cookie remains known, but unusable. */ }
    return { token: randomUUID(), currentName: current?.name ?? '不可用的饼干', poName: po.name, poCredentialId: po.id, canSwitch }
  }

  async function run(entry: Running, validated: Awaited<ReturnType<typeof validate>>): Promise<PublicationAttempt | null> {
    const attempt = entry.attempt
    try {
      let report: PublishReport = await adapter.publish({ payload: attempt.payload, userhash: validated.userhash, attachment: validated.attachment,
        onAccepted: () => { entry.accepted = true } })
      if (report.state === 'confirmed') {
        const candidateId = report.postId
        // A post already confirming another attempt is not this send's result (e.g. a stale getLastPost).
        if ((await store.listPublications()).some(other => other.id !== attempt.id && other.state === 'confirmed' && other.postId === candidateId)) {
          report = { state: 'unconfirmed', problem: null }
        }
      }
      const at = now().toISOString()
      // After an abandon, the store keeps the recorded uncertainty unless this is positive evidence.
      const stored = await persist(attempt, [
        { id: attempt.id, state: report.state, problem: report.state === 'confirmed' ? null : report.problem,
          postId: report.state === 'confirmed' ? report.postId : null, threadId: report.state === 'confirmed' ? report.threadId : null,
          at, launchNotice: unattended },
        { id: attempt.id, state: 'unknown', problem: 'storage', postId: null, threadId: null, at, launchNotice: unattended }
      ])
      // Durable intent survives even if recording the result fails. Never expose a retryable failure.
      const result: PublicationAttempt = stored ?? { ...attempt, state: 'unknown', problem: 'storage', updatedAt: at }
      editorAttempts.set(attempt.editorId, result)
      if (!isUnsettled(result)) editorAttempts.delete(attempt.editorId)
      if (stored?.state === 'unknown' || stored?.state === 'unconfirmed') scheduleCheck(attempt.id)
      return result
    } catch {
      const result: PublicationAttempt = { ...attempt, state: 'unknown', problem: 'network', updatedAt: now().toISOString() }
      editorAttempts.set(attempt.editorId, result)
      // If even this cannot be stored, the intent stays sending (recovered as unknown) and is listed as unstored.
      const stored = await persist(attempt, [{ id: attempt.id, state: 'unknown', problem: 'network', postId: null, threadId: null, at: result.updatedAt, launchNotice: unattended }])
      if (stored?.state === 'unknown') scheduleCheck(attempt.id)
      return stored
    } finally {
      running.delete(attempt.id)
      busy.delete(userhashCookieValue(validated.userhash))
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
      const lock = userhashCookieValue(userhash)
      if (busy.has(lock)) return { kind: 'refused', reason: 'busy' }
      busy.add(lock)
      lockedUserhash = lock
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
      const entry: Running = { attempt, deadline: Date.parse(attempt.createdAt) + deadlineMs, done: Promise.resolve(null), accepted: false, abandoned: false }
      running.set(attempt.id, entry)
      entry.done = run(entry, validated)
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
      if (deps.checks?.onRecover === false) return
      // The one check of every send an earlier run left without a result, one after another.
      void (async () => {
        for (const attempt of await store.listPublications()) if (attempt.state === 'unknown') await enqueue(attempt.id)
      })().catch(() => undefined)
    },
    inFlight() {
      return [...running.values()].map(({ attempt, deadline, done }) => ({ attempt, deadline, done }))
    },
    setUnattended(on) { unattended = on },
    async abandon(attemptId) {
      const entry = running.get(attemptId)
      if (!entry || entry.abandoned) return null
      entry.abandoned = true
      const result = await persist(entry.attempt, [{ id: attemptId, state: entry.accepted ? 'unconfirmed' : 'unknown', problem: 'network',
        postId: null, threadId: null, at: now().toISOString(), launchNotice: unattended }])
      if (result !== null) editorAttempts.set(entry.attempt.editorId, result)
      return result
    },
    unstoredResults() {
      return [...unstored.values()].map(({ attempt }) => attempt)
    },
    async retryUnstored() {
      // Whoever retries now decides about the launch notice: a window showing them, or finishing without one.
      for (const { attempt, writes } of [...unstored.values()]) {
        const stored = await persist(attempt, writes.map(write => ({ ...write, launchNotice: unattended })))
        if (stored === null) continue
        for (const [editorId, held] of editorAttempts) {
          if (held.id !== stored.id) continue
          if (isUnsettled(stored)) editorAttempts.set(editorId, stored)
          else editorAttempts.delete(editorId)
        }
        // Stored at last: its one check was waiting for this.
        if (stored.state === 'unknown' || stored.state === 'unconfirmed') scheduleCheck(stored.id)
      }
      return unstored.size === 0
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
    async getPoWarning() { return { enabled: await store.getPoWarningEnabled() } },
    async setPoWarning({ enabled }) {
      try { await store.setPoWarningEnabled(enabled); if (enabled) suppressed = false; return { ok: true, enabled } }
      catch { return { ok: false, enabled: await store.getPoWarningEnabled().catch(() => true) } }
    }
  }
  return api
}
