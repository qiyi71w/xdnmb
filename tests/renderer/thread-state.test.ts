import { describe, expect, it } from 'vitest'
import type { Post, ThreadCoverage, ThreadPage } from '../../src/shared/forum'
import { canPrependPrevious, initialThreadState, showsHead, threadReducer, type ThreadState } from '../../src/renderer/src/features/thread/threadState'
import { threadTotalPages } from '../../src/shared/threadPages'

const head: Post = {
  id: '100', forumId: '4', createdAt: null, userHash: null, name: null, title: null,
  isAdmin: null, isSage: null, content: [], plainText: '', image: null
}
const source = { status: 'fresh', fetchedAt: '2026-10-23T00:00:00.000Z', saved: true } as const

function page(number: number, replies: number): ThreadPage {
  return {
    threadId: '100', mode: 'all', page: number, head, replyCount: null, skippedItems: 0, endCandidate: replies === 0,
    replies: Array.from({ length: replies }, (_, i) => ({ ...head, id: String(200 + i) }))
  }
}

const coverage: ThreadCoverage = {
  threadId: '100', mode: 'all', pages: [], gaps: [], endCandidatePage: null,
  reportedReplyCount: null, obtainedReplyCount: 0, countMismatch: null
}

describe('thread reading state: located end', () => {
  it('shows 1/116 initially and keeps the range in place when automatic appending hits the cap', () => {
    const counted = { ...coverage, reportedReplyCount: 2194 }
    const loaded = threadReducer(initialThreadState(null), { type: 'page-loaded', task: { type: 'initial' }, page: page(1, 19), coverage: counted, source })
    expect(`${loaded.pages[0]?.page}/${threadTotalPages(loaded.coverage?.reportedReplyCount ?? null)}`).toBe('1/116')
    const capped = threadReducer(loaded, { type: 'page-cap', highestReadablePage: 100 })
    expect(capped.pages).toBe(loaded.pages)
    expect(capped.coverage).toBe(counted)
    expect(capped.rangeVersion).toBe(loaded.rangeVersion)
    expect(capped.pageCap).toBe(100)
    expect(capped.error).toBeNull()
  })

  it.each([{ type: 'locate' } as const, { type: 'jump', page: 101 } as const, { type: 'jump', page: 116 } as const])('shows 100/116 after a capped $type and requests new range positioning', (task) => {
    const counted = { ...coverage, reportedReplyCount: 2194 }
    const loaded = threadReducer(initialThreadState(null), { type: 'page-loaded', task: { type: 'initial' }, page: page(1, 19), coverage: counted, source })
    const started = threadReducer(loaded, { type: 'start', task })
    const capped = threadReducer(started, { type: 'cap-loaded', highestReadablePage: 100, page: page(100, 19), coverage: counted, source })
    expect(`${capped.pages[0]?.page}/${threadTotalPages(capped.coverage?.reportedReplyCount ?? null)}`).toBe('100/116')
    expect(capped.pages.map((item) => [item.page, item.endCandidate])).toEqual([[100, false]])
    expect(capped.rangeVersion).toBe(loaded.rangeVersion + 1)
    expect(capped.coverage).toBe(counted)
    expect(capped.pageCap).toBe(100)
    expect(capped.endProbe).toBeNull()
    expect(capped.task).toBeNull()
    expect(capped.error).toBeNull()
  })

  it('does not invent an end-candidate observation for a count-based tail', () => {
    const state = threadReducer(initialThreadState(null), {
      type: 'end-located', page: page(116, 9), endCandidatePage: null, coverage, probedPages: [116], source
    })
    expect(state.pages.map((p) => [p.page, p.endCandidate])).toEqual([[116, false]])
  })

  it('shows only observed pages when an empty page 1 is the end candidate', () => {
    const state = threadReducer(initialThreadState(null), {
      type: 'end-located', page: page(1, 0), endCandidatePage: 1, coverage, probedPages: [1], source
    })
    expect(state.pages.map((p) => [p.page, p.endCandidate])).toEqual([[1, true]])
  })

  it('shows the observed empty page that follows the last page with replies', () => {
    const state = threadReducer(initialThreadState(null), {
      type: 'end-located', page: page(9, 7), endCandidatePage: 10, coverage, probedPages: [9, 10], source
    })
    expect(state.pages.map((p) => [p.page, p.endCandidate])).toEqual([[9, false], [10, true]])
  })

  it('keeps shown pages and updates coverage when probing is interrupted', () => {
    const loaded = threadReducer(initialThreadState(null), { type: 'page-loaded', task: { type: 'initial' }, page: page(1, 19), coverage, source })
    const updated = { ...coverage, pages: [{ page: 1, fetchedAt: source.fetchedAt, replyIds: [], endCandidate: false, skippedItems: 0 }] }
    const state = threadReducer(loaded, {
      type: 'end-interrupted', coverage: updated, probedPages: [1], failedPage: 4, error: { kind: 'network', detail: 'timeout' }
    })
    expect(state.pages.map((p) => p.page)).toEqual([1])
    expect(state.coverage).toBe(updated)
  })
})

describe('thread reading state: range opened after page 1', () => {
  const load = (state: ThreadState, task: { type: 'initial'; page: number } | { type: 'prepend'; page: number } | { type: 'jump'; page: number }) =>
    threadReducer(threadReducer(state, { type: 'start', task }), { type: 'page-loaded', task, page: page(task.page, 19), coverage, source })

  it('shows the main post only once page 1 is loaded into the range', () => {
    expect(showsHead(initialThreadState(head))).toBe(false)
    const opened = load(initialThreadState(head), { type: 'initial', page: 3 })
    expect(opened.head).toEqual(head)
    expect(showsHead(opened)).toBe(false)
    const second = load(opened, { type: 'prepend', page: 2 })
    expect(second.pages.map((p) => p.page)).toEqual([2, 3])
    expect(showsHead(second)).toBe(false)
    const first = load(second, { type: 'prepend', page: 1 })
    expect(first.pages.map((p) => p.page)).toEqual([1, 2, 3])
    expect(first.rangeVersion).toBe(opened.rangeVersion)
    expect(showsHead(first)).toBe(true)
    expect(showsHead(load(first, { type: 'jump', page: 5 }))).toBe(false)
    expect(showsHead(load(initialThreadState(null), { type: 'initial', page: 1 }))).toBe(true)
  })

  it('allows an automatic previous page only while idle, before page 1, and not after it failed', () => {
    const opened = load(initialThreadState(head), { type: 'initial', page: 3 })
    expect(canPrependPrevious(opened)).toBe(true)
    const task = { type: 'prepend', page: 2 } as const
    const running = threadReducer(opened, { type: 'start', task })
    expect(canPrependPrevious(running)).toBe(false)
    const failed = threadReducer(running, { type: 'failed', task, failure: { type: 'read', error: { kind: 'network', detail: 'timeout' } } })
    expect(canPrependPrevious(failed)).toBe(false)
    const retried = threadReducer(failed, { type: 'start', task })
    const loaded = threadReducer(retried, { type: 'page-loaded', task, page: page(2, 19), coverage, source })
    expect(canPrependPrevious(loaded)).toBe(true)
    expect(canPrependPrevious(load(loaded, { type: 'prepend', page: 1 }))).toBe(false)
  })
})
