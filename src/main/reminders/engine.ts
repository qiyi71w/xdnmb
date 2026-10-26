import type { ReadError } from '../../shared/api'
import { comparePostIds, type PostId, type ThreadPage } from '../../shared/forum'
import { threadTotalPages } from '../../shared/threadPages'
import type { CheckRound, RoundStopReason } from '../../shared/reminders'
import { ForumReadError, ReadCancelledError, type ForumClient } from '../forum/contract'
import type { RequestScheduler } from '../reading/scheduler'
import type { AppStore } from '../storage/contract'
import { assertReadablePage } from '../storage/coverage'
import type { ReminderCoverage, RuleSnapshot } from './contract'
import { quotedPostIds } from './evaluation'

interface ModeWork {
  coverage: ReminderCoverage
  rules: RuleSnapshot[]
  phase: 'probe' | 'verify' | 'scan' | 'quote' | 'done'
  fetched: Map<number, ThreadPage>
  target: { page: number; id: string } | null
  probeStart: number | null
  probePage: number | null
  forward: number
  backward: number
  /** The probe moved once to the estimate of a fresher ReplyCount seen on this round's first probe page. */
  reanchored: boolean
  verifyPages: number[]
  nextPage: number
  missingPages: number[] | null
  /** Quoted posts without local content, read one by one through the controlled quote read. */
  pendingRefs: PostId[] | null
}
interface ThreadWork { threadId: string; modes: ModeWork[]; failed: boolean; counted: boolean }
export interface RoundEngineDeps {
  store: AppStore
  client: Pick<ForumClient, 'getThreadPage' | 'getRef'>
  scheduler: RequestScheduler
  now(): string
  changed(): void
  /** Reuses ordinary cache cleanup after confirmed events have their durable snapshots. */
  afterBatch?(): Promise<void>
}
function ids(page: ThreadPage): string[] { return page.replies.map((post) => post.id) }
function issue(work: ModeWork, value: ReminderCoverage['issues'][number]): void {
  if (!work.coverage.issues.includes(value)) work.coverage.issues.push(value)
}

