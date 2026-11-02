import { randomUUID } from 'node:crypto'
import type { ReadError } from '../../shared/api'
import { comparePostIds, type ContentNode, type Post, type PostId, type ReadingMode, type ThreadPage } from '../../shared/forum'
import { REMINDER_KINDS, type CoverageIssue, type ReminderKind } from '../../shared/reminders'
import { ForumReadError, ReadCancelledError, type ForumClient, type ForumRequestRunner } from '../forum/contract'
import type { RequestScheduler } from '../reading/scheduler'
import type { AppStore } from '../storage/contract'
import { assertReadablePage } from '../storage/coverage'
import type { QuoteSource, ReminderKindState, ReminderUpdate, RuleSnapshot } from './contract'

/** Replies per thread page: the forum splits `ReplyCount` into pages of 19. */
const PAGE_SIZE = 19
/** Network reads (pages and quoted posts) of one thread before the round turns to the next thread. */
const BATCH_READS = 5
const ROUND_READS = 100

/** Page holding reply number `reply` (1-based); page 1 for an empty thread. */
function pageOf(reply: number): number {
  return Math.max(1, Math.ceil(reply / PAGE_SIZE))
}

/** IDs this content explicitly quotes (`>>No.x`), in order of first appearance. */
function quotedPostIds(nodes: ContentNode[], result: Set<PostId> = new Set()): Set<PostId> {
  for (const node of nodes) {
    if (node.type === 'quoteRef' && !node.readingOnly) result.add(node.postId)
    else if ('children' in node) quotedPostIds(node.children, result)
  }
  return result
}

interface KindRun {
  rule: RuleSnapshot
  state: ReminderKindState | undefined
  issues: Set<CoverageIssue>
  error: ReadError | null
  done: boolean
}
/** Quote pages still to read in this check; committed page by page. */
interface QuoteRun {
  /** First read after enabling: only the last page, for the initial checked reply ID. */
  init: boolean
  replyCount: number
  /** First page of this check's new range: where the first new reply after the baseline is. */
  first: number
  next: number
  last: number
  checked: PostId
  /** `next` page as read, kept across batches until its quoted posts are resolved. */
  page: ThreadPage | null
  sources: Map<PostId, QuoteSource> | null
  refs: PostId[]
}
type Step = 'all' | 'po' | 'quote'
interface ThreadRun {
  threadId: string
  /** At least one actual request started this round, even if it failed or the batch is partial. */
  attempted: boolean
  kinds: Partial<Record<ReminderKind, KindRun>>
  steps: Step[]
  /** Page 1 read by this check, per mode. */
  first: Partial<Record<ReadingMode, ThreadPage>>
  /** Modes whose reply-count read was refused without a cookie; read again with the browse cookie. */
  withCookie: Set<ReadingMode>
  quote: QuoteRun | null
}

export interface RoundEngineDeps {
  store: AppStore
  client: Pick<ForumClient, 'getThreadPage' | 'getRef'>
  scheduler: RequestScheduler
  now(): string
  changed(): void
  /** Reuses ordinary cache cleanup after each batch. */
  afterBatch?(): Promise<void>
}

/**
 * One check of every enabled kind (ADR 0001): 全串 and PO compare page 1's reply count of their mode
 * with the baseline; 引用 reads only the pages after its checked position. A batch holds at most five
 * network reads of one thread, then the next thread follows; a thread resumes in later batches.
 * A rate limit or captcha stops the whole round at once. Threads whose counts grew are added to
 * `increased`.
 */
