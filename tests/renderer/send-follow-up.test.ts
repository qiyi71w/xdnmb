import { describe, expect, it } from 'vitest'
import type { QuoteLocation } from '../../src/shared/api'
import { EMPTY_FIELDS, type PostTarget } from '../../src/shared/drafts'
import type { Post } from '../../src/shared/forum'
import type { PublicationAttempt, PublicationState } from '../../src/shared/publication'
import { planSendFollowUp, runSendFollowUp, type SendFollowUp, type SendFollowUpDeps, type SendOrigin, type ShownEntry } from '../../src/renderer/src/features/editor/sendFollowUp'
import type { ThreadSnapshot } from '../../src/renderer/src/features/tabs/tabsState'

const THREAD = '50000001'
const OWN_REPLY = '50000099'
const reply: PostTarget = { kind: 'reply', threadId: THREAD }
const newThread: PostTarget = { kind: 'thread', forumId: '4' }

function attempt(target: PostTarget, state: PublicationState, postId: string | null = null, threadId: string | null = null): PublicationAttempt {
  return {
    id: 'a1', requestId: 'r1', editorId: 'e1', draftId: null,
    payload: { draftId: null, target, credentialId: '1', fields: { ...EMPTY_FIELDS, content: '内容' }, attachmentId: null },
    state, problem: null, createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    postId, threadId, savedDraftId: null, cookieId: null
  }
}

const head = { id: THREAD } as Post

/** Where the send started, what the tab shows now, the follow-up's dependencies, and what they observed. */
interface World {
  origin: SendOrigin
  tab: { current: ShownEntry | null }
  deps: SendFollowUpDeps
  log: { threadRefreshed: boolean; listRefreshed: boolean; located: QuoteLocation[]; backTo: (ThreadSnapshot | null)[]; opened: string[] }
}

/** The reading position where the send started. */
const SENT_AT: ThreadSnapshot = { mode: 'all', anchor: { postId: '49000025', page: 2, offsetRatio: 0, viewportOffset: 0 }, generation: 0, temporaryOf: null, focus: null }

/**
 * A tab and a controlled forum: the reply lands on `replyPage`; a refresh reads up to `rangeEnd`;
 * locate finds only posts on pages read so far (local records). `during` runs inside the refresh.
 */
function world(options: { shown: ShownEntry; replyPage?: number; rangeEnd?: number; endReadable?: boolean; during?: () => void }): World {
  const tab = { current: options.shown as ShownEntry | null }
  const origin: SendOrigin = { tabId: options.shown.tabId, entryKey: options.shown.entryKey, source: SENT_AT }
  const recorded = new Set<string>()
  const replyPage = options.replyPage ?? 3
  const record = (upTo: number) => {
    if (upTo >= replyPage) recorded.add(OWN_REPLY)
  }
  const log = { threadRefreshed: false, listRefreshed: false, located: [] as QuoteLocation[], backTo: [] as (ThreadSnapshot | null)[], opened: [] as string[] }
  const deps = {
    stillShown: (plan: SendFollowUp) => {
      const now = tab.current
      const target: PostTarget = plan.kind === 'reply' ? { kind: 'reply', threadId: plan.threadId } : { kind: 'thread', forumId: plan.forumId }
      return now !== null && now.entryKey === plan.entryKey && now.targets.some((item) => JSON.stringify(item) === JSON.stringify(target))
    },
    refreshThread: async () => {
      log.threadRefreshed = true
      options.during?.()
      record(options.rangeEnd ?? replyPage)
    },
    refreshList: () => {
      log.listRefreshed = true
    },
    locate: async (postId: string): Promise<QuoteLocation> =>
      recorded.has(postId)
        ? { status: 'located', threadId: THREAD, head, target: { postId, page: replyPage, mode: 'all' }, source: 'fresh', networkError: null }
        : { status: 'thread-known', threadId: THREAD, head },
    readThreadEnd: async () => {
      if (options.endReadable !== false) record(replyPage)
    },
    openLocated: (plan: SendFollowUp, location: QuoteLocation) => {
      log.located.push(location)
      if (plan.kind === 'reply') log.backTo.push(plan.source)
    },
    openThread: (_plan: SendFollowUp, threadId: string) => {
      log.opened.push(threadId)
    }
  }
  return { origin, tab, deps, log }
}

const showsThread: ShownEntry = { tabId: 1, entryKey: 10, targets: [reply] }
const showsForum: ShownEntry = { tabId: 1, entryKey: 20, targets: [newThread] }

async function follow(sent: PublicationAttempt, w: World) {
  const plan = planSendFollowUp(sent, w.origin, w.tab.current)
  if (plan !== null) await runSendFollowUp(plan, w.deps)
  return plan
}