/** One trigger owns one engine. A batch contains at most five network reads (pages or quoted posts) for a thread. */
export async function runReminderRound(deps: RoundEngineDeps, input: {
  round: CheckRound
  rules: RuleSnapshot[]
  signal: AbortSignal
  stopReason(): RoundStopReason | null
}): Promise<{ partial: boolean }> {
  const { store } = deps
  const round = input.round
  const threads: ThreadWork[] = []
  // 饼干 IDs as of this round. A changed set is not a trigger; it makes this check revisit retained replies.
  const cookieIds = await store.reminderCookieIds()
  const cookieRevision = JSON.stringify(cookieIds)
  for (const threadId of new Set(input.rules.map((rule) => rule.threadId))) {
    const rules = input.rules.filter((rule) => rule.threadId === threadId)
    const modes: ModeWork[] = []
    for (const mode of ['all', 'po'] as const) {
      const applicable = rules.filter((rule) => mode === 'po' ? rule.kind === 'po' : rule.kind !== 'po')
      if (applicable.length === 0) continue
      const coverage = await store.getReminderCoverage(threadId, mode)
      coverage.state = 'checking'
      coverage.issues = []
      coverage.lastError = null
      coverage.lastRoundId = round.id
      coverage.updatedAt = deps.now()
      await store.saveReminderCoverage(coverage)
      modes.push({ coverage, rules: applicable, phase: 'probe', fetched: new Map(), target: null,
        probeStart: null, probePage: null, forward: 0, backward: 0, reanchored: false, verifyPages: [], nextPage: 1, missingPages: null, pendingRefs: null })
    }
    threads.push({ threadId, modes, failed: false, counted: false })
  }
  deps.changed()
  let rateLimited = false

  async function persist(work: ModeWork): Promise<void> {
    work.coverage.updatedAt = deps.now()
    await store.saveReminderCoverage(work.coverage)
  }
  async function evaluate(work: ModeWork): Promise<void> {
    if (work.target === null) { await persist(work); return }
    const result = await store.evaluateReminders({ roundId: round.id, threadId: work.coverage.threadId,
      mode: work.coverage.mode, target: work.target?.id ?? null, rules: work.rules, at: deps.now() })
    round.newEvents += result.newEvents
    work.coverage.uncertainCount = result.uncertainCount
    work.coverage.uncertainty = result.uncertainty
    work.coverage.issues = work.coverage.issues.filter((value) => value !== 'boundary-uncertain' && value !== 'quote-unverified')
    if (result.uncertainCount > 0) issue(work, 'boundary-uncertain')
    if (result.quoteUnverified > 0) issue(work, 'quote-unverified')
    if (work.phase === 'done' && work.coverage.state !== 'failed' && work.coverage.state !== 'incomplete') {
      work.coverage.state = result.baselinePending ? 'baseline-pending' : work.coverage.issues.length ? 'uncertain' : 'done'
    }
    await persist(work)
  }
  async function page(work: ModeWork, number: number, budget: { remaining: number }): Promise<ThreadPage | null> {
    if (input.signal.aborted) throw new ReadCancelledError()
    const existing = work.fetched.get(number)
    if (existing) return existing
    if (budget.remaining === 0) return null
    budget.remaining--
    const value = await deps.scheduler.run('background', input.signal,
      (signal) => deps.client.getThreadPage(work.coverage.threadId, work.coverage.mode, number, signal))
    assertReadablePage(value, await store.getThreadCoverage(value.threadId, value.mode))
    // Even when cancellation races a completed read, save its observation, but never continue work.
    await store.saveThreadPage(value, deps.now())
    work.fetched.set(number, value)
    if (value.skippedItems > 0) issue(work, 'gaps')
    return value
  }
  async function freeze(work: ModeWork, lastPage: number, value: ThreadPage): Promise<void> {
    work.target = { page: lastPage, id: ids(value).reduce((max, id) => comparePostIds(id, max) > 0 ? id : max, work.coverage.threadId) }
    work.coverage.probe = null
    const checkpoint = work.coverage.checkpoint
    work.verifyPages = checkpoint ? checkpoint.page > 1 ? [checkpoint.page - 1, checkpoint.page] : [1] : []
    work.phase = checkpoint ? 'verify' : 'scan'
    work.nextPage = 1
    await persist(work)
  }
  async function probe(work: ModeWork, budget: { remaining: number }): Promise<boolean> {
    if (work.probeStart === null) {
      // A saved probe position is continued as is (the bounded probe resumes where it stopped).
      // Otherwise ReplyCount only estimates where to start; the latest stored count is preferred over
      // an older verified end, so a thread that grew is not crawled two pages per trigger.
      const old = work.coverage.probe
      const known = old ? null : await store.getThreadCoverage(work.coverage.threadId, work.coverage.mode)
      const estimate = threadTotalPages(known?.reportedReplyCount ?? null)
      const checkpoint = work.coverage.checkpoint
      if (old) {
        work.probeStart = old.page
        work.reanchored = true
      } else if (checkpoint?.complete) work.probeStart = estimate !== null ? Math.max(checkpoint.page, estimate) : checkpoint.page
      else if (estimate !== null) work.probeStart = estimate
      else {
        const first = await page(work, 1, budget)
        if (!first) return false
        work.probeStart = threadTotalPages(first.replyCount) ?? 1
      }
      work.probePage = work.probeStart
    }
    const number = work.probePage!
    const value = await page(work, number, budget)
    if (!value) return false
    if (!work.reanchored && work.forward === 0 && work.backward === 0 && value.replyCount !== null && value.replies.length > 0) {
      // Bounded: at most one move per round, then the usual two pages forward / backward.
      const fresh = threadTotalPages(value.replyCount)!
      work.reanchored = true
      if (fresh > number + 2) {
        work.probePage = fresh
        return true
      }
    }
    const empty = value.replies.length === 0 && value.skippedItems === 0
    if (empty && number === 1) {
      await freeze(work, 1, value)
      return true
    }
    for (const [candidate, observed] of work.fetched) {
      const successor = work.fetched.get(candidate + 1)
      if (observed.replies.length > 0 && observed.skippedItems === 0 && successor?.replies.length === 0 && successor.skippedItems === 0) {
        await freeze(work, candidate, observed)
        return true
      }
    }
    const direction = empty ? 'backward' : 'forward'
    const used = direction === 'forward' ? work.forward : work.backward
    const next = direction === 'forward' ? number + 1 : Math.max(1, number - 1)
    work.coverage.probe = { page: next, direction }
    await persist(work)
    if (used >= 2 || next === number) {
      issue(work, 'target-unverified')
      work.coverage.state = 'incomplete'
      work.phase = 'done'
      return true
    }
    if (direction === 'forward') work.forward++
    else work.backward++
    work.probePage = next
    return true
  }
  async function verify(work: ModeWork, budget: { remaining: number }): Promise<boolean> {
    for (const number of work.verifyPages) if (!(await page(work, number, budget))) return false
    const checkpoint = work.coverage.checkpoint!
    const previous = checkpoint.page === 1 ? [] : ids(work.fetched.get(checkpoint.page - 1)!)
    const current = ids(work.fetched.get(checkpoint.page)!)
    const previousUnchanged = checkpoint.prevIds.length === previous.length && checkpoint.prevIds.every((id, index) => id === previous[index])
    const currentPrefix = checkpoint.pageIds.length <= current.length && checkpoint.pageIds.every((id, index) => id === current[index])
    if (checkpoint.page > work.target!.page || !previousUnchanged || !currentPrefix) {
      issue(work, 'shifted')
      work.coverage.checkpoint = null
      work.nextPage = 1
    } else {
      work.coverage.checkpoint = { page: checkpoint.page, pageIds: current, prevIds: previous, complete: false }
      work.nextPage = checkpoint.page + 1
    }
    work.phase = 'scan'
    await persist(work)
    return true
  }
  async function scan(work: ModeWork, budget: { remaining: number }): Promise<boolean> {
    if (work.nextPage > work.target!.page) {
      work.phase = 'quote'
      return true
    }
    const number = work.nextPage
    const value = await page(work, number, budget)
    if (!value) return false
    if (value.replies.length === 0 && number < work.target!.page) issue(work, 'gaps')
    const previous = number === 1 ? [] : work.coverage.checkpoint?.pageIds ?? []
    work.coverage.checkpoint = { page: number, pageIds: ids(value), prevIds: previous, complete: false }
    work.nextPage++
    await persist(work)
    return true
  }
  async function quote(work: ModeWork, budget: { remaining: number }): Promise<boolean> {
    const quoteRule = work.rules.find((rule) => rule.kind === 'quote')
    if (quoteRule && work.missingPages === null) {
      const observations = await store.getReminderObservations(work.coverage.threadId, work.coverage.mode)
      const candidates = observations.filter((observation) => observation.replyIds.some((id) =>
        (quoteRule.watermarkPostId === null || comparePostIds(id, quoteRule.watermarkPostId) > 0) && comparePostIds(id, work.target!.id) <= 0))
      const missing = new Set(candidates.filter((observation) => observation.replyIds.some((id, index) =>
        (quoteRule.watermarkPostId === null || comparePostIds(id, quoteRule.watermarkPostId) > 0) &&
        comparePostIds(id, work.target!.id) <= 0 && observation.posts[index] === null)).map((observation) => observation.page))
      // A changed 饼干 ID set revisits retained replies, not their network pages. Only absent content
      // and gaps need reads; the revision advances only after the entire evaluation completes.
      if (work.coverage.quoteCookieRevision !== cookieRevision && candidates.length > 0) {
        const first = candidates[0]!.page // Observations are ordered by page in the worker.
        const present = new Set(observations.filter((observation) => observation.skippedItems === 0).map((observation) => observation.page))
        for (let number = first; number <= work.target!.page; number++) if (!present.has(number)) missing.add(number)
      }
      work.missingPages = [...missing].sort((a, b) => a - b)
    }
    while (work.missingPages?.length) {
      const number = work.missingPages[0]!
      // A page already obtained during this round is not retried endlessly if the server omitted
      // content; its skipped-items evidence remains a coverage issue.
      if (!(await page(work, number, budget))) return false
      work.missingPages.shift()
    }
    if (quoteRule && cookieIds.length > 0 && work.pendingRefs === null) {
      // Whose post a reply quotes is known from the quoted post's 饼干 ID: stored content first, then
      // a controlled quote read by ID. The quoted post's thread is never searched for.
      const observations = await store.getReminderObservations(work.coverage.threadId, work.coverage.mode)
      const quoted = new Set<PostId>()
      for (const observation of observations) {
        observation.replyIds.forEach((id, index) => {
          const post = observation.posts[index]
          if (!post || comparePostIds(id, work.target!.id) > 0) return
          if (quoteRule.watermarkPostId !== null && comparePostIds(id, quoteRule.watermarkPostId) <= 0) return
          quotedPostIds(post.content, quoted)
        })
      }
      const absent: PostId[] = []
      for (const id of quoted) if ((await store.loadPost(id)) === null) absent.push(id)
      work.pendingRefs = absent.sort(comparePostIds)
    }
    while (work.pendingRefs?.length) {
      const id = work.pendingRefs[0]!
      if (input.signal.aborted) throw new ReadCancelledError()
      if (budget.remaining === 0) return false
      budget.remaining--
      try {
        const post = await deps.scheduler.run('background', input.signal, (signal) => deps.client.getRef(id, signal))
        await store.savePost(post, deps.now())
      } catch (error) {
        // Not obtained: the reply stays unverified (never a non-match) and is read again next check.
        // A rate limit or captcha stops the round exactly as for pages.
        if (!(error instanceof ForumReadError) || error.error.kind === 'rate-limited') throw error
      }
      work.pendingRefs.shift()
    }
    const observed = await store.getReminderObservations(work.coverage.threadId, work.coverage.mode)
    const upToTarget = observed.filter((observation) => observation.page <= work.target!.page)
    const obtained = new Set(upToTarget.flatMap((observation) => observation.replyIds).filter((id) => comparePostIds(id, work.target!.id) <= 0))
    const targetPage = work.fetched.get(work.target!.page)
    const count = targetPage?.replyCount
    if (count != null && obtained.size !== count) issue(work, 'count-mismatch')
    if (upToTarget.some((observation) => observation.skippedItems > 0)) issue(work, 'gaps')
    work.coverage.checkpoint = work.coverage.checkpoint ? { ...work.coverage.checkpoint, complete: true } : null
    work.coverage.quoteCookieRevision = cookieRevision
    work.coverage.state = 'done'
    work.phase = 'done'
    return true
  }

  try {
    while (threads.some((thread) => !thread.counted) && !input.signal.aborted && !rateLimited) {
      for (const thread of threads) {
        if (thread.counted || input.signal.aborted || rateLimited) continue
        const budget = { remaining: 5 }
        try {
          for (const work of thread.modes) {
            while (work.phase !== 'done' && !input.signal.aborted) {
              const advanced = work.phase === 'probe' ? await probe(work, budget) : work.phase === 'verify' ? await verify(work, budget)
                : work.phase === 'scan' ? await scan(work, budget) : await quote(work, budget)
              if (!advanced) break
            }
            await evaluate(work)
            if (budget.remaining === 0) break
          }
        } catch (error) {
          if (input.signal.aborted || error instanceof ReadCancelledError) break
          if (!(error instanceof ForumReadError)) throw error
          const problem: ReadError = error.error
          thread.failed = true
          for (const work of thread.modes) {
            if (work.phase === 'done') continue
            work.coverage.state = 'failed'
            work.coverage.lastError = problem
            work.phase = 'done'
            await evaluate(work)
          }
          if (problem.kind === 'rate-limited') rateLimited = true
        }
        if (thread.modes.every((work) => work.phase === 'done')) {
          thread.counted = true
          if (thread.failed) round.threadsFailed++
          else if (thread.modes.every((work) => work.coverage.state !== 'incomplete')) round.threadsDone++
        }
        await store.saveReminderRound(round)
        await deps.afterBatch?.()
        deps.changed()
      }
    }
  } finally {
    // A cancelled read leaves the last successful checkpoint and next probe on disk.
    for (const thread of threads) for (const work of thread.modes) {
      if (work.phase !== 'done') {
        work.coverage.state = 'incomplete'
        issue(work, work.target === null ? 'target-unverified' : 'gaps')
      }
      await evaluate(work)
    }
    const reason = rateLimited ? 'rate-limited' : input.stopReason()
    round.state = reason === 'user' ? 'cancelled' : reason !== null ? 'interrupted' : 'finished'
    round.stopReason = reason
    round.finishedAt = deps.now()
    await store.saveReminderRound(round)
    deps.changed()
  }
  return { partial: threads.some((thread) => thread.modes.some((work) => work.coverage.state !== 'done')) }
}