export async function runReminderRound(deps: RoundEngineDeps, input: {
  rules: RuleSnapshot[]
  signal: AbortSignal
  increased: Set<string>
  roundId?: string
}): Promise<{ rateLimited: boolean; complete: boolean }> {
  const { store, now } = deps
  const roundId = input.roundId ?? randomUUID()
  const states = new Map((await store.reminderStates()).map((state) => [`${state.threadId}:${state.kind}`, state]))
  const cookieIds = new Set(await store.reminderCookieIds())
  const hasCookie = (await store.listCredentials()).length > 0
  const runs: ThreadRun[] = []
  let remaining = ROUND_READS
  let complete = true
  for (const threadId of new Set(input.rules.map((rule) => rule.threadId))) {
    const kinds: ThreadRun['kinds'] = {}
    for (const rule of input.rules.filter((item) => item.threadId === threadId)) {
      kinds[rule.kind] = { rule, state: states.get(`${threadId}:${rule.kind}`), issues: new Set(), error: null, done: false }
    }
    const steps: Step[] = []
    if (kinds.all || kinds.quote) steps.push('all')
    if (kinds.po) steps.push('po')
    if (kinds.quote) steps.push('quote')
    runs.push({ threadId, attempted: false, kinds, steps, first: {}, withCookie: new Set(), quote: null })
  }

  async function write(run: ThreadRun, kind: ReminderKind, update: Omit<ReminderUpdate, 'threadId' | 'kind' | 'generation' | 'at'>): Promise<void> {
    const applied = await store.updateReminderState({ ...update, roundId, threadId: run.threadId, kind, generation: run.kinds[kind]!.rule.generation, at: now() })
    if (applied && (update.add ?? 0) > 0) input.increased.add(run.threadId)
  }
  /** Saves the kind's issues of this check and marks it checked. */
  async function finish(run: ThreadRun, kind: ReminderKind, checked = true): Promise<void> {
    const value = run.kinds[kind]
    if (!value || value.done) return
    value.done = true
    if (!checked || value.issues.size > 0 || value.error !== null) complete = false
    await write(run, kind, { issues: [...value.issues], lastError: value.error, checked })
  }
  /**
   * The kind stops before it finished this check. Quote pages still unread (this check's, or a
   * previous check's 尚未补完 not reached yet) stay 尚未补完 and resume next time.
   */
  async function interrupt(run: ThreadRun, kind: ReminderKind, error: ReadError | null): Promise<void> {
    const value = run.kinds[kind]
    if (!value || value.done) return
    if (error !== null) {
      value.issues.add(error.kind === 'not-found' ? 'not-found' : error.kind === 'rate-limited' ? 'rate-limited' : 'read-failed')
      value.error = error
    }
    if (kind === 'quote' && (run.quote !== null || value.state?.issues.includes('incomplete'))) value.issues.add('incomplete')
    await finish(run, kind, run.attempted)
  }
  function drop(run: ThreadRun, step: Step): void {
    run.steps = run.steps.filter((item) => item !== step)
  }

  /** Each transport request consumes one slot, including a separately scheduled page-100 probe. */
  function requestRunner(run: ThreadRun, budget: { remaining: number }): ForumRequestRunner {
    return (signal, work) => deps.scheduler.run('background', signal, async (requestSignal) => {
      if (requestSignal.aborted) throw new ReadCancelledError()
      run.attempted = true
      budget.remaining--
      remaining--
      return work(requestSignal)
    })
  }
  async function readPage(budget: { remaining: number }, run: ThreadRun, mode: ReadingMode, number: number, anonymous: boolean): Promise<ThreadPage | null> {
    if (input.signal.aborted) throw new ReadCancelledError()
    // Reserve room for a possible probe without charging for an HTTP request that never happens.
    const reserve = number > 100 ? 2 : 1
    if (Math.min(budget.remaining, remaining) < reserve) return null
    const value = await deps.client.getThreadPage(run.threadId, mode, number, input.signal, { anonymous, requestRunner: requestRunner(run, budget) })
    assertReadablePage(value, await store.getThreadCoverage(value.threadId, value.mode))
    await store.saveThreadPage(value, now())
    return value
  }

  /** Page 1 of `mode`: its reply count against the 全串 or PO baseline; 全部 also sets up the quote pages. */
  async function countStep(run: ThreadRun, mode: ReadingMode, budget: { remaining: number }): Promise<boolean> {
    let page: ThreadPage | null
    try {
      // Reply counts need no identity; a refusal is read once more with the browse cookie.
      page = await readPage(budget, run, mode, 1, !run.withCookie.has(mode))
    } catch (error) {
      if (!(error instanceof ForumReadError) || error.error.kind !== 'permission' || !hasCookie || run.withCookie.has(mode)) throw error
      run.withCookie.add(mode)
      return true
    }
    if (page === null) return false
    run.first[mode] = page
    const replyCount = page.replyCount
    const kind: ReminderKind = mode === 'all' ? 'all' : 'po'
    const value = run.kinds[kind]
    if (value) {
      const baseline = value.state?.baseline ?? null
      const firstPageReplyIds = page.replySequenceIntact === true && replyCount !== null && Number.isSafeInteger(replyCount)
        && page.replies.length === Math.min(PAGE_SIZE, replyCount)
        && page.replies.every((reply, index) => index === 0 || comparePostIds(page.replies[index - 1]!.id, reply.id) < 0)
        ? page.replies.map((reply) => reply.id) : undefined
      if (replyCount === null) value.issues.add('count-invalid')
      else if (baseline !== null && replyCount > baseline) {
        await write(run, kind, { baseline: replyCount, add: replyCount - baseline, firstPage: pageOf(baseline + 1), firstPageReplyIds })
      } else {
        if (baseline !== null && replyCount < baseline) value.issues.add('count-decreased')
        await write(run, kind, { baseline: replyCount, firstPageReplyIds })
      }
      await finish(run, kind)
    }
    drop(run, mode)
    if (mode === 'all' && run.kinds.quote) await startQuote(run, page)
    return true
  }

  async function startQuote(run: ThreadRun, first: ThreadPage): Promise<void> {
    const value = run.kinds.quote!
    const replyCount = first.replyCount
    const checked = value.state?.checkedPostId ?? null
    const verified = value.state?.baseline ?? 0
    const highest = first.replies.reduce((max, reply) => comparePostIds(reply.id, max) > 0 ? reply.id : max, run.threadId)
    if (replyCount === null) {
      value.issues.add('count-invalid')
      await interrupt(run, 'quote', null)
    } else if (checked === null && pageOf(replyCount) === 1 && first.skippedItems > 0) {
      value.issues.add('incomplete')
      await interrupt(run, 'quote', null)
    } else if (checked === null && pageOf(replyCount) === 1) await write(run, 'quote', { baseline: replyCount, checkedPostId: highest })
    else if (checked === null) {
      run.quote = { init: true, replyCount, first: pageOf(replyCount), next: pageOf(replyCount), last: pageOf(replyCount), checked: run.threadId, page: null, sources: null, refs: [] }
      return
    } else if (replyCount < verified) {
      value.issues.add('count-decreased')
      await write(run, 'quote', { baseline: replyCount })
    } else if (replyCount > verified) {
      run.quote = { init: false, replyCount, first: pageOf(verified + 1), next: pageOf(verified + 1), last: pageOf(replyCount), checked, page: null, sources: null, refs: [] }
      return
    }
    await finish(run, 'quote')
    drop(run, 'quote')
  }

  /**
   * One quote page: its replies newer than the checked ID are new. A quoted post is mine when it is a
   * confirmed own publication, else when its 饼干 ID (stored, or read by a controlled quote read)
   * matches an imported cookie's. A reply counts once however many of my posts it quotes.
   */
  async function quoteStep(run: ThreadRun, budget: { remaining: number }): Promise<boolean> {
    const q = run.quote!
    const value = run.kinds.quote!
    if (q.page === null) {
      const page = (q.next === 1 ? run.first.all : undefined) ?? await readPage(budget, run, 'all', q.next, false)
      if (page === null) return false
      q.page = page
      q.sources = null
    }
    const page = q.page
    const stop = async () => {
      run.quote = null
      await finish(run, 'quote', !value.issues.has('incomplete'))
      drop(run, 'quote')
      return true
    }
    if (page.skippedItems > 0) {
      value.issues.add('incomplete')
      return stop()
    }
    const highest = page.replies.reduce((max, reply) => comparePostIds(reply.id, max) > 0 ? reply.id : max, q.checked)
    if (q.init) {
      // An empty last page proves no position; the next check reads it again.
      if (page.replies.length === 0) value.issues.add('incomplete')
      else await write(run, 'quote', { baseline: q.replyCount, checkedPostId: highest })
      return stop()
    }
    if (page.replies.length === 0) {
      // A page the reply count says has replies came back empty: stop here, the next check resumes at it.
      value.issues.add('incomplete')
      return stop()
    }
    const quotes = page.replies.filter((reply) => comparePostIds(reply.id, q.checked) > 0).map((reply) => [...quotedPostIds(reply.content)])
    if (q.sources === null) {
      const ids = [...new Set(quotes.flat())]
      q.sources = new Map((ids.length > 0 ? await store.reminderQuoteSources(ids) : []).map((source) => [source.postId, source]))
      // Without any known 饼干 ID a quote read could not match anything.
      q.refs = cookieIds.size === 0 ? [] : [...q.sources.values()].filter((source) => !source.own && source.cookieId === null)
        .map((source) => source.postId).sort(comparePostIds)
    }
    while (q.refs.length > 0) {
      const id = q.refs[0]!
      let post: Post
      try {
        if (input.signal.aborted) throw new ReadCancelledError()
        if (Math.min(budget.remaining, remaining) < 1) return false
        post = await deps.client.getRef(id, input.signal, { requestRunner: requestRunner(run, budget) })
      } catch (error) {
        // Not obtained: the reply stays unverified, never a non-match. A rate limit stops the round.
        if (!(error instanceof ForumReadError) || error.error.kind === 'rate-limited') throw error
        complete = false
        q.refs.shift()
        continue
      }
      await store.savePost(post, now())
      q.sources.set(id, { postId: id, own: false, cookieId: post.userHash })
      q.refs.shift()
    }
    let add = 0
    let unverified = 0
    for (const ids of quotes) {
      const sources = ids.map((id) => q.sources!.get(id)!)
      if (sources.some((source) => source.own || (source.cookieId !== null && cookieIds.has(source.cookieId)))) add++
      else if (cookieIds.size > 0 && sources.some((source) => source.cookieId === null)) unverified++
    }
    if (unverified > 0) complete = false
    const last = q.next === q.last
    await write(run, 'quote', { baseline: last ? q.replyCount : q.next * PAGE_SIZE, checkedPostId: highest, add, firstPage: q.first, unverified })
    q.checked = highest
    q.page = null
    q.next++
    return last ? stop() : true
  }

  /** A read of the current step failed: its kinds keep their counts and rules, and get the issue. */
  async function failStep(run: ThreadRun, error: ReadError): Promise<void> {
    const step = run.steps[0]!
    const affected: ReminderKind[] = step === 'po' ? ['po'] : step === 'all' ? ['all', 'quote'] : ['quote']
    for (const kind of affected) await interrupt(run, kind, error)
    run.quote = null
    for (const kind of affected) drop(run, kind)
  }

  let rateLimit: ReadError | null = null
  try {
    while (rateLimit === null && !input.signal.aborted && remaining > 0 && runs.some((run) => run.steps.length > 0)) {
      const before = remaining
      for (const run of runs) {
        if (rateLimit !== null || input.signal.aborted || remaining === 0) break
        if (run.steps.length === 0) continue
        const budget = { remaining: BATCH_READS }
        try {
          while (run.steps.length > 0) {
            const step = run.steps[0]!
            if (!(step === 'quote' ? await quoteStep(run, budget) : await countStep(run, step, budget))) break
          }
        } catch (error) {
          if (input.signal.aborted || error instanceof ReadCancelledError) break
          if (!(error instanceof ForumReadError)) throw error
          await failStep(run, error.error)
          if (error.error.kind === 'rate-limited') rateLimit = error.error
        }
        await deps.afterBatch?.()
        deps.changed()
      }
      // Only page+probe work may remain with a single round slot. Resume it next round.
      if (remaining === before) break
    }
  } finally {
    // Saved counts and positions stay. A rate limit marks every kind it kept from finishing.
    // Attempted threads rotate even after failure; untouched threads keep next-round priority.
    for (const run of runs) for (const kind of REMINDER_KINDS) {
      if (rateLimit !== null) await interrupt(run, kind, rateLimit)
      else if (run.steps.length > 0 && run.kinds[kind] && !run.kinds[kind]!.done) await interrupt(run, kind, null)
    }
    const increased = await store.reminderIncreasedThreads(roundId)
    input.increased.clear()
    for (const threadId of increased) input.increased.add(threadId)
    deps.changed()
  }
  return { rateLimited: rateLimit !== null, complete: complete && !input.signal.aborted && runs.every((run) => run.steps.length === 0) }
}