describe('after a send: reply', () => {
  it('confirmed: refreshes the thread, then opens the own reply where it is', async () => {
    const w = world({ shown: showsThread })
    await follow(attempt(reply, 'confirmed', OWN_REPLY, THREAD), w)
    expect(w.log.threadRefreshed).toBe(true)
    expect(w.log.located).toEqual([expect.objectContaining({ status: 'located', threadId: THREAD, target: { postId: OWN_REPLY, page: 3, mode: 'all' } })])
  })

  it('confirmed: back returns to where the send started, even after reading on meanwhile', async () => {
    const w = world({ shown: showsThread })
    await follow(attempt(reply, 'confirmed', OWN_REPLY, THREAD), w)
    expect(w.log.backTo).toEqual([SENT_AT])
  })

  it('the tab shows the thread through another history entry now: back is read when jumping', async () => {
    const w = world({ shown: showsThread })
    w.tab.current = { ...showsThread, entryKey: 15 }
    await follow(attempt(reply, 'confirmed', OWN_REPLY, THREAD), w)
    expect(w.log.backTo).toEqual([null])
  })

  it('confirmed with the reply past the refreshed range: reads the thread end and still opens it', async () => {
    const w = world({ shown: showsThread, replyPage: 7, rangeEnd: 2 })
    await follow(attempt(reply, 'confirmed', OWN_REPLY, THREAD), w)
    expect(w.log.located).toEqual([expect.objectContaining({ target: { postId: OWN_REPLY, page: 7, mode: 'all' } })])
  })

  it('confirmed but not locatable: stays a refresh, no navigation', async () => {
    const w = world({ shown: showsThread, replyPage: 7, rangeEnd: 2, endReadable: false })
    await follow(attempt(reply, 'confirmed', OWN_REPLY, THREAD), w)
    expect(w.log.threadRefreshed).toBe(true)
    expect(w.log.located).toEqual([])
  })

  it('ID unconfirmed: only refreshes', async () => {
    const w = world({ shown: showsThread })
    await follow(attempt(reply, 'unconfirmed'), w)
    expect(w.log.threadRefreshed).toBe(true)
    expect(w.log.located).toEqual([])
  })

  it('the tab no longer shows the thread: nothing happens', async () => {
    const elsewhere: ShownEntry = { tabId: 1, entryKey: 11, targets: [{ kind: 'reply', threadId: '50000002' }] }
    for (const state of ['confirmed', 'unconfirmed'] as const) {
      const w = world({ shown: elsewhere })
      expect(await follow(attempt(reply, state, state === 'confirmed' ? OWN_REPLY : null, THREAD), w)).toBeNull()
      expect(w.log).toEqual({ threadRefreshed: false, listRefreshed: false, located: [], backTo: [], opened: [] })
    }
  })

  it('the tab moves on while refreshing: no navigation', async () => {
    let w: World | null = null
    w = world({ shown: showsThread, during: () => { w!.tab.current = { tabId: 1, entryKey: 12, targets: [] } } })
    await follow(attempt(reply, 'confirmed', OWN_REPLY, THREAD), w)
    expect(w.log.threadRefreshed).toBe(true)
    expect(w.log.located).toEqual([])
  })

  it('other results do nothing', async () => {
    for (const state of ['failed', 'unknown', 'sending'] as const) {
      const w = world({ shown: showsThread })
      expect(await follow(attempt(reply, state), w)).toBeNull()
    }
  })
})

describe('after a send: new thread', () => {
  it('confirmed: opens the new thread from the forum list', async () => {
    const w = world({ shown: showsForum })
    await follow(attempt(newThread, 'confirmed', '50000100', '50000100'), w)
    expect(w.log.opened).toEqual(['50000100'])
    expect(w.log.listRefreshed).toBe(false)
  })

  it('ID unconfirmed: only refreshes the list', async () => {
    const w = world({ shown: showsForum })
    await follow(attempt(newThread, 'unconfirmed'), w)
    expect(w.log.listRefreshed).toBe(true)
    expect(w.log.opened).toEqual([])
  })

  it('the tab no longer shows that forum (including a report sent from a thread): nothing happens', async () => {
    const report: PostTarget = { kind: 'thread', forumId: '18' }
    for (const [target, shown] of [[newThread, { tabId: 1, entryKey: 21, targets: [{ kind: 'thread', forumId: '5' }] }], [report, showsThread]] as const) {
      const w = world({ shown })
      expect(await follow(attempt(target, 'confirmed', '50000100', '50000100'), w)).toBeNull()
      expect(w.log.opened).toEqual([])
      expect(w.log.listRefreshed).toBe(false)
    }
  })

  it('a report confirmed while the tab shows 值班室 opens it like a new thread', async () => {
    const report: PostTarget = { kind: 'thread', forumId: '18' }
    const w = world({ shown: { tabId: 1, entryKey: 22, targets: [report] } })
    await follow(attempt(report, 'confirmed', '50000101', '50000101'), w)
    expect(w.log.opened).toEqual(['50000101'])
  })
})
